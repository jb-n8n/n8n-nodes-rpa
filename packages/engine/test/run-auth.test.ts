import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import { runTask } from '../src/lane/task.js';
import type { PortalSecrets, Script, Step } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { baselineScript, LOCAL, policyFor, SECRETS, SIGN_IN_STEPS, signedLaneInput } from './helpers.js';
import { bound } from './timing.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

async function atLogin(secrets: PortalSecrets = SECRETS): Promise<StepContext> {
  const script = baselineScript(portal.url);
  session = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker: createMasker([]) });
  await installInterrupts(session.page, script.interrupts);
  await session.page.goto(`${portal.url}/acme/login`);
  return {
    page: session.page, script, policy: policyFor(portal), secrets, vars: {},
    masker: createMasker([secrets.username, secrets.password, secrets.totpSecret]), defaultTimeoutMs: 3000, violations: session.violations,
  };
}
const OPEN_SERVICE: Step = { intent: 'Open Service', click: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' } } };

describe('signIn / detect / interrupts', () => {
  it('signs in with no MFA', async () => {
    const ctx = await atLogin();
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
      expect(r.state.detected.afterLogin).toBe('logged_in');
    } finally { await session.close(); }
  });
  it('signs in through TOTP MFA', async () => {
    portal.setState({ mfa: 'totp' });
    const ctx = await atLogin();
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
    } finally { await session.close(); }
  });
  it('reports TOTP MFA without a secret as detected:mfa_totp, and says the Site Login has no TOTP Secret', async () => {
    portal.setState({ mfa: 'totp' });
    const ctx = await atLogin({ username: SECRETS.username, password: SECRETS.password });
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('detected:mfa_totp: the site asked for a one-time code and the Site Login has no TOTP Secret');
    } finally { await session.close(); }
  });
  it('detects SMS MFA and failed logins', async () => {
    portal.setState({ mfa: 'sms' });
    let ctx = await atLogin();
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      if (!r.ok) expect(r.failure.message).toBe('detected:mfa_sms'); else throw new Error('expected failure');
    } finally { await session.close(); }
    portal.reset();
    ctx = await atLogin({ ...SECRETS, password: 'wrong-pass-123' });
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      if (!r.ok) {
        expect(r.failure.message).toBe('detected:login_failed: the site sent the sign-in page back');
        expect(JSON.stringify(r)).not.toContain('wrong-pass-123');
      } else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('refuses to sign in on a page that is not a declared login page', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.goto(`${portal.url}/acme/p/ws?ticket=abc`);
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(`signIn refused: ${new URL(portal.url).host}/acme/p/ws is not listed in the Site Login under Pages Where the Password May Be Typed`);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
    } finally { await session.close(); }
  });
  it('refuses a username field in a frame of a page that is not listed, and names that page', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.evaluate((src) => new Promise<void>((done) => {
        const f = document.createElement('iframe');
        f.onload = () => { f.contentDocument!.body.innerHTML = '<input id="u" type="text">'; done(); };
        f.src = src;
        document.body.appendChild(f);
      }), `${portal.url}/acme/p/ws?ticket=abc`);
      const step: Step = { intent: 'Sign in', signIn: { ...(SIGN_IN_STEPS[0] as Extract<Step, { signIn: unknown }>).signIn, username: { css: '#u', frame: 'iframe' } } };
      const r = await runSteps(ctx, [step]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(`signIn refused: the username field is on ${new URL(portal.url).host}/acme/p/ws, which is not listed in the Site Login under Pages Where the Password May Be Typed.`);
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${portal.url}/acme/p/ws`, fatal: true });
    } finally { await session.close(); }
  });
  it('submits credentials only once per run', async () => {
    const ctx = await atLogin();
    try {
      let posts = 0;
      ctx.page.on('request', (rq) => { if (rq.method() === 'POST' && rq.url().includes('/login')) posts++; });
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0], { ...SIGN_IN_STEPS[0], intent: 'Sign in again' }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('signIn refused: credentials were already submitted in this run');
      expect(posts).toBe(1);
    } finally { await session.close(); }
  });
  it('refuses when the login form posts off the declared login pages', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.evaluate(() => { (document.querySelector('form') as HTMLFormElement).action = 'http://127.0.0.1:1/login/user?session=abc#x'; });
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      // The form's target, not the page, is what is missing: the message names it (host and path, no query) and the setting.
      if (!r.ok) expect(r.failure.message).toBe("signIn refused: the username field's form posts to 127.0.0.1:1/login/user, which is not listed in the Site Login under Pages Where the Password May Be Typed. Add 127.0.0.1:1/login/user there: the address bar never shows where a form posts.");
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: 'http://127.0.0.1:1/login/user', fatal: true });
    } finally { await session.close(); }
  });
  it('refuses a Sign in button that posts off the declared login pages, before it is clicked', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.evaluate(() => { document.querySelector('form button[type=submit], form input[type=submit], form button')!.setAttribute('formaction', '/acme/elsewhere'); });
      let posts = 0;
      ctx.page.on('request', (rq) => { if (rq.method() === 'POST') posts++; });
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(`signIn refused: the submit button posts to ${new URL(portal.url).host}/acme/elsewhere, which is not listed in the Site Login under Pages Where the Password May Be Typed`);
      expect(ctx.violations).toContainEqual({ kind: 'signin', url: `${portal.url}/acme/elsewhere`, fatal: true });
      expect(posts).toBe(0);
      expect(r.state.submitClicked).toBe(false);
    } finally { await session.close(); }
  });
  it('refuses a username locator that is not a text input', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.evaluate(() => { const t = document.createElement('textarea'); t.id = 'ta'; document.querySelector('form')!.appendChild(t); });
      const bad: Step = { intent: 'Sign in', signIn: { username: { css: '#ta' }, password: { css: 'input[type=password]' }, submit: { css: '#sign-in' } } };
      const r = await runSteps(ctx, [bad]);
      if (!r.ok) expect(r.failure.message).toMatch(/not a text input/); else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('refuses a password locator that is not a password input', async () => {
    const ctx = await atLogin();
    try {
      const bad: Step = { intent: 'Sign in', signIn: { username: { css: '#username' }, password: { css: '#username' }, submit: { css: '#sign-in' } } };
      const r = await runSteps(ctx, [bad]);
      if (!r.ok) expect(r.failure.message).toMatch(/not a password input/); else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('dismisses the cookie banner and what-is-new modal, and skips the survey', async () => {
    portal.setState({ interrupts: ['cookie-banner', 'whats-new-modal', 'survey'] });
    const ctx = await atLogin();
    try {
      const r = await runSteps(ctx, [...SIGN_IN_STEPS, OPEN_SERVICE]);
      expect(r.ok).toBe(true);
      expect(r.state.log[1].status).toBe('ok');
      expect(ctx.page.url()).toContain('/acme/service');
    } finally { await session.close(); }
  });
  it('pauses overlay handlers while typing credentials, so a handler cannot submit the form early', async () => {
    const ctx = await atLogin();
    try {
      ctx.script = { ...ctx.script, interrupts: [{ target: { css: '#promo' }, click: { role: 'button' } }] };
      ctx.interrupts = await installInterrupts(ctx.page, ctx.script.interrupts);
      // An overlay that appears once the username is typed; its handler's first-match click is the Sign in button.
      await ctx.page.evaluate(() => {
        document.getElementById('username')!.addEventListener('input', () => {
          if (document.getElementById('promo')) return;
          const d = document.createElement('div');
          d.id = 'promo';
          d.textContent = 'Save your dealer user ID?';
          document.body.append(d);
        });
      });
      let posts = 0;
      ctx.page.on('request', (rq) => { if (rq.method() === 'POST' && rq.url().endsWith('/acme/login')) posts++; });
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
      expect(posts).toBe(1);
    } finally { await session.close(); }
  });
  it('reports a rejected password quickly even when a TOTP step is declared', async () => {
    const ctx = await atLogin({ ...SECRETS, password: 'wrong-pass-123' });
    try {
      const t0 = Date.now();
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, SIGN_IN_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('detected:login_failed: the site sent the sign-in page back');
      expect(Date.now() - t0).toBeLessThan(bound(2500));
    } finally { await session.close(); }
  });
});

// A hand-written sign-in with no detect step after it: signIn itself tells a rejected password from a sign-in that
// went through, by looking at its own password field once the submit has settled.
const HAND_SIGN_IN: Step = {
  intent: 'Sign in',
  signIn: { username: { label: 'Dealer user ID' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Sign in' } },
};
const WRONG = 'wrong-pass-123';

describe('signIn reports a rejected password itself', () => {
  it('a rejected password fails the signIn step as detected:login_failed, without the password in the result', async () => {
    const ctx = await atLogin({ ...SECRETS, password: WRONG });
    try {
      const t0 = Date.now();
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure).toEqual({ index: 0, intent: 'Sign in', message: 'detected:login_failed: the site sent the sign-in page back' });
      expect(r.state.submitClicked).toBe(true);
      expect(portal.state().logins).toBe(1);
      expect(Date.now() - t0).toBeLessThan(bound(2500));
      expect(JSON.stringify(r)).not.toContain(WRONG);
    } finally { await session.close(); }
  });
  it('with a detect step that checks login_failed after it, the signIn step raises the one login_failed', async () => {
    const ctx = await atLogin({ ...SECRETS, password: WRONG });
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure).toEqual({ index: 0, intent: 'Sign in', message: 'detected:login_failed: the site sent the sign-in page back' });
      expect(r.state.log.map((e) => e.status)).toEqual(['failed']);
      expect(portal.state().logins).toBe(1);
    } finally { await session.close(); }
  });
  it('a page that re-renders the password field with an error, without a navigation, is a rejected password', async () => {
    const ctx = await atLogin({ ...SECRETS, password: WRONG });
    try {
      // A script-driven login form: the submit is handled in the page, which then renders a new form with an error.
      await ctx.page.evaluate(() => {
        const form = document.querySelector('form')!;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          setTimeout(() => {
            form.innerHTML = '<p id="login-error">Invalid username or password.</p>'
              + '<label for="username">Dealer user ID</label><input id="username">'
              + '<label for="password">Password</label><input id="password" type="password">'
              + '<button id="sign-in" type="submit">Sign in</button>';
          }, 300);
        });
      });
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('detected:login_failed: the site sent the sign-in page back');
    } finally { await session.close(); }
  });
  it('a correct password on a one-page sign-in passes at once', async () => {
    const ctx = await atLogin();
    try {
      const t0 = Date.now();
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${portal.url}/acme/home`);
      expect(Date.now() - t0).toBeLessThan(bound(2000));
    } finally { await session.close(); }
  });
  it('a slow sign-in that leaves the login page about 1.5 s after the submit is not a rejection', async () => {
    portal.setState({ slowLogin: true });
    const ctx = await atLogin();
    try {
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${portal.url}/acme/home`);
    } finally { await session.close(); }
  });
  it('a site that asks for a code after the password (no code step declared) is not a rejection: the password field is gone', async () => {
    portal.setState({ mfa: 'totp' });
    const ctx = await atLogin();
    try {
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${portal.url}/acme/mfa`);
    } finally { await session.close(); }
  });
  it('a good sign-in that redraws the password field with its value still in it, for over a second, is not a rejection', async () => {
    const ctx = await atLogin();
    try {
      // A script-driven form: on submit it draws a new form that still holds the typed values (a pending state), and
      // posts that form 1.5 s later. A rejected password comes back as an empty field; this one is not empty.
      await ctx.page.evaluate(() => {
        const form = document.querySelector('form')!;
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const user = (form.querySelector('#username') as HTMLInputElement).value;
          const pass = (form.querySelector('#password') as HTMLInputElement).value;
          const next = document.createElement('form');
          next.method = 'post';
          next.action = form.action;
          next.innerHTML = '<p>Signing you in...</p><label for="username">Dealer user ID</label><input id="username" name="username">'
            + '<label for="password">Password</label><input id="password" name="password" type="password">';
          form.replaceWith(next);
          (next.querySelector('#username') as HTMLInputElement).value = user;
          (next.querySelector('#password') as HTMLInputElement).value = pass;
          setTimeout(() => next.submit(), 1500);
        });
      });
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(3000) }, [HAND_SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toBe(`${portal.url}/acme/home`);
      expect(portal.state().logins).toBe(1);
    } finally { await session.close(); }
  });
  it('a submit that leaves the same password field on the page is not a rejection', async () => {
    const ctx = await atLogin();
    try {
      // Nothing is posted and the page does not change: no evidence of a rejection, so the step passes after its wait.
      await ctx.page.evaluate(() => { document.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault()); });
      const r = await runSteps({ ...ctx, defaultTimeoutMs: bound(2000) }, [HAND_SIGN_IN]);
      expect(r.ok).toBe(true);
      expect(portal.state().logins).toBe(0);
    } finally { await session.close(); }
  });
  it('a rejected password ends the run as login_failed on the script lane, with no repair even with a model', async () => {
    const model = fakeModel([]);
    const script = {
      name: 'hand-written', version: 1, startUrl: `${portal.url}/acme/login`,
      steps: [
        HAND_SIGN_IN,
        { intent: 'Open the notices', goto: `${portal.url}/acme/service/recalls-and-stop-sales` },
        { intent: 'Read notices', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } },
      ],
    } as Script;
    const task = (password: string) => ({
      ...signedLaneInput(script, { policy: policyFor(portal), secrets: { ...SECRETS, password }, output: { idPattern: 'N26-\\d{4}' }, endpoint: LOCAL, defaultStepTimeoutMs: 3000 }),
      repair: { model, goal: 'Read the notices' },
    });
    // The same steps sign in and read with the right password.
    expect(await runTask(task(SECRETS.password))).toMatchObject({ ok: true, lane: 'script' });
    portal.reset();
    const r = await runTask(task(WRONG));
    expect(r).toMatchObject({ ok: false, code: 'login_failed', lane: 'script', failure: { index: 0, intent: 'Sign in' } });
    expect(model.invocations).toHaveLength(0);
    expect(portal.state().logins).toBe(1);
    expect(JSON.stringify(r)).not.toContain(WRONG);
  });
});
