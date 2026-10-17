'use strict';
// Reads/writes ".walk" files: a text dump of a real device's SNMP tree.
//   <oid> <TYPE> <value>      (STRING values are JSON-quoted, HEX is raw bytes in hex)
// Used by tools/snmp-probe.js, the "Xuất dữ liệu SNMP" button and the SNMP replay test server.
const snmp = require('./snmp');

const STANDARD_ROOTS = [
  '1.3.6.1.2.1.1',      // system
  '1.3.6.1.2.1.25',     // HOST-RESOURCES
  '1.3.6.1.2.1.43',     // Printer-MIB
  '1.3.6.1.2.1.47',     // ENTITY-MIB
  '1.3.6.1.2.1.99',     // ENTITY-SENSOR-MIB
  '1.3.6.1.4.1.2021',   // UCD-SNMP
];

function serialize(rows, meta = {}) {
  const head = ['# monitoring-platform snmp walk v1'];
  for (const [k, v] of Object.entries(meta)) head.push(`# ${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
  const lines = rows.map(([oid, val, type]) => {
    const t = type || 'STRING';
    return `${oid} ${t} ${t === 'STRING' ? JSON.stringify(String(val)) : val}`;
  });
  return `${head.join('\n')}\n${lines.join('\n')}\n`;
}

function parse(text) {
  const rows = [];
  const meta = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      const m = /^#\s*([\w.-]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2];
      continue;
    }
    const m = /^(\d+(?:\.\d+)+) ([A-Z0-9]+) ?(.*)$/.exec(line);
    if (!m) throw new Error(`Dòng .walk không hợp lệ: ${line.slice(0, 80)}`);
    const [, oid, type, raw] = m;
    let val;
    if (type === 'STRING') val = JSON.parse(raw);
    else if (['INTEGER', 'COUNTER32', 'GAUGE32', 'TIMETICKS', 'COUNTER64'].includes(type)) val = Number(raw);
    else val = raw; // OID, IPADDR, HEX
    rows.push([oid, val, type]);
  }
  rows.sort((a, b) => snmp.oidCmp(a[0], b[0]));
  return { meta, rows };
}

// Walks the standard branches plus the vendor subtree from sysObjectID.
async function exportWalk({ host, port = 161, community = 'public', roots, max = 5000, timeout = 2000 }) {
  const id = await snmp.snmpGet({ host, port, community, oids: [snmp.OIDS.sysObjectID, snmp.OIDS.sysDescr, snmp.OIDS.sysName], timeout });
  const objectId = id[snmp.OIDS.sysObjectID] || '';
  const list = new Set(roots || STANDARD_ROOTS);
  const ent = /^(1\.3\.6\.1\.4\.1\.\d+)/.exec(objectId);
  if (!roots && ent) {
    list.add(ent[1]);
    // Alcatel-Lucent OmniStack LS switches report sysObjectID under 6486.800.1.1.2.2
    // but store CPU and thermal sensors under Radlan (RND) enterprise 1.3.6.1.4.1.89.
    if (objectId.replace(/^\./, '').startsWith('1.3.6.1.4.1.6486.800.1.1.2.2')) {
      list.add('1.3.6.1.4.1.89.1');
      list.add('1.3.6.1.4.1.89.83');
    }
  }
  const results = await Promise.all([...list].map(async (root) => {
    try { return { root, rows: await snmp.walk({ host, port, community, root, max, timeout, typed: true }) }; } catch (e) { return { root, rows: [], error: e.message }; }
  }));
  const rows = results.flatMap((r) => r.rows);
  const meta = {
    captured: new Date().toISOString(),
    sysObjectID: objectId,
    sysDescr: id[snmp.OIDS.sysDescr] || '',
    sysName: id[snmp.OIDS.sysName] || '',
    roots: [...list].join(' '),
  };
  const failed = results.filter((r) => r.error);
  if (failed.length) meta.errors = failed.map((r) => `${r.root}: ${r.error}`).join('; ');
  return { rows, meta, text: serialize(rows.sort((a, b) => snmp.oidCmp(a[0], b[0])), meta) };
}

module.exports = { serialize, parse, exportWalk, STANDARD_ROOTS };
