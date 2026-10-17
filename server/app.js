'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth');
const { getSettings, setSetting } = require('./db');
const { ADDR_RE, SEV_RANK } = require('./monitor');
const { info: versionInfo } = require('./version');
const engine = require('./snmp-engine');
const walkfile = require('./snmp-walkfile');

const TYPES = ['server', 'vm', 'router', 'switch', 'firewall', 'ap', 'printer', 'ups', 'pc', 'other'];
const THEMES = ['dark', 'light', 'neon'];
const LANGS = ['vi', 'en'];
const ROLES = ['admin', 'operator', 'viewer'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Payload quá lớn')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch { reject(bad('JSON không hợp lệ')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers,
  });
  res.end(data);
}

const tokenEq = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function cleanDevice(b, partial = false) {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(b.name || '').trim();
    if (!name || name.length > 100) throw bad('Tên thiết bị bắt buộc (tối đa 100 ký tự)');
    out.name = name;
  }
  if (!partial || has('type')) {
    if (!TYPES.includes(b.type)) throw bad('Loại thiết bị không hợp lệ');
    out.type = b.type;
  }
  if (!partial || has('address')) {
    const a = String(b.address || '').trim();
    if (a && !ADDR_RE.test(a)) throw bad('Địa chỉ IP/hostname không hợp lệ');
    out.address = a;
  }
  for (const k of ['check_icmp', 'check_agent', 'snmp_enabled', 'maintenance', 'mute_local_alerts']) {
    if (!partial || has(k)) out[k] = b[k] ? 1 : 0;
  }
  if (!partial || has('telegram_enabled')) {
    out.telegram_enabled = b.telegram_enabled === undefined ? 1 : (b.telegram_enabled ? 1 : 0);
  }
  if (!partial || has('snmp_community')) {
    const c = String(b.snmp_community ?? 'public');
    if (c.length > 64) throw bad('SNMP community quá dài');
    out.snmp_community = c;
  }
  if (!partial || has('snmp_port')) {
    const p = Number(b.snmp_port ?? 161);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw bad('SNMP port không hợp lệ');
    out.snmp_port = p;
  }
  if (!partial || has('snmp_profile')) {
    const p = String(b.snmp_profile || '');
    if (p && !engine.profiles().byId.has(p)) throw bad('Hồ sơ SNMP không tồn tại');
    out.snmp_profile = p;
  }
  if (!partial || has('severity')) {
    let s = b.severity;
    if (s === 0 || s === '0' || s === 'none') s = 'none';
    else if (!s) s = null;
    if (s && SEV_RANK[s] === undefined) throw bad('Mức cảnh báo không hợp lệ');
    out.severity = s;
  }
  for (const k of ['location', 'notes']) {
    if (!partial || has(k)) out[k] = String(b[k] || '').slice(0, 500);
  }
  if ((out.check_icmp || out.snmp_enabled) && out.address === '') throw bad('Cần địa chỉ IP để ping/SNMP');
  return out;
}

function cleanMap(data) {
  const nodes = Array.isArray(data.nodes) ? data.nodes.slice(0, 500) : [];
  const links = Array.isArray(data.links) ? data.links.slice(0, 1000) : [];
  const n = (v) => (Number.isFinite(v) ? Math.round(Math.min(10000, Math.max(-10000, v))) : 0);
  const cn = nodes.map((x) => ({
    id: String(x.id || '').slice(0, 40),
    kind: ['device', 'group', 'label'].includes(x.kind) ? x.kind : 'device',
    ref: Number.isInteger(x.ref) ? x.ref : null,
    label: String(x.label || '').slice(0, 80),
    x: n(x.x), y: n(x.y),
  })).filter((x) => x.id);
  const ids = new Set(cn.map((x) => x.id));
  const cl = links.map((l) => ({ from: String(l.from || ''), to: String(l.to || '') }))
    .filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to);
  return { nodes: cn, links: cl };
}

function createApp(db, monitor, opts = {}) {
  const publicDir = opts.publicDir || path.join(__dirname, '..', 'public');
  const agentDir = path.join(__dirname, '..', 'agents');
  const limiter = new auth.LoginLimiter();
  const secureCookie = !!opts.secureCookie;
  const sseClients = new Set();
  const routes = [];

  // role: null = public, 'any' = logged in, else minimum role
  const route = (method, pattern, role, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, role, handler });
  };
  const RANK = { viewer: 1, operator: 2, admin: 3 };

  const cookieFor = (token, maxAge) =>
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, must_change: !!u.must_change, theme: u.theme, lang: u.lang });
  const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw bad('ID không hợp lệ'); return n; };
  const audit = (ctx, msg) => monitor._event({ id: null, name: ctx.user ? ctx.user.username : 'system' }, 'audit', 'ok', msg);

  // ---------- auth ----------
  route('POST', '/api/auth/login', null, async (ctx) => {
    const ip = ctx.req.socket.remoteAddress || '?';
    if (limiter.blocked(ip)) throw new HttpError(429, 'Quá nhiều lần đăng nhập sai, thử lại sau vài phút');
    const b = await readBody(ctx.req, 4096);
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(b.username || ''));
    // verify against a dummy hash when the user is unknown to keep timing similar
    const ok = u ? auth.verifyPassword(String(b.password || ''), u.pass_hash) : (auth.verifyPassword('x', auth.hashPassword('y')), false);
    if (!ok) { limiter.fail(ip); throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu'); }
    limiter.reset(ip);
    const token = auth.createSession(db, u.id);
    send(ctx.res, 200, { user: publicUser(u) }, { 'Set-Cookie': cookieFor(token, auth.SESSION_TTL / 1000) });
  });

  route('POST', '/api/auth/logout', 'any', (ctx) => {
    auth.destroySession(db, ctx.token);
    send(ctx.res, 200, { ok: true }, { 'Set-Cookie': cookieFor('', 0) });
  });

  route('GET', '/api/auth/me', 'any', (ctx) => send(ctx.res, 200, { user: publicUser(ctx.user) }));

  route('POST', '/api/auth/password', 'any', async (ctx) => {
    const b = await readBody(ctx.req, 4096);
    const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!auth.verifyPassword(String(b.current || ''), row.pass_hash)) throw new HttpError(403, 'Mật khẩu hiện tại không đúng');
    const err = auth.validatePassword(b.password);
    if (err) throw bad(err);
    if (b.password === b.current) throw bad('Mật khẩu mới phải khác mật khẩu cũ');
    db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(auth.hashPassword(b.password), ctx.user.id);
    auth.destroyUserSessions(db, ctx.user.id, ctx.token);
    send(ctx.res, 200, { ok: true });
  });

  route('PUT', '/api/auth/theme', 'any', async (ctx) => {
    const b = await readBody(ctx.req, 1024);
    if (!THEMES.includes(b.theme)) throw bad('Theme không hợp lệ');
    db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(b.theme, ctx.user.id);
    send(ctx.res, 200, { ok: true });
  });

  route('PUT', '/api/auth/lang', 'any', async (ctx) => {
    const b = await readBody(ctx.req, 1024);
    if (!LANGS.includes(b.lang)) throw bad('Ngôn ngữ không hợp lệ');
    db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(b.lang, ctx.user.id);
    send(ctx.res, 200, { ok: true, lang: b.lang });
  });

  // ---------- realtime ----------
  route('GET', '/api/stream', 'any', (ctx) => {
    ctx.res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SEC_HEADERS,
    });
    const client = { res: ctx.res, last: 0 };
    sseClients.add(client);
    pushTo(client);
    ctx.req.on('close', () => sseClients.delete(client));
  });
  const pushTo = (c) => {
    c.last = Date.now();
    c.res.write(`event: snapshot\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
  };
  const pushAll = () => { for (const c of sseClients) pushTo(c); };
  monitor.on('change', () => {
    for (const c of sseClients) if (Date.now() - c.last > 300) pushTo(c);
  });
  const sseTimer = setInterval(() => { for (const c of sseClients) if (Date.now() - c.last >= 3000) pushTo(c); }, 1000);
  sseTimer.unref?.();

  route('GET', '/api/snapshot', 'any', (ctx) => send(ctx.res, 200, monitor.snapshot()));

  // ---------- devices ----------
  const setGroups = (deviceId, ids) => {
    db.prepare('DELETE FROM device_groups WHERE device_id = ?').run(deviceId);
    const ins = db.prepare('INSERT OR IGNORE INTO device_groups(device_id,group_id) SELECT ?, id FROM groups WHERE id = ?');
    for (const g of Array.isArray(ids) ? ids : []) ins.run(deviceId, idOf(g));
  };
  const insertDevice = (d) => {
    const token = crypto.randomBytes(24).toString('hex');
    const r = db.prepare(
      `INSERT INTO devices(name,type,address,check_icmp,check_agent,snmp_enabled,snmp_community,snmp_port,snmp_profile,severity,
        location,notes,maintenance,mute_local_alerts,telegram_enabled,agent_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.name, d.type, d.address, d.check_icmp, d.check_agent, d.snmp_enabled, d.snmp_community, d.snmp_port, d.snmp_profile || '',
        d.severity, d.location, d.notes, d.maintenance, d.mute_local_alerts || 0, d.telegram_enabled !== undefined ? d.telegram_enabled : 1, token, Date.now());
    return { id: Number(r.lastInsertRowid), token };
  };

  route('GET', '/api/devices', 'any', (ctx) => send(ctx.res, 200, { devices: monitor.snapshot().devices }));

  route('POST', '/api/devices', 'admin', async (ctx) => {
    const b = await readBody(ctx.req);
    const d = cleanDevice({ type: 'server', check_icmp: true, ...b });
    const { id } = insertDevice(d);
    setGroups(id, b.groups);
    monitor.reload();
    audit(ctx, `Thêm thiết bị "${d.name}"`);
    send(ctx.res, 201, { id });
  });

  route('GET', '/api/devices/:id', 'any', (ctx) => {
    const d = monitor.devices.get(idOf(ctx.p.id));
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');
    const v = monitor.view(d, true);
    if (RANK[ctx.user.role] >= RANK.admin) { v.agent_token = d.agent_token; v.snmp_community = d.snmp_community; }
    send(ctx.res, 200, v);
  });

  route('PUT', '/api/devices/:id', 'admin', async (ctx) => {
    const id = idOf(ctx.p.id);
    const cur = monitor.devices.get(id);
    if (!cur) throw new HttpError(404, 'Không tìm thấy thiết bị');
    const b = await readBody(ctx.req);
    const d = cleanDevice({ ...cur, ...b });
    db.prepare(
      `UPDATE devices SET name=?,type=?,address=?,check_icmp=?,check_agent=?,snmp_enabled=?,snmp_community=?,
        snmp_port=?,snmp_profile=?,severity=?,location=?,notes=?,maintenance=?,mute_local_alerts=?,telegram_enabled=? WHERE id=?`)
      .run(d.name, d.type, d.address, d.check_icmp, d.check_agent, d.snmp_enabled, d.snmp_community, d.snmp_port, d.snmp_profile || '',
        d.severity, d.location, d.notes, d.maintenance, d.mute_local_alerts || 0, d.telegram_enabled !== undefined ? d.telegram_enabled : 1, id);
    if (b.groups !== undefined) setGroups(id, b.groups);
    monitor.reload();
    monitor.evaluate();
    monitor.emit('change');
    send(ctx.res, 200, { ok: true });
  });

  route('DELETE', '/api/devices/:id', 'admin', (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    monitor.reload();
    audit(ctx, `Xóa thiết bị "${d.name}"`);
    monitor.emit('change');
    send(ctx.res, 200, { ok: true });
  });

  route('POST', '/api/devices/:id/ack', 'operator', (ctx) => {
    if (!monitor.ack(idOf(ctx.p.id))) throw new HttpError(404, 'Không tìm thấy thiết bị');
    send(ctx.res, 200, { ok: true });
  });

  // Mock DoS / Flood injection for testing alert thresholds and dashboard responses
  route('POST', '/api/devices/:id/mock-dos', null, async (ctx) => {
    const id = idOf(ctx.p.id);
    const d = monitor.devices.get(id);
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');

    // Auth: localhost loopback OR agent_token OR logged-in operator/admin
    const remote = ctx.req.socket.remoteAddress || '';
    const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    const authHeader = ctx.req.headers.authorization || '';
    const tokenMatch = /^Bearer\s+(\S+)$/.exec(authHeader);
    const tokenValid = tokenMatch && tokenMatch[1] === d.agent_token;
    const userRole = ctx.user && (ctx.user.role === 'admin' || ctx.user.role === 'operator');

    if (!isLoopback && !tokenValid && !userRole) {
      throw new HttpError(403, 'Yêu cầu quyền quản trị, agent token hoặc chạy từ localhost');
    }

    const body = await readBody(ctx.req);
    const result = monitor.mockDos(id, body);
    if (!result) throw new HttpError(404, 'Không thể kích hoạt giả lập DoS');
    send(ctx.res, 200, { ok: true, result });
  });

  route('POST', '/api/devices/:id/regen-token', 'admin', (ctx) => {
    const id = idOf(ctx.p.id);
    if (!monitor.devices.has(id)) throw new HttpError(404, 'Không tìm thấy thiết bị');
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE devices SET agent_token = ? WHERE id = ?').run(token, id);
    monitor.reload();
    send(ctx.res, 200, { agent_token: token });
  });

  route('GET', '/api/snmp/profiles', 'any', (ctx) => send(ctx.res, 200, { profiles: engine.listProfiles() }));

  // Lets the customer send a real walk of an unsupported device (community is never written to the file).
  route('POST', '/api/devices/:id/snmp-walk', 'admin', async (ctx) => {
    const d = monitor.devices.get(idOf(ctx.p.id));
    if (!d) throw new HttpError(404, 'Không tìm thấy thiết bị');
    if (!d.address) throw new HttpError(400, 'Thiết bị chưa có địa chỉ IP');
    let out;
    try {
      out = await walkfile.exportWalk({ host: d.address, port: d.snmp_port, community: d.snmp_community });
    } catch (e) {
      throw new HttpError(502, `Không đọc được SNMP từ thiết bị: ${e.message}`);
    }
    audit(ctx, `Xuất dữ liệu SNMP của "${d.name}"`);
    const fname = `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'device'}.walk`;
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS,
      'Content-Disposition': `attachment; filename="${fname}"`,
    });
    ctx.res.end(out.text);
  });

  require('./diagnostics').registerRoutes({ route, db, monitor, readBody, send, idOf, bad, HttpError, audit }, opts.diag);

  const RANGES = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };
  route('GET', '/api/devices/:id/history', 'any', (ctx) => {
    const id = idOf(ctx.p.id);
    const span = RANGES[ctx.query.get('range')] || RANGES['1h'];
    const step = Math.max(30e3, Math.floor(span / 240 / 1000) * 1000);
    const rows = db.prepare(
      `SELECT (ts / ?) * ? AS ts, AVG(cpu) cpu, AVG(ram) ram, MAX(disk) disk, AVG(rtt) rtt,
              AVG(net_in) net_in, AVG(net_out) net_out, AVG(temp) temp,
              AVG(toner) toner, AVG(drum) drum
       FROM metrics WHERE device_id = ? AND ts >= ? GROUP BY ts / ? ORDER BY ts`)
      .all(step, step, id, Date.now() - span, step);
    send(ctx.res, 200, { points: rows });
  });

  // ---------- groups ----------
  const groupView = (g, snap) => {
    const ids = db.prepare('SELECT device_id FROM device_groups WHERE group_id = ?').all(g.id).map((r) => r.device_id);
    const devs = snap.devices.filter((d) => ids.includes(d.id));
    return { ...g, device_ids: ids, summary: monitor.summarize(devs) };
  };
  route('GET', '/api/groups', 'any', (ctx) => {
    const snap = monitor.snapshot();
    send(ctx.res, 200, { groups: db.prepare('SELECT * FROM groups ORDER BY name').all().map((g) => groupView(g, snap)) });
  });
  const saveGroup = (id, b) => {
    const name = String(b.name || '').trim();
    if (!name || name.length > 80) throw bad('Tên nhóm bắt buộc (tối đa 80 ký tự)');
    const desc = String(b.description || '').slice(0, 300);
    try {
      if (id) db.prepare('UPDATE groups SET name=?, description=? WHERE id=?').run(name, desc, id);
      else id = Number(db.prepare('INSERT INTO groups(name,description) VALUES(?,?)').run(name, desc).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Tên nhóm đã tồn tại');
      throw e;
    }
    if (Array.isArray(b.device_ids)) {
      db.prepare('DELETE FROM device_groups WHERE group_id = ?').run(id);
      const ins = db.prepare('INSERT OR IGNORE INTO device_groups(device_id,group_id) SELECT id, ? FROM devices WHERE id = ?');
      for (const d of b.device_ids) ins.run(id, idOf(d));
    }
    monitor.reload();
    monitor.emit('change');
    return id;
  };
  route('POST', '/api/groups', 'admin', async (ctx) => send(ctx.res, 201, { id: saveGroup(null, await readBody(ctx.req)) }));
  route('PUT', '/api/groups/:id', 'admin', async (ctx) => {
    const id = idOf(ctx.p.id);
    if (!db.prepare('SELECT 1 FROM groups WHERE id = ?').get(id)) throw new HttpError(404, 'Không tìm thấy nhóm');
    saveGroup(id, await readBody(ctx.req));
    send(ctx.res, 200, { ok: true });
  });
  route('DELETE', '/api/groups/:id', 'admin', (ctx) => {
    db.prepare('DELETE FROM groups WHERE id = ?').run(idOf(ctx.p.id));
    monitor.reload();
    monitor.emit('change');
    send(ctx.res, 200, { ok: true });
  });

  // ---------- maps ----------
  route('GET', '/api/maps', 'any', (ctx) => send(ctx.res, 200, { maps: db.prepare('SELECT id, name FROM maps ORDER BY name').all() }));
  route('GET', '/api/maps/:id', 'any', (ctx) => {
    const m = db.prepare('SELECT * FROM maps WHERE id = ?').get(idOf(ctx.p.id));
    if (!m) throw new HttpError(404, 'Không tìm thấy sơ đồ');
    send(ctx.res, 200, { id: m.id, name: m.name, ...JSON.parse(m.data) });
  });
  route('POST', '/api/maps', 'operator', async (ctx) => {
    const b = await readBody(ctx.req);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw bad('Tên sơ đồ bắt buộc');
    const r = db.prepare('INSERT INTO maps(name,data) VALUES(?,?)').run(name, JSON.stringify(cleanMap(b)));
    send(ctx.res, 201, { id: Number(r.lastInsertRowid) });
  });
  route('PUT', '/api/maps/:id', 'operator', async (ctx) => {
    const id = idOf(ctx.p.id);
    const b = await readBody(ctx.req, 1024 * 1024);
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw bad('Tên sơ đồ bắt buộc');
    db.prepare('UPDATE maps SET name=?, data=? WHERE id=?').run(name, JSON.stringify(cleanMap(b)), id);
    send(ctx.res, 200, { ok: true });
  });
  route('DELETE', '/api/maps/:id', 'operator', (ctx) => {
    db.prepare('DELETE FROM maps WHERE id = ?').run(idOf(ctx.p.id));
    send(ctx.res, 200, { ok: true });
  });

  // ---------- events & AI reports ----------
  const { PROVIDER_PRESETS, buildIncidentPrompt } = require('./ai');

  route('GET', '/api/events', 'any', (ctx) => {
    const limit = Math.min(500, Math.max(1, Number(ctx.query.get('limit')) || 100));
    const dev = ctx.query.get('device');
    const rows = dev
      ? db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY ts DESC LIMIT ?').all(idOf(dev), limit)
      : db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
    if (rows.length) {
      const evIds = rows.map((r) => r.id);
      const placeholders = evIds.map(() => '?').join(',');
      const aiRows = db.prepare(`SELECT * FROM ai_reports WHERE event_id IN (${placeholders}) ORDER BY ts DESC`).all(...evIds);
      const byEvId = new Map();
      for (const a of aiRows) {
        if (!byEvId.has(a.event_id)) byEvId.set(a.event_id, a);
      }
      for (const r of rows) {
        r.ai_report = byEvId.get(r.id) || null;
      }
    }
    send(ctx.res, 200, { events: rows });
  });

  route('GET', '/api/ai/reports', 'any', (ctx) => {
    const s = getSettings(db);
    const kind = ctx.query.get('kind') || '';
    const dev = ctx.query.get('device');
    const limit = Math.min(300, Math.max(1, Number(ctx.query.get('limit')) || 100));
    const reports = monitor.ai.listReports({
      kind: ['incident', 'daily'].includes(kind) ? kind : undefined,
      deviceId: dev ? idOf(dev) : undefined,
      limit,
    });
    send(ctx.res, 200, {
      reports,
      stats: monitor.ai.callsToday(),
      ai: {
        enabled: !!(s.ai && s.ai.enabled),
        auto_incident: !!(s.ai && s.ai.auto_incident !== false),
        daily_digest_enabled: !!(s.ai && s.ai.daily_digest_enabled),
        daily_digest_time: (s.ai && s.ai.daily_digest_time) || '23:55',
        cooldown_minutes: (s.ai && s.ai.cooldown_minutes) || 60,
        daily_call_limit: (s.ai && s.ai.daily_call_limit) || 50,
      },
    });
  });

  route('GET', '/api/ai/technical-logs', 'any', (ctx) => {
    const u = new URL(ctx.req.url, 'http://localhost');
    const eventId = u.searchParams.get('event_id') ? idOf(u.searchParams.get('event_id')) : null;
    const deviceId = u.searchParams.get('device_id') ? idOf(u.searchParams.get('device_id')) : null;
    if (!eventId && !deviceId) {
      send(ctx.res, 400, { error: 'Missing event_id or device_id' });
      return;
    }
    const dev = deviceId ? monitor.devices.get(deviceId) : null;
    const ev = eventId ? db.prepare('SELECT id, device_id FROM events WHERE id = ?').get(eventId) : null;
    if (!dev && !ev) {
      send(ctx.res, 404, { error: 'Device or event not found' });
      return;
    }
    const s = getSettings(db);
    const lang = LANGS.includes(u.searchParams.get('lang')) ? u.searchParams.get('lang') : (ctx.user && ctx.user.lang ? ctx.user.lang : (s.default_lang || 'vi'));
    const { collectDeviceTechnicalLogs } = require('./ai');
    const tech = collectDeviceTechnicalLogs(monitor, { eventId, deviceId, lang });
    send(ctx.res, 200, { ok: true, ...tech });
  });

  route('POST', '/api/ai/analyze', 'operator', async (ctx) => {
    const b = await readBody(ctx.req, 4096);
    const s = getSettings(db);
    const lang = LANGS.includes(b.lang) ? b.lang : (ctx.user.lang || s.default_lang || 'vi');
    let ev = null;
    if (b.event_id) {
      ev = db.prepare('SELECT * FROM events WHERE id = ?').get(idOf(b.event_id));
      if (!ev) throw new HttpError(404, 'Không tìm thấy sự kiện');
    }
    const devId = ev ? ev.device_id : (b.device_id ? idOf(b.device_id) : null);
    const d = devId ? monitor.devices.get(devId) : null;
    const v = d ? monitor.view(d, true) : null;
    const { collectDeviceTechnicalLogs } = require('./ai');
    const tech = collectDeviceTechnicalLogs(monitor, { eventId: ev ? ev.id : null, deviceId: devId, lang });
    const incCtx = {
      device_id: devId,
      device_name: (d && d.name) || (ev && ev.device_name) || 'System',
      device_type: (d && d.type) || 'server',
      device_severity: d ? monitor.severityOf(d) : ((ev && ev.severity) || 'high'),
      address: (d && d.address) || '',
      severity: (ev && (ev.severity === 'critical' || ev.severity === 'high')) ? ev.severity : ((v && v.severity) || 'high'),
      event_severity: ev ? ev.severity : null,
      status: ev ? (ev.severity === 'ok' ? 'ok' : (ev.kind === 'down' ? 'down' : 'warning')) : ((v && v.status) || 'warning'),
      kind: (ev && ev.kind) || (v && v.status) || 'warning',
      reason: (ev && ev.message) || (v && v.reasons && v.reasons.join('; ')) || 'Kiểm tra sức khỏe thiết bị',
      event_id: ev ? ev.id : null,
      tech_summary: tech ? tech.tech_summary : null,
      cpu: v ? v.cpu : null,
      ram: v ? v.ram : null,
      disk: v ? v.disk : null,
      temp: v ? v.temperature : null,
      rtt: v ? v.rtt : null,
      pkt_rate: v ? v.pkt_rate : null,
      smart: v ? v.smart : null,
      power: v ? v.power : null,
    };
    const report = await monitor.ai.analyzeIncident(incCtx, s, { lang, force: true, allowLiveDevice: true });
    if (!report) {
      throw new HttpError(500, 'Không thể tạo báo cáo chẩn đoán AI');
    }
    monitor.emit('change');
    send(ctx.res, 200, { ok: true, report });
  });

  route('POST', '/api/ai/daily-digest', 'operator', async (ctx) => {
    const b = await readBody(ctx.req, 2048);
    const s = getSettings(db);
    const lang = LANGS.includes(b.lang) ? b.lang : (ctx.user.lang || s.default_lang || 'vi');
    const report = await monitor.ai.generateDailyDigest(monitor, s, { lang });
    monitor.emit('change');
    send(ctx.res, 200, { ok: true, report });
  });

  route('POST', '/api/ai/test', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 4096);
    const s = getSettings(db);
    const lang = LANGS.includes(b.lang) ? b.lang : (ctx.user.lang || s.default_lang || 'vi');
    const inAi = (b.ai && typeof b.ai === 'object') ? b.ai : b;
    const provider = inAi.provider || s.ai.provider || 'openai';
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const testCfg = {
      ...s.ai,
      enabled: inAi.enabled !== undefined ? !!inAi.enabled : true,
      provider,
      api_url: (inAi.api_url && String(inAi.api_url).trim()) || (provider === s.ai.provider && s.ai.api_url ? s.ai.api_url : preset.api_url),
      api_key: inAi.api_key !== undefined && inAi.api_key !== '' ? String(inAi.api_key).trim() : s.ai.api_key,
      model: (inAi.model && String(inAi.model).trim()) || (provider === s.ai.provider && s.ai.model ? s.ai.model : preset.model),
      max_tokens: Number(inAi.max_tokens || s.ai.max_tokens || 500),
    };
    const sampleCtx = {
      device_id: 0,
      device_name: 'srv-db-prod-01',
      device_type: 'server',
      address: '10.0.10.25',
      severity: 'critical',
      status: 'warning',
      kind: 'warning',
      reason: lang === 'en' ? 'High Disk: 94% (threshold 90%); High CPU: 92%' : 'Ổ đĩa cao: 94% (ngưỡng 90%); CPU cao: 92%',
      cpu: 92, ram: 84, disk: 94, temp: 76, rtt: 1.8,
      trend: 'CPU_avg=78%/max=92%, Disk=94%(slope=+4.2%/d,full_in~1.4d), Down24h=0',
    };
    const prompt = buildIncidentPrompt(sampleCtx, lang);
    let report;
    let source = 'heuristic';
    if (testCfg.enabled && (testCfg.api_key || testCfg.provider === 'ollama' || (testCfg.provider === 'custom' && testCfg.api_url))) {
      try {
        report = await monitor.ai._callLlm(testCfg, prompt, testCfg.max_tokens || 500);
        source = 'ai';
      } catch (err) {
        const { generateLocalExpertFallback } = require('./ai');
        report = { ...generateLocalExpertFallback(sampleCtx, lang), api_error: err.message };
      }
    } else {
      const { generateLocalExpertFallback } = require('./ai');
      report = generateLocalExpertFallback(sampleCtx, lang);
    }
    const tokensUsed = (report.prompt_tokens || 0) + (report.completion_tokens || 0);
    send(ctx.res, 200, {
      ok: true,
      source,
      live_api_called: source === 'ai',
      lang,
      model: testCfg.model,
      tokens_used: tokensUsed,
      api_error: report.api_error || null,
      prompt,
      prompt_preview: prompt,
      report,
      parsed: report,
    });
  });

  // ---------- telegram alerts ----------
  const saveTelegramConfig = (inTg) => {
    const curTg = getSettings(db).telegram || {};
    const evIn = (inTg.events && typeof inTg.events === 'object') ? inTg.events : {};
    const notifyDown = inTg.notify_down !== undefined ? !!inTg.notify_down : (evIn.down !== undefined ? !!evIn.down : (curTg.notify_down !== false));
    const notifyRecovered = inTg.notify_recovered !== undefined ? !!inTg.notify_recovered : (evIn.recovered !== undefined ? !!evIn.recovered : (curTg.notify_recovered !== false));
    const notifyThreshold = inTg.notify_threshold !== undefined ? !!inTg.notify_threshold : (evIn.threshold !== undefined ? !!evIn.threshold : (curTg.notify_threshold !== false));
    let nextToken = curTg.bot_token || '';
    if (inTg.clear_token) {
      nextToken = '';
    } else if (inTg.bot_token !== undefined && String(inTg.bot_token).trim() !== '') {
      nextToken = String(inTg.bot_token).trim().slice(0, 256);
    } else if (inTg.bot_token === '' && inTg.allow_empty_token) {
      nextToken = '';
    }
    const nextChatId = inTg.chat_id !== undefined ? String(inTg.chat_id || '').trim().slice(0, 128) : (curTg.chat_id || '');
    const nextAppUrl = inTg.app_url !== undefined ? String(inTg.app_url || '').trim().slice(0, 256) : (curTg.app_url || '');
    const nextTg = {
      enabled: inTg.enabled !== undefined ? !!inTg.enabled : !!curTg.enabled,
      bot_token: nextToken,
      chat_id: nextChatId,
      app_url: nextAppUrl,
      notify_down: notifyDown,
      notify_recovered: notifyRecovered,
      notify_threshold: notifyThreshold,
      events: { down: notifyDown, recovered: notifyRecovered, threshold: notifyThreshold },
      cooldown_seconds: Math.min(3600, Math.max(0, Number(inTg.cooldown_seconds ?? curTg.cooldown_seconds ?? 30))),
      max_per_minute: Math.min(300, Math.max(1, Number(inTg.max_per_minute ?? curTg.max_per_minute ?? 20))),
    };
    setSetting(db, 'telegram', nextTg);
    return nextTg;
  };

  route('GET', '/api/alerts/telegram', 'any', (ctx) => {
    const s = getSettings(db);
    const tg = s.telegram || {};
    const configured = Boolean(tg.enabled && tg.bot_token && tg.chat_id);
    if (ctx.user.role !== 'admin') {
      send(ctx.res, 200, { enabled: !!tg.enabled, configured });
      return;
    }
    send(ctx.res, 200, {
      telegram: {
        ...tg,
        has_bot_token: Boolean(tg.bot_token),
        configured,
        stats: monitor.telegram ? monitor.telegram.getStats() : null,
      },
    });
  });

  route('PUT', '/api/alerts/telegram', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 8192);
    const inTg = (b.telegram && typeof b.telegram === 'object') ? b.telegram : b;
    const saved = saveTelegramConfig(inTg);
    monitor.reload();
    monitor.emit('change');
    audit(ctx, `Cập nhật cấu hình cảnh báo Telegram (${saved.enabled ? 'Bật' : 'Tắt'})`);
    send(ctx.res, 200, {
      ok: true,
      telegram: {
        ...saved,
        has_bot_token: Boolean(saved.bot_token),
        configured: Boolean(saved.enabled && saved.bot_token && saved.chat_id),
      },
    });
  });

  route('POST', '/api/alerts/test-telegram', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 8192);
    const s = getSettings(db);
    const curTg = s.telegram || {};
    const inTg = (b.telegram && typeof b.telegram === 'object') ? b.telegram : b;
    const token = (inTg.bot_token !== undefined && String(inTg.bot_token).trim() !== '')
      ? String(inTg.bot_token).trim()
      : String(curTg.bot_token || '').trim();
    const chatId = (inTg.chat_id !== undefined && String(inTg.chat_id).trim() !== '')
      ? String(inTg.chat_id).trim()
      : String(curTg.chat_id || '').trim();
    const hostHeader = ctx.req.headers.host ? `http://${ctx.req.headers.host}` : 'http://localhost:8080';
    const appUrl = (inTg.app_url && String(inTg.app_url).trim()) || curTg.app_url || hostHeader;
    const lang = LANGS.includes(b.lang) ? b.lang : (ctx.user.lang || s.default_lang || 'vi');

    if (!token) throw bad('Vui lòng nhập Bot Token trước khi gửi tin thử nghiệm');
    if (!chatId) throw bad('Vui lòng nhập Chat ID / Group ID trước khi gửi tin thử nghiệm');

    try {
      const out = await monitor.telegram.sendTestMessage({
        bot_token: token,
        chat_id: chatId,
        app_url: appUrl,
        lang,
        org_name: s.org_name || 'Monitoring',
      });
      send(ctx.res, 200, {
        ok: true,
        message: lang === 'en' ? 'Test message sent to Telegram successfully!' : 'Đã gửi tin nhắn thử nghiệm tới Telegram thành công!',
        ...out,
      });
    } catch (err) {
      throw new HttpError(err.status === 429 ? 429 : 502, err.message || 'Không gửi được tin nhắn Telegram');
    }
  });

  // ---------- settings ----------
  route('GET', '/api/settings', 'any', (ctx) => {
    const s = getSettings(db);
    const tg = s.telegram || {};
    const tgConfigured = Boolean(tg.enabled && tg.bot_token && tg.chat_id);
    const out = { type_severity: s.type_severity, thresholds: s.thresholds, org_name: s.org_name, default_theme: s.default_theme,
      default_lang: s.default_lang || 'vi',
      ai_enabled: !!(s.ai && s.ai.enabled),
      telegram_enabled: !!tg.enabled,
      telegram_configured: tgConfigured,
      types: TYPES, timing: { ping_interval_ms: monitor.o.pingIntervalMs, ping_fail_limit: monitor.o.pingFailLimit,
        agent_timeout_ms: monitor.o.agentTimeoutMs }, version: versionInfo };
    if (ctx.user.role === 'admin') {
      out.enroll_key = s.enroll_key;
      out.system = monitor.systemInfo();
      const stats = monitor.ai.callsToday();
      out.ai_presets = PROVIDER_PRESETS;
      out.ai_stats = stats;
      out.ai = {
        ...s.ai,
        has_api_key: Boolean(s.ai && s.ai.api_key),
        api_key: '',
        presets: PROVIDER_PRESETS,
        stats,
      };
      out.telegram = {
        ...tg,
        has_bot_token: Boolean(tg.bot_token),
        configured: tgConfigured,
        stats: monitor.telegram ? monitor.telegram.getStats() : null,
      };
    }
    send(ctx.res, 200, out);
  });
  route('PUT', '/api/settings', 'admin', async (ctx) => {
    const b = await readBody(ctx.req);
    if (b.type_severity) {
      const t = {};
      for (const k of TYPES) if (b.type_severity[k] !== undefined && b.type_severity[k] !== '') {
        let val = b.type_severity[k];
        if (val === 0 || val === '0' || val === 'none') val = 'none';
        if (SEV_RANK[val] === undefined) throw bad('Mức cảnh báo không hợp lệ');
        t[k] = val;
      }
      setSetting(db, 'type_severity', t);
    }
    if (b.thresholds) {
      const t = {};
      for (const k of ['cpu', 'ram', 'disk']) {
        const v = Number(b.thresholds[k]);
        if (!Number.isFinite(v) || v < 1 || v > 100) throw bad('Ngưỡng phải từ 1 đến 100');
        t[k] = v;
      }
      if (b.thresholds.temp !== undefined) {
        const v = Number(b.thresholds.temp);
        if (!Number.isFinite(v) || v < 1 || v > 150) throw bad('Ngưỡng nhiệt độ phải từ 1 đến 150°C');
        t.temp = v;
      }
      if (b.thresholds.dos_packet_rate !== undefined) {
        const v = Number(b.thresholds.dos_packet_rate);
        if (!Number.isFinite(v) || v < 10) throw bad('Ngưỡng tốc độ gói tin không hợp lệ');
        t.dos_packet_rate = v;
      }
      setSetting(db, 'thresholds', t);
    }
    if (b.org_name !== undefined) setSetting(db, 'org_name', String(b.org_name).trim().slice(0, 60) || 'Monitoring');
    if (b.default_theme !== undefined) {
      if (!THEMES.includes(b.default_theme)) throw bad('Theme không hợp lệ');
      setSetting(db, 'default_theme', b.default_theme);
    }
    if (b.default_lang !== undefined) {
      if (!LANGS.includes(b.default_lang)) throw bad('Ngôn ngữ không hợp lệ');
      setSetting(db, 'default_lang', b.default_lang);
    }
    if (b.enroll_key !== undefined) {
      const k = String(b.enroll_key);
      if (k && k.length < 16) throw bad('Enroll key phải có ít nhất 16 ký tự (hoặc để trống để tắt)');
      setSetting(db, 'enroll_key', k.slice(0, 128));
    }
    if (b.ai && typeof b.ai === 'object') {
      const curAi = getSettings(db).ai || {};
      const provider = PROVIDER_PRESETS[b.ai.provider] ? b.ai.provider : (curAi.provider || 'openai');
      const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
      const dailyTime = /^\d{2}:\d{2}$/.test(String(b.ai.daily_digest_time || '')) ? String(b.ai.daily_digest_time) : (curAi.daily_digest_time || '23:55');
      const nextAi = {
        enabled: b.ai.enabled !== undefined ? !!b.ai.enabled : !!curAi.enabled,
        provider,
        api_url: (b.ai.api_url && String(b.ai.api_url).trim().slice(0, 300)) || (provider === curAi.provider && curAi.api_url ? curAi.api_url : preset.api_url),
        api_key: b.ai.api_key !== undefined ? String(b.ai.api_key).trim().slice(0, 300) : (curAi.api_key || ''),
        model: (b.ai.model && String(b.ai.model).trim().slice(0, 100)) || (provider === curAi.provider && curAi.model ? curAi.model : preset.model),
        auto_incident: b.ai.auto_incident !== undefined ? !!b.ai.auto_incident : (curAi.auto_incident !== false),
        daily_digest_enabled: b.ai.daily_digest_enabled !== undefined ? !!b.ai.daily_digest_enabled : !!curAi.daily_digest_enabled,
        daily_digest_time: dailyTime,
        cooldown_minutes: Math.min(1440, Math.max(1, Number(b.ai.cooldown_minutes ?? curAi.cooldown_minutes ?? 60))),
        daily_call_limit: Math.min(5000, Math.max(1, Number(b.ai.daily_call_limit ?? curAi.daily_call_limit ?? 50))),
        max_tokens: Math.min(2000, Math.max(100, Number(b.ai.max_tokens ?? curAi.max_tokens ?? 350))),
      };
      setSetting(db, 'ai', nextAi);
    }
    if (b.telegram && typeof b.telegram === 'object') {
      saveTelegramConfig(b.telegram);
    }
    monitor.reload();
    monitor.emit('change');
    send(ctx.res, 200, { ok: true });
  });

  // ---------- users ----------
  route('GET', '/api/users', 'admin', (ctx) =>
    send(ctx.res, 200, { users: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username').all() }));
  route('POST', '/api/users', 'admin', async (ctx) => {
    const b = await readBody(ctx.req, 4096);
    const username = String(b.username || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw bad('Tên đăng nhập 3-40 ký tự (chữ, số, . _ -)');
    if (!ROLES.includes(b.role)) throw bad('Vai trò không hợp lệ');
    const err = auth.validatePassword(b.password);
    if (err) throw bad(err);
    try {
      const r = db.prepare('INSERT INTO users(username,pass_hash,role,must_change,created_at) VALUES(?,?,?,1,?)')
        .run(username, auth.hashPassword(b.password), b.role, Date.now());
      send(ctx.res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Tên đăng nhập đã tồn tại');
      throw e;
    }
  });
  const adminCount = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c;
  route('PUT', '/api/users/:id', 'admin', async (ctx) => {
    const id = idOf(ctx.p.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new HttpError(404, 'Không tìm thấy người dùng');
    const b = await readBody(ctx.req, 4096);
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw bad('Vai trò không hợp lệ');
      if (u.role === 'admin' && b.role !== 'admin' && adminCount() <= 1) throw bad('Phải còn ít nhất một admin');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
    }
    if (b.password) {
      const err = auth.validatePassword(b.password);
      if (err) throw bad(err);
      db.prepare('UPDATE users SET pass_hash = ?, must_change = 1 WHERE id = ?').run(auth.hashPassword(b.password), id);
      auth.destroyUserSessions(db, id, id === ctx.user.id ? ctx.token : null);
    }
    send(ctx.res, 200, { ok: true });
  });
  route('DELETE', '/api/users/:id', 'admin', (ctx) => {
    const id = idOf(ctx.p.id);
    if (id === ctx.user.id) throw bad('Không thể tự xóa tài khoản đang đăng nhập');
    const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
    if (u && u.role === 'admin' && adminCount() <= 1) throw bad('Phải còn ít nhất một admin');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    send(ctx.res, 200, { ok: true });
  });

  // ---------- agent ----------
  route('GET', '/api/health', null, (ctx) => send(ctx.res, 200, { ok: true, version: versionInfo.version, build: versionInfo.build, code: versionInfo.code, features: versionInfo.features }));
  route('POST', '/api/agent/report', null, async (ctx) => {
    const m = /^Bearer\s+(\S+)$/.exec(ctx.req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Thiếu token');
    const b = await readBody(ctx.req);
    let dev = db.prepare('SELECT id FROM devices WHERE agent_token = ?').get(m[1]);
    let enrolled;
    if (!dev) {
      const key = getSettings(db).enroll_key;
      if (!key || !tokenEq(m[1], key)) throw new HttpError(401, 'Token không hợp lệ');
      const name = String(b.hostname || '').trim().slice(0, 100);
      if (!name) throw bad('Thiếu hostname để đăng ký tự động');
      if (db.prepare('SELECT 1 FROM devices WHERE name = ?').get(name)) {
        throw new HttpError(409, 'Thiết bị đã tồn tại, hãy dùng agent token riêng của thiết bị');
      }
      const ip = String(b.ip || '');
      const created = insertDevice(cleanDevice({
        name, type: /^vm$/i.test(String(b.kind)) ? 'vm' : 'server', check_agent: true,
        check_icmp: ADDR_RE.test(ip), address: ADDR_RE.test(ip) ? ip : '',
      }));
      dev = { id: created.id };
      enrolled = created.token;
      monitor.reload();
      monitor.emit('change');
    }
    monitor.ingestAgent(dev.id, b);
    monitor.emit('change');
    send(ctx.res, 200, { ok: true, interval: 5, ...(enrolled ? { device_id: dev.id, token: enrolled } : {}) });
  });

  // ---------- static ----------
  const serveStatic = (req, res, pathname) => {
    const agentFiles = {
      '/agent/install.sh': 'linux/install.sh',
      '/agent/linux/agent.sh': 'linux/agent.sh',
      '/agent/install.ps1': 'windows/install.ps1',
      '/agent/windows/agent.ps1': 'windows/agent.ps1',
      '/agent/install-macos.sh': 'macos/install.sh',
      '/agent/macos/agent.sh': 'macos/agent.sh',
    };
    if (agentFiles[pathname]) {
      const file = path.join(agentDir, agentFiles[pathname]);
      fs.readFile(file, 'utf8', (err, source) => {
        if (err) return send(res, 404, { error: 'Không tìm thấy file cài agent' });
        const host = req.headers.host || 'localhost:8080';
        const body = source.replaceAll('__SERVER_URL__', `http://${host}`);
        res.writeHead(200, {
          'Content-Type': pathname.endsWith('.ps1') ? 'text/plain; charset=utf-8' : 'text/x-shellscript; charset=utf-8',
          'Cache-Control': 'no-store', ...SEC_HEADERS,
        });
        res.end(body);
      });
      return;
    }
    let rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache', ...SEC_HEADERS,
      });
      res.end(buf);
    });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return serveStatic(req, res, decodeURIComponent(url.pathname));
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(res, 404, { error: 'Not found' });
      const match = r.re.exec(url.pathname);
      const ctx = { req, res, query: url.searchParams, p: {}, user: null, token: null };
      r.keys.forEach((k, i) => { ctx.p[k] = decodeURIComponent(match[i + 1]); });

      if (r.method !== 'GET' && r.role !== null && req.headers['x-requested-with'] !== 'monitor') {
        throw new HttpError(403, 'Thiếu header CSRF');
      }
      if (r.role !== null) {
        ctx.token = auth.parseCookies(req.headers.cookie).sid;
        ctx.user = auth.getSessionUser(db, ctx.token);
        if (!ctx.user) throw new HttpError(401, 'Chưa đăng nhập');
        const allowedWhileMustChange = ['/api/auth/me', '/api/auth/password', '/api/auth/logout'];
        if (ctx.user.must_change && !allowedWhileMustChange.includes(url.pathname)) {
          throw new HttpError(403, 'Cần đổi mật khẩu trước khi tiếp tục');
        }
        if (r.role !== 'any' && RANK[ctx.user.role] < RANK[r.role]) throw new HttpError(403, 'Không đủ quyền');
      }
      await r.handler(ctx);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('[error]', e);
      send(res, 500, { error: 'Lỗi máy chủ' });
    }
  });

  server.on('close', () => { clearInterval(sseTimer); for (const c of sseClients) c.res.end(); });
  server.pushAll = pushAll;
  return server;
}

module.exports = { createApp };
