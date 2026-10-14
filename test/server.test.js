'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../server/db');
const { Monitor, updateNetSlot } = require('../server/monitor');
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

    // Không kéo summary.level lên warning/critical/low
    assert.equal(snap.summary.level, 'ok');
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


