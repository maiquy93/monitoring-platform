'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../server/snmp-engine');
const walkfile = require('../server/snmp-walkfile');
const { startReplay, loadFixture } = require('./helpers/snmp-replay');

const poll = (r, extra = {}) => engine.pollDevice({ host: r.host, port: r.port, community: 'public', ...extra });

// ---- dữ liệu THẬT: router MikroTik 192.168.60.50 (RouterOS x86 7.23.8) ------
test('mikrotik (real walk): auto-detected, cpu/ram/disk/uptime read correctly', async () => {
  const r = await startReplay('mikrotik-routeros-x86');
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'mikrotik');
    assert.equal(out.profile.auto, true);
    assert.equal(out.cpu, 1);
    assert.equal(out.ram, 15.4);
    assert.equal(out.disk, 0.3);
    assert.equal(out.uptime, 13298);
    assert.equal(out.diag.cpu.ok, true);
    assert.match(out.sysDescr, /RouterOS/);
    const extra = Object.fromEntries(out.extra.map((e) => [e.key, e.value]));
    assert.equal(extra.routeros_version, '7.23.8');
  } finally { r.close(); }
});

test('generic profile (real MikroTik walk): same CPU/RAM/disk through HOST-RESOURCES; optional toner reports no_rows', async () => {
  const r = await startReplay('mikrotik-routeros-x86');
  try {
    const out = await poll(r, { profile: 'generic' });
    assert.equal(out.profile.id, 'generic');
    assert.equal(out.profile.auto, false);
    assert.equal(out.cpu, 1); assert.equal(out.ram, 15.4); assert.equal(out.disk, 0.3);
    assert.equal(out.diag.toner.ok, false);
    assert.equal(out.diag.toner.code, 'no_rows');
    assert.equal(out.diag.toner.optional, true);
  } finally { r.close(); }
});

test('unknown manual profile falls back to auto-detection and is reported', async () => {
  const r = await startReplay('mikrotik-routeros-x86');
  try {
    const out = await poll(r, { profile: 'khong-ton-tai' });
    assert.equal(out.profile.missing, true);
    assert.equal(out.profile.requested, 'khong-ton-tai');
    assert.equal(out.profile.id, 'mikrotik');
  } finally { r.close(); }
});

test('every profile has a real fixture it was verified with (or is explicitly unverified)', async () => {
  for (const p of engine.listProfiles()) {
    const metrics = engine.profiles().byId.get(p.id).metrics;
    const dir = path.join(__dirname, 'fixtures');
    if (!p.verified_with.length) {
      // Chưa có walk thật: chỉ chấp nhận khi hồ sơ đánh dấu rõ các nguồn unverified.
      assert.ok(p.unverified.length, `hồ sơ ${p.id} chưa có dữ liệu thật (verified_with) và cũng không đánh dấu unverified`);
      continue;
    }
    for (const name of p.verified_with) {
      assert.ok(fs.existsSync(path.join(dir, `${name}.walk`)), `${p.id}: thiếu test/fixtures/${name}.walk`);
      const r = await startReplay(name);
      try {
        const out = await poll(r, { profile: p.id });
        for (const k of ['cpu', 'ram', 'disk']) {
          if (metrics[k]) assert.equal(out.diag[k].ok, true, `${p.id}/${name}: ${k} không đọc được`);
        }
      } finally { r.close(); }
    }
  }
});

// ---- Fortigate: dữ liệu TỔNG HỢP theo FORTINET-FORTIGATE-MIB (chưa có walk thật) ----
const FG = '1.3.6.1.4.1.12356.101.4.1.';
const fgRows = (objectId = '1.3.6.1.4.1.12356.101.1.1000.1', descr = 'FortiGate-VM64') => [
  ['1.3.6.1.2.1.1.1.0', descr, 'STRING'],
  ['1.3.6.1.2.1.1.2.0', objectId, 'OID'],
  ['1.3.6.1.2.1.1.3.0', 360000, 'TIMETICKS'],
  [`${FG}1.0`, 'v7.4.3,build2573,240425 (GA.M)', 'STRING'],
  [`${FG}3.0`, 7, 'GAUGE32'],
  [`${FG}4.0`, 41, 'GAUGE32'],
  [`${FG}5.0`, 2097152, 'GAUGE32'],
  [`${FG}6.0`, 1024, 'GAUGE32'],
  [`${FG}7.0`, 4096, 'GAUGE32'],
  [`${FG}8.0`, 123, 'GAUGE32'],
];

test('fortigate (synthetic MIB data): auto-detected by sysObjectID, cpu/ram/disk read from fgSystemInfo', async () => {
  const r = await startReplay(null, { rows: fgRows() });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'fortigate');
    assert.equal(out.profile.auto, true);
    assert.equal(out.cpu, 7);
    assert.equal(out.ram, 41);
    assert.equal(out.disk, 25);
    assert.equal(out.uptime, 3600);
    assert.equal(out.diag.cpu.unverified, true);
    const extra = Object.fromEntries(out.extra.map((e) => [e.key, e.value]));
    assert.match(extra.fortios_version, /^v7\.4\.3/);
    assert.equal(extra.sessions, 123);
    assert.equal(out.diag.toner, undefined);
  } finally { r.close(); }
});

test('fortigate: auto-detected by sysDescr alone, and without disk the optional disk metric just fails', async () => {
  const rows = fgRows('1.3.6.1.4.1.8072.3.2.10', 'FortiGate-60F v7.2.0').filter(([o]) => o !== `${FG}6.0` && o !== `${FG}7.0`);
  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'fortigate');
    assert.equal(out.cpu, 7);
    assert.equal(out.diag.disk.ok, false);
    assert.equal(out.diag.disk.optional, true);
  } finally { r.close(); }
});

test('detectProfile: vendor classification (fortigate / mikrotik / generic), leading dot tolerated', () => {
  const d = (sysObjectID, sysDescr = '') => engine.detectProfile({ sysObjectID, sysDescr }).id;
  assert.equal(d('1.3.6.1.4.1.12356.101.1.43'), 'fortigate');
  assert.equal(d('.1.3.6.1.4.1.12356.101.1.43'), 'fortigate');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'FortiOS 7.4'), 'fortigate');
  assert.equal(d('1.3.6.1.4.1.14988.1'), 'mikrotik');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'Linux box 6.1'), 'generic');
  assert.equal(d('', ''), 'generic');
});


// ---- lỗi: lý do phải rõ ---------------------------------------------------
test('errors: timeout (silent / wrong community) gives a Vietnamese reason', async () => {
  const silent = await startReplay('mikrotik-routeros-x86', { silent: true });
  const wrong = await startReplay('mikrotik-routeros-x86', { community: 'secret' });
  try {
    await assert.rejects(() => poll(silent, { timeoutMs: 150 }), (e) => e.code === 'timeout' && /community|phản hồi/i.test(e.message));
    await assert.rejects(() => poll(wrong, { timeoutMs: 150 }), (e) => e.code === 'timeout');
  } finally { silent.close(); wrong.close(); }
});

// ---- động cơ: DỮ LIỆU TỔNG HỢP (không phải thiết bị thật) --------------------
const H = '1.3.6.1.2.1.25.';
const synth = (rows) => startReplay(null, { rows });
const baseRows = () => [
  ['1.3.6.1.2.1.1.1.0', 'Thiet bi tong hop', 'STRING'],
  ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.99999.1', 'OID'],
  ['1.3.6.1.2.1.1.3.0', 1000, 'TIMETICKS'],
];

test('synthetic: percent from used/total, free/total, fallback OIDs, table where/agg', async () => {
  const rows = [
    ...baseRows(),
    ['1.3.6.1.4.1.99999.2.1.0', 25, 'GAUGE32'], ['1.3.6.1.4.1.99999.2.2.0', 100, 'GAUGE32'],
    ['1.3.6.1.4.1.99999.3.1.0', 30, 'GAUGE32'],
    ['1.3.6.1.4.1.99999.4.1.1', 10, 'INTEGER'], ['1.3.6.1.4.1.99999.4.1.2', 50, 'INTEGER'],
    ['1.3.6.1.4.1.99999.4.2.1', 1, 'INTEGER'], ['1.3.6.1.4.1.99999.4.2.2', 2, 'INTEGER'],
  ];
  const r = await synth(rows);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  try {
    const write = (n, o) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(o));
    write('generic', { id: 'generic', name: 'G', fallback: true, metrics: {} });
    write('synth', {
      id: 'synth', name: 'S', match: { sysObjectID: ['1.3.6.1.4.1.99999'] },
      metrics: {
        cpu: { unit: '%', sources: [{ get: '1.3.6.1.4.1.99999.9.9.0' }, { percent: { used: '1.3.6.1.4.1.99999.2.1.0', total: '1.3.6.1.4.1.99999.2.2.0' } }] },
        ram: { unit: '%', sources: [{ percent: { free: '1.3.6.1.4.1.99999.2.1.0', total: '1.3.6.1.4.1.99999.2.2.0' } }] },
        disk: {
          unit: '%',
          sources: [{
            table: {
              columns: { kind: '1.3.6.1.4.1.99999.4.2', pct: '1.3.6.1.4.1.99999.4.1' },
              where: { kind: [2] }, value: { column: 'pct' }, agg: 'max',
            },
          }],
        },
        temperature: { unit: '°C', sources: [{ get: '1.3.6.1.4.1.99999.3.1.0' }] },
      },
    });
    engine.reloadProfiles(dir);
    const out = await poll(r);
    assert.equal(out.profile.id, 'synth');
    assert.equal(out.cpu, 25);        // OID đầu không tồn tại → dùng OID dự phòng
    assert.equal(out.diag.cpu.tried.length, 1);  // chỉ ghi nguồn đã thất bại
    assert.equal(out.ram, 75);        // free/total
    assert.equal(out.disk, 50);       // chỉ dòng kind=2
    assert.equal(out.temperature, 30);
  } finally { r.close(); engine.reloadProfiles(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('profile validation: clear Vietnamese errors naming the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  try {
    const write = (n, o) => fs.writeFileSync(path.join(dir, `${n}.json`), typeof o === 'string' ? o : JSON.stringify(o));
    write('generic', { id: 'generic', name: 'G', fallback: true, metrics: {} });
    write('bad', { id: 'bad', name: 'B', match: { sysObjectID: ['1.3.6'] }, metrics: { cpu: { sources: [{ get: 'abc' }] } } });
    assert.throws(() => engine.loadProfiles(dir), /bad\.json.*OID/);
    write('bad', { id: 'khac', name: 'B', fallback: false });
    assert.throws(() => engine.loadProfiles(dir), /bad\.json.*id/);
    write('bad', '{ not json');
    assert.throws(() => engine.loadProfiles(dir), /bad\.json.*JSON/);
    fs.rmSync(path.join(dir, 'bad.json'));
    fs.rmSync(path.join(dir, 'generic.json'));
    assert.throws(() => engine.loadProfiles(dir), /hồ sơ chung/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- định dạng .walk và xuất dữ liệu ----------------------------------------
test('walk file: serialize/parse round-trip and export through replay (no community in file)', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'Chuỗi "có" dấu\nxuống dòng', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.99999.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 123, 'TIMETICKS'],
    ['1.3.6.1.2.1.1.6.0', 'ab12ff', 'HEX'],
  ];
  const back = walkfile.parse(walkfile.serialize(rows, { name: 'x' }));
  assert.deepEqual(back.rows, rows);

  const real = loadFixture('mikrotik-routeros-x86');
  const r = await startReplay('mikrotik-routeros-x86');
  try {
    const { text } = await walkfile.exportWalk({ host: r.host, port: r.port, community: 'public' });
    assert.ok(!/community/i.test(text));
    const got = walkfile.parse(text).rows;
    assert.equal(got.length, real.rows.length);
  } finally { r.close(); }
});

