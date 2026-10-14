'use strict';
// SNMP device-profile engine. All vendor knowledge lives in server/profiles/*.json;
// this file only knows how to detect a profile and evaluate its data-driven metric
// definitions. See README "Cách thêm hồ sơ cho một hãng mới".
const fs = require('node:fs');
const path = require('node:path');
const snmp = require('./snmp');

const PROFILES_DIR = path.join(__dirname, 'profiles');
// Metrics the dashboard understands natively; any other metric is shown as an extra row.
const CORE = ['cpu', 'ram', 'disk', 'temperature', 'toner', 'drum', 'page_count'];
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

// ---- packet counters for Flood/DoS detection (TCP-MIB & UDP-MIB) ------------
const TCP_IN_SEGS = '1.3.6.1.2.1.6.10.0';
const UDP_IN_DATAGRAMS = '1.3.6.1.2.1.7.1.0';

// -> { tcp: number|null, udp: number|null } or null when unsupported.
async function readPktCounters(rd) {
  let tcp = null, udp = null;
  try { tcp = num(await rd.get(TCP_IN_SEGS)); } catch { /* optional TCP-MIB */ }
  try { udp = num(await rd.get(UDP_IN_DATAGRAMS)); } catch { /* optional UDP-MIB */ }
  if (tcp === null && udp === null) return null;
  return { tcp, udp };
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

  return info;
}

module.exports = {
  pollDevice, loadProfiles, reloadProfiles, listProfiles, detectProfile, profiles, SnmpFail, MESSAGES, PROFILES_DIR,
};
