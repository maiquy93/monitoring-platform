'use strict';
// Independent LAN Subnet Auto-Discovery & Bulk Onboarding service.
// Zero-Impact Core: runs strictly on-demand when triggered by an admin, never alters the background Monitor loop.
const os = require('node:os');
const net = require('node:net');
const dns = require('node:dns');
const { execFile } = require('node:child_process');
const snmp = require('./snmp');
const engine = require('./snmp-engine');

const IS_WIN = process.platform === 'win32';
const VALID_TYPES = ['server', 'vm', 'router', 'switch', 'firewall', 'ap', 'printer', 'ups', 'pc', 'other'];

function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    num = (num * 256) + v;
  }
  return num >>> 0;
}

function intToIp(num) {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join('.');
}

function detectLocalSubnet() {
  try {
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const iface of list || []) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address) {
          const parts = iface.address.split('.');
          if (parts.length === 4) {
            return {
              local_ip: iface.address,
              subnet_cidr: `${parts[0]}.${parts[1]}.${parts[2]}.0/24`,
              range_example: `${parts[0]}.${parts[1]}.${parts[2]}.1-${parts[0]}.${parts[1]}.${parts[2]}.254`,
            };
          }
        }
      }
    }
  } catch { /* ignore */ }
  return {
    local_ip: '192.168.1.10',
    subnet_cidr: '192.168.1.0/24',
    range_example: '192.168.1.1-192.168.1.254',
  };
}

// Parses CIDR (192.168.1.0/24), range (192.168.1.1-192.168.1.50 or 192.168.1.1-50), or comma-separated IPs.
function parseIpTargets(input, maxHosts = 256) {
  const str = String(input || '').trim();
  if (!str) throw new Error('Vui lòng nhập dải IP hoặc Subnet CIDR (ví dụ: 192.168.1.0/24)');

  const out = [];
  const seen = new Set();
  const addIp = (intVal) => {
    const ip = intToIp(intVal);
    if (!seen.has(ip)) {
      seen.add(ip);
      out.push(ip);
    }
  };

  const segments = str.split(/[\s,;]+/).filter(Boolean);
  for (const seg of segments) {
    // 1. CIDR notation: a.b.c.d/prefix
    const cidrM = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(seg);
    if (cidrM) {
      const baseInt = ipToInt(cidrM[1]);
      const prefix = Number(cidrM[2]);
      if (baseInt === null || prefix < 22 || prefix > 32) {
        throw new Error(`Dải CIDR "${seg}" không hợp lệ (hỗ trợ từ /24 đến /32)`);
      }
      if (prefix === 32) {
        addIp(baseInt);
        continue;
      }
      const hostBits = 32 - prefix;
      const count = 2 ** hostBits;
      const mask = count === 32 ? 0 : (~((count - 1) >>> 0)) >>> 0;
      const network = (baseInt & mask) >>> 0;
      const start = prefix <= 30 ? network + 1 : network;
      const end = prefix <= 30 ? network + count - 2 : network + count - 1;
      for (let cur = start; cur <= end && out.length < maxHosts; cur++) {
        addIp(cur >>> 0);
      }
      continue;
    }

    // 2. Full IP range: a.b.c.d-e.f.g.h
    const fullRangeM = /^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/.exec(seg);
    if (fullRangeM) {
      const startInt = ipToInt(fullRangeM[1]);
      const endInt = ipToInt(fullRangeM[2]);
      if (startInt === null || endInt === null || endInt < startInt) {
        throw new Error(`Dải IP "${seg}" không hợp lệ`);
      }
      if (endInt - startInt + 1 > maxHosts) {
        throw new Error(`Dải IP vượt quá giới hạn tối đa ${maxHosts} địa chỉ mỗi lần quét`);
      }
      for (let cur = startInt; cur <= endInt && out.length < maxHosts; cur++) {
        addIp(cur >>> 0);
      }
      continue;
    }

    // 3. Short last-octet range: a.b.c.d-e (e.g. 192.168.1.1-50)
    const shortRangeM = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/.exec(seg);
    if (shortRangeM) {
      const prefixIp = shortRangeM[1];
      const startOct = Number(shortRangeM[2]);
      const endOct = Number(shortRangeM[3]);
      if (startOct < 0 || endOct > 255 || endOct < startOct) {
        throw new Error(`Dải IP "${seg}" không hợp lệ`);
      }
      for (let oct = startOct; oct <= endOct && out.length < maxHosts; oct++) {
        const val = ipToInt(`${prefixIp}.${oct}`);
        if (val !== null) addIp(val);
      }
      continue;
    }

    // 4. Single IP: a.b.c.d
    const singleInt = ipToInt(seg);
    if (singleInt !== null) {
      addIp(singleInt);
      continue;
    }

    throw new Error(`Định dạng IP/Subnet "${seg}" không hợp lệ`);
  }

  if (!out.length) throw new Error('Không tìm thấy địa chỉ IP hợp lệ để quét');
  return out.slice(0, maxHosts);
}

function fastPing(ip, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const waitArg = IS_WIN ? String(timeoutMs) : String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const args = IS_WIN ? ['-n', '1', '-w', waitArg, ip] : ['-c', '1', '-W', waitArg, ip];
    execFile('ping', args, { timeout: timeoutMs + 1000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, rtt: null });
      const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(stdout);
      resolve({
        ok: true,
        rtt: m ? parseFloat(m[1]) : (/time<1ms/i.test(stdout) ? 0.5 : 1.0),
      });
    });
  });
}

function fastTcpConnect(ip, port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, ip); } catch { finish(false); }
  });
}

function inferDeviceType({ snmpInfo, openPorts = [] }) {
  if (snmpInfo) {
    const pid = String(snmpInfo.profile_id || '').toLowerCase();
    const descr = String(snmpInfo.sysDescr || '').toLowerCase();
    const oid = String(snmpInfo.sysObjectID || '');

    if (
      pid.includes('printer')
      || /printer|laserjet|deskjet|officejet|canon|brother|epson|ricoh|xerox/i.test(descr)
      || oid.startsWith('1.3.6.1.4.1.2435')
      || oid.startsWith('1.3.6.1.4.1.1602')
      || oid.startsWith('1.3.6.1.4.1.11.2.3.9')
    ) return 'printer';

    if (
      pid.includes('ap') || pid.includes('unifi') || pid.includes('ruckus') || pid.includes('aruba') || pid.includes('omada') || pid.includes('grandstream')
      || /access[ -]?point|\bap\b|wireless|unifi|uap|aironet|ruckus|omada|grandstream|gwn/i.test(descr)
      || oid.startsWith('1.3.6.1.4.1.41112')
      || oid.startsWith('1.3.6.1.4.1.25053')
      || oid.startsWith('1.3.6.1.4.1.14823')
    ) return 'ap';

    if (pid === 'fortigate' || pid === 'pfsense' || /fortigate|fortios|pfsense|opnsense|firewall|sophos|paloalto|asa/i.test(descr)) {
      return 'firewall';
    }

    if (pid === 'mikrotik' || /routeros|mikrotik|router|edgerouter|vyos|isr|asr/i.test(descr)) {
      return 'router';
    }

    if (pid.startsWith('alcatel') || pid === 'cisco' || /switch|catalyst|omnistack|aos|procurve|nexus|arubaos-cx/i.test(descr)) {
      return 'switch';
    }

    if (/ups|apc|smart-ups|eaton|cyberpower/i.test(descr)) {
      return 'ups';
    }

    if (pid === 'synology' || /linux|windows|ubuntu|debian|centos|rhel|synology|qnap|esxi|proxmox/i.test(descr)) {
      return 'server';
    }
  }

  if (openPorts.includes(9100) || openPorts.includes(515) || openPorts.includes(631)) return 'printer';
  if (openPorts.includes(8291) || openPorts.includes(8728)) return 'router';
  if (openPorts.includes(3389) || openPorts.includes(22)) return 'server';
  if (openPorts.includes(80) || openPorts.includes(443) || openPorts.includes(8080)) return 'other';
  return 'server';
}

async function probeHost(ip, opts = {}) {
  const communities = Array.isArray(opts.communities) && opts.communities.length
    ? opts.communities
    : ['public'];
  const snmpPort = Number(opts.snmpPort) || 161;
  const tcpPorts = Array.isArray(opts.tcpPorts) ? opts.tcpPorts : [22, 80, 443, 3389, 8291, 9100];
  const pingFn = opts.pingFn || fastPing;
  const snmpGetFn = opts.snmpGetFn || snmp.snmpGet;
  const tcpProbeFn = opts.tcpProbeFn || fastTcpConnect;
  const dnsReverseFn = opts.dnsReverseFn || ((addr) => dns.promises.reverse(addr));

  const pingRes = await pingFn(ip);
  const openPorts = [];

  if (tcpPorts.length) {
    const portChecks = await Promise.all(tcpPorts.map(async (p) => ((await tcpProbeFn(ip, p, 550)) ? p : null)));
    for (const p of portChecks) if (p !== null) openPorts.push(p);
  }

  // Probe SNMP across candidate communities
  let snmpInfo = null;
  for (const comm of communities) {
    try {
      const id = await snmpGetFn({
        host: ip,
        port: snmpPort,
        community: comm,
        oids: [snmp.OIDS.sysDescr, snmp.OIDS.sysObjectID, snmp.OIDS.sysName],
        timeout: 900,
      });
      if (id && (id[snmp.OIDS.sysDescr] !== undefined || id[snmp.OIDS.sysObjectID] !== undefined || id[snmp.OIDS.sysName] !== undefined)) {
        const ident = {
          sysDescr: String(id[snmp.OIDS.sysDescr] || '').trim(),
          sysObjectID: String(id[snmp.OIDS.sysObjectID] || '').trim(),
          sysName: String(id[snmp.OIDS.sysName] || '').trim(),
        };
        const prof = engine.detectProfile(ident);
        snmpInfo = {
          community: comm,
          port: snmpPort,
          ...ident,
          profile_id: prof ? prof.id : '',
          profile_name: prof ? prof.name : 'Generic SNMP',
        };
        break;
      }
    } catch { /* try next community */ }
  }

  if (!pingRes.ok && !openPorts.length && !snmpInfo) {
    return null;
  }

  let dnsName = '';
  if (!snmpInfo || !snmpInfo.sysName) {
    try {
      const names = await Promise.race([
        dnsReverseFn(ip),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 450)),
      ]);
      if (Array.isArray(names) && names[0]) dnsName = String(names[0]).replace(/\.$/, '');
    } catch { /* optional reverse DNS */ }
  }

  const inferredType = inferDeviceType({ snmpInfo, openPorts });
  const rawName = (snmpInfo && snmpInfo.sysName) || dnsName || `${inferredType.toUpperCase()}-${ip.split('.').pop()}`;

  return {
    ip,
    alive: true,
    rtt_ms: pingRes.ok ? pingRes.rtt : null,
    name: String(rawName).slice(0, 100),
    type: inferredType,
    check_icmp: pingRes.ok,
    snmp_enabled: !!snmpInfo,
    snmp_community: snmpInfo ? snmpInfo.community : (communities[0] || 'public'),
    snmp_port: snmpPort,
    snmp_profile: snmpInfo && snmpInfo.profile_id && snmpInfo.profile_id !== 'generic' ? snmpInfo.profile_id : '',
    snmp_profile_name: snmpInfo ? snmpInfo.profile_name : null,
    sys_descr: snmpInfo ? snmpInfo.sysDescr.slice(0, 160) : '',
    open_ports: openPorts,
  };
}

async function scanSubnet({
  target,
  communities = ['public'],
  snmpPort = 161,
  concurrency = 32,
  existingDevices = [],
  probeOpts = {},
}) {
  const ips = parseIpTargets(target, 256);
  const started = Date.now();
  const byIp = new Map();
  for (const d of existingDevices) {
    if (d.address) byIp.set(String(d.address).trim(), d);
  }

  const discovered = [];
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, Number(concurrency) || 32), ips.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < ips.length) {
      const idx = cursor++;
      const ip = ips[idx];
      try {
        const hit = await probeHost(ip, { communities, snmpPort, ...probeOpts });
        if (hit) {
          const existing = byIp.get(ip);
          discovered.push({
            ...hit,
            already_exists: !!existing,
            existing_id: existing ? existing.id : null,
            existing_name: existing ? existing.name : null,
          });
        }
      } catch { /* skip host error */ }
    }
  });

  await Promise.all(workers);
  discovered.sort((a, b) => (ipToInt(a.ip) || 0) - (ipToInt(b.ip) || 0));

  return {
    target,
    scanned_count: ips.length,
    found_count: discovered.length,
    new_count: discovered.filter((d) => !d.already_exists).length,
    duration_ms: Date.now() - started,
    hosts: discovered,
  };
}

function registerRoutes({ route, monitor, readBody, send, bad, audit, cleanDevice, insertDevice, setGroups }, opts = {}) {
  route('GET', '/api/discovery/defaults', 'admin', (ctx) => {
    send(ctx.res, 200, {
      ok: true,
      ...detectLocalSubnet(),
      types: VALID_TYPES,
    });
  });

  route('POST', '/api/discovery/scan', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 16384);
    const target = String(b.target || b.subnet || '').trim();
    const rawComm = b.communities || b.community || 'public';
    const communities = (Array.isArray(rawComm) ? rawComm : String(rawComm).split(/[\s,;]+/))
      .map((c) => String(c).trim())
      .filter(Boolean)
      .slice(0, 5);

    let result;
    try {
      result = await scanSubnet({
        target,
        communities: communities.length ? communities : ['public'],
        snmpPort: Number(b.snmp_port) || 161,
        concurrency: opts.concurrency || 32,
        existingDevices: [...monitor.devices.values()],
        probeOpts: opts,
      });
    } catch (err) {
      throw bad(err.message || 'Không thể quét dải mạng');
    }

    if (audit) {
      audit(ctx, `Quét mạng Auto-Discovery dải "${target}" (phát hiện ${result.found_count}/${result.scanned_count} thiết bị)`);
    }
    send(ctx.res, 200, { ok: true, ...result });
  });

  route('POST', '/api/discovery/import', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 128 * 1024);
    const items = Array.isArray(b.devices) ? b.devices.slice(0, 256) : [];
    if (!items.length) throw bad('Danh sách thiết bị cần thêm đang trống');

    const groupIds = Array.isArray(b.groups) ? b.groups : [];
    const existingAddresses = new Set(
      [...monitor.devices.values()].map((d) => String(d.address || '').trim()).filter(Boolean)
    );

    const added = [];
    const skipped = [];

    for (const raw of items) {
      const addr = String(raw.address || raw.ip || '').trim();
      if (!addr || existingAddresses.has(addr)) {
        skipped.push({ address: addr, reason: 'duplicate_or_empty' });
        continue;
      }
      try {
        const cleaned = cleanDevice({
          name: String(raw.name || `Device-${addr}`).trim().slice(0, 100),
          type: VALID_TYPES.includes(raw.type) ? raw.type : 'server',
          address: addr,
          check_icmp: raw.check_icmp !== false,
          check_agent: !!raw.check_agent,
          snmp_enabled: !!raw.snmp_enabled,
          snmp_community: String(raw.snmp_community || 'public').slice(0, 64),
          snmp_port: Number(raw.snmp_port) || 161,
          snmp_profile: String(raw.snmp_profile || ''),
          location: String(raw.location || '').slice(0, 200),
          notes: String(raw.notes || 'Auto-Discovery').slice(0, 500),
        });
        const { id } = insertDevice(cleaned);
        if (groupIds.length && setGroups) setGroups(id, groupIds);
        existingAddresses.add(addr);
        added.push({ id, name: cleaned.name, address: addr, type: cleaned.type });
      } catch (err) {
        skipped.push({ address: addr, reason: err.message });
      }
    }

    if (added.length) {
      monitor.reload();
      monitor.emit('change');
      if (audit) audit(ctx, `Auto-Discovery: đã thêm ${added.length} thiết bị mới vào hệ thống`);
    }

    send(ctx.res, 201, {
      ok: true,
      added_count: added.length,
      skipped_count: skipped.length,
      added,
      skipped,
    });
  });
}

module.exports = {
  ipToInt,
  intToIp,
  detectLocalSubnet,
  parseIpTargets,
  inferDeviceType,
  probeHost,
  scanSubnet,
  registerRoutes,
};
