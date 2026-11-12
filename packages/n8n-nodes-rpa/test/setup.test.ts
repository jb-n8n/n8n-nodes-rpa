// `npx n8n-nodes-rpa setup` (dist/setup.mjs, built by `pnpm test`) against a fake n8n public API: a first run, a second
// run, a missing node, a wrong key, an http address that is not this machine, a Connection Line that does not parse, and
// that no secret reaches the output on any path, also when n8n echoes a request.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/setup.mjs', import.meta.url));
const API_KEY = 'n8n-api-key-0123456789-abcdefghij-KLMNOP';
const FINGERPRINT = 'AB'.repeat(32);
const RUNNER_TOKEN = 'runner-token-ZYXWVUTSRQPONMLKJIHGFEDCBA-98765';
const LINE = `rpa-runner://win-1.example.internal:8765/rpa/v1#token=${RUNNER_TOKEN}&fingerprint=${FINGERPRINT}`;
const BROWSER_TOKEN = 'browser-token-abcdefghijklmnopqrstuvwxyz-0123456789';
const FIELDS: Record<string, string[]> = {
  playwrightScriptSigningApi: ['notice', 'secretKey'],
  rpaDesktopRunnerApi: ['about', 'connectionLine', 'url', 'token', 'fingerprint'],
  playwrightBrowserApi: ['notice', 'mode', 'wsUrl', 'token', 'fingerprint', 'privateNetwork', 'headless', 'slowMo'],
  httpBasicAuth: ['user', 'password'],
};

interface Cred { id: string; name: string; type: string; data: Record<string, any> }
interface Wf { id: string; name: string; active: boolean; versionId: string; nodes: any[]; connections: unknown; settings: unknown }
interface Options { knowsNode?: boolean; echo?: 'credentials' | 'activate'; credentials?: Cred[]; executions?: number; patch?: boolean }

/**
 * A fake n8n: the public API routes the command uses (two items a page, so lists page), the API key check, the form
 * (401 without the login once its workflow is active), and a request log. `echo` makes a POST fail with the request
 * body in its message, as a careless proxy or server might.
 */
async function fakeN8n(o: Options = {}) {
  const state = { credentials: [...(o.credentials ?? [])] as Cred[], workflows: [] as Wf[], requests: [] as { method: string; path: string; body: string }[] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      state.requests.push({ method: req.method ?? '', path: url.pathname, body });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      const form = /^\/form\/(.+)$/.exec(url.pathname);
      if (form) {
        const live = state.workflows.some((w) => w.active && w.nodes.some((n) => n.webhookId === form[1]));
        return live ? send(401, { message: 'Authorization is required!' }) : send(404, { message: 'not registered' });
      }
      if (req.headers['x-n8n-api-key'] !== API_KEY) return send(401, { message: "'X-N8N-API-KEY' header required" });
      const page = (items: unknown[]) => {
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 2);
        return { data: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
      };
      const route = `${req.method} ${url.pathname}`;
      let m: RegExpExecArray | null;
      if ((m = /^GET \/api\/v1\/credentials\/schema\/(\w+)$/.exec(route))) {
        const fields = FIELDS[m[1]];
        if (!fields || (o.knowsNode === false && m[1] !== 'httpBasicAuth')) return send(404, { message: 'Not Found' });
        return send(200, { additionalProperties: false, type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])), required: [] });
      }
      if (route === 'GET /api/v1/credentials') return send(200, page(state.credentials.map(({ data: _d, ...c }) => c)));
      if (route === 'POST /api/v1/credentials') {
        if (o.echo === 'credentials') return send(400, { message: `request.body.data is not valid: ${body}` });
        const c = JSON.parse(body);
        const created = { id: `c${state.credentials.length + 1}`, name: c.name, type: c.type, data: c.data };
        state.credentials.push(created);
        return send(200, { id: created.id, name: created.name, type: created.type });
      }
      if ((m = /^PATCH \/api\/v1\/credentials\/(\w+)$/.exec(route))) {
        if (o.patch === false) return send(405, { message: 'Method not allowed' });
        const c = state.credentials.find((x) => x.id === m![1]);
        if (!c) return send(404, { message: 'Not Found' });
        c.data = JSON.parse(body).data;
        return send(200, { id: c.id, name: c.name, type: c.type });
      }
      if (route === 'GET /api/v1/workflows') return send(200, page(state.workflows.map(({ nodes: _n, ...w }) => w)));
      if (route === 'POST /api/v1/workflows') {
        const w = JSON.parse(body);
        const created: Wf = { id: `w${state.workflows.length + 1}`, active: false, versionId: `v-${state.workflows.length + 1}`, ...w };
        state.workflows.push(created);
        return send(200, created);
      }
      if ((m = /^GET \/api\/v1\/workflows\/(\w+)$/.exec(route))) {
        const w = state.workflows.find((x) => x.id === m![1]);
        return w ? send(200, w) : send(404, { message: 'Not Found' });
      }
      if ((m = /^POST \/api\/v1\/workflows\/(\w+)\/activate$/.exec(route))) {
        if (o.echo === 'activate') return send(400, { message: `could not activate: ${JSON.stringify(state.workflows[0])}` });
        const w = state.workflows.find((x) => x.id === m![1]);
        if (!w) return send(404, { message: 'Not Found' });
        w.active = true;
        return send(200, w);
      }
      if (route === 'GET /api/v1/executions') return send(200, { data: Array.from({ length: o.executions ?? 0 }, (_, i) => ({ id: String(i) })), nextCursor: null });
      return send(404, { message: `no route ${route}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const posts = () => state.requests.filter((r) => r.method !== 'GET');
  return { url, state, posts, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
});
async function n8n(o?: Options) {
  const s = await fakeN8n(o);
  open.push(s);
  return s;
}

/** Runs the command without a terminal (stdin closed): it never prompts. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`, stdout });
    });
    child.stdin?.end();
  });
}

const ENV = { N8N_API_KEY: API_KEY };
const setup = (url: string, ...more: string[]) => ['setup', '--url', url, '--approver', 'ops@example.com', ...more];
const count = (text: string, part: string) => text.split(part).length - 1;
/** No secret, in any form the redactor knows, in the output. */
function expectNoSecrets(out: string, extra: string[] = []) {
  for (const s of [API_KEY, LINE, RUNNER_TOKEN, BROWSER_TOKEN, ...extra]) {
    expect(out).not.toContain(s);
    expect(out).not.toContain(encodeURIComponent(s));
  }
}

describe('npx n8n-nodes-rpa setup', () => {
  it('first run: creates the form login, the signing key and the workflow with both set, publishes it, prints the password once', async () => {
    const fake = await n8n();
    const { code, out, stdout } = await run(setup(fake.url), ENV);
    expect(code, out).toBe(0);

    const [form, signing] = fake.state.credentials;
    expect(fake.state.credentials.map((c) => [c.name, c.type])).toEqual([['RPA import form', 'httpBasicAuth'], ['RPA Step Signing', 'playwrightScriptSigningApi']]);
    expect(form.data.user).toBe('rpa');
    expect(form.data.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(signing.data.secretKey).toMatch(/^[0-9a-f]{64}$/);

    const [wf] = fake.state.workflows;
    expect(wf.name).toBe('RPA: 5 Import a bot');
    expect(wf.active).toBe(true);
    expect(Object.keys(JSON.parse(fake.state.requests.find((r) => r.method === 'POST' && r.path === '/api/v1/workflows')!.body)).sort())
      .toEqual(['connections', 'name', 'nodes', 'settings']);
    const node = (name: string) => wf.nodes.find((n) => n.name === name);
    expect(node('Import a bot').credentials).toEqual({ httpBasicAuth: { id: form.id, name: 'RPA import form' } });
    expect(node('Sign steps').credentials).toEqual({ playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' } });
    expect(node('Sign steps').parameters.approverAllowlist).toBe('ops@example.com');
    expect(node('Import steps').credentials).toBeUndefined();
    for (const n of wf.nodes.filter((x) => /\.(formTrigger|form)$/.test(x.type))) expect(n.webhookId, n.name).toMatch(/^[0-9a-f-]{36}$/);

    expect(stdout).toContain(`${fake.url}/form/${node('Import a bot').webhookId}`);
    expect(stdout).toMatch(/User name: +rpa/);
    expect(count(out, form.data.password)).toBe(1);
    expect(stdout).toMatch(new RegExp(`Password: +${form.data.password} +\\(shown once: keep it in your password manager\\)`));
    expect(out).not.toContain(signing.data.secretKey);
    expect(stdout).toMatch(/kept in n8n only.*a lost key means approving every bot again.*--show-signing-key/);
    expect(stdout).toMatch(/1\. Record a bot.*\n.*2\. Open the form.*\n.*3\. Upload the file/);
    for (const name of ['RPA import form', 'RPA Step Signing', 'RPA: 5 Import a bot']) expect(stdout).toMatch(new RegExp(`created .*${name}`));
    expect(out).not.toMatch(/Note:|WARNING/);
    expectNoSecrets(out);
  });

  it('second run: creates nothing, says what it reused, cannot show the old password and offers --new-form-password', async () => {
    const fake = await n8n();
    expect((await run(setup(fake.url), ENV)).code).toBe(0);
    const before = fake.posts().length;
    const [form, signing] = fake.state.credentials;
    const oldPassword = form.data.password as string;

    const again = await run(['setup', '--url', fake.url], ENV); // no --approver: the workflow exists
    expect(again.code, again.out).toBe(0);
    expect(fake.posts().length, 'nothing created or changed').toBe(before);
    expect(fake.state.credentials).toHaveLength(2);
    expect(fake.state.workflows).toHaveLength(1);
    for (const name of ['RPA import form', 'RPA Step Signing', 'RPA: 5 Import a bot']) expect(again.stdout).toMatch(new RegExp(`reused .*${name}`));
    expect(again.stdout).toContain('/form/');
    expect(again.stdout).toMatch(/made earlier.*--new-form-password/);
    expectNoSecrets(again.out, [form.data.password, signing.data.secretKey]);

    const fresh = await run(['setup', '--url', fake.url, '--new-form-password'], ENV);
    expect(fresh.code, fresh.out).toBe(0);
    const patched = fake.state.credentials[0].data;
    expect(patched.user).toBe('rpa');
    expect(patched.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(patched.password).not.toBe(oldPassword);
    expect(count(fresh.out, patched.password)).toBe(1);
    expect(fake.state.credentials[1].data.secretKey, 'the signing key stays').toBe(signing.data.secretKey);
    expect(fake.state.workflows).toHaveLength(1);
  });

  it('prints the signing key only with --show-signing-key; on a key made earlier, makes a new one only while the form is unused', async () => {
    const fake = await n8n();
    const first = await run(setup(fake.url, '--show-signing-key'), ENV);
    expect(first.code, first.out).toBe(0);
    const key = fake.state.credentials[1].data.secretKey;
    expect(count(first.stdout, key)).toBe(1);

    const again = await run(['setup', '--url', fake.url, '--show-signing-key'], ENV);
    expect(again.code, again.out).toBe(0);
    const replaced = fake.state.credentials[1].data.secretKey;
    expect(replaced).not.toBe(key);
    expect(count(again.stdout, replaced)).toBe(1);

    const used = await n8n({ executions: 1 });
    expect((await run(setup(used.url), ENV)).code).toBe(0);
    const kept = used.state.credentials[1].data.secretKey;
    const refused = await run(['setup', '--url', used.url, '--show-signing-key'], ENV);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/used already.*Nothing was changed.*security\.md#if-the-signing-key-is-lost-or-changed/);
    expect(used.state.credentials[1].data.secretKey).toBe(kept);
    expect(refused.out).not.toMatch(/reused/);
    expectNoSecrets(refused.out, [kept]);
  });

  it('a missing node: says how to install it and stops before creating anything', async () => {
    const fake = await n8n({ knowsNode: false });
    const { code, out } = await run(setup(fake.url), ENV);
    expect(code).toBe(1);
    expect(out).toMatch(/RPA node is not installed.*n8n-nodes-rpa.*operator\.md#install-the-node.*restart n8n/);
    expect(fake.posts()).toEqual([]);
    expectNoSecrets(out);
  });

  it('a wrong key: says n8n refused it and where to make one, sends nothing else', async () => {
    const fake = await n8n();
    const { code, out } = await run(setup(fake.url), { N8N_API_KEY: 'wrong-key-0123456789-0123456789' });
    expect(code).toBe(1);
    expect(out).toMatch(/refused the API key.*Settings → n8n API/);
    expect(fake.state.requests).toHaveLength(1);
    expect(out).not.toContain('wrong-key-0123456789-0123456789');
  });

  it('no key, no terminal: says where to make one; a secret as a flag is refused without echoing it', async () => {
    const fake = await n8n();
    const none = await run(setup(fake.url));
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/N8N_API_KEY.*Settings → n8n API/);
    const flag = await run([...setup(fake.url), '--api-key', API_KEY], ENV);
    expect(flag.code).toBe(2);
    expect(flag.out).toMatch(/Unknown option --api-key.*never in flags/);
    expectNoSecrets(flag.out);
    expect(fake.state.requests).toEqual([]);
  });

  it('an http address that is not this machine: refused unless --allow-http, before anything is sent', async () => {
    const remote = await run(setup('http://n8n.example.invalid:5678'), ENV);
    expect(remote.code).toBe(2);
    expect(remote.out).toMatch(/http:\/\/ to another machine: the API key would cross the network unencrypted.*--allow-http/);
    expectNoSecrets(remote.out);
    // With --allow-http it goes on (and fails to reach this name, which never resolves), with a warning.
    const allowed = await run(setup('http://n8n.example.invalid:5678', '--allow-http'), ENV);
    expect(allowed.code).toBe(1);
    expect(allowed.out).toMatch(/WARNING: --allow-http/);
    expect(allowed.out).toMatch(/n8n does not answer at http:\/\/n8n\.example\.invalid:5678/);
    expectNoSecrets(allowed.out);
    const fake = await n8n();
    for (const url of [fake.url, fake.url.replace('127.0.0.1', 'localhost')]) {
      const local = await run(['setup', '--url', url, '--approver', 'ops@example.com'], ENV);
      expect(local.code, local.out).toBe(0);
      expect(local.out).not.toMatch(/unencrypted/);
    }
  });

  it('a Connection Line that does not parse: the node\'s own message, nothing sent, the line never printed', async () => {
    const fake = await n8n();
    const cases: [string, RegExp][] = [
      [LINE.replace(FINGERPRINT, 'zz'), /fingerprint .*not 64 hex digits/],
      [LINE.replace('rpa-runner://', 'rpa-browser://').replace('/rpa/v1#', '/#'), /browser's line/],
      ['token=abc', /must be the whole line that starts with rpa-runner:\/\//],
    ];
    for (const [line, message] of cases) {
      const { code, out } = await run(setup(fake.url), { ...ENV, RPA_CONNECTION_LINE: line });
      expect(code, out).toBe(2);
      expect(out).toMatch(message);
      expect(out).toMatch(/Nothing was sent to n8n/);
      expect(out).not.toContain(line);
      expectNoSecrets(out);
    }
    expect(fake.state.requests).toEqual([]);
  });

  it('a Connection Line that parses: the RPA Desktop Runner credential holds it, and the output never shows it', async () => {
    const fake = await n8n();
    const { code, out } = await run(setup(fake.url), { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(code, out).toBe(0);
    const runner = fake.state.credentials.find((c) => c.type === 'rpaDesktopRunnerApi');
    expect(runner).toMatchObject({ name: 'RPA Desktop Runner', data: { connectionLine: LINE } });
    expect(out).toMatch(/created .*RPA Desktop Runner/);
    expectNoSecrets(out);
    const again = await run(['setup', '--url', fake.url], { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/reused .*RPA Desktop Runner/);
    expect(fake.state.credentials.filter((c) => c.type === 'rpaDesktopRunnerApi')).toHaveLength(1);
  });

  it('--browser-url: the RPA Browser credential with the token from RPA_BROWSER_TOKEN, set on Import steps', async () => {
    const fake = await n8n();
    const { code, out } = await run(setup(fake.url, '--browser-url', 'ws://browser:3000/'), { ...ENV, RPA_BROWSER_TOKEN: BROWSER_TOKEN });
    expect(code, out).toBe(0);
    const browser = fake.state.credentials.find((c) => c.type === 'playwrightBrowserApi')!;
    expect(browser).toMatchObject({ name: 'RPA Browser', data: { mode: 'playwright', wsUrl: 'ws://browser:3000/', token: BROWSER_TOKEN, privateNetwork: true } });
    expect(fake.state.workflows[0].nodes.find((n) => n.name === 'Import steps').credentials).toEqual({ playwrightBrowserApi: { id: browser.id, name: 'RPA Browser' } });
    expectNoSecrets(out);
    const noToken = await run(setup(fake.url, '--browser-url', 'ws://browser:3000/'), ENV);
    expect(noToken.code).toBe(2);
    expect(noToken.out).toMatch(/RPA_BROWSER_TOKEN/);
  });

  it('redacts every secret when n8n echoes a request: a credential body, a workflow on a failed publish', async () => {
    const echo = await n8n({ echo: 'credentials' });
    const failed = await run(setup(echo.url), { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/Could not create the credential "RPA import form" \(HTTP 400: request\.body\.data is not valid: .*\*\*\*/);
    const sent = echo.state.requests.filter((r) => r.method === 'POST').map((r) => JSON.parse(r.body).data.password as string);
    expect(sent).toHaveLength(1);
    expectNoSecrets(failed.out, sent);

    const unpublished = await n8n({ echo: 'activate' });
    const notPublished = await run(setup(unpublished.url), ENV);
    expect(notPublished.code, 'exit 0 only when the form is published').toBe(1);
    expect(notPublished.out).toMatch(/not published/);
    const secrets = unpublished.state.credentials.map((c) => (c.data.password ?? c.data.secretKey) as string);
    expectNoSecrets(notPublished.out, secrets);
  });

  it('stops before creating anything: no approver without a terminal, a bad approver, a same-name credential of another type', async () => {
    const fake = await n8n();
    const noApprover = await run(['setup', '--url', fake.url], ENV);
    expect(noApprover.code).toBe(2);
    expect(noApprover.out).toMatch(/--approver/);
    const bad = await run(['setup', '--url', fake.url, '--approver', '{{ $json.email }}'], ENV);
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/one email address/);
    expect(fake.posts()).toEqual([]);

    const taken = await n8n({ credentials: [{ id: 'c9', name: 'RPA Step Signing', type: 'httpHeaderAuth', data: {} }] });
    const conflict = await run(setup(taken.url), ENV);
    expect(conflict.code).toBe(1);
    expect(conflict.out).toMatch(/"RPA Step Signing" \(id c9\) has the type httpHeaderAuth.*Rename it/);
    expect(taken.state.workflows).toEqual([]);
  });

  it('prints its usage, and names the command', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const flag of ['--url', '--approver', '--allow-http', '--show-signing-key', '--new-form-password', '--browser-url', 'N8N_API_KEY', 'RPA_CONNECTION_LINE']) expect(help.out).toContain(flag);
    expect((await run([])).code).toBe(2);
  });
});
