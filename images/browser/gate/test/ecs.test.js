// ECS task scale-in protection and CloudWatch EMF metrics for the gate. node:test, no dependencies.
// A fake ECS agent (a real HTTP server on loopback) and a fake clock: nothing here waits for minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGate } from '../gate.mjs';
import { emfLine, protectionMinutes, startEmf, taskProtection } from '../ecs.mjs';

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const UPSTREAM_PATH = '/9f86d081884c7d659a2feaa0c55ad015';
const GATE_FILE = fileURLToPath(new URL('../gate.mjs', import.meta.url));
const AUTH = { Authorization: `Bearer ${TOKEN}` };

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** A clock and timers the test moves by hand. Timers record unref(). */
function fakeClock(start = 1_760_000_000_000) {
  let t = start;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const h = { id: (seq += 1), at: t + ms, fn, unrefed: false, unref() { this.unrefed = true; return this; } };
        pending.set(h.id, h);
        return h;
      },
      clearTimeout(h) { if (h) pending.delete(h.id); },
    },
    pending: () => [...pending.values()],
    /** Moves the clock forward, firing every timer that falls due on the way, in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...pending.values()].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at;
        pending.delete(next.id);
        next.fn();
      }
      t = end;
    },
  };
}

const ACCESS_DENIED = {
  requestID: '12345-abc-6789-0123-abc',
  error: {
    Arn: 'arn:aws:ecs:us-west-2:555555555555:task/my-cluster-name/1234567890abcdef0',
    Code: 'AccessDeniedException',
    Message: 'User: arn:aws:sts::444455556666:assumed-role/my-ecs-task-role/1234567890abcdef0 is not authorized to perform: ecs:UpdateTaskProtection',
  },
};

/** A stand-in for the ECS agent's task-protection endpoint. `reply` decides each answer: [status, body] or 'hang'. */
async function fakeAgent(t) {
  const calls = [];
  const agent = { calls, reply: () => [200, { protection: { ExpirationDate: null, ProtectionEnabled: true, TaskArn: 'arn:aws:ecs:us-west-2:111122223333:task/x' } }] };
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: body ? JSON.parse(body) : undefined });
      const r = agent.reply(calls.length);
      if (r === 'hang') return;
      res.writeHead(r[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(r[1]));
    });
  });
  const port = await listen(server);
  t.after(() => close(server));
  agent.port = port;
  agent.uri = `http://127.0.0.1:${port}/api/0123456789abcdef-1234567890`;
  return agent;
}

const ON_15 = { ProtectionEnabled: true, ExpiresInMinutes: 15 };
const OFF = { ProtectionEnabled: false };
const bodies = (agent) => agent.calls.map((c) => c.body);

test('the protection time is the drain time in whole minutes plus 5', () => {
  assert.equal(protectionMinutes(600), 15);
  assert.equal(protectionMinutes(1), 6);
  assert.equal(protectionMinutes(61), 7);
  assert.equal(protectionMinutes(86_400), 1445, 'within the agent limit of 2880 minutes');
});

test('protection follows the session count', async (t) => {
  const agent = await fakeAgent(t);
  const clock = fakeClock();
  const logs = [];
  const p = taskProtection({ agentUri: agent.uri, drainSeconds: 600, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  await p.update(1);
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0], { method: 'PUT', url: '/api/0123456789abcdef-1234567890/task-protection/v1/state', contentType: 'application/json', body: ON_15 });
  await p.update(2);
  assert.equal(agent.calls.length, 1, '1 -> 2 makes no call');
  await p.update(1);
  assert.equal(agent.calls.length, 1, '2 -> 1 makes no call');
  assert.equal(clock.pending().length, 1, 'a refresh is scheduled while sessions are open');
  await p.update(0);
  assert.deepEqual(bodies(agent), [ON_15, OFF]);
  assert.equal(clock.pending().length, 0, 'the refresh timer is cleared at 0');
  await p.update(0);
  assert.equal(agent.calls.length, 2, '0 -> 0 makes no call');
  assert.deepEqual(logs, [], 'nothing is logged when the agent answers');
});

test('protection is refreshed before it expires', async (t) => {
  const agent = await fakeAgent(t);
  const clock = fakeClock();
  const p = taskProtection({ agentUri: agent.uri, drainSeconds: 600, now: clock.now, timers: clock.timers, log: () => {} });
  await p.update(1);
  assert.ok(clock.pending().length === 1 && clock.pending().every((h) => h.unrefed), 'the refresh timer never holds the process open');
  clock.advance(10 * 60_000 - 1);
  await p.update(1);
  assert.equal(agent.calls.length, 1, 'no refresh before ExpiresInMinutes - 5');
  clock.advance(1);
  await p.update(1);
  assert.deepEqual(bodies(agent), [ON_15, ON_15], 'refreshed at 10 of 15 minutes');
  clock.advance(10 * 60_000);
  await p.update(3);
  assert.deepEqual(bodies(agent), [ON_15, ON_15, ON_15], 'and again 10 minutes after the refresh');
  assert.equal(clock.pending().length, 1);
  p.stop();
  assert.equal(clock.pending().length, 0, 'stop() clears the refresh timer');
  clock.advance(60 * 60_000);
  assert.equal(agent.calls.length, 3);
});

test('a failed renewal is retried 30 s later and succeeds before the protection expires', async (t) => {
  const agent = await fakeAgent(t);
  const clock = fakeClock();
  const logs = [];
  const p = taskProtection({ agentUri: agent.uri, drainSeconds: 600, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  await p.update(1);
  const onAt = clock.now();
  // Only the timers act from here on (no update() call: a session change would retry at once, by design).
  agent.reply = () => [500, { error: { Code: 'ServerException', Message: 'try again' } }];
  clock.advance(10 * 60_000);
  await until(() => logs.length === 1, 'the failed renewal');
  assert.deepEqual(bodies(agent), [ON_15, ON_15], 'the renewal is attempted at 10 of 15 minutes');
  assert.match(logs[0], /could not be turned on: HTTP 500 ServerException; retrying in 30 s/);
  assert.ok(clock.pending().length === 1 && clock.pending().every((h) => h.unrefed), 'the retry timer never holds the process open');
  agent.reply = () => [200, { protection: { ProtectionEnabled: true } }];
  clock.advance(30_000 - 1);
  await sleep(50);
  assert.equal(agent.calls.length, 2, 'not retried before 30 s');
  clock.advance(1);
  await until(() => logs.length === 2, 'the retry');
  assert.deepEqual(bodies(agent), [ON_15, ON_15, ON_15], 'retried 30 s later');
  assert.ok(clock.now() < onAt + 15 * 60_000, 'the retry lands before the first protection runs out');
  assert.match(logs[1], /ECS task protection is on again/);
  // The next renewal is 10 minutes after the successful retry.
  clock.advance(10 * 60_000 - 1);
  await sleep(50);
  assert.equal(agent.calls.length, 3);
  clock.advance(1);
  await until(() => agent.calls.length === 4, 'the next renewal');
  p.stop();
});

test('protection calls never overlap and the last one matches the latest count', async () => {
  const clock = fakeClock();
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const releases = [];
  const fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => releases.push(r));
    inFlight -= 1;
    return new Response('{"protection":{}}', { status: 200 });
  };
  const p = taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds: 60, fetch, now: clock.now, timers: clock.timers, log: () => {} });
  const done = [p.update(1), p.update(0), p.update(1), p.update(0)];
  // Let each held call finish in turn.
  for (let i = 0; i < 10 && (inFlight > 0 || releases.length > 0); i += 1) {
    await sleep(5);
    releases.shift()?.();
  }
  await Promise.all(done);
  assert.equal(maxInFlight, 1, 'one call at a time');
  assert.deepEqual(calls.at(-1), OFF, 'the final state is off, as the latest count is 0');
  assert.deepEqual(calls[0], { ProtectionEnabled: true, ExpiresInMinutes: 6 });
  assert.equal(clock.pending().length, 0);

  // The other way round: the latest count is above 0, so the last call turns protection on.
  calls.length = 0;
  const again = [p.update(2), p.update(0), p.update(1)];
  for (let i = 0; i < 10 && (inFlight > 0 || releases.length > 0); i += 1) {
    await sleep(5);
    releases.shift()?.();
  }
  await Promise.all(again);
  assert.deepEqual(calls.at(-1), { ProtectionEnabled: true, ExpiresInMinutes: 6 });
  assert.equal(clock.pending().length, 1, 'and its refresh is scheduled');
  p.stop();
});

test('an agent error is logged and the gate keeps serving', async (t) => {
  const agent = await fakeAgent(t);
  agent.reply = () => [400, ACCESS_DENIED];
  const clock = fakeClock();
  const logs = [];
  const p = taskProtection({ agentUri: `${agent.uri}?secret=q`, drainSeconds: 600, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });

  // A real gate, wired the way the main module wires it.
  const upstream = createServer((_q, s) => { s.writeHead(500); s.end(); });
  upstream.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  const upPort = await listen(upstream);
  const gate = createGate({ token: TOKEN, upstreamPort: upPort, upstreamPath: UPSTREAM_PATH });
  const updates = [];
  gate.onSessions((n) => updates.push(p.update(n)));
  const port = await listen(gate);
  const sockets = new Set();
  for (const s of [gate, upstream]) s.on('connection', (c) => sockets.add(c));
  t.after(async () => { for (const c of sockets) c.destroy(); await close(gate); await close(upstream); });

  const socket = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...AUTH } });
    req.on('upgrade', (res, s) => { assert.equal(res.statusCode, 101); resolve(s); });
    req.on('response', () => reject(new Error('no upgrade')));
    req.on('error', reject);
    req.end();
  });
  await Promise.all(updates);
  socket.write('ping');
  const [chunk] = await once(socket, 'data');
  assert.equal(chunk.toString(), 'ping', 'the session works although the agent refused');
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].url, '/api/0123456789abcdef-1234567890/task-protection/v1/state', 'the query is dropped');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ECS task protection/);
  assert.match(logs[0], /HTTP 400 AccessDeniedException/);
  for (const leak of [TOKEN, 'secret', 'arn:', 'assumed-role', '127.0.0.1', '/api/', 'task-protection/v1']) {
    assert.ok(!logs[0].includes(leak), `the log line holds no ${leak}: ${logs[0]}`);
  }

  // Retried 30 s later while the session is open; a 200 that carries a failure is a failure too.
  agent.reply = () => [200, { failure: { Arn: 'arn:aws:ecs:us-west-2:111122223333:task/x', Detail: null, Reason: 'TASK_NOT_VALID' } }];
  clock.advance(30_000);
  await p.update(1);
  assert.equal(agent.calls.length, 2);
  assert.match(logs[1], /TASK_NOT_VALID/);
  assert.ok(!logs[1].includes('arn:'));

  // The agent answers again: protection is on, the recovery is logged once, and the refresh is scheduled.
  agent.reply = () => [200, { protection: { ProtectionEnabled: true } }];
  clock.advance(30_000);
  await p.update(1);
  assert.deepEqual(bodies(agent), [ON_15, ON_15, ON_15]);
  assert.equal(logs.length, 3);
  assert.match(logs[2], /ECS task protection is on again/);

  socket.destroy();
  await until(() => gate.stats().active === 0, 'the session to close');
  await Promise.all(updates);
  assert.deepEqual(bodies(agent).at(-1), OFF);
  p.stop();
});

test('an unreachable or silent agent is logged by its error code, and update never throws', async (t) => {
  const clock = fakeClock();
  const logs = [];
  // Nothing listens on this port.
  const dead = createServer();
  const deadPort = await listen(dead);
  await close(dead);
  const refused = taskProtection({ agentUri: `http://127.0.0.1:${deadPort}/api/c`, drainSeconds: 600, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  await refused.update(1);
  assert.match(logs[0], /could not be turned on: ECONNREFUSED/);
  assert.ok(!logs[0].includes(String(deadPort)));
  refused.stop();

  const agent = await fakeAgent(t);
  agent.reply = () => 'hang';
  const silent = taskProtection({ agentUri: agent.uri, drainSeconds: 600, now: clock.now, timers: clock.timers, log: (l) => logs.push(l), timeoutMs: 100 });
  const started = Date.now();
  await silent.update(1);
  assert.ok(Date.now() - started < 2000, 'the call is timed out');
  assert.match(logs[1], /could not be turned on: timed out/);
  silent.stop();

  const thrower = taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds: 600, fetch: () => { throw new TypeError('boom'); }, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  await thrower.update(1);
  assert.match(logs[2], /could not be turned on: TypeError/);
  thrower.stop();
});

test('a failed clear is retried, and given up once the protection has expired on its own', async () => {
  const clock = fakeClock();
  const calls = [];
  let fail = false;
  const fetch = async (_u, init) => {
    calls.push(JSON.parse(init.body));
    return fail ? new Response('{"error":{"Code":"ThrottlingException"}}', { status: 400 }) : new Response('{"protection":{}}');
  };
  const logs = [];
  const p = taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds: 60, fetch, now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  await p.update(1); // protected for 6 minutes
  fail = true;
  await p.update(0);
  assert.deepEqual(calls.at(-1), OFF);
  assert.match(logs[0], /could not be turned off: HTTP 400 ThrottlingException/);
  assert.equal(clock.pending().length, 1, 'a retry is scheduled');
  clock.advance(30_000);
  await p.update(0);
  assert.equal(calls.length, 3, 'retried after 30 s');
  clock.advance(6 * 60_000);
  await p.update(0);
  const after = calls.length;
  clock.advance(60 * 60_000);
  await p.update(0);
  assert.equal(calls.length, after, 'no more calls once the protection would have expired');
  assert.equal(clock.pending().length, 0);
});

test('stop() makes one last attempt to clear protection when no session is open, and is bounded', async (t) => {
  const clock = fakeClock();
  const calls = [];
  let fail = true;
  const fetch = async (_u, init) => {
    calls.push(JSON.parse(init.body));
    return fail ? new Response('{}', { status: 500 }) : new Response('{"protection":{}}');
  };
  const p = taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds: 600, fetch, now: clock.now, timers: clock.timers, log: () => {} });
  fail = false;
  await p.update(1);
  fail = true;
  await p.update(0); // the clear fails; a retry is pending
  fail = false;
  await p.stop();
  assert.deepEqual(calls, [ON_15, OFF, OFF], 'stop() clears at once instead of waiting for the retry');
  assert.equal(clock.pending().length, 0);
  await p.update(1);
  assert.equal(calls.length, 3, 'nothing is sent after stop()');

  // With sessions still open (the drain time passed), stop() leaves the protection to expire on its own.
  const q = taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds: 600, fetch, now: clock.now, timers: clock.timers, log: () => {} });
  await q.update(2);
  await q.stop();
  assert.deepEqual(calls.slice(3), [ON_15]);

  // A silent agent does not hold stop() past the call timeout.
  const agent = await fakeAgent(t);
  const r = taskProtection({ agentUri: agent.uri, drainSeconds: 600, now: clock.now, timers: clock.timers, log: () => {}, timeoutMs: 100 });
  await r.update(1);
  agent.reply = () => 'hang';
  r.update(0);
  const started = Date.now();
  await r.stop();
  assert.ok(Date.now() - started < 1000, `stop() took ${Date.now() - started} ms`);
});

test('taskProtection refuses a bad agent URI or drain time without echoing the URI', () => {
  for (const agentUri of ['', 'not a url', 'file:///etc/passwd', 'ftp://169.254.170.2/x']) {
    assert.throws(() => taskProtection({ agentUri, drainSeconds: 600 }), (err) => /ECS_AGENT_URI must be an http URL/.test(err.message) && (agentUri === '' || !err.message.includes(agentUri)));
  }
  for (const drainSeconds of [0, 1.5, 86_401, '600']) {
    assert.throws(() => taskProtection({ agentUri: 'http://169.254.170.2/api/c', drainSeconds }), /drainSeconds/);
  }
});

test('the EMF line has the namespace, dimension and both metrics', () => {
  const line = emfLine({ serviceName: 'rpa-browser', active: 3, capacity: 4, now: 1_760_000_000_123 });
  assert.equal(typeof line, 'string');
  assert.ok(!line.includes('\n'), 'one line');
  assert.deepEqual(JSON.parse(line), {
    _aws: {
      Timestamp: 1_760_000_000_123,
      CloudWatchMetrics: [{
        Namespace: 'RPA/Browser',
        Dimensions: [['ServiceName']],
        Metrics: [{ Name: 'SessionsActive', Unit: 'Count' }, { Name: 'SessionsCapacity', Unit: 'Count' }],
      }],
    },
    ServiceName: 'rpa-browser',
    SessionsActive: 3,
    SessionsCapacity: 4,
  });
  assert.equal(JSON.parse(emfLine({ namespace: 'Other', serviceName: 's', active: 0, capacity: 1, now: 1 }))._aws.CloudWatchMetrics[0].Namespace, 'Other');
  for (const serviceName of ['', '   ', 'tab\there', 'ü', 'x'.repeat(1025), undefined]) {
    assert.throws(() => emfLine({ serviceName, active: 0, capacity: 1, now: 1 }), /BROWSER_GATE_SERVICE_NAME/);
  }
  assert.doesNotThrow(() => emfLine({ serviceName: 'x'.repeat(1024), active: 0, capacity: 1, now: 1 }));
});

test('the EMF writer prints one whole line now and every 60 s on an unref()ed timer', () => {
  const clock = fakeClock();
  const lines = [];
  let active = 0;
  const stop = startEmf({ serviceName: 'svc', stats: () => ({ active, capacity: 4 }), write: (s) => lines.push(s), now: clock.now, timers: clock.timers });
  assert.equal(lines.length, 1);
  assert.ok(clock.pending().every((h) => h.unrefed), 'the timer never holds the process open');
  active = 2;
  clock.advance(59_999);
  assert.equal(lines.length, 1);
  clock.advance(1);
  assert.equal(lines.length, 2);
  clock.advance(60_000);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /^\{[^\n]*\}\n$/, 'each write is one whole line');
  const last = JSON.parse(lines[2]);
  assert.equal(last.SessionsActive, 2);
  assert.equal(last._aws.Timestamp, clock.now());
  stop();
  assert.equal(clock.pending().length, 0);
  clock.advance(600_000);
  assert.equal(lines.length, 3);
});

test('while the gate drains, the EMF line reports 0 sessions and 0 capacity (the task is leaving)', () => {
  const clock = fakeClock();
  const lines = [];
  let stats = { active: 2, capacity: 4, draining: false };
  const stop = startEmf({ serviceName: 'svc', stats: () => stats, write: (s) => lines.push(s), now: clock.now, timers: clock.timers });
  assert.deepEqual([JSON.parse(lines[0]).SessionsActive, JSON.parse(lines[0]).SessionsCapacity], [2, 4]);
  stats = { active: 2, capacity: 4, draining: true };
  clock.advance(60_000);
  assert.deepEqual([JSON.parse(lines[1]).SessionsActive, JSON.parse(lines[1]).SessionsCapacity], [0, 0]);
  stop();
});

test('the gate stats feed the EMF line: 0 and 0 once drain() starts, while Prometheus stays truthful', async (t) => {
  const g = createGate({ token: TOKEN, upstreamPort: 1, upstreamPath: UPSTREAM_PATH, maxSessions: 3, metricsPort: 9464 });
  const lines = [];
  const clock = fakeClock();
  const stop = startEmf({ serviceName: 'svc', stats: g.stats, write: (s) => lines.push(s), now: clock.now, timers: clock.timers });
  t.after(stop);
  assert.equal(JSON.parse(lines[0]).SessionsCapacity, 3);
  await g.drain(1000);
  clock.advance(60_000);
  assert.equal(JSON.parse(lines[1]).SessionsActive, 0);
  assert.equal(JSON.parse(lines[1]).SessionsCapacity, 0);
  const port = await listen(g.metricsServer);
  t.after(() => close(g.metricsServer));
  const body = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/metrics' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject).end();
  });
  assert.match(body, /^rpa_browser_sessions_capacity 3$/m);
  assert.match(body, /^rpa_browser_draining 1$/m);
});

// ---- The main module (gate.mjs run as a program). ----

async function fakeUpstream(t) {
  const server = createServer((_q, s) => { s.writeHead(500); s.end(); });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  const port = await listen(server);
  t.after(() => close(server));
  return port;
}

async function spawnGate(t, env) {
  const child = spawn(process.execPath, [GATE_FILE], {
    env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_GATE_METRICS_PORT: '0', ECS_AGENT_URI: '', ...env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const exited = once(child, 'exit');
  t.after(() => child.kill('SIGKILL'));
  await until(() => /listening on :(\d+)/.test(out), 'the gate to listen', 10_000);
  return { child, exited, port: Number(/listening on :(\d+)/.exec(out)[1]), out: () => out, err: () => err };
}

function openSession(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', ...AUTH } });
    req.on('upgrade', (res, socket) => resolve(socket));
    req.on('response', (res) => reject(new Error(`status ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

test('the main module: protection and EMF are off by default and the settings are validated', async (t) => {
  const upPort = await fakeUpstream(t);
  const g = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(upPort) });
  await sleep(100);
  assert.doesNotMatch(g.out() + g.err(), /ECS|EMF|_aws/);

  const cases = [
    [{ BROWSER_GATE_ECS_PROTECTION: 'yes' }, /BROWSER_GATE_ECS_PROTECTION must be on or off/],
    [{ BROWSER_GATE_EMF: 'true' }, /BROWSER_GATE_EMF must be on or off/],
    [{ BROWSER_GATE_EMF: 'on' }, /BROWSER_GATE_EMF=on needs BROWSER_GATE_SERVICE_NAME/],
    [{ BROWSER_GATE_EMF: 'on', BROWSER_GATE_SERVICE_NAME: '  ' }, /BROWSER_GATE_SERVICE_NAME/],
  ];
  for (const [env, message] of cases) {
    const run = spawnSync(process.execPath, [GATE_FILE], {
      env: { ...process.env, BROWSER_GATE_TOKEN: TOKEN, BROWSER_UPSTREAM_PATH: UPSTREAM_PATH, BROWSER_GATE_PORT: '0', BROWSER_UPSTREAM_PORT: '1', BROWSER_GATE_METRICS_PORT: '0', ...env },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.match(run.stderr, message, JSON.stringify(env));
  }
});

test('the main module: protection on without ECS_AGENT_URI logs once and the gate serves', async (t) => {
  const upPort = await fakeUpstream(t);
  const g = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(upPort), BROWSER_GATE_ECS_PROTECTION: 'on' });
  const socket = await openSession(g.port);
  socket.destroy();
  await sleep(100);
  const lines = (g.out() + g.err()).split('\n').filter((l) => /task protection/i.test(l));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /ECS_AGENT_URI is not set or not an http URL; ECS task protection is off/);
  // A value that is not an http URL gets the same line, and the value itself is never logged.
  const bad = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(upPort), BROWSER_GATE_ECS_PROTECTION: 'on', ECS_AGENT_URI: 'ftp://secret-agent-host/api/x' });
  await sleep(100);
  const badLines = (bad.out() + bad.err()).split('\n').filter((l) => /task protection/i.test(l));
  assert.equal(badLines.length, 1, badLines.join('\n'));
  assert.match(badLines[0], /ECS_AGENT_URI is not set or not an http URL; ECS task protection is off/);
  assert.doesNotMatch(bad.out() + bad.err(), /secret-agent-host|ftp:/);
});

test('the main module: protection follows the sessions, EMF lines go to stdout, and SIGTERM clears and exits', async (t) => {
  const upPort = await fakeUpstream(t);
  const agent = await fakeAgent(t);
  const g = await spawnGate(t, {
    BROWSER_UPSTREAM_PORT: String(upPort), BROWSER_GATE_DRAIN_SECONDS: '120',
    BROWSER_GATE_ECS_PROTECTION: 'on', ECS_AGENT_URI: agent.uri, BROWSER_GATE_EMF: 'on', BROWSER_GATE_SERVICE_NAME: 'rpa-browser-test',
  });
  assert.match(g.out(), /ECS task protection on while sessions are open \(7 min, renewed while they stay open\)/);
  assert.ok(!g.out().includes(agent.uri) && !g.out().includes(String(agent.port)), 'the agent URI is not logged');
  await until(() => g.out().split('\n').some((l) => l.startsWith('{')), 'the first EMF line');
  const emf = JSON.parse(g.out().split('\n').find((l) => l.startsWith('{')));
  assert.equal(emf.ServiceName, 'rpa-browser-test');
  assert.equal(emf.SessionsCapacity, 4);
  assert.equal(emf._aws.CloudWatchMetrics[0].Namespace, 'RPA/Browser');

  const socket = await openSession(g.port);
  await until(() => agent.calls.length === 1, 'protection on');
  assert.deepEqual(agent.calls[0].body, { ProtectionEnabled: true, ExpiresInMinutes: 7 });
  socket.destroy();
  await until(() => agent.calls.length === 2, 'protection off');
  assert.deepEqual(agent.calls[1].body, OFF);

  g.child.kill('SIGTERM');
  const [code] = await g.exited;
  assert.equal(code, 0);
  assert.equal(agent.calls.length, 2, 'nothing more to clear');
  assert.ok(!(g.out() + g.err()).includes(TOKEN));
});

test('the main module: a silent agent does not hold the exit', async (t) => {
  const upPort = await fakeUpstream(t);
  const agent = await fakeAgent(t);
  agent.reply = () => 'hang';
  const g = await spawnGate(t, { BROWSER_UPSTREAM_PORT: String(upPort), BROWSER_GATE_ECS_PROTECTION: 'on', ECS_AGENT_URI: agent.uri });
  const socket = await openSession(g.port);
  await until(() => agent.calls.length >= 1, 'the protection call');
  socket.destroy();
  await sleep(50);
  const started = Date.now();
  g.child.kill('SIGTERM');
  const [code] = await g.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 4500, `exited ${Date.now() - started} ms after SIGTERM`);
});
