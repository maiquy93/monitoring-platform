'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_TYPE_SEVERITY = {
  server: 'critical', vm: 'critical', router: 'critical', firewall: 'critical',
  switch: 'high', ups: 'high', ap: 'medium', other: 'medium', printer: 'low', pc: 'low',
};

const DEFAULT_AI_SETTINGS = {
  enabled: false,
  provider: 'openai',
  api_url: 'https://api.openai.com/v1/chat/completions',
  api_key: '',
  model: 'gpt-4o-mini',
  auto_incident: true,
  daily_digest_enabled: false,
  daily_digest_time: '23:55',
  cooldown_minutes: 60,
  daily_call_limit: 50,
  max_tokens: 280,
};

const DEFAULT_TELEGRAM_SETTINGS = {
  enabled: false,
  bot_token: '',
  chat_id: '',
  app_url: '',
  notify_down: true,
  notify_recovered: true,
  notify_threshold: true,
  cooldown_seconds: 30,
  max_per_minute: 20,
};

const DEFAULT_SETTINGS = {
  type_severity: DEFAULT_TYPE_SEVERITY,
  thresholds: { cpu: 90, ram: 90, disk: 90, temp: 85, dos_packet_rate: 10000 },
  enroll_key: '',
  org_name: 'Monitoring',
  default_theme: 'neon',
  default_lang: 'vi',
  ai: DEFAULT_AI_SETTINGS,
  telegram: DEFAULT_TELEGRAM_SETTINGS,
  storm_guard_enabled: 0,
  storm_use_parent_id: 1,
  storm_use_topology: 0,
  storm_burst_threshold: 3,
};

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer', must_change INTEGER NOT NULL DEFAULT 0,
      theme TEXT, lang TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS groups(
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS devices(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'server',
      address TEXT NOT NULL DEFAULT '', check_icmp INTEGER NOT NULL DEFAULT 1,
      check_agent INTEGER NOT NULL DEFAULT 0, snmp_enabled INTEGER NOT NULL DEFAULT 0,
      snmp_community TEXT NOT NULL DEFAULT 'public', snmp_port INTEGER NOT NULL DEFAULT 161,
      severity TEXT, location TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      maintenance INTEGER NOT NULL DEFAULT 0, maintenance_until INTEGER DEFAULT 0, mute_local_alerts INTEGER NOT NULL DEFAULT 0,
      telegram_enabled INTEGER NOT NULL DEFAULT 1, parent_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      port_count INTEGER DEFAULT 0,
      agent_token TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS device_groups(
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY(device_id, group_id));
    CREATE TABLE IF NOT EXISTS metrics(
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, cpu REAL, ram REAL, disk REAL, rtt REAL, net_in REAL, net_out REAL, temp REAL);
    CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(device_id, ts);
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, device_id INTEGER, device_name TEXT NOT NULL,
      kind TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS maps(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{"nodes":[],"links":[]}');
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_reports(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      device_id INTEGER, device_name TEXT NOT NULL DEFAULT '', event_id INTEGER,
      severity TEXT NOT NULL DEFAULT 'high', lang TEXT NOT NULL DEFAULT 'vi',
      fingerprint TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL DEFAULT '',
      cause TEXT NOT NULL DEFAULT '', solution TEXT NOT NULL DEFAULT '',
      prediction TEXT NOT NULL DEFAULT '', prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'ai');
    CREATE INDEX IF NOT EXISTS idx_ai_reports_ts ON ai_reports(ts);
    CREATE INDEX IF NOT EXISTS idx_ai_reports_event ON ai_reports(event_id);
    CREATE INDEX IF NOT EXISTS idx_ai_reports_fp ON ai_reports(fingerprint, ts);
    CREATE TABLE IF NOT EXISTS metrics_hourly(
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      hour_ts INTEGER NOT NULL,
      cpu_avg REAL, cpu_max REAL,
      ram_avg REAL, ram_max REAL,
      disk_avg REAL, disk_max REAL,
      rtt_avg REAL, rtt_max REAL,
      net_in_avg REAL, net_in_max REAL,
      net_out_avg REAL, net_out_max REAL,
      temp_avg REAL, temp_max REAL,
      toner_avg REAL, drum_avg REAL,
      samples_count INTEGER DEFAULT 0,
      PRIMARY KEY(device_id, hour_ts));
    CREATE INDEX IF NOT EXISTS idx_metrics_hourly ON metrics_hourly(device_id, hour_ts);
  `);
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('lang')) db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (!cols.includes('snmp_profile')) db.exec("ALTER TABLE devices ADD COLUMN snmp_profile TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('mute_local_alerts')) db.exec("ALTER TABLE devices ADD COLUMN mute_local_alerts INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes('telegram_enabled')) db.exec("ALTER TABLE devices ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 1");
  if (!cols.includes('parent_id')) db.exec('ALTER TABLE devices ADD COLUMN parent_id INTEGER REFERENCES devices(id) ON DELETE SET NULL');
  if (!cols.includes('maintenance_until')) db.exec('ALTER TABLE devices ADD COLUMN maintenance_until INTEGER DEFAULT 0');
  if (!cols.includes('port_count')) db.exec('ALTER TABLE devices ADD COLUMN port_count INTEGER DEFAULT 0');
  // bandwidth history (bytes per second): net_in = download/rx, net_out = upload/tx
  const mcols = db.prepare('PRAGMA table_info(metrics)').all().map((c) => c.name);
  if (!mcols.includes('net_in')) db.exec('ALTER TABLE metrics ADD COLUMN net_in REAL');
  if (!mcols.includes('net_out')) db.exec('ALTER TABLE metrics ADD COLUMN net_out REAL');
  if (!mcols.includes('temp')) db.exec('ALTER TABLE metrics ADD COLUMN temp REAL');
  if (!mcols.includes('toner')) db.exec('ALTER TABLE metrics ADD COLUMN toner REAL');
  if (!mcols.includes('drum')) db.exec('ALTER TABLE metrics ADD COLUMN drum REAL');
  return db;
}

function getSettings(db) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* ignore corrupt row */ }
  }
  out.type_severity = { ...DEFAULT_TYPE_SEVERITY, ...out.type_severity };
  out.thresholds = { ...DEFAULT_SETTINGS.thresholds, ...out.thresholds };
  out.ai = { ...DEFAULT_AI_SETTINGS, ...(out.ai || {}) };
  out.telegram = { ...DEFAULT_TELEGRAM_SETTINGS, ...(out.telegram || {}) };
  out.storm_guard_enabled = Number(out.storm_guard_enabled ?? 0);
  out.storm_use_parent_id = Number(out.storm_use_parent_id ?? 1);
  out.storm_use_topology = Number(out.storm_use_topology ?? 0);
  out.storm_burst_threshold = Number(out.storm_burst_threshold ?? 3);
  if (!['vi', 'en'].includes(out.default_lang)) out.default_lang = 'vi';
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

function rollupMetrics(db, now = Date.now(), toHour = null) {
  const currentHour = toHour != null ? toHour : Math.floor(now / 3600e3) * 3600e3;
  const lastRow = db.prepare('SELECT MAX(hour_ts) as last_hour FROM metrics_hourly').get();
  let startTs = 0;
  if (lastRow && lastRow.last_hour != null) {
    startTs = Math.min(lastRow.last_hour, currentHour - 3600e3);
  }

  return db.prepare(`
    INSERT INTO metrics_hourly(
      device_id, hour_ts,
      cpu_avg, cpu_max,
      ram_avg, ram_max,
      disk_avg, disk_max,
      rtt_avg, rtt_max,
      net_in_avg, net_in_max,
      net_out_avg, net_out_max,
      temp_avg, temp_max,
      toner_avg, drum_avg,
      samples_count
    )
    SELECT
      device_id,
      (ts / 3600000) * 3600000 AS hour_ts,
      ROUND(AVG(cpu), 2), MAX(cpu),
      ROUND(AVG(ram), 2), MAX(ram),
      ROUND(AVG(disk), 2), MAX(disk),
      ROUND(AVG(rtt), 2), MAX(rtt),
      ROUND(AVG(net_in), 2), MAX(net_in),
      ROUND(AVG(net_out), 2), MAX(net_out),
      ROUND(AVG(temp), 1), MAX(temp),
      ROUND(AVG(toner), 1),
      ROUND(AVG(drum), 1),
      COUNT(*)
    FROM metrics
    WHERE ts >= ? AND ts < ?
    GROUP BY device_id, hour_ts
    ON CONFLICT(device_id, hour_ts) DO UPDATE SET
      cpu_avg = excluded.cpu_avg,
      cpu_max = excluded.cpu_max,
      ram_avg = excluded.ram_avg,
      ram_max = excluded.ram_max,
      disk_avg = excluded.disk_avg,
      disk_max = excluded.disk_max,
      rtt_avg = excluded.rtt_avg,
      rtt_max = excluded.rtt_max,
      net_in_avg = excluded.net_in_avg,
      net_in_max = excluded.net_in_max,
      net_out_avg = excluded.net_out_avg,
      net_out_max = excluded.net_out_max,
      temp_avg = excluded.temp_avg,
      temp_max = excluded.temp_max,
      toner_avg = excluded.toner_avg,
      drum_avg = excluded.drum_avg,
      samples_count = excluded.samples_count
  `).run(startTs, currentHour);
}

function pruneMetrics(db, now = Date.now(), rawDays = 7, hourlyDays = 90) {
  const rawCutoff = now - rawDays * 86400e3;
  const hourlyCutoff = now - hourlyDays * 86400e3;
  const r1 = db.prepare('DELETE FROM metrics WHERE ts < ?').run(rawCutoff);
  const r2 = db.prepare('DELETE FROM metrics_hourly WHERE hour_ts < ?').run(hourlyCutoff);
  return { rawDeleted: r1.changes, hourlyDeleted: r2.changes };
}

module.exports = {
  open,
  getSettings,
  setSetting,
  rollupMetrics,
  pruneMetrics,
  DEFAULT_TYPE_SEVERITY,
  DEFAULT_AI_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
};
