// signIn totp.via clicks are gated like signIn's own buttons: a via button must not post off the declared login pages,
// must not sit in the form that holds the password (a page must not get the password posted through a via click), and
// is not clicked while the password page is still showing or after the password was rejected. The code provider's
// requestedAt is stamped before the click that makes the site send the code. A tiny local identity provider plays the site.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openSession, type Session } from '../src/browser/session.js';
import { signInCodeFieldMissing } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { totp } from '../src/secrets/totp.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { CodeRequest, PortalPolicy, PortalSecrets, Step } from '../src/types.js';
import { LOCAL, SECRETS } from './helpers.js';

type Mode = {
  /** Where a correct password leads: the "Send me the code" page or straight to the code page. */
  after: '/send' | '/mfa';
  /** The action of the send page's form (default /send). */
  sendAction?: string;
  /**
   * 'spa': Sign in posts nothing; it hides the password and shows "Send me the code" in the same form.
   * 'stay': Sign in posts nothing; "Send me the code" shows in its own form while the password field stays.
   */
  script?: 'spa' | 'stay';
};
let mode: Mode;
let posts: { path: string; body: URLSearchParams }[];
let server: Server;
let origin: string;
let host: string;

const page = (body: string) => `<!doctype html><html><head><title>Sign in</title></head><body>${body}</body></html>`;
const sendForm = (action = '/send') => `<form method="post" action="${action}"><button type="submit">Send me the code</button></form>`;
const loginPage = (error = '') => page(
  `<form id="f" method="post" action="/login" novalidate>`
  + `<label for="email">Email</label><input id="email" name="loginfmt" type="text">`
  + `<div id="pwbox"><label for="pw">Password</label><input id="pw" name="passwd" type="password"></div>`
  + (mode.script === 'spa' ? `<div id="sendbox" hidden><button type="submit" name="step" value="send">Send me the code</button></div>` : '')
  + `<button type="${mode.script ? 'button' : 'submit'}" id="signin">Sign in</button></form>`
  + (error ? `<p id="error">${error}</p>${sendForm()}` : '')
  + (mode.script === 'stay' ? `<div id="later" hidden>${sendForm()}</div>` : '')
  + (mode.script === 'spa' ? `<script>document.getElementById('signin').addEventListener('click', () => setTimeout(() => {
      document.getElementById('pwbox').style.display = 'none';
      document.getElementById('signin').style.display = 'none';
      document.getElementById('sendbox').hidden = false;
    }, 200));</script>` : '')
  + (mode.script === 'stay' ? `<script>document.getElementById('signin').addEventListener('click', () => setTimeout(() => {
      document.getElementById('later').hidden = false;
    }, 200));</script>` : ''),
);
const codePage = () => page(`<form method="post" action="/mfa"><label for="code">Code</label><input id="code" name="otc"><button type="submit">Verify</button></form>`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const html = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    const redirect = (to: string) => { res.writeHead(302, { location: to }); res.end(); };
    if (req.method === 'POST') {
      let data = '';
      req.on('data', (c: Buffer) => { data += c.toString(); });
      req.on('end', () => {
        const body = new URLSearchParams(data);
        posts.push({ path: u.pathname, body });
        if (u.pathname === '/login') {
          if (body.get('loginfmt') !== SECRETS.username || body.get('passwd') !== SECRETS.password) return html(200, loginPage('Your account or password is incorrect.'));
          return redirect(mode.after);
        }
        if (u.pathname === '/send') return redirect('/mfa');
        if (u.pathname === '/mfa') {
          const now = Date.now();
          const ok = [-30_000, 0, 30_000].some((d) => totp(SECRETS.totpSecret!, now + d) === body.get('otc'));
          return ok ? redirect('/home') : html(200, codePage());
        }
        html(404, page('not found'));
      });
      return;
    }
    if (u.pathname === '/login') return html(200, loginPage());
    if (u.pathname === '/send') return html(200, page(sendForm(mode.sendAction)));
    if (u.pathname === '/mfa') return html(200, codePage());
    if (u.pathname === '/home') return html(200, page('<h1>Welcome</h1>'));
    html(404, page('not found'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { mode = { after: '/send' }; posts = []; });

const policy = (): PortalPolicy => ({
  startUrl: `${origin}/login`,
  navHosts: [host],
  subresourceHosts: [],
  login: ['/login', '/send', '/mfa'].map((path) => ({ host, path })),
  allowedSubmits: [],
  allowPrivateNetwork: true,
});

const SEND = { role: 'button', name: 'Send me the code' } as const;
function signIn(via: boolean, source: 'seed' | 'workflow' = 'seed', timeoutMs = 3000): Step {
  return {
    intent: 'Sign in',
    timeoutMs,
    signIn: {
      username: { label: 'Email' },
      password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' }, source, ...(via ? { via: [SEND] } : {}) },
    },
  } as Step;
}

let session: Session;
/** Also records when each button was clicked, by its text, on the page's own clock. */
async function at(secrets: PortalSecrets = SECRETS): Promise<{ ctx: StepContext; clicks: { text: string; at: number }[] }> {
  session = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  const clicks: { text: string; at: number }[] = [];
  await session.page.exposeFunction('__clicked', (text: string, when: number) => { clicks.push({ text, at: when }); });
  await session.page.addInitScript(() => {
    document.addEventListener('click', (e) => {
      const b = (e.target as Element).closest('button');
      if (b) void (window as unknown as { __clicked: (t: string, w: number) => void }).__clicked(b.textContent ?? '', Date.now());
    }, true);
  });
  await session.page.goto(`${origin}/login`);
  const ctx: StepContext = {
    page: session.page, script: { startUrl: `${origin}/login`, steps: [] }, policy: policy(), secrets, vars: {},
    masker: createMasker([secrets.username, secrets.password, secrets.totpSecret]), defaultTimeoutMs: 3000, violations: session.violations,
  };
  return { ctx, clicks };
}
const paths = () => posts.map((p) => p.path);

describe('signIn totp.via buttons are gated', () => {
  it('a via button in the form that holds the password is refused before it is clicked', async () => {
    mode.script = 'spa';
    const { ctx, clicks } = await at();
    try {
      const r = await runSteps(ctx, [signIn(true)]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('signIn refused: the via button is in a form with a password field');
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${origin}/login`, fatal: true });
      expect(clicks.map((c) => c.text)).toEqual(['Sign in']);
      expect(posts).toEqual([]);
    } finally { await session.close(); }
  });

  it('a via button that posts off the declared login pages is refused before it is clicked', async () => {
    mode.sendAction = '/elsewhere/send';
    const { ctx, clicks } = await at();
    try {
      const r = await runSteps(ctx, [signIn(true)]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('signIn refused: the via button does not post to a declared login page');
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${origin}/elsewhere/send`, fatal: true });
      expect(clicks.map((c) => c.text)).toEqual(['Sign in']);
      expect(paths()).toEqual(['/login']);
    } finally { await session.close(); }
  });

  it('a via button is not clicked while the password field still shows', async () => {
    mode.script = 'stay';
    const { ctx, clicks } = await at();
    try {
      const r = await runSteps(ctx, [signIn(true, 'seed', 2000)]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(signInCodeFieldMissing(2, 0, 1));
      expect(await ctx.page.getByRole('button', { name: 'Send me the code' }).isVisible()).toBe(true);
      expect(clicks.map((c) => c.text)).toEqual(['Sign in']);
      expect(posts).toEqual([]);
    } finally { await session.close(); }
  });

  it('a via button on the page that rejected the password is not clicked', async () => {
    const { ctx, clicks } = await at({ ...SECRETS, password: 'wrong-password' });
    try {
      const r = await runSteps(ctx, [signIn(true, 'seed', 10_000)]);
      expect(r.ok).toBe(true);
      expect(await ctx.page.getByRole('button', { name: 'Send me the code' }).isVisible()).toBe(true);
      expect(clicks.map((c) => c.text)).toEqual(['Sign in']);
      expect(paths()).toEqual(['/login']);
    } finally { await session.close(); }
  });

  it('a via button on a login page, in a form without a password field, is clicked and the sign-in completes', async () => {
    const { ctx, clicks } = await at();
    try {
      const r = await runSteps(ctx, [signIn(true)]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${origin}/home`);
      expect(clicks.map((c) => c.text)).toEqual(['Sign in', 'Send me the code', 'Verify']);
      expect(paths()).toEqual(['/login', '/send', '/mfa']);
      expect(ctx.violations).toEqual([]);
    } finally { await session.close(); }
  });
});

describe('the code provider\'s requestedAt', () => {
  const NO_SEED: PortalSecrets = { username: SECRETS.username, password: SECRETS.password };

  it('with via: stamped no later than the via click that makes the site send the code', async () => {
    const { ctx, clicks } = await at(NO_SEED);
    const asked: CodeRequest[] = [];
    ctx.codeProvider = async (req) => { asked.push(req); return totp(SECRETS.totpSecret!); };
    try {
      const r = await runSteps(ctx, [signIn(true, 'workflow')]);
      expect(r.ok).toBe(true);
      expect(asked).toHaveLength(1);
      const send = clicks.find((c) => c.text === 'Send me the code')!;
      const signInAt = clicks.find((c) => c.text === 'Sign in')!.at;
      expect(Date.parse(asked[0].requestedAt)).toBeLessThanOrEqual(send.at);
      // Stamped at the via click, not at the password submit.
      expect(Date.parse(asked[0].requestedAt)).toBeGreaterThanOrEqual(signInAt);
    } finally { await session.close(); }
  });

  it('without via: stamped no later than the password submit', async () => {
    mode.after = '/mfa';
    const { ctx, clicks } = await at(NO_SEED);
    const asked: CodeRequest[] = [];
    ctx.codeProvider = async (req) => { asked.push(req); return totp(SECRETS.totpSecret!); };
    try {
      const r = await runSteps(ctx, [signIn(false, 'workflow')]);
      expect(r.ok).toBe(true);
      expect(asked).toHaveLength(1);
      expect(Date.parse(asked[0].requestedAt)).toBeLessThanOrEqual(clicks.find((c) => c.text === 'Sign in')!.at);
    } finally { await session.close(); }
  });
});
