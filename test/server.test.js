'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { Monitor, updateNetSlot, updatePktSlot } = require('../server/monitor');
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

test('snmp printer: toner/drum/page_count/status are shown on overview tile and device detail, and stored in metrics history', async () => {
  const printerInfo = {
    sysDescr: 'HP LaserJet Pro M404dn',
    sysName: 'HP-Printer-01',
    uptime: 3600,
    toner: 65,
    drum: 82,
    page_count: 15420,
    printer: {
      status_code: 3,
      status_text: 'Sẵn sàng (Ready/Idle)',
      display: 'Ready',
      model: 'HP LaserJet Pro M404dn',
      serial: 'VNC3K04921',
      firmware: '1L7EWK2',
      duplex: 'Có (In 2 mặt tự động)',
      page_count: 15420,
      memory: { total: 134217728, used: 42467328, percent: 32 },
      languages: ['PJL', 'PCLXL', 'PCL', 'PDF', 'POSTSCRIPT'],
      errors: [],
      supplies: [
        { name: 'HP Black Toner CF276A', kind: 'toner', percent: 65, status: '65%' },
        { name: 'HP Imaging Drum Unit', kind: 'drum', percent: 82, status: '82%' }
      ],
      trays: [
        { name: 'Tray 1', status: 'Còn giấy', max: 250, level: 180, media_type: 'Plain', media_name: 'A4', vendor: 'Hewlett-Packard' }
      ]
    }
  };
  const t = await boot({ snmpFn: async () => printerInfo });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'hp-printer', type: 'printer', address: '10.0.0.88', check_icmp: false, snmp_enabled: true
    });
    assert.equal(c.status, 201);
    t.monitor.tick();
    await new Promise((r) => setTimeout(r, 30));

    // Kiểm tra thông tin hiển thị trên thẻ tổng quan (overview tile)
    const v = t.monitor.snapshot().devices[0];
    assert.equal(v.status, 'up');
    assert.equal(v.type, 'printer');
    assert.equal(v.toner, 65);
    assert.equal(v.drum, 82);
    assert.equal(v.page_count, 15420);
    assert.equal(v.printer_status, 'Ready');

    // Kiểm tra trang chi tiết (device detail API)
    const detail = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.ok(detail.printer);
    assert.equal(detail.printer.model, 'HP LaserJet Pro M404dn');
    assert.equal(detail.printer.serial, 'VNC3K04921');
    assert.equal(detail.printer.firmware, '1L7EWK2');
    assert.equal(detail.printer.duplex, 'Có (In 2 mặt tự động)');
    assert.equal(detail.printer.memory.percent, 32);
    assert.ok(detail.printer.languages.includes('PCLXL'));
    assert.equal(detail.printer.supplies.length, 2);
    assert.equal(detail.printer.trays.length, 1);
    assert.equal(detail.printer.trays[0].media_type, 'Plain');
    assert.equal(detail.printer.trays[0].media_name, 'A4');

    // Lưu vào bảng metrics
    t.monitor.tick(Date.now() + 60000);
    const row = t.db.prepare('SELECT toner, drum FROM metrics WHERE device_id=?').get(c.body.id);
    assert.deepEqual({ ...row }, { toner: 65, drum: 82 });

    // API history trả về toner và drum
    const hist = (await t.api('GET', `/api/devices/${c.body.id}/history`)).body;
    assert.ok(hist.points.length > 0);
    assert.equal(hist.points[0].toner, 65);
    assert.equal(hist.points[0].drum, 82);
  } finally { t.close(); }
});

test('snmp printer: low drum life or low toner or paper jam triggers warning status and event', async () => {
  const printerState = {
    sysDescr: 'Brother HL-L2366DW',
    sysName: 'Brother-HR',
    uptime: 1000,
    toner: 8, // <= 10%
    drum: 9,  // <= 10%
    page_count: 9500,
    printer: {
      status_code: 1,
      status_text: 'Cảnh báo',
      display: 'Paper Jam',
      errors: ['Kẹt giấy (Paper jam)'],
      supplies: [],
      trays: []
    }
  };
  const t = await boot({ snmpFn: async () => printerState });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'brother-printer', type: 'printer', address: '10.0.0.89', check_icmp: false, snmp_enabled: true
    });
    assert.equal(c.status, 201);
    t.monitor.tick();
    await new Promise((r) => setTimeout(r, 30));

    const v = t.monitor.snapshot().devices[0];
    assert.equal(v.status, 'warning');
    assert.ok(v.reasons.some((r) => /mực còn 8%/i.test(r)));
    assert.ok(v.reasons.some((r) => /độ bền drum còn 9%/i.test(r)));
    assert.ok(v.reasons.some((r) => /kẹt giấy/i.test(r)));

    const events = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events;
    assert.ok(events.length > 0);
    assert.ok(events.some((e) => /sự cố máy in/i.test(e.message)));
  } finally { t.close(); }
});

test('severity: "none" (không cảnh báo) keeps device up, prevents alert events, and does not raise system summary level', async () => {
  const printerState = {
    sysDescr: 'Brother HL-L2366DW',
    sysName: 'Brother-HR',
    uptime: 1000,
    toner: 0,
    drum: 0,
    page_count: 9500,
    printer: {
      status_code: 1,
      status_text: 'Cảnh báo',
      display: 'No Toner',
      errors: ['Hết mực (No toner)'],
      supplies: [],
      trays: []
    }
  };
  const t = await boot({ snmpFn: async () => printerState });
  try {
    await loginAdmin(t);
    // 1. Tạo thiết bị với severity: 'none'
    const c = await t.api('POST', '/api/devices', {
      name: 'silent-printer', type: 'printer', address: '10.0.0.99', check_icmp: false, snmp_enabled: true, severity: 'none'
    });
    assert.equal(c.status, 201);
    const devGet = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(devGet.severity, 'none');
    assert.equal(devGet.severity_override, 'none');

    t.monitor.tick();
    await new Promise((r) => setTimeout(r, 30));

    // Thiết bị không bị chuyển sang trạng thái warning
    const snap = t.monitor.snapshot();
    const v = snap.devices.find((d) => d.id === c.body.id);
    assert.equal(v.status, 'up');
    assert.equal(v.severity, 'none');

    // Không sinh ra bất kỳ sự kiện warning nào trong bảng events
    const events = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events;
    assert.equal(events.length, 0);

    // Không kéo summary.level lên warning/critical/low và warning count = 0
    assert.equal(snap.summary.level, 'ok');
    assert.equal(snap.summary.warning, 0);
    assert.equal(snap.summary.unacked, 0);

    // 2. Cài đặt severity về 0 hoặc '0' qua PUT /api/devices/:id
    const uRes = await t.api('PUT', `/api/devices/${c.body.id}`, { severity: 0 });
    assert.equal(uRes.status, 200);
    const devAfter0 = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(devAfter0.severity, 'none');

    const uResStr0 = await t.api('PUT', `/api/devices/${c.body.id}`, { severity: '0' });
    assert.equal(uResStr0.status, 200);
    const devAfterStr0 = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(devAfterStr0.severity, 'none');

    // 3. Cài đặt type_severity cho printer là 0 qua API settings
    const sRes = await t.api('PUT', '/api/settings', {
      type_severity: { printer: 0 }
    });
    assert.equal(sRes.status, 200);
    const updatedSettings = (await t.api('GET', '/api/settings')).body;
    assert.equal(updatedSettings.type_severity.printer, 'none');

    // 4. Kiểm tra bật / tắt tính năng mute_local_alerts (tắt cảnh báo trên thẻ local)
    assert.equal(devGet.mute_local_alerts, false);
    const mRes = await t.api('PUT', `/api/devices/${c.body.id}`, { mute_local_alerts: true });
    assert.equal(mRes.status, 200);
    const devMuted = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    assert.equal(devMuted.mute_local_alerts, true);
    const snapMuted = t.monitor.snapshot().devices.find((d) => d.id === c.body.id);
    assert.equal(snapMuted.mute_local_alerts, true);
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

test('bandwidth: updateNetSlot handles deltas, 32-bit counter rollover and resets', () => {
  const slot = { base: null, rate: null };
  const t0 = 1000000;
  // First sample sets baseline
  updateNetSlot(slot, { p1: [1000, 2000, 64] }, t0);
  assert.equal(slot.rate, null);
  assert.deepEqual(slot.base, { ts: t0, rows: { p1: [1000, 2000, 64] } });

  // Second sample after 10s: rx +10000 (1000 B/s), tx +20000 (2000 B/s)
  updateNetSlot(slot, { p1: [11000, 22000, 64] }, t0 + 10000);
  assert.equal(slot.rate.in, 1000);
  assert.equal(slot.rate.out, 2000);

  // 32-bit rollover: counter near 2^32 wraps to small value
  const s32 = { base: null, rate: null };
  updateNetSlot(s32, { eth0: [4294960000, 1000, 32] }, t0);
  // After 10s: wraps past 2^32 (4294967296) to 5000: delta = 5000 + 4294967296 - 4294960000 = 12296 bytes => 1229.6 B/s
  updateNetSlot(s32, { eth0: [5000, 21000, 32] }, t0 + 10000);
  assert.equal(Math.round(s32.rate.in), 1230);
  assert.equal(s32.rate.out, 2000);

  // Counter reset on 64-bit counter (device rebooted without wrap): drops silently
  const s64 = { base: null, rate: null };
  updateNetSlot(s64, { p1: [50000, 50000, 64] }, t0);
  updateNetSlot(s64, { p1: [1000, 1000, 64] }, t0 + 10000);
  assert.equal(s64.rate, null);
});

test('bandwidth: agent network traffic calculates bandwidth, stores in DB and returns in history API', async () => {
  const t = await boot({ agentTimeoutMs: 20000, agentNetWindowMs: 0 });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', { name: 'srv-net', type: 'server', check_icmp: false, check_agent: true });
    const dev = (await t.api('GET', `/api/devices/${c.body.id}`)).body;
    const now = Date.now();

    // Report #1 sets baseline
    await t.api('POST', '/api/agent/report', {
      hostname: 'srv-net', cpu: { percent: 10, cores: 2 },
      memory: { total: 4e9, used: 1e9, percent: 25 },
      disks: [{ mount: '/', total: 5e10, used: 1e10, percent: 20 }],
      net: { rx_bytes: 1000000, tx_bytes: 500000 },
      uptime: 500,
    }, { authorization: `Bearer ${dev.agent_token}`, cookie: '' });

    t.monitor.startedAt -= 60000;
    t.monitor.evaluate(now);
    assert.equal(t.monitor.snapshot().devices[0].net_in, null);

    // Report #2: update slot with delta rx = 1000000 B, tx = 500000 B over exactly 10s => in: 100000 B/s, out: 50000 B/s
    const st = t.monitor.state.get(c.body.id);
    const t1 = st.agent.net.base.ts + 10000;
    updateNetSlot(st.agent.net, { agent: [2000000, 1000000, 64] }, t1, 0);
    st.agent.lastAt = t1;
    st.lastMetricAt = 0;

    t.monitor.evaluate(t1);
    const d = t.monitor.snapshot().devices[0];
    assert.equal(d.net_in, 100000);
    assert.equal(d.net_out, 50000);

    // Stored metric
    const row = t.db.prepare('SELECT net_in, net_out FROM metrics WHERE device_id=? ORDER BY ts DESC').get(c.body.id);
    assert.deepEqual({ ...row }, { net_in: 100000, net_out: 50000 });

    // History API returns points with net_in and net_out
    const history = await t.api('GET', `/api/devices/${c.body.id}/history?range=1h`);
    assert.equal(history.status, 200);
    assert.ok(history.body.points.length > 0);
    const pt = history.body.points[history.body.points.length - 1];
    assert.equal(pt.net_in, 100000);
    assert.equal(pt.net_out, 50000);
  } finally { t.close(); }
});

test('bandwidth: SNMP interface traffic calculates rates and stores metrics', async () => {
  let sample = 1;
  const t = await boot({
    snmpFn: async () => ({
      sysDescr: 'RouterOS', sysName: 'rt', uptime: 100, cpu: 15, ram: 30, disk: 10,
      if_counters: {
        rows: {
          '1': sample === 1 ? [100000, 50000, 64] : [400000, 200000, 64],
        },
      },
    }),
  });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'router-net', type: 'router', address: '10.0.0.99', check_icmp: false, snmp_enabled: true,
    });
    assert.equal(c.status, 201);

    let now = Date.now();
    // First SNMP poll: baseline
    now += 35000;
    t.monitor.tick(now);
    for (let i = 0; i < 30 && !t.monitor.state.get(c.body.id).snmp.net.base; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.monitor.state.get(c.body.id).snmp.net.base);
    assert.equal(t.monitor.snapshot().devices[0].net_in, null);

    // Second SNMP poll after 30s: sample 2
    sample = 2;
    now += 30000;
    t.monitor.tick(now);
    for (let i = 0; i < 30 && !t.monitor.state.get(c.body.id).snmp.net.rate; i++) await new Promise((r) => setTimeout(r, 20));

    // Delta rx = 300,000 / 30s = 10,000 B/s, delta tx = 150,000 / 30s = 5,000 B/s
    const d = t.monitor.snapshot().devices[0];
    assert.equal(d.net_in, 10000);
    assert.equal(d.net_out, 5000);

    // Stored metrics contain net_in and net_out
    now += 35000;
    t.monitor.tick(now);
    const row = t.db.prepare('SELECT net_in, net_out FROM metrics WHERE device_id=? ORDER BY ts DESC').get(c.body.id);
    assert.deepEqual({ ...row }, { net_in: 10000, net_out: 5000 });
  } finally { t.close(); }
});

test('dos: SNMP TCP/UDP packet rate spike triggers critical Flood/DoS event and recovers', async () => {
  let sample = 1;
  const t = await boot({
    snmpFn: async () => ({
      sysDescr: 'RouterOS', sysName: 'rt-sec', uptime: 500, cpu: 10, ram: 20, disk: 5,
      pkt_counters: {
        tcp: sample === 1 ? 100000 : 700000,
        udp: sample === 1 ? 50000 : 250000,
      },
    }),
  });
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'router-dos', type: 'router', address: '10.0.0.101', check_icmp: false, snmp_enabled: true,
    });
    assert.equal(c.status, 201);

    let now = Date.now();
    // Sample 1: Baseline
    now += 35000;
    t.monitor.tick(now);
    for (let i = 0; i < 30 && !t.monitor.state.get(c.body.id).snmp.pkt.base; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.monitor.state.get(c.body.id).snmp.pkt.base);

    // Sample 2 after 30s:
    // Delta TCP = 600,000, UDP = 200,000 => total 800,000 / 30s = 26,666.7 pkts/s (> threshold 10,000 pkts/s)
    sample = 2;
    now += 30000;
    t.monitor.tick(now);
    for (let i = 0; i < 30 && !t.monitor.state.get(c.body.id).alerts.dos; i++) await new Promise((r) => setTimeout(r, 20));

    const snap = t.monitor.snapshot();
    const d = snap.devices.find((x) => x.id === c.body.id);
    assert.equal(d.dos_alert, true);
    assert.equal(d.alerts.dos, true);
    assert.ok(d.reasons.some((r) => r.includes('Flood/DoS')));
    assert.equal(d.status, 'warning');
    assert.equal(snap.summary.level, 'critical'); // Bumped to critical due to active emergency alert

    // Event was logged with critical severity
    const events = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events;
    const dosEv = events.find((e) => e.kind === 'dos');
    assert.ok(dosEv);
    assert.equal(dosEv.severity, 'critical');
    assert.match(dosEv.message, /Flood\/DoS/);

    // Sample 3 after 30s: normal packet rate (delta = 300 packets / 30s = 10 pkts/s)
    sample = 3;
    const st = t.monitor.state.get(c.body.id);
    now += 30000;
    st.snmp.pkt.base = { ts: now - 30000, pkt: { tcp: 700000, udp: 250000 } };
    t.monitor.o.snmpFn = async () => ({
      sysDescr: 'RouterOS', sysName: 'rt-sec', uptime: 530, cpu: 10, ram: 20, disk: 5,
      pkt_counters: { tcp: 700200, udp: 250100 },
    });
    t.monitor.tick(now);
    for (let i = 0; i < 30 && t.monitor.state.get(c.body.id).alerts.dos; i++) await new Promise((r) => setTimeout(r, 20));

    const snap2 = t.monitor.snapshot();
    const d2 = snap2.devices.find((x) => x.id === c.body.id);
    assert.equal(d2.dos_alert, false);
    assert.equal(d2.alerts.dos, false);

    const recEv = (await t.api('GET', `/api/events?device=${c.body.id}`)).body.events.find((e) => e.kind === 'dos' && e.severity === 'ok');
    assert.ok(recEv);
  } finally { t.close(); }
});

test('dos: mockDos triggers critical Flood/DoS alert, spikes bandwidth and recovers cleanly', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'router-test-dos', type: 'router', address: '192.168.60.50', check_icmp: false, snmp_enabled: true,
    });
    assert.equal(c.status, 201);
    const devId = c.body.id;

    // Trigger mock DoS
    const r1 = await t.api('POST', `/api/devices/${devId}/mock-dos`, {
      active: true, pps: 60000, bandwidth_mbps: 90, ports: [53, 123], attack_type: 'DNS/NTP UDP Flood (cổng 53, 123)',
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.result.pps, 60000);

    const snap = t.monitor.snapshot();
    const d = snap.devices.find((x) => x.id === devId);
    assert.equal(d.dos_alert, true);
    assert.equal(d.alerts.dos, true);
    assert.equal(d.pkt_rate, 60000);
    assert.equal(d.status, 'warning');
    assert.equal(snap.summary.level, 'critical');

    // Recover
    const r2 = await t.api('POST', `/api/devices/${devId}/mock-dos`, { active: false });
    assert.equal(r2.status, 200);

    const snap2 = t.monitor.snapshot();
    const d2 = snap2.devices.find((x) => x.id === devId);
    assert.equal(d2.dos_alert, false);
    assert.equal(d2.alerts.dos, false);
  } finally { t.close(); }
});

test('agent deep monitoring: SMART failure, Thermal Throttling, and UPS on battery trigger critical events', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'srv-deep', type: 'server', check_icmp: false, check_agent: true,
    });
    assert.equal(c.status, 201);
    const devId = c.body.id;
    const token = (await t.api('GET', `/api/devices/${devId}`)).body.agent_token;

    // Report 1: Normal report with temperature = 50°C, smart passed, power AC
    const r1 = await fetch(`${t.base}/api/agent/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        hostname: 'srv-deep', os: 'Linux', agent_version: '1.1.0',
        cpu: { percent: 35, cores: 8, load1: 0.5 },
        memory: { total: 16e9, used: 8e9, percent: 50 },
        disks: [{ mount: '/', total: 500e9, used: 200e9, percent: 40 }],
        uptime: 1000,
        temperature: 50.0,
        smart: { ok: true, status: 'passed' },
        power: { on_battery: false, battery_percent: 100, status: 'ac' },
      }),
    });
    assert.equal(r1.status, 200);
    t.monitor.startedAt -= 60000;
    t.monitor.evaluate();

    let d = t.monitor.snapshot().devices[0];
    assert.equal(d.temperature, 50.0);
    assert.equal(d.smart.ok, true);
    assert.equal(d.power.on_battery, false);
    assert.equal(d.status, 'up');

    // Report 2: Bad Sector / SMART failure + Thermal Throttling (89°C > 85°C) + On Battery (UPS power loss)
    const r2 = await fetch(`${t.base}/api/agent/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        hostname: 'srv-deep', os: 'Linux', agent_version: '1.1.0',
        cpu: { percent: 40, cores: 8, load1: 0.6 },
        memory: { total: 16e9, used: 8e9, percent: 50 },
        disks: [{ mount: '/', total: 500e9, used: 200e9, percent: 40 }],
        uptime: 1005,
        temperature: 89.0,
        smart: { ok: false, status: 'failing', details: '/dev/sda: Bad Sectors detected' },
        power: { on_battery: true, battery_percent: 65, status: 'discharging' },
      }),
    });
    assert.equal(r2.status, 200);
    t.monitor.evaluate();

    d = t.monitor.snapshot().devices[0];
    assert.equal(d.temperature, 89.0);
    assert.equal(d.alerts.smart, true);
    assert.equal(d.alerts.thermal, true);
    assert.equal(d.alerts.power, true);
    assert.equal(d.status, 'warning');
    assert.equal(t.monitor.snapshot().summary.level, 'critical');

    // Verify critical events logged
    const events = (await t.api('GET', `/api/events?device=${devId}`)).body.events;
    assert.ok(events.some((e) => e.kind === 'smart' && e.severity === 'critical'));
    assert.ok(events.some((e) => e.kind === 'thermal' && e.severity === 'critical'));
    assert.ok(events.some((e) => e.kind === 'power' && e.severity === 'critical'));

    // Verify temp is recorded into metrics history
    const stDev = t.monitor.state.get(devId);
    stDev.lastMetricAt = 0;
    t.monitor._maybeStoreMetric(t.monitor.devices.get(devId), stDev, Date.now() + 35000, true);
    const hist = await t.api('GET', `/api/devices/${devId}/history?range=1h`);
    assert.equal(hist.status, 200);
    const lastPt = hist.body.points[hist.body.points.length - 1];
    assert.equal(lastPt.temp, 89.0);

    // Report 3: Legacy agent payload backward compatibility (no temperature, smart, or power)
    const r3 = await fetch(`${t.base}/api/agent/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        hostname: 'srv-deep', os: 'Linux', agent_version: '0.9.0',
        cpu: { percent: 20, cores: 4, load1: 0.1 },
        memory: { total: 8e9, used: 2e9, percent: 25 },
        disks: [{ mount: '/', total: 100e9, used: 20e9, percent: 20 }],
        uptime: 2000,
      }),
    });
    assert.equal(r3.status, 200);
    t.monitor.evaluate();
    d = t.monitor.snapshot().devices[0];
    assert.equal(d.temperature, null);
    assert.equal(d.smart, null);
    assert.equal(d.power, null);
  } finally { t.close(); }
});

test('ui: dual-screen layout pins KPI cards, provides independent scroll container for devices, and styles thin scrollbars', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const views = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');

  // 1. Custom thin scrollbar styling
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*5px/);
  assert.match(css, /::-webkit-scrollbar-thumb/);

  // 2. Dual screen layout pins KPI section and scrolls device section independently
  assert.match(css, /\.dual-main-pinned\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /\.dual-main-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.dual-filter-bar\s*\{[^}]*position:\s*sticky/);

  // 3. Views template contains pinned KPI wrapper and scrollable device container in dual mode
  assert.ok(views.includes('<div class="dual-main-pinned">'));
  assert.ok(views.includes('<div class="dual-main-scroll" id="dual-main-scroll">'));
  assert.ok(views.includes('id="dev-count-badge"'));
  assert.ok(views.includes('id="dual-badge-groups"'));
  assert.ok(views.includes('id="dual-badge-problems"'));
});

test('i18n & language settings: API supports default_lang in settings and per-user language preference', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    // Default language is 'vi'
    const s0 = await t.api('GET', '/api/settings');
    assert.equal(s0.status, 200);
    assert.equal(s0.body.default_lang, 'vi');

    // Update default_lang to 'en'
    const putSt = await t.api('PUT', '/api/settings', { default_lang: 'en' });
    assert.equal(putSt.status, 200);
    const s1 = await t.api('GET', '/api/settings');
    assert.equal(s1.body.default_lang, 'en');

    // Invalid language is rejected
    const badSt = await t.api('PUT', '/api/settings', { default_lang: 'fr' });
    assert.equal(badSt.status, 400);

    // Per-user language preference via PUT /api/auth/lang
    const putUserLang = await t.api('PUT', '/api/auth/lang', { lang: 'en' });
    assert.equal(putUserLang.status, 200);
    assert.equal(putUserLang.body.lang, 'en');

    const me = await t.api('GET', '/api/auth/me');
    assert.equal(me.body.user.lang, 'en');

    const badUserLang = await t.api('PUT', '/api/auth/lang', { lang: 'invalid' });
    assert.equal(badUserLang.status, 400);
  } finally { t.close(); }
});

test('global continuous alarm & i18n pack: core.js, admin.js, style.css, and README.md include continuous alarm and English pack', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const core = fs.readFileSync(path.join(__dirname, '../public/core.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');

  // 1. Continuous alarm for Critical & High unacknowledged incidents until Acknowledged
  assert.ok(core.includes('M.hasUnackedHighOrCritical = (snap = M.S.snap) =>'));
  assert.ok(core.includes('M.syncAlarmLoop = () =>'));
  assert.match(core, /d\.severity === 'critical' \|\| d\.severity === 'high'/);
  assert.match(core, /setInterval\(\(\) => \{/);
  assert.match(css, /\.icon-btn\.ringing\s*\{/);

  // 2. English language pack & Settings language selector
  assert.ok(core.includes('const I18N_EN = {'));
  assert.ok(core.includes('M.t = (s) =>'));
  assert.ok(core.includes('M.trData = (str) =>'));
  assert.ok(core.includes('M.applyLang = (lang, broadcast = true) =>'));
  assert.ok(core.includes('id="lang-sel"'));
  assert.ok(admin.includes('name="lang"'));
  assert.ok(admin.includes('default_lang: chosenLang'));

  // 3. Bilingual README documentation (Vietnamese + English)
  assert.ok(readme.includes('# Monitoring Platform (English Documentation)'));
  assert.ok(readme.includes('## 1. Server Installation & Startup'));
  assert.ok(readme.includes('## 5. Global Continuous Alarm, Dual-Screen & TV Wallboard'));
});

test('dos: updatePktSlot distinguishes router reboot counter reset from genuine 32-bit rollover', () => {
  const t0 = 1000000;

  // 1. Router reboot scenario: counter was at 150,000 before reboot, then dropped to 120 after 180s
  // Previously this blindly added 2^32 (4,294,967,296) / 180s = ~23,832,593 pkt/s false DoS alert!
  const sReboot = { base: null, rate: null };
  updatePktSlot(sReboot, { tcp: 50000, udp: 150000 }, t0);
  assert.equal(sReboot.rate, null);
  updatePktSlot(sReboot, { tcp: 20, udp: 120 }, t0 + 180000);
  assert.equal(sReboot.rate, null, 'Counter reset after reboot must not produce a bogus 23.8M pkt/s spike');
  assert.deepEqual(sReboot.base.pkt, { tcp: 20, udp: 120 });

  // Next sample 30s after reboot: normal traffic (+60 pkts / 30s = 2 pkt/s)
  updatePktSlot(sReboot, { tcp: 50, udp: 150 }, t0 + 210000);
  assert.equal(sReboot.rate.rate, 2);

  // 2. Genuine 32-bit rollover: counter near 2^32 (4,294,960,000 >= 2^31) wraps to 5,000 over 10s
  const sWrap = { base: null, rate: null };
  updatePktSlot(sWrap, { tcp: 4294960000, udp: 1000 }, t0);
  updatePktSlot(sWrap, { tcp: 5000, udp: 2000 }, t0 + 10000);
  // tcp delta = 5000 + 4294967296 - 4294960000 = 12296; udp delta = 1000 => total = 13296 / 10s = 1329.6 pkt/s
  assert.equal(Math.round(sWrap.rate.rate), 1330);

  // 3. Per-interface 64-bit counter reset (IF-MIB fallback): decreasing 64-bit counter resets cleanly
  const sIf = { base: null, rate: null };
  updatePktSlot(sIf, { tcp: null, udp: null, rows: { 1: [500000, 64], 2: [300000, 64] } }, t0);
  updatePktSlot(sIf, { tcp: null, udp: null, rows: { 1: [100, 64], 2: [50, 64] } }, t0 + 90000);
  assert.equal(sIf.rate, null, '64-bit interface counter reset must not wrap or spike');
});

test('dos: router power-cycle / reboot recovery does not trigger false Flood/DoS alert', async () => {
  let phase = 'before_reboot';
  const t = await boot({
    snmpFn: async () => {
      if (phase === 'down') throw new Error('timeout');
      if (phase === 'before_reboot') {
        return {
          sysDescr: 'RouterOS', sysName: 'Router VM', uptime: 7200, cpu: 8, ram: 22, disk: 10,
          pkt_counters: { tcp: 85000, udp: 240000 },
        };
      }
      if (phase === 'just_rebooted') {
        return {
          sysDescr: 'RouterOS', sysName: 'Router VM', uptime: 18, cpu: 15, ram: 20, disk: 10,
          pkt_counters: { tcp: 15, udp: 45 },
        };
      }
      return {
        sysDescr: 'RouterOS', sysName: 'Router VM', uptime: 48, cpu: 6, ram: 20, disk: 10,
        pkt_counters: { tcp: 30, udp: 60 },
      };
    },
  });

  try {
    await loginAdmin(t);
    const addr = '10.0.0.254';
    t.alive.add(addr);
    const c = await t.api('POST', '/api/devices', {
      name: 'Router VM', type: 'router', address: addr, check_icmp: true, snmp_enabled: true,
    });
    assert.equal(c.status, 201);
    const devId = c.body.id;

    let now = Date.now() + 35000;
    // 1. Initial poll before reboot establishes baseline
    await t.monitor._ping(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    await t.monitor._snmp(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    assert.equal(t.monitor.snapshot().devices[0].status, 'up');

    // 2. Router is powered off for 94s -> goes down
    phase = 'down';
    t.alive.delete(addr);
    now += 4000;
    await t.monitor._ping(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    now += 4000;
    await t.monitor._ping(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    await t.monitor._snmp(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    await t.monitor._snmp(t.monitor.devices.get(devId), t.monitor.state.get(devId), now + 30000);
    assert.equal(t.monitor.snapshot().devices[0].status, 'down');

    // 3. Router boots back up after 94s with counters reset near 0 and uptime = 18s
    phase = 'just_rebooted';
    t.alive.add(addr);
    now += 94000;
    await t.monitor._ping(t.monitor.devices.get(devId), t.monitor.state.get(devId), now);
    await t.monitor._snmp(t.monitor.devices.get(devId), t.monitor.state.get(devId), now + 26000);

    const dAfterReboot = t.monitor.snapshot().devices[0];
    assert.equal(dAfterReboot.status, 'up', 'Router must stay UP after reboot recovery, not warning');
    assert.equal(dAfterReboot.dos_alert, false, 'Must not trigger false Flood/DoS alert on reboot');
    assert.equal(dAfterReboot.alerts.dos, false);

    const events = (await t.api('GET', `/api/events?device=${devId}`)).body.events;
    assert.ok(!events.some((e) => e.kind === 'dos'), 'No false DoS event should be logged on router reboot');

    // 4. Subsequent SNMP poll 30s later computes normal 1 pkt/s rate
    phase = 'post_reboot_2';
    await t.monitor._snmp(t.monitor.devices.get(devId), t.monitor.state.get(devId), now + 56000);
    const dNormal = t.monitor.snapshot().devices[0];
    assert.equal(dNormal.status, 'up');
    assert.equal(dNormal.pkt_rate, 1);
  } finally { t.close(); }
});

test('ai: unified VI/EN templates, JSON parser, and 24h trend pre-calculation', () => {
  const {
    buildIncidentPrompt,
    buildDailyDigestPrompt,
    parseAiJsonResponse,
    computeDeviceTrendSummary,
  } = require('../server/ai');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // 1. Unified Vietnamese & English Incident Prompts
  const ctx = {
    device_name: 'DB-Server-01',
    device_type: 'server',
    address: '10.0.0.10',
    severity: 'critical',
    kind: 'smart',
    reason: 'Lỗi ổ đĩa SMART (Bad Sector / Sắp hỏng)',
    metrics: 'CPU:92%,RAM:85%,Disk:94%,Temp:82C,SMART:BAD_SECTOR',
    trend: 'CPU(avg:70%,max:95%);Disk(now:94%,+3.5%/d,full~1.7d)',
  };

  const pVi = buildIncidentPrompt(ctx, 'vi');
  assert.match(pVi.system, /chuyên gia AI quản trị hạ tầng mạng/);
  assert.match(pVi.user, /\[TEMPLATE_SU_CO_V1\]/);
  assert.match(pVi.user, /Thiet_bi: DB-Server-01 \(Loai: server \| IP: 10\.0\.0\.10\)/);
  assert.ok(pVi.user.length < 300, 'Outbound prompt must remain ultra-compact to save tokens');

  const pEn = buildIncidentPrompt(ctx, 'en');
  assert.match(pEn.system, /You are a senior NOC\/SRE AI assistant/);
  assert.match(pEn.user, /\[INCIDENT_TEMPLATE_V1\]/);
  assert.match(pEn.user, /Device: DB-Server-01 \(Type: server \| IP: 10\.0\.0\.10\)/);

  // 2. Daily Digest Prompts (VI & EN)
  const digestSample = {
    total_events: 14, down_events: 2, warning_events: 9, dos_events: 1, smart_events: 1, thermal_events: 1,
    top_devices: 'DB-Server-01:6(crit/high:5)',
    resource_risks: 'DB-Server-01[Disk:94%(+3.5%/d,full~1.7d),CPUmax:95%]',
  };
  assert.match(buildDailyDigestPrompt(digestSample, 'vi').system, /chuyên gia AI phân tích vận hành/);
  assert.match(buildDailyDigestPrompt(digestSample, 'en').system, /senior NOC\/SRE AI analyst/);

  // 3. Robust JSON response parser (handles markdown code fences and VI/EN keys)
  const parsedEn = parseAiJsonResponse('```json\n{"issue":"Disk SMART failure & 94% usage","cause":"Physical bad sectors on primary volume","solution":"Replace disk and restore RAID","prediction":"Imminent failure within 48h"}\n```');
  assert.equal(parsedEn.issue, 'Disk SMART failure & 94% usage');
  assert.equal(parsedEn.cause, 'Physical bad sectors on primary volume');
  assert.equal(parsedEn.solution, 'Replace disk and restore RAID');
  assert.equal(parsedEn.prediction, 'Imminent failure within 48h');

  const parsedViKeys = parseAiJsonResponse('{"van_de":"Ổ đĩa báo lỗi Bad Sector","nguyen_nhan":"Lão hóa phần cứng","giai_phap":"Thay ổ đĩa mới ngay","du_doan":"Đầy ổ sau 1.7 ngày"}');
  assert.equal(parsedViKeys.issue, 'Ổ đĩa báo lỗi Bad Sector');
  assert.equal(parsedViKeys.prediction, 'Đầy ổ sau 1.7 ngày');

  // Tolerates array-wrapped objects, case insensitivity, and alternative Vietnamese keys
  const parsedArray = parseAiJsonResponse('[{"ISSUE":"CPU Saturation","ROOT_CAUSE":"Stuck loop","GIAI_PHAP":"Restart service","XU_HUONG":"Stable"}]');
  assert.equal(parsedArray.issue, 'CPU Saturation');
  assert.equal(parsedArray.cause, 'Stuck loop');
  assert.equal(parsedArray.solution, 'Restart service');
  assert.equal(parsedArray.prediction, 'Stable');

  // 4. Server-side 24h linear trend calculation (saves sending raw metric arrays)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-ai-'));
  const db = open(path.join(dir, 'm.db'));
  try {
    const now = Date.now();
    db.prepare("INSERT INTO devices(id,name,agent_token,created_at) VALUES(1,'srv','tok',?)").run(now);
    for (let i = 0; i <= 10; i++) {
      const ts = now - (10 - i) * 3600 * 1000; // 10 hours span
      db.prepare('INSERT INTO metrics(device_id,ts,cpu,ram,disk,temp) VALUES(1,?,?,?,?,?)').run(ts, 50 + i * 4, 70, 80 + i * 1.0, 65 + i);
    }
    const trend = computeDeviceTrendSummary(db, 1, now);
    assert.match(trend, /CPU_avg=70%\/max=90%/);
    assert.match(trend, /Disk=90%\(slope=\+24%\/d,full_in~0\.4d\)/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ai: end-to-end incident diagnosis, token-saving cache, settings toggle, and 24h daily log digest', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);

    // Mock external LLM API fetch to verify exact outbound payloads & token counting
    const llmCalls = [];
    t.monitor.ai.fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body);
      llmCalls.push({ url, headers: opts.headers, body });
      const sys = body.messages[0].content;
      const isEn = sys.includes('You are a senior');
      const reply = isEn
        ? {
          issue: 'Critical server incident: Disk > 90% and SMART Bad Sector detected.',
          cause: 'Log rotation failure combined with physical disk surface degradation.',
          solution: '1. Run smartctl -a /dev/sda. 2. Clean /var/log and swap faulty drive.',
          prediction: 'Disk will reach 100% within 24h if not cleaned.',
        }
        : {
          issue: 'Sự cố máy chủ nghiêm trọng: Ổ đĩa > 90% kèm lỗi Bad Sector SMART.',
          cause: 'Tràn log hệ thống kết hợp xuống cấp bề mặt vật lý ổ cứng.',
          solution: '1. Kiểm tra smartctl -a /dev/sda. 2. Dọn /var/log và thay thế ổ đĩa lỗi.',
          prediction: 'Ổ đĩa sẽ đầy 100% trong 24h tới nếu không xử lý.',
        };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 95, completion_tokens: 65 },
        }),
      };
    };

    // 1. Configure AI settings via PUT /api/settings
    const putAi = await t.api('PUT', '/api/settings', {
      default_lang: 'vi',
      ai: {
        enabled: true,
        provider: 'openai',
        api_url: 'https://api.openai.com/v1/chat/completions',
        api_key: 'sk-test-secret-token-12345',
        model: 'gpt-4o-mini',
        auto_incident: true,
        daily_digest_enabled: true,
        daily_digest_time: '23:50',
        cooldown_minutes: 60,
        daily_call_limit: 50,
        max_tokens: 300,
      },
    });
    assert.equal(putAi.status, 200);

    const getSt = (await t.api('GET', '/api/settings')).body;
    assert.equal(getSt.ai.enabled, true);
    assert.equal(getSt.ai.has_api_key, true);
    assert.equal(getSt.ai.api_key, '', 'Raw API token must never be leaked back to client');

    // 2. Test AI Connection & Template Preview in Vietnamese and English
    const testVi = await t.api('POST', '/api/ai/test', { lang: 'vi' });
    assert.equal(testVi.status, 200);
    assert.equal(testVi.body.live_api_called, true);
    assert.match(testVi.body.parsed.issue, /Sự cố máy chủ nghiêm trọng/);
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0].headers.Authorization, 'Bearer sk-test-secret-token-12345');

    const testEn = await t.api('POST', '/api/ai/test', { lang: 'en' });
    assert.equal(testEn.status, 200);
    assert.equal(testEn.body.live_api_called, true);
    assert.match(testEn.body.parsed.issue, /Critical server incident/);
    assert.equal(llmCalls.length, 2);

    // 2b. Verify Gemini provider options (reasoning_effort: none, json_object)
    const testGemini = await t.api('POST', '/api/ai/test', {
      lang: 'vi',
      ai: { provider: 'gemini', model: 'gemini-3.8-flash', api_key: 'test-gemini-key' },
    });
    assert.equal(testGemini.status, 200);
    assert.equal(testGemini.body.live_api_called, true);
    const geminiCall = llmCalls[llmCalls.length - 1];
    assert.equal(geminiCall.body.reasoning_effort, 'none');
    assert.deepEqual(geminiCall.body.response_format, { type: 'json_object' });

    // Truncated token generation (finish_reason = length) surfaces descriptive error
    const savedFetchFn = t.monitor.ai.fetchFn;
    t.monitor.ai.fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ finish_reason: 'length', message: { content: '{"issue":"Truncated...' } }],
        usage: { prompt_tokens: 300, completion_tokens: 15 },
      }),
    });
    const testTruncated = await t.api('POST', '/api/ai/test', {
      lang: 'vi',
      ai: { provider: 'gemini', model: 'gemini-3.8-flash', api_key: 'test-gemini-key' },
    });
    assert.equal(testTruncated.status, 200);
    assert.match(testTruncated.body.api_error, /finish_reason=length/);
    t.monitor.ai.fetchFn = savedFetchFn;

    // 3. Create a Critical Server & a Low-severity Workstation
    const srvRes = await t.api('POST', '/api/devices', {
      name: 'Prod-DB-01', type: 'server', address: '10.0.0.50', check_icmp: false, check_agent: true, severity: 'critical',
    });
    const srvId = srvRes.body.id;

    const lowRes = await t.api('POST', '/api/devices', {
      name: 'Office-PC', type: 'workstation', address: '10.0.0.51', check_icmp: false, check_agent: true, severity: 'low',
    });
    const lowId = lowRes.body.id;

    // 4. Low-severity device has high CPU -> must NOT call AI API (saves tokens!)
    const callsBeforeLow = llmCalls.length;
    const tLow = Date.now();
    t.monitor.ingestAgent(lowId, { cpu: { percent: 96 }, memory: { percent: 40 }, disks: [{ mount: '/', percent: 50 }] }, tLow - 20000);
    t.monitor.evaluate(tLow - 20000);
    t.monitor.ingestAgent(lowId, { cpu: { percent: 96 }, memory: { percent: 40 }, disks: [{ mount: '/', percent: 50 }] }, tLow);
    t.monitor.evaluate(tLow);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(llmCalls.length, callsBeforeLow, 'Low severity device must not trigger automatic AI API calls');

    // 5. Critical server reports Disk > 90% and SMART Bad Sector -> automatically triggers AI analysis!
    const callsBeforeCrit = llmCalls.length;
    const tNow = Date.now();
    t.monitor.ingestAgent(srvId, {
      cpu: { percent: 93 }, memory: { percent: 88 }, disks: [{ mount: '/', percent: 95 }],
      smart: { ok: false, details: 'Bad sector on /dev/sda' },
    }, tNow - 20000);
    t.monitor.evaluate(tNow - 20000);
    t.monitor.ingestAgent(srvId, {
      cpu: { percent: 94 }, memory: { percent: 88 }, disks: [{ mount: '/', percent: 95 }],
      smart: { ok: false, details: 'Bad sector on /dev/sda' },
    }, tNow);
    t.monitor.evaluate(tNow);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(llmCalls.length > callsBeforeCrit, 'Critical server incident must automatically trigger AI API');

    // Verify GET /api/events attaches ai_report directly to the event
    const evList = (await t.api('GET', `/api/events?device=${srvId}`)).body.events;
    const smartEv = evList.find((e) => e.kind === 'smart');
    assert.ok(smartEv && smartEv.ai_report, 'Event must include attached AI diagnosis');
    assert.match(smartEv.ai_report.issue, /Sự cố máy chủ nghiêm trọng/);

    // 6. Fingerprint Deduplication Cache: same incident within 60-min cooldown costs 0 extra API calls!
    const callsBeforeDup = llmCalls.length;
    const dupReport = await t.monitor.ai.analyzeIncident({
      device_id: srvId,
      device_name: 'Prod-DB-01',
      device_type: 'server',
      severity: 'critical',
      kind: 'smart',
      reason: smartEv.message,
    }, t.monitor.settings, { now: tNow + 60000 });
    assert.equal(dupReport.cached, 1, 'Duplicate incident within cooldown must hit cache');
    assert.equal(dupReport.prompt_tokens, 0);
    assert.equal(dupReport.completion_tokens, 0);
    assert.equal(llmCalls.length, callsBeforeDup, 'Cache hit must make 0 external API calls');

    // 7. Switch language to English ("en") -> manual analyze returns English template & response
    await t.api('PUT', '/api/settings', { default_lang: 'en' });
    const analyzeEn = await t.api('POST', '/api/ai/analyze', { event_id: smartEv.id, lang: 'en' });
    assert.equal(analyzeEn.status, 200);
    assert.equal(analyzeEn.body.report.lang, 'en');
    assert.match(analyzeEn.body.report.issue, /Critical server incident/);

    // 8. End-of-Day 24h Log Collection & Digest (Zero agent changes required)
    const digestRes = await t.api('POST', '/api/ai/daily-digest', { lang: 'en' });
    assert.equal(digestRes.status, 200);
    assert.equal(digestRes.body.report.kind, 'daily');
    assert.equal(digestRes.body.report.device_name, 'End-of-Day System Digest (24h)');

    // 9. Turn OFF AI API calls (enabled: false) -> stops all external LLM calls immediately
    await t.api('PUT', '/api/settings', { ai: { enabled: false } });
    const callsWhenDisabled = llmCalls.length;
    const localDigest = await t.api('POST', '/api/ai/daily-digest', { lang: 'vi' });
    assert.equal(localDigest.status, 200);
    assert.equal(localDigest.body.report.source, 'heuristic');
    assert.equal(llmCalls.length, callsWhenDisabled, 'When AI is disabled, 0 external API calls are made');
  } finally { t.close(); }
});

test('ai: smart incident filter excludes ping/down/printers, deep technical telemetry logs and GET /api/ai/technical-logs', async () => {
  const { isAiAnalyzableIncident, fmtBytesHuman, fmtDurHuman } = require('../server/ai');

  // 1. Formatters
  assert.equal(fmtBytesHuman(1024), '1.0 KB');
  assert.equal(fmtBytesHuman(1048576 * 50), '50.0 MB');
  assert.equal(fmtBytesHuman(1073741824 * 2.5), '2.50 GB');
  assert.equal(fmtDurHuman(90), '1m 30s');
  assert.equal(fmtDurHuman(3665), '1h 1m');
  assert.equal(fmtDurHuman(90000), '1d 1h 0m');

  // 2. Unit Tests for isAiAnalyzableIncident
  // Rejection cases:
  // a) Disconnection / ICMP ping / Agent silence
  assert.equal(isAiAnalyzableIncident({ kind: 'down', device_type: 'server', device_severity: 'critical', reason: 'Không phản hồi ICMP' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'down', device_type: 'router', device_severity: 'critical', reason: 'Agent không gửi dữ liệu (21s)' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'critical', reason: 'Agent không gửi dữ liệu (21s)' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'router', device_severity: 'critical', reason: 'Không phản hồi ICMP sau 2 lần thử' }), false);

  // b) Printer devices & consumable issues
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'printer', device_severity: 'high', reason: 'Hộp mực sắp hết (Black Toner: 5%)' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'printer_toner', device_type: 'printer', device_severity: 'critical', reason: 'Hết mực in hoàn toàn' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'printer', device_severity: 'high', reason: 'Kẹt giấy khay 1 (Paper Jam)' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'high', reason: 'Sự cố máy in / drum' }), false);

  // c) Recovery & Audit events
  assert.equal(isAiAnalyzableIncident({ kind: 'up', device_type: 'server', device_severity: 'critical', reason: 'Server recovered after 45s' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', event_severity: 'ok', reason: 'Đã hoạt động bình thường trở lại' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'audit', device_type: 'server', device_severity: 'critical', reason: 'User logged in' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'none', reason: 'CPU cao: 95%' }), false);

  // d) Low or Medium severity devices in normal mode
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'low', reason: 'CPU cao: 95%' }), false);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'medium', reason: 'CPU cao: 95%' }), false);

  // Acceptance cases (Positive whitelist):
  // e) SMART Bad Sector, Flood/DoS, Thermal, UPS on High/Critical devices
  assert.equal(isAiAnalyzableIncident({ kind: 'smart', device_type: 'server', device_severity: 'critical', reason: 'Lỗi ổ đĩa SMART (Bad Sector)' }), true);
  assert.equal(isAiAnalyzableIncident({ kind: 'dos', device_type: 'router', device_severity: 'critical', reason: 'Nghi vấn tấn công Flood/DoS (25.000 pkt/s)' }), true);
  assert.equal(isAiAnalyzableIncident({ kind: 'thermal', device_type: 'server', device_severity: 'high', reason: 'Nhiệt độ CPU vượt ngưỡng: 92°C (Thermal Throttling)' }), true);
  assert.equal(isAiAnalyzableIncident({ kind: 'power', device_type: 'server', device_severity: 'critical', reason: 'Mất điện lưới, UPS đang chạy pin (Pin: 42%)' }), true);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'high', reason: 'CPU cao: 94% (> 90%)' }), true);
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'critical', reason: 'Ổ đĩa cao: 96% (/var/log đầy)' }), true);

  // f) Force / Manual inspection overrides device severity
  assert.equal(isAiAnalyzableIncident({ kind: 'warning', device_type: 'server', device_severity: 'low', cpu: 95 }, { force: true }), true);

  // 3. Integration & End-to-End Verification with Live Monitor & API
  const t = await boot();
  try {
    await loginAdmin(t);

    const llmCalls = [];
    t.monitor.ai.fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body);
      llmCalls.push({ url, headers: opts.headers, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ issue: 'Mock issue', cause: 'Mock cause', solution: 'Mock solution', prediction: 'Mock prediction' }) } }],
          usage: { prompt_tokens: 50, completion_tokens: 40 },
        }),
      };
    };

    await t.api('PUT', '/api/settings', {
      default_lang: 'vi',
      ai: { enabled: true, provider: 'openai', api_key: 'sk-test-token-telemetry', auto_incident: true },
    });

    // Create a Critical Router (ICMP + Agent) and a Critical Printer
    const rtr = (await t.api('POST', '/api/devices', {
      name: 'Core-Router-01', type: 'router', address: '10.0.0.1', check_icmp: true, severity: 'critical',
    })).body;
    t.alive.add('10.0.0.1');

    const prt = (await t.api('POST', '/api/devices', {
      name: 'Office-HP-Laser', type: 'printer', address: '10.0.0.2', check_icmp: false, severity: 'critical',
    })).body;

    const srv = (await t.api('POST', '/api/devices', {
      name: 'Storage-Server-01', type: 'server', address: '10.0.0.3', check_icmp: false, check_agent: true, severity: 'critical',
    })).body;

    // A) Critical router goes DOWN via ICMP failure
    t.monitor.tick(Date.now());
    await new Promise((r) => setTimeout(r, 20));
    t.alive.delete('10.0.0.1');
    t.monitor.tick(Date.now() + 5000);
    await new Promise((r) => setTimeout(r, 20));
    t.monitor.tick(Date.now() + 10000);
    await new Promise((r) => setTimeout(r, 20));

    const rtrDev = t.monitor.snapshot().devices.find((d) => d.id === rtr.id);
    assert.equal(rtrDev.status, 'down');
    assert.equal(llmCalls.length, 0, 'Ping failure / down status must NEVER trigger AI analysis');

    // B) Printer triggers toner / paper jam alert
    t.monitor._event(t.monitor.devices.get(prt.id), 'warning', 'high', 'Hộp mực sắp hết (Black 0%)');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(llmCalls.length, 0, 'Printer consumables must NEVER trigger AI analysis');

    // C) Storage server reports SMART bad sector & CPU 94% -> Genuine technical incident triggers AI
    const now = Date.now();
    t.monitor.ingestAgent(srv.id, {
      hostname: 'srv-storage-prod',
      os: 'Linux 6.8.0-45-generic #45-Ubuntu SMP',
      cores: 8,
      load1: 7.85,
      uptime: 86400 * 15,
      cpu: { percent: 94 },
      memory: { total: 34359738368, used: 28991029248, percent: 84 },
      disks: [
        { mount: '/', total: 107374182400, used: 42949672960, percent: 40 },
        { mount: '/data', total: 4398046511104, used: 4178144185548, percent: 95 },
      ],
      smart: { ok: false, status: 'BAD_SECTOR', details: 'Raw Read Error Rate exceeded threshold on /dev/sdb' },
      net: { in_bytes: 52428800, out_bytes: 83886080 },
    }, now - 20000);
    t.monitor.evaluate(now - 20000);

    t.monitor.ingestAgent(srv.id, {
      hostname: 'srv-storage-prod',
      os: 'Linux 6.8.0-45-generic #45-Ubuntu SMP',
      cores: 8,
      load1: 7.92,
      uptime: 86400 * 15 + 20,
      cpu: { percent: 94 },
      memory: { total: 34359738368, used: 28991029248, percent: 84 },
      disks: [
        { mount: '/', total: 107374182400, used: 42949672960, percent: 40 },
        { mount: '/data', total: 4398046511104, used: 4178144185548, percent: 95 },
      ],
      smart: { ok: false, status: 'BAD_SECTOR', details: 'Raw Read Error Rate exceeded threshold on /dev/sdb' },
      net: { in_bytes: 52428800 + 10485760, out_bytes: 83886080 + 20971520 },
    }, now);
    t.monitor.evaluate(now);
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(llmCalls.length >= 1, 'Genuine hardware SMART incident must trigger AI analysis');
    assert.match(llmCalls[0].body.messages[1].content, /Tech_Logs:/, 'LLM prompt must include compact tech_summary');

    // D) Test GET /api/ai/technical-logs endpoint
    // 1. Unauthenticated request gets 401
    const unauthClient = t.createClient();
    const unauthRes = await unauthClient('GET', '/api/ai/technical-logs?device_id=' + srv.id);
    assert.equal(unauthRes.status, 401);

    // 2. Missing parameters gets 400
    const missingRes = await t.api('GET', '/api/ai/technical-logs');
    assert.equal(missingRes.status, 400);

    // 3. Non-existent device/event gets 404
    const notFoundRes = await t.api('GET', '/api/ai/technical-logs?device_id=999999');
    assert.equal(notFoundRes.status, 404);

    // 4. Query by device_id in Vietnamese
    const techVi = await t.api('GET', `/api/ai/technical-logs?device_id=${srv.id}&lang=vi`);
    assert.equal(techVi.status, 200);
    assert.equal(techVi.body.ok, true);
    assert.equal(techVi.body.device_id, srv.id);
    assert.equal(techVi.body.device_name, 'Storage-Server-01');
    assert.match(techVi.body.log_text, /LOGS KỸ THUẬT CHẨN ĐOÁN HỆ THỐNG & MẠNG/);
    assert.match(techVi.body.log_text, /Linux 6\.8\.0-45-generic/);
    assert.match(techVi.body.log_text, /Cấu hình CPU   : 8 nhân/);
    assert.match(techVi.body.log_text, /\/data : 95%/);
    assert.match(techVi.body.log_text, /SMART_DISK_ERR=true/);
    assert.match(techVi.body.log_text, /YÊU CẦU CHẨN ĐOÁN DÀNH CHO AI CHATBOX/);
    assert.ok(techVi.body.tech_summary.includes('Cores=8'));
    assert.ok(techVi.body.tech_summary.includes('Mounts=['));

    // 5. Query by event_id in English
    const evList = (await t.api('GET', `/api/events?device=${srv.id}`)).body.events;
    const smartEv = evList.find((e) => e.kind === 'smart');
    assert.ok(smartEv, 'Smart event must be recorded in events table');

    const techEn = await t.api('GET', `/api/ai/technical-logs?event_id=${smartEv.id}&lang=en`);
    assert.equal(techEn.status, 200);
    assert.equal(techEn.body.ok, true);
    assert.match(techEn.body.log_text, /TECHNICAL DIAGNOSTIC TELEMETRY & LOGS FOR AI ANALYSIS/);
    assert.match(techEn.body.log_text, /SMART_ERR=true/);
    assert.match(techEn.body.log_text, /\[6\. AI DIAGNOSTIC PROMPT\]/);
  } finally { t.close(); }
});

test('events & ai tab navigation: router supports #/events and #/events/ai, views.js isolates errors to #ev-body', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const coreJs = fs.readFileSync(path.join(__dirname, '../public/core.js'), 'utf8');
  const viewsJs = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');

  // Verify regex routes in core.js
  assert.match(coreJs, /\[\/\^#\\\/events\(\?:\\\/\(ai\|events\)\)\?\$\/,\s*'events'\]/);

  // Test regex directly
  const evRouteRe = /^#\/events(?:\/(ai|events))?$/;
  assert.ok(evRouteRe.test('#/events'));
  assert.equal(evRouteRe.exec('#/events')[1], undefined);
  assert.ok(evRouteRe.test('#/events/ai'));
  assert.equal(evRouteRe.exec('#/events/ai')[1], 'ai');
  assert.ok(evRouteRe.test('#/events/events'));
  assert.equal(evRouteRe.exec('#/events/events')[1], 'events');
  assert.equal(evRouteRe.test('#/events/other'), false);

  // Verify admin.js redirects to #/events/ai
  assert.match(adminJs, /location\.hash = '#\/events\/ai'/);

  // Verify views.js has error handling in load() so failures stay within #ev-body
  assert.match(viewsJs, /if \(\$\('#ev-body'\)\) \{\s*\$\('#ev-body'\)\.innerHTML = `<div class="panel err"/);

  // Verify views.js clears interval before re-scheduling to prevent timer leaks
  assert.match(viewsJs, /clearInterval\(this\.t\);/);

  // Verify event row click-to-toggle AI report, state persistence, and backwards compatibility
  assert.match(viewsJs, /class="ev-row \$\{hasAi \? 'has-ai' : ''\} \$\{hasAi && isHidden \? 'ai-closed' : ''\}"/);
  assert.match(viewsJs, /<tr id="ai-ev-row-\$\{e\.id\}" class="\$\{isHidden \? 'hidden' : ''\}">/);
  assert.match(viewsJs, /M\.isAiRowHidden\s*=\s*\(id\)\s*=>/);
  assert.match(viewsJs, /M\.setAiRowHidden\s*=\s*\(id,\s*hidden\)\s*=>/);
  assert.match(viewsJs, /localStorage\.setItem\('hidden_ai_events',/);
  assert.match(viewsJs, /const evRow = ev\.target\.closest\('tr\.ev-row\.has-ai'\);/);
  assert.match(viewsJs, /if \(ev\.target\.closest\('a, button, input, textarea, select'\)\) return;/);
  assert.match(viewsJs, /const toggleBtn = ev\.target\.closest\('\[data-ai-toggle\]'\);/);
  assert.match(viewsJs, /M\.setAiRowHidden\(id, isHidden\);/);
  assert.match(viewsJs, /M\.setAiRowHidden\(id, false\);/);

  const styleCss = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(styleCss, /tr\.ev-row\.has-ai\s*\{[^}]*cursor:\s*pointer;/);

  // Functional simulation of eventsTable with hiddenAi state persistence
  const mockStorage = new Map();
  const mockLocalStorage = {
    getItem: (k) => mockStorage.get(k) || null,
    setItem: (k, v) => mockStorage.set(k, String(v)),
  };
  const mockDoc = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const mockM = {
    S: { lang: 'vi', user: { role: 'admin' } },
    fmtTime: () => '12:00:00',
    isAiEligibleEvent: () => true,
    renderAiReportCard: () => '<div class="ai-card">Diagnosis</div>',
  };
  const fn = new Function('M', 'localStorage', 'document', 'esc', 't', 'tr', '$', `
    ${viewsJs.slice(viewsJs.indexOf('const _hiddenAiSet = new Set();'), viewsJs.indexOf('document.addEventListener('))}
    return { eventsTable: M.eventsTable, setAiRowHidden: M.setAiRowHidden, isAiRowHidden: M.isAiRowHidden };
  `);
  const mod = fn(mockM, mockLocalStorage, mockDoc, (x) => x, (x) => x, (x) => x, () => null);

  const testEvent = { id: 101, ts: Date.now(), kind: 'dos', severity: 'critical', message: 'DoS alert', ai_report: { id: 1, issue: 'DoS' } };

  // 1. By default, event table renders AI card visible
  const htmlOpen = mod.eventsTable([testEvent], true);
  assert.match(htmlOpen, /<tr id="ai-ev-row-101" class="">/);
  assert.doesNotMatch(htmlOpen, /ai-closed/);

  // 2. When hidden, event table renders AI card with class="hidden" and ev-row with ai-closed
  mod.setAiRowHidden(101, true);
  assert.equal(mockStorage.get('hidden_ai_events'), '[101]');
  assert.equal(mod.isAiRowHidden(101), true);

  const htmlHidden = mod.eventsTable([testEvent], true);
  assert.match(htmlHidden, /<tr id="ai-ev-row-101" class="hidden">/);
  assert.match(htmlHidden, /class="ev-row has-ai ai-closed"/);

  // 3. When unhidden, it switches back to open
  mod.setAiRowHidden(101, false);
  assert.equal(mockStorage.get('hidden_ai_events'), '[]');
  assert.equal(mod.isAiRowHidden(101), false);
  const htmlReopened = mod.eventsTable([testEvent], true);
  assert.match(htmlReopened, /<tr id="ai-ev-row-101" class="">/);
  assert.doesNotMatch(htmlReopened, /ai-closed/);

  // 4. Verify Copy Logs handler order & card button integration
  const copyLogIdx = viewsJs.indexOf("const copyLogBtn = ev.target.closest('[data-ai-copy-logs]');");
  const evRowIdx = viewsJs.indexOf("const evRow = ev.target.closest('tr.ev-row.has-ai');");
  assert.ok(copyLogIdx !== -1 && evRowIdx !== -1, 'Both copyLogBtn and evRow handlers must exist');
  assert.ok(copyLogIdx < evRowIdx, 'copyLogBtn handler MUST execute BEFORE evRow handler so event row click guard does not swallow copy logs');

  assert.match(viewsJs, /data-ai-copy-logs="\$\{r\.event_id \|\| ''\}"/);
  assert.match(viewsJs, /if \(isEligible \|\| hasAi\) \{\s*aiBtns\.push\(`<button type="button" class="ai-badge tech-copy" data-ai-copy-logs="\$\{e\.id\}"/);
});

test('ai: manual forced incident analysis, down device diagnosis, reasoning models, and error resilience', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);

    // 1. Enable AI with Groq custom provider and reasoning model (e.g. openai/gpt-oss-120b)
    const llmCalls = [];
    t.monitor.ai.fetchFn = async (url, opts) => {
      const body = JSON.parse(opts.body);
      llmCalls.push({ url, headers: opts.headers, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                issue: `AI Diagnosis for ${body.model}`,
                cause: 'Network saturation or interface down',
                solution: '1. Check switch port. 2. Restart interface.',
                prediction: 'Service will stabilize once interface is restored.',
              }),
            },
          }],
          usage: { prompt_tokens: 350, completion_tokens: 280 },
        }),
      };
    };

    await t.api('PUT', '/api/settings', {
      ai: {
        enabled: true,
        provider: 'custom',
        api_url: 'https://api.groq.com/openai/v1/chat/completions',
        api_key: 'gsk_test_key_mock_123',
        model: 'openai/gpt-oss-120b',
        max_tokens: 800,
      },
    });

    // 2. Create a server device that is currently marked 'down'
    const createRes = await t.api('POST', '/api/devices', {
      name: 'srv-down-test',
      type: 'server',
      address: '10.0.0.99',
      check_icmp: 1,
      severity: 'critical',
    });
    const devId = createRes.body.id;
    const dev = t.monitor.devices.get(devId);
    const st = t.monitor.state.get(devId);
    st.status = 'down'; // Simulate device is down right now

    // 3. Insert a critical DoS event and a Down event for this device
    const now = Date.now();
    const evDosId = t.monitor.db.prepare(
      "INSERT INTO events(ts, device_id, device_name, kind, severity, message) VALUES(?, ?, ?, 'dos', 'critical', 'Nghi ngờ tấn công Flood/DoS (15.000 gói/s)')"
    ).run(now - 60000, devId, 'srv-down-test').lastInsertRowid;

    const evDownId = t.monitor.db.prepare(
      "INSERT INTO events(ts, device_id, device_name, kind, severity, message) VALUES(?, ?, ?, 'down', 'critical', 'srv-down-test mất kết nối: Không ping được (ICMP)')"
    ).run(now - 30000, devId, 'srv-down-test').lastInsertRowid;

    // 4. Test "Phân tích AI" on Event in Events Tab for a DoS event even though device is currently DOWN
    const resDos = await t.api('POST', '/api/ai/analyze', { event_id: Number(evDosId), lang: 'vi' });
    assert.equal(resDos.status, 200);
    assert.ok(resDos.body.report, 'Report must NOT be null when analyzing DoS event for down device');
    assert.equal(resDos.body.report.event_id, Number(evDosId));
    assert.equal(resDos.body.report.source, 'ai');
    assert.match(resDos.body.report.issue, /AI Diagnosis for openai\/gpt-oss-120b/);

    // Verify reasoning_effort was passed as 'low' for Groq with reasoning model
    const lastCall1 = llmCalls[llmCalls.length - 1];
    assert.equal(lastCall1.body.reasoning_effort, 'low', 'Groq with reasoning model must set reasoning_effort=low');
    assert.equal(lastCall1.body.response_format.type, 'json_object');
    assert.ok(lastCall1.body.max_tokens >= 800, 'Effective max_tokens for reasoning model must be at least 800');

    // 5. Test "Phân tích AI" on a Down event
    const resDown = await t.api('POST', '/api/ai/analyze', { event_id: Number(evDownId), lang: 'vi' });
    assert.equal(resDown.status, 200);
    assert.ok(resDown.body.report, 'Report must NOT be null when analyzing Down event');
    assert.equal(resDown.body.report.event_id, Number(evDownId));
    assert.equal(resDown.body.report.source, 'ai');

    // 6. Test "Gửi AI Phân tích ngay" from Technical Logs modal (device_id only, no event_id)
    const resTechModal = await t.api('POST', '/api/ai/analyze', { device_id: devId, lang: 'vi' });
    assert.equal(resTechModal.status, 200);
    assert.ok(resTechModal.body.report, 'Report must NOT be null when sending from Technical Logs modal');
    assert.equal(resTechModal.body.report.device_id, devId);

    // 7. Verify prompt preview in /api/ai/test also includes model and passes
    const testAiRes = await t.api('POST', '/api/ai/test', {
      ai: {
        provider: 'custom',
        api_url: 'https://api.groq.com/openai/v1/chat/completions',
        api_key: 'gsk_test_key_mock_123',
        model: 'openai/gpt-oss-120b',
        max_tokens: 800,
      },
    });
    assert.equal(testAiRes.status, 200);
    assert.equal(testAiRes.body.live_api_called, true);
    assert.equal(testAiRes.body.model, 'openai/gpt-oss-120b');
  } finally { t.close(); }
});

test('ui theme neon: high-visibility NOC optimizations for tags, status highlights, bold typography and backward compatibility', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const views = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');

  // 1. Base .sev-badge styling: padding, rounded corners, bold, accessible across all themes
  assert.match(css, /\.sev-badge\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.sev-badge\s*\{[^}]*padding:\s*3px\s+10px/);
  assert.match(css, /\.sev-badge\s*\{[^}]*border-radius:\s*6px/);
  assert.match(css, /\.sev-badge\s*\{[^}]*font-weight:\s*700/);

  // 2. High-visibility theme Neon optimizations for NOC operators
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\s*\{[^}]*font-weight:\s*800/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\s*\{[^}]*font-size:\s*13px/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\s*\{[^}]*text-shadow:\s*none/);

  // 3. Highlight categories: "Mất kết nối" (critical / ev-down) & "Phục hồi" (ok / ev-up)
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\.critical/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\.ev-down/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\.ok/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.sev-badge\.ev-up/);

  // 4. Tile status tag (.tile .t-state) and Hero detail header (.hero .h-state)
  assert.match(css, /\.tile\s+\.t-state\s*\{[^}]*border-radius/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.tile\s+\.t-state/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.tile\.down\s+\.t-state/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.tile\.up\s+\.t-state/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.hero\s+\.h-state\s*\{[^}]*font-weight:\s*800/);

  // 5. Views integration: M.eventsTable attaches ev-kind classes and M.showKpiModal has consistent badges
  assert.match(views, /<span class="sev-badge \$\{badge\(e\)\} ev-\$\{e\.kind\}">/);
  assert.match(views, /<span class="sev-badge critical ev-down">/);
  assert.match(views, /<span class="sev-badge ok ev-up">/);
});

test('ui overview: compact device tile height and single non-duplicated AP wireless info', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const viewsJs = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');

  // 1. CSS optimizations for moderate, compact device tile height & two-margin justification
  assert.match(css, /\.tile\s*\{[^}]*padding:\s*9px\s+12px/);
  assert.match(css, /\.tile\s+\.t-sub\s*\{[^}]*font-size:\s*11\.5px/);
  assert.match(css, /\.tile\s+\.t-sub\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(css, /\.tile\s+\.t-sub\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.tile\s+\.t-sub\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.tile\s+\.t-sub\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.tile\s+\.t-sub-left\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.tile\s+\.t-sub-right\s*\{[^}]*text-align:\s*right/);
  assert.match(css, /\.tile\s+\.bars\s*\{[^}]*margin-top:\s*6px/);
  assert.match(css, /:root\[data-theme="neon"\]\s+\.tile\s+\.t-sub/);

  // 2. Evaluation of M.tile for AP devices: single non-duplicated line "2 SSID - 1 client"
  const M = {
    esc: (s) => String(s || ''),
    $: () => null,
    $$: () => [],
    t: (s) => s,
    trData: (s) => s,
    views: {},
    S: { lang: 'vi', settings: { thresholds: { cpu: 85, ram: 85, disk: 90 } } },
    statusClass: (d) => d.status || 'up',
    ICON: { ap: '📡', server: '🖥️' },
    STATE_NAME: { up: 'Online', down: 'Mất kết nối', warning: 'Cảnh báo' },
    fmtDur: () => '2h',
  };

  const sandbox = {
    M,
    window: { M },
    document: { addEventListener: () => {} },
    localStorage: { getItem: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(viewsJs, sandbox);

  // AP with 2 SSID and 1 client (exact user test case)
  const apHtml = sandbox.M.tile({
    id: 10,
    type: 'ap',
    name: 'AP-Alcatel',
    address: '192.168.1.50',
    status: 'up',
    rtt: 2,
    total_ssids: 2,
    total_clients: 1,
    uptime: 3600,
    since: Date.now() - 3600000,
  });

  // Must contain single unified info "2 SSID - 1 client" on left, uptime on right
  assert.ok(apHtml.includes('2 SSID - 1 client'));
  assert.ok(apHtml.includes('<span class="t-sub-left">192.168.1.50 · 2 SSID - 1 client</span>'));
  assert.ok(apHtml.includes('<span class="t-sub-right">up 2h</span>'));
  // Must NOT duplicate with .bar-ap box
  assert.ok(!apHtml.includes('bar-ap'));
  assert.ok(!apHtml.includes('class="bars"'));
  // Must NOT display ping latency (ms) on tile
  assert.ok(!apHtml.includes('2 ms'));
  assert.ok(!apHtml.includes(' ms'));

  // AP with CPU and RAM (e.g. Cisco/Mikrotik): CPU and RAM bars present, but no bar-ap
  const apWithCpuHtml = sandbox.M.tile({
    id: 11,
    type: 'ap',
    name: 'AP-Cisco',
    address: '192.168.1.51',
    status: 'up',
    rtt: 3,
    total_ssids: 4,
    total_clients: 25,
    cpu: 15,
    ram: 40,
    uptime: 7200,
    since: Date.now() - 7200000,
  });

  assert.ok(apWithCpuHtml.includes('4 SSID - 25 client'));
  assert.ok(apWithCpuHtml.includes('<span class="t-sub-left">192.168.1.51 · 4 SSID - 25 client</span>'));
  assert.ok(apWithCpuHtml.includes('<span class="t-sub-right">up 2h</span>'));
  assert.ok(!apWithCpuHtml.includes('bar-ap'));
  assert.ok(apWithCpuHtml.includes('class="bars"'));
  assert.ok(apWithCpuHtml.includes('CPU 15%'));
  assert.ok(apWithCpuHtml.includes('RAM 40%'));
  assert.ok(!apWithCpuHtml.includes('3 ms'));

  // Standard server device tile: address on left, uptime on right, justified to both margins
  const serverHtml = sandbox.M.tile({
    id: 12,
    type: 'server',
    name: 'App-Server-01',
    address: '10.0.0.10',
    status: 'up',
    rtt: 1.2,
    cpu: 25,
    ram: 60,
    uptime: 86400,
    since: Date.now() - 86400000,
  });
  assert.ok(serverHtml.includes('10.0.0.10 · up 2h'));
  assert.ok(serverHtml.includes('<span class="t-sub-left">10.0.0.10</span>'));
  assert.ok(serverHtml.includes('<span class="t-sub-right">up 2h</span>'));
  assert.ok(!serverHtml.includes('1.2 ms'));
  assert.ok(!serverHtml.includes(' ms'));
});

test('ui events: separate message text and standardized .event-actions container for AI and Copy Logs buttons', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  const viewsJs = fs.readFileSync(path.join(__dirname, '../public/views.js'), 'utf8');

  // 1. CSS rules for event-actions flex container and event-msg
  assert.match(css, /\.event-msg\s*\{[^}]*line-height/);
  assert.match(css, /\.event-actions\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.event-actions\s*\{[^}]*gap:\s*8px/);
  assert.match(css, /\.event-actions\s*\{[^}]*align-items:\s*center/);
  assert.match(css, /\.event-actions\s*\{[^}]*margin-top:\s*6px/);
  assert.match(css, /\.event-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.event-actions\s+\.ai-badge\s*\{[^}]*margin-left:\s*0/);

  // 2. Evaluation of M.eventsTable rendering
  const M = {
    esc: (s) => String(s || ''),
    $: () => null,
    $$: () => [],
    t: (s) => s,
    trData: (s) => s,
    views: {},
    S: { lang: 'vi', user: { role: 'admin' }, settings: { thresholds: {} } },
    fmtTime: () => '10:00:00',
    isAiEligibleEvent: (e) => e.kind !== 'up' && e.kind !== 'audit',
    isAiRowHidden: () => true,
    renderAiReportCard: () => '<div>AI Card</div>',
  };

  const sandbox = {
    M,
    window: { M },
    document: { addEventListener: () => {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(viewsJs, sandbox);

  // Event with action buttons (eligible for AI analyze & copy logs)
  const critEvent = {
    id: 101,
    device_id: 1,
    device_name: 'Core-Switch',
    kind: 'dos',
    severity: 'critical',
    message: 'Nghi ngờ tấn công Flood/DoS',
    ts: Date.now(),
  };

  const tblHtml = sandbox.M.eventsTable([critEvent], true);
  // Verify message is separated into .event-msg
  assert.ok(tblHtml.includes('<div class="event-msg">Nghi ngờ tấn công Flood/DoS</div>'));
  // Verify action buttons are grouped into .event-actions
  assert.ok(tblHtml.includes('<div class="event-actions">'));
  assert.ok(tblHtml.includes('data-ai-analyze="101"'));
  assert.ok(tblHtml.includes('data-ai-copy-logs="101"'));

  // Event with existing AI diagnosis
  const aiEvent = {
    id: 102,
    device_id: 1,
    device_name: 'Core-Switch',
    kind: 'down',
    severity: 'critical',
    message: 'Mất kết nối ICMP',
    ts: Date.now(),
    ai_report: { id: 1, issue: 'Down' },
  };
  const aiTblHtml = sandbox.M.eventsTable([aiEvent], false);
  assert.ok(aiTblHtml.includes('<div class="event-msg">Mất kết nối ICMP</div>'));
  assert.ok(aiTblHtml.includes('<div class="event-actions">'));
  assert.ok(aiTblHtml.includes('data-ai-toggle="102"'));
  assert.ok(aiTblHtml.includes('data-ai-copy-logs="102"'));

  // Event without actions (audit / system)
  const auditEvent = {
    id: 103,
    device_id: 1,
    device_name: 'Core-Switch',
    kind: 'audit',
    severity: 'none',
    message: 'Khởi động lại hệ thống thành công',
    ts: Date.now(),
  };
  const auditTblHtml = sandbox.M.eventsTable([auditEvent], false);
  assert.ok(auditTblHtml.includes('<div class="event-msg">Khởi động lại hệ thống thành công</div>'));
  assert.ok(!auditTblHtml.includes('<div class="event-actions">'));
});

