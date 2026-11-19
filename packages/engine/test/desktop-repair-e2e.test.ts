// Desktop self-repair end to end on the fake runner's ERP Demo: v1 steps signed with a declared write (Save), run on
// v2 with a scripted chat model: drift, the repair session (repair-mode exploration, probe clicks, an added click held
// for approval), the proof in a fresh start of the app, and the proposal (version 2, no write flags).
import { afterEach, describe, expect, it } from 'vitest';
import { runnerTarget } from '../src/desktop/surface.js';
import {
  DESKTOP_REPAIR_NEEDS_SIGNED, PROOF_RESERVE_MS, runDesktopTask, type DesktopRepairSuccess, type DesktopTaskInput, type DesktopTaskResult,
} from '../src/desktop/task.js';
import { REPAIR_ALREADY_RAN } from '../src/messages.js';
import { desktopProposal, signDesktopSteps } from '../src/proposal/desktop.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import { stepTarget } from '../src/desktop/repair/session.js';
import type { DesktopScript, DesktopStep } from '../src/types.js';
import { fakeModel, type FakeTurn } from './fake-model.js';
import { ERP_PASSWORD, ERP_POLICY, FakeRunner, RUNNER_TOKEN, type ErpChange } from './fake-runner.js';
import { EXPECTED, VARS } from './fixtures/erp-steps.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const OWNER = 'owner@example.com';

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

/** The ref of the element `ControlType "name"` in the latest view of a tool result (the view's lines are indented). */
function ref(text: string, controlType: string, name: string): string {
  const view = text.slice(text.lastIndexOf('<page_content>'));
  const m = [...view.matchAll(/^\s*\[(e\d+)\] (\S+) "([^"]*)"/gm)].find((x) => x[2] === controlType && x[3] === name);
  if (!m) throw new Error(`no ${controlType} "${name}" in the view:\n${view}`);
  return m[1]!;
}
/** The latest view the model saw (a refused tool call carries none: the view before it still holds). */
const latestView = (messages: { content: string }[]): string => [...messages].reverse().find((m) => m.content.includes('<page_content>'))?.content ?? '';
const on = (tool: string, controlType: string, name: string): FakeTurn => (_t, messages) => ({ name: tool, args: { ref: ref(latestView(messages), controlType, name) } });
const call = (tool: string, args: Record<string, unknown> = {}): FakeTurn => () => ({ name: tool, args });

/**
 * The sample's v1 steps with sign-in by a click on Sign in instead of Enter in Password. The UiPath sample presses
 * Enter, which the review page flags as a possible write (a key that can press a default button), so under DR9 its proof
 * stops at step 4 (tested below); this variant lets the proof go on to the repaired steps.
 */
const CLICK_SIGN_IN: DesktopScript = (() => {
  const d = structuredClone(EXPECTED);
  d.steps[3] = { intent: 'Click Sign in', click: { uia: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Sign in' }, path: [{ controlType: 'Button', automationId: 'btnSignIn', name: 'Sign in' }] } } };
  return d;
})();

/** The v1 steps as the owner approved them: Save (step 16) declared a write. */
function signedV1(writeSteps = [16], script: DesktopScript = CLICK_SIGN_IN): { script: unknown; trust: DesktopTaskInput['trust'] } {
  const p = desktopProposal(script);
  const signed = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps });
  if (!signed.ok) throw new Error(signed.reasons.join('; '));
  return { script: JSON.parse(JSON.stringify(signed.row.steps)) as unknown, trust: { required: true, signature: signed.row.signature, approvedBy: OWNER, key: KEY } };
}

async function run(turns: FakeTurn[], opts: { erpChanges?: ErpChange[]; erpUi?: 'v1' | 'v2'; more?: Partial<DesktopTaskInput>; writeSteps?: number[]; script?: DesktopScript } = {}) {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: opts.erpUi ?? 'v2', ...(opts.erpChanges ? { erpChanges: opts.erpChanges } : {}) });
  const model = fakeModel(turns);
  const v1 = signedV1(opts.writeSteps, opts.script);
  const r = await runDesktopTask({
    ...v1, runner: runner.endpoint, vars: VARS, secretVars: ['password'], defaultStepTimeoutMs: 400, budgetMs: 120_000,
    repair: { model, goal: 'Export the line items of a company as a CSV file' }, ...opts.more,
  });
  return { r, model, runner };
}

const repaired = (r: DesktopTaskResult): DesktopRepairSuccess => {
  if (!r.ok) throw new Error(`expected a repair, got ${r.code}: ${r.message}`);
  if (r.lane !== 'agent') throw new Error('expected the agent lane');
  return r;
};

/** Every control the approved v1 steps act on, as runner targets. */
const approvedTargets = new Set([...EXPECTED.steps, ...CLICK_SIGN_IN.steps].map((s) => stepTarget(s)).filter((l) => l !== undefined).map((l) => JSON.stringify(runnerTarget(l!))));

/** The fake runner's act requests: none carries write, and every step-mode act is on a control the owner approved. */
function assertNoWriteAndNoUnapprovedStepAct(r: FakeRunner): void {
  const acts = r.requests.filter((q) => q.method === 'act');
  expect(acts.filter((q) => q.params.write === true)).toEqual([]);
  for (const q of acts) {
    const mode = (q.params.mode as string | undefined) ?? 'step';
    if (mode === 'step' && q.params.target !== undefined) expect(approvedTargets.has(JSON.stringify(q.params.target)), JSON.stringify(q.params.target)).toBe(true);
    if (mode === 'probe') expect(['click', 'doubleClick']).toContain(q.params.action);
  }
}

/**
 * The ERP Demo v2 repair as the live model did it: Find for Search, Reports opened without closing File first (the
 * stale "Click File" folds, B7), Export line items..., Continue added.
 */
const V2_TURNS: FakeTurn[] = [
  on('use_target', 'Button', 'Find'),
  on('expand', 'MenuItem', 'Reports'),
  on('use_target', 'MenuItem', 'Export line items...'),
  on('add_step', 'Button', 'Continue'),
];

describe('desktop self-repair on the fake runner', () => {
  it('v2: repairs Find and the Reports menu, adds Continue without clicking it, proves up to it and proposes version 2', async () => {
    const { r, model, runner: fr } = await run(V2_TURNS);
    const out = repaired(r);
    expect(out.llmCalls).toBe(4);
    expect(model.tools.map((t) => t.function.name)).toEqual(['look', 'expand', 'select_item', 'read', 'escape', 'use_target', 'add_step', 'give_up']);
    expect(out.completed).toBe(false);
    expect(out.files).toEqual([]);
    expect(out.outputs).toEqual([]);

    const steps = out.proposal.steps.steps;
    expect(steps).toHaveLength(EXPECTED.steps.length + 1);
    // v1's "Click File" (step 12) folded away: Reports replaced it.
    expect(steps.map((s) => s.intent).filter((i) => i === 'Click File')).toEqual([]);
    expect(steps.map((s) => s.intent).slice(8, 15)).toEqual([
      'Click Find', 'Read Result count as out_ResultCount', 'Read First document as out_FirstDocument', 'Click Reports', 'Click Export line items...',
      'Click Continue', 'Wait for the window Export line items',
    ]);
    // DR6: no write flags at all; the approver marks writes again.
    expect(steps.filter((s: DesktopStep) => s.write !== undefined)).toEqual([]);
    expect(out.proposal).toMatchObject({ name: 'erp-1', baseVersion: 1, version: 2 });
    expect(out.digest).toBe(proposalDigest(out.proposal));
    // DR9: Continue is held (write word in its id and title) and also looks like a write: the proof resolves it only.
    expect(out.proof).toEqual({ replayed: 13, stoppedAt: 14, stoppedBecause: 'looks like a write', changedSteps: [9, 13], addedSteps: [12, 14] });
    expect(out.proposal.evidence.proof).toEqual(out.proof);
    // Continue and Save are flagged as candidate writes for the approver.
    expect(out.proposal.safetyFlags.filter((f) => f.startsWith('candidate write'))).toEqual([
      'candidate write: step 14 (Click Continue) may save, post or submit', 'candidate write: step 17 (Click Save) may save, post or submit',
    ]);

    // DR3 and the runner floor: nothing was written and no unapproved control was acted on in step mode, in the repair
    // or in the proof; Continue (id btnConfirmExport, in "Confirm export") was never clicked.
    assertNoWriteAndNoUnapprovedStepAct(fr);
    const acts = fr.requests.filter((q) => q.method === 'act');
    expect(acts.some((q) => JSON.stringify(q.params.target ?? {}).includes('btnConfirmExport'))).toBe(false);
    // Repair mode: the session's expand of Reports, and the proof's replay of "Click Reports" as that expand (B6).
    expect(acts.filter((q) => q.params.mode === 'repair').map((q) => q.params.action)).toEqual(['expand', 'expand']);
    // The proof: the repair run ended with a reservation for the proof's run, which started the app again.
    expect(fr.reservations).toEqual([{ runId: expect.any(String), ms: PROOF_RESERVE_MS }, { runId: undefined, ms: undefined }]);
    const begins = fr.requests.filter((q) => q.method === 'run.begin').map((q) => q.params.runId);
    expect(begins).toHaveLength(2);
    expect(begins[1]).toBe(fr.reservations[0]!.runId);
    expect(fr.requests.filter((q) => q.method === 'app.launch')).toHaveLength(2);
    // The proof resolved Continue and did not act on it.
    const proofStart = fr.requests.findIndex((q) => q.method === 'run.begin' && q.params.runId === begins[1]);
    const proofReqs = fr.requests.slice(proofStart);
    expect(proofReqs.filter((q) => q.method === 'act').map((q) => [q.params.action, q.params.mode ?? 'step'])).toEqual([
      ['type', 'step'], ['type', 'step'], ['click', 'step'], ['select', 'step'], ['type', 'step'], ['type', 'step'], ['click', 'probe'],
      ['read', 'step'], ['read', 'step'], ['expand', 'repair'], ['click', 'probe'],
    ]);
    expect(proofReqs.some((q) => q.method === 'resolve' && JSON.stringify(q.params.target).includes('btnConfirmExport'))).toBe(true);

    // Masking: the password never reaches the model, the transcript, the proposal or the log.
    const everything = JSON.stringify([model.invocations, out.transcript, out.proposal, out.log, out.note, out.agentLog]);
    expect(everything).not.toContain(ERP_PASSWORD);
    expect(everything).not.toContain(RUNNER_TOKEN);
    expect(everything).not.toContain(KEY);
    // The model saw the app only as text, wrapped as untrusted data.
    expect(model.invocations[0]![1]!.content).toContain('<page_content>');
  });

  it('with the UiPath sample (sign-in by Enter) the proof stops at step 4, which looks like a write (DR9)', async () => {
    const { r, runner: fr } = await run(V2_TURNS, { script: EXPECTED });
    const out = repaired(r);
    expect(out.proof).toEqual({ replayed: 3, stoppedAt: 4, stoppedBecause: 'looks like a write', changedSteps: [9, 13], addedSteps: [12, 14] });
    assertNoWriteAndNoUnapprovedStepAct(fr);
    const begins = fr.requests.filter((q) => q.method === 'run.begin').map((q) => q.params.runId);
    const proofReqs = fr.requests.slice(fr.requests.findIndex((q) => q.method === 'run.begin' && q.params.runId === begins[1]));
    expect(proofReqs.filter((q) => q.method === 'act').map((q) => q.params.action)).toEqual(['type', 'type']);
    expect(proofReqs.some((q) => q.method === 'resolve' && JSON.stringify(q.params.target).includes('txtPassword'))).toBe(true);
    expect(out.note).toContain('the proof stopped at step 4 (looks like a write: found, not run)');
  });

  it('without the confirm dialog the repair goes on to the declared write, resolves it and stops there', async () => {
    const { r, runner: fr } = await run([V2_TURNS[0]!, call('escape'), ...V2_TURNS.slice(1, 3)], { erpUi: 'v1', erpChanges: ['rename', 'menu'] });
    const out = repaired(r);
    expect(out.proof).toEqual({ replayed: 15, stoppedAt: 16, stoppedBecause: 'declared write', changedSteps: [9, 13], addedSteps: [12] });
    expect(out.proposal.steps.steps).toHaveLength(EXPECTED.steps.length);
    assertNoWriteAndNoUnapprovedStepAct(fr);
    // Save was resolved (twice: the repair and the proof) and never clicked.
    const save = JSON.stringify(runnerTarget(stepTarget(CLICK_SIGN_IN.steps[15]!)!));
    expect(fr.requests.filter((q) => q.method === 'resolve' && JSON.stringify(q.params.target) === save).length).toBeGreaterThanOrEqual(2);
    expect(fr.requests.some((q) => q.method === 'act' && JSON.stringify(q.params.target) === save)).toBe(false);
    expect(fr.lastExportDir === undefined || fr.requests.every((q) => q.method !== 'file.retrieve')).toBe(true);
  });

  it('a model that gives up ends as drift with its reason and the cost', async () => {
    const { r } = await run([call('give_up', { reason: 'no control does what Search did' })]);
    if (r.ok) throw new Error('expected a failure');
    expect(r).toMatchObject({ code: 'drift_detected', lane: 'agent', llmCalls: 1 });
    expect(r.message).toContain('AI repair did not fix it: the repair gave up: no control does what Search did');
    expect(r.message).toMatch(/It used 1 chat model call and [\d,]+ tokens\.$/);
  });

  it('a held or already-run repair, and unsigned steps, report the drift with the reason and call no model', async () => {
    for (const [more, why] of [
      [{ repair: { model: fakeModel([]), alreadyRan: true } }, REPAIR_ALREADY_RAN],
      [{ repair: { model: fakeModel([]), held: 'a repair of these steps already failed' } }, 'a repair of these steps already failed'],
    ] as [Partial<DesktopTaskInput>, string][]) {
      const { r } = await run([], { more });
      await runner?.close();
      runner = undefined;
      if (r.ok) throw new Error('expected a failure');
      expect(r.code).toBe('drift_detected');
      expect(r.message.endsWith(`(${why})`)).toBe(true);
      expect(r.llmCalls).toBeUndefined();
    }
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const model = fakeModel([]);
    const r = await runDesktopTask({ script: EXPECTED, trust: { required: false }, runner: runner.endpoint, vars: VARS, defaultStepTimeoutMs: 400, repair: { model } });
    if (r.ok) throw new Error('expected a failure');
    expect(r.message.endsWith(`(${DESKTOP_REPAIR_NEEDS_SIGNED})`)).toBe(true);
    expect(model.invocations).toHaveLength(0);
  });

  it('a failed declared write step is never repaired (DR2)', async () => {
    // The owner marked Search a write: on v2 it fails, and the repair does not start.
    const model = fakeModel([]);
    const { r } = await run([], { writeSteps: [9, 16], more: { repair: { model } } });
    if (r.ok) throw new Error('expected a failure');
    expect(r.code).toBe('drift_detected');
    expect(r.message).toContain('(AI repair not attempted on step 9: it is a declared write step, and AI repair never changes a write step: update it by hand)');
    expect(model.invocations).toHaveLength(0);
  });

  it('a step-mode click on an unapproved control never happens: a repair-mode click on a Button is refused and the model is told', async () => {
    const { r, runner: fr } = await run([on('select_item', 'Button', 'Find'), call('give_up', { reason: 'stuck' })]);
    if (r.ok) throw new Error('expected a failure');
    expect(r.agentLog?.[0]).toMatchObject({ tool: 'select_item', ok: false });
    expect(r.agentLog?.[0]?.note).toContain('select_item takes a tab, list item or tree item, not a Button');
    assertNoWriteAndNoUnapprovedStepAct(fr);
  });

  it('use_target never moves a plain step onto a control that reads like a write', async () => {
    const { r, runner: fr } = await run([on('use_target', 'Button', 'Post'), call('give_up', { reason: 'only Post is left' })]);
    if (r.ok) throw new Error('expected a failure');
    expect(r.agentLog?.[0]?.note).toContain('reads like a write or a destructive action, and step 9 does not');
    assertNoWriteAndNoUnapprovedStepAct(fr);
    expect(fr.requests.some((q) => q.method === 'act' && JSON.stringify(q.params.target ?? {}).includes('btnPost'))).toBe(false);
  });

  it('use_target and add_step refuse a destructive control such as Cancel', async () => {
    const { r, runner: fr } = await run([
      on('use_target', 'Button', 'Find'), call('escape'), on('expand', 'MenuItem', 'Reports'), on('use_target', 'MenuItem', 'Export line items...'),
      on('use_target', 'Button', 'Cancel'), on('add_step', 'Button', 'Cancel'), call('give_up', { reason: 'stuck' }),
    ]);
    if (r.ok) throw new Error('expected a failure');
    expect(r.agentLog?.slice(4).map((a) => [a.tool, a.ok])).toEqual([['use_target', false], ['add_step', false], ['give_up', true]]);
    expect(r.agentLog?.[5]?.note).toContain('looks like it deletes, cancels');
    assertNoWriteAndNoUnapprovedStepAct(fr);
    expect(fr.requests.some((q) => q.method === 'act' && JSON.stringify(q.params.target ?? {}).includes('btnCancelExport'))).toBe(false);
  });
});

