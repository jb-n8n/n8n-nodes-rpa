import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type BrowserServer } from 'playwright-core';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { privateAddress } from '../src/messages.js';
import type { BrowserEndpoint, PortalPolicy, Script } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { policyFor, SECRETS, signedLaneInput } from './helpers.js';

/** How long the mocked lookup of `localhost` takes: longer than a step's timeout here (400 ms), shorter than Session.idle()'s 2 s. */
const SLOW_LOOKUP_MS = 1_200;

// TaskInput has no resolver seam (by design), so the lanes are driven through the module defaults instead. With these
// mocks 127.0.0.1 counts as public and localhost resolves, slowly, to 10.0.0.5: the redirect guard holds a hop to localhost
// until its private-address check is done, which is after the step that led to it has already timed out.
vi.mock('../src/browser/address.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/browser/address.js')>();
  return {
    ...mod,
    isPrivateAddress: (ip: string) => ip.startsWith('10.'),
    defaultResolveHost: async (h: string) => {
      if (h !== 'localhost') return [];
      await new Promise((r) => setTimeout(r, SLOW_LOOKUP_MS));
      return ['10.0.0.5'];
    },
  };
});

let portal: Awaited<ReturnType<typeof startPortal>>;
let server: BrowserServer;
let remote: BrowserEndpoint;
beforeAll(async () => {
  portal = await startPortal();
  server = await chromium.launchServer({ headless: true });
  remote = { mode: 'playwright', wsUrl: server.wsEndpoint() };
});
afterAll(async () => { await server.close(); await portal.close(); });
beforeEach(() => { portal.reset(); });

const other = () => `localhost:${portal.port}`;
/** A redirect from the (public, through the mocks) start host to a missing page on localhost (private, through the mocks). */
const redirectToMissing = () => `${portal.url}/public/redirect?to=${encodeURIComponent(`http://${other()}/public/missing`)}`;
const policy = (startUrl: string): PortalPolicy => {
  const { allowPrivateNetwork: _drop, ...rest } = policyFor(portal);
  return { ...rest, startUrl, navHosts: [portal.host, other()] };
};
function input(script: Script, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput {
  return signedLaneInput(script, { policy: policy(script.startUrl), secrets: SECRETS, output: {}, endpoint: remote, defaultStepTimeoutMs: 400, ...over });
}

describe('late private-address checks decide the lane outcome', () => {
  it('script lane: a start page that failed after a private redirect hop is policy_violation, not drift', async () => {
    const script: Script = {
      name: 'late-hop', version: 1, startUrl: redirectToMissing(),
      steps: [{ intent: 'Wait for the table', waitFor: { target: { css: 'table.results' } } }],
    };
    const r = await runScriptLane(input(script));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'policy_violation', message: privateAddress(other()) });
    expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'private', host: other(), fatal: true }));
  });
  it('first run: the same start page is policy_violation before the model is ever called', async () => {
    const model = fakeModel([]);
    const r = await runTask({
      script: undefined, repair: { model, goal: 'Read the table.', name: 'late-hop' }, policy: policy(redirectToMissing()), secrets: SECRETS,
      trust: { required: false }, output: { idPattern: 'N26-\\d{4}' }, endpoint: remote, defaultStepTimeoutMs: 400,
    });
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'policy_violation', message: privateAddress(other()) });
    expect(model.invocations).toHaveLength(0);
  });
  it('a step that timed out before its private hop was flagged reports the private address, under that step', async () => {
    const script: Script = {
      name: 'late-hop-step', version: 1, startUrl: `${portal.url}/public/table`,
      steps: [
        { intent: 'Open the redirect', goto: redirectToMissing() },
        { intent: 'Wait for the table', waitFor: { target: { css: 'table.results' } } },
      ],
    };
    const r = await runScriptLane(input(script));
    if (r.ok) throw new Error('expected failure');
    // The hop is never sent, so the step that opened the redirect is the one that fails, not the next one.
    expect(r).toMatchObject({ code: 'policy_violation', message: `Open the redirect: ${privateAddress(other())}` });
  });
});
