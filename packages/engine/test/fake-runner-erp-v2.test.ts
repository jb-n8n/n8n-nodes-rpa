// The fake runner's ERP Demo v2 model (desktop/erp-demo with --ui v2), its menus, expand, Escape and `windows`, as the
// real runner showed them on windows-latest (desktop/runner/test/Rpa.Runner.Scenario, its OBSERVE lines).
import { afterEach, describe, expect, it } from 'vitest';
import { connectRunner, type RunnerClient } from '../src/desktop/client.js';
import { METHOD_NOT_FOUND, RunnerError, type RunnerTarget, type RunnerWindow } from '../src/desktop/protocol.js';
import { runDesktopTask } from '../src/desktop/task.js';
import { desktopProposal, signDesktopSteps } from '../src/proposal/desktop.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import type { UiaCond, WindowSel } from '../src/types.js';
import { ERP_EXE, ERP_PASSWORD, ERP_POLICY, ERP_USER, erpCsv, erpLineItems, FakeRunner, type FakeRunnerOptions } from './fake-runner.js';
import { EXPECTED, VARS } from './fixtures/erp-steps.js';

const KEY = 'desktop-v2-signing-key-0123456789';
const OWNER = 'owner@example.com';
const RUN = 'run-v2';
const MAIN = { title: 'ERP Demo - Line items' };
const LOGIN = { title: 'ERP Demo - Sign in' };
const MAIN_CLASS = 'WindowsForms10.Window.8.app.0.2bf8098_r6_ad1';
const DROP_DOWN_CLASS = 'WindowsForms10.Window.808.app.0.2bf8098_r6_ad1';
const REPAIR_REFUSAL = 'policy_refused: repair mode allows only focus, expand, read, Escape without a target, and click on tabs, list items and tree items';
const ESCAPE_REFUSAL = 'policy_refused: in repair mode Escape could press a declared write control of this window (a cancel button), so it is allowed only while a menu is open';

let runner: FakeRunner | undefined;
let client: RunnerClient | undefined;
afterEach(async () => {
  await client?.close();
  await runner?.close();
  client = undefined;
  runner = undefined;
});

const t = (window: WindowSel | undefined, ...path: UiaCond[]): RunnerTarget => ({ ...(window ? { window } : {}), path });
const menuItem = (name: string, window?: WindowSel) => t(window, { controlType: 'MenuItem', name });

/** Starts the fake on the ERP Demo, begins a run and launches the app (with `args` when given). */
async function launch(opts: FakeRunnerOptions = {}, args?: string[]): Promise<RunnerClient> {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, ...opts });
  client = await connectRunner(runner.endpoint);
  await client.call('run.begin', { runId: RUN, leaseMs: 60_000 });
  await client.call('app.launch', { runId: RUN, app: { exe: ERP_EXE, ...(args ? { args } : {}) } });
  return client;
}
const c = () => client!;
const act = (target: RunnerTarget, action: 'click' | 'expand' | 'type' | 'select' | 'read' | 'focus', extra: { value?: string; write?: boolean; mode?: 'repair'; segments?: ({ text: string } | { exportDir: true })[] } = {}) =>
  c().call('act', { runId: RUN, target, action, timeoutMs: 200, ...extra });
const key = (value: string, extra: { target?: RunnerTarget; write?: boolean; mode?: 'repair' } = {}) =>
  c().call('act', { runId: RUN, action: 'key', value, timeoutMs: 200, ...extra });
const resolve = (target: RunnerTarget) => c().call('resolve', { runId: RUN, target, timeoutMs: 0 });
const windows = async (): Promise<RunnerWindow[]> => (await c().call('windows', { runId: RUN })).windows;
const titles = async () => (await windows()).map((w) => w.title);
const snapshot = (params: { window?: WindowSel; maxNodes?: number; maxDepth?: number } = {}) => c().call('snapshot', { runId: RUN, ...params });
/** The runner's error for a call that must fail. */
const failure = (p: Promise<unknown>) => p.then(
  () => { throw new Error('expected the runner to answer an error'); },
  (e: unknown) => { if (!(e instanceof RunnerError)) throw e; return { code: e.code, message: e.message }; },
);

async function signIn(): Promise<void> {
  await act(t(LOGIN, { automationId: 'txtUser' }), 'type', { value: ERP_USER });
  await act(t(LOGIN, { automationId: 'txtPassword' }), 'type', { value: ERP_PASSWORD });
  await act(t(LOGIN, { automationId: 'btnSignIn' }), 'click');
}
async function search(button = 'btnFind'): Promise<void> {
  await act(t(MAIN, { automationId: 'cmbCompany' }), 'select', { value: '1000' });
  await act(t(MAIN, { automationId: button }), 'click');
}

describe('ERP Demo v2 in the fake runner', () => {
  it('v1 steps fail on v2 at Click Search', async () => {
    const p = desktopProposal(EXPECTED);
    const signed = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [16] });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const r = await runDesktopTask({
      script: JSON.parse(JSON.stringify(signed.row.steps)) as unknown, trust: { required: true, signature: signed.row.signature, approvedBy: OWNER, key: KEY },
      runner: runner.endpoint, vars: VARS, defaultStepTimeoutMs: 300,
    });
    if (r.ok) throw new Error('the v1 steps ran on v2');
    expect(r.code).toBe('drift_detected');
    expect(r.failure?.index).toBe(8);
    expect(r.message).toContain('btnSearch');
  });

  it('args --ui v2 select v2; customSave renames the save button', async () => {
    await launch({}, ['--ui', 'v2']);
    await signIn();
    expect(await resolve(t(MAIN, { controlType: 'Button', automationId: 'btnFind', name: 'Find' }))).toEqual({ candidate: 0 });
    expect((await failure(resolve(t(MAIN, { automationId: 'btnSearch' })))).code).toBe(-32004);
    await act(menuItem('File', MAIN), 'click');
    await resolve(menuItem('Exit'));
    expect((await failure(resolve(menuItem('Export...')))).code).toBe(-32004);
    await client!.close();
    await runner!.close();

    // --ui v1 wins over the option; customSave alone keeps v1's menu and button, and changes only the export dialog.
    await launch({ erpUi: 'v2', erpChanges: ['customSave'] }, ['--ui', 'v1']);
    await signIn();
    await search('btnSearch');
    await act(menuItem('File', MAIN), 'click');
    await act(menuItem('Export...'), 'click');
    expect((await windows())[0]).toEqual({ title: 'Export line items', exe: ERP_EXE, automationId: 'ExportForm', className: MAIN_CLASS, foreground: true });
    const dialog = { title: 'Export line items' };
    expect(await resolve(t(dialog, { controlType: 'Button', automationId: 'btnExportSave', name: 'Export' }))).toEqual({ candidate: 0 });
    await resolve(t(dialog, { controlType: 'Button', automationId: 'btnExportCancel', name: 'Cancel' }));
    expect((await failure(resolve(t(dialog, { automationId: '1' })))).code).toBe(-32004);
    await act(t(dialog, { controlType: 'Edit', automationId: '1001', name: 'File name:', className: 'Edit' }), 'type', { segments: [{ exportDir: true }, { text: '\\line-items.csv' }] });
    await act(t(dialog, { automationId: 'btnExportSave' }), 'click');
    const file = await c().call('file.retrieve', { runId: RUN, pattern: '^line-items\\.csv$', timeoutMs: 1000, maxBytes: 1_000_000 });
    expect(Buffer.from(file.base64, 'base64').toString('utf8')).toBe(erpCsv(erpLineItems('1000', '2026-01-01', '2026-12-31')));
  });

  it('each change stands alone: rename keeps the File menu\'s Export...', async () => {
    await launch({ erpChanges: ['rename'] });
    await signIn();
    await search('btnFind');
    await act(menuItem('File', MAIN), 'click');
    await act(menuItem('Export...'), 'click');
    // No Confirm export without 'confirm': the Save dialog opens at once.
    expect((await windows())[0]).toMatchObject({ title: 'Export line items', className: '#32770', foreground: true });
  });

  it('expand on Reports opens its drop-down; Escape closes it', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    expect(await titles()).toEqual(['ERP Demo - Line items', 'Reports']);
    const dropDown = await snapshot({ window: { title: 'Reports' } });
    expect(dropDown.window).toEqual({ title: 'Reports', exe: ERP_EXE });
    expect(dropDown.nodes.map((n) => [n.depth, n.controlType, n.name])).toEqual([[0, 'Menu', 'Reports'], [1, 'MenuItem', 'Export line items...']]);
    await key('Escape');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
  });

  it('one Escape leaves the menu bar in menu mode (Down reopens the drop-down); the second leaves it', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    await key('Escape');
    await key('Down');
    expect(await titles()).toEqual(['ERP Demo - Line items', 'Reports']);
    await key('Escape');
    await key('Escape');
    await key('Down');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    // Any targeted action leaves menu mode too.
    await act(menuItem('Reports', MAIN), 'expand');
    await key('Escape');
    await act(t(MAIN, { automationId: 'txtDateFrom' }), 'focus');
    await key('Down');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
  });

  it('expanding Help while Reports is open closes Reports; a click on an open top-level item closes it', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    await act(menuItem('Help', MAIN), 'expand');
    expect(await windows()).toEqual([
      { title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: MAIN_CLASS, foreground: true },
      { title: 'Help', exe: ERP_EXE, automationId: '', className: DROP_DOWN_CLASS, foreground: false },
    ]);
    await resolve(menuItem('About'));
    expect((await failure(resolve(menuItem('Export line items...')))).code).toBe(-32004);
    await act(menuItem('Help', MAIN), 'click');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    await act(menuItem('Reports', MAIN), 'click');
    expect(await titles()).toEqual(['ERP Demo - Line items', 'Reports']);
  });

  it('while a drop-down is open the main form\'s tree holds it, and its items resolve exactly once from any window', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    // No window selector: the foreground window, the main form, with the drop-down nested under its menu item.
    const snap = await snapshot();
    expect(snap.window).toEqual({ title: 'ERP Demo - Line items', exe: ERP_EXE });
    const at = snap.nodes.findIndex((n) => n.controlType === 'MenuItem' && n.name === 'Reports');
    expect(snap.nodes.slice(at, at + 3).map((n) => [n.depth - snap.nodes[at].depth, n.controlType, n.name])).toEqual([
      [0, 'MenuItem', 'Reports'], [1, 'Menu', 'Reports'], [2, 'MenuItem', 'Export line items...'],
    ]);
    for (const window of [MAIN, { exe: 'erpdemo.exe' }, { title: 'Reports' }, undefined]) {
      expect(await resolve(menuItem('Export line items...', window)), JSON.stringify(window)).toEqual({ candidate: 0 });
      expect(await c().call('isVisible', { runId: RUN, target: menuItem('Export line items...', window) })).toEqual({ visible: true });
    }
    await key('Escape');
    expect(snap.nodes.length).toBeGreaterThan((await snapshot()).nodes.length);
    expect((await failure(resolve(menuItem('Export line items...')))).code).toBe(-32004);
  });

  it('repair mode refuses a Button click and Enter, allows expand on a MenuItem and Escape', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    expect(await failure(act(t(MAIN, { controlType: 'Button', name: 'Find' }), 'click', { mode: 'repair' }))).toEqual({
      code: -32003, message: 'policy_refused: repair mode may click only tabs, list items and tree items, not a Button',
    });
    expect(await failure(key('Enter', { mode: 'repair' }))).toEqual({ code: -32003, message: REPAIR_REFUSAL });
    expect(await failure(key('Escape', { mode: 'repair', target: t(MAIN, { automationId: 'txtDateFrom' }) }))).toEqual({ code: -32003, message: REPAIR_REFUSAL });
    expect(await failure(act(t(MAIN, { automationId: 'txtDateFrom' }), 'type', { mode: 'repair', value: 'x' }))).toEqual({ code: -32003, message: REPAIR_REFUSAL });
    expect(await failure(key('Ctrl+S', { mode: 'repair' }))).toEqual({ code: -32003, message: 'policy_refused: the gated key Ctrl+S is never allowed in repair mode' });
    expect(await failure(act(t(MAIN, { automationId: 'btnPost' }), 'click', { mode: 'repair' }))).toEqual({
      code: -32003, message: 'policy_refused: the target is a declared write control; repair mode never acts on it',
    });
    // The main form holds btnPost: a repair Escape needs an open drop-down of it.
    expect(await failure(key('Escape', { mode: 'repair' }))).toEqual({ code: -32003, message: ESCAPE_REFUSAL });

    await act(menuItem('Reports', MAIN), 'expand', { mode: 'repair' });
    await act(menuItem('Export line items...'), 'read', { mode: 'repair' });
    await key('Escape', { mode: 'repair' });
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    // Menu mode is no open menu: the second repair Escape is refused; a step-mode Escape leaves menu mode.
    expect(await failure(key('Escape', { mode: 'repair' }))).toEqual({ code: -32003, message: ESCAPE_REFUSAL });
    await key('Escape');
    await key('Down');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    expect(runner!.lastApp?.posted).toBe(0);
  });

  it('expand on an element that cannot expand answers -32602; a ComboBox expands', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    expect(await failure(act(t(MAIN, { automationId: 'btnFind' }), 'expand', { mode: 'repair' }))).toEqual({ code: -32602, message: 'invalid params: the element cannot expand' });
    await act(menuItem('Reports', MAIN), 'expand');
    expect(await failure(act(menuItem('Export line items...'), 'expand'))).toEqual({ code: -32602, message: 'invalid params: the element cannot expand' });
    await act(t(MAIN, { automationId: 'cmbCompany' }), 'expand', { mode: 'repair' });
  });

  it('Continue opens the Save dialog; Escape on Confirm export cancels the export', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await search();
    const openConfirm = async () => {
      await act(menuItem('Reports', MAIN), 'click');
      await act(menuItem('Export line items...'), 'click');
    };
    await openConfirm();
    expect(await windows()).toEqual([
      { title: 'Confirm export', exe: ERP_EXE, automationId: 'ConfirmExportForm', className: MAIN_CLASS, foreground: true },
      { title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: MAIN_CLASS, foreground: false },
    ]);
    const snap = await snapshot();
    expect(snap.window).toEqual({ title: 'Confirm export', exe: ERP_EXE });
    expect(snap.nodes.map((n) => [n.controlType, n.automationId, n.name])).toEqual([
      ['Window', 'ConfirmExportForm', 'Confirm export'],
      ['Text', 'lblConfirm', 'Export 12 line items to a CSV file?'],
      ['Button', 'btnConfirmExport', 'Continue'],
      ['Button', 'btnCancelExport', 'Cancel'],
    ]);
    // No write control in Confirm export: a repair Escape cancels it.
    await key('Escape', { mode: 'repair' });
    expect(await windows()).toEqual([{ title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: MAIN_CLASS, foreground: true }]);

    await openConfirm();
    await act(t({ title: 'Confirm export' }, { controlType: 'Button', name: 'Continue' }), 'click');
    expect((await windows())[0]).toEqual({ title: 'Export line items', exe: ERP_EXE, automationId: '', className: '#32770', foreground: true });
    await key('Escape', { mode: 'repair' });
    expect(await titles()).toEqual(['ERP Demo - Line items']);

    // Cancel cancels; Continue, a file name and Save write the CSV.
    await openConfirm();
    await act(t({ title: 'Confirm export' }, { automationId: 'btnCancelExport' }), 'click');
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    await openConfirm();
    await act(t({ title: 'Confirm export' }, { automationId: 'btnConfirmExport' }), 'click');
    const save = { title: 'Export line items', className: '#32770' };
    await act(t(save, { controlType: 'Edit', automationId: '1001' }), 'type', { segments: [{ exportDir: true }, { text: '\\line-items.csv' }] });
    await act(t(save, { controlType: 'Button', automationId: '1' }), 'click', { write: true });
    expect(await titles()).toEqual(['ERP Demo - Line items']);
    const file = await c().call('file.retrieve', { runId: RUN, pattern: '^line-items\\.csv$', timeoutMs: 1000, maxBytes: 1_000_000 });
    expect(Buffer.from(file.base64, 'base64').toString('utf8')).toBe(erpCsv(erpLineItems('1000', '2026-01-01', '2026-12-31')));
  });

  it('windows lists the main form first and the drop-down second; noWindowsMethod answers -32601', async () => {
    await launch({ erpUi: 'v2' });
    expect(await windows()).toEqual([{ title: 'ERP Demo - Sign in', exe: ERP_EXE, automationId: 'LoginForm', className: MAIN_CLASS, foreground: true }]);
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    expect(await windows()).toEqual([
      { title: 'ERP Demo - Line items', exe: ERP_EXE, automationId: 'MainForm', className: MAIN_CLASS, foreground: true },
      { title: 'Reports', exe: ERP_EXE, automationId: '', className: DROP_DOWN_CLASS, foreground: false },
    ]);
    await client!.close();
    await runner!.close();

    await launch({ erpUi: 'v2', noWindowsMethod: true });
    expect(await failure(windows())).toEqual({ code: METHOD_NOT_FOUND, message: 'method not found' });
  });

  it('snapshot honours its window selector and says when maxNodes or maxDepth cut it short', async () => {
    await launch({ erpUi: 'v2' });
    await signIn();
    await act(menuItem('Reports', MAIN), 'expand');
    // A selector matching several windows takes the front-most: the drop-down sits above the main form.
    expect((await snapshot({ window: { exe: ERP_EXE } })).window.title).toBe('Reports');
    expect((await snapshot({ window: MAIN })).window.title).toBe('ERP Demo - Line items');
    expect(await failure(snapshot({ window: { title: 'Nope' } }))).toEqual({ code: -32004, message: 'not_found: no element matched window {title="Nope"} (no matching window of the run)' });
    const full = await snapshot();
    expect(full).not.toHaveProperty('truncated');
    const cut = await snapshot({ maxNodes: 3 });
    expect(cut.nodes).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    expect((await snapshot({ maxDepth: 1 })).truncated).toBe(true);
    // As the runner's SnapshotBuilder: reaching maxNodes counts as cut short, even on the last node.
    expect((await snapshot({ window: { title: 'Reports' }, maxNodes: 2 })).truncated).toBe(true);
    expect(await snapshot({ window: { title: 'Reports' }, maxNodes: 3 })).not.toHaveProperty('truncated');
  });
});
