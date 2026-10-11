'use strict';
// SNMP device-profile engine. All vendor knowledge lives in server/profiles/*.json;
// this file only knows how to detect a profile and evaluate its data-driven metric
// definitions. See README "Cách thêm hồ sơ cho một hãng mới".
const fs = require('node:fs');
const path = require('node:path');
const snmp = require('./snmp');

const PROFILES_DIR = path.join(__dirname, 'profiles');
// Metrics the dashboard understands natively; any other metric is shown as an extra row.
const CORE = ['cpu', 'ram', 'disk', 'temperature', 'toner'];
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
  return info;
}

module.exports = {
  pollDevice, loadProfiles, reloadProfiles, listProfiles, detectProfile, profiles, SnmpFail, MESSAGES, PROFILES_DIR,
};
