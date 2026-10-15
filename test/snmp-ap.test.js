'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../server/snmp-engine');
const { startReplay } = require('./helpers/snmp-replay');
const dbm = require('../server/db');
const { Monitor } = require('../server/monitor');

const poll = (r, extra = {}) => engine.pollDevice({ host: r.host, port: r.port, community: 'public', ...extra });

// 1. Kiểm tra tự động nhận diện Profile (detectProfile) cho các hãng AP
test('detectProfile: auto-detect AP profiles for major vendors (UniFi, Cisco AP, Aruba, Ruckus, Omada, Grandstream, Generic)', () => {
  // Ubiquiti UniFi
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.41112.1.4', sysDescr: 'Linux U6-Pro' }).id, 'ubiquiti-unifi');
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.41112.1.6', sysDescr: 'UAP-AC-Pro 6.5.62' }).id, 'ubiquiti-unifi');

  // Cisco AP
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.9.1.28', sysDescr: 'Cisco Catalyst 9800-CL Wireless Controller' }).id, 'cisco-ap');
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.9.1.24', sysDescr: 'Cisco Aironet 3800 Series Access Point' }).id, 'cisco-ap');

  // Aruba
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.14823.1.2.85', sysDescr: 'ArubaOS (MODEL: 515), Version 8.10.0.7' }).id, 'aruba-ap');
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.14823.1.1', sysDescr: 'Aruba Instant AP-305' }).id, 'aruba-ap');

  // Ruckus
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.25053.1.2', sysDescr: 'Ruckus R750 Multimedia Hotzone Wireless AP / Unleashed' }).id, 'ruckus-ap');
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.25053.1.1', sysDescr: 'Ruckus ZoneDirector 1200' }).id, 'ruckus-ap');

  // TP-Link Omada
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.11863.6.4.1', sysDescr: 'TP-Link Omada EAP670 v1.0' }).id, 'tp-link-omada');

  // Grandstream
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.42397.1.1', sysDescr: 'Grandstream GWN7660 Wi-Fi 6 AP' }).id, 'grandstream-ap');

  // Generic AP
  assert.equal(engine.detectProfile({ sysObjectID: '1.3.6.1.4.1.99999', sysDescr: 'Enterprise 802.11 Access Point' }).id, 'ap-generic');
});

// 2. Ubiquiti UniFi: Poll giả lập MIB (unifiVapTable và ARP table)
test('ubiquiti unifi: reads SSIDs, client counts per SSID, total clients and ARP table', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'UniFi U6-Pro 6.5.54', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.41112.1.4', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 720000, 'TIMETICKS'],
    ['1.3.6.1.2.1.1.5.0', 'U6-Pro-Floor2', 'STRING'],

    // CPU / RAM
    ['1.3.6.1.2.1.25.3.3.1.2.1', 12, 'INTEGER'],
    ['1.3.6.1.2.1.25.3.3.1.2.2', 18, 'INTEGER'],
    ['1.3.6.1.2.1.25.2.3.1.2.1', '1.3.6.1.2.1.25.2.1.2', 'OID'],
    ['1.3.6.1.2.1.25.2.3.1.5.1', 1048576, 'INTEGER'],
    ['1.3.6.1.2.1.25.2.3.1.6.1', 419430, 'INTEGER'],

    // unifiVapTable: 2 VAPs (SSID 1 = CongTy-5G, SSID 2 = Khach-Guest)
    // VAP 1
    ['1.3.6.1.4.1.41112.1.6.1.2.1.2.1', 'f4f5e8010203', 'HEX'], // BSSID
    ['1.3.6.1.4.1.41112.1.6.1.2.1.4.1', 36, 'INTEGER'],           // Channel
    ['1.3.6.1.4.1.41112.1.6.1.2.1.6.1', 'CongTy-5G', 'STRING'],   // ESSID
    ['1.3.6.1.4.1.41112.1.6.1.2.1.8.1', 25, 'INTEGER'],          // Num Stations
    ['1.3.6.1.4.1.41112.1.6.1.2.1.9.1', 'na', 'STRING'],          // Radio 5GHz

    // VAP 2
    ['1.3.6.1.4.1.41112.1.6.1.2.1.2.2', 'f4f5e8010204', 'HEX'], // BSSID
    ['1.3.6.1.4.1.41112.1.6.1.2.1.4.2', 6, 'INTEGER'],           // Channel
    ['1.3.6.1.4.1.41112.1.6.1.2.1.6.2', 'Khach-Guest', 'STRING'], // ESSID
    ['1.3.6.1.4.1.41112.1.6.1.2.1.8.2', 9, 'INTEGER'],           // Num Stations
    ['1.3.6.1.4.1.41112.1.6.1.2.1.9.2', 'ng', 'STRING'],          // Radio 2.4GHz

    // ipNetToMediaTable (ARP table)
    ['1.3.6.1.2.1.4.22.1.1.2.192.168.1.101', 2, 'INTEGER'],
    ['1.3.6.1.2.1.4.22.1.2.2.192.168.1.101', 'a0b1c2d3e401', 'HEX'],
    ['1.3.6.1.2.1.4.22.1.3.2.192.168.1.101', '192.168.1.101', 'IPADDR'],
    ['1.3.6.1.2.1.4.22.1.4.2.192.168.1.101', 3, 'INTEGER'], // dynamic

    ['1.3.6.1.2.1.4.22.1.1.2.192.168.1.102', 2, 'INTEGER'],
    ['1.3.6.1.2.1.4.22.1.2.2.192.168.1.102', 'a0b1c2d3e402', 'HEX'],
    ['1.3.6.1.2.1.4.22.1.3.2.192.168.1.102', '192.168.1.102', 'IPADDR'],
    ['1.3.6.1.2.1.4.22.1.4.2.192.168.1.102', 3, 'INTEGER'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'ubiquiti-unifi');
    assert.equal(out.profile.auto, true);
    assert.equal(out.cpu, 15);
    assert.equal(out.ram, 40);
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 34); // 25 + 9

    assert.ok(out.ap);
    assert.equal(out.ap.total_ssids, 2);
    assert.equal(out.ap.total_clients, 34);
    assert.equal(out.ap.ssids.length, 2);

    const ssid1 = out.ap.ssids.find((s) => s.ssid === 'CongTy-5G');
    assert.ok(ssid1);
    assert.equal(ssid1.clients, 25);
    assert.equal(ssid1.band, '5 GHz');
    assert.equal(ssid1.channel, 36);
    assert.equal(ssid1.bssid, 'F4:F5:E8:01:02:03');

    const ssid2 = out.ap.ssids.find((s) => s.ssid === 'Khach-Guest');
    assert.ok(ssid2);
    assert.equal(ssid2.clients, 9);
    assert.equal(ssid2.band, '2.4 GHz');

    // ARP Table check
    assert.equal(out.ap.has_arp, true);
    assert.equal(out.ap.arp_table.length, 2);
    assert.equal(out.ap.arp_table[0].ip, '192.168.1.101');
    assert.equal(out.ap.arp_table[0].mac, 'A0:B1:C2:D3:E4:01');
    assert.equal(out.ap.arp_table[0].type, 'Dynamic (Động)');
  } finally {
    r.close();
  }
});

// 3. Ruckus Wireless: Poll giả lập WLAN table và Station Table (ruckusZDAllStaTable)
test('ruckus wireless: reads WLANs, client stations with hostnames and ARP table', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'Ruckus R750 Multimedia Hotzone Wireless AP', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.25053.1.2.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 500000, 'TIMETICKS'],
    ['1.3.6.1.4.1.25053.1.1.1.15.0', 22, 'INTEGER'], // CPU
    ['1.3.6.1.4.1.25053.1.1.1.16.0', 48, 'INTEGER'], // RAM

    // ruckusZDAllWLANTable (2 SSIDs)
    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.2.1', 'Ruckus-Corporate', 'STRING'],
    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.3.1', 'd838fc112233', 'HEX'],
    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.16.1', 18, 'INTEGER'],

    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.2.2', 'Ruckus-VIP', 'STRING'],
    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.3.2', 'd838fc112234', 'HEX'],
    ['1.3.6.1.4.1.25053.1.2.2.1.1.1.16.2', 7, 'INTEGER'],

    // ruckusZDAllStaTable (station details with hostnames)
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.1.1', 'e0b255aa0011', 'HEX'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.3.1', -58, 'INTEGER'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.4.1', '192.168.10.55', 'IPADDR'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.6.1', 'Ruckus-Corporate', 'STRING'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.8.1', 'MacBook-Pro-CEO', 'STRING'],

    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.1.2', 'e0b255aa0012', 'HEX'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.3.2', -65, 'INTEGER'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.4.2', '192.168.10.56', 'IPADDR'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.6.2', 'Ruckus-VIP', 'STRING'],
    ['1.3.6.1.4.1.25053.1.2.2.4.1.1.8.2', 'iPhone-KT', 'STRING'],

    // Standard ARP table (ipNetToMedia)
    ['1.3.6.1.2.1.4.22.1.1.1.192.168.10.55', 1, 'INTEGER'],
    ['1.3.6.1.2.1.4.22.1.2.1.192.168.10.55', 'e0b255aa0011', 'HEX'],
    ['1.3.6.1.2.1.4.22.1.3.1.192.168.10.55', '192.168.10.55', 'IPADDR'],
    ['1.3.6.1.2.1.4.22.1.4.1.192.168.10.55', 3, 'INTEGER'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'ruckus-ap');
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 25); // 18 + 7

    assert.ok(out.ap);
    assert.equal(out.ap.ssids.length, 2);

    // Bảng ARP kết hợp hostname từ station table
    assert.ok(out.ap.arp_table.length >= 2);
    const ceoSta = out.ap.arp_table.find((a) => a.ip === '192.168.10.55');
    assert.ok(ceoSta);
    assert.equal(ceoSta.hostname, 'MacBook-Pro-CEO');
    assert.equal(ceoSta.ssid, 'Ruckus-Corporate');
    assert.equal(ceoSta.mac, 'E0:B2:55:AA:00:11');

    const iphoneSta = out.ap.arp_table.find((a) => a.ip === '192.168.10.56');
    assert.ok(iphoneSta);
    assert.equal(iphoneSta.hostname, 'iPhone-KT');
    assert.equal(iphoneSta.ssid, 'Ruckus-VIP');
  } finally {
    r.close();
  }
});

// 4. Aruba AP: Poll giả lập ESSID table và User Table
test('aruba: reads ESSIDs, total clients and user tracking', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'ArubaOS (MODEL: 515), Version 8.10.0.7', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.14823.1.2.85', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 360000, 'TIMETICKS'],

    // CPU / RAM
    ['1.3.6.1.4.1.14823.2.2.1.1.1.9.0', 14, 'GAUGE32'],
    ['1.3.6.1.4.1.14823.2.2.1.1.1.11.0', 52, 'GAUGE32'],

    // wlsxEssidTable (2 ESSIDs)
    ['1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.2.1', 'Aruba-Staff', 'STRING'],
    ['1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.3.1', 40, 'INTEGER'],

    ['1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.2.2', 'Aruba-Visitors', 'STRING'],
    ['1.3.6.1.4.1.14823.2.2.1.5.2.1.7.1.3.2', 12, 'INTEGER'],

    ['1.3.6.1.4.1.14823.2.2.1.4.1.1.0', 52, 'INTEGER'], // total users

    // wlsxUserTable
    ['1.3.6.1.4.1.14823.2.2.1.4.1.2.1.1.1', '10.0.1.20', 'IPADDR'],
    ['1.3.6.1.4.1.14823.2.2.1.4.1.2.1.2.1', '204c03112233', 'HEX'],
    ['1.3.6.1.4.1.14823.2.2.1.4.1.2.1.3.1', 'user-laptop.corp.vn', 'STRING'],
    ['1.3.6.1.4.1.14823.2.2.1.4.1.2.1.7.1', 'Aruba-Staff', 'STRING'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'aruba-ap');
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 52); // 40 + 12

    assert.ok(out.ap);
    assert.equal(out.ap.ssids.length, 2);
    assert.ok(out.ap.arp_table.length >= 1);
    const user1 = out.ap.arp_table.find((a) => a.ip === '10.0.1.20');
    assert.ok(user1);
    assert.equal(user1.hostname, 'user-laptop.corp.vn');
    assert.equal(user1.ssid, 'Aruba-Staff');
    assert.equal(user1.mac, '20:4C:03:11:22:33');
  } finally {
    r.close();
  }
});

// 5. Cisco Wireless: Poll cLWlanConfigTable và cldcClientTable
test('cisco ap: reads WLAN SSID config and clients', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'Cisco Catalyst 9800-CL Wireless Controller', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.9.1.28', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 400000, 'TIMETICKS'],
    ['1.3.6.1.4.1.9.9.109.1.1.1.1.8.1', 19, 'GAUGE32'], // CPU

    // CISCO-LWAPP-WLAN-MIB: 2 WLANs
    ['1.3.6.1.4.1.9.9.512.1.1.1.1.6.1', 'Cisco-Enterprise', 'STRING'],
    ['1.3.6.1.4.1.9.9.512.1.1.1.1.5.1', 30, 'GAUGE32'],

    ['1.3.6.1.4.1.9.9.512.1.1.1.1.6.2', 'Cisco-IoT', 'STRING'],
    ['1.3.6.1.4.1.9.9.512.1.1.1.1.5.2', 15, 'GAUGE32'],

    // CISCO-LWAPP-DOT11-CLIENT-MIB (cldcClientTable)
    ['1.3.6.1.4.1.9.9.599.1.3.1.1.1.1', '002710aabbcc', 'HEX'],
    ['1.3.6.1.4.1.9.9.599.1.3.1.1.10.1', '172.16.1.50', 'IPADDR'],
    ['1.3.6.1.4.1.9.9.599.1.3.1.1.27.1', 'Cisco-Enterprise', 'STRING'],
    ['1.3.6.1.4.1.9.9.599.1.3.1.1.28.1', 'dev-thinkpad', 'STRING'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'cisco-ap');
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 45); // 30 + 15

    assert.ok(out.ap);
    assert.equal(out.ap.ssids.length, 2);
    const cli = out.ap.arp_table.find((a) => a.ip === '172.16.1.50');
    assert.ok(cli);
    assert.equal(cli.hostname, 'dev-thinkpad');
    assert.equal(cli.ssid, 'Cisco-Enterprise');
    assert.equal(cli.mac, '00:27:10:AA:BB:CC');
  } finally {
    r.close();
  }
});

// 6. TP-Link Omada: Poll tpEapSsidTable
test('tp-link omada: reads EAP SSIDs and client counts per band', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'TP-Link Omada EAP670 v1.0', 'STRING'],
    ['1.3.6.1.4.1.11863.6.4.1', '1.3.6.1.4.1.11863.6.4.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 180000, 'TIMETICKS'],

    // TPLINK-EAP-MIB (tpEapSsidTable)
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.2.1', 'Omada-Office', 'STRING'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.3.1', '50d4f7112233', 'HEX'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.4.1', 16, 'INTEGER'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.5.1', 'na', 'STRING'], // 5 GHz

    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.2.2', 'Omada-Guest', 'STRING'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.3.2', '50d4f7112234', 'HEX'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.4.2', 8, 'INTEGER'],
    ['1.3.6.1.4.1.11863.6.4.1.2.1.1.5.2', 'ng', 'STRING'], // 2.4 GHz
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'tp-link-omada');
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 24);
    assert.equal(out.ap.ssids[0].band, '5 GHz');
    assert.equal(out.ap.ssids[1].band, '2.4 GHz');
  } finally {
    r.close();
  }
});

// 7. Monitor snapshot & device view: AP metrics in overview tile and detailed view
test('monitor: AP device snapshot includes total_ssids, total_clients and detailed view includes ap data', async () => {
  const db = dbm.open(':memory:');
  const mon = new Monitor(db, {
    pingFn: async () => ({ ok: true, rtt: 1.5 }),
    snmpFn: async () => ({
      sysDescr: 'UniFi AP-AC-Pro',
      sysObjectID: '1.3.6.1.4.1.41112.1.4',
      sysName: 'AP-HoiTruong',
      uptime: 86400,
      profile: { id: 'ubiquiti-unifi', name: 'Ubiquiti UniFi', auto: true },
      diag: {},
      extra: [],
      total_ssids: 3,
      total_clients: 42,
      ap: {
        total_ssids: 3,
        total_clients: 42,
        ssids: [
          { ssid: 'NoiBo-5G', clients: 28, bssid: 'F4:F5:E8:11:22:33', band: '5 GHz' },
          { ssid: 'Khach', clients: 14, bssid: 'F4:F5:E8:11:22:34', band: '2.4 GHz' },
        ],
        arp_table: [
          { ip: '192.168.1.55', mac: 'A0:B1:C2:D3:E4:F5', hostname: 'PC-KeToan', ssid: 'NoiBo-5G', type: 'Dynamic (Động)' },
        ],
        has_arp: true,
      },
    }),
  });

  const r = db.prepare(
    `INSERT INTO devices(name,type,address,check_icmp,check_agent,snmp_enabled,snmp_community,snmp_port,agent_token,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run('AP Hội Trường', 'ap', '192.168.1.10', 1, 0, 1, 'public', 161, 'test-token-ap', Date.now());
  const devId = Number(r.lastInsertRowid);
  mon.reload();

  // Chờ poll SNMP hoàn tất
  mon.tick();
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Kiểm tra Snapshot (Overview Tile trên Dashboard)
  const snap = mon.snapshot();
  const devSnap = snap.devices.find((d) => d.id === devId);
  assert.ok(devSnap);
  assert.equal(devSnap.type, 'ap');
  assert.equal(devSnap.status, 'up');
  assert.equal(devSnap.total_ssids, 3);
  assert.equal(devSnap.total_clients, 42);

  // Kiểm tra Detailed View (Trang chi tiết thiết bị)
  const dev = mon.devices.get(devId);
  const detail = mon.view(dev, true);
  assert.equal(detail.total_ssids, 3);
  assert.equal(detail.total_clients, 42);
  assert.ok(detail.ap);
  assert.equal(detail.ap.total_ssids, 3);
  assert.equal(detail.ap.total_clients, 42);
  assert.equal(detail.ap.ssids.length, 2);
  assert.equal(detail.ap.arp_table.length, 1);
  assert.equal(detail.ap.arp_table[0].hostname, 'PC-KeToan');
});

// 8. Grandstream GWN: Poll gwnSsidTable
test('grandstream gwn: reads GWN SSIDs, client count and band', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'Grandstream GWN7660 Wi-Fi 6 AP', 'STRING'],
    ['1.3.6.1.4.1.42397.1.1', '1.3.6.1.4.1.42397.1.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 250000, 'TIMETICKS'],

    // GRANDSTREAM-GWN-MIB (gwnSsidTable)
    ['1.3.6.1.4.1.42397.1.1.2.2.1.2.1', 'GWN-Office-5G', 'STRING'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.3.1', '000b82112233', 'HEX'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.4.1', 21, 'INTEGER'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.5.1', '5GHz', 'STRING'],

    ['1.3.6.1.4.1.42397.1.1.2.2.1.2.2', 'GWN-Guest-2.4G', 'STRING'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.3.2', '000b82112234', 'HEX'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.4.2', 7, 'INTEGER'],
    ['1.3.6.1.4.1.42397.1.1.2.2.1.5.2', '2.4GHz', 'STRING'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'grandstream-ap');
    assert.equal(out.total_ssids, 2);
    assert.equal(out.total_clients, 28); // 21 + 7
    assert.equal(out.ap.ssids[0].band, '5 GHz');
    assert.equal(out.ap.ssids[1].band, '2.4 GHz');
    assert.equal(out.ap.ssids[0].bssid, '00:0B:82:11:22:33');
  } finally {
    r.close();
  }
});

// 9. Standard IEEE 802.11 MIB AP: Fallback dot11DesiredSSID và dot11AssociatedStationCount
test('generic ieee 802.11 ap: reads standard dot11 SSID and station count', async () => {
  const rows = [
    ['1.3.6.1.2.1.1.1.0', 'IEEE 802.11 Wireless Access Point', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.99999.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 300000, 'TIMETICKS'],

    // IEEE802dot11-MIB
    ['1.2.840.10036.1.1.1.9.1', 'Std-WiFi-Zone', 'STRING'],
    ['1.2.840.10036.2.2.1.4.1', 13, 'INTEGER'],

    // ARP
    ['1.3.6.1.2.1.4.22.1.1.1.192.168.2.88', 1, 'INTEGER'],
    ['1.3.6.1.2.1.4.22.1.2.1.192.168.2.88', '34e6d7112233', 'HEX'],
    ['1.3.6.1.2.1.4.22.1.3.1.192.168.2.88', '192.168.2.88', 'IPADDR'],
    ['1.3.6.1.2.1.4.22.1.4.1.192.168.2.88', 3, 'INTEGER'],
  ];

  const r = await startReplay(null, { rows });
  try {
    const out = await poll(r);
    assert.equal(out.profile.id, 'ap-generic');
    assert.equal(out.total_ssids, 1);
    assert.equal(out.total_clients, 13);
    assert.equal(out.ap.ssids[0].ssid, 'Std-WiFi-Zone');
    assert.equal(out.ap.has_arp, true);
    assert.equal(out.ap.arp_table[0].ip, '192.168.2.88');
    assert.equal(out.ap.arp_table[0].mac, '34:E6:D7:11:22:33');
  } finally {
    r.close();
  }
});

