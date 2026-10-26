// The rpa-browser container's behaviour: metrics and health, the SIGTERM drain (the open session is kept, new ones get
// 503 `draining`, up to BROWSER_GATE_DRAIN_SECONDS) and the supervisor exiting 1 when the run-server or the gate dies, so
// the orchestrator restarts it and the client sees a closed connection, never a stuck one.
// The start/stop basics are in entrypoint.test.js. Runs only with RPA_DOCKER_TESTS=1 and a working `docker` (docker.js):
//   RPA_DOCKER_TESTS=1 node --test images/browser/test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_TEST_TIMEOUT, TOKEN, connectBrowser, docker, get, harness, logs, sample, skip, sleep, state, upgrade, waitForExit } from './docker.js';

const h = harness('container');
let main;

before(async () => {
  if (skip) return;
  h.build();
  main = await h.start('main', { metrics: true });
});

after(() => {
  if (!skip) h.cleanup();
});

const metrics = async (port) => {
  const res = await get(port, '/metrics');
  assert.equal(res.status, 200);
  return res.body;
};
const auth = { Authorization: `Bearer ${TOKEN}` };
/** Resolves true once the browser reports the connection closed, or false after `ms`. */
const closedWithin = (disconnected, ms) => Promise.race([disconnected.then(() => true), sleep(ms).then(() => false)]);
/** An open session: a connected browser with a page, and a promise that settles when the connection closes. */
async function openSession(port) {
  const browser = await connectBrowser(port);
  const disconnected = new Promise((resolve) => browser.once('disconnected', resolve));
  const page = await browser.newPage();
  await page.setContent('<p>open</p>');
  return { browser, page, disconnected };
}

test('metrics and healthz are served', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const { port, metricsPort } = main;
  // The gate can answer before the run-server listens; until then /healthz says so (503 `upstream down`).
  let health;
  for (const until = Date.now() + 30_000; Date.now() < until; await sleep(200)) {
    health = await get(port, '/healthz');
    if (health.status === 200) break;
    assert.deepEqual(health, { status: 503, body: 'upstream down\n' });
  }
  assert.deepEqual(health, { status: 200, body: 'ok\n' });
  assert.deepEqual(await get(port, '/healthz', 'HEAD'), { status: 200, body: '' });
  // Metrics have their own port (9464), never the gate's.
  assert.equal((await get(port, '/metrics')).status, 404);
  const idle = await metrics(metricsPort);
  assert.equal(sample(idle, 'rpa_browser_sessions_active'), 0);
  assert.equal(sample(idle, 'rpa_browser_sessions_capacity'), 4);
  assert.equal(sample(idle, 'rpa_browser_draining'), 0);

  const { browser } = await openSession(port);
  let busy;
  try {
    busy = await metrics(metricsPort);
    assert.equal(sample(busy, 'rpa_browser_sessions_active'), 1);
    assert.ok(sample(busy, 'rpa_browser_sessions_total') >= 1, busy);
  } finally {
    await browser.close();
  }
  let active;
  for (const until = Date.now() + 5000; Date.now() < until; await sleep(100)) {
    active = sample(await metrics(metricsPort), 'rpa_browser_sessions_active');
    if (active === 0) break;
  }
  assert.equal(active, 0, 'the closed session is no longer counted');
  assert.ok(!`${idle}${busy}`.includes(TOKEN), 'the metrics never carry the token');
});

test('runs on a read-only root filesystem with /tmp on a volume, as on ECS', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  // Like the ECS task: readonlyRootFilesystem, an empty volume at /tmp (filled from the image's VOLUME, owner and mode
  // included) and the XDG directories under /tmp, as the Helm chart sets them.
  const { container: id, port } = await h.start('read-only', {
    env: { XDG_CACHE_HOME: '/tmp/.cache', XDG_CONFIG_HOME: '/tmp/.config' },
    args: ['--read-only', '--mount', 'type=volume,dst=/tmp'],
  });
  assert.equal(docker(['exec', id, 'stat', '-c', '%U %a', '/tmp']).stdout.trim(), 'root 1777');
  assert.notEqual(docker(['exec', id, 'touch', '/home/pwuser/x']).status, 0, 'the root filesystem is read-only');
  const browser = await connectBrowser(port);
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>read-only root</h1>');
    const png = await page.screenshot();
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.ok(png.length > 1000, `a real screenshot, ${png.length} bytes`);
  } finally {
    await browser.close();
  }
  assert.match(state(id), /^true /, logs(id));
});

test('SIGTERM holds the container until the session closes', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const { container: id, port, metricsPort } = await h.start('hold', { metrics: true });
  const { browser, page } = await openSession(port);
  try {
    assert.equal(docker(['kill', '--signal', 'TERM', id]).status, 0);
    await sleep(1500);
    assert.equal(state(id), 'true 0', 'the container is still running while the session is open');
    // A new session is refused with the status and header the engine waits on; the load balancer sees /healthz fail.
    assert.deepEqual(await upgrade(port, auth), { status: 503, browser: 'draining' });
    assert.deepEqual(await get(port, '/healthz'), { status: 503, body: 'draining\n' });
    const draining = await metrics(metricsPort);
    assert.equal(sample(draining, 'rpa_browser_draining'), 1);
    assert.equal(sample(draining, 'rpa_browser_sessions_active'), 1);
    assert.equal(sample(draining, 'rpa_browser_refused_total{reason="draining"}'), 1);
    assert.equal(await page.textContent('p'), 'open', 'the open session keeps working while the gate drains');
  } finally {
    await browser.close();
  }
  const took = await waitForExit(id, 15_000);
  assert.equal(state(id), 'false 0', `exit after a drained stop (${took} ms after the session closed)\n${logs(id)}`);
  assert.ok(took < 5000, `the container stopped ${took} ms after the session closed`);
  assert.match(logs(id), /browser-gate: drained, no sessions open; exiting/);
});

test('SIGTERM exits after the drain time', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const { container: id, port } = await h.start('drain-time', { env: { BROWSER_GATE_DRAIN_SECONDS: '3' } });
  const { browser, disconnected } = await openSession(port);
  try {
    const signalled = Date.now();
    assert.equal(docker(['kill', '--signal', 'TERM', id]).status, 0);
    await sleep(2000);
    assert.equal(state(id), 'true 0', 'still draining before the drain time');
    await waitForExit(id, 20_000);
    const took = Date.now() - signalled;
    assert.equal(state(id), 'false 0', logs(id));
    // The drain time (3 s), then the run-server stop: TERM every second while a browser closes, KILL after 10 s at most.
    assert.ok(took >= 2900 && took < 15_000, `the container stopped ${took} ms after TERM`);
    assert.match(logs(id), /browser-gate: drain time passed with 1 session open; exiting/);
    assert.ok(await closedWithin(disconnected, 5000), 'the client sees the session closed');
  } finally {
    await browser.close().catch(() => {});
  }
});

test('a second stop signal ends the drain at once', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const { container: id, port } = await h.start('twice');
  const { browser } = await openSession(port);
  try {
    assert.equal(docker(['kill', '--signal', 'TERM', id]).status, 0);
    await sleep(1500);
    assert.equal(state(id), 'true 0', 'the first TERM drains while the session is open');
    assert.equal(docker(['kill', '--signal', 'TERM', id]).status, 0);
    const took = await waitForExit(id, 15_000);
    assert.equal(state(id), 'false 0');
    assert.ok(took < 5000, `the container stopped ${took} ms after the second TERM`);
  } finally {
    await browser.close().catch(() => {});
  }
});

/** Kills one of the supervisor's two processes with SIGKILL, mid-session, and checks the container exits 1. */
async function killMidSession(suffix, pattern) {
  const { container: id, port } = await h.start(suffix);
  const { browser, disconnected } = await openSession(port);
  try {
    // docker exec runs pgrep directly (no shell), and pgrep never matches itself.
    const pids = docker(['exec', id, 'pgrep', '-f', pattern]).stdout.trim().split('\n').filter(Boolean);
    assert.equal(pids.length, 1, `one process matches ${pattern}: ${pids}`);
    assert.equal(docker(['exec', id, 'sh', '-c', 'kill -KILL "$1"', 'sh', pids[0]]).status, 0);
    const took = await waitForExit(id, 15_000);
    assert.equal(state(id), 'false 1', `exit code after the process died (${took} ms)\n${logs(id)}`);
    assert.ok(took < 5000, `the container stopped ${took} ms after the process died`);
    assert.match(logs(id), /rpa-browser: the run-server or the gate stopped; exiting so the container restarts/);
    assert.ok(await closedWithin(disconnected, 5000), 'the client sees the session closed, not a stuck connection');
  } finally {
    await browser.close().catch(() => {});
  }
}

test('the container exits when the run-server dies', { skip, timeout: DOCKER_TEST_TIMEOUT }, () => killMidSession('rs-dies', 'playwright run-server'));

test('the container exits when the gate dies', { skip, timeout: DOCKER_TEST_TIMEOUT }, () => killMidSession('gate-dies', 'gate/gate.mjs'));
