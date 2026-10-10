'use strict';
const path = require('node:path');
const { open } = require('./db');
const { Monitor } = require('./monitor');
const { createApp } = require('./app');
const auth = require('./auth');

const env = process.env;
const dbFile = env.DB_FILE || path.join(__dirname, '..', 'data', 'monitor.db');
const port = Number(env.PORT) || 8080;
const host = env.HOST || '0.0.0.0';

const db = open(dbFile);
auth.ensureAdmin(db);

const monitor = new Monitor(db, {
  ...(env.PING_INTERVAL_MS && { pingIntervalMs: Number(env.PING_INTERVAL_MS) }),
  ...(env.AGENT_TIMEOUT_MS && { agentTimeoutMs: Number(env.AGENT_TIMEOUT_MS) }),
  ...(env.RETENTION_DAYS && { retentionDays: Number(env.RETENTION_DAYS) }),
});
monitor.start();
setInterval(() => auth.purgeSessions(db), 3600e3).unref();

const server = createApp(db, monitor, { secureCookie: env.COOKIE_SECURE === '1' });
server.listen(port, host, () => console.log(`[monitor] listening on http://${host}:${port}  db=${dbFile}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { monitor.stop(); server.close(); db.close(); process.exit(0); });
}
