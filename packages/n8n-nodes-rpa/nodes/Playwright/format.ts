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

/** One step as the review page lists it: its sentence, its marks (variables, a returned file, a sign-in), and whether the import added it. */
export interface ReviewStep { text: string; marks: string[]; added?: true }
/** A candidate write as the review page asks about it; `signsIn`: a key pressed in a secret field (signInKeySteps), asked unticked. */
export interface ReviewWrite { step: number; intent: string; signsIn?: true }

type Json = Record<string, unknown>;
const asJson = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
/** A value that is one of the steps' `{{var.name}}` templates (spaces allowed, as the engine renders them). */
const holdsVariable = (v: unknown): boolean => /\{\{\s*var\./.test(String(v ?? ''));
/** Every `{{var.name}}` in a step, once, in order. */
const stepVariables = (s: unknown): string[] =>
  [...new Set([...(JSON.stringify(s ?? null) ?? '').matchAll(/\{\{\s*var\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]))];

/** The name of a desktop target's own (last) condition, or ''. */
/** A target's own condition: the last one of its UI Automation path. */
function ownCondition(t: unknown): Json | undefined {
  const path = asJson(asJson(t).uia).path;
  return Array.isArray(path) && path.length ? asJson(path[path.length - 1]) : undefined;
}

function targetName(t: unknown): string {
  const own = ownCondition(t);
  return own ? String(own.name ?? own.automationId ?? '') : '';
}

/** A desktop step's sentence: its verb, the value it types or chooses (never a variable's) and its field, as the recorder's bar words it. */
function desktopSentence(s: Json): string {
  const fill = s.fill === undefined ? undefined : asJson(s.fill);
  const select = s.select === undefined ? undefined : asJson(s.select);
  const key = s.key === undefined ? undefined : asJson(s.key);
  const check = s.check === undefined ? undefined : asJson(s.check);
  const field = targetName(fill?.field ?? select?.field ?? key?.target ?? check?.field) || String(s.intent ?? '');
  if (fill) {
    const file = /^\{\{\$exportDir\}\}[\\/](.+)$/.exec(String(fill.value ?? ''));
    if (file) return `Save ${file[1]} into the run's export folder`;
    return holdsVariable(fill.value) ? `Type into ${field}` : `Type "${String(fill.value)}" into ${field}`;
  }
  if (select) return holdsVariable(select.option) ? `Choose an item in ${field}` : `Choose "${String(select.option)}" in ${field}`;
  if (key) return `Press ${String(key.key)}${field ? ` in ${field}` : ''}`;
  if (check) return `${check.checked === false ? 'Uncheck ' : 'Check '}${field}`;
  // A read: the name a person sees, never the control's automation id; the output name is the step's mark.
  if (s.read !== undefined) {
    const name = ownCondition(asJson(s.read).target)?.name;
    return typeof name === 'string' && name.trim() ? `Read ${name.trim()}` : 'Read a value from the app';
  }
  return String(s.intent ?? '');
}

/** A browser step's sentence: its intent, and a typed value the intent does not say (never a secret's or a variable's). */
function browserSentence(s: Json): string {
  const intent = String(s.intent ?? '');
  const fill = s.fill === undefined ? undefined : asJson(s.fill);
  return fill && !fill.secret && typeof fill.value === 'string' && !holdsVariable(fill.value) && !intent.includes(fill.value) ? `${intent}: "${fill.value}"` : intent;
}

/**
 * For the review page only (shown, never signed or reviewed): each step's short sentence and marks. A desktop step names
 * a variable secret when the import says so (`secretVariables`); a browser step, when it is a secret fill or a password
 * change. `startValues`: a recording's start values; `added`: the step numbers (from 1) the import added.
 */
export function reviewSteps(
  steps: readonly unknown[], o: { desktop: boolean; secretVariables?: readonly string[]; startValues?: Readonly<Record<string, string>>; added?: readonly number[] },
): ReviewStep[] {
  return steps.map((raw, j) => {
    const s = asJson(raw);
    const secret = (v: string): boolean =>
      (o.desktop ? (o.secretVariables ?? []).includes(v) : Boolean(asJson(s.fill).secret) || Boolean(asJson(s.signIn).changePassword));
    const marks = [
      ...stepVariables(raw).map((v) => (secret(v) ? `secret variable ${v}` : `variable ${v}${o.startValues?.[v] !== undefined ? `, starts as ${o.startValues[v]}` : ''}`)),
      ...(s.expectFile || s.download ? ['returns a file'] : []),
      ...(s.read && asJson(s.read).as ? [`gives its text to n8n as ${String(asJson(s.read).as)}`] : []),
      ...(s.signIn ? ['signs in with the RPA Site Login'] : []),
    ];
    return { text: o.desktop ? desktopSentence(s) : browserSentence(s), marks, ...((o.added ?? []).includes(j + 1) ? { added: true as const } : {}) };
  });
}

/** For the review page only: a desktop step list's candidate writes (desktopWriteCandidates), each with its intent on one line. */
export function reviewWrites(steps: readonly DesktopStep[], candidates: readonly number[], secretVariables: readonly string[]): ReviewWrite[] {
  const signsIn = signInKeySteps(steps, secretVariables);
  return candidates.map((n) => ({ step: n, intent: oneLine(steps[n - 1]?.intent ?? ''), ...(signsIn.includes(n) ? { signsIn: true as const } : {}) }));
}
