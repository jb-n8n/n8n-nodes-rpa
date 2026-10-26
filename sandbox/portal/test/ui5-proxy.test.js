import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ui5Route, UI5_BASE, UI5_VERSION } from '../ui5-proxy.js';
import { startPortal } from '../testing.js';

const ROOT = '/sap/public/bc/ui5_ui5/resources/';

// A server of its own that calls ui5Route with an injected fetch and cache dir; the portal itself is only used for the mode test.
let server, base, cacheDir, calls, answer;
before(async () => {
  server = createServer(async (req, res) => {
    const send = (r, status, body, headers = {}) => { r.writeHead(status, { 'Content-Type': 'text/html', ...headers }); r.end(body); };
    const fetch = async (url, init) => { calls.push({ url, init }); return answer(url, init); };
    if (!(await ui5Route(req, res, new URL(req.url, 'http://x'), send, { fetch, cacheDir }))) send(res, 404, 'fell through');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

const fresh = () => { cacheDir = mkdtempSync(join(tmpdir(), 'ui5-proxy-test-')); calls = []; };
// A raw GET: fetch would normalize "..", backslashes and percent-escapes before they reach the server.
const get = (path, method = 'GET') => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: base, path, method }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end();
});

test('serves and caches a resource', async () => {
  fresh();
  assert.equal(UI5_VERSION, '1.148.10');
  assert.equal(UI5_BASE, 'https://sdk.openui5.org/1.148.10/resources/');
  answer = () => new Response('sap.ui.define(function(){});', { status: 200 });
  const first = await get(`${ROOT}sap/m/library-preload.js`);
  assert.equal(first.status, 200);
  assert.equal(first.body, 'sap.ui.define(function(){});');
  assert.match(first.headers['content-type'], /^application\/javascript/);
  assert.equal(first.headers['cache-control'], 'public, max-age=31536000');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UI5_BASE}sap/m/library-preload.js`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(readFileSync(join(cacheDir, 'sap/m/library-preload.js'), 'utf8'), 'sap.ui.define(function(){});');
  const second = await get(`${ROOT}sap/m/library-preload.js`);
  assert.equal(second.status, 200);
  assert.equal(second.body, 'sap.ui.define(function(){});');
  assert.equal(calls.length, 1, 'the second request makes no fetch');
  // UI5's own cache-buster on theme CSS is the one query accepted; it is not passed on and does not change the cache file
  answer = () => new Response('.sapMBtn{}', { status: 200 });
  const css = await get(`${ROOT}sap/m/themes/sap_horizon/library.css?sap-ui-dist-version=${UI5_VERSION}`);
  assert.equal(css.status, 200);
  assert.equal(calls.at(-1).url, `${UI5_BASE}sap/m/themes/sap_horizon/library.css`);
  assert.equal(readFileSync(join(cacheDir, 'sap/m/themes/sap_horizon/library.css'), 'utf8'), '.sapMBtn{}');
  assert.equal((await get(`${ROOT}sap/m/themes/sap_horizon/library.css?sap-ui-dist-version=1.120.0`)).status, 404);
  // content types come from the extension
  answer = () => new Response('x', { status: 200 });
  for (const [p, type] of [['sap/m/themes/sap_horizon/library.css', /^text\/css/], ['sap/m/manifest.json', /^application\/json/],
    ['sap/m/messagebundle_en.properties', /^text\/plain/], ['sap/ui/core/themes/base/fonts/72-Regular.woff2', /^font\/woff2$/]]) {
    assert.match((await get(`${ROOT}${p}`)).headers['content-type'], type, p);
  }
});

test('the proxy refuses traversal and reports an unreachable CDN', async () => {
  fresh();
  answer = () => new Response('secret', { status: 200 });
  for (const path of [`${ROOT}../../../../etc/passwd`, `${ROOT}sap/../../x.js`, `${ROOT}%2e%2e/%2e%2e/x.js`, `${ROOT}sap%2Fm.js`,
    `${ROOT}sap\\m\\library.js`, `${ROOT}sap-ui-core.js?x=1`, `${ROOT}sap-ui-core.js?`, `${ROOT}`, `${ROOT}/etc/passwd`, `${ROOT}sap//m.js`,
    `${ROOT}./sap-ui-core.js`, '/sap/public/bc/ui5_ui5/sap-ui-core.js']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
  }
  assert.equal(calls.length, 0);

  answer = () => { throw new TypeError('fetch failed'); };
  const down = await get(`${ROOT}sap-ui-core.js`);
  assert.equal(down.status, 502);
  assert.equal(down.body, 'OpenUI5 could not be loaded from sdk.openui5.org (fetch failed)');
  assert.notEqual(down.headers['cache-control'], 'public, max-age=31536000');
  answer = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  const slow = await get(`${ROOT}sap-ui-core.js`);
  assert.equal(slow.status, 502);
  assert.match(slow.body, /^OpenUI5 could not be loaded from sdk\.openui5\.org \(.*time.*\)$/i);
  assert.deepEqual(readdirSync(cacheDir), [], 'nothing cached');

  answer = () => new Response('Not Found', { status: 404 });
  const missing = await get(`${ROOT}sap/ushell/library.js`);
  assert.equal(missing.status, 404);
  assert.equal(existsSync(join(cacheDir, 'sap/ushell/library.js')), false);
  answer = () => new Response('oops', { status: 503 });
  assert.equal((await get(`${ROOT}sap/m/library.js`)).status, 502);
  assert.equal(existsSync(join(cacheDir, 'sap/m/library.js')), false);
  // a failure is retried on the next request, then cached once it works
  answer = () => new Response('ok', { status: 200 });
  assert.equal((await get(`${ROOT}sap/m/library.js`)).body, 'ok');
  assert.equal(readFileSync(join(cacheDir, 'sap/m/library.js'), 'utf8'), 'ok');
});

test('light mode does not serve UI5', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui5-proxy-mode-'));
  const saved = { fetch: globalThis.fetch, cache: process.env.UI5_CACHE_DIR };
  const cdn = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(UI5_BASE)) { cdn.push(String(url)); return new Response('/* ui5 */', { status: 200 }); }
    return saved.fetch(url, init);
  };
  process.env.UI5_CACHE_DIR = dir;
  const portal = await startPortal();
  try {
    const light = await fetch(`${portal.url}${ROOT}sap-ui-core.js`, { redirect: 'manual' });
    assert.equal(light.status, 302); // the light look-alike's /sap gate: no portal session, back to the portal login
    assert.equal(cdn.length, 0);
    assert.deepEqual(readdirSync(dir), []);
    process.env.SANDBOX_SAP = 'realistic'; // the mode is read per request
    const real = await fetch(`${portal.url}${ROOT}sap-ui-core.js`, { redirect: 'manual' });
    assert.equal(real.status, 200); // /sap/public/ needs no SAP logon
    assert.equal(await real.text(), '/* ui5 */');
    assert.deepEqual(cdn, [`${UI5_BASE}sap-ui-core.js`]);
    assert.equal(readFileSync(join(dir, 'sap-ui-core.js'), 'utf8'), '/* ui5 */');
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.cache === undefined) delete process.env.UI5_CACHE_DIR; else process.env.UI5_CACHE_DIR = saved.cache;
    await portal.close();
  }
});

test('HEAD answers like GET without a body, from the cache or by fetching and caching', async () => {
  fresh();
  answer = () => new Response('sap.ui.define(function(){});', { status: 200 });
  const miss = await get(`${ROOT}sap-ui-core.js`, 'HEAD');
  assert.equal(miss.status, 200);
  assert.equal(miss.body, '');
  assert.match(miss.headers['content-type'], /^application\/javascript/);
  assert.equal(miss.headers['cache-control'], 'public, max-age=31536000');
  assert.equal(calls.length, 1);
  assert.ok(existsSync(join(cacheDir, 'sap-ui-core.js')));
  const hit = await get(`${ROOT}sap-ui-core.js`, 'HEAD');
  assert.equal(hit.status, 200);
  assert.equal(hit.body, '');
  assert.equal(calls.length, 1);
  assert.equal((await get(`${ROOT}sap-ui-core.js`, 'POST')).status, 405);
});
