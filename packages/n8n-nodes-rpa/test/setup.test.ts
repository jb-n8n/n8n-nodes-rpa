// `npx n8n-nodes-rpa setup` (dist/setup.mjs, built by `pnpm test`) against a fake n8n public API: a first run, a second
// run, a missing node, a wrong key, an http address that is not this machine, a Connection Line that does not parse, and
// that no secret reaches the output on any path, also when n8n echoes a request.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerNoTcpAnswer } from '../../engine/src/messages.js';

const CLI = fileURLToPath(new URL('../dist/setup.mjs', import.meta.url));
const FAKE_TTY = fileURLToPath(new URL('./fixtures/fake-tty.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../templates/5-import-a-bot.json', import.meta.url));
// n8n 2.x API keys are JWTs whose subject is the user (PublicApiKeyService). The fake's: the owner's, and a key of
// another form (an older n8n's), which does not say whose it is.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const PLAIN_KEY = 'n8n-api-key-0123456789-abcdefghij-KLMNOP';
const API_KEY = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u-owner', iss: 'n8n', aud: 'public-api' }), PLAIN_KEY].join('.');
// A key made with an expiry carries it (exp, seconds): 2026-12-01 00:00 UTC.
const EXPIRING_KEY = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u-owner', iss: 'n8n', aud: 'public-api', exp: 1796083200 }), PLAIN_KEY].join('.');
const FINGERPRINT = 'AB'.repeat(32);
const RUNNER_TOKEN = 'runner-token-ZYXWVUTSRQPONMLKJIHGFEDCBA-98765';
const LINE = `rpa-runner://win-1.example.internal:8765/rpa/v1#token=${RUNNER_TOKEN}&fingerprint=${FINGERPRINT}`;
// The line of the same machine printed again, with the address n8n can reach (rpa connection -Address): made up.
const NEW_TOKEN = 'made-up-new-runner-token';
const NEW_LINE = `rpa-runner://rpa.example.com:8765/rpa/v1#token=${NEW_TOKEN}&fingerprint=${'CD'.repeat(32)}`;
const BROWSER_TOKEN = 'browser-token-abcdefghijklmnopqrstuvwxyz-0123456789';
// The node's own test messages for an RPA Desktop Runner (the engine's runnerConnected and runnerUnreachable).
const RUNNER_CONNECTED = 'Connected to the desktop runner (session not interactive)';
const RUNNER_UNREACHABLE = 'Could not connect to the desktop runner at wss://win-1.example.internal:8765/rpa/v1 (no answer within 60 s). Is it running, and is the port open?';
const FIELDS: Record<string, string[]> = {
  playwrightScriptSigningApi: ['notice', 'secretKey'],
  rpaDesktopRunnerApi: ['about', 'connectionLine', 'url', 'token', 'fingerprint'],
  playwrightBrowserApi: ['notice', 'mode', 'wsUrl', 'token', 'fingerprint', 'privateNetwork', 'headless', 'slowMo'],
  httpBasicAuth: ['user', 'password'],
};

interface Cred { id: string; name: string; type: string; data: Record<string, any>; projectId?: string }
interface Wf { id: string; name: string; active: boolean; versionId: string; nodes: any[]; connections: unknown; settings: unknown; projectId?: string; updatedAt?: string }
interface Options {
  teamName?: string; knowsNode?: boolean; echo?: 'credentials' | 'activate'; credentials?: Cred[]; workflows?: Wf[]; patch?: boolean; ownership?: boolean;
  /** GET /users/{id}: false answers 403 (a key whose owner may not read users). */
  users?: boolean;
  /** POST /credentials/{id}/test: the node's own message, a failed test, or 403 (a key without credential:read). */
  test?: 'ok' | 'error' | 'forbidden';
  /** What a failed test says (default RUNNER_UNREACHABLE). */
  testMessage?: string;
  /** With test 'error': the test passes once the credential's Connection Line holds this text (a corrected line). */
  testOkWhen?: string;
  /** Workflows the API key cannot see (not listed), whose forms still hold their paths. */
  hiddenForms?: Wf[];
}

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
        // n8n 2.45's Form Trigger answers at its Form Path (Options → Form Path) when it has one, else at its webhook id.
        const trigger = state.workflows.filter((w) => w.active).flatMap((w) => w.nodes).find((x) => /\.formTrigger$/.test(x.type) && (x.parameters?.options?.path || x.webhookId) === form[1]);
        if (!trigger) return send(404, { message: 'not registered' });
        // n8n's sign-in: the browser goes to n8n's authorize page, then its sign-in. Basic Auth: 401.
        if (trigger.parameters?.authentication === 'n8nUserAuth') {
          res.writeHead(302, { location: `http://127.0.0.1/mcp-oauth/authorize?response_type=code&client_id=c1&redirect_uri=${encodeURIComponent(url.href)}` });
          return res.end();
        }
        return send(401, { message: 'Authorization is required!' });
      }
      if (![API_KEY, PLAIN_KEY, EXPIRING_KEY].includes(String(req.headers['x-n8n-api-key']))) return send(401, { message: "'X-N8N-API-KEY' header required" });
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
      if ((m = /^GET \/api\/v1\/users\/([\w-]+)$/.exec(route))) {
        if (o.users === false) return send(403, { message: 'Forbidden' });
        return m[1] === 'u-owner' ? send(200, { id: 'u-owner', email: 'owner@example.com', firstName: 'O', lastName: 'Wner' }) : send(404, { message: 'Not Found' });
      }
      if (route === 'GET /api/v1/credentials') return send(200, page(state.credentials.map(credItem)));
      if (route === 'POST /api/v1/credentials') {
        if (o.echo === 'credentials') return send(400, { message: `request.body.data is not valid: ${body}` });
        const c = JSON.parse(body);
        const created = { id: `c${++n}`, name: c.name, type: c.type, data: c.data, projectId: c.projectId ?? HOME };
        state.credentials.push(created);
        return send(200, { id: created.id, name: created.name, type: created.type });
      }
      if ((m = /^POST \/api\/v1\/credentials\/([\w-]+)\/test$/.exec(route))) {
        if (o.test === 'forbidden') return send(403, { message: 'Forbidden' });
        const tested = state.credentials.find((x) => x.id === m![1]);
        if (!tested) return send(404, { message: 'Not Found' });
        const fixed = o.testOkWhen !== undefined && String(tested.data?.connectionLine ?? '').includes(o.testOkWhen);
        if (o.test === 'error' && !fixed) return send(200, { status: 'Error', message: o.testMessage ?? RUNNER_UNREACHABLE });
        return send(200, { status: 'OK', message: RUNNER_CONNECTED });
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
        // n8n refuses a form path an active workflow holds already, also one this key cannot see: n8n 2.45's public API
        // answers 409 with this message (seen on a real n8n in round 14's live proof).
        const pathOf = (x: Wf) => x.nodes.find((y) => /\.formTrigger$/.test(y.type))?.parameters?.options?.path;
        if (m[2] === 'activate' && pathOf(w) && [...state.workflows, ...(o.hiddenForms ?? [])].some((x) => x !== w && x.active && pathOf(x) === pathOf(w))) {
          return send(409, { message: 'There is a conflict with one of the webhooks.' });
        }
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
      if (pending.length && pending[0][0].test(out)) {
        child.stdin.write(`${pending.shift()![1]}\n`);
        // After the last answer the pipe is closed: a pipe read without echo (askHidden) keeps the process alive after it
        // pauses, which a terminal does not.
        if (!pending.length) child.stdin.end();
      }
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
/** The same with the form's Basic Auth login (--form-login basic): today's way, for approvers without an n8n account. */
const basicSetup = (url: string, ...more: string[]) => setup(url, '--form-login', 'basic', ...more);
type Fake = Awaited<ReturnType<typeof fakeN8n>>;
const credOf = (fake: Fake, type: string) => fake.state.credentials.find((c) => c.type === type)!;
const signingKeyOf = (fake: Fake) => credOf(fake, 'playwrightScriptSigningApi').data.secretKey as string;
const count = (text: string, part: string) => text.split(part).length - 1;
/** No secret, in any form the redactor knows, in the output. */
function expectNoSecrets(out: string, extra: string[] = []) {
  for (const s of [API_KEY, LINE, RUNNER_TOKEN, BROWSER_TOKEN, ...extra]) {
    expect(out).not.toContain(s);
    expect(out).not.toContain(encodeURIComponent(s));
  }
}

describe('npx n8n-nodes-rpa setup', () => {
  it("first run: the form opens with n8n's sign-in: no form login is made; the signing key and the workflow, published", async () => {
    const fake = await n8n();
    const { code, out, stdout } = await run(setup(fake.url), ENV);
    expect(code, out).toBe(0);
    expect(fake.state.credentials.map((c) => [c.name, c.type])).toEqual([['RPA Step Signing', 'playwrightScriptSigningApi']]);
    const [signing] = fake.state.credentials;
    const [wf] = fake.state.workflows;
    expect(wf.active).toBe(true);
    const node = (name: string) => wf.nodes.find((n) => n.name === name);
    // The template's form as it ships: n8n's sign-in, for people who may run the workflow; no credential.
    expect(node('Import a bot')).toMatchObject({ typeVersion: 2.6, parameters: { authentication: 'n8nUserAuth', requireExecuteAccess: true } });
    expect(node('Import a bot')).not.toHaveProperty('credentials');
    expect(node('Sign steps').credentials).toEqual({ playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' } });
    expect(node('Sign steps').parameters).toMatchObject({ approverAllowlist: 'ops@example.com', approvalFormPage: 'Review and approve' });
    expect(String(node('Sign steps').parameters.approverFrom)).toContain("'basicAuth' ? 'approvedBy' : 'formSignIn'");
    // A readable address (Options → Form Path), typed by hand on the Windows machine; the webhook id stays.
    expect(node('Import a bot').parameters.options).toEqual({ path: 'rpa-import' });
    expect(node('Import a bot').webhookId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stdout).toContain(`  Address:    ${fake.url}/form/rpa-import\n`);
    expect(stdout).toContain('  Sign-in:    the form opens with your n8n sign-in. Who approves is recorded as the n8n user who approved.');
    expect(stdout).not.toMatch(/User name:|Password:/);
    expect(stdout).toMatch(/1\. Record a bot.*\n.*2\. Open the form address in your browser and sign in to n8n\. The first time, n8n asks whether the form may use your n8n login: choose Allow access\.\n.*3\. Upload the file/);
    expect(stdout).toContain('Only the n8n users on "Sign steps" → Approver Allowlist may approve: add others there in n8n.');
    // n8n's own labels: Settings → n8n API → Create API key, and Revoke on the key's ⋯ menu.
    expect(stdout).not.toMatch(/Create an API key|Delete it/);
    // The form answered as a sign-in form (a redirect to n8n's authorize page): no note.
    expect(out).not.toMatch(/Note:|WARNING/);
    // The last line: what the API key can do, and what to do with it.
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('The API key you gave can do everything its owner can in n8n, within its scopes, and it never expires. Revoke it when the setup is done: in n8n, Settings → n8n API, the key\'s ⋯ menu → Revoke. Make the next one with an expiry.');
    expectNoSecrets(out, [signing.data.secretKey]);
  });

  it("the approver: the API key owner's address when n8n tells it, else --approver or the question; a key with an expiry says when", async () => {
    const fake = await n8n();
    const own = await run(['setup', '--url', fake.url], { N8N_API_KEY: EXPIRING_KEY });
    expect(own.code, own.out).toBe(0);
    expect(own.stdout).toContain("approver owner@example.com: the API key's owner (another with --approver)");
    expect(fake.state.workflows[0].nodes.find((n) => n.name === 'Sign steps').parameters.approverAllowlist).toBe('owner@example.com');
    expect(own.stdout.trimEnd().split('\n').at(-1)).toBe('The API key you gave can do everything its owner can in n8n, within its scopes, until 2026-12-01 00:00 UTC. Revoke it when the setup is done: in n8n, Settings → n8n API, the key\'s ⋯ menu → Revoke.');
    // A key whose owner n8n does not tell (no user id in it, or no right to read users): asked, or --approver.
    for (const [fakeOptions, key] of [[{}, PLAIN_KEY], [{ users: false }, API_KEY]] as const) {
      const other = await n8n(fakeOptions);
      const r = await run(['setup', '--url', other.url], { N8N_API_KEY: key });
      expect(r.code, r.out).toBe(2);
      expect(r.out).toMatch(/Give your email address with --approver/);
      expect(other.posts()).toEqual([]);
    }
    const plain = await n8n();
    const p = await run(setup(plain.url), { N8N_API_KEY: PLAIN_KEY });
    expect(p.code, p.out).toBe(0);
    expect(p.stdout.trimEnd().split('\n').at(-1)).toBe('The API key you gave can do everything its owner can in n8n, within its scopes. Revoke it when the setup is done: in n8n, Settings → n8n API, the key\'s ⋯ menu → Revoke. Make the next one with an expiry.');
    expectNoSecrets(own.out + p.out, [EXPIRING_KEY]);
  });

  it('--form-login: only n8n or basic; --new-form-password only with basic; nothing sent', async () => {
    const fake = await n8n();
    for (const [args, message] of [
      [['--form-login', 'none'], /--form-login must be n8n .* or basic/],
      [['--new-form-password'], /--new-form-password applies only with --form-login basic: with n8n's sign-in the form has no password\./],
      [['--form-login', 'n8n', '--new-form-password'], /--new-form-password applies only with --form-login basic/],
    ] as const) {
      const r = await run(setup(fake.url, ...args), ENV);
      expect(r.code, r.out).toBe(2);
      expect(r.out).toMatch(message);
    }
    expect(fake.state.requests).toEqual([]);
  });

  it("a workflow whose form signs in another way is not used: a fresh one is made, and the old one named", async () => {
    const fake = await n8n();
    expect((await run(basicSetup(fake.url), ENV)).code).toBe(0);
    const [old] = fake.state.workflows;
    const r = await run(setup(fake.url), ENV);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`not used workflow "RPA: 5 Import a bot" (id ${old.id}): its form uses Basic Auth, and this run sets up n8n's sign-in. This run makes a fresh one: unpublish the old one in n8n when you no longer use it.`);
    expect(fake.state.workflows).toHaveLength(2);
    const fresh = fake.state.workflows[1];
    expect(fresh.name).toMatch(/^RPA: 5 Import a bot \(\d{4}-\d{2}-\d{2}\)$/);
    expect(fresh.nodes.find((n) => n.name === 'Import a bot')).not.toHaveProperty('credentials');
    expect(old.nodes.find((n) => n.name === 'Import a bot').credentials.httpBasicAuth.id, 'the old one is left as it is').toBe(credOf(fake, 'httpBasicAuth').id);
    // And back: --form-login basic does not take the n8n sign-in one.
    const back = await run(basicSetup(fake.url), ENV);
    expect(back.code, back.out).toBe(0);
    expect(back.stdout).toMatch(/reused +workflow "RPA: 5 Import a bot" \(id /);
  });

  it('first run with --form-login basic: creates the form login, the signing key and the workflow with both set, publishes it, prints the password once', async () => {
    const fake = await n8n();
    const { code, out, stdout } = await run(basicSetup(fake.url), ENV);
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
    // Basic Auth on the form, so Sign steps takes Approved By (the allowlist's one address), as before.
    expect(node('Import a bot').parameters.authentication).toBe('basicAuth');
    expect(node('Import a bot').parameters).not.toHaveProperty('requireExecuteAccess');
    expect(node('Sign steps').credentials).toEqual({ playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' } });
    expect(node('Sign steps').parameters.approverAllowlist).toBe('ops@example.com');
    // Import steps carries the signing key only to pass it on to the workflow file the form hands over (it never reads it).
    expect(node('Import steps').credentials).toEqual({ playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' } });
    for (const n of wf.nodes.filter((x) => /\.(formTrigger|form)$/.test(x.type))) expect(n.webhookId, n.name).toMatch(/^[0-9a-f-]{36}$/);

    expect(stdout).toContain(`${fake.url}/form/rpa-import`);
    expect(stdout).toMatch(/User name: +rpa/);
    expect(count(out, form.data.password)).toBe(1);
    expect(stdout).toMatch(new RegExp(`Password: +${form.data.password} +\\(shown once: keep it in your password manager\\)`));
    expect(out).not.toContain(signing.data.secretKey);
    expect(stdout).toContain('  Signing key: made by this run and kept in n8n, which does not show it again. To have a copy, run this again now, before you approve a bot, with --replace-signing-key --show-signing-key.');
    expect(stdout).toMatch(/1\. Record a bot.*\n.*2\. Open the form.*\n.*3\. Upload the file/);
    for (const name of ['RPA import form', 'RPA Step Signing', 'RPA: 5 Import a bot']) expect(stdout).toMatch(new RegExp(`created .*${name}`));
    expect(out).not.toMatch(/Note:|WARNING/);
    expectNoSecrets(out);
  });

  it('second run with --form-login basic: creates nothing, says what it reused, cannot show the old password and offers --new-form-password', async () => {
    const fake = await n8n();
    expect((await run(basicSetup(fake.url), ENV)).code).toBe(0);
    const before = fake.posts().length;
    const [form, signing] = fake.state.credentials;
    const oldPassword = form.data.password as string;

    const again = await run(['setup', '--url', fake.url, '--form-login', 'basic'], ENV); // no --approver: the workflow exists
    expect(again.code, again.out).toBe(0);
    expect(fake.posts().length, 'nothing created or changed').toBe(before);
    expect(fake.state.credentials).toHaveLength(2);
    expect(fake.state.workflows).toHaveLength(1);
    for (const name of ['RPA import form', 'RPA Step Signing', 'RPA: 5 Import a bot']) expect(again.stdout).toMatch(new RegExp(`reused .*${name}`));
    expect(again.stdout).toContain('/form/');
    expect(again.stdout).toMatch(/made earlier.*--new-form-password/);
    expectNoSecrets(again.out, [form.data.password, signing.data.secretKey]);

    const fresh = await run(['setup', '--url', fake.url, '--form-login', 'basic', '--new-form-password'], ENV);
    expect(fresh.code, fresh.out).toBe(0);
    const patched = fake.state.credentials[0].data;
    expect(patched.user).toBe('rpa');
    expect(patched.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(patched.password).not.toBe(oldPassword);
    expect(count(fresh.out, patched.password)).toBe(1);
    expect(signingKeyOf(fake), 'the signing key stays').toBe(signing.data.secretKey);
    expect(fake.state.workflows).toHaveLength(1);
  });

  it('prints the signing key only with --show-signing-key, on the run that makes it', async () => {
    const fake = await n8n();
    const first = await run(setup(fake.url, '--show-signing-key'), ENV);
    expect(first.code, first.out).toBe(0);
    const key = signingKeyOf(fake);
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
      // Bots may be approved with it by now: no advice to replace it, only what a new key does.
      expect(r.stdout).toContain('  Signing key: made earlier and kept in n8n, which does not show it again. A new key (--replace-signing-key) stops every bot signed with this one until it is approved again.');
      expect(r.stdout).not.toMatch(/To keep a copy|before you approve a bot/);
    }
    expect(fake.state.workflows).toHaveLength(1);
  });

  it('--replace-signing-key: refused without a terminal, stops without the typed word, replaces and shows the key once with it', async () => {
    const fake = await n8n();
    expect((await run(setup(fake.url), ENV)).code).toBe(0);
    const key = signingKeyOf(fake);
    const patches = () => fake.state.requests.filter((r) => r.method === 'PATCH').length;

    const piped = await run(['setup', '--url', fake.url, '--replace-signing-key'], ENV);
    expect(piped.code).toBe(2);
    expect(piped.out).toMatch(/needs you at a terminal.*script_untrusted.*security\.md#if-the-signing-key-is-lost-or-changed.*Run it by hand/s);

    const no = await runAtTerminal(['setup', '--url', fake.url, '--replace-signing-key'], ENV, [[/Connect a Windows machine now/, 'n'], [/Type REPLACE/, 'yes']]);
    expect(no.code, no.out).toBe(1);
    expect(no.out).toMatch(/script_untrusted/);
    expect(no.out).toMatch(/Nothing was changed/);
    expect(patches()).toBe(0);
    expect(signingKeyOf(fake)).toBe(key);

    const yes = await runAtTerminal(['setup', '--url', fake.url, '--replace-signing-key'], ENV, [[/Connect a Windows machine now/, 'n'], [/Type REPLACE/, 'REPLACE']]);
    expect(yes.code, yes.out).toBe(0);
    const replaced = signingKeyOf(fake);
    expect(replaced).toMatch(/^[0-9a-f]{64}$/);
    expect(replaced).not.toBe(key);
    expect(count(yes.out, replaced)).toBe(1);
    expect(patches()).toBe(1);
    expect(yes.out).not.toContain(key);
    expectNoSecrets(yes.out);

    // What the first run's note says to do for a copy: the new key once, the old one never.
    const both = await runAtTerminal(['setup', '--url', fake.url, '--replace-signing-key', '--show-signing-key'], ENV, [[/Connect a Windows machine now/, 'n'], [/Type REPLACE/, 'REPLACE']]);
    expect(both.code, both.out).toBe(0);
    const third = signingKeyOf(fake);
    expect(third).not.toBe(replaced);
    expect(count(both.out, third)).toBe(1);
    expect(both.out).toMatch(/Signing key: +[0-9a-f]{64} +\(shown once/);
    expect(both.out).not.toContain(replaced);
    // A run that does not make a key shows none, with or without --show-signing-key.
    for (const extra of [[], ['--show-signing-key']]) {
      const plain = await run(['setup', '--url', fake.url, ...extra], ENV);
      expect(plain.code, plain.out).toBe(0);
      expect(plain.out).not.toContain(third);
      expect(plain.out).not.toMatch(/Signing key: +[0-9a-f]{64}/);
    }
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
    expect(out).toMatch(/refused the API key.*Make an API key in n8n: Settings → n8n API → Create API key \(as the owner or an admin\), with Scopes All and the shortest expiry, and revoke it when the setup is done\./);
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
    expect(flag.out).toMatch(/--api-key takes no value: the key goes in N8N_API_KEY or the prompt, never in flags/);
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

  it("the form's address: n8n's own from its environment where the command runs with n8n, else as reached, with one line more", async () => {
    const formOf = (fake: Fake) => fake.state.workflows.at(-1)!.nodes.find((n) => n.name === 'Import a bot').parameters.options.path as string;
    const probes = (fake: Fake) => fake.state.requests.filter((r) => r.path.startsWith('/form/')).length;
    // Inside n8n's container: WEBHOOK_URL is n8n's address for its forms. The form is still checked where n8n was reached.
    const inside = await n8n();
    const r = await run(setup(inside.url), { ...ENV, WEBHOOK_URL: 'https://n8n.example.com/', N8N_EDITOR_BASE_URL: 'https://editor.example.com/' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain(`  Address:    https://n8n.example.com/form/${formOf(inside)}\n`);
    expect(r.stdout).not.toContain(`${inside.url}/form/`);
    expect(r.stdout).not.toContain('Replace the host and port');
    expect(probes(inside)).toBeGreaterThan(0);
    // Two addresses, each said once with what it is for: the one the command talks to, and the one to open.
    expect(r.stdout.split('\n')[0]).toBe('This run uses an n8n API key: N8N_API_KEY is set.');
    expect(r.stdout.split('\n')[1]).toBe(`Setting up n8n for RPA. This command talks to n8n at ${inside.url}; in your browser, n8n is at https://n8n.example.com/.`);
    expect(r.stdout.split(inside.url)).toHaveLength(2);
    // The same address twice is one address.
    const same = await n8n();
    const s = await run(setup(same.url), { ...ENV, WEBHOOK_URL: `${same.url}/` });
    expect(s.stdout.split('\n')[1]).toBe(`Setting up ${same.url} for RPA`);
    // N8N_EDITOR_BASE_URL when WEBHOOK_URL is not set; an n8n under a path keeps it.
    const editor = await n8n();
    const e = await run(setup(editor.url), { ...ENV, N8N_EDITOR_BASE_URL: 'https://example.com/n8n' });
    expect(e.stdout).toContain(`  Address:    https://example.com/n8n/form/${formOf(editor)}\n`);
    // Nothing usable from the environment: the address as reached, and one line to say what to change.
    for (const env of [{}, { WEBHOOK_URL: 'https://user:made-up@n8n.example.com/' }, { WEBHOOK_URL: 'ftp://n8n.example.com/' }, { WEBHOOK_URL: 'not an address' }] as Record<string, string>[]) {
      const fake = await n8n();
      const o = await run(setup(fake.url), { ...ENV, ...env });
      expect(o.code, o.out).toBe(0);
      expect(o.stdout).toContain(`  Address:    ${fake.url}/form/${formOf(fake)}\n              Replace the host and port with the ones you open n8n with, if they differ.\n`);
      expect(o.stdout).not.toContain('n8n.example.com');
    }
  });

  it('the readable address /form/rpa-import only when no other form uses it; otherwise the address with an id, and why', async () => {
    const pathOf = (w: Wf) => w.nodes.find((n) => n.name === 'Import a bot').parameters.options?.path;
    const idOf = (w: Wf) => w.nodes.find((n) => n.name === 'Import a bot').webhookId as string;
    const other: Wf = {
      id: 'w-other', name: 'Contact form', active: false, versionId: 'v0', connections: {}, settings: {},
      nodes: [{ name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.6, webhookId: 'aaaa', parameters: { options: { path: 'RPA-Import' } } }],
    };
    // A form of another workflow at that path, published or not (publishing it would take the address).
    const taken = await n8n({ workflows: [other] });
    const t = await run(setup(taken.url), ENV);
    expect(t.code, t.out).toBe(0);
    const made = taken.state.workflows.find((w) => w.name === 'RPA: 5 Import a bot')!;
    expect(pathOf(made)).toBeUndefined();
    expect(t.stdout).toContain('         its form keeps an address with an id, not /form/rpa-import: the workflow "Contact form" (id w-other) has a form at /form/rpa-import.\n');
    expect(t.stdout).toContain(`  Address:    ${taken.url}/form/${idOf(made)}\n`);
    // A run that makes a second form (--new-workflow) leaves the first one its address.
    const twice = await n8n();
    expect((await run(setup(twice.url), ENV)).code).toBe(0);
    twice.state.workflows[0].nodes.find((n) => n.name === 'Sign steps').type = 'n8n-nodes-base.noOp';
    const second = await run(setup(twice.url, '--new-workflow'), ENV);
    expect(second.code, second.out).toBe(0);
    expect(twice.state.workflows.map(pathOf)).toEqual(['rpa-import', undefined]);
    expect(second.stdout).toContain(`  Address:    ${twice.url}/form/${idOf(twice.state.workflows[1])}\n`);
    // Held by a workflow this API key cannot see: n8n refuses to publish; the form keeps its id, is published, and says why.
    const hidden = await n8n({ hiddenForms: [{ ...other, id: 'w-hidden', active: true, nodes: [{ ...other.nodes[0], parameters: { options: { path: 'rpa-import' } } }] }] });
    const h = await run(setup(hidden.url), ENV);
    expect(h.code, h.out).toBe(0);
    const [w] = hidden.state.workflows;
    expect(w.active).toBe(true);
    expect(pathOf(w)).toBeUndefined();
    expect(h.stdout).toContain('         its form keeps an address with an id, not /form/rpa-import: n8n says that address is taken (HTTP 409: There is a conflict with one of the webhooks.).\n');
    expect(h.stdout).toContain(`  Address:    ${hidden.url}/form/${idOf(w)}\n`);
    // One refusal, one more try.
    expect(hidden.state.requests.filter((r) => r.path.endsWith('/activate'))).toHaveLength(2);
  });

  it('a Connection Line that parses: the RPA Desktop Runner credential holds it, and the output never shows it', async () => {
    const fake = await n8n();
    const { code, out } = await run(setup(fake.url), { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(code, out).toBe(0);
    const runner = fake.state.credentials.find((c) => c.type === 'rpaDesktopRunnerApi');
    expect(runner).toMatchObject({ name: 'RPA Desktop Runner', data: { connectionLine: LINE } });
    expect(out).toMatch(/created .*RPA Desktop Runner/);
    // Import steps passes the runner and the signing key on to the workflow file, by id and name: nothing to pick there.
    const signing = fake.state.credentials.find((c) => c.type === 'playwrightScriptSigningApi')!;
    expect(fake.state.workflows[0].nodes.find((n) => n.name === 'Import steps').credentials).toEqual({
      playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' }, rpaDesktopRunnerApi: { id: runner!.id, name: 'RPA Desktop Runner' },
    });
    // n8n tests it with the node's own test, once, after the form is published; the line shows the node's message.
    expect(fake.state.requests.filter((r) => r.path === `/api/v1/credentials/${runner!.id}/test`).map((r) => r.method)).toEqual(['POST']);
    expect(out).toContain(`tested   credential "RPA Desktop Runner" (id ${runner!.id}): ${RUNNER_CONNECTED}`);
    expect(out.indexOf('published workflow')).toBeLessThan(out.indexOf('testing  credential'));
    expect(out).toContain(`The workflow the form gives you already uses the RPA Desktop Runner "RPA Desktop Runner" (id ${runner!.id}).`);
    expectNoSecrets(out);
    const again = await run(['setup', '--url', fake.url], { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/reused .*RPA Desktop Runner/);
    expect(fake.state.credentials.filter((c) => c.type === 'rpaDesktopRunnerApi')).toHaveLength(1);
  });

  describe('a Connection Line for an RPA Desktop Runner the project has: asked before it is replaced', () => {
    const HAND: Cred = { id: 'c-hand', name: 'RPA Desktop Runner account', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE } };
    const MADE: Cred = { id: 'c-made', name: 'RPA Desktop Runner', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE } };
    const ELSEWHERE: Cred = { id: 'c-else', name: 'RPA Desktop Runner account', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE }, projectId: 'P-other' };
    const QUESTION = /Replace the Connection Line of "RPA Desktop Runner account" with the line for rpa\.example\.com:8765\? \(y\/N\)/;
    const lineOf = (fake: Fake, id: string) => fake.state.credentials.find((c) => c.id === id)!.data.connectionLine;
    const tests = (fake: Fake, id: string) => fake.state.requests.filter((r) => r.path === `/api/v1/credentials/${id}/test`).length;

    it('--desktop-runner and a line, at a terminal: yes replaces the line, names only its address and port, and n8n tests it', async () => {
      const fake = await n8n({ credentials: [HAND, ELSEWHERE] });
      const r = await runAtTerminal(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), { ...ENV, RPA_CONNECTION_LINE: NEW_LINE }, [[QUESTION, 'y']]);
      expect(r.code, r.out).toBe(0);
      expect(lineOf(fake, 'c-hand')).toBe(NEW_LINE);
      expect(lineOf(fake, 'c-else'), 'another project\'s is never touched').toBe(LINE);
      expect(fake.state.credentials.filter((c) => c.type === 'rpaDesktopRunnerApi')).toHaveLength(2);
      expect(r.out).toContain('replaced Connection Line of credential "RPA Desktop Runner account" (id c-hand): it now names rpa.example.com:8765');
      expect(r.out).toContain(`tested   credential "RPA Desktop Runner account" (id c-hand): ${RUNNER_CONNECTED}`);
      expect(r.out.indexOf('replaced Connection Line')).toBeLessThan(r.out.indexOf('testing  credential'));
      expect(tests(fake, 'c-hand')).toBe(1);
      expect(fake.state.workflows[0].nodes.find((n) => n.name === 'Import steps').credentials.rpaDesktopRunnerApi).toEqual({ id: 'c-hand', name: 'RPA Desktop Runner account' });
      expect(fake.state.requests.filter((x) => x.path.startsWith('/api/v1/credentials/c-else'))).toEqual([]);
      expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN, 'CD'.repeat(32)]);
    });

    it('at a terminal, no (or just Enter) keeps the old line, and n8n still tests the credential', async () => {
      for (const answer of ['n', '']) {
        const fake = await n8n({ credentials: [HAND] });
        const r = await runAtTerminal(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), { ...ENV, RPA_CONNECTION_LINE: NEW_LINE }, [[QUESTION, answer]]);
        expect(r.code, r.out).toBe(0);
        expect(lineOf(fake, 'c-hand')).toBe(LINE);
        expect(fake.state.requests.filter((x) => x.method === 'PATCH')).toEqual([]);
        expect(r.out).toContain('         its Connection Line stays as it is.');
        expect(tests(fake, 'c-hand')).toBe(1);
        expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN]);
      }
    });

    it('without a terminal it keeps the old line and says how to replace it', async () => {
      const fake = await n8n({ credentials: [HAND] });
      const r = await run(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), { ...ENV, RPA_CONNECTION_LINE: NEW_LINE });
      expect(r.code, r.out).toBe(0);
      expect(lineOf(fake, 'c-hand')).toBe(LINE);
      expect(fake.state.requests.filter((x) => x.method === 'PATCH')).toEqual([]);
      expect(r.out).not.toMatch(/Replace the Connection Line/);
      expect(r.out).toContain('reused   credential "RPA Desktop Runner account" (id c-hand)');
      expect(r.out).toContain("         its Connection Line stays as it is: this run replaces one only when you say so at a terminal. To use the line for rpa.example.com:8765, run this again in a terminal, or paste the line into the credential's Connection Line in n8n.");
      expect(tests(fake, 'c-hand')).toBe(1);
      expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN]);
    });

    it('without --desktop-runner the line is for the "RPA Desktop Runner" an earlier line made: the same question', async () => {
      const fake = await n8n({ credentials: [MADE] });
      const r = await runAtTerminal(setup(fake.url), { ...ENV, RPA_CONNECTION_LINE: NEW_LINE }, [[/Replace the Connection Line of "RPA Desktop Runner" with the line for rpa\.example\.com:8765\? \(y\/N\)/, 'yes']]);
      expect(r.code, r.out).toBe(0);
      expect(lineOf(fake, 'c-made')).toBe(NEW_LINE);
      expect(fake.state.credentials.filter((c) => c.type === 'rpaDesktopRunnerApi')).toHaveLength(1);
      expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN]);
    });

    it('--desktop-runner naming one only another project has stops before anything is made, and a line does not change that', async () => {
      const fake = await n8n({ credentials: [ELSEWHERE] });
      const r = await run(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), { ...ENV, RPA_CONNECTION_LINE: NEW_LINE });
      expect(r.code).toBe(2);
      expect(r.out).toContain('No RPA Desktop Runner named "RPA Desktop Runner account" in your project.');
      expect(lineOf(fake, 'c-else')).toBe(LINE);
      expect(fake.state.requests.filter((x) => x.method === 'PATCH')).toEqual([]);
      expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN]);
    });
  });

  describe('no Connection Line: the RPA Desktop Runner the project has', () => {
    const HAND: Cred = { id: 'c-hand', name: 'RPA Desktop Runner account', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE } };
    const SECOND: Cred = { id: 'c-second', name: 'Night shift', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE } };
    const ELSEWHERE: Cred = { id: 'c-else', name: 'RPA Desktop Runner', type: 'rpaDesktopRunnerApi', data: { connectionLine: LINE }, projectId: 'P-other' };
    const NAMED = ['--desktop-runner', 'RPA Desktop Runner account'];
    const onImport = (fake: Fake) => fake.state.workflows.find((w) => w.projectId === HOME)!.nodes.find((n) => n.name === 'Import steps').credentials;
    /** Only listed: never read one by one, never changed. */
    const neverRead = (fake: Fake) => {
      expect(fake.state.requests.filter((r) => /^\/api\/v1\/credentials\/c-/.test(r.path) && !r.path.endsWith('/test'))).toEqual([]);
    };

    it('exactly one, whatever its name: picked on Import steps by id and name, said; tested only when named (IB-9)', async () => {
      // Another user's runner is not this project's: it does not count, and it is never picked.
      const fake = await n8n({ credentials: [HAND, ELSEWHERE] });
      const { code, out, stdout } = await run(setup(fake.url), ENV);
      expect(code, out).toBe(0);
      expect(onImport(fake).rpaDesktopRunnerApi).toEqual({ id: 'c-hand', name: 'RPA Desktop Runner account' });
      expect(out).toContain('picked   credential "RPA Desktop Runner account" (id c-hand): the only RPA Desktop Runner in your project. Not tested: this run tests a Windows machine only when you give its Connection Line or name it with --desktop-runner');
      expect(out).toContain('The workflow the form gives you already uses the RPA Desktop Runner "RPA Desktop Runner account" (id c-hand).');
      // No line and no --desktop-runner: no test, and the closing lines say nothing about a Windows machine.
      expect(fake.state.requests.some((r) => r.path.endsWith('/test'))).toBe(false);
      expect(out).not.toMatch(/Windows machine is|not connected/);
      expect(stdout.trimEnd().split('\n').at(-1)).toMatch(/^The API key you gave/);
      // Named: tested, and the last line says that it is connected.
      const named = await run(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), ENV);
      expect(named.out).toContain(`tested   credential "RPA Desktop Runner account" (id c-hand): ${RUNNER_CONNECTED}`);
      expect(named.stdout.trimEnd().split('\n').at(-1)).toBe(`The import form is ready, and the Windows machine is connected. n8n's test said: ${RUNNER_CONNECTED}.`);
      expect(out).not.toContain('c-else');
      expect(fake.state.credentials.filter((c) => c.type === 'rpaDesktopRunnerApi')).toHaveLength(2);
      neverRead(fake);
      expectNoSecrets(out);
    });

    it('none: nothing picked, no test, and it says how to give the line', async () => {
      const fake = await n8n({ credentials: [ELSEWHERE] });
      const { code, out } = await run(setup(fake.url), ENV);
      expect(code, out).toBe(0);
      expect(onImport(fake).rpaDesktopRunnerApi).toBeUndefined();
      expect(fake.state.requests.some((r) => r.path.endsWith('/test'))).toBe(false);
      expect(out).toContain("No RPA Desktop Runner is set, so a desktop bot's workflow asks for one. To connect a Windows machine, run this again and paste its Connection Line when it asks.");
      // A browser user is not told: a browser bot's workflow has no runner slot.
      const browser = await n8n();
      const b = await run(setup(browser.url, '--browser-url', 'ws://browser:3000/'), { ...ENV, RPA_BROWSER_TOKEN: BROWSER_TOKEN });
      expect(b.code, b.out).toBe(0);
      expect(b.out).not.toMatch(/RPA Desktop Runner/);
    });

    it('several: none without --desktop-runner, each listed; the one it names with it; a name it does not have stops before anything is made', async () => {
      const fake = await n8n({ credentials: [HAND, SECOND] });
      const none = await run(setup(fake.url), ENV);
      expect(none.code, none.out).toBe(0);
      expect(onImport(fake).rpaDesktopRunnerApi).toBeUndefined();
      expect(none.out).toContain('not picked: your project has 2 RPA Desktop Runners, "RPA Desktop Runner account" (id c-hand), "Night shift" (id c-second), and this run picks one only by --desktop-runner <name>. Pick one on "Import steps" in n8n, so the workflow the form hands over uses it.');
      expect(fake.state.requests.some((r) => r.path.endsWith('/test'))).toBe(false);

      const named = await n8n({ credentials: [HAND, SECOND] });
      const r = await run(setup(named.url, '--desktop-runner', 'Night shift'), ENV);
      expect(r.code, r.out).toBe(0);
      expect(onImport(named).rpaDesktopRunnerApi).toEqual({ id: 'c-second', name: 'Night shift' });
      expect(r.out).toContain('picked   credential "Night shift" (id c-second): the RPA Desktop Runner --desktop-runner names');
      expect(r.out).toContain(`tested   credential "Night shift" (id c-second): ${RUNNER_CONNECTED}`);
      neverRead(named);

      const wrong = await n8n({ credentials: [HAND, SECOND, ELSEWHERE] });
      const w = await run(setup(wrong.url, '--desktop-runner', 'RPA Desktop Runner'), ENV);
      expect(w.code).toBe(2);
      expect(w.out).toContain('No RPA Desktop Runner named "RPA Desktop Runner" in your project. Your project\'s RPA Desktop Runners: "RPA Desktop Runner account" (id c-hand), "Night shift" (id c-second).');
      // The workflow made to learn the project is removed again; no credential is made.
      expect(wrong.state.workflows).toEqual([]);
      expect(wrong.state.credentials.map((c) => c.id)).toEqual(['c-hand', 'c-second', 'c-else']);
    });

    it('--desktop-runner: a name that is not one is refused before anything is sent', async () => {
      const fake = await n8n({ credentials: [HAND] });
      for (const name of ['', 'RPA Step Signing', 'two\nlines']) expect((await run(setup(fake.url, '--desktop-runner', name), ENV)).code, name).toBe(2);
      expect(fake.state.requests).toEqual([]);
      // At a terminal it does not ask for a line: the flag picks one.
      const t = await runAtTerminal(setup(fake.url, '--desktop-runner', 'RPA Desktop Runner account'), ENV, []);
      expect(t.code, t.out).toBe(0);
      expect(t.out).not.toMatch(/Connect a Windows machine now/);
      expect((await run(['--help'])).out).toContain('--desktop-runner <name>');
    });

    it('the test: a failed one is said with the node\'s message, without the token, and the run still ends well; a key that may not test says how', async () => {
      const failing = await n8n({ credentials: [HAND], test: 'error' });
      const f = await run(setup(failing.url, ...NAMED), ENV);
      expect(f.code, f.out).toBe(0);
      expect(f.out).toContain(`tested   credential "RPA Desktop Runner account" (id c-hand), and it failed: ${RUNNER_UNREACHABLE}`);
      // The closing lines do not read as if all went well: the form is ready, the machine is not connected, why, and
      // what to do (the message's own instruction), after the API key's line.
      expect(f.stdout.trimEnd().split('\n').slice(-5)).toEqual([
        '',
        'The import form is ready, but the Windows machine is not connected yet.',
        '  Reason:     Could not connect to the desktop runner at wss://win-1.example.internal:8765/rpa/v1 (no answer within 60 s).',
        '  What to do: Is it running, and is the port open?',
        '              Then run this command again, with the new line if you printed one.',
      ]);
      expect(f.stdout.indexOf('The API key you gave')).toBeLessThan(f.stdout.indexOf('not connected yet'));
      expectNoSecrets(f.out);
      // The node's longest message ends in the command to run on the Windows machine: it is printed whole, and its
      // instruction is what to do at the end.
      const long = runnerNoTcpAnswer('wss://10.0.0.5:8765/rpa/v1', 10, '10.0.0.5');
      expect(long.length).toBeGreaterThan(300);
      const l = await run(setup((await n8n({ credentials: [HAND], test: 'error', testMessage: long })).url, ...NAMED), ENV);
      expect(l.code, l.out).toBe(0);
      expect(l.out).toContain(`and it failed: ${long}`);
      expect(l.stdout).toContain('\n  Reason:     Could not connect to the desktop runner at wss://10.0.0.5:8765/rpa/v1 (no answer within 10 s).\n');
      expect(l.stdout).toContain(`\n  What to do: ${long.slice(long.indexOf('Check, in this order'))}\n`);
      // A message with no instruction: what to do is to correct the line.
      const odd = await run(setup((await n8n({ credentials: [HAND], test: 'error', testMessage: 'The desktop runner at wss://x.example.com:8765/rpa/v1 presented another certificate. Nothing was sent.' })).url, ...NAMED), ENV);
      expect(odd.stdout).toContain('\n  Reason:     The desktop runner at wss://x.example.com:8765/rpa/v1 presented another certificate.\n  What to do: Correct the Connection Line of "RPA Desktop Runner account".\n');
      const forbidden = await n8n({ credentials: [HAND], test: 'forbidden' });
      const r = await run(setup(forbidden.url, ...NAMED), ENV);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('not tested credential "RPA Desktop Runner account" (id c-hand) (HTTP 403: Forbidden). To test it, open it in n8n, which tests it as it opens. For this command to test it, the API key needs the scope credential:read.');
      expect(r.stdout.trimEnd().split('\n').slice(-3)).toEqual([
        'The import form is ready. Whether the Windows machine is connected is not known: n8n did not test it.',
        '  Reason:     HTTP 403: Forbidden. For this command to test it, the API key needs the scope credential:read.',
        '  What to do: open the credential "RPA Desktop Runner account" in n8n, which tests it as it opens.',
      ]);
      expect(onImport(forbidden).rpaDesktopRunnerApi).toEqual({ id: 'c-hand', name: 'RPA Desktop Runner account' });
    });

    it('no answer, at a terminal: it offers once to paste a corrected line, replaces it, says only its address and port, and n8n tests it again', async () => {
      const ASK = /Corrected Connection Line for "RPA Desktop Runner account" \(not shown\), or Enter to finish: /;
      const lineOf = (fake: Fake) => fake.state.credentials.find((c) => c.id === 'c-hand')!.data.connectionLine;
      const tests = (fake: Fake) => fake.state.requests.filter((r) => r.path === '/api/v1/credentials/c-hand/test').length;
      const fake = await n8n({ credentials: [HAND], test: 'error', testOkWhen: 'rpa.example.com' });
      const r = await runAtTerminal(setup(fake.url, ...NAMED), ENV, [[ASK, NEW_LINE]]);
      expect(r.code, r.out).toBe(0);
      expect(lineOf(fake)).toBe(NEW_LINE);
      expect(r.out).toContain('n8n got no answer from the Windows machine. If you printed its line again, for example with -Address, paste it now.');
      expect(r.out).toContain('replaced Connection Line of credential "RPA Desktop Runner account" (id c-hand): it now names rpa.example.com:8765');
      expect(tests(fake)).toBe(2);
      expect(r.out.trimEnd().split('\n').at(-1)).toBe(`The import form is ready, and the Windows machine is connected. n8n's test said: ${RUNNER_CONNECTED}.`);
      expectNoSecrets(r.out, [NEW_LINE, NEW_TOKEN, 'CD'.repeat(32)]);

      // Enter: nothing changes, and the closing lines are today's.
      const enter = await n8n({ credentials: [HAND], test: 'error' });
      const e = await runAtTerminal(setup(enter.url, ...NAMED), ENV, [[ASK, '']]);
      expect(e.code, e.out).toBe(0);
      expect(lineOf(enter)).toBe(LINE);
      expect(enter.state.requests.filter((q) => q.method === 'PATCH')).toEqual([]);
      expect(tests(enter)).toBe(1);
      expect(e.out).toContain('The import form is ready, but the Windows machine is not connected yet.');
      // A line that does not parse: the node's message, nothing changed, nothing more asked.
      const bad = await n8n({ credentials: [HAND], test: 'error' });
      const b = await runAtTerminal(setup(bad.url, ...NAMED), ENV, [[ASK, 'rpa-runner://half-a-line']]);
      expect(b.code, b.out).toBe(0);
      expect(lineOf(bad)).toBe(LINE);
      expect(b.out).toMatch(/ {9}not used: .* The Connection Line of credential "RPA Desktop Runner account" \(id c-hand\) stays as it is\./);
      expect(b.out).not.toContain('half-a-line');
      expect(tests(bad)).toBe(1);
      // Still no answer after the new line: asked once only, and the closing lines say so.
      const still = await n8n({ credentials: [HAND], test: 'error' });
      const st = await runAtTerminal(setup(still.url, ...NAMED), ENV, [[ASK, NEW_LINE]]);
      expect(st.code, st.out).toBe(0);
      expect(tests(still)).toBe(2);
      expect(st.out.match(/Corrected Connection Line/g)).toHaveLength(1);
      expect(st.out).toContain('The import form is ready, but the Windows machine is not connected yet.');
      expectNoSecrets(e.out + b.out + st.out, [NEW_LINE, NEW_TOKEN]);
    });

    it('another failure than no answer, or no terminal: it does not ask, and the closing lines are today\'s', async () => {
      const other = await n8n({ credentials: [HAND], test: 'error', testMessage: 'The desktop runner at wss://x.example.com:8765/rpa/v1 refused the token. Check the Token in the RPA Desktop Runner credential.' });
      const o = await runAtTerminal(setup(other.url, ...NAMED), ENV, []);
      expect(o.code, o.out).toBe(0);
      expect(o.out).not.toContain('Corrected Connection Line');
      const plain = await n8n({ credentials: [HAND], test: 'error' });
      const p = await run(setup(plain.url, ...NAMED), ENV);
      expect(p.code, p.out).toBe(0);
      expect(p.out).not.toContain('Corrected Connection Line');
      expect(p.out).not.toContain('n8n got no answer');
      expect(plain.state.requests.filter((q) => q.method === 'PATCH')).toEqual([]);
    });

    it('a workflow there already is left alone: it says to pick the runner on Import steps, by name and id', async () => {
      const fake = await n8n();
      expect((await run(setup(fake.url), ENV)).code).toBe(0);
      const [wf] = fake.state.workflows;
      fake.state.credentials.push({ ...HAND, projectId: HOME });
      const before = fake.state.requests.length;
      const r = await run(setup(fake.url), ENV);
      expect(r.code, r.out).toBe(0);
      // Not named: picked for what the form hands over, not tested (IB-9).
      expect(fake.state.requests.slice(before).filter((q) => q.method !== 'GET').map((q) => q.path)).toEqual([]);
      expect(wf.nodes.find((n) => n.name === 'Import steps').credentials.rpaDesktopRunnerApi).toBeUndefined();
      expect(r.out).toContain('its credentials were left as they are: pick "RPA Desktop Runner account" (id c-hand) on "Import steps" in n8n, so the workflow file the form hands over carries them.');
      expect(r.out).toContain('The workflow the form gives you does not use "RPA Desktop Runner account" yet: pick it on "Import steps" in n8n (see above).');
    });

    it('in a shared project: picked only with the set, after the question or --reuse-project-credentials', async () => {
      const TEAM_RUNNER: Cred = { ...HAND, id: 'c-team-runner', projectId: 'P-team' };
      const OTHER_WORK: Wf = { id: 'w-team-other', name: 'Team work', active: false, versionId: 'v', nodes: [], connections: {}, settings: {}, projectId: 'P-team' };
      const teamImport = (fake: Fake) => fake.state.workflows.find((w) => w.projectId === 'P-team' && w.id !== 'w-team-other')!.nodes.find((n) => n.name === 'Import steps').credentials;
      const no = await n8n({ credentials: [TEAM_RUNNER], workflows: [OTHER_WORK] });
      const n = await run(setup(no.url, '--project-id', 'P-team'), ENV);
      expect(n.code, n.out).toBe(0);
      expect(n.out).toMatch(/Found in the shared project "Ops" \(id P-team\):\n {2}credential "RPA Desktop Runner account" \(id c-team-runner\)\n/);
      expect(n.out).toContain('not used credential "RPA Desktop Runner account": this run does not use what it found in the shared project');
      expect(teamImport(no).rpaDesktopRunnerApi).toBeUndefined();
      const yes = await n8n({ credentials: [TEAM_RUNNER], workflows: [OTHER_WORK] });
      const y = await run(setup(yes.url, '--project-id', 'P-team', '--reuse-project-credentials'), ENV);
      expect(y.code, y.out).toBe(0);
      expect(teamImport(yes).rpaDesktopRunnerApi).toEqual({ id: 'c-team-runner', name: 'RPA Desktop Runner account' });
    });
  });

  it('--browser-url: the RPA Browser credential with the token from RPA_BROWSER_TOKEN, set on Import steps', async () => {
    const fake = await n8n();
    const { code, out } = await run(setup(fake.url, '--browser-url', 'ws://browser:3000/'), { ...ENV, RPA_BROWSER_TOKEN: BROWSER_TOKEN });
    expect(code, out).toBe(0);
    const browser = fake.state.credentials.find((c) => c.type === 'playwrightBrowserApi')!;
    expect(browser).toMatchObject({ name: 'RPA Browser', data: { mode: 'playwright', wsUrl: 'ws://browser:3000/', token: BROWSER_TOKEN, privateNetwork: true } });
    const signing = fake.state.credentials.find((c) => c.type === 'playwrightScriptSigningApi')!;
    expect(fake.state.workflows[0].nodes.find((n) => n.name === 'Import steps').credentials).toEqual({
      playwrightBrowserApi: { id: browser.id, name: 'RPA Browser' }, playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' },
    });
    expectNoSecrets(out);
    const noToken = await run(setup(fake.url, '--browser-url', 'ws://browser:3000/'), ENV);
    expect(noToken.code).toBe(2);
    expect(noToken.out).toMatch(/RPA_BROWSER_TOKEN/);
  });

  describe('--site-login and --allow-private-network', () => {
    const SITE_PASSWORD = 'site-password-0123456789-abcdefghij';
    const site = (id: string, name: string, projectId = HOME): Cred => ({
      id, name, type: 'playwrightSiteLoginApi', projectId, data: { loginUrl: 'http://sandbox:8080/acme/login', username: 'summit-ops', password: SITE_PASSWORD, totpSecret: 'JBSWY3DPEHPK3PXP' },
    });
    const MINE = site('c-site', 'RPA Site Login account');
    // A workflow of another name in the owner's project tells this run its project before anything is made.
    const OWN_WORK: Wf = { id: 'w-own', name: 'Own work', active: false, versionId: 'v', nodes: [], connections: {}, settings: {} };
    const siteArgs = ['--site-login', 'RPA Site Login account', '--allow-private-network'];
    const node = (wf: Wf, name: string) => wf.nodes.find((n) => n.name === name);
    /** Every request this run sent and every line it printed: the Site Login's values are in none of them. */
    const expectSiteUntouched = (fake: Fake, out: string) => {
      for (const v of [SITE_PASSWORD, 'summit-ops', 'JBSWY3DPEHPK3PXP']) expect(out).not.toContain(v);
      expect(fake.state.requests.filter((r) => r.path.includes('c-site'))).toEqual([]);
      for (const r of fake.state.requests) expect(r.body).not.toContain(SITE_PASSWORD);
      expect(fake.state.credentials.find((c) => c.id === 'c-site')).toEqual({ ...MINE });
    };

    it('picks the existing Site Login by name on Import steps and Sign steps, and turns Allow Private Network on, typed', async () => {
      const other = site('c-other', 'RPA Site Login account', 'P-other');
      const fake = await n8n({ credentials: [MINE, other] });
      const { code, out, stdout } = await run(setup(fake.url, '--browser-url', 'ws://browser:3000/', ...siteArgs), { ...ENV, RPA_BROWSER_TOKEN: BROWSER_TOKEN });
      expect(code, out).toBe(0);
      const wf = fake.state.workflows.find((w) => w.name === 'RPA: 5 Import a bot')!;
      const ref = { id: 'c-site', name: 'RPA Site Login account' };
      expect(node(wf, 'Import steps').credentials.playwrightSiteLoginApi).toEqual(ref);
      expect(node(wf, 'Sign steps').credentials.playwrightSiteLoginApi).toEqual(ref);
      // Typed in beside the template's own Version option, which it keeps.
      const templateOptions = JSON.parse(readFileSync(TEMPLATE, 'utf8')).nodes.find((n: { name: string }) => n.name === 'Import steps').parameters.options;
      expect(templateOptions).toHaveProperty('version');
      expect(node(wf, 'Import steps').parameters.options).toEqual({ ...templateOptions, allowPrivateNetwork: true });
      // Never one of another user or project, never made.
      expect(stdout).toContain('left alone credential "RPA Site Login account" (playwrightSiteLoginApi, id c-other): it belongs to another project or user, so it is not used');
      expect(fake.state.credentials.filter((c) => c.type === 'playwrightSiteLoginApi')).toHaveLength(2);
      expect(stdout).toContain('with the Site Login "RPA Site Login account" (id c-site) on "Import steps" and "Sign steps"');
      expect(stdout).toContain('  Private network: on. Imports may open sites on this computer or your own network, and the workflow the form hands over has it on too.');
      expectSiteUntouched(fake, out);
      expectNoSecrets(out);

      // Without the flags nothing of this is set.
      const plain = await n8n({ credentials: [MINE] });
      const p = await run(setup(plain.url), ENV);
      expect(p.code, p.out).toBe(0);
      const pwf = plain.state.workflows[0];
      expect(node(pwf, 'Import steps').credentials).not.toHaveProperty('playwrightSiteLoginApi');
      expect(node(pwf, 'Sign steps').credentials).not.toHaveProperty('playwrightSiteLoginApi');
      expect(node(pwf, 'Import steps').parameters.options).not.toHaveProperty('allowPrivateNetwork');
      expect(p.stdout).not.toContain('Private network');
    });

    it('a name that matches none, or more than one, in the project stops before anything is changed, listing what it found', async () => {
      const none = await n8n({ credentials: [site('c-a', 'Acme portal'), site('c-x', 'RPA Site Login account', 'P-other')], workflows: [OWN_WORK] });
      const r = await run(setup(none.url, ...siteArgs), ENV);
      expect(r.code, r.out).toBe(2);
      expect(r.out).toContain('No RPA Site Login named "RPA Site Login account" in your project. Your project\'s RPA Site Logins: "Acme portal" (id c-a). Create it in n8n (+ → New credential → RPA Site Login), or give its name as n8n shows it. Nothing was changed.');
      expect(r.out).toContain('left alone credential "RPA Site Login account" (playwrightSiteLoginApi, id c-x): it belongs to another project or user');
      expect(none.posts()).toEqual([]);
      const empty = await n8n({ workflows: [OWN_WORK] });
      expect((await run(setup(empty.url, ...siteArgs), ENV)).out).toContain('Your project has no RPA Site Login.');
      expect(empty.posts()).toEqual([]);
      // Learned from the workflow it makes: that one is removed again.
      const late = await n8n();
      expect((await run(setup(late.url, ...siteArgs), ENV)).code).toBe(2);
      expect(late.state.workflows).toEqual([]);
      expect(late.state.credentials).toEqual([]);

      const two = await n8n({ credentials: [MINE, site('c-site2', 'RPA Site Login account')], workflows: [OWN_WORK] });
      const t = await run(setup(two.url, ...siteArgs), ENV);
      expect(t.code, t.out).toBe(1);
      expect(t.out).toContain('Your project has 2 credentials named "RPA Site Login account" (ids c-site, c-site2), and this command cannot tell which one is meant.');
      expect(two.posts()).toEqual([]);
      expectSiteUntouched(two, r.out + t.out);
      // Not a name, or the name of a credential this command makes.
      for (const bad of [' ', 'RPA Step Signing', 'a\u001b[2Jb', 'x'.repeat(129)]) {
        const b = await run(setup(empty.url, '--site-login', bad), ENV);
        expect(b.code, bad).toBe(2);
        expect(b.out).toMatch(/--site-login/);
      }
    });

    it('in a shared project the one question covers it: without a terminal or the flag it is not set', async () => {
      const TEAM_SITE = site('c-tsite', 'RPA Site Login account', 'P-team');
      const TEAM_WORK: Wf = { id: 'w-team-other', name: 'Team work', active: false, versionId: 'v', nodes: [], connections: {}, settings: {}, projectId: 'P-team' };
      const no = await n8n({ credentials: [TEAM_SITE], workflows: [TEAM_WORK] });
      const r = await run(setup(no.url, '--project-id', 'P-team', ...siteArgs), ENV);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/Found in the shared project "Ops" \(id P-team\):\n {2}credential "RPA Site Login account" \(id c-tsite\)\n/);
      expect(r.out).toContain('not used credential "RPA Site Login account": this run does not use what it found in the shared project, so no Site Login is set. Pick one on "Import steps" and "Sign steps" in n8n.');
      const made = no.state.workflows.find((w) => w.name === 'RPA: 5 Import a bot')!;
      expect(node(made, 'Import steps').credentials).not.toHaveProperty('playwrightSiteLoginApi');
      const yes = await n8n({ credentials: [TEAM_SITE], workflows: [TEAM_WORK] });
      const y = await run(setup(yes.url, '--project-id', 'P-team', '--reuse-project-credentials', ...siteArgs), ENV);
      expect(y.code, y.out).toBe(0);
      const wf = yes.state.workflows.find((w) => w.name === 'RPA: 5 Import a bot')!;
      expect(node(wf, 'Sign steps').credentials.playwrightSiteLoginApi).toEqual({ id: 'c-tsite', name: 'RPA Site Login account' });
    });

    it('a workflow that is there already is left as it is: it says what it would have set', async () => {
      const fake = await n8n({ credentials: [MINE] });
      expect((await run(setup(fake.url), ENV)).code).toBe(0);
      const before = JSON.stringify(fake.state.workflows);
      const puts = () => fake.state.requests.filter((x) => x.method === 'PUT').length;
      const putsBefore = puts();
      const r = await run(setup(fake.url, ...siteArgs), ENV);
      expect(r.code, r.out).toBe(0);
      expect(r.stdout).toMatch(/reused +workflow "RPA: 5 Import a bot"/);
      expect(r.stdout).toContain('         it was left as it is, without what you asked for: in n8n, pick "RPA Site Login account" (id c-site) on "Import steps" and "Sign steps", and turn on Options → Allow Private Network on "Import steps", then publish it again.');
      expect(r.stdout).not.toContain('Private network: on');
      expect(JSON.stringify(fake.state.workflows)).toBe(before);
      expect(puts()).toBe(putsBefore);
      // Once set by hand in n8n, a run with the same flags has nothing to say about them.
      const wf = fake.state.workflows[0];
      for (const n of ['Import steps', 'Sign steps']) node(wf, n).credentials.playwrightSiteLoginApi = { id: 'c-site', name: 'RPA Site Login account' };
      node(wf, 'Import steps').parameters.options = { allowPrivateNetwork: true };
      const again = await run(setup(fake.url, ...siteArgs), ENV);
      expect(again.code, again.out).toBe(0);
      expect(again.stdout).not.toContain('without what you asked for');
      expect(again.stdout).toContain('Private network: on.');
      expectSiteUntouched(fake, r.out + again.out);
    });
    describe('--new-workflow --site-login: a form of that Site Login\'s own, beside the first one', () => {
      const ACME = site('c-acme', 'Ünïted Acme Portal');
      const acmeArgs = ['--new-workflow', '--site-login', 'Ünïted Acme Portal'];
      const SITE_FORM = 'RPA: 5 Import a bot (Ünïted Acme Portal)';
      const formOf = (wf: Wf) => node(wf, 'Import a bot');

      it('its own name, title and /form/rpa-import-<slug>; the same signing key; the first form is not touched', async () => {
        const fake = await n8n({ credentials: [MINE, ACME] });
        const first = await run(setup(fake.url, '--site-login', 'RPA Site Login account'), ENV);
        expect(first.code, first.out).toBe(0);
        const [main] = fake.state.workflows;
        const before = JSON.stringify(main);
        const signing = credOf(fake, 'playwrightScriptSigningApi');
        const key = signingKeyOf(fake);
        const requestsBefore = fake.state.requests.length;

        const r = await run(setup(fake.url, ...acmeArgs), ENV);
        expect(r.code, r.out).toBe(0);
        expect(fake.state.workflows).toHaveLength(2);
        const second = fake.state.workflows[1];
        expect(second).toMatchObject({ name: SITE_FORM, active: true });
        expect(formOf(second).parameters.formTitle).toBe('Import a bot for Ünïted Acme Portal');
        expect(formOf(second).parameters.options.path).toBe('rpa-import-united-acme-portal');
        const acme = { id: 'c-acme', name: 'Ünïted Acme Portal' };
        expect(node(second, 'Import steps').credentials.playwrightSiteLoginApi).toEqual(acme);
        expect(node(second, 'Sign steps').credentials.playwrightSiteLoginApi).toEqual(acme);
        // One signing credential, unchanged, on both forms: never a new key.
        expect(fake.state.credentials.filter((c) => c.type === 'playwrightScriptSigningApi')).toHaveLength(1);
        expect(signingKeyOf(fake)).toBe(key);
        for (const wf of [main, second]) expect(node(wf, 'Sign steps').credentials.playwrightScriptSigningApi).toEqual({ id: signing.id, name: 'RPA Step Signing' });
        expect(r.stdout).toMatch(/reused +credential "RPA Step Signing" \(id c\d+\): its key stays as it is/);
        // The first form: not read for a change, not written, not published again.
        expect(JSON.stringify(main)).toBe(before);
        const after = fake.state.requests.slice(requestsBefore);
        expect(after.filter((q) => q.method !== 'GET' && q.path.includes(main.id))).toEqual([]);
        expect(after.filter((q) => q.method === 'PATCH')).toEqual([]);
        expect(formOf(main).parameters.options.path).toBe('rpa-import');
        expect(formOf(main).parameters.formTitle).toBe('Import a bot');
        expect(r.stdout).toContain(`created  workflow "${SITE_FORM}" (id ${second.id}), approver ops@example.com`);
        expect(r.stdout).toContain(`  Address:    ${fake.url}/form/rpa-import-united-acme-portal\n`);
        expect(r.stdout).toContain('  Site Login: "Ünïted Acme Portal". Use this form for the bots that sign in with it. Your other import form is not changed.');
        expectSiteUntouched(fake, r.out);
        expectNoSecrets(r.out);

        // Again: that form is reused as it is, nothing new.
        const again = await run(setup(fake.url, ...acmeArgs), ENV);
        expect(again.code, again.out).toBe(0);
        expect(fake.state.workflows).toHaveLength(2);
        expect(again.stdout).toMatch(/reused +workflow "RPA: 5 Import a bot \(Ünïted Acme Portal\)"/);
        // The first form's run reuses the first form, not the Site Login's.
        const main2 = await run(setup(fake.url, '--site-login', 'RPA Site Login account'), ENV);
        expect(main2.stdout).toMatch(/reused +workflow "RPA: 5 Import a bot" \(id /);
        expect(fake.state.workflows).toHaveLength(2);
      });

      it('a first run with both flags makes the key once, which the main form then reuses; a taken address keeps the id', async () => {
        const fake = await n8n({ credentials: [MINE, ACME] });
        expect((await run(setup(fake.url, ...acmeArgs), ENV)).code).toBe(0);
        expect((await run(setup(fake.url), ENV)).code).toBe(0);
        expect(fake.state.credentials.filter((c) => c.type === 'playwrightScriptSigningApi')).toHaveLength(1);
        expect(fake.state.workflows.map((w) => [w.name, formOf(w).parameters.options.path])).toEqual([[SITE_FORM, 'rpa-import-united-acme-portal'], ['RPA: 5 Import a bot', 'rpa-import']]);
        // Another Site Login whose name gives the same address: the address with an id, and why.
        const twin = await n8n({ credentials: [MINE, ACME, site('c-twin', 'united acme portal')] });
        expect((await run(setup(twin.url, ...acmeArgs), ENV)).code).toBe(0);
        const t = await run(setup(twin.url, '--new-workflow', '--site-login', 'united acme portal'), ENV);
        expect(t.code, t.out).toBe(0);
        expect(formOf(twin.state.workflows[1]).parameters.options.path).toBeUndefined();
        expect(t.stdout).toContain(`         its form keeps an address with an id, not /form/rpa-import-united-acme-portal: the workflow "${SITE_FORM}" (id ${twin.state.workflows[0].id}) has a form at /form/rpa-import-united-acme-portal.`);
        // A name without a letter or a digit: the address with an id.
        const odd = await n8n({ credentials: [site('c-odd', '★ ★')] });
        const o = await run(setup(odd.url, '--new-workflow', '--site-login', '★ ★'), ENV);
        expect(o.code, o.out).toBe(0);
        expect(formOf(odd.state.workflows[0]).parameters.options.path).toBeUndefined();
        expect(o.stdout).toContain("its form keeps an address with an id: the Site Login's name has no letters or digits for an address.");
      });

      it('in a shared project whose set it may not use, it stops: no second key, no form without its Site Login', async () => {
        const TEAM_KEY: Cred = { id: 'c-tkey', name: 'RPA Step Signing', type: 'playwrightScriptSigningApi', data: { secretKey: 'made-up-team-key-0123456789abcdef' }, projectId: 'P-team' };
        const TEAM_WORK: Wf = { id: 'w-team-other', name: 'Team work', active: false, versionId: 'v', nodes: [], connections: {}, settings: {}, projectId: 'P-team' };
        const fake = await n8n({ credentials: [TEAM_KEY, site('c-tsite', 'Ünïted Acme Portal', 'P-team')], workflows: [TEAM_WORK] });
        const r = await run(setup(fake.url, '--project-id', 'P-team', ...acmeArgs), ENV);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('A form for a Site Login signs with the RPA Step Signing key your other forms use, and this run does not use that credential (id c-tkey).');
        expect(fake.state.credentials.map((c) => c.id)).toEqual(['c-tkey', 'c-tsite']);
        expect(fake.state.workflows.map((w) => w.id)).toEqual(['w-team-other']);
        const yes = await run(setup(fake.url, '--project-id', 'P-team', '--reuse-project-credentials', ...acmeArgs), ENV);
        expect(yes.code, yes.out).toBe(0);
        expect(node(fake.state.workflows[1], 'Sign steps').credentials.playwrightScriptSigningApi).toEqual({ id: 'c-tkey', name: 'RPA Step Signing' });
        expect(fake.state.credentials.filter((c) => c.type === 'playwrightScriptSigningApi')).toHaveLength(1);
      });
    });
  });

  it('redacts every secret when n8n echoes a request: a credential body, a workflow on a failed publish', async () => {
    const echo = await n8n({ echo: 'credentials' });
    const failed = await run(basicSetup(echo.url), { ...ENV, RPA_CONNECTION_LINE: LINE });
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/Could not create the credential "RPA import form" \(HTTP 400: request\.body\.data is not valid: .*\*\*\*/);
    const sent = echo.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/credentials').map((r) => JSON.parse(r.body).data.password as string);
    expect(sent).toHaveLength(1);
    expectNoSecrets(failed.out, sent);
    expect(echo.state.workflows, 'the workflow it started without credentials is removed again').toEqual([]);
    // n8n's sign-in: the signing key is the first credential sent, and it is redacted the same way.
    const echoKey = await n8n({ echo: 'credentials' });
    const keyFailed = await run(setup(echoKey.url), ENV);
    expect(keyFailed.code).toBe(1);
    expect(keyFailed.out).toMatch(/Could not create the credential "RPA Step Signing" \(HTTP 400: request\.body\.data is not valid: .*\*\*\*/);
    expectNoSecrets(keyFailed.out, echoKey.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/credentials').map((r) => JSON.parse(r.body).data.secretKey as string));

    const unpublished = await n8n({ echo: 'activate' });
    const notPublished = await run(setup(unpublished.url), ENV);
    expect(notPublished.code, 'exit 0 only when the form is published').toBe(1);
    expect(notPublished.out).toMatch(/not published/);
    const secrets = unpublished.state.credentials.map((c) => (c.data.password ?? c.data.secretKey) as string);
    expectNoSecrets(notPublished.out, secrets);
  });

  it('stops before creating anything: no approver without a terminal, a bad approver, a same-name credential of another type', async () => {
    const fake = await n8n({ users: false });
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
      const { code } = await run(basicSetup(fake.url, '--new-form-password', '--replace-signing-key'), ENV);
      // --replace-signing-key asks for the typed word whenever a key of that name exists: no terminal here, so it stops.
      expect(code).toBe(2);
      expect(fake.posts()).toEqual([]);
      const ok = await run(basicSetup(fake.url, '--new-form-password'), ENV);
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
      expect(first.out).toMatch(/"RPA: 5 Import a bot" \(id w-P-owner\) in your project differs from the template: its node "Sign steps" is not a n8n-nodes-rpa\.playwright node\. It is not published, and this run changed nothing\. To keep its address, undo that change in n8n, or delete that workflow, and run this again\. --new-workflow makes another form at a new address\./);
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
        expect(out).toMatch(/The project "Ops" \(id P-team\) is shared: everyone in it who may run its workflows can open the form, and use the signing key this command sets up there\. A personal project keeps them to one person\./);
        // With --form-login basic, the form's login is shared there too.
        const basic = await n8n({ credentials: [TEAM_KEY], workflows: [OTHER_WORK] });
        const b = await run(basicSetup(basic.url, '--project-id', 'P-team'), ENV);
        expect(b.code, b.out).toBe(0);
        expect(b.out).toMatch(/The project "Ops" \(id P-team\) is shared: everyone in it can use the form's login and the signing key this command sets up there\. A personal project keeps them to one person\./);
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
          ...(x.name === 'Import a bot' ? { parameters: { ...x.parameters, authentication: 'basicAuth' }, credentials: { httpBasicAuth: { id: 'c-tform', name: 'RPA import form' } }, webhookId: 'team-form' } : {}) }));
        const teamWf: Wf = { id: 'w-team', name: 'RPA: 5 Import a bot', active: true, versionId: 'v', nodes, connections: t.connections, settings: {}, projectId: 'P-team' };
        const fake = await n8n({ credentials: [TEAM_KEY, FORM_TEAM], workflows: [teamWf] });
        const r = await runAtTerminal(basicSetup(fake.url, '--project-id', 'P-team', '--show-signing-key'), ENV, [[/Connect a Windows machine now/, 'n'], [/Use these\?/, 'n']]);
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
    for (const flag of ['--api-key', '--no-api-key', '--url', '--approver', '--form-login', '--allow-http', '--show-signing-key', '--replace-signing-key', '--new-form-password', '--browser-url', '--site-login', '--allow-private-network', 'N8N_API_KEY', 'RPA_CONNECTION_LINE']) expect(help.out).toContain(flag);
    // The API key: all scopes and the shortest expiry by default, revoked after; the stricter scope list on one line.
    expect(help.out).toContain('with Scopes All and the shortest expiry, and revoke it when the setup is done.');
    expect(help.out).toContain('The stricter way, Scopes Custom with only: workflow:create, workflow:read, workflow:update, workflow:delete, workflow:list, workflow:activate, credential:create, credential:read, credential:update, credential:list, user:read\n');
    expect((await run([])).code).toBe(2);
  });
});

const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));

describe('a form this command made, brought up to date (item 2, IB-1)', () => {
  /** A form the first run made, then changed: a sticky note added by hand, and the form's text as an older version had it. */
  async function madeThenChanged(extra: string[] = []) {
    const fake = await n8n();
    expect((await run(setup(fake.url, ...extra), ENV)).code).toBe(0);
    const [wf] = fake.state.workflows;
    wf.nodes.push({ id: 'note-1', name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 0], parameters: { content: 'Approvers: ask Sam.' } });
    wf.nodes.find((n) => n.name === 'Import a bot').parameters.formDescription = 'An older text.';
    wf.nodes = wf.nodes.filter((n) => n.name !== 'Choice fits the box?');
    const sign = wf.nodes.find((n) => n.name === 'Sign steps');
    sign.parameters.approverAllowlist = 'ops@example.com, second@example.com';
    return { fake, wf };
  }

  it('without a terminal: says what differs, changes nothing, says the form is live at its address, exit 0', async () => {
    const { fake, wf } = await madeThenChanged();
    const before = JSON.stringify(wf);
    const writes = fake.posts().length;
    const r = await run(setup(fake.url), ENV);
    expect(r.code, r.out).toBe(0);
    expect(fake.posts().length).toBe(writes);
    expect(JSON.stringify(fake.state.workflows[0])).toBe(before);
    expect(r.out).toContain(`The form "RPA: 5 Import a bot" (id ${wf.id}) was made by this command, and differs from this version's template:`);
    expect(r.out).toContain('  Added in the template:     "Choice fits the box?"');
    expect(r.out).toContain('  Not in the template:       "Sticky Note"');
    expect(r.out).toMatch(/ {2}Set differently: +.*"Import a bot"/);
    expect(r.out).toContain('  Lost with it: the node "Sticky Note", which the template does not have.');
    expect(r.out).toContain('Not updated: without a terminal this command does not ask. To update it, run this command again at a terminal and answer y.');
    expect(r.out).toContain(`  It is published, and answers at ${fake.url}/form/rpa-import.`);
    // IB-1: no line says the form is not ready.
    expect(r.out).not.toMatch(/not ready|not published/);
  });

  it('n at a terminal: the same; y: its nodes and connections are the template\'s, what the person set is kept, published again', async () => {
    const { fake, wf } = await madeThenChanged(['--allow-private-network']);
    const QUESTION = /Update this form to this version\? \(y\/N\) /;
    const no = await runAtTerminal(setup(fake.url), ENV, [[/Connect a Windows machine now/, 'n'], [QUESTION, 'n']]);
    expect(no.code, no.out).toBe(0);
    expect(fake.state.workflows[0].nodes.some((n) => n.name === 'Sticky Note')).toBe(true);
    const webhooks = Object.fromEntries(wf.nodes.filter((n) => n.webhookId).map((n) => [n.name, n.webhookId]));
    const signing = wf.nodes.find((n) => n.name === 'Sign steps').credentials;
    const yes = await runAtTerminal(setup(fake.url), ENV, [[/Connect a Windows machine now/, 'n'], [QUESTION, 'y']]);
    expect(yes.code, yes.out).toBe(0);
    const [after] = fake.state.workflows;
    expect(fake.state.workflows).toHaveLength(1);
    expect(after.id).toBe(wf.id);
    expect(after.name).toBe('RPA: 5 Import a bot');
    expect(after.nodes.map((n) => n.name).sort()).toEqual(template().nodes.map((n: any) => n.name).sort());
    expect(after.connections).toEqual(template().connections);
    const n = (name: string) => after.nodes.find((x) => x.name === name);
    expect(n('Sign steps').parameters.approverAllowlist).toBe('ops@example.com, second@example.com');
    expect(n('Sign steps').credentials).toEqual(signing);
    expect(n('Import steps').credentials).toEqual(signing);
    expect(n('Import steps').parameters.options.allowPrivateNetwork).toBe(true);
    expect(n('Import a bot').parameters.options.path).toBe('rpa-import');
    expect(n('Import a bot').parameters.formDescription).toBe(template().nodes.find((x: any) => x.name === 'Import a bot').parameters.formDescription);
    for (const [name, id] of Object.entries(webhooks)) expect(n(name).webhookId, name).toBe(id);
    expect(after.active).toBe(true);
    expect(yes.out).toContain(`updated  workflow "RPA: 5 Import a bot" (id ${wf.id}): its nodes and connections are this version's template, with what you set kept`);
    const activations = fake.state.requests.filter((q) => q.path === `/api/v1/workflows/${wf.id}/activate`);
    expect(JSON.parse(activations.at(-1)!.body).versionId).toBe(after.versionId);
    expect(yes.out).toContain('The import form is ready.');
    // Run again: it matches now, nothing asked.
    const again = await run(setup(fake.url), ENV);
    expect(again.out).toMatch(/reused +workflow "RPA: 5 Import a bot" \(id .*\): it matches the template/);
  });

  it('a form whose own nodes are gone is not one this command made: it stops, says that form is still published, and how to keep its address', async () => {
    const fake = await n8n();
    expect((await run(setup(fake.url), ENV)).code).toBe(0);
    fake.state.workflows[0].nodes.find((n) => n.name === 'Sign steps').type = 'n8n-nodes-base.noOp';
    const r = await run(setup(fake.url), ENV);
    expect(r.code).toBe(1);
    expect(r.out).toContain('This run changed nothing: that form is still published at its address. To keep its address, undo that change in n8n, or delete that workflow, and run this again.');
    expect(r.out).not.toMatch(/not ready/);
  });
});

describe("a Site Login's own form is found by the Site Login's id (IB-11)", () => {
  it('after the Site Login is renamed, the guide\'s command for the new name reuses its form, by name and address', async () => {
    const SITE: Cred = { id: 'c-acme', name: 'Sample accounts', type: 'playwrightSiteLoginApi', data: { username: 'u', password: 'p-made-up' } };
    const fake = await n8n({ credentials: [SITE] });
    const first = await run(setup(fake.url, '--new-workflow', '--site-login', 'Sample accounts'), ENV);
    expect(first.code, first.out).toBe(0);
    fake.state.credentials.find((c) => c.id === 'c-acme')!.name = 'Dealer accounts';
    const r = await run(setup(fake.url, '--new-workflow', '--site-login', 'Dealer accounts'), ENV);
    expect(r.code, r.out).toBe(0);
    expect(fake.state.workflows).toHaveLength(1);
    expect(r.out).toMatch(/reused +workflow "RPA: 5 Import a bot \(Sample accounts\)"/);
    expect(r.out).toContain(`  Address:    ${fake.url}/form/rpa-import-sample-accounts`);
  });
});

// ---- The way through n8n's own command line (no API key): a fake n8n command, a made-up /proc and a fake running n8n.

const FAKE_CLI = fileURLToPath(new URL('./fixtures/fake-n8n-cli.mjs', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const CLI_PROJECTS = {
  'P-owner': { id: 'P-owner', name: 'Own Er <owner@example.com>', type: 'personal', creatorId: 'u-owner' },
  'P-other': { id: 'P-other', name: 'Oth Er <other@example.com>', type: 'personal', creatorId: 'u-other' },
  'P-team': { id: 'P-team', name: 'Ops', type: 'team', creatorId: 'u-other' },
};
interface CliState { credentials: (Cred & { updatedAt?: string })[]; workflows: any[]; calls: { command: string; args: string[]; secretsInEnv: string[] }[]; inputs: { path: string; fileMode: string; dirMode: string }[]; fail?: string }
let cliRoots: string[] = [];
afterEach(() => {
  for (const r of cliRoots) rmSync(r, { recursive: true, force: true });
  cliRoots = [];
});

/**
 * n8n with its command line on PATH: a running n8n (/healthz, its forms, from the same state), seen in a made-up /proc as
 * one process "n8n" of this user, with HOME and its database file open, unless the options say otherwise.
 */
async function cliN8n(o: { credentials?: Cred[]; workflows?: any[]; environ?: Record<string, string>; uid?: number; dbOpen?: boolean; noPackage?: boolean; fail?: string; processes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'r16-cli-'));
  cliRoots.push(root);
  const home = join(root, 'home');
  const pkgDir = join(home, '.n8n', 'nodes', 'node_modules', 'n8n-nodes-rpa');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(home, '.n8n', 'database.sqlite'), '');
  if (!o.noPackage) writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'n8n-nodes-rpa', version: PACKAGE.version, n8n: PACKAGE.n8n }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'n8n'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(bin, 'n8n'), 0o755);
  const stateFile = join(root, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    projects: CLI_PROJECTS, ownerProject: 'P-owner', fail: o.fail, calls: [], inputs: [],
    credentials: (o.credentials ?? []).map((c) => ({ projectId: 'P-owner', ...c })), workflows: (o.workflows ?? []).map((w) => ({ projectId: 'P-owner', ...w })),
  }));
  const proc = join(root, 'proc');
  for (let i = 0; i < (o.processes ?? 1); i++) {
    const pdir = join(proc, String(4242 + i));
    mkdirSync(join(pdir, 'fd'), { recursive: true });
    writeFileSync(join(pdir, 'cmdline'), 'n8n\0\0\0\0');
    const uid = o.uid ?? process.getuid!();
    writeFileSync(join(pdir, 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    writeFileSync(join(pdir, 'environ'), `${Object.entries({ HOME: home, PATH: '/usr/bin', ...o.environ }).map(([k, v]) => `${k}=${v}`).join('\0')}\0`);
    symlinkSync(home, join(pdir, 'cwd'));
    if (o.dbOpen !== false) symlinkSync(join(home, '.n8n', 'database.sqlite'), join(pdir, 'fd', '21'));
  }
  // Another process: a task runner, never taken for n8n.
  mkdirSync(join(proc, '19'), { recursive: true });
  writeFileSync(join(proc, '19', 'cmdline'), 'n8n task-runner\0');
  const state = (): CliState => JSON.parse(readFileSync(stateFile, 'utf8'));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/healthz') return res.writeHead(200).end('{"status":"ok"}');
    const form = /^\/form\/(.+)$/.exec(url.pathname);
    const trigger = form && state().workflows.filter((w) => w.activeVersionId).flatMap((w) => w.nodes).find((x: any) => /\.formTrigger$/.test(x.type) && (x.parameters?.options?.path || x.webhookId) === form[1]);
    if (!trigger) return res.writeHead(404).end('{}');
    if (trigger.parameters?.authentication === 'basicAuth') return res.writeHead(401).end('{}');
    return res.writeHead(302, { location: 'http://127.0.0.1/signin?redirect=x' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FAKE_N8N_STATE: stateFile, N8N_RPA_SETUP_TEST_PROC: proc };
  return { url, home, env, state, stateFile };
}
type CliFake = Awaited<ReturnType<typeof cliN8n>>;
const imports = (f: CliFake) => f.state().calls.filter((c) => c.command.startsWith('import:') || c.command.startsWith('publish:'));
/** Every file n8n's command line imported from: 0600, in a directory of 0700, and gone afterwards. */
function expectFilesGone(f: CliFake) {
  for (const i of f.state().inputs) {
    expect(i.fileMode).toBe('600');
    expect(i.dirMode).toBe('700');
    expect(existsSync(dirname(i.path)), i.path).toBe(false);
  }
}

describe("setup through n8n's own command line, with no API key", () => {
  const SITE: Cred = { id: 'c-site', name: 'RPA Site Login account', type: 'playwrightSiteLoginApi', data: { username: 'summit-ops', password: 'made-up-site-pw' } };
  const guide = (f: CliFake, ...more: string[]) => ['setup', '--url', f.url, '--approver', 'ops@example.com', ...more];

  it('first run: says which way and why; imports the signing key and the browser, picks the Site Login, imports and publishes the form, which answers', async () => {
    const f = await cliN8n({ credentials: [SITE] });
    const r = await run(guide(f, '--browser-url', 'ws://browser:3000/', '--site-login', 'RPA Site Login account', '--allow-private-network'), { ...f.env, RPA_BROWSER_TOKEN: BROWSER_TOKEN });
    expect(r.code, r.out).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toBe("Setting up n8n for RPA through n8n's own command line: no API key is needed.");
    expect(lines[1]).toBe(`  Why this way: no API key was given, the command n8n is here, and it works on the database of the n8n that runs here (${join(f.home, '.n8n', 'database.sqlite')}).`);
    const s = f.state();
    const signing = s.credentials.find((c) => c.type === 'playwrightScriptSigningApi')!;
    const browser = s.credentials.find((c) => c.type === 'playwrightBrowserApi')!;
    expect(signing.data.secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(browser.data).toEqual({ mode: 'playwright', wsUrl: 'ws://browser:3000/', token: BROWSER_TOKEN, privateNetwork: true });
    expect(s.credentials.find((c) => c.id === 'c-site')!.data, 'never read or changed').toEqual(SITE.data);
    const [wf] = s.workflows;
    expect(wf.activeVersionId).toBe(wf.versionId);
    const node = (name: string) => wf.nodes.find((n: any) => n.name === name);
    expect(node('Sign steps').credentials).toEqual({ playwrightScriptSigningApi: { id: signing.id, name: 'RPA Step Signing' }, playwrightSiteLoginApi: { id: 'c-site', name: 'RPA Site Login account' } });
    expect(node('Import steps').parameters.options.allowPrivateNetwork).toBe(true);
    expect(r.out).toContain('answered the form, after');
    expect(r.stdout).toContain(`The import form is ready.\n  Address:    ${f.url}/form/rpa-import\n`);
    expect(r.out).not.toMatch(/API key you gave|Revoke/);
    // Secrets: in no argument, not in the children's environment, files 0600 in 0700 and removed.
    for (const c of s.calls) {
      expect(c.secretsInEnv, c.command).toEqual([]);
      for (const a of c.args) for (const secret of [BROWSER_TOKEN, signing.data.secretKey]) expect(a).not.toContain(secret);
    }
    expect(s.inputs.length).toBeGreaterThanOrEqual(3);
    expectFilesGone(f);
    expectNoSecrets(r.out, [signing.data.secretKey, 'made-up-site-pw']);
  });

  it('again: asks whether the personal project it found is yours; with yes nothing is imported or replaced', async () => {
    const f = await cliN8n({ credentials: [SITE] });
    expect((await run(guide(f, '--site-login', 'RPA Site Login account'), f.env)).code).toBe(0);
    const key = f.state().credentials.find((c) => c.type === 'playwrightScriptSigningApi')!;
    const before = imports(f).length;
    const piped = await run(guide(f, '--site-login', 'RPA Site Login account'), f.env);
    expect(piped.code).toBe(2);
    expect(piped.out).toContain('Found in the personal project "Own Er <owner@example.com>" (id P-owner):');
    expect(piped.out).toContain('Without a terminal, add --reuse-project-credentials to use it. Nothing was changed.');
    const no = await runAtTerminal(guide(f, '--site-login', 'RPA Site Login account'), f.env, [[/Connect a Windows machine now/, 'n'], [/Is that your personal project\? \(y\/N\) /, 'n']]);
    expect(no.code).toBe(1);
    const yes = await runAtTerminal(guide(f, '--site-login', 'RPA Site Login account'), f.env, [[/Connect a Windows machine now/, 'n'], [/Is that your personal project\? \(y\/N\) /, 'y']]);
    expect(yes.code, yes.out).toBe(0);
    const flag = await run(guide(f, '--site-login', 'RPA Site Login account', '--reuse-project-credentials'), f.env);
    expect(flag.code, flag.out).toBe(0);
    expect(imports(f).length, 'nothing imported, nothing published').toBe(before);
    const after = f.state().credentials.find((c) => c.id === key.id)!;
    expect(after.data.secretKey).toBe(key.data.secretKey);
    expect(after.updatedAt).toBe(key.updatedAt);
    expect(flag.out).toMatch(/reused +credential "RPA Step Signing" .*its key stays as it is/);
    expect(flag.out).toMatch(/reused +workflow "RPA: 5 Import a bot"/);
    expect(flag.stdout).toContain('The import form is ready.');
  });

  it('never the wrong database: another HOME, another user, the file not open, several n8n: refused before any call; --no-api-key stops, else the API key way', async () => {
    const cases: [NonNullable<Parameters<typeof cliN8n>[0]>, Record<string, string>, RegExp][] = [
      [{}, { HOME: '/tmp/another-home' }, /the running n8n and n8n's command line here would differ in HOME/],
      [{ uid: 4321 }, {}, /n8n runs here as another user \(user id 4321\) than this command/],
      [{ dbOpen: false }, {}, /the running n8n does not have .*database\.sqlite open, so n8n's command line here would use another database/],
      [{ processes: 2 }, {}, /2 n8n processes run here/],
      [{ environ: { DB_SQLITE_DATABASE: 'other.sqlite' } }, {}, /would differ in DB_SQLITE_DATABASE/],
      [{ environ: { EXECUTIONS_MODE: 'queue' } }, { EXECUTIONS_MODE: 'queue' }, /n8n runs in queue mode, and the way through n8n's command line is not built for queue mode/],
    ];
    for (const [options, env, why] of cases) {
      const f = await cliN8n(options);
      const e = { ...f.env, ...env };
      const strict = await run(['setup', '--url', f.url, '--approver', 'ops@example.com', '--no-api-key'], e);
      expect(strict.code, strict.out).toBe(2);
      expect(strict.out).toMatch(why);
      expect(strict.out).toContain("--no-api-key: n8n's command line cannot be used here");
      expect(strict.out).toContain("Run this as n8n's user where n8n runs, with n8n's settings");
      const fallback = await run(['setup', '--url', f.url, '--approver', 'ops@example.com'], e);
      expect(fallback.code).toBe(2);
      expect(fallback.out.split('\n')[0]).toMatch(/^This run uses an n8n API key, because .*Where n8n runs, as n8n's user, it needs none\.$/);
      expect(fallback.out).toMatch(/No API key: set N8N_API_KEY/);
      expect(f.state().calls, 'n8n\'s command line never ran').toEqual([]);
    }
  });

  it('--api-key takes the API key way where the command line could be used; no n8n command: the API key way, and why', async () => {
    const f = await cliN8n();
    const forced = await run(['setup', '--url', f.url, '--api-key'], f.env);
    expect(forced.out.split('\n')[0]).toBe('This run uses an n8n API key: --api-key was given.');
    expect(f.state().calls).toEqual([]);
    const none = await run(['setup', '--url', f.url, '--no-api-key'], { ...f.env, PATH: dirname(process.execPath) });
    expect(none.code).toBe(2);
    expect(none.out).toContain("--no-api-key: n8n's command line cannot be used here: the command n8n is not here.");
    const both = await run(['setup', '--api-key', '--no-api-key'], f.env);
    expect(both.out).toContain('Give --api-key or --no-api-key, not both.');
  });

  it('the RPA node not installed in n8n\'s folder: stops before any import', async () => {
    const f = await cliN8n({ noPackage: true });
    const r = await run(guide(f), f.env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/The RPA node is not installed in n8n's folder/);
    expect(f.state().calls).toEqual([]);
  });

  it('an import that fails: the file is removed all the same, the reason is said, and nothing is published', async () => {
    const f = await cliN8n({ fail: 'import:credentials' });
    const r = await run(guide(f), f.env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Could not create the credential "RPA Step Signing" \(n8n's command line did not import the credential "RPA Step Signing" \(.*made-up failure\)\)/);
    expect(f.state().calls.some((c) => c.command === 'publish:workflow')).toBe(false);
    expect(r.out).toContain('has no credentials and is not published: delete it in n8n.');
    expectFilesGone(f);
  });

  it('a Windows machine: n8n\'s command line cannot test it, and says so; a new line for one there is asked about with the old line\'s loss said', async () => {
    const f = await cliN8n();
    const r = await run(guide(f), { ...f.env, RPA_CONNECTION_LINE: LINE });
    expect(r.code, r.out).toBe(0);
    const runner = f.state().credentials.find((c) => c.type === 'rpaDesktopRunnerApi')!;
    expect(runner.data.connectionLine).toBe(LINE);
    expect(r.out).toContain(`not tested credential "RPA Desktop Runner" (id ${runner.id}): n8n's command line cannot test a credential. To test it, open it in n8n, which tests it as it opens.`);
    expect(r.out).toContain('Whether the Windows machine is connected is not known: n8n did not test it.');
    for (const c of f.state().calls) expect(c.secretsInEnv).toEqual([]);
    const QUESTION = /Replace the Connection Line of "RPA Desktop Runner" with the line for rpa\.example\.com:8765\? n8n's command line cannot test the new line first, and the old line will be gone\. \(y\/N\) /;
    const no = await runAtTerminal(guide(f, '--reuse-project-credentials'), { ...f.env, RPA_CONNECTION_LINE: NEW_LINE }, [[QUESTION, 'n']]);
    expect(no.code, no.out).toBe(0);
    expect(f.state().credentials.find((c) => c.id === runner.id)!.data.connectionLine).toBe(LINE);
    const yes = await runAtTerminal(guide(f, '--reuse-project-credentials'), { ...f.env, RPA_CONNECTION_LINE: NEW_LINE }, [[QUESTION, 'y']]);
    expect(yes.code, yes.out).toBe(0);
    expect(f.state().credentials.find((c) => c.id === runner.id)!.data.connectionLine).toBe(NEW_LINE);
    expectFilesGone(f);
    expectNoSecrets(r.out + no.out + yes.out, [NEW_LINE, NEW_TOKEN]);
  });

  it('item 2 through the command line: a form it made that differs is updated in place, by its id, and published again', async () => {
    const f = await cliN8n();
    expect((await run(guide(f), f.env)).code).toBe(0);
    const s = f.state();
    const [wf] = s.workflows;
    wf.nodes.push({ id: 'n1', name: 'Sticky Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 0], parameters: { content: 'x' } });
    writeFileSync(f.stateFile, JSON.stringify(s));
    const QUESTION = /Update this form to this version\? \(y\/N\) /;
    const no = await runAtTerminal(guide(f, '--reuse-project-credentials'), f.env, [[/Connect a Windows/, 'n'], [QUESTION, 'n']]);
    expect(no.code, no.out).toBe(0);
    expect(no.out).toContain('It is published, and answers at');
    expect(f.state().workflows[0].nodes.some((n: any) => n.name === 'Sticky Note')).toBe(true);
    const yes = await runAtTerminal(guide(f, '--reuse-project-credentials'), f.env, [[/Connect a Windows/, 'n'], [QUESTION, 'y']]);
    expect(yes.code, yes.out).toBe(0);
    const [after] = f.state().workflows;
    expect(after.id).toBe(wf.id);
    expect(after.nodes.some((n: any) => n.name === 'Sticky Note')).toBe(false);
    expect(after.activeVersionId).toBe(after.versionId);
    expect(yes.out).toContain('The import form is ready.');
    expect(f.state().workflows).toHaveLength(1);
  });
});
