import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { PRESS_PASSWORD_REFUSED } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, Step, StepsResult } from '../src/types.js';
import { LOCAL } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

type Counters = { posts: { path: string; name?: string }[] };
const counters = async (): Promise<Counters> => (await fetch(`${portal.url}/public/api/counters`)).json() as Promise<Counters>;

const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}/public/keys`, navHosts: [portal.host], subresourceHosts: [], login: [], allowedSubmits: [],
  writeMode: 'block', allowPrivateNetwork: true,
});

/** Runs steps on a live session opened at `path`, after `prepare` changed the page; the caller closes the session. */
async function direct(path: string, steps: Step[], prepare?: (s: Session) => Promise<void>): Promise<{ s: Session; ctx: StepContext; r: StepsResult }> {
  const s = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  await s.page.goto(`${portal.url}${path}`);
  await prepare?.(s);
  const ctx: StepContext = {
    page: s.page, script: { name: 't', version: 1, startUrl: `${portal.url}${path}`, steps }, policy: policy(), vars: { item: 'Beta' },
    masker: createMasker([]), defaultTimeoutMs: 3000, violations: s.violations,
  };
  return { s, ctx, r: await runSteps(ctx, steps) };
}
const keysSeen = (s: Session) => s.page.evaluate(() => (window as unknown as { keysSeen: string[] }).keysSeen);

describe('hover and modifier clicks', () => {
  const MONTHLY: Step = { intent: 'Open the monthly report', timeoutMs: 1000, click: { role: 'link', name: 'Monthly' } };
  const SHOWN: Step = { intent: 'The report opened', waitFor: { target: { css: '#echo' }, hasText: 'Monthly' } };

  it('hover opens a menu and the next click uses it', async () => {
    const { s, r } = await direct('/public/hover-menu', [{ intent: 'Open the menu', hover: { role: 'button', name: 'Reports' } }, MONTHLY, SHOWN]);
    try {
      if (!r.ok) throw new Error(r.failure.message);
      expect(new URL(s.page.url()).pathname).toBe('/public/echo');
    } finally { await s.close(); }
    // Without the hover the menu item never shows.
    const without = await direct('/public/hover-menu', [MONTHLY]);
    try { expect(without.r.ok).toBe(false); } finally { await without.s.close(); }
  });

  it('Ctrl+click selects a second item in a list', async () => {
    const steps: Step[] = [
      { intent: 'Pick Alpha', click: { role: 'option', name: 'Alpha' } },
      { intent: 'Add Beta', click: { role: 'option', name: '{{var.item}}' }, modifiers: ['Ctrl'] },
      { intent: 'Both are picked', waitFor: { target: { css: '#picked' }, hasText: 'Alpha, Beta' } },
    ];
    const { s, r } = await direct('/public/pick-list', steps);
    try {
      if (!r.ok) throw new Error(r.failure.message);
      // A plain click instead picks only the one item.
      const plain = await runSteps({ page: s.page, script: { startUrl: portal.url, steps }, policy: policy(), vars: {}, masker: createMasker([]), defaultTimeoutMs: 3000, violations: s.violations }, [
        { intent: 'Pick Gamma', click: { role: 'option', name: 'Gamma' } },
        { intent: 'Only Gamma', waitFor: { target: { css: '#picked' }, hasText: 'Gamma' } },
      ]);
      if (!plain.ok) throw new Error(plain.failure.message);
      expect(await s.page.textContent('#picked')).toBe('Gamma');
    } finally { await s.close(); }
  });
});

describe('press', () => {
  it('press Enter on a search field submits a GET form', async () => {
    const { s, r } = await direct('/public/keys', [
      { intent: 'Type the search', fill: { field: { label: 'Search' }, value: 'blue mugs' } },
      { intent: 'Search', press: { key: 'Enter', target: { label: 'Search' } } },
      { intent: 'Results shown', waitFor: { target: { css: '#echo' }, hasText: 'blue mugs' } },
    ]);
    try {
      if (!r.ok) throw new Error(r.failure.message);
      expect(s.violations).toEqual([]);
      expect((await counters()).posts).toEqual([]);
    } finally { await s.close(); }
  });

  it('press Tab moves the focus', async () => {
    const { s, r } = await direct('/public/keys', [
      { intent: 'Next field', press: { key: 'Tab', target: { label: 'Note' } } },
      { intent: 'The PIN field has the focus', waitFor: { target: { css: '#focused' }, hasText: 'pin' } },
    ]);
    try {
      if (!r.ok) throw new Error(r.failure.message);
      expect(await keysSeen(s)).toEqual(['Tab']);
    } finally { await s.close(); }
  });

  it('press on a password field is refused and types nothing', async () => {
    for (const target of [{ label: 'PIN' }, { text: 'PIN' }]) {
      const { s, ctx, r } = await direct('/public/keys', [{ intent: 'Clear the PIN', press: { key: 'Backspace', target } }]);
      try {
        expect(r.ok, JSON.stringify(target)).toBe(false);
        if (!r.ok) expect(r.failure.message).toBe(PRESS_PASSWORD_REFUSED);
        expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
        expect(await keysSeen(s)).toEqual([]);
      } finally { await s.close(); }
    }
  });

  it('press with no target while a password field has the focus is refused', async () => {
    const { s, ctx, r } = await direct('/public/keys', [
      { intent: 'Into the PIN field', click: { label: 'PIN' } },
      { intent: 'Send', press: { key: 'Enter' } },
    ]);
    try {
      expect(r).toMatchObject({ ok: false, failure: { intent: 'Send', message: PRESS_PASSWORD_REFUSED } });
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
      expect(await keysSeen(s)).toEqual([]);
      expect((await counters()).posts).toEqual([]);
    } finally { await s.close(); }
  });

  it('press with no target is refused when the focus is on a password field inside a frame', async () => {
    const { s, ctx, r } = await direct('/public/keys', [{ intent: 'Send', press: { key: 'Enter' } }], async (session) => {
      await session.page.evaluate(() => {
        const f = document.createElement('iframe');
        f.srcdoc = '<label>Code <input type="password" id="code"></label>';
        document.body.append(f);
        return new Promise((done) => { f.onload = done; });
      });
      await session.page.frameLocator('iframe').locator('#code').focus();
    });
    try {
      expect(r).toMatchObject({ ok: false, failure: { intent: 'Send', message: PRESS_PASSWORD_REFUSED } });
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
    } finally { await s.close(); }
  });
});
