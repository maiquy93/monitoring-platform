'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');

async function boot(monitorOpts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const monitor = new Monitor(db, {
    pingFn: async () => ({ ok: true, rtt: 1.5 }),
    ...monitorOpts,
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
  return { db, monitor, api, createClient, close, base };
}

async function loginAdmin(t) {
  const r = await t.api('POST', '/api/auth/login', { username: 'admin', password: 'initial-pass-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.must_change, true);
  const c = await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'new-password-1' });
  assert.equal(c.status, 200);
}

test('topology port DB schema & migration: port_count exists in devices table', () => {
  const db = open(':memory:');
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  assert.ok(cols.includes('port_count'), 'devices table should have port_count column');
});

test('monitor.view: computes default and explicit port_count correctly', () => {
  const db = open(':memory:');
  const monitor = new Monitor(db, { pingFn: async () => ({ ok: true, rtt: 1 }) });

  // 1. Switch with default (port_count = 0 in DB) -> 24 ports
  db.prepare(`
    INSERT INTO devices(id, name, type, address, port_count, agent_token, created_at)
    VALUES(1, 'Core Switch', 'switch', '192.168.1.2', 0, 'tok-1', ?)
  `).run(Date.now());

  // 2. Router with default (port_count = 0 in DB) -> 8 ports
  db.prepare(`
    INSERT INTO devices(id, name, type, address, port_count, agent_token, created_at)
    VALUES(2, 'Edge Router', 'router', '192.168.1.1', 0, 'tok-2', ?)
  `).run(Date.now());

  // 3. Switch with customized 48 ports
  db.prepare(`
    INSERT INTO devices(id, name, type, address, port_count, agent_token, created_at)
    VALUES(3, 'Access Switch 48', 'switch', '192.168.1.3', 48, 'tok-3', ?)
  `).run(Date.now());

  // 4. Server with port_count = 0 -> 0 ports (hidden port panel)
  db.prepare(`
    INSERT INTO devices(id, name, type, address, port_count, agent_token, created_at)
    VALUES(4, 'Web Server', 'server', '192.168.1.10', 0, 'tok-4', ?)
  `).run(Date.now());

  monitor.reload();

  const d1 = monitor.devices.get(1);
  const v1 = monitor.view(d1);
  assert.equal(v1.port_count, 24, 'Switch default should be 24 ports');

  const d2 = monitor.devices.get(2);
  const v2 = monitor.view(d2);
  assert.equal(v2.port_count, 8, 'Router default should be 8 ports');

  const d3 = monitor.devices.get(3);
  const v3 = monitor.view(d3);
  assert.equal(v3.port_count, 48, 'Configured 48-port switch should return 48 ports');

  const d4 = monitor.devices.get(4);
  const v4 = monitor.view(d4);
  assert.equal(v4.port_count, 0, 'Server should have 0 ports (hidden port matrix)');
});

test('API & cleanMap: preserves from_port and to_port in topology map links', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);

    // Create 2 devices
    const rDev1 = await t.api('POST', '/api/devices', {
      name: 'SW-Core-01',
      type: 'switch',
      address: '10.0.0.1',
      port_count: 24,
    });
    assert.equal(rDev1.status, 201);
    const swId = rDev1.body.id;

    const rDev2 = await t.api('POST', '/api/devices', {
      name: 'R-Gateway-01',
      type: 'router',
      address: '10.0.0.254',
      port_count: 8,
    });
    assert.equal(rDev2.status, 201);
    const rId = rDev2.body.id;

    // Verify GET /api/devices/:id returns port_count
    const rDevGet = await t.api('GET', `/api/devices/${swId}`);
    assert.equal(rDevGet.status, 200);
    assert.equal(rDevGet.body.port_count, 24);

    // Create Topology Map with Port-to-Port Link
    const mapPayload = {
      name: 'Core Backbone Map',
      nodes: [
        { id: 'node-sw', kind: 'device', ref: swId, label: 'Core Switch', x: 200, y: 300 },
        { id: 'node-rt', kind: 'device', ref: rId, label: 'Gateway Router', x: 500, y: 300 },
      ],
      links: [
        { from: 'node-sw', to: 'node-rt', from_port: '24', to_port: '1' },
      ],
    };

    const rMapCreate = await t.api('POST', '/api/maps', mapPayload);
    assert.equal(rMapCreate.status, 201);
    const mapId = rMapCreate.body.id;

    // Read back the map and verify from_port & to_port are intact
    const rMapGet = await t.api('GET', `/api/maps/${mapId}`);
    assert.equal(rMapGet.status, 200);
    assert.equal(rMapGet.body.name, 'Core Backbone Map');
    assert.equal(rMapGet.body.links.length, 1);
    assert.equal(rMapGet.body.links[0].from, 'node-sw');
    assert.equal(rMapGet.body.links[0].to, 'node-rt');
    assert.equal(rMapGet.body.links[0].from_port, '24');
    assert.equal(rMapGet.body.links[0].to_port, '1');

    // Update map with another link (one end port, one end generic/null)
    const updatePayload = {
      name: 'Core Backbone Map v2',
      nodes: rMapGet.body.nodes,
      links: [
        { from: 'node-sw', to: 'node-rt', from_port: '1', to_port: null },
      ],
    };
    const rMapPut = await t.api('PUT', `/api/maps/${mapId}`, updatePayload);
    assert.equal(rMapPut.status, 200);

    const rMapGet2 = await t.api('GET', `/api/maps/${mapId}`);
    assert.equal(rMapGet2.body.links[0].from_port, '1');
    assert.equal(rMapGet2.body.links[0].to_port, null);

  } finally {
    t.close();
  }
});

test('frontend static assets: map.js and style.css contain clean wire routing and port badge styles', () => {
  const mapJs = fs.readFileSync(path.join(__dirname, '../public/map.js'), 'utf8');
  assert.ok(mapJs.includes('getEdgeEndpoints'), 'map.js must define getEdgeEndpoints for straight wire routing');
  assert.ok(mapJs.includes('getBadgeCoords'), 'map.js must define getBadgeCoords for port badges');
  assert.ok(mapJs.includes('openLinkConfigModal'), 'map.js must support wire port config modal');
  assert.ok(mapJs.includes('m-port-badge'), 'map.js must render port badges on cable ends');
  assert.ok(mapJs.includes('m-port-active-summary'), 'map.js must summarize active ports on card');
  assert.ok(mapJs.includes('m-port-inspect-btn'), 'map.js must include port inspector trigger');

  const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.ok(styleCss.includes('.m-port-badge'), 'style.css must style .m-port-badge');
  assert.ok(styleCss.includes('.m-port-badge-bg'), 'style.css must style badge background');
  assert.ok(styleCss.includes('.m-port-active-summary'), 'style.css must style active summary');
  assert.ok(styleCss.includes('.m-port-inspect-btn'), 'style.css must style port inspect button');

  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
  assert.ok(adminJs.includes('port_count'), 'admin.js must support port_count in device modal');
});
