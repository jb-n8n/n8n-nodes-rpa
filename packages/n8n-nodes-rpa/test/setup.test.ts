// `npx n8n-nodes-rpa setup` (dist/setup.mjs, built by `pnpm test`) against a fake n8n public API: a first run, a second
// run, a missing node, a wrong key, an http address that is not this machine, a Connection Line that does not parse, and
// that no secret reaches the output on any path, also when n8n echoes a request.
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../dist/setup.mjs', import.meta.url));
const FAKE_TTY = fileURLToPath(new URL('./fixtures/fake-tty.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/5-import-a-bot.json', import.meta.url));
// n8n 2.x API keys are JWTs whose subject is the user (PublicApiKeyService). The fake's: the owner's, and a key of
// another form (an older n8n's), which does not say whose it is.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const PLAIN_KEY = 'n8n-api-key-0123456789-abcdefghij-KLMNOP';
const API_KEY = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u-owner', iss: 'n8n', aud: 'public-api' }), PLAIN_KEY].join('.');
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

interface Cred { id: string; name: string; type: string; data: Record<string, any>; projectId?: string }
interface Wf { id: string; name: string; active: boolean; versionId: string; nodes: any[]; connections: unknown; settings: unknown; projectId?: string; updatedAt?: string }
interface Options { teamName?: string; knowsNode?: boolean; echo?: 'credentials' | 'activate'; credentials?: Cred[]; workflows?: Wf[]; patch?: boolean; ownership?: boolean }

// The fake's projects, as n8n 2.45 describes them: two personal projects and a team project.
const PROJECTS: Record<string, { id: string; name: string; type: string; creatorId: string | null }> = {
  'P-owner': { id: 'P-owner', name: 'Owner <owner@example.com>', type: 'personal', creatorId: 'u-owner' },
  'P-other': { id: 'P-other', name: 'Other <other@example.com>', type: 'personal', creatorId: 'u-other' },
  'P-team': { id: 'P-team', name: 'Ops', type: 'team', creatorId: 'u-other' },
};
const HOME = 'P-owner'; // the owner's personal project: where a call without projectId puts things

/**
 * A fake n8n 2.45: the public API routes the command uses (two items a page, so lists page), the API key check, who owns
 * what (credential list items: shared[] { id, name, role }; workflow list items: shared[] { role, workflowId,
 * projectId }; GET /workflows/{id}: shared[].project { id, type, creatorId }; `ownership: false` leaves all of it out),
 * the form (401 without the login once its workflow is active), and a request log. `echo` makes a call fail with the
 * request body in its message, as a careless proxy or server might.
 */
async function fakeN8n(o: Options = {}) {
  const own = o.ownership !== false;
  const state = {
    credentials: (o.credentials ?? []).map((c) => ({ projectId: HOME, ...c })) as Cred[],
    workflows: (o.workflows ?? []).map((w) => ({ projectId: HOME, ...w })) as Wf[],
    requests: [] as { method: string; path: string; body: string }[],
  };
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      state.requests.push({ method: req.method ?? '', path: url.pathname, body });
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      const form = /^\/form\/(.+)$/.exec(url.pathname);
      if (form) {
        const live = state.workflows.some((w) => w.active && w.nodes.some((x) => x.webhookId === form[1]));
        return live ? send(401, { message: 'Authorization is required!' }) : send(404, { message: 'not registered' });
      }
      if (req.headers['x-n8n-api-key'] !== API_KEY && req.headers['x-n8n-api-key'] !== PLAIN_KEY) return send(401, { message: "'X-N8N-API-KEY' header required" });
      const page = (items: unknown[]) => {
        const offset = Number(url.searchParams.get('cursor') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 2);
        return { data: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
      };
      const credItem = ({ data: _d, projectId, ...c }: Cred) => ({
        ...c, ...(own ? { shared: [{ id: projectId, name: PROJECTS[projectId!]?.name, role: 'credential:owner' }] } : {}),
      });
      const project = (id: string) => (id === 'P-team' && o.teamName !== undefined ? { ...PROJECTS[id], name: o.teamName } : PROJECTS[id]);
      const wfItem = ({ projectId, ...w }: Wf, full = false) => ({
        ...w,
        ...(own ? { shared: [{ role: 'workflow:owner', workflowId: w.id, projectId, ...(full ? { project: project(projectId!) } : {}) }] } : {}),
      });
      const route = `${req.method} ${url.pathname}`;
      let m: RegExpExecArray | null;
      if ((m = /^GET \/api\/v1\/credentials\/schema\/(\w+)$/.exec(route))) {
        const fields = FIELDS[m[1]];
        if (!fields || (o.knowsNode === false && m[1] !== 'httpBasicAuth')) return send(404, { message: 'Not Found' });
        return send(200, { additionalProperties: false, type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])), required: [] });
      }
      if (route === 'GET /api/v1/credentials') return send(200, page(state.credentials.map(credItem)));
      if (route === 'POST /api/v1/credentials') {
        if (o.echo === 'credentials') return send(400, { message: `request.body.data is not valid: ${body}` });
        const c = JSON.parse(body);
        const created = { id: `c${++n}`, name: c.name, type: c.type, data: c.data, projectId: c.projectId ?? HOME };
        state.credentials.push(created);
        return send(200, { id: created.id, name: created.name, type: created.type });
      }
      if ((m = /^PATCH \/api\/v1\/credentials\/([\w-]+)$/.exec(route))) {
        if (o.patch === false) return send(405, { message: 'Method not allowed' });
        const c = state.credentials.find((x) => x.id === m![1]);
        if (!c) return send(404, { message: 'Not Found' });
        c.data = JSON.parse(body).data;
        return send(200, { id: c.id, name: c.name, type: c.type });
      }
      if (route === 'GET /api/v1/workflows') return send(200, page(state.workflows.map((w) => wfItem(w))));
      if (route === 'POST /api/v1/workflows') {
        const w = JSON.parse(body);
        const created: Wf = { id: `w${++n}`, active: false, versionId: `v-${n}`, ...w, projectId: w.projectId ?? HOME, updatedAt: new Date().toISOString() };
        state.workflows.push(created);
        return send(200, wfItem(created));
      }
      if ((m = /^(GET|PUT|DELETE) \/api\/v1\/workflows\/([\w-]+)$/.exec(route))) {
        const w = state.workflows.find((x) => x.id === m![2]);
        if (!w) return send(404, { message: 'Not Found' });
        if (m[1] === 'PUT') Object.assign(w, JSON.parse(body), { versionId: `v-${++n}` });
        if (m[1] === 'DELETE') state.workflows = state.workflows.filter((x) => x !== w);
        return send(200, wfItem(w, true));
      }
      if ((m = /^POST \/api\/v1\/workflows\/([\w-]+)\/(activate|archive)$/.exec(route))) {
        if (o.echo === 'activate' && m[2] === 'activate') return send(400, { message: `could not activate: ${JSON.stringify(state.workflows[0])}` });
        const w = state.workflows.find((x) => x.id === m![1]);
        if (!w) return send(404, { message: 'Not Found' });
        if (m[2] === 'activate') w.active = true;
        return send(200, wfItem(w));
      }
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

/** Runs the command as if at a terminal (test/fixtures/fake-tty.mjs), answering each prompt as it shows. */
function runAtTerminal(args: string[], env: Record<string, string>, answers: [RegExp, string][]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', FAKE_TTY, CLI, ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    const pending = [...answers];
    const onOutput = (chunk: Buffer) => {
      out += chunk.toString();
      if (pending.length && pending[0][0].test(out)) child.stdin.write(`${pending.shift()![1]}\n`);
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
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
    expect(stdout).toMatch(/kept in n8n only.*never shows it again. A lost key means approving every bot again.*--replace-signing-key before you approve a bot/);
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

  it('prints the signing key only with --show-signing-key, on the run that makes it', async () => {
    const fake = await n8n();
    const first = await run(setup(fake.url, '--show-signing-key'), ENV);
    expect(first.code, first.out).toBe(0);
    const key = fake.state.credentials[1].data.secretKey;
    expect(count(first.stdout, key)).toBe(1);
    expect(first.stdout).toMatch(/Signing key: +[0-9a-f]{64} +\(shown once/);
  });

  it('never rewrites an existing signing key on its own: not with --show-signing-key, not without the import workflow', async () => {
    const KEY = 'k'.repeat(40);
    const fake = await n8n({ credentials: [{ id: 'c7', name: 'RPA Step Signing', type: 'playwrightScriptSigningApi', data: { secretKey: KEY } }] });
    for (const extra of [[], ['--show-signing-key']]) {
      const r = await run(setup(fake.url, ...extra), ENV);
      expect(r.code, r.out).toBe(0);
      expect(fake.state.credentials.find((c) => c.id === 'c7')!.data.secretKey).toBe(KEY);
      expect(fake.state.requests.some((q) => q.method === 'PATCH')).toBe(false);
      expect(r.stdout).toMatch(/reused .*RPA Step Signing.*its key stays as it is/);
      if (extra.length) expect(r.stdout).toMatch(/does not give a stored key back, so it cannot be shown, and the key was not changed/);
      expect(r.stdout).toMatch(/--replace-signing-key/);
    }
    expect(fake.state.workflows).toHaveLength(1);
  });

  it('--replace-signing-key: refused without a terminal, stops without the typed word, replaces and shows the key once with it', async () => {
    const fake = await n8n();
    expect((await run(setup(fake.url), ENV)).code).toBe(0);
    const key = fake.state.credentials[1].data.secretKey;
    const patches = () => fake.state.requests.filter((r) => r.method === 'PATCH').length;

    const piped = await run(['setup', '--url', fake.url, '--replace-signing-key'], ENV);
    expect(piped.code).toBe(2);
    expect(piped.out).toMatch(/needs you at a terminal.*script_untrusted.*security\.md#if-the-signing-key-is-lost-or-changed.*Run it by hand/s);

    const no = await runAtTerminal(['setup', '--url', fake.url, '--replace-signing-key'], ENV, [[/Connect a Windows machine now/, 'n'], [/Type REPLACE/, 'yes']]);
    expect(no.code, no.out).toBe(1);
    expect(no.out).toMatch(/script_untrusted/);
    expect(no.out).toMatch(/Nothing was changed/);
    expect(patches()).toBe(0);
    expect(fake.state.credentials[1].data.secretKey).toBe(key);

    const yes = await runAtTerminal(['setup', '--url', fake.url, '--replace-signing-key'], ENV, [[/Connect a Windows machine now/, 'n'], [/Type REPLACE/, 'REPLACE']]);
    expect(yes.code, yes.out).toBe(0);
    const replaced = fake.state.credentials[1].data.secretKey;
    expect(replaced).toMatch(/^[0-9a-f]{64}$/);
    expect(replaced).not.toBe(key);
    expect(count(yes.out, replaced)).toBe(1);
    expect(patches()).toBe(1);
    expect(yes.out).not.toContain(key);
    expectNoSecrets(yes.out);
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
    const sent = echo.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/credentials').map((r) => JSON.parse(r.body).data.password as string);
    expect(sent).toHaveLength(1);
    expectNoSecrets(failed.out, sent);
    expect(echo.state.workflows, 'the workflow it started without credentials is removed again').toEqual([]);

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

  describe('ownership: only what this run\'s project owns is reused', () => {
    const SIGNING_ELSEWHERE: Cred = { id: 'c-planted', name: 'RPA Step Signing', type: 'playwrightScriptSigningApi', data: { secretKey: 'k'.repeat(64) }, projectId: 'P-other' };
    const FORM_ELSEWHERE: Cred = { id: 'c-form-other', name: 'RPA import form', type: 'httpBasicAuth', data: { user: 'rpa', password: 'p'.repeat(32) }, projectId: 'P-other' };
    const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8')) as { nodes: any[]; connections: unknown };
    const planted = (projectId: string, change?: (nodes: any[]) => void): Wf => {
      const t = template();
      change?.(t.nodes);
      return { id: `w-${projectId}`, name: 'RPA: 5 Import a bot', active: false, versionId: 'v-0', nodes: t.nodes, connections: t.connections, settings: { executionOrder: 'v1' }, projectId };
    };

    it('a same-name signing credential and form login in another project are left alone: its own are made, and the ids named', async () => {
      const fake = await n8n({ credentials: [SIGNING_ELSEWHERE, FORM_ELSEWHERE] });
      const { code } = await run(setup(fake.url, '--new-form-password', '--replace-signing-key'), ENV);
      // --replace-signing-key asks for the typed word whenever a key of that name exists: no terminal here, so it stops.
      expect(code).toBe(2);
      expect(fake.posts()).toEqual([]);
      const ok = await run(setup(fake.url, '--new-form-password'), ENV);
      expect(ok.code, ok.out).toBe(0);
      expect(fake.state.credentials.find((c) => c.id === 'c-planted')!.data.secretKey, 'never changed').toBe('k'.repeat(64));
      expect(fake.state.credentials.find((c) => c.id === 'c-form-other')!.data.password, 'never changed').toBe('p'.repeat(32));
      expect(fake.state.requests.some((r) => r.method === 'PATCH')).toBe(false);
      const mine = fake.state.credentials.filter((c) => c.projectId === HOME);
      expect(mine.map((c) => c.name).sort()).toEqual(['RPA Step Signing', 'RPA import form']);
      const [wf] = fake.state.workflows;
      expect(wf.nodes.find((x) => x.name === 'Sign steps').credentials.playwrightScriptSigningApi.id).not.toBe('c-planted');
      expect(ok.stdout).toMatch(/left alone credential "RPA Step Signing" \(playwrightScriptSigningApi, id c-planted\): it belongs to another project or user/);
      expect(ok.stdout).toMatch(/more than one credential named "RPA Step Signing": this run's is id c\d+\. Do not pick ids c-planted/);
      expect(ok.stdout).not.toContain('k'.repeat(64));
    });

    it('a same-name workflow in another project is left alone and never published: its own is made under a dated name', async () => {
      const fake = await n8n({ workflows: [planted('P-other')] });
      const { code, out } = await run(setup(fake.url), ENV);
      expect(code, out).toBe(0);
      const theirs = fake.state.workflows.find((w) => w.id === 'w-P-other')!;
      expect(theirs.active).toBe(false);
      expect(fake.state.requests.some((r) => r.path.startsWith('/api/v1/workflows/w-P-other') && r.method !== 'GET')).toBe(false);
      const mine = fake.state.workflows.find((w) => w.projectId === HOME)!;
      expect(mine.name).toMatch(/^RPA: 5 Import a bot \(\d{4}-\d{2}-\d{2}\)$/);
      expect(mine.active).toBe(true);
      expect(out).toMatch(/left alone workflow "RPA: 5 Import a bot" \(id w-P-other\): it belongs to another project or user/);
      // The second run finds its own (dated) workflow and creates nothing.
      const before = fake.posts().length;
      const again = await run(['setup', '--url', fake.url], ENV);
      expect(again.code, again.out).toBe(0);
      expect(fake.posts().length).toBe(before);
      expect(again.out).toMatch(/reused +workflow "RPA: 5 Import a bot \(\d{4}-\d{2}-\d{2}\)"/);
    });

    it('a workflow in its own project that differs from the template is not published; --new-workflow makes a fresh one', async () => {
      const fake = await n8n({ workflows: [planted(HOME, (nodes) => { nodes.find((x) => x.name === 'Sign steps').type = 'n8n-nodes-base.noOp'; })] });
      const first = await run(setup(fake.url), ENV);
      expect(first.code, first.out).toBe(1);
      expect(first.out).toMatch(/"RPA: 5 Import a bot" \(id w-P-owner\) in your project differs from the template: its node "Sign steps" is not a n8n-nodes-rpa\.playwright node\. It was not published.*--new-workflow/);
      expect(first.out).not.toMatch(/The import form is ready|\/form\//);
      expect(fake.posts()).toEqual([]);

      const fresh = await run(setup(fake.url, '--new-workflow'), ENV);
      expect(fresh.code, fresh.out).toBe(0);
      expect(fake.state.workflows.find((w) => w.id === 'w-P-owner')!.active).toBe(false);
      expect(fake.state.workflows.find((w) => w.id !== 'w-P-owner')!.name).toMatch(/\(\d{4}-\d{2}-\d{2}\)$/);

      // A node with a credential of another project also differs.
      const other = await n8n({ credentials: [SIGNING_ELSEWHERE], workflows: [planted(HOME, (nodes) => { nodes.find((x) => x.name === 'Sign steps').credentials = { playwrightScriptSigningApi: { id: 'c-planted', name: 'RPA Step Signing' } }; })] });
      const r = await run(setup(other.url), ENV);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/a credential on "Sign steps" \(id c-planted\) belongs to another project or user/);
      expect(other.state.workflows[0].active).toBe(false);
    });

    it('--project-id: works in that project, and leaves the same names in the personal project alone', async () => {
      const fake = await n8n({ credentials: [{ ...SIGNING_ELSEWHERE, id: 'c-personal', projectId: HOME }] });
      const { code, out } = await run(setup(fake.url, '--project-id', 'P-team'), ENV);
      expect(code, out).toBe(0);
      for (const r of fake.state.requests.filter((x) => x.method === 'POST' && /\/(credentials|workflows)$/.test(x.path))) expect(JSON.parse(r.body).projectId).toBe('P-team');
      expect(fake.state.workflows[0].projectId).toBe('P-team');
      expect(out).toMatch(/left alone credential "RPA Step Signing" \(playwrightScriptSigningApi, id c-personal\)/);
      const again = await run(['setup', '--url', fake.url, '--project-id', 'P-team', '--reuse-project-credentials'], ENV);
      expect(again.code, again.out).toBe(0);
      expect(again.out).not.toMatch(/^created/m);
      expect((await run(setup(fake.url, '--project-id', 'bad id!'), ENV)).code).toBe(2);
    });

    describe('a shared project: what is found there is used only when the person says so', () => {
      const TEAM_KEY: Cred = { id: 'c-team', name: 'RPA Step Signing', type: 'playwrightScriptSigningApi', data: { secretKey: 't'.repeat(64) }, projectId: 'P-team' };
      // A workflow of another name tells the fake's project type (team), as n8n tells it on GET /workflows/{id}.
      const OTHER_WORK: Wf = { id: 'w-team-other', name: 'Team work', active: false, versionId: 'v', nodes: [], connections: {}, settings: {}, projectId: 'P-team' };
      const signingOf = (fake: { state: { workflows: Wf[] } }) => fake.state.workflows.find((w) => WF.test(w.name))!.nodes.find((x) => x.name === 'Sign steps').credentials.playwrightScriptSigningApi.id;
      const WF = /^RPA: 5 Import a bot/;

      it('no terminal and no flag: not reused, a new one is made, both ids named, and the shared project is said', async () => {
        const fake = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK] });
        const { code, out } = await run(setup(fake.url, '--project-id', 'P-team'), ENV);
        expect(code, out).toBe(0);
        expect(out).toMatch(/The project "Ops" \(id P-team\) is shared: everyone in it can use the form's login and the signing key this command sets up there\. A personal project keeps them to one person\./);
        const made = fake.state.credentials.find((c) => c.name === 'RPA Step Signing' && c.id !== 'c-team')!;
        expect(made.projectId).toBe('P-team');
        expect(signingOf(fake)).toBe(made.id);
        expect(out).toMatch(/Found in the shared project "Ops" \(id P-team\):\n {2}credential "RPA Step Signing" \(id c-team\)\n/);
        expect(out).toMatch(/Not used: without a terminal they are used only with --reuse-project-credentials\./);
        expect(out).toMatch(/left alone in the shared project: credential id c-team\. This run makes its own set\./);
        expect(fake.state.credentials.find((c) => c.id === 'c-team')!.data.secretKey).toBe('t'.repeat(64));
      });

      it('--reuse-project-credentials: reused', async () => {
        const fake = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK] });
        const { code, out } = await run(setup(fake.url, '--project-id', 'P-team', '--reuse-project-credentials'), ENV);
        expect(code, out).toBe(0);
        expect(signingOf(fake)).toBe('c-team');
        expect(out).toMatch(/reused +credential "RPA Step Signing" \(id c-team\)/);
      });

      it('"y" typed at a terminal: reused; anything else: not', async () => {
        const yes = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK] });
        const r = await runAtTerminal(setup(yes.url, '--project-id', 'P-team'), ENV,
          [[/Connect a Windows machine now/, 'n'], [/Use these\? Anyone in that project could have made them\. \[y\/N\] /, 'y']]);
        expect(r.code, r.out).toBe(0);
        expect(signingOf(yes)).toBe('c-team');
        const no = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK] });
        const n = await runAtTerminal(setup(no.url, '--project-id', 'P-team'), ENV, [[/Connect a Windows machine now/, 'n'], [/Use these\?/, '']]);
        expect(n.code, n.out).toBe(0);
        expect(signingOf(no)).not.toBe('c-team');
      });

      it('the personal project: reused without a question', async () => {
        const fake = await n8n({ credentials: [{ ...TEAM_KEY, id: 'c-mine', projectId: HOME }], workflows: [{ ...OTHER_WORK, id: 'w-mine', projectId: HOME }] });
        const r = await runAtTerminal(setup(fake.url), ENV, [[/Connect a Windows machine now/, 'n']]);
        expect(r.code, r.out).toBe(0);
        expect(signingOf(fake)).toBe('c-mine');
        expect(r.out).not.toMatch(/shared|Use these\?/);
      });

      it('one answer for the set: "no" leaves the credential and the workflow alone, and makes a fresh set wired together', async () => {
        const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
        const FORM_TEAM: Cred = { id: 'c-tform', name: 'RPA import form', type: 'httpBasicAuth', data: { user: 'rpa', password: 'q'.repeat(32) }, projectId: 'P-team' };
        const nodes = t.nodes.map((x: any) => ({ ...x, ...(x.name === 'Sign steps' ? { credentials: { playwrightScriptSigningApi: { id: 'c-team', name: 'RPA Step Signing' } } } : {}),
          ...(x.name === 'Import a bot' ? { credentials: { httpBasicAuth: { id: 'c-tform', name: 'RPA import form' } }, webhookId: 'team-form' } : {}) }));
        const teamWf: Wf = { id: 'w-team', name: 'RPA: 5 Import a bot', active: true, versionId: 'v', nodes, connections: t.connections, settings: {}, projectId: 'P-team' };
        const fake = await n8n({ credentials: [TEAM_KEY, FORM_TEAM], workflows: [teamWf] });
        const r = await runAtTerminal(setup(fake.url, '--project-id', 'P-team', '--show-signing-key'), ENV, [[/Connect a Windows machine now/, 'n'], [/Use these\?/, 'n']]);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toMatch(/credential "RPA import form" \(id c-tform\)\n {2}credential "RPA Step Signing" \(id c-team\)\n {2}workflow "RPA: 5 Import a bot" \(id w-team\)\n/);
        expect(r.out.match(/Use these\?/g)).toHaveLength(1);
        expect(r.out).toMatch(/left alone in the shared project: credential id c-tform, credential id c-team, workflow id w-team\./);
        const mine = fake.state.workflows.find((w) => w.id !== 'w-team')!;
        const key = fake.state.credentials.find((c) => c.name === 'RPA Step Signing' && c.id !== 'c-team')!;
        expect(mine.nodes.find((x) => x.name === 'Sign steps').credentials.playwrightScriptSigningApi.id).toBe(key.id);
        expect(mine.nodes.find((x) => x.name === 'Import a bot').credentials.httpBasicAuth.id).not.toBe('c-tform');
        expect(r.out).not.toContain('team-form');
        expect(count(r.out, key.data.secretKey)).toBe(1);
      });

      it('"yes" to the set, but the workflow points at another signing credential: the workflow is not used, a fresh one is', async () => {
        const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
        const OTHER_KEY: Cred = { id: 'c-team2', name: 'Some other key', type: 'playwrightScriptSigningApi', data: { secretKey: 'u'.repeat(64) }, projectId: 'P-team' };
        const nodes = t.nodes.map((x: any) => (x.name === 'Sign steps' ? { ...x, credentials: { playwrightScriptSigningApi: { id: 'c-team2', name: 'Some other key' } } } : x));
        const teamWf: Wf = { id: 'w-team', name: 'RPA: 5 Import a bot', active: false, versionId: 'v', nodes, connections: t.connections, settings: {}, projectId: 'P-team' };
        const fake = await n8n({ credentials: [TEAM_KEY, OTHER_KEY], workflows: [teamWf] });
        const { code, out } = await run(setup(fake.url, '--project-id', 'P-team', '--reuse-project-credentials', '--show-signing-key'), ENV);
        expect(code, out).toBe(0);
        expect(out).toMatch(/not used workflow "RPA: 5 Import a bot" \(id w-team\): its node "(Import a bot|Sign steps)" does not use the (httpBasicAuth|playwrightScriptSigningApi) credential this run uses\. This run makes a fresh one\./);
        expect(fake.state.workflows.find((w) => w.id === 'w-team')!.active).toBe(false);
        expect(signingOf({ state: { workflows: fake.state.workflows.filter((w) => w.id !== 'w-team') } })).toBe('c-team');
        // The key was not made by this run: it is never shown.
        expect(out).not.toContain('t'.repeat(64));
        expect(out).not.toContain('u'.repeat(64));
      });

      it('the same in the personal project: a workflow that points at another signing credential is not relied on', async () => {
        const t = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
        const OTHER_KEY: Cred = { id: 'c-other-key', name: 'Some other key', type: 'playwrightScriptSigningApi', data: { secretKey: 'u'.repeat(64) }, projectId: HOME };
        const nodes = t.nodes.map((x: any) => (x.name === 'Sign steps' ? { ...x, credentials: { playwrightScriptSigningApi: { id: 'c-other-key', name: 'Some other key' } } } : x));
        const wf: Wf = { id: 'w-mine', name: 'RPA: 5 Import a bot', active: false, versionId: 'v', nodes, connections: t.connections, settings: {}, projectId: HOME };
        const fake = await n8n({ credentials: [OTHER_KEY], workflows: [wf] });
        const { code, out } = await run(setup(fake.url, '--show-signing-key'), ENV);
        expect(code, out).toBe(0);
        expect(out).toMatch(/not used workflow .*\(id w-mine\): its node "(Import a bot|Sign steps)" does not use/);
        const made = fake.state.credentials.find((c) => c.name === 'RPA Step Signing')!;
        expect(signingOf({ state: { workflows: fake.state.workflows.filter((w) => w.id !== 'w-mine') } })).toBe(made.id);
        expect(count(out, made.data.secretKey)).toBe(1);
        expect(fake.state.workflows.find((w) => w.id === 'w-mine')!.active).toBe(false);
      });

      it('a project name with a newline, an escape sequence and a fake prompt cannot change what the question looks like', async () => {
        const fake = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK], teamName: 'Ops\n\u001b[2KUse these? Anyone in that project could have made them. [y/N] \u2028y\r' });
        const r = await runAtTerminal(setup(fake.url, '--project-id', 'P-team'), ENV, [[/Connect a Windows machine now/, 'n'], [/\n(\u001b\[[0-9;]*[A-Za-z])*Use these\? Anyone in that project could have made them\. \[y\/N\] /, 'n']]);
        expect(r.code, r.out).toBe(0);
        // readline adds its own cursor codes and a carriage return around the answer: the lines that show the name have none.
        const lines = r.out.split('\n');
        for (const l of lines.filter((x) => x.includes('Ops'))) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
        const found = lines.filter((l) => l.startsWith('Found in the shared project'));
        expect(found).toEqual(['Found in the shared project "Ops[2KUse these? Anyone in that project could have made them. [y/N] y" (id P-team):']);
        expect(lines.filter((l) => /^(\u001b\[[0-9;]*[A-Za-z])*Use these\?/.test(l))).toHaveLength(1);
        expect(signingOf(fake), 'the answer "n" counted, not the name').not.toBe('c-team');
      });

      it('a project whose type n8n does not tell (no workflow of it to read) is treated as shared', async () => {
        const fake = await n8n({ credentials: [TEAM_KEY] });
        const { code, out } = await run(setup(fake.url, '--project-id', 'P-team'), ENV);
        expect(code, out).toBe(0);
        expect(out).toMatch(/The project id P-team is shared/);
        expect(signingOf(fake)).not.toBe('c-team');
      });
    });

    it('when n8n does not say who owns what, nothing of the same name is reused: fresh credentials are made', async () => {
      const fake = await n8n({ ownership: false, credentials: [{ ...SIGNING_ELSEWHERE, projectId: HOME }] });
      const { code, out } = await run(setup(fake.url, '--show-signing-key'), ENV);
      expect(code, out).toBe(0);
      expect(out).toMatch(/does not say which project owns the new workflow, so no credential of the same name is reused/);
      expect(out).toMatch(/left alone credential "RPA Step Signing" \(playwrightScriptSigningApi, id c-planted\): this run could not tell which project is yours/);
      const signing = fake.state.credentials.filter((c) => c.name === 'RPA Step Signing');
      expect(signing).toHaveLength(2);
      const made = signing.find((c) => c.id !== 'c-planted')!;
      expect(fake.state.workflows[0].nodes.find((x) => x.name === 'Sign steps').credentials.playwrightScriptSigningApi.id).toBe(made.id);
      expect(count(out, made.data.secretKey)).toBe(1);
      expect(out).not.toContain('k'.repeat(64));
    });

    it('a key that does not say whose it is: its own earlier workflow is not taken on trust, the credentials of its project are', async () => {
      const fake = await n8n();
      expect((await run(setup(fake.url), ENV)).code).toBe(0);
      const creds = fake.state.credentials.map((c) => c.id);
      const r = await run(setup(fake.url), { N8N_API_KEY: PLAIN_KEY });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/left alone workflow "RPA: 5 Import a bot" \(id w\d+\): the API key does not say whose it is/);
      // The new workflow tells the project, so the credentials made there before are reused, and nothing else.
      expect(fake.state.credentials.map((c) => c.id)).toEqual(creds);
      expect(fake.state.workflows).toHaveLength(2);
    });
  });

  it('prints its usage, and names the command', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    for (const flag of ['--url', '--approver', '--allow-http', '--show-signing-key', '--replace-signing-key', '--new-form-password', '--browser-url', 'N8N_API_KEY', 'RPA_CONNECTION_LINE']) expect(help.out).toContain(flag);
    expect((await run([])).code).toBe(2);
  });
});
