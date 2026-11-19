// How steps AI repair added or changed act before approval (DesktopSurface.changedSteps), the engine's deny list on
// names and ids, add_step after a failed check, and the per-fix cap checked before any click.
import { afterEach, describe, expect, it } from 'vitest';
import { connectRunner } from '../src/desktop/client.js';
import { CHANGED_STEP_NOT_RUN } from '../src/desktop/handlers.js';
import { looksDestructive, probeBlock } from '../src/desktop/repair/session.js';
import { buildTree } from '../src/desktop/repair/tree.js';
import { createDesktopSurface, type ChangedStep, type DesktopViewItem } from '../src/desktop/surface.js';
import { runDesktopTask, type DesktopTaskResult } from '../src/desktop/task.js';
import { desktopProposal, signDesktopSteps } from '../src/proposal/desktop.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import { createMasker } from '../src/secrets/mask.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { DesktopLocator, DesktopScript, DesktopStep, Step } from '../src/types.js';
import { fakeModel, type FakeTurn } from './fake-model.js';
import { DEMO_PASSWORD, DEMO_POLICY, DEMO_USER, ERP_PASSWORD, ERP_POLICY, ERP_USER, FakeRunner } from './fake-runner.js';
import { EXPECTED, VARS } from './fixtures/erp-steps.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const OWNER = 'owner@example.com';
let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const MAIN = { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' };
const at = (window: object, cond: Record<string, string>): DesktopLocator => ({ uia: { window, path: [cond] } });

/** Signed in on ERP Demo v2, with a surface and step context on the run, as runDesktopTask builds them. */
async function onErp(runId: string) {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
  const client = await connectRunner(runner.endpoint);
  await client.call('run.begin', { runId, leaseMs: 5000 });
  await client.call('app.launch', { runId, app: { exe: 'ErpDemo.exe' } });
  const surface = createDesktopSurface(client, runId, { exe: 'ErpDemo.exe' });
  const ctx: StepContext = {
    page: undefined as never, surface, script: { surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [] } as never,
    policy: { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] },
    vars: {}, masker: createMasker([]), defaultTimeoutMs: 1000, violations: [],
  };
  surface.trackStep(() => ctx.stepIndex);
  const login = { title: 'ERP Demo - Sign in' };
  await client.call('act', { runId, target: { window: login, path: [{ automationId: 'txtUser' }] }, action: 'type', value: ERP_USER, timeoutMs: 1000 });
  await client.call('act', { runId, target: { window: login, path: [{ automationId: 'txtPassword' }] }, action: 'type', value: ERP_PASSWORD, timeoutMs: 1000 });
  await client.call('act', { runId, target: { window: login, path: [{ automationId: 'btnSignIn' }] }, action: 'click', timeoutMs: 1000 });
  return { client, surface, ctx, runId };
}

const acts = () => runner!.requests.filter((q) => q.method === 'act').slice(3).map((q) => [q.params.action, q.params.mode ?? 'step']);

describe('changed steps act as their marks say', () => {
  it('expand and escape replay as repair-mode acts (B6, B4); probe clicks, repair-mode reads; check-only acts in step mode (B5)', async () => {
    const { client, surface, ctx } = await onErp('marks');
    const steps: DesktopStep[] = [
      { intent: 'Click Reports', click: at(MAIN, { controlType: 'MenuItem', name: 'Reports' }) },
      { intent: 'Press Escape', key: { key: 'Escape' } },
      { intent: 'Click Find', click: at(MAIN, { controlType: 'Button', automationId: 'btnFind' }) },
      { intent: 'Read the count', read: { target: at(MAIN, { automationId: 'lblResultCount' }), as: 'n' } },
      { intent: 'Click Find', click: at(MAIN, { controlType: 'Button', automationId: 'btnFind' }), expect: { visible: at(MAIN, { automationId: 'lblResultCount' }) } },
    ];
    const marks: ChangedStep[] = ['expand', 'escape', 'probe', 'probe', 'checkOnly'];
    marks.forEach((m, i) => surface.changedSteps.set(i, m));
    const res = await runSteps(ctx, steps as unknown as Step[], newRunState());
    expect(res.ok).toBe(true);
    expect(acts()).toEqual([['expand', 'repair'], ['key', 'repair'], ['click', 'probe'], ['read', 'repair'], ['click', 'step']]);
    await client.close();
  });

  it('a changed step that would type, choose, check or press another key is refused before anything is sent', async () => {
    const { client, surface, ctx } = await onErp('refuse');
    for (const [step, mark] of [
      [{ intent: 'Type', fill: { field: at(MAIN, { automationId: 'txtDateFrom' }), value: 'x' } }, 'probe'],
      [{ intent: 'Choose', select: { field: at(MAIN, { automationId: 'cmbCompany' }), option: '2000' } }, 'probe'],
      [{ intent: 'Press Enter', key: { key: 'Enter' } }, 'escape'],
      [{ intent: 'Click Find', click: at(MAIN, { automationId: 'btnFind' }), write: true }, 'checkOnly'],
    ] as [DesktopStep, ChangedStep][]) {
      surface.changedSteps.clear();
      surface.changedSteps.set(0, mark);
      const res = await runSteps(ctx, [step] as unknown as Step[], newRunState());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure.message).toContain(CHANGED_STEP_NOT_RUN);
    }
    expect(acts()).toEqual([]);
    await client.close();
  });
});

describe('the deny list reads names and automation ids (I1)', () => {
  const item = (ref: string, depth: number, controlType: string, name: string, automationId = '', parent?: string): DesktopViewItem => ({
    ref, depth, controlType, name, fullName: name, automationId, className: '', enabled: true, ...(parent ? { parent } : {}),
  });
  it('an icon-only btnReject, Sign out, Discard changes and an id like cmdRevokeAll read as destructive; Next, Back and Find do not', () => {
    for (const [name, id] of [['', 'btnReject'], ['Sign out', ''], ['Discard changes', ''], ['', 'cmdRevokeAll'], ['', 'btn_archive']]) expect(looksDestructive(name!, id!), `${name} ${id}`).toBe(true);
    for (const [name, id] of [['Next', 'btnNext'], ['Back', 'btnBack'], ['Find', 'btnFind'], ['Payments overview', '']]) expect(looksDestructive(name!, id!), `${name} ${id}`).toBe(false);
  });
  it('probeBlock holds a button whose id alone is destructive', () => {
    const roots = buildTree([item('e1', 0, 'Window', 'Review'), item('e2', 1, 'Button', '', 'btnReject', 'e1'), item('e3', 1, 'Button', 'Next', 'btnNext', 'e1')]);
    expect(probeBlock(roots[0]!.children[0]!, roots, 'Review')).toMatch(/deletes, cancels, rejects or signs out/);
    expect(probeBlock(roots[0]!.children[1]!, roots, 'Review')).toBeUndefined();
  });
});

/** The sample with sign-in by a click (DR9 lets the proof go on), Search given a check that no longer holds. */
function signed(script: DesktopScript) {
  const p = desktopProposal(script);
  const s = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [16] });
  if (!s.ok) throw new Error(s.reasons.join('; '));
  return { script: JSON.parse(JSON.stringify(s.row.steps)) as unknown, trust: { required: true, signature: s.row.signature, approvedBy: OWNER, key: KEY } };
}
const latestView = (messages: { content: string }[]): string => [...messages].reverse().find((m) => m.content.includes('<page_content>'))?.content ?? '';
function ref(text: string, controlType: string, name: string | RegExp): string {
  const view = text.slice(text.lastIndexOf('<page_content>'));
  const m = [...view.matchAll(/^\s*\[(e\d+)\] (\S+) "([^"]*)"/gm)].find((x) => x[2] === controlType && (typeof name === 'string' ? x[3] === name : name.test(x[3]!)));
  if (!m) throw new Error(`no ${controlType} ${String(name)} in the view:\n${view}`);
  return m[1]!;
}
const on = (tool: string, controlType: string, name: string | RegExp): FakeTurn => (_t, messages) => ({ name: tool, args: { ref: ref(latestView(messages), controlType, name) } });
const call = (tool: string, args: Record<string, unknown> = {}): FakeTurn => () => ({ name: tool, args });

describe('a failed check', () => {
  it('add_step is refused after a failed check (I2); use_target moves only the check, and the proof runs the approved action in step mode (B5)', async () => {
    const d = structuredClone(EXPECTED);
    d.steps[3] = { intent: 'Click Sign in', click: at({ exe: 'erpdemo.exe', title: 'ERP Demo - Sign in' }, { controlType: 'Button', automationId: 'btnSignIn', name: 'Sign in' }) };
    // v1's Search, with a check on a label the app no longer has.
    d.steps[8] = { ...d.steps[8]!, expect: { visible: at(MAIN, { controlType: 'Text', automationId: 'lblMatches' }) } };
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v1' });
    const model = fakeModel([on('add_step', 'Button', 'Post'), on('use_target', 'Text', /line items$/)]);
    const r: DesktopTaskResult = await runDesktopTask({
      ...signed(d), runner: runner.endpoint, vars: VARS, secretVars: ['password'], defaultStepTimeoutMs: 400, budgetMs: 120_000, repair: { model },
    });
    if (!r.ok || r.lane !== 'agent') throw new Error(`expected a repair: ${r.ok ? r.lane : r.message}`);
    expect(r.agentLog[0]).toMatchObject({ tool: 'add_step', ok: false });
    expect(r.agentLog[0]!.note).toContain('only its check failed: call use_target on the control the check should look at, or give_up');
    expect(r.proposal.steps.steps[8]).toMatchObject({ intent: 'Click Search', expect: { visible: { uia: { path: [{ controlType: 'Text', automationId: 'lblResultCount' }] } } } });
    expect(r.proof).toEqual({ replayed: 15, stoppedAt: 16, stoppedBecause: 'declared write', changedSteps: [9], addedSteps: [] });
    // The proof clicked the approved Search in step mode (its action did not change), and only once.
    const begins = runner.requests.filter((q) => q.method === 'run.begin').map((q) => q.params.runId);
    const proof = runner.requests.slice(runner.requests.findIndex((q) => q.method === 'run.begin' && q.params.runId === begins[1]));
    const search = proof.filter((q) => q.method === 'act' && JSON.stringify(q.params.target ?? {}).includes('btnSearch'));
    expect(search.map((q) => q.params.mode ?? 'step')).toEqual(['step']);
    expect(runner.requests.some((q) => q.method === 'act' && q.params.mode === 'probe')).toBe(false);
  });
});

describe('the per-fix cap', () => {
  it('is checked before add_step clicks anything (low)', async () => {
    const uia = (automationId: string, controlType = 'Edit'): DesktopLocator => ({ uia: { path: [{ controlType, automationId }] } });
    const d: DesktopScript = {
      surface: 'desktop', name: 'orders', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [
        { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
        { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
        { intent: 'Sign in', click: uia('btnSignIn', 'Button') },
        { intent: 'Run the search', click: uia('btnSearchOld', 'Button') },
      ],
    };
    runner = await FakeRunner.start({ policy: DEMO_POLICY });
    const model = fakeModel([
      on('select_item', 'TabItem', 'Orders'), on('select_item', 'TabItem', 'Customers'), on('select_item', 'TabItem', 'Orders'),
      on('add_step', 'Button', 'Search'), call('give_up', { reason: 'stuck' }),
    ]);
    const p = desktopProposal(d);
    const s = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [] });
    if (!s.ok) throw new Error(s.reasons.join('; '));
    const r = await runDesktopTask({
      script: s.row.steps, trust: { required: true, signature: s.row.signature, approvedBy: OWNER, key: KEY }, runner: runner.endpoint,
      vars: { user: DEMO_USER, password: DEMO_PASSWORD }, defaultStepTimeoutMs: 400, budgetMs: 60_000, repair: { model },
    });
    if (r.ok) throw new Error('expected a failure');
    expect(r.agentLog?.[3]).toMatchObject({ tool: 'add_step', ok: false });
    expect(r.agentLog?.[3]?.note).toContain('a fix may add at most 3 steps');
    expect(runner.requests.some((q) => q.method === 'act' && q.params.mode === 'probe')).toBe(false);
  });
});
