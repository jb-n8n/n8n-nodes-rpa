// The browser host: a browser server and the token gate with TLS in one process. node:test, no dependencies.
// The browser server is a stand-in (the injectable runServer, or a stand-in for Playwright's CLI under the real
// launcher), so no browser is needed. Every token and key is made at run time; none is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, createServer as createTcpServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startHost } from '../host.mjs';
import { selfSignedCert } from '../../gate/selfsigned.mjs';

const TOKEN = randomBytes(32).toString('hex');
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const FINGERPRINT = '(?:[0-9A-F]{2}:){31}[0-9A-F]{2}';
const SECRET_PATH = /^\/[0-9a-f]{32}$/;
const TOKEN_RULE = 'browser-token must hold at least 32 characters of ASCII text without spaces';
const WINDOWS = process.platform === 'win32';
const HOST_DIR = fileURLToPath(new URL('..', import.meta.url));
const GATE_DIR = fileURLToPath(new URL('../../gate', import.meta.url));

/** Polls until fn() is truthy, or fails after the deadline. */
async function until(fn, what, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A data directory of its own, removed after the test. `token` null leaves the token file out. */
function dataDir(t, token = TOKEN) {
  const dir = mkdtempSync(join(tmpdir(), 'rpa-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (token !== null) writeFileSync(join(dir, 'browser-token'), token, { mode: 0o600 });
  return dir;
}

/**
 * A stand-in for the browser server behind the injectable runServer. Each call starts a local server that answers
 * upgrades on the given path with 101 and echoes bytes, and prints the line Playwright's run-server prints once it
 * listens. `announce: false` holds that line back until announce() is called; `revealPath: true` answers GET /json with
 * the path, as Playwright 1.63 does when nothing filters it.
 */
function fakeBrowserServer({ announce = true, revealPath = false } = {}) {
  const calls = [];
  const runServer = ({ port, path, env }) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const call = { port, path, env, child, requests: [], kills: [], exited: false };
    calls.push(call);
    const sockets = new Set();
    const server = createServer((req, res) => {
      if (revealPath && req.url === '/json') return res.end(JSON.stringify({ wsEndpointPath: path }));
      res.end('Running');
    });
    server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
    server.on('upgrade', (req, socket, head) => {
      if (req.url.split('?')[0] !== path) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      call.requests.push({ url: req.url, headers: { ...req.headers } });
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (head.length) socket.write(head);
      socket.pipe(socket);
    });
    /** The process ends: its connections close with it. */
    call.exit = (code, signal = null) => {
      if (call.exited) return;
      call.exited = true;
      for (const s of sockets) s.destroy();
      server.close();
      child.stdout.end();
      child.emit('exit', code, signal);
    };
    child.kill = (signal = 'SIGTERM') => {
      call.kills.push(signal);
      setImmediate(() => call.exit(null, signal));
      return true;
    };
    call.announce = () => child.stdout.write(`Listening on ws://127.0.0.1:${server.address().port}${path}\n`);
    server.listen(port, '127.0.0.1', () => {
      call.listeningPort = server.address().port;
      if (announce) call.announce();
    });
    return child;
  };
  return { runServer, calls };
}

/** A host on a fake browser server, listening on a free loopback port; stopped after the test. */
async function ownHost(t, options = {}) {
  const fake = options.fake ?? fakeBrowserServer();
  const lines = [];
  const dir = options.dataDir ?? dataDir(t);
  const host = await startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: (line) => lines.push(line), ...options.start });
  t.after(() => host.stop());
  return { host, fake, call: fake.calls.at(-1), lines, dir, cert: readFileSync(join(dir, 'browser-cert.pem'), 'utf8') };
}

/** An upgrade request over TLS; the certificate is its own trust anchor and names no host, so the name is not checked. */
function upgradeTls(port, cert, headers = {}, path = '/?session=1') {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path, ca: cert, checkServerIdentity: () => undefined, agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...headers },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket, fingerprint: socket.getPeerCertificate().fingerprint256 }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

/** A plain GET on loopback; resolves with the status and body. */
function get(port, path) {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
}

/**
 * One upgrade request written as text on loopback, so the target can be anything. Resolves with what came back: all of
 * it once the other side closed the connection, or what had arrived when the wait ended (an accepted upgrade stays open).
 */
function rawUpgrade(port, target, ms = 500) {
  return new Promise((resolve) => {
    const chunks = [];
    const answer = (closed) => resolve({ closed, text: Buffer.concat(chunks).toString('latin1') });
    const s = connect({ host: '127.0.0.1', port }, () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    const timer = setTimeout(() => { answer(false); s.destroy(); }, ms);
    s.on('data', (c) => chunks.push(c));
    s.on('error', () => {});
    s.on('close', () => { clearTimeout(timer); answer(true); });
  });
}

/** Whether something accepts a TCP connection on the loopback port. */
function accepts(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** A port nothing listens on (bound, then released). */
async function freePort() {
  const s = createTcpServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The command line the operating system shows for a process (what another local user can read). */
function commandLine(pid) {
  const run = WINDOWS
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' })
    : spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(run.status, 0, 'the command line can be read');
  return run.stdout.trim();
}

test('the start line names the address and the fingerprint', async (t) => {
  const { host, lines, call } = await ownHost(t);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^RPA browser listening on wss://127\\.0\\.0\\.1:\\d+, fingerprint ${FINGERPRINT}$`));
  assert.equal(lines[0], `RPA browser listening on wss://127.0.0.1:${host.port}, fingerprint ${host.fingerprint}`);
  assert.ok(!lines[0].includes(call.path.slice(1)), 'the path of the browser server is not in the start line');
  assert.ok(!lines[0].includes(TOKEN));
});

test('an IPv6 bind address is shown in brackets', async (t) => {
  const fake = fakeBrowserServer();
  const lines = [];
  let host;
  try {
    host = await startHost({ dataDir: dataDir(t), port: 0, bind: '::1', runServer: fake.runServer, log: (line) => lines.push(line) });
  } catch (err) {
    if (/EADDRNOTAVAIL|EAFNOSUPPORT/.test(err.message)) return t.skip('this machine has no IPv6 loopback');
    throw err;
  }
  t.after(() => host.stop());
  assert.match(lines[0], new RegExp(`^RPA browser listening on wss://\\[::1\\]:${host.port}, fingerprint ${FINGERPRINT}$`));
});

test('the certificate is created once and reused', async (t) => {
  const dir = dataDir(t);
  const first = await ownHost(t, { dataDir: dir });
  const files = () => ['browser-cert.pem', 'browser-key.pem'].map((name) => readFileSync(join(dir, name), 'utf8'));
  const created = files();
  assert.match(created[0], /^-----BEGIN CERTIFICATE-----/);
  assert.match(created[1], /^-----BEGIN PRIVATE KEY-----/);
  assert.deepEqual(readdirSync(dir).sort(), ['browser-cert.pem', 'browser-key.pem', 'browser-token'], 'no temporary file is left');
  await first.host.stop();
  const second = await ownHost(t, { dataDir: dir });
  assert.equal(second.host.fingerprint, first.host.fingerprint);
  assert.deepEqual(files(), created);
  const { status, socket, fingerprint } = await upgradeTls(second.host.port, created[0], AUTH);
  assert.equal(status, 101);
  assert.equal(fingerprint, second.host.fingerprint, 'the fingerprint in the start line is the one of the certificate served');
  socket.destroy();
});

test('the key file is created for its owner only', { skip: WINDOWS && 'Windows has no file modes; the access rules of the data directory decide there' }, async (t) => {
  const { dir } = await ownHost(t);
  assert.equal(statSync(join(dir, 'browser-key.pem')).mode & 0o777, 0o600);
});

test('one of the two certificate files missing refuses to start', async (t) => {
  const { key, cert } = selfSignedCert();
  const fake = fakeBrowserServer();
  const start = (dir) => startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} });

  const certOnly = dataDir(t);
  writeFileSync(join(certOnly, 'browser-cert.pem'), cert);
  await assert.rejects(start(certOnly), { message: 'browser-key.pem is missing beside browser-cert.pem; restore it, or delete both to create a new certificate (the fingerprint changes)' });
  assert.deepEqual(readdirSync(certOnly).sort(), ['browser-cert.pem', 'browser-token'], 'no file is written');

  const keyOnly = dataDir(t);
  writeFileSync(join(keyOnly, 'browser-key.pem'), key, { mode: 0o600 });
  await assert.rejects(start(keyOnly), { message: 'browser-cert.pem is missing beside browser-key.pem; restore it, or delete both to create a new certificate (the fingerprint changes)' });
  assert.deepEqual(readdirSync(keyOnly).sort(), ['browser-key.pem', 'browser-token'], 'no file is written');
  assert.equal(fake.calls.length, 0, 'no browser server is started');
});

test('a key that does not belong to the certificate refuses to start, without showing either', async (t) => {
  const dir = dataDir(t);
  writeFileSync(join(dir, 'browser-key.pem'), selfSignedCert().key, { mode: 0o600 });
  writeFileSync(join(dir, 'browser-cert.pem'), selfSignedCert().cert);
  const fake = fakeBrowserServer();
  const error = await startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} }).then(() => undefined, (err) => err);
  assert.match(error.message, /^browser-key\.pem and browser-cert\.pem do not hold a usable key and its certificate \(\w+\); restore them, or delete both to create a new certificate \(the fingerprint changes\)$/);
  assert.doesNotMatch(error.message, /BEGIN|PRIVATE/);
  assert.equal(fake.calls.length, 0, 'no browser server is started');
});

test('a data directory that cannot be written leaves no certificate file behind', { skip: (WINDOWS || process.getuid() === 0) && 'needs file modes and a user they apply to' }, async (t) => {
  const dir = dataDir(t);
  const fake = fakeBrowserServer();
  chmodSync(dir, 0o500);
  try {
    await assert.rejects(
      startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} }),
      { message: 'cannot create browser-key.pem and browser-cert.pem: EACCES' },
    );
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(readdirSync(dir), ['browser-token']);
  assert.equal(fake.calls.length, 0, 'no browser server is started');
});

test('a missing or short token file refuses to start', async (t) => {
  const fake = fakeBrowserServer();
  const refused = async (token, what) => {
    const dir = dataDir(t, token);
    const before = readdirSync(dir);
    const error = await startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} }).then(() => undefined, (err) => err);
    assert.equal(error?.message, TOKEN_RULE, what);
    assert.deepEqual(readdirSync(dir), before, `${what}: no certificate is created`);
  };
  await refused(null, 'no token file');
  await refused('', 'an empty file');
  await refused(`${TOKEN.slice(0, 31)}\r\n`, '31 characters');
  await refused(`${TOKEN.slice(0, 30)} ${TOKEN.slice(30)}`, 'a space inside the token');
  await refused(`${TOKEN.slice(0, 40)}é`, 'a character outside ASCII');
  // What Windows PowerShell 5.1 writes with > or Out-File: UTF-16 with a byte order mark.
  await refused(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TOKEN, 'utf16le')]), 'a UTF-16 file');
  assert.equal(fake.calls.length, 0, 'no browser server is started');
});

test('the token file is trimmed: spaces, line ends and a byte order mark around the token are dropped', async (t) => {
  const { host, cert } = await ownHost(t, { dataDir: dataDir(t, `﻿  ${TOKEN}\r\n`) });
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  socket.destroy();
});

test('an authorised wss upgrade reaches the run-server on its random path; without the token the answer is 401', async (t) => {
  const { host, call, cert } = await ownHost(t);
  assert.match(call.path, SECRET_PATH);
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  socket.write('ping');
  const [chunk] = await once(socket, 'data');
  assert.equal(chunk.toString(), 'ping');
  socket.destroy();
  assert.equal(call.requests.length, 1);
  assert.equal(call.requests[0].url, `${call.path}?session=1`);
  assert.equal(call.requests[0].headers.authorization, undefined, 'the token is not passed on to the run-server');

  assert.equal((await upgradeTls(host.port, cert)).status, 401);
  assert.equal((await upgradeTls(host.port, cert, { Authorization: `Bearer ${TOKEN.slice(0, -1)}x` })).status, 401);
  assert.equal(call.requests.length, 1, 'a refused upgrade never reaches the run-server');
  // The gate never serves plain text on the port: an authorised upgrade without TLS gets no 101.
  const plain = await new Promise((resolve) => {
    const chunks = [];
    const s = connect({ host: '127.0.0.1', port: host.port }, () => s.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`));
    s.on('data', (c) => chunks.push(c));
    s.on('error', () => {});
    s.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
  });
  assert.doesNotMatch(plain, /HTTP\/1\.1 101/);
  assert.equal(call.requests.length, 1);
});

test('an authorised upgrade that names the local end of a tunnel in its Host header is forwarded', async (t) => {
  // n8n reaches the gate through a local tunnel, so the gate sees Host: 127.0.0.1:<the tunnel's port>.
  const { host, call, cert } = await ownHost(t);
  const { status, socket } = await upgradeTls(host.port, cert, { ...AUTH, Host: '127.0.0.1:54321' });
  assert.equal(status, 101);
  socket.destroy();
  assert.equal(call.requests[0].headers.host, `127.0.0.1:${call.listeningPort}`, 'the run-server sees its own address');
});

test('the run-server never sees the token', async (t) => {
  // The host does not keep the token in its environment, but a start script might: such variables are not passed on.
  process.env.RPA_TEST_TOKEN_COPY = TOKEN;
  process.env.RPA_TEST_HEADER_COPY = `Bearer ${TOKEN}`;
  t.after(() => { delete process.env.RPA_TEST_TOKEN_COPY; delete process.env.RPA_TEST_HEADER_COPY; });
  process.env.RPA_TEST_KEPT = 'kept';
  t.after(() => { delete process.env.RPA_TEST_KEPT; });
  const { call } = await ownHost(t);
  const values = Object.values(call.env);
  assert.ok(values.length > 0);
  assert.ok(values.every((value) => value !== TOKEN), 'no value of the environment equals the token');
  assert.ok(values.every((value) => !value.includes(TOKEN)), 'no value of the environment holds the token');
  assert.equal(call.env.RPA_TEST_KEPT, 'kept', 'the rest of the environment is passed on');
  assert.ok(!JSON.stringify([call.port, call.path]).includes(TOKEN));
});

test('by default the browser server picks its own port, and the gate forwards to the port it announced', async (t) => {
  const { host, call, cert } = await ownHost(t);
  assert.equal(call.port, 0, 'port 0: the operating system picks a free one');
  assert.notEqual(call.listeningPort, 0);
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  socket.destroy();
  const fixed = await freePort();
  const other = await ownHost(t, { start: { upstreamPort: fixed } });
  assert.equal(other.call.port, fixed);
  assert.notEqual(other.call.path, call.path, 'every start has a path of its own');
});

test('the gate listens only once the browser server has announced its address', async (t) => {
  const fake = fakeBrowserServer({ announce: false });
  const port = await freePort();
  let started = false;
  const starting = startHost({ dataDir: dataDir(t), port, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} });
  starting.then(() => { started = true; }, () => {});
  await until(() => fake.calls[0]?.listeningPort, 'the browser server to listen');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(started, false);
  assert.equal(await accepts(port), false, 'the gate is not listening yet');
  // Other output does not count, nor does an address with another path.
  fake.calls[0].child.stdout.write(`starting\nListening on ws://127.0.0.1:${fake.calls[0].listeningPort}/another-path\n`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(started, false);
  fake.calls[0].announce();
  const host = await starting;
  t.after(() => host.stop());
  assert.equal(await accepts(port), true);
});

test('a browser server that stops or stays silent before it listens fails the start', async (t) => {
  const stopsEarly = fakeBrowserServer({ announce: false });
  const starting = startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', runServer: stopsEarly.runServer, log: () => {} });
  await until(() => stopsEarly.calls[0]?.listeningPort, 'the browser server to listen');
  stopsEarly.calls[0].exit(3);
  await assert.rejects(starting, { message: 'the browser server stopped before it was listening (exit code 3)' });

  // An exit code with which the launcher says why: the host has a line of its own for it.
  const cannotLimit = fakeBrowserServer({ announce: false });
  const refused = startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', runServer: cannotLimit.runServer, log: () => {} });
  await until(() => cannotLimit.calls[0]?.listeningPort, 'the browser server to listen');
  cannotLimit.calls[0].exit(69);
  await assert.rejects(refused, { message: 'the browser server cannot limit module loading to the install with this Node; Node 22.15 or later is needed' });

  const silent = fakeBrowserServer({ announce: false });
  await assert.rejects(
    startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', runServer: silent.runServer, log: () => {}, startTimeoutMs: 200 }),
    { message: 'the browser server did not report its address within 0.2 s' },
  );
  assert.equal(silent.calls[0].exited, true, 'the silent browser server is ended');
});

test('a browser server that tells its path to a plain request fails the start', async (t) => {
  const fake = fakeBrowserServer({ revealPath: true });
  const port = await freePort();
  const error = await startHost({ dataDir: dataDir(t), port, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} }).then(() => undefined, (err) => err);
  assert.equal(error?.message, 'the browser server answers a plain request with its path; not starting');
  assert.ok(!error.message.includes(fake.calls[0].path.slice(1)));
  assert.equal(fake.calls[0].exited, true, 'the browser server is ended');
  assert.equal(await accepts(port), false, 'the gate never listened');
});

test('the run-server exiting stops the host with code 1', async (t) => {
  const { host, call, cert } = await ownHost(t);
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  const closed = once(socket, 'close');
  socket.on('error', () => {});
  call.exit(1);
  assert.equal(await host.exited, 1);
  await closed;
  assert.equal(await accepts(host.port), false, 'the gate is closed');
  await host.stop();
  assert.equal(await host.exited, 1, 'a later stop() does not change the code');
});

test('stop() resolves exited with 0', async (t) => {
  const { host, call, cert } = await ownHost(t);
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  const closed = once(socket, 'close');
  socket.on('error', () => {});
  const stopped = host.stop();
  assert.equal(host.stop(), stopped, 'a second stop() is the same stop');
  await stopped;
  assert.equal(await host.exited, 0);
  await closed;
  assert.equal(call.exited, true, 'the browser server is ended');
  assert.equal(await accepts(host.port), false, 'the gate is closed');
});

test('a port in use fails with a line naming the port', async (t) => {
  const taken = createTcpServer();
  await new Promise((resolve) => taken.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => taken.close(resolve)));
  const { port } = taken.address();
  const fake = fakeBrowserServer();
  await assert.rejects(
    startHost({ dataDir: dataDir(t), port, bind: '127.0.0.1', runServer: fake.runServer, log: () => {} }),
    { message: `cannot listen on port ${port}: EADDRINUSE` },
  );
  assert.equal(fake.calls[0].exited, true, 'the browser server is ended');
});

test('the port, the bind address and the session limit are checked before anything is started', async (t) => {
  const fake = fakeBrowserServer();
  const start = (options) => startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', runServer: fake.runServer, log: () => {}, ...options });
  await assert.rejects(start({ port: 70_000 }), { message: 'port must be a whole number from 0 to 65535' });
  await assert.rejects(start({ port: '3000' }), { message: 'port must be a whole number from 0 to 65535' });
  await assert.rejects(start({ bind: 'localhost' }), { message: 'bind must be an IP address' });
  await assert.rejects(start({ maxSessions: 0 }), { message: 'maxSessions must be a whole number from 1 to 64' });
  await assert.rejects(start({ dataDir: '' }), { message: 'dataDir must name the data directory' });
  assert.equal(fake.calls.length, 0);
});

test('one session at a time by default; maxSessions changes it', async (t) => {
  const one = await ownHost(t);
  const first = await upgradeTls(one.host.port, one.cert, AUTH);
  assert.equal(first.status, 101);
  assert.equal((await upgradeTls(one.host.port, one.cert, AUTH)).status, 503);
  first.socket.destroy();
  const two = await ownHost(t, { start: { maxSessions: 2 } });
  const open = [await upgradeTls(two.host.port, two.cert, AUTH), await upgradeTls(two.host.port, two.cert, AUTH)];
  assert.deepEqual(open.map((o) => o.status), [101, 101]);
  assert.equal((await upgradeTls(two.host.port, two.cert, AUTH)).status, 503);
  for (const o of open) o.socket.destroy();
});

test('stop() ends the whole process tree of the browser server', { skip: !WINDOWS && 'taskkill /T is the Windows path; elsewhere the browser server ends its own browsers on SIGTERM' }, async (t) => {
  // A browser server with a child of its own (a browser), both real processes.
  const script = `
    const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const server = require('node:http').createServer().listen(0, '127.0.0.1', () => {
      console.log('grandchild ' + grandchild.pid);
      console.log('Listening on ws://127.0.0.1:' + server.address().port + process.env.TEST_PATH);
    });`;
  let child;
  let output = '';
  const runServer = ({ path, env }) => {
    child = spawn(process.execPath, ['-e', script], { env: { ...env, TEST_PATH: path }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    child.stdout.on('data', (chunk) => { output += chunk; });
    return child;
  };
  const host = await startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', runServer, log: () => {} });
  const grandchild = Number(/grandchild (\d+)/.exec(output)[1]);
  t.after(() => { for (const pid of [child.pid, grandchild]) if (alive(pid)) process.kill(pid); });
  assert.ok(alive(child.pid) && alive(grandchild));
  await host.stop();
  assert.equal(await host.exited, 0);
  await until(() => !alive(child.pid) && !alive(grandchild), 'the browser server and its child to end');
});

// ---- The files as they are installed: host/ and gate/ side by side, node_modules beside them. ----

/**
 * What Playwright's cli.js does for `run-server`, as far as the host can tell: listens on --host and --port, prints its
 * address, answers upgrades on --path, tells the path to GET /json and "Running" to every other plain request, and
 * ends with an uncaught error on an upgrade whose target is not a URL path (Playwright 1.63 does, for `*@`). It notes
 * what it was started with in started.json beside itself, and each upgrade that reaches it in upgrades.log. A probe.json beside it asks for more before it listens:
 * `requires` and `imports` are module names it tries to load (the outcome of each goes into started.json, and so do the
 * folders require() searches for a name).
 */
const FAKE_CLI = `
const http = require('node:http');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] !== 'run-server') process.exit(64);
const path = option('--path');
const probe = existsSync(join(__dirname, 'probe.json')) ? JSON.parse(readFileSync(join(__dirname, 'probe.json'), 'utf8')) : {};
(async () => {
  const loads = {};
  for (const name of probe.requires ?? []) {
    try { require(name); loads[name] = 'loaded'; } catch (err) { loads[name] = String(err.code); }
  }
  for (const name of probe.imports ?? []) {
    try { await import(name); loads['import ' + name] = 'loaded'; } catch (err) { loads['import ' + name] = String(err.code); }
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/json') return res.end(JSON.stringify({ wsEndpointPath: path }));
    res.end('Running');
  });
  server.on('upgrade', (req, socket) => {
    appendFileSync(join(__dirname, 'upgrades.log'), (req.url.split('?')[0] === path ? 'own' : 'other') + '\\n');
    if (new URL('http://localhost' + req.url).pathname !== path) return socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n');
    socket.pipe(socket);
  });
  server.listen(Number(option('--port')), option('--host'), () => {
    const variablesWithThePath = Object.keys(process.env).filter((name) => process.env[name].includes(path.slice(1)));
    const variable = (name) => process.env[name] ?? null;
    const environment = { WS_NO_BUFFER_UTIL: variable('WS_NO_BUFFER_UTIL'), WS_NO_UTF_8_VALIDATE: variable('WS_NO_UTF_8_VALIDATE'), NODE_PATH: variable('NODE_PATH') };
    const searched = require.resolve.paths('a-module-that-is-not-installed');
    writeFileSync(join(__dirname, 'started.json'), JSON.stringify({ pid: process.pid, args, port: server.address().port, variablesWithThePath, loads, searched, environment }));
    console.log('Listening on ws://' + option('--host') + ':' + server.address().port + path);
  });
})();
`;

/**
 * A copy of host/ and gate/ laid out as installed, with the stand-in for Playwright's CLI; removed after the test. The
 * install root sits two folders deep in a folder of its own (`base`), so a test can put things above the install.
 */
function installedCopy(t, { probe } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'rpa-host-files-'));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(base, 'outer', 'install');
  const cliDir = join(root, 'node_modules', 'playwright');
  for (const dir of [join(root, 'host'), join(root, 'gate'), cliDir]) mkdirSync(dir, { recursive: true });
  for (const name of ['host.mjs', 'run-server.mjs']) copyFileSync(join(HOST_DIR, name), join(root, 'host', name));
  for (const name of ['gate.mjs', 'ecs.mjs', 'selfsigned.mjs']) copyFileSync(join(GATE_DIR, name), join(root, 'gate', name));
  writeFileSync(join(cliDir, 'package.json'), '{}');
  writeFileSync(join(cliDir, 'cli.js'), FAKE_CLI);
  if (probe) writeFileSync(join(cliDir, 'probe.json'), JSON.stringify(probe));
  const started = () => JSON.parse(readFileSync(join(cliDir, 'started.json'), 'utf8'));
  const upgrades = () => (existsSync(join(cliDir, 'upgrades.log')) ? readFileSync(join(cliDir, 'upgrades.log'), 'utf8').trim().split('\n') : []);
  return { base, root, upgrades, hostFile: join(root, 'host', 'host.mjs'), launcherFile: join(root, 'host', 'run-server.mjs'), started };
}

/** Puts a module `name` into `folder` (a node_modules folder, or one NODE_PATH names). Loading it leaves `ran-<name>` in `base`. */
function plantModule(folder, name, base, { esm = false } = {}) {
  const dir = join(folder, name);
  mkdirSync(dir, { recursive: true });
  const marker = JSON.stringify(join(base, `ran-${name}`));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(esm ? { name, type: 'module', exports: './index.js' } : { name, main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), esm ? `import { writeFileSync } from 'node:fs';\nwriteFileSync(${marker}, '');\n` : `require('node:fs').writeFileSync(${marker}, '');\n`);
}

test('started the default way, the path is given to the browser server but is not on its command line or in its environment', async (t) => {
  const files = installedCopy(t);
  const installed = await import(pathToFileURL(files.hostFile).href);
  const dir = dataDir(t);
  const host = await installed.startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', log: () => {} });
  t.after(() => host.stop());
  const started = files.started();
  t.after(() => { if (alive(started.pid)) process.kill(started.pid); });
  const path = started.args[started.args.indexOf('--path') + 1];
  assert.match(path, SECRET_PATH);
  assert.deepEqual(started.args, ['run-server', '--port', '0', '--host', '127.0.0.1', '--path', path]);
  assert.deepEqual(started.variablesWithThePath, [], 'the variable that carried the path is gone before the browser server code runs');

  const shown = commandLine(started.pid);
  assert.ok(shown.includes('run-server.mjs'), 'the command line names the launcher file');
  assert.ok(!shown.includes(path.slice(1)), 'the command line does not hold the path');
  assert.ok(!shown.includes(TOKEN));

  const cert = readFileSync(join(dir, 'browser-cert.pem'), 'utf8');
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101);
  socket.write('ping');
  const [chunk] = await once(socket, 'data');
  assert.equal(chunk.toString(), 'ping');
  socket.destroy();

  // The stand-in tells its path to GET /json like Playwright 1.63; the launcher answers every plain request itself.
  for (const plainPath of ['/json', '/']) {
    const answer = await get(started.port, plainPath);
    assert.equal(answer.status, 404, plainPath);
    assert.ok(!answer.body.includes(path.slice(1)), `${plainPath} does not tell the path`);
  }

  await host.stop();
  await until(() => !alive(started.pid), 'the browser server to end');
});

test('an upgrade that is not for the path of the browser server is closed before the browser server sees it', async (t) => {
  // Any local user can connect to the browser server's port. Playwright 1.63 ends with an uncaught error on an upgrade
  // whose target is `*@`, which would stop the host and free the gate's port at every start.
  const files = installedCopy(t);
  const installed = await import(pathToFileURL(files.hostFile).href);
  const dir = dataDir(t);
  const host = await installed.startHost({ dataDir: dir, port: 0, bind: '127.0.0.1', log: () => {} });
  t.after(() => host.stop());
  let exited = false;
  host.exited.then(() => { exited = true; });
  const started = files.started();
  t.after(() => { if (alive(started.pid)) process.kill(started.pid); });
  const path = started.args[started.args.indexOf('--path') + 1];

  const others = ['*@', '*', '/', '/other', `${path}x`, `${path}/more`, `${path.slice(0, -1)}`, `/${path}`, `${path.toUpperCase()}`, `http://127.0.0.1:${started.port}${path}`, 'http://[', '/%'];
  for (const [index, target] of others.entries()) {
    const answer = await rawUpgrade(started.port, target);
    assert.ok(answer.closed, `target ${index}: the connection is closed`);
    assert.doesNotMatch(answer.text, /^HTTP\/1\.1 101/, `target ${index}: no upgrade`);
    assert.ok(alive(started.pid), `target ${index}: the browser server keeps running`);
  }
  // A request line that is not HTTP at all never becomes an upgrade; it must not end the browser server either.
  const garbage = await rawUpgrade(started.port, 'a b c\r\n\x00');
  assert.ok(garbage.closed);
  assert.equal(files.upgrades().length, 0, 'none of them reached the browser server');

  const own = await rawUpgrade(started.port, `${path}?session=1`);
  assert.match(own.text, /^HTTP\/1\.1 101/, 'an upgrade to the path, with a query, reaches the browser server');
  assert.equal(files.upgrades().join(), 'own');

  const cert = readFileSync(join(dir, 'browser-cert.pem'), 'utf8');
  const { status, socket } = await upgradeTls(host.port, cert, AUTH);
  assert.equal(status, 101, 'the gate still serves a session');
  socket.destroy();
  assert.equal(files.upgrades().join(), 'own,own');
  assert.ok(alive(started.pid));
  assert.equal(exited, false, 'the host is still up');
});

test('a module planted outside the install is not loaded by the browser server; a module inside the install is', async (t) => {
  // Playwright's bundled ws asks for bufferutil and utf-8-validate, which are not installed. Node would look for them in
  // the node_modules of every folder above the install, up to the root of the drive, where any user may create one.
  const files = installedCopy(t, {
    probe: { requires: ['bufferutil', 'utf-8-validate', 'named-by-node-path', 'inside-the-install'], imports: ['planted-for-import', 'inside-for-import'] },
  });
  plantModule(join(dirname(files.root), 'node_modules'), 'bufferutil', files.base);
  plantModule(join(files.base, 'node_modules'), 'utf-8-validate', files.base);
  plantModule(join(files.base, 'node_modules'), 'planted-for-import', files.base, { esm: true });
  plantModule(join(files.base, 'elsewhere'), 'named-by-node-path', files.base);
  plantModule(join(files.root, 'node_modules'), 'inside-the-install', files.base);
  plantModule(join(files.root, 'node_modules'), 'inside-for-import', files.base, { esm: true });
  const nodePath = process.env.NODE_PATH;
  process.env.NODE_PATH = join(files.base, 'elsewhere');
  t.after(() => {
    if (nodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = nodePath;
  });

  const installed = await import(pathToFileURL(files.hostFile).href);
  const host = await installed.startHost({ dataDir: dataDir(t), port: 0, bind: '127.0.0.1', log: () => {} });
  t.after(() => host.stop());
  const started = files.started();
  assert.deepEqual(started.loads, {
    bufferutil: 'MODULE_NOT_FOUND',
    'utf-8-validate': 'MODULE_NOT_FOUND',
    'named-by-node-path': 'MODULE_NOT_FOUND',
    'inside-the-install': 'loaded',
    'import planted-for-import': 'ERR_MODULE_NOT_FOUND',
    'import inside-for-import': 'loaded',
  });
  const ran = readdirSync(files.base).filter((name) => name.startsWith('ran-')).sort();
  assert.deepEqual(ran, ['ran-inside-for-import', 'ran-inside-the-install'], 'only the modules inside the install ran');
  const root = realpathSync(files.root);
  assert.deepEqual(started.searched, [join(root, 'node_modules', 'playwright', 'node_modules'), join(root, 'node_modules')], 'require() searches inside the install only');
  assert.deepEqual(started.environment, { WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1', NODE_PATH: null });
});

test('the launcher does not start without the path and port the host gives it', (t) => {
  const files = installedCopy(t);
  const run = (env) => spawnSync(process.execPath, [files.launcherFile], { env: { ...process.env, ...env }, encoding: 'utf8', input: '', timeout: 10_000 });
  for (const env of [{}, { RPA_RUN_SERVER_PORT: '0' }, { RPA_RUN_SERVER_PATH: '/short', RPA_RUN_SERVER_PORT: '0' }, { RPA_RUN_SERVER_PATH: `/${'a'.repeat(32)}`, RPA_RUN_SERVER_PORT: 'x' }]) {
    const result = run(env);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^run-server: the browser host starts this file and gives it a path and a port\n$/);
    assert.doesNotMatch(result.stderr, /short/);
  }
});

/** The host's main block in an installed copy, with its output collected; ended after the test. */
async function spawnHost(t, env = {}) {
  const files = installedCopy(t);
  const dir = dataDir(t);
  const port = await freePort();
  const child = spawn(process.execPath, [files.hostFile], {
    env: { ...process.env, RPA_BROWSER_DATA_DIR: dir, RPA_BROWSER_PORT: String(port), RPA_BROWSER_BIND: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { output.stdout += c; });
  child.stderr.on('data', (c) => { output.stderr += c; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, dir, port, output, exited, started: files.started };
}

test('the main block starts from RPA_BROWSER_DATA_DIR and RPA_BROWSER_PORT and prints the start line', async (t) => {
  const h = await spawnHost(t, { RPA_BROWSER_MAX_SESSIONS: '2' });
  await until(() => h.output.stdout.includes('\n') || h.child.exitCode !== null, 'the start line');
  assert.match(h.output.stdout, new RegExp(`^RPA browser listening on wss://127\\.0\\.0\\.1:${h.port}, fingerprint ${FINGERPRINT}\\n$`));
  const cert = readFileSync(join(h.dir, 'browser-cert.pem'), 'utf8');
  const open = [await upgradeTls(h.port, cert, AUTH), await upgradeTls(h.port, cert, AUTH)];
  assert.deepEqual(open.map((o) => o.status), [101, 101]);
  assert.equal((await upgradeTls(h.port, cert, AUTH)).status, 503, 'RPA_BROWSER_MAX_SESSIONS=2');
  for (const o of open) o.socket.destroy();
  assert.equal(h.output.stderr, '');
});

test('the main block exits 1 when the browser server stops', async (t) => {
  const h = await spawnHost(t);
  await until(() => h.output.stdout.includes('\n') || h.child.exitCode !== null, 'the start line');
  process.kill(h.started().pid);
  assert.deepEqual(await h.exited, { code: 1, signal: null });
  assert.equal(h.output.stderr, 'RPA browser: the browser server stopped; exiting\n');
});

test('the main block exits 0 on SIGINT and ends the browser server', { skip: WINDOWS && 'Windows cannot send Ctrl+C to one child process; stop() is tested directly' }, async (t) => {
  const h = await spawnHost(t);
  await until(() => h.output.stdout.includes('\n') || h.child.exitCode !== null, 'the start line');
  const { pid } = h.started();
  h.child.kill('SIGINT');
  assert.deepEqual(await h.exited, { code: 0, signal: null });
  await until(() => !alive(pid), 'the browser server to end');
  assert.equal(h.output.stderr, '');
});

test('when the host is ended without a chance to stop, the browser server ends by itself', async (t) => {
  // What the start script does on Windows, and what SIGKILL does elsewhere: no handler of the host runs.
  const h = await spawnHost(t);
  await until(() => h.output.stdout.includes('\n') || h.child.exitCode !== null, 'the start line');
  const { pid } = h.started();
  t.after(() => { if (alive(pid)) process.kill(pid); });
  assert.ok(alive(pid));
  h.child.kill('SIGKILL');
  await h.exited;
  await until(() => !alive(pid), 'the browser server to end');
});

test('the main block exits 1 with one line on a start-up mistake, without showing the token', async (t) => {
  const failed = async (env, line) => {
    const h = await spawnHost(t, env);
    assert.deepEqual(await h.exited, { code: 1, signal: null }, line);
    assert.equal(h.output.stderr, `RPA browser: ${line}\n`);
    assert.equal(h.output.stdout, '');
  };
  await failed({ RPA_BROWSER_PORT: '0' }, 'RPA_BROWSER_PORT must be a whole number from 1 to 65535');
  await failed({ RPA_BROWSER_PORT: '3000x' }, 'RPA_BROWSER_PORT must be a whole number from 1 to 65535');
  await failed({ RPA_BROWSER_MAX_SESSIONS: '65' }, 'RPA_BROWSER_MAX_SESSIONS must be a whole number from 1 to 64');
  await failed({ RPA_BROWSER_BIND: 'example.test' }, 'RPA_BROWSER_BIND must be an IP address');
  await failed({ RPA_BROWSER_DATA_DIR: join(tmpdir(), `rpa-host-none-${randomBytes(6).toString('hex')}`) }, TOKEN_RULE);
  if (!WINDOWS) await failed({ RPA_BROWSER_DATA_DIR: '' }, 'RPA_BROWSER_DATA_DIR is not set');
});
