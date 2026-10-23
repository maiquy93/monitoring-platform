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
  assert.equal(v1.port_count, 48, 'Switch default should be 48 ports');

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

test('frontend static assets: map.js and style.css support snap-to-device cable port badges', () => {
  const mapJs = fs.readFileSync(path.join(__dirname, '../public/map.js'), 'utf8');
  assert.ok(mapJs.includes('getLinkEndpoints'), 'map.js must define getLinkEndpoints for top-to-bottom wire routing');
  assert.ok(mapJs.includes('getBadgeCoords'), 'map.js must define getBadgeCoords for snap-to-device port badges');
  assert.ok(mapJs.includes('openLinkConfigModal'), 'map.js must support wire port config modal');
  assert.ok(mapJs.includes('m-port-inspect-btn'), 'map.js must include port inspector trigger');
  assert.ok(mapJs.includes('m-port-badge'), 'map.js must render floating cable badges on links');
  assert.ok(!mapJs.includes('m-port-active-summary'), 'map.js must NOT clutter node card with inline text labels');

  const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.ok(styleCss.includes('.m-port-inspect-btn'), 'style.css must style port inspect button');
  assert.ok(styleCss.includes('.m-port-badge'), 'style.css must style .m-port-badge');
  assert.ok(styleCss.includes('.m-port-badge-bg'), 'style.css must style .m-port-badge-bg');
  assert.ok(!styleCss.includes('.m-port-active-summary'), 'style.css must NOT have leftover .m-port-active-summary styles');

  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
  assert.ok(adminJs.includes('port_count'), 'admin.js must support port_count in device modal');
});

test('topology port badge math: getBadgeCoords snaps snugly to originating device endpoint without drifting', () => {
  // Test simulated getBadgeCoords
  function getBadgeCoords(ptFrom, ptTo, offsetDist) {
    const dx = ptTo.x - ptFrom.x;
    const dy = ptTo.y - ptFrom.y;
    const dist = Math.hypot(dx, dy) || 1;
    const offset = Math.min(offsetDist || 18, dist * 0.35);
    return {
      x: ptFrom.x + (dx / dist) * offset,
      y: ptFrom.y + (dy / dist) * offset,
    };
  }

  const ptA = { x: 300, y: 130 }; // Device A bottom anchor
  const ptB = { x: 300, y: 370 }; // Device B top anchor (distance = 240px)

  // When only Device A has port (from_port = 24): badge stays right at ptA
  const badgeA = getBadgeCoords(ptA, ptB, 18);
  assert.equal(badgeA.x, 300);
  assert.equal(badgeA.y, 148, 'Badge A must be 18px below ptA, directly attached to Device A');
  assert.ok(badgeA.y < 200, 'Badge A must stay firmly near Device A, far from Device B');

  // When only Device B has port (to_port = 1): badge stays right at ptB
  const badgeB = getBadgeCoords(ptB, ptA, 18);
  assert.equal(badgeB.x, 300);
  assert.equal(badgeB.y, 352, 'Badge B must be 18px above ptB, directly attached to Device B');
  assert.ok(badgeB.y > 300, 'Badge B must stay firmly near Device B, far from Device A');

  // On very short cables (e.g. 20px), badges scale proportionally and never invert or cross over
  const ptShortA = { x: 100, y: 100 };
  const ptShortB = { x: 100, y: 120 };
  const shortBadgeA = getBadgeCoords(ptShortA, ptShortB, 18);
  const shortBadgeB = getBadgeCoords(ptShortB, ptShortA, 18);
  assert.ok(shortBadgeA.y < shortBadgeB.y, 'Badges must never cross over on short cables');
});

test('API & cleanMap: supports LACP Port-Channel bundle, members array, bundle_name, and mlag_peer link_type', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);

    const rSw1 = await t.api('POST', '/api/devices', { name: 'SW-Core-A', type: 'switch', address: '10.0.1.1', port_count: 48 });
    const rSw2 = await t.api('POST', '/api/devices', { name: 'SW-Core-B', type: 'switch', address: '10.0.1.2', port_count: 48 });
    const rDist = await t.api('POST', '/api/devices', { name: 'SW-Dist-01', type: 'switch', address: '10.0.1.3', port_count: 48 });

    const mapPayload = {
      name: 'Enterprise LACP & MLAG Topology',
      nodes: [
        { id: 'n-core-a', kind: 'device', ref: rSw1.body.id, x: 300, y: 160 },
        { id: 'n-core-b', kind: 'device', ref: rSw2.body.id, x: 700, y: 160 },
        { id: 'n-dist-1', kind: 'device', ref: rDist.body.id, x: 500, y: 420 },
      ],
      links: [
        // 1. MLAG Peer link between 2 Core Switches
        {
          from: 'n-core-a',
          to: 'n-core-b',
          is_bundle: true,
          bundle_name: 'Po-Peer1',
          link_type: 'mlag_peer',
          members: [
            { src: 'port47', dst: 'port47' },
            { src: 'port48', dst: 'port48' },
          ],
        },
        // 2. LACP Trunk link from Core A to Distribution Switch
        {
          from: 'n-core-a',
          to: 'n-dist-1',
          is_bundle: true,
          bundle_name: 'Po1',
          link_type: 'lacp',
          members: [
            { src: 'port23', dst: 'port47' },
            { src: 'port24', dst: 'port48' },
          ],
        },
        // 3. Single standard link from Core B to Distribution Switch
        {
          from: 'n-core-b',
          to: 'n-dist-1',
          from_port: '1',
          to_port: '2',
          is_bundle: false,
          link_type: 'single',
        },
      ],
    };

    const rCreate = await t.api('POST', '/api/maps', mapPayload);
    assert.equal(rCreate.status, 201);

    const rGet = await t.api('GET', `/api/maps/${rCreate.body.id}`);
    assert.equal(rGet.status, 200);
    assert.equal(rGet.body.links.length, 3);

    // Check MLAG Peer link
    const lkMlag = rGet.body.links[0];
    assert.equal(lkMlag.link_type, 'mlag_peer');
    assert.equal(lkMlag.is_bundle, true);
    assert.equal(lkMlag.bundle_name, 'Po-Peer1');
    assert.deepEqual(lkMlag.members, [
      { src: 'port47', dst: 'port47' },
      { src: 'port48', dst: 'port48' },
    ]);

    // Check LACP Bundle link
    const lkLacp = rGet.body.links[1];
    assert.equal(lkLacp.link_type, 'lacp');
    assert.equal(lkLacp.is_bundle, true);
    assert.equal(lkLacp.bundle_name, 'Po1');
    assert.deepEqual(lkLacp.members, [
      { src: 'port23', dst: 'port47' },
      { src: 'port24', dst: 'port48' },
    ]);

    // Check Single link
    const lkSingle = rGet.body.links[2];
    assert.equal(lkSingle.link_type, 'single');
    assert.equal(lkSingle.is_bundle, false);
    assert.equal(lkSingle.bundle_name, '');
    assert.deepEqual(lkSingle.members, []);
    assert.equal(lkSingle.from_port, '1');
    assert.equal(lkSingle.to_port, '2');
  } finally {
    t.close();
  }
});

test('LACP & MLAG frontend rendering, SNMP member port health (UP / Degraded / DOWN), and visual effects', () => {
  const vm = require('node:vm');
  const mapJs = fs.readFileSync(path.join(__dirname, '../public/map.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

  // Verify Link Config Modal & LACP/MLAG elements in map.js
  assert.ok(mapJs.includes('inp-is-bundle'), 'map.js must have LACP bundle checkbox');
  assert.ok(mapJs.includes('Liên kết gộp LACP / Bonding'), 'map.js must include LACP checkbox label');
  assert.ok(mapJs.includes('inp-bundle-name'), 'map.js must have bundle_name input');
  assert.ok(mapJs.includes('VD: Po1, Bond1...'), 'map.js must include bundle_name placeholder');
  assert.ok(mapJs.includes('lacp_src_port') && mapJs.includes('lacp_dst_port'), 'map.js must allow multi-port selection at both ends');
  assert.ok(mapJs.includes('m-lacp-badge'), 'map.js must render center LACP bundle badge');
  assert.ok(mapJs.includes('m-link-mlag'), 'map.js must render MLAG peer double dashed links');
  assert.ok(mapJs.includes('m-link-flow'), 'map.js must render data flow animation line on active cables');

  // Verify CSS animations & Glassmorphism in style.css
  assert.ok(styleCss.includes('cable-data-flow') && styleCss.includes('stroke-dashoffset'), 'style.css must define SVG stroke-dashoffset cable data flow animation');
  assert.ok(styleCss.includes('node-breathe-up') && styleCss.includes('nodepulse'), 'style.css must define Soft Glow / Pulse animations for Online and Offline nodes');
  assert.ok(styleCss.includes('backdrop-filter'), 'style.css must support Glassmorphism backdrop-filter');

  // Execute map.js in a minimal sandbox to unit-test evaluateLinkHealth, formatBundlePortsBadgeLabel, and renderLinkItem
  const fakeSvg = { innerHTML: '', addEventListener() {} };
  const fakeM = {
    esc: (s) => String(s ?? ''),
    $: () => fakeSvg,
    t: (s) => s,
    S: { user: { role: 'admin' }, snap: { devices: [] }, groups: [], maps: [] },
    views: {},
    ICON: { switch: '🔀' },
    STATE_NAME: { up: 'Online', down: 'Offline' },
    statusClass: (d) => d.status,
  };
  vm.runInNewContext(mapJs, { M: fakeM, window: { M: fakeM }, document: { body: { contains: () => false } }, Math, Set, Map, Array, Object, String, Number, Boolean, RegExp, Date });

  // 1. Test formatBundlePortsBadgeLabel
  assert.equal(fakeM.formatBundlePortsBadgeLabel(['port23', 'port24']), 'P23-24');
  assert.equal(fakeM.formatBundlePortsBadgeLabel(['port1', 'port2', 'port3', 'port4']), 'P1-4');
  assert.equal(fakeM.formatBundlePortsBadgeLabel(['Gi1/0/23', 'Gi1/0/24']), 'GI1/0/23-24');
  assert.equal(fakeM.formatBundlePortsBadgeLabel(['2/e47', '2/e48']), '2/E47-48');

  // 2. Test evaluateLinkHealth with SNMP member port states
  const lacpLink = {
    from: 'n1',
    to: 'n2',
    is_bundle: true,
    bundle_name: 'Po1',
    link_type: 'lacp',
    members: [
      { src: 'port23', dst: 'port47' },
      { src: 'port24', dst: 'port48' },
    ],
  };

  // Case A: All member ports UP -> Green (var(--c-ok))
  fakeM.S.snmpPorts.set(1, {
    at: Date.now(),
    ports: [
      { index: 23, name: 'port23', oper_status: 'up', admin_status: 'up' },
      { index: 24, name: 'port24', oper_status: 'up', admin_status: 'up' },
    ],
  });
  fakeM.S.snmpPorts.set(2, {
    at: Date.now(),
    ports: [
      { index: 47, name: 'port47', oper_status: 'up', admin_status: 'up' },
      { index: 48, name: 'port48', oper_status: 'up', admin_status: 'up' },
    ],
  });

  const infoA = { name: 'SW-Core-1', rank: 'up', rawDevice: { id: 1, status: 'up' } };
  const infoB = { name: 'SW-Dist-1', rank: 'up', rawDevice: { id: 2, status: 'up' } };

  const healthAllUp = fakeM.evaluateLinkHealth(lacpLink, infoA, infoB);
  assert.equal(healthAllUp.state, 'up');
  assert.equal(healthAllUp.stroke, 'var(--c-ok)');
  assert.equal(healthAllUp.upCount, 2);

  // Verify SVG output contains twin lines + "Po1: 2 links" center badge + P23-24 / P47-48 physical port badges
  const svgUp = fakeM.views.map.renderLinkItem(lacpLink, 0, { x: 300, y: 150 }, { x: 300, y: 400 }, infoA, infoB);
  assert.ok(svgUp.includes('Po1: 2 links'), 'Center badge must show "Po1: 2 links"');
  assert.ok(svgUp.includes('P23-24'), 'Source physical port badge must show P23-24');
  assert.ok(svgUp.includes('P47-48'), 'Destination physical port badge must show P47-48');
  assert.ok(svgUp.includes('m-link-lacp'), 'LACP link must render twin parallel lines');
  assert.ok(svgUp.includes('m-link-flow'), 'UP LACP link must render data flow animation');

  // Case B: 1 member port UP, 1 member port DOWN (đứt 1 chân dự phòng) -> Degraded orange-amber (var(--c-high))
  fakeM.S.snmpPorts.set(1, {
    at: Date.now(),
    ports: [
      { index: 23, name: 'port23', oper_status: 'up', admin_status: 'up' },
      { index: 24, name: 'port24', oper_status: 'down', admin_status: 'up' },
    ],
  });
  const healthDegraded = fakeM.evaluateLinkHealth(lacpLink, infoA, infoB);
  assert.equal(healthDegraded.state, 'degraded');
  assert.equal(healthDegraded.stroke, 'var(--c-high)');
  assert.equal(healthDegraded.upCount, 1);
  assert.equal(healthDegraded.totalCount, 2);

  // Case C: All member ports DOWN -> Red (var(--c-critical))
  fakeM.S.snmpPorts.set(1, {
    at: Date.now(),
    ports: [
      { index: 23, name: 'port23', oper_status: 'down', admin_status: 'up' },
      { index: 24, name: 'port24', oper_status: 'down', admin_status: 'up' },
    ],
  });
  const healthDown = fakeM.evaluateLinkHealth(lacpLink, infoA, infoB);
  assert.equal(healthDown.state, 'down');
  assert.equal(healthDown.stroke, 'var(--c-critical)');
  assert.equal(healthDown.upCount, 0);

  // 3. Test MLAG Peer rendering (double dashed horizontal line)
  const mlagLink = {
    from: 'n1',
    to: 'n2',
    is_bundle: true,
    bundle_name: 'MLAG-Core',
    link_type: 'mlag_peer',
    members: [
      { src: 'port47', dst: 'port47' },
      { src: 'port48', dst: 'port48' },
    ],
  };
  const svgMlag = fakeM.views.map.renderLinkItem(mlagLink, 1, { x: 250, y: 200 }, { x: 650, y: 200 }, infoA, infoB);
  assert.ok(svgMlag.includes('m-link-mlag'), 'MLAG Peer must render with m-link-mlag class');
  assert.ok(svgMlag.includes('stroke-dasharray="8 5"'), 'MLAG Peer must render double dashed lines');
  assert.ok(svgMlag.includes('MLAG-Core: 2 links'), 'MLAG Peer center badge must show bundle name and link count');

  // 4. Test openLinkConfigModal: displays exact SNMP physical port count when SNMP succeeds, and 48-port fallback only when SNMP fails
  let modalBodyHtml = '';
  fakeM.modal = (_title, html) => {
    modalBodyHtml = html;
    return {
      form: {
        querySelector: () => null,
        querySelectorAll: () => [],
      },
    };
  };
  fakeM.$ = () => ({
    checked: true,
    value: 'lacp',
    classList: { toggle() {} },
    addEventListener() {},
  });
  fakeM.api = async () => ({ ports: [] });

  fakeM.S.snap.devices = [
    { id: 10, name: 'Device-With-SNMP', type: 'firewall', address: '10.0.0.10', port_count: 8, checks: { snmp: true } },
    { id: 20, name: 'Device-SNMP-Unreachable', type: 'firewall', address: '10.0.0.20', port_count: 8, checks: { snmp: true } },
  ];
  // Device 10 has exact 10 physical SNMP ports discovered dynamically; Device 20 has no SNMP response (fallback to 48)
  const discoveredSnmpPorts = Array.from({ length: 10 }, (_, k) => ({
    index: k + 1,
    name: `port${k + 1}`,
    oper_status: k === 0 || k === 3 ? 'up' : 'down',
    speed_label: '1 Gbps',
  }));
  fakeM.S.snmpPorts.set(10, { at: Date.now(), ports: discoveredSnmpPorts });
  fakeM.S.snmpPorts.delete(20);

  fakeM.views.map.m = {
    nodes: [
      { id: 'n-a', kind: 'device', ref: 10, x: 200, y: 150 },
      { id: 'n-b', kind: 'device', ref: 20, x: 500, y: 150 },
    ],
    links: [
      {
        from: 'n-a',
        to: 'n-b',
        is_bundle: true,
        bundle_name: 'Po1',
        link_type: 'lacp',
        members: [{ src: 'port1', dst: 'port47' }, { src: 'port4', dst: 'port48' }],
      },
    ],
  };

  fakeM.views.map.openLinkConfigModal(0);

  // Count rendered checkboxes for src (10 SNMP ports) vs dst (48 fallback ports even when firewall default port_count is 8)
  const srcMatches = modalBodyHtml.match(/name="lacp_src_port"/g) || [];
  const dstMatches = modalBodyHtml.match(/name="lacp_dst_port"/g) || [];
  assert.equal(srcMatches.length, 10, 'Device with 10 SNMP physical ports must display exact 10 checkboxes');
  assert.equal(dstMatches.length, 48, 'Device with failed/unavailable SNMP must fall back to 48 suggested ports (never 8)');
  assert.ok(modalBodyHtml.includes('10 port SNMP'), 'Header for SNMP device must show 10 port SNMP');
  assert.ok(modalBodyHtml.includes('(1..48)'), 'Header for fallback device must show (1..48) suggestion list');
  assert.ok(!modalBodyHtml.includes('Thiết bị không bật SNMP'), 'Must never falsely claim SNMP is not enabled');
});
