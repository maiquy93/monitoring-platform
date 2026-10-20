'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getSettings, rollupMetrics } = require('./db');

const SEV_RANK = { none: 0, '0': 0, low: 1, medium: 2, high: 3, critical: 4 };
const ADDR_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/;
const IS_WIN = process.platform === 'win32';

function defaultPing(addr) {
  return new Promise((resolve) => {
    if (!ADDR_RE.test(addr)) return resolve({ ok: false });
    const args = IS_WIN ? ['-n', '1', '-w', '1000', addr] : ['-c', '1', '-W', '1', addr];
    execFile('ping', args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
      resolve({ ok: true, rtt: m ? parseFloat(m[1]) : (/time<1ms/i.test(stdout) ? 0.5 : null) });
    });
  });
}

const num = (v, min, max) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// ---- bandwidth from cumulative octet counters ------------------------------
const NET_MAX_BPS = 1.25e11;             // 1 Tbit/s: anything above is a counter glitch, not traffic
const PKT_MAX_PPS = 1e7;                 // 10 Mpps: sanity ceiling to reject counter reset glitches
const NET_BASE_MAX_MS = 300e3;           // a baseline older than this is dropped instead of averaged
const COUNTER32_MAX = 2 ** 32;           // 4,294,967,296
const COUNTER32_WRAP_MIN_PREV = 2 ** 31; // 2,147,483,648: 32-bit wrap is only valid if prev was in upper half of uint32

// slot = { base: {ts, rows} | null, rate: {in, out, at} | null }; rows = { key: [inOctets, outOctets, counterBits] }.
// Keeps the baseline until `minMs` has passed so a fast reporter is averaged over a longer window.
function updateNetSlot(slot, rows, now, minMs = 0) {
  const base = slot.base;
  if (!base || now - base.ts > NET_BASE_MAX_MS) { slot.base = { ts: now, rows }; return; }
  const dt = (now - base.ts) / 1000;
  if (now - base.ts < minMs || dt <= 0) return;
  let rin = 0, rout = 0, any = false;
  for (const [k, cur] of Object.entries(rows)) {
    const prev = base.rows[k];
    if (!prev) continue;                       // interface appeared since the last sample
    const canWrapIn = cur[2] === 32 && prev[0] >= COUNTER32_WRAP_MIN_PREV;
    const canWrapOut = cur[2] === 32 && prev[1] >= COUNTER32_WRAP_MIN_PREV;
    let din = cur[0] - prev[0], dout = cur[1] - prev[1];
    if (din < 0) din = canWrapIn ? din + COUNTER32_MAX : NaN;
    if (dout < 0) dout = canWrapOut ? dout + COUNTER32_MAX : NaN;
    if (!Number.isFinite(din) || !Number.isFinite(dout) || din / dt > NET_MAX_BPS || dout / dt > NET_MAX_BPS) continue;
    rin += din; rout += dout; any = true;
  }
  slot.base = { ts: now, rows };
  if (any) slot.rate = { in: rin / dt, out: rout / dt, at: now };
}

// ---- packet rate (TCP + UDP or per-interface IF-MIB) for Flood/DoS detection ----
// slot = { base: {ts, pkt} | null, rate: {rate, at} | null };
// pkt = { tcp, udp, rows?: { ifIndex: [pkts, counterBits] } }
function updatePktSlot(slot, pkt, now) {
  const base = slot.base;
  if (!base || now - base.ts > NET_BASE_MAX_MS) { slot.base = { ts: now, pkt }; return; }
  const dt = (now - base.ts) / 1000;
  if (dt <= 0) return;
  let totalPkts = 0, any = false, reset = false;

  if (pkt.rows && base.pkt && base.pkt.rows) {
    for (const [k, cur] of Object.entries(pkt.rows)) {
      const prev = base.pkt.rows[k];
      if (!prev) continue;
      const bits = cur[1] || 32;
      let d = cur[0] - prev[0];
      if (d < 0) {
        if (bits === 32 && prev[0] >= COUNTER32_WRAP_MIN_PREV) d += COUNTER32_MAX;
        else { reset = true; break; } // Device or interface counter reset (reboot)
      }
      if (!Number.isFinite(d) || d < 0 || d / dt > PKT_MAX_PPS) { reset = true; break; }
      totalPkts += d;
      any = true;
    }
  } else {
    for (const k of ['tcp', 'udp']) {
      if (pkt[k] != null && base.pkt && base.pkt[k] != null) {
        const bits = pkt.bits || 32;
        let d = pkt[k] - base.pkt[k];
        if (d < 0) {
          if (bits === 32 && base.pkt[k] >= COUNTER32_WRAP_MIN_PREV) d += COUNTER32_MAX;
          else { reset = true; break; } // Device rebooted or SNMP counter reset to 0
        }
        if (!Number.isFinite(d) || d < 0 || d / dt > PKT_MAX_PPS) { reset = true; break; }
        totalPkts += d;
        any = true;
      }
    }
  }

  slot.base = { ts: now, pkt };
  if (reset) {
    slot.rate = null;
    return;
  }
  if (any && totalPkts / dt <= PKT_MAX_PPS) {
    slot.rate = { rate: totalPkts / dt, at: now };
  }
}

class Monitor extends EventEmitter {
  constructor(db, opts = {}) {
    super();
    this.db = db;
    this.o = {
      pingIntervalMs: 4000,      // one ICMP probe every 4s ...
      pingFailLimit: 2,          // ... 2 consecutive failures => down (~8-10s)
      agentTimeoutMs: 20000,     // no agent report for 20s => agent check failed
      snmpIntervalMs: 30000,
      snmpFailLimit: 2,
      metricEveryMs: 30000,
      netStaleMs: 90000,         // bandwidth sample older than this is not shown or stored
      agentNetWindowMs: 8000,    // agent traffic is averaged over at least this window
      breachMs: 15000,
      retentionDays: 7,
      maxEvents: 100000,
      minFreeBytes: 500 * 1048576, // below this the history is trimmed early
      dbFile: null,                // lets the monitor watch the disk holding the database
      concurrency: 32,
      pingFn: defaultPing,
      snmpFn: require('./snmp-engine').pollDevice,
      ...opts,
    };
    const { AiService } = require('./ai');
    const { TelegramService } = require('./telegram');
    this.ai = new AiService(db, { fetchFn: opts.aiFetchFn });
    this.telegram = new TelegramService(db, { fetchFn: opts.telegramFetchFn });
    this.devices = new Map();   // id -> row (+ groups)
    this.state = new Map();     // id -> runtime state
    this.settings = getSettings(db);
    this.startedAt = Date.now();
    this.inflight = 0;
    this.timer = null;
    this.lastPurge = 0;
    this.lastDiskCheck = 0;
    this.lastAiCheck = 0;
    this.diskLow = false;
    this.reload();
  }

  reload() {
    this.settings = getSettings(this.db);
    const rows = this.db.prepare('SELECT * FROM devices').all();
    const gm = new Map();
    for (const r of this.db.prepare('SELECT device_id, group_id FROM device_groups').all()) {
      if (!gm.has(r.device_id)) gm.set(r.device_id, []);
      gm.get(r.device_id).push(r.group_id);
    }
    const seen = new Set();
    for (const r of rows) {
      seen.add(r.id);
      this.devices.set(r.id, { ...r, groups: gm.get(r.id) || [] });
      if (!this.state.has(r.id)) this.state.set(r.id, this._newState(r.id));
      const st = this.state.get(r.id);
      const key = [r.address, r.snmp_port, r.snmp_community, r.snmp_profile].join('|');
      if (st.snmpKey !== undefined && st.snmpKey !== key) {
        st.snmp.nextAt = 0; st.snmp.fails = 0; st.snmp.net = { base: null, rate: null };
        st.snmp.pkt = { base: null, rate: null };
      } // re-poll right away
      st.snmpKey = key;
    }
    for (const id of [...this.devices.keys()]) {
      if (!seen.has(id)) { this.devices.delete(id); this.state.delete(id); }
    }
    this.evaluate(Date.now());
  }

  _newState(id) {
    const last = this.db.prepare('SELECT MAX(ts) t FROM metrics WHERE device_id = ? AND cpu IS NOT NULL').get(id);
    return {
      status: 'unknown', reasons: [], since: Date.now(), acked: false,
      icmp: { ok: null, fails: 0, rtt: null, nextAt: 0, busy: false },
      snmp: { ok: null, fails: 0, nextAt: 0, busy: false, info: null, error: null, net: { base: null, rate: null }, pkt: { base: null, rate: null } },
      agent: { lastAt: last && last.t ? last.t : null, data: null, net: { base: null, rate: null } },
      breach: { cpu: 0, ram: 0, disk: 0 },
      alerts: { dos: false, smart: false, thermal: false, ups: false, printer: false },
      lastMetricAt: 0,
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
    this.tick();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  severityOf(d) {
    const s = d.severity;
    if (s === 0 || s === '0' || s === 'none') return 'none';
    if (s && SEV_RANK[s] !== undefined) return s;
    const def = this.settings.type_severity[d.type];
    if (def === 0 || def === '0' || def === 'none') return 'none';
    return (def && SEV_RANK[def] !== undefined) ? def : 'medium';
  }

  // ---- data ingestion -------------------------------------------------
  ingestAgent(deviceId, p, now = Date.now()) {
    const st = this.state.get(deviceId);
    if (!st) return false;
    const disks = Array.isArray(p.disks) ? p.disks.slice(0, 32).map((d) => ({
      mount: str(d && d.mount, 64),
      total: num(d && d.total, 0, 1e18),
      used: num(d && d.used, 0, 1e18),
      percent: num(d && d.percent, 0, 100),
    })) : [];
    const mem = p.memory || {};
    const rx = num(p.net && p.net.rx_bytes, 0, 1e18), tx = num(p.net && p.net.tx_bytes, 0, 1e18);
    if (rx !== null && tx !== null) updateNetSlot(st.agent.net, { agent: [rx, tx, 64] }, now, this.o.agentNetWindowMs);
    const temp = num(p.temperature ?? (p.cpu && p.cpu.temp), -50, 200);
    const smart = p.smart && typeof p.smart === 'object' ? {
      ok: p.smart.ok !== false && !p.smart.failing,
      status: str(p.smart.status, 32),
      details: str(p.smart.details || p.smart.message, 128),
    } : null;
    const power = p.power && typeof p.power === 'object' ? {
      on_battery: !!p.power.on_battery,
      battery_percent: num(p.power.battery_percent, 0, 100),
      status: str(p.power.status, 32),
    } : null;
    st.agent = {
      net: st.agent.net,
      lastAt: now,
      data: {
        hostname: str(p.hostname, 128), os: str(p.os, 128), ip: str(p.ip, 64), version: str(p.agent_version, 32),
        cpu: num(p.cpu && p.cpu.percent, 0, 100),
        cores: num(p.cores ?? (p.cpu && p.cpu.cores), 0, 4096),
        load1: num(p.load1 ?? (p.cpu && p.cpu.load1), 0, 1e6),
        ram: { total: num(mem.total, 0, 1e18), used: num(mem.used, 0, 1e18), percent: num(mem.percent, 0, 100) },
        disks, uptime: num(p.uptime, 0, 1e10),
        net: rx !== null && tx !== null ? { rx_bytes: rx, tx_bytes: tx } : null,
        temperature: temp,
        smart,
        power,
      },
    };
    return true;
  }

  // ---- scheduler ------------------------------------------------------
  tick(now = Date.now()) {
    for (const [id, d] of this.devices) {
      const st = this.state.get(id);
      if (d.check_icmp && d.address && !st.icmp.busy && now >= st.icmp.nextAt) this._dispatch(() => this._ping(d, st, now));
      if (d.snmp_enabled && d.address && !st.snmp.busy && now >= st.snmp.nextAt) this._dispatch(() => this._snmp(d, st, now));
    }
    this.evaluate(now);
    if (now - this.lastAiCheck >= 30000) {
      this.lastAiCheck = now;
      this.ai.checkScheduledDailyDigest(this, this.settings, now);
    }
    if (now - this.lastPurge > 3600e3) { this.lastPurge = now; this.purge(); }
    if (now - this.lastDiskCheck > 300e3) { this.lastDiskCheck = now; this.guardDisk(); }
  }

  _dispatch(fn) {
    if (this.inflight >= this.o.concurrency) return;
    this.inflight++;
    fn().catch(() => {}).finally(() => { this.inflight--; });
  }

  async _ping(d, st, now = Date.now()) {
    st.icmp.busy = true;
    st.icmp.nextAt = now + this.o.pingIntervalMs;
    let r;
    try { r = await this.o.pingFn(d.address); } catch { r = { ok: false }; }
    st.icmp.busy = false;
    if (r.ok) { st.icmp.fails = 0; st.icmp.ok = true; st.icmp.rtt = r.rtt ?? null; }
    else {
      st.icmp.fails++;
      st.icmp.rtt = null;
      if (st.icmp.fails >= this.o.pingFailLimit) st.icmp.ok = false;
    }
    this.evaluate(now);
  }

  async _snmp(d, st, now = Date.now()) {
    st.snmp.busy = true;
    st.snmp.nextAt = now + this.o.snmpIntervalMs;
    try {
      const { if_counters: ifc, pkt_counters: pkt, ...info } = await this.o.snmpFn({ host: d.address, port: d.snmp_port, community: d.snmp_community, profile: d.snmp_profile || '' });
      const prevUptime = st.snmp.info && st.snmp.info.uptime != null ? st.snmp.info.uptime : null;
      const baseTs = (st.snmp.pkt && st.snmp.pkt.base && st.snmp.pkt.base.ts)
        || (st.snmp.net && st.snmp.net.base && st.snmp.net.base.ts)
        || null;
      const rebooted = info.uptime != null && (
        (prevUptime != null && info.uptime < prevUptime) ||
        (baseTs != null && info.uptime < (now - baseTs) / 1000 - 5)
      );
      if (rebooted || st.snmp.ok === false || st.snmp.fails > 0 || st.status === 'down') {
        st.snmp.net = { base: null, rate: null };
        st.snmp.pkt = { base: null, rate: null };
      }
      st.snmp.info = info;
      if (ifc && ifc.rows) updateNetSlot(st.snmp.net, ifc.rows, now);
      if (pkt) updatePktSlot(st.snmp.pkt, pkt, now);
      st.snmp.fails = 0; st.snmp.ok = true; st.snmp.error = null;
    } catch (e) {
      st.snmp.fails++;
      st.snmp.error = { code: e.code || 'error', message: e.message, at: now };
      if (st.snmp.fails >= this.o.snmpFailLimit) {
        st.snmp.ok = false;
        st.snmp.net = { base: null, rate: null };
        st.snmp.pkt = { base: null, rate: null };
      }
    }
    st.snmp.busy = false;
    this.evaluate(now);
  }

  // ---- evaluation -----------------------------------------------------
  evaluate(now = Date.now()) {
    let changed = false;
    const inGrace = now - this.startedAt < this.o.agentTimeoutMs + 5000;
    const th = this.settings.thresholds;
    for (const [id, d] of this.devices) {
      const st = this.state.get(id);
      if (!st.alerts) st.alerts = { dos: false, smart: false, thermal: false, ups: false, printer: false };
      const reasons = [];
      let status;

      const agentFresh = st.agent.lastAt != null && now - st.agent.lastAt <= this.o.agentTimeoutMs;
      const checks = [];
      if (d.check_icmp && d.address) checks.push({ n: 'icmp', ok: st.icmp.ok });
      if (d.check_agent) {
        let ok = st.agent.lastAt == null ? null : agentFresh;
        if (ok === false && inGrace) ok = null;
        checks.push({ n: 'agent', ok });
      }
      if (d.snmp_enabled && d.address) checks.push({ n: 'snmp', ok: st.snmp.ok });

      if (d.maintenance) status = 'maint';
      else if (!checks.length) status = 'unknown';
      else if (checks.some((c) => c.ok === true)) {
        status = 'up';
        const agentCheck = checks.find((c) => c.n === 'agent');
        if (agentCheck && agentCheck.ok === false) reasons.push('Agent không gửi dữ liệu (còn ping được)');
        const vals = this._resources(st, agentFresh);
        if (vals) {
          const label = { cpu: 'CPU', ram: 'RAM', disk: 'Ổ đĩa' };
          for (const k of ['cpu', 'ram', 'disk']) {
            // must stay above threshold for 15s so short spikes don't raise alerts
            if (vals[k] != null && vals[k] >= th[k]) {
              if (!st.breach[k]) st.breach[k] = now;
              if (now - st.breach[k] >= this.o.breachMs) reasons.push(`${label[k]} cao: ${Math.round(vals[k])}% (ngưỡng ${th[k]}%)`);
            } else st.breach[k] = 0;
          }
        }
        const toner = st.snmp.info && st.snmp.info.toner;
        if (toner != null && toner >= 0 && toner <= 10) reasons.push(`Mực còn ${toner}%`);
        const drum = st.snmp.info && st.snmp.info.drum;
        if (drum != null && drum >= 0 && drum <= 10) reasons.push(`Độ bền drum còn ${drum}% (cần thay drum)`);
        else if (drum != null && drum >= 0 && drum <= 20) reasons.push(`Độ bền drum sắp hết: ${drum}%`);

        const prn = st.snmp.info && st.snmp.info.printer;
        if (prn && prn.errors && prn.errors.length) {
          for (const err of prn.errors) reasons.push(err);
          if (!st.alerts.printer) {
            st.alerts.printer = true;
            this._event(d, 'warning', 'medium', `${d.name}: Sự cố máy in - ${prn.errors.join('; ')}`);
          }
        } else if (st.alerts.printer) {
          st.alerts.printer = false;
          this._event(d, 'up', 'ok', `${d.name}: Máy in đã hoạt động bình thường`);
        }

        // 1. SNMP Flood / DoS detection (hỗ trợ cả dữ liệu SNMP thực tế và mock test)
        const pktFresh = st.snmp && st.snmp.pkt && st.snmp.pkt.rate && (now - st.snmp.pkt.rate.at <= this.o.netStaleMs);
        let pktRate = pktFresh ? st.snmp.pkt.rate.rate : null;
        let attackSuffix = '';

        if (st.mockDos && st.mockDos.active) {
          if (now <= st.mockDos.expiresAt) {
            pktRate = st.mockDos.pps;
            attackSuffix = ` · ${st.mockDos.attackType}`;
            if (!st.snmp.net) st.snmp.net = { base: null, rate: null };
            st.snmp.net.rate = { rx: st.mockDos.rxBytes, tx: st.mockDos.rxBytes * 0.05, at: now };
          } else {
            st.mockDos.active = false;
          }
        }

        st.snmp.pktRate = pktRate;
        const dosTh = th.dos_packet_rate || 10000;
        if (pktRate != null && pktRate >= dosTh) {
          reasons.push(`Nghi ngờ tấn công Flood/DoS (${Math.round(pktRate).toLocaleString('vi-VN')} gói/s > ${dosTh.toLocaleString('vi-VN')} gói/s${attackSuffix})`);
          if (!st.alerts.dos) {
            st.alerts.dos = true;
            this._event(d, 'dos', 'critical', `${d.name}: Nghi ngờ tấn công Flood/DoS (${Math.round(pktRate).toLocaleString('vi-VN')} gói/s${attackSuffix})`);
          }
        } else if (st.alerts.dos) {
          st.alerts.dos = false;
          this._event(d, 'dos', 'ok', `${d.name}: Tốc độ gói tin đã trở lại bình thường${pktRate != null ? ` (${Math.round(pktRate).toLocaleString('vi-VN')} gói/s)` : ''}`);
        }

        // 2. SMART / Bad Sector detection
        if (agentFresh && st.agent.data && st.agent.data.smart && st.agent.data.smart.ok === false) {
          const detail = st.agent.data.smart.details ? `: ${st.agent.data.smart.details}` : '';
          reasons.push(`Đĩa cứng báo lỗi SMART / Bad Sector${detail}`);
          if (!st.alerts.smart) {
            st.alerts.smart = true;
            this._event(d, 'smart', 'critical', `${d.name}: Cảnh báo đĩa cứng (SMART lỗi/Bad Sector)${detail}`);
          }
        } else if (st.alerts.smart) {
          st.alerts.smart = false;
          this._event(d, 'smart', 'ok', `${d.name}: Trạng thái đĩa cứng SMART đã trở lại bình thường`);
        }

        // 3. Thermal Throttling detection
        const curTemp = (agentFresh && st.agent.data && st.agent.data.temperature != null)
          ? st.agent.data.temperature
          : (st.snmp.ok && st.snmp.info && st.snmp.info.temperature != null ? st.snmp.info.temperature : null);
        const tempTh = th.temp || 85;
        if (curTemp != null && curTemp >= tempTh) {
          reasons.push(`Nhiệt độ CPU quá cao: ${Math.round(curTemp)}°C (ngưỡng ${tempTh}°C)`);
          if (!st.alerts.thermal) {
            st.alerts.thermal = true;
            this._event(d, 'thermal', 'critical', `${d.name}: Báo động nhiệt độ CPU quá cao: ${Math.round(curTemp)}°C (Thermal Throttling)`);
          }
        } else if (st.alerts.thermal && curTemp != null && curTemp < tempTh - 3) {
          st.alerts.thermal = false;
          this._event(d, 'thermal', 'ok', `${d.name}: Nhiệt độ CPU đã trở lại mức an toàn (${Math.round(curTemp)}°C)`);
        }

        // 4. Power / UPS status
        if (agentFresh && st.agent.data && st.agent.data.power && st.agent.data.power.on_battery) {
          const batInfo = st.agent.data.power.battery_percent != null ? ` (pin còn ${st.agent.data.power.battery_percent}%)` : '';
          reasons.push(`Mất điện lưới (On Battery)${batInfo}`);
          if (!st.alerts.ups) {
            st.alerts.ups = true;
            this._event(d, 'power', 'critical', `${d.name}: Cảnh báo khẩn cấp: Mất điện lưới, đang chạy pin UPS${batInfo}`);
          }
        } else if (st.alerts.ups) {
          st.alerts.ups = false;
          this._event(d, 'power', 'ok', `${d.name}: Đã có điện lưới trở lại (nguồn AC ổn định)`);
        }

        const devSev = this.severityOf(d);
        if (reasons.length && devSev !== 'none') status = 'warning';
      } else if (checks.every((c) => c.ok === false)) {
        status = 'down';
        reasons.push(...checks.map((c) => ({
          icmp: 'Không ping được (ICMP)', agent: 'Agent mất kết nối', snmp: 'SNMP không phản hồi',
        }[c.n])));
      } else status = 'unknown';

      st.reasons = reasons;
      if (status !== st.status) {
        this._transition(d, st, status, now);
        changed = true;
      }
      if (this._maybeStoreMetric(d, st, now, agentFresh)) { /* stored */ }
    }
    if (changed) this.emit('change');
    return changed;
  }

  _transition(d, st, next, now) {
    const prev = st.status;
    const sev = this.severityOf(d);
    const dur = Math.round((now - st.since) / 1000);
    const hasCritAlert = st.alerts && (st.alerts.dos || st.alerts.smart || st.alerts.thermal || st.alerts.ups);
    if (next === 'down') {
      st.snmp.net = { base: null, rate: null };
      st.snmp.pkt = { base: null, rate: null };
      if (st.alerts) st.alerts.dos = false;
    }
    if (sev !== 'none') {
      if (next === 'down') {
        const msg = `${d.name} mất kết nối: ${st.reasons.join(', ')}`;
        this._event(d, 'down', sev, msg);
        this._triggerTelegramAlert(d, st, 'down', msg, now);
      } else if (next === 'warning') {
        const msg = `${d.name}: ${st.reasons.join('; ')}`;
        this._event(d, 'warning', hasCritAlert ? 'critical' : (sev === 'low' ? 'low' : 'medium'), msg);
        this._triggerTelegramAlert(d, st, 'warning', msg, now);
      } else if (next === 'up' && (prev === 'down' || prev === 'warning')) {
        const msg = `${d.name} hoạt động trở lại sau ${dur}s`;
        this._event(d, 'up', 'ok', msg);
        this._triggerTelegramAlert(d, st, 'up', msg, now);
      }
    }
    st.status = next;
    st.since = now;
    st.acked = false;
  }

  _triggerTelegramAlert(d, st, kind, reason, now = Date.now()) {
    if (!this.telegram || !d || !d.id || d.maintenance) return;
    if (this.severityOf(d) === 'none') return;
    if (d.telegram_enabled === 0 || d.telegram_enabled === false) return;
    const tg = this.settings && this.settings.telegram;
    if (!tg || !tg.enabled || !tg.bot_token || !tg.chat_id) return;

    const agentFresh = st && st.agent.lastAt != null && now - st.agent.lastAt <= this.o.agentTimeoutMs;
    const res = st ? this._resources(st, agentFresh) : null;
    const temp = (agentFresh && st.agent.data && st.agent.data.temperature != null)
      ? st.agent.data.temperature
      : (st && st.snmp.ok && st.snmp.info && st.snmp.info.temperature != null ? st.snmp.info.temperature : null);

    const ctx = {
      device_id: d.id,
      device_name: d.name,
      device_type: d.type,
      address: d.address,
      location: d.location,
      telegram_enabled: d.telegram_enabled !== 0,
      kind,
      reason,
      cpu: res ? res.cpu : null,
      ram: res ? res.ram : null,
      disk: res ? res.disk : null,
      temp,
      ts: now,
    };

    this.telegram.notifyDeviceEvent(ctx, this.settings, {
      now,
      lang: (this.settings && this.settings.default_lang) || 'vi',
    }).catch(() => {});
  }

  _event(d, kind, severity, message) {
    const devSev = d && d.id ? this.severityOf(d) : severity;
    if (devSev === 'none' && kind !== 'audit') return null;
    const now = Date.now();
    const info = this.db.prepare('INSERT INTO events(ts,device_id,device_name,kind,severity,message) VALUES(?,?,?,?,?,?)')
      .run(now, d.id, d.name, kind, severity, message);
    const eventId = Number(info.lastInsertRowid);
    this.emit('event', { id: eventId, device_id: d.id, kind, severity, message });

    // Smart Incident Filter: never trigger AI on disconnect/ping, printer, or recovery/audit
    const { isAiAnalyzableIncident } = require('./ai');
    if (d && d.id && isAiAnalyzableIncident({
      device_id: d.id,
      device_type: d.type,
      device_severity: devSev,
      event_severity: severity,
      kind,
      reason: message,
      status: kind,
    })) {
      const aiSev = (severity === 'critical' || severity === 'high') ? severity : devSev;
      this._triggerAiIncident(d, kind, aiSev, message, eventId, now);
    }
    return eventId;
  }

  _triggerAiIncident(d, kind, aiSev, message, eventId, now = Date.now()) {
    if (!this.settings.ai || !this.settings.ai.enabled || this.settings.ai.auto_incident === false) return;
    const { collectDeviceTechnicalLogs } = require('./ai');
    const techLogs = collectDeviceTechnicalLogs(this, {
      eventId,
      deviceId: d.id,
      lang: this.settings.default_lang || 'vi',
      now,
    });
    const st = this.state.get(d.id);
    const agentFresh = st && st.agent.lastAt != null && now - st.agent.lastAt <= this.o.agentTimeoutMs;
    const res = st ? this._resources(st, agentFresh) : null;
    const temp = (agentFresh && st.agent.data && st.agent.data.temperature != null)
      ? st.agent.data.temperature
      : (st && st.snmp.ok && st.snmp.info && st.snmp.info.temperature != null ? st.snmp.info.temperature : null);
    const ctx = {
      device_id: d.id,
      device_name: d.name,
      device_type: d.type,
      device_severity: this.severityOf(d),
      address: d.address,
      severity: aiSev,
      status: st ? st.status : kind,
      kind,
      reason: message,
      event_id: eventId,
      tech_summary: techLogs ? techLogs.tech_summary : null,
      cpu: res ? res.cpu : null,
      ram: res ? res.ram : null,
      disk: res ? res.disk : null,
      temp,
      rtt: st && st.icmp ? st.icmp.rtt : null,
      pkt_rate: st && st.snmp ? st.snmp.pktRate : null,
      smart: agentFresh && st.agent.data ? st.agent.data.smart : null,
      power: agentFresh && st.agent.data ? st.agent.data.power : null,
    };
    this.ai.analyzeIncident(ctx, this.settings, { now }).then((rep) => {
      if (rep) this.emit('change');
    }).catch(() => {});
  }

  // Agent data wins; SNMP (HOST-RESOURCES-MIB) is the fallback for routers/switches.
  _resources(st, agentFresh) {
    if (agentFresh && st.agent.data) {
      const a = st.agent.data;
      return { cpu: a.cpu, ram: a.ram.percent, disk: a.disks.length ? Math.max(...a.disks.map((x) => x.percent || 0)) : null };
    }
    const i = st.snmp.ok && st.snmp.info;
    if (i && (i.cpu != null || i.ram != null || i.disk != null)) {
      return { cpu: i.cpu ?? null, ram: i.ram ?? null, disk: i.disk ?? null };
    }
    return null;
  }

  // Current bandwidth in bytes/s ({in, out}) or null. Same precedence as _resources: fresh agent first, then SNMP.
  _net(st, now, agentFresh) {
    if (st.mockDos && st.mockDos.active && now <= st.mockDos.expiresAt) {
      return { in: st.mockDos.rxBytes, out: st.mockDos.rxBytes * 0.05 };
    }
    const fresh = (r) => (r && now - r.at <= this.o.netStaleMs ? r : null);
    const r = (agentFresh && st.agent && st.agent.net && fresh(st.agent.net.rate))
      || (st.snmp && st.snmp.ok && st.snmp.net && fresh(st.snmp.net.rate)) || null;
    return r ? { in: r.in, out: r.out } : null;
  }

  _maybeStoreMetric(d, st, now, agentFresh) {
    if (now - st.lastMetricAt < this.o.metricEveryMs) return false;
    const res = this._resources(st, agentFresh);
    const net = this._net(st, now, agentFresh);
    const rtt = st.icmp.rtt;
    const temp = (agentFresh && st.agent.data && st.agent.data.temperature != null)
      ? st.agent.data.temperature
      : (st.snmp.ok && st.snmp.info && st.snmp.info.temperature != null ? st.snmp.info.temperature : null);
    const toner = st.snmp.ok && st.snmp.info && st.snmp.info.toner != null ? st.snmp.info.toner : null;
    const drum = st.snmp.ok && st.snmp.info && st.snmp.info.drum != null ? st.snmp.info.drum : null;
    if (!res && rtt == null && !net && temp == null && toner == null && drum == null) return false;
    st.lastMetricAt = now;
    this.db.prepare('INSERT INTO metrics(device_id,ts,cpu,ram,disk,rtt,net_in,net_out,temp,toner,drum) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      d.id, now, res ? res.cpu : null, res ? res.ram : null, res ? res.disk : null, rtt,
      net ? Math.round(net.in) : null, net ? Math.round(net.out) : null,
      temp != null ? Math.round(temp * 10) / 10 : null,
      toner != null ? Math.round(toner * 10) / 10 : null,
      drum != null ? Math.round(drum * 10) / 10 : null);
    return true;
  }

  purge() {
    const now = Date.now();
    try { rollupMetrics(this.db, now); } catch (e) { /* ignore rollup error */ }
    this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(now - this.o.retentionDays * 86400e3);
    this.db.prepare('DELETE FROM metrics_hourly WHERE hour_ts < ?').run(now - 90 * 86400e3);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 90 * 86400e3);
    this.db.prepare('DELETE FROM ai_reports WHERE ts < ?').run(now - 90 * 86400e3);
    // hard cap so a flapping device can never grow the events table without limit
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(this.o.maxEvents);
    this.checkpoint();
  }

  // Keeps the WAL file from growing and giving space back to the filesystem.
  checkpoint() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* in-memory db or busy */ }
  }

  // Free space of the volume holding the database (null when unknown).
  diskSpace() {
    if (!this.o.dbFile || this.o.dbFile === ':memory:') return null;
    try {
      const s = fs.statfsSync(path.dirname(this.o.dbFile));
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    } catch { return null; }
  }

  // When the disk is nearly full, shrink history early instead of letting SQLite fail with "disk I/O error".
  guardDisk() {
    const d = this.diskSpace();
    this.diskLow = !!d && d.free < this.o.minFreeBytes;
    if (!this.diskLow) return false;
    const now = Date.now();
    this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(now - 86400e3);
    this.db.prepare('DELETE FROM metrics_hourly WHERE hour_ts < ?').run(now - 14 * 86400e3);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 14 * 86400e3);
    this.checkpoint();
    console.warn(`[monitor] disk almost full (${Math.round(d.free / 1048576)} MB free): trimmed history`);
    return true;
  }

  systemInfo() {
    const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
    const f = this.o.dbFile;
    const d = this.diskSpace();
    return {
      db_bytes: f && f !== ':memory:' ? size(f) : null,
      wal_bytes: f && f !== ':memory:' ? size(`${f}-wal`) : null,
      disk_free_bytes: d ? d.free : null,
      disk_total_bytes: d ? d.total : null,
      disk_low: !!this.diskLow,
      retention_days: this.o.retentionDays,
    };
  }

  ack(id) {
    const st = this.state.get(id);
    if (!st) return false;
    st.acked = true;
    this.emit('change');
    return true;
  }

  // ---- views ----------------------------------------------------------
  view(d, detailed = false) {
    const st = this.state.get(d.id);
    const a = st.agent.data;
    const stale = st.agent.lastAt != null && Date.now() - st.agent.lastAt > this.o.agentTimeoutMs;
    const res = this._resources(st, !stale && a != null);
    const net = this._net(st, Date.now(), !stale && a != null);
    const v = {
      id: d.id, name: d.name, type: d.type, address: d.address, location: d.location,
      maintenance: !!d.maintenance, mute_local_alerts: !!d.mute_local_alerts,
      telegram_enabled: d.telegram_enabled !== 0,
      severity: this.severityOf(d), groups: d.groups,
      status: st.status, reasons: st.reasons, since: st.since, acked: st.acked,
      rtt: st.icmp.rtt,
      net_in: net ? Math.round(net.in) : null,
      net_out: net ? Math.round(net.out) : null,
      cpu: res ? res.cpu : null,
      ram: res ? res.ram : null,
      disk: res ? res.disk : null,
      uptime: !stale && a && a.uptime != null ? a.uptime
        : (st.snmp.info && st.snmp.info.uptime != null ? st.snmp.info.uptime : null),
      toner: st.snmp.info && st.snmp.info.toner != null ? st.snmp.info.toner : null,
      drum: st.snmp.info && st.snmp.info.drum != null ? st.snmp.info.drum : null,
      page_count: st.snmp.info && st.snmp.info.page_count != null ? st.snmp.info.page_count : null,
      total_ssids: (st.snmp.info && st.snmp.info.total_ssids != null) ? st.snmp.info.total_ssids
        : (st.snmp.info && st.snmp.info.ap ? st.snmp.info.ap.total_ssids : null),
      total_clients: (st.snmp.info && st.snmp.info.total_clients != null) ? st.snmp.info.total_clients
        : (st.snmp.info && st.snmp.info.ap ? st.snmp.info.ap.total_clients : null),
      printer_status: st.snmp.info && st.snmp.info.printer ? (st.snmp.info.printer.display || st.snmp.info.printer.status_text) : null,
      printer_errors: st.snmp.info && st.snmp.info.printer ? st.snmp.info.printer.errors : [],
      temperature: (!stale && a && a.temperature != null) ? a.temperature
        : (st.snmp.ok && st.snmp.info && st.snmp.info.temperature != null ? st.snmp.info.temperature : null),
      smart: (!stale && a) ? a.smart : null,
      power: (!stale && a) ? a.power : null,
      dos_alert: !stale && !!(st.alerts && st.alerts.dos),
      alerts: {
        dos: !stale && !!(st.alerts && st.alerts.dos),
        smart: (!stale && a) ? !!(st.alerts && st.alerts.smart) : false,
        thermal: !!(st.alerts && st.alerts.thermal),
        power: (!stale && a) ? !!(st.alerts && st.alerts.ups) : false,
        printer: !!(st.alerts && st.alerts.printer),
      },
      checks: { icmp: !!(d.check_icmp && d.address), agent: !!d.check_agent, snmp: !!(d.snmp_enabled && d.address) },
      last_agent_at: st.agent.lastAt,
      pkt_rate: (st.mockDos && st.mockDos.active && Date.now() <= st.mockDos.expiresAt)
        ? st.mockDos.pps
        : (st.snmp.pkt && st.snmp.pkt.rate ? Math.round(st.snmp.pkt.rate.rate) : null),
      dos_details: (st.mockDos && st.mockDos.active && Date.now() <= st.mockDos.expiresAt) ? st.mockDos.attackType : null,
    };
    if (detailed) {
      v.notes = d.notes;
      v.check_icmp = !!d.check_icmp; v.check_agent = !!d.check_agent;
      v.snmp_enabled = !!d.snmp_enabled; v.snmp_port = d.snmp_port;
      v.severity_override = d.severity || '';
      v.agent = a; v.snmp = st.snmp.info;
      v.printer = st.snmp.info ? st.snmp.info.printer : null;
      v.ap = st.snmp.info ? st.snmp.info.ap : null;
      v.snmp_profile = d.snmp_profile || '';
      v.snmp_error = st.snmp.error;
    }
    return v;
  }

  mockDos(deviceId, opts = {}) {
    const d = this.devices.get(deviceId);
    const st = this.state.get(deviceId);
    if (!d || !st) return null;
    const now = Date.now();
    const active = opts.active !== false;
    const pps = Number(opts.pps) || 55000;
    const mbps = Number(opts.bandwidth_mbps || opts.bandwidth) || 85;
    const rxBytes = mbps * 1024 * 1024;
    const ports = Array.isArray(opts.ports)
      ? opts.ports
      : (opts.ports ? String(opts.ports).split(',').map((p) => Number(p.trim())).filter(Boolean) : [53, 123]);
    const attackType = opts.attack_type || `NTP/DNS UDP Flood (cổng ${ports.join(', ')})`;
    const durationSec = Number(opts.duration_sec || opts.duration) || 60;

    if (!active) {
      if (st.mockDos) st.mockDos.active = false;
      this.evaluate(now);
      this.emit('change');
      return { active: false, device_id: d.id, device_name: d.name };
    }

    if (d.snmp_enabled) st.snmp.ok = true;
    else if (d.check_icmp) st.icmp.ok = true;
    else if (d.check_agent) st.agent.lastAt = now;
    else st.snmp.ok = true;

    st.mockDos = {
      active: true,
      pps,
      rxBytes,
      ports,
      attackType,
      at: now,
      expiresAt: now + (durationSec * 1000),
    };
    this.evaluate(now);
    this.emit('change');
    return {
      active: true,
      device_id: d.id,
      device_name: d.name,
      address: d.address,
      pps,
      bandwidth_mb: mbps,
      ports,
      attack_type: attackType,
      expires_at: st.mockDos.expiresAt,
      duration_sec: durationSec,
    };
  }

  snapshot() {
    const devices = [...this.devices.values()].map((d) => this.view(d)).sort((a, b) => a.name.localeCompare(b.name));
    return { ts: Date.now(), devices, summary: this.summarize(devices) };
  }

  // Overall level drives wall-display colour: red/orange/yellow/blue/green.
  summarize(devices) {
    const s = { total: 0, alive: 0, down: 0, warning: 0, unknown: 0, maintenance: 0, level: 'ok', unacked: 0 };
    let worst = 0;
    for (const d of devices) {
      if (d.status === 'maint') { s.maintenance++; continue; }
      s.total++;
      if (d.status === 'up' || d.status === 'warning') s.alive++;
      if (d.status === 'down') s.down++;
      if (d.status === 'warning' && d.severity !== 'none') s.warning++;
      if (d.status === 'unknown') s.unknown++;
      if (d.status === 'down' || d.status === 'warning') {
        if (d.severity === 'none') continue;
        const hasCrit = d.alerts && (d.alerts.dos || d.alerts.smart || d.alerts.thermal || d.alerts.power);
        const sev = d.status === 'down' ? d.severity : (hasCrit ? 'critical' : (d.severity === 'low' ? 'low' : 'medium'));
        worst = Math.max(worst, SEV_RANK[sev] || 0);
        if (!d.acked) s.unacked++;
      }
    }
    s.level = ['ok', 'low', 'medium', 'high', 'critical'][worst];
    return s;
  }
}

module.exports = { Monitor, ADDR_RE, SEV_RANK, defaultPing, updateNetSlot, updatePktSlot };
