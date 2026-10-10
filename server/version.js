'use strict';
// Identifies the running code so an operator can tell whether the server is
// on the new or old build, however it was deployed (git pull, copied files...).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

// Features the operator can check for; add a name when shipping a capability.
const FEATURES = ['snmp-host-resources', 'snmp-profiles', 'disk-guard'];

function gitShortSha() {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const file = path.join(root, '.git', ref);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().slice(0, 7);
    const line = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : '';
  } catch { return ''; }
}

function buildFile() {
  try { return fs.readFileSync(path.join(root, 'BUILD'), 'utf8').trim().split(/\s+/)[0]; } catch { return ''; }
}

// Hash of the real source files: changes whenever any code file changes.
function codeHash() {
  const h = crypto.createHash('sha1');
  for (const dir of ['server', 'server/profiles', 'public']) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)).filter((n) => /\.(js|css|html|json)$/.test(n)).sort(); } catch { /* missing dir */ }
    for (const n of names) {
      h.update(`${dir}/${n}\0`);
      try { h.update(fs.readFileSync(path.join(root, dir, n))); } catch { /* unreadable */ }
    }
  }
  return h.digest('hex').slice(0, 8);
}

const info = {
  version: pkg.version,
  build: gitShortSha() || buildFile() || 'unknown',
  code: codeHash(),
  features: FEATURES,
  started_at: Date.now(),
};

module.exports = { info };
