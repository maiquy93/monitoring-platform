'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getSettings } = require('./db');
const snmp = require('./snmp');

const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
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
      breachMs: 15000,
      retentionDays: 7,
      maxEvents: 100000,
      minFreeBytes: 500 * 1048576, // below this the history is trimmed early
      dbFile: null,                // lets the monitor watch the disk holding the database
      concurrency: 32,
      pingFn: defaultPing,
      snmpFn: snmp.pollDevice,
      ...opts,
    };
    this.devices = new Map();   // id -> row (+ groups)
    this.state = new Map();     // id -> runtime state
    this.settings = getSettings(db);
    this.startedAt = Date.now();
    this.inflight = 0;
    this.timer = null;
    this.lastPurge = 0;
    this.lastDiskCheck = 0;
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
    }
    for (const id of [...this.devices.keys()]) {
      if (!seen.has(id)) { this.devices.delete(id); this.state.delete(id); }
    }
  }

  _newState(id) {
    const last = this.db.prepare('SELECT MAX(ts) t FROM metrics WHERE device_id = ? AND cpu IS NOT NULL').get(id);
    return {
      status: 'unknown', reasons: [], since: Date.now(), acked: false,
      icmp: { ok: null, fails: 0, rtt: null, nextAt: 0, busy: false },
      snmp: { ok: null, fails: 0, nextAt: 0, busy: false, info: null },
      agent: { lastAt: last && last.t ? last.t : null, data: null },
      breach: { cpu: 0, ram: 0, disk: 0 },
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
    if (d.severity && SEV_RANK[d.severity]) return d.severity;
    return this.settings.type_severity[d.type] || 'medium';
  }

  // ---- data ingestion -------------------------------------------------
  ingestAgent(deviceId, p) {
    const st = this.state.get(deviceId);
    if (!st) return false;
    const disks = Array.isArray(p.disks) ? p.disks.slice(0, 32).map((d) => ({
      mount: str(d && d.mount, 64),
      total: num(d && d.total, 0, 1e18),
      used: num(d && d.used, 0, 1e18),
      percent: num(d && d.percent, 0, 100),
    })) : [];
    const mem = p.memory || {};
    st.agent = {
      lastAt: Date.now(),
      data: {
        hostname: str(p.hostname, 128), os: str(p.os, 128), ip: str(p.ip, 64), version: str(p.agent_version, 32),
        cpu: num(p.cpu && p.cpu.percent, 0, 100), cores: num(p.cpu && p.cpu.cores, 0, 4096),
        load1: num(p.cpu && p.cpu.load1, 0, 1e6),
        ram: { total: num(mem.total, 0, 1e18), used: num(mem.used, 0, 1e18), percent: num(mem.percent, 0, 100) },
        disks, uptime: num(p.uptime, 0, 1e10),
      },
    };
    return true;
  }

  // ---- scheduler ------------------------------------------------------
  tick(now = Date.now()) {
    for (const [id, d] of this.devices) {
      const st = this.state.get(id);
      if (d.check_icmp && d.address && !st.icmp.busy && now >= st.icmp.nextAt) this._dispatch(() => this._ping(d, st));
      if (d.snmp_enabled && d.address && !st.snmp.busy && now >= st.snmp.nextAt) this._dispatch(() => this._snmp(d, st));
    }
    this.evaluate(now);
    if (now - this.lastPurge > 3600e3) { this.lastPurge = now; this.purge(); }
    if (now - this.lastDiskCheck > 300e3) { this.lastDiskCheck = now; this.guardDisk(); }
  }

  _dispatch(fn) {
    if (this.inflight >= this.o.concurrency) return;
    this.inflight++;
    fn().catch(() => {}).finally(() => { this.inflight--; });
  }

  async _ping(d, st) {
    st.icmp.busy = true;
    st.icmp.nextAt = Date.now() + this.o.pingIntervalMs;
    let r;
    try { r = await this.o.pingFn(d.address); } catch { r = { ok: false }; }
    st.icmp.busy = false;
    if (r.ok) { st.icmp.fails = 0; st.icmp.ok = true; st.icmp.rtt = r.rtt ?? null; }
    else {
      st.icmp.fails++;
      st.icmp.rtt = null;
      if (st.icmp.fails >= this.o.pingFailLimit) st.icmp.ok = false;
    }
    this.evaluate();
  }

  async _snmp(d, st) {
    st.snmp.busy = true;
    st.snmp.nextAt = Date.now() + this.o.snmpIntervalMs;
    try {
      st.snmp.info = await this.o.snmpFn({ host: d.address, port: d.snmp_port, community: d.snmp_community });
      st.snmp.fails = 0; st.snmp.ok = true;
    } catch {
      st.snmp.fails++;
      if (st.snmp.fails >= this.o.snmpFailLimit) st.snmp.ok = false;
    }
    st.snmp.busy = false;
    this.evaluate();
  }

  // ---- evaluation -----------------------------------------------------
  evaluate(now = Date.now()) {
    let changed = false;
    const inGrace = now - this.startedAt < this.o.agentTimeoutMs + 5000;
    const th = this.settings.thresholds;
    for (const [id, d] of this.devices) {
      const st = this.state.get(id);
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
        if (toner != null && toner <= 10) reasons.push(`Mực còn ${toner}%`);
        if (reasons.length) status = 'warning';
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
    if (next === 'down') this._event(d, 'down', sev, `${d.name} mất kết nối: ${st.reasons.join(', ')}`);
    else if (next === 'warning') this._event(d, 'warning', sev === 'low' ? 'low' : 'medium', `${d.name}: ${st.reasons.join('; ')}`);
    else if (next === 'up' && (prev === 'down' || prev === 'warning')) {
      this._event(d, 'up', 'ok', `${d.name} hoạt động trở lại sau ${dur}s`);
    }
    st.status = next;
    st.since = now;
    st.acked = false;
  }

  _event(d, kind, severity, message) {
    this.db.prepare('INSERT INTO events(ts,device_id,device_name,kind,severity,message) VALUES(?,?,?,?,?,?)')
      .run(Date.now(), d.id, d.name, kind, severity, message);
    this.emit('event', { device_id: d.id, kind, severity, message });
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

  _maybeStoreMetric(d, st, now, agentFresh) {
    if (now - st.lastMetricAt < this.o.metricEveryMs) return false;
    const res = this._resources(st, agentFresh);
    const rtt = st.icmp.rtt;
    if (!res && rtt == null) return false;
    st.lastMetricAt = now;
    this.db.prepare('INSERT INTO metrics(device_id,ts,cpu,ram,disk,rtt) VALUES(?,?,?,?,?,?)').run(
      d.id, now, res ? res.cpu : null, res ? res.ram : null, res ? res.disk : null, rtt);
    return true;
  }

  purge() {
    const now = Date.now();
    this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(now - this.o.retentionDays * 86400e3);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - 90 * 86400e3);
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
    const v = {
      id: d.id, name: d.name, type: d.type, address: d.address, location: d.location,
      maintenance: !!d.maintenance, severity: this.severityOf(d), groups: d.groups,
      status: st.status, reasons: st.reasons, since: st.since, acked: st.acked,
      rtt: st.icmp.rtt,
      cpu: res ? res.cpu : null,
      ram: res ? res.ram : null,
      disk: res ? res.disk : null,
      uptime: !stale && a && a.uptime != null ? a.uptime
        : (st.snmp.info && st.snmp.info.uptime != null ? st.snmp.info.uptime : null),
      toner: st.snmp.info && st.snmp.info.toner != null ? st.snmp.info.toner : null,
      checks: { icmp: !!(d.check_icmp && d.address), agent: !!d.check_agent, snmp: !!(d.snmp_enabled && d.address) },
      last_agent_at: st.agent.lastAt,
    };
    if (detailed) {
      v.notes = d.notes;
      v.check_icmp = !!d.check_icmp; v.check_agent = !!d.check_agent;
      v.snmp_enabled = !!d.snmp_enabled; v.snmp_port = d.snmp_port;
      v.severity_override = d.severity || '';
      v.agent = a; v.snmp = st.snmp.info;
    }
    return v;
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
      if (d.status === 'warning') s.warning++;
      if (d.status === 'unknown') s.unknown++;
      if (d.status === 'down' || d.status === 'warning') {
        const sev = d.status === 'down' ? d.severity : (d.severity === 'low' ? 'low' : 'medium');
        worst = Math.max(worst, SEV_RANK[sev]);
        if (!d.acked) s.unacked++;
      }
    }
    s.level = ['ok', 'low', 'medium', 'high', 'critical'][worst];
    return s;
  }
}

module.exports = { Monitor, ADDR_RE, SEV_RANK, defaultPing };
