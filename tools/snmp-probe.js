'use strict';
// Usage: node tools/snmp-probe.js <ip> [community] [port]
// Walks the SNMP branches the monitor relies on and prints the raw results,
// using the same client as the server (server/snmp.js).
const snmp = require('../server/snmp');

const [host, community = 'public', portArg] = process.argv.slice(2);
if (!host) {
  console.error('Usage: node tools/snmp-probe.js <ip> [community] [port]');
  process.exit(2);
}
const port = Number(portArg) || 161;

const BRANCHES = [
  ['system', '1.3.6.1.2.1.1'],
  ['hrProcessorLoad', '1.3.6.1.2.1.25.3.3.1'],
  ['hrStorage', '1.3.6.1.2.1.25.2.3.1'],
  ['hrDeviceTable', '1.3.6.1.2.1.25.3.2.1'],
  ['mikrotik (1.3.6.1.4.1.14988)', '1.3.6.1.4.1.14988'],
];

(async () => {
  console.log(`SNMP probe ${host}:${port} community=${community}`);
  let anyOk = false;
  for (const [name, root] of BRANCHES) {
    console.log(`\n=== ${name}  ${root} ===`);
    try {
      const rows = await snmp.walk({ host, port, community, root });
      if (!rows.length) console.log('(không có dữ liệu)');
      for (const [oid, val] of rows) console.log(`${oid} = ${JSON.stringify(val)}`);
      if (rows.length) anyOk = true;
    } catch (e) {
      console.log(`LỖI: ${e.message}`);
    }
  }
  console.log('\n=== kết quả pollDevice (cái server dùng) ===');
  try {
    console.log(await snmp.pollDevice({ host, port, community }));
  } catch (e) {
    console.log(`LỖI: ${e.message}`);
  }
  process.exit(anyOk ? 0 : 1);
})();
