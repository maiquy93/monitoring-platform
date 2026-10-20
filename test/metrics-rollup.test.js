'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, rollupMetrics, pruneMetrics } = require('../server/db');
const { createApp } = require('../server/app');
const { Monitor } = require('../server/monitor');
const auth = require('../server/auth');

process.env.ADMIN_PASSWORD = 'initial-pass-1';

function bootTestServer(db) {
  auth.ensureAdmin(db);
  const monitor = new Monitor(db, { pingFn: async () => ({ ok: true, rtt: 5 }) });
  const app = createApp(db, monitor, {});
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      const base = `http://127.0.0.1:${port}`;
      let cookie = '';
      resolve({
        base,
        db,
        monitor,
        async login() {
          const res = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' },
            body: JSON.stringify({ username: 'admin', password: 'initial-pass-1' }),
          });
          const raw = res.headers.get('set-cookie') || '';
          cookie = raw.split(';')[0];
          await fetch(`${base}/api/auth/password`, {
            method: 'POST',
            headers: {
              Cookie: cookie,
              'Content-Type': 'application/json',
              'X-Requested-With': 'monitor',
            },
            body: JSON.stringify({ current: 'initial-pass-1', password: 'new-password-1' }),
          });
        },
        async api(method, p, body) {
          const res = await fetch(`${base}${p}`, {
            method,
            headers: {
              ...(cookie && { Cookie: cookie }),
              'Content-Type': 'application/json',
              'X-Requested-With': 'monitor',
            },
            ...(body && { body: JSON.stringify(body) }),
          });
          let b = null;
          try { b = await res.json(); } catch { /* ignore */ }
          return { status: res.status, body: b };
        },
        close() {
          monitor.stop();
          s.close();
          db.close();
        },
      });
    });
  });
}

test('metrics_hourly: table schema exists and has proper indexes', () => {
  const db = open(':memory:');
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('metrics_hourly'), 'metrics_hourly table must exist');

    const cols = db.prepare('PRAGMA table_info(metrics_hourly)').all().map((r) => r.name);
    assert.ok(cols.includes('device_id'));
    assert.ok(cols.includes('hour_ts'));
    assert.ok(cols.includes('cpu_avg'));
    assert.ok(cols.includes('cpu_max'));
    assert.ok(cols.includes('ram_avg'));
    assert.ok(cols.includes('ram_max'));
    assert.ok(cols.includes('disk_avg'));
    assert.ok(cols.includes('disk_max'));
    assert.ok(cols.includes('rtt_avg'));
    assert.ok(cols.includes('rtt_max'));
    assert.ok(cols.includes('net_in_avg'));
    assert.ok(cols.includes('net_in_max'));
    assert.ok(cols.includes('net_out_avg'));
    assert.ok(cols.includes('net_out_max'));
    assert.ok(cols.includes('temp_avg'));
    assert.ok(cols.includes('temp_max'));
    assert.ok(cols.includes('toner_avg'));
    assert.ok(cols.includes('drum_avg'));
    assert.ok(cols.includes('samples_count'));
  } finally {
    db.close();
  }
});

test('rollupMetrics: aggregates raw metrics into hourly summary and handles ON CONFLICT updates', () => {
  const db = open(':memory:');
  try {
    db.prepare("INSERT INTO devices(id, name, agent_token, created_at) VALUES(1, 'server1', 'tok1', ?)").run(Date.now());

    // 10:00 AM base timestamp
    const hour10 = 1729418400000;
    // Insert 2 samples into hour 10
    db.prepare('INSERT INTO metrics(device_id, ts, cpu, ram, disk, rtt, net_in, net_out, temp, toner, drum) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(1, hour10 + 10000, 40, 70, 50, 5, 100, 300, 40, null, null);
    db.prepare('INSERT INTO metrics(device_id, ts, cpu, ram, disk, rtt, net_in, net_out, temp, toner, drum) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(1, hour10 + 30000, 60, 80, 50, 15, 200, 400, 50, null, null);

    // Roll up as of 11:00 AM (hour 10 is completed)
    const hour11 = hour10 + 3600e3;
    rollupMetrics(db, hour11);

    const row = db.prepare('SELECT * FROM metrics_hourly WHERE device_id = 1 AND hour_ts = ?').get(hour10);
    assert.ok(row, 'Row for hour 10 must exist');
    assert.equal(row.cpu_avg, 50);
    assert.equal(row.cpu_max, 60);
    assert.equal(row.ram_avg, 75);
    assert.equal(row.ram_max, 80);
    assert.equal(row.disk_avg, 50);
    assert.equal(row.disk_max, 50);
    assert.equal(row.rtt_avg, 10);
    assert.equal(row.rtt_max, 15);
    assert.equal(row.net_in_avg, 150);
    assert.equal(row.net_in_max, 200);
    assert.equal(row.net_out_avg, 350);
    assert.equal(row.net_out_max, 400);
    assert.equal(row.temp_avg, 45);
    assert.equal(row.temp_max, 50);
    assert.equal(row.samples_count, 2);

    // Test idempotency and updates: add a 3rd sample with cpu=90 and re-rollup
    db.prepare('INSERT INTO metrics(device_id, ts, cpu, ram, disk, rtt, net_in, net_out, temp, toner, drum) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(1, hour10 + 40000, 90, 90, 60, 30, 300, 500, 60, null, null);

    rollupMetrics(db, hour11);
    const updated = db.prepare('SELECT * FROM metrics_hourly WHERE device_id = 1 AND hour_ts = ?').get(hour10);
    assert.equal(updated.cpu_avg, 63.33); // (40+60+90)/3 = 63.33
    assert.equal(updated.cpu_max, 90);
    assert.equal(updated.samples_count, 3);
  } finally {
    db.close();
  }
});

test('pruneMetrics: purges raw metrics > 7d and hourly metrics > 90d', () => {
  const db = open(':memory:');
  try {
    db.prepare("INSERT INTO devices(id, name, agent_token, created_at) VALUES(1, 'server1', 'tok1', ?)").run(Date.now());
    const now = Date.now();

    // Raw metrics: 1 fresh (2 days ago), 1 old (8 days ago)
    db.prepare('INSERT INTO metrics(device_id, ts, cpu) VALUES(?, ?, ?)')
      .run(1, now - 2 * 86400e3, 50);
    db.prepare('INSERT INTO metrics(device_id, ts, cpu) VALUES(?, ?, ?)')
      .run(1, now - 8 * 86400e3, 50);

    // Hourly metrics: 1 fresh (30 days ago), 1 old (95 days ago)
    db.prepare('INSERT INTO metrics_hourly(device_id, hour_ts, cpu_avg) VALUES(?, ?, ?)')
      .run(1, now - 30 * 86400e3, 50);
    db.prepare('INSERT INTO metrics_hourly(device_id, hour_ts, cpu_avg) VALUES(?, ?, ?)')
      .run(1, now - 95 * 86400e3, 50);

    const res = pruneMetrics(db, now, 7, 90);
    assert.equal(res.rawDeleted, 1);
    assert.equal(res.hourlyDeleted, 1);

    const remainingRaw = db.prepare('SELECT COUNT(*) c FROM metrics').get().c;
    const remainingHourly = db.prepare('SELECT COUNT(*) c FROM metrics_hourly').get().c;
    assert.equal(remainingRaw, 1);
    assert.equal(remainingHourly, 1);
  } finally {
    db.close();
  }
});

test('history API: 24h/7d queries raw metrics, 30d/90d queries metrics_hourly with capped data points', async () => {
  const db = open(':memory:');
  const t = await bootTestServer(db);
  try {
    await t.login();
    const dev = (await t.api('POST', '/api/devices', { name: 'core-router', type: 'router', address: '10.0.0.1' })).body;
    const now = Date.now();

    // Insert 100 raw metric points over the last 24h
    for (let i = 0; i < 100; i++) {
      db.prepare('INSERT INTO metrics(device_id, ts, cpu, ram, disk, rtt) VALUES(?,?,?,?,?,?)')
        .run(dev.id, now - i * 15 * 60e3, 40 + (i % 20), 60, 50, 10);
    }

    // Insert 500 hourly points over the last 60 days
    for (let h = 0; h < 500; h++) {
      db.prepare(`
        INSERT INTO metrics_hourly(
          device_id, hour_ts, cpu_avg, cpu_max, ram_avg, ram_max, disk_avg, disk_max, rtt_avg, rtt_max
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(dev.id, now - h * 3600e3, 35.0, 75.0, 55.0, 65.0, 40.0, 40.0, 8.5, 12.0);
    }

    // Test range=24h (raw table)
    const h24 = await t.api('GET', `/api/devices/${dev.id}/history?range=24h`);
    assert.equal(h24.status, 200);
    assert.ok(h24.body.points.length > 0);
    assert.ok(h24.body.points.length <= 250, 'Points for 24h should be <= 250');
    assert.ok(h24.body.points[0].cpu != null);

    // Test range=7d (raw table)
    const h7d = await t.api('GET', `/api/devices/${dev.id}/history?range=7d`);
    assert.equal(h7d.status, 200);
    assert.ok(h7d.body.points.length <= 250, 'Points for 7d should be <= 250');

    // Test range=30d (metrics_hourly table)
    const h30d = await t.api('GET', `/api/devices/${dev.id}/history?range=30d`);
    assert.equal(h30d.status, 200);
    assert.ok(h30d.body.points.length > 0);
    assert.ok(h30d.body.points.length <= 250, 'Points for 30d should be <= 250');
    const pt30 = h30d.body.points[0];
    assert.equal(pt30.cpu, 35.0);
    assert.equal(pt30.cpu_max, 75.0);
    assert.equal(pt30.ram, 55.0);
    assert.equal(pt30.ram_max, 65.0);

    // Test range=90d (metrics_hourly table)
    const h90d = await t.api('GET', `/api/devices/${dev.id}/history?range=90d`);
    assert.equal(h90d.status, 200);
    assert.ok(h90d.body.points.length > 0);
    assert.ok(h90d.body.points.length <= 250, 'Points for 90d should be <= 250');
  } finally {
    t.close();
  }
});

test('history API: range=30d falls back cleanly to raw metrics when hourly metrics table is empty', async () => {
  const db = open(':memory:');
  const t = await bootTestServer(db);
  try {
    await t.login();
    const dev = (await t.api('POST', '/api/devices', { name: 'brand-new-switch', type: 'switch', address: '10.0.0.2' })).body;
    const now = Date.now();
    db.prepare('INSERT INTO metrics(device_id, ts, cpu) VALUES(?,?,?)').run(dev.id, now - 60e3, 45);

    const res = await t.api('GET', `/api/devices/${dev.id}/history?range=30d`);
    assert.equal(res.status, 200);
    assert.equal(res.body.points.length, 1);
    assert.equal(res.body.points[0].cpu, 45);
  } finally {
    t.close();
  }
});
