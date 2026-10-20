'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../server/db');
const { Monitor } = require('../server/monitor');

function insertDevice(db, { id, name, type = 'server', address = '10.0.0.1', check_icmp = 1, severity = 'high', telegram_enabled = 1, parent_id = null }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO devices(id, name, type, address, check_icmp, severity, telegram_enabled, parent_id, agent_token, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, type, address, check_icmp, severity, telegram_enabled, parent_id, `tok-${id}`, now);
}

function createTestMonitor(db, monitorOpts = {}) {
  setSetting(db, 'storm_guard_enabled', 1);
  setSetting(db, 'storm_use_parent_id', 1);
  setSetting(db, 'storm_use_topology', 1);
  setSetting(db, 'storm_burst_threshold', 3);
  const alive = new Set();
  const telegramCalls = [];
  const aiCalls = [];

  const monitor = new Monitor(db, {
    pingFn: async (addr) => (alive.has(addr) ? { ok: true, rtt: 2.1 } : { ok: false }),
    telegramFetchFn: async (url, opts) => {
      telegramCalls.push({ url, opts, body: JSON.parse(opts.body || '{}') });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    },
    aiFetchFn: async (url, opts) => {
      aiCalls.push({ url, opts, body: JSON.parse(opts.body || '{}') });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"summary":"AI root cause diagnosis","suggested_action":"Check power"}' }] } }],
        }),
        text: async () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"summary":"AI root cause diagnosis","suggested_action":"Check power"}' }] } }],
        }),
      };
    },
    ...monitorOpts,
  });

  return { monitor, alive, telegramCalls, aiCalls };
}

test('Layer 1: explicit parent_id configuration has Priority 1 over topology map', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 1, name: 'Core Gateway', type: 'router', address: '10.0.0.1' });
  insertDevice(db, { id: 2, name: 'Distribution Switch', type: 'switch', address: '10.0.0.2', parent_id: 1 });
  insertDevice(db, { id: 3, name: 'Backup Gateway', type: 'router', address: '10.0.0.3' });

  // In Topology map, user drew link from Backup Gateway (3) to Distribution Switch (2)
  const mapData = {
    nodes: [
      { id: 'n2', kind: 'device', ref: 2, label: 'Distribution Switch' },
      { id: 'n3', kind: 'device', ref: 3, label: 'Backup Gateway' },
    ],
    links: [{ from: 'n3', to: 'n2' }],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Test Map', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);

  // Switch (2) has explicit parent_id = 1 => getUpstreamParents MUST return [1], ignoring Map link
  const parents = monitor.getUpstreamParents(2);
  assert.deepEqual(parents, [1]);

  // When Core Gateway (1) is DOWN, Switch (2) MUST be suppressed with root cause Core Gateway
  monitor.state.get(1).status = 'down';
  monitor.state.get(2).status = 'down';
  const sup = monitor.isSuppressedByParent(2);
  assert.equal(sup.suppressed, true);
  assert.equal(sup.rootCause.id, 1);
  assert.equal(sup.rootCause.name, 'Core Gateway');
});

test('Layer 1 & 2: Topology Role Weight priority and reverse-drawn links', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 10, name: 'Edge Firewall', type: 'firewall', address: '10.1.0.1' });
  insertDevice(db, { id: 11, name: 'Access Switch', type: 'switch', address: '10.1.0.2' });
  insertDevice(db, { id: 12, name: 'Web Server', type: 'server', address: '10.1.0.3' });

  // Map with reverse-drawn links: Server -> Switch -> Firewall
  const mapData = {
    nodes: [
      { id: 'n10', kind: 'device', ref: 10, label: 'Edge Firewall' },
      { id: 'n11', kind: 'device', ref: 11, label: 'Access Switch' },
      { id: 'n12', kind: 'device', ref: 12, label: 'Web Server' },
    ],
    links: [
      { from: 'n12', to: 'n11' }, // drawn reverse (Server -> Switch)
      { from: 'n11', to: 'n10' }, // drawn reverse (Switch -> Firewall)
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Reverse Map', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);

  // Role Weight: Firewall (weight 1) > Switch (weight 2) > Server (weight 3)
  assert.deepEqual(monitor.getUpstreamParents(11), [10]);
  assert.deepEqual(monitor.getUpstreamParents(12), [11]);
  assert.deepEqual(monitor.getUpstreamParents(10), []);

  monitor.state.get(10).status = 'down';
  monitor.state.get(11).status = 'down';
  monitor.state.get(12).status = 'down';

  // Both Switch and Server must trace root cause to Edge Firewall
  assert.equal(monitor.isSuppressedByParent(11).rootCause.id, 10);
  assert.equal(monitor.isSuppressedByParent(12).rootCause.id, 10);
  assert.equal(monitor.isSuppressedByParent(10).suppressed, false);
});

test('Layer 2: Dual-Homing redundant upstreams (suppress ONLY when ALL parents are down)', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 20, name: 'Switch 1', type: 'switch', address: '10.2.0.1' });
  insertDevice(db, { id: 21, name: 'Switch 2', type: 'switch', address: '10.2.0.2' });
  insertDevice(db, { id: 22, name: 'Dual-Homed Server', type: 'server', address: '10.2.0.3' });

  // Dual-homed links: Switch 1 -> Server and Switch 2 -> Server
  const mapData = {
    nodes: [
      { id: 's1', kind: 'device', ref: 20, label: 'Switch 1' },
      { id: 's2', kind: 'device', ref: 21, label: 'Switch 2' },
      { id: 'srv', kind: 'device', ref: 22, label: 'Dual-Homed Server' },
    ],
    links: [
      { from: 's1', to: 'srv' },
      { from: 's2', to: 'srv' },
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Redundant Map', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);
  const parents = monitor.getUpstreamParents(22);
  assert.equal(parents.length, 2);
  assert.ok(parents.includes(20) && parents.includes(21));

  // Case A: Only Switch 1 is DOWN, but Switch 2 is UP
  // Dual-homing rule: Since not ALL parents are down, Server is NOT suppressed!
  monitor.state.get(20).status = 'down';
  monitor.state.get(21).status = 'up';
  monitor.state.get(22).status = 'down';

  const supA = monitor.isSuppressedByParent(22);
  assert.equal(supA.suppressed, false, 'Server must not be suppressed when one redundant uplink is still UP');

  // Case B: BOTH Switch 1 AND Switch 2 are DOWN
  // Dual-homing rule: ALL parents are down -> Server IS suppressed!
  monitor.state.get(21).status = 'down';
  const supB = monitor.isSuppressedByParent(22);
  assert.equal(supB.suppressed, true);
  assert.ok(supB.rootCause);
});

test('Layer 2: Cycle detection handles ring topology without infinite loop', () => {
  const db = open(':memory:');
  insertDevice(db, { id: 30, name: 'Ring A', type: 'switch', address: '10.3.0.1' });
  insertDevice(db, { id: 31, name: 'Ring B', type: 'switch', address: '10.3.0.2' });
  insertDevice(db, { id: 32, name: 'Ring C', type: 'switch', address: '10.3.0.3' });

  // Ring: A -> B -> C -> A
  const mapData = {
    nodes: [
      { id: 'ra', kind: 'device', ref: 30, label: 'Ring A' },
      { id: 'rb', kind: 'device', ref: 31, label: 'Ring B' },
      { id: 'rc', kind: 'device', ref: 32, label: 'Ring C' },
    ],
    links: [
      { from: 'ra', to: 'rb' },
      { from: 'rb', to: 'rc' },
      { from: 'rc', to: 'ra' },
    ],
  };
  db.prepare('INSERT INTO maps(name, data) VALUES(?, ?)').run('Ring Map', JSON.stringify(mapData));

  const { monitor } = createTestMonitor(db);
  monitor.state.get(30).status = 'down';
  monitor.state.get(31).status = 'down';
  monitor.state.get(32).status = 'down';

  const sup = monitor.isSuppressedByParent(31);
  assert.equal(sup.suppressed, true);
  assert.ok(sup.rootCause);
});

test('Layer 3: Burst / Mass Outage Aggregator when NO topology is configured', async () => {
  const db = open(':memory:');
  setSetting(db, 'telegram', {
    enabled: true,
    bot_token: 'test-token-123',
    chat_id: 'test-chat-456',
    notify_down: true,
    notify_recovered: true,
  });
  setSetting(db, 'default_lang', 'vi');
  setSetting(db, 'ai', {
    enabled: true,
    provider: 'gemini',
    api_key: 'test-gemini-key',
    auto_incident: true,
  });

  // 4 Standalone devices with NO topology and NO parent_id
  insertDevice(db, { id: 101, name: 'Standalone VM 1', type: 'server', address: '192.168.10.1', severity: 'high' });
  insertDevice(db, { id: 102, name: 'Standalone VM 2', type: 'server', address: '192.168.10.2', severity: 'high' });
  insertDevice(db, { id: 103, name: 'Standalone VM 3', type: 'server', address: '192.168.10.3', severity: 'high' });
  insertDevice(db, { id: 104, name: 'Standalone VM 4', type: 'server', address: '192.168.10.4', severity: 'high' });

  const { monitor, telegramCalls, aiCalls } = createTestMonitor(db);
  monitor.reload();

  const now = Date.now();

  // Scenario A: 1 single device fails -> Normal individual alert
  const st1 = monitor.state.get(101);
  st1.icmp.ok = false;
  st1.reasons = ['Không ping được (ICMP)'];
  monitor._transition(monitor.devices.get(101), st1, 'down', now);
  monitor._flushDownAlerts(now);

  assert.equal(telegramCalls.length, 1, 'Single failure must trigger 1 individual Telegram alert');
  assert.ok(telegramCalls[0].body.text.includes('Standalone VM 1'));

  // Clear calls for Scenario B
  telegramCalls.length = 0;
  aiCalls.length = 0;

  // Scenario B: Mass Outage - 3 devices fail simultaneously within 10s window without topology
  const st2 = monitor.state.get(102);
  const st3 = monitor.state.get(103);
  const st4 = monitor.state.get(104);
  st2.icmp.ok = false; st2.reasons = ['Không ping được (ICMP)'];
  st3.icmp.ok = false; st3.reasons = ['Không ping được (ICMP)'];
  st4.icmp.ok = false; st4.reasons = ['Không ping được (ICMP)'];

  monitor._transition(monitor.devices.get(102), st2, 'down', now + 1000);
  monitor._transition(monitor.devices.get(103), st3, 'down', now + 1000);
  monitor._transition(monitor.devices.get(104), st4, 'down', now + 1000);
  monitor._flushDownAlerts(now + 1000);
  await new Promise((r) => setTimeout(r, 50));

  // Layer 3 Cầu chì chống bão: MUST aggregate into EXACTLY 1 Mass Outage Telegram alert!
  assert.equal(telegramCalls.length, 1, 'Burst of 3+ devices must send exactly 1 aggregated Telegram notification');
  assert.ok(telegramCalls[0].body.text.includes('MASS OUTAGE') || telegramCalls[0].body.text.includes('SẬP MẠNG HÀNG LOẠT'));
  assert.ok(telegramCalls[0].body.text.includes('Standalone VM 2'));
  assert.ok(telegramCalls[0].body.text.includes('Standalone VM 3'));
  assert.ok(telegramCalls[0].body.text.includes('Standalone VM 4'));

  // AI analysis: MUST be called at most 1 time for the mass outage cluster!
  assert.equal(aiCalls.length, 1, 'Burst of 3+ devices must trigger AI at most 1 time');
  const aiBodyStr = JSON.stringify(aiCalls[0].body);
  assert.ok(aiBodyStr.includes('Mass Outage') || aiBodyStr.includes('sập đồng thời'));

  // Check event logs: each device still has its event logged in the database for auditing
  const events = db.prepare("SELECT device_id, kind FROM events WHERE kind = 'down'").all();
  assert.equal(events.length, 4);

  // Test recovery: devices in mass outage do NOT flood individual Telegram recovery alerts
  telegramCalls.length = 0;
  monitor._transition(monitor.devices.get(102), st2, 'up', now + 5000);
  monitor._transition(monitor.devices.get(103), st3, 'up', now + 5000);
  assert.equal(telegramCalls.length, 0, 'Devices recovered from mass outage must not spam individual recovery alerts');
});

test('Bilingual compatibility: Suppressed tag formats in VI and EN', () => {
  const db = open(':memory:');
  setSetting(db, 'default_lang', 'vi');
  insertDevice(db, { id: 201, name: 'Core Router', type: 'router', address: '10.9.0.1' });
  insertDevice(db, { id: 202, name: 'Branch AP', type: 'ap', address: '10.9.0.2', parent_id: 201 });

  const { monitor } = createTestMonitor(db);
  monitor.reload();

  monitor.state.get(201).status = 'down';
  const stAp = monitor.state.get(202);
  stAp.icmp.ok = false;
  stAp.reasons = ['Không ping được (ICMP)'];
  monitor._transition(monitor.devices.get(202), stAp, 'down', Date.now());

  const evVi = db.prepare('SELECT * FROM events WHERE device_id = 202').get();
  assert.ok(evVi.message.includes('[Đã chặn thông báo lẻ - Do sập nguồn từ: Core Router]') || evVi.message.includes('[Suppressed - Mất kết nối từ: Core Router]'));

  // Test EN language
  setSetting(db, 'default_lang', 'en');
  monitor.reload();
  monitor.state.get(201).status = 'down';
  monitor.state.get(202).status = 'unknown'; // reset to trigger transition
  monitor._transition(monitor.devices.get(202), stAp, 'down', Date.now() + 1000);

  const evEn = db.prepare('SELECT * FROM events WHERE device_id = 202 ORDER BY id DESC').get();
  assert.ok(evEn.message.includes('[Suppressed - Upstream failure from: Core Router]'));

  // Test frontend trData regex
  const fs = require('node:fs');
  const coreJs = fs.readFileSync(require('node:path').join(__dirname, '../public/core.js'), 'utf8');
  assert.ok(coreJs.includes('Mất kết nối từ'));
  assert.ok(coreJs.includes('Upstream failure from:'));
});
