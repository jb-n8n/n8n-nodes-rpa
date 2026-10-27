import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalSecrets, Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS, SIGN_IN_STEPS } from './helpers.js';
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
  it('reports TOTP MFA without a secret as detected:mfa_totp', async () => {
    portal.setState({ mfa: 'totp' });
    const ctx = await atLogin({ username: SECRETS.username, password: SECRETS.password });
    try {
      const r = await runSteps(ctx, SIGN_IN_STEPS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('detected:mfa_totp');
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
        expect(r.failure.message).toBe('detected:login_failed');
        expect(JSON.stringify(r)).not.toContain('wrong-pass-123');
      } else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('refuses to sign in on a page that is not a declared login page', async () => {
    const ctx = await atLogin();
    try {
      await ctx.page.goto(`${portal.url}/acme/p/ws`);
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toMatch(/signIn refused/);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
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
      await ctx.page.evaluate(() => { (document.querySelector('form') as HTMLFormElement).action = 'http://127.0.0.1:1/steal'; });
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toMatch(/signIn refused/);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
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
      if (!r.ok) expect(r.failure.message).toBe('signIn refused: the submit button does not post to a declared login page');
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
      expect(r.failure.message).toBe('detected:login_failed');
      expect(Date.now() - t0).toBeLessThan(bound(2500));
    } finally { await session.close(); }
  });
});
