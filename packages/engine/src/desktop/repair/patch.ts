import { oneLine } from '../../proposal/describe.js';
import { parseDesktopScript } from '../../steps/parse.js';
import type { DesktopLocator, DesktopScript, DesktopStep } from '../../types.js';

/** A repair fix would break a patch invariant; the message is engine text. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/** Menu-opening base steps one fix may fold away. */
export const FOLD_MAX = 2;
/** Steps one fix may add before the failed step. */
export const DESKTOP_MAX_INSERTED_PER_FIX = 3;
const MAX_NAME = 80;

/** Where the error came from: the handler's resolve or act (`waitFor`'s target included), or `checkExpect`. */
export type FailedPart = 'target' | 'expect';

/** What the repair agent did, in order, that the new step set must keep. */
export type Recorded =
  | { kind: 'openMenu'; loc: DesktopLocator; name: string }
  | { kind: 'select'; loc: DesktopLocator; name: string }
  | { kind: 'escape' }
  | { kind: 'inserted'; loc: DesktopLocator; name: string };

/** Why a declared write step is never repaired (engine text; the repair gives up with it). */
export const WRITE_STEP_NOT_REPAIRED = 'it is a declared write step, and AI repair never changes a write step: update it by hand';
/** Why a fill of a secret variable is never repaired. */
export const SECRET_FILL_NOT_REPAIRED = 'it types a secret variable, and AI repair never moves a secret fill onto another control: update it by hand';

const VAR_REF = /\{\{\s*var\.([A-Za-z0-9_]+)\s*\}\}/g;

/** Whether a step types (or chooses) the value of a secret variable: a fill or select whose value names one. */
export function isSecretFill(step: DesktopStep, isSecretVar: (name: string) => boolean): boolean {
  const template = 'fill' in step ? step.fill.value : 'select' in step ? step.select.option : undefined;
  if (typeof template !== 'string') return false;
  return [...template.matchAll(VAR_REF)].some((m) => isSecretVar(m[1]));
}

/**
 * Why a step may not be repaired at all (DR2), or undefined: a declared write step, or a fill of a secret variable.
 * `isSecretVar` defaults to "every variable is secret", so a caller that does not know the run's secrets fails closed.
 */
export function unrepairable(step: DesktopStep, isSecretVar: (name: string) => boolean = () => true): string | undefined {
  if (step.write === true) return WRITE_STEP_NOT_REPAIRED;
  if (isSecretFill(step, isSecretVar)) return SECRET_FILL_NOT_REPAIRED;
  return undefined;
}

/**
 * The step with one locator replaced: the verb's own locator, or `expect.visible`. Every other field stays. A declared
 * write step and a secret fill are refused (PatchError): AI repair never moves either. A clipboard read and a key without
 * a target have no locator to replace.
 */
export function retargetStep(step: DesktopStep, part: FailedPart, loc: DesktopLocator, isSecretVar?: (name: string) => boolean): DesktopStep {
  const refused = unrepairable(step, isSecretVar);
  if (refused) throw new PatchError(refused);
  const next = structuredClone(step);
  if (part === 'expect') {
    next.expect = { ...next.expect, visible: loc };
    return next;
  }
  if ('click' in next) next.click = loc;
  else if ('doubleClick' in next) next.doubleClick = loc;
  else if ('fill' in next) next.fill.field = loc;
  else if ('select' in next) next.select.field = loc;
  else if ('check' in next) next.check.field = loc;
  else if ('waitFor' in next) next.waitFor.target = loc;
  else if ('read' in next) {
    if (!('target' in next.read)) throw new PatchError('a clipboard read has no locator to replace');
    next.read.target = loc;
  }
  else if ('key' in next) {
    if (!next.key.target) throw new PatchError('a key step without a target has no locator to replace');
    next.key.target = loc;
  } else throw new PatchError('an expectFile step has no locator to replace');
  return next;
}

/** An intent in the importer's wording, from a masked, clipped, one-line control name. */
export function desktopIntent(step: DesktopStep, controlName: string, mask: (s: string) => string): string {
  const name = oneLine(Array.from(mask(controlName)).slice(0, MAX_NAME).join(''));
  if ('click' in step) return `Click ${name}`;
  if ('doubleClick' in step) return `Double-click ${name}`;
  if ('fill' in step) return `Type into ${name}`;
  if ('select' in step) return `Choose ${oneLine(step.select.option)} in ${name}`;
  if ('check' in step) return `${step.check.checked === false ? 'Uncheck' : 'Check'} ${name}`;
  if ('waitFor' in step) return `Wait for ${name}`;
  if ('read' in step) return `Read ${name} as ${oneLine(step.read.as)}`;
  if ('key' in step) return step.key.target ? `Press ${oneLine(step.key.key)} in ${name}` : `Press ${oneLine(step.key.key)}`;
  return step.intent;
}

const isFoldable = (s: DesktopStep | undefined): boolean => {
  if (!s || !('click' in s) || s.write) return false;
  if (Object.keys(s).some((k) => k !== 'intent' && k !== 'click')) return false;
  return s.click.uia.path.at(-1)?.controlType === 'MenuItem';
};

/**
 * Replaces `doc.steps[from..failedIndex]` with the recorded steps and the failed step (retargeted when `loc` is set).
 * An expanded menu becomes a click, an Escape pops the last open menu; with none open it folds the menu-opening step
 * just before the range when it is a plain click (intent and click only; at most FOLD_MAX), else it stays as a key step.
 */
export function compileFix(
  doc: DesktopScript,
  fix: { failedIndex: number; part: FailedPart; loc?: DesktopLocator; targetName?: string; recorded: Recorded[]; isSecretVar?: (name: string) => boolean },
  mask: (s: string) => string,
): { doc: DesktopScript; from: number; retargetedIndex: number } {
  const base = doc.steps[fix.failedIndex];
  if (!base) throw new PatchError(`step ${fix.failedIndex} does not exist`);
  // DR2: a failed write step is never repaired, not even by a step inserted before it.
  if (base.write === true) throw new PatchError(WRITE_STEP_NOT_REPAIRED);
  let from = fix.failedIndex;
  let folded = 0;
  const kept: Recorded[] = [];
  const open: Recorded[] = [];
  for (const r of fix.recorded) {
    if (r.kind === 'openMenu') {
      kept.push(r);
      open.push(r);
    } else if (r.kind === 'escape') {
      const last = open.pop();
      if (last) kept.splice(kept.indexOf(last), 1);
      else if (kept.length === 0 && folded < FOLD_MAX && from > 0 && isFoldable(doc.steps[from - 1])) {
        from -= 1;
        folded += 1;
      } else kept.push(r);
    } else kept.push(r);
  }
  if (kept.length > DESKTOP_MAX_INSERTED_PER_FIX) throw new PatchError(`a fix may add at most ${DESKTOP_MAX_INSERTED_PER_FIX} steps`);
  for (let i = from; i < fix.failedIndex; i++) {
    if (doc.steps[i]?.write) throw new PatchError('a folded step is a write');
  }
  const added = kept.map((r): DesktopStep =>
    r.kind === 'escape'
      ? { intent: 'Press Escape', key: { key: 'Escape' } }
      : { intent: desktopIntent({ intent: '', click: r.loc }, r.name, mask), click: r.loc },
  );
  if (added.some((s) => s.write !== undefined)) throw new PatchError('an inserted step carries write');
  let failed = base;
  if (fix.loc) {
    failed = retargetStep(base, fix.part, fix.loc, fix.isSecretVar);
    if (fix.part === 'target') failed.intent = desktopIntent(failed, fix.targetName ?? fix.loc.uia.path.at(-1)?.name ?? 'the element', mask);
    if (failed.write !== base.write) throw new PatchError('the retargeted step changed its write flag');
  }
  const next = structuredClone(doc);
  next.steps.splice(from, fix.failedIndex - from + 1, ...added, failed);
  return { doc: parseDesktopScript(next), from, retargetedIndex: from + added.length };
}
