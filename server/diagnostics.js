'use strict';
// Independent Quick Diagnostic Toolkit service (Ping, Traceroute, TCP Port Check, Live SNMP Walk).
// Zero-Impact Core: runs strictly on-demand via API, never modifies the background Monitor loop.
const { execFile } = require('node:child_process');
const net = require('node:net');
const snmp = require('./snmp');
const { ADDR_RE } = require('./monitor');

const IS_WIN = process.platform === 'win32';

const WELL_KNOWN_PORTS = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP3',
  143: 'IMAP',
  161: 'SNMP',
  389: 'LDAP',
  443: 'HTTPS',
  445: 'SMB',
  515: 'LPD Printer',
  631: 'IPP Printer',
  1433: 'MSSQL',
  1521: 'Oracle DB',
  3306: 'MySQL / MariaDB',
  3389: 'RDP (Windows)',
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

// ---- 3. TCP Port Scanner / Service Check ------------------------------------
function parsePortsInput(portsInput) {
  const defaultPorts = [22, 80, 443, 3389, 8080, 8291, 9100];
  if (!portsInput) return defaultPorts;
  const rawList = Array.isArray(portsInput)
    ? portsInput
    : String(portsInput).split(/[\s,;]+/).filter(Boolean);
  const valid = [];
  const seen = new Set();
  for (const item of rawList) {
    const p = Number(item);
    if (Number.isInteger(p) && p >= 1 && p <= 65535 && !seen.has(p)) {
      seen.add(p);
      valid.push(p);
      if (valid.length >= 24) break;
    }
  }
  return valid.length ? valid : defaultPorts;
}

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
        service: WELL_KNOWN_PORTS[port] || 'TCP',
        open,
        state,
        rtt_ms: open ? Date.now() - t0 : null,
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

async function runTcpCheck({ host, ports, timeoutMs = 1500, probeFn = defaultTcpProbe }) {
  if (!host || !ADDR_RE.test(host)) throw new Error('Địa chỉ IP/hostname không hợp lệ');
  const portList = parsePortsInput(ports);
  const waitMs = Math.min(5000, Math.max(300, Number(timeoutMs) || 1500));
  const started = Date.now();
  const results = await Promise.all(portList.map((p) => probeFn(host, p, waitMs)));
  const openCount = results.filter((r) => r.open).length;
  return {
    ok: openCount > 0,
    host,
    open_count: openCount,
    total_count: results.length,
    results,
    duration_ms: Date.now() - started,
  };
}

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
      } else if (tool === 'tcp') {
        result = await runTcpCheck({
          host: d.address,
          ports: b.ports,
          timeoutMs: b.timeout_ms,
          probeFn: opts.tcpProbeFn,
        });
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
        throw bad('Công cụ chẩn đoán không hợp lệ (chọn ping, traceroute, tcp hoặc snmp)');
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
}

module.exports = {
  WELL_KNOWN_PORTS,
  SNMP_PRESETS,
  OID_LABELS,
  labelOid,
  parsePingOutput,
  parseTracerouteOutput,
  parsePortsInput,
  runPing,
  runTraceroute,
  runTcpCheck,
  runSnmpLiveWalk,
  registerRoutes,
};
