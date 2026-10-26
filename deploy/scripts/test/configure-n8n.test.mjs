// configure-n8n.mjs against a fake n8n public API (node:http): the credential, the template import, idempotency, and
// that neither the token nor the API key ever reaches the script's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../configure-n8n.mjs', import.meta.url));
const TEMPLATES = fileURLToPath(new URL('../../../packages/n8n-nodes-rpa/templates/', import.meta.url));
const API_KEY = 'n8n-api-key-0123456789-abcdefghij';
const TOKEN = 'rpa-browser-token-ZYXWVUTSRQPONMLKJIHGFEDCBA-0123456789';
const ENDPOINT = 'ws://rpa-browser.n8n.svc.cluster.local:3000/';
const EXPECTED = ['RPA: 0 Connection check', 'RPA: 1 Create tables (run once)', 'RPA: 2 Data feed', 'RPA: 3 Approve steps', 'RPA: Hello world'];
// The fields of the RPA Browser credential (credentials/PlaywrightBrowserApi.credentials.ts), as n8n 2.41's
// GET /api/v1/credentials/schema/playwrightBrowserApi derives them (toJsonSchema: notices included, nothing required).
const SCHEMA = {
  additionalProperties: false,
  type: 'object',
  properties: {
    notice: { type: 'notice' }, mode: { type: 'string', enum: ['playwright', 'cdp', 'local'] }, playwrightNotice: { type: 'notice' },
    cdpNotice: { type: 'notice' }, localNotice: { type: 'notice' }, wsUrl: { type: 'string' }, token: { type: 'string' },
    privateNetwork: { type: 'boolean' }, headless: { type: 'boolean' }, slowMo: { type: 'number' },
  },
  required: [],
};

/**
 * A fake n8n: the public API routes the script uses, with cursor pagination (two items a page, so the lists page),
 * the API key check, and a request log. `echoCredentialBody` makes POST /credentials fail with the request body in its
 * message, as a careless proxy or server might.
 */
async function fakeN8n({ echoCredentialBody = false, knowsType = true, listsCredentials = true, credentials = [], workflows = [] } = {}) {
  const state = { credentials: [...credentials], workflows: [...workflows], requests: [] };
  const page = (items, url) => {
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 2);
    const data = items.slice(offset, offset + limit);
    return { data, nextCursor: offset + limit < items.length ? String(offset + limit) : null };
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      state.requests.push({ method: req.method, path: url.pathname, body, apiKey: req.headers['x-n8n-api-key'] });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers['x-n8n-api-key'] !== API_KEY) return send(401, { message: 'unauthorized' });
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/v1/credentials/schema/playwrightBrowserApi') return knowsType ? send(200, SCHEMA) : send(404, { message: 'Not Found' });
      if (route === 'GET /api/v1/credentials') {
        // n8n 2.41 lists credentials only for the owner and admins (scope credential:list).
        return listsCredentials ? send(200, page(state.credentials, url)) : send(403, { message: 'Forbidden' });
      }
      if (route === 'POST /api/v1/credentials') {
        if (echoCredentialBody) return send(400, { message: `request.body is not valid: ${body}` });
        const c = JSON.parse(body);
        const created = { id: `c${state.credentials.length + 1}`, name: c.name, type: c.type, data: c.data, shared: [{ id: c.projectId ?? 'personal' }] };
        state.credentials.push(created);
        return send(200, { id: created.id, name: created.name, type: created.type });
      }
      if (route === 'GET /api/v1/workflows') {
        const project = url.searchParams.get('projectId');
        return send(200, page(project ? state.workflows.filter((w) => (w.projectId ?? 'personal') === project) : state.workflows, url));
      }
      if (route === 'POST /api/v1/workflows') {
        const w = JSON.parse(body);
        const created = { id: `w${state.workflows.length + 1}`, ...w };
        state.workflows.push(created);
        return send(200, { id: created.id, name: created.name });
      }
      return send(404, { message: `no route ${route}` });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Runs the script; resolves with its exit code and combined output (never rejects). */
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

const ENV = { N8N_API_KEY: API_KEY, RPA_BROWSER_TOKEN: TOKEN };
const assertNoSecrets = (out) => {
  assert.ok(!out.includes(TOKEN), 'the token is not in the output');
  assert.ok(!out.includes(API_KEY), 'the API key is not in the output');
};

test('creates the credential and imports the templates without echoing the token', async () => {
  const n8n = await fakeN8n({ workflows: [{ id: 'x1', name: 'Someone else 1' }, { id: 'x2', name: 'Someone else 2' }, { id: 'x3', name: 'Someone else 3' }] });
  try {
    const { code, out } = await run(['--n8n-url', `${n8n.url}/`, '--endpoint', ENDPOINT], ENV);
    assert.equal(code, 0, out);
    assertNoSecrets(out);

    const creds = n8n.state.credentials;
    assert.equal(creds.length, 1);
    assert.deepEqual(creds[0], {
      id: 'c1', name: 'RPA Browser', type: 'playwrightBrowserApi',
      // ws:// to a cluster or VPC address: the engine needs Private Network Endpoint on (with the token) to accept it.
      data: { mode: 'playwright', wsUrl: ENDPOINT, token: TOKEN, privateNetwork: true }, shared: [{ id: 'personal' }],
    });

    const imported = n8n.state.workflows.slice(3);
    assert.deepEqual(imported.map((w) => w.name), EXPECTED);
    for (const w of imported) {
      // Only what POST /api/v1/workflows accepts (its schema has additionalProperties: false), no credentials.
      assert.deepEqual(Object.keys(w).sort(), ['connections', 'id', 'name', 'nodes', 'settings']);
      assert.ok(!JSON.stringify(w).includes('"credentials"'), `${w.name} carries no credential`);
    }
    const file = readFileSync(join(TEMPLATES, '2-data-feed.json'), 'utf8');
    assert.deepEqual(imported[2].nodes, JSON.parse(file).nodes);

    // Every request carried the key in the header, and no request put a secret in its URL.
    for (const r of n8n.state.requests) {
      assert.equal(r.apiKey, API_KEY);
      assert.ok(!r.path.includes(TOKEN) && !r.path.includes(API_KEY));
    }
    for (const name of ['RPA Browser', ...EXPECTED]) assert.match(out, new RegExp(`created.*${name.replace(/[()]/g, '\\$&')}`, 'i'));
    // The remaining steps.
    assert.match(out, /RPA: 1 Create tables \(run once\)/);
    assert.match(out, /pick/i);
  } finally {
    await n8n.close();
  }
});

test('is idempotent', async () => {
  const n8n = await fakeN8n();
  try {
    const first = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.equal(first.code, 0, first.out);
    const posts = n8n.state.requests.filter((r) => r.method === 'POST').length;
    assert.equal(posts, 1 + EXPECTED.length);

    const second = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.equal(second.code, 0, second.out);
    assertNoSecrets(second.out);
    assert.equal(n8n.state.requests.filter((r) => r.method === 'POST').length, posts, 'the second run creates nothing');
    assert.equal(n8n.state.credentials.length, 1);
    assert.equal(n8n.state.workflows.length, EXPECTED.length);
    for (const name of ['RPA Browser', ...EXPECTED]) assert.match(second.out, new RegExp(`exists.*${name.replace(/[()]/g, '\\$&')}`, 'i'));
  } finally {
    await n8n.close();
  }
});

test('refuses to run without N8N_API_KEY', async () => {
  const n8n = await fakeN8n();
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], { RPA_BROWSER_TOKEN: TOKEN });
    assert.notEqual(code, 0);
    assert.match(out, /N8N_API_KEY/);
    assert.equal(n8n.state.requests.length, 0, 'nothing was sent');
    assertNoSecrets(out);
  } finally {
    await n8n.close();
  }
});

test('refuses secrets as flags, a missing or short token, and a bad endpoint, before sending anything', async () => {
  const n8n = await fakeN8n();
  try {
    const cases = [
      [['--n8n-url', n8n.url, '--endpoint', ENDPOINT, '--token', TOKEN], ENV, /--token/],
      [['--n8n-url', n8n.url, '--endpoint', ENDPOINT], { N8N_API_KEY: API_KEY }, /RPA_BROWSER_TOKEN/],
      [['--n8n-url', n8n.url, '--endpoint', ENDPOINT], { N8N_API_KEY: API_KEY, RPA_BROWSER_TOKEN: 'short' }, /32/],
      [['--n8n-url', n8n.url, '--endpoint', 'http://rpa-browser:3000/'], ENV, /ws:\/\/ or wss:\/\//],
      [['--n8n-url', 'ftp://n8n.example.com', '--endpoint', ENDPOINT], ENV, /--n8n-url/],
      [['--endpoint', ENDPOINT], ENV, /--n8n-url/],
      [['--n8n-url', n8n.url.replace('://', '://admin:hunter2@'), '--endpoint', ENDPOINT], ENV, /--n8n-url must not carry a user or password/],
    ];
    for (const [args, env, message] of cases) {
      const { code, out } = await run(args, env);
      assert.notEqual(code, 0, args.join(' '));
      assert.match(out, message);
      assertNoSecrets(out);
    }
    assert.equal(n8n.state.requests.length, 0);
  } finally {
    await n8n.close();
  }
});

test('masks a server error that echoes the request body', async () => {
  const n8n = await fakeN8n({ echoCredentialBody: true });
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.notEqual(code, 0);
    assertNoSecrets(out);
    assert.match(out, /RPA Browser/);
    assert.match(out, /400/);
  } finally {
    await n8n.close();
  }
});

test('stops when n8n does not know the credential type (the node package is not installed)', async () => {
  const n8n = await fakeN8n({ knowsType: false });
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.notEqual(code, 0);
    assert.match(out, /playwrightBrowserApi/);
    assert.match(out, /n8n-nodes-rpa/);
    assert.equal(n8n.state.requests.filter((r) => r.method === 'POST').length, 0);
  } finally {
    await n8n.close();
  }
});

test('without the right to list credentials, creates none (it could not tell a duplicate) and still imports the templates', async () => {
  const n8n = await fakeN8n({ listsCredentials: false });
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.notEqual(code, 0, 'the run is incomplete');
    assertNoSecrets(out);
    assert.equal(n8n.state.credentials.length, 0);
    assert.deepEqual(n8n.state.workflows.map((w) => w.name), EXPECTED);
    assert.match(out, /credential:list/);
    assert.match(out, /owner or an admin/);
  } finally {
    await n8n.close();
  }
});

test('imports from --templates and refuses a directory without the five templates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpa-templates-'));
  try {
    for (const f of readdirSync(TEMPLATES)) writeFileSync(join(dir, f), readFileSync(join(TEMPLATES, f)));
    const n8n = await fakeN8n();
    try {
      const ok = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT, '--templates', dir], ENV);
      assert.equal(ok.code, 0, ok.out);
      assert.deepEqual(n8n.state.workflows.map((w) => w.name), EXPECTED);
      rmSync(join(dir, 'hello-world.json'));
      const missing = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT, '--templates', dir], ENV);
      assert.notEqual(missing.code, 0);
      assert.match(missing.out, /hello-world\.json/);
    } finally {
      await n8n.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warns when the API key and the token would cross the network unencrypted (http:// to a host that is not loopback)', async () => {
  // A name that never resolves (.invalid, RFC 6761): the warning comes before any request.
  const remote = await run(['--n8n-url', 'http://n8n.example.invalid', '--endpoint', ENDPOINT], ENV);
  assert.match(remote.out, /WARNING: .*http:\/\/.*unencrypted/);
  assertNoSecrets(remote.out);
  const n8n = await fakeN8n();
  try {
    for (const url of [n8n.url, n8n.url.replace('127.0.0.1', 'localhost')]) {
      const local = await run(['--n8n-url', url, '--endpoint', ENDPOINT], ENV);
      assert.equal(local.code, 0, local.out);
      assert.doesNotMatch(local.out, /unencrypted/);
    }
  } finally {
    await n8n.close();
  }
});

test('refuses a same-name credential of another type: exit 1, rename it', async () => {
  const n8n = await fakeN8n({ credentials: [{ id: 'c9', name: 'RPA Browser', type: 'httpHeaderAuth', shared: [{ id: 'personal' }] }] });
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT], ENV);
    assert.equal(code, 1, out);
    assert.match(out, /httpHeaderAuth/);
    assert.match(out, /[Rr]ename it/);
    assert.equal(n8n.state.credentials.length, 1, 'nothing created next to it');
    assert.deepEqual(n8n.state.workflows.map((w) => w.name), EXPECTED, 'the templates are still imported');
  } finally {
    await n8n.close();
  }
});

test('--project-id creates the credential and the workflows in that project, and checks names there', async () => {
  const n8n = await fakeN8n({
    credentials: [{ id: 'c9', name: 'RPA Browser', type: 'playwrightBrowserApi', shared: [{ id: 'personal' }] }],
    workflows: [{ id: 'w9', name: 'RPA: 0 Connection check' }],
  });
  try {
    const { code, out } = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT, '--project-id', 'Prj4RPA0001'], ENV);
    assert.equal(code, 0, out);
    assertNoSecrets(out);
    const posts = n8n.state.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body));
    assert.equal(posts.length, 1 + EXPECTED.length, 'the personal-project copies do not count');
    for (const body of posts) assert.equal(body.projectId, 'Prj4RPA0001');
    assert.ok(n8n.state.requests.some((r) => r.method === 'GET' && r.path === '/api/v1/workflows'));
    const again = await run(['--n8n-url', n8n.url, '--endpoint', ENDPOINT, '--project-id', 'Prj4RPA0001'], ENV);
    assert.equal(again.code, 0, again.out);
    assert.equal(n8n.state.requests.filter((r) => r.method === 'POST').length, posts.length, 'idempotent within the project');
    const help = await run(['--help'], {});
    assert.match(help.out, /--project-id/);
    // The usage shows exporting the secrets, never typing them inline in front of the command (shell history).
    assert.match(help.out, /read -rs N8N_API_KEY && export N8N_API_KEY/);
    assert.match(help.out, /export RPA_BROWSER_TOKEN=/);
    assert.doesNotMatch(help.out, /N8N_API_KEY=\.\.\. /);
  } finally {
    await n8n.close();
  }
});
