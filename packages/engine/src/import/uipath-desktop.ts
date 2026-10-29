// UiPath desktop sequences become desktop step sets. The walker (uipath.ts) turns each desktop activity inside an Open
// Application, Attach Window or Use Application scope (or with a full `<wnd>` selector) into a DesktopEvent with a UI
// Automation target and a value it already resolved; buildDesktopDraft turns one sequence of them into a desktop step
// document (version 1, unsigned, accepted by parseDesktopScript) and report items. No value is evaluated; no password is
// ever imported (a secure or credential-like value is always a run variable), and no step is marked a write: the owner
// declares writes when approving, and the report lists the candidates.
import { desktopWriteCandidates } from '../proposal/desktop.js';
import { parseDesktopScript, ScriptShapeError } from '../steps/parse.js';
import type { DesktopLocator, DesktopScript, DesktopStep, UiaCond, UiaTarget, WindowSel } from '../types.js';
import { cleanLabel } from './draft.js';
import type { DesktopDraft, ImportItem, ImportReport } from './types.js';

/** One desktop activity, as the walker resolved it. `at` says where in the project it came from, for the report. */
export type DesktopEvent =
  /** Open Application (or a Use Application that opens its app): the app the step set launches. */
  | { at: string; kind: 'launch'; exe: string; args?: string[]; window?: WindowSel; label: string }
  /** A window scope begins (Attach Window, Use Application): the next step first waits for its window. */
  | { at: string; kind: 'scope'; window?: WindowSel; label: string }
  | { at: string; kind: 'click'; target: UiaTarget; label: string }
  /** `exportFile`: the value is a save path rewritten to the run's export folder; an expectFile step follows the next click. */
  | { at: string; kind: 'fill'; target: UiaTarget; label: string; value: string; exportFile?: string }
  | { at: string; kind: 'select'; target: UiaTarget; label: string; option: string }
  | { at: string; kind: 'check'; target: UiaTarget; label: string; checked: boolean }
  | { at: string; kind: 'key'; target?: UiaTarget; label: string; chord: string }
  | { at: string; kind: 'read'; target: UiaTarget; label: string; as: string };

/** A run of desktop events: one desktop draft, named `<name>-<number>` like a browser sequence. */
export interface DesktopSequence {
  number: number;
  name: string;
  displayName: string;
  events: DesktopEvent[];
  /** Variables the steps type that hold a password or another secret (they come from a credential or a secure value). */
  secretVariables: string[];
}

/** A step keeps its primary target and at most this many fallbacks (the step format allows five). */
const MAX_FALLBACKS = 2;
const READ_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TEMPLATE_VAR = /\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g;

/** What a target names, for an intent: the last condition's name, else its automation id. */
function targetName(t: UiaTarget | undefined): string {
  const last = t?.path[t.path.length - 1];
  return cleanLabel(last?.name ?? last?.automationId ?? '');
}
/** A label for an intent: quoted when it has a bracket or a double quote, so it cannot fake the change list's action group. */
function shown(label: string): string {
  return /[()"]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}
function windowName(w: WindowSel | undefined): string {
  return cleanLabel(w?.title ?? w?.titlePattern ?? w?.exe ?? '');
}

/**
 * The locator for a target: the target itself, then a fallback that keeps only the last condition's automation id and
 * control type when the target named more (a name or class that changes with the language or the build).
 */
export function desktopLocator(target: UiaTarget): DesktopLocator {
  const last = target.path[target.path.length - 1];
  const fallbacks: { uia: UiaTarget }[] = [];
  if (last.automationId !== undefined && (last.name !== undefined || last.className !== undefined)) {
    const cond: UiaCond = { ...(last.controlType !== undefined ? { controlType: last.controlType } : {}), automationId: last.automationId };
    fallbacks.push({ uia: { ...(target.window ? { window: { ...target.window } } : {}), path: [...target.path.slice(0, -1).map((c) => ({ ...c })), cond] } });
  }
  const primary = { uia: { ...(target.window ? { window: { ...target.window } } : {}), path: target.path.map((c) => ({ ...c })) } };
  const kept = fallbacks.slice(0, MAX_FALLBACKS);
  return kept.length ? { ...primary, fallbacks: kept } : primary;
}

/** The exported file's name as an anchored pattern (expectFile.pattern). */
export const filePattern = (file: string): string => `^${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`;

const sameExe = (a: string | undefined, b: string): boolean => {
  if (a === undefined) return true;
  const base = (s: string) => (s.split(/[\\/]/).pop() ?? s).toLowerCase();
  return base(a) === base(b);
};

/**
 * One desktop sequence as a desktop draft named `seq.name`. The app comes from the sequence's first launch, else from
 * its first target's window; a target in another app's window is reported and left out (a run drives the app it
 * launched). A scope's window becomes a waitFor on the first element the next step finds there. A save path typed
 * into a Save dialog becomes `{{$exportDir}}\<file>` (the walker rewrote it) and an expectFile step after the next
 * click. Read names are made unique. Every candidate write (desktopWriteCandidates) gets a report item; none is
 * declared. Returns undefined (with an error item) when no valid step document could be built.
 */
export function buildDesktopDraft(seq: DesktopSequence, report: ImportReport): DesktopDraft | undefined {
  const add = (at: string, kind: ImportItem['kind'], what: string, reason: string) => report.items.push({ at, kind, what, reason });
  const launch = seq.events.find((e): e is Extract<DesktopEvent, { kind: 'launch' }> => e.kind === 'launch');
  const firstWindowExe = seq.events.map((e) => ('target' in e ? e.target?.window?.exe : 'window' in e ? e.window?.exe : undefined)).find((x) => x !== undefined);
  const exe = launch?.exe ?? firstWindowExe;
  if (!exe) {
    add('', 'error', seq.name, 'the desktop activities do not say which application to open (no Open Application and no window selector with app=): add an Open Application to the UiPath project, or write the steps by hand');
    return undefined;
  }
  if (!launch) {
    add(seq.events[0]?.at ?? '', 'converted', `Open ${exe}`, `the project attaches to ${exe} without opening it: the desktop steps open it first (app.exe), as the runner only drives apps a run launched`);
  }

  const steps: DesktopStep[] = [];
  const atOf: string[] = [];
  const push = (step: DesktopStep, at: string) => { steps.push(step); atOf.push(at); };
  let pendingWindow: { window?: WindowSel; label: string; at: string } | undefined;
  let pendingFile: { file: string; at: string } | undefined;
  const reads = new Set<string>();
  const flushFile = () => {
    if (!pendingFile) return;
    push({ intent: `Return the exported file ${shown(cleanLabel(pendingFile.file))}`, expectFile: { pattern: filePattern(pendingFile.file) } }, pendingFile.at);
    add(pendingFile.at, 'converted', `Return ${cleanLabel(pendingFile.file)}`, 'the file the app saves into the run\'s export folder comes back to n8n as the step\'s file (expectFile), matched by its name');
    pendingFile = undefined;
  };

  for (const e of seq.events) {
    if (e.kind === 'launch' || e.kind === 'scope') {
      if (e.kind === 'launch' && !sameExe(e.exe, exe)) {
        add(e.at, 'untranslated', e.label || `Open ${e.exe}`, `a second application (${e.exe}) in one desktop sequence: a run drives only the app it launches (${exe}), so its steps were left out`);
        pendingWindow = undefined;
        continue;
      }
      pendingWindow = { window: e.window, label: e.label, at: e.at };
      continue;
    }
    const target = 'target' in e ? e.target : undefined;
    if (target?.window?.exe !== undefined && !sameExe(target.window.exe, exe)) {
      add(e.at, 'untranslated', e.label || targetName(target), `the element is in a window of ${target.window.exe}, another application than the one the steps open (${exe}): a run drives only the app it launches`);
      continue;
    }
    if (pendingWindow && target) {
      const window = pendingWindow.window ?? target.window;
      const shownWindow = windowName(window);
      if (window) {
        push({ intent: `Wait for the window ${shown(shownWindow || 'of the app')}`, waitFor: { target: { uia: { window: { ...window }, path: target.path.map((c) => ({ ...c })) } } } }, pendingWindow.at);
      }
      pendingWindow = undefined;
    }
    const name = shown(cleanLabel(e.label) || targetName(target) || 'the element');
    switch (e.kind) {
      case 'click':
        push({ intent: `Click ${name}`, click: desktopLocator(e.target) }, e.at);
        flushFile();
        break;
      case 'fill':
        push({ intent: `Type into ${name}`, fill: { field: desktopLocator(e.target), value: e.value } }, e.at);
        if (e.exportFile !== undefined) {
          flushFile();
          pendingFile = { file: e.exportFile, at: e.at };
        }
        break;
      case 'select':
        push({ intent: `Choose ${shown(cleanLabel(e.option))} in ${name}`, select: { field: desktopLocator(e.target), option: e.option } }, e.at);
        break;
      case 'check':
        push({ intent: `${e.checked ? 'Check' : 'Uncheck'} ${name}`, check: { field: desktopLocator(e.target), checked: e.checked } }, e.at);
        break;
      case 'key': {
        const where = e.target ? ` in ${shown(cleanLabel(e.label) || targetName(e.target) || 'the element')}` : '';
        push({ intent: `Press ${e.chord}${where}`, key: { key: e.chord, ...(e.target ? { target: desktopLocator(e.target) } : {}) } }, e.at);
        // Enter in a Save dialog saves, as a click on Save does.
        if (e.chord === 'Enter') flushFile();
        break;
      }
      case 'read': {
        let as = READ_NAME.test(e.as) ? e.as : 'text';
        for (let n = 2; reads.has(as); n++) as = `${READ_NAME.test(e.as) ? e.as.slice(0, 60) : 'text'}_${n}`;
        if (as !== e.as) add(e.at, 'converted', `Read ${name}`, `the value is returned as ${as}${READ_NAME.test(e.as) ? `: ${e.as} is already used by an earlier read` : ': UiPath stores it in no plain variable'}`);
        reads.add(as);
        push({ intent: `Read ${name} as ${as}`, read: { target: desktopLocator(e.target), as } }, e.at);
        break;
      }
    }
  }
  flushFile();

  if (steps.length === 0) {
    add('', 'error', seq.name, 'Nothing in these desktop activities could be turned into steps.');
    return undefined;
  }
  if (steps.length > 200) {
    add('', 'error', seq.name, 'the desktop sequence has more than 200 steps: split it in the UiPath project');
    return undefined;
  }
  const doc = { surface: 'desktop', name: seq.name, version: 1, app: { exe, ...(launch?.args?.length ? { args: [...launch.args] } : {}) }, steps };
  let script: DesktopScript;
  try {
    script = parseDesktopScript(doc);
  } catch (err) {
    const issues = err instanceof ScriptShapeError ? err.issues : [err instanceof Error ? err.message : String(err)];
    add('', 'error', seq.name, `the desktop draft is not valid steps: ${issues.slice(0, 5).join('; ')}`);
    return undefined;
  }
  const writeCandidates = desktopWriteCandidates(script);
  for (const n of writeCandidates) {
    add(atOf[n - 1] ?? '', 'candidateWrite', `Step ${n}: ${script.steps[n - 1].intent}`,
      `this step may save, post or submit. The import never declares a write: if it writes, list ${n} in Write Steps when you approve these steps (Sign Steps); the desktop runner refuses a declared write control without it`);
  }
  const variables = [...new Set(script.steps.flatMap((s) => {
    const text = 'fill' in s ? s.fill.value : 'select' in s ? s.select.option : '';
    return [...text.matchAll(TEMPLATE_VAR)].map((m) => m[1]);
  }))];
  report.steps += script.steps.length;
  return { name: seq.name, script, writeCandidates, variables, secretVariables: seq.secretVariables.filter((v) => variables.includes(v)) };
}
