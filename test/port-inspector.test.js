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
