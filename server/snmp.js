'use strict';
// Minimal SNMP v2c GET client (no dependencies).
const dgram = require('node:dgram');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  tcpInSegs: '1.3.6.1.2.1.6.10.0',
  udpInDatagrams: '1.3.6.1.2.1.7.1.0',
};

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

const TYPE_NAMES = { 0x02: 'INTEGER', 0x04: 'STRING', 0x06: 'OID', 0x40: 'IPADDR', 0x41: 'COUNTER32', 0x42: 'GAUGE32', 0x43: 'TIMETICKS', 0x46: 'COUNTER64' };
const isPrintable = (raw) => raw.every((x) => x === 9 || x === 10 || x === 13 || (x >= 0x20 && x < 0x7f) || x >= 0x80)
  && Buffer.from(raw).toString('utf8').indexOf('\ufffd') < 0;

// `types` (optional) is filled with oid -> type name, for exact replay of walks.
function decodeResponse(buf, expectedReqId, types) {
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
      case 0x04:
        if (!isPrintable(raw)) { val = raw.toString('hex'); if (types) types[oid] = 'HEX'; break; }
        val = raw.toString('utf8').replace(/[\x00-\x1f\x7f]/g, '').trim();
        break;
      case 0x41: case 0x42: case 0x43: case 0x46: val = decUInt(raw); break;
      case 0x40: val = Array.from(raw).join('.'); break; // IpAddress
      case 0x06: val = decOid(raw); break;
      default: val = null; // null, noSuchObject, noSuchInstance, endOfMibView
    }
    out[oid] = val;
    if (types && val !== null && !types[oid]) types[oid] = TYPE_NAMES[valT.tag];
    off = vb.end;
  }
  return out;
}

function snmpGet({ host, port = 161, community = 'public', oids, timeout = 2000, next = false, types }) {
  return new Promise((resolve, reject) => {
    const reqId = Math.floor(Math.random() * 0x7ffffff) + 1;
    const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
    let timer;
    const done = (fn, v) => { clearTimeout(timer); try { sock.close(); } catch { /* closed */ } fn(v); };
    timer = setTimeout(() => done(reject, new Error('SNMP timeout')), timeout);
    sock.on('error', (e) => done(reject, e));
    sock.on('message', (msg) => {
      try { done(resolve, decodeResponse(msg, reqId, types)); } catch (e) { done(reject, e); }
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

// Walks a whole subtree with GETNEXT; returns [[oid, value], ...] in order
// (with `typed`, [[oid, value, type], ...]).
async function walk({ host, port = 161, community = 'public', root, timeout = 2000, max = 3000, typed = false }) {
  const out = [];
  let cur = root;
  while (out.length < max) {
    const types = typed ? {} : undefined;
    const r = await snmpGet({ host, port, community, oids: [cur], timeout, next: true, types });
    const oid = Object.keys(r)[0];
    if (!oid || r[oid] === null || oidCmp(oid, cur) <= 0 || !oid.startsWith(`${root}.`)) break;
    out.push(typed ? [oid, r[oid], types[oid]] : [oid, r[oid]]);
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

module.exports = {
  snmpGet, walk, walkColumns, oidCmp, buildGet, decodeResponse, encOid, encInt, tlv, readTlv, decOid, decInt, OIDS,
};
