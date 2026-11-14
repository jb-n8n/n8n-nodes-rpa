import type { DesktopProposal, DesktopStep, DownloadTemplate, PortalPolicy, Proposal, Script, Step } from 'n8n-rpa-engine';
import type { Engine } from './engine.js';

/**
 * Every host, form submission, download and pop-up handler (interrupt) the steps have, then
 * the two flags only the run knows: extract-fields-dropped (needs the base steps) and count unverified (the page states no total),
 * then, for steps that went to approval without a replay (`notReplayed`), one flag per secret fill and password change.
 *
 * The engine flags only what is new compared with the base steps ("new host: …"). Sign Steps has no base, so both
 * Run Steps and Sign Steps list everything, from the steps alone: validateScript against an empty baseline (proposal
 * mode, no previous steps), with the "new " prefix dropped. The policy only satisfies the call; flags do not depend on
 * it. `script` is the parsed steps (engine parseScript).
 */
export function fullSafetyFlags(
  engine: Pick<Engine, 'validateScript' | 'UNVERIFIED_COUNT_FLAG' | 'EXTRACT_FIELDS_DROPPED' | 'notReplayedFlags'>,
  script: Script,
  known: { unverifiedCount: boolean; fieldsDropped: boolean; notReplayed?: boolean },
): string[] {
  const policy: PortalPolicy = { startUrl: script.startUrl, navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };
  const flags = engine.validateScript(script, { policy, mode: 'proposal' }).safetyFlags.map((f) => f.replace(/^new /, ''));
  if (known.fieldsDropped) flags.push(engine.EXTRACT_FIELDS_DROPPED);
  if (known.unverifiedCount) flags.push(engine.UNVERIFIED_COUNT_FLAG);
  if (known.notReplayed) flags.push(...engine.notReplayedFlags(script));
  return flags;
}

/** The single top-level download step's template, as the engine reads it (downloadTemplateOf), or undefined when there is not exactly one. */
function downloadTemplate(steps: Step[]): DownloadTemplate | undefined {
  const found = steps.filter((s): s is Extract<Step, { download: unknown }> => 'download' in s);
  if (found.length !== 1) return undefined;
  const { mime, maxBytes, check } = found[0].download;
  return { ...(mime ? { mime } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}), check: check ?? {} };
}

/** True when the steps have a download step anywhere (paginate bodies included). */
export function hasDownloadStep(steps: Step[]): boolean {
  return steps.some((s) => 'download' in s || ('paginate' in s && hasDownloadStep(s.paginate.each)));
}

function hasExtractStep(steps: Step[]): boolean {
  return steps.some((s) => 'extract' in s || ('paginate' in s && hasExtractStep(s.paginate.each)));
}

/** The engine's file-document shape: exactly one top-level download, none inside paginate, and no extract step. */
export function isFileDocument(steps: Step[]): boolean {
  const top = steps.filter((s) => 'download' in s).length;
  const all = (list: Step[]): number => list.reduce((n, s) => n + ('download' in s ? 1 : 0) + ('paginate' in s ? all(s.paginate.each) : 0), 0);
  return top === 1 && all(steps) === 1 && !hasExtractStep(steps);
}

/** One line: control, format and line-separator characters become JSON escapes (same as the engine's oneLine; the engine loads lazily). */
const oneLine = (s: string): string =>
  s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' })[c] ?? Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));


/**
 * One line of evidence for the approver. For a file proposal it describes the PROVEN file (the evidence's), and the
 * checks come from the download step of the steps, never from the evidence.
 */
export function evidenceLine(p: Proposal | DesktopProposal, engine: Pick<Engine, 'describeCheck'>): string {
  if (isDesktopProposal(p)) return DESKTOP_EVIDENCE_LINE;
  const { count, total, diff, file: f } = p.evidence;
  const reads = p.evidence.readPosts?.length ? `; read-only requests the Site Login allowed: ${p.evidence.readPosts.join(', ')}` : '';
  if (f) {
    const checks = engine.describeCheck(downloadTemplate(p.steps.steps) ?? { check: {} });
    return oneLine(`Proven in a fresh browser: downloaded ${JSON.stringify(f.fileName)} (${f.mimeType}, ${f.bytes} bytes${f.rows !== null ? `, ${f.rows} rows` : ''}); checks: ${checks}${reads}`);
  }
  const head = total === null ? `Proven in a fresh browser: ${count} rows (the page states no total)` : `Proven in a fresh browser: ${count} of ${total} rows`;
  const delta = diff.missing.length || diff.extra.length ? `; compared with the repair run: ${diff.missing.length} missing, ${diff.extra.length} extra` : '';
  return oneLine(`${head}${delta}${reads}`);
}

/** The evidence line of desktop steps from a UiPath import: nothing was replayed, so the approver reviews the steps as written. */
export const DESKTOP_EVIDENCE_LINE =
  'Not replayed: desktop steps imported from UiPath are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.';
/** The same for desktop steps from a step document (Import Steps → Step Document (JSON)). */
export const DESKTOP_DOCUMENT_EVIDENCE_LINE =
  'Not replayed: desktop steps from a step document are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.';
/** The same for desktop steps from a recording (Import Steps → RPA Recording). */
export const DESKTOP_RECORDING_EVIDENCE_LINE =
  'Not replayed: desktop steps imported from a recording are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.';
/**
 * The evidence line of browser steps from a step document that go to approval without a replay (Import Steps never runs
 * steps that submit a form, download through a form, type a secret or change a password). Sign Steps accepts it only on
 * a first version with empty evidence whose steps have one of those.
 */
export const NOT_REPLAYED_EVIDENCE_LINE =
  "Not replayed: these browser steps were never run by the import, because they submit a form, download through a form, type a secret or change a password. Check every step, each form's target and each download before you approve.";
/**
 * Every evidence line a desktop Repaired steps item may carry, one per import source that gives desktop steps. The
 * evidence does not say where the steps came from, so Sign Steps accepts any of these on a desktop item.
 */
export const DESKTOP_EVIDENCE_LINES: readonly string[] = [DESKTOP_EVIDENCE_LINE, DESKTOP_DOCUMENT_EVIDENCE_LINE, DESKTOP_RECORDING_EVIDENCE_LINE];

/** A proposal whose steps are a desktop step set (`surface: "desktop"`, own property, as the engine routes). */
export function isDesktopProposal(p: Proposal | DesktopProposal): p is DesktopProposal {
  const steps = p.steps as unknown;
  return typeof steps === 'object' && steps !== null && Object.hasOwn(steps, 'surface') && (steps as { surface?: unknown }).surface === 'desktop';
}

/**
 * Plain-English step changes, one per line. Desktop steps are a first version whose change list is every step in order,
 * so each line carries its step number (`Step 16: Click Save (…)`): the number the approver lists in Write Steps. The
 * numbers are added here, recomputed from the reviewed fields (the digest covers the changes, not this text).
 */
export function changeList(p: Proposal | DesktopProposal): string {
  if (p.changes.length === 0) return 'No step changes';
  if (isDesktopProposal(p)) return p.changes.map((c, i) => `Step ${i + 1}: ${c.now === null ? `Removed: ${oneLine(c.was ?? '')}` : oneLine(c.now)}`).join('\n');
  return p.changes
    .map((c) => {
      const was = c.was === null ? null : oneLine(c.was);
      const now = c.now === null ? null : oneLine(c.now);
      return was !== null && now !== null ? `Changed: ${was} -> ${now}` : now !== null ? `Added: ${now}` : `Removed: ${was ?? ''}`;
    })
    .join('\n');
}

/** The steps an import left out, one per line, as the approver reads them; '' when there are none. */
export function leftOutList(p: { leftOut?: readonly string[] }): string {
  return (p.leftOut ?? []).map(oneLine).join('\n');
}

export function safetyLine(p: Pick<Proposal, 'safetyFlags'>): string {
  return p.safetyFlags.length ? p.safetyFlags.map(oneLine).join('; ') : 'none';
}

/** JSON with object keys sorted, so that two targets recorded with their keys in another order compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * For the review page only (never signed or reviewed): the numbers (from 1) of the desktop key steps that press a key in a
 * field where a secret variable is typed, or with no target right after such a fill (the key then goes to that field).
 * Enter in the password field signs in; it does not save, so the review page leaves such a candidate write unticked.
 */
export function signInKeySteps(steps: readonly DesktopStep[], secretVariables: readonly string[]): number[] {
  const typesSecret = (s: DesktopStep | undefined): s is Extract<DesktopStep, { fill: unknown }> =>
    s !== undefined && 'fill' in s && [...s.fill.value.matchAll(/\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g)].some((m) => secretVariables.includes(m[1]));
  const secretFields = new Set(steps.filter(typesSecret).map((s) => canonical(s.fill.field.uia)));
  return steps.flatMap((s, i) => {
    if (!('key' in s)) return [];
    const inSecretField = s.key.target ? secretFields.has(canonical(s.key.target.uia)) : typesSecret(steps[i - 1]);
    return inSecretField ? [i + 1] : [];
  });
}

/**
 * For the review page only: the numbers (from 1) of the steps an import adds to a recording, which the person did not
 * record: a wait for each window and each returned file (the recorder records neither).
 */
export function importAddedSteps(steps: readonly DesktopStep[]): number[] {
  return steps.flatMap((s, i) => ('waitFor' in s || 'expectFile' in s ? [i + 1] : []));
}

/**
 * One step as the review page lists it: its sentence, its marks (variables, a returned file, a sign-in), whether the
 * import added it, and for a browser `paginate` (the only step that holds steps) the steps it runs on each page.
 */
export interface ReviewStep {
  /** The sentence built from the step: what it does, where, and the value. Never the author's description. */
  text: string;
  /**
   * The step's own description (its intent), only when it says something else than `text`: a separate field, so that
   * the review page and the emails put it beside the sentence with a label they write themselves, and nothing is found
   * by searching the sentence.
   */
  describedAs?: string;
  /**
   * Set when `describedAs` names the same kind of action as the step and no other site (describedQuietly): the page shows
   * it quietly, as the author's words. Absent, a description is shown as a warning.
   */
  quiet?: true;
  marks: string[]; added?: true; each?: ReviewStep[];
}
/** A step's sentence and, when it says something else, the author's description. */
type Sentence = { text: string; describedAs?: string };
const sentence = (text: string, describedAs?: string): Sentence => (describedAs ? { text, describedAs } : { text });
/** A candidate write as the review page asks about it; `signsIn`: a key pressed in a secret field (signInKeySteps), asked unticked. */
export interface ReviewWrite { step: number; intent: string; signsIn?: true }

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
/** A value that is one of the steps' `{{var.name}}` templates (spaces allowed, as the engine renders them). */
const holdsVariable = (v: unknown): boolean => /\{\{\s*var\./.test(String(v ?? ''));
/** Every `{{var.name}}` in a text, once, in order. */
const variablesIn = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{\{\s*var\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];
/**
 * Every `{{var.name}}` a step types, chooses or otherwise uses, once, in order: from the step's own fields, never from its
 * intent. The intent is the author's description: after a value was changed to a fixed one, it may still name the
 * variable the step no longer uses.
 */
const stepVariables = (s: unknown): string[] => variablesIn(JSON.stringify(Object.fromEntries(Object.entries(asJson(s)).filter(([k]) => k !== 'intent'))));

/** A target's own condition: the last one of its UI Automation path. */
function ownCondition(t: unknown): Json | undefined {
  const path = asJson(asJson(t).uia).path;
  return Array.isArray(path) && path.length ? asJson(path[path.length - 1]) : undefined;
}

function targetName(t: unknown): string {
  const own = ownCondition(t);
  return own ? String(own.name ?? own.automationId ?? '') : '';
}

/**
 * A desktop step's sentence, as the recorder's bar words it. For every step that acts on the app (type, choose, check,
 * press, click) the action, the control and the value come from the step itself, never from its intent: the page is
 * what a person approves, and the intent is the author's own description (a step document's or a UiPath project's
 * author may be someone else). A variable's value is never shown.
 */
function desktopSentence(s: Json): Sentence {
  const fill = s.fill === undefined ? undefined : asJson(s.fill);
  const select = s.select === undefined ? undefined : asJson(s.select);
  const key = s.key === undefined ? undefined : asJson(s.key);
  const check = s.check === undefined ? undefined : asJson(s.check);
  const named = targetName(fill?.field ?? select?.field ?? key?.target ?? check?.field);
  // A name as one name: quoted when it holds a bracket or a double quote, as a browser step's name is (shownName).
  const field = named ? shownName(named) : '';
  if (fill) {
    const file = /^\{\{\$exportDir\}\}[\\/](.+)$/.exec(String(fill.value ?? ''));
    if (file) return sentence(`Save ${file[1]} into the run's export folder`);
  }
  // A control with neither a name nor an id. What the step does and the value it types or chooses come from the step
  // itself, as for a named control: this page is what a person approves, and the intent is only the author's own
  // description, so it is shown as that (describedAs), and never in place of the action or the value.
  const described = String(s.intent ?? '').replace(/\s+/g, ' ').trim();
  // A description that names a variable the step does not use (its value was changed to a fixed one, the description
  // left as it was) says something else than the step: shown beside the sentence.
  const used = stepVariables(s);
  const stale = variablesIn(described).some((v) => !used.includes(v)) ? described : undefined;
  if (!named && (fill || select || check)) {
    const text = fill ? `${holdsVariable(fill.value) ? 'Type' : `Type "${String(fill.value)}"`} into a field without a name`
      : select ? `${holdsVariable(select.option) ? 'Choose an item' : `Choose "${String(select.option)}"`} in a field without a name`
      : `${asJson(check).checked === false ? 'Uncheck' : 'Check'} a box without a name`;
    return sentence(text, described || undefined);
  }
  if (fill) {
    return sentence(holdsVariable(fill.value) ? `Type into ${field}` : `Type "${String(fill.value)}" into ${field}`, stale);
  }
  if (select) return sentence(holdsVariable(select.option) ? `Choose an item in ${field}` : `Choose "${String(select.option)}" in ${field}`, stale);
  if (key) {
    // The key goes to the control it names, or to the one in front (no target). The author's description is never the target.
    const text = `Press ${String(key.key)}${field ? ` in ${field}` : key.target ? ' in a control without a name' : ''}`;
    return sentence(text, !named && described && comparable(described) !== comparable(text) ? described : undefined);
  }
  if (check) return sentence(`${check.checked === false ? 'Uncheck ' : 'Check '}${field}`, stale);
  // A read: the name a person sees, never the control's automation id; the output name is the step's mark.
  if (s.read !== undefined) {
    const name = ownCondition(asJson(s.read).target)?.name;
    return sentence(typeof name === 'string' && name.trim() ? `Read ${shownName(name.trim())}` : 'Read a value from the app');
  }
  // A click: the control comes from the step itself. The author's description stands beside it when it says something
  // else, compared as a browser step's is (comparable).
  for (const [verb, word] of [['click', 'Click'], ['doubleClick', 'Double-click']] as const) {
    if (s[verb] === undefined) continue;
    const name = targetName(s[verb]);
    const text = `${word} ${name ? shownName(name) : 'a control without a name'}`;
    return sentence(text, described && comparable(described) !== comparable(text) ? described : undefined);
  }
  return sentence(String(s.intent ?? ''));
}

/** Names, values, selectors and addresses in a browser step's sentence are at most this many characters (the importer's label length). */
const MAX_SHOWN = 80;
/** The author's description beside a browser step's sentence is at most this many characters. */
const MAX_DESCRIBED = 120;

/** Text on one line, as the importer cleans a label: format characters dropped, control characters and runs of spaces one space, cut with an ellipsis. */
function clean(v: unknown, max: number): string {
  const t = String(v ?? '').replace(/[\p{Cf}\p{Cs}]/gu, '').replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : t;
}

/**
 * A name as the importer's descriptions show it (import/draft.ts `shown`): quoted when it has a bracket or a double quote,
 * so a name reads as one name in the sentence.
 */
const shownName = (name: string): string => (/[()"]/.test(name) ? `"${name.replaceAll('"', "'")}"` : name);

/** A typed or chosen value or a selector: JSON-quoted on one line (a quote or a line break in it shows escaped), cut to MAX_SHOWN with an ellipsis. */
function shownValue(v: unknown): string {
  const chars = Array.from(String(v ?? ''));
  return oneLine(JSON.stringify(chars.slice(0, MAX_SHOWN).join(''))) + (chars.length > MAX_SHOWN ? '…' : '');
}

/**
 * The element a browser locator finds, as a person recognises it: the name of a role (else "the <role>"), a label, a
 * visible text or a test id, as the importer names it; for a CSS selector the selector itself. Only the primary
 * locator: it is what the step uses, and a fallback is tried only when it finds nothing.
 */
function browserTarget(l: unknown): string {
  const loc = asJson(l);
  if (typeof loc.role === 'string') {
    const name = clean(loc.name, MAX_SHOWN);
    return name ? shownName(name) : `the ${shownName(clean(loc.role, MAX_SHOWN))}`;
  }
  for (const k of ['label', 'text', 'testId'] as const) {
    if (typeof loc[k] === 'string') return shownName(clean(loc[k], MAX_SHOWN)) || 'an element without a name';
  }
  if (typeof loc.css === 'string') return `the element matching ${shownValue(loc.css)}`;
  return 'an element';
}

/** A form a submit step or a download's `via` sends: method, host (the start site's when absent) and path. */
function shownForm(t: unknown): string {
  const f = asJson(t);
  const host = typeof f.host === 'string' ? clean(f.host, MAX_SHOWN) : 'the start site';
  return `${clean(f.method ?? 'POST', 10).toUpperCase()} ${host}${typeof f.host === 'string' ? '' : ' at '}${clean(f.path, MAX_SHOWN)}`;
}

/**
 * The browser steps that only read or wait: their sentence is the author's description, as before. They change nothing
 * on the site and send nothing to it, and what they give to n8n is in the step's marks (a file, a read's output) and in
 * the details block.
 */
const READ_OR_WAIT = ['waitFor', 'extract', 'extractTable', 'read', 'detect', 'screenshot', 'pdf'] as const;

/**
 * What a browser step does, from the step itself: `core` is the action and its target in the importer's words, `more` the
 * value or detail after it (a typed value, the keys held, the form it sends), `alike` another wording of the same that a
 * description may use (a plain http address without its scheme). undefined for a step that only reads or waits.
 */
function browserAction(s: Json, shownUrl: (url: string) => string): { core: string; more: string; alike?: string } | undefined {
  const value = (v: unknown, secret: boolean) => (secret ? 'a secret' : holdsVariable(v) ? 'a variable' : shownValue(v));
  if (typeof s.goto === 'string') {
    // Host and path, never the query or fragment, without "https://" as the importer words it. A plain http address
    // keeps its "http://": the page then says the site is not encrypted. The importer's wording, without it, still matches.
    const place = shownUrl(s.goto).replace(/^https:\/\//i, '').replace(/^((?:http:\/\/)?[^/]+)\/$/i, '$1');
    const open = (p: string) => `Open ${shownName(clean(p, MAX_SHOWN))}`;
    const plain = place.replace(/^http:\/\//i, '');
    return { core: open(place), more: '', ...(plain !== place ? { alike: open(plain) } : {}) };
  }
  if (s.signIn !== undefined) {
    const sign = asJson(s.signIn);
    return { core: sign.totp ? 'Sign in with an authentication code' : 'Sign in', more: sign.changePassword ? ', and set a new password if the site asks for one' : '' };
  }
  if (s.click !== undefined) {
    const held = Array.isArray(s.modifiers) && s.modifiers.length ? `, holding ${s.modifiers.map((m) => clean(m, 10)).join('+')}` : '';
    return { core: `Click ${browserTarget(s.click)}`, more: held };
  }
  if (s.fill !== undefined) {
    const f = asJson(s.fill);
    return { core: `Type into ${browserTarget(f.field)}`, more: `: ${value(f.value, Boolean(f.secret))}` };
  }
  if (s.select !== undefined) {
    const f = asJson(s.select);
    const chosen = [f.value].flat().map((v) => (holdsVariable(v) ? 'an option set by a variable' : shownValue(v))).join(', ');
    return { core: `Choose ${chosen} in ${browserTarget(f.field)}`, more: '' };
  }
  if (s.check !== undefined) return { core: `${asJson(s.check).checked === false ? 'Uncheck' : 'Check'} ${browserTarget(asJson(s.check).field)}`, more: '' };
  if (s.clickAll !== undefined) return { core: `Click every ${browserTarget(asJson(s.clickAll).target)}`, more: `, at most ${Number(asJson(s.clickAll).max)}` };
  if (s.press !== undefined) {
    const p = asJson(s.press);
    return { core: `Press ${clean(p.key, MAX_SHOWN)}${p.target === undefined ? '' : ` in ${browserTarget(p.target)}`}`, more: '' };
  }
  if (s.hover !== undefined) return { core: `Hover over ${browserTarget(s.hover)}`, more: '' };
  if (s.popup !== undefined) return { core: `Open ${browserTarget(asJson(s.popup).trigger)} in a new tab`, more: '' };
  // A submit is the steps' declared write: the sites line says that a form is sent, this line says which step sends it.
  if (s.submit !== undefined) return { core: `Click ${browserTarget(asJson(s.submit).button)} to submit a form`, more: ` to ${shownForm(s.submit)}` };
  if (s.download !== undefined) {
    const d = asJson(s.download);
    return { core: `Download with ${browserTarget(d.trigger)}`, more: d.via === undefined ? '' : `, through a form sent to ${shownForm(d.via)}` };
  }
  if (s.paginate !== undefined) {
    const p = asJson(s.paginate);
    const each = Array.isArray(p.each) ? p.each.length : 0;
    return { core: `Page through with ${browserTarget(p.next)}`, more: `, at most ${Number(p.max)} pages, ${each} ${each === 1 ? 'step' : 'steps'} on each` };
  }
  return undefined;
}

/**
 * Text as compared with the author's description: no case, no quotes (straight or curly, single or double), single
 * spaces and no full stop at the end. Only differences that cannot change what a step does are ignored: another verb,
 * target or value still differs, so a description that says "Click" where the step opens a link, or another value,
 * still shows beside the sentence.
 */
export const comparable = (t: string): string =>
  t.replace(/["'\u2018\u2019\u201c\u201d]/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').trimEnd().toLowerCase();

/**
 * The kinds of action a description names by its first word (or two), and the kinds each step may be described as. A
 * description whose first word is in VERBS but names no kind of its step is a warning; one whose first word is not
 * there is quiet. One table, exact words: no fuzzy matching. A click may open, download, tick or choose, and a submit
 * often saves, so those are not warnings.
 */
const VERBS: Record<string, readonly string[]> = {
  open: ['open', 'go', 'navigate', 'visit'],
  type: ['type', 'enter', 'fill', 'set'],
  click: ['click', 'press', 'tap', 'double-click'],
  choose: ['choose', 'select', 'pick'],
  check: ['check', 'tick', 'untick', 'uncheck'],
  read: ['read', 'get', 'copy'],
  download: ['download', 'export', 'save'],
  wait: ['wait'],
  upload: ['upload'],
  signIn: ['sign in', 'log in'],
};
const CLICK_KINDS = ['click', 'open', 'download', 'check', 'choose'];
const STEP_KINDS: Record<string, readonly string[]> = {
  goto: ['open'], signIn: ['signIn', 'type'], click: CLICK_KINDS, doubleClick: CLICK_KINDS, clickAll: ['click', 'check'], hover: ['click', 'open'],
  popup: ['click', 'open'], press: ['click', 'type'], key: ['click', 'type'], fill: ['type'], select: ['choose'], check: ['check', 'click'],
  submit: ['click', 'download'], download: ['download', 'click'], paginate: ['click', 'open', 'read'],
};

/** The kind of action a description names by its first word or two, or undefined when the word is not in VERBS. */
function describedKind(described: string): string | undefined {
  const words = described.toLowerCase().replace(/^[^a-z]+/, '').split(/[^a-z-]+/);
  const first = [`${words[0]} ${words[1] ?? ''}`, words[0]];
  return Object.keys(VERBS).find((kind) => VERBS[kind].some((v) => first.includes(v)));
}

/** File names, which look like a host (report.csv): their last part is one of these. */
const FILE_EXTENSION = /\.(?:csv|tsv|xlsx?|pdf|txt|json|xml|zip|docx?|pptx?|png|jpe?g|gif|html?|js|ts|exe|dll|msi)$/i;
/** Hosts named in a text: of an address with a scheme (any, with its port and user dropped), or a bare domain name. */
function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#'"<>\\]+)|\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi)) {
    const host = (m[1] ?? m[2]).replace(/^.*@/, '').replace(/:\d*$/, '').toLowerCase();
    if (m[1] !== undefined || !FILE_EXTENSION.test(host)) hosts.push(host);
  }
  return hosts;
}

/** Text in double quotes, straight or curly. */
const QUOTED = /"([^"]*)"|\u201c([^\u201d]*)\u201d/g;
/** An ISO date. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/**
 * The values a description states: each text it puts in double quotes, each ISO date and each number of three or more
 * digits outside the quotes, an address (hosts are checked on their own, hostsIn) and a host's port.
 */
export function statedValues(described: string): string[] {
  const quoted = [...described.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter((q) => q !== '');
  const rest = described.replace(QUOTED, ' ').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ').replace(/[\w.-]+:\d+/g, ' ');
  const dates = rest.match(ISO_DATE) ?? [];
  const numbers = rest.replace(ISO_DATE, ' ').match(/\d{3,}/g) ?? [];
  return [...quoted, ...dates, ...numbers];
}

/** Every text and number a step's own fields hold (its intent left out), lower case. */
function ownValues(v: unknown, acc: string[] = []): string[] {
  if (typeof v === 'string' || typeof v === 'number') acc.push(String(v).toLowerCase());
  else if (Array.isArray(v)) v.forEach((x) => ownValues(x, acc));
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'intent') ownValues(x, acc);
  return acc;
}

/**
 * Whether the author's description of a step can be shown quietly: it names a kind of action the step may be (VERBS,
 * STEP_KINDS), or none the table knows, no host but the step's own (any host its fields name, and the start site's),
 * and no value the step's own fields do not hold (statedValues: a quoted text, an ISO date, a number of three or more
 * digits; one field must hold it, case aside). A description that states no value is judged by the first two alone.
 * Otherwise the page shows it as a warning. What runs is the sentence built from the step, whatever the description says.
 */
function describedQuietly(step: Json, described: string, startUrl: string | undefined): boolean {
  const kind = describedKind(described);
  const stepKinds = Object.keys(STEP_KINDS).filter((k) => step[k] !== undefined).flatMap((k) => STEP_KINDS[k]);
  if (kind !== undefined && !stepKinds.includes(kind)) return false;
  const own = JSON.stringify(Object.fromEntries(Object.entries(step).filter(([k]) => k !== 'intent'))).replace(/\\\\/g, '').toLowerCase();
  const start = startUrl && URL.canParse(startUrl) ? new URL(startUrl).hostname.toLowerCase() : undefined;
  if (!hostsIn(described).every((h) => h === start || own.includes(h))) return false;
  const values = ownValues(step);
  return statedValues(described).every((v) => values.some((x) => x.includes(v.toLowerCase())));
}

/**
 * A browser step's sentence. For every step that acts on the page or sends something, the action, the target and the
 * value come from the step itself, never from its intent: the page is what a person approves, and the intent is the
 * author's own description (a step document's or a UiPath project's author may be someone else). The description
 * stands beside the sentence (`describedAs`, which the page labels), when it says something else: neither
 * the action alone nor all of it, compared without case, quotes, extra spaces or a full stop at the end (comparable). An import's descriptions (import/draft.ts describeEvent) say the action
 * in the same words, so a recording reads without brackets. A secret's and a variable's value is never shown.
 */
function browserSentence(s: Json, shownUrl: (url: string) => string): Sentence {
  const described = clean(s.intent, MAX_DESCRIBED);
  if (READ_OR_WAIT.some((v) => s[v] !== undefined)) return sentence(String(s.intent ?? ''));
  const action = browserAction(s, shownUrl);
  if (!action) return sentence(String(s.intent ?? ''));
  const text = `${action.core}${action.more}`;
  const same = [action.core, text, action.alike ?? text].some((t) => comparable(t) === comparable(described));
  return sentence(text, described && !same ? described : undefined);
}

/**
 * The mark of a step that finds its control by the row it is in (a desktop name such as "Vendor Row 1", as the
 * recorder's bar marks it), and of one that finds it by its place among others (a desktop condition's index, a browser
 * CSS selector such as `tr:nth-child(1) button`). Either way, a later run acts on whatever is in that place then.
 */
export const BY_ROW = 'found by its row: at each run it acts on whatever is in that row';
export const BY_POSITION = 'found by its position: at each run it acts on whatever is in that place';
/** The two marks above: an item made before they existed shows neither, and still signs (signSteps sameReviewStep). */
export const POSITION_MARKS: readonly string[] = [BY_ROW, BY_POSITION];

/** A name that carries a row position, as the recorder judges it (Rpa.Recorder.Core LocatorRules.IsPositional). */
const ROW_POSITION = /\bRow [0-9]+\b/;

/**
 * How a desktop target finds its control when it does so by position: by a condition's index (any of its path), or,
 * as the recorder marks it, by an own condition without an automation id whose name carries a row ("Vendor Row 1").
 * Only the primary target: it is the one the step names and uses first.
 */
function desktopPosition(t: unknown): string | undefined {
  const path = asJson(asJson(t).uia).path;
  if (!Array.isArray(path) || path.length === 0) return undefined;
  if (path.some((c) => asJson(c).index !== undefined)) return BY_POSITION;
  const own = asJson(path[path.length - 1]);
  return own.automationId === undefined && typeof own.name === 'string' && ROW_POSITION.test(own.name) ? BY_ROW : undefined;
}

/**
 * A CSS selector (or the XPath Playwright also takes there) that picks an element by its place among others: an
 * nth-child or nth-of-type, a first or last child, an nth match, or an XPath index.
 */
const POSITIONAL_CSS = /:nth-(?:last-)?(?:child|of-type)\s*\(|:nth-match\s*\(|:(?:first|last)-(?:child|of-type)\b|>>\s*nth\s*=|^\s*(?:xpath=|\/|\.\.?\/|\()[\s\S]*\[\s*(?:\d+|last\(\)[^\]]*|position\(\)[^\]]*)\s*\]/i;

/** Whether a browser locator (its primary, the elements it is searched within, and its frame) finds by position. */
function browserPositional(l: unknown): boolean {
  const loc = asJson(l);
  if (typeof loc.css === 'string' && POSITIONAL_CSS.test(loc.css)) return true;
  if (typeof loc.frame === 'string' && POSITIONAL_CSS.test(loc.frame)) return true;
  return loc.within !== undefined && browserPositional(loc.within);
}

/** The locators a browser step acts on: the control it clicks, types into, chooses in, presses in, hovers or sends with. */
function browserTargets(s: Json): unknown[] {
  const f = (k: string, inner: string) => (s[k] === undefined ? [] : [asJson(s[k])[inner]]);
  return [
    ...(s.click === undefined ? [] : [s.click]), ...(s.hover === undefined ? [] : [s.hover]),
    ...f('fill', 'field'), ...f('select', 'field'), ...f('check', 'field'), ...f('clickAll', 'target'), ...f('press', 'target'),
    ...f('popup', 'trigger'), ...f('submit', 'button'), ...f('download', 'trigger'), ...f('paginate', 'next'),
  ].filter((l) => l !== undefined);
}

/** The locators a desktop step acts on or reads from, as the recorder marks them. */
function desktopTargets(s: Json): unknown[] {
  const f = (k: string, inner: string) => (s[k] === undefined ? [] : [asJson(s[k])[inner]]);
  return [
    ...(s.click === undefined ? [] : [s.click]), ...(s.doubleClick === undefined ? [] : [s.doubleClick]),
    ...f('fill', 'field'), ...f('select', 'field'), ...f('check', 'field'), ...f('key', 'target'), ...f('read', 'target'),
  ].filter((l) => l !== undefined);
}

/** The step's position mark (BY_ROW or BY_POSITION), from the step itself, or undefined. */
function positionMark(s: Json, desktop: boolean): string | undefined {
  if (desktop) return desktopTargets(s).map(desktopPosition).find((m) => m !== undefined);
  return browserTargets(s).some(browserPositional) ? BY_POSITION : undefined;
}

/**
 * For the review page only (shown, never signed or reviewed): each step's short sentence and marks. A desktop step names
 * a variable secret when the import says so (`secretVariables`); a browser step, when it is a secret fill or a password
 * change. `startValues`: a recording's start values; `added`: the step numbers (from 1) the import added. `shownUrl`: the
 * engine's, for the address a browser goto opens.
 */
export function reviewSteps(
  steps: readonly unknown[],
  o: { desktop: true; secretVariables?: readonly string[]; startValues?: Readonly<Record<string, string>>; added?: readonly number[]; startUrl?: undefined }
    | {
      desktop: false; shownUrl: (url: string) => string; secretVariables?: undefined; startValues?: undefined; added?: undefined;
      /** The steps' start address: a description may name its host (describedQuietly). */
      startUrl?: string;
    },
): ReviewStep[] {
  const review = (raw: unknown, j: number): ReviewStep => {
    const s = asJson(raw);
    // A paginate's own marks leave out its body: each step of the body is listed under it with its own.
    const body = s.paginate !== undefined && Array.isArray(asJson(s.paginate).each) ? (asJson(s.paginate).each as unknown[]) : undefined;
    const own = body ? { ...s, paginate: { ...asJson(s.paginate), each: [] } } : raw;
    const secret = (v: string): boolean =>
      (o.desktop ? (o.secretVariables ?? []).includes(v) : Boolean(asJson(s.fill).secret) || Boolean(asJson(s.signIn).changePassword));
    const marks = [
      ...stepVariables(own).map((v) => (secret(v) ? `secret variable ${v}` : `variable ${v}${o.startValues?.[v] !== undefined ? `, starts as ${o.startValues[v]}` : ''}`)),
      ...(s.expectFile || s.download ? ['returns a file'] : []),
      ...(s.read && asJson(s.read).as ? [`gives its text to n8n as ${String(asJson(s.read).as)}`] : []),
      ...(s.signIn ? ['signs in with the RPA Site Login'] : []),
      // Last, so that an item made before this mark existed differs only by its absence (signSteps sameReviewStep).
      ...((m) => (m ? [m] : []))(positionMark(asJson(own), o.desktop)),
    ];
    const said = o.desktop ? desktopSentence(s) : browserSentence(s, o.shownUrl);
    return {
      ...said, ...(said.describedAs !== undefined && describedQuietly(s, said.describedAs, o.startUrl) ? { quiet: true as const } : {}), marks,
      ...((o.added ?? []).includes(j + 1) ? { added: true as const } : {}),
      ...(body?.length ? { each: body.map((b) => review(b, -1)) } : {}),
    };
  };
  return steps.map(review);
}

/** For the review page only: a desktop step list's candidate writes (desktopWriteCandidates), each with its intent on one line. */
export function reviewWrites(steps: readonly DesktopStep[], candidates: readonly number[], secretVariables: readonly string[]): ReviewWrite[] {
  const signsIn = signInKeySteps(steps, secretVariables);
  return candidates.map((n) => ({ step: n, intent: oneLine(steps[n - 1]?.intent ?? ''), ...(signsIn.includes(n) ? { signsIn: true as const } : {}) }));
}

/**
 * One entry of the change list as the approval emails show it (shown only, never signed). For an entry that names a step
 * the steps have, its number (from 1; a step inside a paginate has its paginate's number and `onEachPage`) and that
 * step's sentence, description and mark, as reviewSteps builds them. An entry that names no step (a pop-up handler, or a
 * step removed) keeps the run's own words in `text`. `was`: the run's words for the step as it was.
 */
export interface ReviewChange {
  change: 'Added' | 'Changed' | 'Removed';
  step?: number; onEachPage?: true; text?: string; describedAs?: string; quiet?: true; was?: string;
}

/** The suffix the engine's change list adds to a changed step that reads the same as before (engine ALSO_CHANGED). */
const ALSO_CHANGED_SUFFIX = / \(also changed: [\w.]+(?:, [\w.]+)*\)$/;

/**
 * For the approval emails of browser steps: each change-list entry (`changes`, the engine's stepChanges) as a ReviewChange.
 * An entry names a step when it is that step's engine description (describeStep, the also-changed suffix aside); the first
 * such step is taken. A pure function of the steps and the change list, so Sign Steps builds the same list again.
 */
export function reviewChanges(
  engine: Pick<Engine, 'describeStep'>, steps: readonly unknown[], changes: readonly { was: string | null; now: string | null }[],
  o: { shownUrl: (url: string) => string; startUrl?: string },
): ReviewChange[] {
  const describe = (s: unknown): string | undefined => {
    try {
      return engine.describeStep(s as Step);
    } catch {
      return undefined;
    }
  };
  const located: { step: number; raw: unknown; inner: boolean; said: string | undefined }[] = [];
  steps.forEach((s, i) => {
    located.push({ step: i + 1, raw: s, inner: false, said: describe(s) });
    const each = asJson(asJson(s).paginate).each;
    if (Array.isArray(each)) for (const b of each) located.push({ step: i + 1, raw: b, inner: true, said: describe(b) });
  });
  return changes.map((c) => {
    const change = c.was !== null && c.now !== null ? 'Changed' : c.now !== null ? 'Added' : 'Removed';
    const was = c.was !== null ? { was: oneLine(c.was) } : {};
    if (c.now === null) return { change, ...was };
    const now = c.now.replace(ALSO_CHANGED_SUFFIX, '');
    const at = located.find((l) => l.said !== undefined && l.said === now);
    if (!at) return { change, text: oneLine(c.now), ...was };
    // The step's own sentence: a paginate's inner lines are entries of their own.
    const [r] = reviewSteps([at.raw], { desktop: false, ...o });
    return {
      change, step: at.step, ...(at.inner ? { onEachPage: true as const } : {}), text: r.text,
      ...(r.describedAs !== undefined ? { describedAs: r.describedAs } : {}), ...(r.quiet ? { quiet: true as const } : {}), ...was,
    };
  });
}
