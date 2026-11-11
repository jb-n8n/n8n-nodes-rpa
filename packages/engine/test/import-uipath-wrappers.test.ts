import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importSource } from '../src/import/index.js';
import type { FlowNode, ImportItem, ImportOptions, ImportResult } from '../src/import/types.js';
import { parseDesktopScript, parseScript } from '../src/steps/parse.js';
import type { DesktopStep, Step } from '../src/types.js';
import { SECRETS } from './helpers.js';

/** A fixture project zipped under its folder, as Studio exports it. */
function fixtureZip(folder: string): Buffer {
  const dir = fileURLToPath(new URL(`./fixtures/import/${folder}/`, import.meta.url));
  const entries: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else entries[`${folder}/${relative(dir, p).split('\\').join('/')}`] = strToU8(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return Buffer.from(zipSync(entries));
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const xaml = (body: string) => `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:s="clr-namespace:System;assembly=mscorlib" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
<Sequence DisplayName="Main sequence">${body}</Sequence></Activity>`;
const target = (selector: string) => `<uix:TargetAnchorable FullSelectorArgument="${esc(selector)}" />`;
const card = (body: string, url = 'https://portal.example.com/app') =>
  `<uix:NApplicationCard DisplayName="Use Browser Chrome: Portal"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">${body}</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp BrowserType="Chrome" Url="${url}" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
const app = (body: string) =>
  `<uix:NApplicationCard DisplayName="Use Application: Ledger Demo"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">${body}</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp FilePath="LedgerDemo.exe" Selector="&lt;wnd app='ledgerdemo.exe' title='Ledger Demo' /&gt;" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
const click = (name: string, selector: string) => `<uix:NClick DisplayName="Click '${name}'"><uix:NClick.Target>${target(selector)}</uix:NClick.Target></uix:NClick>`;
const typeInto = (name: string, selector: string, text: string) =>
  `<uix:NTypeInto DisplayName="Type Into '${name}'" Text="${esc(text)}"><uix:NTypeInto.Target>${target(selector)}</uix:NTypeInto.Target></uix:NTypeInto>`;
const retry = (body: string) => `<ui:RetryScope DisplayName="Retry Scope" NumberOfRetries="3"><ui:RetryScope.ActivityBody><ActivityAction><Sequence>${body}</Sequence></ActivityAction></ui:RetryScope.ActivityBody></ui:RetryScope>`;
const checkState = (selector: string, yes: string, no = '') =>
  `<uix:NCheckState DisplayName="Check App State 'Popup'"><uix:NCheckState.IfExists><Sequence>${yes}</Sequence></uix:NCheckState.IfExists><uix:NCheckState.IfNotExists><Sequence>${no}</Sequence></uix:NCheckState.IfNotExists><uix:NCheckState.Target>${target(selector)}</uix:NCheckState.Target></uix:NCheckState>`;

const steps = (r: ImportResult): Step[] => r.drafts.flatMap((d) => d.script.steps);
const desktopSteps = (r: ImportResult): DesktopStep[] => (r.desktopDrafts ?? []).flatMap((d) => d.script.steps);
const kinds = (r: ImportResult, kind: ImportItem['kind']) => r.report.items.filter((i) => i.kind === kind);
/** The approval's left-out list: untranslated items, and dropped ones whose absence changes what the bot does. */
const leftOut = (r: ImportResult) => r.report.items.filter((i) => i.kind === 'untranslated' || (i.kind === 'dropped' && !i.notNeeded)).map((i) => i.what);
const EACH_STEP_CHECKS = 'Each step checks again just before it runs, so a step that makes the element show or go away changes which of the later steps run';

describe('UiPath blocks that wrap UI activities: the fixture with every kind', () => {
  const OPTS: ImportOptions = { name: 'wrappers', hasSiteLogin: false };

  it('imports the UI activities inside each block, in order, with conditions where the block tests an element', () => {
    const r = importSource('uipath', fixtureZip('uipath-wrappers'), OPTS);
    expect(kinds(r, 'error')).toEqual([]);
    expect(r.drafts.map((d) => d.name)).toEqual(['wrappers-1', 'wrappers-3', 'wrappers-4', 'wrappers-5']);
    for (const d of r.drafts) expect(parseScript(d.script)).toEqual(d.script);
    const accept = { role: 'button', name: 'Accept cookies', exact: true };
    expect(r.drafts[0].script.steps).toEqual([
      { intent: 'Open orders.example.com/app', goto: 'https://orders.example.com/app' },
      // Retry Scope: its body, once.
      { intent: 'Click Orders', click: { role: 'link', name: 'Orders', exact: true } },
      { intent: 'Click Refresh', click: { role: 'button', name: 'Refresh', exact: true } },
      // Try Catch: the Try.
      { intent: 'Type into Search', fill: { field: { label: 'Search', exact: true }, value: 'open invoices' } },
      { intent: 'Click Apply', click: { role: 'button', name: 'Apply', exact: true } },
      // Check App State: "Target appears" runs only when the element shows.
      { intent: 'Click Accept cookies', when: { visible: accept }, click: accept },
      // Element Exists, then an If on its answer: Then when it shows, Else when it does not.
      { intent: 'Click Dismiss notice', when: { visible: { css: '#maintenance-notice' } }, click: { role: 'button', name: 'Dismiss notice', exact: true } },
      { intent: 'Click Notices', when: { hidden: { css: '#maintenance-notice' } }, click: { role: 'link', name: 'Notices', exact: true } },
      // While: its body, once.
      { intent: 'Click Next page', click: { role: 'link', name: 'Next page', exact: true } },
    ]);
    // The Switch's cases and the Flowchart's two paths.
    expect(r.drafts.slice(1).map((d) => d.script.steps.map((s) => s.intent))).toEqual([
      ['Open reports.example.com/emea', 'Click EMEA report'],
      ['Open reports.example.com/amer', 'Click AMER report'],
      ['Open orders.example.com/export', 'Click Start export', 'Click Open the file list', 'Click Try again'],
    ]);

    // The desktop app: Retry Scope's body, Check App State's "Target appears" with a condition, Do While's body once.
    expect(r.desktopDrafts?.map((d) => d.name)).toEqual(['wrappers-2']);
    const desk = r.desktopDrafts![0];
    expect(parseDesktopScript(desk.script)).toEqual(desk.script);
    const window = { exe: 'ledgerdemo.exe', title: 'Ledger Demo' };
    const dismiss = { controlType: 'Button', automationId: 'btnDismiss', name: 'Dismiss' };
    expect(desk.script.steps.map((s) => s.intent)).toEqual(['Wait for the window Ledger Demo', 'Click Post batch', 'Click Dismiss', 'Click Next record']);
    expect(desk.script.steps[2]).toMatchObject({ when: { visible: { uia: { window, path: [dismiss] } } }, click: { uia: { path: [dismiss] } } });
    expect(desk.script.steps.filter((s) => s.when).length).toBe(1);
    // A desktop step that may write is only ever a candidate, inside a block as anywhere else.
    expect(desk.writeCandidates).toEqual([2]);
    expect(desk.script.steps.some((s) => 'write' in s)).toBe(false);

    const ifNode = (key: string, then: FlowNode[], other: FlowNode[]): FlowNode => ({ kind: 'if', expression: `region = "${key}"`, displayName: `Switch on region: ${key}`, then, else: other });
    expect(r.flow).toEqual({
      name: 'Orders and Ledger',
      nodes: [
        { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Orders portal' },
        { kind: 'desktop', sequence: 2, displayName: 'Use Application: Ledger Demo' },
        ifNode('EMEA', [{ kind: 'browser', sequence: 3, displayName: 'Use Browser Chrome: EMEA reports' }], [
          ifNode('AMER', [{ kind: 'browser', sequence: 4, displayName: 'Use Browser Chrome: AMER reports' }], [{ kind: 'wait', seconds: 30, displayName: 'Wait for the next run' }]),
        ]),
        { kind: 'browser', sequence: 5, displayName: 'Use Browser Chrome: Export' },
      ],
    });
  });

  it('reports each block once, says what was flattened, and lists what the steps do not do as left out', () => {
    const r = importSource('uipath', fixtureZip('uipath-wrappers'), OPTS);
    // The app's path and the candidate write are reported as for any desktop import; every other item is a block's.
    const rest = r.report.items.filter((i) => i.kind === 'candidateWrite' || i.what === 'Use Application: Ledger Demo');
    expect(rest.map((i) => [i.kind, i.what])).toEqual([['converted', 'Use Application: Ledger Demo'], ['candidateWrite', 'Step 2: Click Post batch']]);
    const blocks = r.report.items.filter((i) => !rest.includes(i));
    expect(blocks).toEqual<ImportItem[]>([
      {
        at: 'Main.xaml: RetryScope_1', kind: 'converted', what: 'Retry Scope: open the orders',
        reason: "RetryScope: its 2 activities were imported once, in order. The steps do not retry them: a step that fails ends the run, and n8n's Retry On Fail setting on the Run steps node runs all the steps again. Its check that they worked (1 activity) was not imported",
      },
      {
        at: 'Main.xaml: TryCatch_1', kind: 'converted', what: 'Try Catch: search',
        reason: 'TryCatch: its 2 activities in Try were imported, in order. When a step from Try fails, the run stops there: nothing in Catch runs',
      },
      {
        at: 'Main.xaml: TryCatch_1', kind: 'untranslated', what: 'Catch Exception',
        reason: 'the catch branch (1 activity) was not imported: give the n8n node an error output or the workflow an error workflow',
      },
      {
        at: 'Main.xaml: NCheckState_1', kind: 'converted', what: "Check App State 'Cookie banner'",
        reason: `NCheckState: the steps from its 1 activity under "Target appears" run only when Cookie banner shows. ${EACH_STEP_CHECKS}`,
      },
      {
        at: 'Main.xaml: ElementExists_2', kind: 'converted', what: "Element Exists 'Maintenance notice'",
        reason: 'ElementExists: it became the condition of the steps in If the notice shows',
      },
      {
        at: 'Main.xaml: If_1', kind: 'converted', what: 'If the notice shows',
        reason: `If: it tests noticeShown, the answer of Element Exists 'Maintenance notice': the steps from its 1 activity under Then run only when Maintenance notice shows, and those from its 1 activity under Else only when it does not. ${EACH_STEP_CHECKS}`,
      },
      {
        at: 'Main.xaml: While_1', kind: 'untranslated', what: 'While more pages',
        reason: 'While: the loop was not imported: its 1 activity was imported to run once, in order. To repeat the steps, give the Run steps node one item per repetition: n8n runs the steps once for each item',
      },
      {
        at: 'Main.xaml: RetryScope_2', kind: 'converted', what: 'Retry Scope: post the batch',
        reason: "RetryScope: its 1 activity was imported once, in order. The steps do not retry them: a step that fails ends the run, and n8n's Retry On Fail setting on the Run steps node runs all the steps again",
      },
      {
        at: 'Main.xaml: NCheckState_2', kind: 'converted', what: "Check App State 'Warning'",
        reason: `NCheckState: the steps from its 1 activity under "Target appears" run only when Warning shows. ${EACH_STEP_CHECKS}`,
      },
      {
        at: 'Main.xaml: DoWhile_1', kind: 'untranslated', what: 'Do While records are left',
        reason: 'DoWhile: the loop was not imported: its 1 activity was imported to run once, in order. To repeat the steps, give the Run steps node one item per repetition: n8n runs the steps once for each item',
      },
      {
        at: 'Main.xaml: Switch`1_1', kind: 'converted', what: 'Switch on region',
        reason: 'Switch: each of its cases (EMEA, AMER) became an n8n If on region, and Default comes after the last one: fill in their conditions in the workflow; until then every run takes the first case',
      },
      {
        at: 'Main.xaml: FlowDecision_1', kind: 'untranslated', what: 'Export ready?',
        reason: 'FlowDecision: the decision was not imported: the activities on its True path, then those on its False path, were imported one after another, so every run does both. Check the order, and remove the steps the run should not do or make the choice in n8n',
      },
    ]);
    // What the bot did that the steps do not: the catch branch, both loops' repetition, the Flowchart's decision.
    expect(leftOut(r)).toEqual(['Catch Exception', 'While more pages', 'Do While records are left', 'Export ready?']);
    // Every UI activity but the catch's became a step: 8 in the portal (and its goto), 3 in the app (and the wait for its
    // window), one in each case (and its goto), 3 in the Flowchart (and its goto).
    expect(r.report.steps).toBe(9 + 4 + 2 + 2 + 4);
  });
});

describe('UiPath blocks: the standard state-machine template', () => {
  const OPTS: ImportOptions = { name: 'invoices', hasSiteLogin: false, vars: { in_InvoiceNumber: 'INV-1' } };

  // The fixture is shaped as Studio saves the standard template (checked against UiPath's published template, which is not
  // copied here): the first state in the file is not the initial one, each state is written inside the transition that
  // first reaches it, the initial state's failure transition (to End Process, a final state) comes before its success
  // transition, and some transitions' actions only log or comment.
  it('imports each state\'s entry in the order of the states and names each state in the report', () => {
    const r = importSource('uipath', fixtureZip('uipath-state-machine'), OPTS);
    expect(kinds(r, 'error')).toEqual([]);
    expect(r.drafts.map((d) => [d.name, d.script.steps.map((s) => s.intent)])).toEqual([
      ['invoices-1', ['Open invoices.example.com', 'Click Invoices']],
      // Process Transaction and End Process follow each other with nothing between: one browser sequence, as two Use
      // Browser activities in a row always are.
      ['invoices-2', ['Open invoices.example.com/invoices', 'Type into Invoice number', 'Click Open', 'Open invoices.example.com', 'Click Sign out']],
    ]);
    expect(r.drafts[1].script.steps[1]).toMatchObject({ fill: { value: '{{var.in_InvoiceNumber}}' } });
    expect(r.flow).toEqual({
      name: 'Invoice Approval',
      nodes: [
        { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Invoice portal' },
        { kind: 'untranslated', activity: 'GetQueueItem', displayName: 'Get Transaction Item', note: 'this activity has no step equivalent in this release' },
        { kind: 'browser', sequence: 2, displayName: 'Use Browser Chrome: Approve an invoice' },
      ],
    });
    expect(r.report.items).toEqual<ImportItem[]>([
      {
        at: 'Main.xaml: StateMachine_1', kind: 'untranslated', what: 'General Business Process',
        reason: 'StateMachine: its transitions were not imported: the entry activities of its 4 states were imported once each, one after another, in this order: Initialization, Get Transaction Data, Process Transaction, End Process. The steps never go back to an earlier state, as a state machine does to take the next transaction: check the order, and give the Run steps node one item per transaction in n8n',
      },
      { at: 'Main.xaml: State_1', kind: 'converted', what: 'State "Initialization"', reason: 'state 1 of 4: the steps from its entry (2 activities): Open invoices.example.com, Click Invoices' },
      { at: 'Main.xaml: LogMessage_1', kind: 'dropped', what: 'Log Message (Initialization)', reason: "logging is not a step: the run's own record and n8n's executions show what happened", notNeeded: true },
      // A transition whose action only logs or comments is accounted for, but not listed as left out.
      { at: 'Main.xaml: Transition_2', kind: 'dropped', what: 'Transition "System Exception (failed initialization)"', reason: 'its trigger and action (1 activity) only log or comment, which the steps do not need', notNeeded: true },
      { at: 'Main.xaml: Transition_1', kind: 'dropped', what: 'Transition "Successful"', reason: 'its trigger and action (1 activity) only log or comment, which the steps do not need', notNeeded: true },
      { at: 'Main.xaml: State_2', kind: 'converted', what: 'State "Get Transaction Data"', reason: 'state 2 of 4: its entry (1 activity) gave no UI steps' },
      { at: 'Framework/GetTransactionData.xaml: GetQueueItem_1', kind: 'untranslated', what: 'Get Transaction Item', reason: 'GetQueueItem: this activity has no step equivalent in this release' },
      { at: 'Main.xaml: Transition_4', kind: 'untranslated', what: 'Transition "No Data"', reason: 'its trigger and action (2 activities) were not imported: the steps do not move between states' },
      { at: 'Main.xaml: State_3', kind: 'converted', what: 'State "Process Transaction"', reason: 'state 3 of 4: the steps from its entry (2 activities): Open invoices.example.com/invoices, Type into Invoice number, Click Open' },
      {
        at: 'Main.xaml: TryCatch_1', kind: 'converted', what: 'Try Catch (process the transaction)',
        reason: 'TryCatch: its 1 activity in Try was imported, in order. When a step from Try fails, the run stops there: nothing in Catch runs',
      },
      { at: 'Main.xaml: TryCatch_1', kind: 'untranslated', what: 'Catch BusinessRuleException', reason: 'the catch branch (1 activity) was not imported: give the n8n node an error output or the workflow an error workflow' },
      { at: 'Main.xaml: TryCatch_1', kind: 'untranslated', what: 'Catch Exception', reason: 'the catch branch (1 activity) was not imported: give the n8n node an error output or the workflow an error workflow' },
      { at: 'Main.xaml: State_4', kind: 'converted', what: 'State "End Process"', reason: 'state 4 of 4: the steps from its entry (1 activity): Open invoices.example.com, Click Sign out' },
    ]);
    expect(leftOut(r)).toEqual(['General Business Process', 'Get Transaction Item', 'Transition "No Data"', 'Catch BusinessRuleException', 'Catch Exception']);
  });

  it('a state machine read today would have imported nothing: no state is lost when a state is reached only by a reference', () => {
    // The same machine with every state written at the top and joined by references only.
    const state = (id: number, name: string, entry: string, to: number[]) => `<State x:Name="__R${id}" DisplayName="${name}"><State.Entry>${entry}</State.Entry><State.Transitions>${to.map((t) => `<Transition DisplayName="to ${t}" To="{x:Reference __R${t}}" />`).join('')}</State.Transitions></State>`;
    const body = `<StateMachine DisplayName="Machine"><StateMachine.InitialState><x:Reference>__R0</x:Reference></StateMachine.InitialState>
      ${state(1, 'Second', card(click('Two', "<webctrl tag='BUTTON' aaname='Two' />")), [2])}
      ${state(0, 'First', card(click('One', "<webctrl tag='BUTTON' aaname='One' />")), [1, 0])}
      ${state(2, 'Third', card(click('Three', "<webctrl tag='BUTTON' aaname='Three' />")), [])}
      ${state(3, 'Orphan', card(click('Four', "<webctrl tag='BUTTON' aaname='Four' />")), [])}</StateMachine>`;
    const r = importSource('uipath', xaml(body), { name: 'm', hasSiteLogin: false });
    expect(kinds(r, 'error')).toEqual([]);
    // From the initial state along the transitions, then any state no transition reaches, in the file's order.
    expect(steps(r).filter((st) => 'click' in st).map((st) => st.intent)).toEqual(['Click One', 'Click Two', 'Click Three', 'Click Four']);
    expect(r.report.items.filter((i) => i.what.startsWith('State ')).map((i) => i.what)).toEqual(['State "First"', 'State "Second"', 'State "Third"', 'State "Orphan"']);
  });
});

describe('UiPath blocks: the rules of every import hold inside them', () => {
  it('a secret typed inside a Retry Scope is removed as it is at the top level, in a browser', () => {
    const signIn = [
      typeInto('User', "<webctrl tag='INPUT' aaname='User' id='user' />", SECRETS.username),
      typeInto('Password', "<webctrl tag='INPUT' type='password' id='pw' />", SECRETS.password),
      click('Log On', "<webctrl tag='BUTTON' aaname='Log On' />"),
    ].join('');
    const opts: ImportOptions = { name: 's', hasSiteLogin: true, secrets: SECRETS };
    const top = importSource('uipath', xaml(card(signIn)), opts);
    const wrapped = importSource('uipath', xaml(card(retry(signIn))), opts);
    expect(steps(wrapped)).toEqual(steps(top));
    expect(steps(wrapped).map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['goto', 'signIn']);
    expect(kinds(wrapped, 'secret').map((i) => i.what)).toEqual(kinds(top, 'secret').map((i) => i.what));
    for (const r of [top, wrapped]) for (const v of [SECRETS.username, SECRETS.password]) expect(JSON.stringify(r)).not.toContain(v);
    // Without a Site Login a password-like field's value is still never imported.
    const bare = importSource('uipath', xaml(card(retry(signIn))), { name: 's', hasSiteLogin: false });
    expect(JSON.stringify(bare)).not.toContain(SECRETS.password);
  });

  it('a secret typed inside a Retry Scope is removed as it is at the top level, in a desktop app', () => {
    const typed = 'Ledger-Secret-77';
    const body = typeInto('Password', "<uia automationid='txtPassword' name='Password' role='edit' />", typed) + click('Sign in', "<uia automationid='btnSignIn' name='Sign in' role='button' />");
    const top = importSource('uipath', xaml(app(body)), { name: 'd', hasSiteLogin: false });
    const wrapped = importSource('uipath', xaml(app(retry(body))), { name: 'd', hasSiteLogin: false });
    expect(desktopSteps(wrapped)).toEqual(desktopSteps(top));
    expect(desktopSteps(wrapped)[1]).toMatchObject({ fill: { value: '{{var.password}}' } });
    expect(kinds(wrapped, 'secret').map((i) => i.what)).toEqual(['Password']);
    expect(wrapped.desktopDrafts?.[0].secretVariables).toEqual(['password']);
    for (const r of [top, wrapped]) expect(JSON.stringify(r)).not.toContain(typed);
  });

  it('a condition whose element names a sign-in value removes the step, never the value', () => {
    const body = checkState(`<webctrl tag='SPAN' aaname='Hello ${SECRETS.username}' />`, click('Go', "<webctrl tag='BUTTON' aaname='Go' />"));
    const r = importSource('uipath', xaml(card(body)), { name: 'c', hasSiteLogin: true, secrets: SECRETS });
    expect(JSON.stringify(r)).not.toContain(SECRETS.username);
    expect(steps(r).map((s) => s.intent)).toEqual(['Open portal.example.com/app']);
    expect(kinds(r, 'secret')).toContainEqual(expect.objectContaining({ what: 'Click Go' }));
  });

  it('a sign-in inside a block with a condition becomes the sign-in step, and the report says it runs every time', () => {
    const signIn = [
      typeInto('User', "<webctrl tag='INPUT' aaname='User' id='user' />", SECRETS.username),
      typeInto('Password', "<webctrl tag='INPUT' type='password' id='pw' />", SECRETS.password),
      click('Log On', "<webctrl tag='BUTTON' aaname='Log On' />"),
    ].join('');
    const r = importSource('uipath', xaml(card(checkState("<webctrl tag='BUTTON' aaname='Log On' />", signIn))), { name: 's', hasSiteLogin: true, secrets: SECRETS });
    expect(steps(r).map((s) => [Object.keys(s).find((k) => k !== 'intent' && k !== 'when'), s.when !== undefined])).toEqual([['goto', false], ['signIn', false]]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ what: "Check App State 'Popup'", reason: expect.stringContaining('A sign-in among them becomes the sign-in step, which runs every time') }));
    expect(JSON.stringify(r)).not.toContain(SECRETS.password);
  });

  it('a Switch with more cases than the nesting allows is refused with a report error, never a throw', () => {
    const cases = Array.from({ length: 700 }, (_, i) => `<Delay x:Key="c${i}" DisplayName="Case ${i}" Duration="00:00:01" />`).join('');
    const r = importSource('uipath', xaml(`<Switch x:TypeArguments="x:String" DisplayName="Big" Expression="[k]">${cases}</Switch>`), { name: 'b', hasSiteLogin: false });
    expect(kinds(r, 'error')).toEqual([expect.objectContaining({ reason: expect.stringContaining("a Switch's cases are counted") })]);
    const fits = importSource('uipath', xaml(`<Switch x:TypeArguments="x:String" DisplayName="Big" Expression="[k]">${cases.split('<Delay').slice(0, 301).join('<Delay')}</Switch>`), { name: 'b', hasSiteLogin: false });
    expect(kinds(fits, 'error')).toEqual([]);
  });

  it('a step whose condition has no usable locator is left out, never run without it', () => {
    const body = checkState("<webctrl tag='DIV' id='popup-9f3a2c71' />", click('Close', "<webctrl tag='BUTTON' aaname='Close' />"));
    const r = importSource('uipath', xaml(card(body)), { name: 'g', hasSiteLogin: false });
    expect(steps(r).map((s) => s.intent)).toEqual(['Open portal.example.com/app']);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Click Close', reason: expect.stringContaining('must not run without its condition') }));
    expect(leftOut(r)).toContain('Click Close');
  });
});

describe('UiPath blocks: when a condition cannot be read', () => {
  it('a Check App State whose element the import cannot read becomes an n8n If, never steps that always run unsaid', () => {
    const body = checkState("<webctrl tag='SPAN' aaname='Inv.*' matching:aaname='regex' />", click('Close', "<webctrl tag='BUTTON' aaname='Close' />"), click('Open', "<webctrl tag='BUTTON' aaname='Open' />"));
    const r = importSource('uipath', xaml(card(body)), { name: 'u', hasSiteLogin: false });
    expect(r.flow?.nodes).toEqual([{ kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Portal' }, {
      kind: 'if', expression: "Check App State 'Popup': the element shows", displayName: "Check App State 'Popup'",
      then: [{ kind: 'browser', sequence: 2, displayName: 'Use Browser Chrome: Portal' }], else: [{ kind: 'browser', sequence: 3, displayName: 'Use Browser Chrome: Portal' }],
    }]);
    expect(r.report.items).toContainEqual(expect.objectContaining({
      kind: 'converted', what: "Check App State 'Popup'",
      reason: expect.stringMatching(/^NCheckState: the import cannot read which element it checks \(.*regular expression.*\), so it became an n8n If: fill in its condition in the workflow; until then the steps under "Target appears" run every time and those under "Target does not appear" never do$/),
    }));
    expect(steps(r).some((s) => s.when)).toBe(false);
  });

  it('desktop steps cannot run only when an element is missing: such a block becomes an n8n If', () => {
    const body = click('Start', "<uia automationid='btnStart' name='Start' role='button' />")
      + checkState("<uia automationid='dlgWarning' name='Warning' role='window' />", click('OK', "<uia automationid='btnOk' name='OK' role='button' />"), click('Next', "<uia automationid='btnNext' name='Next' role='button' />"));
    const r = importSource('uipath', xaml(app(body)), { name: 'd', hasSiteLogin: false });
    expect(r.flow?.nodes.map((n) => n.kind)).toEqual(['desktop', 'if']);
    expect(desktopSteps(r).some((s) => s.when)).toBe(false);
    expect(r.report.items).toContainEqual(expect.objectContaining({ what: "Check App State 'Popup'", reason: expect.stringContaining('desktop steps can run only when an element shows, not when it does not') }));
  });

  it('an If on a plain variable stays an n8n If; an Element Exists no If uses stays not translated', () => {
    const exists = `<ui:ElementExists DisplayName="Element Exists 'Banner'" Exists="[seen]"><ui:ElementExists.Target><ui:Target Selector="${esc("<webctrl tag='DIV' id='banner' />")}" /></ui:ElementExists.Target></ui:ElementExists>`;
    const r = importSource('uipath', xaml(card(exists + `<If Condition="[other]" DisplayName="If other"><If.Then>${click('Go', "<webctrl tag='BUTTON' aaname='Go' />")}</If.Then></If>`)), { name: 'p', hasSiteLogin: false });
    expect(r.flow?.nodes.map((n) => n.kind)).toEqual(['browser', 'if']);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: "Element Exists 'Banner'", reason: expect.stringContaining('keeps the answer in seen') }));
    // `Not seen` swaps the branches' conditions.
    const not = importSource('uipath', xaml(card(exists + `<If Condition="[Not seen]" DisplayName="If no banner"><If.Then>${click('Go', "<webctrl tag='BUTTON' aaname='Go' />")}</If.Then></If>`)), { name: 'p', hasSiteLogin: false });
    expect(steps(not)[1]).toMatchObject({ when: { hidden: { css: '#banner' } } });
  });

  it('a Parallel For Each becomes an n8n loop like For Each, and says its items run one after another', () => {
    const body = `<ParallelForEach x:TypeArguments="x:String" DisplayName="Each region" Values="[regions]"><ActivityAction x:TypeArguments="x:String"><Delay DisplayName="Pause" Duration="00:00:01" /></ActivityAction></ParallelForEach>`;
    const r = importSource('uipath', xaml(body), { name: 'l', hasSiteLogin: false });
    expect(r.flow?.nodes).toEqual([{ kind: 'forEach', expression: 'regions', displayName: 'Each region', body: [{ kind: 'wait', seconds: 1, displayName: 'Pause' }] }]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Each region', reason: 'ParallelForEach: it became an n8n loop over regions: n8n runs the items one after another, not at the same time' }));
  });

  it('a Flowchart that loops back after a decision reports the loop and keeps both paths', () => {
    const fc = `<Flowchart DisplayName="Pages"><Flowchart.StartNode><x:Reference>__R0</x:Reference></Flowchart.StartNode>
      <FlowStep x:Name="__R0">${click('Read', "<webctrl tag='BUTTON' aaname='Read' />")}<FlowStep.Next><FlowDecision x:Name="__R1" DisplayName="More?" Condition="[more]">
      <FlowDecision.True><FlowStep x:Name="__R2">${click('Next', "<webctrl tag='A' aaname='Next' />")}<FlowStep.Next><x:Reference>__R0</x:Reference></FlowStep.Next></FlowStep></FlowDecision.True>
      <FlowDecision.False><FlowStep x:Name="__R3">${click('Done', "<webctrl tag='BUTTON' aaname='Done' />")}</FlowStep></FlowDecision.False></FlowDecision></FlowStep.Next></FlowStep></Flowchart>`;
    const r = importSource('uipath', xaml(card(fc)), { name: 'f', hasSiteLogin: false });
    expect(steps(r).filter((s) => !('goto' in s)).map((s) => s.intent)).toEqual(['Click Read', 'Click Next', 'Click Done']);
    expect(leftOut(r)).toEqual(['More?', 'FlowStep']);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: 'Flowchart: the Flowchart loops back to an earlier step: rebuild the loop in n8n' }));
  });

  it('an activity with a body the import does not know keeps today\'s report and imports nothing inside it', () => {
    const r = importSource('uipath', xaml(card(`<ui:MysteryScope DisplayName="Mystery"><ui:MysteryScope.Body><ActivityAction><Sequence>${click('Never', "<webctrl tag='BUTTON' aaname='Never' />")}</Sequence></ActivityAction></ui:MysteryScope.Body></ui:MysteryScope>`)), { name: 'm', hasSiteLogin: false });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Mystery', reason: 'MysteryScope: this activity has no step equivalent in this release: the 1 activity inside was not imported' }));
    expect(JSON.stringify(r.drafts)).not.toContain('Never');
  });
});
