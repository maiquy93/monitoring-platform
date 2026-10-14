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

test('detectProfile: cisco / synology / pfsense by enterprise sysObjectID or sysDescr, no false prefix match', () => {
  const d = (sysObjectID, sysDescr = '') => engine.detectProfile({ sysObjectID, sysDescr }).id;
  assert.equal(d('1.3.6.1.4.1.9.1.1208'), 'cisco');
  assert.equal(d('.1.3.6.1.4.1.9.1.1208'), 'cisco');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'Cisco IOS Software, C2960 Software'), 'cisco');
  assert.equal(d('1.3.6.1.4.1.99999.1'), 'generic');   // 1.3.6.1.4.1.9 không được khớp tiền tố chuỗi "…9999"
  assert.equal(d('1.3.6.1.4.1.6574.1'), 'synology');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'Linux DiskStation 4.4.302+ #72806'), 'synology');
  assert.equal(d('1.3.6.1.4.1.12325.1.1.2.1.1'), 'pfsense');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.8', 'pfSense.home.arpa 2.7.2-RELEASE FreeBSD 14.0'), 'pfsense');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.8', 'OPNsense.localdomain 24.1 FreeBSD 13.2'), 'pfsense');
});

// ---- Cisco: dữ liệu TỔNG HỢP theo CISCO-PROCESS-MIB / CISCO-MEMORY-POOL-MIB (chưa có walk thật) ----
const ciscoRows = (descr = 'Cisco IOS Software, C2960X Software') => [
  ['1.3.6.1.2.1.1.1.0', descr, 'STRING'],
  ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.9.1.1208', 'OID'],
  ['1.3.6.1.2.1.1.3.0', 720000, 'TIMETICKS'],
  ['1.3.6.1.4.1.9.9.109.1.1.1.1.8.1', 12, 'GAUGE32'],   // cpmCPUTotal5minRev, CPU 1
  ['1.3.6.1.4.1.9.9.109.1.1.1.1.8.2', 20, 'GAUGE32'],   // CPU 2 (thành viên stack)
  ['1.3.6.1.4.1.9.9.48.1.1.1.1.1', 1, 'INTEGER'],       // ciscoMemoryPoolType = processor
  ['1.3.6.1.4.1.9.9.48.1.1.1.5.1', 300, 'GAUGE32'],     // ciscoMemoryPoolUsed
  ['1.3.6.1.4.1.9.9.48.1.1.1.6.1', 700, 'GAUGE32'],     // ciscoMemoryPoolFree
  ['1.3.6.1.4.1.9.9.48.1.1.1.1.2', 2, 'INTEGER'],       // pool I/O: phải bị bỏ qua
  ['1.3.6.1.4.1.9.9.48.1.1.1.5.2', 900, 'GAUGE32'],
  ['1.3.6.1.4.1.9.9.48.1.1.1.6.2', 100, 'GAUGE32'],
];

test('cisco (synthetic MIB data): auto-detected, CPU 5min max over CPUs, RAM from processor pool used/free', async () => {
  const r = await startReplay(null, { rows: ciscoRows() });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'cisco');
    assert.equal(out.profile.auto, true);
    assert.equal(out.cpu, 20);
    assert.equal(out.ram, 30);          // 300 / (300 + 700), pool I/O (90%) không được tính
    assert.equal(out.uptime, 7200);
    assert.equal(out.diag.cpu.unverified, true);
    assert.equal(out.diag.ram.unverified, true);
    assert.equal(out.disk, undefined);
    assert.equal(out.diag.disk, undefined);   // Cisco IOS không có disk qua HOST-RESOURCES
    assert.equal(out.diag.toner, undefined);
  } finally { r.close(); }
});

test('cisco: ram reports a reason when the device has no CISCO-MEMORY-POOL-MIB rows', async () => {
  const rows = ciscoRows().filter(([o]) => !o.startsWith('1.3.6.1.4.1.9.9.48.'));
  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'cisco');
    assert.equal(out.cpu, 20);
    assert.equal(out.diag.ram.ok, false);
    assert.equal(out.diag.ram.code, 'no_rows');
  } finally { r.close(); }
});

// ---- pfSense / OPNsense: dữ liệu TỔNG HỢP theo UCD-SNMP-MIB + HOST-RESOURCES-MIB (chưa có walk thật) ----
const HRS = '1.3.6.1.2.1.25.2.3.1.';
const hrStorageRows = () => [
  [`${HRS}2.1`, '1.3.6.1.2.1.25.2.1.2', 'OID'], [`${HRS}5.1`, 1000, 'INTEGER'], [`${HRS}6.1`, 250, 'INTEGER'],   // RAM 25%
  [`${HRS}2.2`, '1.3.6.1.2.1.25.2.1.4', 'OID'], [`${HRS}5.2`, 2000, 'INTEGER'], [`${HRS}6.2`, 500, 'INTEGER'],   // đĩa 25%
  [`${HRS}2.3`, '1.3.6.1.2.1.25.2.1.4', 'OID'], [`${HRS}5.3`, 1000, 'INTEGER'], [`${HRS}6.3`, 800, 'INTEGER'],   // đĩa 80%
];
const pfRows = (objectId, descr) => [
  ['1.3.6.1.2.1.1.1.0', descr, 'STRING'],
  ['1.3.6.1.2.1.1.2.0', objectId, 'OID'],
  ['1.3.6.1.2.1.1.3.0', 100000, 'TIMETICKS'],
];

test('pfsense/opnsense (synthetic, net-snmp): detected by sysDescr, CPU/RAM from UCD-SNMP-MIB, disk from HOST-RESOURCES', async () => {
  const rows = [
    ...pfRows('1.3.6.1.4.1.8072.3.2.8', 'OPNsense.localdomain 24.1 FreeBSD 13.2-RELEASE amd64'),
    ['1.3.6.1.4.1.2021.11.11.0', 88, 'INTEGER'],     // ssCpuIdle → CPU 12%
    ['1.3.6.1.4.1.2021.4.5.0', 4000000, 'INTEGER'],  // memTotalReal
    ['1.3.6.1.4.1.2021.4.6.0', 3000000, 'INTEGER'],  // memAvailReal → RAM 25%
    ...hrStorageRows(),
  ];
  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'pfsense');
    assert.equal(out.cpu, 12);
    assert.equal(out.ram, 25);
    assert.equal(out.disk, 80);
    assert.equal(out.uptime, 1000);
    assert.equal(out.diag.cpu.source, 0);
    assert.equal(out.diag.disk.unverified, true);
    assert.equal(out.diag.toner, undefined);
  } finally { r.close(); }
});

test('pfsense (synthetic, bsnmpd): detected by Begemot sysObjectID, no UCD → CPU/RAM fall back to HOST-RESOURCES', async () => {
  const rows = [
    ...pfRows('1.3.6.1.4.1.12325.1.1.2.1.1', 'FreeBSD fw 14.0-CURRENT'),
    ['1.3.6.1.2.1.25.3.3.1.2.1', 30, 'INTEGER'], ['1.3.6.1.2.1.25.3.3.1.2.2', 50, 'INTEGER'],   // hrProcessorLoad
    ...hrStorageRows(),
  ];
  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'pfsense');
    assert.equal(out.cpu, 40);
    assert.equal(out.diag.cpu.source, 1);
    assert.equal(out.diag.cpu.tried.length, 1);
    assert.equal(out.ram, 25);
    assert.equal(out.diag.ram.source, 1);
    assert.equal(out.disk, 80);
  } finally { r.close(); }
});

// ---- Synology: dữ liệu TỔNG HỢP theo Synology DiskStation MIB Guide (chưa có walk thật) ----
const SY = '1.3.6.1.4.1.6574.';
const synologyRows = (objectId = '1.3.6.1.4.1.8072.3.2.10') => [
  ['1.3.6.1.2.1.1.1.0', 'Linux DiskStation 4.4.302+ #72806 SMP x86_64', 'STRING'],
  ['1.3.6.1.2.1.1.2.0', objectId, 'OID'],
  ['1.3.6.1.2.1.1.3.0', 500000, 'TIMETICKS'],
  [`${SY}1.2.0`, 38, 'INTEGER'],            // temperature
  [`${SY}1.5.1.0`, 'DS920+', 'STRING'],     // modelName
  [`${SY}1.5.3.0`, 'DSM 7.2.1-69057', 'STRING'],   // version
  [`${SY}1.7.1.0`, 17, 'INTEGER'],          // cpuUtilization
  [`${SY}1.7.2.0`, 43, 'INTEGER'],          // memUtilization
  [`${SY}3.1.1.2.1`, 'Storage Pool 1', 'STRING'], [`${SY}3.1.1.4.1`, 2000000000000, 'COUNTER64'], [`${SY}3.1.1.5.1`, 8000000000000, 'COUNTER64'],   // raidFreeSize / raidTotalSize: 75%
  [`${SY}3.1.1.2.2`, 'Volume 1', 'STRING'],       [`${SY}3.1.1.4.2`, 1000000000000, 'COUNTER64'], [`${SY}3.1.1.5.2`, 8000000000000, 'COUNTER64'],   // 87.5%
];

test('synology (synthetic MIB data): auto-detected by sysObjectID, cpu/ram/temp from SYNOLOGY-SYSTEM-MIB, disk from SYNOLOGY-RAID-MIB', async () => {
  const r = await startReplay(null, { rows: synologyRows('1.3.6.1.4.1.6574.1') });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'synology');
    assert.equal(out.profile.auto, true);
    assert.equal(out.cpu, 17);
    assert.equal(out.ram, 43);
    assert.equal(out.disk, 87.5);       // volume đầy nhất
    assert.equal(out.temperature, 38);
    assert.equal(out.uptime, 5000);
    assert.equal(out.diag.cpu.unverified, true);
    const extra = Object.fromEntries(out.extra.map((e) => [e.key, e.value]));
    assert.equal(extra.model, 'DS920+');
    assert.match(extra.dsm_version, /^DSM 7\.2/);
    assert.equal(out.diag.toner, undefined);
  } finally { r.close(); }
});

test('synology: detected by sysDescr, old DSM without SYNOLOGY-SYSTEM-MIB utilisation falls back to UCD-SNMP / HOST-RESOURCES', async () => {
  const rows = [
    ...synologyRows().filter(([o]) => !o.startsWith(`${SY}1.7.`) && !o.startsWith(`${SY}3.`)),
    ['1.3.6.1.4.1.2021.11.11.0', 70, 'INTEGER'],      // ssCpuIdle → CPU 30%
    ['1.3.6.1.4.1.2021.4.5.0', 2000000, 'INTEGER'],
    ['1.3.6.1.4.1.2021.4.6.0', 500000, 'INTEGER'],    // RAM 75%
    ...hrStorageRows(),
  ];
  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'synology');
    assert.equal(out.cpu, 30);
    assert.equal(out.diag.cpu.source, 1);
    assert.equal(out.ram, 75);
    assert.equal(out.diag.ram.source, 1);
    assert.equal(out.disk, 80);
    assert.equal(out.diag.disk.source, 1);
  } finally { r.close(); }
});

// ---- Máy in: HP, Brother, Canon (dữ liệu TỔNG HỢP theo Printer-MIB RFC 3805 / RFC 2790 / Vendor MIB) ----
const hpPrinterRows = () => [
  ['1.3.6.1.2.1.1.1.0', 'HP LaserJet Pro M404dn', 'STRING'],
  ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.11.2.3.9.1', 'OID'],
  ['1.3.6.1.2.1.1.3.0', 450000, 'TIMETICKS'],
  ['1.3.6.1.2.1.1.5.0', 'HPLaserJet-Office', 'STRING'],
  ['1.3.6.1.2.1.25.3.5.1.1.1', 3, 'INTEGER'], // hrPrinterStatus: idle (sẵn sàng)
  ['1.3.6.1.2.1.25.3.5.1.2.1', 0, 'INTEGER'], // không có lỗi
  ['1.3.6.1.2.1.43.5.1.1.16.1', 'HP LaserJet Pro M404dn', 'STRING'],
  ['1.3.6.1.2.1.43.5.1.1.17.1', 'VNC3K04921', 'STRING'],
  ['1.3.6.1.2.1.43.10.2.1.4.1.1', 14520, 'COUNTER32'], // tổng số trang in
  ['1.3.6.1.2.1.43.16.5.1.2.1.1', 'Ready', 'STRING'],
  // Hộp mực Black Toner (68%)
  ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'HP Black Toner Cartridge CF276A', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.1', 7, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.1', 10000, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.1', 6800, 'INTEGER'],
  // Cụm trống Drum (74%)
  ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'HP LaserJet Imaging Drum', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.2', 7, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.2', 25000, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.2', 18500, 'INTEGER'],
  // Khay nạp giấy Tray 1
  ['1.3.6.1.2.1.43.8.2.1.9.1.1', 250, 'INTEGER'],
  ['1.3.6.1.2.1.43.8.2.1.10.1.1', 180, 'INTEGER'],
  ['1.3.6.1.2.1.43.8.2.1.11.1.1', 0, 'INTEGER'],
  ['1.3.6.1.2.1.43.8.2.1.13.1.1', 'Tray 1 (Cassette)', 'STRING'],
];

test('detectProfile: hp / brother / canon printers by sysObjectID or sysDescr', () => {
  const d = (sysObjectID, sysDescr = '') => engine.detectProfile({ sysObjectID, sysDescr }).id;
  assert.equal(d('1.3.6.1.4.1.11.2.3.9.1'), 'hp-printer');
  assert.equal(d('.1.3.6.1.4.1.11.2.3.9.1'), 'hp-printer');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'HP LaserJet Pro M404dn'), 'hp-printer');
  assert.equal(d('1.3.6.1.4.1.2435.2.1.1'), 'brother-printer');
  assert.equal(d('.1.3.6.1.4.1.2435.2.1.1'), 'brother-printer');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'Brother HL-L2366DW series'), 'brother-printer');
  assert.equal(d('1.3.6.1.4.1.1602.1.1.2'), 'canon-printer');
  assert.equal(d('.1.3.6.1.4.1.1602.1.1.2'), 'canon-printer');
  assert.equal(d('1.3.6.1.4.1.8072.3.2.10', 'Canon imageRUNNER ADVANCE C3530i'), 'canon-printer');
});

test('hp printer (synthetic MIB data): auto-detected, reads toner, drum life, page count, supplies and trays', async () => {
  const r = await startReplay(null, { rows: hpPrinterRows() });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'hp-printer');
    assert.equal(out.profile.auto, true);
    assert.equal(out.toner, 68);
    assert.equal(out.drum, 74);
    assert.equal(out.page_count, 14520);
    assert.equal(out.uptime, 4500);
    assert.ok(out.printer, 'cần có thông tin printer');
    assert.equal(out.printer.model, 'HP LaserJet Pro M404dn');
    assert.equal(out.printer.serial, 'VNC3K04921');
    assert.equal(out.printer.display, 'Ready');
    assert.equal(out.printer.status_text, 'Sẵn sàng (Ready/Idle)');
    assert.equal(out.printer.errors.length, 0);
    assert.equal(out.printer.supplies.length, 2);
    assert.equal(out.printer.trays.length, 1);
  } finally { r.close(); }
});

const brotherPrinterRows = () => [
  ['1.3.6.1.2.1.1.1.0', 'Brother HL-L2366DW series', 'STRING'],
  ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.2435.2.1.1', 'OID'],
  ['1.3.6.1.2.1.1.3.0', 320000, 'TIMETICKS'],
  ['1.3.6.1.2.1.1.5.0', 'Brother-Office', 'STRING'],
  ['1.3.6.1.2.1.25.3.5.1.1.1', 3, 'INTEGER'],
  ['1.3.6.1.2.1.25.3.5.1.2.1', 0, 'INTEGER'],
  ['1.3.6.1.2.1.43.5.1.1.16.1', 'Brother HL-L2366DW series', 'STRING'],
  ['1.3.6.1.2.1.43.5.1.1.17.1', 'E73890H8J29381', 'STRING'],
  ['1.3.6.1.2.1.43.10.2.1.4.1.1', 8920, 'COUNTER32'],
  ['1.3.6.1.2.1.43.16.5.1.2.1.1', 'Sleep', 'STRING'],
  // Toner cartridge TN-2385 (20%)
  ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'Toner Cartridge (TN-2385)', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.1', 7, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.1', 2600, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.1', 520, 'INTEGER'],
  // Drum unit DR-2385 (12%)
  ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'Drum Unit (DR-2385)', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.2', 7, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.2', 12000, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.2', 1440, 'INTEGER'],
];

test('brother printer (synthetic MIB data): auto-detected, reads separated toner (TN) and drum (DR), page count', async () => {
  const r = await startReplay(null, { rows: brotherPrinterRows() });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'brother-printer');
    assert.equal(out.toner, 20);
    assert.equal(out.drum, 12);
    assert.equal(out.page_count, 8920);
    assert.equal(out.printer.serial, 'E73890H8J29381');
    assert.equal(out.printer.display, 'Sleep');
  } finally { r.close(); }
});

const canonPrinterRows = (jammed = false) => [
  ['1.3.6.1.2.1.1.1.0', 'Canon imageRUNNER ADVANCE C3530i', 'STRING'],
  ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.1602.1.1.2', 'OID'],
  ['1.3.6.1.2.1.1.3.0', 780000, 'TIMETICKS'],
  ['1.3.6.1.2.1.1.5.0', 'Canon-iR-ADV', 'STRING'],
  ['1.3.6.1.2.1.25.3.5.1.1.1', jammed ? 1 : 3, 'INTEGER'],
  ['1.3.6.1.2.1.25.3.5.1.2.1', jammed ? 0x04 : 0, 'INTEGER'], // bit 5 jammed: 0x04
  ['1.3.6.1.2.1.43.5.1.1.16.1', 'Canon iR-ADV C3530i', 'STRING'],
  ['1.3.6.1.2.1.43.5.1.1.17.1', 'QNA04918', 'STRING'],
  ['1.3.6.1.2.1.43.10.2.1.4.1.1', 53400, 'COUNTER32'],
  ['1.3.6.1.2.1.43.16.5.1.2.1.1', jammed ? 'Paper Jam Tray 2' : 'Ready to print', 'STRING'],
  // Canon supplies (unit 19 = percent)
  ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'Canon NPG-67 Black Toner', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.1', 19, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.1', 100, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.1', 85, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'Canon NPG-67 Drum Unit', 'STRING'],
  ['1.3.6.1.2.1.43.11.1.1.7.1.2', 19, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.8.1.2', 100, 'INTEGER'],
  ['1.3.6.1.2.1.43.11.1.1.9.1.2', 92, 'INTEGER'],
];

test('canon printer (synthetic MIB data): auto-detected, reads toner, drum life, and detects paper jam error', async () => {
  const r = await startReplay(null, { rows: canonPrinterRows(true) });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'canon-printer');
    assert.equal(out.toner, 85);
    assert.equal(out.drum, 92);
    assert.equal(out.page_count, 53400);
    assert.equal(out.printer.serial, 'QNA04918');
    assert.equal(out.printer.display, 'Paper Jam Tray 2');
    assert.ok(out.printer.errors.some((e) => /kẹt giấy/i.test(e)), 'phải phát hiện lỗi kẹt giấy');
  } finally { r.close(); }
});

test('profile validation: table percent accepts used+free without total, rejects incomplete combinations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  try {
    const write = (n, o) => fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(o));
    write('generic', { id: 'generic', name: 'G', fallback: true, metrics: {} });
    const prof = (percent) => ({
      id: 'p', name: 'P', match: { sysObjectID: ['1.3.6.1.4.1.99999'] },
      metrics: { ram: { sources: [{ table: { columns: { u: '1.3.6.1.4.1.99999.1', f: '1.3.6.1.4.1.99999.2' }, value: { percent } } }] } },
    });
    write('p', prof({ used: 'u', free: 'f' }));
    assert.doesNotThrow(() => engine.loadProfiles(dir));
    write('p', prof({ used: 'u' }));
    assert.throws(() => engine.loadProfiles(dir), /p\.json.*percent/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

