'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');
const snmp = require('../server/snmp');
const { PortInspectorService, PORT_COLS, IFX_COLS, formatSpeedLabel, classifyIfType } = require('../server/port-inspector');

async function boot(appOpts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const monitor = new Monitor(db, {
    pingFn: async () => ({ ok: true, rtt: 1.1 }),
  });
  const server = createApp(db, monitor, appOpts);
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
  await t.api('POST', '/api/auth/login', { username: 'admin', password: 'initial-pass-1' });
  await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'new-password-1' });
}

test('port-inspector unit: formatSpeedLabel, classifyIfType, and two-sample bandwidth & flapping calculation', async () => {
  assert.equal(formatSpeedLabel(1000000000), '1 Gbps');
  assert.equal(formatSpeedLabel(100000000), '100 Mbps');
  assert.equal(classifyIfType(24, 'lo'), 'loopback');
  assert.equal(classifyIfType(6, 'ether1'), 'physical');

  const svc = new PortInspectorService();
  let sampleNo = 0;

  const walkColumnsFn = async ({ columns }) => {
    if (columns.includes(PORT_COLS.descr)) {
      sampleNo++;
      return {
        1: {
          [PORT_COLS.descr]: 'ether1-WAN',
          [PORT_COLS.type]: 6,
          [PORT_COLS.speed]: 1000000000,
          [PORT_COLS.admin]: 1,
          [PORT_COLS.oper]: 1,
          [PORT_COLS.lastChange]: 1000,
          [PORT_COLS.in32]: sampleNo === 1 ? 1000000 : 11000000, // +10 MB in 2s = 5 MB/s
          [PORT_COLS.out32]: sampleNo === 1 ? 500000 : 2500000,  // +2 MB in 2s = 1 MB/s
          [PORT_COLS.inErrors]: 0,
          [PORT_COLS.outErrors]: 0,
        },
        2: {
          [PORT_COLS.descr]: 'ether2-Trunk',
          [PORT_COLS.type]: 6,
          [PORT_COLS.speed]: 100000000,
          [PORT_COLS.admin]: 1,
          [PORT_COLS.oper]: sampleNo === 1 ? 2 : 1, // state transition
          [PORT_COLS.lastChange]: 49500, // changed 5s ago when sysUpTime is 50000
          [PORT_COLS.in32]: 500,
          [PORT_COLS.out32]: 500,
          [PORT_COLS.inErrors]: 12,
          [PORT_COLS.outErrors]: 3,
        },
      };
    }
    return {
      1: {
        [IFX_COLS.name]: 'Gi1/0/1',
        [IFX_COLS.alias]: 'FPT-WAN-Uplink',
        [IFX_COLS.highSpeed]: 1000,
      },
      2: {
        [IFX_COLS.name]: 'Gi1/0/2',
        [IFX_COLS.alias]: 'Floor2-Switch',
        [IFX_COLS.highSpeed]: 100,
      },
    };
  };

  const snmpGetFn = async () => ({ [snmp.OIDS.sysUpTime]: 50000 });

  // Sample 1 at t = 10000ms
  const r1 = await svc.inspectDevice({
    deviceKey: 'sw1',
    host: '10.0.0.2',
    walkColumnsFn,
    snmpGetFn,
    now: 10000,
  });
  assert.equal(r1.total_ports, 2);
  assert.equal(r1.up_count, 1);
  assert.equal(r1.down_count, 1);
  assert.equal(r1.has_rate_sample, false);

  // Sample 2 at t = 12000ms (dt = 2s)
  const r2 = await svc.inspectDevice({
    deviceKey: 'sw1',
    host: '10.0.0.2',
    walkColumnsFn,
    snmpGetFn,
    now: 12000,
  });
  assert.equal(r2.has_rate_sample, true);
  const p1 = r2.ports.find((p) => p.index === 1);
  const p2 = r2.ports.find((p) => p.index === 2);

  assert.equal(p1.name, 'Gi1/0/1');
  assert.equal(p1.alias, 'FPT-WAN-Uplink');
  assert.equal(p1.rx_Bps, 5000000);
  assert.equal(p1.tx_Bps, 1000000);
  assert.equal(p1.utilization_pct, 4.0); // 5MB/s = 40Mbps on 1Gbps link = 4%

  assert.equal(p2.total_errors, 15);
  assert.equal(p2.flapping, true);
});

test('port-inspector API: GET /api/devices/:id/ports returns physical interfaces and rates', async () => {
  const t = await boot({
    ports: {
      snmpGetFn: async () => ({ [snmp.OIDS.sysUpTime]: 100000 }),
      walkColumnsFn: async ({ columns }) => {
        if (columns.includes(PORT_COLS.descr)) {
          return {
            1: {
              [PORT_COLS.descr]: 'ether1',
              [PORT_COLS.type]: 6,
              [PORT_COLS.speed]: 1000000000,
              [PORT_COLS.admin]: 1,
              [PORT_COLS.oper]: 1,
              [PORT_COLS.in32]: 2048000,
              [PORT_COLS.out32]: 1024000,
              [PORT_COLS.inErrors]: 0,
              [PORT_COLS.outErrors]: 0,
            },
          };
        }
        return {};
      },
    },
  });

  try {
    await loginAdmin(t);
    const created = await t.api('POST', '/api/devices', {
      name: 'SW-Distribution-01',
      type: 'switch',
      address: '10.0.1.20',
      snmp_enabled: true,
    });
    assert.equal(created.status, 201);

    const res = await t.api('GET', `/api/devices/${created.body.id}/ports`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.total_ports, 1);
    assert.equal(res.body.ports[0].name, 'ether1');
    assert.equal(res.body.ports[0].speed_label, '1 Gbps');
  } finally {
    t.close();
  }
});

test('port-inspector UI isolation: index.html loads /port-inspector.js and defines M.openPortInspectorModal', () => {
  const pubDir = path.join(__dirname, '..', 'public');
  const indexHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  const piJs = fs.readFileSync(path.join(pubDir, 'port-inspector.js'), 'utf8');
  assert.ok(indexHtml.includes('<script src="/port-inspector.js"></script>'));
  assert.ok(piJs.includes('M.openPortInspectorModal'));
  assert.ok(piJs.includes('/ports'));
});

test('port-inspector filter: isPhysicalPort strips virtual interfaces and junk keywords', () => {
  const { isPhysicalPort } = require('../server/port-inspector');
  // Physical ports: OK
  assert.equal(isPhysicalPort(6, 'Gi1/0/1', 'GigabitEthernet1/0/1'), true);
  assert.equal(isPhysicalPort(6, 'ether1', 'ether1-WAN'), true);
  assert.equal(isPhysicalPort(62, 'Fa0/1', 'FastEthernet0/1'), true);
  assert.equal(isPhysicalPort(117, 'ge-0/0/0', 'GigabitEthernet'), true);

  // Virtual & Junk ports: Stripped out
  assert.equal(isPhysicalPort(24, 'lo', 'Loopback0'), false);
  assert.equal(isPhysicalPort(6, 'Loopback0', 'Virtual Loopback'), false);
  assert.equal(isPhysicalPort(135, 'Vlan1', 'Vlan 1'), false);
  assert.equal(isPhysicalPort(6, 'VLAN 100', 'Vlan Interface'), false);
  assert.equal(isPhysicalPort(6, 'Null0', 'Null Interface'), false);
  assert.equal(isPhysicalPort(131, 'Tunnel0', 'GRE Tunnel'), false);
  assert.equal(isPhysicalPort(6, 'CPU', 'Control Plane Interface'), false);
  assert.equal(isPhysicalPort(209, 'bridge0', 'Bridge interface'), false);
  assert.equal(isPhysicalPort(161, 'Port-channel1', 'LAG Trunk'), false);
  assert.equal(isPhysicalPort(6, 'Port-Channel 1', 'Bond trunk'), false);
  assert.equal(isPhysicalPort(6, 'Gi0/1.100', 'VLAN sub-interface'), false);
});

test('port-inspector 48-port switch: preserves port 25, 31, 37, 47 status accurately without shifting', async () => {
  const svc = new PortInspectorService();
  const mockRows = {};
  const mockIfx = {};

  // Insert 48 physical ethernet ports + interspersed virtual interfaces
  for (let i = 1; i <= 48; i++) {
    const isUp = [1, 25, 31, 37, 47].includes(i);
    mockRows[i] = {
      [PORT_COLS.descr]: `GigabitEthernet1/0/${i}`,
      [PORT_COLS.type]: 6,
      [PORT_COLS.speed]: 1000000000,
      [PORT_COLS.admin]: 1,
      [PORT_COLS.oper]: isUp ? 1 : 2, // 1 = Up, 2 = Down
    };
    mockIfx[i] = {
      [IFX_COLS.name]: `Gi1/0/${i}`,
    };
  }

  // Interspersed junk virtual interfaces
  mockRows[49] = { [PORT_COLS.descr]: 'Vlan1', [PORT_COLS.type]: 135, [PORT_COLS.oper]: 1 };
  mockRows[50] = { [PORT_COLS.descr]: 'Null0', [PORT_COLS.type]: 6, [PORT_COLS.oper]: 1 };
  mockRows[51] = { [PORT_COLS.descr]: 'Loopback0', [PORT_COLS.type]: 24, [PORT_COLS.oper]: 1 };

  const walkColumnsFn = async ({ columns }) => {
    if (columns.includes(PORT_COLS.descr)) return mockRows;
    return mockIfx;
  };
  const snmpGetFn = async () => ({ [snmp.OIDS.sysUpTime]: 10000 });

  const res = await svc.inspectDevice({
    deviceKey: 'sw-access-48',
    host: '10.10.10.10',
    walkColumnsFn,
    snmpGetFn,
    configuredPortCount: 48,
  });

  assert.equal(res.total_ports, 48, 'Should include all 48 physical ports and exclude Vlan1, Null0, Loopback0');

  const p1 = res.ports.find((p) => p.name === 'Gi1/0/1');
  const p25 = res.ports.find((p) => p.name === 'Gi1/0/25');
  const p31 = res.ports.find((p) => p.name === 'Gi1/0/31');
  const p37 = res.ports.find((p) => p.name === 'Gi1/0/37');
  const p47 = res.ports.find((p) => p.name === 'Gi1/0/47');
  const p48 = res.ports.find((p) => p.name === 'Gi1/0/48');

  assert.ok(p25, 'Port 25 must exist');
  assert.ok(p31, 'Port 31 must exist');
  assert.ok(p37, 'Port 37 must exist');
  assert.ok(p47, 'Port 47 must exist');

  assert.equal(p1.oper_status, 'up', 'Port 1 must be up');
  assert.equal(p25.oper_status, 'up', 'Port 25 must be up');
  assert.equal(p31.oper_status, 'up', 'Port 31 must be up');
  assert.equal(p37.oper_status, 'up', 'Port 37 must be up');
  assert.equal(p47.oper_status, 'up', 'Port 47 must be up');
  assert.equal(p48.oper_status, 'down', 'Port 48 must be down');
});
