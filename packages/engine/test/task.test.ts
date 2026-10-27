import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import type { ChatModel, ChatResponse } from '../src/agent/model.js';
import type { Session } from '../src/browser/session.js';
import { clampAgentBudget, MAX_AGENT_ACTIONS, MAX_AGENT_TOKENS, triggerClickToKeep } from '../src/lane/agent-lane.js';
import { newRunState } from '../src/steps/run.js';
import type { DownloadTemplate } from '../src/steps/file-check.js';
import { FIELDS_UNSUPPORTED, repairKind, downloadTemplateOf, repairPrecondition, runTask, type TaskInput, type TaskResult } from '../src/lane/task.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import type { ProveInput } from '../src/prove/prove.js';
import { signScript } from '../src/sign.js';
import {
  FIRST_RUN_NEEDS_NAME, FIRST_RUN_NEEDS_TARGET, NO_STEPS_NO_REPAIR, REPAIR_ALREADY_RAN, REPAIR_DOWNLOAD_NEEDS_CHECK, REPAIR_NEEDS_ID_AND_EXTRACT,
  FILE_NOT_DELIVERABLE, FILE_WITHHELD, REPAIR_NO_CAPTURES, REPAIR_ONE_DOWNLOAD, REPAIR_REFUSED_WRITES, ROWS_WITHHELD,
  UNSIGNED_REQUIRED, UNSIGNED_WRITES,
} from '../src/messages.js';
import type { BrowserEndpoint, Script, Step } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, use, type FakeTurn } from './fake-model.js';
import { APPROVER, baselineScript, LOCAL, policyFor, publicPolicy, reportScript, SECRETS, TEST_KEY } from './helpers.js';
import { bound } from './timing.js';
const TOTAL_PATTERN = 'Showing \\d+[-–]\\d+ of (\\d+)';

// proveScript runs for real; the wrapper only records what runTask passed it.
const { handoffs, proveCalls, onStopTrace, failNextSettle, failSubmitResolve, loopBudgets, proveRewrite } = vi.hoisted(() => ({
  /** When `on`, agentLane records its hand-off and returns a stub instead of running. */
  handoffs: { on: false, seen: [] as { kind: string; download?: unknown }[] },
  proveCalls: [] as { input: ProveInput; at: number }[],
  /** One-shot: rewrites the next real prove result before runTask sees it. */
  proveRewrite: { next: undefined as ((r: import('../src/prove/prove.js').ProveResult) => import('../src/prove/prove.js').ProveResult) | undefined },
  /** The budget each runAgentLoop call received (the loop still runs for real). */
  loopBudgets: [] as { maxActions?: number; maxTokens?: number }[],
  /** One-shot hook run on the session the next time a trace is stopped (stopTrace still runs for real). */
  onStopTrace: { next: undefined as ((session: Session) => void) | undefined },
  /** One-shot fault: the next settle() after a step's action throws (e.g. right after the sign-in form was submitted). */
  failNextSettle: { on: false },
  /** One-shot fault: the next lookup of a button (a sign-in submit) fails, after the credentials were typed. */
  failSubmitResolve: { on: false },
}));
const { sessionPolicies, sessionViewports, onSession } = vi.hoisted(() => ({
  /** One-shot: runs on the next session right after it opened. */
  onSession: { next: undefined as ((s: Session) => void) | undefined },
  sessionPolicies: [] as import('../src/types.js').PortalPolicy[],
  sessionViewports: [] as ({ width: number; height: number } | undefined)[],
}));
vi.mock('../src/browser/session.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/browser/session.js')>();
  return {
    ...mod,
    openSession: (opts: Parameters<typeof mod.openSession>[0]) => {
      sessionPolicies.push(structuredClone(opts.policy));
      sessionViewports.push(opts.viewport);
      return mod.openSession(opts).then((s) => {
        const hook = onSession.next;
        onSession.next = undefined;
        hook?.(s);
        return s;
      });
    },
  };
});
beforeEach(() => { sessionPolicies.length = 0; sessionViewports.length = 0; onSession.next = undefined; });
vi.mock('../src/steps/locator.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/steps/locator.js')>();
  return {
    ...mod,
    resolveUnique: async (...args: Parameters<typeof mod.resolveUnique>) => {
      if (failSubmitResolve.on && 'role' in args[1] && args[1].role === 'button') {
        failSubmitResolve.on = false;
        throw new Error('the sign-in button went away');
      }
      return mod.resolveUnique(...args);
    },
  };
});
vi.mock('../src/steps/run.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/steps/run.js')>();
  return {
    ...mod,
    settle: async (page: Parameters<typeof mod.settle>[0]) => {
      if (failNextSettle.on) {
        failNextSettle.on = false;
        await mod.settle(page);
        throw new Error('the page stopped responding');
      }
      return mod.settle(page);
    },
  };
});
vi.mock('../src/lane/agent-lane.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lane/agent-lane.js')>();
  return {
    ...mod,
    agentLane: async (input: Parameters<typeof mod.agentLane>[0], repair: Parameters<typeof mod.agentLane>[1], h: Parameters<typeof mod.agentLane>[2]) => {
      if (!handoffs.on) return mod.agentLane(input, repair, h);
      handoffs.seen.push({ kind: h.kind, ...(h.download ? { download: h.download } : {}) });
      await h.runtime.dispose();
      return { ok: false, code: 'drift_detected', message: 'stub', lane: 'agent' } as never;
    },
  };
});
vi.mock('../src/agent/loop.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/agent/loop.js')>();
  return {
    ...mod,
    runAgentLoop: (input: Parameters<typeof mod.runAgentLoop>[0]) => {
      loopBudgets.push({ maxActions: input.budget.maxActions, maxTokens: input.budget.maxTokens });
      return mod.runAgentLoop(input);
    },
  };
});
vi.mock('../src/prove/prove.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/prove/prove.js')>();
  return {
    ...mod,
    proveScript: async (input: ProveInput) => {
      proveCalls.push({ input, at: Date.now() });
      const r = await mod.proveScript(input);
      const rewrite = proveRewrite.next;
      proveRewrite.next = undefined;
      return rewrite ? rewrite(r) : r;
    },
  };
});
const { compileRewrite } = vi.hoisted(() => ({
  /** One-shot: rewrites the next compile result before the agent lane sees it (compile still runs for real). */
  compileRewrite: { next: undefined as ((r: import('../src/compile/compile.js').CompileResult) => import('../src/compile/compile.js').CompileResult) | undefined },
}));
beforeEach(() => { compileRewrite.next = undefined; });
vi.mock('../src/compile/compile.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/compile/compile.js')>();
  return {
    ...mod,
    compileProposal: (input: Parameters<typeof mod.compileProposal>[0]) => {
      const r = mod.compileProposal(input);
      const rewrite = compileRewrite.next;
      compileRewrite.next = undefined;
      return rewrite ? rewrite(r) : r;
    },
  };
});
vi.mock('../src/trace/trace.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/trace/trace.js')>();
  return {
    ...mod,
    stopTrace: (session: Session, opts: Parameters<typeof mod.stopTrace>[1]) => {
      const hook = onStopTrace.next;
      onStopTrace.next = undefined;
      hook?.(session);
      return mod.stopTrace(session, opts);
    },
  };
});

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); proveCalls.length = 0; proveRewrite.next = undefined; onStopTrace.next = undefined; failNextSettle.on = false; failSubmitResolve.on = false; loopBudgets.length = 0; handoffs.on = false; handoffs.seen.length = 0; });

const GOAL = 'Read every current recall and stop-sale notice.';
type Over = Partial<TaskInput> & {
  /** Turns AI repair on with the v1 node's settings: this Goal, rows delivered unconfirmed unless said otherwise. */
  model?: ChatModel; name?: string; agentBudget?: { maxActions?: number; maxTokens?: number };
  deliverUnconfirmed?: boolean; alreadyRan?: boolean; download?: DownloadTemplate;
};
function task(over: Over = {}, script: Script = baselineScript(portal.url)): TaskInput {
  const { model, name, agentBudget, deliverUnconfirmed = true, alreadyRan, download, ...rest } = over;
  const { signature } = signScript(script, TEST_KEY, { approvedBy: APPROVER });
  return {
    script, trust: { required: true, signature, approvedBy: APPROVER, key: TEST_KEY }, policy: policyFor(portal), secrets: { ...SECRETS },
    output: { idPattern: 'N26-\\d{4}', totalPattern: TOTAL_PATTERN }, endpoint: LOCAL, defaultStepTimeoutMs: 3000,
    ...(model ? {
      repair: { model, goal: GOAL, deliverUnconfirmed, ...(name ? { name } : {}), ...(agentBudget ? { agentBudget } : {}), ...(alreadyRan ? { alreadyRan } : {}), ...(download ? { download } : {}) },
    } : {}),
    ...rest,
  };
}
const firstRun = (over: Over = {}) => task({ name: 'demo-sandbox', ...over, script: undefined });
/** Opening this endpoint fails browser_unavailable, so any other outcome proves no browser was opened. */
const NO_BROWSER: BrowserEndpoint = { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/' };
const HEAL = () => [clickNamed('Field Actions'), use('extract'), done('found', 'all notices')];
const SIGN_IN: FakeTurn = (t) => ({
  name: 'sign_in', args: { username_ref: refByName(t, 'Dealer user ID'), password_ref: refByName(t, 'Password'), submit_ref: refByName(t, 'Sign in') },
});
const secretsIn = (v: unknown) => JSON.stringify(v, (k, x) => (['trace', 'screenshot', 'before', 'after'].includes(k) ? undefined : x));
const LEAK = /demo-password|summit-ops|JBSWY3DPEHPK3PXP|test-signing-key/;

describe('runTask', () => {
  it('steps with a capture never reach the agent lane: repair is refused before the run', async () => {
    const base = baselineScript(portal.url);
    const at = base.steps.findIndex((s) => s.intent === 'Open Recalls & Stop-Sales');
    const script: Script = { ...base, steps: [...base.steps.slice(0, at), { intent: 'Screenshot the menu', screenshot: { capture: 'viewport' } }, ...base.steps.slice(at)] };
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel(HEAL());
    const refused = await runTask(task({ model }, script));
    expect(refused).toMatchObject({ ok: false, code: 'policy_violation', lane: 'script', configError: true, message: REPAIR_NO_CAPTURES });
    expect(model.invocations).toHaveLength(0);
    expect(portal.state().logins).toBe(0);
  });
  it('a passing script never calls the model', async () => {
    const model = fakeModel([]);
    const r = await runTask(task({ model }));
    expect(r).toMatchObject({ ok: true, lane: 'script' });
    expect(model.invocations).toHaveLength(0);
  });
  it('drift without AI repair stays drift_detected and never calls a model', async () => {
    portal.setState({ label: 'Field Actions' });
    const bare = await runTask(task());
    expect(bare).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
    if (!bare.ok) expect(bare.message).not.toMatch(/waiting for approval|already ran/);
  });
  it('heals drift on the same session, proves with the stored state and proposes v2', async () => {
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel(HEAL());
    const r = await runTask(task({ model }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.rows).toHaveLength(7);
    expect(r.confirmed).toBe(true);
    expect(r.prove).toMatchObject({ ok: true, total: 7, reasons: [] });
    expect(r.prove?.failureCode).toBeUndefined();
    expect(r.llmCalls).toBe(3);
    expect(r.agentLog.map((a) => a.tool)).toEqual(['click', 'extract', 'done']);
    expect(model.texts[0]).toContain('The approved script stopped at the step "Open Recalls & Stop-Sales"');
    // The approved route after the failing step, as a hint.
    expect(model.texts[0]).toContain('The approved steps after it were: "Read every page of notices".');
    expect(r.proposal).toMatchObject({ baseVersion: 1, version: 2, safetyFlags: [] });
    expect(r.proposal?.changes[0]).toMatchObject({
      was: 'Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales")', now: expect.stringMatching(/^Open Field Actions \(click role "link" name "Field Actions" exact/),
    });
    expect(r.proposal?.steps.steps[4]).toMatchObject({ intent: 'Open Field Actions', checkpoint: true, expect: { url: '/acme/service/field-actions' } });
    expect(r.proposal?.screenshots.before?.length).toBeGreaterThan(1000);
    expect(r.digest).toBe(proposalDigest(r.proposal!));
    expect(portal.state().logins).toBe(1); // the script lane's sign-in only: prove reused the session
    expect(secretsIn(r)).not.toMatch(LEAK);
    expect(r.trace).toBeUndefined(); // confirmed: 'onFailure' keeps no trace
    // ...but the repaired steps carry the proof run's trace: the new steps alone, one named group each, for the reviewer.
    const proof = Object.values(unzipSync(r.proposal?.trace as Buffer)).map((b) => strFromU8(b)).join('\n');
    expect(proof).toContain('Proof: Open Field Actions');
    expect(proof).not.toContain('AI: ');
    expect(proof).not.toContain(SECRETS.password);
    expect(r.submitted).toBe(false); // every result says whether a write left the browser
    // Prove reused the state captured right after the login block, under the run's own deadline.
    expect(proveCalls).toHaveLength(1);
    const { input: p } = proveCalls[0];
    expect(p.postLoginUrl).toBe(`${portal.url}/acme/home`);
    expect(p.storageState?.cookies.length).toBeGreaterThan(0);
    expect(p.checkFallbacksFrom).toBe(4);
  });
  it('a first run explores from the start page and proposes v1', async () => {
    const model = fakeModel([SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'), done('found', 'all seven')]);
    const r = await runTask(firstRun({ model }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.confirmed).toBe(true);
    expect(r.proposal).toMatchObject({ name: 'demo-sandbox', baseVersion: null, version: 1 });
    expect(r.proposal?.safetyFlags).toContain(`new host: ${portal.host}`);
    expect(r.digest).toBe(proposalDigest(r.proposal!));
    expect(portal.state().logins).toBe(2); // the agent's sign-in, then prove's full replay
    expect(secretsIn(r)).not.toMatch(LEAK);
    expect(proveCalls[0]?.input.storageState).toBeUndefined();
    expect(r.submitted).toBe(false);
    const noRepair = await runTask(firstRun());
    expect(noRepair).toMatchObject({ ok: false, code: 'drift_detected', lane: 'agent', message: NO_STEPS_NO_REPAIR });
  });
  it('maps agent outcomes to error codes', async () => {
    portal.setState({ label: 'Field Actions' });
    // Both the attempt from the failed page and the escalation from the post-login page give up.
    const gaveUp = await runTask(task({ model: fakeModel([done('not_found', 'no notices here'), done('not_found', 'no notices anywhere')]) }));
    expect(gaveUp).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    const budget = await runTask(task({ model: fakeModel([use('look'), use('look'), use('look')]), agentBudget: { maxActions: 2 } }));
    expect(budget).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent' });
    portal.setState({ label: 'Field Actions', paginate: true });
    const partial = await runTask(task({ model: fakeModel(HEAL()) }));
    if (partial.ok) throw new Error('expected failure');
    expect(partial.code).toBe('incomplete');
    expect(partial.message).toMatch(/Expected 7 rows \(the page says "Showing 1-4 of 7"\) but found 4\. Nothing was marked successful\./);
  });
  it('a model failure is incomplete with "model unavailable"', async () => {
    portal.setState({ label: 'Field Actions' });
    const broken: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error(`rate limited for ${SECRETS.username}`); } }) };
    const r = await runTask(task({ model: broken }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'incomplete', lane: 'agent' });
    expect(r.message).toMatch(/^model unavailable: .*rate limited/);
    expect(secretsIn(r)).not.toMatch(LEAK);
  });
  it('a fatal violation during the agent lane is policy_violation', async () => {
    portal.setState({ label: 'Field Actions' });
    const policy = { ...policyFor(portal), allowedSubmits: [] };
    const model = fakeModel([clickNamed('Reports'), clickNamed('Export CSV'), use('look')]);
    const r = await runTask(task({ policy, model }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', lane: 'agent' });
  });
  it('a compile error still returns the rows, unconfirmed and without a proposal', async () => {
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel([use('back'), clickNamed('Service'), clickNamed('Field Actions'), use('extract'), done()]);
    const r = await runTask(task({ model }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.rows).toHaveLength(7);
    expect(r.confirmed).toBe(false);
    expect(r.proposal).toBeUndefined();
    expect(r.digest).toBeUndefined();
    expect(r.compileIssues?.[0]).toMatch(/does not undo a click/);
    expect(r.trace?.length).toBeGreaterThan(1000); // unconfirmed rows count as a failure for 'onFailure'
  });
  it('one deadline covers both lanes, and the trace covers the agent lane', async () => {
    portal.setState({ label: 'Field Actions' });
    const hung: ChatModel = { bindTools: () => ({ invoke: () => new Promise<ChatResponse>(() => undefined) }) };
    const t0 = Date.now();
    const slow = await runTask(task({ model: hung, budgetMs: 12_000 }));
    expect(slow).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent' });
    expect(Date.now() - t0).toBeLessThan(12_000 + bound(3000));
    const traced = await runTask(task({ model: fakeModel(HEAL()), saveTrace: 'always' }));
    expect(traced.ok).toBe(true);
    const text = Object.values(unzipSync(traced.trace as Buffer)).map((b) => strFromU8(b)).join('\n');
    expect(text).toContain('field-actions');
    expect(text).not.toContain(SECRETS.password);
  });

  // Escalation and resume edge cases.
  it('escalates once from the post-login page when the attempt from the failed page gives up', async () => {
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel([
      done('not_found', 'not on this page'),
      clickNamed('Service'), clickNamed('Field Actions'), use('extract'), done('found', 'all notices'),
    ]);
    const r = await runTask(task({ model }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.rows).toHaveLength(7);
    expect(r.confirmed).toBe(true);
    expect(r.llmCalls).toBe(5);
    expect(r.agentLog.map((a) => a.tool)).toEqual(['done', 'click', 'click', 'extract', 'done']);
    expect(model.texts[1]).toContain('/acme/home');
    // The base login block is kept, the agent's path replaces everything after it.
    expect(r.proposal?.steps.steps.slice(0, 3)).toEqual(baselineScript(portal.url).steps.slice(0, 3));
    expect(r.proposal?.steps.steps.map((s) => s.intent).slice(3)).toEqual(['Open Service', 'Open Field Actions', 'Read the rows on this page']);
    expect(portal.state().logins).toBe(1);
  });
  it('does not escalate when the agent ran out of time', async () => {
    portal.setState({ label: 'Field Actions' });
    let calls = 0;
    const hung: ChatModel = { bindTools: () => ({ invoke: () => { calls++; return new Promise<ChatResponse>(() => undefined); } }) };
    const r = await runTask(task({ model: hung, budgetMs: 12_000 }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'incomplete', lane: 'agent' });
    expect(r.message).toMatch(/time budget ran out/);
    expect(calls).toBe(1);
    expect(r.transcript?.map((m) => m.role)).toEqual(['system', 'user']); // no second attempt was started
  });
  it('agent "blocked" is auth_blocked, but a rejected agent sign-in is login_failed, with one submission', async () => {
    portal.setState({ mfa: 'sms' });
    const sms = await runTask(firstRun({ model: fakeModel([SIGN_IN, done('blocked', 'a text-message code is required')]) }));
    expect(sms).toMatchObject({ ok: false, code: 'auth_blocked', lane: 'agent' });
    portal.reset();
    const wrong = { ...SECRETS, password: 'wrong-pass-123' };
    const rejected = await runTask(firstRun({ secrets: wrong, model: fakeModel([SIGN_IN, use('look'), done('blocked', 'the sign-in was rejected')]) }));
    expect(rejected).toMatchObject({ ok: false, code: 'login_failed', lane: 'agent' });
    expect(portal.state().logins).toBe(1);
    expect(secretsIn(rejected)).not.toContain('wrong-pass-123');
  });
  it('first-run start-page failures map like the script lane; a 401 login page proceeds', async () => {
    const at = (path: string) => ({ ...policyFor(portal), startUrl: `${portal.url}${path}` });
    const gone = await runTask(firstRun({ policy: at('/acme/p/status/404'), model: fakeModel([]) }));
    expect(gone).toMatchObject({ ok: false, code: 'drift_detected', lane: 'agent', message: 'HTTP 404 at the start page' });
    const down = await runTask(firstRun({ policy: at('/acme/p/status/503'), model: fakeModel([]) }));
    expect(down).toMatchObject({ ok: false, code: 'site_down', lane: 'agent', message: 'HTTP 503 at the start page' });
    const model = fakeModel([done('not_found', 'nothing')]);
    const login401 = await runTask(firstRun({ policy: at('/acme/login?status=401'), model }));
    expect(login401).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    expect(model.invocations).toHaveLength(1);
  });
  it('without a sign-in by the agent, prove never signs in again: it resumes the session saved before the broken detect', async () => {
    // The login check is broken after the credentials were sent: the drift is in the login block, the agent cannot sign in again.
    const script = structuredClone(baselineScript(portal.url)); // the sign-in steps are shared fixtures
    const detect = script.steps[2];
    if (!('detect' in detect)) throw new Error('fixture changed');
    detect.detect.checks.logged_in = { css: 'body[data-page=dashboard]' };
    const model = fakeModel([clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'), done('found', 'all seven')]);
    const r = await runTask(task({ model }, script));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.rows).toHaveLength(7);
    expect(r.confirmed).toBe(true);
    expect(r.prove).toMatchObject({ ok: true, reasons: [] });
    expect(portal.state().logins).toBe(1); // still one credential submission: the script lane's
    // The detect is re-anchored on the first click after sign-in, and prove resumed right before it.
    expect(r.proposal?.steps.steps[2]).toMatchObject({ intent: 'Check sign-in worked (new page after sign-in)', detect: { checks: { logged_in: { role: 'link', name: 'Service' } } } });
    const { input: p } = proveCalls[0];
    expect(p).toMatchObject({ resumeAt: 2, checkFallbacksFrom: 2, postLoginUrl: `${portal.url}/acme/home` });
    expect(p.storageState?.cookies.length).toBeGreaterThan(0);
  });
  it('surfaces the full-replay prove failure code', async () => {
    const input = firstRun({ model: fakeModel([]) });
    const model = fakeModel([
      SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'),
      () => { input.secrets = { ...SECRETS, password: 'rotated-pass-456' }; return { name: 'done', args: { outcome: 'found', note: 'all seven' } }; },
    ]);
    input.repair = { ...input.repair!, model };
    const r = await runTask(input);
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.rows).toHaveLength(7);
    expect(r.confirmed).toBe(false);
    expect(r.proposal).toBeUndefined();
    expect(r.prove).toMatchObject({ ok: false, failureCode: 'login_failed' });
    expect(portal.state().logins).toBe(2);
  });
  it('cancelling is incomplete / run cancelled, before or during the agent lane', async () => {
    const pre = new AbortController();
    pre.abort();
    const before = await runTask(task({ model: fakeModel([]), signal: pre.signal }));
    expect(before).toMatchObject({ ok: false, code: 'incomplete', message: 'run cancelled', lane: 'script' });
    const beforeFirst = await runTask(firstRun({ model: fakeModel([]), signal: pre.signal }));
    expect(beforeFirst).toMatchObject({ ok: false, code: 'incomplete', message: 'run cancelled', lane: 'agent' });
    portal.setState({ label: 'Field Actions' });
    const ac = new AbortController();
    const model = fakeModel([() => { ac.abort(); return { name: 'look', args: {} }; }, use('look'), done()]);
    const during = await runTask(task({ model, signal: ac.signal }));
    expect(during).toMatchObject({ ok: false, code: 'incomplete', message: 'run cancelled', lane: 'agent' });
  });
  it('a download run without an output spec returns the file (was: file output with an empty MIME list)', async () => {
    const r = await runTask(task({ vars: { from: '2000-01-01' }, output: undefined }, reportScript(portal.url)));
    if (!r.ok || r.lane !== 'script') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.files).toHaveLength(1);
  });

  // Review fixes.
  it('a blocked request during prove is policy_violation, with the prove session\'s violation', async () => {
    const input = firstRun({ model: fakeModel([]) });
    const model = fakeModel([
      SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'),
      // From here on (compile and prove) the login page is no longer declared, so prove's sign-in is a blocked submission.
      () => { input.policy = { ...input.policy, login: [] }; return { name: 'done', args: { outcome: 'found', note: 'all seven' } }; },
    ]);
    input.repair = { ...input.repair!, model };
    const r = await runTask(input);
    if (r.ok) throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r).toMatchObject({ code: 'policy_violation', lane: 'agent' });
    expect(r.message).toMatch(/blocked request during prove/);
    expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true, url: `${portal.url}/acme/login` }));
    expect(portal.state().logins).toBe(1); // prove refused before typing anything
    // The prove session was traced, and its (scrubbed) trace replaces the healing trace.
    expect(proveCalls[0]?.input.trace).toBe(true);
    const text = Object.values(unzipSync(r.trace as Buffer)).map((b) => strFromU8(b)).join('\n');
    expect(text).toContain('/acme/login');
    expect(text).not.toContain('recalls'); // the healing session's pages are not in the prove trace
    expect(text).not.toContain(SECRETS.password);
    expect(text).not.toContain(SECRETS.username);
  });
  it('empty steps without AI repair never open a browser or run the agent', async () => {
    for (const script of [undefined, null, '', '  ', [], { steps: [] }]) {
      const r = await runTask(task({ script, endpoint: NO_BROWSER }));
      expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'agent', message: NO_STEPS_NO_REPAIR });
    }
  });
  it('after the agent signs in: lock wording is account_locked; a rejected sign-in then a model failure is login_failed', async () => {
    portal.setState({ locked: true });
    const locked = await runTask(firstRun({ model: fakeModel([SIGN_IN, done('blocked', 'cannot sign in')]) }));
    expect(locked).toMatchObject({ ok: false, code: 'account_locked', lane: 'agent' });
    expect(portal.state().logins).toBe(1);
    portal.reset();
    // After sign_in the model goes silent: the loop ends as 'error', but the page says the credentials were rejected.
    const rejected = await runTask(firstRun({ secrets: { ...SECRETS, password: 'wrong-pass-123' }, model: fakeModel([SIGN_IN]) }));
    expect(rejected).toMatchObject({ ok: false, code: 'login_failed', lane: 'agent' });
    expect(portal.state().logins).toBe(1);
  });
  it('cancelling during prove is incomplete / run cancelled', async () => {
    const ac = new AbortController();
    const model = fakeModel([SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'), done('found', 'all seven')]);
    // Prove's full replay is the second sign-in: abort as soon as it reaches the portal.
    const watch = setInterval(() => { if (portal.state().logins >= 2) ac.abort(); }, 10);
    try {
      const r = await runTask(firstRun({ model, signal: ac.signal }));
      expect(proveCalls).toHaveLength(1);
      expect(r).toMatchObject({ ok: false, code: 'incomplete', message: 'run cancelled', lane: 'agent' });
    } finally {
      clearInterval(watch);
    }
  });
  it('the agent stops at the run deadline minus the prove reserve; prove gets the rest of the same deadline', async () => {
    portal.setState({ label: 'Field Actions' });
    let abortedAt = 0;
    const hung: ChatModel = {
      bindTools: () => ({
        invoke: (_m, opts) => new Promise<ChatResponse>(() => { opts?.signal?.addEventListener('abort', () => { abortedAt = Date.now(); }); }),
      }),
    };
    const t0 = Date.now();
    const slow = await runTask(task({ model: hung, budgetMs: 20_000 }));
    expect(slow).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent' });
    // Reserve = min(60 s, 40% of 20 s) = 8 s: the model call is cut off about 12 s in (plus the browser launch).
    expect(abortedAt - t0).toBeGreaterThanOrEqual(11_500);
    expect(abortedAt - t0).toBeLessThan(bound(14_500, 20_000));
    const t1 = Date.now();
    const healed = await runTask(task({ model: fakeModel(HEAL()), budgetMs: 100_000 }));
    expect(healed.ok).toBe(true);
    const { input: p, at } = proveCalls[0];
    expect(p.deadlineMs! - t1).toBeGreaterThan(99_000); // the run's single deadline (budget from the start)
    expect(p.deadlineMs! - t1).toBeLessThan(100_000 + bound(1500));
    expect(p.budgetMs).toBeGreaterThanOrEqual(p.deadlineMs! - at - 50);
    expect(p.deadlineMs! - at).toBeGreaterThan(40_000); // at least the 40 s reserve is left for prove
  });
  it('the agent cannot submit a declared form during repair', async () => {
    portal.setState({ label: 'Field Actions' });
    expect(policyFor(portal).allowedSubmits).toContainEqual({ host: portal.host, path: '/acme/reports/export', method: 'POST' });
    const model = fakeModel([clickNamed('Reports'), clickNamed('Export CSV'), use('look')]);
    const r = await runTask(task({ model }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', lane: 'agent' });
    if (!r.ok) expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true, url: `${portal.url}/acme/reports/export` }));
    expect(proveCalls).toHaveLength(0);
  });
  it('prove replays under the no-write policy', async () => {
    portal.setState({ label: 'Field Actions' });
    const r = await runTask(task({ model: fakeModel(HEAL()) }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(sessionPolicies).toHaveLength(2); // the script lane, then prove
    // The script lane: the credential lists the export, but the baseline steps declare no form, so none is allowed.
    expect(sessionPolicies[0]).toMatchObject({ allowedSubmits: [], writeMode: 'fatal' });
    expect(sessionPolicies[1]).toMatchObject({ allowedSubmits: [], writeMode: 'fatal', login: policyFor(portal).login });
    expect(proveCalls[0]?.input.policy.allowedSubmits).toEqual([]);
  });
  it("prove opens at the run's viewport", async () => {
    portal.setState({ label: 'Field Actions' });
    const viewport = { width: 800, height: 600 };
    const r = await runTask(task({ model: fakeModel(HEAL()), viewport }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(proveCalls[0]?.input.viewport).toEqual(viewport);
    expect(sessionViewports).toEqual([viewport, viewport]); // the script lane, then prove
  });
  describe('field-reading documents, first runs and file checks', () => {
    /** The baseline whose paginated extract reads per-item fields. */
    const withFields = (): Script => {
      const script = structuredClone(baselineScript(portal.url));
      const read = script.steps[5];
      if (!('paginate' in read) || !('extract' in read.paginate.each[0])) throw new Error('fixture changed');
      read.paginate.each[0].extract.item = { css: 'tbody tr' };
      read.paginate.each[0].extract.fields = { title: { pattern: '\\S+ (.+)' } };
      return script;
    };
    it('a first run with required fields never runs the agent or signs in', async () => {
      const model = fakeModel([SIGN_IN, done()]);
      const r = await runTask(firstRun({ model, output: { idPattern: 'N26-\\d{4}', requiredFields: ['title'] } }));
      expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'agent', message: FIELDS_UNSUPPORTED });
      expect(FIELDS_UNSUPPORTED).toBe('repair cannot record field extraction yet: update the script by hand');
      expect(model.invocations).toHaveLength(0);
      expect(portal.state().logins).toBe(0);
    });
    it('drift on a script that reads fields (or must return required fields) is reported, not healed', async () => {
      portal.setState({ label: 'Field Actions' });
      const model = fakeModel(HEAL());
      const base = await runTask(task({ model }, withFields()));
      if (base.ok) throw new Error('expected drift');
      expect(base).toMatchObject({ code: 'drift_detected', lane: 'script', failure: { intent: 'Open Recalls & Stop-Sales' } });
      // The drift detail is kept, with the reason it was not healed after it (like the pending-proposal case).
      expect(base.message).toMatch(/^Open Recalls & Stop-Sales\b.+ \(repair cannot record field extraction yet: update the script by hand\)$/);
      expect(base.message.endsWith(` (${FIELDS_UNSUPPORTED})`)).toBe(true);
      expect(base.screenshot?.length).toBeGreaterThan(1000); // the script lane's failure context is kept
      expect(base.log.map((e) => e.intent)).toContain('Sign in');
      const required = await runTask(task({ model, output: { idPattern: 'N26-\\d{4}', requiredFields: ['title'] } }));
      expect(required).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
      if (required.ok) throw new Error('expected drift');
      expect(required.message.endsWith(` (${FIELDS_UNSUPPORTED})`)).toBe(true);
      expect(required.message.length).toBeGreaterThan(FIELDS_UNSUPPORTED.length + 3);
      expect(model.invocations).toHaveLength(0);
      expect(portal.state().logins).toBe(2); // one per run: the script lane's own sign-in only
      expect(proveCalls).toHaveLength(0);
      // Without drift the field-reading script runs as usual.
      portal.reset();
      const fine = await runTask(task({ model }, withFields()));
      expect(fine).toMatchObject({ ok: true, lane: 'script' });
    });
    it('a field-reading document whose start comes from the default start URL is not healed either', async () => {
      portal.setState({ label: 'Field Actions' });
      const model = fakeModel(HEAL());
      const { startUrl: _start, ...rest } = withFields();
      const doc = { ...rest, steps: [{ intent: 'Open the sign-in page', goto: '/acme/login' }, ...rest.steps] };
      const r = await runTask(task({ model, script: doc, trust: { required: false, allowUnsignedWrites: true } }));
      if (r.ok) throw new Error('expected drift');
      expect(r).toMatchObject({ code: 'drift_detected', lane: 'script' });
      expect(r.message.endsWith(` (${FIELDS_UNSUPPORTED})`)).toBe(true);
      expect(model.invocations).toHaveLength(0);
      expect(proveCalls).toHaveLength(0);
    });
    it('a fatal violation recorded while the healing session is released is policy_violation, before prove (minor 1)', async () => {
      portal.setState({ label: 'Field Actions' });
      const model = fakeModel([
        clickNamed('Field Actions'), use('extract'),
        () => {
          onStopTrace.next = (session) => { session.violations.push({ kind: 'host', url: 'https://evil.example/late', fatal: true }); };
          return { name: 'done', args: { outcome: 'found', note: 'all notices' } };
        },
      ]);
      const r = await runTask(task({ model }));
      if (r.ok) throw new Error(JSON.stringify(r).slice(0, 500));
      expect(r).toMatchObject({ code: 'policy_violation', lane: 'agent', message: 'a blocked request was attempted during the run' });
      expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'host', fatal: true, url: 'https://evil.example/late' }));
      expect(proveCalls).toHaveLength(0);
      expect(r.trace?.length).toBeGreaterThan(1000); // the healing trace
    });
    it('with saveTrace never, prove is not traced and a prove violation carries no trace (minor 2)', async () => {
      const input = firstRun({ model: fakeModel([]), saveTrace: 'never' });
      const model = fakeModel([
        SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'),
        () => { input.policy = { ...input.policy, login: [] }; return { name: 'done', args: { outcome: 'found', note: 'all seven' } }; },
      ]);
      input.repair = { ...input.repair!, model };
      const r = await runTask(input);
      expect(r).toMatchObject({ ok: false, code: 'policy_violation', lane: 'agent' });
      expect(proveCalls[0]?.input.trace).toBe(false);
      expect(r.trace).toBeUndefined();
    });
    it('a sign_in that fails after submitting the credentials still decides the login outcome (minor 3)', async () => {
      // The wrong password is submitted, then the sign_in step fails while the page settles: the portal shows its rejection.
      const model = fakeModel([(t) => { failNextSettle.on = true; return SIGN_IN(t, []); }, done('blocked', 'the sign-in did not go through')]);
      const r = await runTask(firstRun({ secrets: { ...SECRETS, password: 'wrong-pass-123' }, model }));
      if (r.ok) throw new Error(JSON.stringify(r).slice(0, 500));
      expect(r.agentLog?.[0]).toMatchObject({ tool: 'sign_in', ok: false });
      expect(r.agentLog?.[0]?.note).toMatch(/stopped responding/);
      expect(r).toMatchObject({ code: 'login_failed', lane: 'agent' }); // was auth_blocked: only an ok sign_in counted
      expect(r.message).toMatch(/rejected the agent's sign-in/);
      expect(portal.state().logins).toBe(1);
      expect(secretsIn(r)).not.toContain('wrong-pass-123');
    });
    it('a sign_in that fails while filling the form, before the submit click, stays auth_blocked (not login_failed)', async () => {
      // Credentials are typed, then the submit button cannot be found: nothing was submitted, so the portal rejected nothing.
      const model = fakeModel([(t) => { failSubmitResolve.on = true; return SIGN_IN(t, []); }, done('blocked', 'the sign-in did not go through')]);
      const r = await runTask(firstRun({ model }));
      if (r.ok) throw new Error(JSON.stringify(r).slice(0, 500));
      expect(r.agentLog?.[0]).toMatchObject({ tool: 'sign_in', ok: false });
      expect(r.agentLog?.[0]?.note).toMatch(/button went away/);
      expect(r).toMatchObject({ code: 'auth_blocked', lane: 'agent' });
      expect(portal.state().logins).toBe(0);
    });
    it('agent-lane results start with the script lane\'s log, and failures carry its failing step (minor 6)', async () => {
      portal.setState({ label: 'Field Actions' });
      const healed = await runTask(task({ model: fakeModel(HEAL()) }));
      if (!healed.ok || healed.lane !== 'agent') throw new Error(JSON.stringify(healed).slice(0, 500));
      expect(healed.log.slice(0, 5).map((e) => [e.intent, e.status])).toEqual([
        ['Sign in', 'ok'], ['Skip the survey', 'skipped'], ['Check sign-in worked', 'ok'], ['Open Service', 'ok'], ['Open Recalls & Stop-Sales', 'failed'],
      ]);
      expect(healed.log.length).toBeGreaterThan(5); // then the agent's own steps
      const gaveUp = await runTask(task({ model: fakeModel([done('not_found', 'no notices here'), done('not_found', 'no notices anywhere')]) }));
      if (gaveUp.ok) throw new Error('expected failure');
      expect(gaveUp).toMatchObject({ code: 'not_found', lane: 'agent', failure: { index: 4, intent: 'Open Recalls & Stop-Sales' } });
      expect(gaveUp.failure?.message.length).toBeGreaterThan(0);
      expect(gaveUp.log[0]).toMatchObject({ intent: 'Sign in', status: 'ok' });
      const first = await runTask(firstRun({ model: fakeModel([done('not_found', 'nothing')]) }));
      if (first.ok) throw new Error('expected failure');
      expect(first.failure).toBeUndefined(); // a first run has no script-lane failure
    });
    it('a model error reaches the result clipped and with key-like tokens redacted (minor 7)', async () => {
      portal.setState({ label: 'Field Actions' });
      const err = `401 invalid x-api-key sk-ant-api03-SECRETKEYVALUE?api_key=QWERTY Bearer abc.def.ghi for ${SECRETS.username} ${'z'.repeat(400)}`;
      const broken: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error(err); } }) };
      const r = await runTask(task({ model: broken }));
      if (r.ok) throw new Error('expected failure');
      expect(r.message).toMatch(/^model unavailable: 401 invalid x-api-key \[redacted\]\?\[redacted\] \[redacted\] for \[secret\] z+$/);
      expect(r.message.length).toBeLessThanOrEqual('model unavailable: '.length + 200);
      expect(JSON.stringify(r)).not.toMatch(/SECRETKEYVALUE|QWERTY|abc\.def/);
    });
  });
  it('a refused trust check opens no browser and stays on the script lane', async () => {
    const model = fakeModel(HEAL());
    const neverOpened = { mode: 'playwright' as const, wsUrl: 'ws://browser.invalid:1/' };
    const r = await runTask(task({ model, endpoint: neverOpened, trust: { required: true, key: TEST_KEY } }));
    expect(r).toMatchObject({ ok: false, code: 'script_untrusted', lane: 'script', message: UNSIGNED_REQUIRED });
    if (!r.ok) expect(r.durationMs).toBeLessThan(bound(500));
    const unsigned = await runTask(task({ model, endpoint: neverOpened, trust: { required: false } }));
    expect(unsigned).toMatchObject({ ok: false, code: 'script_untrusted', lane: 'script', message: UNSIGNED_WRITES });
    expect(model.invocations).toHaveLength(0);
  });
  it('a first run is exempt from the trust gate', async () => {
    // Opening NO_BROWSER fails browser_unavailable: reaching it proves the gate let the first run through.
    const r = await runTask(firstRun({ model: fakeModel([]), trust: { required: true, signature: 'null' }, endpoint: NO_BROWSER }));
    expect(r).toMatchObject({ ok: false, code: 'browser_unavailable', lane: 'agent' });
  });
});

describe('repair rules', () => {
  const withStep = (step: Step, base: Script = baselineScript(portal.url)): Script => ({ ...base, steps: [...base.steps, step] });
  const SUBMIT: Step = { intent: 'Export', submit: { button: { role: 'button', name: 'Export CSV' }, path: '/acme/reports/export' } };
  const VIA: Step = { intent: 'Export CSV', download: { trigger: { role: 'button', name: 'Export CSV' }, via: { path: '/acme/reports/export' } } };
  const configError = (r: TaskResult, message: string, lane: 'script' | 'agent') =>
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', message, lane, configError: true });

  it('preconditions are configuration errors, checked before any browser opens, in order', async () => {
    const model = fakeModel([]);
    configError(await runTask(task({ model, endpoint: NO_BROWSER, output: {} })), REPAIR_NEEDS_ID_AND_EXTRACT, 'script');
    const noExtract = { ...baselineScript(portal.url), steps: baselineScript(portal.url).steps.slice(0, 5) };
    configError(await runTask(task({ model, endpoint: NO_BROWSER }, noExtract)), REPAIR_NEEDS_ID_AND_EXTRACT, 'script');
    configError(await runTask(task({ model, endpoint: NO_BROWSER }, withStep(SUBMIT))), REPAIR_REFUSED_WRITES, 'script');
    configError(await runTask(task({ model, endpoint: NO_BROWSER }, withStep(VIA))), REPAIR_REFUSED_WRITES, 'script');
    // Precedence: no ID Pattern and a submit → the ID Pattern message.
    configError(await runTask(task({ model, endpoint: NO_BROWSER, output: {} }, withStep(SUBMIT))), REPAIR_NEEDS_ID_AND_EXTRACT, 'script');
    configError(await runTask(firstRun({ model, endpoint: NO_BROWSER, name: '' })), FIRST_RUN_NEEDS_NAME, 'agent');
    configError(await runTask(firstRun({ model, endpoint: NO_BROWSER, name: '   ' })), FIRST_RUN_NEEDS_NAME, 'agent');
    expect(model.invocations).toHaveLength(0);
    expect(portal.state().logins).toBe(0);
  });

  describe('repair is for data feeds: steps that capture, read or table are refused', () => {
    const CAPTURES: [string, Step][] = [
      ['screenshot', { intent: 'Screenshot', screenshot: { capture: 'viewport' } }],
      ['pdf', { intent: 'Save as PDF', pdf: {} }],
      ['read', { intent: 'Read the title', read: { what: 'title' } }],
      ['extractTable', { intent: 'Read the table', extractTable: { table: { css: 'table' } } }],
    ];
    for (const [verb, step] of CAPTURES) {
      it(`${verb} refuses repair before any browser opens`, async () => {
        const model = fakeModel([]);
        configError(await runTask(task({ model, endpoint: NO_BROWSER }, withStep(step))), REPAIR_NO_CAPTURES, 'script');
        expect(repairPrecondition(withStep(step), { idPattern: 'N26-\\d{4}' }, {})).toBe(REPAIR_NO_CAPTURES);
        expect(model.invocations).toHaveLength(0);
      });
    }
    it('a capture nested in a paginate body is refused too; without repair the steps run', async () => {
      const nested = structuredClone(baselineScript(portal.url));
      const pages = nested.steps[5];
      if (!('paginate' in pages)) throw new Error('fixture changed');
      pages.paginate.each.push(CAPTURES[2][1]);
      configError(await runTask(task({ model: fakeModel([]), endpoint: NO_BROWSER }, nested)), REPAIR_NO_CAPTURES, 'script');
      expect(await runTask(task({ endpoint: NO_BROWSER }, nested))).toMatchObject({ ok: false, code: 'browser_unavailable', lane: 'script' });
    });
    it('precedence: ID Pattern and extract first, then form writes, then captures; download.via stays a write refusal', () => {
      const output = { idPattern: 'N26-\\d{4}' };
      expect(repairPrecondition(withStep(CAPTURES[0][1]), {}, {})).toBe(REPAIR_NEEDS_ID_AND_EXTRACT);
      expect(repairPrecondition(withStep(VIA), output, {})).toBe(REPAIR_REFUSED_WRITES);
      expect(repairPrecondition(withStep(SUBMIT, withStep(CAPTURES[0][1])), output, {})).toBe(REPAIR_REFUSED_WRITES);
      expect(REPAIR_NO_CAPTURES).toBe('AI repair works only on steps that extract rows or download one file: remove screenshot, PDF, read and table steps, or turn AI Repair off');
    });
  });

  describe('a document that downloads one checked file', () => {
    const DL: Step = { intent: 'Download', download: { trigger: { role: 'link', name: 'Export' }, check: { name: '^LINEITEMS_' } } };
    const doc = (...steps: Step[]): Script => ({ name: 'r', version: 1, startUrl: 'http://127.0.0.1/', steps });
    const TEMPLATE: DownloadTemplate = { check: { name: '^LINEITEMS_' } };
    const out = {};
    it('one download with check.name is repairable', () => expect(repairPrecondition(doc(DL), out, {})).toBeUndefined());
    it('check.columns is enough too', () => {
      expect(repairPrecondition(doc({ intent: 'Download', download: { trigger: { css: 'a' }, check: { columns: ['A'] } } }), out, {})).toBeUndefined();
    });
    it('a download with via is a write refusal', () => {
      expect(repairPrecondition(doc({ intent: 'x', download: { trigger: { css: 'a' }, via: { path: '/x' }, check: { name: 'a' } } }), out, {})).toBe(REPAIR_REFUSED_WRITES);
    });
    it('two downloads', () => expect(repairPrecondition(doc(DL, DL), out, {})).toBe(REPAIR_ONE_DOWNLOAD));
    it('a download inside paginate', () => {
      const nested = doc({ intent: 'Pages', paginate: { next: { role: 'link', name: 'Next' }, each: [DL] } } as Step);
      expect(repairPrecondition(nested, out, {})).toBe(REPAIR_ONE_DOWNLOAD);
    });
    it('a download plus an extract step', () => {
      const ex: Step = { intent: 'Read the rows', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } };
      expect(repairPrecondition(doc(DL, ex), { idPattern: 'N26-\\d{4}' }, {})).toBe(REPAIR_ONE_DOWNLOAD);
    });
    it('a download plus a screenshot', () => {
      expect(repairPrecondition(doc(DL, { intent: 'Shot', screenshot: { capture: 'viewport' } }), out, {})).toBe(REPAIR_NO_CAPTURES);
    });
    it('a download with only check.minRows', () => {
      expect(repairPrecondition(doc({ intent: 'x', download: { trigger: { css: 'a' }, check: { minRows: 1 } } }), out, {})).toBe(REPAIR_DOWNLOAD_NEEDS_CHECK);
      expect(repairPrecondition(doc({ intent: 'x', download: { trigger: { css: 'a' } } }), out, {})).toBe(REPAIR_DOWNLOAD_NEEDS_CHECK);
    });
    it('empty steps: download with an ID Pattern, or neither, needs one target', () => {
      expect(repairPrecondition(undefined, { idPattern: 'N' }, { name: 'n', download: TEMPLATE })).toBe(FIRST_RUN_NEEDS_TARGET);
      expect(repairPrecondition(undefined, {}, { name: 'n' })).toBe(FIRST_RUN_NEEDS_TARGET);
    });
    it('empty steps with download and no name need a name; with a name they pass', () => {
      expect(repairPrecondition(undefined, {}, { download: TEMPLATE })).toBe(FIRST_RUN_NEEDS_NAME);
      expect(repairPrecondition(undefined, {}, { name: 'n', download: TEMPLATE })).toBeUndefined();
    });
    it('empty steps: an Expected File whose check names neither name nor columns is refused', () => {
      const asks = (check: object) => repairPrecondition(undefined, {}, { name: 'n', download: { check } as DownloadTemplate });
      expect(asks({ minRows: 1 })).toBe(FIRST_RUN_NEEDS_TARGET);
      expect(asks({})).toBe(FIRST_RUN_NEEDS_TARGET);
      expect(repairPrecondition(undefined, {}, { name: 'n', download: { mime: ['text/csv'] } as DownloadTemplate })).toBe(FIRST_RUN_NEEDS_TARGET);
      expect(asks({ name: '^A' })).toBeUndefined();
      expect(asks({ columns: ['A'] })).toBeUndefined();
    });
    it('submit or a via download inside paginate is a write refusal', () => {
      const inPages = (step: object) => doc({ intent: 'Pages', paginate: { next: { css: 'a' }, each: [DL, step] } } as Step);
      expect(repairPrecondition(inPages({ intent: 's', submit: { button: { css: 'b' }, path: '/x' } }), out, {})).toBe(REPAIR_REFUSED_WRITES);
      expect(repairPrecondition(inPages({ intent: 'v', download: { trigger: { css: 'a' }, via: { path: '/x' }, check: { name: 'a' } } }), out, {})).toBe(REPAIR_REFUSED_WRITES);
    });
    it('the repair hand-off carries the step template for a file document and no download for a rows document', async () => {
      handoffs.on = true;
      portal.setState({ label: 'Field Actions' });
      const base = baselineScript(portal.url);
      const fileDoc: Script = { ...base, steps: [...base.steps.slice(0, 5), DL] };
      await runTask(task({ model: fakeModel([]), download: TEMPLATE }, fileDoc));
      await runTask(task({ model: fakeModel([]), download: TEMPLATE }));
      expect(handoffs.seen).toEqual([{ kind: 'file', download: TEMPLATE }, { kind: 'rows' }]);
    });
    it('repairKind and downloadTemplateOf', () => {
      expect(repairKind(doc(DL), out, {})).toBe('file');
      expect(repairKind(doc({ intent: 'Pages', paginate: { next: { css: 'a' }, each: [DL] } } as Step), out, {})).toBe('file');
      expect(repairKind(undefined, out, { download: TEMPLATE })).toBe('file');
      expect(repairKind(undefined, out, {})).toBe('rows');
      expect(repairKind({ steps: [] }, out, { download: TEMPLATE })).toBe('file');
      expect(repairKind(baselineScript('http://x'), out, { download: TEMPLATE })).toBe('rows');
      expect(downloadTemplateOf(doc(DL))).toEqual({ check: { name: '^LINEITEMS_' } });
      expect(downloadTemplateOf(doc(DL, DL))).toBeUndefined();
    });
    it('runTask returns a policy_violation config error for an unrepairable download document before any browser opens', async () => {
      const model = fakeModel([]);
      configError(await runTask(task({ model, endpoint: NO_BROWSER }, doc(DL, DL))), REPAIR_ONE_DOWNLOAD, 'script');
      configError(await runTask(firstRun({ model, endpoint: NO_BROWSER, download: TEMPLATE })), FIRST_RUN_NEEDS_TARGET, 'agent');
      expect(model.invocations).toHaveLength(0);
    });
    it('empty steps: an Expected File the download step rules refuse is a configuration error naming the problem', () => {
      const asks = (download: object) => repairPrecondition(undefined, {}, { name: 'n', download: download as DownloadTemplate });
      expect(asks({ check: { name: '(' } })).toBe('Expected File: File Name Pattern (check.name) is not a valid regex');
      const cols = Array.from({ length: 51 }, (_, i) => `C${i}`);
      expect(asks({ check: { columns: cols } })).toBe('Expected File: Required Columns (check.columns) must be 1 to 50 strings of at most 200 characters');
      expect(asks({ check: { columns: ['x'.repeat(201)] } })).toBe('Expected File: Required Columns (check.columns) must be 1 to 50 strings of at most 200 characters');
      expect(asks({ check: { name: '^A', minBytes: 200 * 1024 * 1024 + 1 } })).toBe('Expected File: Minimum Size (check.minBytes) must be between 1 and 209715200');
      expect(asks({ check: { name: '^A', minRows: 1_000_000_001 } })).toBe('Expected File: Minimum Rows (check.minRows) must be a whole number from 0 to 1000000000');
      expect(asks({ mime: [], check: { name: '^A' } })).toBe('Expected File: File Type (mime) must be a non-empty array of strings');
      expect(asks({ maxBytes: 0, check: { name: '^A' } })).toBe('Expected File: maxBytes must be between 1 and 209715200');
      expect(asks({ check: { name: '^A', extra: 1 } })).toBe('Expected File: check has unknown key "extra"');
      expect(asks({ trigger: { css: 'a' }, check: { name: '^A' } })).toBe('Expected File: download has unknown key "trigger"');
      expect(asks({ check: { name: '(', columns: ['A'], minRows: -1 } }))
        .toBe('Expected File: File Name Pattern (check.name) is not a valid regex; Minimum Rows (check.minRows) must be a whole number from 0 to 1000000000');
      expect(asks({ mime: ['text/csv'], maxBytes: 1024, check: { name: '^A', minBytes: 1, columns: ['A'], minRows: 0 } })).toBeUndefined();
    });
    it('runTask refuses an invalid Expected File before any browser opens', async () => {
      const model = fakeModel([]);
      configError(await runTask(firstRun({ model, endpoint: NO_BROWSER, output: {}, download: { check: { name: '(' } } })), 'Expected File: File Name Pattern (check.name) is not a valid regex', 'agent');
      expect(model.invocations).toHaveLength(0);
    });
  });

  it('a submit nested in a paginate body is refused too, and the same steps without AI repair are not refused', async () => {
    const nested = structuredClone(baselineScript(portal.url));
    const pages = nested.steps[5];
    if (!('paginate' in pages)) throw new Error('fixture changed');
    pages.paginate.each.push(SUBMIT);
    configError(await runTask(task({ model: fakeModel([]), endpoint: NO_BROWSER }, nested)), REPAIR_REFUSED_WRITES, 'script');
    // Without repair the refusal does not apply: the run reaches the browser (which this endpoint cannot open).
    expect(await runTask(task({ endpoint: NO_BROWSER }, nested))).toMatchObject({ ok: false, code: 'browser_unavailable', lane: 'script' });
  });

  it('empty-looking steps with repair and a name are a first run (it tries to open the browser)', async () => {
    for (const script of [[], { steps: [] }, '']) {
      const r = await runTask(task({ model: fakeModel([]), name: 'demo-sandbox', endpoint: NO_BROWSER, script }));
      expect(r).toMatchObject({ ok: false, code: 'browser_unavailable', lane: 'agent' });
    }
  });

  it('one repair per execution: a later drift says repair already ran and never calls the model', async () => {
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel(HEAL());
    const r = await runTask(task({ model, alreadyRan: true }));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
    if (!r.ok) expect(r.message.endsWith(` (${REPAIR_ALREADY_RAN})`)).toBe(true);
    const first = await runTask(firstRun({ model, alreadyRan: true, endpoint: NO_BROWSER }));
    expect(first).toMatchObject({ ok: false, code: 'drift_detected', lane: 'agent', message: REPAIR_ALREADY_RAN });
    expect(model.invocations).toHaveLength(0);
  });

  it("repaired steps keep the steps' own name; Options → Name is only the fallback", async () => {
    portal.setState({ label: 'Field Actions' });
    const r = await runTask(task({ model: fakeModel(HEAL()), name: 'another-name' }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.proposal?.name).toBe('demo-sandbox');
  });

  it('agent-lane rows reach the caller only when the proof passed, unless Deliver Unconfirmed Rows is on', async () => {
    // The section was renamed, and a release signs everyone out before prove runs, so the proof cannot pass.
    portal.setState({ label: 'Field Actions' });
    const signOut = () => { portal.setState({ label: 'Field Actions' }); return { name: 'done', args: { outcome: 'found', note: 'all seven' } }; };
    const turns = () => [clickNamed('Service'), clickNamed('Field Actions'), use('extract'), signOut];
    const script = baselineScript(portal.url);
    const withheld = await runTask(task({ model: fakeModel(turns()), deliverUnconfirmed: false }, script));
    expect(withheld).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent', llmCalls: 4 });
    if (!withheld.ok) {
      // The golden text, then why the proof did not pass.
      expect(withheld.message.startsWith(`${ROWS_WITHHELD}. Reason: `)).toBe(true);
      expect(withheld.message).toMatch(/healing session expired/);
      expect(withheld.agentLog?.map((a) => a.tool)).toEqual(['click', 'click', 'extract', 'done']);
      expect(withheld.tokens).toBeGreaterThan(0);
      expect(withheld).not.toHaveProperty('rows');
      expect(withheld.trace?.length).toBeGreaterThan(1000); // a failure keeps its trace under 'onFailure'
    }
    const delivered = await runTask(task({ model: fakeModel(turns()), deliverUnconfirmed: true }, script));
    if (!delivered.ok || delivered.lane !== 'agent') throw new Error(JSON.stringify(delivered).slice(0, 500));
    expect(delivered.rows).toHaveLength(7);
    expect(delivered.confirmed).toBe(false);
    expect(delivered.prove?.ok).toBe(false);
  });

  it('withheld rows keep a login failure from the proof replay, so the login breaker still trips', async () => {
    const input = firstRun({ model: fakeModel([]), deliverUnconfirmed: false });
    const model = fakeModel([
      SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'),
      () => { input.secrets = { ...SECRETS, password: 'rotated-pass-456' }; return { name: 'done', args: { outcome: 'found', note: 'all seven' } }; },
    ]);
    input.repair = { ...input.repair!, model };
    const r = await runTask(input);
    expect(r).toMatchObject({ ok: false, code: 'login_failed', lane: 'agent' });
    if (!r.ok) expect(r.message.startsWith(`${ROWS_WITHHELD}. Reason: `)).toBe(true);
    expect(secretsIn(r)).not.toContain('rotated-pass-456');
  });

  it('withheld rows after a compile error say which compile issue stopped the proof', async () => {
    portal.setState({ label: 'Field Actions' });
    const model = fakeModel([use('back'), clickNamed('Service'), clickNamed('Field Actions'), use('extract'), done()]);
    const r = await runTask(task({ model, deliverUnconfirmed: false }));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent' });
    if (!r.ok) {
      expect(r.message.startsWith(`${ROWS_WITHHELD}. Reason: `)).toBe(true);
      expect(r.message).toMatch(/does not undo a click/);
    }
  });

  it('agent-lane messages never show a URL query string: model notes and withheld-row reasons', async () => {
    portal.setState({ label: 'Field Actions' });
    const note = 'looked at http://x.example/list?token=abc#frag';
    const nf = await runTask(task({ model: fakeModel([done('not_found', note), done('not_found', note)]) }));
    expect(nf).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    if (!nf.ok) {
      expect(nf.message).toBe('the agent did not find the data: looked at http://x.example/list');
      expect(JSON.stringify(nf.agentLog)).not.toMatch(/token=abc|#frag/);
    }
    portal.reset();
    portal.setState({ label: 'Field Actions' });
    proveRewrite.next = (res) => ({ ...res, ok: false, reasons: ['Open the report: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/report?token=abc'] });
    const withheld = await runTask(task({ model: fakeModel(HEAL()), deliverUnconfirmed: false }));
    expect(withheld).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent' });
    if (!withheld.ok) {
      expect(withheld.message).toBe(`${ROWS_WITHHELD}. Reason: Open the report: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/report`);
    }
  });

  it('agent-lane results carry blockedRequests, files and the base name, version and hash', async () => {
    portal.setState({ label: 'Field Actions' });
    const healed = await runTask(task({ model: fakeModel(HEAL()) }));
    if (!healed.ok || healed.lane !== 'agent') throw new Error(JSON.stringify(healed).slice(0, 500));
    expect(healed).toMatchObject({ blockedRequests: [], files: [], name: 'demo-sandbox', version: 1 });
    expect(healed.hash).toMatch(/^[0-9a-f]{64}$/);
    portal.reset();
    portal.setState({ label: 'Field Actions' });
    const failed = await runTask(task({ model: fakeModel([done('not_found', 'none'), done('not_found', 'none')]) }));
    expect(failed).toMatchObject({ ok: false, code: 'not_found', lane: 'agent', blockedRequests: [], version: 1 });
    if (!failed.ok) expect(failed.hash).toMatch(/^[0-9a-f]{64}$/);
    // A first run has no base: no version or hash, and no name until the proposal names it.
    const first = await runTask(firstRun({ model: fakeModel([done('not_found', 'none')]) }));
    expect(first).toMatchObject({ ok: false, lane: 'agent', blockedRequests: [] });
    expect(first).not.toHaveProperty('hash');
  });

  it('a first run that fails at the start page reports the session blockedRequests', async () => {
    const blocked = { method: 'POST', host: 'beacon.example', path: '/collect' };
    onSession.next = (s) => { s.blockedRequests.push(blocked); };
    const policy = { ...policyFor(portal), startUrl: `${portal.url}/public/missing` };
    const r = await runTask(firstRun({ model: fakeModel([]), policy }));
    expect(r).toMatchObject({ ok: false, lane: 'agent', blockedRequests: [blocked], llmCalls: 0 });
  });

  it('llmCalls counts model call attempts on every agent-lane result: a failed call, a throw, a refusal', async () => {
    portal.setState({ label: 'Field Actions' });
    // The first invoke throws: the loop ends 'error', and the attempt still counts.
    const failing: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error('provider timed out'); } }) };
    const failed = await runTask(task({ model: failing }));
    expect(failed).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent', llmCalls: 1 });
    // The response blows up after the call returned: the agent lane's catch path still reports the attempt.
    portal.reset();
    portal.setState({ label: 'Field Actions' });
    const hostile: ChatModel = {
      bindTools: () => ({
        invoke: async () => ({ content: '', get usage_metadata(): ChatResponse['usage_metadata'] { throw new Error('bad response'); } }) as ChatResponse,
      }),
    };
    const thrown = await runTask(task({ model: hostile }));
    expect(thrown).toMatchObject({ ok: false, lane: 'agent', llmCalls: 1 });
    // Refused before the loop: no call, 0.
    const never = fakeModel([]);
    const refused = await runTask(firstRun({ model: never, endpoint: NO_BROWSER }));
    expect(refused).toMatchObject({ ok: false, code: 'browser_unavailable', lane: 'agent', llmCalls: 0 });
    expect(never.invocations).toHaveLength(0);
  });

  it('repairPrecondition needs only the name, and a name is trimmed once', async () => {
    const output = { idPattern: 'N26-\\d{4}' };
    expect(repairPrecondition(undefined, output, {})).toBe(FIRST_RUN_NEEDS_NAME);
    expect(repairPrecondition(undefined, output, { name: ' \t ' })).toBe(FIRST_RUN_NEEDS_NAME);
    expect(repairPrecondition(undefined, output, { name: ' demo-sandbox ' })).toBeUndefined();
    expect(repairPrecondition(baselineScript(portal.url), output, {})).toBeUndefined();
    // A first run named with spaces around the name builds steps named without them.
    const model = fakeModel([SIGN_IN, clickNamed('Service'), clickNamed('Recalls & Stop-Sales'), use('extract'), done('found', 'all seven')]);
    const r = await runTask(firstRun({ model, name: '  demo-sandbox  ' }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    expect(r.proposal?.name).toBe('demo-sandbox');
    expect(r.proposal?.steps.name).toBe('demo-sandbox');
  });

  it('agent budgets are clamped: at most 200 actions and 1,000,000 tokens, at least 1 action and 1,000 tokens', async () => {
    expect(clampAgentBudget({ maxActions: 10_000, maxTokens: 5_000_000 })).toEqual({ maxActions: MAX_AGENT_ACTIONS, maxTokens: MAX_AGENT_TOKENS });
    expect(clampAgentBudget({ maxActions: 0, maxTokens: 10 })).toEqual({ maxActions: 1, maxTokens: 1000 });
    expect(clampAgentBudget({ maxActions: Number.NaN, maxTokens: Number.POSITIVE_INFINITY })).toEqual({ maxActions: 40, maxTokens: 200_000 });
    expect(clampAgentBudget(undefined)).toEqual({ maxActions: 40, maxTokens: 200_000 });
    expect([MAX_AGENT_ACTIONS, MAX_AGENT_TOKENS]).toEqual([200, 1_000_000]);
    // Through runTask, a 10-token budget behaves as 1,000: at 110 tokens per fake call, the tenth call crosses it.
    const looks = fakeModel(Array.from({ length: 30 }, () => use('look')));
    const floor = await runTask(firstRun({ model: looks, agentBudget: { maxTokens: 10 } }));
    expect(floor).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent', llmCalls: 10 });
    expect(looks.invocations).toHaveLength(10);
    // …and 10,000 actions reach the agent loop as 200.
    loopBudgets.length = 0;
    await runTask(firstRun({ model: fakeModel([done('not_found', 'nothing')]), agentBudget: { maxActions: 10_000, maxTokens: 5_000_000 } }));
    expect(loopBudgets[0]).toEqual({ maxActions: 200, maxTokens: 1_000_000 });
  });
});

describe('keeping a download trigger click that opened a dialog', () => {
  const EXPORT = { role: 'button', name: 'Export' };
  const base = (): Script => ({
    name: 'dialog', version: 1, startUrl: `${portal.url}/acme/login`,
    steps: [
      ...baselineScript(portal.url).steps.slice(0, 4),
      { intent: 'Export the report', download: { trigger: EXPORT, mime: ['text/csv'], check: { name: '^report' } } },
    ],
  });
  const prior = (index?: number) => {
    const s = newRunState();
    if (index !== undefined) s.clickedTrigger = { index };
    return s;
  };
  const failure = { index: 4, intent: 'Export the report', message: 'Timeout 3000ms exceeded while waiting for event "download"' };
  it('keeps it for the attempt that resumes from the drift point', () => {
    expect(triggerClickToKeep({ base: base(), failure, prior: prior(4) }, true)).toEqual({ index: 4 });
  });
  it('never for the escalation attempt, which restarts after login and redoes its own clicks', () => {
    expect(triggerClickToKeep({ base: base(), failure, prior: prior(4) }, false)).toBeUndefined();
  });
  it('never when the trigger was not clicked, the marker is for another step, or the failed step is not a plain download', () => {
    expect(triggerClickToKeep({ base: base(), failure, prior: prior() }, true)).toBeUndefined();
    expect(triggerClickToKeep({ base: base(), failure, prior: prior(3) }, true)).toBeUndefined();
    expect(triggerClickToKeep({ base: base(), failure: { ...failure, index: 3 }, prior: prior(3) }, true)).toBeUndefined();
    const via = base();
    via.steps[4] = { intent: 'Export the report', download: { trigger: EXPORT, via: { path: '/acme/reports/export' }, check: { name: '^report' } } };
    expect(triggerClickToKeep({ base: via, failure, prior: prior(4) }, true)).toBeUndefined();
    expect(triggerClickToKeep({ failure, prior: prior(4) }, true)).toBeUndefined();
    expect(triggerClickToKeep({ base: base(), prior: prior(4) }, true)).toBeUndefined();
  });
});

describe('file repairs', () => {
  const CHECK = { name: '^report', columns: ['code', 'name'], minRows: 1 };
  /** Open the files page, then download through an export link the page no longer has: the download step drifts. */
  const filesDoc = (): Script => ({
    name: 'files-report', version: 1, startUrl: `${portal.url}/public/files`,
    steps: [
      { intent: 'Open the files page', goto: `${portal.url}/public/files` },
      { intent: 'Download the report', download: { trigger: { css: '#export-report' }, mime: ['text/csv'], check: CHECK } },
    ],
  });
  const fileTask = (over: Over = {}): TaskInput => ({
    ...task(over, filesDoc()), policy: publicPolicy(portal, { startUrl: `${portal.url}/public/files` }), secrets: undefined, output: {},
  });
  const HEAL_FILE = () => [clickNamed('report.csv', 'download'), done('found', 'the report')];

  it('a file repair whose proof fails delivers no file even with deliverUnconfirmed', async () => {
    proveRewrite.next = (r) => ({ ...r, ok: false, reasons: ['the proof downloaded no file'], file: undefined });
    const model = fakeModel(HEAL_FILE());
    const r = await runTask(fileTask({ model, deliverUnconfirmed: true }));
    expect(proveCalls).toHaveLength(1);
    expect(proveCalls[0]!.input.expectFile).toBe(true);
    expect(r).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent', message: `${FILE_WITHHELD}. Reason: the proof downloaded no file` });
    expect(r).not.toHaveProperty('files');
    expect(r).not.toHaveProperty('proposal');
    expect(model.invocations).toHaveLength(2);
  });

  it('a proven file task with no download step to name the file fails incomplete, never ok with no file', async () => {
    compileRewrite.next = (c) => ({ ...c, script: { ...c.script, steps: c.script.steps.filter((st) => !('download' in st)) } });
    const file = { fileName: 'report.csv', mimeType: 'text/csv', bytes: 20, columns: ['code', 'name'], rows: 1 };
    proveRewrite.next = (r) => ({ ...r, ok: true, reasons: [], file });
    const r = await runTask(fileTask({ model: fakeModel(HEAL_FILE()), deliverUnconfirmed: false }));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', lane: 'agent', message: FILE_NOT_DELIVERABLE });
    expect(r).not.toHaveProperty('files');
    expect(FILE_NOT_DELIVERABLE).toBe('the proof passed but there is no downloaded file to deliver, so nothing was delivered');
  });

  it('the delivered file is named after the compiled download step', async () => {
    const r = await runTask(fileTask({ model: fakeModel(HEAL_FILE()), deliverUnconfirmed: false }));
    if (!r.ok || r.lane !== 'agent') throw new Error(JSON.stringify(r).slice(0, 500));
    const at = r.proposal!.steps.steps.findIndex((s) => 'download' in s);
    expect(at).toBeGreaterThan(0);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv', binaryName: `file_${at}` });
    expect(r.confirmed).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.prove).toMatchObject({ ok: true, total: null, file: { fileName: 'report.csv', columns: ['code', 'name'], rows: 1 } });
    expect(r.proposal?.evidence.file).toEqual({ fileName: 'report.csv', mimeType: 'text/csv', bytes: r.files[0]!.data.length, columns: ['code', 'name'], rows: 1 });
    expect(r.proposal?.safetyFlags).not.toContain('count unverified: the page that was read states no total');
    expect(r.proposal?.steps.steps[at]).toMatchObject({ download: { mime: ['text/csv'], check: CHECK } });
  });
});
