'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { open } = require('../server/db');
const { Monitor } = require('../server/monitor');
const { createApp } = require('../server/app');
const auth = require('../server/auth');
const diag = require('../server/diagnostics');
const { startReplay, loadFixture } = require('./helpers/snmp-replay');

async function boot(appOpts = {}) {
  process.env.ADMIN_PASSWORD = 'initial-pass-1';
  const db = open(':memory:');
  auth.ensureAdmin(db, () => {});
  const monitor = new Monitor(db, {
    pingFn: async () => ({ ok: true, rtt: 1.2 }),
  });
  const server = createApp(db, monitor, appOpts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const createClient = () => {
    let cookie = '';
    return async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'monitor', cookie, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null) };
    };
  };
  const api = createClient();
  const close = () => { monitor.stop(); server.close(); server.closeAllConnections?.(); };
  return { db, monitor, api, createClient, close, base };
}

async function loginAdmin(t) {
  await t.api('POST', '/api/auth/login', { username: 'admin', password: 'initial-pass-1' });
  await t.api('POST', '/api/auth/password', { current: 'initial-pass-1', password: 'new-password-1' });
}

test('diagnostics unit: parsePingOutput, parseTracerouteOutput, parsePortsInput and labelOid', () => {
  const samplePing = [
    'PING 10.0.0.1 (10.0.0.1) 56(84) bytes of data.',
    '64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=1.20 ms',
    '64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=2.40 ms',
    '64 bytes from 10.0.0.1: icmp_seq=3 ttl=64 time=1.80 ms',
    '--- 10.0.0.1 ping statistics ---',
    '4 packets transmitted, 3 received, 25% packet loss, time 3004ms',
  ].join('\n');

  const p = diag.parsePingOutput(samplePing, 4);
  assert.equal(p.ok, true);
  assert.equal(p.transmitted, 4);
  assert.equal(p.received, 3);
  assert.equal(p.loss_percent, 25);
  assert.equal(p.min_ms, 1.2);
  assert.equal(p.max_ms, 2.4);
  assert.equal(p.avg_ms, 1.8);
  assert.equal(p.jitter_ms, 0.9);
  assert.equal(p.replies.length, 3);

  const sampleTrace = [
    'traceroute to 10.0.0.50 (10.0.0.50), 15 hops max',
    ' 1  10.0.0.1  0.84 ms',
    ' 2  *',
    ' 3  10.0.0.50  2.15 ms',
  ].join('\n');

  const hops = diag.parseTracerouteOutput(sampleTrace);
  assert.equal(hops.length, 3);
  assert.deepEqual(hops[0], { hop: 1, ip: '10.0.0.1', rtt_ms: 0.84, timeout: false, raw: '1  10.0.0.1  0.84 ms' });
  assert.equal(hops[1].timeout, true);
  assert.equal(hops[2].ip, '10.0.0.50');

  assert.deepEqual(diag.parsePortsInput('22, 80, 443, 80, invalid, 70000'), [22, 80, 443]);
  assert.equal(diag.labelOid('1.3.6.1.2.1.1.5.0'), 'sysName.0');
  assert.equal(diag.labelOid('1.3.6.1.2.1.2.2.1.2.4'), 'ifDescr.4');
});

test('diagnostics unit: runTraceroute falls back to ICMP TTL sweep when traceroute/tracepath are missing', async () => {
  const calls = [];
  const execFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'traceroute' || cmd === 'tracepath') {
      const err = new Error('not found');
      err.code = 'ENOENT';
      return { err, stdout: '', stderr: '' };
    }
    const ttlIdx = args.indexOf('-t');
    const ttl = ttlIdx !== -1 ? Number(args[ttlIdx + 1]) : 1;
    if (ttl === 1) {
      return { err: { code: 1 }, stdout: 'From 192.168.1.1 icmp_seq=1 Time to live exceeded\n', stderr: '' };
    }
    return { err: null, stdout: '64 bytes from 192.168.1.10: icmp_seq=1 ttl=63 time=1.45 ms\n', stderr: '' };
  };

  const res = await diag.runTraceroute({ host: '192.168.1.10', maxHops: 5, execFn });
  assert.equal(res.ok, true);
  assert.equal(res.hops.length, 2);
  assert.equal(res.hops[0].ip, '192.168.1.1');
  assert.equal(res.hops[1].ip, '192.168.1.10');
  assert.equal(res.hops[1].rtt_ms, 1.45);
});

test('diagnostics unit: runTcpCheck detects open and closed local TCP ports', async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const openPort = srv.address().port;
  try {
    const res = await diag.runTcpCheck({ host: '127.0.0.1', ports: [openPort, 1], timeoutMs: 800 });
    assert.equal(res.ok, true);
    assert.equal(res.open_count, 1);
    assert.equal(res.total_count, 2);
    const pOpen = res.results.find((x) => x.port === openPort);
    const pClosed = res.results.find((x) => x.port === 1);
    assert.equal(pOpen.open, true);
    assert.equal(typeof pOpen.rtt_ms, 'number');
    assert.equal(pClosed.open, false);
  } finally {
    srv.close();
  }
});

test('diagnostics API: RBAC permissions and end-to-end Ping, Traceroute, TCP, and SNMP Live Walk', async () => {
  const replay = await startReplay('mikrotik-routeros-x86', { community: 'public' });
  const t = await boot({
    diag: {
      pingExecFn: async () => ({
        err: null,
        stdout: '64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.42 ms\n1 packets transmitted, 1 received, 0% packet loss\n',
        stderr: '',
      }),
      traceExecFn: async () => ({
        err: null,
        stdout: 'traceroute to 127.0.0.1\n 1  127.0.0.1  0.31 ms\n',
        stderr: '',
      }),
      tcpProbeFn: async (host, port) => ({
        port,
        service: diag.WELL_KNOWN_PORTS[port] || 'TCP',
        open: port === 80 || port === 8291,
        state: (port === 80 || port === 8291) ? 'open' : 'closed',
        rtt_ms: (port === 80 || port === 8291) ? 1.1 : null,
        error: null,
      }),
    },
  });

  try {
    await loginAdmin(t);
    const devRes = await t.api('POST', '/api/devices', {
      name: 'Core-MikroTik',
      type: 'router',
      address: '127.0.0.1',
      snmp_enabled: true,
      snmp_port: replay.port,
      snmp_community: 'public',
    });
    assert.equal(devRes.status, 201);
    const devId = devRes.body.id;

    // Create a viewer and an operator
    await t.api('POST', '/api/users', { username: 'viewer1', password: 'password-123', role: 'viewer' });
    await t.api('POST', '/api/users', { username: 'op1', password: 'password-123', role: 'operator' });

    const viewerApi = t.createClient();
    await viewerApi('POST', '/api/auth/login', { username: 'viewer1', password: 'password-123' });
    await viewerApi('POST', '/api/auth/password', { current: 'password-123', password: 'new-password-123' });

    // Viewer cannot execute diagnostic tools
    const viewerAttempt = await viewerApi('POST', `/api/devices/${devId}/diag`, { tool: 'ping' });
    assert.equal(viewerAttempt.status, 403);

    // Operator can execute all 4 diagnostic tools
    const opApi = t.createClient();
    await opApi('POST', '/api/auth/login', { username: 'op1', password: 'password-123' });
    await opApi('POST', '/api/auth/password', { current: 'password-123', password: 'new-password-123' });

    const pingDiag = await opApi('POST', `/api/devices/${devId}/diag`, { tool: 'ping', count: 1 });
    assert.equal(pingDiag.status, 200);
    assert.equal(pingDiag.body.result.ok, true);
    assert.equal(pingDiag.body.result.loss_percent, 0);

    const traceDiag = await opApi('POST', `/api/devices/${devId}/diag`, { tool: 'traceroute', max_hops: 10 });
    assert.equal(traceDiag.status, 200);
    assert.equal(traceDiag.body.result.ok, true);
    assert.equal(traceDiag.body.result.hops[0].ip, '127.0.0.1');

    const tcpDiag = await opApi('POST', `/api/devices/${devId}/diag`, { tool: 'tcp', ports: '22, 80, 8291' });
    assert.equal(tcpDiag.status, 200);
    assert.equal(tcpDiag.body.result.open_count, 2);

    const snmpDiag = await opApi('POST', `/api/devices/${devId}/diag`, { tool: 'snmp', oid: 'system' });
    assert.equal(snmpDiag.status, 200);
    assert.equal(snmpDiag.body.result.ok, true);
    assert.ok(snmpDiag.body.result.rows.some((r) => r.label === 'sysDescr.0' && /RouterOS/i.test(r.value)));
  } finally {
    await replay.close();
    t.close();
  }
});

test('diagnostics UI isolation: index.html loads /diagnostics.js and defines M.openDiagnosticsModal', () => {
  const pubDir = path.join(__dirname, '..', 'public');
  const indexHtml = fs.readFileSync(path.join(pubDir, 'index.html'), 'utf8');
  const diagJs = fs.readFileSync(path.join(pubDir, 'diagnostics.js'), 'utf8');
  assert.ok(indexHtml.includes('<script src="/diagnostics.js"></script>'));
  assert.ok(diagJs.includes('M.openDiagnosticsModal'));
  assert.ok(diagJs.includes('/api/devices/'));
});
