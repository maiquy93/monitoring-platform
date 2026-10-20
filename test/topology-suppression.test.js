'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../server/db');
const { Monitor } = require('../server/monitor');

function insertDevice(db, { id, name, type = 'server', address = '10.0.0.1', check_icmp = 1, severity = 'high', telegram_enabled = 1 }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices(id, name, type, address, check_icmp, severity, telegram_enabled, agent_token, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, type, address, check_icmp, severity, telegram_enabled, `tok-${id}`, now);
}

function createTestMonitor(db, monitorOpts = {}) {
  const alive = new Set();
  const telegramCalls = [];
  const aiCalls = [];

  const monitor = new Monitor(db, {
    pingFn: async (addr) => (alive.has(addr) ? { ok: true, rtt: 2.1 } : { ok: false }),
    telegramFetchFn: async (url, opts) => {
      telegramCalls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    },
    aiFetchFn: async (url, opts) => {
      aiCalls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"summary":"AI root cause diagnosis","suggested_action":"Check power"}' }] } }],
        }),
      };
    },
    ...monitorOpts,
  });

  return { monitor, alive, telegramCalls, aiCalls };
}

test('topology suppression: standalone device not in map alerts normally', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 1, name: 'Standalone Server', type: 'server', address: '10.0.0.10', severity: 'high' });

  const { monitor } = createTestMonitor(db);
  const result = monitor.isParentDown(1);
  assert.equal(result.suppressed, false);
  assert.equal(result.rootCauseDevice, null);
});

test('topology suppression: hierarchy traversal identifies upstream root cause', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 1, name: 'Core Switch', type: 'switch', address: '10.0.0.1', severity: 'critical' });
  insertDevice(db, { id: 2, name: 'Access Switch', type: 'switch', address: '10.0.0.2', severity: 'high' });
  insertDevice(db, { id: 3, name: 'App Server', type: 'server', address: '10.0.0.3', severity: 'high' });

  // Topology: Core Switch (node 1) -> Access Switch (node 2) -> App Server (node 3)
  const mapData = {
    nodes: [
      { id: 'n1', kind: 'device', ref: 1, label: 'Core Switch' },
      { id: 'n2', kind: 'device', ref: 2, label: 'Access Switch' },
      { id: 'n3', kind: 'device', ref: 3, label: 'App Server' },
    ],
    links: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3' },
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Main DC Topology', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);

  // Scenario 1: Everything is UP
  monitor.state.get(1).status = 'up';
  monitor.state.get(2).status = 'up';
  monitor.state.get(3).status = 'up';
  assert.equal(monitor.isParentDown(3).suppressed, false);
  assert.equal(monitor.isParentDown(2).suppressed, false);
  assert.equal(monitor.isParentDown(1).suppressed, false);

  // Scenario 2: Core Switch goes DOWN, Access Switch goes DOWN, Server goes DOWN
  monitor.state.get(1).status = 'down';
  monitor.state.get(2).status = 'down';
  monitor.state.get(3).status = 'down';

  // Core Switch has no upstream down parent -> NOT suppressed (it is the root cause)
  const sup1 = monitor.isParentDown(1);
  assert.equal(sup1.suppressed, false);
  assert.equal(sup1.rootCauseDevice, null);

  // Access Switch parent is Core Switch (down) -> Suppressed, root cause is Core Switch
  const sup2 = monitor.isParentDown(2);
  assert.equal(sup2.suppressed, true);
  assert.equal(sup2.rootCauseDevice.id, 1);
  assert.equal(sup2.rootCauseDevice.name, 'Core Switch');

  // App Server parent is Access Switch (down), which traces up to Core Switch (down) -> Root cause is Core Switch
  const sup3 = monitor.isParentDown(3);
  assert.equal(sup3.suppressed, true);
  assert.equal(sup3.rootCauseDevice.id, 1);
  assert.equal(sup3.rootCauseDevice.name, 'Core Switch');

  // Scenario 3: Core Switch is UP, but Access Switch is DOWN
  monitor.state.get(1).status = 'up';
  monitor.state.get(2).status = 'down';
  monitor.state.get(3).status = 'down';

  // Access Switch is NOT suppressed because Core Switch is UP
  const sup2b = monitor.isParentDown(2);
  assert.equal(sup2b.suppressed, false);

  // App Server IS suppressed with root cause Access Switch
  const sup3b = monitor.isParentDown(3);
  assert.equal(sup3b.suppressed, true);
  assert.equal(sup3b.rootCauseDevice.id, 2);
  assert.equal(sup3b.rootCauseDevice.name, 'Access Switch');
});

test('topology suppression: cycle detection prevents infinite loops', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 10, name: 'Switch A', type: 'switch', address: '10.1.1.1', severity: 'high' });
  insertDevice(db, { id: 11, name: 'Switch B', type: 'switch', address: '10.1.1.2', severity: 'high' });
  insertDevice(db, { id: 12, name: 'Switch C', type: 'switch', address: '10.1.1.3', severity: 'high' });

  // Circular link: A -> B -> C -> A
  const mapData = {
    nodes: [
      { id: 'na', kind: 'device', ref: 10, label: 'Switch A' },
      { id: 'nb', kind: 'device', ref: 11, label: 'Switch B' },
      { id: 'nc', kind: 'device', ref: 12, label: 'Switch C' },
    ],
    links: [
      { from: 'na', to: 'nb' },
      { from: 'nb', to: 'nc' },
      { from: 'nc', to: 'na' },
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Ring Topology', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);
  monitor.state.get(10).status = 'down';
  monitor.state.get(11).status = 'down';
  monitor.state.get(12).status = 'down';

  // Must not throw or hang in infinite loop
  const sup = monitor.isParentDown(11);
  assert.equal(sup.suppressed, true);
  assert.ok(sup.rootCauseDevice);
});

test('topology suppression: device tier rank overrides reverse-drawn links', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 20, name: 'Firewall Edge', type: 'firewall', address: '10.2.0.1', severity: 'critical' });
  insertDevice(db, { id: 21, name: 'Database Server', type: 'server', address: '10.2.0.2', severity: 'high' });

  // User accidentally drew link from Server to Firewall
  const mapData = {
    nodes: [
      { id: 'n_fw', kind: 'device', ref: 20, label: 'Firewall' },
      { id: 'n_srv', kind: 'device', ref: 21, label: 'DB Server' },
    ],
    links: [
      { from: 'n_srv', to: 'n_fw' }, // drawn reverse!
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Edge Topology', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);
  monitor.state.get(20).status = 'down';
  monitor.state.get(21).status = 'down';

  // Firewall is tier 4, Server is tier 2 => Firewall is recognized as parent!
  const supServer = monitor.isParentDown(21);
  assert.equal(supServer.suppressed, true);
  assert.equal(supServer.rootCauseDevice.id, 20);
  assert.equal(supServer.rootCauseDevice.name, 'Firewall Edge');

  // Firewall itself has no parent
  const supFw = monitor.isParentDown(20);
  assert.equal(supFw.suppressed, false);
});

test('topology suppression: alert storm suppression stops child Telegram alerts and AI analysis', async () => {
  const db = open(':memory:');
  // Configure Telegram
  setSetting(db, 'telegram', {
    enabled: true,
    bot_token: 'test-token-123',
    chat_id: 'test-chat-456',
    notify_down: true,
    notify_recovered: true,
  });
  setSetting(db, 'default_lang', 'vi');

  insertDevice(db, { id: 100, name: 'Gateway Router', type: 'router', address: '192.168.1.1', severity: 'critical', telegram_enabled: 1 });
  insertDevice(db, { id: 101, name: 'Switch Floor 1', type: 'switch', address: '192.168.1.2', severity: 'high', telegram_enabled: 1 });
  insertDevice(db, { id: 102, name: 'Camera 01', type: 'camera', address: '192.168.1.3', severity: 'medium', telegram_enabled: 1 });

  const mapData = {
    nodes: [
      { id: 'n_gw', kind: 'device', ref: 100, label: 'Gateway' },
      { id: 'n_sw', kind: 'device', ref: 101, label: 'Switch' },
      { id: 'n_cam', kind: 'device', ref: 102, label: 'Camera' },
    ],
    links: [
      { from: 'n_gw', to: 'n_sw' },
      { from: 'n_sw', to: 'n_cam' },
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Branch Map', JSON.stringify(mapData));

  const { monitor, telegramCalls } = createTestMonitor(db);
  monitor.reload();

  const now = Date.now();

  // 1. Gateway Router goes DOWN (root cause)
  const stGw = monitor.state.get(100);
  stGw.icmp.ok = false;
  stGw.reasons = ['Không ping được (ICMP)'];
  monitor._transition(monitor.devices.get(100), stGw, 'down', now);

  // Gateway Router MUST NOT be suppressed
  assert.equal(stGw.suppressed, false);
  // Gateway Router MUST trigger Telegram alert
  assert.equal(telegramCalls.length, 1);

  // 2. Switch Floor 1 goes DOWN (child of Gateway)
  const stSw = monitor.state.get(101);
  stSw.icmp.ok = false;
  stSw.reasons = ['Không ping được (ICMP)'];
  monitor._transition(monitor.devices.get(101), stSw, 'down', now + 1000);

  // Switch Floor 1 MUST be suppressed
  assert.equal(stSw.suppressed, true);
  assert.equal(stSw.rootCauseDevice.id, 100);
  // Telegram calls count MUST STILL BE 1 (child alert suppressed!)
  assert.equal(telegramCalls.length, 1);

  // 3. Camera 01 goes DOWN (grandchild of Gateway)
  const stCam = monitor.state.get(102);
  stCam.icmp.ok = false;
  stCam.reasons = ['Không ping được (ICMP)'];
  monitor._transition(monitor.devices.get(102), stCam, 'down', now + 2000);

  // Camera 01 MUST be suppressed
  assert.equal(stCam.suppressed, true);
  assert.equal(stCam.rootCauseDevice.id, 100);
  // Telegram calls count MUST STILL BE 1!
  assert.equal(telegramCalls.length, 1);

  // Check event messages in database
  const events = db.prepare('SELECT device_id, kind, message FROM events ORDER BY id ASC').all();
  assert.equal(events.length, 3);

  // Gateway event has normal message
  assert.ok(events[0].message.includes('Gateway Router mất kết nối: Không ping được (ICMP)'));
  assert.ok(!events[0].message.includes('[Suppressed'));

  // Switch event has suppressed note with root cause Gateway Router
  assert.ok(events[1].message.includes('[Suppressed - Do sập nguồn từ: Gateway Router]'));

  // Camera event has suppressed note with root cause Gateway Router
  assert.ok(events[2].message.includes('[Suppressed - Do sập nguồn từ: Gateway Router]'));

  // 4. Test recovery: suppressed devices do NOT spam Telegram recovery alerts
  monitor._transition(monitor.devices.get(101), stSw, 'up', now + 5000);
  assert.equal(telegramCalls.length, 1); // No recovery alert for child!
  assert.equal(stSw.suppressed, false);

  // Root device recovers -> sends recovery alert
  monitor._transition(monitor.devices.get(100), stGw, 'up', now + 6000);
  assert.equal(telegramCalls.length, 2); // Recovery alert sent for root device!
});

test('topology suppression: bilingual support in backend message and frontend trData', () => {
  const db = open(':memory:');
  setSetting(db, 'default_lang', 'en');
  insertDevice(db, { id: 200, name: 'Core Router', type: 'router', address: '10.5.0.1', severity: 'high' });
  insertDevice(db, { id: 201, name: 'Web Server', type: 'server', address: '10.5.0.2', severity: 'high' });

  const mapData = {
    nodes: [
      { id: 'nr', kind: 'device', ref: 200, label: 'Router' },
      { id: 'ns', kind: 'device', ref: 201, label: 'Server' },
    ],
    links: [{ from: 'nr', to: 'ns' }],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('EN Map', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);
  monitor.reload();

  // Root router goes down
  const stR = monitor.state.get(200);
  stR.icmp.ok = false;
  stR.reasons = ['ICMP timeout'];
  monitor._transition(monitor.devices.get(200), stR, 'down', Date.now());

  // Child server goes down with english default_lang
  const stS = monitor.state.get(201);
  stS.icmp.ok = false;
  stS.reasons = ['ICMP timeout'];
  monitor._transition(monitor.devices.get(201), stS, 'down', Date.now());

  const ev = db.prepare('SELECT * FROM events WHERE device_id = 201').get();
  assert.ok(ev);
  assert.ok(ev.message.includes('[Suppressed - Upstream failure from: Core Router]'));

  // Test frontend trData regex replacement
  const fs = require('node:fs');
  const coreJs = fs.readFileSync(require('node:path').join(__dirname, '../public/core.js'), 'utf8');
  assert.ok(coreJs.includes('Suppressed - Upstream failure from:'));
});
