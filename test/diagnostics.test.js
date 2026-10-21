'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
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

  assert.deepEqual(diag.parsePortsInput('22, 80, 443, 80, invalid, 70000'), [
    { port: 22, protocol: 'tcp' },
    { port: 80, protocol: 'tcp' },
    { port: 443, protocol: 'tcp' },
  ]);
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

test('diagnostics unit: parsePortsInput supports comma lists, ranges, combinations, bounds, and deduplication', () => {
  // Comma-separated with auto protocol mapping (53 -> udp, 22/80/443 -> tcp)
  assert.deepEqual(diag.parsePortsInput('22, 53, 80, 443'), [
    { port: 22, protocol: 'tcp' },
    { port: 53, protocol: 'udp' },
    { port: 80, protocol: 'tcp' },
    { port: 443, protocol: 'tcp' },
  ]);

  // Range with and without spaces
  assert.deepEqual(diag.parsePortsInput('22-25'), [
    { port: 22, protocol: 'tcp' },
    { port: 23, protocol: 'tcp' },
    { port: 24, protocol: 'tcp' },
    { port: 25, protocol: 'tcp' },
  ]);
  assert.deepEqual(diag.parsePortsInput('22 - 25'), [
    { port: 22, protocol: 'tcp' },
    { port: 23, protocol: 'tcp' },
    { port: 24, protocol: 'tcp' },
    { port: 25, protocol: 'tcp' },
  ]);

  // Combined format: list + range
  assert.deepEqual(diag.parsePortsInput('22, 80, 100-103'), [
    { port: 22, protocol: 'tcp' },
    { port: 80, protocol: 'tcp' },
    { port: 100, protocol: 'tcp' },
    { port: 101, protocol: 'tcp' },
    { port: 102, protocol: 'tcp' },
    { port: 103, protocol: 'tcp' },
  ]);

  // Deduplication & preserve order
  assert.deepEqual(diag.parsePortsInput('80, 78-82, 80'), [
    { port: 80, protocol: 'tcp' },
    { port: 78, protocol: 'tcp' },
    { port: 79, protocol: 'tcp' },
    { port: 81, protocol: 'tcp' },
    { port: 82, protocol: 'tcp' },
  ]);

  // Clamping and invalid filtering
  assert.deepEqual(diag.parsePortsInput('0-3, invalid, 65534-70000'), [
    { port: 1, protocol: 'tcp' },
    { port: 2, protocol: 'tcp' },
    { port: 3, protocol: 'tcp' },
    { port: 65534, protocol: 'tcp' },
    { port: 65535, protocol: 'tcp' },
  ]);

  // Reversed range handling
  assert.deepEqual(diag.parsePortsInput('103 - 100'), [
    { port: 100, protocol: 'tcp' },
    { port: 101, protocol: 'tcp' },
    { port: 102, protocol: 'tcp' },
    { port: 103, protocol: 'tcp' },
  ]);

  // Large range support (no arbitrary 24 port cap)
  const large = diag.parsePortsInput('22-8000');
  assert.equal(large.length, 7979);
  assert.equal(large[0].port, 22);
  assert.equal(large[large.length - 1].port, 8000);

  // Explicit suffix override (e.g. 161/udp, 80/tcp, 161/tcp, 80/udp)
  assert.deepEqual(diag.parsePortsInput('161/udp, 80/tcp, 161/tcp, 80/udp'), [
    { port: 161, protocol: 'udp', explicit: true },
    { port: 80, protocol: 'tcp', explicit: true },
    { port: 161, protocol: 'tcp', explicit: true },
    { port: 80, protocol: 'udp', explicit: true },
  ]);

  // Explicit suffix on ranges
  assert.deepEqual(diag.parsePortsInput('160-162/udp'), [
    { port: 160, protocol: 'udp', explicit: true },
    { port: 161, protocol: 'udp', explicit: true },
    { port: 162, protocol: 'udp', explicit: true },
  ]);

  // Deduplication with both auto and explicit
  assert.deepEqual(diag.parsePortsInput('161, 161/udp, 80, 80/tcp'), [
    { port: 161, protocol: 'udp' },
    { port: 80, protocol: 'tcp' },
  ]);

  // Range detection helper
  assert.equal(diag.hasRangeInput('22, 80, 443'), false);
  assert.equal(diag.hasRangeInput('22 - 8000'), true);
  assert.equal(diag.hasRangeInput('22, 80, 100-200'), true);
  assert.equal(diag.hasRangeInput('160-162/udp'), true);
});

test('diagnostics unit: defaultUdpProbe detects open UDP service and closed UDP port', async () => {
  const srv = dgram.createSocket('udp4');
  srv.on('message', (msg, rinfo) => {
    srv.send(Buffer.from('pong'), rinfo.port, rinfo.address);
  });
  await new Promise((r) => srv.bind(0, '127.0.0.1', r));
  const openUdpPort = srv.address().port;

  try {
    const resOpen = await diag.defaultUdpProbe('127.0.0.1', openUdpPort, 600);
    assert.equal(resOpen.open, true);
    assert.equal(resOpen.state, 'open');
    assert.equal(resOpen.protocol, 'udp');
    assert.equal(typeof resOpen.rtt_ms, 'number');

    // Port 19999 is closed and unmapped on loopback
    const resClosed = await diag.defaultUdpProbe('127.0.0.1', 19999, 400);
    assert.equal(resClosed.open, false);
    assert.ok(resClosed.state === 'closed' || resClosed.state === 'timeout');
  } finally {
    srv.close();
  }
});

test('diagnostics unit: defaultUdpProbe sends valid SNMP GetRequest and DNS Query payloads and counts any response as open', async () => {
  let receivedSnmp = null;
  const snmpSrv = dgram.createSocket('udp4');
  snmpSrv.on('message', (msg, rinfo) => {
    receivedSnmp = msg;
    // Return an SNMP error response or dummy bytes (e.g. auth failure / bad community)
    snmpSrv.send(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => snmpSrv.bind(0, '127.0.0.1', r));
  const snmpPort = snmpSrv.address().port;

  let receivedDns = null;
  const dnsSrv = dgram.createSocket('udp4');
  dnsSrv.on('message', (msg, rinfo) => {
    receivedDns = msg;
    // Return dummy DNS response
    dnsSrv.send(Buffer.from('123481800001000000000000', 'hex'), rinfo.port, rinfo.address);
  });
  await new Promise((r) => dnsSrv.bind(0, '127.0.0.1', r));
  const dnsPort = dnsSrv.address().port;

  try {
    // Probe mock SNMP port (using port 161 logic by calling with 161 payload or port 161)
    // When port is 161, defaultUdpProbe sends SNMP GET payload
    // Let's test with port 161 simulation using a custom probe or testing the payload directly
    assert.ok(diag.SNMP_PROBE_PAYLOAD.length > 30);
    assert.equal(diag.SNMP_PROBE_PAYLOAD[0], 0x30); // ASN.1 Sequence
    assert.ok(diag.SNMP_PROBE_PAYLOAD.toString('binary').includes('public'));

    assert.ok(diag.DNS_PROBE_PAYLOAD.length >= 17);
    assert.equal(diag.DNS_PROBE_PAYLOAD[0], 0x12);
    assert.equal(diag.DNS_PROBE_PAYLOAD[1], 0x34);

    // Test probe against snmpSrv
    const snmpRes = await diag.defaultUdpProbe('127.0.0.1', snmpPort, 500);
    assert.equal(snmpRes.open, true);
    assert.equal(snmpRes.state, 'open');
    assert.equal(snmpRes.protocol, 'udp');

    // Test probe against dnsSrv
    const dnsRes = await diag.defaultUdpProbe('127.0.0.1', dnsPort, 500);
    assert.equal(dnsRes.open, true);
    assert.equal(dnsRes.state, 'open');
    assert.equal(dnsRes.protocol, 'udp');
  } finally {
    snmpSrv.close();
    dnsSrv.close();
  }
});

test('diagnostics unit: runPortScan detailed mode for small list returns per-port cards with TCP and UDP states', async () => {
  const tcpCalls = [];
  const udpCalls = [];

  const mockTcpProbe = async (host, port) => {
    tcpCalls.push(port);
    return {
      port,
      protocol: 'tcp',
      service: diag.WELL_KNOWN_PORTS[port] || 'TCP',
      open: port === 80,
      state: port === 80 ? 'open' : 'closed',
      rtt_ms: port === 80 ? 1.5 : null,
      error: port === 80 ? null : 'ECONNREFUSED',
    };
  };

  const mockUdpProbe = async (host, port) => {
    udpCalls.push(port);
    return {
      port,
      protocol: 'udp',
      service: diag.WELL_KNOWN_PORTS[port] || 'UDP',
      open: port === 53,
      state: port === 53 ? 'open' : 'closed',
      rtt_ms: port === 53 ? 2.0 : null,
      error: port === 53 ? null : 'ECONNREFUSED',
    };
  };

  const res = await diag.runPortScan({
    host: '127.0.0.1',
    ports: '22, 53, 80',
    tcpProbeFn: mockTcpProbe,
    udpProbeFn: mockUdpProbe,
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'detailed');
  assert.equal(res.total_count, 3);
  assert.equal(res.open_count, 2);
  assert.equal(res.tcp_open_count, 1);
  assert.equal(res.udp_open_count, 1);
  assert.equal(res.results.length, 3);

  // Auto-protocol mapping dispatches 22, 80 to TCP probe, and 53 to UDP probe
  assert.deepEqual(tcpCalls, [22, 80]);
  assert.deepEqual(udpCalls, [53]);

  const p53 = res.results.find((x) => x.port === 53);
  const p80 = res.results.find((x) => x.port === 80);
  const p22 = res.results.find((x) => x.port === 22);

  assert.equal(p53.open, true);
  assert.equal(p53.protocol, 'udp');
  assert.equal(p80.open, true);
  assert.equal(p80.protocol, 'tcp');
  assert.equal(p22.open, false);
});

test('diagnostics unit: runPortScan supports explicit override suffixes (e.g. 161/tcp, 80/udp)', async () => {
  const tcpCalls = [];
  const udpCalls = [];

  const mockTcpProbe = async (host, port) => {
    tcpCalls.push(port);
    return {
      port,
      protocol: 'tcp',
      service: 'TCP',
      open: port === 161, // Explicit 161/tcp is open
      state: port === 161 ? 'open' : 'closed',
      rtt_ms: port === 161 ? 1.0 : null,
      error: null,
    };
  };

  const mockUdpProbe = async (host, port) => {
    udpCalls.push(port);
    return {
      port,
      protocol: 'udp',
      service: 'UDP',
      open: port === 80, // Explicit 80/udp is open
      state: port === 80 ? 'open' : 'closed',
      rtt_ms: port === 80 ? 2.0 : null,
      error: null,
    };
  };

  const res = await diag.runPortScan({
    host: '127.0.0.1',
    ports: '161/tcp, 80/udp, 443/tcp',
    tcpProbeFn: mockTcpProbe,
    udpProbeFn: mockUdpProbe,
  });

  assert.equal(res.ok, true);
  assert.equal(res.total_count, 3);
  assert.equal(res.open_count, 2);
  assert.equal(res.tcp_open_count, 1); // 161/tcp
  assert.equal(res.udp_open_count, 1); // 80/udp

  assert.deepEqual(tcpCalls, [161, 443]);
  assert.deepEqual(udpCalls, [80]);

  const p161 = res.results.find((x) => x.port === 161);
  const p80 = res.results.find((x) => x.port === 80);
  assert.equal(p161.protocol, 'tcp');
  assert.equal(p161.open, true);
  assert.equal(p80.protocol, 'udp');
  assert.equal(p80.open, true);
});

test('diagnostics unit: runPortScan range mode limits concurrency and returns summary counts without full element payload', async () => {
  let activeConcurrency = 0;
  let maxObservedConcurrency = 0;

  const mockTcpProbe = async (host, port) => {
    activeConcurrency++;
    if (activeConcurrency > maxObservedConcurrency) {
      maxObservedConcurrency = activeConcurrency;
    }
    await new Promise((r) => setTimeout(r, 2));
    activeConcurrency--;
    return {
      port,
      protocol: 'tcp',
      service: 'TCP',
      open: port === 100 || port === 200,
      state: (port === 100 || port === 200) ? 'open' : 'closed',
      rtt_ms: (port === 100 || port === 200) ? 1.0 : null,
      error: null,
    };
  };

  const mockUdpProbe = async (host, port) => {
    return {
      port,
      protocol: 'udp',
      service: 'UDP',
      open: port === 161, // SNMP port in CORE_UDP_PORTS
      state: port === 161 ? 'open' : 'closed',
      rtt_ms: port === 161 ? 1.2 : null,
      error: null,
    };
  };

  const res = await diag.runPortScan({
    host: '127.0.0.1',
    ports: '100-250', // 151 ports
    concurrency: 16,
    tcpProbeFn: mockTcpProbe,
    udpProbeFn: mockUdpProbe,
  });

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'summary');
  assert.equal(res.is_range, true);
  assert.equal(res.total_count, 151);
  assert.equal(res.tcp_open_count, 2); // 100, 200
  assert.equal(res.udp_open_count, 1); // 161
  assert.equal(res.open_count, 3);
  assert.equal(res.results, undefined);
  assert.equal(res.open_ports.length, 3);
  assert.ok(maxObservedConcurrency <= 16, `Observed concurrency ${maxObservedConcurrency} exceeded limit 16`);
});

test('diagnostics API: Range port scan returns summary mode with TCP/UDP counts', async () => {
  const t = await boot({
    diag: {
      tcpProbeFn: async (host, port) => ({
        port,
        service: diag.WELL_KNOWN_PORTS[port] || 'TCP',
        open: port === 80 || port === 443,
        state: (port === 80 || port === 443) ? 'open' : 'closed',
        rtt_ms: (port === 80 || port === 443) ? 1.1 : null,
        error: null,
      }),
      udpProbeFn: async (host, port) => ({
        port,
        service: diag.WELL_KNOWN_PORTS[port] || 'UDP',
        open: port === 53 || port === 161,
        state: (port === 53 || port === 161) ? 'open' : 'closed',
        rtt_ms: (port === 53 || port === 161) ? 2.2 : null,
        error: null,
      }),
    },
  });

  try {
    await loginAdmin(t);
    const devRes = await t.api('POST', '/api/devices', {
      name: 'Scan-Router',
      type: 'router',
      address: '127.0.0.1',
    });
    const devId = devRes.body.id;

    // Test range scan: 50-170 (121 ports) -> auto-summary mode
    const rangeDiag = await t.api('POST', `/api/devices/${devId}/diag`, {
      tool: 'tcp',
      ports: '50 - 170',
    });

    assert.equal(rangeDiag.status, 200);
    const res = rangeDiag.body.result;
    assert.equal(res.mode, 'summary');
    assert.equal(res.is_range, true);
    assert.equal(res.total_count, 121);
    assert.equal(res.tcp_open_count, 1); // port 80
    assert.equal(res.udp_open_count, 2); // port 53, 161
    assert.equal(res.open_count, 3);
    assert.equal(res.results, undefined);
    assert.equal(res.open_ports.length, 3);
  } finally {
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

test('diagnostics agent unit: parseAndValidateListeningPorts validates and formats listening services correctly', () => {
  const rawInput = JSON.stringify([
    { proto: 'tcp', port: 80, service: 'nginx/w3wp' },
    { proto: 'udp', port: 161, service: 'snmpd' },
    { proto: 'tcp', port: 22, service: '' }, // empty service should fallback to SSH
    { proto: 'tcp', port: 80, service: 'nginx/w3wp' }, // duplicate, should be deduplicated
    { proto: 'icmp', port: 0, service: 'invalid' }, // invalid proto, should be discarded
    { proto: 'tcp', port: 99999, service: 'out-of-range' }, // port > 65535, should be discarded
    { proto: 'udp', port: 53, service: 'named' },
  ]);

  const res = diag.parseAndValidateListeningPorts(rawInput);
  assert.equal(res.total_count, 4);
  assert.equal(res.tcp_count, 2);
  assert.equal(res.udp_count, 2);

  const tcp80 = res.services.find((s) => s.proto === 'tcp' && s.port === 80);
  assert.ok(tcp80);
  assert.equal(tcp80.service, 'nginx/w3wp');
  assert.equal(tcp80.state, 'LISTEN');

  const tcp22 = res.services.find((s) => s.proto === 'tcp' && s.port === 22);
  assert.ok(tcp22);
  assert.equal(tcp22.service, 'SSH');
  assert.equal(tcp22.state, 'LISTEN');

  const udp161 = res.services.find((s) => s.proto === 'udp' && s.port === 161);
  assert.ok(udp161);
  assert.equal(udp161.service, 'snmpd');
  assert.equal(udp161.state, 'LISTEN');

  const udp53 = res.services.find((s) => s.proto === 'udp' && s.port === 53);
  assert.ok(udp53);
  assert.equal(udp53.service, 'named');
  assert.equal(udp53.state, 'LISTEN');
});

test('diagnostics agent unit: Windows PID 4 System and privileged System/Unknown processes are preserved', () => {
  const winPayload = [
    { proto: 'tcp', port: 445, service: 'System' },
    { proto: 'tcp', port: 135, service: 'System/Unknown' },
    { proto: 'tcp', port: 80, service: 'w3wp' },
  ];
  const res = diag.parseAndValidateListeningPorts(winPayload);
  assert.equal(res.total_count, 3);
  assert.equal(res.services.find((s) => s.port === 445).service, 'System');
  assert.equal(res.services.find((s) => s.port === 135).service, 'System/Unknown');
  assert.equal(res.services.find((s) => s.port === 80).service, 'w3wp');

  // Verify Windows agent script includes the System/Unknown fallback logic
  const winPs1 = fs.readFileSync(path.join(__dirname, '..', 'agents', 'windows', 'agent.ps1'), 'utf8');
  assert.ok(winPs1.includes('System/Unknown'));
  assert.ok(winPs1.includes('-ErrorAction SilentlyContinue'));
  assert.ok(winPs1.includes('$p -eq 4'));
});

test('diagnostics agent API: server devices use agent-based listening services without remote packet scan', async () => {
  let remoteProbeCalled = false;
  const t = await boot({
    diag: {
      tcpProbeFn: async () => {
        remoteProbeCalled = true;
        return { open: false };
      },
    },
  });

  try {
    await loginAdmin(t);

    // Create a server device
    const srvRes = await t.api('POST', '/api/devices', {
      name: 'Web-App-Server',
      type: 'server',
      address: '10.20.30.40',
      check_agent: true,
    });
    const srvId = srvRes.body.id;

    // Simulate Agent sending listening ports via POST /api/devices/:id/listening-services
    const samplePayload = [
      { proto: 'tcp', port: 80, service: 'nginx/w3wp' },
      { proto: 'tcp', port: 443, service: 'nginx/w3wp' },
      { proto: 'udp', port: 161, service: 'snmpd' },
    ];

    const postPortsRes = await t.api('POST', `/api/devices/${srvId}/listening-services`, samplePayload);
    assert.equal(postPortsRes.status, 200);
    assert.equal(postPortsRes.body.ok, true);
    assert.equal(postPortsRes.body.total_count, 3);
    assert.equal(postPortsRes.body.tcp_count, 2);
    assert.equal(postPortsRes.body.udp_count, 1);
    assert.equal(postPortsRes.body.services[0].state, 'LISTEN');

    // Call GET /api/devices/:id/listening-services (called by frontend when user clicks Fetch)
    const getPortsRes = await t.api('GET', `/api/devices/${srvId}/listening-services`);
    assert.equal(getPortsRes.status, 200);
    assert.equal(getPortsRes.body.ok, true);
    assert.equal(getPortsRes.body.total_count, 3);
    assert.equal(getPortsRes.body.services.length, 3);

    // Call POST /api/devices/:id/diag with tool: 'tcp' on a server device
    const diagRes = await t.api('POST', `/api/devices/${srvId}/diag`, { tool: 'tcp' });
    assert.equal(diagRes.status, 200);
    assert.equal(diagRes.body.ok, true);
    assert.equal(diagRes.body.result.mode, 'agent');
    assert.equal(diagRes.body.result.total_count, 3);
    assert.equal(diagRes.body.result.tcp_count, 2);
    assert.equal(diagRes.body.result.udp_count, 1);
    assert.equal(diagRes.body.result.services.length, 3);

    // Remote probe should NOT be called for server devices
    assert.equal(remoteProbeCalled, false);
  } finally {
    t.close();
  }
});

test('diagnostics agent API: periodic report /api/agent/report ingests listening_ports', async () => {
  const t = await boot();
  try {
    await loginAdmin(t);
    const c = await t.api('POST', '/api/devices', {
      name: 'App-Linux-Host',
      type: 'server',
      check_agent: true,
      check_icmp: false,
    });
    const devId = c.body.id;
    const dev = (await t.api('GET', `/api/devices/${devId}`)).body;

    // Report from agent with listening_ports
    const reportRes = await t.api('POST', '/api/agent/report', {
      hostname: 'App-Linux-Host',
      os: 'Linux',
      agent_version: '1.0.0',
      ip: '192.168.1.100',
      listening_ports: [
        { proto: 'tcp', port: 8080, service: 'node' },
        { proto: 'tcp', port: 22, service: 'sshd' },
        { proto: 'udp', port: 123, service: 'chronyd' },
      ],
    }, { authorization: `Bearer ${dev.agent_token}`, cookie: '' });

    assert.equal(reportRes.status, 200);

    // Verify listening services are stored and queryable
    const getRes = await t.api('GET', `/api/devices/${devId}/listening-services`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.ok, true);
    assert.equal(getRes.body.total_count, 3);
    assert.equal(getRes.body.tcp_count, 2);
    assert.equal(getRes.body.udp_count, 1);
    const s8080 = getRes.body.services.find((s) => s.port === 8080);
    assert.ok(s8080);
    assert.equal(s8080.service, 'node');
    assert.equal(s8080.state, 'LISTEN');

    // Also test dedicated agent token endpoint: POST /api/agent/listening-ports
    const directAgentPost = await t.api('POST', '/api/agent/listening-ports', [
      { proto: 'tcp', port: 3306, service: 'mysqld' },
      { proto: 'udp', port: 161, service: 'snmpd' },
    ], { authorization: `Bearer ${dev.agent_token}`, cookie: '' });

    assert.equal(directAgentPost.status, 200);
    assert.equal(directAgentPost.body.ok, true);
    assert.equal(directAgentPost.body.total_count, 2);

    const getUpdated = await t.api('GET', `/api/devices/${devId}/listening-services`);
    assert.equal(getUpdated.status, 200);
    assert.equal(getUpdated.body.total_count, 2);
    assert.equal(getUpdated.body.services.find((s) => s.port === 3306).service, 'mysqld');
  } finally {
    t.close();
  }
});

test('diagnostics UI: verifies server-type logic, listening services button, and LISTEN table rendering', () => {
  const diagJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'diagnostics.js'), 'utf8');
  assert.ok(diagJs.includes("curDev.type === 'server'"));
  assert.ok(diagJs.includes('Fetch Listening Services') || diagJs.includes('Tải danh sách dịch vụ thực tế'));
  assert.ok(diagJs.includes('/api/devices/${curDev.id}/listening-services') || diagJs.includes('/listening-services'));
  assert.ok(diagJs.includes('LISTEN'));
});
