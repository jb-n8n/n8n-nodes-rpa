// Review and signing of desktop step sets. A desktop draft (from an import) is not replayed: there is no desktop proof
// yet, so the approver reviews the steps as written. Its proposal lists every step, the app it launches, the files it
// returns, its declared writes and its candidate writes. The owner declares writes only when approving (Sign Steps'
// Write Steps): the import never sets `write: true`, and signDesktopSteps adds exactly the declared ones before signing.
import { STEPS_CHANGED_AFTER_REVIEW, STEPS_HASH_MISMATCH, STEPS_NAME_MISMATCH, STEPS_VERSION_MISMATCH } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { normalizeForDenylist } from '../policy/destructive.js';
import { canonicalize, scriptHash, signScript } from '../sign.js';
import { DESKTOP_WRITE_VERBS } from '../steps/desktop-vocabulary.js';
import { desktopVerbOf, parseDesktopScript } from '../steps/parse.js';
import type { DesktopLocator, DesktopScript, DesktopStep, UiaCond, UiaTarget, WindowSel } from '../types.js';
import { oneLine } from './describe.js';
import { NO_REVIEW_DIGEST, proposalDigest, type IntentChange, type Proposal } from './proposal.js';

/** A proposal whose steps are a desktop step set. Same fields, digest and approval flow as a browser Proposal. */
export interface DesktopProposal extends Omit<Proposal, 'steps' | 'screenshots' | 'trace'> {
  steps: DesktopScript;
  screenshots: Record<string, never>;
}
/** A signed desktop step set, shaped as a row of the steps table. */
export interface SignedDesktopRow {
  name: string;
  version: number;
  steps: DesktopScript;
  hash: string;
  signature: string;
  approvedBy: string;
  approvedAt: string;
  status: 'active';
  /** The steps the owner declared writes at approval (1-based), in order. */
  writeSteps: number[];
}


/** Words that make a control look like it saves, posts or submits (matched on its name, automation id and the step's intent). */
const WRITE_WORDS = /\b(save|post|posting|submit|send|delete|remove|approve|release|book|pay|transfer|apply|confirm|commit|update|create|ok|yes)\b/i;
/**
 * Whether a text, read as words (`btnPost` → `btn Post`) and folded as the delete/cancel list folds it
 * (normalizeForDenylist: look-alike letters, accents, invisible characters, full-width forms), has a write word: the
 * runner's probe and repair-mode rule (WriteWords.Has folds the same way).
 */
export function hasWriteWord(text: string): boolean {
  return WRITE_WORDS.test(writeText(text));
}
/** `btnPost` → `btn Post`, `save_as` → `save as`: words a camel-case or snake-case id is made of. */
const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-]+/g, ' ');
/** A text as the write words are matched on: read as words, then folded. */
const writeText = (s: string): string => normalizeForDenylist(words(s));

/**
 * Plain navigation, as the runner's IsNavigationKey reads a chord: Tab (Shift+Tab too), or an arrow, Home, End, PageUp,
 * PageDown or Escape without Shift; never with Ctrl, Alt or Win. Any other key can press a button (Enter, Space, an
 * Alt mnemonic, Shift+F10, Delete, a save shortcut): such a key step is a candidate write.
 */
export function isNavigationKey(chord: string): boolean {
  const parts = chord.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  if (mods.some((m) => m === 'ctrl' || m === 'alt' || m === 'win')) return false;
  if (key === 'Tab') return true;
  return !mods.includes('shift') && ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(key);
}

/** The text a locator names (names and automation ids of every condition, primary and fallbacks). */
function locatorWords(loc: DesktopLocator): string {
  const conds = [loc.uia, ...(loc.fallbacks ?? []).map((f) => f.uia)].flatMap((t) => t.path);
  return conds.map((c) => `${c.name ?? ''} ${words(c.automationId ?? '')}`).join(' ');
}

/**
 * Whether a desktop step looks like a write the owner should consider declaring: a click or double click whose control
 * or intent reads like save, post, submit (and similar), or any key that is not plain navigation (isNavigationKey). A
 * hint for the reviewer, never a decision: nothing here sets `write`, and the runner's own policy is the floor.
 */
export function looksLikeWrite(step: DesktopStep): boolean {
  if ('click' in step) return WRITE_WORDS.test(writeText(step.intent)) || WRITE_WORDS.test(writeText(locatorWords(step.click)));
  if ('doubleClick' in step) return WRITE_WORDS.test(writeText(step.intent)) || WRITE_WORDS.test(writeText(locatorWords(step.doubleClick)));
  if ('key' in step) return !isNavigationKey(step.key.key);
  return false;
}

// ---- The repair's stop rule (DR9, DR10b): which steps a repair run-on and its proof run, from the steps alone. ----

/** A fill whose whole value is one secret variable (`{{var.password}}`): the only way a signed step types a secret. */
const SECRET_FILL_VALUE_RE = /^\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}$/;
/** A sign-in window's title (exact, never a pattern) has one of these. */
const SIGN_IN_TITLE = /\b(?:sign ?in|log ?in|login|logon)\b/i;
/** A sign-in button's own name is one of these, and nothing else. */
const SIGN_IN_BUTTON = /^\s*(?:sign ?in|log ?in|login|logon)\s*$/i;

/** What the stop rule knows: which variables are secrets, and which steps (0-based) the repair changed or added. */
export type DesktopStopOpts = { isSecretVar?: (name: string) => boolean; changed?: ReadonlySet<number> };
type StopOpts = DesktopStopOpts;
const sameJson = (a: unknown, b: unknown): boolean => {
  try { return canonicalize(a) === canonicalize(b); } catch { return false; }
};

/** The sign-in window of step i's sign-in, from the secret fill right before it (its field's window), or undefined. */
export function signInWindow(doc: DesktopScript, i: number): WindowSel | undefined {
  const prev = doc.steps[i - 1];
  return prev && 'fill' in prev ? prev.fill.field.uia.window : undefined;
}

/**
 * DR10 as tightened by DR10b: whether step `i` only signs in, judged on the steps (signInWindowClear judges the window
 * when the step is reached). True only for a step that is not a declared write and that the repair did not change
 * (`changed`), right after an unchanged fill whose whole value is one secret variable, whose field names its window by
 * an exact title (never a pattern) with a sign-in word (sign in, log in, login, logon), and that is one of:
 * - the key Enter whose target is that same field (the same locator, fallbacks included); a target-less Enter goes to
 *   whatever has the focus, so it is not exempt;
 * - a click on a button whose own name is a sign-in word (Sign in, Log in, Login, Logon), in that same window, by every
 *   candidate of its locator. OK, Submit and any other button are never exempt.
 * Anything else that looks like a write stops the repair and the proof (DR9). Without `isSecretVar` nothing is exempt.
 */
export function signsInOnly(doc: DesktopScript, i: number, o: StopOpts = {}): boolean {
  const step = doc.steps[i];
  const prev = doc.steps[i - 1];
  if (!o.isSecretVar || !step || !prev || step.write === true || prev.write === true || o.changed?.has(i) || o.changed?.has(i - 1)) return false;
  if (!('fill' in prev)) return false;
  const v = SECRET_FILL_VALUE_RE.exec(prev.fill.value);
  if (!v || !o.isSecretVar(v[1]!)) return false;
  const field = prev.fill.field;
  const win = field.uia.window;
  if (!win || typeof win.title !== 'string' || win.titlePattern !== undefined || !SIGN_IN_TITLE.test(win.title)) return false;
  if ('key' in step) return step.key.key === 'Enter' && step.key.target !== undefined && sameJson(step.key.target, field);
  if (!('click' in step)) return false;
  const candidates = [step.click.uia, ...(step.click.fallbacks ?? []).map((f) => f.uia)];
  return candidates.every((t) => {
    const own = t.path[t.path.length - 1];
    return sameJson(t.window, win) && own?.controlType === 'Button' && typeof own.name === 'string' && SIGN_IN_BUTTON.test(own.name);
  });
}

/**
 * The index of the first step at or after `from` that is a declared write or looks like one (looksLikeWrite: what the
 * review page flags as a candidate write), or the number of steps. Repair and proof run no such step: they resolve it.
 * A step that only signs in (signsInOnly) does not stop them here; signInChecks lists those, which run only when
 * signInWindowClear passes when they are reached.
 */
export function firstStopIndex(doc: DesktopScript, from = 0, o: StopOpts = {}): number {
  for (let i = from; i < doc.steps.length; i++) {
    const s = doc.steps[i]!;
    if (s.write === true) return i;
    if (looksLikeWrite(s) && !signsInOnly(doc, i, o)) return i;
  }
  return doc.steps.length;
}

/** The steps in [from, to) that look like a write but only sign in (signsInOnly): each runs only after signInWindowClear. */
export function signInChecks(doc: DesktopScript, from: number, to: number, o: StopOpts = {}): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (looksLikeWrite(doc.steps[i]!) && signsInOnly(doc, i, o)) out.push(i);
  return out;
}

/** Step numbers (1-based) of the steps that look like writes and are not declared ones. */
export function desktopWriteCandidates(script: DesktopScript): number[] {
  return script.steps.flatMap((s, i) => (s.write !== true && looksLikeWrite(s) ? [i + 1] : []));
}

const q = (v: string): string => oneLine(JSON.stringify(v));

function reviewWindow(w: WindowSel): string {
  return [
    w.exe !== undefined ? `app ${q(w.exe)}` : '', w.title !== undefined ? `title ${q(w.title)}` : '', w.titlePattern !== undefined ? `title matching ${q(w.titlePattern)}` : '',
    w.automationId !== undefined ? `id ${q(w.automationId)}` : '', w.className !== undefined ? `class ${q(w.className)}` : '',
  ].filter(Boolean).join(' ');
}
function reviewCond(c: UiaCond): string {
  return [
    c.controlType !== undefined ? q(c.controlType) : '', c.automationId !== undefined ? `id ${q(c.automationId)}` : '', c.name !== undefined ? `name ${q(c.name)}` : '',
    c.className !== undefined ? `class ${q(c.className)}` : '', c.index !== undefined ? `index ${c.index}` : '',
  ].filter(Boolean).join(' ');
}
function reviewTarget(t: UiaTarget): string {
  const path = t.path.map(reviewCond).join(' > ');
  return t.window ? `${path} in window ${reviewWindow(t.window)}` : path;
}
/** Every element a desktop locator may match, for a reviewer: the primary target, then each fallback, joined by " or ". */
export function reviewDesktopLocator(loc: DesktopLocator): string {
  return [loc.uia, ...(loc.fallbacks ?? []).map((f) => f.uia)].map(reviewTarget).join(' or ');
}

function desktopAction(step: DesktopStep): string {
  let s: string;
  if ('click' in step) s = `click ${reviewDesktopLocator(step.click)}`;
  else if ('doubleClick' in step) s = `double-click ${reviewDesktopLocator(step.doubleClick)}`;
  else if ('fill' in step) s = `type ${q(step.fill.value)} into ${reviewDesktopLocator(step.fill.field)}`;
  else if ('select' in step) s = `select ${q(step.select.option)} in ${reviewDesktopLocator(step.select.field)}`;
  else if ('check' in step) s = `${step.check.checked === false ? 'uncheck' : 'check'} ${reviewDesktopLocator(step.check.field)}`;
  else if ('waitFor' in step) s = `wait for ${reviewDesktopLocator(step.waitFor.target)} to be ${step.waitFor.state ?? 'visible'}`;
  else if ('read' in step) s = 'clipboard' in step.read ? `read the clipboard as ${q(step.read.as)}` : `read ${reviewDesktopLocator(step.read.target)} as ${q(step.read.as)}`;
  else if ('key' in step) s = `press ${q(step.key.key)}${step.key.target ? ` in ${reviewDesktopLocator(step.key.target)}` : ''}`;
  else if ('expectFile' in step) {
    const c = step.expectFile.check;
    const checks = c ? [c.name !== undefined ? `name ${q(c.name)}` : '', c.columns ? `columns ${c.columns.map(q).join(', ')}` : '', c.minRows !== undefined ? `at least ${c.minRows} rows` : '']
      .filter(Boolean).join('; ') : '';
    s = `return the file matching ${q(step.expectFile.pattern)} from the export folder${checks ? `; checks: ${checks}` : ''}`;
  } else s = desktopVerbOf(step);
  if ('expectFile' in step && step.expectFile.maxBytes !== undefined) s += `; at most ${step.expectFile.maxBytes} bytes`;
  if ('expectFile' in step && step.expectFile.mime) s += `; types ${step.expectFile.mime.map(q).join(', ')}`;
  if (step.when) s = `if ${reviewDesktopLocator(step.when.visible)} shows, ${s}`;
  // Every other field the signature covers is shown too, so the change list is the whole step.
  const more = [
    step.expect?.visible ? `then expect ${reviewDesktopLocator(step.expect.visible)} visible` : '',
    step.optional === true ? 'optional' : '', step.checkpoint === true ? 'checkpoint' : '',
    step.timeoutMs !== undefined ? `timeout ${step.timeoutMs} ms` : '',
  ].filter(Boolean);
  if (more.length) s += `; ${more.join('; ')}`;
  return step.write === true ? `${s}; declared write` : s;
}

/** A desktop step as the change list shows it: its intent and, in brackets, what it does. The action is the last bracketed group. */
export function describeDesktopStep(step: DesktopStep): string {
  return `${oneLine(step.intent)} (${desktopAction(step)})`;
}

/** The change list of a first version (no base): every step added, in order. */
export function desktopStepChanges(script: DesktopScript, mask: (s: string) => string = (s) => s): IntentChange[] {
  return script.steps.map((s) => ({ was: null, now: mask(describeDesktopStep(s)) }));
}

/** The evidence of a desktop proposal: nothing ran, so there are no rows and no file. */
export const DESKTOP_NO_EVIDENCE = { count: 0, total: null, diff: { missing: [] as string[], extra: [] as string[] } };

/**
 * Every safety-relevant fact of a desktop step set, from the steps alone (Sign Steps recomputes the same list): the app
 * it launches, each file it returns, each clipboard read, each declared write and each candidate write (looksLikeWrite)
 * the owner has not declared. Order: app, then the steps in order.
 */
export function desktopSafetyFlags(script: DesktopScript): string[] {
  const flags = [`desktop app: ${q(script.app.exe)}${script.app.args?.length ? ` with arguments ${script.app.args.map(q).join(' ')}` : ''}`];
  script.steps.forEach((s, i) => {
    const n = i + 1;
    if ('expectFile' in s) flags.push(`file returned to n8n: step ${n} returns the file matching ${q(s.expectFile.pattern)} from the run's export folder`);
    if ('read' in s && 'clipboard' in s.read) {
      flags.push(`clipboard read: step ${n} (${oneLine(s.intent)}) returns the clipboard's text to n8n as ${q(s.read.as)} (the desktop runner allows it only when its policy sets clipboardRead, only while the run's window is in front, and only for text the run's app copied in the last step that acted on it, at most 10 seconds earlier)`);
    }
    if (s.write === true) flags.push(`write: step ${n} (${oneLine(s.intent)}) is a declared write step`);
    // One clause per step. What marking a step as a write does (it passes the runner's write gate, which covers only the
    // controls and keys the runner's policy lists) is said once, beside the question, on the review page and in the email.
    else if (looksLikeWrite(s)) flags.push(`candidate write: step ${n} (${oneLine(s.intent)}) may save, post or submit`);
  });
  return flags;
}

/** The reviewable proposal for an imported desktop draft: version 1, no base, nothing replayed. */
export function desktopProposal(script: DesktopScript, mask: (s: string) => string = (s) => s): DesktopProposal {
  const steps = parseDesktopScript(script);
  return {
    name: steps.name ?? '',
    baseVersion: null,
    version: steps.version ?? 1,
    steps: script,
    hash: scriptHash(script),
    evidence: structuredClone(DESKTOP_NO_EVIDENCE),
    changes: desktopStepChanges(steps, mask),
    safetyFlags: desktopSafetyFlags(steps).map(mask),
    screenshots: {},
  };
}

export const WRITE_STEPS_INVALID = 'Write Steps must list step numbers, such as 7, 9';
export const writeStepOutOfRange = (n: number, count: number) => `Write Steps: there is no step ${n} (the steps are numbered 1 to ${count})`;
export const writeStepNotAllowed = (n: number, verb: string) => `Write Steps: step ${n} is a ${verb} step, which cannot be a write (only click, doubleClick, fill, select, check and key steps can)`;
export const DESKTOP_FLAGS_INCOMPLETE = 'the safety flags do not list the app, the returned files, the clipboard reads, the declared writes and the candidate writes the steps have';
export const DESKTOP_CHANGES_MISMATCH = 'the change list does not show every step of the steps, in order, as added';
export const DESKTOP_NEEDS_FIRST_VERSION = 'a desktop proposal without the proof of an AI repair must be a first version (no base version) that shows every step';
export const DESKTOP_REPAIR_VERSION = 'the version of repaired desktop steps must be higher than the version they were repaired from';
export const DESKTOP_PROOF_INVALID = "the proof of the desktop repair is malformed or does not fit the steps (steps replayed, the step it stopped at and why, the steps changed and added)";
export const DESKTOP_WRITES_PRESET = 'the reviewed steps already mark a write: writes are marked only when the steps are approved';
export const DESKTOP_EVIDENCE_INVALID = 'desktop steps are not replayed at import, so their evidence must be empty (no rows, no file)';

/** What a desktop repair's proof may say it stopped for (DesktopProofEvidence.stoppedBecause). */
const PROOF_STOPS: readonly unknown[] = ['declared write', 'looks like a write', 'held for approval'];

/**
 * Why a desktop repair's proof (evidence.proof, as the run reported it) cannot stand for steps of `count` steps, or
 * undefined. Shape and consistency only (the claims are the runner's, an accepted risk): exactly the five fields;
 * `replayed` a whole number up to the steps; `stoppedAt` null with nothing to stop for, or the step right after the
 * replayed ones with a known reason; `changedSteps` and `addedSteps` step numbers, ascending, without repeats, none in
 * both; and no claim past the first step the stop rule would stop at. The reviewer's line is built from these numbers,
 * so nothing else may ride along.
 */
export function desktopProofProblem(proof: unknown, script: DesktopScript): string | undefined {
  const count = script.steps.length;
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return DESKTOP_PROOF_INVALID;
  const p = proof as Record<string, unknown>;
  const keys = Object.keys(p).sort().join(',');
  if (keys !== 'addedSteps,changedSteps,replayed,stoppedAt,stoppedBecause') return DESKTOP_PROOF_INVALID;
  const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (!whole(p.replayed, 0, count)) return DESKTOP_PROOF_INVALID;
  if (p.stoppedAt === null) {
    if (p.stoppedBecause !== null || p.replayed !== count) return DESKTOP_PROOF_INVALID;
  } else if (!whole(p.stoppedAt, 1, count) || p.stoppedAt !== p.replayed + 1 || !PROOF_STOPS.includes(p.stoppedBecause)) return DESKTOP_PROOF_INVALID;
  const list = (v: unknown): v is number[] => Array.isArray(v) && v.every((n, i) => whole(n, 1, count) && (i === 0 || n > (v[i - 1] as number)));
  if (!list(p.changedSteps) || !list(p.addedSteps)) return DESKTOP_PROOF_INVALID;
  if (p.changedSteps.some((n) => (p.addedSteps as number[]).includes(n))) return DESKTOP_PROOF_INVALID;
  // The proof never runs past the first step the stop rule stops at (DR9, DR10b's structural part, any variable read
  // as a secret, the steps it says it changed or added counted as changed): it may not claim it did.
  const changed = new Set([...p.changedSteps, ...p.addedSteps].map((n) => n - 1));
  const stop = firstStopIndex(script, 0, { isSecretVar: () => true, changed });
  if (p.replayed > stop || (p.stoppedAt !== null && p.stoppedAt > stop + 1)) return DESKTOP_PROOF_INVALID;
  return undefined;
}

/** Write Steps as typed by the approver: step numbers separated by commas or spaces; '' or only spaces is none. */
export function parseWriteSteps(text: string): number[] | { error: string } {
  const parts = text.split(/[\s,;]+/).filter((p) => p !== '');
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,4}$/.test(p)) return { error: WRITE_STEPS_INVALID };
    const n = Number(p);
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/**
 * The steps with `write: true` added on the listed steps (1-based). Refuses a number outside the steps and a step whose
 * verb cannot be a write. Steps already declared writes keep their flag. The input is not changed.
 */
export function declareWrites(script: DesktopScript, writeSteps: number[]): { ok: true; script: DesktopScript } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const out = structuredClone(script);
  for (const n of writeSteps) {
    const step = Number.isInteger(n) && n >= 1 && n <= out.steps.length ? out.steps[n - 1] : undefined;
    if (!step) { reasons.push(writeStepOutOfRange(n, out.steps.length)); continue; }
    const verb = desktopVerbOf(step);
    if (!DESKTOP_WRITE_VERBS.has(verb)) { reasons.push(writeStepNotAllowed(n, verb)); continue; }
    step.write = true;
  }
  return reasons.length ? { ok: false, reasons } : { ok: true, script: out };
}

const sameSet = (a: string[], b: string[]): boolean => {
  const s = new Set(a);
  return s.size === a.length && a.length === b.length && b.every((x) => s.has(x));
};

/**
 * Re-checks a desktop proposal (an untrusted Repaired steps item) and signs it with the owner's declared writes. In
 * order: the review digest is required; the steps parse as a desktop step set with a name and version; the hash,
 * name, version and digest match what was reviewed; it is a first version (no base) without a proof, or an AI repair:
 * a higher version of its base with a well-formed proof (desktopProofProblem); the safety flags are exactly
 * desktopSafetyFlags of the steps and the change list is exactly desktopStepChanges of the steps (one entry per step,
 * in order: an unkeyed digest alone could hide a step); the evidence is empty apart from a repair's proof. Then Write Steps are added (declareWrites) and the result is signed with `pw-steps/2`, bound to the app
 * (sign.ts desktopBinding) and the approver. No Site Login is bound: desktop runs refuse one. Never throws.
 */
export function signDesktopSteps(input: {
  proposal: DesktopProposal;
  key: string;
  approverId: string;
  reviewedDigest: string;
  /** Step numbers (1-based) the owner declares writes, from Sign Steps' Write Steps. */
  writeSteps: number[];
  /** Values that must never be in an error reason (the signing key, Site Login secrets). */
  secrets?: (string | undefined)[];
  now?: Date;
}): { ok: true; row: SignedDesktopRow } | { ok: false; reasons: string[] } {
  const { proposal } = input;
  const masker = createMasker([input.key, ...(input.secrets ?? [])]);
  const fail = (reasons: string[]) => ({ ok: false as const, reasons: reasons.map((r) => masker.mask(r)) });
  if (typeof input.reviewedDigest !== 'string' || !input.reviewedDigest.trim()) return fail([NO_REVIEW_DIGEST]);
  let script: DesktopScript;
  try {
    script = parseDesktopScript(proposal.steps);
  } catch (err) {
    return fail([(err as Error).message]);
  }
  const { name, version } = script;
  if (name === undefined || version === undefined) return fail(['signing needs a name and a version']);
  const reasons: string[] = [];
  let hash = '';
  try {
    hash = scriptHash(proposal.steps);
  } catch {
    hash = '';
  }
  if (proposal.hash !== hash) reasons.push(STEPS_HASH_MISMATCH);
  if (name !== proposal.name) reasons.push(STEPS_NAME_MISMATCH);
  if (version !== proposal.version) reasons.push(STEPS_VERSION_MISMATCH);
  // An import is a first version, reviewed whole. An AI repair (version N+1 of base N) is reviewed whole too, as an
  // import is: every step listed as added, no write mark, and the proof of what ran in a fresh start of the app.
  const e = proposal.evidence as unknown as Record<string, unknown> | undefined;
  const proof = e !== undefined && e !== null && typeof e === 'object' ? e.proof : undefined;
  if (proposal.baseVersion === null) {
    if (proof !== undefined) reasons.push(DESKTOP_PROOF_INVALID);
  } else if (proof === undefined) reasons.push(DESKTOP_NEEDS_FIRST_VERSION);
  else {
    if (!Number.isInteger(proposal.baseVersion) || proposal.baseVersion < 1 || version <= proposal.baseVersion) reasons.push(DESKTOP_REPAIR_VERSION);
    const bad = desktopProofProblem(proof, script);
    if (bad) reasons.push(bad);
  }
  let digest = '';
  try {
    digest = proposalDigest(proposal);
  } catch {
    digest = '';
  }
  if (input.reviewedDigest !== digest) reasons.push(STEPS_CHANGED_AFTER_REVIEW);
  const flags = Array.isArray(proposal.safetyFlags) ? proposal.safetyFlags : [];
  if (!sameSet(flags.map(String), desktopSafetyFlags(script))) reasons.push(DESKTOP_FLAGS_INCOMPLETE);
  // The change list is the whole review: exactly one "added" entry per step, in order, each the step's own description
  // (a declared write says so). A partial, reordered or padded list could hide a step from the approver.
  const changes: unknown[] = Array.isArray(proposal.changes) ? proposal.changes : [];
  const expectedChanges = desktopStepChanges(script);
  const exact = changes.length === expectedChanges.length && changes.every((c, i) => {
    const e = c as { was?: unknown; now?: unknown } | null;
    return e !== null && typeof e === 'object' && e.was === null && e.now === expectedChanges[i].now;
  });
  if (!exact) reasons.push(DESKTOP_CHANGES_MISMATCH);
  const d = e?.diff as { missing?: unknown[]; extra?: unknown[] } | undefined;
  if (!e || e.count !== 0 || e.total !== null || Object.keys(e).some((k) => !['count', 'total', 'diff', 'proof'].includes(k)) || !d || d.missing?.length !== 0 || d.extra?.length !== 0) {
    reasons.push(DESKTOP_EVIDENCE_INVALID);
  }
  // The import never marks a write: a reviewed document that carries one did not come from it.
  if (script.steps.some((st) => Object.hasOwn(st, 'write'))) reasons.push(DESKTOP_WRITES_PRESET);
  if (!input.approverId.trim()) reasons.push('approver id is empty');
  if (!input.key.trim()) reasons.push('signing key is empty');
  const at = input.now ?? new Date();
  if (Number.isNaN(at.getTime())) reasons.push('approval time is invalid');
  const declared = declareWrites(script, input.writeSteps);
  if (!declared.ok) reasons.push(...declared.reasons);
  if (reasons.length || !declared.ok) return fail(reasons);
  // What is signed is the reviewed document plus the declared write flags: nothing else changes.
  const signedDoc = structuredClone(proposal.steps) as DesktopScript;
  for (const n of input.writeSteps) signedDoc.steps[n - 1].write = true;
  let signed: { hash: string; signature: string };
  try {
    parseDesktopScript(signedDoc);
    signed = signScript(signedDoc, input.key, { approvedBy: input.approverId });
  } catch (err) {
    return fail([(err as Error).message]);
  }
  return {
    ok: true,
    row: {
      name, version, steps: signedDoc, hash: signed.hash, signature: signed.signature, approvedBy: input.approverId, approvedAt: at.toISOString(), status: 'active',
      writeSteps: [...input.writeSteps].sort((a, b) => a - b),
    },
  };
}
