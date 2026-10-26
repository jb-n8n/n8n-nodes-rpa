import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPortal, type SandboxPortal } from 'n8n-rpa-sandbox/testing.js';
import type { ChatMessage, ChatModel, ChatResponse } from 'n8n-rpa-engine';
import { baselineWithoutTotp, countingModel, NAME, runEval, runStepsInput } from '../src/run.js';

let portal: SandboxPortal;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });

const LABELS = ['Field Actions', 'Safety Campaigns', 'Compliance Notices', 'Recalls & Stop-Sales'];
function refOf(text: string, names: string[]): string {
  for (const m of text.slice(text.lastIndexOf('<page_content>')).matchAll(/^\[(e\d+)\] link ("(?:[^"\\]|\\.)*")/gm)) {
    if (names.includes(JSON.parse(m[2]) as string)) return m[1];
  }
  throw new Error('no notices link on the page');
}
/** The ref of the element of this role and exact name in the latest snapshot. */
function refByRole(text: string, role: string, name: string): string {
  for (const m of text.slice(text.lastIndexOf('<page_content>')).matchAll(/^\[(e\d+)\] (\S+) ("(?:[^"\\]|\\.)*")/gm)) {
    if (m[2] === role && JSON.parse(m[3]) === name) return m[1];
  }
  throw new Error(`no ${role} "${name}" on the page`);
}
/**
 * Scripted model that heals a renamed notices section: click it, extract, done. With `code`, it first answers the
 * authenticator prompt the release added after the base sign-in (enter_code, no sign_in of its own), then opens
 * Service from the home page.
 */
function labelHealer(opts: { code?: boolean } = {}): ChatModel {
  return {
    bindTools: () => {
      let turn = 0;
      return {
        invoke: async (messages: ChatMessage[]): Promise<ChatResponse> => {
          const last = [...messages].reverse().find((m) => m.role === 'tool' || m.role === 'user')?.content ?? '';
          turn++;
          const call = (name: string, args: Record<string, unknown> = {}): ChatResponse => ({
            content: '', tool_calls: [{ id: `c${turn}`, name, args }], usage_metadata: { input_tokens: 50, output_tokens: 5 },
          });
          const step = opts.code ? turn - 2 : turn;
          if (step === -1) return call('enter_code', { field_ref: refByRole(last, 'textbox', 'Authentication code'), submit_ref: refByRole(last, 'button', 'Verify') });
          if (step === 0) return call('click', { ref: refByRole(last, 'link', 'Service') });
          if (step === 1) return call('click', { ref: refOf(last, LABELS) });
          if (step === 2) return call('extract');
          return call('done', { outcome: 'found', note: 'all notices' });
        },
      };
    },
  };
}

describe('runEval', () => {
  it('reports heal, prove, full cycle, zero model calls on the following run, no false completes and no leaks', async () => {
    const lines: string[] = [];
    const report = await runEval({
      portal, seeds: [1, 2], model: labelHealer(), modelName: 'scripted',
      release: (seed) => ({ label: seed === 1 ? 'Field Actions' : 'Safety Campaigns' }), log: (l) => lines.push(l),
    });
    expect(report).toMatchObject({
      model: 'scripted', seeds: 2, releasesNeedingHeal: 2, healRate: 1, proveRate: 1, cycleRate: 1,
      followingRunLlmCalls: 0, falseCompletes: 0, leaks: 0, policyViolations: 0, pass: true,
    });
    expect(report.results.map((r) => r.firstRun.lane)).toEqual(['agent', 'agent']);
    expect(report.medianTokens).toBe(165);
    expect(lines).toHaveLength(2);
  });
  it('a release that adds TOTP after a sign-in recorded without it heals, proves and signs', async () => {
    const report = await runEval({
      portal, seeds: [3], model: labelHealer({ code: true }), modelName: 'scripted', baseline: baselineWithoutTotp,
      release: () => ({ mfa: 'totp', label: 'Field Actions' }),
    });
    expect(report.results[0]).toMatchObject({ needsHeal: true, healed: true, proved: true, approved: true, followingRunOk: true, followingRunLlmCalls: 0 });
    expect(report).toMatchObject({ cycleRate: 1, falseCompletes: 0, leaks: 0, pass: true });
  }, 120_000); // prove waits for a fresh TOTP window after the agent's code (up to 30 s)
  it('a release that does not break the script needs no heal and does not count against the rates', async () => {
    const report = await runEval({ portal, seeds: [7], model: labelHealer(), modelName: 'scripted', release: () => ({ render: 'cards' }) });
    expect(report).toMatchObject({ releasesNeedingHeal: 0, cycleRate: 1, pass: true });
    expect(report.results[0]).toMatchObject({ needsHeal: false, firstRun: { ok: true, lane: 'script' } });
  });
  it('countingModel counts invocations', async () => {
    const inner: ChatModel = { bindTools: () => ({ invoke: async () => ({ content: '' }) }) };
    const counter = countingModel(inner);
    const bound = counter.bindTools([]);
    await bound.invoke([]);
    await bound.invoke([]);
    expect(counter.calls).toBe(2);
  });
});

describe('runStepsInput', () => {
  it('builds the TaskInput executeRunSteps builds for the data feed: signed and bound, Site Login policy, repair without unconfirmed rows', () => {
    const model: ChatModel = { bindTools: () => ({ invoke: async () => ({ content: '' }) }) };
    const input = runStepsInput(portal, { steps: { name: NAME, version: 3, steps: [] }, version: 3, signature: 'sig', approvedBy: 'eval@example.com' }, model);
    expect(input.trust).toEqual({
      required: true, signature: 'sig', approvedBy: 'eval@example.com', key: 'eval-signing-key', allowUnsignedWrites: false,
      expect: { name: 'example-feed', version: 3, siteLoginId: 'eval-site-login' },
    });
    expect(input.policy).toMatchObject({ navHosts: [portal.host], writeMode: 'fatal', allowPrivateNetwork: true });
    expect(input.repair).toMatchObject({ model, name: 'example-feed', deliverUnconfirmed: false, alreadyRan: false, agentBudget: { maxActions: 40, maxTokens: 200_000 } });
    expect(input).toMatchObject({
      budgetMs: 180_000, defaultStepTimeoutMs: 30_000, viewport: { width: 1280, height: 800 }, vars: {}, saveTrace: 'onFailure',
      output: { idPattern: 'N26-\\d{4}', totalPattern: 'Showing \\d+-\\d+ of (\\d+)' },
    });
    expect(input).not.toHaveProperty('startStatus');
  });
});
