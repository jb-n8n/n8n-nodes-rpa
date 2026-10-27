// A two-page (identity-first) signIn. The username page posts to a password page with `next`; every
// check of the one-page sign-in is re-run on the second page, and a rejected username or an undeclared second page stops
// the run before the password is typed. A tiny local identity provider plays the site.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { openSession, type Session } from '../src/browser/session.js';
import { SIGNIN_NEXT_NO_PASSWORD } from '../src/messages.js';
import { runTask } from '../src/lane/task.js';
import { fakeModel } from './fake-model.js';
import { validateScript } from '../src/policy/validate.js';
import { describeStep } from '../src/proposal/describe.js';
import { createMasker } from '../src/secrets/mask.js';
import { totp } from '../src/secrets/totp.js';
import { parseScript } from '../src/steps/parse.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, PortalSecrets, Step } from '../src/types.js';
import { LOCAL, SECRETS, signedLaneInput } from './helpers.js';
import { bound } from './timing.js';

type Mode = {
  next: '/password' | '/elsewhere/password'; mfa: boolean;
  /** A formaction on the Next button or on the password page's Sign in button. */
  nextFormaction?: string; submitFormaction?: string;
  /** The password page echoes the email in a read-only Email field and renders the password field after 1.5 s. */
  echo?: boolean;
};
let mode: Mode;
let posts: { path: string; body: URLSearchParams }[];
let server: Server;
let origin: string;
let host: string;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string, attrs = '') => `<!doctype html><html><head><title>Sign in</title></head><body ${attrs}>${body}</body></html>`;
const emailPage = (error = '') => page(
  `<form method="post" action="/login" novalidate><label for="email">Email</label><input id="email" name="loginfmt" type="email">`
  + `${error ? `<p id="error">${esc(error)}</p>` : ''}<button type="submit"${mode.nextFormaction ? ` formaction="${mode.nextFormaction}"` : ''}>Next</button></form>`,
);
const passwordPage = (action: string, email: string) => page(
  `<form method="post" action="${action}">`
  + (mode.echo ? `<label for="who">Email</label><input id="who" readonly value="${esc(email)}">` : `<p id="who">${esc(email)}</p>`)
  + `<div id="pwbox"${mode.echo ? ' hidden' : ''}><label for="pw">Password</label><input id="pw" name="passwd" type="password"></div>`
  + `<button type="submit"${mode.submitFormaction ? ` formaction="${mode.submitFormaction}"` : ''}>Sign in</button></form>`
  + (mode.echo ? `<script>setTimeout(() => { document.getElementById('pwbox').hidden = false; }, 1500);</script>` : ''),
);
const codePage = () => page(`<form method="post" action="/mfa"><label for="code">Code</label><input id="code" name="otc"><button type="submit">Verify</button></form>`);
// The test username is not an email address: the forms skip the browser's own validation (novalidate), as identity providers do.
// One document for both steps, as single-page identity forms do: Next hides the email (it stays in the DOM) and shows the password.
const spaPage = () => page(`
  <form id="f" method="post" action="/password" novalidate>
    <div id="step1"><label for="email">Email</label><input id="email" name="loginfmt" type="email"><button type="button" id="next">Next</button></div>
    <div id="step2" hidden><label for="pw">Password</label><input id="pw" name="passwd" type="password"><button type="submit">Sign in</button></div>
  </form>
  <script>
    document.getElementById('next').addEventListener('click', () => setTimeout(() => {
      document.getElementById('step1').style.display = 'none';
      document.getElementById('step2').hidden = false;
    }, 300));
  </script>`);

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
          if (body.get('loginfmt') !== SECRETS.username) return html(200, emailPage("We couldn't find an account with that username."));
          return redirect(`${mode.next}?email=${encodeURIComponent(SECRETS.username)}`);
        }
        if (u.pathname === '/password' || u.pathname === '/elsewhere/password') {
          if (body.get('passwd') !== SECRETS.password) return html(200, passwordPage(u.pathname, SECRETS.username));
          return redirect(mode.mfa ? '/mfa' : '/home');
        }
        if (u.pathname === '/mfa') {
          const now = Date.now();
          const ok = [-30_000, 0, 30_000].some((d) => totp(SECRETS.totpSecret!, now + d) === body.get('otc'));
          return ok ? redirect('/home') : html(200, codePage());
        }
        html(404, page('not found'));
      });
      return;
    }
    if (u.pathname === '/login') return html(200, emailPage());
    if (u.pathname === '/spa') return html(200, spaPage());
    if (u.pathname === '/password' || u.pathname === '/elsewhere/password') return html(200, passwordPage(u.pathname, u.searchParams.get('email') ?? ''));
    if (u.pathname === '/mfa') return html(200, codePage());
    if (u.pathname === '/home') return html(200, page('<h1>Welcome</h1><main>N-1001</main>', 'data-page="home"'));
    html(404, page('not found'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  origin = `http://${host}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => { mode = { next: '/password', mfa: false }; posts = []; });

const policy = (): PortalPolicy => ({
  startUrl: `${origin}/login`,
  navHosts: [host],
  subresourceHosts: [],
  login: ['/login', '/password', '/mfa', '/spa'].map((path) => ({ host, path })),
  allowedSubmits: [],
  allowPrivateNetwork: true,
});

const SIGN_IN: Step = {
  intent: 'Sign in',
  signIn: {
    username: { label: 'Email' },
    next: { role: 'button', name: 'Next' },
    password: { label: 'Password' },
    submit: { role: 'button', name: 'Sign in' },
  },
};
const WITH_CODE: Step = {
  intent: 'Sign in',
  signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } } },
};

let session: Session;
async function at(path: string, secrets: PortalSecrets = SECRETS): Promise<StepContext> {
  session = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  await session.page.goto(`${origin}${path}`);
  return {
    page: session.page, script: { startUrl: `${origin}/login`, steps: [] }, policy: policy(), secrets, vars: {},
    masker: createMasker([secrets.username, secrets.password, secrets.totpSecret]), defaultTimeoutMs: 3000, violations: session.violations,
  };
}

describe('signIn with next', () => {
  it('a two-page sign-in fills the username, clicks next, then fills the password', async () => {
    const ctx = await at('/login');
    try {
      const state = newRunState();
      const r = await runSteps(ctx, [SIGN_IN], state);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${origin}/home`);
      expect(posts.map((p) => p.path)).toEqual(['/login', '/password']);
      expect(posts[0].body.get('loginfmt')).toBe(SECRETS.username);
      expect(posts[0].body.has('passwd')).toBe(false);
      expect(posts[1].body.get('passwd')).toBe(SECRETS.password);
      expect(state.credentialsSubmitted).toBe(true);
      expect(state.submitClicked).toBe(true);
      expect(ctx.violations).toEqual([]);
    } finally { await session.close(); }
  });

  it('on a single-page identity form, the username stays in the page hidden while the password appears', async () => {
    const ctx = await at('/spa');
    try {
      const spa: Step = { intent: 'Sign in', signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, next: { css: '#next' } } };
      const r = await runSteps(ctx, [spa]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${origin}/home`);
      expect(posts.map((p) => p.path)).toEqual(['/password']);
      expect(posts[0].body.get('loginfmt')).toBe(SECRETS.username);
      expect(posts[0].body.get('passwd')).toBe(SECRETS.password);
    } finally { await session.close(); }
  });

  it('next to an undeclared page stops before the password', async () => {
    mode.next = '/elsewhere/password';
    const ctx = await at('/login');
    try {
      const state = newRunState();
      const r = await runSteps(ctx, [SIGN_IN], state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(`signIn refused: ${host}/elsewhere/password is not a declared login page`);
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${origin}/elsewhere/password`, fatal: true });
      expect(ctx.page.url()).toContain('/elsewhere/password');
      // The password was never typed: not posted, and not in the field.
      expect(posts.map((p) => p.path)).toEqual(['/login']);
      expect(await ctx.page.locator('#pw').inputValue()).toBe('');
      expect(state.submitClicked).toBe(false);
    } finally { await session.close(); }
  });

  it('a rejected username stops before the password', async () => {
    const ctx = await at('/login', { ...SECRETS, username: 'nobody@example.com' });
    try {
      const state = newRunState();
      const t0 = Date.now();
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [SIGN_IN], state);
      expect(r.ok).toBe(false);
      // A username the site does not know is a rejected login (it trips the login breaker), not drift.
      if (!r.ok) expect(r.failure.message).toBe('detected:login_failed');
      // The re-rendered username page is recognised without waiting for the whole step timeout.
      expect(Date.now() - t0).toBeLessThan(bound(2900));
      expect(posts.map((p) => p.path)).toEqual(['/login']);
      expect(ctx.violations).toEqual([]);
      expect(state.credentialsSubmitted).toBe(true);
      // Next is not the credentials' submit: a failure before the password is submitted is not a rejected login.
      expect(state.submitClicked).toBe(false);
    } finally { await session.close(); }
  });

  it('a rejected username fails the run as login_failed in the script lane, with no repair even with a model', async () => {
    const model = fakeModel([]);
    const script = { name: 'two-page', version: 1, startUrl: `${origin}/login`, steps: [SIGN_IN, { intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N-\\d+' } }] };
    // The same steps sign in and read with the right username.
    const good = await runTask({ ...signedLaneInput(script, { policy: policy(), secrets: SECRETS, output: { idPattern: 'N-\\d+' }, endpoint: LOCAL, defaultStepTimeoutMs: 3000 }), repair: { model, goal: 'Read the rows' } });
    expect(good).toMatchObject({ ok: true, lane: 'script' });
    posts = [];
    const r = await runTask({
      ...signedLaneInput(script, { policy: policy(), secrets: { ...SECRETS, username: 'nobody@example.com' }, output: { idPattern: 'N-\\d+' }, endpoint: LOCAL, defaultStepTimeoutMs: 3000 }),
      repair: { model, goal: 'Read the rows' },
    });
    expect(r).toMatchObject({ ok: false, code: 'login_failed', lane: 'script' });
    expect(model.invocations).toHaveLength(0);
    expect(posts.map((p) => p.path)).toEqual(['/login']);
    expect(JSON.stringify(r)).not.toContain('nobody@example.com');
  });

  it('a Next button that is not on the page fails before anything is typed', async () => {
    const ctx = await at('/login');
    try {
      const state = newRunState();
      const renamed: Step = { intent: 'Sign in', signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, next: { role: 'button', name: 'Continue' } } };
      const r = await runSteps(ctx, [renamed], state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toMatch(/No element found for Role and Name button "Continue"/);
      expect(state.credentialsSubmitted).toBe(false);
      expect(await ctx.page.locator('#email').inputValue()).toBe('');
      expect(posts).toEqual([]);
      expect(ctx.violations).toEqual([]);
    } finally { await session.close(); }
  });

  it('a Next button that posts off the declared login pages is refused before it is clicked', async () => {
    mode.nextFormaction = '/elsewhere';
    const ctx = await at('/login');
    try {
      const r = await runSteps(ctx, [SIGN_IN]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('signIn refused: the next button does not post to a declared login page');
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${origin}/elsewhere`, fatal: true });
      expect(posts).toEqual([]);
    } finally { await session.close(); }
  });

  it('a Sign in button that posts off the declared login pages is refused before it is clicked', async () => {
    mode.submitFormaction = '/elsewhere';
    const ctx = await at('/login');
    try {
      const state = newRunState();
      const r = await runSteps(ctx, [SIGN_IN], state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('signIn refused: the submit button does not post to a declared login page');
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${origin}/elsewhere`, fatal: true });
      expect(posts.map((p) => p.path)).toEqual(['/login']);
      expect(state.submitClicked).toBe(false);
    } finally { await session.close(); }
  });

  it('a password page that echoes the email read-only is not a rejected username', async () => {
    mode.echo = true;
    const ctx = await at('/login');
    try {
      const r = await runSteps(ctx, [SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${origin}/home`);
      expect(posts.map((p) => p.path)).toEqual(['/login', '/password']);
    } finally { await session.close(); }
  });

  it('a password field that never appears fails as drift with the timeout message', async () => {
    mode.echo = true;
    const ctx = await at('/login');
    try {
      // The password field shows after 1.5 s; a 1 s step timeout gives up first.
      const r = await runSteps({ ...ctx, defaultTimeoutMs: 1000 }, [SIGN_IN]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(SIGNIN_NEXT_NO_PASSWORD);
      expect(SIGNIN_NEXT_NO_PASSWORD).toBe('signIn: after Next the password field did not appear');
      expect(posts.map((p) => p.path)).toEqual(['/login']);
    } finally { await session.close(); }
  });

  it('next with a code step signs in', async () => {
    mode.mfa = true;
    const ctx = await at('/login');
    try {
      const r = await runSteps(ctx, [WITH_CODE]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${origin}/home`);
      expect(posts.map((p) => p.path)).toEqual(['/login', '/password', '/mfa']);
    } finally { await session.close(); }
  });

  it('parseScript and the schema accept next; templates in next are refused', () => {
    const doc = { startUrl: 'http://127.0.0.1:9999/login', steps: [WITH_CODE] };
    expect(parseScript(doc).steps[0]).toEqual(WITH_CODE);
    const schema = JSON.parse(readFileSync(new URL('../schema/steps.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema, 'steps.schema.json');
    const validate = ajv.getSchema('steps.schema.json')!;
    expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
    // A frame is refused on next as on the other signIn locators, by both.
    const framed = { ...doc, steps: [{ intent: 'Sign in', signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, next: { text: 'Next', frame: 'iframe' } } }] };
    expect(() => parseScript(framed)).toThrow(/signIn\.next cannot use frame/);
    expect(validate(framed)).toBe(false);
    const notLocator = { ...doc, steps: [{ intent: 'Sign in', signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, next: 'Next' } }] };
    expect(() => parseScript(notLocator)).toThrow(/signIn\.next/);
    expect(validate(notLocator)).toBe(false);
    const templated: Step = { intent: 'Sign in', signIn: { ...(SIGN_IN as Extract<Step, { signIn: unknown }>).signIn, next: { role: 'button', name: '{{var.next}}' } } };
    const v = validateScript({ startUrl: 'http://127.0.0.1:9999/login', steps: [templated] }, { policy: { ...policy(), navHosts: ['127.0.0.1:9999'] }, secrets: SECRETS, mode: 'load' });
    expect(v.violations).toContain('step "Sign in": signIn steps must not contain templates');
  });

  it('the change list shows next', () => {
    expect(describeStep(SIGN_IN)).toBe('Sign in (sign in with label "Email", next role "button" name "Next", label "Password", submit role "button" name "Sign in")');
    expect(describeStep(WITH_CODE)).toBe('Sign in (sign in with label "Email", next role "button" name "Next", label "Password", submit role "button" name "Sign in", code in label "Code", submit role "button" name "Verify")');
    // A one-page signIn reads exactly as before.
    const { next: _drop, ...onePage } = (SIGN_IN as Extract<Step, { signIn: unknown }>).signIn;
    expect(describeStep({ intent: 'Sign in', signIn: onePage })).toBe('Sign in (sign in with label "Email", label "Password", submit role "button" name "Sign in")');
  });
});
