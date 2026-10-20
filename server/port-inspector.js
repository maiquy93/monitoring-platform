'use strict';
// Independent Switch / Router Per-Port Inspector service (IF-MIB + ifXTable).
// Zero-Impact Core: runs strictly on-demand via API, maintaining its own lightweight rate delta map
// without touching server/monitor.js or server/snmp-engine.js.
const snmp = require('./snmp');

const PORT_COLS = {
  descr: '1.3.6.1.2.1.2.2.1.2',       // ifDescr
  type: '1.3.6.1.2.1.2.2.1.3',        // ifType
  mtu: '1.3.6.1.2.1.2.2.1.4',         // ifMtu
  speed: '1.3.6.1.2.1.2.2.1.5',       // ifSpeed (bps)
  mac: '1.3.6.1.2.1.2.2.1.6',         // ifPhysAddress
  admin: '1.3.6.1.2.1.2.2.1.7',       // ifAdminStatus (1=up, 2=down, 3=testing)
  oper: '1.3.6.1.2.1.2.2.1.8',        // ifOperStatus (1=up, 2=down, 3=testing, 4=unknown, 5=dormant, 6=notPresent, 7=lowerLayerDown)
  lastChange: '1.3.6.1.2.1.2.2.1.9',  // ifLastChange (TimeTicks)
  in32: '1.3.6.1.2.1.2.2.1.10',       // ifInOctets
  inDiscards: '1.3.6.1.2.1.2.2.1.13', // ifInDiscards
  inErrors: '1.3.6.1.2.1.2.2.1.14',   // ifInErrors
  out32: '1.3.6.1.2.1.2.2.1.16',      // ifOutOctets
  outDiscards: '1.3.6.1.2.1.2.2.1.19',// ifOutDiscards
  outErrors: '1.3.6.1.2.1.2.2.1.20',  // ifOutErrors
};

const IFX_COLS = {
  name: '1.3.6.1.2.1.31.1.1.1.1',     // ifName
  hcIn: '1.3.6.1.2.1.31.1.1.1.6',     // ifHCInOctets (64-bit)
  hcOut: '1.3.6.1.2.1.31.1.1.1.10',   // ifHCOutOctets (64-bit)
  highSpeed: '1.3.6.1.2.1.31.1.1.1.15', // ifHighSpeed (Mbps)
  alias: '1.3.6.1.2.1.31.1.1.1.18',   // ifAlias (port description)
};

const COUNTER32_MAX = 2 ** 32;
const COUNTER32_WRAP_MIN_PREV = 2 ** 31;
const VIRTUAL_IF_TYPES = new Set([24, 53, 131, 135, 136, 150, 161, 209]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function formatMac(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  if (/^[0-9a-fA-F]{12}$/.test(str)) {
    return str.match(/.{1,2}/g).map((b) => b.toUpperCase()).join(':');
  }
  if (/^([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}$/.test(str)) {
    return str.split(/[:-]/).map((b) => b.padStart(2, '0').toUpperCase()).join(':');
  }
  return '';
}

function formatSpeedLabel(speedBps) {
  if (!speedBps || speedBps <= 0) return '—';
  if (speedBps >= 1e9) {
    const g = speedBps / 1e9;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} Gbps`;
  }
  if (speedBps >= 1e6) {
    const m = Math.round(speedBps / 1e6);
    return `${m} Mbps`;
  }
  if (speedBps >= 1e3) {
    return `${Math.round(speedBps / 1e3)} Kbps`;
  }
  return `${speedBps} bps`;
}

function classifyIfType(ifType, name) {
  const n = String(name || '').toLowerCase();
  if (ifType === 24 || /^lo\b|loopback/i.test(n)) return 'loopback';
  if (ifType === 135 || ifType === 136 || /^vlan|br\d|bridge/i.test(n)) return 'vlan';
  if (ifType === 161 || /^po\d|bond|lag|ae\d|port-channel|portchannel/i.test(n)) return 'lag';
  if (ifType === 131 || /^tun|wg|vpn|gre|ipsec|pppoe|ovpn/i.test(n)) return 'tunnel';
  if (/^null\b|null\d*/i.test(n) || /^cpu\b|control-plane/i.test(n)) return 'virtual';
  if (VIRTUAL_IF_TYPES.has(ifType) || ifType === 1) return 'virtual';
  return 'physical';
}

const ETHERNET_PHYSICAL_TYPES = new Set([6, 62, 69, 117]);

function isPhysicalPort(ifType, name, descr = '') {
  const n = String(name || '').trim();
  const d = String(descr || '').trim();
  const combined = `${n} ${d}`.toLowerCase();

  // 1. Loại bỏ các ifType ảo đã biết
  if (VIRTUAL_IF_TYPES.has(ifType) || ifType === 24 || ifType === 1) return false;

  // 2. Loại bỏ các sub-interface ảo (vd: Gi0/1.100, eth0.50)
  if (/^[a-z0-9\-_/]+\.\d+$/i.test(n)) return false;

  // 3. Lọc bỏ các interface có tên hoặc mô tả chứa từ khóa rác
  if (/(loopback|\blo\d*\b|null|vlan|\bvl\d+\b|tunnel|\btun\d*\b|gre|ipsec|pppoe|ovpn|wireguard|\bwg\d*\b|cpu|control-plane|bridge|\bbr\d*\b|bvi|port-channel|portchannel|\bpo\d+\b|bond|\blag\d*\b|\bae\d+\b|stack-port|eoip)/i.test(combined)) {
    return false;
  }

  // 4. Lọc theo tiền tố tên ảo phổ biến
  if (/^(lo\d*|null\d*|vl\d+|vlan\d*|tun\d*|tunnel\d*|gre\d*|po\d+|bond\d*|br\d*|bvi\d*|cpu|stack)/i.test(n)) {
    return false;
  }

  // 5. Nhận diện các cổng Ethernet chuẩn
  const isEthType = ETHERNET_PHYSICAL_TYPES.has(ifType);
  const isEthName = /^(eth|gi|fa|te|ge|xe|sfp|cổng|port|lan|wan|ethernet)/i.test(n);
  return isEthType || isEthName;
}

class PortInspectorService {
  constructor() {
    this.samples = new Map(); // deviceKey -> { ts, ports: Map(ifIndex -> { inOct, outOct, bits, oper, flapCount, flapWindowAt }) }
  }

  async inspectDevice({
    deviceKey,
    host,
    port = 161,
    community = 'public',
    maxPorts = 48,
    configuredPortCount = null,
    includeVirtual = false,
    timeoutMs = 2000,
    walkColumnsFn = snmp.walkColumns,
    snmpGetFn = snmp.snmpGet,
    now = Date.now(),
  }) {
    const conn = { host, port: Number(port) || 161, community: community || 'public' };
    let sysUpTimeTicks = null;
    try {
      const sys = await snmpGetFn({ ...conn, oids: [snmp.OIDS.sysUpTime], timeout: timeoutMs });
      if (sys && num(sys[snmp.OIDS.sysUpTime]) !== null) {
        sysUpTimeTicks = num(sys[snmp.OIDS.sysUpTime]);
      }
    } catch { /* optional */ }

    const baseRows = await walkColumnsFn({
      ...conn,
      columns: Object.values(PORT_COLS),
      maxRows: maxPorts,
      timeout: timeoutMs,
    });

    if (!baseRows || !Object.keys(baseRows).length) {
      throw new Error('Thiết bị không trả về bảng cổng mạng SNMP (IF-MIB)');
    }

    let ifxRows = {};
    try {
      ifxRows = await walkColumnsFn({
        ...conn,
        columns: Object.values(IFX_COLS),
        maxRows: maxPorts,
        timeout: timeoutMs,
      });
    } catch { /* ifXTable is optional on older devices */ }

    const key = String(deviceKey || `${host}:${port}`);
    const prevEntry = this.samples.get(key) || null;
    const dtSec = prevEntry && now > prevEntry.ts ? (now - prevEntry.ts) / 1000 : 0;
    const nextSamplePorts = new Map();

    const ports = [];
    for (const [idx, r] of Object.entries(baseRows)) {
      const x = ifxRows[idx] || {};
      const ifIndex = Number(idx) || idx;
      const descr = String(r[PORT_COLS.descr] || '').trim();
      const ifName = String(x[IFX_COLS.name] || descr || `Port ${idx}`).trim();
      const alias = String(x[IFX_COLS.alias] || '').trim();
      const ifType = num(r[PORT_COLS.type]) || 6;
      const isPhysical = isPhysicalPort(ifType, ifName, descr);
      if (!includeVirtual && !isPhysical) {
        continue; // Lọc bỏ rác: loopback, null, vlan, tunnel, cpu, bridge, port-channel...
      }
      const category = classifyIfType(ifType, ifName);
      const adminCode = num(r[PORT_COLS.admin]) ?? 1;
      const operCode = num(r[PORT_COLS.oper]) ?? 2;
      const adminStatus = adminCode === 1 ? 'up' : (adminCode === 2 ? 'down' : 'testing');
      const operStatus = operCode === 1 ? 'up' : (operCode === 5 ? 'dormant' : 'down');

      const highSpeedMbps = num(x[IFX_COLS.highSpeed]);
      const rawSpeedBps = num(r[PORT_COLS.speed]);
      const speedBps = (highSpeedMbps && highSpeedMbps > 0)
        ? highSpeedMbps * 1e6
        : (rawSpeedBps && rawSpeedBps > 0 && rawSpeedBps < 4294967295 ? rawSpeedBps : null);

      const hasHc = num(x[IFX_COLS.hcIn]) !== null && num(x[IFX_COLS.hcOut]) !== null;
      const inOctets = hasHc ? num(x[IFX_COLS.hcIn]) : num(r[PORT_COLS.in32]);
      const outOctets = hasHc ? num(x[IFX_COLS.hcOut]) : num(r[PORT_COLS.out32]);
      const bits = hasHc ? 64 : 32;

      const inErrors = num(r[PORT_COLS.inErrors]) || 0;
      const outErrors = num(r[PORT_COLS.outErrors]) || 0;
      const inDiscards = num(r[PORT_COLS.inDiscards]) || 0;
      const outDiscards = num(r[PORT_COLS.outDiscards]) || 0;

      const lastChangeTicks = num(r[PORT_COLS.lastChange]);
      const lastChangeAgoSec = (sysUpTimeTicks !== null && lastChangeTicks !== null && sysUpTimeTicks >= lastChangeTicks)
        ? Math.floor((sysUpTimeTicks - lastChangeTicks) / 100)
        : null;

      // Calculate bandwidth rate & flapping from previous sample if available
      let rxBps = null;
      let txBps = null;
      let utilizationPct = null;
      let flapCount = 0;
      let flapWindowAt = now;

      const prevPort = prevEntry && prevEntry.ports ? prevEntry.ports.get(String(idx)) : null;
      if (prevPort) {
        flapWindowAt = now - prevPort.flapWindowAt <= 300000 ? prevPort.flapWindowAt : now;
        flapCount = now - prevPort.flapWindowAt <= 300000 ? (prevPort.flapCount || 0) : 0;
        if (prevPort.oper && prevPort.oper !== operStatus) {
          flapCount += 1;
        }
        if (dtSec >= 0.5 && dtSec <= 300 && inOctets !== null && outOctets !== null && prevPort.inOct !== null && prevPort.outOct !== null) {
          let din = inOctets - prevPort.inOct;
          let dout = outOctets - prevPort.outOct;
          if (din < 0 && bits === 32 && prevPort.inOct >= COUNTER32_WRAP_MIN_PREV) din += COUNTER32_MAX;
          if (dout < 0 && bits === 32 && prevPort.outOct >= COUNTER32_WRAP_MIN_PREV) dout += COUNTER32_MAX;
          if (din >= 0 && dout >= 0) {
            rxBps = Math.round(din / dtSec); // bytes per second
            txBps = Math.round(dout / dtSec); // bytes per second
            if (speedBps && speedBps > 0) {
              const maxDirBits = Math.max(rxBps, txBps) * 8;
              utilizationPct = Math.min(100, Math.round((maxDirBits / speedBps) * 1000) / 10);
            }
          }
        }
      }

      const flapping = flapCount >= 2 || (operStatus === 'up' && lastChangeAgoSec !== null && lastChangeAgoSec > 0 && lastChangeAgoSec < 60 && sysUpTimeTicks > 18000);

      nextSamplePorts.set(String(idx), {
        inOct: inOctets,
        outOct: outOctets,
        bits,
        oper: operStatus,
        flapCount,
        flapWindowAt,
      });

      ports.push({
        index: ifIndex,
        name: ifName,
        descr: descr !== ifName ? descr : '',
        alias,
        type_code: ifType,
        category,
        mac: formatMac(r[PORT_COLS.mac]),
        mtu: num(r[PORT_COLS.mtu]),
        admin_status: adminStatus,
        oper_status: operStatus,
        speed_bps: speedBps,
        speed_label: formatSpeedLabel(speedBps),
        in_octets: inOctets,
        out_octets: outOctets,
        rx_Bps: rxBps,
        tx_Bps: txBps,
        utilization_pct: utilizationPct,
        in_errors: inErrors,
        out_errors: outErrors,
        in_discards: inDiscards,
        out_discards: outDiscards,
        total_errors: inErrors + outErrors,
        total_discards: inDiscards + outDiscards,
        last_change_ago_sec: lastChangeAgoSec,
        flapping,
        flap_count: flapCount,
      });
    }

    this.samples.set(key, { ts: now, ports: nextSamplePorts });

    ports.sort((a, b) => Number(a.index) - Number(b.index));

    // Giới hạn số cổng theo cấu hình thực tế thiết bị (VD Switch 24/48, Router 4/8/16)
    const portLimit = (configuredPortCount && configuredPortCount > 0) ? configuredPortCount : (maxPorts || 48);
    const finalPorts = ports.slice(0, portLimit);

    const upPorts = finalPorts.filter((p) => p.oper_status === 'up');
    const downPorts = finalPorts.filter((p) => p.oper_status !== 'up' && p.admin_status === 'up');
    const adminDownPorts = finalPorts.filter((p) => p.admin_status !== 'up');
    const issuePorts = finalPorts.filter((p) => p.total_errors > 0 || p.flapping || (p.utilization_pct !== null && p.utilization_pct >= 80));

    return {
      total_ports: finalPorts.length,
      up_count: upPorts.length,
      down_count: downPorts.length,
      admin_down_count: adminDownPorts.length,
      issue_count: issuePorts.length,
      has_rate_sample: dtSec >= 0.5,
      sample_interval_sec: dtSec > 0 ? Math.round(dtSec * 10) / 10 : null,
      ports: finalPorts,
    };
  }
}

function registerRoutes({ route, monitor, send, idOf, bad, HttpError }, opts = {}) {
  const inspector = new PortInspectorService();

  route('GET', '/api/devices/:id/ports', 'any', async (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');
    if (!d.address) throw bad('Thiết bị chưa có địa chỉ IP');

    const includeVirtual = ctx.query.get('include_virtual') === '1' || ctx.query.get('include_all') === '1';
    const configuredPortCount = (d.port_count && d.port_count > 0)
      ? d.port_count
      : (d.type === 'switch' ? 48 : (['router', 'firewall'].includes(d.type) ? 16 : 48));

    try {
      const data = await inspector.inspectDevice({
        deviceKey: d.id,
        host: d.address,
        port: d.snmp_port || 161,
        community: d.snmp_community || 'public',
        maxPorts: configuredPortCount,
        configuredPortCount,
        includeVirtual,
        walkColumnsFn: opts.walkColumnsFn,
        snmpGetFn: opts.snmpGetFn,
      });
      send(ctx.res, 200, {
        ok: true,
        device_id: d.id,
        device_name: d.name,
        device_type: d.type,
        address: d.address,
        ...data,
      });
    } catch (err) {
      throw new HttpError(502, `Không đọc được danh sách cổng SNMP: ${err.message}`);
    }
  });
}

module.exports = {
  PORT_COLS,
  IFX_COLS,
  formatSpeedLabel,
  classifyIfType,
  isPhysicalPort,
  PortInspectorService,
  registerRoutes,
};
