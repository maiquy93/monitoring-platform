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
const discovery = require('../server/discovery');

async function boot(appOpts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const monitor = new Monitor(db, {
    pingFn: async () => ({ ok: true, rtt: 1.5 }),
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

test('discovery unit: parseIpTargets supports CIDR (/24, /30), short ranges, full ranges, and single IPs', () => {
  const cidr30 = discovery.parseIpTargets('192.168.10.0/30');
  assert.deepEqual(cidr30, ['192.168.10.1', '192.168.10.2']);

  const cidr24 = discovery.parseIpTargets('10.0.5.0/24');
  assert.equal(cidr24.length, 254);
  assert.equal(cidr24[0], '10.0.5.1');
  assert.equal(cidr24[253], '10.0.5.254');

  const shortRange = discovery.parseIpTargets('192.168.1.10-14');
  assert.deepEqual(shortRange, ['192.168.1.10', '192.168.1.11', '192.168.1.12', '192.168.1.13', '192.168.1.14']);

  const mixed = discovery.parseIpTargets('10.0.0.1, 10.0.0.5-10.0.0.7');
  assert.deepEqual(mixed, ['10.0.0.1', '10.0.0.5', '10.0.0.6', '10.0.0.7']);

  assert.throws(() => discovery.parseIpTargets('999.999.1.1'), /không hợp lệ/);
});

test('discovery unit: inferDeviceType accurately classifies routers, switches, APs, printers, firewalls, and servers', () => {
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: { profile_id: 'hp-printer', sysDescr: 'HP LaserJet Pro M404dn' } }),
    'printer'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: { profile_id: 'ubiquiti-unifi', sysDescr: 'U6-LR' } }),
    'ap'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: { profile_id: 'fortigate', sysDescr: 'FortiGate-100F' } }),
    'firewall'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: { profile_id: 'mikrotik', sysDescr: 'RouterOS RB5009' } }),
    'router'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: { profile_id: 'alcatel-aos7', sysDescr: 'OmniSwitch OS6860' } }),
    'switch'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: null, openPorts: [80, 9100] }),
    'printer'
  );
  assert.equal(
    discovery.inferDeviceType({ snmpInfo: null, openPorts: [22, 8291] }),
    'router'
  );
});

test('discovery API: admin-only scanSubnet & bulk import with group assignment and duplicate protection', async () => {
  const t = await boot({
    discovery: {
      pingFn: async (ip) => {
        if (ip === '10.10.1.1' || ip === '10.10.1.2' || ip === '10.10.1.3') return { ok: true, rtt: 1.4 };
        return { ok: false, rtt: null };
      },
      tcpProbeFn: async (ip, port) => {
        if (ip === '10.10.1.3' && port === 9100) return true;
        return false;
      },
      snmpGetFn: async ({ host }) => {
        if (host === '10.10.1.1') {
          return {
            [snmp.OIDS.sysDescr]: 'RouterOS CHR 7.12',
            [snmp.OIDS.sysObjectID]: '1.3.6.1.4.1.14988.1',
            [snmp.OIDS.sysName]: 'GW-MikroTik-01',
          };
        }
        if (host === '10.10.1.2') {
          return {
            [snmp.OIDS.sysDescr]: 'Alcatel-Lucent OS6860E',
            [snmp.OIDS.sysObjectID]: '1.3.6.1.4.1.6486.801.1.1.2.1.11.1.2',
            [snmp.OIDS.sysName]: 'SW-Core-T1',
          };
        }
        throw new Error('timeout');
      },
      dnsReverseFn: async () => [],
    },
  });

  try {
    await loginAdmin(t);

    // Pre-create one existing device (10.10.1.1) and one group
    const grpRes = await t.api('POST', '/api/groups', { name: 'Hạ tầng Tầng 1', description: 'Core LAN' });
    assert.equal(grpRes.status, 201);
    const grpId = grpRes.body.id;

    await t.api('POST', '/api/devices', { name: 'Existing-GW', type: 'router', address: '10.10.1.1' });

    // Non-admin operator cannot run discovery scan
    await t.api('POST', '/api/users', { username: 'op1', password: 'password-123', role: 'operator' });
    const opApi = t.createClient();
    await opApi('POST', '/api/auth/login', { username: 'op1', password: 'password-123' });
    await opApi('POST', '/api/auth/password', { current: 'password-123', password: 'new-password-123' });
    const opScan = await opApi('POST', '/api/discovery/scan', { target: '10.10.1.1-5' });
    assert.equal(opScan.status, 403);

    // Admin scans range 10.10.1.1-5
    const scanRes = await t.api('POST', '/api/discovery/scan', { target: '10.10.1.1-5', communities: 'public' });
    assert.equal(scanRes.status, 200);
    assert.equal(scanRes.body.scanned_count, 5);
    assert.equal(scanRes.body.found_count, 3);
    assert.equal(scanRes.body.new_count, 2);

    const h1 = scanRes.body.hosts.find((h) => h.ip === '10.10.1.1');
    const h2 = scanRes.body.hosts.find((h) => h.ip === '10.10.1.2');
    const h3 = scanRes.body.hosts.find((h) => h.ip === '10.10.1.3');
    assert.equal(h1.already_exists, true);
    assert.equal(h2.already_exists, false);
    assert.equal(h2.type, 'switch');
    assert.equal(h2.snmp_profile, 'alcatel-aos7');
    assert.equal(h3.type, 'printer');

    // Bulk import all 3 (10.10.1.1 should be automatically skipped as duplicate)
    const impRes = await t.api('POST', '/api/discovery/import', {
      devices: scanRes.body.hosts,
      groups: [grpId],
    });
    assert.equal(impRes.status, 201);
    assert.equal(impRes.body.added_count, 2);
    assert.equal(impRes.body.skipped_count, 1);

    const allDevs = await t.api('GET', '/api/devices');
    assert.equal(allDevs.body.devices.length, 3);
    const sw = allDevs.body.devices.find((d) => d.address === '10.10.1.2');
    assert.equal(sw.name, 'SW-Core-T1');
    assert.deepEqual(sw.groups, [grpId]);
  } finally {
    t.close();
  }
});

test('discovery UI isolation: index.html loads /discovery.js and defines M.openDiscoveryModal', () => {
  const pubDir = path.join(__dirname, '..', 'public');
  const indexHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  const discJs = fs.readFileSync(path.join(pubDir, 'discovery.js'), 'utf8');
  assert.ok(indexHtml.includes('<script src="/discovery.js"></script>'));
  assert.ok(discJs.includes('M.openDiscoveryModal'));
  assert.ok(discJs.includes('/api/discovery/scan'));
});
