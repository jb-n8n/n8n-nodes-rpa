import { stablePath } from '../steps/urls.js';
import type { AgentAction } from '../agent/tools.js';
import { loginDetectIndex, signInIndex } from '../policy/login-block.js';
import { flattenSteps, loginBlockEnd, validateScript } from '../policy/validate.js';
import { COMPILE_CHANGES_FILE_CHECK, COMPILE_EMITS_SUBMIT, COMPILE_TOUCHES_SUBMIT } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { canonicalize } from '../sign.js';
import { parseScript, ScriptShapeError } from '../steps/parse.js';
import type { DownloadTemplate } from '../steps/file-check.js';
import type { Interrupt, Locator, PortalPolicy, PortalSecrets, Script, Step } from '../types.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

export const PAGINATE_MAX = 20;
export const PAGINATE_NEXT_WAIT_MS = 1500;
/** The DSL's upper bound for paginate.max, and the pages of headroom over what the agent saw. */
const PAGINATE_LIMIT = 100;
const PAGINATE_HEADROOM = 5;
const NAV_TOOLS = new Set(['click', 'next_page']);
/** Safety flag: the base script read per-item fields that the compiled script no longer reads (v1 repair records no field extraction). */
export const EXTRACT_FIELDS_DROPPED = 'extract-fields-dropped';

/** True when any extract step (including those nested in paginate) reads items or named fields. */
export function extractsFields(steps: Step[]): boolean {
  return flattenSteps(steps).some((s) => 'extract' in s && (s.extract.item !== undefined || s.extract.fields !== undefined));
}

/** True when the step, or a step nested in it (paginate bodies), submits a form: a submit, or a download through a form. */
function submitsForm(step: Step): boolean {
  return flattenSteps([step]).some((s) => 'submit' in s || ('download' in s && s.download.via !== undefined));
}

export interface CompileInput {
  base?: Script;
  /** Index of the last base step to keep; -1 keeps none. */
  resumeFrom: number;
  actions: AgentAction[];
  /** Repaired steps are named `steps.name ?? Options → Name`; absent when neither is set. */
  name?: string;
  startUrl: string;
  version: number;
  policy: PortalPolicy;
  /** Site Login secrets; absent without a Site Login. */
  secrets?: PortalSecrets;
  /** Main-frame navigations seen in the healing session (Session.navigations). */
  observedNavigations: string[];
  /** The run's variables (raw ctx.vars, never the sanitized prompt values): typed values equal to exactly one become {{var.<name>}}. */
  vars?: Record<string, string>;
  /** A file task's template: the compiled download step must carry exactly these checks. */
  download?: DownloadTemplate;
  /**
   * The base download step at `index` (resumeFrom + 1) clicked its trigger before it failed, and the agent went on from
   * the page that click left (a format dialog, say): compile replays that click as a plain base-derived click step in
   * place of the old download, before the agent's steps (agent-lane triggerClickToKeep).
   */
  keepTriggerClick?: { index: number };
}
export interface CompileResult {
  script: Script;
  safetyFlags: string[];
  /** Index of the first step built from the agent's actions. */
  suffixFrom: number;
  /**
   * Set when compile re-anchored the login block's detect after that detect was what failed: the step where prove
   * resumes the session captured right before it, so the new detect runs in the fresh browser too.
   */
  resumeAt?: number;
}
export class CompileError extends Error {
  constructor(readonly issues: string[]) {
    super(`compile failed: ${issues.join('; ')}`);
    this.name = 'CompileError';
  }
}

const clone = <T>(v: T): T => structuredClone(v);
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return ''; } };
const sameStep = (a?: Step, b?: Step) => a !== undefined && b !== undefined && canonicalize(a) === canonicalize(b);
const BACK_ERROR = 'a "back" that does not undo a click cannot be compiled';

/**
 * Undoes a dead end: drops the actions taken on the abandoned page, back to and including the navigating click that
 * left the page `back` returns to (action urls are the page an action started on). Overlay dismisses are kept (their
 * interrupts stay valid) and a sign-in is never undone.
 * - `one-level` (a back followed by another back): the most recent navigating click, whatever page it started on.
 * - a landing url (the last back of a run, with a later action): the most recent click that started on that page.
 * - `undefined` (the last back, with nothing after it): the most recent click that started on another page than the one
 *   `back` left.
 */
function undoBack(kept: AgentAction[], back: AgentAction, landing: string | 'one-level' | undefined): void {
  const overlays: AgentAction[] = [];
  const undoes = (x: AgentAction) => landing === 'one-level' || (landing === undefined ? x.url !== back.url : x.url === landing);
  while (kept.length) {
    const x = kept.pop()!;
    if (x.tool === 'sign_in' || x.tool === 'enter_code') throw new CompileError(['a "back" cannot undo a sign-in']);
    if (x.tool === 'dismiss' && x.interrupt) { overlays.unshift(x); continue; }
    if (NAV_TOOLS.has(x.tool) && undoes(x)) {
      kept.push(...overlays);
      return;
    }
  }
  throw new CompileError([BACK_ERROR]);
}

/** Intents for login steps compile changed: the second applies when the base already used the first. */
const SIGN_IN_WITH_CODE = ['Sign in with an authentication code', 'Sign in with an updated authentication code'] as const;
const DETECT_AFTER_CODE = ['Check sign-in worked (after the code)', 'Check sign-in worked (after the updated code)'] as const;
const DETECT_NEW_LANDMARK = ['Check sign-in worked (new page after sign-in)', 'Check sign-in worked (updated page after sign-in)'] as const;
/** A new intent for a changed step: always different from the old one, so the change list cannot hide the change. */
const renamed = (old: string, names: readonly [string, string]) => (old === names[0] ? names[1] : names[0]);
/** Anchors a detect's logged_in check on `click` and renames it, so the approver's change list shows the new check. */
function reanchorDetect(detect: S<'detect'>, click: Locator, names: readonly [string, string]): void {
  detect.detect.checks = { ...detect.detect.checks, logged_in: clone(click) };
  detect.intent = renamed(detect.intent, names);
}

/** The intent of a kept download trigger click: names the control without implying a download (it opened something). */
function openIntent(trigger: Locator): string {
  const name = 'role' in trigger ? trigger.name : 'label' in trigger ? trigger.label : 'text' in trigger ? trigger.text : undefined;
  const shown = name?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return shown ? `Open ${shown}` : 'Open the download options';
}

/** A plain navigation click: the only kind of action an exploration loop may contain. */
const isNavClick = (a: AgentAction) => a.tool === 'click' && !!a.step && 'click' in a.step && !a.step.when;

/**
 * Cuts exploration loops: a run of 2 or more plain navigation clicks that starts and ends on an identical page
 * state (same full URL, title, page text, snapshot elements and their ARIA states, as the agent saw them) and passes
 * through at least one different state is dropped, so the next action runs on the page it was recorded on. Only clicks are ever cut: a sign-in, code, dismiss, fill, select, expand, extract or next_page ends the
 * run, and an action without a recorded page state never matches. The longest loop from each position is cut.
 */
function pruneLoops(kept: AgentAction[]): void {
  for (let i = 0; i < kept.length; i++) {
    const state = kept[i].pageState;
    if (!state || !isNavClick(kept[i])) continue;
    let end = -1;
    let leftState = false;
    for (let j = i + 1; j < kept.length; j++) {
      // A cut needs 2 or more clicks that passed through at least one different state: a single click (or a run)
      // that seemed to change nothing may still have changed something the fingerprint cannot see.
      if (kept[j].pageState === state && j - i >= 2 && leftState) end = j;
      if (kept[j].pageState !== state) leftState = true;
      if (!isNavClick(kept[j])) break;
    }
    if (end > i) kept.splice(i, end - i);
  }
}

/**
 * In a run of consecutive fill/select steps from `from` on, an earlier fill (or select) of a field (same verb, same
 * canonical locator) is dropped only when every field filled between it and the field's next fill is filled again after
 * that next fill (nothing typed in between could have depended on the earlier value); otherwise both stay. Steps never
 * move. Any other step, or a fill or select gated with `when`, ends the run; steps before `from` (the base's) are never
 * touched. Mutates `steps`.
 */
function collapseRepeatedFills(steps: Step[], from: number): void {
  const key = (s: Step) => (s.when ? undefined : 'fill' in s ? `fill:${canonicalize(s.fill.field)}` : 'select' in s ? `select:${canonicalize(s.select.field)}` : undefined);
  const out: Step[] = steps.slice(0, from);
  let run: Step[] = [];
  const flush = () => {
    const keys = run.map((s) => key(s)!);
    run.forEach((s, i) => {
      const next = keys.indexOf(keys[i], i + 1);
      const redundant = next > i && keys.slice(i + 1, next).every((k) => keys.indexOf(k, next + 1) > next);
      if (!redundant) out.push(s);
    });
    run = [];
  };
  for (let i = from; i < steps.length; i++) {
    if (key(steps[i])) run.push(steps[i]);
    else {
      flush();
      out.push(steps[i]);
    }
  }
  flush();
  steps.splice(0, steps.length, ...out);
}

/**
 * Records typed values as run variables: from top-level step `from` on, a fill or select value that equals exactly
 * one variable's raw value becomes `{{var.<name>}}`. Empty values and values equal to two or more variables stay literal.
 * Mutates `steps`; nested paginate steps are not visited. Used by compile and by the import draft builder.
 */
export function substituteVars(steps: Step[], vars: Record<string, string>, from: number): void {
  const entries = Object.entries(vars);
  for (let i = from; i < steps.length; i++) {
    const s = steps[i];
    const typed = 'fill' in s ? s.fill : 'select' in s ? s.select : undefined;
    if (!typed || !typed.value) continue;
    const hits = entries.filter(([, v]) => v === typed.value);
    if (hits.length === 1) typed.value = `{{var.${hits[0][0]}}}`;
  }
}

/** Deterministically turns the agent's recorded actions into a candidate script and checks it like any proposal. */
export function compileProposal(input: CompileInput): CompileResult {
  const masker = createMasker([input.secrets?.username, input.secrets?.password, input.secrets?.totpSecret]);
  try {
    return compile(input);
  } catch (err) {
    // Compile errors never carry a secret, whatever produced them.
    if (err instanceof CompileError) throw new CompileError(err.issues.map((i) => masker.mask(i)));
    throw new CompileError([masker.mask(err instanceof Error ? err.message : String(err))]);
  }
}

function compile(input: CompileInput): CompileResult {
  // 1. Dead ends and repeats.
  const kept: AgentAction[] = [];
  const useful = input.actions.filter((a) => a.ok && a.tool !== 'look' && a.tool !== 'done');
  // Defence in depth behind the repair refusal: repaired steps never contain a form submission.
  if (useful.some((a) => a.step !== undefined && submitsForm(a.step))) throw new CompileError([COMPILE_EMITS_SUBMIT]);
  for (let i = 0; i < useful.length; i++) {
    const a = useful[i];
    const prev = kept[kept.length - 1];
    if (a.tool === 'back') {
      if (!prev) throw new CompileError([BACK_ERROR]);
      const landing = useful[i + 1]?.tool === 'back' ? 'one-level' : useful[i + 1]?.url;
      undoBack(kept, a, landing);
      continue;
    }
    if (a.tool === 'click' && prev?.tool === 'click' && sameStep(prev.step, a.step)) continue;
    kept.push(a);
  }
  pruneLoops(kept);

  // 2. Proven prefix and interrupts.
  const { base, resumeFrom } = input;
  if (!base) {
    if (resumeFrom !== -1) throw new CompileError(['resumeFrom needs a base script']);
  } else if (!Number.isInteger(resumeFrom) || resumeFrom < -1 || resumeFrom >= base.steps.length) {
    throw new CompileError([`resumeFrom must be an integer from -1 to ${base.steps.length - 1}`]);
  }
  let steps: Step[] = base ? clone(base.steps.slice(0, resumeFrom + 1)) : [];
  // An agent that restarted inside or before the login block without signing in relies on the base's login.
  const loginEnd = base ? loginBlockEnd(base) : -1;
  if (base && loginEnd >= 0 && steps.length <= loginEnd && !kept.some((a) => a.tool === 'sign_in')) {
    steps = clone(base.steps.slice(0, loginEnd + 1));
  }
  // 2a. The failed download's trigger click opened what the agent then used: it is replayed as a click (keepTriggerClick).
  let keptClickAt = -1;
  if (input.keepTriggerClick) {
    const at = input.keepTriggerClick.index;
    const failed = base?.steps[at];
    if (!base || !failed || !('download' in failed) || failed.download.via !== undefined || at !== resumeFrom + 1 || steps.length !== at || at <= loginEnd) {
      throw new CompileError(['the trigger click to keep must belong to the base download step right after the kept steps']);
    }
    // Only the trigger is kept: the base step's when/timeoutMs/expect described a download step, so they are deliberately not copied.
    steps.push({ intent: openIntent(failed.download.trigger), click: clone(failed.download.trigger) });
    keptClickAt = at;
  }
  let suffixFrom = steps.length;
  const interrupts: Interrupt[] = clone(input.base?.interrupts ?? []);
  const addInterrupt = (it: Interrupt) => {
    if (!interrupts.some((x) => canonicalize(x) === canonicalize(it))) interrupts.push(clone(it));
  };
  /** From kept[from]: the run of enter_code and dismiss actions after a sign-in. Folds the code, collects interstitials. */
  const afterSignIn = (from: number, signIn: S<'signIn'>, replaceTotp: boolean) => {
    const interstitials: Step[] = [];
    let j = from;
    let folded = false;
    while (j < kept.length && (kept[j].tool === 'enter_code' || (kept[j].tool === 'dismiss' && (kept[j].step || kept[j].interrupt)))) {
      const x = kept[j];
      if (x.tool === 'enter_code' && x.totp && (!signIn.signIn.totp || (replaceTotp && !folded))) {
        signIn.signIn.totp = clone(x.totp);
        folded = true;
      }
      if (x.tool === 'dismiss' && x.interrupt) addInterrupt(x.interrupt);
      else if (x.tool === 'dismiss' && x.step) interstitials.push(clone(x.step));
      j++;
    }
    const after = kept.slice(j).find((x) => NAV_TOOLS.has(x.tool));
    const afterClick = after?.step && 'click' in after.step ? after.step.click : undefined;
    return { interstitials, next: j, afterClick };
  };

  // 2b. The release added an authentication code after the base sign-in: the base login block replayed, the
  // code page appeared, and the agent entered the code without a sign_in of its own. The code belongs to the base
  // signIn (generated at run time from the TOTP secret, never a literal); interstitials go after the login block's
  // own conditional steps, and the detect is re-anchored on the first click after the code, as for a recorded sign-in.
  let k0 = 0;
  const signInAt = base ? signInIndex(base) : -1;
  let resumeAt: number | undefined;
  // Only when the agent restarted inside (or before) the login block: with resumeFrom === loginEnd (the detect passed) or
  // an escalation (compileFrom = loginEnd), the base login already completed and a code is not the base sign-in's.
  if (base && signInAt >= 0 && resumeFrom < loginEnd && steps.length === loginEnd + 1 && !kept.some((a) => a.tool === 'sign_in')) {
    // Overlays and interstitials the agent dismissed before the code count too: afterSignIn takes them in any order.
    let first = 0;
    while (first < kept.length && kept[first].tool === 'dismiss' && (kept[first].interrupt || kept[first].step)) first++;
    if (kept[first]?.tool === 'enter_code') {
      const signIn = clone(steps[signInAt]) as S<'signIn'>;
      const { interstitials, next, afterClick } = afterSignIn(0, signIn, true);
      const block = steps.slice(signInAt + 1, loginEnd + 1);
      const last = block[block.length - 1];
      const own = last && 'detect' in last ? block.slice(0, -1) : block;
      let detect: Step | undefined = last && 'detect' in last ? clone(last) : undefined;
      if (detect && 'detect' in detect && afterClick) reanchorDetect(detect, afterClick, DETECT_AFTER_CODE);
      if (!detect && afterClick) {
        detect = {
          intent: DETECT_AFTER_CODE[0],
          detect: { name: 'afterLogin', checks: { logged_in: clone(afterClick), login_failed: clone(signIn.signIn.password) }, require: 'logged_in' },
        };
      }
      // A changed login step gets a new intent, so the intent-based change list shows the approver was → now.
      if (canonicalize(signIn) !== canonicalize(steps[signInAt])) signIn.intent = renamed(signIn.intent, SIGN_IN_WITH_CODE);
      steps = [...steps.slice(0, signInAt), signIn, ...own, ...interstitials, ...(detect ? [detect] : [])];
      // The agent changed the login block: prove must replay it in full.
      suffixFrom = signInAt;
      k0 = next;
    } else if (resumeFrom === loginEnd - 1 && loginDetectIndex(base, loginEnd) === loginEnd) {
      // 2c. The base sign-in went through but its detect failed: the release hid the logged-in landmark (a nav
      // behind a menu button, say). The agent went on from the healing session without signing in again. Kept as is, the
      // old detect fails again on the next run, so it is re-anchored on the first click after sign-in, with the
      // interstitials the agent dismissed before it. The sign-in and its own steps stay the base's: prove resumes the
      // healing session right before the detect (prove-run.ts) and runs everything from there.
      // afterSignIn folds codes into a sign-in; this branch keeps the base one (a leading code went to 2b), so a scratch copy.
      const scratch = clone(steps[signInAt]) as S<'signIn'>;
      const { interstitials, next, afterClick } = afterSignIn(0, scratch, false);
      if (!afterClick) throw new CompileError(['cannot tell what a successful sign-in looks like: nothing was clicked after signing in']);
      const detect = clone(steps[loginEnd]) as S<'detect'>;
      reanchorDetect(detect, afterClick, DETECT_NEW_LANDMARK);
      steps = [...steps.slice(0, loginEnd), ...interstitials, detect];
      suffixFrom = loginEnd;
      resumeAt = loginEnd;
      k0 = next;
    }
  }

  // 3. Repaired suffix.
  for (let k = k0; k < kept.length; k++) {
    const a = kept[k];
    if (a.tool === 'sign_in') {
      if (!a.step || !('signIn' in a.step)) throw new CompileError(['a sign-in action has no recorded step']);
      const signIn = clone(a.step) as S<'signIn'>;
      const { interstitials, next: j, afterClick } = afterSignIn(k + 1, signIn, false);
      if (!afterClick) throw new CompileError(['cannot tell what a successful sign-in looks like: nothing was clicked after signing in']);
      steps.push(signIn, ...interstitials, {
        intent: 'Check sign-in worked',
        detect: { name: 'afterLogin', checks: { logged_in: clone(afterClick), login_failed: clone(signIn.signIn.password) }, require: 'logged_in' },
      });
      k = j - 1;
      continue;
    }
    if (a.tool === 'enter_code') throw new CompileError(['an authentication code was entered without a sign-in step to attach it to']);
    if (a.tool === 'dismiss') {
      if (a.interrupt) addInterrupt(a.interrupt);
      else if (a.step) steps.push(clone(a.step));
      continue;
    }
    if (a.tool === 'extract' && a.step && 'extract' in a.step) {
      const body = clone(a.step);
      // The run of next_page actions (each optionally followed by a same-scope extract) that follows this extract.
      const run: Step[] = [];
      const nexts: Locator[] = [];
      let n = k + 1;
      for (let np = kept[n]?.step; n < kept.length && kept[n].tool === 'next_page' && np && 'click' in np; np = kept[n]?.step) {
        nexts.push(np.click);
        run.push(np);
        n++;
        const ex = kept[n]?.step;
        if (kept[n]?.tool === 'extract' && ex && 'extract' in ex && canonicalize(ex.extract) === canonicalize(body.extract)) {
          run.push(ex);
          n++;
        }
      }
      if (nexts.length === 0) {
        steps.push(body);
        continue;
      }
      if (nexts.every((l) => canonicalize(l) === canonicalize(nexts[0]))) {
        const pagesSeen = nexts.length + 1;
        const max = Math.min(PAGINATE_LIMIT, Math.max(PAGINATE_MAX, pagesSeen + PAGINATE_HEADROOM));
        steps.push({ intent: 'Read every page', paginate: { next: clone(nexts[0]), until: 'absent', max, nextWaitMs: PAGINATE_NEXT_WAIT_MS, each: [body] } });
      } else {
        // The next control changed between pages (e.g. numbered page links): replay what the agent did, page by page.
        steps.push(body, ...run.map(clone));
      }
      k = n - 1;
      continue;
    }
    if (a.step) steps.push(clone(a.step));
  }
  if (steps.length === suffixFrom) throw new CompileError(['the agent recorded no steps']);
  collapseRepeatedFills(steps, suffixFrom);

  // 3b. Values the agent typed that equal exactly one run variable are recorded as that variable. Raw vars, base steps untouched.
  if (input.vars) substituteVars(steps, input.vars, suffixFrom);

  // 4. Checkpoint the step that leads to the rows or the file.
  const firstRead = steps.findIndex((s, i) => i >= suffixFrom && ('extract' in s || 'paginate' in s || 'download' in s));
  const readAt = stablePath(pathOf(kept.find((a) => a.tool === 'extract' || a.tool === 'download')?.url ?? ''));
  // A kept trigger click leads to the file too: it gets the checkpoint when the agent clicked nothing before the download.
  const checkFrom = keptClickAt >= 0 ? keptClickAt : suffixFrom;
  if (firstRead > checkFrom && readAt) {
    for (let i = firstRead - 1; i >= checkFrom; i--) {
      const s = steps[i];
      if ('click' in s && !s.when) {
        s.checkpoint = true;
        s.expect = { ...(s.expect ?? {}), url: readAt };
        break;
      }
    }
  }

  // Every base form submission must survive unchanged inside the kept prefix: a repair may not drop, move or rebuild it.
  if (base) {
    for (let i = 0; i < base.steps.length; i++) {
      if (submitsForm(base.steps[i]) && (i >= suffixFrom || !sameStep(steps[i], base.steps[i]))) throw new CompileError([COMPILE_TOUCHES_SUBMIT]);
    }
  }

  // A repair may not change the author's signed file checks: the one download must carry the hand-off template.
  if (input.download) {
    const downloads = flattenSteps(steps).filter((s): s is S<'download'> => 'download' in s);
    const { mime, maxBytes, check } = input.download;
    const want = canonicalize({ ...(mime !== undefined ? { mime } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}), check });
    const got = downloads.length === 1
      ? canonicalize({ ...(downloads[0].download.mime !== undefined ? { mime: downloads[0].download.mime } : {}), ...(downloads[0].download.maxBytes !== undefined ? { maxBytes: downloads[0].download.maxBytes } : {}), check: downloads[0].download.check })
      : undefined;
    if (got !== want) throw new CompileError([COMPILE_CHANGES_FILE_CHECK]);
  }

  // 5. Same checks as any proposal.
  const script: Script = { ...(input.name ? { name: input.name } : {}), version: input.version, startUrl: input.startUrl, ...(interrupts.length ? { interrupts } : {}), steps };
  let parsed: Script;
  try {
    parsed = parseScript(script);
  } catch (err) {
    throw new CompileError(err instanceof ScriptShapeError ? err.issues : [(err as Error).message]);
  }
  const policy = validateScript(parsed, {
    policy: input.policy, secrets: input.secrets, mode: 'proposal', previous: input.base, observedNavigations: input.observedNavigations,
  });
  if (!policy.ok) throw new CompileError(policy.violations);
  const safetyFlags = [...policy.safetyFlags];
  // Defence in depth: runTask never heals a field-reading script, but a dropped field list must never pass unflagged.
  if (base && extractsFields(base.steps) && !extractsFields(parsed.steps)) safetyFlags.push(EXTRACT_FIELDS_DROPPED);
  return { script: parsed, safetyFlags, suffixFrom, ...(resumeAt !== undefined ? { resumeAt } : {}) };
}
