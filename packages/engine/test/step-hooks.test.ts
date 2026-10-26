import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { BrowserEndpoint, Step } from '../src/types.js';
import { LOCAL, policyFor, SECRETS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
const masker = createMasker([SECRETS.username, SECRETS.password]);

describe('step hooks (named trace groups and live-view markers)', () => {
  it('runSteps reports each top-level step by a masked label, skips conditional steps it did not run, and says when one fails', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    const calls: string[] = [];
    try {
      const ctx: StepContext = {
        page: s.page, script: { startUrl: `${portal.url}/acme/login`, steps: [] }, policy: policyFor(portal), vars: {}, masker,
        defaultTimeoutMs: 800, violations: s.violations,
        stepHooks: { start: async (_p, label) => { calls.push(`start ${label}`); }, end: async (_p, ok, label) => { calls.push(`${ok ? 'ok' : 'failed'} ${label}`); } },
      };
      const steps: Step[] = [
        { intent: 'Open the login page', goto: `${portal.url}/acme/login` },
        { intent: 'Skip the survey', when: { visible: { css: '#never-there' } }, click: { css: '#never-there' } },
        { intent: `Check ${SECRETS.username}`, click: { css: '#no-such-control' } },
      ];
      const r = await runSteps(ctx, steps, newRunState());
      expect(r.ok).toBe(false);
      expect(calls).toEqual(['start Step 1: Open the login page', 'ok Step 1: Open the login page', 'start Step 3: Check [secret]', 'failed Step 3: Check [secret]']);
      // Agent actions and the proof label their steps by lane instead of a number.
      calls.length = 0;
      await runSteps(ctx, [steps[0]], newRunState(), { label: 'AI' });
      expect(calls).toEqual(['start AI: Open the login page', 'ok AI: Open the login page']);
    } finally { await s.close(); }
  });

  it('over CDP, sends a marker another DevTools client can read, in a world the page cannot see, and names the step in the trace', async () => {
    const port = await new Promise<number>((resolve) => { const srv = createServer().listen(0, () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); }); });
    const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    try {
      // Slow Motion on: someone is watching, so the engine sends markers (a CDP session without it sends none, below).
      const s = await openSession({ endpoint: { mode: 'cdp', wsUrl: `http://127.0.0.1:${port}`, slowMo: 1 }, policy: policyFor(portal), masker, trace: true });
      try {
        await s.page.goto(`${portal.url}/acme/login`);
        // The page's own script watches console.debug: a marker in the main world would show up here.
        await s.page.evaluate(() => { const w = window as unknown as { seen: unknown[] }; w.seen = []; console.debug = (...a: unknown[]) => { w.seen.push(a); }; });
        // A live view: a second DevTools client on the same page.
        const viewer = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const markers: string[][] = [];
        try {
          const page = viewer.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/acme/login'));
          if (!page) throw new Error('viewer did not find the page');
          const cdp = await page.context().newCDPSession(page);
          cdp.on('Runtime.consoleAPICalled', (e: { args: { value?: unknown }[] }) => {
            if (e.args[0]?.value === 'rpa-step') markers.push(e.args.slice(1).map((a) => String(a.value)));
          });
          await cdp.send('Runtime.enable');
          await s.stepHooks.start(s.page, 'Step 1: Open Service');
          await s.stepHooks.end(s.page, false, 'Step 1: Open Service');
          await expect.poll(() => markers.length).toBe(2);
          expect(markers).toEqual([['start', 'Step 1: Open Service'], ['failed', 'Step 1: Open Service']]);
          expect(await s.page.evaluate(() => (window as unknown as { seen: unknown[] }).seen.length)).toBe(0);
          // A navigation replaces the document and its isolated world: the next marker still arrives.
          await s.page.goto(`${portal.url}/acme/login?again=1`);
          await s.stepHooks.start(s.page, 'Step 2: Sign in');
          await expect.poll(() => markers.length).toBe(3);
          expect(markers[2]).toEqual(['start', 'Step 2: Sign in']);
        } finally { await viewer.close().catch(() => undefined); }
        // Without Slow Motion nobody is watching: no markers, no extra CDP traffic per step.
        const quiet = await openSession({ endpoint: { mode: 'cdp', wsUrl: `http://127.0.0.1:${port}` }, policy: policyFor(portal), masker });
        try {
          await quiet.page.goto(`${portal.url}/acme/login?quiet=1`);
          const heard: unknown[] = [];
          const listener = await quiet.context.newCDPSession(quiet.page);
          listener.on('Runtime.consoleAPICalled', (e: { args: { value?: unknown }[] }) => { if (e.args[0]?.value === 'rpa-step') heard.push(e.args); });
          await listener.send('Runtime.enable');
          await quiet.stepHooks.start(quiet.page, 'Step 1: Quiet');
          await quiet.stepHooks.end(quiet.page, true, 'Step 1: Quiet');
          await new Promise((r) => setTimeout(r, 300));
          expect(heard).toEqual([]);
        } finally { await quiet.close(); }
        const zip = await s.takeTrace();
        const text = Object.values(unzipSync(new Uint8Array(zip as Buffer))).map((f) => strFromU8(f)).join('\n');
        expect(text).toContain('Step 1: Open Service');
      } finally { await s.close(); }
    } finally { await browser.close(); }
  }, 60_000);

  it('in Browser Server mode, sends markers too with Slow Motion on, none without, and Local Browser sends none', async () => {
    const server = await chromium.launchServer({ headless: true, host: '127.0.0.1', port: 0 });
    const heardFrom = async (endpoint: BrowserEndpoint): Promise<string[][]> => {
      const s = await openSession({ endpoint, policy: policyFor(portal), masker });
      try {
        await s.page.goto(`${portal.url}/acme/login`);
        const heard: string[][] = [];
        const listener = await s.context.newCDPSession(s.page);
        listener.on('Runtime.consoleAPICalled', (e: { args: { value?: unknown }[] }) => { if (e.args[0]?.value === 'rpa-step') heard.push(e.args.slice(1).map((a) => String(a.value))); });
        await listener.send('Runtime.enable');
        await s.stepHooks.start(s.page, 'Step 1: Watch');
        await s.stepHooks.end(s.page, true, 'Step 1: Watch');
        await new Promise((r) => setTimeout(r, 400));
        return heard;
      } finally { await s.close(); }
    };
    try {
      expect(await heardFrom({ mode: 'playwright', wsUrl: server.wsEndpoint(), slowMo: 1 })).toEqual([['start', 'Step 1: Watch'], ['ok', 'Step 1: Watch']]);
      expect(await heardFrom({ mode: 'playwright', wsUrl: server.wsEndpoint() })).toEqual([]);
      expect(await heardFrom({ ...LOCAL, slowMo: 1 })).toEqual([]);
    } finally { await server.close(); }
  }, 60_000);
});
