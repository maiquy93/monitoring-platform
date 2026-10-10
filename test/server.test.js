'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');
const snmp = require('../server/snmp');
const walkfile = require('../server/snmp-walkfile');
const { startReplay, loadFixture } = require('./helpers/snmp-replay');

async function boot(monitorOpts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const alive = new Set();
  const monitor = new Monitor(db, {
    pingFn: async (addr) => (alive.has(addr) ? { ok: true, rtt: 1.5 } : { ok: false }),
    agentTimeoutMs: 20000, ...monitorOpts,
  });
  const server = createApp(db, monitor);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const createClient = () => {
    let cookie = '';
    return async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'monitor', cookie, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  const api = createClient();
  const close = () => { monitor.stop(); server.close(); server.closeAllConnections?.(); };
  return { db, monitor, api, createClient, alive, close, base };
}

async function loginAdmin(t) {
  const r = await t.api('POST', '/api/auth/login', { username: 'admin', password: 'initial-pass-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.must_change, true);
  const c = await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'new-password-1' });
  assert.equal(c.status, 200);
}

async function loginUser(api, username, password, newPassword) {
  const login = await api('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.must_change, true);
  const changed = await api('POST', '/api/auth/password', { current: password, password: newPassword });
  assert.equal(changed.status, 200);
}

test('auth: login required, must change password, rate limit', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('GET', '/api/devices')).status, 401);
    assert.equal((await t.api('POST', '/api/auth/login', { username: 'admin', password: 'bad' })).status, 401);
    await t.api('POST', '/api/auth/login', { username: 'admin', password: 'initial-pass-1' });
    assert.equal((await t.api('GET', '/api/devices')).status, 403); // must change first
    assert.equal((await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'short' })).status, 400);
    await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'new-password-1' });
    assert.equal((await t.api('GET', '/api/devices')).status, 200);
    // CSRF header is mandatory for mutations
    assert.equal((await t.api('POST', '/api/devices', { name: 'x', type: 'server' }, { 'x-requested-with': '' })).status, 403);
    for (let i = 0; i < 8; i++) await t.api('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
    assert.equal((await t.api('POST', '/api/auth/login', { username: 'admin', password: 'new-password-1' })).status, 429);
  } finally { t.close(); }
});

test('icmp: device goes down after 2 failed probes and recovers', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const created = await t.api('POST', '/api/devices', { name: 'router-1', type: 'router', address: '10.0.0.1', check_icmp: true });
    assert.equal(created.status, 201);
    t.alive.add('10.0.0.1');
    const st = () => t.monitor.snapshot().devices[0];
    const step = async () => { t.monitor.tick(Date.now() + 1e9); await new Promise((r) => setTimeout(r, 20)); };
    // drive ticks with a monotonic fake clock so the interval gate opens each time
    let now = Date.now();
    const run = async () => { now += 5000; t.monitor.tick(now); await new Promise((r) => setTimeout(r, 20)); };
    await run();
    assert.equal(st().status, 'up');
    t.alive.delete('10.0.0.1');
    await run();
    assert.equal(st().status, 'up'); // one failure is tolerated
    await run();
    assert.equal(st().status, 'down');
    assert.equal(st().severity, 'critical');
    assert.equal(t.monitor.snapshot().summary.level, 'critical');
    t.alive.add('10.0.0.1');
    await run();
    assert.equal(st().status, 'up');
    const kinds = (await t.api('GET', '/api/events')).body.events.map((e) => e.kind);
    assert.ok(kinds.includes('down') && kinds.includes('up'));
    void step;
  } finally { t.close(); }
});

test('agent: report keeps device up, 20s silence marks it down; printers use lower severity', async () => {
  const t = await boot({ agentTimeoutMs: 20000 });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', { name: 'srv-linux', type: 'server', check_icmp: false, check_agent: true });
    const dev = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    const rep = await t.api('POST', '/api/agent/report', {
      hostname: 'srv-linux', cpu: { percent: 12, cores: 4 }, memory: { total: 8e9, used: 2e9, percent: 25 },
      disks: [{ mount: '/', total: 1e11, used: 4e10, percent: 40 }], uptime: 1234,
    }, { authorization: `Bearer ${dev.agent_token}`, cookie: '' });
    assert.equal(rep.status, 200);
    t.monitor.startedAt -= 60000; // skip startup grace
    t.monitor.evaluate();
    let d = t.monitor.snapshot().devices[0];
    assert.equal(d.status, 'up');
    assert.equal(d.cpu, 12);
    t.monitor.evaluate(Date.now() + 21000);
    d = t.monitor.snapshot().devices[0];
    assert.equal(d.status, 'down');
    assert.equal((await t.api('POST', '/api/agent/report', {}, { authorization: 'Bearer nope', cookie: '' })).status, 401);

    const p = await t.api('POST', '/api/devices', { name: 'printer-1', type: 'printer', address: '10.0.0.9', check_icmp: true });
    assert.ok(p.body.id);
    assert.equal(t.monitor.snapshot().devices.find((x) => x.name === 'printer-1').severity, 'low');
  } finally { t.close(); }
});

test('agent: silence warns when ICMP remains available and recovers on report', async () => {
  const t = await boot({ agentTimeoutMs: 20000 });
  try {
    await loginAdmin(t);
    t.alive.add('10.0.0.8');
    const c = await t.api('POST', '/api/devices', {
      name: 'srv-combined-check', type: 'server', address: '10.0.0.8', check_icmp: true, check_agent: true,
    });
    t.monitor.tick();
    await new Promise((r) => setTimeout(r, 20));
    const dev = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    const report = {
      hostname: 'srv-combined-check', cpu: { percent: 12, cores: 4 },
      memory: { total: 8e9, used: 2e9, percent: 25 },
      disks: [{ mount: '/', total: 1e11, used: 4e10, percent: 40 }], uptime: 1234,
    };
    assert.equal((await t.api('POST', '/api/agent/report', report, {
      authorization: `Bearer ${dev.agent_token}`, cookie: '',
    })).status, 200);
    t.monitor.startedAt -= 60000; // skip startup grace
    t.monitor.evaluate();
    assert.equal(t.monitor.snapshot().devices[0].status, 'up');

    t.monitor.evaluate(Date.now() + 21000);
    let d = t.monitor.snapshot().devices[0];
    assert.equal(d.status, 'warning');
    assert.match(d.reasons[0], /Agent không gửi dữ liệu/);
    const warning = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events.find((e) => e.kind === 'warning');
    assert.ok(warning);

    assert.equal((await t.api('POST', '/api/agent/report', report, {
      authorization: `Bearer ${dev.agent_token}`, cookie: '',
    })).status, 200);
    t.monitor.evaluate();
    d = t.monitor.snapshot().devices[0];
    assert.equal(d.status, 'up');
    const recovered = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events.find((e) => e.kind === 'up');
    assert.ok(recovered);
  } finally { t.close(); }
});

test('agent auto-enroll with enroll key; invalid address rejected', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    assert.equal((await t.api('PUT', '/api/settings', { enroll_key: 'short' })).status, 400);
    assert.equal((await t.api('PUT', '/api/settings', { enroll_key: 'enroll-key-1234567890' })).status, 200);
    const r = await t.api('POST', '/api/agent/report', { hostname: 'auto-host', cpu: { percent: 1 } },
      { authorization: 'Bearer enroll-key-1234567890', cookie: '' });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    assert.equal(t.monitor.snapshot().devices.length, 1);
    assert.equal(t.monitor.snapshot().devices[0].type, 'server');
    assert.equal((await t.api('POST', '/api/devices', { name: 'bad', type: 'server', address: '1.1.1.1; rm -rf /' })).status, 400);
  } finally { t.close(); }
});

test('public agent installers are served with the server URL', async () => {
  const t = await boot();
  try {
    for (const file of ['/agent/install.sh', '/agent/install.ps1', '/agent/install-macos.sh']) {
      const r = await fetch(t.base + file);
      const body = await r.text();
      assert.equal(r.status, 200, file);
      assert.ok(body.includes(t.base), file);
      assert.ok(!body.includes('__SERVER_URL__'), file);
    }
    for (const file of ['/agent/linux/agent.sh', '/agent/windows/agent.ps1', '/agent/macos/agent.sh']) {
      const r = await fetch(t.base + file);
      assert.equal(r.status, 200, file);
    }
  } finally { t.close(); }
});

test('groups and maps can be managed by an admin', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const d = await t.api('POST', '/api/devices', { name: 'sw1', type: 'switch', address: '10.0.0.2' });
    const g = await t.api('POST', '/api/groups', { name: 'Tầng 1', device_ids: [d.body.id] });
    const groups = (await t.api('GET', '/api/groups')).body.groups;
    assert.equal(groups[0].device_ids[0], d.body.id);
    const m = await t.api('POST', '/api/maps', {
      name: 'Core', nodes: [{ id: 'a', kind: 'device', ref: d.body.id, x: 10, y: 20 }, { id: 'b', kind: 'label', label: 'WAN', x: 1, y: 1 }],
      links: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zzz' }],
    });
    const map = (await t.api('GET', `/api/maps/${m.body.id}`)).body;
    assert.equal(map.links.length, 1);
    assert.ok(g.body.id);
  } finally { t.close(); }
});

test('roles: viewer is read-only, operator can acknowledge and edit maps, admin manages all', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const device = await t.api('POST', '/api/devices', { name: 'role-device', type: 'server', address: '10.0.0.3' });
    const map = await t.api('POST', '/api/maps', { name: 'Role map', nodes: [], links: [] });
    assert.equal((await t.api('POST', '/api/users', {
      username: 'viewer1', password: 'viewer-pass-1', role: 'viewer',
    })).status, 201);
    assert.equal((await t.api('POST', '/api/users', {
      username: 'operator1', password: 'operator-pass-1', role: 'operator',
    })).status, 201);

    const viewer = t.createClient();
    await loginUser(viewer, 'viewer1', 'viewer-pass-1', 'viewer-pass-2');
    assert.equal((await viewer('PUT', `/api/devices/${device.body.id}`, { notes: 'blocked' })).status, 403);
    assert.equal((await viewer('PUT', '/api/settings', { org_name: 'blocked' })).status, 403);
    assert.equal((await viewer('PUT', `/api/maps/${map.body.id}`, { name: 'blocked', nodes: [], links: [] })).status, 403);
    assert.equal((await viewer('POST', '/api/users', {
      username: 'blocked1', password: 'blocked-pass-1', role: 'viewer',
    })).status, 403);

    const operator = t.createClient();
    await loginUser(operator, 'operator1', 'operator-pass-1', 'operator-pass-2');
    assert.equal((await operator('POST', `/api/devices/${device.body.id}/ack`, {})).status, 200);
    assert.equal((await operator('PUT', `/api/maps/${map.body.id}`, {
      name: 'Role map edited', nodes: [], links: [],
    })).status, 200);
    assert.equal((await operator('PUT', '/api/settings', { org_name: 'blocked' })).status, 403);
    assert.equal((await operator('POST', '/api/users', {
      username: 'blocked2', password: 'blocked-pass-1', role: 'viewer',
    })).status, 403);

    assert.equal((await t.api('PUT', `/api/devices/${device.body.id}`, { notes: 'admin edit' })).status, 200);
    assert.equal((await t.api('PUT', '/api/settings', { org_name: 'Role test' })).status, 200);
    assert.equal((await t.api('PUT', `/api/maps/${map.body.id}`, {
      name: 'Role map admin', nodes: [], links: [],
    })).status, 200);
    assert.equal((await t.api('POST', '/api/users', {
      username: 'adminmade1', password: 'adminmade-pass-1', role: 'viewer',
    })).status, 201);
  } finally { t.close(); }
});

test('snmp: encode request and decode response', () => {
  const pkt = snmp.buildGet('public', 42, [snmp.OIDS.sysUpTime]);
  assert.equal(pkt[0], 0x30);
  // hand-built GetResponse: sysUpTime.0 = TimeTicks 360000 (1h)
  const oid = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x03, 0x00]);
  const val = Buffer.from([0x43, 0x03, 0x05, 0x7e, 0x40]);
  const vb = Buffer.concat([Buffer.from([0x30, oid.length + val.length]), oid, val]);
  const vbl = Buffer.concat([Buffer.from([0x30, vb.length]), vb]);
  const body = Buffer.concat([Buffer.from([0x02, 0x01, 42, 0x02, 0x01, 0, 0x02, 0x01, 0]), vbl]);
  const pdu = Buffer.concat([Buffer.from([0xa2, body.length]), body]);
  const inner = Buffer.concat([Buffer.from([0x02, 0x01, 0x01, 0x04, 0x06]), Buffer.from('public'), pdu]);
  const msg = Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
  const out = snmp.decodeResponse(msg, 42);
  assert.equal(out[snmp.OIDS.sysUpTime], 360000);
  assert.throws(() => snmp.decodeResponse(msg.subarray(0, 10), 42));
});

test('snmp: cpu/ram/disk from SNMP are shown on the device view and stored', async () => {
  const t = await boot({ snmpFn: async () => ({ sysDescr: 'RouterOS', sysName: 'rt', uptime: 100, cpu: 12, ram: 25, disk: 40 }) });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', { name: 'mikrotik', type: 'router', address: '10.0.0.5', check_icmp: false, snmp_enabled: true });
    assert.equal(c.status, 201);
    t.monitor.tick();
    await new Promise((r) => setTimeout(r, 30));
    const v = t.monitor.snapshot().devices[0];
    assert.equal(v.status, 'up');
    assert.equal(v.cpu, 12); assert.equal(v.ram, 25); assert.equal(v.disk, 40);
    t.monitor.tick(Date.now() + 60000);
    const row = t.db.prepare('SELECT cpu,ram,disk FROM metrics WHERE device_id=?').get(c.body.id);
    assert.deepEqual({ ...row }, { cpu: 12, ram: 25, disk: 40 });
  } finally { t.close(); }
});

test('version: health and settings expose build info', async () => {
  const t = await boot();
  try {
    const h = await t.api('GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.match(h.body.version, /^\d+\.\d+\.\d+$/);
    assert.match(h.body.code, /^[0-9a-f]{8}$/);
    assert.ok(h.body.features.includes('snmp-host-resources'));
    await loginAdmin(t);
    const s = (await t.api('GET', '/api/settings')).body;
    assert.equal(s.version.code, h.body.code);
    assert.ok('disk_low' in s.system);
  } finally { t.close(); }
});

test('housekeeping: purge caps events, disk guard trims history when disk is low', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'));
  const db = open(path.join(dir, 'm.db'));
  const m = new Monitor(db, { dbFile: path.join(dir, 'm.db'), maxEvents: 5, minFreeBytes: Number.MAX_SAFE_INTEGER });
  try {
    const now = Date.now();
    for (let i = 0; i < 20; i++) m.db.prepare('INSERT INTO events(ts,device_id,device_name,kind,severity,message) VALUES(?,?,?,?,?,?)').run(now, null, 'd', 'down', 'low', 'x');
    m.db.prepare("INSERT INTO devices(id,name,agent_token,created_at) VALUES(1,'d','tok',?)").run(now);
    m.db.prepare('INSERT INTO metrics(device_id,ts,cpu,ram,disk,rtt) VALUES(1,?,1,1,1,1)').run(now - 3 * 86400e3);
    m.purge();
    assert.equal(m.db.prepare('SELECT COUNT(*) c FROM events').get().c, 5);
    assert.equal(m.db.prepare('SELECT COUNT(*) c FROM metrics').get().c, 1); // still inside 7-day retention
    assert.equal(m.guardDisk(), true); // "free space" is always below the huge threshold
    assert.equal(m.db.prepare('SELECT COUNT(*) c FROM metrics').get().c, 0); // older than 1 day removed
    const info = m.systemInfo();
    assert.equal(info.disk_low, true);
    assert.ok(info.db_bytes > 0 && info.disk_free_bytes > 0);
  } finally { m.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('snmp: device profile end-to-end through the monitor and API (real RouterOS walk)', async () => {
  const replay = await startReplay('mikrotik-routeros-x86');
  const t = await boot();
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'router', type: 'router', address: replay.host, check_icmp: false, snmp_enabled: true, snmp_port: replay.port,
    });
    assert.equal(c.status, 201);
    const poll = async () => {
      t.monitor.tick(Date.now() + 120000);
      for (let i = 0; i < 60 && !t.monitor.state.get(c.body.id).snmp.info; i++) await new Promise((r) => setTimeout(r, 50));
    };
    await poll();
    const detail = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(detail.snmp.profile.id, 'mikrotik');
    assert.equal(detail.snmp.profile.auto, true);
    assert.equal(detail.cpu, 1); assert.equal(detail.ram, 15.4); assert.equal(detail.disk, 0.3);
    assert.equal(detail.snmp_community, 'public');

    const profiles = (await t.api('GET', '/api/snmp/profiles')).body.profiles;
    assert.ok(profiles.some((p) => p.id === 'mikrotik') && profiles.some((p) => p.id === 'generic' && p.fallback));
    assert.equal((await t.api('PUT', `/api/devices/${c.body.id}`, { snmp_profile: 'nope' })).status, 400);

    // manual override is stored and forces an immediate re-poll with the chosen profile
    assert.equal((await t.api('PUT', `/api/devices/${c.body.id}`, { snmp_profile: 'generic' })).status, 200);
    t.monitor.state.get(c.body.id).snmp.info = null;
    await poll();
    const after = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(after.snmp_profile, 'generic');
    assert.equal(after.snmp.profile.id, 'generic');
    assert.equal(after.snmp.profile.auto, false);
    assert.equal(after.disk, 0.3);

    // without a session the export is refused
    const res = await fetch(`${t.base}/api/devices/${c.body.id}/snmp-walk`, { method: 'POST', headers: { 'x-requested-with': 'monitor' } });
    assert.equal(res.status, 401);
  } finally { t.close(); replay.close(); }
});

test('snmp: "Xuất dữ liệu SNMP" returns a .walk file for admins only', async () => {
  const replay = await startReplay('mikrotik-routeros-x86');
  const t = await boot();
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', { name: 'r2', type: 'router', address: replay.host, check_icmp: false, snmp_enabled: true, snmp_port: replay.port });
    const cookie = await (async () => {
      const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'monitor' }, body: JSON.stringify({ username: 'admin', password: 'new-password-1' }) });
      return r.headers.get('set-cookie').split(';')[0];
    })();
    const res = await fetch(`${t.base}/api/devices/${c.body.id}/snmp-walk`, { method: 'POST', headers: { 'x-requested-with': 'monitor', cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /\.walk"/);
    const text = await res.text();
    assert.match(text, /sysObjectID: 1\.3\.6\.1\.4\.1\.14988\.1/);
    assert.ok(!/public/.test(text.replace(/\n1\.3\.[^\n]*/g, '')), 'community must not appear in header');
    assert.equal(walkfile.parse(text).rows.length, loadFixture('mikrotik-routeros-x86').rows.length);
  } finally { t.close(); replay.close(); }
});

