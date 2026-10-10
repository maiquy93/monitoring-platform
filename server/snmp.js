'use strict';
// Minimal SNMP v2c GET client (no dependencies).
const dgram = require('node:dgram');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  // Printer MIB: first marker supply (toner) level / max capacity
  tonerLevel: '1.3.6.1.2.1.43.11.1.1.9.1.1',
  tonerMax: '1.3.6.1.2.1.43.11.1.1.8.1.1',
  // HOST-RESOURCES-MIB
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageType: '1.3.6.1.2.1.25.2.3.1.2',
  hrStorageUnits: '1.3.6.1.2.1.25.2.3.1.4',
  hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5',
  hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
};
const HR_RAM = '1.3.6.1.2.1.25.2.1.2';
const HR_DISKS = new Set(['1.3.6.1.2.1.25.2.1.4', '1.3.6.1.2.1.25.2.1.9']); // fixed disk, flash memory

function encLen(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), encLen(body.length), body]);

function encInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

function encOid(oid) {
  const p = oid.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const chunk = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function buildGet(community, reqId, oids, pduTag = 0xa0) {
  const varbinds = Buffer.concat(oids.map((o) => tlv(0x30, Buffer.concat([encOid(o), Buffer.from([0x05, 0x00])]))));
  const pdu = tlv(pduTag,  Buffer.concat([encInt(reqId), encInt(0), encInt(0), tlv(0x30, varbinds)]));
  return tlv(0x30, Buffer.concat([encInt(1), tlv(0x04, Buffer.from(community)), pdu]));
}

function readTlv(buf, off) {
  if (off + 2 > buf.length) throw new Error('truncated SNMP packet');
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) throw new Error('bad SNMP length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  if (off + hdr + len > buf.length) throw new Error('truncated SNMP packet');
  return { tag, start: off + hdr, end: off + hdr + len };
}

function decUInt(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
function decInt(b) {
  let v = decUInt(b);
  if (b.length && (b[0] & 0x80)) v -= 2 ** (8 * b.length);
  return v;
}
function decOid(b) {
  if (!b.length) return '';
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

function decodeResponse(buf, expectedReqId) {
  const msg = readTlv(buf, 0);
  let t = readTlv(buf, msg.start); // version
  t = readTlv(buf, t.end);         // community
  const pdu = readTlv(buf, t.end);
  if (pdu.tag !== 0xa2) throw new Error('unexpected PDU type');
  let f = readTlv(buf, pdu.start);
  if (decInt(buf.subarray(f.start, f.end)) !== expectedReqId) throw new Error('request id mismatch');
  f = readTlv(buf, f.end);
  const errStatus = decInt(buf.subarray(f.start, f.end));
  if (errStatus !== 0) throw new Error(`SNMP error status ${errStatus}`);
  f = readTlv(buf, f.end); // error index
  const list = readTlv(buf, f.end);
  const out = {};
  let off = list.start;
  while (off < list.end) {
    const vb = readTlv(buf, off);
    const oidT = readTlv(buf, vb.start);
    const valT = readTlv(buf, oidT.end);
    const raw = buf.subarray(valT.start, valT.end);
    const oid = decOid(buf.subarray(oidT.start, oidT.end));
    let val;
    switch (valT.tag) {
      case 0x02: val = decInt(raw); break;
      case 0x04: val = raw.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '').trim(); break;
      case 0x41: case 0x42: case 0x43: case 0x46: val = decUInt(raw); break;
      case 0x40: val = Array.from(raw).join('.'); break; // IpAddress
      case 0x06: val = decOid(raw); break;
      default: val = null; // null, noSuchObject, noSuchInstance, endOfMibView
    }
    out[oid] = val;
    off = vb.end;
  }
  return out;
}

function snmpGet({ host, port = 161, community = 'public', oids, timeout = 2000, next = false }) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 0x7ffffff) + 1;
    const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let timer;
    const done = (fn, v) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } fn(v); };
    timer = setTimeout(() => done(reject, new Error('SNMP timeout')), timeout);
    sock.on('error', (e) => done(reject, e));
    sock.on('message', (msg) => {
      try { done(resolve, decodeResponse(msg, reqId)); } catch (e) { done(reject, e); }
    });
    sock.send(buildGet(community, reqId, oids, next ? 0xa1 : 0xa0), port, host, (err) => { if (err) done(reject, err); });
  });
}

const oidCmp = (a, b) => {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  }
  return 0;
};

// Walks a whole subtree with GETNEXT; returns [[oid, value], ...] in order.
async function walk({ host, port = 161, community = 'public', root, timeout = 2000, max = 3000 }) {
  const out = [];
  let cur = root;
  while (out.length < max) {
    const r = await snmpGet({ host, port, community, oids: [cur], timeout, next: true });
    const oid = Object.keys(r)[0];
    if (!oid || r[oid] === null || oidCmp(oid, cur) <= 0 || !oid.startsWith(`${root}.`)) break;
    out.push([oid, r[oid]]);
    cur = oid;
  }
  return out;
}

// Walks table columns with GETNEXT; returns { index: { columnOid: value } }.
async function walkColumns({ host, port, community, columns, maxRows = 64, timeout = 2000 }) {
  const rows = {};
  let cur = columns.slice();
  for (let i = 0; i < maxRows; i++) {
    const r = await snmpGet({ host, port, community, oids: cur, timeout, next: true });
    const nextCur = [];
    let any = false;
    columns.forEach((col, ci) => {
      const oid = Object.keys(r).find((k) => k.startsWith(`${col}.`) && r[k] !== null);
      if (oid === undefined) { nextCur[ci] = cur[ci]; return; }
      any = true;
      (rows[oid.slice(col.length + 1)] ||= {})[col] = r[oid];
      nextCur[ci] = oid;
    });
    if (!any) break;
    // stop once the first column leaves its subtree
    if (!Object.keys(r).some((k) => k.startsWith(`${columns[0]}.`) && r[k] !== null)) break;
    cur = nextCur;
  }
  return rows;
}

// CPU/RAM/disk from HOST-RESOURCES-MIB (RouterOS, net-snmp, Windows SNMP...).
async function pollResources({ host, port, community }) {
  const out = {};
  const cpuRows = await walkColumns({ host, port, community, columns: [OIDS.hrProcessorLoad] }).catch(() => ({}));
  const loads = Object.values(cpuRows).map((r) => r[OIDS.hrProcessorLoad]).filter(Number.isFinite);
  if (loads.length) out.cpu = Math.round(loads.reduce((a, b) => a + b, 0) / loads.length);

  const st = await walkColumns({
    host, port, community,
    columns: [OIDS.hrStorageType, OIDS.hrStorageUnits, OIDS.hrStorageSize, OIDS.hrStorageUsed],
  }).catch(() => ({}));
  let disk = null;
  for (const r of Object.values(st)) {
    const size = r[OIDS.hrStorageSize];
    const used = r[OIDS.hrStorageUsed];
    if (!(size > 0) || !Number.isFinite(used)) continue;
    const pct = Math.round((used / size) * 1000) / 10;
    if (r[OIDS.hrStorageType] === HR_RAM && out.ram == null) out.ram = pct;
    else if (HR_DISKS.has(r[OIDS.hrStorageType])) disk = Math.max(disk ?? 0, pct);
  }
  if (disk != null) out.disk = disk;
  return out;
}

// Polls identity/uptime (and printer toner when available).
async function pollDevice({ host, port, community }) {
  const r = await snmpGet({ host, port, community, oids: [OIDS.sysDescr, OIDS.sysUpTime, OIDS.sysName] });
  const info = {
    sysDescr: r[OIDS.sysDescr] || '',
    sysName: r[OIDS.sysName] || '',
    uptime: r[OIDS.sysUpTime] != null ? Math.floor(r[OIDS.sysUpTime] / 100) : null,
  };
  try {
    const p = await snmpGet({ host, port, community, oids: [OIDS.tonerLevel, OIDS.tonerMax], timeout: 1500 });
    const lvl = p[OIDS.tonerLevel];
    const max = p[OIDS.tonerMax];
    if (Number.isFinite(lvl) && Number.isFinite(max) && max > 0 && lvl >= 0) {
      info.toner = Math.round((lvl / max) * 100);
    }
  } catch { /* not a printer or MIB unsupported */ }
  try {
    Object.assign(info, await pollResources({ host, port, community }));
  } catch { /* host resources MIB unsupported */ }
  return info;
}

module.exports = { snmpGet, walk, oidCmp, pollDevice, pollResources, walkColumns, buildGet, decodeResponse, OIDS };
