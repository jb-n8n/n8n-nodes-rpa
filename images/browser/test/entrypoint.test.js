// The rpa-browser image end to end, the basics: tini, the supervisor (entrypoint.sh), the run-server and the gate in one
// container that starts, authenticates, serves a session and stops. The drain, metrics and failure behaviour is in container.test.js.
// node:test, no dependencies of its own (playwright-core comes from the engine package). It builds the image (or uses
// RPA_BROWSER_IMAGE), so it runs only with RPA_DOCKER_TESTS=1 and a working `docker` (see docker.js):
//   RPA_DOCKER_TESTS=1 pnpm --filter n8n-rpa-gate test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_TEST_TIMEOUT, connectBrowser, docker, dockerAsync, harness, skip, upgrade } from './docker.js';

const h = harness('entrypoint');
let container;
let port;

before(async () => {
  if (skip) return;
  h.build();
  ({ container, port } = await h.start('main'));
});

after(() => {
  if (!skip) h.cleanup();
});

const upgradeStatus = async (headers) => (await upgrade(port, headers)).status;

test('the image runs tini as PID 1 and the supervisor under it, as pwuser', { skip, timeout: DOCKER_TEST_TIMEOUT }, () => {
  const inspect = docker(['image', 'inspect', h.image, '--format', '{{json .Config.Entrypoint}} {{.Config.User}}']);
  assert.equal(inspect.stdout.trim(), '["/usr/bin/tini","--","/opt/rpa-browser/entrypoint.sh"] pwuser');
  const pid1 = docker(['exec', container, 'cat', '/proc/1/cmdline']).stdout.split('\0').filter(Boolean);
  assert.deepEqual(pid1, ['/usr/bin/tini', '--', '/opt/rpa-browser/entrypoint.sh']);
});

test('a WebSocket upgrade without the token gets 401', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  assert.equal(await upgradeStatus(), 401);
  assert.equal(await upgradeStatus({ Authorization: 'Bearer not-the-token-not-the-token-not-the-token' }), 401);
});

test('with the token, playwright-core connects through the gate and opens a page', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const browser = await connectBrowser(port);
  try {
    const page = await browser.newPage();
    await page.setContent('<h1>Hello from rpa-browser</h1>');
    assert.equal(await page.textContent('h1'), 'Hello from rpa-browser');
    assert.ok((await page.screenshot()).length > 0);
  } finally {
    await browser.close();
  }
});

test('the logs show the gate but never the run-server address', { skip, timeout: DOCKER_TEST_TIMEOUT }, () => {
  const logs = docker(['logs', container]);
  const all = `${logs.stdout}${logs.stderr}`;
  assert.match(all, /browser-gate: listening on :3000/);
  assert.doesNotMatch(all, /Listening on ws:|127\.0\.0\.1:3001\//);
});

test('docker stop exits 0 and the container stops cleanly, well before the kill timeout', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const started = Date.now();
  let stoppedAt;
  const stopping = dockerAsync(['stop', '-t', '20', container]).then((status) => { stoppedAt = Date.now(); return status; });
  // If the stop is slow, record what is still running (the run-server path redacted) so a failure says why.
  let snapshot = '';
  while (stoppedAt === undefined && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 100));
  if (stoppedAt === undefined) {
    snapshot = docker(['exec', container, 'ps', '-eo', 'pid,ppid,stat,etime,args']).stdout.replace(/--path \/\S+/g, '--path /<secret>');
  }
  assert.equal(await stopping, 0);
  const logs = docker(['logs', container]);
  const why = `stop took ${stoppedAt - started} ms\nstill running after 5 s:\n${snapshot}\nlogs:\n${logs.stdout}${logs.stderr}`;
  assert.ok(stoppedAt - started < 15_000, why);
  assert.equal(docker(['inspect', container, '--format', '{{.State.ExitCode}}']).stdout.trim(), '0', why);
});

test('the run-server and the browsers it launches never see the gate token', { skip, timeout: DOCKER_TEST_TIMEOUT }, async () => {
  const { container: id, port: p } = await h.start('env');
  const browser = await connectBrowser(p);
  try {
    await (await browser.newPage()).setContent('<p>env</p>');
    // Run as pwuser, which owns every process here, so /proc/<pid>/environ is readable.
    const script = 'for pid in $(pgrep -f "$1"); do [ "$pid" = "$$" ] && continue; '
      + 'if tr "\\0" "\\n" < /proc/$pid/environ 2>/dev/null | grep -q "^BROWSER_GATE_TOKEN="; then echo "$pid token"; else echo "$pid clean"; fi; done';
    const check = (pattern) => docker(['exec', id, 'sh', '-c', script, 'sh', pattern]).stdout.trim().split('\n').filter(Boolean);
    const gate = check('gate/gate.mjs');
    assert.ok(gate.length > 0 && gate.every((l) => l.endsWith(' token')), `the gate has the token: ${gate}`);
    const runServer = check('playwright run-server');
    assert.ok(runServer.length > 0, 'the run-server is running');
    assert.deepEqual(runServer.filter((l) => !l.endsWith(' clean')), [], 'the run-server has no token');
    const chromium = check('chrom');
    assert.ok(chromium.length > 0, 'a browser is running');
    assert.deepEqual(chromium.filter((l) => !l.endsWith(' clean')), [], 'no browser process has the token');
  } finally {
    await browser.close();
  }
});
