import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import type { Page } from 'playwright-core';
import { INPUT_CONTAINS_SECRET, offListSite, PASSWORD_FILL_REFUSED_STEPS, SIGNIN_NEEDS_SITE_LOGIN } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { classifyFailure, shownFailure } from '../src/classify/classify.js';
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
  it('a value the field\'s type refuses (text in a date field) says which field and value, keeps the browser\'s text, and is not drift (IB-10)', async () => {
    const ctx = await ctxFor();
    try {
      await logIn(ctx.page);
      const r = await runSteps(ctx, [
        { intent: 'Open the reports', goto: '/acme/reports' },
        { intent: 'Type into From: "2026-09-01"', fill: { field: { label: 'From' }, value: 'first of September' } },
      ]);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure).toMatchObject({ index: 1, intent: 'Type into From: "2026-09-01"' });
      expect(r.failure.message).toMatch(/^the field "From" did not take the value "first of September": it does not fit that field, for example text in a date field \(browser: locator\.fill: .*Malformed value.*\)$/);
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('policy_violation');
      expect(shownFailure(r.failure.intent, r.failure.message, r.failure.index)).toMatch(/^Step 2 \(Type into From: "2026-09-01"\): the field "From" did not take the value "first of September"/);
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

describe('runSteps conditions', () => {
  const fillUser = (intent: string, when: Step['when'], value: string): Step => ({ intent, when, fill: { field: { css: '#username' }, value } });
  const notes = (r: Awaited<ReturnType<typeof runSteps>>) => r.state.log.map((l) => [l.status, l.note]);
  it('a step with when.hidden runs when the element is absent and is skipped when it shows', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        fillUser('No banner', { hidden: { css: '#cookie-overlay' } }, 'absent'),
        fillUser('User field gone', { hidden: { css: '#username' } }, 'shown'),
      ]);
      expect(r.ok).toBe(true);
      expect(notes(r)).toEqual([['ok', undefined], ['skipped', 'condition not met']]);
      expect(await session.page.inputValue('#username')).toBe('absent');
    } finally { await session.close(); }
  });
  it('a step with a variable condition runs when the variable equals the value and is skipped with "condition not met" when it does not', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        fillUser('Same value', { var: 'dealer', equals: 'SM-7702' }, 'equal'),
        fillUser('Other case', { var: 'dealer', equals: 'sm-7702' }, 'case differs'),
      ]);
      expect(r.ok).toBe(true);
      expect(notes(r)).toEqual([['ok', undefined], ['skipped', 'condition not met']]);
      expect(await session.page.inputValue('#username')).toBe('equal');
    } finally { await session.close(); }
  });
  it('notEquals is the reverse', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        fillUser('Not another value', { var: 'dealer', notEquals: 'SM-0000' }, 'differs'),
        fillUser('Not this value', { var: 'dealer', notEquals: 'SM-7702' }, 'same'),
      ]);
      expect(r.ok).toBe(true);
      expect(notes(r)).toEqual([['ok', undefined], ['skipped', 'condition not met']]);
      expect(await session.page.inputValue('#username')).toBe('differs');
    } finally { await session.close(); }
  });
  it('a variable condition is checked before the locators are rendered: a skipped step needs none of its own variables', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        { intent: 'Detail', when: { var: 'dealer', equals: 'other' }, click: { role: 'link', name: '{{var.detail}}' } },
        fillUser('After', undefined, 'ran'),
      ]);
      expect(r.ok).toBe(true);
      expect(notes(r)).toEqual([['skipped', 'condition not met'], ['ok', undefined]]);
      // An element condition still renders its locator first: an unset variable there fails as before.
      const e = await runSteps(ctx, [{ intent: 'Gate', when: { hidden: { text: '{{var.detail}}' } }, click: { css: '#x' } }]);
      expect(e.ok).toBe(false);
      if (!e.ok) expect(e.failure.message).toBe('missing input "detail"');
    } finally { await session.close(); }
  });
  it('a variable condition on a variable that holds a secret fill value is refused, never compared', async () => {
    const ctx = { ...(await ctxFor()), masker: createMasker(['demo-password']), vars: { a: 'Tr0ub4dor-77-x', b: 'Tr0ub4dor-77-x' } };
    try {
      const r = await runSteps(ctx, [
        fillUser('Gate', { var: 'b', equals: 'Tr0ub4dor-77-x' }, 'never'),
        { intent: 'Type the export password', fill: { field: { css: '#password' }, value: '{{var.a}}', secret: true } },
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure).toMatchObject({ index: 0, message: INPUT_CONTAINS_SECRET });
      expect(await session.page.inputValue('#username')).toBe('');
    } finally { await session.close(); }
  });
  it('a variable condition on an unset variable fails the run', async () => {
    const ctx = await ctxFor();
    try {
      const r = await runSteps(ctx, [
        fillUser('Unknown', { var: 'region', equals: '' }, 'never'),
        fillUser('After', undefined, 'never either'),
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure).toMatchObject({ index: 0, message: 'missing input "region"' });
      expect(await session.page.inputValue('#username')).toBe('');
    } finally { await session.close(); }
  });
});
