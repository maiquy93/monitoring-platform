'use strict';
// Usage: node tools/snmp-probe.js <ip> [community] [options]
//   --port <n>      UDP port (default 161)
//   --name <name>   save the walk as test/fixtures/<name>.walk (e.g. mikrotik-routeros-x86)
//   --out <file>    save the walk to an explicit path
//   --root <oid>    walk only this subtree (repeatable)
// Walks the real device with the project's own SNMP client, saves a .walk file
// and shows which profile would be picked and what each metric reads.
const fs = require('node:fs');
const path = require('node:path');
const walkfile = require('../server/snmp-walkfile');
const engine = require('../server/snmp-engine');

const args = process.argv.slice(2);
const opt = (name) => { const v = []; for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) { v.push(args[i + 1]); args.splice(i, 2); i--; } return v; };
const port = Number(opt('port')[0]) || 161;
const name = opt('name')[0];
const outArg = opt('out')[0];
const roots = opt('root');
const [host, community = 'public'] = args;
if (!host) {
  console.error('Usage: node tools/snmp-probe.js <ip> [community] [--port n] [--name vendor-model] [--out file] [--root oid]');
  process.exit(2);
}

(async () => {
  console.log(`SNMP probe ${host}:${port}`);
  let exp;
  try {
    exp = await walkfile.exportWalk({ host, port, community, roots: roots.length ? roots : undefined });
  } catch (e) {
    console.error(`LỖI: ${e.message} (sai community, bị chặn UDP 161 hoặc thiết bị tắt SNMP)`);
    process.exit(1);
  }
  console.log(`sysObjectID: ${exp.meta.sysObjectID}\nsysDescr:    ${exp.meta.sysDescr}\nsysName:     ${exp.meta.sysName}`);
  console.log(`Đã walk ${exp.rows.length} OID`);
  if (exp.meta.errors) console.log(`Cảnh báo: ${exp.meta.errors}`);

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const base = name || `unknown-${slug(exp.meta.sysName || exp.meta.sysDescr || host)}`;
  const file = outArg || path.join(__dirname, '..', 'test', 'fixtures', `${base}.walk`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, exp.text);
  console.log(`Đã lưu: ${file}`);
  console.log('Lưu ý: file có thể chứa IP/MAC/serial của thiết bị, không chứa community.');

  console.log('\n=== Kết quả đọc bằng hồ sơ ===');
  try {
    const info = await engine.pollDevice({ host, port, community });
    console.log(`Hồ sơ: ${info.profile.name} (${info.profile.id}${info.profile.auto ? ', tự nhận diện' : ''})`);
    for (const [k, d] of Object.entries(info.diag)) {
      console.log(`${k.padEnd(12)} ${d.ok ? `OK  ${d.value}` : `${d.optional ? 'bỏ qua' : 'LỖI  '} ${d.message}`}`);
    }
  } catch (e) {
    console.log(`LỖI: ${e.message}`);
  }
  process.exit(0);
})();
