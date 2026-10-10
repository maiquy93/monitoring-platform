'use strict';
// Populates a running server with demo devices/groups/map. Usage: node tools/seed-demo.js http://localhost:8080 admin <password>
const [server = 'http://localhost:8080', user = 'admin', pass] = process.argv.slice(2);
let cookie = '';
async function api(method, url, body) {
  const r = await fetch(server + url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monitor', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url}: ${j.error}`);
  return j;
}
(async () => {
  const login = await api('POST', '/api/auth/login', { username: user, password: pass });
  if (login.user.must_change) {
    const next = process.env.NEW_PASSWORD || 'demo-password-1';
    await api('POST', '/api/auth/password', { current: pass, password: next });
    console.error(`password changed to ${next}`);
  }
  const mk = async (d) => (await api('POST', '/api/devices', d)).id;
  const g1 = (await api('POST', '/api/groups', { name: 'Core network', description: 'Router, switch, firewall' })).id;
  const g2 = (await api('POST', '/api/groups', { name: 'Văn phòng', description: 'Máy in, máy trạm' })).id;
  const fw = await mk({ name: 'FW-Edge', type: 'firewall', address: '127.0.0.1', groups: [g1] });
  const rt = await mk({ name: 'Router-WAN', type: 'router', address: '127.0.0.1', groups: [g1] });
  const sw = await mk({ name: 'SW-Core', type: 'switch', address: '127.0.0.1', groups: [g1] });
  const pr = await mk({ name: 'Printer-HR', type: 'printer', address: '10.255.255.1', groups: [g2] });
  const pc = await mk({ name: 'PC-Reception', type: 'pc', address: '127.0.0.1', groups: [g2] });
  const web = await mk({ name: 'srv-web01', type: 'server', check_icmp: false, check_agent: true, groups: [g1] });
  const db = await mk({ name: 'srv-db01', type: 'vm', check_icmp: false, check_agent: true, groups: [g1] });
  const tokens = {};
  for (const [n, id] of [['srv-web01', web], ['srv-db01', db]]) tokens[n] = (await api('GET', `/api/devices/${id}`)).agent_token;
  const node = (id, kind, ref, x, y, label = '') => ({ id, kind, ref, x, y, label });
  await api('POST', '/api/maps', {
    name: 'Core topology',
    nodes: [node('fw', 'device', fw, 800, 120), node('rt', 'device', rt, 800, 260), node('sw', 'device', sw, 800, 420),
      node('web', 'device', web, 500, 600), node('db', 'device', db, 800, 600), node('off', 'group', g2, 1150, 600), node('wan', 'label', null, 800, 40, 'INTERNET')],
    links: [['wan', 'fw'], ['fw', 'rt'], ['rt', 'sw'], ['sw', 'web'], ['sw', 'db'], ['sw', 'off']].map(([from, to]) => ({ from, to })),
  });
  void pr; void pc;
  console.log(JSON.stringify(tokens));
})().catch((e) => { console.error(e.message); process.exit(1); });
