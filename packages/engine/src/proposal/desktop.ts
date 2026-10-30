// Review and signing of desktop step sets. A desktop draft (from an import) is not replayed: there is no desktop proof
// yet, so the approver reviews the steps as written. Its proposal lists every step, the app it launches, the files it
// returns, its declared writes and its candidate writes. The owner declares writes only when approving (Sign Steps'
// Write Steps): the import never sets `write: true`, and signDesktopSteps adds exactly the declared ones before signing.
import { STEPS_CHANGED_AFTER_REVIEW, STEPS_HASH_MISMATCH, STEPS_NAME_MISMATCH, STEPS_VERSION_MISMATCH } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { scriptHash, signScript } from '../sign.js';
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
/** Keys that can press a default button or save: Enter on a default button, the usual save shortcuts. */
const WRITE_KEYS = new Set(['Enter', 'Ctrl+Enter', 'Ctrl+S', 'Ctrl+Shift+S', 'F11']);
/** `btnPost` → `btn Post`, `save_as` → `save as`: words a camel-case or snake-case id is made of. */
const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-]+/g, ' ');

/** The text a locator names (names and automation ids of every condition, primary and fallbacks). */
function locatorWords(loc: DesktopLocator): string {
  const conds = [loc.uia, ...(loc.fallbacks ?? []).map((f) => f.uia)].flatMap((t) => t.path);
  return conds.map((c) => `${c.name ?? ''} ${words(c.automationId ?? '')}`).join(' ');
}

/**
 * Whether a desktop step looks like a write the owner should consider declaring: a click whose control or intent
 * reads like save, post, submit (and similar), or a key that can press a default button or save. A hint for the
 * reviewer, never a decision: nothing here sets `write`, and the runner's own policy is the floor.
 */
export function looksLikeWrite(step: DesktopStep): boolean {
  if ('click' in step) return WRITE_WORDS.test(words(step.intent)) || WRITE_WORDS.test(locatorWords(step.click));
  if ('key' in step) return WRITE_KEYS.has(step.key.key);
  return false;
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
      flags.push(`clipboard read: step ${n} (${oneLine(s.intent)}) returns the clipboard's text to n8n as ${q(s.read.as)} (the desktop runner allows it only when its policy sets clipboardRead, and only while the run's window is in front)`);
    }
    if (s.write === true) flags.push(`write: step ${n} (${oneLine(s.intent)}) is a declared write step`);
    else if (looksLikeWrite(s)) {
      // Plain about what listing does: it marks the step for the runner's write gate, which covers only the controls and
      // keys the runner's policy lists. It does not stop an unlisted step from saving through any other control.
      flags.push(
        `candidate write: step ${n} (${oneLine(s.intent)}) may save, post or submit: list ${n} in Write Steps if it does (the desktop runner refuses a write only on the controls and keys its policy lists, so leaving a step unlisted does not stop it from saving unless its control is in the runner policy)`,
      );
    }
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
export const writeStepNotAllowed = (n: number, verb: string) => `Write Steps: step ${n} is a ${verb} step, which cannot be a write (only click, fill, select, check and key steps can)`;
export const DESKTOP_FLAGS_INCOMPLETE = 'the safety flags do not list the app, the returned files, the clipboard reads, the declared writes and the candidate writes the steps have';
export const DESKTOP_CHANGES_MISMATCH = 'the change list does not show every step of the steps, in order, as added';
export const DESKTOP_NEEDS_FIRST_VERSION = 'desktop steps have no repair yet, so a desktop proposal must be a first version (no base version) that shows every step';
export const DESKTOP_WRITES_PRESET = 'the reviewed steps already mark a write: only Write Steps, chosen when you approve, declares writes';
export const DESKTOP_EVIDENCE_INVALID = 'desktop steps are not replayed at import, so their evidence must be empty (no rows, no file)';

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
 * name, version and digest match what was reviewed; it is a first version (no base); the safety flags are exactly
 * desktopSafetyFlags of the steps and the change list is exactly desktopStepChanges of the steps (one entry per step,
 * in order: an unkeyed digest alone could hide a step); the evidence is empty. Then Write Steps are added (declareWrites) and the result is signed with `pw-steps/2`, bound to the app
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
  // Desktop steps have no repair yet: every desktop proposal is a first version, reviewed whole.
  if (proposal.baseVersion !== null) reasons.push(DESKTOP_NEEDS_FIRST_VERSION);
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
  const e = proposal.evidence as unknown as Record<string, unknown> | undefined;
  const d = e?.diff as { missing?: unknown[]; extra?: unknown[] } | undefined;
  if (!e || e.count !== 0 || e.total !== null || e.file !== undefined || e.readPosts !== undefined || !d || d.missing?.length !== 0 || d.extra?.length !== 0) {
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
