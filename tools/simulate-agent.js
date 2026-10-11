'use strict';
// Fake agent for testing: node tools/simulate-agent.js --server http://localhost:8080 --token <token> [--host name] [--interval 5] [--cpu 30]
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const server = args.server || 'http://localhost:8080';
const token = args.token;
const host = args.host || 'sim-host';
const interval = Number(args.interval || 5) * 1000;
if (!token) { console.error('Usage: --token <agent token or enroll key> [--server url] [--host name] [--interval s] [--cpu base%]'); process.exit(1); }

const base = Number(args.cpu || 30);
const t0 = Date.now() - Math.random() * 1e6;
let tok = token;

let simRx = 50000000;
let simTx = 20000000;

async function tick() {
  const wave = (p) => Math.min(100, Math.max(1, base + 20 * Math.sin(Date.now() / p) + Math.random() * 8));
  simRx += Math.floor(150000 + Math.random() * 500000);
  simTx += Math.floor(80000 + Math.random() * 200000);
  const body = {
    hostname: host, os: 'Simulated Linux', agent_version: 'sim-0.1', ip: args.ip || '',
    cpu: { percent: +wave(20000).toFixed(1), cores: 8, load1: 1.2 },
    memory: { total: 16e9, used: 16e9 * (wave(50000) / 100), percent: +wave(50000).toFixed(1) },
    disks: [{ mount: '/', total: 5e11, used: 2e11, percent: 40 }, { mount: '/data', total: 2e12, used: 1.4e12, percent: +(args.disk || 70) }],
    uptime: Math.floor((Date.now() - t0) / 1000),
    net: { rx_bytes: simRx, tx_bytes: simTx },
  };
  try {
    const r = await fetch(`${server}/api/agent/report`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.token) { tok = j.token; console.log(`enrolled as device ${j.device_id}, token ${tok}`); }
    else if (!r.ok) console.error(r.status, j.error);
  } catch (e) { console.error('send failed:', e.message); }
}
setInterval(tick, interval);
tick();
