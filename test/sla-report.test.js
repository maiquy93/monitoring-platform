'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');

async function startServer(opts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const monitor = new Monitor(db, {
    pingIntervalMs: 60000,
    snmpIntervalMs: 60000,
    pingFn: async () => ({ ok: true, rtt: 1.5 }),
    ...opts.monitor,
  });
  const srv = createApp(db, monitor);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return {
    db,
    monitor,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { monitor.stop(); srv.close(r); }),
  };
}

async function loginCookie(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' },
    body: JSON.stringify({ username: 'admin', password: 'initial-pass-1' }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const pwRes = await fetch(`${baseUrl}/api/auth/password`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' },
    body: JSON.stringify({ current: 'initial-pass-1', password: 'new-password-1' }),
  });
  assert.equal(pwRes.status, 200);
  return cookie;
}

test('sla-report: calculates per-device SLA uptime %, downtime, MTTR, and resource averages accurately', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const cookie = await loginCookie(s.url);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' };

  // Create 2 devices: Core Router (will have 1h downtime in 24h) and Web Server (100% up)
  let res = await fetch(`${s.url}/api/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Core-Router-01', type: 'router', address: '10.0.0.1', check_icmp: true }),
  });
  assert.equal(res.status, 201);
  const router = await res.json();

  res = await fetch(`${s.url}/api/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Web-Server-01', type: 'server', address: '10.0.0.10', check_icmp: true }),
  });
  assert.equal(res.status, 201);
  const server = await res.json();

  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;

  // Backdate created_at of both devices to 48 hours ago so full 24h window is monitored
  s.db.prepare('UPDATE devices SET created_at = ? WHERE id IN (?, ?)').run(now - 48 * 3600 * 1000, router.id, server.id);

  // Insert a 3600-second (1 hour) outage on Core-Router-01 inside the 24h window
  const downAt = dayAgo + 2 * 3600 * 1000;
  const upAt = downAt + 3600 * 1000; // 1 hour later
  const insEv = s.db.prepare('INSERT INTO events(ts, device_id, device_name, kind, severity, message) VALUES(?,?,?,?,?,?)');
  insEv.run(downAt, router.id, 'Core-Router-01', 'down', 'critical', 'Mất kết nối ICMP (timeout)');
  insEv.run(upAt, router.id, 'Core-Router-01', 'up', 'ok', 'Hoạt động trở lại sau 3600s');

  // Insert a warning on Web-Server-01 (warnings should be counted in warning_count, not downtime)
  insEv.run(dayAgo + 5 * 3600 * 1000, server.id, 'Web-Server-01', 'warning', 'high', 'CPU vượt ngưỡng 92%');

  // Insert sample metrics for both devices
  const insMetric = s.db.prepare('INSERT INTO metrics(device_id, ts, cpu, ram, disk, rtt) VALUES(?,?,?,?,?,?)');
  insMetric.run(router.id, now - 3600 * 1000, 20, 45, 30, 1.2);
  insMetric.run(router.id, now - 1800 * 1000, 40, 55, 30, 2.8);
  insMetric.run(server.id, now - 3600 * 1000, 60, 70, 80, 0.8);

  // Query 24h SLA Report with target = 99.0%
  res = await fetch(`${s.url}/api/reports/sla?range=24h&target=99`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  const report = await res.json();

  assert.equal(report.range, '24h');
  assert.equal(report.sla_target, 99);
  assert.equal(report.summary.total_devices, 2);
  assert.equal(report.summary.total_outages, 1);
  assert.equal(report.summary.total_warnings, 1);
  assert.equal(report.summary.fleet_mttr_sec, 3600);

  // Core-Router-01 was down 1h out of 24h => 23/24 = 95.833% (< 99% target => breached)
  const rRow = report.devices.find((d) => d.device_id === router.id);
  assert.ok(rRow);
  assert.equal(rRow.outage_count, 1);
  assert.equal(rRow.downtime_sec, 3600);
  assert.equal(rRow.mttr_sec, 3600);
  assert.equal(rRow.sla_status, 'breached');
  assert.ok(Math.abs(rRow.uptime_pct - 95.833) < 0.05, `Expected ~95.833%, got ${rRow.uptime_pct}`);
  assert.equal(rRow.metrics.avg_cpu, 30);
  assert.equal(rRow.metrics.max_cpu, 40);
  assert.equal(rRow.metrics.avg_ram, 50);
  assert.equal(rRow.metrics.avg_rtt, 2);

  // Web-Server-01 had 0s downtime => 100% uptime (met)
  const sRow = report.devices.find((d) => d.device_id === server.id);
  assert.ok(sRow);
  assert.equal(sRow.outage_count, 0);
  assert.equal(sRow.warning_count, 1);
  assert.equal(sRow.downtime_sec, 0);
  assert.equal(sRow.uptime_pct, 100);
  assert.equal(sRow.sla_status, 'met');
});

test('sla-report: CSV export includes UTF-8 BOM, headers, and device SLA rows', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const cookie = await loginCookie(s.url);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' };

  await fetch(`${s.url}/api/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Switch-Floor-2', type: 'switch', address: '192.168.2.2', location: 'Tầng 2' }),
  });

  const res = await fetch(`${s.url}/api/reports/sla/csv?range=7d&target=99.5`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="sla-report-7d-/);

  const rawBuf = Buffer.from(await res.arrayBuffer());
  assert.equal(rawBuf[0], 0xef, 'CSV should start with UTF-8 BOM byte 0xEF');
  assert.equal(rawBuf[1], 0xbb, 'CSV should start with UTF-8 BOM byte 0xBB');
  assert.equal(rawBuf[2], 0xbf, 'CSV should start with UTF-8 BOM byte 0xBF');
  const text = rawBuf.toString('utf8');
  assert.ok(text.includes('SLA Uptime (%)'));
  assert.ok(text.includes('Switch-Floor-2'));
  assert.ok(text.includes('192.168.2.2'));
  assert.ok(text.includes('ĐẠT CHUẨN (MET)'));
});

test('sla-report: frontend script is isolated and registered in index.html', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(indexHtml.includes('<script src="/sla-report.js"></script>'));

  const slaJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sla-report.js'), 'utf8');
  assert.ok(slaJs.includes('M.openSlaReportModal'));
  assert.ok(slaJs.includes('/api/reports/sla/csv'));
});
