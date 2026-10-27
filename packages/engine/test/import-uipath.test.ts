import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { IMPORT_NEEDS_SITE_LOGIN } from '../src/messages.js';
import { importSource } from '../src/import/index.js';
import type { FlowNode, ImportItem, ImportOptions, ImportReport, ImportResult } from '../src/import/types.js';
import { MAX_REPORT_ITEMS, MAX_UIPATH_ACTIVITIES, uipathImport } from '../src/import/uipath.js';
import { readSelector, selectorToCandidates } from '../src/import/uipath-selector.js';
import { loginBlockEnd } from '../src/policy/validate.js';
import { parseScript } from '../src/steps/parse.js';
import type { Step } from '../src/types.js';
import { ERP_CHECK, SAP_VARS, SECRETS } from './helpers.js';
import { bound } from './timing.js';
import { timed, zeros, zip } from './zip-fixtures.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

const DIR = fileURLToPath(new URL('./fixtures/import/uipath-sap-report/', import.meta.url));
const ROOT = 'SAP Line Item Report/';
const OPTS: ImportOptions = {
  name: 'sap-report', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: { mime: ['text/csv'], check: ERP_CHECK },
};
const WEBGUI = 'http://localhost:8080/sap/bc/gui/sap/its/webgui';
const DESKTOP_NOTE = "rebuild in SAP's web GUI";

/** The fixture project's files, by path relative to the project folder. */
function fixtureFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(DIR, path).split('\\').join('/')] = readFileSync(path, 'utf8');
    }
  };
  walk(DIR);
  return out;
}
/** The project zipped under a top folder, as Studio's "export" or a zipped folder gives it. `null` removes a file. */
function projectZip(changes: Record<string, string | null> = {}, prefix = ROOT): Buffer {
  const files = { ...fixtureFiles(), ...changes };
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) if (text !== null) entries[prefix + path] = strToU8(text);
  return Buffer.from(zipSync(entries));
}
const MAIN = fixtureFiles()['Main.xaml'];

const verbOf = (s: Step) => Object.keys(s).find((k) => !['intent', 'expect', 'optional', 'when', 'checkpoint', 'timeoutMs'].includes(k));
const errors = (r: { report: ImportReport }) => r.report.items.filter((i) => i.kind === 'error');
const newReport = (): ImportReport => ({ source: 'uipath', steps: 0, items: [] });

/** A minimal workflow file around `body` (activities in one Sequence). */
const xaml = (body: string, cls = 'Main') => `<Activity x:Class="${cls}" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
<Sequence DisplayName="Main sequence">${body}</Sequence></Activity>`;
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const target = (selector: string) => `<uix:TargetAnchorable FullSelectorArgument="${esc(selector)}" />`;
const card = (body: string, url = 'https://portal.example.com/app') =>
  `<uix:NApplicationCard DisplayName="Use Browser Chrome: Portal"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">${body}</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp BrowserType="Chrome" Url="${url}" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
const click = (name: string, selector: string, extra = '') => `<uix:NClick DisplayName="Click '${name}'"${extra}><uix:NClick.Target>${target(selector)}</uix:NClick.Target></uix:NClick>`;
const typeInto = (name: string, selector: string, text: string) =>
  `<uix:NTypeInto DisplayName="Type Into '${name}'" Text="${esc(text)}"><uix:NTypeInto.Target>${target(selector)}</uix:NTypeInto.Target></uix:NTypeInto>`;
const invoke = (file: string) => `<ui:InvokeWorkflowFile DisplayName="Invoke ${file}" WorkflowFileName="${file}" />`;

describe('UiPath projects', () => {
  it('the SAP report project imports one browser sequence with signIn and a checked download', () => {
    const r = importSource('uipath', projectZip(), OPTS);
    expect(errors(r)).toEqual([]);
    expect(r.drafts.map((d) => d.name)).toEqual(['sap-report-1']);
    const { script } = r.drafts[0];
    expect(script).toMatchObject({ name: 'sap-report-1', version: 1 });
    expect(parseScript(script)).toEqual(script);
    const steps = script.steps;
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'click', 'select', 'fill', 'fill', 'click', 'download']);
    expect(steps.map((s) => s.intent)).toEqual([
      'Open localhost:8080/sap/bc/gui/sap/its/webgui',
      'Sign in',
      'Click Line Item Report',
      'Choose {{var.company}} in Company Code',
      'Type into From',
      'Type into To',
      'Click Execute',
      'Download with Export',
    ]);
    expect(steps[0]).toEqual({ intent: 'Open localhost:8080/sap/bc/gui/sap/its/webgui', goto: WEBGUI });
    expect((steps[1] as S<'signIn'>).signIn).toEqual({
      username: { label: 'User', exact: true, fallbacks: [{ css: '#sap-user' }] },
      password: { css: '#sap-password' },
      submit: { role: 'button', name: 'Log On', exact: true, fallbacks: [{ css: '#LOGON_BUTTON' }] },
    });
    expect((steps[2] as S<'click'>).click).toEqual({ text: 'Line Item Report', exact: true });
    expect((steps[3] as S<'select'>).select).toEqual({ field: { label: 'Company Code', exact: true }, value: '{{var.company}}' });
    expect((steps[4] as S<'fill'>).fill).toEqual({ field: { label: 'From', exact: true }, value: '{{var.from}}' });
    expect((steps[5] as S<'fill'>).fill).toEqual({ field: { label: 'To', exact: true }, value: '{{var.to}}' });
    expect((steps[6] as S<'click'>).click).toEqual({ css: '#execBtn' });
    expect((steps[7] as S<'download'>).download).toEqual({
      trigger: { role: 'button', name: 'Export', exact: true, fallbacks: [{ css: 'button.btn.tb' }] }, mime: ['text/csv'], check: ERP_CHECK,
    });
    expect(r.report.steps).toBe(8);
    const items = r.report.items;
    expect(items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Click Export', at: 'Main.xaml: NClick_4' }));
    expect(items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['User', 'Password']);
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Log Message' }));
    // A Delay inside the browser card does not split the sequence: steps wait for their elements.
    expect(items).toContainEqual(expect.objectContaining({ at: 'Main.xaml: Delay_2', kind: 'converted', what: 'Wait for the report', reason: expect.stringContaining('timeoutMs') }));

    // Without a Site Login the sign-in is removed and the report says adoption needs one.
    const bare = importSource('uipath', projectZip(), { ...OPTS, hasSiteLogin: false, secrets: undefined });
    expect(bare.drafts[0].script.steps.map(verbOf)).toEqual(['goto', 'click', 'select', 'fill', 'fill', 'click', 'download']);
    expect(bare.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', reason: IMPORT_NEEDS_SITE_LOGIN }));
    // Without an Expected File the export stays a click, and the report says so.
    const noFile = importSource('uipath', projectZip(), { ...OPTS, download: undefined });
    expect(noFile.drafts[0].script.steps.map(verbOf).at(-1)).toBe('click');
    expect(noFile.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Click Export' }));
  });

  it('the flow keeps S3, If, ForEach, spreadsheet and credential nodes in order', () => {
    const r = importSource('uipath', projectZip(), OPTS);
    const nodes: FlowNode[] = [
      { kind: 'credential', asset: 'SAP_Login', displayName: 'Get SAP credential' },
      { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: SAP Logon' },
      { kind: 's3Upload', bucket: 'acme-finance-reports', key: 'sap/line-items.xlsx', displayName: 'Upload line items to S3' },
      {
        kind: 'if', expression: 'intTotal > 1000', displayName: 'If many line items',
        then: [{ kind: 'email', to: 'finance@acme.example', subject: 'Large SAP line item report', displayName: 'Send SMTP Mail Message' }],
        else: [{ kind: 'wait', seconds: 5, displayName: 'Delay' }],
      },
      {
        kind: 'forEach', expression: '{"EMEA", "AMER"}', displayName: 'For Each region',
        body: [{ kind: 'http', method: 'POST', url: 'https://hooks.acme.example/sap-report', displayName: 'Notify the region' }],
      },
      { kind: 'readSpreadsheet', path: 'C:\\Reports\\line-items.xlsx', sheet: 'Line Items', displayName: 'Read Range' },
      { kind: 'untranslated', activity: 'NSAPLogon', displayName: 'SAP Logon', note: DESKTOP_NOTE },
      { kind: 'untranslated', activity: 'NClick', displayName: "Click 'Execute' in SAP GUI", note: DESKTOP_NOTE },
    ];
    expect(r.flow).toEqual({ name: 'SAP Line Item Report', nodes });
    // The credential is a slot: the report says what to attach, never the asset's name.
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Get SAP credential' }));

    // A Delay inside a card does not split it; an If does. Later parts reopen the card's address and sign in again
    // with the first part's signIn (locators only), and the report says what is not replayed.
    const signInBody = [
      typeInto('User', "<webctrl tag='INPUT' aaname='User' id='user' />", '[in_User]'),
      `<uix:NTypeInto DisplayName="Type Into 'Password'" SecureText="[in_Password]"><uix:NTypeInto.Target>${target("<webctrl tag='INPUT' type='password' id='pw' />")}</uix:NTypeInto.Target></uix:NTypeInto>`,
      click('Log On', "<webctrl tag='BUTTON' aaname='Log On' />"),
    ].join('');
    const split = importSource('uipath', xaml(card([
      signInBody,
      click('Reports', "<webctrl tag='A' aaname='Reports' />"),
      '<Delay DisplayName="Wait for the portal" Duration="00:01:30" />',
      click('Totals', "<webctrl tag='A' aaname='Totals' />"),
      `<If Condition="[hasMore]" DisplayName="If more"><If.Then>${click('Next page', "<webctrl tag='A' aaname='Next page' />")}</If.Then></If>`,
      click('Refresh', "<webctrl tag='BUTTON' aaname='Refresh' />"),
    ].join(''))), { name: 'split', hasSiteLogin: true, secrets: SECRETS });
    expect(errors(split)).toEqual([]);
    expect(split.flow?.nodes).toEqual([
      { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Portal' },
      { kind: 'if', expression: 'hasMore', displayName: 'If more', then: [{ kind: 'browser', sequence: 2, displayName: 'Use Browser Chrome: Portal' }], else: [] },
      { kind: 'browser', sequence: 3, displayName: 'Use Browser Chrome: Portal' },
    ]);
    expect(split.drafts.map((d) => [d.name, d.script.steps.map(verbOf)])).toEqual([
      ['split-1', ['goto', 'signIn', 'click', 'click']],
      ['split-2', ['goto', 'signIn', 'click']],
      ['split-3', ['goto', 'signIn', 'click']],
    ]);
    const signIns = split.drafts.map((d) => d.script.steps[1]);
    expect(signIns[1]).toEqual(signIns[0]);
    expect(signIns[2]).toEqual(signIns[0]);
    expect(split.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Wait for the portal' }));
    expect(split.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Open portal.example.com/app' }));
    expect(split.report.items.filter((i) => i.kind === 'converted' && i.what === 'Sign in' && /not replayed/.test(i.reason))).toHaveLength(2);
    expect(JSON.stringify(split)).not.toContain(SECRETS.password);
    // A Delay outside a card stays a wait node.
    const outside = importSource('uipath', xaml('<Delay DisplayName="Pause" Duration="00:00:02" />'), { name: 'o', hasSiteLogin: false });
    expect(outside.flow?.nodes).toEqual([{ kind: 'wait', seconds: 2, displayName: 'Pause' }]);
  });

  it('SAP desktop activities are reported in order, not translated', () => {
    const r = importSource('uipath', projectZip(), OPTS);
    const items = r.report.items;
    const head = items.findIndex((i) => i.what === 'SAP desktop activities (2)');
    expect(head).toBeGreaterThanOrEqual(0);
    expect(items[head]).toMatchObject({ kind: 'untranslated', at: '' });
    expect(items.slice(head + 1, head + 3)).toEqual<ImportItem[]>([
      { at: 'Main.xaml: NSAPLogon_1', kind: 'untranslated', what: '1. SAP Logon', reason: `NSAPLogon: ${DESKTOP_NOTE}` },
      { at: 'Main.xaml: NClick_5', kind: 'untranslated', what: "2. Click 'Execute' in SAP GUI", reason: `NClick: ${DESKTOP_NOTE}` },
    ]);
    // Nothing from SAP GUI reaches a draft.
    expect(JSON.stringify(r.drafts)).not.toContain('tbar');

    // A card on SAP GUI for Windows makes everything inside it desktop, in order, inside If branches too.
    const desk = importSource('uipath', xaml(`<uix:NApplicationCard DisplayName="Use Application: SAP Logon 770"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      ${typeInto('Transaction', "<ctrl name='okcd' />", 'FBL3N')}
      <If Condition="[True]" DisplayName="If"><If.Then>${click('Execute', "<sap id='tbar[1]/btn[8]' />")}</If.Then></If>
      </Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp FilePath="C:\\SAP\\saplogon.exe" Selector="&lt;wnd app='saplogon.exe' /&gt;" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`), { name: 'd', hasSiteLogin: false });
    expect(desk.drafts).toEqual([]);
    const dh = desk.report.items.findIndex((i) => i.what === 'SAP desktop activities (3)');
    expect(desk.report.items.slice(dh + 1, dh + 4).map((i) => i.what)).toEqual(['1. Use Application: SAP Logon 770', "2. Type Into 'Transaction'", "3. Click 'Execute'"]);
    expect(JSON.stringify(desk)).not.toContain('FBL3N');
  });

  it('Object Repository references resolve', () => {
    const r = importSource('uipath', projectZip(), OPTS);
    expect((r.drafts[0].script.steps[2] as S<'click'>).click).toEqual({ text: 'Line Item Report', exact: true });
    // A reference the project does not have drops the step, with the reason.
    const files = fixtureFiles();
    const content = Object.keys(files).find((p) => p.endsWith('/.content'))!;
    const missing = importSource('uipath', projectZip({ [content]: null }), OPTS);
    expect(missing.drafts[0].script.steps.map(verbOf)).toEqual(['goto', 'signIn', 'select', 'fill', 'fill', 'click', 'download']);
    expect(missing.report.items).toContainEqual(expect.objectContaining({
      at: 'Main.xaml: NClick_2', kind: 'dropped', what: 'Click Line Item Report', reason: expect.stringContaining('Object Repository'),
    }));
    // The element's folder name resolves a reference written with another library id.
    const other = importSource('uipath', projectZip({ 'Main.xaml': MAIN.replace('Reference="Rk3pQe1nTUmN0yZ7VbXg2A/', 'Reference="OtherLibrary/') }), OPTS);
    expect((other.drafts[0].script.steps[2] as S<'click'>).click).toEqual({ text: 'Line Item Report', exact: true });
  });

  it('selector attributes map to locators', () => {
    const c = selectorToCandidates;
    // aaname on a button, a link or a submit/button input: a role with an exact name.
    expect(c("<webctrl tag='BUTTON' aaname='Save' />")).toEqual([{ role: 'button', name: 'Save', exact: true }]);
    expect(c("<webctrl tag='A' aaname='Reports' />")).toEqual([{ role: 'link', name: 'Reports', exact: true }]);
    expect(c("<webctrl tag='INPUT' type='submit' aaname='Go on' />")).toEqual([{ role: 'button', name: 'Go on', exact: true }]);
    expect(c("<webctrl tag='INPUT' type='button' aaname='Add row' />")).toEqual([{ role: 'button', name: 'Add row', exact: true }]);
    // aaname on a field: an exact label.
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) expect(c(`<webctrl tag='${tag}' aaname='Company Code' />`)).toEqual([{ label: 'Company Code', exact: true }]);
    // aaname elsewhere: text.
    expect(c("<webctrl tag='SPAN' aaname='Total due' />")).toEqual([{ text: 'Total due', exact: true }]);
    // The tag hint (the target's element type) stands in for a missing tag.
    expect(c("<webctrl aaname='Plant' />", 'INPUT')).toEqual([{ label: 'Plant', exact: true }]);
    // id: css #id, escaped.
    expect(c("<webctrl id='execBtn' tag='BUTTON' />")).toEqual([{ css: '#execBtn' }]);
    expect(c("<webctrl id='M0:46:1.ok' tag='BUTTON' />")).toEqual([{ css: '#M0\\:46\\:1\\.ok' }]);
    expect(c("<webctrl id='1st' tag='DIV' />")).toEqual([{ css: '#\\31 st' }]);
    // check:text and innertext: text.
    expect(c("<webctrl tag='BUTTON' check:text='Line Item Report' />")).toEqual([{ text: 'Line Item Report', exact: true }]);
    expect(c("<webctrl tag='TD' innertext='Posted' />")).toEqual([{ text: 'Posted', exact: true }]);
    // name: css tag[name].
    expect(c("<webctrl tag='INPUT' name='S_BUKRS-LOW' />")).toEqual([{ css: 'input[name="S_BUKRS-LOW"]' }]);
    // tag plus class: css tag.c1.c2.
    expect(c("<webctrl tag='BUTTON' class='btn  tb' />")).toEqual([{ css: 'button.btn.tb' }]);
    // css-selector: css, last.
    expect(c("<webctrl tag='BUTTON' aaname='Export' css-selector='body&gt;div&gt;button' />")).toEqual([{ role: 'button', name: 'Export', exact: true }, { css: 'body>div>button' }]);
    // Best first: name, then text, then css.
    expect(c("<webctrl tag='BUTTON' aaname='Export' innertext='Export now' id='exp' class='btn' />")).toEqual([
      { role: 'button', name: 'Export', exact: true }, { text: 'Export now', exact: true }, { css: '#exp' }, { css: 'button.btn' },
    ]);
    // parentid: within css #parentid.
    expect(c("<webctrl parentid='toolbar' tag='BUTTON' aaname='Export' />")).toEqual([{ role: 'button', name: 'Export', exact: true, within: { css: '#toolbar' } }]);
    // A * wildcard drops exact (the longest literal part is matched) and is reported.
    expect(c("<webctrl tag='BUTTON' aaname='Export*' />")).toEqual([{ role: 'button', name: 'Export' }]);
    expect(c("<webctrl tag='SPAN' aaname='Order * of ?' />")).toEqual([{ text: 'Order' }]);
    expect(c("<webctrl tag='DIV' id='row-*' />")).toEqual([{ css: 'div[id*="row-"]' }]);
    expect(readSelector("<webctrl tag='BUTTON' aaname='Export*' />").issues).toEqual([expect.stringContaining('wildcard')]);
    // html and wnd scope elements are ignored; the last webctrl is the target; an iframe before it becomes the frame.
    expect(c("<html app='chrome.exe' title='Line Item Report' /><webctrl tag='INPUT' aaname='Company Code' />")).toEqual([{ label: 'Company Code', exact: true }]);
    expect(c("<webctrl tag='FORM' id='outer' /><webctrl tag='INPUT' aaname='From' />")).toEqual([{ label: 'From', exact: true }]);
    expect(c("<webctrl tag='IFRAME' id='app' /><webctrl tag='INPUT' aaname='From' />")).toEqual([{ label: 'From', exact: true, frame: 'iframe#app' }]);
    expect(readSelector("<html app='chrome.exe' /><webctrl tag='INPUT' aaname='From' />").desktop).toBe(false);
    // wnd, ctrl and sap make the activity desktop.
    for (const s of ["<wnd app='saplogon.exe' /><ctrl name='okcd' />", "<sap id='tbar[1]' />", "<wnd app='excel.exe' />"]) {
      expect(readSelector(s)).toMatchObject({ desktop: true, candidates: [] });
    }
    // idx, regex and fuzzy matching, and variables in values are reported, not imported.
    expect(c("<webctrl tag='BUTTON' aaname='Export' idx='2' />")).toEqual([{ role: 'button', name: 'Export', exact: true }]);
    expect(readSelector("<webctrl tag='BUTTON' aaname='Export' idx='2' />").issues).toEqual([expect.stringContaining('idx')]);
    expect(readSelector("<webctrl tag='SPAN' aaname='Inv.*' matching:aaname='regex' />")).toMatchObject({ candidates: [], issues: [expect.stringContaining('regular expression')] });
    expect(readSelector("<webctrl tag='SPAN' aaname='Totl' matching:aaname='fuzzy' fuzzylevel:aaname='0.7' />")).toMatchObject({ candidates: [{ text: 'Totl' }], issues: [expect.stringContaining('fuzzy')] });
    expect(readSelector("<webctrl tag='INPUT' aaname='{{strField}}' id='f1' />")).toMatchObject({ candidates: [{ css: '#f1' }], issues: [expect.stringContaining('variable')] });
    // A selector that is not well-formed (a bare &) is an issue, never a throw.
    expect(readSelector("<webctrl tag='SPAN' aaname='P&L' />")).toMatchObject({ candidates: [], issues: [expect.stringContaining('cannot be read')] });
    expect(c('')).toEqual([]);
    // Nested frames: only the innermost is used, and that is reported.
    const nested = readSelector("<webctrl tag='IFRAME' id='outer' /><webctrl tag='IFRAME' id='inner' /><webctrl tag='INPUT' aaname='From' />");
    expect(nested.candidates).toEqual([{ label: 'From', exact: true, frame: 'iframe#inner' }]);
    expect(nested.issues).toEqual([expect.stringContaining('nested frames')]);
    // A password field the selector names only by its type: a last-resort css candidate.
    expect(c("<webctrl tag='INPUT' type='password' />")).toEqual([{ css: 'input[type="password"]' }]);
    expect(c("<webctrl tag='INPUT' type='password' id='pw' />")).toEqual([{ css: '#pw' }]);
    // css-selector values that are not plain CSS are reported, not copied.
    for (const bad of ['div >> text=Export', 'text=Export', 'xpath=//button']) {
      const r = readSelector(`<webctrl tag='BUTTON' aaname='Export' css-selector='${bad}' />`);
      expect(r.candidates).toEqual([{ role: 'button', name: 'Export', exact: true }]);
      expect(r.issues).toEqual([expect.stringContaining('css-selector')]);
    }
    expect(c("<webctrl tag='BUTTON' aaname='a\"b' class='x\"y' />")).toEqual([{ role: 'button', name: 'a"b', exact: true }, { css: 'button.x\\"y' }]);
  });

  it('VB expressions are kept as text and never evaluated', () => {
    const body = card([
      typeInto('Company', "<webctrl tag='INPUT' aaname='Company' />", '[strCompany]'),
      typeInto('Plant', "<webctrl tag='INPUT' aaname='Plant' />", '[strPlant]'),
      typeInto('Customer', "<webctrl tag='INPUT' aaname='Customer' />", '["ACME ""Retail"""]'),
      typeInto('Note', "<webctrl tag='INPUT' aaname='Note' />", '["Run " + Now.ToString]'),
      typeInto('Danger', "<webctrl tag='INPUT' aaname='Danger' />", '[System.IO.File.Delete("C:\\x")]'),
      `<uix:NTypeInto DisplayName="Type Into 'City'"><uix:NTypeInto.Text><InArgument x:TypeArguments="x:String"><CSharpValue x:TypeArguments="x:String">"Berlin"</CSharpValue></InArgument></uix:NTypeInto.Text><uix:NTypeInto.Target>${target("<webctrl tag='INPUT' aaname='City' />")}</uix:NTypeInto.Target></uix:NTypeInto>`,
      `<uix:NSelectItem DisplayName="Select Item 'Region'" Item="[regions(0)]"><uix:NSelectItem.Target>${target("<webctrl tag='SELECT' aaname='Region' />")}</uix:NSelectItem.Target></uix:NSelectItem>`,
    ].join(''));
    const flow = `<If Condition="[amount &gt; 1000 AndAlso Not String.IsNullOrEmpty(strCompany)]" DisplayName="If big"><If.Then><Delay Duration="[TimeSpan.FromSeconds(n)]" /></If.Then></If>
      <ui:ForEachRow DataTable="[dtItems]" DisplayName="For Each Row"><ui:ForEachRow.Body><ActivityAction x:TypeArguments="sd:DataRow"><Sequence>
      <ui:HttpClient DisplayName="Post row" EndPoint="[baseUrl + &quot;/rows&quot;]" Method="POST" /></Sequence></ActivityAction></ui:ForEachRow.Body></ui:ForEachRow>
      <If DisplayName="If C#"><If.Condition><InArgument x:TypeArguments="x:Boolean"><CSharpValue x:TypeArguments="x:Boolean">rows.Count &gt; 0</CSharpValue></InArgument></If.Condition></If>`;
    const r = importSource('uipath', xaml(body + flow), { name: 'expr', hasSiteLogin: false, vars: { strCompany: '1000' } });
    expect(errors(r)).toEqual([]);
    const steps = r.drafts[0].script.steps;
    expect(steps.map((s) => ('fill' in s ? s.fill.value : undefined)).filter((v) => v !== undefined)).toEqual(['{{var.strCompany}}', 'ACME "Retail"', 'Berlin']);
    // An unmapped variable or a computed value is not evaluated: the step is dropped and the report quotes the expression.
    for (const [what, expr] of [['Type into Plant', 'strPlant'], ['Type into Note', '"Run " + Now.ToString'], ['Type into Danger', 'System.IO.File.Delete("C:\\x")'], ['Choose an option in Region', 'regions(0)']]) {
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what, reason: expect.stringContaining(expr) }));
    }
    expect(r.flow?.nodes.slice(1)).toEqual([
      { kind: 'if', expression: 'amount > 1000 AndAlso Not String.IsNullOrEmpty(strCompany)', displayName: 'If big', then: [{ kind: 'wait', displayName: 'Delay' }], else: [] },
      { kind: 'forEach', expression: 'dtItems', displayName: 'For Each Row', body: [{ kind: 'http', method: 'POST', displayName: 'Post row' }] },
      { kind: 'if', expression: 'rows.Count > 0', displayName: 'If C#', then: [], else: [] },
    ]);
  });

  it('a single .xaml imports without project.json', () => {
    const one = xaml(card([
      typeInto('Search', "<webctrl tag='INPUT' aaname='Search' />", 'invoices'),
      click('Search', "<webctrl tag='BUTTON' aaname='Search' />"),
    ].join('')) + invoke('Workflows\\Next.xaml'), 'Lookup');
    for (const data of [one, Buffer.from(one), new Uint8Array(Buffer.from(`\ufeff${one}`))]) {
      const r = importSource('uipath', data, { name: 'lookup', hasSiteLogin: false });
      expect(errors(r)).toEqual([]);
      expect(r.drafts.map((d) => d.script.steps.map(verbOf))).toEqual([['goto', 'fill', 'click']]);
      expect(r.flow).toEqual({
        name: 'Lookup',
        nodes: [
          { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Portal' },
          { kind: 'untranslated', activity: 'InvokeWorkflowFile', displayName: 'Invoke Workflows\\Next.xaml', note: 'Workflows/Next.xaml is not in the import: import the project folder as a zip' },
        ],
      });
    }
    // A zip with workflows but no project.json starts at Main.xaml.
    const z = Buffer.from(zipSync({ 'bot/Main.xaml': strToU8(one), 'bot/Workflows/Next.xaml': strToU8(xaml('<Delay DisplayName="Pause" Duration="00:00:02" />', 'Next')) }));
    const r = importSource('uipath', z, { name: 'lookup', hasSiteLogin: false });
    expect(errors(r)).toEqual([]);
    expect(r.flow?.nodes.map((n) => n.kind)).toEqual(['browser', 'wait']);
    // Classic activities: OpenBrowser, TypeInto, Click with full selectors.
    const classic = xaml(`<ui:OpenBrowser BrowserType="Chrome" DisplayName="Open Browser" Url="https://portal.example.com/login"><ui:OpenBrowser.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      <ui:TypeInto DisplayName="Type Into 'INPUT  q'" Text="invoices"><ui:TypeInto.Target><ui:Target Selector="&lt;webctrl tag='INPUT' name='q' /&gt;" /></ui:TypeInto.Target></ui:TypeInto>
      <ui:Click DisplayName="Click 'BUTTON  Find'"><ui:Click.Target><ui:Target Selector="&lt;html app='chrome.exe' /&gt;&lt;webctrl tag='BUTTON' aaname='Find' /&gt;" /></ui:Click.Target></ui:Click>
      <ui:NavigateTo DisplayName="Navigate To" Url="https://portal.example.com/reports" />
      <ui:Check Action="Uncheck" DisplayName="Check 'Archived'"><ui:Check.Target><ui:Target Selector="&lt;webctrl tag='INPUT' type='checkbox' aaname='Archived' /&gt;" /></ui:Check.Target></ui:Check>
      </Sequence></ActivityAction></ui:OpenBrowser.Body></ui:OpenBrowser>`);
    const cr = importSource('uipath', classic, { name: 'classic', hasSiteLogin: false });
    expect(errors(cr)).toEqual([]);
    expect(cr.drafts[0].script.steps.map((s) => s.intent)).toEqual(['Open portal.example.com/login', 'Type into q', 'Click Find', 'Open portal.example.com/reports', 'Uncheck Archived']);
    expect(cr.drafts[0].script.steps[1]).toMatchObject({ fill: { field: { css: 'input[name="q"]' }, value: 'invoices' } });
  });

  it('invoke cycles and depth over 10 are refused with a report error', () => {
    const cycle = Buffer.from(zipSync({
      'project.json': strToU8(JSON.stringify({ name: 'loop', main: 'Main.xaml' })),
      'Main.xaml': strToU8(xaml(invoke('A.xaml'))),
      'A.xaml': strToU8(xaml(`<Delay DisplayName="In A" Duration="00:00:01" />${invoke('b.XAML')}`, 'A')),
      'B.xaml': strToU8(xaml(invoke('.\\A.xaml'), 'B')),
    }));
    const r = importSource('uipath', cycle, { name: 'loop', hasSiteLogin: false });
    expect(errors(r)).toEqual([expect.objectContaining({ kind: 'error', reason: expect.stringContaining('A.xaml → B.xaml → A.xaml') })]);
    expect(r.flow?.nodes).toEqual([
      { kind: 'wait', seconds: 1, displayName: 'In A' },
      { kind: 'untranslated', activity: 'InvokeWorkflowFile', displayName: 'Invoke .\\A.xaml', note: expect.stringContaining('cycle') },
    ]);

    // Main → W1 → … → W11: W1..W10 are followed, W11 is refused.
    const files: Record<string, Uint8Array> = { 'Main.xaml': strToU8(xaml(invoke('W1.xaml'))) };
    for (let i = 1; i <= 11; i++) files[`W${i}.xaml`] = strToU8(xaml(`<Delay DisplayName="W${i}" Duration="00:00:01" />${i < 11 ? invoke(`W${i + 1}.xaml`) : ''}`, `W${i}`));
    const deep = importSource('uipath', Buffer.from(zipSync(files)), { name: 'deep', hasSiteLogin: false });
    expect(errors(deep)).toEqual([expect.objectContaining({ reason: expect.stringContaining('deeper than 10') })]);
    expect(deep.flow?.nodes.filter((n) => n.kind === 'wait').map((n) => n.displayName)).toEqual(['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10']);

    // A workflow invoked many times over is bounded by the activity cap, quickly.
    const fan: Record<string, Uint8Array> = { 'Main.xaml': strToU8(xaml(invoke('F1.xaml').repeat(40))) };
    for (let i = 1; i <= 10; i++) fan[`F${i}.xaml`] = strToU8(xaml(i < 10 ? invoke(`F${i + 1}.xaml`).repeat(40) : '<Delay Duration="00:00:01" />', `F${i}`));
    const { out, ms } = timed(() => importSource('uipath', Buffer.from(zipSync(fan)), { name: 'fan', hasSiteLogin: false }));
    expect(errors(out)).toEqual([expect.objectContaining({ reason: expect.stringContaining(MAX_UIPATH_ACTIVITIES.toLocaleString('en-US')) })]);
    expect(ms).toBeLessThan(bound(3000));
  });

  it('secrets never appear', () => {
    const r = importSource('uipath', projectZip(), OPTS);
    const all = JSON.stringify(r);
    for (const v of [SECRETS.username, SECRETS.password, SECRETS.totpSecret!, 'in_Password']) expect(all).not.toContain(v);
    // The robot credential's name appears only as the flow's credential slot.
    const slot = structuredClone(r);
    const cred = slot.flow!.nodes.find((n) => n.kind === 'credential') as Extract<FlowNode, { kind: 'credential' }>;
    expect(cred.asset).toBe('SAP_Login');
    cred.asset = '';
    expect(JSON.stringify(slot)).not.toContain('SAP_Login');

    // Site Login values written into the bot (a typed username and password, an address, a condition, a mail and an
    // S3 key) never reach a draft, the report or the flow.
    const p = SECRETS.password;
    const leaky = xaml(card([
      typeInto('Key', "<webctrl tag='INPUT' aaname='Key' />", p),
      typeInto('Login', "<webctrl tag='INPUT' aaname='Login' id='login' />", SECRETS.username),
      `<uix:NTypeInto DisplayName="Type Into 'Secret'" Text="[&quot;${p}&quot;]"><uix:NTypeInto.Target>${target("<webctrl tag='INPUT' aaname='Notes' />")}</uix:NTypeInto.Target></uix:NTypeInto>`,
      `<ui:TypeSecureText DisplayName="Type Secure Text 'PIN'" SecureText="[secPin]"><ui:TypeSecureText.Target>${target("<webctrl tag='INPUT' aaname='PIN' />")}</ui:TypeSecureText.Target></ui:TypeSecureText>`,
      click('Go', "<webctrl tag='BUTTON' aaname='Go' />"),
      click(`Hello ${SECRETS.username}`, `<webctrl tag='SPAN' aaname='Hello ${SECRETS.username}' />`),
    ].join(''), `https://portal.example.com/app?u=${SECRETS.username}`)
      + `<If Condition="[strPwd = &quot;${p}&quot;]" DisplayName="If ${p}"><If.Then><ui:SendSMTPMailMessage To="${SECRETS.username}@acme.example" Subject="pw ${p}" DisplayName="Mail" /></If.Then></If>`
      + `<ui:GetCredential AssetName="${p}" DisplayName="Get Credential" />`
      + `<ui:HttpClient EndPoint="https://api.example.com/?key=${p}" Method="GET" DisplayName="Call" />`);
    const lr = importSource('uipath', leaky, OPTS);
    const text = JSON.stringify(lr);
    for (const v of [p, SECRETS.username, 'secPin']) expect(text).not.toContain(v);
    expect(lr.report.items.filter((i) => i.kind === 'secret').length).toBeGreaterThanOrEqual(3);
    // Without a Site Login nothing is known to be secret, but the SecureText expression still never appears.
    expect(JSON.stringify(importSource('uipath', leaky, { ...OPTS, hasSiteLogin: false, secrets: undefined }))).not.toContain('secPin');
  });

  it('a workflow invoked many times over a large file is bounded', () => {
    const run = (files: Record<string, string>) => timed(() => importSource('uipath', Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))), { name: 'w', hasSiteLogin: false }));
    // Main invokes F 20,000 times; F holds 150,000 elements that are not activities.
    const big = run({ 'Main.xaml': xaml(invoke('F.xaml').repeat(20_000)), 'F.xaml': xaml(`${'<Sequence.Variables />'.repeat(150_000)}<Delay />`, 'F') });
    expect(errors(big.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('more work than an import does') })]);
    expect(big.ms).toBeLessThan(bound(1000));
    // Nested Flowcharts over a large subtree, invoked many times.
    let chart = `<Sequence>${'<Sequence.Variables />'.repeat(100_000)}<Delay DisplayName="Bottom" /></Sequence>`;
    for (let i = 0; i < 60; i++) chart = `<Flowchart DisplayName="F${i}"><Flowchart.StartNode><FlowStep x:Name="__R${i}">${chart}</FlowStep></Flowchart.StartNode></Flowchart>`;
    const flow = run({ 'Main.xaml': xaml(invoke('C.xaml').repeat(5_000)), 'C.xaml': xaml(chart, 'C') });
    expect(errors(flow.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('more work than an import does') })]);
    expect(flow.ms).toBeLessThan(bound(1000));
    const once = timed(() => importSource('uipath', xaml(chart), { name: 'c', hasSiteLogin: false }));
    expect(errors(once.out).map((e) => e.reason)).toEqual([]);
    expect(once.out.flow?.nodes).toEqual([{ kind: 'wait', displayName: 'Bottom' }]);
    expect(once.ms).toBeLessThan(bound(1000));
    // A 60 KiB selector invoked 20,000 times, and referenced 20,000 times through the Object Repository.
    const longSelector = `<html app='chrome.exe' title='${'t'.repeat(60_000)}' /><webctrl tag='BUTTON' aaname='Go' />`;
    const sel = run({ 'Main.xaml': xaml(invoke('S.xaml').repeat(20_000)), 'S.xaml': xaml(card(click('Go', longSelector)), 'S') });
    expect(errors(sel.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('more work than an import does') })]);
    expect(sel.ms).toBeLessThan(bound(1000));
    const refClick = '<uix:NClick DisplayName="Click \'Go\'"><uix:NClick.Target><uix:TargetAnchorable Reference="L/E1" /></uix:NClick.Target></uix:NClick>';
    const repo = run({
      'project.json': JSON.stringify({ main: 'Main.xaml' }),
      'Main.xaml': xaml(card(refClick.repeat(20_000))),
      '.objects/L/A/S/E1/.content': `<ObjectRepositoryTargetData Reference="L/E1"><TargetAnchorable FullSelectorArgument="${esc(longSelector)}" /></ObjectRepositoryTargetData>`,
    });
    expect(repo.ms).toBeLessThan(bound(1000));
    expect(repo.out.report.items.length).toBeLessThan(5);
  });

  it('the report keeps at most 500 items, errors and project-wide items first, then one summary item', () => {
    const mystery = (i: number) => `<ui:MysteryActivity DisplayName="Mystery ${i} for ${SECRETS.username}" />`;
    const files = {
      'Main.xaml': strToU8(xaml(Array.from({ length: 600 }, (_, i) => mystery(i)).join('') + invoke('Bad.xaml'))),
      'Bad.xaml': strToU8('<Activity><Sequence></Activity>'),
    };
    const r = importSource('uipath', Buffer.from(zipSync(files)), { name: 'many', hasSiteLogin: true, secrets: SECRETS });
    const items = r.report.items;
    expect(MAX_REPORT_ITEMS).toBe(500);
    expect(items).toHaveLength(501);
    // The error (after 600 activities) and the project-wide "no browser activities" item are kept; the rest in order.
    expect(errors(r)).toEqual([expect.objectContaining({ at: 'Bad.xaml', reason: expect.stringContaining('cannot be read') })]);
    expect(items).toContainEqual(expect.objectContaining({ at: '', what: 'Browser steps' }));
    const kept = items.filter((i) => i.what.startsWith('[secret]') || i.what.startsWith('Mystery'));
    expect(kept.map((i) => i.what)).toEqual(Array.from({ length: kept.length }, (_, i) => `Mystery ${i} for [secret]`));
    // 603 items (600 activities, the error, the invoke's own item, the browser item), less the 500 kept.
    expect(items.at(-1)).toEqual({ at: '', kind: 'untranslated', what: '…and 103 more not translated', reason: expect.stringContaining('the report lists 500 items') });
    expect(JSON.stringify(r.report)).not.toContain(SECRETS.username);
    // The flow is not cut here (the node's workflow file caps what it draws).
    expect(r.flow?.nodes.filter((n) => n.kind === 'untranslated').length).toBeGreaterThanOrEqual(600);
  });

  it('the project as a whole holds at most 1,000,000 parsed elements', () => {
    const files: Record<string, Uint8Array> = { 'Main.xaml': strToU8(xaml(Array.from({ length: 8 }, (_, i) => invoke(`P${i}.xaml`)).join(''))) };
    for (let i = 0; i < 8; i++) files[`P${i}.xaml`] = strToU8(xaml(`<Delay DisplayName="P${i}" />${'<Sequence.Variables />'.repeat(150_000)}`, `P${i}`));
    const { out, ms } = timed(() => importSource('uipath', Buffer.from(zipSync(files)), { name: 'p', hasSiteLogin: false }));
    const errs = errors(out);
    expect(errs.length).toBeGreaterThan(0);
    for (const e of errs) expect(e.reason).toContain('1,000,000 elements');
    // The first six files fit; the rest are reported, not parsed.
    expect(out.flow?.nodes.filter((n) => n.kind === 'wait').map((n) => n.displayName)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']);
    expect(ms).toBeLessThan(bound(3000));
    // The Object Repository counts too.
    const objects: Record<string, Uint8Array> = { 'project.json': strToU8('{"main":"Main.xaml"}'), 'Main.xaml': strToU8(xaml('<Delay />')) };
    for (let i = 0; i < 6; i++) objects[`.objects/L/A/S/E${i}/.content`] = strToU8(`<ObjectRepositoryTargetData Reference="L/E${i}">${'<x />'.repeat(199_000)}</ObjectRepositoryTargetData>`);
    const or = importSource('uipath', Buffer.from(zipSync(objects)), { name: 'p', hasSiteLogin: false });
    expect(errors(or).map((e) => e.reason)).toEqual([expect.stringContaining('1,000,000 elements')]);
  });

  it('credential asset names stay out of display names and the report', () => {
    const r = importSource('uipath', xaml(`<ui:GetCredential AssetName="Portal_Bot" DisplayName="Get credential PORTAL_BOT" /><ui:LogMessage DisplayName="Log portal_bot" />`), { name: 'c', hasSiteLogin: false });
    expect(r.flow?.nodes).toEqual([{ kind: 'credential', asset: 'Portal_Bot', displayName: 'Get credential the credential' }]);
    expect(JSON.stringify(r.report).toLowerCase()).not.toContain('portal_bot');
  });

  it('a C# project reads C# literals', () => {
    const files = fixtureFiles();
    const body = xaml(card(typeInto('Folder', "<webctrl tag='INPUT' aaname='Folder' />", String.raw`["C:\\Reports"]`)));
    const zipWith = (lang: string) => Buffer.from(zipSync({ 'project.json': strToU8(JSON.stringify({ ...JSON.parse(files['project.json']), expressionLanguage: lang })), 'Main.xaml': strToU8(body) }));
    const valueOf = (r: ImportResult) => (r.drafts[0].script.steps[1] as S<'fill'>).fill.value;
    expect(valueOf(importSource('uipath', zipWith('CSharp'), { name: 'cs', hasSiteLogin: false }))).toBe(String.raw`C:\Reports`);
    expect(valueOf(importSource('uipath', zipWith('VisualBasic'), { name: 'vb', hasSiteLogin: false }))).toBe(String.raw`C:\\Reports`);
    // A single file says C# on its root.
    const cs = body.replace('<Activity ', '<Activity sap2010:ExpressionActivityEditor.ExpressionActivityEditor="C#" ');
    expect(valueOf(importSource('uipath', cs, { name: 'cs', hasSiteLogin: false }))).toBe(String.raw`C:\Reports`);
  });

  it('hostile and broken projects give report errors, never a throw or a hang', () => {
    const run = (data: Buffer | string) => timed(() => importSource('uipath', data, { name: 'x', hasSiteLogin: false }));
    // A zip bomb.
    const bomb = run(zip([{ name: 'Main.xaml', raw: zeros(256), usize: 100 }]));
    expect(errors(bomb.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('larger than') })]);
    // Too many entries.
    const many = run(Buffer.from(zipSync(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f${i}.xaml`, strToU8('x')])))));
    expect(errors(many.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('2000') })]);
    // More than 20 MiB.
    const big = run(Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
    expect(errors(big.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('20 MiB') })]);
    // Deeply nested XAML.
    const deep = run(xaml(`${'<Sequence>'.repeat(10_000)}${'</Sequence>'.repeat(10_000)}`));
    expect(errors(deep.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('deeper than 200') })]);
    // Too many elements.
    const wide = run(xaml('<Delay />'.repeat(250_000)));
    expect(errors(wide.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('200000 elements') })]);
    // A DOCTYPE (entity expansion) is refused.
    const doctype = run(`<!DOCTYPE a [<!ENTITY x "y">]>${xaml('')}`);
    expect(errors(doctype.out)).toEqual([expect.objectContaining({ reason: expect.stringContaining('DOCTYPE') })]);
    for (const t of [bomb, many, big, deep, wide, doctype]) expect(t.ms).toBeLessThan(bound(1000));

    // A malformed invoked workflow is reported and the rest imports.
    const broken = importSource('uipath', projectZip({ 'Workflows/UploadReport.xaml': '<Activity><Sequence></Activity>' }), OPTS);
    expect(errors(broken)).toEqual([expect.objectContaining({ at: 'Workflows/UploadReport.xaml', reason: expect.stringContaining('cannot be read') })]);
    expect(broken.drafts.map((d) => d.name)).toEqual(['sap-report-1']);
    expect(broken.flow?.nodes.map((n) => n.kind)).toEqual(['credential', 'browser', 'untranslated', 'if', 'forEach', 'readSpreadsheet', 'untranslated', 'untranslated']);
    // A selector with a bare & is a report item for that activity, not a failed import.
    const amp = importSource('uipath', xaml(card(click('P&amp;L', "<webctrl tag='BUTTON' aaname='P&L' />") + click('Next', "<webctrl tag='BUTTON' aaname='Next' />"))), { name: 'amp', hasSiteLogin: false });
    expect(errors(amp)).toEqual([]);
    expect(amp.drafts[0].script.steps.map((s) => s.intent)).toEqual(['Open portal.example.com/app', 'Click Next']);
    expect(amp.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Click P&L', reason: expect.stringContaining('cannot be read') }));
    // Not a project at all.
    for (const data of ['', 'hello', Buffer.from(zipSync({ 'readme.txt': strToU8('hi') })), Buffer.from('PK\u0003\u0004 not really')]) {
      const r = importSource('uipath', data, { name: 'x', hasSiteLogin: false });
      expect(errors(r).length).toBeGreaterThan(0);
      expect(r.drafts).toEqual([]);
    }
    // A project whose main workflow is missing.
    const noMain = importSource('uipath', projectZip({ 'Main.xaml': null }), OPTS);
    expect(errors(noMain)).toEqual([expect.objectContaining({ reason: expect.stringContaining('Main.xaml') })]);
    // uipathImport alone never throws either.
    const report = newReport();
    expect(uipathImport(Buffer.from([0x50, 0x4b, 0x05, 0x06]), { name: 'x', hasSiteLogin: false }, report)).toEqual({ sequences: [], flow: { name: 'x', nodes: [] } });
    expect(report.items.length).toBeGreaterThan(0);
  });

  it('activity table: classic and modern names, scopes and reports', () => {
    const body = card([
      `<uix:NGoToUrl DisplayName="Go to URL" Url="https://portal.example.com/orders" />`,
      `<uix:NCheck Action="Check" DisplayName="Check 'Open only'"><uix:NCheck.Target>${target("<webctrl tag='INPUT' type='checkbox' aaname='Open only' />")}</uix:NCheck.Target></uix:NCheck>`,
      `<uix:NGetText DisplayName="Get Text 'Total'"><uix:NGetText.Target>${target("<webctrl tag='SPAN' id='total' />")}</uix:NGetText.Target></uix:NGetText>`,
    ].join(''))
      + `<TryCatch DisplayName="Try Catch"><TryCatch.Try><Sequence><ui:Comment DisplayName="Comment" Text="note" /><Assign DisplayName="Assign" /></Sequence></TryCatch.Try>
         <TryCatch.Catches><Catch x:TypeArguments="s:Exception"><ActivityAction x:TypeArguments="s:Exception"><Sequence /></ActivityAction></Catch></TryCatch.Catches></TryCatch>`
      + `<Flowchart DisplayName="Flow"><Flowchart.StartNode><x:Reference>__ReferenceID0</x:Reference></Flowchart.StartNode>
         <FlowStep x:Name="__ReferenceID0"><ui:SendOutlookMailMessage To="ops@acme.example" Subject="Done" DisplayName="Send Outlook Mail Message" /><FlowStep.Next><FlowStep x:Name="__ReferenceID1"><Delay DisplayName="Pause" Duration="00:00:03" /><FlowStep.Next><FlowDecision x:Name="__ReferenceID2" Condition="[ok]" DisplayName="Decide" /></FlowStep.Next></FlowStep></FlowStep.Next></FlowStep>
         <x:Reference>__ReferenceID1</x:Reference></Flowchart>`
      + `<ui:UploadFile DisplayName="Upload outside a scope" BucketName="b" />`
      + `<ui:CommentOut DisplayName="Disabled"><ui:CommentOut.Body><Sequence>${click('Never', "<webctrl tag='BUTTON' aaname='Never' />")}</Sequence></ui:CommentOut.Body></ui:CommentOut>`
      + `<ueab:ExcelProcessScopeX xmlns:ueab="http://schemas.uipath.com/workflow/activities/excel" DisplayName="Excel Process Scope"><ueab:ExcelProcessScopeX.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
         <ueab:ExcelApplicationCard DisplayName="Use Excel File" WorkbookPath="out.xlsx"><ueab:ExcelApplicationCard.Body><ActivityAction x:TypeArguments="ue:IWorkbookQuickHandle"><Sequence>
         <ueab:WriteRangeX DisplayName="Write DataTable to Excel" /></Sequence></ActivityAction></ueab:ExcelApplicationCard.Body></ueab:ExcelApplicationCard></Sequence></ActivityAction></ueab:ExcelProcessScopeX.Body></ueab:ExcelProcessScopeX>`
      + `<ui:MysteryActivity DisplayName="Mystery"><ui:MysteryActivity.Body><ActivityAction><Sequence><Delay /></Sequence></ActivityAction></ui:MysteryActivity.Body></ui:MysteryActivity>`;
    const r = importSource('uipath', xaml(body), { name: 't', hasSiteLogin: false });
    expect(errors(r)).toEqual([]);
    expect(r.drafts.map((d) => d.script.steps.map((s) => s.intent))).toEqual([['Open portal.example.com/app', 'Open portal.example.com/orders', 'Check Open only']]);
    expect(r.flow?.nodes).toEqual([
      { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Portal' },
      { kind: 'untranslated', activity: 'NGetText', displayName: "Get Text 'Total'", note: expect.stringContaining('ID Pattern') },
      { kind: 'email', to: 'ops@acme.example', subject: 'Done', displayName: 'Send Outlook Mail Message' },
      { kind: 'wait', seconds: 3, displayName: 'Pause' },
      { kind: 'untranslated', activity: 'FlowDecision', displayName: 'Decide', note: expect.stringContaining('Flowchart') },
      { kind: 'untranslated', activity: 'UploadFile', displayName: 'Upload outside a scope', note: expect.stringContaining('Amazon') },
      { kind: 'writeSpreadsheet', path: 'out.xlsx', displayName: 'Write DataTable to Excel' },
      { kind: 'untranslated', activity: 'MysteryActivity', displayName: 'Mystery', note: expect.stringContaining('1 activity inside') },
    ]);
    const items = r.report.items;
    for (const what of ['Comment', 'Assign', 'Disabled']) expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Catch Exception' }));
    expect(JSON.stringify(r)).not.toContain('Never');
  });
});

// A realistic identity-first sign-in (email, Next, password, Sign in), its code from a TOTP activity
// (Text="[strOtp]", never 6 to 8 digits), then "Stay signed in?" No, then the classic GUI's XLSX export.
describe('UiPath: identity-first sign-in with a code from a TOTP activity and "Stay signed in?"', () => {
  const SSO_DIR = fileURLToPath(new URL('./fixtures/import/uipath-sap-sso2/', import.meta.url));
  const SSO2 = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
  const SSO_OPTS: ImportOptions = {
    name: 'sap-sso2', hasSiteLogin: true, secrets: SSO2, vars: { strFromDate: '01.09.2026', strToDate: '30.09.2026' }, download: { check: { name: '\\.XLSX$' } },
  };
  const ssoFiles = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of readdirSync(SSO_DIR)) out[name] = readFileSync(join(SSO_DIR, name), 'utf8');
    return out;
  };
  const ssoZip = (main = ssoFiles()['Main.xaml']): Buffer => Buffer.from(zipSync(Object.fromEntries(
    Object.entries({ ...ssoFiles(), 'Main.xaml': main }).map(([k, v]) => [`SAP Line Item Report (SSO)/${k}`, strToU8(v)]),
  )));

  it('imports one draft whose login block ends after the gated No, with the code taken into signIn.totp', () => {
    const r = importSource('uipath', ssoZip(), SSO_OPTS);
    expect(errors(r)).toEqual([]);
    expect(r.report.items.filter((i) => i.kind === 'untranslated')).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    const script = r.drafts[0].script;
    expect(parseScript(script)).toEqual(script);
    expect(script.steps.map(verbOf)).toEqual(['goto', 'signIn', 'click', 'goto', 'click', 'fill', 'fill', 'fill', 'click', 'click', 'click', 'download']);
    expect((script.steps[1] as S<'signIn'>).signIn).toMatchObject({
      username: { label: 'Email' }, next: { role: 'button', name: 'Next' }, password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' }, totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } },
    });
    expect(script.steps[2]).toMatchObject({ intent: 'Click No', when: { visible: { role: 'button', name: 'No', exact: true } }, click: { role: 'button', name: 'No', exact: true } });
    expect(script.steps.slice(3).some((s) => 'when' in s)).toBe(false);
    expect(loginBlockEnd(script)).toBe(2);
    expect((script.steps[6] as S<'fill'>).fill.value).toBe('{{var.strFromDate}}');

    const items = r.report.items;
    expect(items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Code', reason: expect.stringContaining('fresh code') }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Generate the authenticator code', reason: expect.stringContaining('Site Login') }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Click No', reason: expect.stringContaining('Stay signed in?') }));
    // The TOTP activity is no flow node: the browser activities stay one sequence.
    expect(r.flow?.nodes.map((n) => n.kind)).toEqual(['credential', 'credential', 'browser']);
    // Deep scan: no Site Login secret, no credential asset name, nothing of the code's expression.
    const json = JSON.stringify(r);
    for (const v of [SSO2.username, SSO2.password, SSO2.totpSecret]) expect(json).not.toContain(v);
    // A credential asset's name appears only as its slot on the credential node.
    expect(JSON.stringify([r.drafts, r.report])).not.toContain('SAP_SSO_BotTotp');
    expect(JSON.stringify(r.drafts)).not.toMatch(/strOtp|secTotpKey/);
  });

  it('a code typed from any expression into a code field joins the sign-in; a TOTP output marks a field that is not labelled a code', () => {
    const main = ssoFiles()['Main.xaml'];
    // Without the TOTP activity: the label (Code) and the expression are enough.
    const plain = importSource('uipath', ssoZip(main.replace(/<otp:GenerateTOTP [^\n]*\/>\n/, '').replace('Text="[strOtp]"', 'Text="[strCode]"')), SSO_OPTS);
    expect((plain.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp).toMatchObject({ field: { label: 'Code' } });
    expect(plain.report.items.filter((i) => i.kind === 'untranslated')).toEqual([]);
    // A field named otherwise: the TOTP activity's output says it is the code.
    const relabel = (m: string) => m.replace("type='tel' aaname='Code'", "type='tel' aaname='Security response'").replaceAll("aaname='Code'", "aaname='Security response'").replace("DisplayName=\"Type Into 'Code'\"", "DisplayName=\"Type Into 'Security response'\"");
    const named = importSource('uipath', ssoZip(relabel(main)), SSO_OPTS);
    expect((named.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp).toMatchObject({ field: { label: 'Security response' } });
    // Without the TOTP activity, a code label or a code-like variable name: not the code (reported as an expression the
    // import does not evaluate).
    const neither = importSource('uipath', ssoZip(relabel(main).replace(/<otp:GenerateTOTP [^\n]*\/>\n/, '').replace('Text="[strOtp]"', 'Text="[strResponse]"')), SSO_OPTS);
    expect((neither.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp).toBeUndefined();
    expect(neither.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('strResponse') }));
  });

  it('a field typed from an expression right after a sign-in is the code only when it is a TOTP output or its own texts say code', () => {
    const signInBody = [
      typeInto('User', "<webctrl tag='INPUT' aaname='User' id='user' />", '[in_User]'),
      `<uix:NTypeInto DisplayName="Type Into 'Password'" SecureText="[in_Password]"><uix:NTypeInto.Target>${target("<webctrl tag='INPUT' type='password' id='pw' />")}</uix:NTypeInto.Target></uix:NTypeInto>`,
      click('Log On', "<webctrl tag='BUTTON' aaname='Log On' />"),
    ].join('');
    const after = (field: string) => importSource('uipath', xaml(card([signInBody, field, click('Continue', "<webctrl tag='BUTTON' aaname='Continue' />")].join(''))),
      { name: 'sap', hasSiteLogin: true, secrets: SECRETS, vars: { in_Transaction: 'FBL1N' } });
    // SAP's command field (id ToolbarOkCode) typed from a mapped argument: a plain fill, the transaction code kept.
    const tcode = after(typeInto('Command field', "<webctrl tag='INPUT' id='ToolbarOkCode' aaname='Command field' />", '[in_Transaction]'));
    const steps = tcode.drafts[0].script.steps;
    expect((steps[1] as S<'signIn'>).signIn.totp).toBeUndefined();
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'fill', 'click']);
    expect((steps[2] as S<'fill'>).fill.value).toBe('{{var.in_Transaction}}');
    expect(tcode.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).not.toContain('Command field');
    // A config expression the import does not evaluate: reported, never the code.
    const config = after(typeInto('Transaction', "<webctrl tag='INPUT' id='cmd' />", '[Config("TCode").ToString]'));
    expect((config.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp).toBeUndefined();
    expect(config.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('Config("TCode")') }));
    expect(config.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).not.toContain('Transaction');
    // "Company Code" and "Promo code" from an expression: not the code either.
    for (const name of ['Company Code', 'Promo code']) {
      const r = after(typeInto(name, `<webctrl tag='INPUT' aaname='${name}' />`, '[strValue]'));
      expect((r.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp, name).toBeUndefined();
    }
    // A field whose own text says it is the code is (an authenticator code typed from any variable).
    const otp = after(typeInto('Verification code', "<webctrl tag='INPUT' id='otp' aaname='Verification code' />", '[strCode]'));
    expect((otp.drafts[0].script.steps[1] as S<'signIn'>).signIn.totp).toMatchObject({ submit: { role: 'button', name: 'Continue' } });
  });

  it('a TOTP activity is never a step or a flow node, inside or outside a browser card; a code it makes typed elsewhere is reported', () => {
    for (const activity of ['GenerateTOTP', 'GetTotpCode', 'GenerateOneTimePassword', 'GetOtp']) {
      const r = importSource('uipath', xaml(`<otp:${activity} xmlns:otp="clr-namespace:Vendor.Otp" DisplayName="Make a code" Result="[strCode]" />${card(
        typeInto('Reference', "<webctrl tag='INPUT' aaname='Reference' />", '[strCode]') + click('Save', "<webctrl tag='BUTTON' aaname='Save' />"))}`), OPTS);
      expect(r.flow?.nodes.map((n) => n.kind), activity).toEqual(['browser']);
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Make a code' }));
      // Not after a sign-in: the typed code is no step, and the report says where it came from.
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Type into Reference', reason: expect.stringContaining('TOTP activity') }));
      expect(r.drafts[0].script.steps.some((s) => 'fill' in s)).toBe(false);
    }
    // Other names stay untranslated activities.
    const other = importSource('uipath', xaml(card(`<ui:Hotpath DisplayName="Hot path" />${click('Save', "<webctrl tag='BUTTON' aaname='Save' />")}`)), OPTS);
    expect(other.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Hot path' }));
  });
});
