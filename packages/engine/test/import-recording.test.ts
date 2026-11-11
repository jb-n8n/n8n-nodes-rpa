import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stableDesktopId } from '../src/desktop/stable-ids.js';
import { importSource } from '../src/import/index.js';
import type { ImportItem, ImportOptions, ImportResult } from '../src/import/types.js';
import { parseDesktopScript } from '../src/steps/parse.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
const SAMPLES = fileURLToPath(new URL('./fixtures/desktop/stable-id-samples.json', import.meta.url));
const OPTS: ImportOptions = { name: 'erp', hasSiteLogin: false };

type Json = Record<string, any>;
/** A fresh copy of the ERP Demo recording, to change for one test. */
const recording = (): Json => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const importRec = (rec: Json | string, opts: ImportOptions = OPTS): ImportResult =>
  importSource('recording', typeof rec === 'string' ? rec : JSON.stringify(rec), opts);
const items = (r: ImportResult, kind: ImportItem['kind']) => r.report.items.filter((i) => i.kind === kind);

/** Nothing imported: one error item with this reason (`what`: the draft's name when the draft builder refused it), no draft of either kind and no flow. */
function expectRefused(r: ImportResult, reason: string, what = 'RPA recording') {
  expect(items(r, 'error')).toEqual([{ at: '', kind: 'error', what, reason }]);
  expect(r.drafts).toEqual([]);
  expect(r.desktopDrafts ?? []).toEqual([]);
  expect(r.flow).toBeUndefined();
}
const notValid = (...issues: string[]) => `the recording is not valid, so nothing was imported: ${issues.join('; ')}`;

describe('the ERP Demo recording', () => {
  it('the ERP Demo recording imports as 17 steps with candidate writes [4, 16], the variable password and the secret variable password', () => {
    const r = importRec(recording());
    expect(items(r, 'error')).toEqual([]);
    expect(r.report.source).toBe('recording');
    expect(r.drafts).toEqual([]);
    expect(r.desktopDrafts).toHaveLength(1);
    const d = r.desktopDrafts![0];
    expect(d).toMatchObject({ name: 'erp', writeCandidates: [4, 16], variables: ['password'], secretVariables: ['password'], startValues: {} });
    expect(r.report.steps).toBe(17);
    expect(d.script.app).toEqual({ exe: 'ErpDemo.exe' });
    expect(d.script.steps.map((s) => s.intent)).toEqual([
      'Wait for the window ERP Demo - Sign in',
      'Type into User name',
      'Type into Password',
      'Press Enter in Password',
      'Wait for the window ERP Demo - Line items',
      'Choose 2000 in Company code',
      'Type into Date from',
      'Type into Date to',
      'Click Search',
      'Click Vendor Row 1',
      'Click File',
      'Wait for the window erpdemo.exe',
      'Click Export...',
      'Wait for the window Export line items',
      'Type into File name:',
      'Click Save',
      'Return the exported file line-items.csv',
    ]);
    expect(d.script.steps[2]).toMatchObject({ fill: { value: '{{var.password}}' } });
    expect(d.script.steps[14]).toMatchObject({ fill: { value: '{{$exportDir}}\\line-items.csv' } });
    expect(d.script.steps[16]).toMatchObject({ expectFile: { pattern: '^line-items\\.csv$' } });
    expect(d.script.steps.some((s) => 'write' in s)).toBe(false);
    expect(items(r, 'candidateWrite').map((i) => i.what)).toEqual(['Step 4: Press Enter in Password', 'Step 16: Click Save']);
    // The workflow around it: one desktop node, named by the recording, whose draft keeps the Name the person typed.
    expect(r.flow).toEqual({ name: 'ERP Demo line items', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'ERP Demo line items', draft: 'erp' }] });
  });

  it('the draft parses as a desktop script and holds no index', () => {
    const d = importRec(recording()).desktopDrafts![0];
    expect(parseDesktopScript(d.script)).toEqual(d.script);
    expect(JSON.stringify(d.script)).not.toContain('"index"');
  });

  it('reads the recording as bytes, with or without a byte order mark', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    expect(importSource('recording', Buffer.from(text), OPTS).desktopDrafts).toHaveLength(1);
    expect(importSource('recording', Buffer.from(`\uFEFF${text}`), OPTS).desktopDrafts).toHaveLength(1);
  });

  it('a recording without a launch opens the app it names, with its arguments', () => {
    const rec = recording();
    rec.app = { exe: 'ErpDemo.exe', args: ['--ui', 'v1'] };
    rec.events.shift();
    const r = importRec(rec);
    expect(items(r, 'error')).toEqual([]);
    const d = r.desktopDrafts![0];
    expect(d.script.app).toEqual({ exe: 'ErpDemo.exe', args: ['--ui', 'v1'] });
    expect(d.script.steps[0].intent).toBe('Wait for the window ERP Demo - Sign in');
    expect(items(r, 'converted').map((i) => i.reason).join('\n')).not.toMatch(/UiPath|project/);
  });
});

describe('a recording that is refused', () => {
  it('refuses a recording larger than 5 MiB', () => {
    const rec = recording();
    rec.name = 'x'.repeat(5 * 1024 * 1024);
    expectRefused(importRec(rec), 'the recording is larger than 5 MiB, so it was not read');
    expectRefused(importSource('recording', Buffer.alloc(5 * 1024 * 1024 + 1, 32), OPTS), 'the recording is larger than 5 MiB, so it was not read');
  });

  it('refuses a file that is not JSON', () => {
    expectRefused(importRec('{"format": "rpa-recording/1", '), 'the file is not valid JSON: give the recording file the RPA recorder saved (.rpa-recording.json)');
  });

  it('refuses a format other than rpa-recording/1', () => {
    for (const format of ['rpa-recording/2', 'rpa-desktop-recording/spike-0', undefined]) {
      const rec = recording();
      rec.format = format;
      expectRefused(importRec(rec), 'the file is not an RPA recording: its format must be rpa-recording/1');
    }
    expectRefused(importRec('[]'), 'the file is not an RPA recording: its format must be rpa-recording/1');
  });

  it('refuses an unknown key anywhere', () => {
    const cases: [string, (rec: Json) => void][] = [
      ['recording has the unknown key "startedAt"', (rec) => { rec.startedAt = '2026-11-10T22:59:14Z'; }],
      ['app has the unknown key "path"', (rec) => { rec.app.path = 'C:\\Apps\\ErpDemo.exe'; }],
      ['events[1] has the unknown key "seq"', (rec) => { rec.events[1].seq = 0; }],
      ['events[4] has the unknown key "target"', (rec) => { rec.events[4].target = rec.events[5].target; }],
      ['events[0] has the unknown key "secret"', (rec) => { rec.events[0].secret = true; }],
      ['events[8] has the unknown key "secret"', (rec) => { rec.events[8].secret = true; }],
      ['events[1].target has the unknown key "fallbacks"', (rec) => { rec.events[1].target.fallbacks = []; }],
      ['events[1].target.window has the unknown key "pid"', (rec) => { rec.events[1].target.window.pid = '4242'; }],
      ['events[1].target.path[0] has the unknown key "value"', (rec) => { rec.events[1].target.path[0].value = 'clerk'; }],
      ['events[1] has the unknown key "__proto__"', (rec) => { Object.defineProperty(rec.events[1], '__proto__', { value: {}, enumerable: true }); }],
    ];
    for (const [issue, change] of cases) {
      const rec = recording();
      change(rec);
      expectRefused(importRec(rec), notValid(issue));
    }
    const rec = recording();
    rec.events[2].kind = 'type';
    expectRefused(importRec(rec), notValid('events[2].kind must be one of launch, scope, click, fill, select, check, key, read'));
  });

  it('refuses more than 400 events', () => {
    const rec = recording();
    while (rec.events.length <= 400) rec.events.push(structuredClone(rec.events[8]));
    expectRefused(importRec(rec), 'the recording has more than 400 events, so it was not read: record the work in shorter parts');
  });

  it('refuses an index in any condition', () => {
    const rec = recording();
    rec.events[9].target.path[0].index = 1;
    expectRefused(importRec(rec), notValid('events[9].target.path[0] has an index: a recording finds an element by its id or name, not by its position among its siblings'));
    const nested = recording();
    nested.events[9].target.path.unshift({ controlType: 'DataGrid', automationId: 'gridResults', index: 0 });
    expectRefused(importRec(nested), notValid('events[9].target.path[0] has an index: a recording finds an element by its id or name, not by its position among its siblings'));
  });

  it('refuses a {{$...}} template other than {{$exportDir}} in a fill value', () => {
    const cases: [string, (rec: Json) => void][] = [
      ['events[1].value', (rec) => { rec.events[1].value = '{{$env.HOME}}'; }],
      ['events[1].value', (rec) => { rec.events[1].value = '{{{ $json.password }}}'; }],
      ['events[8].label', (rec) => { rec.events[8].label = 'Search {{$exportDir}}'; }],
      ['events[5].option', (rec) => { rec.events[5].option = '{{$exportDir}}'; }],
      ['name', (rec) => { rec.name = 'ERP {{$now}}'; }],
    ];
    for (const [path, change] of cases) {
      const rec = recording();
      change(rec);
      expectRefused(importRec(rec), notValid(`${path} holds a {{$...}} template: only a fill's value may hold {{$exportDir}}`));
    }
  });

  it('refuses a secret-marked fill with a literal value', () => {
    for (const value of ['typed-literal', '{{var.password}}x', '{{var.a}}{{var.b}}', '']) {
      const rec = recording();
      rec.events[2].value = value;
      const r = importRec(rec);
      expectRefused(r, notValid('events[2] is marked secret, so its value must be one run variable such as {{var.password}}: a typed secret is not imported'));
    }
  });

  it('refuses a typed value in a field that looks like a password field and is not marked secret', () => {
    const typed = 'Typed-Into-Pwd-7';
    const reason = notValid('events[2] types into a field that looks like a password field (by its name, id or label), so its value must be a run variable marked secret, such as {{var.password}} with "secret": true');
    const cases: ((e: Json) => void)[] = [
      () => {}, // the ERP Demo password field: id txtPassword, name and label Password
      (e) => { e.target.path[0] = { controlType: 'Edit', automationId: 'txtField2', name: 'PIN' }; e.label = 'Field 2'; },
      (e) => { e.target.path[0] = { controlType: 'Edit', automationId: 'txtKennwort' }; e.label = ''; },
      (e) => { e.target.path[0] = { controlType: 'Edit', automationId: 'txtField2' }; e.label = 'Client secret'; },
    ];
    for (const change of cases) {
      const rec = recording();
      delete rec.events[2].secret;
      rec.events[2].value = typed;
      change(rec.events[2]);
      const r = importRec(rec);
      expectRefused(r, reason);
      expect(JSON.stringify(r)).not.toContain(typed);
    }
    // Marked secret with a variable, it imports; unmarked, a variable is not a typed value.
    expect(importRec(recording()).desktopDrafts).toHaveLength(1);
    const unmarked = recording();
    delete unmarked.events[2].secret;
    expect(importRec(unmarked).desktopDrafts).toHaveLength(1);
    // A field whose name, id and label say nothing of a password keeps its typed value.
    const other = recording();
    delete other.events[2].secret;
    other.events[2].value = typed;
    other.events[2].target.path[0] = { controlType: 'Edit', automationId: 'txtField2', name: 'Field 2' };
    other.events[2].label = 'Field 2';
    other.events[3].target.path[0] = other.events[2].target.path[0];
    other.events[3].label = 'Field 2';
    const r = importRec(other);
    expect(items(r, 'error')).toEqual([]);
    expect(r.desktopDrafts![0].script.steps[2]).toMatchObject({ fill: { value: typed } });
  });

  it('refuses a recording that names a value of the RPA Site Login', () => {
    const opts: ImportOptions = { name: 'erp', hasSiteLogin: true, secrets: { username: 'ab', password: 'S1te-Login-Pass' } };
    const long = recording();
    long.events[6].value = 'S1te-Login-Pass';
    const r = importRec(long, opts);
    expectRefused(r, 'the desktop draft still named a sign-in value, so it was not returned', 'erp');
    expect(r.report.steps).toBe(0);
    expect(JSON.stringify(r)).not.toContain('S1te-Login-Pass');
    // A short Site Login value counts as a whole typed value.
    const short = recording();
    short.events[5].option = 'AB';
    expectRefused(importRec(short, opts), 'the desktop draft still named a sign-in value, so it was not returned', 'erp');
    // Without one, the same values import.
    expect(importRec(short).desktopDrafts).toHaveLength(1);
  });

  it('refuses an app or a window named by a path, not by the program\'s file name', () => {
    const cases: [string, (rec: Json) => void][] = [
      ['app.exe', (rec) => { rec.app.exe = 'C:\\Users\\Public\\ErpDemo.exe'; }],
      ['app.exe', (rec) => { rec.app.exe = '..\\ErpDemo.exe'; }],
      ['app.exe', (rec) => { rec.app.exe = '\\\\server\\share\\ErpDemo.exe'; }],
      ['app.exe', (rec) => { rec.app.exe = 'ErpDemo.bat'; }],
      ['events[0].exe', (rec) => { rec.events[0].exe = 'C:/Tools/ErpDemo.exe'; }],
      ['events[1].target.window.exe', (rec) => { rec.events[1].target.window.exe = 'D:\\erpdemo.exe'; }],
      ['events[4].window.exe', (rec) => { rec.events[4].window.exe = 'erpdemo'; }],
    ];
    for (const [path, change] of cases) {
      const rec = recording();
      change(rec);
      const r = importRec(rec);
      expect(items(r, 'error').map((i) => i.reason).join('\n')).toContain(`${path} must be a program's file name, such as ErpDemo.exe, without a folder`);
      expect(r.desktopDrafts ?? []).toEqual([]);
    }
  });

  it('refuses a launch of another program than the recording\'s app', () => {
    const rec = recording();
    rec.events[0].exe = 'Other.exe';
    expectRefused(importRec(rec), notValid('events[0] must open the recording\'s app, with the same exe and args'));
    const args = recording();
    args.events[0].args = ['--ui', 'v2'];
    expectRefused(importRec(args), notValid('events[0] must open the recording\'s app, with the same exe and args'));
  });

  it('refuses a recording that gives more than 200 steps, with the step parser\'s reason', () => {
    const rec = recording();
    while (rec.events.length < 220) rec.events.push(structuredClone(rec.events[8]));
    expectRefused(importRec(rec), 'the desktop draft is not valid steps: steps has more than 200 steps', 'erp');
  });

  it('refuses a recording with nothing to turn into steps', () => {
    const rec = recording();
    rec.events = [rec.events[0], rec.events[4]];
    expectRefused(importRec(rec), 'Nothing in this file could be turned into steps.');
  });

  it('refuses values of the wrong type, and keeps a quoted key short', () => {
    const rec = recording();
    rec.events[7].checked = 'yes';
    rec.events[7].kind = 'check';
    delete rec.events[7].value;
    rec.events[3].chord = 13;
    rec.secretVariables = ['password', 'not a name'];
    expectRefused(importRec(rec), notValid(
      'events[3].chord must be a string',
      'events[7].checked must be true or false',
      'secretVariables must be a list of variable names (letters, digits and _)',
    ));
    const long = recording();
    long.events[1]['k'.repeat(200)] = 1;
    expect(items(importRec(long), 'error')[0].reason).toBe(notValid(`events[1] has the unknown key "${'k'.repeat(60)}…"`));
  });
});

describe('start values (variables): a variable starts with the value that was recorded, except a secret', () => {
  /** The recording with step 6 (Company code) and step 7 (Date from) made variables, as the recorder writes them. */
  const withVariables = (variables: Json = { in_CompanyCode: '2000', in_DateFrom: '2026-01-20' }): Json => {
    const rec = recording();
    const fill = rec.events.find((e: Json) => e.kind === 'fill' && e.label === 'Date from');
    const select = rec.events.find((e: Json) => e.kind === 'select');
    fill.value = '{{var.in_DateFrom}}';
    select.option = '{{var.in_CompanyCode}}';
    rec.variables = variables;
    return rec;
  };
  it('the draft carries each start value beside the variable its steps type', () => {
    const r = importRec(withVariables());
    expect(items(r, 'error')).toEqual([]);
    const d = r.desktopDrafts![0];
    expect(d.variables).toEqual(['password', 'in_CompanyCode', 'in_DateFrom']);
    expect(d.startValues).toEqual({ in_CompanyCode: '2000', in_DateFrom: '2026-01-20' });
    expect(d.script.steps[5]).toMatchObject({ select: { option: '{{var.in_CompanyCode}}' } });
    // The start value is not in the steps: they are signed with the variable.
    expect(JSON.stringify(d.script)).not.toContain('2026-01-20');
    // Without the key, no start values (a file from an older recorder).
    expect(importRec(recording()).desktopDrafts![0].startValues).toEqual({});
  });
  it('refuses a start value for a secret variable, for a variable no step types, and of the wrong type', () => {
    expectRefused(importRec(withVariables({ password: 'Long-password-1' })), notValid('variables.password is a secret variable: a secret never has a start value in the recording'));
    const secretFill = withVariables({});
    secretFill.secretVariables = [];
    expectRefused(importRec({ ...secretFill, variables: { password: 'x' } }), notValid('variables.password is a secret variable: a secret never has a start value in the recording'));
    expectRefused(importRec(withVariables({ in_Unused: 'a' })), notValid('variables.in_Unused names a variable no step types'));
    expectRefused(importRec(withVariables({ in_CompanyCode: 2000 })), notValid('variables.in_CompanyCode must be a single-line string of at most 500 characters'));
    expectRefused(importRec(withVariables({ 'not a name': 'a' })), notValid('variables has a name that is not a variable name (letters, digits and _): "not a name"'));
    expectRefused(importRec({ ...withVariables(), variables: ['2000'] }), notValid('variables must be an object of variable names and their start values'));
    // A secret never reaches the report through a start value either.
    expect(JSON.stringify(importRec(withVariables({ password: 'Long-password-1' })))).not.toContain('Long-password-1');
  });
  it('refuses a start value that holds a value of the RPA Site Login', () => {
    const opts: ImportOptions = { ...OPTS, hasSiteLogin: true, secrets: { username: 'clerk-login', password: 'Long-password-1' } };
    expectRefused(importRec(withVariables({ in_CompanyCode: 'clerk-login', in_DateFrom: 'x' }), opts), 'the desktop draft still named a sign-in value, so it was not returned', 'erp');
  });
});

describe('secrets, ids and positions', () => {
  it('a secret-marked fill never puts a typed value into the draft, the report or the flow', () => {
    const typed = 'Typed-Secret-Value-9';
    const rec = recording();
    rec.events[2].value = typed;
    const refused = importRec(rec);
    expect(refused.desktopDrafts ?? []).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(typed);
    // The recorder's own file: the fill types the variable, which is secret even when secretVariables forgot it.
    const ok = recording();
    ok.secretVariables = [];
    const r = importRec(ok);
    expect(r.desktopDrafts![0].secretVariables).toEqual(['password']);
  });

  it('an unstable automation id is dropped and reported', () => {
    const rec = recording();
    // A grid cell with a per-run id and a name: the id goes, the name finds it.
    rec.events[9].target.path = [{ controlType: 'DataGrid', automationId: '4237251161' }, { controlType: 'DataItem', automationId: '4266824994', name: 'Vendor Row 1' }];
    // A button with only a generated id: nothing is left to find it by.
    rec.events.splice(10, 0, { at: '2026-11-10T22:59:31.0000000+00:00', kind: 'click', label: 'Refresh', target: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' }, path: [{ controlType: 'Button', automationId: '3f2a9c1e-77b0-4c1d-9a55-0123456789ab' }] } });
    const r = importRec(rec);
    expect(items(r, 'error')).toEqual([]);
    const d = r.desktopDrafts![0];
    expect(d.script.steps[9]).toEqual({ intent: 'Click Vendor Row 1', click: { uia: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' }, path: [{ controlType: 'DataItem', name: 'Vendor Row 1' }] } } });
    expect(d.script.steps).toHaveLength(17);
    expect(JSON.stringify(d.script)).not.toMatch(/4237251161|4266824994|3f2a9c1e/);
    expect(items(r, 'converted')).toContainEqual({
      at: '2026-11-10T22:59:30.2291062+00:00', kind: 'converted', what: 'Vendor Row 1',
      reason: 'the automation id looks generated (it may change from run to run), so the step finds the element without it',
    });
    const dropped = items(r, 'dropped');
    expect(dropped).toEqual([{
      at: '2026-11-10T22:59:31.0000000+00:00', kind: 'dropped', what: 'Refresh',
      reason: 'the automation id looks generated (it may change from run to run) and nothing else names the element, so this step was left out: add it by hand',
    }]);
    // The person did this and the steps do not: the approval lists it as left out.
    expect(dropped[0].notNeeded).toBeUndefined();
  });

  it('a positional target is reported', () => {
    const r = importRec(recording());
    expect(items(r, 'converted')).toContainEqual({
      at: '2026-11-10T22:59:30.2291062+00:00', kind: 'converted', what: 'Vendor Row 1',
      reason: 'the step finds its element by a row position, not by what the row holds: on a later run it acts on whatever is in that row',
    });
    const rec = recording();
    rec.events[9].positional = 'yes';
    expectRefused(importRec(rec), notValid('events[9].positional must be true when it is there'));
  });

  it('a key the steps never send (a Windows shell chord) is left out with a report item, and the rest imports', () => {
    for (const chord of ['Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Escape', 'Ctrl+Shift+Escape', 'Alt+Escape']) {
      const rec = recording();
      rec.events[3].chord = chord;
      const r = importRec(rec);
      expect(items(r, 'error')).toEqual([]);
      expect(items(r, 'dropped')).toContainEqual({
        at: '2026-11-10T22:59:20.5266375+00:00', kind: 'dropped', what: 'Password',
        reason: `the step was left out: its key is ${chord}, which drives the Windows shell, not the app: desktop steps never send it`,
      });
      expect(r.report.steps).toBe(16);
      expect(r.desktopDrafts![0].script.steps.some((s) => 'key' in s)).toBe(false);
    }
    const rec = recording();
    rec.events[3].chord = 'ctrl+s';
    expect(items(importRec(rec), 'dropped').map((i) => i.reason)).toContain(
      'the step was left out: its key must be a key chord such as Enter, Tab, Ctrl+S or F5 (modifiers in the order Ctrl, Alt, Shift; letters uppercase)');
  });

  it('a choice of an empty item is left out with a report item, and the rest imports', () => {
    const rec = recording();
    rec.events[5].option = '';
    const r = importRec(rec);
    expect(items(r, 'error')).toEqual([]);
    expect(items(r, 'dropped')).toContainEqual({
      at: '2026-11-10T22:59:22.9162750+00:00', kind: 'dropped', what: 'Company code',
      reason: 'the step was left out: it chooses an empty item, which desktop steps cannot choose',
    });
    expect(r.report.steps).toBe(16);
  });

  it('stableDesktopId agrees with every sample in stable-id-samples.json', () => {
    const samples = JSON.parse(readFileSync(SAMPLES, 'utf8')) as { id: string; stable: boolean }[];
    expect(samples.length).toBeGreaterThanOrEqual(20);
    for (const s of samples) expect(stableDesktopId(s.id), JSON.stringify(s.id)).toBe(s.stable);
  });
});
