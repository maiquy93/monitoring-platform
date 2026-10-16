'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_TYPE_SEVERITY = {
  server: 'critical', vm: 'critical', router: 'critical', firewall: 'critical',
  switch: 'high', ups: 'high', ap: 'medium', other: 'medium', printer: 'low', pc: 'low',
};

const DEFAULT_SETTINGS = {
  type_severity: DEFAULT_TYPE_SEVERITY,
  thresholds: { cpu: 90, ram: 90, disk: 90, temp: 85, dos_packet_rate: 10000 },
  enroll_key: '',
  org_name: 'Monitoring',
  default_theme: 'neon',
  default_lang: 'vi',
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
      maintenance INTEGER NOT NULL DEFAULT 0, mute_local_alerts INTEGER NOT NULL DEFAULT 0, agent_token TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL);
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
  `);
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!ucols.includes('lang')) db.exec('ALTER TABLE users ADD COLUMN lang TEXT');
  const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (!cols.includes('snmp_profile')) db.exec("ALTER TABLE devices ADD COLUMN snmp_profile TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('mute_local_alerts')) db.exec("ALTER TABLE devices ADD COLUMN mute_local_alerts INTEGER NOT NULL DEFAULT 0");
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
  if (!['vi', 'en'].includes(out.default_lang)) out.default_lang = 'vi';
  return out;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

module.exports = { open, getSettings, setSetting, DEFAULT_TYPE_SEVERITY };
