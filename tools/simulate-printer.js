'use strict';
// Fake SNMP Printer Agent: node tools/simulate-printer.js [--brand hp|brother|canon] [--port 1161] [--toner 65] [--drum 80] [--jam]
const dgram = require('node:dgram');
const snmp = require('../server/snmp');
const { startReplay } = require('../test/helpers/snmp-replay');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), [])
);

const brand = (args.brand || 'hp').toLowerCase();
const port = Number(args.port || 1161);
const tonerLevel = args.toner !== undefined ? Number(args.toner) : (args['low-toner'] ? 8 : 75);
const drumLevel = args.drum !== undefined ? Number(args.drum) : (args['low-drum'] ? 9 : 82);
const jammed = !!(args.jam || args['paper-jam']);

function buildRows() {
  if (brand === 'brother') {
    return [
      ['1.3.6.1.2.1.1.1.0', 'Brother HL-L2366DW series', 'STRING'],
      ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.2435.2.1.1', 'OID'],
      ['1.3.6.1.2.1.1.3.0', 360000, 'TIMETICKS'],
      ['1.3.6.1.2.1.1.5.0', 'Brother-Office-Printer', 'STRING'],
      ['1.3.6.1.2.1.25.3.5.1.1.1', jammed ? 1 : 3, 'INTEGER'],
      ['1.3.6.1.2.1.25.3.5.1.2.1', jammed ? 0x04 : 0, 'INTEGER'],
      ['1.3.6.1.2.1.43.5.1.1.16.1', 'Brother HL-L2366DW series', 'STRING'],
      ['1.3.6.1.2.1.43.5.1.1.17.1', 'E73890H8J29381', 'STRING'],
      ['1.3.6.1.2.1.43.10.2.1.4.1.1', 9850, 'COUNTER32'],
      ['1.3.6.1.2.1.43.16.5.1.2.1.1', jammed ? 'Paper Jam Inside' : 'Sleep', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'Toner Cartridge (TN-2385)', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.7.1.1', 7, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.8.1.1', 2600, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.9.1.1', Math.round(2600 * (tonerLevel / 100)), 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'Drum Unit (DR-2385)', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.7.1.2', 7, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.8.1.2', 12000, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.9.1.2', Math.round(12000 * (drumLevel / 100)), 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.9.1.1', 250, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.10.1.1', 200, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.11.1.1', 0, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.13.1.1', 'Tray 1', 'STRING'],
    ];
  }
  if (brand === 'canon') {
    return [
      ['1.3.6.1.2.1.1.1.0', 'Canon imageRUNNER ADVANCE C3530i', 'STRING'],
      ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.1602.1.1.2', 'OID'],
      ['1.3.6.1.2.1.1.3.0', 780000, 'TIMETICKS'],
      ['1.3.6.1.2.1.1.5.0', 'Canon-iR-ADV-Accounting', 'STRING'],
      ['1.3.6.1.2.1.25.3.5.1.1.1', jammed ? 1 : 3, 'INTEGER'],
      ['1.3.6.1.2.1.25.3.5.1.2.1', jammed ? 0x04 : 0, 'INTEGER'],
      ['1.3.6.1.2.1.43.5.1.1.16.1', 'Canon iR-ADV C3530i', 'STRING'],
      ['1.3.6.1.2.1.43.5.1.1.17.1', 'QNA04918', 'STRING'],
      ['1.3.6.1.2.1.43.10.2.1.4.1.1', 53400, 'COUNTER32'],
      ['1.3.6.1.2.1.43.16.5.1.2.1.1', jammed ? 'Paper Jam Tray 2' : 'Ready to print', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'Canon NPG-67 Black Toner', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.7.1.1', 19, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.8.1.1', 100, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.9.1.1', tonerLevel, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'Canon NPG-67 Drum Unit', 'STRING'],
      ['1.3.6.1.2.1.43.11.1.1.7.1.2', 19, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.8.1.2', 100, 'INTEGER'],
      ['1.3.6.1.2.1.43.11.1.1.9.1.2', drumLevel, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.9.1.1', 500, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.10.1.1', 350, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.11.1.1', 0, 'INTEGER'],
      ['1.3.6.1.2.1.43.8.2.1.13.1.1', 'Drawer 1 (A4)', 'STRING'],
    ];
  }
  // Default: HP
  return [
    ['1.3.6.1.2.1.1.1.0', 'HP LaserJet Pro M404dn', 'STRING'],
    ['1.3.6.1.2.1.1.2.0', '1.3.6.1.4.1.11.2.3.9.1', 'OID'],
    ['1.3.6.1.2.1.1.3.0', 450000, 'TIMETICKS'],
    ['1.3.6.1.2.1.1.5.0', 'HPLaserJet-Office', 'STRING'],
    ['1.3.6.1.2.1.25.3.5.1.1.1', jammed ? 1 : 3, 'INTEGER'],
    ['1.3.6.1.2.1.25.3.5.1.2.1', jammed ? 0x04 : 0, 'INTEGER'],
    ['1.3.6.1.2.1.43.5.1.1.16.1', 'HP LaserJet Pro M404dn', 'STRING'],
    ['1.3.6.1.2.1.43.5.1.1.17.1', 'VNC3K04921', 'STRING'],
    ['1.3.6.1.2.1.43.10.2.1.4.1.1', 14520, 'COUNTER32'],
    ['1.3.6.1.2.1.43.16.5.1.2.1.1', jammed ? 'Jam in cartridge area' : 'Ready', 'STRING'],
    ['1.3.6.1.2.1.43.11.1.1.4.1.1', 2, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.5.1.1', 3, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.6.1.1', 'HP Black Toner Cartridge CF276A', 'STRING'],
    ['1.3.6.1.2.1.43.11.1.1.7.1.1', 7, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.8.1.1', 10000, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.9.1.1', Math.round(10000 * (tonerLevel / 100)), 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.4.1.2', 2, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.5.1.2', 9, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.6.1.2', 'HP LaserJet Imaging Drum', 'STRING'],
    ['1.3.6.1.2.1.43.11.1.1.7.1.2', 7, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.8.1.2', 25000, 'INTEGER'],
    ['1.3.6.1.2.1.43.11.1.1.9.1.2', Math.round(25000 * (drumLevel / 100)), 'INTEGER'],
    ['1.3.6.1.2.1.43.8.2.1.9.1.1', 250, 'INTEGER'],
    ['1.3.6.1.2.1.43.8.2.1.10.1.1', 180, 'INTEGER'],
    ['1.3.6.1.2.1.43.8.2.1.11.1.1', 0, 'INTEGER'],
    ['1.3.6.1.2.1.43.8.2.1.13.1.1', 'Tray 1 (Cassette)', 'STRING'],
  ];
}

(async () => {
  const rows = buildRows();
  const replay = await startReplay(null, { rows });
  // re-bind to user port if specified
  let activePort = replay.port;
  if (port && port !== replay.port) {
    try {
      replay.close();
      const srv = dgram.createSocket('udp4');
      const data = rows.slice().sort((a, b) => snmp.oidCmp(a[0], b[0]));
      srv.on('message', (m, rinfo) => {
        try {
          const msg = snmp.readTlv(m, 0);
          const ver = snmp.readTlv(m, msg.start);
          const com = snmp.readTlv(m, ver.end);
          const pdu = snmp.readTlv(m, com.end);
          const id = snmp.readTlv(m, pdu.start);
          const reqId = snmp.decInt(m.subarray(id.start, id.end));
          const es = snmp.readTlv(m, id.end);
          const ei = snmp.readTlv(m, es.end);
          const list = snmp.readTlv(m, ei.end);
          const vbs = [];
          for (let o = list.start; o < list.end;) {
            const vb = snmp.readTlv(m, o);
            const ot = snmp.readTlv(m, vb.start);
            const q = snmp.decOid(m.subarray(ot.start, ot.end));
            let hit, outOid = q, value;
            if (pdu.tag === 0xa1) {
              hit = data.find((r) => snmp.oidCmp(r[0], q) > 0);
              if (hit) outOid = hit[0];
              value = hit ? (hit[2] === 'INTEGER' ? snmp.tlv(0x02, Buffer.from([hit[1] >> 8, hit[1] & 0xff])) : (hit[2] === 'COUNTER32' ? snmp.tlv(0x41, Buffer.from([hit[1] >> 8, hit[1] & 0xff])) : snmp.tlv(0x04, Buffer.from(String(hit[1]))))) : Buffer.from([0x82, 0x00]);
            } else {
              hit = data.find((r) => r[0] === q);
              value = hit ? (hit[2] === 'INTEGER' ? snmp.tlv(0x02, Buffer.from([hit[1] >> 8, hit[1] & 0xff])) : (hit[2] === 'COUNTER32' ? snmp.tlv(0x41, Buffer.from([hit[1] >> 8, hit[1] & 0xff])) : snmp.tlv(0x04, Buffer.from(String(hit[1]))))) : Buffer.from([0x80, 0x00]);
            }
            vbs.push(snmp.tlv(0x30, Buffer.concat([snmp.encOid(outOid), value])));
            o = vb.end;
          }
          const body = Buffer.concat([snmp.encInt(reqId), snmp.encInt(0), snmp.encInt(0), snmp.tlv(0x30, Buffer.concat(vbs))]);
          srv.send(snmp.tlv(0x30, Buffer.concat([snmp.encInt(1), snmp.tlv(0x04, Buffer.from('public')), snmp.tlv(0xa2, body)])), rinfo.port, rinfo.address);
        } catch {}
      });
      await new Promise((r) => srv.bind(port, '127.0.0.1', r));
      activePort = port;
    } catch {
      // keep dynamic port
    }
  }

  console.log(`[simulate-printer] Giả lập máy in ${brand.toUpperCase()} đang chạy tại 127.0.0.1:${activePort}`);
  console.log(`[simulate-printer] Thông số: Mực = ${tonerLevel}%, Độ bền Drum = ${drumLevel}%, Kẹt giấy = ${jammed}`);
  console.log('[simulate-printer] Nhấn Ctrl+C để dừng.');
})();
