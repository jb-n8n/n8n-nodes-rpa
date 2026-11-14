import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export const CLI = fileURLToPath(new URL('../../dist/setup.mjs', import.meta.url));
export const FAKE_TTY = fileURLToPath(new URL('./fake-tty.mjs', import.meta.url));
export const TEMPLATE = fileURLToPath(new URL('../../templates/5-import-a-bot.json', import.meta.url));
// n8n 2.x API keys are JWTs whose subject is the user (PublicApiKeyService). The fake's: the owner's, and a key of
// another form (an older n8n's), which does not say whose it is.
export const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const PLAIN_KEY = 'n8n-api-key-0123456789-abcdefghij-KLMNOP';
export const API_KEY = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u-owner', iss: 'n8n', aud: 'public-api' }), PLAIN_KEY].join('.');
// A key made with an expiry carries it (exp, seconds): 2026-12-01 00:00 UTC.
export const EXPIRING_KEY = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u-owner', iss: 'n8n', aud: 'public-api', exp: 1796083200 }), PLAIN_KEY].join('.');
export const FINGERPRINT = 'AB'.repeat(32);
export const RUNNER_TOKEN = 'runner-token-ZYXWVUTSRQPONMLKJIHGFEDCBA-98765';
export const LINE = `rpa-runner://win-1.example.internal:8765/rpa/v1#token=${RUNNER_TOKEN}&fingerprint=${FINGERPRINT}`;
// The line of the same machine printed again, with the address n8n can reach (rpa connection -Address): made up.
export const NEW_TOKEN = 'made-up-new-runner-token';
export const NEW_LINE = `rpa-runner://rpa.example.com:8765/rpa/v1#token=${NEW_TOKEN}&fingerprint=${'CD'.repeat(32)}`;
export const BROWSER_TOKEN = 'browser-token-abcdefghijklmnopqrstuvwxyz-0123456789';
// The node's own test messages for an RPA Desktop Runner (the engine's runnerConnected and runnerUnreachable).
export const RUNNER_CONNECTED = 'Connected to the desktop runner (it has no Windows session to work in yet)';
export const RUNNER_UNREACHABLE = 'Could not connect to the desktop runner at wss://win-1.example.internal:8765/rpa/v1 (no answer within 60 s). Is it running, and is the port open?';
export const FIELDS: Record<string, string[]> = {
  playwrightScriptSigningApi: ['notice', 'secretKey'],
  rpaDesktopRunnerApi: ['about', 'connectionLine', 'url', 'token', 'fingerprint'],
  playwrightBrowserApi: ['notice', 'mode', 'wsUrl', 'token', 'fingerprint', 'privateNetwork', 'headless', 'slowMo'],
  httpBasicAuth: ['user', 'password'],
};

export interface Cred { id: string; name: string; type: string; data: Record<string, any>; projectId?: string }
export interface Wf { id: string; name: string; active: boolean; versionId: string; nodes: any[]; connections: unknown; settings: unknown; projectId?: string; updatedAt?: string }
export interface Options {
  teamName?: string; knowsNode?: boolean; echo?: 'credentials' | 'activate'; credentials?: Cred[]; workflows?: Wf[]; patch?: boolean; ownership?: boolean;
  /** GET /users/{id}: false answers 403 (a key whose owner may not read users). */
  users?: boolean;
  /** POST /credentials/{id}/test: the node's own message, a failed test, or 403 (a key without credential:read). */
  test?: 'ok' | 'error' | 'forbidden';
  /** What a failed test says (default RUNNER_UNREACHABLE). */
  testMessage?: string;
  /** With test 'error': the test passes once the credential's Connection Line holds this text (a corrected line). */
  testOkWhen?: string;
  /** DELETE /credentials/{id}: false answers 403 (a key without credential:delete). */
  deleteCredentials?: boolean;
  /** Workflows the API key cannot see (not listed), whose forms still hold their paths. */
  hiddenForms?: Wf[];
}

// The fake's projects, as n8n 2.45 describes them: two personal projects and a team project.
export const PROJECTS: Record<string, { id: string; name: string; type: string; creatorId: string | null }> = {
  'P-owner': { id: 'P-owner', name: 'Owner <owner@example.com>', type: 'personal', creatorId: 'u-owner' },
  'P-other': { id: 'P-other', name: 'Other <other@example.com>', type: 'personal', creatorId: 'u-other' },
  'P-team': { id: 'P-team', name: 'Ops', type: 'team', creatorId: 'u-other' },
};
export const HOME = 'P-owner'; // the owner's personal project: where a call without projectId puts things

/**
 * A fake n8n 2.45: the public API routes the command uses (two items a page, so lists page), the API key check, who owns
 * what (credential list items: shared[] { id, name, role }; workflow list items: shared[] { role, workflowId,
 * projectId }; GET /workflows/{id}: shared[].project { id, type, creatorId }; `ownership: false` leaves all of it out),
 * the form (401 without the login once its workflow is active), and a request log. `echo` makes a call fail with the
 * request body in its message, as a careless proxy or server might.
 */
export async function fakeN8n(o: Options = {}) {
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
      if ((m = /^DELETE \/api\/v1\/credentials\/([\w-]+)$/.exec(route))) {
        if (o.deleteCredentials === false) return send(403, { message: 'Forbidden' });
        const c = state.credentials.find((x) => x.id === m![1]);
        if (!c) return send(404, { message: 'Not Found' });
        state.credentials = state.credentials.filter((x) => x !== c);
        return send(200, { id: c.id, name: c.name, type: c.type });
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

export let open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(open.map((s) => s.close()));
  open = [];
});
export async function n8n(o?: Options) {
  const s = await fakeN8n(o);
  open.push(s);
  return s;
}

/** Runs the command without a terminal (stdin closed): it never prompts. */
export function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}`, stdout });
    });
    child.stdin?.end();
  });
}

/** Runs the command as if at a terminal (test/fixtures/fake-tty.mjs), answering each prompt as it shows. */
export function runAtTerminal(args: string[], env: Record<string, string>, answers: [RegExp, string][]): Promise<{ code: number; out: string }> {
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
