'use strict';
const crypto = require('node:crypto');

const SESSION_TTL = 12 * 3600 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(sha(token), userId, Date.now() + SESSION_TTL);
  return token;
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.role, u.must_change, u.theme, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { destroySession(db, token); return null; }
  return row;
}

function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function destroyUserSessions(db, userId, exceptToken) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, exceptToken ? sha(exceptToken) : '');
}

function purgeSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
    }
  }
  return out;
}

// Seeds the first admin. Password comes from ADMIN_PASSWORD or is generated and printed once.
function ensureAdmin(db, log = console.log) {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return null;
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO users(username,pass_hash,role,must_change,created_at) VALUES(?,?,?,?,?)')
    .run('admin', hashPassword(pw), 'admin', 1, Date.now());
  log(`[setup] Created user "admin" with initial password: ${pw}  (must be changed at first login)`);
  return pw;
}

// Sliding-window limiter for failed logins, keyed by IP.
class LoginLimiter {
  constructor(max = 8, windowMs = 5 * 60 * 1000) { this.max = max; this.windowMs = windowMs; this.m = new Map(); }
  _prune(key) {
    const now = Date.now();
    const arr = (this.m.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.m.set(key, arr); else this.m.delete(key);
    return arr;
  }
  blocked(key) { return this._prune(key).length >= this.max; }
  fail(key) { const a = this._prune(key); a.push(Date.now()); this.m.set(key, a); }
  reset(key) { this.m.delete(key); }
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự';
  if (pw.length > 128) return 'Mật khẩu quá dài';
  return null;
}

module.exports = {
  hashPassword, verifyPassword, createSession, getSessionUser, destroySession,
  destroyUserSessions, purgeSessions, parseCookies, ensureAdmin, LoginLimiter, validatePassword, SESSION_TTL,
};
