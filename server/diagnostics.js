'use strict';
// Independent Quick Diagnostic Toolkit service (Ping, Traceroute, Port Scanner TCP/UDP, Live SNMP Walk).
// Zero-Impact Core: runs strictly on-demand via API, never modifies the background Monitor loop.
const { execFile } = require('node:child_process');
const net = require('node:net');
const dgram = require('node:dgram');
const snmp = require('./snmp');
const { ADDR_RE } = require('./monitor');

const IS_WIN = process.platform === 'win32';

const WELL_KNOWN_PORTS = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  67: 'DHCP Server',
  68: 'DHCP Client',
  69: 'TFTP',
  80: 'HTTP',
  110: 'POP3',
  123: 'NTP',
  137: 'NetBIOS-NS',
  138: 'NetBIOS-DGM',
  143: 'IMAP',
  161: 'SNMP',
  162: 'SNMP-Trap',
  389: 'LDAP',
  443: 'HTTPS',
  445: 'SMB',
  500: 'IKE (VPN)',
  514: 'Syslog',
  515: 'LPD Printer',
  631: 'IPP Printer',
  1194: 'OpenVPN',
  1433: 'MSSQL',
  1521: 'Oracle DB',
  1900: 'SSDP / UPnP',
  3306: 'MySQL / MariaDB',
  3389: 'RDP (Windows)',
  4500: 'IPSec NAT-T',
  5353: 'mDNS',
  5432: 'PostgreSQL',
  5900: 'VNC',
  6379: 'Redis',
  8000: 'HTTP-Alt',
  8080: 'HTTP-Proxy / Web',
  8291: 'MikroTik WinBox',
  8443: 'HTTPS-Alt',
  8728: 'MikroTik API',
  9100: 'JetDirect Printer',
};

const SNMP_PRESETS = {
  system: '1.3.6.1.2.1.1',
  interfaces: '1.3.6.1.2.1.2.2.1',
  ifx: '1.3.6.1.2.1.31.1.1.1',
  storage: '1.3.6.1.2.1.25.2.3.1',
  cpu: '1.3.6.1.2.1.25.3.3.1',
  printer: '1.3.6.1.2.1.43.11.1.1',
  arp: '1.3.6.1.2.1.4.22.1',
};

const OID_LABELS = {
  '1.3.6.1.2.1.1.1.0': 'sysDescr.0',
  '1.3.6.1.2.1.1.2.0': 'sysObjectID.0',
  '1.3.6.1.2.1.1.3.0': 'sysUpTime.0',
  '1.3.6.1.2.1.1.4.0': 'sysContact.0',
  '1.3.6.1.2.1.1.5.0': 'sysName.0',
  '1.3.6.1.2.1.1.6.0': 'sysLocation.0',
  '1.3.6.1.2.1.1.7.0': 'sysServices.0',
  '1.3.6.1.2.1.2.2.1.1': 'ifIndex',
  '1.3.6.1.2.1.2.2.1.2': 'ifDescr',
  '1.3.6.1.2.1.2.2.1.3': 'ifType',
  '1.3.6.1.2.1.2.2.1.5': 'ifSpeed',
  '1.3.6.1.2.1.2.2.1.7': 'ifAdminStatus',
  '1.3.6.1.2.1.2.2.1.8': 'ifOperStatus',
  '1.3.6.1.2.1.2.2.1.10': 'ifInOctets',
  '1.3.6.1.2.1.2.2.1.14': 'ifInErrors',
  '1.3.6.1.2.1.2.2.1.16': 'ifOutOctets',
  '1.3.6.1.2.1.2.2.1.20': 'ifOutErrors',
  '1.3.6.1.2.1.31.1.1.1.1': 'ifName',
  '1.3.6.1.2.1.31.1.1.1.6': 'ifHCInOctets',
  '1.3.6.1.2.1.31.1.1.1.10': 'ifHCOutOctets',
  '1.3.6.1.2.1.31.1.1.1.15': 'ifHighSpeed',
  '1.3.6.1.2.1.31.1.1.1.18': 'ifAlias',
  '1.3.6.1.2.1.25.2.3.1.3': 'hrStorageDescr',
  '1.3.6.1.2.1.25.2.3.1.4': 'hrStorageAllocationUnits',
  '1.3.6.1.2.1.25.2.3.1.5': 'hrStorageSize',
  '1.3.6.1.2.1.25.2.3.1.6': 'hrStorageUsed',
  '1.3.6.1.2.1.25.3.3.1.2': 'hrProcessorLoad',
  '1.3.6.1.2.1.43.11.1.1.6': 'prtMarkerSuppliesDescription',
  '1.3.6.1.2.1.43.11.1.1.8': 'prtMarkerSuppliesMaxCapacity',
  '1.3.6.1.2.1.43.11.1.1.9': 'prtMarkerSuppliesLevel',
};

function labelOid(oid) {
  if (OID_LABELS[oid]) return OID_LABELS[oid];
  for (const [prefix, name] of Object.entries(OID_LABELS)) {
    if (oid.startsWith(`${prefix}.`)) {
      return `${name}.${oid.slice(prefix.length + 1)}`;
    }
  }
  return '';
}

function defaultExec(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      resolve({
        err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

// ---- 1. Multi-packet Ping Diagnostic ----------------------------------------
function parsePingOutput(raw, count) {
  const lines = String(raw || '').split(/\r?\n/);
  const replies = [];
  for (const line of lines) {
    if (!/bytes from|Reply from/i.test(line)) continue;
    const seqM = /(?:icmp_seq|seq)=([0-9]+)/i.exec(line);
    const ttlM = /ttl=([0-9]+)/i.exec(line);
    const timeM = /time[=<]\s*([\d.]+)\s*ms/i.exec(line);
    const rtt = timeM ? parseFloat(timeM[1]) : (/time<1ms/i.test(line) ? 0.5 : null);
    replies.push({
      seq: seqM ? Number(seqM[1]) : replies.length + 1,
      ttl: ttlM ? Number(ttlM[1]) : null,
      rtt_ms: rtt,
      raw: line.trim(),
    });
  }

  let transmitted = count;
  let received = replies.length;
  const statM = /(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets )?received/i.exec(raw)
    || /Sent\s*=\s*(\d+),\s*Received\s*=\s*(\d+)/i.exec(raw);
  if (statM) {
    transmitted = Number(statM[1]);
    received = Number(statM[2]);
  }
  const lossPercent = transmitted > 0
    ? Math.max(0, Math.min(100, Math.round(((transmitted - received) / transmitted) * 100)))
    : 100;

  const rtts = replies.map((r) => r.rtt_ms).filter((v) => typeof v === 'number' && Number.isFinite(v));
  let minMs = null, avgMs = null, maxMs = null, jitterMs = null;
  if (rtts.length) {
    minMs = Math.round(Math.min(...rtts) * 100) / 100;
    maxMs = Math.round(Math.max(...rtts) * 100) / 100;
    avgMs = Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 100) / 100;
    if (rtts.length > 1) {
      let diffs = 0;
      for (let i = 1; i < rtts.length; i++) diffs += Math.abs(rtts[i] - rtts[i - 1]);
      jitterMs = Math.round((diffs / (rtts.length - 1)) * 100) / 100;
    } else {
      jitterMs = 0;
    }
  }

  return {
    ok: received > 0,
    transmitted,
    received,
    loss_percent: lossPercent,
    min_ms: minMs,
    avg_ms: avgMs,
    max_ms: maxMs,
    jitter_ms: jitterMs,
    replies,
  };
}

async function runPing({ host, count = 4, timeoutSec = 1, execFn = defaultExec }) {
  if (!host || !ADDR_RE.test(host)) throw new Error('Địa chỉ IP/hostname không hợp lệ');
  const pktCount = Math.min(10, Math.max(1, Number(count) || 4));
  const waitSec = Math.min(5, Math.max(1, Number(timeoutSec) || 1));
  const started = Date.now();
  const args = IS_WIN
    ? ['-n', String(pktCount), '-w', String(waitSec * 1000), host]
    : ['-c', String(pktCount), '-W', String(waitSec), host];
  const { stdout, stderr } = await execFn('ping', args, (pktCount * waitSec + 4) * 1000);
  const rawOutput = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  const parsed = parsePingOutput(rawOutput, pktCount);
  return {
    ...parsed,
    host,
    count: pktCount,
    raw_output: rawOutput || `ping ${host}: không có phản hồi`,
    duration_ms: Date.now() - started,
  };
}

// ---- 2. Traceroute Diagnostic (with tracepath & TTL sweep fallback) ---------
function parseTracerouteOutput(raw) {
  const hops = [];
  const lines = String(raw || '').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const hopNum = Number(m[1]);
    const rest = m[2].trim();
    if (!Number.isInteger(hopNum) || hopNum < 1 || hopNum > 64) continue;
    if (/^\*(\s+\*)*$/.test(rest) || /no reply/i.test(rest)) {
      hops.push({ hop: hopNum, ip: '*', rtt_ms: null, timeout: true, raw: line.trim() });
      continue;
    }
    const ipM = /((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{3,39})/.exec(rest);
    const timeM = /([\d.]+)\s*ms/i.exec(rest);
    hops.push({
      hop: hopNum,
      ip: ipM ? ipM[1] : rest.split(/\s+/)[0],
      rtt_ms: timeM ? parseFloat(timeM[1]) : null,
      timeout: false,
      raw: line.trim(),
    });
  }
  return hops;
}

async function runTraceroute({ host, maxHops = 15, timeoutSec = 1, execFn = defaultExec }) {
  if (!host || !ADDR_RE.test(host)) throw new Error('Địa chỉ IP/hostname không hợp lệ');
  const limitHops = Math.min(25, Math.max(1, Number(maxHops) || 15));
  const waitSec = Math.min(3, Math.max(1, Number(timeoutSec) || 1));
  const started = Date.now();

  const cmd = IS_WIN ? 'tracert' : 'traceroute';
  const args = IS_WIN
    ? ['-d', '-h', String(limitHops), '-w', String(waitSec * 1000), host]
    : ['-n', '-w', String(waitSec), '-q', '1', '-m', String(limitHops), host];

  let res = await execFn(cmd, args, (limitHops * waitSec + 5) * 1000);

  // Fallback 1: Linux tracepath if traceroute is not installed
  if (res.err && res.err.code === 'ENOENT' && !IS_WIN) {
    res = await execFn('tracepath', ['-n', '-m', String(limitHops), host], (limitHops * waitSec + 5) * 1000);
  }

  // Fallback 2: Sequential ICMP TTL sweep using standard `ping -t <ttl>` if neither traceroute nor tracepath exists
  if (res.err && res.err.code === 'ENOENT' && !IS_WIN) {
    const rawLines = [`traceroute to ${host}, ${limitHops} hops max (ICMP TTL mode)`];
    const hops = [];
    for (let ttl = 1; ttl <= Math.min(limitHops, 12); ttl++) {
      const t0 = Date.now();
      const pr = await execFn('ping', ['-c', '1', '-W', '1', '-t', String(ttl), host], 2500);
      const out = `${pr.stdout}\n${pr.stderr}`;
      const rttM = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      const fromM = /From\s+((?:\d{1,3}\.){3}\d{1,3})/i.exec(out) || /bytes from\s+((?:\d{1,3}\.){3}\d{1,3})/i.exec(out);
      const rtt = rttM ? parseFloat(rttM[1]) : (fromM ? Math.max(0.5, Date.now() - t0) : null);
      if (fromM) {
        const ip = fromM[1];
        const line = ` ${ttl}  ${ip}  ${rtt.toFixed(2)} ms`;
        rawLines.push(line);
        hops.push({ hop: ttl, ip, rtt_ms: Number(rtt.toFixed(2)), timeout: false, raw: line.trim() });
        if (ip === host || /bytes from/i.test(out)) break;
      } else {
        const line = ` ${ttl}  *`;
        rawLines.push(line);
        hops.push({ hop: ttl, ip: '*', rtt_ms: null, timeout: true, raw: line.trim() });
      }
    }
    return {
      ok: hops.some((h) => !h.timeout),
      host,
      max_hops: limitHops,
      hops,
      raw_output: rawLines.join('\n'),
      duration_ms: Date.now() - started,
    };
  }

  const rawOutput = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join('\n');
  const hops = parseTracerouteOutput(rawOutput);
  return {
    ok: hops.some((h) => !h.timeout) || (!res.err && rawOutput.length > 0),
    host,
    max_hops: limitHops,
    hops,
    raw_output: rawOutput || `Không thể chạy traceroute tới ${host}`,
    duration_ms: Date.now() - started,
  };
}

// ---- 3. Port Scanner / Service Check (TCP + UDP) ----------------------------

const CORE_UDP_PORTS = {
  53: 'udp',   // DNS
  67: 'udp',   // DHCP Server
  68: 'udp',   // DHCP Client
  69: 'udp',   // TFTP
  123: 'udp',  // NTP
  137: 'udp',  // NetBIOS-NS
  138: 'udp',  // NetBIOS-DGM
  161: 'udp',  // SNMP
  162: 'udp',  // SNMP-Trap
  500: 'udp',  // IKE (VPN)
  514: 'udp',  // Syslog
  1194: 'udp', // OpenVPN
  1900: 'udp', // SSDP / UPnP
  4500: 'udp', // IPSec NAT-T
  5353: 'udp', // mDNS
};

// RFC-compliant probes for common UDP services to elicit responses from daemons and prevent silent firewall drops:
// - Port 161: SNMPv2c GetRequest for sysUpTime (1.3.6.1.2.1.1.3.0) with community 'public'
const SNMP_PROBE_PAYLOAD = Buffer.from('302602010104067075626c6963a019020101020100020100300e300c06082b060102010103000500', 'hex');
// - Port 53: DNS Standard Query for root '.' (IN A)
const DNS_PROBE_PAYLOAD = Buffer.from('1234010000010000000000000000010001', 'hex');
// - Port 123: NTP v3/v4 client mode probe (48 bytes)
const NTP_PROBE_PAYLOAD = Buffer.concat([Buffer.from([0x1b]), Buffer.alloc(47)]);

/**
 * Checks whether the input string/array contains a port range expression (e.g. "22-8000" or "22 - 8000").
 */
function hasRangeInput(portsInput) {
  if (!portsInput && portsInput !== 0) return false;
  const str = Array.isArray(portsInput) ? portsInput.join(',') : String(portsInput);
  return /\d+\s*-\s*\d+/.test(str);
}

/**
 * Parses user input for ports supporting:
 * - Auto protocol mapping for core UDP ports (e.g. 161, 53, 123 -> udp; others -> tcp)
 * - Explicit suffix override: "161/udp, 80/tcp, 161/tcp, 80/udp"
 * - Comma / semicolon / whitespace separated lists
 * - Port ranges with or without suffix (e.g. "22-8000", "160-162/udp", "80-85/tcp")
 * - Combined expressions (e.g. "22, 53, 80/tcp, 100-105")
 * - Array of ports/ranges/objects
 * - Safe clamping to 1..65535, invalid token filtering, and deduplication by port/protocol
 */
function parsePortsInput(portsInput) {
  const defaultTargets = [22, 80, 443, 3389, 8080, 8291, 9100].map((p) => ({ port: p, protocol: 'tcp' }));
  if (!portsInput && portsInput !== 0) return defaultTargets;

  let rawSegments = [];
  if (Array.isArray(portsInput)) {
    for (const item of portsInput) {
      if (item && typeof item === 'object' && item.port) {
        rawSegments.push(item.protocol ? `${item.port}/${item.protocol}` : String(item.port));
      } else {
        rawSegments.push(String(item));
      }
    }
  } else {
    rawSegments = String(portsInput).split(/[\n\r,;]+/);
  }

  const valid = [];
  const seen = new Set();

  const addTarget = (p, explicitProto) => {
    if (!Number.isInteger(p) || p < 1 || p > 65535) return;
    const proto = explicitProto ? explicitProto.toLowerCase() : (CORE_UDP_PORTS[p] || 'tcp');
    if (proto !== 'tcp' && proto !== 'udp') return;
    const key = `${p}/${proto}`;
    if (!seen.has(key)) {
      seen.add(key);
      const target = { port: p, protocol: proto };
      if (explicitProto) target.explicit = true;
      valid.push(target);
    }
  };

  const addRange = (start, end, explicitProto) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const min = Math.max(1, Math.min(start, end));
    const max = Math.min(65535, Math.max(start, end));
    if (min > 65535 || max < 1) return;
    for (let p = min; p <= max; p++) {
      addTarget(p, explicitProto);
    }
  };

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed) continue;

    // Direct range match: e.g. "22-8000", "22 - 25", "160-162/udp", "80-85/tcp"
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)(?:\s*\/\s*(tcp|udp))?$/i);
    if (rangeMatch) {
      addRange(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10), rangeMatch[3]);
      continue;
    }

    // Direct single port match: e.g. "80", "161/udp", "443/tcp"
    const singleMatch = trimmed.match(/^(\d+)(?:\s*\/\s*(tcp|udp))?$/i);
    if (singleMatch) {
      addTarget(parseInt(singleMatch[1], 10), singleMatch[2]);
      continue;
    }

    // Whitespace separated tokens within segment
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const subRange = token.match(/^(\d+)\s*-\s*(\d+)(?:\s*\/\s*(tcp|udp))?$/i);
      if (subRange) {
        addRange(parseInt(subRange[1], 10), parseInt(subRange[2], 10), subRange[3]);
      } else {
        const subSingle = token.match(/^(\d+)(?:\s*\/\s*(tcp|udp))?$/i);
        if (subSingle) {
          addTarget(parseInt(subSingle[1], 10), subSingle[2]);
        }
      }
    }
  }

  return valid.length ? valid : defaultTargets;
}

/**
 * Standard TCP probe using net.Socket connect + timeout.
 */
function defaultTcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finish = (open, state, error = null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({
        port,
        protocol: 'tcp',
        service: WELL_KNOWN_PORTS[port] || 'TCP',
        open,
        state,
        rtt_ms: open ? Math.max(1, Date.now() - t0) : null,
        error,
      });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, 'open', null));
    sock.once('timeout', () => finish(false, 'timeout', 'Timeout'));
    sock.once('error', (err) => {
      const code = err && err.code ? err.code : 'CLOSED';
      finish(false, code === 'ECONNREFUSED' ? 'closed' : 'filtered', code);
    });
    try {
      sock.connect(port, host);
    } catch (err) {
      finish(false, 'error', err.message || 'Error');
    }
  });
}

/**
 * Standard UDP probe using node:dgram connect + payload probe + timeout.
 * - Port 53: DNS root query header
 * - Port 161: SNMP v1/v2c GetRequest for sysUpTime
 * - Port 123: NTP client mode request
 * - Generic: 1-byte dummy packet
 * Any byte received from target is treated as OPEN.
 */
function defaultUdpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let socket;

    try {
      const isIpv6 = net.isIP(host) === 6;
      socket = dgram.createSocket(isIpv6 ? 'udp6' : 'udp4');
    } catch (err) {
      return resolve({
        port,
        protocol: 'udp',
        service: WELL_KNOWN_PORTS[port] || 'UDP',
        open: false,
        state: 'error',
        rtt_ms: null,
        error: err.message,
      });
    }

    const cleanup = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
    };

    const finish = (open, state, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        port,
        protocol: 'udp',
        service: WELL_KNOWN_PORTS[port] || 'UDP',
        open,
        state,
        rtt_ms: open ? Math.max(1, Date.now() - t0) : null,
        error,
      });
    };

    const timer = setTimeout(() => {
      finish(false, 'timeout', 'Timeout');
    }, timeoutMs);

    socket.on('error', (err) => {
      const code = err && err.code ? err.code : 'CLOSED';
      finish(false, code === 'ECONNREFUSED' ? 'closed' : 'filtered', code);
    });

    // Any byte response returned (even error status / auth rejection) proves the UDP daemon is alive and listening
    socket.on('message', () => {
      finish(true, 'open', null);
    });

    try {
      socket.connect(port, host, (err) => {
        if (err) return finish(false, 'error', err.message);

        let payload;
        if (port === 53) {
          payload = DNS_PROBE_PAYLOAD;
        } else if (port === 161) {
          try {
            payload = snmp.buildGet('public', 1, [snmp.OIDS.sysUpTime]);
          } catch {
            payload = SNMP_PROBE_PAYLOAD;
          }
        } else if (port === 123) {
          payload = NTP_PROBE_PAYLOAD;
        } else {
          // 1-byte dummy packet for other UDP services
          payload = Buffer.from([0x00]);
        }

        socket.send(payload, (sendErr) => {
          if (sendErr) finish(false, 'error', sendErr.message);
        });
      });
    } catch (err) {
      finish(false, 'error', err.message);
    }
  });
}

/**
 * Port Scanner Coordinator with dual TCP/UDP scanning and Concurrency Pool.
 * - Auto protocol mapping: UDP ports (161, 53, 123...) use UDP probe; TCP ports use TCP probe.
 * - Explicit override: "/udp" and "/tcp" suffixes override auto mapping.
 * - If small list (<= 32 ports): detailed array with cards (OPEN, CLOSED, TIMEOUT).
 * - If range / large port count (> 32 ports, e.g. 22-8000): returns summary counts
 *   (tcp_open_count, udp_open_count, open_ports list) without allocating thousands
 *   of closed port objects in memory.
 */
async function runPortScan({
  host,
  ports,
  timeoutMs = 1500,
  concurrency = 32,
  protocols = ['tcp', 'udp'],
  tcpProbeFn = defaultTcpProbe,
  udpProbeFn = defaultUdpProbe,
  probeFn, // backward-compatible alias for tcpProbeFn
  mode,    // 'auto' | 'detailed' | 'summary'
}) {
  if (!host || !ADDR_RE.test(host)) throw new Error('Địa chỉ IP/hostname không hợp lệ');

  const actualTcpProbe = probeFn || tcpProbeFn || defaultTcpProbe;
  const actualUdpProbe = udpProbeFn || defaultUdpProbe;
  let targetList = parsePortsInput(ports);

  // If caller explicitly restricted protocols filter to a single protocol (e.g. ['tcp'] or ['udp'])
  if (Array.isArray(protocols) && protocols.length === 1) {
    const singleProto = protocols[0].toLowerCase();
    if (singleProto === 'tcp' || singleProto === 'udp') {
      targetList = targetList.map((t) => (t.explicit ? t : { ...t, protocol: singleProto }));
    }
  }

  const isRange = hasRangeInput(ports);
  // Auto-detect summary mode for large ranges or large port counts
  const isSummary = mode === 'summary' || (mode !== 'detailed' && (targetList.length > 32 || (isRange && targetList.length > 20)));

  const defaultTimeout = isSummary ? 800 : 1500;
  const waitMs = Math.min(5000, Math.max(100, Number(timeoutMs) || defaultTimeout));
  const maxConcurrency = Math.min(128, Math.max(1, Number(concurrency) || (isSummary ? 64 : 32)));

  const started = Date.now();

  let tcpOpenCount = 0;
  let udpOpenCount = 0;
  let totalOpenCount = 0;
  const openPorts = [];
  const detailedResults = isSummary ? null : new Array(targetList.length);

  // Concurrency Pool (Worker Queue)
  let nextIdx = 0;
  const workerCount = Math.min(maxConcurrency, targetList.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIdx < targetList.length) {
      const idx = nextIdx++;
      const target = targetList[idx];
      const p = target.port;
      const proto = target.protocol;

      let probeRes;
      if (proto === 'udp') {
        probeRes = await actualUdpProbe(host, p, waitMs);
      } else {
        probeRes = await actualTcpProbe(host, p, waitMs);
      }

      const isOpen = Boolean(probeRes && probeRes.open);
      if (isOpen) {
        totalOpenCount++;
        if (proto === 'udp') {
          udpOpenCount++;
        } else {
          tcpOpenCount++;
        }
      }

      const state = isOpen ? 'open' : (probeRes?.state || 'closed');
      const rttMs = isOpen ? probeRes.rtt_ms : null;
      const serviceName = WELL_KNOWN_PORTS[p] || (proto === 'udp' ? 'UDP' : 'TCP');

      if (isSummary) {
        if (isOpen) {
          openPorts.push({
            port: p,
            service: serviceName,
            protocol: proto,
            state: 'open',
            rtt_ms: rttMs,
            tcp: proto === 'tcp' ? probeRes : null,
            udp: proto === 'udp' ? probeRes : null,
          });
        }
      } else {
        detailedResults[idx] = {
          port: p,
          service: serviceName,
          protocol: proto,
          open: isOpen,
          state,
          rtt_ms: rttMs,
          error: isOpen ? null : (probeRes?.error || null),
          tcp: proto === 'tcp' ? probeRes : null,
          udp: proto === 'udp' ? probeRes : null,
        };
      }
    }
  });

  await Promise.all(workers);

  if (isSummary) {
    openPorts.sort((a, b) => a.port - b.port);
    return {
      ok: totalOpenCount > 0,
      host,
      mode: 'summary',
      is_range: isRange,
      open_count: totalOpenCount,
      tcp_open_count: tcpOpenCount,
      udp_open_count: udpOpenCount,
      total_count: targetList.length,
      open_ports: openPorts,
      duration_ms: Date.now() - started,
    };
  }

  return {
    ok: totalOpenCount > 0,
    host,
    mode: 'detailed',
    is_range: isRange,
    open_count: totalOpenCount,
    tcp_open_count: tcpOpenCount,
    udp_open_count: udpOpenCount,
    total_count: detailedResults.length,
    results: detailedResults,
    duration_ms: Date.now() - started,
  };
}

// Backward-compatible alias for existing callers
const runTcpCheck = runPortScan;

// ---- 4. Live SNMP Walk / OID Inspector --------------------------------------
async function runSnmpLiveWalk({
  host,
  port = 161,
  community = 'public',
  oid = 'system',
  maxRows = 60,
  timeoutMs = 2000,
  walkFn = snmp.walk,
  getFn = snmp.snmpGet,
}) {
  if (!host || !ADDR_RE.test(host)) throw new Error('Địa chỉ IP/hostname không hợp lệ');
  const rawOid = String(oid || 'system').trim().replace(/^\./, '');
  const rootOid = SNMP_PRESETS[rawOid.toLowerCase()] || rawOid;
  if (!/^\d+(\.\d+)+$/.test(rootOid)) {
    throw new Error('OID không hợp lệ (cần định dạng số như 1.3.6.1.2.1.1 hoặc chọn nhánh mẫu)');
  }
  const limit = Math.min(150, Math.max(1, Number(maxRows) || 60));
  const started = Date.now();
  let rows = [];
  let error = null;

  try {
    const walked = await walkFn({
      host,
      port: Number(port) || 161,
      community: community || 'public',
      root: rootOid,
      timeout: timeoutMs,
      max: limit,
      typed: true,
    });
    rows = walked.map(([o, val, type]) => ({
      oid: o,
      label: labelOid(o),
      type: type || 'VALUE',
      value: val === null || val === undefined ? '' : String(val),
    }));

    // If walking a scalar leaf OID (e.g. 1.3.6.1.2.1.1.1.0) returned 0 subtree items, try exact snmpGet
    if (!rows.length) {
      const types = {};
      const single = await getFn({
        host,
        port: Number(port) || 161,
        community: community || 'public',
        oids: [rootOid],
        timeout: timeoutMs,
        types,
      });
      if (single && single[rootOid] !== undefined && single[rootOid] !== null) {
        rows.push({
          oid: rootOid,
          label: labelOid(rootOid),
          type: types[rootOid] || 'VALUE',
          value: String(single[rootOid]),
        });
      }
    }
  } catch (err) {
    error = err.message || 'SNMP timeout';
  }

  return {
    ok: rows.length > 0 && !error,
    host,
    port: Number(port) || 161,
    root_oid: rootOid,
    count: rows.length,
    rows,
    error,
    duration_ms: Date.now() - started,
  };
}

function isLocalAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase().trim();
  if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return true;
  const os = require('node:os');
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name]) {
        if (info.address && info.address.toLowerCase() === a) return true;
      }
    }
  } catch {}
  return false;
}

function parseAndValidateListeningPorts(input) {
  let list = input;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list.trim() || '[]');
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [];

  const seen = new Map();
  let tcpCount = 0;
  let udpCount = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const proto = String(item.proto || item.protocol || '').toLowerCase().trim();
    if (proto !== 'tcp' && proto !== 'udp') continue;

    const port = Number(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

    let service = String(item.service || item.process || item.name || '').trim();
    const key = `${proto}:${port}`;

    if (seen.has(key)) {
      const existing = seen.get(key);
      if ((!existing.service || existing.service === '-') && service) {
        existing.service = service;
      }
      continue;
    }

    if (!service && WELL_KNOWN_PORTS[port]) {
      service = WELL_KNOWN_PORTS[port];
    }

    if (proto === 'tcp') tcpCount++;
    else if (proto === 'udp') udpCount++;

    seen.set(key, {
      proto,
      port,
      service: service || '-',
      state: 'LISTEN',
    });
  }

  const cleaned = Array.from(seen.values());
  cleaned.sort((a, b) => {
    if (a.proto !== b.proto) return a.proto === 'tcp' ? -1 : 1;
    return a.port - b.port;
  });

  return {
    tcp_count: tcpCount,
    udp_count: udpCount,
    total_count: cleaned.length,
    services: cleaned,
  };
}

function collectLocalListeningPorts(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const psCmd = `$procMap = @{0='System';4='System'}; try { Get-Process -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Id -ne $null -and $_.ProcessName) { $procMap[[int]$_.Id] = $_.ProcessName } } } catch {}; function Resolve-PName($p) { if ($p -eq 4 -or $p -eq 0) { return 'System' }; if ($procMap.ContainsKey($p) -and -not [string]::IsNullOrEmpty($procMap[$p])) { return $procMap[$p] }; try { $o = Get-Process -Id $p -ErrorAction SilentlyContinue; if ($o -and $o.ProcessName) { return $o.ProcessName } } catch {}; return 'System/Unknown' }; $tcp = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{proto='tcp';port=[int]$_.LocalPort;service=(Resolve-PName([int]$_.OwningProcess))} }); $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{proto='udp';port=[int]$_.LocalPort;service=(Resolve-PName([int]$_.OwningProcess))} }); (@($tcp)+@($udp)) | ConvertTo-Json -Compress`;
      execFile('powershell', ['-NoProfile', '-Command', psCmd], { timeout: timeoutMs }, (err, stdout) => {
        if (err || !stdout) return resolve(parseAndValidateListeningPorts([]));
        resolve(parseAndValidateListeningPorts(stdout));
      });
      return;
    }

    const script = `ss -tulnp 2>/dev/null | awk 'NR>1 {
      proto = tolower($1);
      if (proto ~ /^tcp/) proto = "tcp";
      else if (proto ~ /^udp/) proto = "udp";
      else next;

      state = $2;
      if (proto == "tcp" && state != "LISTEN") next;
      if (proto == "udp" && state != "UNCONN" && state != "LISTEN" && state != "ESTAB") next;

      n = split($5, addr_parts, ":");
      port = addr_parts[n] + 0;
      if (port < 1 || port > 65535) next;

      svc = "";
      idx = index($0, "users:((\\"");
      if (idx > 0) {
        rem = substr($0, idx + 9);
        qidx = index(rem, "\\"");
        if (qidx > 0) svc = substr(rem, 1, qidx - 1);
      }

      key = proto ":" port;
      if (!seen[key] || (svc != "" && services[key] == "")) {
        if (!seen[key]) {
          seen[key] = 1;
          order[++count] = key;
        }
        protos[key] = proto;
        ports[key] = port;
        services[key] = svc;
      }
    }
    END {
      printf "[";
      for (i = 1; i <= count; i++) {
        k = order[i];
        if (i > 1) printf ",";
        s = services[k];
        gsub(/\\\\/, "\\\\\\\\", s); gsub(/\\"/, "\\\\\\"", s);
        printf "{\\"proto\\":\\"%s\\",\\"port\\":%d,\\"service\\":\\"%s\\"}", protos[k], ports[k], s;
      }
      printf "]";
    }'`;

    execFile('sh', ['-c', script], { timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout) return resolve(parseAndValidateListeningPorts([]));
      resolve(parseAndValidateListeningPorts(stdout));
    });
  });
}

// ---- Route Registration (Plug-and-Play into server/app.js) ------------------
function registerRoutes({ route, monitor, readBody, send, idOf, bad, HttpError, audit }, opts = {}) {
  route('POST', '/api/devices/:id/diag', 'operator', async (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');
    if (!d.address) throw bad('Thiết bị chưa có địa chỉ IP/hostname để chẩn đoán');

    const b = await readBody(ctx.req, 16384);
    const tool = String(b.tool || 'ping').toLowerCase().trim();

    let result;
    try {
      if (tool === 'ping') {
        result = await runPing({
          host: d.address,
          count: b.count,
          timeoutSec: b.timeout_sec,
          execFn: opts.pingExecFn || opts.execFn,
        });
      } else if (tool === 'traceroute') {
        result = await runTraceroute({
          host: d.address,
          maxHops: b.max_hops,
          timeoutSec: b.timeout_sec,
          execFn: opts.traceExecFn || opts.execFn,
        });
      } else if (tool === 'tcp' || tool === 'ports' || tool === 'port' || tool === 'port_scan' || tool === 'listening_ports' || tool === 'listening_services') {
        if (d.type === 'server') {
          const st = monitor.state.get(d.id);
          let agentData = st?.agent?.listening_services || st?.agent?.data?.listening_services;

          if (b.raw || b.ports_json || (Array.isArray(b.ports) && typeof b.ports[0] === 'object')) {
            agentData = parseAndValidateListeningPorts(b.raw || b.ports_json || b.ports);
            if (st) {
              if (!st.agent) st.agent = { data: {} };
              st.agent.listening_services = agentData;
              if (st.agent.data) st.agent.data.listening_services = agentData;
            }
          }

          if ((!agentData || agentData.total_count === 0) && isLocalAddress(d.address)) {
            try {
              const localData = await collectLocalListeningPorts();
              if (localData && localData.total_count > 0) {
                agentData = localData;
                if (st) {
                  if (!st.agent) st.agent = { data: {} };
                  st.agent.listening_services = agentData;
                  if (st.agent.data) st.agent.data.listening_services = agentData;
                }
              }
            } catch {}
          }

          if (!agentData) {
            agentData = {
              tcp_count: 0,
              udp_count: 0,
              total_count: 0,
              services: [],
            };
          }

          result = {
            ok: agentData.total_count > 0,
            mode: 'agent',
            host: d.address,
            device_type: 'server',
            tcp_count: agentData.tcp_count,
            udp_count: agentData.udp_count,
            total_count: agentData.total_count,
            services: agentData.services,
            open_count: agentData.total_count,
            tcp_open_count: agentData.tcp_count,
            udp_open_count: agentData.udp_count,
            open_ports: agentData.services,
            duration_ms: 5,
          };
        } else {
          result = await runPortScan({
            host: d.address,
            ports: b.ports,
            timeoutMs: b.timeout_ms,
            concurrency: b.concurrency,
            protocols: b.protocols,
            mode: b.mode,
            tcpProbeFn: opts.tcpProbeFn,
            udpProbeFn: opts.udpProbeFn,
            probeFn: opts.tcpProbeFn,
          });
        }
      } else if (tool === 'snmp') {
        result = await runSnmpLiveWalk({
          host: d.address,
          port: d.snmp_port || 161,
          community: d.snmp_community || 'public',
          oid: b.oid || 'system',
          maxRows: b.max_rows || 60,
          walkFn: opts.snmpWalkFn,
          getFn: opts.snmpGetFn,
        });
      } else {
        throw bad('Công cụ chẩn đoán không hợp lệ (chọn ping, traceroute, tcp/port hoặc snmp)');
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw bad(err.message || 'Lỗi khi chạy công cụ chẩn đoán');
    }

    if (audit && b.audit) {
      audit(ctx, `Chẩn đoán ${tool.toUpperCase()} trên "${d.name}" (${d.address})`);
    }

    send(ctx.res, 200, {
      ok: true,
      tool,
      device_id: d.id,
      device_name: d.name,
      device_type: d.type,
      address: d.address,
      result,
    });
  });

  // GET /api/devices/:id/listening-services
  route('GET', '/api/devices/:id/listening-services', 'operator', async (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');

    const st = monitor.state.get(id);
    let agentData = st?.agent?.listening_services || st?.agent?.data?.listening_services;

    if ((!agentData || agentData.total_count === 0) && isLocalAddress(d.address)) {
      try {
        const localData = await collectLocalListeningPorts();
        if (localData && localData.total_count > 0) {
          agentData = localData;
          if (st) {
            if (!st.agent) st.agent = { data: {} };
            st.agent.listening_services = agentData;
            if (st.agent.data) st.agent.data.listening_services = agentData;
          }
        }
      } catch {}
    }

    if (!agentData) {
      agentData = {
        tcp_count: 0,
        udp_count: 0,
        total_count: 0,
        services: [],
      };
    }

    send(ctx.res, 200, {
      ok: true,
      device_id: d.id,
      device_name: d.name,
      device_type: d.type,
      address: d.address,
      ...agentData,
    });
  });

  // POST /api/devices/:id/listening-services
  route('POST', '/api/devices/:id/listening-services', 'operator', async (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');

    const b = await readBody(ctx.req, 65536);
    const rawData = (b && typeof b === 'object' && ('ports' in b || 'services' in b || 'data' in b || 'raw' in b))
      ? (b.ports || b.services || b.data || b.raw)
      : b;

    const validated = parseAndValidateListeningPorts(rawData);
    const st = monitor.state.get(id);
    if (st) {
      if (!st.agent) st.agent = { data: {} };
      st.agent.listening_services = validated;
      if (st.agent.data) st.agent.data.listening_services = validated;
    }

    send(ctx.res, 200, {
      ok: true,
      device_id: d.id,
      device_name: d.name,
      device_type: d.type,
      address: d.address,
      ...validated,
    });
  });
}

module.exports = {
  WELL_KNOWN_PORTS,
  CORE_UDP_PORTS,
  SNMP_PROBE_PAYLOAD,
  DNS_PROBE_PAYLOAD,
  NTP_PROBE_PAYLOAD,
  SNMP_PRESETS,
  OID_LABELS,
  labelOid,
  parsePingOutput,
  parseTracerouteOutput,
  parsePortsInput,
  hasRangeInput,
  defaultTcpProbe,
  defaultUdpProbe,
  runPing,
  runTraceroute,
  runPortScan,
  runTcpCheck,
  runSnmpLiveWalk,
  isLocalAddress,
  parseAndValidateListeningPorts,
  collectLocalListeningPorts,
  registerRoutes,
};
