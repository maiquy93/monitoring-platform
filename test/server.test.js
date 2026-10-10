'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');
const snmp = require('../server/snmp');

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
