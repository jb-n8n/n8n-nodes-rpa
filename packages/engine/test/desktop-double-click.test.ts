// The desktop doubleClick step: parsed, described, run (the runner action doubleClick), judged as a click by the write
// rules, and given by a recording's `double` click and by a UiPath desktop double click (never by a browser one).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runDesktopTask, type DesktopTaskResult } from '../src/desktop/task.js';
import { chromeEvents } from '../src/import/chrome.js';
import { importSource } from '../src/import/index.js';
import type { ImportReport, ImportResult } from '../src/import/types.js';
import { declareWrites, describeDesktopStep, desktopSafetyFlags, desktopWriteCandidates } from '../src/proposal/desktop.js';
import { signScript } from '../src/sign.js';
import { parseDesktopScript, parseScript, ScriptShapeError } from '../src/steps/parse.js';
import type { DesktopLocator, DesktopScript } from '../src/types.js';
import { DEMO_PASSWORD, DEMO_USER, FakeRunner } from './fake-runner.js';

const uia = (automationId: string, controlType = 'Edit', name?: string): DesktopLocator => ({ uia: { path: [{ controlType, automationId, ...(name ? { name } : {}) }] } });
const doc = (steps: unknown[]) => ({ surface: 'desktop', name: 'erp-orders', version: 1, app: { exe: 'ErpDemo.exe' }, steps });
const issues = (d: unknown): string[] => {
  try {
    parseDesktopScript(d);
    return [];
  } catch (err) {
    return (err as ScriptShapeError).issues;
  }
};

describe('the doubleClick desktop step', () => {
  it('parses as a click does, with the same options and the write mark', () => {
    const step = { intent: 'Open the order', doubleClick: uia('row1', 'DataItem', 'Order Row 1'), timeoutMs: 5000, optional: true, write: true, when: { visible: uia('gridOrders', 'DataGrid') } };
    expect(parseDesktopScript(doc([step])).steps[0]).toEqual(step);
    expect(issues(doc([{ intent: 'x', doubleClick: 'row1' }]))).toEqual(['steps[0].doubleClick must be a locator object']);
    expect(issues(doc([{ intent: 'x', doubleClick: { css: '#row1' } }]))).toEqual([expect.stringContaining('steps[0].doubleClick')]);
    expect(issues(doc([{ intent: 'x', doubleClick: uia('row1'), click: uia('row1') }]))).toEqual(['steps[0] must have exactly one action (click, doubleClick, fill, select, check, waitFor, read, key, expectFile)']);
    // Write may be declared on it, as on a click; not on a read.
    expect(issues(doc([{ intent: 'x', read: { target: uia('a'), as: 'count' }, write: true }]))).toEqual(['steps[0].write is only allowed on click, doubleClick, fill, select, check and key steps']);
  });

  it('is not a browser step: a browser step list is unchanged', () => {
    expect(() => parseScript({ startUrl: 'https://example.com/', steps: [{ intent: 'Open', doubleClick: { css: '#row1' } }] })).toThrow(ScriptShapeError);
  });

  it('describes as a double-click in the change list', () => {
    expect(describeDesktopStep({ intent: 'Double-click Order Row 1', doubleClick: uia('row1', 'DataItem', 'Order Row 1') })).toBe(
      'Double-click Order Row 1 (double-click "DataItem" id "row1" name "Order Row 1")',
    );
    expect(describeDesktopStep({ intent: 'Double-click Post', doubleClick: uia('btnPost', 'Button'), write: true })).toBe('Double-click Post (double-click "Button" id "btnPost"; declared write)');
  });

  it('the write heuristic and the signing declaration treat it as a click', () => {
    const script = parseDesktopScript(doc([
      { intent: 'Double-click Save', doubleClick: uia('btnSave', 'Button') },
      { intent: 'Double-click Order Row 1', doubleClick: uia('row1', 'DataItem') },
      { intent: 'Click Save', click: uia('btnSave', 'Button') },
    ])) as DesktopScript;
    expect(desktopWriteCandidates(script)).toEqual([1, 3]);
    expect(desktopSafetyFlags(script).filter((f) => f.startsWith('candidate write'))).toEqual([
      expect.stringMatching(/^candidate write: step 1 \(Double-click Save\)/), expect.stringMatching(/^candidate write: step 3 \(Click Save\)/),
    ]);
    const declared = declareWrites(script, [1, 2]);
    expect(declared.ok && declared.script.steps.map((s) => s.write)).toEqual([true, true, undefined]);
    expect(desktopSafetyFlags((declared as { script: DesktopScript }).script)[1]).toBe('write: step 1 (Double-click Save) is a declared write step');
  });
});

const KEY = 'desktop-signing-key-0123456789abcdef';
const WHO = 'ops@example.com';
const SIGN_IN = [
  { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
  { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
  { intent: 'Sign in', click: uia('btnSignIn', 'Button'), expect: { visible: uia('txtSearch') } },
];
let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});
async function run(d: unknown): Promise<DesktopTaskResult> {
  runner ??= await FakeRunner.start();
  const trust = { required: true, signature: signScript(d, KEY, { approvedBy: WHO }).signature, approvedBy: WHO, key: KEY };
  return runDesktopTask({ script: d, trust, runner: runner.endpoint, vars: { user: DEMO_USER, password: DEMO_PASSWORD }, defaultStepTimeoutMs: 2000 });
}

describe('running a doubleClick step', () => {
  it('sends the runner action doubleClick, and a declared write control needs write: true as for a click', async () => {
    const post = (write: boolean) => doc([...SIGN_IN, { intent: 'Double-click Post', doubleClick: uia('btnPost', 'Button'), ...(write ? { write: true } : {}) }]);
    const refused = await run(post(false));
    expect(refused).toMatchObject({ ok: false, code: 'policy_violation', message: 'Double-click Post: Button #btnPost is a declared write control: the step must be a declared write' });
    expect(runner!.lastApp?.posted).toBe(0);
    const ok = await run(post(true));
    expect(ok).toMatchObject({ ok: true, submitted: true });
    expect(runner!.lastApp?.posted).toBe(1);
    const acts = runner!.requests.filter((q) => q.method === 'act' && q.params.action === 'doubleClick');
    expect(acts.at(-1)?.params).toMatchObject({ action: 'doubleClick', write: true, mode: 'step', target: { path: [{ controlType: 'Button', automationId: 'btnPost' }] } });
  });
});

const RECORDING = fileURLToPath(new URL('./fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
const recording = (): Record<string, any> => JSON.parse(readFileSync(RECORDING, 'utf8'));
const errors = (r: ImportResult) => r.report.items.filter((i) => i.kind === 'error');

describe('a doubleClick from a recording', () => {
  it('a recording click with double: true gives a doubleClick step', () => {
    const rec = recording();
    rec.events[9].double = true;
    const r = importSource('recording', JSON.stringify(rec), { name: 'erp', hasSiteLogin: false });
    expect(errors(r)).toEqual([]);
    expect(r.desktopDrafts![0].script.steps[9]).toEqual({
      intent: 'Double-click Vendor Row 1', doubleClick: { uia: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' }, path: [{ controlType: 'DataItem', name: 'Vendor Row 1' }] } },
    });
    // The ERP fixture itself has none and imports as before.
    const plain = importSource('recording', readFileSync(RECORDING), { name: 'erp', hasSiteLogin: false });
    expect(plain.desktopDrafts![0].script.steps.some((s) => 'doubleClick' in s)).toBe(false);
  });

  it('double is only ever true, and only on a click', () => {
    const notTrue = recording();
    notTrue.events[9].double = false;
    const r = importSource('recording', JSON.stringify(notTrue), { name: 'erp', hasSiteLogin: false });
    expect(errors(r).map((i) => i.reason)).toEqual(['the recording is not valid, so nothing was imported: events[9].double must be true when it is there']);
    const onFill = recording();
    onFill.events[1].double = true;
    expect(errors(importSource('recording', JSON.stringify(onFill), { name: 'erp', hasSiteLogin: false })).map((i) => i.reason)).toEqual([
      'the recording is not valid, so nothing was imported: events[1] has the unknown key "double"',
    ]);
  });
});

const NS = 'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
const xaml = (body: string) => `<Activity x:Class="Main" ${NS}><Sequence DisplayName="Main">${body}</Sequence></Activity>`;
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const open = (body: string) =>
  `<ui:OpenApplication DisplayName="Open ERP" FileName="ErpDemo.exe" Selector="${esc("<wnd app='erpdemo.exe' title='ERP Demo - Line items' />")}"><ui:OpenApplication.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>${body}</Sequence></ActivityAction></ui:OpenApplication.Body></ui:OpenApplication>`;
const target = (selector: string) => `<ui:Target Selector="${esc(selector)}" />`;

describe('a doubleClick from UiPath, desktop only', () => {
  it('a desktop DoubleClick, or a Click whose ClickType is double, gives a doubleClick step without the single-click note', () => {
    const row = "<uia automationid='row1' name='Order Row 1' role='list item' />";
    const r = importSource('uipath', xaml(open([
      `<ui:DoubleClick DisplayName="Double Click 'Order Row 1'" sap2010:WorkflowViewState.IdRef="D1"><ui:DoubleClick.Target>${target(row)}</ui:DoubleClick.Target></ui:DoubleClick>`,
      `<ui:Click DisplayName="Click 'Order Row 1'" ClickType="CLICK_DOUBLE" sap2010:WorkflowViewState.IdRef="D2"><ui:Click.Target>${target(row)}</ui:Click.Target></ui:Click>`,
      `<ui:Click DisplayName="Click 'Search'" sap2010:WorkflowViewState.IdRef="D3"><ui:Click.Target>${target("<uia automationid='btnSearch' name='Search' role='button' />")}</ui:Click.Target></ui:Click>`,
    ].join(''))), { name: 'd', hasSiteLogin: false });
    expect(errors(r)).toEqual([]);
    const steps = r.desktopDrafts![0].script.steps;
    expect(steps.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['waitFor', 'doubleClick', 'doubleClick', 'click']);
    expect(steps[1].intent).toBe('Double-click Order Row 1');
    expect(r.report.items.map((i) => i.reason).join('\n')).not.toMatch(/double click became/);
  });

  it('a browser double click is unchanged: UiPath gives no doubleClick, Chrome a click with its note', () => {
    const browser = `<uix:NApplicationCard DisplayName="Use Browser: Portal"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      <uix:NClick DisplayName="Click 'Reports'" ClickType="CLICK_DOUBLE"><uix:NClick.Target><uix:TargetAnchorable FullSelectorArgument="${esc("<webctrl tag='A' aaname='Reports' />")}" /></uix:NClick.Target></uix:NClick>
      </Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp Url="https://portal.example.com/app" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
    const r = importSource('uipath', xaml(browser), { name: 'b', hasSiteLogin: false });
    expect(r.drafts[0].script.steps.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['goto', 'click']);
    expect(JSON.stringify(r)).not.toContain('doubleClick');
    const report: ImportReport = { source: 'chrome', steps: 0, items: [] };
    const events = chromeEvents({ title: 't', steps: [{ type: 'navigate', url: 'https://portal.example.com/' }, { type: 'doubleClick', selectors: [['#row1']] }] }, report);
    expect(events.map((e) => e.kind)).toEqual(['goto', 'click']);
    expect(report.items).toContainEqual(expect.objectContaining({ kind: 'converted', reason: 'a double click became a single click: check that one click does the same' }));
  });
});
