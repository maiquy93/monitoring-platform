'use strict';
// SNMP device-profile engine. All vendor knowledge lives in server/profiles/*.json;
// this file only knows how to detect a profile and evaluate its data-driven metric
// definitions. See README "Cách thêm hồ sơ cho một hãng mới".
const fs = require('node:fs');
const path = require('node:path');
const snmp = require('./snmp');

const PROFILES_DIR = path.join(__dirname, 'profiles');
const CORE = ['cpu', 'ram', 'disk', 'temperature', 'toner', 'drum', 'page_count', 'total_ssids', 'total_clients'];
const AGGS = new Set(['avg', 'max', 'min', 'sum', 'first']);

const MESSAGES = {
  timeout: 'Thiết bị không trả lời (timeout): kiểm tra community, danh sách IP được phép (ACL) và firewall UDP 161',
  no_such_oid: 'Thiết bị không có OID này (noSuchObject): thiết bị/firmware không hỗ trợ chỉ số này',
  no_rows: 'Bảng SNMP không có dòng nào: thiết bị không hỗ trợ MIB này',
  no_match: 'Bảng có dữ liệu nhưng không dòng nào khớp điều kiện của hồ sơ',
  bad_value: 'Giá trị đọc được không dùng được (không phải số, hoặc tổng dung lượng bằng 0)',
  error: 'Lỗi SNMP không xác định',
};

class SnmpFail extends Error {
  constructor(code, detail) {
    super(detail || MESSAGES[code] || code);
    this.code = code;
  }
}

// "match" is one clause {sysObjectID?, sysDescr?} (both must hit) or an array of such
// clauses (any one is enough), e.g. sysObjectID of the vendor OR a sysDescr regex.
const matchClauses = (p) => (Array.isArray(p.match) ? p.match : [p.match]);

// ---- profile loading ------------------------------------------------------
function validateSource(src, where) {
  const kinds = ['get', 'percent', 'table'].filter((k) => src[k] !== undefined);
  if (kinds.length !== 1) throw new Error(`${where}: mỗi nguồn cần đúng một trong get / percent / table`);
  const oid = (v, what) => { if (typeof v !== 'string' || !/^\d+(\.\d+)+$/.test(v)) throw new Error(`${where}: ${what} phải là OID dạng 1.3.6...`); };
  if (src.get !== undefined) oid(src.get, 'get');
  if (src.percent !== undefined) {
    const p = src.percent;
    oid(p.total, 'percent.total');
    if ((p.used === undefined) === (p.free === undefined)) throw new Error(`${where}: percent cần used hoặc free (một trong hai)`);
    oid(p.used ?? p.free, 'percent.used/free');
  }
  if (src.table !== undefined) {
    const t = src.table;
    if (!t.columns || !Object.keys(t.columns).length) throw new Error(`${where}: table.columns trống`);
    for (const [k, v] of Object.entries(t.columns)) oid(v, `table.columns.${k}`);
    if (!t.value || (t.value.column === undefined) === (t.value.percent === undefined)) throw new Error(`${where}: table.value cần column hoặc percent`);
    const pc = t.value.percent;
    // percent: "total" + (used hoặc free), hoặc cả "used" và "free" (tổng = used + free, vd. CISCO-MEMORY-POOL-MIB)
    if (pc && (pc.total !== undefined ? (pc.used === undefined) === (pc.free === undefined) : (pc.used === undefined || pc.free === undefined))) {
      throw new Error(`${where}: table.value.percent cần total + (used hoặc free), hoặc cả used và free`);
    }
    const refs = t.value.column !== undefined ? [t.value.column] : (pc.total !== undefined ? [pc.total, pc.used ?? pc.free] : [pc.used, pc.free]);
    for (const r of refs) if (!t.columns[r]) throw new Error(`${where}: table.value tham chiếu cột "${r}" không có trong columns`);
    for (const k of Object.keys(t.where || {})) if (!t.columns[k]) throw new Error(`${where}: table.where dùng cột "${k}" không có trong columns`);
    for (const k of Object.keys(t.where_match || {})) if (!t.columns[k]) throw new Error(`${where}: table.where_match dùng cột "${k}" không có trong columns`);
    if (t.agg && !AGGS.has(t.agg)) throw new Error(`${where}: agg phải là ${[...AGGS].join('/')}`);
  }
}

function validateProfile(p, file) {
  const id = path.basename(file, '.json');
  const fail = (m) => { throw new Error(`Hồ sơ SNMP ${path.basename(file)}: ${m}`); };
  if (p.id !== id) fail(`"id" phải trùng tên file (${id})`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) fail('"id" chỉ gồm a-z, 0-9 và dấu gạch ngang');
  if (typeof p.name !== 'string' || !p.name) fail('thiếu "name"');
  if (!p.fallback && !p.match) fail('cần "match" (hoặc "fallback": true cho hồ sơ chung)');
  if (p.match) {
    for (const c of matchClauses(p)) {
      if (!c || typeof c !== 'object' || (c.sysObjectID === undefined && c.sysDescr === undefined)) fail('match cần sysObjectID và/hoặc sysDescr');
      for (const o of c.sysObjectID || []) if (!/^\d+(\.\d+)+$/.test(o)) fail(`match.sysObjectID "${o}" không hợp lệ`);
      if (c.sysDescr !== undefined) { try { new RegExp(c.sysDescr, 'i'); } catch { fail('match.sysDescr không phải regex hợp lệ'); } }
    }
  }
  for (const [key, m] of Object.entries(p.metrics || {})) {
    if (m === null) continue; // removes an inherited metric
    if (!/^[a-z][a-z0-9_]*$/.test(key)) fail(`tên chỉ số "${key}" không hợp lệ`);
    if (!Array.isArray(m.sources) || !m.sources.length) fail(`chỉ số "${key}" cần "sources" (danh sách OID thử lần lượt)`);
    m.sources.forEach((s, i) => { try { validateSource(s, `chỉ số "${key}" nguồn #${i + 1}`); } catch (e) { fail(e.message); } });
  }
}

function loadProfiles(dir = PROFILES_DIR) {
  const raw = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const file = path.join(dir, f);
    let p;
    try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Hồ sơ SNMP ${f}: JSON lỗi (${e.message})`); }
    validateProfile(p, file);
    raw.set(p.id, p);
  }
  const resolve = (p, seen = []) => {
    if (!p.extends) return { ...(p.metrics || {}) };
    if (seen.includes(p.id)) throw new Error(`Hồ sơ SNMP ${p.id}: extends vòng`);
    const parent = raw.get(p.extends);
    if (!parent) throw new Error(`Hồ sơ SNMP ${p.id}: extends "${p.extends}" không tồn tại`);
    return { ...resolve(parent, [...seen, p.id]), ...(p.metrics || {}) };
  };
  const list = [...raw.values()].map((p) => {
    const metrics = Object.fromEntries(Object.entries(resolve(p)).filter(([, m]) => m !== null));
    return { ...p, metrics };
  });
  if (list.filter((p) => p.fallback).length !== 1) throw new Error('Cần đúng một hồ sơ chung ("fallback": true) trong server/profiles');
  return { list, byId: new Map(list.map((p) => [p.id, p])) };
}

let registry;
function profiles() { return registry || (registry = loadProfiles()); }
function reloadProfiles(dir) { registry = loadProfiles(dir); return registry; }

function listProfiles() {
  return profiles().list.map((p) => ({
    id: p.id, name: p.name, description: p.description || '', fallback: !!p.fallback,
    match: p.match || null, verified_with: p.verified_with || [],
    unverified: Object.entries(p.metrics).filter(([, m]) => m.sources.some((s) => s.unverified)).map(([k]) => k),
  }));
}

// ---- detection --------------------------------------------------------------
// Score of one clause (null = no match). sysObjectID (longest-prefix) outranks sysDescr.
function scoreClause(c, ident) {
  let score = 0;
  const oids = c.sysObjectID;
  if (oids && oids.length) {
    const hit = oids.filter((o) => ident.sysObjectID === o || ident.sysObjectID.startsWith(`${o}.`));
    if (!hit.length) return null;
    score += 100 + Math.max(...hit.map((o) => o.split('.').length));
  }
  if (c.sysDescr !== undefined) {
    if (!new RegExp(c.sysDescr, 'i').test(ident.sysDescr || '')) return null;
    score += 10;
  }
  return score;
}

function detectProfile(ident, reg = profiles()) {
  ident = { ...ident, sysObjectID: String(ident.sysObjectID || '').replace(/^\./, ''), sysDescr: ident.sysDescr || '' };
  let best = null;
  for (const p of reg.list) {
    if (p.fallback || !p.match) continue;
    const scores = matchClauses(p).map((c) => scoreClause(c, ident)).filter((s) => s !== null);
    if (!scores.length) continue;
    const score = (p.priority || 0) + Math.max(...scores);
    if (!best || score > best.score) best = { p, score };
  }
  return best ? best.p : reg.list.find((p) => p.fallback);
}

// ---- evaluation -------------------------------------------------------------
class Reader {
  constructor(conn) {
    this.conn = conn;
    this.scalars = new Map();
    this.tables = new Map();
    this.timeouts = 0;
  }

  guard(e) {
    if (e instanceof SnmpFail) return e;
    if (/timeout/i.test(e.message)) { this.timeouts++; return new SnmpFail('timeout'); }
    return new SnmpFail('error', e.message);
  }

  async get(oid) {
    if (!this.scalars.has(oid)) {
      this.scalars.set(oid, (async () => {
        if (this.timeouts >= 2) throw new SnmpFail('timeout');
        let r;
        try { r = await snmp.snmpGet({ ...this.conn, oids: [oid], timeout: 1500 }); } catch (e) { throw this.guard(e); }
        const v = r[oid];
        if (v === undefined || v === null) throw new SnmpFail('no_such_oid');
        return v;
      })());
    }
    return this.scalars.get(oid);
  }

  async table(columns, maxRows = 64) {
    columns = [...new Set(columns)].sort(snmp.oidCmp);
    const key = columns.join('|');
    if (!this.tables.has(key)) {
      this.tables.set(key, (async () => {
        if (this.timeouts >= 2) throw new SnmpFail('timeout');
        let rows;
        try { rows = await snmp.walkColumns({ ...this.conn, columns, maxRows, timeout: 1500 }); } catch (e) { throw this.guard(e); }
        if (!Object.keys(rows).length) throw new SnmpFail('no_rows');
        return rows;
      })());
    }
    return this.tables.get(key);
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
function pct(used, total) {
  if (num(used) === null || num(total) === null || total <= 0 || used < 0) return null;
  return (used / total) * 100;
}
// Percent of one table row. `p` names columns: total + (used | free), or used + free (total = used + free).
function rowPercent(p, get) {
  if (p.total === undefined) return pct(get(p.used), get(p.used) + get(p.free));
  const total = get(p.total);
  return pct(p.used !== undefined ? get(p.used) : total - get(p.free), total);
}
const aggregate = (vals, agg) => {
  if (agg === 'max') return Math.max(...vals);
  if (agg === 'min') return Math.min(...vals);
  if (agg === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (agg === 'first') return vals[0];
  return vals.reduce((a, b) => a + b, 0) / vals.length;
};

async function evalSource(src, rd) {
  let v;
  if (src.get !== undefined) {
    v = await rd.get(src.get);
    if (src.text) return String(v);
    if (src.map) {
      const m = src.map[String(v)];
      return m === undefined ? String(v) : m;
    }
    if (num(v) === null) throw new SnmpFail('bad_value');
  } else if (src.percent) {
    const p = src.percent;
    const total = await rd.get(p.total);
    const part = await rd.get(p.used ?? p.free);
    v = pct(p.used !== undefined ? part : total - part, total);
  } else {
    const t = src.table;
    const rows = await rd.table(Object.values(t.columns), t.maxRows);
    const col = (r, name) => r[t.columns[name]];
    const vals = [];
    let matched = 0;
    for (const r of Object.values(rows)) {
      if (t.where && !Object.entries(t.where).every(([k, allowed]) => allowed.map(String).includes(String(col(r, k))))) continue;
      if (t.where_match && !Object.entries(t.where_match).every(([k, pat]) => new RegExp(pat, 'i').test(String(col(r, k) || '')))) continue;
      matched++;
      const x = t.value.column !== undefined
        ? num(col(r, t.value.column))
        : rowPercent(t.value.percent, (name) => col(r, name));
      if (x !== null) vals.push(x);
    }
    if (!matched) throw new SnmpFail('no_match');
    if (!vals.length) throw new SnmpFail('bad_value');
    v = aggregate(vals, t.agg || 'avg');
  }
  if (v === null || v === undefined || Number.isNaN(v)) throw new SnmpFail('bad_value');
  if (src.invert) v = 100 - v;
  if (src.scale !== undefined) v *= src.scale;
  return v;
}

const sourceOid = (s) => s.get ?? (s.percent && s.percent.total) ?? Object.values(s.table.columns)[0];

async function evalMetric(key, def, rd) {
  const tried = [];
  for (let i = 0; i < def.sources.length; i++) {
    const src = def.sources[i];
    try {
      let value = await evalSource(src, rd);
      if (typeof value === 'number') {
        if (def.unit === '%') value = Math.min(100, Math.max(0, value));
        const dp = def.round ?? 1;
        value = Math.round(value * 10 ** dp) / 10 ** dp;
      }
      return { key, ok: true, value, source: i, unverified: !!src.unverified, tried };
    } catch (e) {
      const f = e instanceof SnmpFail ? e : new SnmpFail('error', e.message);
      tried.push({ source: i, oid: sourceOid(src), code: f.code, message: f.message });
    }
  }
  const last = tried[tried.length - 1];
  return { key, ok: false, code: last.code, message: last.message, tried };
}

// ---- interface traffic (IF-MIB) -----------------------------------------------
// Raw octet counters per interface; the Monitor turns two samples into bytes/s.
const IF_COLS = {
  type: '1.3.6.1.2.1.2.2.1.3',
  in32: '1.3.6.1.2.1.2.2.1.10', out32: '1.3.6.1.2.1.2.2.1.16',
  hcIn: '1.3.6.1.2.1.31.1.1.1.6', hcOut: '1.3.6.1.2.1.31.1.1.1.10',
};
// ifType values that only re-count traffic already seen on a real port (or never leave the box).
const IF_VIRTUAL_TYPES = new Set([24, 53, 131, 135, 136, 150, 161, 209]); // loopback, propVirtual, tunnel, vlan, lag, bridge...

// -> { rows: { ifIndex: [inOctets, outOctets, counterBits] } } or null when the device has no usable IF-MIB.
async function readIfCounters(rd) {
  let table;
  try { table = await rd.table(Object.values(IF_COLS), 128); } catch { return null; }
  const all = Object.entries(table).map(([idx, r]) => {
    const hc = num(r[IF_COLS.hcIn]) !== null && num(r[IF_COLS.hcOut]) !== null;
    const rx = hc ? r[IF_COLS.hcIn] : num(r[IF_COLS.in32]);
    const tx = hc ? r[IF_COLS.hcOut] : num(r[IF_COLS.out32]);
    return { idx, type: num(r[IF_COLS.type]), row: rx !== null && tx !== null ? [rx, tx, hc ? 64 : 32] : null };
  }).filter((x) => x.row);
  // prefer physical ports; if everything is "virtual" (some appliances), at least skip loopback
  let use = all.filter((x) => !IF_VIRTUAL_TYPES.has(x.type));
  if (!use.length) use = all.filter((x) => x.type !== 24);
  if (!use.length) return null;
  return { rows: Object.fromEntries(use.map((x) => [x.idx, x.row])) };
}

// ---- packet counters for Flood/DoS detection (TCP-MIB & UDP-MIB / IF-MIB fallback) ----
const TCP_IN_SEGS = '1.3.6.1.2.1.6.10.0';
const UDP_IN_DATAGRAMS = '1.3.6.1.2.1.7.1.0';
const IF_HC_IN_PKTS = '1.3.6.1.2.1.31.1.1.1.7';
const IF_IN_UCAST_PKTS = '1.3.6.1.2.1.2.2.1.11';

// -> { tcp: number|null, udp: number|null } or null when unsupported.
async function readPktCounters(rd) {
  let tcp = null, udp = null;
  try { tcp = num(await rd.get(TCP_IN_SEGS)); } catch { /* optional TCP-MIB */ }
  try { udp = num(await rd.get(UDP_IN_DATAGRAMS)); } catch { /* optional UDP-MIB */ }
  if (tcp !== null || udp !== null) return { tcp, udp };

  // Fallback to interface packets (for routers like MikroTik RouterOS without host transport MIBs)
  try {
    const tbl = await rd.table([IF_HC_IN_PKTS, IF_IN_UCAST_PKTS], 32);
    if (tbl) {
      let sum = 0, found = false;
      for (const r of Object.values(tbl)) {
        const v = num(r[IF_HC_IN_PKTS]) !== null ? num(r[IF_HC_IN_PKTS]) : num(r[IF_IN_UCAST_PKTS]);
        if (v !== null && v > 0) { sum += v; found = true; }
      }
      if (found) return { tcp: 0, udp: sum };
    }
  } catch { /* optional IF-MIB */ }

  return null;
}

// ---- printer status, supplies and counters (Printer-MIB & HOST-RESOURCES) ----
const PRT_STATUS_NAMES = {
  1: 'Khác',
  2: 'Không rõ',
  3: 'Sẵn sàng (Ready/Idle)',
  4: 'Đang in (Printing)',
  5: 'Đang khởi động/sấy (Warmup)',
};

const PRINTER_ERROR_BITS = [
  'Sắp hết giấy (Low paper)',
  'Hết giấy (No paper)',
  'Sắp hết mực (Low toner)',
  'Hết mực (No toner)',
  'Nắp máy đang mở (Door open)',
  'Kẹt giấy (Paper jam)',
  'Ngoại tuyến (Offline)',
  'Cần bảo trì kỹ thuật (Service requested)',
  'Thiếu khay nạp giấy (Input tray missing)',
  'Thiếu khay giấy ra (Output tray missing)',
  'Thiếu hộp mực/vật tư (Marker supply missing)',
  'Khay ra sắp đầy (Output near full)',
  'Khay ra đã đầy (Output full)',
  'Khay nạp giấy rỗng (Input tray empty)',
  'Quá hạn bảo dưỡng định kỳ (Overdue maintenance)',
];

function parsePrinterErrors(raw) {
  if (raw === null || raw === undefined) return [];
  const errors = [];
  let bytes = [];
  if (typeof raw === 'number') {
    bytes = [raw & 0xff, (raw >> 8) & 0xff];
  } else if (typeof raw === 'string') {
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      bytes = Buffer.from(raw, 'hex');
    } else {
      bytes = Buffer.from(raw, 'latin1');
    }
  }
  for (let i = 0; i < PRINTER_ERROR_BITS.length; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitInByte = 7 - (i % 8);
    if (bytes[byteIdx] !== undefined && (bytes[byteIdx] & (1 << bitInByte))) {
      errors.push(PRINTER_ERROR_BITS[i]);
    }
  }
  return errors;
}

const PRT_SCALARS = {
  status: '1.3.6.1.2.1.25.3.5.1.1.1',
  error_state: '1.3.6.1.2.1.25.3.5.1.2.1',
  display: '1.3.6.1.2.1.43.16.5.1.2.1.1',
  name: '1.3.6.1.2.1.43.5.1.1.16.1',
  serial: '1.3.6.1.2.1.43.5.1.1.17.1',
  pages: '1.3.6.1.2.1.43.10.2.1.4.1.1',
  hp_pages: '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.5.0',
  brother_pages: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0',
  brother_pages2: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.0',
  canon_pages: '1.3.6.1.4.1.1602.1.11.1.3.1.4.1',
};

const PRT_SUPPLY_COLS = {
  class: '1.3.6.1.2.1.43.11.1.1.4',
  type: '1.3.6.1.2.1.43.11.1.1.5',
  descr: '1.3.6.1.2.1.43.11.1.1.6',
  unit: '1.3.6.1.2.1.43.11.1.1.7',
  max: '1.3.6.1.2.1.43.11.1.1.8',
  level: '1.3.6.1.2.1.43.11.1.1.9',
};

const PRT_INPUT_COLS = {
  name: '1.3.6.1.2.1.43.8.2.1.13',
  max: '1.3.6.1.2.1.43.8.2.1.9',
  level: '1.3.6.1.2.1.43.8.2.1.10',
  status: '1.3.6.1.2.1.43.8.2.1.11',
  media_type: '1.3.6.1.2.1.43.8.2.1.12',
  vendor: '1.3.6.1.2.1.43.8.2.1.14',
  media_name: '1.3.6.1.2.1.43.8.2.1.18',
};

async function readPrinterDetails(rd, ident) {
  let rawStatus = null, rawError = null, display = null, pName = null, serial = null, pages = null;
  try { rawStatus = num(await rd.get(PRT_SCALARS.status)); } catch { /* optional */ }
  try { rawError = await rd.get(PRT_SCALARS.error_state); } catch { /* optional */ }
  try { display = String(await rd.get(PRT_SCALARS.display)).trim(); } catch { /* optional */ }
  try { pName = String(await rd.get(PRT_SCALARS.name)).trim(); } catch { /* optional */ }
  try { serial = String(await rd.get(PRT_SCALARS.serial)).trim(); } catch { /* optional */ }

  for (const pOid of [PRT_SCALARS.pages, PRT_SCALARS.hp_pages, PRT_SCALARS.brother_pages, PRT_SCALARS.brother_pages2, PRT_SCALARS.canon_pages]) {
    try {
      const p = num(await rd.get(pOid));
      if (p !== null && p >= 0) { pages = p; break; }
    } catch { /* try next */ }
  }

  let supplyRows = null;
  try { supplyRows = await rd.table(Object.values(PRT_SUPPLY_COLS), 32); } catch { /* optional */ }

  let inputRows = null;
  try { inputRows = await rd.table(Object.values(PRT_INPUT_COLS), 16); } catch { /* optional */ }

  // Printer Memory (HOST-RESOURCES-MIB hrStorageTable)
  let memory = null;
  try {
    const storRows = await rd.table(['1.3.6.1.2.1.25.2.3.1.2', '1.3.6.1.2.1.25.2.3.1.3', '1.3.6.1.2.1.25.2.3.1.4', '1.3.6.1.2.1.25.2.3.1.5', '1.3.6.1.2.1.25.2.3.1.6'], 8);
    for (const r of Object.values(storRows || {})) {
      const type = r['1.3.6.1.2.1.25.2.3.1.2'];
      const descr = String(r['1.3.6.1.2.1.25.2.3.1.3'] || '');
      if (type === '1.3.6.1.2.1.25.2.1.2' || /ram|memory/i.test(descr)) {
        const units = num(r['1.3.6.1.2.1.25.2.3.1.4']) || 1;
        const size = num(r['1.3.6.1.2.1.25.2.3.1.5']);
        const used = num(r['1.3.6.1.2.1.25.2.3.1.6']);
        if (size && size > 0 && used != null && used >= 0) {
          memory = {
            total: size * units,
            used: used * units,
            percent: Math.min(100, Math.max(0, Math.round((used / size) * 100))),
          };
          break;
        }
      }
    }
  } catch { /* optional */ }

  // Interpreters / Print Languages (prtInterpreterTable)
  const languages = [];
  try {
    const intpRows = await rd.table(['1.3.6.1.2.1.43.15.1.1.5'], 16);
    for (const r of Object.values(intpRows || {})) {
      const lang = String(r['1.3.6.1.2.1.43.15.1.1.5'] || '').trim();
      if (lang && !['Automatic Language Switching', 'URP'].includes(lang) && !languages.includes(lang)) {
        languages.push(lang);
      }
    }
  } catch { /* optional */ }

  if (rawStatus === null && rawError === null && !display && !pName && !serial && pages === null && !supplyRows && !inputRows && !memory) {
    return null;
  }

  const supplies = [];
  const tonerPercents = [];
  const drumPercents = [];

  if (supplyRows) {
    for (const [idx, r] of Object.entries(supplyRows)) {
      const descr = String(r[PRT_SUPPLY_COLS.descr] || `Vật tư ${idx}`).trim();
      const type = num(r[PRT_SUPPLY_COLS.type]);
      const unit = num(r[PRT_SUPPLY_COLS.unit]);
      const max = num(r[PRT_SUPPLY_COLS.max]);
      const level = num(r[PRT_SUPPLY_COLS.level]);
      const supClass = num(r[PRT_SUPPLY_COLS.class]);

      let percent = null;
      if (max !== null && level !== null && max > 0 && level >= 0) {
        percent = Math.min(100, Math.max(0, Math.round((level / max) * 100)));
      } else if (unit === 19 && level !== null && level >= 0 && level <= 100) {
        percent = Math.round(level);
      }

      let kind = 'other';
      const descrLower = descr.toLowerCase();
      if (type === 9 || /drum|opc|photoconductor|trống/i.test(descrLower)) {
        kind = 'drum';
        if (percent !== null) drumPercents.push(percent);
      } else if (type === 4 || /waste|thải/i.test(descrLower)) {
        kind = 'waste';
      } else if ([3, 5, 6, 19].includes(type) || /toner|cartridge|black|cyan|magenta|yellow|mực/i.test(descrLower)) {
        kind = 'toner';
        if (percent !== null) tonerPercents.push(percent);
      } else if ([15, 17].includes(type) || /fuser|sấy/i.test(descrLower)) {
        kind = 'fuser';
      } else if (type === 18 || /transfer|băng tải/i.test(descrLower)) {
        kind = 'transfer';
      }

      supplies.push({
        index: idx,
        name: descr,
        type: type ?? 1,
        kind,
        unit,
        max,
        level,
        percent,
        status: level === 0 ? 'Hết vật tư' : (level === -3 ? 'Còn vật tư' : (level === -2 ? 'Không rõ' : (percent != null ? `${percent}%` : 'Không rõ'))),
      });
    }
  }

  const trays = [];
  if (inputRows) {
    for (const [idx, r] of Object.entries(inputRows)) {
      const name = String(r[PRT_INPUT_COLS.name] || `Khay ${idx}`).trim();
      const max = num(r[PRT_INPUT_COLS.max]);
      const level = num(r[PRT_INPUT_COLS.level]);
      const st = num(r[PRT_INPUT_COLS.status]);
      const mediaType = String(r[PRT_INPUT_COLS.media_type] || '').trim();
      const mediaName = String(r[PRT_INPUT_COLS.media_name] || '').trim();
      let status = 'Bình thường';
      if (level === 0) status = 'Hết giấy';
      else if (level === -3) status = 'Còn giấy';
      else if (level === -2 || level === -1) status = 'Không rõ';
      else if (max && level && max > 0 && level > 0) status = `${level}/${max} tờ (${Math.round((level / max) * 100)}%)`;
      else if (level > 0) status = `${level} tờ`;
      trays.push({
        name,
        max,
        level,
        status,
        media_type: mediaType || 'Mặc định',
        media_name: mediaName && mediaName !== name ? mediaName : (mediaType || 'A4 / Mặc định'),
        vendor: String(r[PRT_INPUT_COLS.vendor] || '').trim(),
      });
    }
  }

  const errors = parsePrinterErrors(rawError);

  let firmware = null;
  if (ident && ident.sysDescr) {
    const fnMatch = ident.sysDescr.match(/FN:([A-Za-z0-9._-]+)/i);
    if (fnMatch) firmware = fnMatch[1];
    if (!serial) {
      const snMatch = ident.sysDescr.match(/SN:([A-Za-z0-9._-]+)/i);
      if (snMatch) serial = snMatch[1];
    }
    if (!pName) {
      const pidMatch = ident.sysDescr.match(/PID:([^,]+)/i);
      if (pidMatch) pName = pidMatch[1].trim();
    }
  }

  const model = pName || (ident && ident.sysDescr ? ident.sysDescr.split(',')[0].trim() : '');
  const duplex = /(?:dn|dw|fdw|cdw|dtn|duplex)(?:$|[^a-z0-9])/i.test(model) ? 'Có (In 2 mặt tự động)' : null;

  return {
    status_code: rawStatus,
    status_text: PRT_STATUS_NAMES[rawStatus] || 'Bình thường',
    display: display || '',
    model,
    serial: serial || '',
    firmware,
    duplex,
    page_count: pages,
    toner: tonerPercents.length ? Math.min(...tonerPercents) : null,
    drum: drumPercents.length ? Math.min(...drumPercents) : null,
    errors,
    supplies,
    trays,
    memory,
    languages,
  };
}

// ---- Access Point (AP) wireless metrics & ARP / Client tracking ----
const AP_OIDS = {
  unifi: {
    bssid: '1.3.6.1.4.1.41112.1.6.1.2.1.2',
    radio: '1.3.6.1.4.1.41112.1.6.1.2.1.9',
    channel: '1.3.6.1.4.1.41112.1.6.1.2.1.4',
    ssid: '1.3.6.1.4.1.41112.1.6.1.2.1.6',
    stations: '1.3.6.1.4.1.41112.1.6.1.2.1.8',
  },
  ruckus: {
    ssid: '1.3.6.1.4.1.25053.1.2.2.1.1.1.2',
    bssid: '1.3.6.1.4.1.25053.1.2.2.1.1.1.3',
    stations: '1.3.6.1.4.1.25053.1.2.2.1.1.1.16',
  },
  ruckus_sta: {
    mac: '1.3.6.1.4.1.25053.1.2.2.4.1.1.1',
    rssi: '1.3.6.1.4.1.25053.1.2.2.4.1.1.3',
    ip: '1.3.6.1.4.1.25053.1.2.2.4.1.1.4',
    ssid: '1.3.6.1.4.1.25053.1.2.2.4.1.1.6',
    user: '1.3.6.1.4.1.25053.1.2.2.4.1.1.8',
    os: '1.3.6.1.4.1.25053.1.2.2.4.1.1.12',
  },
  aruba: {
    ssid: '1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.2',
    stations: '1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.3',
    total_users: '1.3.6.1.4.1.14823.2.2.1.4.1.1.0',
  },
  aruba_user: {
    ip: '1.3.6.1.4.1.14823.2.2.1.4.1.2.1.1',
    mac: '1.3.6.1.4.1.14823.2.2.1.4.1.2.1.2',
    user: '1.3.6.1.4.1.14823.2.2.1.4.1.2.1.3',
    ssid: '1.3.6.1.4.1.14823.2.2.1.4.1.2.1.7',
  },
  cisco: {
    ssid: '1.3.6.1.4.1.9.9.512.1.1.1.1.6',
    stations: '1.3.6.1.4.1.9.9.512.1.1.1.1.5',
  },
  cisco_client: {
    mac: '1.3.6.1.4.1.9.9.599.1.3.1.1.1',
    ip: '1.3.6.1.4.1.9.9.599.1.3.1.1.10',
    ssid: '1.3.6.1.4.1.9.9.599.1.3.1.1.27',
    user: '1.3.6.1.4.1.9.9.599.1.3.1.1.28',
  },
  cisco_dot11: {
    ssid: '1.3.6.1.4.1.9.9.273.1.1.2.1.1',
  },
  cisco_dot11_client: {
    mac: '1.3.6.1.4.1.9.9.273.1.3.1.1.1',
    ip: '1.3.6.1.4.1.9.9.273.1.3.1.1.3',
    ssid: '1.3.6.1.4.1.9.9.273.1.3.1.1.7',
  },
  omada: {
    ssid: '1.3.6.1.4.1.11863.6.4.1.2.1.1.2',
    bssid: '1.3.6.1.4.1.11863.6.4.1.2.1.1.3',
    stations: '1.3.6.1.4.1.11863.6.4.1.2.1.1.4',
    radio: '1.3.6.1.4.1.11863.6.4.1.2.1.1.5',
  },
  grandstream: {
    ssid: '1.3.6.1.4.1.42397.1.1.2.2.1.2',
    bssid: '1.3.6.1.4.1.42397.1.1.2.2.1.3',
    stations: '1.3.6.1.4.1.42397.1.1.2.2.1.4',
    band: '1.3.6.1.4.1.42397.1.1.2.2.1.5',
  },
  dot11: {
    ssid: '1.2.840.10036.1.1.1.9',
    stations: '1.2.840.10036.2.2.1.4',
  },
  arp: {
    ifIndex: '1.3.6.1.2.1.4.22.1.1',
    physAddress: '1.3.6.1.2.1.4.22.1.2',
    netAddress: '1.3.6.1.2.1.4.22.1.3',
    type: '1.3.6.1.2.1.4.22.1.4',
  },
  arp_phys: {
    netAddress: '1.3.6.1.2.1.4.35.1.3',
    physAddress: '1.3.6.1.2.1.4.35.1.4',
    type: '1.3.6.1.2.1.4.35.1.5',
  },
};

function formatMac(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  if (/^[0-9a-fA-F]{12}$/.test(str)) {
    return str.match(/.{1,2}/g).map((b) => b.toUpperCase()).join(':');
  }
  if (/^([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}$/.test(str)) {
    return str.split(/[:-]/).map((b) => b.padStart(2, '0').toUpperCase()).join(':');
  }
  if (str.length === 6) {
    return Array.from(str).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  return str;
}

function formatIp(raw) {
  if (!raw) return '';
  const str = String(raw).trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(str)) return str;
  if (/^[0-9a-fA-F]{8}$/.test(str)) {
    const bytes = Buffer.from(str, 'hex');
    return Array.from(bytes).join('.');
  }
  return str;
}

function parseBand(val, channel) {
  if (channel != null) {
    if (channel >= 1 && channel <= 14) return '2.4 GHz';
    if (channel >= 36 && channel <= 177) return '5 GHz';
    if (channel >= 180) return '6 GHz';
  }
  if (val == null) return '';
  const s = String(val).toLowerCase().trim();
  if (s === 'ng' || s === '1' || s.includes('2.4')) return '2.4 GHz';
  if (s === 'na' || s === '2' || s.includes('5g') || s.includes('5.0')) return '5 GHz';
  if (s === '6g' || s === '3' || s.includes('6g')) return '6 GHz';
  return String(val).trim();
}

const SYSTEM_SSID_PREFIXES = [
  'element-',
  'vwire-',
  'mesh-',
  'internal-',
  '_mesh',
  '_internal',
  'instant-mesh',
  'instant-setup',
  'setmeup-',
  'setup-',
  'direct-',
];

function normalizeSsid(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw).replace(/\x00+$/g, '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).replace(/\x00+$/g, '').trim();
  }
  return s;
}

function isSystemOrHiddenSsid(raw) {
  const s = normalizeSsid(raw);
  if (!s) return true;

  // Filter non-printable / control characters or binary garbage
  if (/^[\x00-\x1f\x7f]+$/.test(s)) return true;

  const lower = s.toLowerCase();
  if (SYSTEM_SSID_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }

  // Filter long hex hashes generated by firmware (e.g. 24+ hex digits) or UUIDs
  if (/^[0-9a-f]{24,}$/i.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;

  return false;
}

function isValidUserSsid(raw) {
  return !isSystemOrHiddenSsid(raw);
}

async function readApDetails(rd, ident) {
  const ssids = [];
  const clientMap = new Map();
  let totalClients = null;

  // 1. Try Ubiquiti UniFi (UBNT-UniFi-MIB)
  try {
    const vapRows = await rd.table([
      AP_OIDS.unifi.ssid,
      AP_OIDS.unifi.stations,
      AP_OIDS.unifi.bssid,
      AP_OIDS.unifi.radio,
      AP_OIDS.unifi.channel,
    ], 32);
    if (vapRows && Object.keys(vapRows).length) {
      for (const [idx, r] of Object.entries(vapRows)) {
        const name = normalizeSsid(r[AP_OIDS.unifi.ssid]);
        if (isSystemOrHiddenSsid(name)) continue;
        const clients = num(r[AP_OIDS.unifi.stations]) || 0;
        const bssid = formatMac(r[AP_OIDS.unifi.bssid]);
        const channel = num(r[AP_OIDS.unifi.channel]);
        const band = parseBand(r[AP_OIDS.unifi.radio], channel);
        ssids.push({ ssid: name, clients, bssid, band, channel });
      }
    }
  } catch { /* optional */ }

  // 2. Try Ruckus Wireless (RUCKUS-ZD-WLAN-MIB)
  if (!ssids.length) {
    try {
      const zdRows = await rd.table([
        AP_OIDS.ruckus.ssid,
        AP_OIDS.ruckus.stations,
        AP_OIDS.ruckus.bssid,
      ], 32);
      if (zdRows && Object.keys(zdRows).length) {
        for (const [idx, r] of Object.entries(zdRows)) {
          const name = normalizeSsid(r[AP_OIDS.ruckus.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.ruckus.stations]) || 0;
          const bssid = formatMac(r[AP_OIDS.ruckus.bssid]);
          ssids.push({ ssid: name, clients, bssid, band: '', channel: null });
        }
      }
    } catch { /* optional */ }
  }

  // 3. Try TP-Link Omada (TPLINK-EAP-MIB)
  if (!ssids.length) {
    try {
      const eapRows = await rd.table([
        AP_OIDS.omada.ssid,
        AP_OIDS.omada.stations,
        AP_OIDS.omada.bssid,
        AP_OIDS.omada.radio,
      ], 32);
      if (eapRows && Object.keys(eapRows).length) {
        for (const [idx, r] of Object.entries(eapRows)) {
          const name = normalizeSsid(r[AP_OIDS.omada.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.omada.stations]) || 0;
          const bssid = formatMac(r[AP_OIDS.omada.bssid]);
          const band = parseBand(r[AP_OIDS.omada.radio]);
          ssids.push({ ssid: name, clients, bssid, band, channel: null });
        }
      }
    } catch { /* optional */ }
  }

  // 4. Try Grandstream GWN (GRANDSTREAM-GWN-MIB)
  if (!ssids.length) {
    try {
      const gwnRows = await rd.table([
        AP_OIDS.grandstream.ssid,
        AP_OIDS.grandstream.stations,
        AP_OIDS.grandstream.bssid,
        AP_OIDS.grandstream.band,
      ], 32);
      if (gwnRows && Object.keys(gwnRows).length) {
        for (const [idx, r] of Object.entries(gwnRows)) {
          const name = normalizeSsid(r[AP_OIDS.grandstream.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.grandstream.stations]) || 0;
          const bssid = formatMac(r[AP_OIDS.grandstream.bssid]);
          const band = parseBand(r[AP_OIDS.grandstream.band]);
          ssids.push({ ssid: name, clients, bssid, band, channel: null });
        }
      }
    } catch { /* optional */ }
  }

  // 5. Try Aruba (WLSX-WLAN-MIB)
  if (!ssids.length) {
    try {
      const arubaRows = await rd.table([
        AP_OIDS.aruba.ssid,
        AP_OIDS.aruba.stations,
      ], 32);
      if (arubaRows && Object.keys(arubaRows).length) {
        for (const [idx, r] of Object.entries(arubaRows)) {
          const name = normalizeSsid(r[AP_OIDS.aruba.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.aruba.stations]) || 0;
          ssids.push({ ssid: name, clients, bssid: '', band: '', channel: null });
        }
      }
    } catch { /* optional */ }
    try {
      const tot = num(await rd.get(AP_OIDS.aruba.total_users));
      if (tot != null) totalClients = tot;
    } catch { /* optional */ }
  }

  // 6. Try Cisco (CISCO-LWAPP-WLAN-MIB & CISCO-DOT11-ASSOCIATION-MIB)
  if (!ssids.length) {
    try {
      const ciscoRows = await rd.table([
        AP_OIDS.cisco.ssid,
        AP_OIDS.cisco.stations,
      ], 32);
      if (ciscoRows && Object.keys(ciscoRows).length) {
        for (const [idx, r] of Object.entries(ciscoRows)) {
          const name = normalizeSsid(r[AP_OIDS.cisco.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.cisco.stations]) || 0;
          ssids.push({ ssid: name, clients, bssid: '', band: '', channel: null });
        }
      }
    } catch { /* optional */ }
    if (!ssids.length) {
      try {
        const dot11Rows = await rd.table([AP_OIDS.cisco_dot11.ssid], 32);
        if (dot11Rows && Object.keys(dot11Rows).length) {
          for (const [idx, r] of Object.entries(dot11Rows)) {
            const name = normalizeSsid(r[AP_OIDS.cisco_dot11.ssid]);
            if (isSystemOrHiddenSsid(name)) continue;
            ssids.push({ ssid: name, clients: 0, bssid: '', band: '', channel: null });
          }
        }
      } catch { /* optional */ }
    }
  }

  // 7. Try Standard IEEE 802.11 MIB
  if (!ssids.length) {
    try {
      const stdRows = await rd.table([AP_OIDS.dot11.ssid, AP_OIDS.dot11.stations], 32);
      if (stdRows && Object.keys(stdRows).length) {
        for (const [idx, r] of Object.entries(stdRows)) {
          const name = normalizeSsid(r[AP_OIDS.dot11.ssid]);
          if (isSystemOrHiddenSsid(name)) continue;
          const clients = num(r[AP_OIDS.dot11.stations]) || 0;
          ssids.push({ ssid: name, clients, bssid: '', band: '', channel: null });
        }
      }
    } catch { /* optional */ }
  }

  // Read vendor Client Station Tables (Ruckus, Aruba, Cisco)
  try {
    const staRows = await rd.table([
      AP_OIDS.ruckus_sta.mac,
      AP_OIDS.ruckus_sta.ip,
      AP_OIDS.ruckus_sta.user,
      AP_OIDS.ruckus_sta.ssid,
      AP_OIDS.ruckus_sta.rssi,
    ], 128);
    if (staRows && Object.keys(staRows).length) {
      for (const [idx, r] of Object.entries(staRows)) {
        const mac = formatMac(r[AP_OIDS.ruckus_sta.mac]);
        const ip = formatIp(r[AP_OIDS.ruckus_sta.ip]);
        const user = String(r[AP_OIDS.ruckus_sta.user] || '').trim();
        const rawSsid = normalizeSsid(r[AP_OIDS.ruckus_sta.ssid]);
        const ssid = !isSystemOrHiddenSsid(rawSsid) ? rawSsid : '';
        const rssi = num(r[AP_OIDS.ruckus_sta.rssi]);
        if (mac || ip) {
          const item = { mac, ip, hostname: user, ssid, rssi, type: 'Wireless (Wi-Fi)' };
          if (mac) clientMap.set(mac, item);
          if (ip) clientMap.set(ip, item);
        }
      }
    }
  } catch { /* optional */ }

  try {
    const userRows = await rd.table([
      AP_OIDS.aruba_user.ip,
      AP_OIDS.aruba_user.mac,
      AP_OIDS.aruba_user.user,
      AP_OIDS.aruba_user.ssid,
    ], 128);
    if (userRows && Object.keys(userRows).length) {
      for (const [idx, r] of Object.entries(userRows)) {
        const ip = formatIp(r[AP_OIDS.aruba_user.ip]);
        const mac = formatMac(r[AP_OIDS.aruba_user.mac]);
        const user = String(r[AP_OIDS.aruba_user.user] || '').trim();
        const rawSsid = normalizeSsid(r[AP_OIDS.aruba_user.ssid]);
        const ssid = !isSystemOrHiddenSsid(rawSsid) ? rawSsid : '';
        if (mac || ip) {
          const item = { mac, ip, hostname: user, ssid, type: 'Wireless (Wi-Fi)' };
          if (mac) clientMap.set(mac, item);
          if (ip) clientMap.set(ip, item);
        }
      }
    }
  } catch { /* optional */ }

  try {
    const ciscoCliRows = await rd.table([
      AP_OIDS.cisco_client.mac,
      AP_OIDS.cisco_client.ip,
      AP_OIDS.cisco_client.user,
      AP_OIDS.cisco_client.ssid,
    ], 128);
    if (ciscoCliRows && Object.keys(ciscoCliRows).length) {
      for (const [idx, r] of Object.entries(ciscoCliRows)) {
        const mac = formatMac(r[AP_OIDS.cisco_client.mac]);
        const ip = formatIp(r[AP_OIDS.cisco_client.ip]);
        const user = String(r[AP_OIDS.cisco_client.user] || '').trim();
        const rawSsid = normalizeSsid(r[AP_OIDS.cisco_client.ssid]);
        const ssid = !isSystemOrHiddenSsid(rawSsid) ? rawSsid : '';
        if (mac || ip) {
          const item = { mac, ip, hostname: user, ssid, type: 'Wireless (Wi-Fi)' };
          if (mac) clientMap.set(mac, item);
          if (ip) clientMap.set(ip, item);
        }
      }
    }
  } catch { /* optional */ }

  try {
    const dot11CliRows = await rd.table([
      AP_OIDS.cisco_dot11_client.mac,
      AP_OIDS.cisco_dot11_client.ip,
      AP_OIDS.cisco_dot11_client.ssid,
    ], 128);
    if (dot11CliRows && Object.keys(dot11CliRows).length) {
      for (const [idx, r] of Object.entries(dot11CliRows)) {
        const mac = formatMac(r[AP_OIDS.cisco_dot11_client.mac]);
        const ip = formatIp(r[AP_OIDS.cisco_dot11_client.ip]);
        const rawSsid = normalizeSsid(r[AP_OIDS.cisco_dot11_client.ssid]);
        const ssid = !isSystemOrHiddenSsid(rawSsid) ? rawSsid : '';
        if (mac || ip) {
          const item = { mac, ip, hostname: '', ssid, type: 'Wireless (Wi-Fi)' };
          if (mac && !clientMap.has(mac)) clientMap.set(mac, item);
          if (ip && !clientMap.has(ip)) clientMap.set(ip, item);
        }
      }
    }
  } catch { /* optional */ }

  // If no ssids were discovered from tables, but we have clients grouped by ssid:
  if (!ssids.length && clientMap.size > 0) {
    const ssidCount = new Map();
    const seen = new Set();
    for (const cli of clientMap.values()) {
      const key = cli.mac || cli.ip;
      if (seen.has(key)) continue;
      seen.add(key);
      const sName = normalizeSsid(cli.ssid);
      if (sName && !isSystemOrHiddenSsid(sName)) {
        ssidCount.set(sName, (ssidCount.get(sName) || 0) + 1);
      }
    }
    for (const [name, count] of ssidCount.entries()) {
      ssids.push({ ssid: name, clients: count, bssid: '', band: '', channel: null });
    }
  }

  // Read Standard ARP Tables (RFC 1213 / RFC 4293)
  const arpTable = [];
  const arpSeen = new Set();
  const parseArpType = (v) => ({ 1: 'Khác', 2: 'Không hợp lệ', 3: 'Dynamic (Động)', 4: 'Static (Tĩnh)' }[num(v)] || 'Dynamic');

  try {
    const mediaRows = await rd.table([
      AP_OIDS.arp.physAddress,
      AP_OIDS.arp.netAddress,
      AP_OIDS.arp.type,
      AP_OIDS.arp.ifIndex,
    ], 256);
    if (mediaRows && Object.keys(mediaRows).length) {
      for (const [idx, r] of Object.entries(mediaRows)) {
        const rawType = num(r[AP_OIDS.arp.type]);
        if (rawType === 2) continue;
        let ip = formatIp(r[AP_OIDS.arp.netAddress]);
        if (!ip || ip === '0.0.0.0') {
          const parts = idx.split('.');
          if (parts.length >= 4) ip = parts.slice(-4).join('.');
        }
        const mac = formatMac(r[AP_OIDS.arp.physAddress]);
        if (!mac || mac === '00:00:00:00:00:00') continue;
        if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1' || ip.startsWith('255.')) continue;
        const ifIdx = num(r[AP_OIDS.arp.ifIndex]) || (idx.split('.')[0] ? num(idx.split('.')[0]) : null);
        const ifName = ifIdx ? `if${ifIdx}` : '';
        const sta = clientMap.get(ip) || clientMap.get(mac);
        const staSsid = sta && sta.ssid ? normalizeSsid(sta.ssid) : '';
        const entry = {
          ip,
          mac,
          hostname: sta && sta.hostname ? sta.hostname : '',
          ssid: !isSystemOrHiddenSsid(staSsid) ? staSsid : '',
          interface: ifName,
          type: parseArpType(rawType),
        };
        const key = `${ip}-${mac}`;
        if (!arpSeen.has(key)) {
          arpSeen.add(key);
          arpTable.push(entry);
        }
      }
    }
  } catch { /* optional */ }

  if (!arpTable.length) {
    try {
      const physRows = await rd.table([
        AP_OIDS.arp_phys.netAddress,
        AP_OIDS.arp_phys.physAddress,
        AP_OIDS.arp_phys.type,
      ], 256);
      if (physRows && Object.keys(physRows).length) {
        for (const [idx, r] of Object.entries(physRows)) {
          let ip = formatIp(r[AP_OIDS.arp_phys.netAddress]);
          const mac = formatMac(r[AP_OIDS.arp_phys.physAddress]);
          if (!mac || mac === '00:00:00:00:00:00') continue;
          if (!ip || ip === '0.0.0.0' || ip === '127.0.0.1') continue;
          const sta = clientMap.get(ip) || clientMap.get(mac);
          const staSsid = sta && sta.ssid ? normalizeSsid(sta.ssid) : '';
          const entry = {
            ip,
            mac,
            hostname: sta && sta.hostname ? sta.hostname : '',
            ssid: !isSystemOrHiddenSsid(staSsid) ? staSsid : '',
            interface: '',
            type: parseArpType(r[AP_OIDS.arp_phys.type]),
          };
          const key = `${ip}-${mac}`;
          if (!arpSeen.has(key)) {
            arpSeen.add(key);
            arpTable.push(entry);
          }
        }
      }
    } catch { /* optional */ }
  }

  // Include any wireless client from vendor station tables not yet in ARP table
  if (clientMap.size > 0) {
    const seenCli = new Set();
    for (const cli of clientMap.values()) {
      const key = cli.mac || cli.ip;
      if (seenCli.has(key)) continue;
      seenCli.add(key);
      const arpKey = `${cli.ip}-${cli.mac}`;
      if (!arpSeen.has(arpKey) && (cli.ip || cli.mac)) {
        arpSeen.add(arpKey);
        const cliSsid = cli.ssid ? normalizeSsid(cli.ssid) : '';
        arpTable.push({
          ip: cli.ip || '—',
          mac: cli.mac || '—',
          hostname: cli.hostname || '',
          ssid: !isSystemOrHiddenSsid(cliSsid) ? cliSsid : '',
          interface: 'wlan',
          type: 'Wireless (Wi-Fi)',
        });
      }
    }
  }

  // Compute totals
  let sumClients = 0;
  for (const s of ssids) sumClients += (s.clients || 0);
  if (sumClients > 0) {
    totalClients = sumClients;
  } else if (totalClients == null) {
    totalClients = 0;
  }
  if (totalClients === 0 && clientMap.size > 0) {
    const validCli = [...clientMap.values()].filter((c) => !c.ssid || !isSystemOrHiddenSsid(c.ssid));
    const uniqueMacs = new Set(validCli.map((c) => c.mac || c.ip).filter(Boolean));
    if (uniqueMacs.size > 0) totalClients = uniqueMacs.size;
  }

  const uniqueSsidNames = new Set(ssids.map((s) => s.ssid));
  const totalSsids = uniqueSsidNames.size;

  // Breakdown by frequency band (2.4 GHz, 5 GHz, 6 GHz, etc.)
  const byBand = {};
  for (const s of ssids) {
    const b = s.band || 'Mặc định';
    if (!byBand[b]) byBand[b] = { count: 0, clients: 0 };
    byBand[b].count++;
    byBand[b].clients += (s.clients || 0);
  }

  if (!ssids.length && !arpTable.length && totalClients == null) {
    return null;
  }

  return {
    total_ssids: totalSsids,
    total_clients: totalClients != null ? totalClients : 0,
    ssids,
    arp_table: arpTable,
    has_arp: arpTable.length > 0,
    by_band: byBand,
  };
}

async function pollDevice({ host, port = 161, community = 'public', profile = '' }) {
  const conn = { host, port, community };
  let id;
  try {
    id = await snmp.snmpGet({ ...conn, oids: [snmp.OIDS.sysDescr, snmp.OIDS.sysObjectID, snmp.OIDS.sysName] });
  } catch (e) {
    if (/timeout/i.test(e.message)) throw new SnmpFail('timeout', `${MESSAGES.timeout} (hoặc sai community)`);
    throw new SnmpFail('error', e.message);
  }
  const ident = {
    sysDescr: id[snmp.OIDS.sysDescr] || '',
    sysObjectID: id[snmp.OIDS.sysObjectID] || '',
    sysName: id[snmp.OIDS.sysName] || '',
  };
  const reg = profiles();
  const manual = profile ? reg.byId.get(profile) : null;
  const chosen = manual || detectProfile(ident, reg);
  const info = {
    ...ident, uptime: null,
    profile: { id: chosen.id, name: chosen.name, auto: !manual, requested: profile || '', missing: !!profile && !manual },
    diag: {}, extra: [],
  };

  const rd = new Reader(conn);
  const results = await Promise.all(Object.entries(chosen.metrics).map(([k, d]) => evalMetric(k, d, rd)));
  for (const r of results) {
    const def = chosen.metrics[r.key];
    const label = def.label || r.key;
    info.diag[r.key] = r.ok
      ? { ok: true, label, value: r.value, unit: def.unit || '', source: r.source, unverified: r.unverified, tried: r.tried }
      : { ok: false, label, optional: !!def.optional, code: r.code, message: r.message, tried: r.tried };
    if (!r.ok) continue;
    if (r.key === 'uptime') info.uptime = Math.floor(r.value);
    else if (CORE.includes(r.key)) info[r.key] = r.value;
    else info.extra.push({ key: r.key, label, unit: def.unit || '', value: r.value });
  }
  const ifc = await readIfCounters(rd);
  if (ifc) info.if_counters = ifc;
  const pkt = await readPktCounters(rd);
  if (pkt) info.pkt_counters = pkt;

  const isPrinterCandidate = chosen.id.includes('printer')
    || /printer|laserjet|deskjet|pagewide|canon|brother|epson|xerox|ricoh/i.test(ident.sysDescr)
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.2435')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.1602')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.11.2.3.9')
    || chosen.metrics.toner || chosen.metrics.drum;
  if (isPrinterCandidate) {
    const prn = await readPrinterDetails(rd, ident);
    if (prn) {
      info.printer = prn;
      if (info.toner == null && prn.toner != null) info.toner = prn.toner;
      if (info.drum == null && prn.drum != null) info.drum = prn.drum;
      if (info.page_count == null && prn.page_count != null) info.page_count = prn.page_count;
      if (info.ram == null && prn.memory) info.ram = prn.memory.percent;
    }
  }

  const isApCandidate = chosen.id.includes('ap')
    || chosen.id.includes('unifi')
    || chosen.id.includes('ruckus')
    || chosen.id.includes('aruba')
    || chosen.id.includes('omada')
    || chosen.id.includes('grandstream')
    || /(?:access[ -]?point|\bap\b|wireless|unifi|ubnt|uap|u6|aruba|iap|instant.*ap|ruckus|zonedirector|smartzone|unleashed|omada|eap|grandstream|gwn|aironet|catalyst.*9800|c9800)/i.test(ident.sysDescr)
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.41112')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.25053')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.14823')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.11863')
    || ident.sysObjectID.startsWith('1.3.6.1.4.1.42397');
  if (isApCandidate) {
    const ap = await readApDetails(rd, ident);
    if (ap) {
      info.ap = ap;
      if (info.total_ssids == null && ap.total_ssids != null) info.total_ssids = ap.total_ssids;
      if (info.total_clients == null && ap.total_clients != null) info.total_clients = ap.total_clients;
    }
  }

  return info;
}

module.exports = {
  pollDevice, loadProfiles, reloadProfiles, listProfiles, detectProfile, profiles, SnmpFail, MESSAGES, PROFILES_DIR,
  isSystemOrHiddenSsid, isValidUserSsid, normalizeSsid, parseBand, formatMac, formatIp,
};
