import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import type { Page } from 'playwright-core';
import { offListSite, PASSWORD_FILL_REFUSED_STEPS, SIGNIN_NEEDS_SITE_LOGIN } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS, SIGN_IN_STEPS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(async () => { portal.reset(); });

async function ctxFor(): Promise<StepContext> {
  session = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker: createMasker([]) });
  await session.page.goto(`${portal.url}/acme/login`);
  // renderVars rejects literal secrets, so disable only that guard here; mask() still scrubs messages.
  const masker = { ...createMasker(['demo-password']), containsSecret: () => false };
  return {
    page: session.page, script: baselineScript(portal.url), policy: policyFor(portal), secrets: SECRETS,
    vars: { dealer: 'SM-7702' }, masker, defaultTimeoutMs: 3000, violations: session.violations,
  };
}

/** Signs in with plain page actions, not steps: the fill verb refuses password fields. */
async function logIn(page: Page): Promise<void> {
  await page.fill('#username', 'summit-ops');
  await page.fill('#password', 'demo-password');
  await page.click('#sign-in');
  await page.waitForSelector('body[data-page=home]');
}

describe('masking around URL shortening', () => {
  it('a secret with a space and a non-ASCII character in a failing goto path is masked raw and encoded', async () => {
    const secret = 'pass wörd';
    const dead = '127.0.0.1:1';
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), navHosts: [portal.host, dead] }, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const masker = { ...createMasker([secret]), containsSecret: () => false };
      const steps: Step[] = [{ intent: 'Open', goto: `http://${dead}/a/${secret}/b?token=abc` }];
      const r = await runSteps({
        page: s.page, script: baselineScript(portal.url), policy: { ...policyFor(portal), navHosts: [portal.host, dead] }, vars: {}, masker,
        defaultTimeoutMs: 3000, violations: s.violations,
      }, steps);
      if (r.ok) throw new Error('expected failure');
      const shown = [r.failure.message, ...r.state.log.map((e) => e.note ?? '')];
      for (const text of shown) {
        expect(text).toContain(`http://${dead}/a/[secret]/b`);
        for (const form of [secret, encodeURIComponent(secret), encodeURI(secret), 'w%C3%B6rd', 'wörd', '?', 'token=abc']) expect(text).not.toContain(form);
      }
    } finally { await s.close(); }
  });
});

describe('runSteps basics', () => {
  it('navigates, checks expectations and records checkpoints after signing in', async () => {
    const ctx = await ctxFor();
    try {
      await logIn(ctx.page);
      const r = await runSteps(ctx, [
        { intent: 'Service', click: { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' } } },
        { intent: 'Notices', click: { role: 'link', name: 'Recalls & Stop-Sales' }, expect: { heading: 'Recalls & Stop-Sales', url: '/acme/service/' }, checkpoint: true },
        { intent: 'Rows', waitFor: { target: { css: '#notices-table tr' }, minCount: 8 } },
      ]);
      expect(r.ok).toBe(true);
      expect(r.state.lastCheckpoint).toBe(1);
      expect(r.state.log.map((l) => l.status)).toEqual(['ok', 'ok', 'ok']);
    } finally { await session.close(); }
  });
  it('skips when-steps whose element is absent and optional steps that fail', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        { intent: 'Maybe banner', when: { visible: { css: '#cookie-overlay' } }, click: { css: '#cookie-overlay button' } },
        { intent: 'Optional', optional: true, timeoutMs: 300, click: { css: '#does-not-exist' } },
        { intent: 'User', fill: { field: { css: '#username' }, value: 'summit-ops' } },
      ]);
      expect(r.ok).toBe(true);
      expect(r.state.log.map((l) => l.status)).toEqual(['skipped', 'skipped', 'ok']);
    } finally { await session.close(); }
  });
  it('resolves relative gotos with inputs and fails with a masked message', async () => {
    const ctx = await ctxFor();
    try {
      await logIn(ctx.page);
      const r = await runSteps(ctx, [
        { intent: 'Go to service with dealer', goto: '/acme/service?dealer={{var.dealer}}' },
        { intent: 'Find the password', timeoutMs: 300, click: { css: 'a[title="demo-password"]' } },
      ]);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(session.page.url()).toContain('dealer=SM-7702');
      expect(r.failure).toMatchObject({ index: 1, intent: 'Find the password' });
      expect(r.failure.message).not.toContain('demo-password');
      expect(r.failure.message).toContain('[secret]');
    } finally { await session.close(); }
  });
  it('the fill verb refuses a password field with a fatal sign-in violation, before typing', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [{ intent: 'Password', fill: { field: { css: '#password' }, value: 'not-the-password' } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(PASSWORD_FILL_REFUSED_STEPS);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
      expect(await session.page.inputValue('#password')).toBe('');
    } finally { await session.close(); }
  });
  it('fails clearly for a verb without a handler yet', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [{ intent: 'Popup', popup: { trigger: { css: 'a' } } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toMatch(/has no handler|No element found/);
    } finally { await session.close(); }
  });
  it('blocks a goto to a host outside the allowlist and records a fatal violation', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [{ intent: 'Evil', goto: 'https://evil.example/x' }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(offListSite('evil.example', [portal.host]));
      expect(ctx.violations.some((v) => v.kind === 'host' && v.fatal)).toBe(true);
    } finally { await session.close(); }
  });
  it('stops on a fatal violation even when the step is optional', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        { intent: 'Evil', optional: true, goto: 'https://evil.example/x' },
        { intent: 'Home', goto: '/acme/login' },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.failure).toMatchObject({ index: 0, message: offListSite('evil.example', [portal.host]) });
        expect(r.state.log).toHaveLength(1);
        expect(r.state.log[0].status).toBe('failed');
      }
    } finally { await session.close(); }
  });
  it('signIn without a Site Login is refused with a fatal violation', async () => {
    const ctx = { ...(await ctxFor()), secrets: undefined };
    try {
      const r = await runSteps(ctx, [SIGN_IN_STEPS[0]]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(SIGNIN_NEEDS_SITE_LOGIN);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
    } finally { await session.close(); }
  });
});
