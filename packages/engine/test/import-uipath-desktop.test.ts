import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDesktopTrust, runDesktopTask } from '../src/desktop/task.js';
import { importSource } from '../src/import/index.js';
import type { ImportItem, ImportOptions, ImportResult } from '../src/import/types.js';
import { canonicalChord } from '../src/import/uipath.js';
import { canonicalChord as sharedCanonicalChord } from '../src/steps/desktop-vocabulary.js';
import {
  ctrlControlType, CTRL_ROLE_TO_CONTROL_TYPE, readDesktopSelector, uiaControlType, UIA_ROLE_TO_CONTROL_TYPE,
} from '../src/import/uipath-desktop-selector.js';
import {
  declareWrites, describeDesktopStep, desktopProposal, desktopSafetyFlags, parseWriteSteps, signDesktopSteps, type DesktopProposal,
} from '../src/proposal/desktop.js';
import { proposalDigest } from '../src/proposal/proposal.js';
import { parseDesktopScript } from '../src/steps/parse.js';
import type { DesktopStep } from '../src/types.js';
import { ERP_PASSWORD, ERP_POLICY, erpCsv, erpLineItems, FakeRunner } from './fake-runner.js';
import { EXPECTED, VARS } from './fixtures/erp-steps.js';

const DIR = fileURLToPath(new URL('./fixtures/import/uipath-erp-desktop/', import.meta.url));
const KEY = 'desktop-import-signing-key-0123456789';
const OWNER = 'owner@example.com';
const OPTS: ImportOptions = { name: 'erp', hasSiteLogin: false };

/** The sample project zipped under its folder, as Studio exports it or a user zips it. */
function sampleZip(changes: Record<string, string> = {}): Buffer {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(DIR, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(DIR);
  Object.assign(files, changes);
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[`ERP Demo Line Items/${path}`] = strToU8(text);
  return Buffer.from(zipSync(entries));
}
const fixture = (path: string) => readFileSync(join(DIR, path), 'utf8');

const items = (r: ImportResult, kind: ImportItem['kind']) => r.report.items.filter((i) => i.kind === kind);

describe('the sample UiPath desktop project (ERP Demo)', () => {
  it('imports one desktop draft with exactly the expected steps, and no browser draft', () => {
    const r = importSource('uipath', sampleZip(), OPTS);
    expect(items(r, 'error')).toEqual([]);
    expect(r.drafts).toEqual([]);
    expect(r.desktopDrafts).toHaveLength(1);
    const d = r.desktopDrafts![0];
    expect(d.script).toEqual(EXPECTED);
    expect(parseDesktopScript(d.script)).toEqual(EXPECTED);
    expect(d).toMatchObject({ name: 'erp-1', writeCandidates: [4, 16], variables: ['username', 'password', 'in_CompanyCode', 'in_DateFrom', 'in_DateTo'], secretVariables: ['password'] });
    expect(r.report.steps).toBe(17);
    // No step is a write: the owner declares writes at approval.
    expect(d.script.steps.some((s) => 'write' in s)).toBe(false);
  });

  it('the flow keeps the credential lookup and one desktop node; the log message is dropped', () => {
    const r = importSource('uipath', sampleZip(), OPTS);
    expect(r.flow).toEqual({
      name: 'ERP Demo Line Items',
      nodes: [
        { kind: 'credential', asset: 'ERP_Demo_Login', displayName: 'Get ERP Demo credential' },
        { kind: 'desktop', sequence: 1, displayName: "Open Application 'ERP Demo - Sign in'" },
      ],
    });
    expect(r.report.items).toContainEqual({ at: 'Main.xaml: LogMessage_1', kind: 'dropped', what: 'Log Message', reason: expect.stringContaining('logging is not a step') });
  });

  it('the password is a secret run variable: never imported, and the report says how to supply it', () => {
    const r = importSource('uipath', sampleZip(), OPTS);
    expect(items(r, 'secret')).toEqual([{
      at: 'Main.xaml: TypeSecureText_1', kind: 'secret', what: 'Password',
      reason: expect.stringContaining('the step types the run variable {{var.password}}. Supply password in Run steps → Options → Variables from a secret source'),
    }]);
    // The credential lookup is reworded: desktop steps never use a Site Login.
    expect(r.report.items.find((i) => i.what === 'Get ERP Demo credential')?.reason).toBe(
      'a UiPath credential is never imported: desktop steps type its user name and password from run variables (see the secret items); browser steps use an RPA Site Login on the Run steps node',
    );
    // The asset's name appears only as the credential node's slot.
    const text = JSON.stringify({ ...r, flow: undefined });
    expect(text).not.toContain('ERP_Demo_Login');
  });

  it('lists the candidate writes (Enter on the sign-in form, Save in the dialog) and never declares them', () => {
    const r = importSource('uipath', sampleZip(), OPTS);
    expect(items(r, 'candidateWrite').map((i) => [i.at, i.what])).toEqual([
      ['Main.xaml: SendHotkey_1', 'Step 4: Press Enter in Password'],
      ['Workflows/SearchAndExport.xaml: Click_4', 'Step 16: Click Save'],
    ]);
    expect(items(r, 'candidateWrite')[1].reason).toContain('list 16 in Write Steps when you approve');
  });

  it('the save path becomes {{$exportDir}} and an expectFile step; lossy selector parts are reported', () => {
    const r = importSource('uipath', sampleZip(), OPTS);
    const converted = items(r, 'converted');
    expect(converted).toContainEqual(expect.objectContaining({
      at: 'Workflows/SearchAndExport.xaml: TypeInto_3', what: 'File name:', reason: expect.stringContaining('became {{$exportDir}}\\line-items.csv'),
    }));
    expect(converted).toContainEqual(expect.objectContaining({ what: 'Return line-items.csv', reason: expect.stringContaining('expectFile') }));
    expect(converted).toContainEqual(expect.objectContaining({ at: 'Workflows/SearchAndExport.xaml: GetValue_2', reason: expect.stringContaining("role 'cell' (<ctrl>) became the UI Automation control type DataItem") }));
    expect(converted).toContainEqual(expect.objectContaining({ at: 'Main.xaml: TypeInto_1', reason: expect.stringContaining('class name uses a wildcard') }));
    expect(converted).toContainEqual(expect.objectContaining({ at: 'Main.xaml: OpenApplication_1', reason: expect.stringContaining('opens as ErpDemo.exe') }));
  });

  it('a save path whose file name is not a literal is a report item, and no expectFile is invented', () => {
    const file = 'Workflows/SearchAndExport.xaml';
    const r = importSource('uipath', sampleZip({ [file]: fixture(file).replace('[in_ExportFolder + &quot;\\line-items.csv&quot;]', '[in_ExportFolder + &quot;\\&quot; + fileName]') }), OPTS);
    const steps = r.desktopDrafts![0].script.steps;
    expect(steps.some((s) => 'expectFile' in s)).toBe(false);
    expect(steps.some((s) => 'fill' in s && s.fill.value.includes('$exportDir'))).toBe(false);
    expect(items(r, 'untranslated')).toContainEqual(expect.objectContaining({ at: `${file}: TypeInto_3`, reason: expect.stringContaining('cannot split into a folder and a literal file name') }));
  });

  it('a literal typed into a password field is never imported, anywhere in the result', () => {
    const literal = 'Hunter-2-secret';
    const main = fixture('Main.xaml').replace(/<ui:TypeSecureText [^>]*SecureText="\[password\]"[^>]*>/, (tag) => tag.replace('ui:TypeSecureText', 'ui:TypeInto').replace('SecureText="[password]"', `Text="${literal}"`))
      .replace('</ui:TypeSecureText.Target>\n            </ui:TypeSecureText>', '</ui:TypeSecureText.Target>\n            </ui:TypeInto>').replaceAll('ui:TypeSecureText.Target', 'ui:TypeInto.Target');
    expect(main).toContain(literal);
    const r = importSource('uipath', sampleZip({ 'Main.xaml': main }), OPTS);
    expect(items(r, 'error')).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(literal);
    expect(r.desktopDrafts![0].script.steps[2]).toMatchObject({ fill: { value: '{{var.password}}' } });
    expect(items(r, 'secret')).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('a value typed into a password field is never imported') }));
  });
});

describe('UiPath desktop selectors → UI Automation conditions', () => {
  it('maps <uia> attributes: automationid, cls, name, role (by the role table)', () => {
    expect(readDesktopSelector("<wnd app='erpdemo.exe' title='ERP Demo - Sign in' /><uia automationid='txtUser' cls='Edit' name='User name' role='edit' />")).toEqual({
      kind: 'uia', window: { exe: 'erpdemo.exe', title: 'ERP Demo - Sign in' }, path: [{ controlType: 'Edit', automationId: 'txtUser', name: 'User name', className: 'Edit' }], issues: [],
      hints: ['ERP Demo - Sign in', 'User name', 'txtUser'],
    });
    // A partial selector (inside a window scope) has no window of its own.
    expect(readDesktopSelector("<uia name='File' role='menu item' />")).toMatchObject({ kind: 'uia', path: [{ controlType: 'MenuItem', name: 'File' }] });
    expect(readDesktopSelector("<uia name='File' role='menu item' />")).not.toHaveProperty('window');
    // Each element after the window is one more condition below the previous match.
    expect(readDesktopSelector("<wnd app='a.exe' /><uia automationid='grid' role='data grid' /><uia name='Row 0' role='data item' />")).toMatchObject({
      path: [{ controlType: 'DataGrid', automationId: 'grid' }, { controlType: 'DataItem', name: 'Row 0' }],
    });
  });

  it('the role table covers UiPath\'s UI Automation role names, ignoring case and spaces', () => {
    const cases: [string, string][] = [
      ['button', 'Button'], ['edit', 'Edit'], ['combo box', 'ComboBox'], ['ComboBox', 'ComboBox'], ['list item', 'ListItem'], ['menu item', 'MenuItem'],
      ['data grid', 'DataGrid'], ['data item', 'DataItem'], ['table', 'Table'], ['text', 'Text'], ['check box', 'CheckBox'], ['radio button', 'RadioButton'],
      ['tab item', 'TabItem'], ['tree item', 'TreeItem'], ['hyperlink', 'Hyperlink'], ['link', 'Hyperlink'], ['dialog', 'Window'], ['window', 'Window'],
      ['pane', 'Pane'], ['split button', 'SplitButton'], ['tool bar', 'ToolBar'], ['status bar', 'StatusBar'], ['header item', 'HeaderItem'], ['document', 'Document'],
    ];
    for (const [role, type] of cases) expect(uiaControlType(role), role).toBe(type);
    expect(uiaControlType('flux capacitor')).toBeUndefined();
    // Every entry is a UI Automation control type name.
    for (const v of Object.values(UIA_ROLE_TO_CONTROL_TYPE)) expect(v).toMatch(/^[A-Z][A-Za-z]+$/);
    for (const v of Object.values(CTRL_ROLE_TO_CONTROL_TYPE)) expect(v.controlType).toMatch(/^[A-Z][A-Za-z]+$/);
    expect(ctrlControlType('push button')).toEqual({ controlType: 'Button', exact: true });
    expect(ctrlControlType('editable text')).toEqual({ controlType: 'Edit', exact: true });
    expect(ctrlControlType('page tab')).toEqual({ controlType: 'TabItem', exact: true });
    expect(ctrlControlType('cell')).toEqual({ controlType: 'DataItem', exact: false });
  });

  it('maps <ctrl> as far as it goes and reports what is lost', () => {
    const r = readDesktopSelector("<wnd app='erpdemo.exe' /><ctrl ctrlname='gridResults' /><ctrl name='Document Row 0' role='cell' />");
    expect(r).toMatchObject({ kind: 'uia', path: [{ automationId: 'gridResults' }, { controlType: 'DataItem', name: 'Document Row 0' }] });
    expect(r.kind === 'uia' && r.issues).toEqual([expect.stringContaining("role 'cell' (<ctrl>) became the UI Automation control type DataItem")]);
    const win32 = readDesktopSelector("<wnd app='notepad.exe' cls='#32770' /><ctrl ctrlid='1001' role='editable text' text='x' />");
    expect(win32).toMatchObject({ path: [{ controlType: 'Edit', automationId: '1001' }] });
    expect(win32.kind === 'uia' && win32.issues).toEqual([expect.stringContaining('attribute text has no UI Automation equivalent')]);
    const unknown = readDesktopSelector("<wnd app='a.exe' /><ctrl name='Thing' role='sound' />");
    expect(unknown).toMatchObject({ path: [{ name: 'Thing' }] });
    expect(unknown.kind === 'uia' && unknown.issues[0]).toContain("role 'sound' (<ctrl>) has no UI Automation control type");
  });

  it('wildcards, regex, variables and idx are left out of conditions and reported; a wildcard title becomes a pattern', () => {
    const r = readDesktopSelector("<wnd app='a.exe' title='Orders - *' cls='WindowsForms10.Window.8.app*' /><uia automationid='btn{{n}}' name='Sa?e' role='button' idx='2' />");
    expect(r).toMatchObject({ kind: 'uia', window: { exe: 'a.exe', titlePattern: '^Orders - .*$' }, path: [{ controlType: 'Button' }] });
    const issues = r.kind === 'uia' ? r.issues.join(' | ') : '';
    for (const word of ['window class uses a wildcard', 'automation id is a UiPath variable', 'name uses a wildcard', 'picked by position (idx']) expect(issues).toContain(word);
    expect(readDesktopSelector("<wnd app='a.exe' /><uia name='Inv.*' matching:name='regex' role='text' />")).toMatchObject({ path: [{ controlType: 'Text' }] });
  });

  it('SAP GUI, Java, remote desktop and web selectors are never UI Automation targets', () => {
    expect(readDesktopSelector("<wnd app='saplogon.exe' /><ctrl name='okcd' />").kind).toBe('sap');
    expect(readDesktopSelector("<sap id='tbar[1]' />").kind).toBe('sap');
    expect(readDesktopSelector("<wnd app='javaw.exe' /><java role='push button' name='OK' />")).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('Java element') });
    expect(readDesktopSelector("<wnd app='wfica32.exe' title='ERP - Citrix' /><uia name='OK' />")).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('remote desktop window') });
    expect(readDesktopSelector("<webctrl tag='BUTTON' />").kind).toBe('none');
    expect(readDesktopSelector("<wnd app='a.exe' title='Main' />")).toEqual({ kind: 'window', window: { exe: 'a.exe', title: 'Main' }, issues: [], hints: ['Main'] });
  });

  it('Send Hotkey keys become canonical chords; Win chords are refused', () => {
    expect(canonicalChord('enter', 'None')).toEqual({ chord: 'Enter' });
    expect(canonicalChord('s', 'Shift, Ctrl')).toEqual({ chord: 'Ctrl+Shift+S' });
    expect(canonicalChord('F5', '')).toEqual({ chord: 'F5' });
    expect(canonicalChord('pgdn', 'Alt')).toEqual({ chord: 'Alt+PageDown' });
    expect(canonicalChord('esc', 'none')).toEqual({ chord: 'Escape' });
    expect(canonicalChord('r', 'Win')).toEqual({ error: expect.stringContaining('Windows-key shortcut') });
    expect(canonicalChord('printscreen', '')).toEqual({ error: expect.stringContaining('not one desktop steps can press') });
  });
});

const NS = 'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
const xaml = (body: string) => `<Activity x:Class="Main" ${NS}><Sequence DisplayName="Main">${body}</Sequence></Activity>`;
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const target = (selector: string) => `<ui:Target Selector="${esc(selector)}" />`;
const open = (body: string, title = 'ERP Demo - Line items') =>
  `<ui:OpenApplication DisplayName="Open ERP" FileName="ErpDemo.exe" Selector="${esc(`<wnd app='erpdemo.exe' title='${title}' />`)}"><ui:OpenApplication.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>${body}</Sequence></ActivityAction></ui:OpenApplication.Body></ui:OpenApplication>`;
const click = (name: string, selector: string, id = name) => `<ui:Click DisplayName="Click '${name}'" sap2010:WorkflowViewState.IdRef="${id}"><ui:Click.Target>${target(selector)}</ui:Click.Target></ui:Click>`;

describe('review fixes: clicks, secrets in arguments and expressions, chords, titles', () => {
  it('a right-button or modified click is untranslated, never a plain click', () => {
    const r = importSource('uipath', xaml(open([
      click('Menu', "<uia automationid='gridResults' role='table' />", 'R1').replace('<ui:Click ', '<ui:Click MouseButton="BTN_RIGHT" '),
      click('Many', "<uia automationid='gridResults' role='table' />", 'R2').replace('<ui:Click ', '<ui:Click MouseButton="BTN_LEFT" KeyModifiers="Ctrl" '),
      click('Search', "<uia automationid='btnSearch' role='button' />", 'R3').replace('<ui:Click ', '<ui:Click MouseButton="BTN_LEFT" KeyModifiers="None" '),
    ].join(''))), { name: 'c', hasSiteLogin: false });
    expect(r.desktopDrafts![0].script.steps.map((s) => s.intent)).toEqual(['Wait for the window ERP Demo - Line items', 'Click Search']);
    expect(items(r, 'untranslated').map((i) => [i.at, i.reason])).toEqual([
      ['Main.xaml: R1', expect.stringContaining('right-button click')], ['Main.xaml: R2', expect.stringContaining('with ctrl held down')],
    ]);
  });

  it('arguments that carry a password and an expression typed into a password field are never echoed', () => {
    const body = `<ui:TypeInto DisplayName="Type Into 'Password'" sap2010:WorkflowViewState.IdRef="T1" Text="[&quot;Pa55-lit&quot; &amp; suffix]"><ui:TypeInto.Target>${target("<uia automationid='txtPassword' name='Password' role='edit' />")}</ui:TypeInto.Target></ui:TypeInto>${click('Go', "<uia automationid='btnSignIn' role='button' />")}`;
    const withArgs = open(body, 'ERP Demo - Sign in').replace('FileName="ErpDemo.exe"', 'FileName="ErpDemo.exe" Arguments="/user ops /password Arg-Secret-9"');
    const r = importSource('uipath', xaml(withArgs), { name: 'a', hasSiteLogin: false });
    const text = JSON.stringify(r);
    expect(text).not.toContain('Pa55-lit');
    expect(text).not.toContain('Arg-Secret-9');
    expect(r.desktopDrafts![0].script.app).toEqual({ exe: 'ErpDemo.exe' });
    expect(items(r, 'secret')).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('arguments look like they carry a password') }));
  });

  it('shell chords are refused; Enter after a save path returns the file right away; odd window titles are reported', () => {
    // The parser's own rule (one shared definition): also with extra modifiers, as the runner judges a shell chord.
    expect(canonicalChord).toBe(sharedCanonicalChord);
    for (const [key, mods] of [['esc', 'Ctrl'], ['tab', 'Alt'], ['esc', 'Alt'], ['esc', 'Ctrl, Shift'], ['esc', 'Ctrl, Alt'], ['tab', 'Alt, Shift'], ['tab', 'Ctrl, Alt']]) {
      expect(canonicalChord(key, mods), `${mods}+${key}`).toEqual({ error: expect.stringContaining('drives the Windows shell') });
    }
    const save = `<ui:TypeInto DisplayName="Type Into 'File name:'" Text="C:\\Exports\\out.csv[k(enter)]"><ui:TypeInto.Target>${target("<uia automationid='1001' name='File name:' role='edit' />")}</ui:TypeInto.Target></ui:TypeInto>`;
    const r = importSource('uipath', xaml(open(`${save}${click('Search', "<uia automationid='btnSearch' role='button' />")}`, 'Export line items')), { name: 'e', hasSiteLogin: false });
    expect(r.desktopDrafts![0].script.steps.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['waitFor', 'fill', 'key', 'expectFile', 'click']);
    expect(readDesktopSelector("<wnd app='a.exe' title='(?i)orders' matching:title='regex' /><uia name='x' />")).toMatchObject({ kind: 'uia', window: { exe: 'a.exe' }, issues: [expect.stringContaining('regular expression this engine cannot read')] });
    expect(readDesktopSelector("<wnd app='a.exe' title='Ordrs' matching:title='fuzzy' /><uia name='x' />")).toMatchObject({ window: { exe: 'a.exe' }, issues: [expect.stringContaining('fuzzy matching')] });
  });
});

describe('untranslated desktop targets and mixed projects', () => {
  it('Java, image (computer vision) and remote desktop targets are report items, and the rest of the sequence stays one draft', () => {
    const r = importSource('uipath', xaml(open([
      click('Search', "<uia automationid='btnSearch' role='button' />", 'C1'),
      click('OK', "<wnd app='javaw.exe' /><java name='OK' role='push button' />", 'C2'),
      `<ui:Click DisplayName="Click 'Logo'" sap2010:WorkflowViewState.IdRef="C3"><ui:Click.Target><uix:TargetAnchorable SearchSteps="Image" ImageBase64="iVBOR" /></ui:Click.Target></ui:Click>`,
      `<uix:CVClick DisplayName="CV Click 'Post'" sap2010:WorkflowViewState.IdRef="C4" />`,
      click('Remote', "<wnd app='wfica32.exe' title='ERP' /><uia name='Remote' role='button' />", 'C5'),
      click('Post', "<uia automationid='btnPost' name='Post' role='button' />", 'C6'),
    ].join(''))), { name: 'u', hasSiteLogin: false });
    expect(r.desktopDrafts).toHaveLength(1);
    expect(r.desktopDrafts![0].script.steps.map((s) => s.intent)).toEqual(['Wait for the window ERP Demo - Line items', 'Click Search', 'Click Post']);
    const untranslated = items(r, 'untranslated').map((i) => [i.at, i.reason]);
    expect(untranslated).toEqual([
      ['Main.xaml: C2', expect.stringContaining('Java element (<java>)')],
      ['Main.xaml: C3', expect.stringContaining('found by image or computer vision')],
      ['Main.xaml: C4', expect.stringContaining('image, OCR or computer vision')],
      ['Main.xaml: C5', expect.stringContaining('remote desktop window')],
    ]);
    // A Post button is a candidate write, never a declared one.
    expect(r.desktopDrafts![0].writeCandidates).toEqual([3]);
  });

  it('a mixed project gives separate browser and desktop drafts, numbered in the project\'s order', () => {
    const browser = `<uix:NApplicationCard DisplayName="Use Browser: Portal"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      <uix:NClick DisplayName="Click 'Reports'"><uix:NClick.Target><uix:TargetAnchorable FullSelectorArgument="${esc("<webctrl tag='A' aaname='Reports' />")}" /></uix:NClick.Target></uix:NClick>
      </Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp Url="https://portal.example.com/app" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
    const desktopCard = `<uix:NApplicationCard DisplayName="Use Application: ERP Demo" OpenMode="IfNotOpen"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      <uix:NClick DisplayName="Click 'Search'"><uix:NClick.Target><uix:TargetAnchorable FullSelectorArgument="${esc("<uia automationid='btnSearch' name='Search' role='button' />")}" /></uix:NClick.Target></uix:NClick>
      </Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp FilePath="C:\\Program Files\\ERP Demo\\ErpDemo.exe" Selector="${esc("<wnd app='erpdemo.exe' title='ERP Demo - Line items' />")}" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
    const r = importSource('uipath', xaml(`${browser}${open(click('Sign in', "<uia automationid='btnSignIn' name='Sign in' role='button' />"), 'ERP Demo - Sign in')}<Delay DisplayName="Pause" Duration="00:00:02" />${desktopCard}${browser}`), { name: 'm', hasSiteLogin: false });
    expect(items(r, 'error')).toEqual([]);
    expect(r.drafts.map((d) => d.name)).toEqual(['m-1', 'm-4']);
    expect(r.desktopDrafts!.map((d) => d.name)).toEqual(['m-2', 'm-3']);
    expect(r.flow!.nodes.map((n) => [n.kind, 'sequence' in n ? n.sequence : undefined])).toEqual([
      ['browser', 1], ['desktop', 2], ['wait', undefined], ['desktop', 3], ['browser', 4],
    ]);
    expect(r.desktopDrafts![1].script).toMatchObject({ app: { exe: 'ErpDemo.exe' }, steps: [{ waitFor: {} }, { intent: 'Click Search' }] });
    expect(r.drafts[0].script.steps.map((s) => s.intent)).toEqual(['Open portal.example.com/app', 'Click Reports']);
  });

  it('an SAP GUI card stays the SAP report branch, untouched by desktop translation', () => {
    const sap = `<uix:NApplicationCard DisplayName="Use Application: SAP Logon"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence>
      <uix:NTypeInto DisplayName="Type Into 'Transaction'" Text="FBL3N"><uix:NTypeInto.Target><uix:TargetAnchorable FullSelectorArgument="${esc("<ctrl name='okcd' />")}" /></uix:NTypeInto.Target></uix:NTypeInto>
      </Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp FilePath="C:\\SAP\\saplogon.exe" Selector="${esc("<wnd app='saplogon.exe' />")}" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
    const r = importSource('uipath', xaml(sap), { name: 's', hasSiteLogin: false });
    expect(r.desktopDrafts).toBeUndefined();
    expect(r.report.items.map((i) => i.what)).toContain('SAP desktop activities (2)');
  });
});

/** The importer's desktop draft for the sample, as an approver receives it. */
function sampleProposal(): DesktopProposal {
  const r = importSource('uipath', sampleZip(), OPTS);
  return desktopProposal(r.desktopDrafts![0].script);
}

describe('approving and signing an imported desktop draft', () => {
  it('the proposal is a first version that lists the app, the returned file and the candidate writes', () => {
    const p = sampleProposal();
    expect(p).toMatchObject({ name: 'erp-1', baseVersion: null, version: 1, evidence: { count: 0, total: null, diff: { missing: [], extra: [] } } });
    expect(p.safetyFlags).toEqual([
      'desktop app: "ErpDemo.exe"',
      'candidate write: step 4 (Press Enter in Password) may save, post or submit: list 4 in Write Steps if it does (the desktop runner refuses a write only on the controls and keys its policy lists, so leaving a step unlisted does not stop it from saving unless its control is in the runner policy)',
      'candidate write: step 16 (Click Save) may save, post or submit: list 16 in Write Steps if it does (the desktop runner refuses a write only on the controls and keys its policy lists, so leaving a step unlisted does not stop it from saving unless its control is in the runner policy)',
      'file returned to n8n: step 17 returns the file matching "^line-items\\\\.csv$" from the run\'s export folder',
    ]);
    expect(p.changes).toHaveLength(17);
    expect(p.changes.every((c) => c.was === null)).toBe(true);
    expect(p.changes[15].now).toBe('Click Save (click "Button" id "1" name "Save" class "Button" in window app "erpdemo.exe" title "Export line items" class "#32770" or "Button" id "1" in window app "erpdemo.exe" title "Export line items" class "#32770")');
  });

  it('signs with the owner\'s declared writes, bound to the app; Run Steps\' trust gate accepts it', () => {
    const p = sampleProposal();
    const r = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [16], now: new Date('2026-10-29T10:00:00Z') });
    if (!r.ok) throw new Error(r.reasons.join('; '));
    expect(r.row).toMatchObject({ name: 'erp-1', version: 1, approvedBy: OWNER, approvedAt: '2026-10-29T10:00:00.000Z', status: 'active', writeSteps: [16] });
    // Exactly the declared step became a write; nothing else changed.
    expect(r.row.steps.steps.map((s, i) => (s.write ? i + 1 : 0)).filter(Boolean)).toEqual([16]);
    const { write: _w, ...unwritten } = r.row.steps.steps[15];
    expect({ ...r.row.steps, steps: r.row.steps.steps.map((s, i) => (i === 15 ? unwritten : s)) }).toEqual(p.steps);
    expect(checkDesktopTrust(r.row.steps, { required: true, signature: r.row.signature, approvedBy: OWNER, key: KEY })).toEqual({ ok: true, signed: true });
    // The signature binds the app: the same steps for another app do not verify, nor do the reviewed (unwritten) steps.
    expect(checkDesktopTrust({ ...r.row.steps, app: { exe: 'Other.exe' } }, { required: true, signature: r.row.signature, approvedBy: OWNER, key: KEY }).ok).toBe(false);
    expect(checkDesktopTrust(p.steps, { required: true, signature: r.row.signature, approvedBy: OWNER, key: KEY }).ok).toBe(false);
    // Without Write Steps nothing is a write.
    const plain = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [] });
    expect(plain.ok && plain.row.steps.steps.some((s) => s.write)).toBe(false);
  });

  it('refuses a changed proposal, hidden flags, a crafted change list and writes on steps that cannot write', () => {
    const p = sampleProposal();
    const digest = proposalDigest(p);
    const sign = (proposal: DesktopProposal, writeSteps: number[] = [], reviewed = digest) => signDesktopSteps({ proposal, key: KEY, approverId: OWNER, reviewedDigest: reviewed, writeSteps });
    const reasons = (r: ReturnType<typeof signDesktopSteps>) => (r.ok ? [] : r.reasons);
    expect(reasons(sign(p, [], ''))).toEqual(['the proposal has no review digest']);
    // A step changed after review: the hash and the digest no longer match.
    const edited = structuredClone(p);
    (edited.steps.steps[1] as Extract<DesktopStep, { fill: unknown }>).fill.value = 'someone-else';
    expect(reasons(sign(edited))).toEqual(expect.arrayContaining(['the steps do not match the hash that was reviewed', 'the repaired steps changed after they were reviewed']));
    // Flags that hide a candidate write, with a matching digest: refused.
    const hidden = { ...p, safetyFlags: p.safetyFlags.filter((f) => !f.includes('step 16')) };
    expect(reasons(sign(hidden, [], proposalDigest(hidden)))).toContain('the safety flags do not list the app, the returned files, the clipboard reads, the declared writes and the candidate writes the steps have');
    // The change list must show every step, in order, as added: a missing, reordered, padded or foreign entry is refused.
    const MISMATCH = 'the change list does not show every step of the steps, in order, as added';
    const lists = {
      foreign: [...p.changes.slice(0, -1), { was: null, now: 'Click Cancel (click "Button" id "2")' }],
      missing: p.changes.filter((_, i) => i !== 15),
      reordered: [p.changes[1], p.changes[0], ...p.changes.slice(2)],
      padded: [...p.changes, { was: null, now: null }],
      nullNow: p.changes.map((c, i) => (i === 15 ? { was: null, now: null } : c)),
      empty: [],
      changedWas: p.changes.map((c, i) => (i === 0 ? { was: c.now, now: c.now } : c)),
    };
    for (const [what, changes] of Object.entries(lists)) {
      const crafted = { ...p, changes } as DesktopProposal;
      expect(reasons(sign(crafted, [], proposalDigest(crafted))), what).toEqual([MISMATCH]);
    }
    const based = { ...p, baseVersion: 0 };
    expect(reasons(sign(based, [], proposalDigest(based)))).toContain('desktop steps have no repair yet, so a desktop proposal must be a first version (no base version) that shows every step');
    const proven = { ...p, evidence: { ...p.evidence, count: 12 } };
    expect(reasons(sign(proven, [], proposalDigest(proven)))).toContain('desktop steps are not replayed at import, so their evidence must be empty (no rows, no file)');
    expect(reasons(sign(p, [1]))).toEqual(['Write Steps: step 1 is a waitFor step, which cannot be a write (only click, fill, select, check and key steps can)']);
    expect(reasons(sign(p, [18]))).toEqual(['Write Steps: there is no step 18 (the steps are numbered 1 to 17)']);
    expect(reasons(sign(p, [17]))).toEqual(['Write Steps: step 17 is a expectFile step, which cannot be a write (only click, fill, select, check and key steps can)']);
  });

  it('refuses reviewed steps that already mark a write, and shows every signed field in the change list', () => {
    const p = sampleProposal();
    const preset = structuredClone(p);
    preset.steps.steps[15].write = true;
    const crafted = { ...desktopProposal(preset.steps), steps: preset.steps };
    // Flags and change list match the crafted steps, so only the preset write is refused, with or without Write Steps.
    for (const writeSteps of [[], [16]]) {
      const r = signDesktopSteps({ proposal: crafted, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(crafted), writeSteps });
      expect(r).toEqual({ ok: false, reasons: ['the reviewed steps already mark a write: only Write Steps, chosen when you approve, declares writes'] });
    }
    const step = { ...p.steps.steps[8], optional: true, checkpoint: true, timeoutMs: 5000, expect: { visible: { uia: { path: [{ automationId: 'lblResultCount' }] } } } } as DesktopStep;
    expect(describeDesktopStep(step)).toMatch(/; then expect id "lblResultCount" visible; optional; checkpoint; timeout 5000 ms\)$/);
  });

  it('Write Steps text, declareWrites and the change list descriptions', () => {
    expect(parseWriteSteps('16, 4 4')).toEqual([4, 16]);
    expect(parseWriteSteps('')).toEqual([]);
    expect(parseWriteSteps('step 4')).toEqual({ error: 'Write Steps must list step numbers, such as 7, 9' });
    const p = sampleProposal();
    const d = declareWrites(p.steps, [9]);
    expect(d.ok && d.script.steps[8].write).toBe(true);
    expect(p.steps.steps[8].write).toBeUndefined();
    expect(d.ok && describeDesktopStep(d.script.steps[8])).toMatch(/; declared write\)$/);
    expect(d.ok && desktopSafetyFlags(d.script)).toContain('write: step 9 (Click Search) is a declared write step');
    // Steps that already carry a write show it in the change list and the flags (and Sign Steps refuses them: see above).
    if (!d.ok) throw new Error('declareWrites failed');
    const withWrite = desktopProposal(d.script);
    expect(withWrite.changes[8].now).toBe('Click Search (click "Button" id "btnSearch" name "Search" in window app "erpdemo.exe" title "ERP Demo - Line items" or "Button" id "btnSearch" in window app "erpdemo.exe" title "ERP Demo - Line items"; declared write)');
    expect(withWrite.safetyFlags).toContain('write: step 9 (Click Search) is a declared write step');
    const hiddenWrite = { ...withWrite, changes: p.changes };
    const r = signDesktopSteps({ proposal: hiddenWrite, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(hiddenWrite), writeSteps: [] });
    expect(r.ok ? [] : r.reasons).toContain('the change list does not show every step of the steps, in order, as added');
  });
});

describe('end to end: import the sample, approve, sign, run on the desktop runner', () => {
  let runner: FakeRunner | undefined;
  afterEach(async () => {
    await runner?.close();
    runner = undefined;
  });

  it('the signed desktop steps sign in, search, read the results and return the CSV', async () => {
    const p = sampleProposal();
    const signed = signDesktopSteps({ proposal: p, key: KEY, approverId: OWNER, reviewedDigest: proposalDigest(p), writeSteps: [16] });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    // What the steps table stores and the generated workflow's Run steps reads back.
    const stored = JSON.parse(JSON.stringify(signed.row.steps)) as unknown;
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY });
    const r = await runDesktopTask({
      script: stored, trust: { required: true, signature: signed.row.signature, approvedBy: OWNER, key: KEY }, runner: runner.endpoint, vars: VARS, defaultStepTimeoutMs: 3000,
    });
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ fileName: 'line-items.csv', mimeType: 'text/csv', binaryName: 'file_16' });
    const csv = r.files[0].data.toString('utf8');
    expect(csv).toBe(erpCsv(erpLineItems('1000', '2026-01-01', '2026-12-31')));
    expect(csv.split('\r\n').filter(Boolean)).toHaveLength(13);
    expect(r.outputs.map((o) => [o.as, o.text])).toEqual([['out_ResultCount', '12 line items'], ['out_FirstDocument', '1000-0001']]);
    // Only the declared step carried the write marker; the password never left the run in clear.
    const acts = runner.requests.filter((q) => q.method === 'act');
    expect(acts.filter((q) => q.params.write === true).map((q) => (q.params.target as { path: { name?: string }[] }).path[0].name)).toEqual(['Save']);
    const { data: _bytes, ...shown } = r.files[0];
    expect(JSON.stringify({ ...r, files: [shown] })).not.toContain(ERP_PASSWORD);
    expect(runner.lastApp?.signInFailures).toBe(0);
  });

  it('a click on the app\'s Post button is a candidate write, never declared by the import', () => {
    const r = importSource('uipath', xaml(open(click('Post', "<uia automationid='btnPost' name='Post' role='button' />"), 'ERP Demo - Sign in')), { name: 'post', hasSiteLogin: false });
    const draft = r.desktopDrafts![0];
    expect(draft.writeCandidates).toEqual([2]);
    expect(draft.script.steps[1].write).toBeUndefined();
  });
});
