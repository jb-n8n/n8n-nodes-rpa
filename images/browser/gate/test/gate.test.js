// The token gate in front of the Playwright run-server. node:test, no dependencies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWED_LAUNCH_OPTIONS, createGate, MIN_TOKEN_LENGTH, MIN_UPSTREAM_PATH_SECRET } from '../gate.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
/** The random run-server path the compose stack generates at container start (128 bits, hex). */
const UPSTREAM_PATH = '/9f86d081884c7d659a2feaa0c55ad015';
const SECRET = UPSTREAM_PATH.slice(1);
const GATE_FILE = fileURLToPath(new URL('../gate.mjs', import.meta.url));

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

/** A stand-in for the run-server: answers every upgrade with 101, then echoes bytes back. */
async function fakeUpstream() {
  const seen = { connections: 0, requests: [] };
  const server = createServer((_req, res) => { res.writeHead(500); res.end(); });
  server.on('connection', () => { seen.connections += 1; });
  server.on('upgrade', (req, socket, head) => {
    seen.requests.push({ url: req.url, headers: { ...req.headers } });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  return { server, seen, port: await listen(server) };
}

/** An upgrade request to the gate: resolves with the status and, after a 101, the raw socket. */
function upgrade(port, headers = {}, path = '/pw?session=1') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers } });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

/** The raw bytes the gate answers to a hand-written request, until it closes the connection. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const s = connect({ host: '127.0.0.1', port }, () => s.write(text));
    s.on('data', (c) => chunks.push(c));
    s.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    s.on('error', reject);
  });
}

const upstream = await fakeUpstream();
const gate = createGate({ token: TOKEN, upstreamPort: upstream.port, upstreamPath: UPSTREAM_PATH });
const gatePort = await listen(gate);
after(async () => { await close(gate); await close(upstream.server); });
const AUTH = { Authorization: `Bearer ${TOKEN}` };
/** The headers playwright-core 1.63's chromium.connect sends (client/connect.ts, _connectOverWebSocket), plus the token. */
const ENGINE_HEADERS = { 'User-Agent': 'Playwright/1.63.0 (arm64; macOS 26.0) node/24.0', 'x-playwright-proxy': '', 'x-playwright-browser': 'chromium', ...AUTH };

test('with the right token the upgrade reaches the run-server and bytes round-trip', async () => {
  const before = upstream.seen.requests.length;
  const { status, socket } = await upgrade(gatePort, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(status, 101);
  socket.write('ping');
  const [chunk] = await once(socket, 'data');
  assert.equal(chunk.toString(), 'ping');
  socket.destroy();
  const forwarded = upstream.seen.requests[before];
  assert.equal(forwarded.url, `${UPSTREAM_PATH}?session=1`, 'the client path is replaced by the secret run-server path');
  assert.equal(forwarded.headers.upgrade, 'websocket');
  assert.equal(forwarded.headers.authorization, undefined, 'the token is not passed on to the run-server');
});

test('a wrong or missing token gets 401 and the run-server never sees a connection', async () => {
  const before = upstream.seen.connections;
  assert.equal((await upgrade(gatePort, { Authorization: `Bearer ${TOKEN.slice(0, -1)}x` })).status, 401);
  assert.equal((await upgrade(gatePort, { Authorization: `Bearer ${TOKEN}${TOKEN}` })).status, 401);
  assert.equal((await upgrade(gatePort, { Authorization: TOKEN })).status, 401);
  assert.equal((await upgrade(gatePort)).status, 401);
  assert.equal(upstream.seen.connections, before);
});

test('the headers the engine sends on connect pass, and the upgrade goes to the secret path', async () => {
  const before = upstream.seen.requests.length;
  const { status, socket } = await upgrade(gatePort, ENGINE_HEADERS, '/');
  assert.equal(status, 101);
  socket.destroy();
  assert.equal(upstream.seen.requests[before].url, UPSTREAM_PATH);
  assert.equal(upstream.seen.requests[before].headers['x-playwright-browser'], 'chromium');
});

test('the Host header becomes the run-server address (its DNS-rebinding check admits only loopback names)', async () => {
  // playwright-core 1.63 bound to 127.0.0.1 answers 403 unless Host is localhost, 127.0.0.1 or [::1]; n8n sends
  // Host: browser:3000. Origin is passed on unchanged so the run-server's own Origin check still applies.
  const before = upstream.seen.requests.length;
  const { status, socket } = await upgrade(gatePort, { ...ENGINE_HEADERS, Host: 'browser:3000', Origin: 'http://evil.example' }, '/');
  assert.equal(status, 101);
  socket.destroy();
  const forwarded = upstream.seen.requests[before];
  assert.equal(forwarded.headers.host, `127.0.0.1:${upstream.port}`);
  assert.equal(forwarded.headers.origin, 'http://evil.example');
});

test('launch options on the allowlist pass, in the header or the query', async () => {
  assert.deepEqual([...ALLOWED_LAUNCH_OPTIONS].sort(), ['headless', 'slowMo', 'timeout']);
  const options = JSON.stringify({ headless: true, timeout: 30000, slowMo: 0 });
  const header = await upgrade(gatePort, { ...AUTH, 'x-playwright-launch-options': options });
  assert.equal(header.status, 101);
  header.socket.destroy();
  const query = await upgrade(gatePort, AUTH, `/?launch-options=${encodeURIComponent(options)}`);
  assert.equal(query.status, 101);
  query.socket.destroy();
});

test('executablePath, ignoreDefaultArgs, env and every other launch option get 403 and never reach the run-server', async () => {
  const before = upstream.seen.connections;
  const refused = [
    { executablePath: '/bin/sh' }, { ignoreDefaultArgs: ['--disable-extensions'] }, { ignoreAllDefaultArgs: true },
    { env: { LD_PRELOAD: '/tmp/x.so' } }, { args: ['--no-sandbox'] }, { proxy: { server: 'socks5://10.0.0.1:1080' } },
    { headless: true, executablePath: '/bin/sh' }, { headless: 'yes' }, { timeout: -1 },
  ];
  for (const o of refused) {
    const json = JSON.stringify(o);
    assert.equal((await upgrade(gatePort, { ...AUTH, 'x-playwright-launch-options': json })).status, 403, `header ${json}`);
    assert.equal((await upgrade(gatePort, AUTH, `/?launch-options=${encodeURIComponent(json)}`)).status, 403, `query ${json}`);
  }
  // Not JSON, not an object, or given twice (the run-server would read only one of them).
  for (const bad of ['{', '[]', 'null', '"x"']) {
    assert.equal((await upgrade(gatePort, { ...AUTH, 'x-playwright-launch-options': bad })).status, 403, bad);
  }
  const ok = encodeURIComponent('{"headless":true}');
  const evil = encodeURIComponent('{"executablePath":"/bin/sh"}');
  assert.equal((await upgrade(gatePort, AUTH, `/?launch-options=${ok}&launch-options=${evil}`)).status, 403);
  // An allowed query does not hide a refused header (the run-server falls back to the header when the query is empty).
  assert.equal((await upgrade(gatePort, { ...AUTH, 'x-playwright-launch-options': '{"env":{}}' }, '/?launch-options=')).status, 403);
  assert.equal(upstream.seen.connections, before);
});

test('a client may not expose its own network to the browser (x-playwright-proxy / proxy)', async () => {
  const before = upstream.seen.connections;
  assert.equal((await upgrade(gatePort, { ...AUTH, 'x-playwright-proxy': '*' })).status, 403);
  assert.equal((await upgrade(gatePort, { ...AUTH, 'x-playwright-proxy': 'localhost' })).status, 403);
  assert.equal((await upgrade(gatePort, AUTH, '/?proxy=*')).status, 403);
  assert.equal(upstream.seen.connections, before);
});

test('the secret run-server path never appears in a response the gate writes', async () => {
  const replies = [
    await raw(gatePort, 'GET /json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'),
    await raw(gatePort, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'),
    await raw(gatePort, `GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${TOKEN}\r\nx-playwright-launch-options: {"env":{}}\r\n\r\n`),
  ];
  assert.match(replies[0], /^HTTP\/1\.1 404/);
  assert.match(replies[1], /^HTTP\/1\.1 401/);
  assert.match(replies[2], /^HTTP\/1\.1 403/);
  for (const r of replies) assert.doesNotMatch(r, new RegExp(SECRET));
});

test('the upstream path must be a secret of at least 32 characters, and the error never shows it', () => {
  assert.equal(MIN_UPSTREAM_PATH_SECRET, 32);
  for (const upstreamPath of [undefined, '/', '/short', 'no-leading-slash-0123456789abcdef0123', `${UPSTREAM_PATH}?x=1`, `${UPSTREAM_PATH}/../`]) {
    assert.throws(() => createGate({ token: TOKEN, upstreamPort: 1, upstreamPath }), /BROWSER_UPSTREAM_PATH must be/);
  }
  const run = spawnSync(process.execPath, [GATE_FILE], {
    env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: '/tooshort-secret', BROWSER_GATE_PORT: '0', BROWSER_UPSTREAM_PORT: '1' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BROWSER_UPSTREAM_PATH must be/);
  assert.doesNotMatch(run.stderr, /tooshort-secret/);
});

test('the start-up log names the port but not the secret path', async () => {
  const child = spawn(process.execPath, [GATE_FILE], {
    env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_UPSTREAM_PORT: '1', BROWSER_GATE_METRICS_PORT: '0' },
  });
  let out = '';
  child.stderr.on('data', (c) => { out += c; });
  const [line] = await once(child.stdout, 'data');
  out += line;
  child.kill();
  await once(child, 'exit');
  assert.match(out, /browser-gate: listening/);
  assert.doesNotMatch(out, new RegExp(SECRET));
});

test('an upgrade to anything but websocket gets 400 and never reaches the run-server', async () => {
  const before = upstream.seen.connections;
  assert.equal((await upgrade(gatePort, { ...AUTH, Upgrade: 'h2c' })).status, 400);
  assert.equal((await upgrade(gatePort, { ...AUTH, Upgrade: 'TLS/1.0' })).status, 400);
  assert.equal((await upgrade(gatePort, { Upgrade: 'h2c' })).status, 400);
  assert.equal(upstream.seen.connections, before);
  const mixedCase = await upgrade(gatePort, { ...AUTH, Upgrade: 'WebSocket' });
  assert.equal(mixedCase.status, 101);
  mixedCase.socket.destroy();
});

test('imported ahead of another entry point (argv[1] does not exist), it neither starts nor crashes', () => {
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(GATE_FILE).href, '/nonexistent-browser-gate-entry/x.mjs'], {
    env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.doesNotMatch(run.stderr, /ENOENT|realpath|lstat/);
  assert.doesNotMatch(run.stdout, /browser-gate: listening/);
  assert.match(run.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
});

test('a plain HTTP request gets 404', async () => {
  const res = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: gatePort, path: '/json/version' }, resolve).on('error', reject).end();
  });
  res.resume();
  assert.equal(res.statusCode, 404);
});

test('a token shorter than 32 characters is refused', () => {
  assert.equal(MIN_TOKEN_LENGTH, 32);
  assert.throws(() => createGate({ token: 'short', upstreamPort: 1, upstreamPath: UPSTREAM_PATH }), /at least 32 characters/);
  const run = spawnSync(process.execPath, [GATE_FILE], {
    env: { ...process.env, BROWSER_GATE_TOKEN: 'short', BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_UPSTREAM_PORT: '1' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BROWSER_GATE_TOKEN must be at least 32 characters/);
  assert.doesNotMatch(run.stderr, /short/);
});

// ---- The session limit, /healthz, metrics and drain (the browser service). ----

/** Polls until fn() is truthy, or fails after the deadline. */
async function until(fn, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plain GET; resolves with the status, headers and body. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

/** A port nothing listens on (bound, then released). */
async function freePort() {
  const s = createServer();
  const port = await listen(s);
  await close(s);
  return port;
}

/** A gate of its own on a fresh fake upstream, listening, with every onSessions call recorded; closed after the test. */
async function ownGate(t, options = {}) {
  const up = options.upstreamPort === undefined ? await fakeUpstream() : undefined;
  const g = createGate({ token: TOKEN, upstreamPort: up?.port, upstreamPath: UPSTREAM_PATH, ...options });
  const counts = [];
  g.onSessions((n) => counts.push(n));
  // Upgraded sockets are not closed by closeAllConnections, so the test ends every connection itself.
  const sockets = new Set();
  for (const s of [g.server, g.metricsServer, up?.server]) s?.on('connection', (c) => sockets.add(c));
  const port = await listen(g.server);
  const metricsPort = g.metricsServer ? await listen(g.metricsServer) : undefined;
  t.after(async () => {
    for (const c of sockets) c.destroy();
    await close(g.server);
    if (g.metricsServer) await close(g.metricsServer);
    if (up) await close(up.server);
  });
  return { gate: g, port, metricsPort, upstream: up, counts };
}

const AUTHORISED_UPGRADE = `GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`;

/** Splits a raw HTTP response into its status line, lower-cased headers and body. */
function parseRaw(text) {
  const [head, body] = text.split('\r\n\r\n');
  const [statusLine, ...lines] = head.split('\r\n');
  const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
  return { statusLine, headers, body };
}

test('the fifth session is refused busy with Retry-After', async (t) => {
  const { gate: g, port, upstream: up } = await ownGate(t, { maxSessions: 4 });
  const sockets = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await upgrade(port, AUTH);
    assert.equal(r.status, 101, `session ${i + 1}`);
    sockets.push(r.socket);
  }
  t.after(() => sockets.forEach((s) => s.destroy()));
  assert.equal(g.stats().active, 4);
  assert.equal(g.stats().capacity, 4);
  const connectionsBefore = up.seen.connections;
  const reply = parseRaw(await raw(port, AUTHORISED_UPGRADE));
  assert.equal(reply.statusLine, 'HTTP/1.1 503 Service Unavailable');
  assert.equal(reply.headers['retry-after'], '2');
  assert.equal(reply.headers['x-rpa-browser'], 'busy');
  assert.equal(reply.headers.connection, 'close');
  assert.equal(Number(reply.headers['content-length']), Buffer.byteLength(reply.body));
  assert.equal((await upgrade(port, AUTH)).status, 503, 'a real HTTP client sees the 503 too');
  assert.equal(up.seen.connections, connectionsBefore, 'a refused session never reaches the run-server');
  // A wrong token still gets 401 at capacity: the engine must not wait on a token that will never work.
  assert.equal((await upgrade(port, { Authorization: `Bearer ${'x'.repeat(64)}` })).status, 401);
  const s = g.stats();
  assert.equal(s.active, 4);
  assert.equal(s.sessionsTotal, 4);
  assert.deepEqual(s.refused, { capacity: 2, draining: 0, unauthorized: 1, forbidden: 0, bad_request: 0 });
});

test('a closed session frees its slot', async (t) => {
  const { gate: g, port, counts } = await ownGate(t, { maxSessions: 2 });
  const a = await upgrade(port, AUTH);
  const b = await upgrade(port, AUTH);
  t.after(() => { a.socket.destroy(); b.socket.destroy(); });
  assert.equal((await upgrade(port, AUTH)).status, 503);
  a.socket.destroy();
  await until(() => g.stats().active === 1, 'the slot to free');
  const c = await upgrade(port, AUTH);
  assert.equal(c.status, 101);
  c.socket.destroy();
  b.socket.destroy();
  await until(() => g.stats().active === 0, 'every slot to free');
  assert.deepEqual(counts, [1, 2, 1, 2, 1, 0], 'onSessions sees every change of the active count');
  assert.equal(g.stats().sessionsTotal, 3);
});

test('a half-open close, an upstream reset or an unreachable upstream frees the slot exactly once', async (t) => {
  // The client half-closes (sends FIN, keeps reading): the slot is held until both sides have closed, then freed once.
  const half = await ownGate(t);
  const r = await upgrade(half.port, AUTH);
  assert.equal(r.status, 101);
  assert.equal(half.gate.stats().active, 1);
  r.socket.end();
  await until(() => half.gate.stats().active === 0, 'the half-closed session to free');
  await sleep(50);
  assert.deepEqual(half.counts, [1, 0]);

  // The run-server resets the connection mid-session.
  const resetting = createServer();
  resetting.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    setTimeout(() => socket.resetAndDestroy(), 20);
  });
  const resetPort = await listen(resetting);
  t.after(() => close(resetting));
  const reset = await ownGate(t, { upstreamPort: resetPort });
  const rs = await upgrade(reset.port, AUTH);
  assert.equal(rs.status, 101);
  rs.socket.on('error', () => {});
  await once(rs.socket, 'close');
  await until(() => reset.gate.stats().active === 0, 'the reset session to free');
  await sleep(50);
  assert.deepEqual(reset.counts, [1, 0]);

  // Nothing listens upstream: the client is disconnected and the slot freed once.
  const down = await ownGate(t, { upstreamPort: await freePort() });
  const closed = await raw(down.port, AUTHORISED_UPGRADE);
  assert.equal(closed, '', 'the client gets a closed connection');
  await until(() => down.gate.stats().active === 0, 'the failed session to free');
  await sleep(50);
  assert.deepEqual(down.counts, [1, 0]);
  assert.equal(down.gate.stats().sessionsTotal, 1);
});

test('drain refuses new sessions and resolves when idle', async (t) => {
  const { gate: g, port, upstream: up } = await ownGate(t);
  const open = await upgrade(port, AUTH);
  t.after(() => open.socket.destroy());
  let result;
  const drained = g.drain(10_000).then((r) => { result = r; return r; });
  assert.equal(g.stats().draining, true);
  const connectionsBefore = up.seen.connections;
  const reply = parseRaw(await raw(port, AUTHORISED_UPGRADE));
  assert.equal(reply.statusLine, 'HTTP/1.1 503 Service Unavailable');
  assert.equal(reply.headers['retry-after'], '2');
  assert.equal(reply.headers['x-rpa-browser'], 'draining');
  assert.equal(Number(reply.headers['content-length']), Buffer.byteLength(reply.body));
  assert.equal((await upgrade(port)).status, 401, 'a missing token is still 401 while draining');
  assert.equal(up.seen.connections, connectionsBefore);
  // The open session keeps working until it ends.
  open.socket.write('still here');
  const [chunk] = await once(open.socket, 'data');
  assert.equal(chunk.toString(), 'still here');
  await sleep(30);
  assert.equal(result, undefined, 'drain waits for the open session');
  open.socket.destroy();
  assert.equal(await drained, 'idle');
  assert.equal(g.stats().refused.draining, 1);
  // An idle gate drains at once.
  const idle = await ownGate(t);
  assert.equal(await idle.gate.drain(10_000), 'idle');

  await t.test("resolves 'timeout' after the drain time", async (t2) => {
    const slow = await ownGate(t2);
    const s = await upgrade(slow.port, AUTH);
    t2.after(() => s.socket.destroy());
    const started = Date.now();
    assert.equal(await slow.gate.drain(150), 'timeout');
    assert.ok(Date.now() - started >= 140);
    assert.equal(slow.gate.stats().active, 1, 'the gate itself does not cut the session; the main module exits');
  });
});

test('healthz is 200 when serving, 503 when draining or the upstream is down', async (t) => {
  const serving = await ownGate(t);
  const ok = await get(serving.port, '/healthz');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'ok\n');
  // A full replica is still healthy: it is busy, not broken.
  assert.equal((await get(serving.port, '/healthz?x=1')).status, 200);
  assert.equal((await get(serving.port, '/healthz/')).status, 404, 'every other path stays 404');
  assert.equal((await get(serving.port, '/')).status, 404);
  const draining = serving.gate.drain(1000);
  const d = await get(serving.port, '/healthz');
  assert.equal(d.status, 503);
  assert.equal(d.body, 'draining\n');
  await draining;

  const down = await ownGate(t, { upstreamPort: await freePort() });
  const u = await get(down.port, '/healthz');
  assert.equal(u.status, 503);
  assert.equal(u.body, 'upstream down\n');
  assert.doesNotMatch(u.body + JSON.stringify(u.headers), new RegExp(SECRET));
});

test('metrics report sessions, capacity, draining and refusals, and never the token', async (t) => {
  assert.equal(createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH }).metricsServer, undefined, 'no metrics server unless asked');
  assert.equal(createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH, metricsPort: 0 }).metricsServer, undefined, 'port 0 disables metrics');
  // metricsPort says a metrics server is wanted; the caller listens on it (here on a free port).
  const { gate: g, port, metricsPort } = await ownGate(t, { maxSessions: 2, metricsPort: 9464 });
  assert.ok(metricsPort);
  const a = await upgrade(port, AUTH, '/some/client/path?session=very-secret-session');
  const b = await upgrade(port, { ...AUTH, 'X-Custom-Header': 'header-value-xyz' });
  t.after(() => { a.socket.destroy(); b.socket.destroy(); });
  assert.equal((await upgrade(port, AUTH)).status, 503);
  assert.equal((await upgrade(port, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal((await upgrade(port, { ...AUTH, 'x-playwright-proxy': '*' })).status, 403);
  assert.equal((await upgrade(port, { ...AUTH, Upgrade: 'h2c' })).status, 400);
  const m = await get(metricsPort, '/metrics');
  assert.equal(m.status, 200);
  assert.match(m.headers['content-type'], /^text\/plain; version=0\.0\.4/);
  const values = Object.fromEntries(m.body.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const i = l.lastIndexOf(' ');
    return [l.slice(0, i), Number(l.slice(i + 1))];
  }));
  assert.deepEqual(values, {
    rpa_browser_sessions_active: 2,
    rpa_browser_sessions_capacity: 2,
    rpa_browser_draining: 0,
    rpa_browser_sessions_total: 2,
    'rpa_browser_refused_total{reason="capacity"}': 1,
    'rpa_browser_refused_total{reason="draining"}': 0,
    'rpa_browser_refused_total{reason="unauthorized"}': 1,
    'rpa_browser_refused_total{reason="forbidden"}': 1,
    'rpa_browser_refused_total{reason="bad_request"}': 1,
  });
  for (const name of ['rpa_browser_sessions_active', 'rpa_browser_sessions_capacity', 'rpa_browser_draining']) {
    assert.match(m.body, new RegExp(`^# TYPE ${name} gauge$`, 'm'));
  }
  for (const name of ['rpa_browser_sessions_total', 'rpa_browser_refused_total']) {
    assert.match(m.body, new RegExp(`^# TYPE ${name} counter$`, 'm'));
  }
  for (const secret of [TOKEN, SECRET, 'very-secret-session', '/some/client/path', 'header-value-xyz', 'X-Custom-Header', 'Bearer', 'nope']) {
    assert.ok(!m.body.toLowerCase().includes(secret.toLowerCase()), `metrics must not contain ${secret}`);
  }
  assert.equal((await get(metricsPort, '/')).status, 404);
  assert.equal((await get(metricsPort, '/healthz')).status, 404);
  assert.equal((await get(port, '/metrics')).status, 404, 'metrics are not on the gate port');
  g.drain(1000);
  assert.match((await get(metricsPort, '/metrics')).body, /^rpa_browser_draining 1$/m);
});

test('the session limit must be 1-64', () => {
  for (const maxSessions of [0, 65, 1.5, -1, NaN, '4']) {
    assert.throws(() => createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH, maxSessions }), /maxSessions must be a whole number from 1 to 64/);
  }
  assert.equal(createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH, maxSessions: 64 }).stats().capacity, 64);
  assert.equal(createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH }).stats().capacity, 4, 'the default is 4');
});

/** Runs the gate as the main module; resolves once it listens, with its port and a log reader. */
async function spawnGate(t, env) {
  const child = spawn(process.execPath, [GATE_FILE], {
    env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_GATE_METRICS_PORT: '0', ...env },
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  await until(() => /listening on :(\d+)/.test(log), 'the gate to listen', 10_000);
  return { child, exited, port: Number(/listening on :(\d+)/.exec(log)[1]), log: () => log };
}

test('the main module validates the session limit, drain time and metrics port', () => {
  const cases = [
    [{ BROWSER_GATE_MAX_SESSIONS: '0' }, /BROWSER_GATE_MAX_SESSIONS must be a whole number from 1 to 64/],
    [{ BROWSER_GATE_MAX_SESSIONS: '65' }, /BROWSER_GATE_MAX_SESSIONS/],
    [{ BROWSER_GATE_MAX_SESSIONS: '4.5' }, /BROWSER_GATE_MAX_SESSIONS/],
    [{ BROWSER_GATE_MAX_SESSIONS: 'four' }, /BROWSER_GATE_MAX_SESSIONS/],
    [{ BROWSER_GATE_DRAIN_SECONDS: '0' }, /BROWSER_GATE_DRAIN_SECONDS must be a whole number of seconds from 1 to 86400/],
    [{ BROWSER_GATE_DRAIN_SECONDS: '-5' }, /BROWSER_GATE_DRAIN_SECONDS/],
    [{ BROWSER_GATE_DRAIN_SECONDS: '86401' }, /BROWSER_GATE_DRAIN_SECONDS/],
    [{ BROWSER_GATE_DRAIN_SECONDS: '10m' }, /BROWSER_GATE_DRAIN_SECONDS/],
    [{ BROWSER_GATE_METRICS_PORT: '65536' }, /BROWSER_GATE_METRICS_PORT must be a port from 1 to 65535, or 0 to turn metrics off/],
    [{ BROWSER_GATE_METRICS_PORT: 'x' }, /BROWSER_GATE_METRICS_PORT/],
  ];
  for (const [env, message] of cases) {
    const run = spawnSync(process.execPath, [GATE_FILE], {
      env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_UPSTREAM_PORT: '1', ...env }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.match(run.stderr, message, JSON.stringify(env));
    assert.doesNotMatch(run.stderr + run.stdout, new RegExp(`${TOKEN}|${SECRET}`));
  }
});

test('on SIGTERM the main module drains: healthz 503, new sessions refused, exit 0 when the last session closes', async (t) => {
  const up = await fakeUpstream();
  t.after(() => close(up.server));
  const metricsPort = await freePort();
  const g = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(up.port), BROWSER_GATE_MAX_SESSIONS: '3', BROWSER_GATE_METRICS_PORT: String(metricsPort) });
  await until(() => g.log().includes(`metrics on :${metricsPort}`), 'the metrics line');
  assert.match((await get(metricsPort, '/metrics')).body, /^rpa_browser_sessions_capacity 3$/m);
  const open = await upgrade(g.port, AUTH);
  assert.equal(open.status, 101);
  t.after(() => open.socket.destroy());
  g.child.kill('SIGTERM');
  await until(() => /draining/.test(g.log()), 'the drain log line');
  assert.match(g.log(), /SIGTERM: draining, refusing new sessions; 1 session open, waiting up to 600 s/);
  assert.equal((await get(g.port, '/healthz')).status, 503);
  assert.equal(parseRaw(await raw(g.port, AUTHORISED_UPGRADE)).headers['x-rpa-browser'], 'draining');
  await sleep(100);
  assert.equal(g.child.exitCode, null, 'the gate stays up while a session is open');
  open.socket.destroy();
  const [code] = await g.exited;
  assert.equal(code, 0);
  assert.doesNotMatch(g.log(), new RegExp(`${TOKEN}|${SECRET}`));
});

test('the main module exits 0 when the drain time passes, and at once on a second SIGTERM', async (t) => {
  const up = await fakeUpstream();
  t.after(() => close(up.server));
  const timed = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(up.port), BROWSER_GATE_DRAIN_SECONDS: '1' });
  const s1 = await upgrade(timed.port, AUTH);
  t.after(() => s1.socket.destroy());
  const started = Date.now();
  timed.child.kill('SIGTERM');
  const [code] = await timed.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 900, `exited after ${Date.now() - started} ms`);

  const twice = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(up.port), BROWSER_GATE_DRAIN_SECONDS: '600' });
  const s2 = await upgrade(twice.port, AUTH);
  t.after(() => s2.socket.destroy());
  twice.child.kill('SIGTERM');
  await until(() => /draining/.test(twice.log()), 'the drain log line');
  const second = Date.now();
  twice.child.kill('SIGTERM');
  const [code2] = await twice.exited;
  assert.equal(code2, 0);
  assert.ok(Date.now() - second < 2000);
});

// ---- Review round 2: a run-server that never accepts, 400/403 before busy and draining, HEAD /healthz, dual-stack. ----

/** A plain request with any method and host; resolves with the status, headers and body. */
function requestTo({ host = '127.0.0.1', port, path, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    request({ host, port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

/** TEST-NET-1 (RFC 5737): never routed, so a connect to it hangs instead of being refused. */
const BLACKHOLE = '192.0.2.1';
async function connectHangs() {
  return new Promise((resolve) => {
    const s = connect({ host: BLACKHOLE, port: 9 });
    const timer = setTimeout(() => { s.destroy(); resolve(true); }, 400);
    s.on('error', () => { clearTimeout(timer); resolve(false); });
    s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve(false); });
  });
}

test('a run-server that never accepts: the client giving up or the connect timeout frees the slot', async (t) => {
  if (!(await connectHangs())) return t.skip(`a connect to ${BLACKHOLE} does not hang on this network`);
  const hung = await ownGate(t, { upstreamHost: BLACKHOLE, upstreamPort: 9, upstreamConnectTimeoutMs: 5000 });
  // The client sends FIN (half-close) while the gate is still connecting upstream.
  const s1 = connect({ host: '127.0.0.1', port: hung.port }, () => s1.write(AUTHORISED_UPGRADE));
  s1.on('error', () => {});
  await until(() => hung.gate.stats().active === 1, 'the session to start');
  const ended = Date.now();
  s1.end();
  await until(() => hung.gate.stats().active === 0, 'the half-closed session to free', 1000);
  assert.ok(Date.now() - ended < 1000);
  // The client closes the connection.
  const s2 = connect({ host: '127.0.0.1', port: hung.port }, () => s2.write(AUTHORISED_UPGRADE));
  await until(() => hung.gate.stats().active === 1, 'the second session to start');
  s2.destroy();
  await until(() => hung.gate.stats().active === 0, 'the closed session to free', 1000);
  assert.deepEqual(hung.counts, [1, 0, 1, 0]);

  // The client waits forever: the connect timeout ends the attempt and closes the client connection.
  const timed = await ownGate(t, { upstreamHost: BLACKHOLE, upstreamPort: 9, upstreamConnectTimeoutMs: 300 });
  const started = Date.now();
  const reply = await raw(timed.port, AUTHORISED_UPGRADE);
  const took = Date.now() - started;
  assert.equal(reply, '', 'the client gets a closed connection');
  assert.ok(took >= 250 && took < 3000, `closed after ${took} ms`);
  await until(() => timed.gate.stats().active === 0, 'the timed-out session to free', 1000);
  assert.deepEqual(timed.counts, [1, 0]);
});

test('400 and 403 still win over busy and draining', async (t) => {
  const { gate: g, port } = await ownGate(t, { maxSessions: 1 });
  const open = await upgrade(port, AUTH);
  t.after(() => open.socket.destroy());
  for (const phase of ['busy', 'draining']) {
    if (phase === 'draining') g.drain(10_000);
    assert.equal((await upgrade(port, { ...AUTH, Upgrade: 'h2c' })).status, 400, `${phase}: not a WebSocket upgrade`);
    assert.equal((await upgrade(port, { ...AUTH, 'x-playwright-proxy': '*' })).status, 403, `${phase}: a refused option`);
    assert.equal((await upgrade(port, { ...AUTH, 'x-playwright-launch-options': '{"env":{}}' })).status, 403, `${phase}: a refused launch option`);
    assert.equal((await upgrade(port, AUTH)).status, 503, `${phase}: a good request gets 503`);
  }
  assert.deepEqual(g.stats().refused, { capacity: 1, draining: 1, unauthorized: 0, forbidden: 4, bad_request: 2 });
});

test('HEAD /healthz answers like GET, without a body', async (t) => {
  const serving = await ownGate(t);
  const ok = await requestTo({ port: serving.port, path: '/healthz', method: 'HEAD' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '');
  assert.equal((await requestTo({ port: serving.port, path: '/healthz', method: 'POST' })).status, 404, 'other methods stay 404');
  serving.gate.drain(1000);
  assert.equal((await requestTo({ port: serving.port, path: '/healthz', method: 'HEAD' })).status, 503);
  const down = await ownGate(t, { upstreamPort: await freePort() });
  assert.equal((await requestTo({ port: down.port, path: '/healthz', method: 'HEAD' })).status, 503);
});

/** Whether this machine has an IPv6 loopback to test the dual-stack bind on. */
async function hasIpv6Loopback() {
  const s = createServer();
  try {
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '::1', resolve); });
    await close(s);
    return true;
  } catch {
    return false;
  }
}

test('the main module listens on IPv4 and IPv6 (dual-stack) for sessions and metrics', async (t) => {
  if (!(await hasIpv6Loopback())) return t.skip('no IPv6 loopback on this machine');
  const up = await fakeUpstream();
  t.after(() => close(up.server));
  const metricsPort = await freePort();
  const g = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(up.port), BROWSER_GATE_METRICS_PORT: String(metricsPort) });
  await until(() => g.log().includes(`metrics on :${metricsPort}`), 'the metrics line');
  for (const host of ['127.0.0.1', '::1']) {
    assert.equal((await requestTo({ host, port: g.port, path: '/healthz' })).status, 200, `healthz on ${host}`);
    assert.equal((await requestTo({ host, port: metricsPort, path: '/metrics' })).status, 200, `metrics on ${host}`);
  }
});
