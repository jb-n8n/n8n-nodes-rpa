// A desktop recording as an import source. The RPA recorder watches a person work in a Windows application and saves
// what they did as a recording file (`<name>.rpa-recording.json`). The file is read as data and checked strictly, and
// its events go to the desktop draft builder the UiPath desktop import uses (buildDesktopDraft). Nothing in it is
// evaluated, and no step is marked a write: the approver declares writes.
//
// The file format, rpa-recording/1: UTF-8 JSON of at most 5 MiB (a byte order mark is ignored). Key order does not
// matter. A key that is not listed here, at any level, refuses the file, and so does a value of another type.
//
//   {
//     "format": "rpa-recording/1",
//     "name": "<the step set's name the person typed: one line, 1 to 200 characters>",
//     "app": { "exe": "<the program's file name, such as ErpDemo.exe>", "args": ["<argument>", ...] },  (args optional)
//     "events": [<event>, ...],                  (at most 400)
//     "secretVariables": ["<variable>", ...],    (the variables whose fills were typed into secret fields)
//     "variables": { "<variable>": "<start value>", ... }   (optional: the value recorded where the person made a
//                                                 variable, one line of at most 500 characters; never for a secret)
//   }
//
// Every event has "at" (when it happened, as text: one line, 1 to 64 characters), "kind", and "label" (the name the
// person saw on the element or window, at most 500 characters, possibly empty). By kind, it also has:
//
//   launch   "exe" (app.exe), "args" (optional, app.args), "window" (optional): the app started and showed this window
//   scope    "window" (optional): another window came up; the next step first waits for it
//   click    "target", "double" (optional: a double click)
//   fill     "target", "value", "exportFile" (optional), "secret" (optional)
//   select   "target", "option"
//   check    "target", "checked" (true or false)
//   key      "target" (optional), "chord" (the canonical spelling, modifiers in the order Ctrl, Alt, Shift: "Ctrl+S")
//   read     "target", "as"
//
// and an event with "target" may have "positional": true. "secret", "double" and "positional" are only ever true.
//
//   target     { "window": <window> (optional), "path": [<condition>, ...] }   (1 to 20 conditions, outermost first)
//   window     { "exe", "title", "titlePattern", "automationId", "className" }  (each optional, one line, 1 to 500
//              characters; "exe" is a program's file name)
//   condition  { "controlType", "automationId", "name", "className" }           (each optional, as a window's; an
//              "index" refuses the file)
//
// A fill with "secret": true was typed into a secret field: its value is exactly one run variable, "{{var.name}}",
// never what was typed. A fill not marked secret whose field's name, automation id or label looks like a password
// field (CREDENTIAL_FIELD: password words, PIN, secret) refuses the file unless its value is exactly one
// "{{var.name}}". A fill into a Save dialog's file name has the value "{{$exportDir}}\<file>" and "exportFile":
// "<file>"; no other "{{$...}}" template may appear anywhere. "positional": true marks a target found by a name that
// carries a position (a grid cell, "Vendor Row 1").
//
// A key event whose chord the step format refuses (a Windows shell chord such as Alt+Tab, or a chord not in the
// canonical spelling) and a select of an empty item are left out, each with a `dropped` report item; the rest imports.
//
// A start value is for a variable a step types or chooses ("{{var.name}}" in a fill's value or a select's option) and
// never for a secret one (in secretVariables, or typed by a fill marked secret): such a file is refused. The draft
// carries the start values beside its steps (DesktopDraft.startValues), never in them: the steps are signed with the
// variable, and the generated workflow starts each variable with its value.
//
// On import, an automation id that stableDesktopId finds generated is dropped from its condition (an outer condition
// left with only a control type goes from the path), and an event whose own condition is left with nothing but a
// control type is left out. The draft is named the import's Name (one recording, one step list), with the flow's one
// desktop node.
import { stableDesktopId } from '../desktop/stable-ids.js';
import { IMPORT_EMPTY } from '../messages.js';
import { CREDENTIAL_FIELD } from '../secrets/credential-field.js';
import { createMasker } from '../secrets/mask.js';
import { stepChordProblem } from '../steps/desktop-vocabulary.js';
import type { DesktopApp, UiaCond, UiaTarget } from '../types.js';
import { cleanLabel, MIN_SECRET_LENGTH } from './draft.js';
import { isObject, MAX_IMPORT_JSON_BYTES, readJson, type Json } from './read.js';
import type { ImportItem, ImportOptions, ImportReport, ImportResult, UiPathFlow } from './types.js';
import { buildDesktopDraft, DRAFT_NAMES_SIGN_IN_VALUE, signInValueCheck, type DesktopEvent } from './uipath-desktop.js';

export const RECORDING_FORMAT = 'rpa-recording/1';
/** One recorded event: a desktop event, `secret` on a fill typed into a secret field, `positional` on a target found by its position. */
export type RecordedEvent = DesktopEvent & { secret?: true; positional?: true };
/** A recording file, as the RPA recorder saves it (the format above). */
export interface RecordingFile {
  format: typeof RECORDING_FORMAT; name: string; app: DesktopApp; events: RecordedEvent[]; secretVariables: string[]; variables?: Record<string, string>;
}

/** A recording larger than this is refused before it is parsed, as a Chrome recording is. */
const MAX_RECORDING_BYTES = MAX_IMPORT_JSON_BYTES;
/** A recording with more events than this is refused (the draft keeps the step parser's own limit on steps). */
const MAX_RECORDING_EVENTS = 400;
/** The longest text of a window or a condition, as the step parser allows. */
const MAX_UIA_TEXT = 500;

const WHAT = 'RPA recording';
const TOO_LARGE = 'the recording is larger than 5 MiB, so it was not read';
const NOT_TEXT = 'the recording must be text or a file';
const NOT_JSON = 'the file is not valid JSON: give the recording file the RPA recorder saved (.rpa-recording.json)';
const NOT_A_RECORDING = `the file is not an RPA recording: its format must be ${RECORDING_FORMAT}`;
const TOO_MANY_EVENTS = 'the recording has more than 400 events, so it was not read: record the work in shorter parts';
const NOT_VALID = (issues: string[]) => `the recording is not valid, so nothing was imported: ${issues.slice(0, 5).join('; ')}`;
const UNKNOWN_KEY = (path: string, key: string) => `${path} has the unknown key ${JSON.stringify(key.length > 60 ? `${key.slice(0, 60)}…` : key)}`;
const HAS_INDEX = (path: string) => `${path} has an index: a recording finds an element by its id or name, not by its position among its siblings`;
const RESERVED_TEMPLATE = (path: string) => `${path} holds a {{$...}} template: only a fill's value may hold {{$exportDir}}`;
const SECRET_NOT_VARIABLE = (path: string) => `${path} is marked secret, so its value must be one run variable such as {{var.password}}: a typed secret is not imported`;
const PASSWORD_LITERAL = (path: string) =>
  `${path} types into a field that looks like a password field (by its name, id or label), so its value must be a run variable marked secret, such as {{var.password}} with "secret": true`;
const NOT_EXE_NAME = (path: string) => `${path} must be a program's file name, such as ErpDemo.exe, without a folder`;
const OTHER_APP = (path: string) => `${path} must open the recording's app, with the same exe and args`;
const UNSTABLE_ID = 'the automation id looks generated (it may change from run to run), so the step finds the element without it';
const NOTHING_LEFT = 'the automation id looks generated (it may change from run to run) and nothing else names the element, so this step was left out: add it by hand';
const KEY_LEFT_OUT = (problem: string) => `the step was left out: its key ${problem}`;
const EMPTY_OPTION = 'the step was left out: it chooses an empty item, which desktop steps cannot choose';
const POSITIONAL = 'the step finds its element by a row position, not by what the row holds: on a later run it acts on whatever is in that row';
const VARIABLES_NOT_OBJECT = 'variables must be an object of variable names and their start values';
const BAD_VARIABLE_NAME = (name: string) => `variables has a name that is not a variable name (letters, digits and _): ${JSON.stringify(name.length > 60 ? `${name.slice(0, 60)}…` : name)}`;
const SECRET_START_VALUE = (name: string) => `variables.${name} is a secret variable: a secret never has a start value in the recording`;
const UNUSED_START_VALUE = (name: string) => `variables.${name} names a variable no step types`;
/** A start value: one line, as a recorded value is. */
const MAX_START_VALUE = 500;
/** Every {{var.name}} in a text. */
const VARIABLES_IN = /\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g;

/** Keys beside at, kind and label, by kind. A Map, so a kind such as `constructor` or `__proto__` is never mistaken for one. */
const EVENT_KEYS = new Map<string, readonly string[]>([
  ['launch', ['exe', 'args', 'window']],
  ['scope', ['window']],
  ['click', ['target', 'double', 'positional']],
  ['fill', ['target', 'value', 'exportFile', 'secret', 'positional']],
  ['select', ['target', 'option', 'positional']],
  ['check', ['target', 'checked', 'positional']],
  ['key', ['target', 'chord', 'positional']],
  ['read', ['target', 'as', 'positional']],
]);
const WINDOW_KEYS = ['exe', 'title', 'titlePattern', 'automationId', 'className'];
const COND_KEYS = ['controlType', 'automationId', 'name', 'className'];
/** A program's file name: no folder, drive, wildcard or control character, ending in .exe. */
const EXE_NAME = /^(?![ .])[^\\/:*?"<>|\p{Cc}]{0,251}\.exe$/iu;
/** A file name without a folder (a Save dialog's file). */
const FILE_NAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\p{Cc}]{1,255}$/u;
/** A secret fill's whole value: one run variable. */
const ONE_VARIABLE = /^\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}$/;
const VARIABLE_NAME = /^[A-Za-z0-9_]+$/;
/** A `{{$name}}` template, also behind extra braces or spaces, as the step parser finds it. */
const RESERVED = /\{\{[\s{]*(\$[^}]*?)\s*\}\}/g;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n]/.test(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** What names a fill's field: its label, and the name and automation id of the field's own (last) condition. */
function fieldTexts(e: Json): string[] {
  const path = isObject(e.target) && Array.isArray(e.target.path) ? e.target.path : [];
  const own: unknown = path[path.length - 1];
  return [e.label, ...(isObject(own) ? [own.name, own.automationId] : [])].filter((t): t is string => typeof t === 'string');
}

/** Every problem of a parsed recording (format and event count already checked), in file order; none when it is valid. */
function recordingIssues(rec: Json): string[] {
  const issues: string[] = [];
  const onlyKeys = (v: Json, allowed: readonly string[], path: string) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) issues.push(UNKNOWN_KEY(path, k));
  };
  const text = (v: Json, key: string, path: string, max: number) => {
    if (!isText(v[key], max)) issues.push(`${path}.${key} must be a non-empty single-line string of at most ${max} characters`);
  };
  const string = (v: Json, key: string, path: string) => {
    if (typeof v[key] !== 'string') issues.push(`${path}.${key} must be a string`);
  };
  const exe = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !EXE_NAME.test(v)) issues.push(NOT_EXE_NAME(path));
  };
  const window = (w: unknown, path: string) => {
    if (!isObject(w)) { issues.push(`${path} must be an object`); return; }
    onlyKeys(w, WINDOW_KEYS, path);
    for (const k of WINDOW_KEYS) if (w[k] !== undefined) text(w, k, path, MAX_UIA_TEXT);
    if (w.exe !== undefined) exe(w.exe, `${path}.exe`);
  };
  const target = (t: unknown, path: string) => {
    if (!isObject(t)) { issues.push(`${path} must be an object`); return; }
    onlyKeys(t, ['window', 'path'], path);
    if (t.window !== undefined) window(t.window, `${path}.window`);
    if (!Array.isArray(t.path) || t.path.length === 0 || t.path.length > 20) { issues.push(`${path}.path must be a list of 1 to 20 conditions`); return; }
    t.path.forEach((c, i) => {
      const at = `${path}.path[${i}]`;
      if (!isObject(c)) { issues.push(`${at} must be an object`); return; }
      if (Object.hasOwn(c, 'index')) issues.push(HAS_INDEX(at));
      onlyKeys(c, [...COND_KEYS, 'index'], at);
      for (const k of COND_KEYS) if (c[k] !== undefined) text(c, k, at, MAX_UIA_TEXT);
    });
  };

  onlyKeys(rec, ['format', 'name', 'app', 'events', 'secretVariables', 'variables'], 'recording');
  if (!isText(rec.name, 200)) issues.push('name must be a non-empty single-line string of at most 200 characters');
  const app = rec.app;
  if (!isObject(app)) issues.push('app must be an object with exe');
  else {
    onlyKeys(app, ['exe', 'args'], 'app');
    exe(app.exe, 'app.exe');
    if (app.args !== undefined && !isStringList(app.args)) issues.push('app.args must be a list of strings');
  }
  const events = rec.events as unknown[];
  events.forEach((e, i) => {
    const at = `events[${i}]`;
    if (!isObject(e)) { issues.push(`${at} must be an object`); return; }
    const keys = typeof e.kind === 'string' ? EVENT_KEYS.get(e.kind) : undefined;
    if (!keys) { issues.push(`${at}.kind must be one of ${[...EVENT_KEYS.keys()].join(', ')}`); return; }
    onlyKeys(e, ['at', 'kind', 'label', ...keys], at);
    text(e, 'at', at, 64);
    if (typeof e.label !== 'string' || e.label.length > MAX_UIA_TEXT) issues.push(`${at}.label must be a string of at most ${MAX_UIA_TEXT} characters`);
    if (keys.includes('target') && (e.kind !== 'key' || e.target !== undefined)) target(e.target, `${at}.target`);
    if (keys.includes('window') && e.window !== undefined) window(e.window, `${at}.window`);
    if (e.positional !== undefined && e.positional !== true) issues.push(`${at}.positional must be true when it is there`);
    if (e.double !== undefined && e.double !== true) issues.push(`${at}.double must be true when it is there`);
    switch (e.kind) {
      case 'launch': {
        exe(e.exe, `${at}.exe`);
        if (e.args !== undefined && !isStringList(e.args)) issues.push(`${at}.args must be a list of strings`);
        const appArgs = isObject(app) && isStringList(app.args) ? app.args : [];
        const args = isStringList(e.args) ? e.args : [];
        const sameApp = isObject(app) && typeof app.exe === 'string' && typeof e.exe === 'string' && app.exe.toLowerCase() === e.exe.toLowerCase();
        if (!sameApp || args.length !== appArgs.length || args.some((a, n) => a !== appArgs[n])) issues.push(OTHER_APP(at));
        break;
      }
      case 'fill':
        string(e, 'value', at);
        if (e.exportFile !== undefined && (typeof e.exportFile !== 'string' || !FILE_NAME.test(e.exportFile))) issues.push(`${at}.exportFile must be a file name without a folder`);
        if (e.secret !== undefined && (e.secret !== true || typeof e.value !== 'string' || !ONE_VARIABLE.test(e.value))) issues.push(SECRET_NOT_VARIABLE(at));
        // The recorder never reads a field it takes for secret: a typed value in one was changed by hand or is a recorder fault.
        else if (e.secret === undefined && typeof e.value === 'string' && !ONE_VARIABLE.test(e.value) && fieldTexts(e).some((t) => CREDENTIAL_FIELD.test(t))) {
          issues.push(PASSWORD_LITERAL(at));
        }
        break;
      case 'select': string(e, 'option', at); break;
      case 'check': if (typeof e.checked !== 'boolean') issues.push(`${at}.checked must be true or false`); break;
      case 'key': string(e, 'chord', at); break;
      case 'read': string(e, 'as', at); break;
    }
  });
  if (!(isStringList(rec.secretVariables) && rec.secretVariables.every((v) => VARIABLE_NAME.test(v)))) {
    issues.push('secretVariables must be a list of variable names (letters, digits and _)');
  }
  startValueIssues(rec, events, issues);
  // {{$exportDir}} only as a fill's value, as the step parser allows it; no other {{$...}} anywhere.
  const templates = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      const fillValue = /^events\[(\d+)\]\.value$/.exec(path);
      for (const m of v.matchAll(RESERVED)) {
        if (m[1] !== '$exportDir' || !fillValue || (events[Number(fillValue[1])] as Json).kind !== 'fill') { issues.push(RESERVED_TEMPLATE(path)); return; }
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => templates(x, `${path}[${i}]`));
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) templates(x, path ? `${path}.${k}` : k);
  };
  templates(rec, '');
  return issues;
}

/**
 * The start values' problems: the key is optional; each name is a variable a fill's value or a select's option types,
 * never a secret one (listed in secretVariables, or typed by a fill marked secret), and each value one line.
 */
function startValueIssues(rec: Json, events: unknown[], issues: string[]): void {
  if (rec.variables === undefined) return;
  if (!isObject(rec.variables)) { issues.push(VARIABLES_NOT_OBJECT); return; }
  const used = new Set<string>();
  const secret = new Set(isStringList(rec.secretVariables) ? rec.secretVariables : []);
  for (const e of events) {
    if (!isObject(e)) continue;
    const text = e.kind === 'fill' ? e.value : e.kind === 'select' ? e.option : undefined;
    if (typeof text !== 'string') continue;
    for (const m of text.matchAll(VARIABLES_IN)) {
      used.add(m[1]);
      if (e.kind === 'fill' && e.secret === true) secret.add(m[1]);
    }
  }
  for (const [name, value] of Object.entries(rec.variables)) {
    if (!VARIABLE_NAME.test(name)) issues.push(BAD_VARIABLE_NAME(name));
    else if (secret.has(name)) issues.push(SECRET_START_VALUE(name));
    else if (!used.has(name)) issues.push(UNUSED_START_VALUE(name));
    else if (!isText(value, MAX_START_VALUE)) issues.push(`variables.${name} must be a single-line string of at most ${MAX_START_VALUE} characters`);
  }
}

/**
 * The target without the automation ids stableDesktopId finds generated. An outer condition left with only a control
 * type goes from the path; undefined when the element's own condition is left with nothing but a control type.
 */
function stableTarget(t: UiaTarget): { target: UiaTarget; changed: boolean } | undefined {
  let changed = false;
  const path: UiaCond[] = [];
  t.path.forEach((c, i) => {
    if (c.automationId === undefined || stableDesktopId(c.automationId)) { path.push(c); return; }
    changed = true;
    const { automationId: _generated, ...rest } = c;
    if (i === t.path.length - 1 || rest.name !== undefined || rest.className !== undefined) path.push(rest);
  });
  const own = path[path.length - 1];
  if (changed && own.automationId === undefined && own.name === undefined && own.className === undefined) return undefined;
  return { target: { ...(t.window ? { window: t.window } : {}), path }, changed };
}

/**
 * Imports a recording file (`data`: its bytes or its text) as one desktop draft named opts.name, with a flow of one
 * desktop node for the workflow around it. A file that is not a valid recording, a fill marked secret that carries a
 * typed value, and a draft that names a value of the RPA Site Login are each an `error` item and no draft.
 */
export function importRecording(data: Buffer | Uint8Array | string, opts: ImportOptions): ImportResult {
  const report: ImportReport = { source: 'recording', steps: 0, items: [] };
  const add = (at: string, kind: ImportItem['kind'], what: string, reason: string) => report.items.push({ at, kind, what, reason });
  const fail = (reason: string): ImportResult => {
    add('', 'error', WHAT, reason);
    return { drafts: [], report };
  };
  const read = readJson(data, MAX_RECORDING_BYTES);
  if ('problem' in read) return fail({ tooLarge: TOO_LARGE, notText: NOT_TEXT, notJson: NOT_JSON }[read.problem]);
  const raw = read.value;
  if (!isObject(raw) || raw.format !== RECORDING_FORMAT) return fail(NOT_A_RECORDING);
  if (!Array.isArray(raw.events)) return fail(NOT_VALID(['events must be a list of events']));
  if (raw.events.length > MAX_RECORDING_EVENTS) return fail(TOO_MANY_EVENTS);
  const issues = recordingIssues(raw);
  if (issues.length) return fail(NOT_VALID(issues));
  const file = raw as unknown as RecordingFile;

  const secretVariables = new Set(file.secretVariables);
  const events: DesktopEvent[] = [];
  for (const recorded of file.events) {
    const { secret, positional, ...event } = recorded;
    const what = cleanLabel(event.label) || 'the element';
    if (secret && event.kind === 'fill') secretVariables.add(ONE_VARIABLE.exec(event.value)![1]);
    // What the step parser would refuse in one event leaves that event out, not the whole recording.
    const chordProblem = event.kind === 'key' ? stepChordProblem(event.chord) : undefined;
    if (chordProblem) { add(event.at, 'dropped', what, KEY_LEFT_OUT(chordProblem)); continue; }
    if (event.kind === 'select' && event.option === '') { add(event.at, 'dropped', what, EMPTY_OPTION); continue; }
    if ('target' in event && event.target) {
      const stable = stableTarget(event.target);
      if (!stable) { add(event.at, 'dropped', what, NOTHING_LEFT); continue; }
      if (stable.changed) add(event.at, 'converted', what, UNSTABLE_ID);
      event.target = stable.target;
    }
    if (positional) add(event.at, 'converted', what, POSITIONAL);
    events.push(event as DesktopEvent);
  }
  if (!events.some((e) => e.kind !== 'launch' && e.kind !== 'scope')) return fail(IMPORT_EMPTY);
  // The steps open the recording's app: a recording of a window that was already open gets its launch here.
  if (!events.some((e) => e.kind === 'launch')) {
    events.unshift({ at: '', kind: 'launch', exe: file.app.exe, ...(file.app.args?.length ? { args: [...file.app.args] } : {}), label: file.app.exe });
  }

  // One recording gives one step list: it keeps the Name the person typed.
  const name = opts.name;
  const displayName = cleanLabel(file.name) || cleanLabel(opts.name);
  const draft = buildDesktopDraft({ number: 1, name, displayName, events, secretVariables: [...secretVariables] }, report, { parserLimits: true });
  // Defence in depth: nothing returned names a value of the RPA Site Login.
  const sl = opts.hasSiteLogin ? [opts.secrets?.username, opts.secrets?.password, opts.secrets?.totpSecret] : [];
  const masker = createMasker(sl.filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH));
  const masked = (r: ImportResult): ImportResult => {
    for (const item of r.report.items) { item.at = masker.mask(item.at); item.what = masker.mask(item.what); item.reason = masker.mask(item.reason); }
    return r;
  };
  if (!draft) return masked({ drafts: [], report });
  const startValues = { ...(file.variables ?? {}) };
  // A start value goes into the generated workflow: one that holds a value of the RPA Site Login is refused like the draft.
  if (signInValueCheck(opts, [])(draft) || Object.values(startValues).some((v) => masker.containsSecret(v))) {
    report.steps -= draft.script.steps.length;
    add('', 'error', name, DRAFT_NAMES_SIGN_IN_VALUE);
    return masked({ drafts: [], report });
  }
  const flowName = masker.mask(displayName);
  const flow: UiPathFlow = { name: flowName, nodes: [{ kind: 'desktop', sequence: 1, displayName: flowName, draft: name }] };
  return masked({ drafts: [], desktopDrafts: [{ ...draft, startValues }], report, flow });
}
