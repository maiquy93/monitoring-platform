'use strict';
// Fake SNMP agent that replays a real device's .walk file over UDP (v2c GET / GETNEXT).
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const snmp = require('../../server/snmp');
const walkfile = require('../../server/snmp-walkfile');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const { tlv, encOid, readTlv, decOid, decInt, oidCmp } = snmp;

function bytesOf(n, signed) {
  let b = BigInt(n);
  const out = [];
  do { out.unshift(Number(b & 0xffn)); b >>= 8n; } while (signed ? (b !== 0n && b !== -1n) : b !== 0n);
  if (signed) {
    if (n >= 0 && out[0] & 0x80) out.unshift(0);
    if (n < 0 && !(out[0] & 0x80)) out.unshift(0xff);
  } else if (out[0] & 0x80) out.unshift(0);
  return Buffer.from(out);
}

function encodeValue(type, val) {
  switch (type) {
    case 'INTEGER': return tlv(0x02, bytesOf(val, true));
    case 'COUNTER32': return tlv(0x41, bytesOf(val, false));
    case 'GAUGE32': return tlv(0x42, bytesOf(val, false));
    case 'TIMETICKS': return tlv(0x43, bytesOf(val, false));
    case 'COUNTER64': return tlv(0x46, bytesOf(val, false));
    case 'OID': return encOid(val);
    case 'IPADDR': return tlv(0x40, Buffer.from(String(val).split('.').map(Number)));
    case 'HEX': return tlv(0x04, Buffer.from(val, 'hex'));
    default: return tlv(0x04, Buffer.from(String(val), 'utf8'));
  }
}

function loadFixture(name) {
  const file = path.isAbsolute(name) ? name : path.join(FIXTURES, `${name}.walk`);
  return walkfile.parse(fs.readFileSync(file, 'utf8'));
}

// opts.rows serves an in-memory table instead of a file; `silent` never answers (timeout);
// a wrong community gets no answer, like a real SNMP v2c agent.
async function startReplay(name, { rows, community = 'public', silent = false } = {}) {
  const data = (rows || loadFixture(name).rows).slice().sort((a, b) => oidCmp(a[0], b[0]));
  const srv = dgram.createSocket('udp4');
  srv.on('message', (m, rinfo) => {
    if (silent) return;
    try {
      const msg = readTlv(m, 0);
      const ver = readTlv(m, msg.start);
      const com = readTlv(m, ver.end);
      if (m.subarray(com.start, com.end).toString() !== community) return;
      const pdu = readTlv(m, com.end);
      const id = readTlv(m, pdu.start);
      const reqId = decInt(m.subarray(id.start, id.end));
      const es = readTlv(m, id.end);
      const ei = readTlv(m, es.end);
      const list = readTlv(m, ei.end);
      const vbs = [];
      for (let o = list.start; o < list.end;) {
        const vb = readTlv(m, o);
        const ot = readTlv(m, vb.start);
        const q = decOid(m.subarray(ot.start, ot.end));
        let hit; let outOid = q; let value;
        if (pdu.tag === 0xa1) {
          hit = data.find((r) => oidCmp(r[0], q) > 0);
          if (hit) outOid = hit[0];
          value = hit ? encodeValue(hit[2], hit[1]) : Buffer.from([0x82, 0x00]);
        } else {
          hit = data.find((r) => r[0] === q);
          value = hit ? encodeValue(hit[2], hit[1]) : Buffer.from([0x80, 0x00]);
        }
        vbs.push(tlv(0x30, Buffer.concat([encOid(outOid), value])));
        o = vb.end;
      }
      const body = Buffer.concat([snmp.encInt(reqId), snmp.encInt(0), snmp.encInt(0), tlv(0x30, Buffer.concat(vbs))]);
      srv.send(tlv(0x30, Buffer.concat([snmp.encInt(1), tlv(0x04, Buffer.from(community)), tlv(0xa2, body)])), rinfo.port, rinfo.address);
    } catch { /* ignore malformed */ }
  });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  return { port: srv.address().port, host: '127.0.0.1', server: srv, close: () => srv.close() };
}

function listFixtures() {
  if (!fs.existsSync(FIXTURES)) return [];
  return fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.walk')).map((f) => path.basename(f, '.walk'));
}

module.exports = { startReplay, loadFixture, listFixtures, FIXTURES };
