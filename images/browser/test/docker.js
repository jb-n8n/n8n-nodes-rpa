// Shared harness for the docker tests (entrypoint.test.js, container.test.js); not a test file itself.
// They run only with RPA_DOCKER_TESTS=1 and a working `docker`. Each test file builds the image under its own per-run tag
// (the second build is all cache hits) and removes it and its containers afterwards. RPA_BROWSER_IMAGE=<image> uses a
// prebuilt image instead (CI builds it once with buildx) and leaves it in place.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const IMAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const ROOT = new URL('../../../', import.meta.url);
export const TOKEN = 'e2e0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';

export const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000, ...opts });
/** Runs a docker command without blocking the event loop; resolves with its exit status. */
export const dockerAsync = (args) => new Promise((resolve) => spawn('docker', args, { stdio: 'ignore' }).on('exit', resolve));
const dockerReady = () => {
  const r = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 20_000 });
  return r.status === 0 && r.stdout.trim() !== '';
};
export const skip = process.env.RPA_DOCKER_TESTS !== '1'
  ? 'set RPA_DOCKER_TESTS=1 to build and run the rpa-browser image'
  : !dockerReady() ? 'docker is not available' : false;

/** Per docker test, so a hung container or connect fails that test instead of stalling the run (the slowest takes ~5 s). */
export const DOCKER_TEST_TIMEOUT = 90_000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** "<running> <exit code>", for example "true 0" while running and "false 1" after a failure exit. */
export const state = (id) => docker(['inspect', id, '--format', '{{.State.Running}} {{.State.ExitCode}}']).stdout.trim();
export const logs = (id) => { const r = docker(['logs', id]); return `${r.stdout}${r.stderr}`; };
/** Polls until the container has stopped or the time is up; resolves with the milliseconds it waited. */
export async function waitForExit(id, withinMs) {
  const from = Date.now();
  while (state(id).startsWith('true') && Date.now() - from < withinMs) await sleep(100);
  return Date.now() - from;
}

/**
 * One image and the containers started from it, for one test file. `label` keeps the tag and names apart from the other
 * file's; the pid keeps concurrent runs (or another checkout) from sharing or removing each other's image and containers.
 */
export function harness(label) {
  const prebuilt = process.env.RPA_BROWSER_IMAGE?.trim() || '';
  const image = prebuilt || `rpa-browser:${label}-test-${process.pid}`;
  const prefix = `rpa-browser-${label}-test-${process.pid}`;
  const started = [];
  return {
    image,
    build() {
      if (prebuilt) {
        assert.equal(docker(['image', 'inspect', prebuilt]).status, 0, `RPA_BROWSER_IMAGE=${prebuilt} is not a local image`);
        return;
      }
      const build = docker(['build', '-t', image, IMAGE_DIR], { stdio: ['ignore', 'ignore', 'pipe'] });
      assert.equal(build.status, 0, `docker build failed:\n${build.stderr}`);
    },
    cleanup() {
      // -v: the image declares /tmp a VOLUME, so every container has an anonymous volume to remove with it.
      for (const name of started) docker(['rm', '-f', '-v', name]);
      if (!prebuilt) docker(['rmi', '-f', image]);
    },
    /**
     * Runs the image hardened like the compose stack (no capabilities, no privilege escalation, memory and process limits)
     * and waits for the gate. Not --rm: tests read the exit code afterwards; cleanup() removes every container.
     * `args` are extra `docker run` options (for example --read-only). Resolves with { container, port, metricsPort }
     * (metricsPort is the published 9464 when `metrics` is set).
     */
    async start(suffix, { env = {}, metrics = false, args = [] } = {}) {
      const name = `${prefix}-${suffix}`;
      started.push(name);
      const envArgs = Object.entries({ BROWSER_GATE_TOKEN: TOKEN, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const run = docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3000', ...(metrics ? ['-p', '127.0.0.1::9464'] : []),
        ...envArgs, ...args, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '2g', '--pids-limit', '1024', image]);
      assert.equal(run.status, 0, run.stderr);
      const container = run.stdout.trim();
      const published = (p) => {
        const mapped = docker(['port', container, `${p}/tcp`]).stdout.trim().split('\n')[0];
        return Number(mapped.slice(mapped.lastIndexOf(':') + 1));
      };
      const port = published(3000);
      await waitForGate(port, container);
      return { container, port, metricsPort: metrics ? published(9464) : undefined };
    },
  };
}

/** Waits until the gate answers plain HTTP (404), or fails after the deadline. */
async function waitForGate(port, id, deadline = Date.now() + 60_000) {
  for (;;) {
    const ok = await new Promise((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode === 404); });
      req.on('error', () => resolve(false));
      req.end();
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`the gate never answered; logs:\n${logs(id)}`);
    await sleep(500);
  }
}

/** A WebSocket upgrade request to the gate; resolves with { status, browser } (the X-RPA-Browser header, if any). */
export function upgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, browser: res.headers['x-rpa-browser'] }); });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, browser: res.headers['x-rpa-browser'] }); });
    req.on('error', reject);
    req.end();
  });
}

/** A plain HTTP request; resolves with { status, body }. */
export function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** One Prometheus sample's value from the metrics text, or undefined. */
export const sample = (text, name) => {
  const line = text.split('\n').find((l) => l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(name.length + 1));
};

/** Connects playwright-core (the engine's copy) through the gate, retrying while the run-server starts. */
export async function connectBrowser(port) {
  const { chromium } = createRequire(new URL('packages/engine/package.json', ROOT))('playwright-core');
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chromium.connect(`ws://127.0.0.1:${port}/`, { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 15_000 });
    } catch (err) {
      // The gate can be up a moment before the run-server is.
      if (attempt >= 20) throw err;
      await sleep(500);
    }
  }
}
