// The rpa-browser image's files and the compose service that runs it, read as text (no docker needed). node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const compose = read('docker-compose.yml');
const service = /^  browser:\n(?:(?: {4}.*)?\n)+/m.exec(compose)?.[0] ?? '';
const entrypoint = read('images/browser/entrypoint.sh');
const dockerfile = read('images/browser/Dockerfile');

test('the supervisor puts the gate in front of a loopback-only run-server on a random path kept out of the logs', () => {
  assert.match(entrypoint, /^#!\/bin\/sh\n/);
  // A random 128-bit run-server path per container start, handed to the gate only.
  assert.match(entrypoint, /^P="\$\(od -An -tx1 -N16 \/dev\/urandom \| tr -d ' \\n'\)"$/m);
  // The run-server (and every browser it launches) starts without the gate token in its environment.
  assert.match(entrypoint, /^env -u BROWSER_GATE_TOKEN \/opt\/rpa-browser\/server\/node_modules\/\.bin\/playwright run-server --port "\$\{BROWSER_UPSTREAM_PORT:-3001\}" --host 127\.0\.0\.1 --path "\/\$P" >\/dev\/null 2>&1 &$/m);
  assert.match(entrypoint, /^BROWSER_UPSTREAM_PATH="\/\$P" node \/opt\/rpa-browser\/gate\/gate\.mjs &$/m);
  assert.doesNotMatch(entrypoint, /export (P|BROWSER_UPSTREAM_PATH)\b/);
  assert.doesNotMatch(entrypoint, /run-server[^\n]*--unsafe/);
  // dash has no `wait -n`. On TERM/INT only the gate is signalled first; either process dying ends the container with 1.
  assert.doesNotMatch(entrypoint, /^\s*wait -n/m);
  assert.match(entrypoint, /^trap 'SIGNALS=\$\(\(SIGNALS \+ 1\)\)' TERM INT$/m);
  // The gate drains first (further signals are passed on to it); only then is the run-server stopped, with TERM repeated
  // (its own handler can swallow one while a browser is closing) and KILL after 10 s.
  const stopping = entrypoint.slice(entrypoint.indexOf('if [ "$SIGNALS" -gt 0 ]; then'));
  assert.match(stopping, /^if \[ "\$SIGNALS" -gt 0 \]; then\n\s+kill -TERM "\$GATE" 2>\/dev\/null\n\s+SENT=1\n[\s\S]*?while kill -0 "\$GATE" 2>\/dev\/null; do\n[\s\S]*?kill -TERM "\$GATE"[\s\S]*?done\n[\s\S]*?while kill -0 "\$RS" 2>\/dev\/null; do\n[\s\S]*?kill -KILL "\$RS"[\s\S]*?kill -TERM "\$RS"[\s\S]*?done\n\s+exit 0\n/);
  assert.ok(stopping.indexOf('kill -TERM "$GATE"') < stopping.indexOf('"$RS"'), 'the gate is signalled before the run-server');
  assert.match(entrypoint, /^exit 1$/m);
});

test('the image runs the supervisor under a pinned tini, as pwuser', () => {
  assert.match(dockerfile, /apt-get install -y --no-install-recommends tini=0\.19\.0-1\b/);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/opt\/rpa-browser\/entrypoint\.sh"\]$/m);
  assert.match(dockerfile, /^USER pwuser$/m);
  assert.match(dockerfile, /^COPY --chmod=0644 gate\/gate\.mjs \/opt\/rpa-browser\/gate\/gate\.mjs$/m);
  // gate.mjs imports ./ecs.mjs, so the image needs it next to the gate.
  assert.match(dockerfile, /^COPY --chmod=0644 gate\/ecs\.mjs \/opt\/rpa-browser\/gate\/ecs\.mjs$/m);
  assert.match(dockerfile, /^COPY --chmod=0644 server\/package\.json server\/package-lock\.json \.\/$/m);
  assert.match(dockerfile, /^COPY --chmod=0755 entrypoint\.sh \/opt\/rpa-browser\/entrypoint\.sh$/m);
});

test('the image declares /tmp a volume, root-owned 1777, so a read-only root still has a writable /tmp', () => {
  // Fargate (and docker) copy the image's VOLUME path, with its owner and mode, into the empty bind mount or volume
  // mounted there. Without the VOLUME a Fargate bind mount is root 0755 and pwuser can't write it.
  assert.match(dockerfile, /^RUN chown root:root \/tmp && chmod 1777 \/tmp$/m);
  assert.match(dockerfile, /^VOLUME \["\/tmp"\]$/m);
  assert.ok(dockerfile.indexOf('chmod 1777 /tmp') < dockerfile.indexOf('VOLUME ["/tmp"]'), 'build steps after a VOLUME line discard their changes to it');
});

test('the compose stack builds the image, runs it hardened and publishes no browser port', () => {
  const dev = read('docker-compose.dev.yml');
  const env = read('.env.example');
  // The browser service is `browser` (n8n's default endpoint is ws://browser:3000/).
  assert.match(service, /^ {4}build:\n {6}context: images\/browser\n {4}image: n8n-rpa\/rpa-browser:local$/m);
  assert.doesNotMatch(compose, /^  playwright:/m);
  // tini is the image's PID 1, the supervisor is the image's entrypoint and the gate is baked in.
  assert.doesNotMatch(service, /^\s+init:/m);
  assert.doesNotMatch(service, /^\s+(command|entrypoint|volumes):/m);
  assert.match(service, /^ {4}restart: unless-stopped\n {4}user: pwuser$/m);
  for (const line of ['security_opt: [no-new-privileges:true]', 'cap_drop: [ALL]', 'mem_limit: 2g', 'pids_limit: 1024']) {
    assert.match(service, new RegExp(`^ {4}${line.replace(/[[\]]/g, '\\$&')}$`, 'm'), line);
  }
  assert.doesNotMatch(service, /cap_add|privileged/);
  assert.match(service, /BROWSER_GATE_TOKEN: \$\{BROWSER_TOKEN:\?set BROWSER_TOKEN in \.env\}/);
  assert.match(service, /BROWSER_GATE_PORT: "3000"/);
  assert.match(service, /BROWSER_UPSTREAM_PORT: "3001"/);
  assert.match(compose, /"127\.0\.0\.1:8080:8080"/);
  assert.doesNotMatch(compose, /network_mode/);
  assert.doesNotMatch(compose, /3000:3000/);
  assert.match(dev, /"127\.0\.0\.1:3000:3000"/);
  assert.match(env, /^# openssl rand -hex 32$/m);
  assert.match(env, /^BROWSER_TOKEN=$/m);
  assert.doesNotMatch(env, /PLAYWRIGHT_TOKEN/);
});

test('the image installs the run-server at build time from an integrity-checked lockfile, never at start', () => {
  assert.doesNotMatch(service, /^\s+[^#\s][^\n]*\bnpx\b/m);
  assert.doesNotMatch(entrypoint, /^[^#\n]*\bnpx\b/m);
  // The image, the lockfile and the engine's playwright-core move together (README: Version matching).
  const engine = JSON.parse(read('packages/engine/package.json')).dependencies['playwright-core'];
  assert.match(dockerfile, new RegExp(`^FROM mcr\\.microsoft\\.com/playwright:v${engine.replace(/\./g, '\\.')}@sha256:[0-9a-f]{64}$`, 'm'));
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  const lock = JSON.parse(read('images/browser/server/package-lock.json'));
  for (const name of ['playwright', 'playwright-core']) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry?.version, engine, name);
    assert.match(entry?.integrity ?? '', /^sha512-/, name);
  }
});
