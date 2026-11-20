// The desktop repair session: one agent conversation that repairs a desktop run step by step, on the live run the
// failed step left open. The agent explores in the runner's repair mode only; each fix it ends (use_target, add_step)
// becomes a patch of the step set (compileFix), and the engine then runs the steps on, up to the first declared write,
// whose target it only resolves. Steps the repair added or retargeted act in the runner's probe mode (clicks only) or,
// for a read, in repair mode; a changed step that would type, choose, check, press a key, or click something that reads
// like a write is not run at all: the repair stops before it, and the proof resolves it without acting.
import { createHash } from 'node:crypto';
import { driveAgentLoop, type AgentBudget, type LoopCore } from '../../agent/loop.js';
import type { ChatModel } from '../../agent/model.js';
import type { ToolCall } from '../../agent/tools.js';
import { neutralize } from '../../agent/tools.js';
import { looksDestructive } from '../../policy/destructive.js';
import { firstStopIndex, hasWriteWord, looksLikeWrite, signInChecks, signInWindow, type DesktopStopOpts } from '../../proposal/desktop.js';
import { maskClipped, type Masker } from '../../secrets/mask.js';
import { runSteps, type StepContext } from '../../steps/run.js';
import type { DesktopLocator, DesktopScript, DesktopStep, ErrorCode, RunState, Step, StepLogEntry, WindowSel } from '../../types.js';
import { PolicyRefusedError, RunnerError, type RunnerAction, type RunnerWindow } from '../protocol.js';
import { runnerTarget, type ChangedStep, type DesktopSurface, type DesktopView } from '../surface.js';
import { desktopCandidatesFor, TargetError } from './candidates.js';
import { compileFix, PatchError, unrepairable, type AddedKind, type FailedPart, type Recorded } from './patch.js';
import {
  DESKTOP_AGENT_TOOL_NAMES, DESKTOP_AGENT_TOOLS, DESKTOP_CIRCLE_NUDGE_TEXT, desktopNextFailureText, desktopRepairFirstMessage, desktopRepairSystemPrompt,
} from './prompt.js';
import { buildTree, type TreeNode } from './tree.js';

/** At most this many fixes (failed steps repaired) in one repair. */
export const DESKTOP_MAX_FIXES = 5;
/** At most this many steps added by add_step in one repair. */
export const DESKTOP_MAX_ADDED = 2;
const EXPLORE_MS = 5_000;
/**
 * The shortest time a step waits for its control to appear while the repair runs steps on the live run (the step the
 * model just chose, then the approved steps after it): as long as the repair's own actions wait, and as browser repair's
 * actions wait. A step that drifted too then reaches the model after this wait, not after its full timeout.
 */
export const RUN_ON_MIN_WAIT_MS = EXPLORE_MS;

/**
 * How long a step waits for its control while the repair runs steps on: RUN_ON_MIN_WAIT_MS, or twice the slowest step
 * that passed in this run when that is longer (a slow app keeps its pace), never more than the step's own timeout
 * (capWait). The action keeps the step's timeout, and the proof replays every step with its full timeout.
 */
export function runOnWaitMs(log: readonly StepLogEntry[]): number {
  const slowest = log.reduce((m, e) => (e.status === 'ok' && e.ms > m ? e.ms : m), 0);
  return Math.max(RUN_ON_MIN_WAIT_MS, 2 * slowest);
}
const READ_CLIP = 1500;
const VIEW_TEXT_MAX = 12_000;
const PROBE_CLICKABLE = new Set(['Button', 'MenuItem', 'Hyperlink', 'SplitButton', 'TabItem', 'ListItem', 'TreeItem']);
const SELECTABLE = new Set(['TabItem', 'ListItem', 'TreeItem']);
const MENU_TYPES = new Set(['MenuItem', 'SplitButton']);

/** What the session decides about a failure met while the steps went on (the desktop task's trigger table). */
export type FailureClass = { repair: true } | { repair: false; code: ErrorCode; why?: string };

export interface DesktopRepairHandoff {
  surface: DesktopSurface;
  ctx: StepContext;
  state: RunState;
  base: DesktopScript;
  failure: { index: number; intent: string; message: string; part: FailedPart };
  model: ChatModel;
  goal?: string;
  budget: AgentBudget;
  signal?: AbortSignal;
  /** The run's masker as it stands now (secrets, typed variable values, clipboard texts). */
  mask(): Masker;
  isSecretVar(name: string): boolean;
  /** The trigger table for a step that fails while the steps go on after a fix. */
  classify(index: number, message: string): FailureClass;
  /** A fixed wait for steps the repair runs on (tests); default runOnWaitMs of the run's log so far. */
  runOnWaitMs?: number;
}

/**
 * Why the repaired steps stop where they stop: a declared write, a step the review page flags as looking like a write
 * (DR9: an owner who left it unticked must not get it run twice), or a changed step held for approval.
 */
export interface RepairStop { index: number; reason: 'write' | 'flagged' | 'held'; why: string }

export type DesktopSessionEnd =
  | { kind: 'repaired'; doc: DesktopScript; changed: number[]; added: number[]; marks: Map<number, ChangedStep>; stop: RepairStop | null; fixes: number }
  | { kind: 'gave_up'; note: string }
  | { kind: 'failed'; code: ErrorCode; message: string };

export interface DesktopRepairAction { tool: string; ok: boolean; note?: string }

export interface DesktopSessionResult {
  end: DesktopSessionEnd | undefined;
  loop: LoopCore<'repaired' | 'gave_up' | 'failed'>;
  actions: DesktopRepairAction[];
}

class ToolError extends Error {}

/** The step's own target (the verb's locator), when it has one. */
export function stepTarget(step: DesktopStep): DesktopLocator | undefined {
  if ('click' in step) return step.click;
  if ('doubleClick' in step) return step.doubleClick;
  if ('fill' in step) return step.fill.field;
  if ('select' in step) return step.select.field;
  if ('check' in step) return step.check.field;
  if ('waitFor' in step) return step.waitFor.target;
  if ('read' in step) return 'target' in step.read ? step.read.target : undefined;
  if ('key' in step) return step.key.target;
  return undefined;
}

/** The runner action a step's handler sends, or undefined for a step that sends none (waitFor, expectFile). */
function actionOf(step: DesktopStep): RunnerAction | undefined {
  if ('click' in step) return 'click';
  if ('doubleClick' in step) return 'doubleClick';
  if ('fill' in step) return 'type';
  if ('select' in step) return 'select';
  if ('check' in step) return step.check.checked === false ? 'uncheck' : 'check';
  if ('read' in step) return 'read';
  if ('key' in step) return 'key';
  return undefined;
}

export { firstStopIndex, signInChecks, signInWindow, signsInOnly } from '../../proposal/desktop.js';
type StopOpts = DesktopStopOpts;

/**
 * DR10b's window check, when the sign-in step is reached: the sign-in window as UI Automation shows it now has no
 * control whose name or automation id has a write word (save, post, submit, ok and the like) or reads destructive.
 * The sign-in words are neither. Fails closed: a window that cannot be read, or whose view was cut short, is not clear.
 */
export async function signInWindowClear(surface: DesktopSurface, masker: Masker, window: WindowSel | undefined): Promise<boolean> {
  if (!window) return false;
  try {
    const view = await surface.view(masker, { window });
    // A view cut short may leave the very control out: not clear. The words are read on the unmasked names (rawItems:
    // engine-only, never shown or sent to the model), so a masked value cannot hide one.
    if (view.truncated) return false;
    return !surface.rawItems().some((it) => hasWriteWord(it.name) || hasWriteWord(it.automationId) || looksDestructive(it.name, it.automationId));
  } catch {
    return false;
  }
}

/** The engine's destructive denylist on a desktop control's name and automation id (policy/destructive.ts). */
export { looksDestructive };

/** How each kind of added step acts before approval. */
const MARK_OF: Record<AddedKind, ChangedStep> = { openMenu: 'expand', select: 'select', escape: 'escape', inserted: 'probe' };

/**
 * Why the runner's probe mode would refuse a click on this view node (the engine's copy of RunnerService.CheckProbe,
 * judged on the last view, unmasked): a write word in its name or id, a control type probe mode does not click, a
 * combo box item, or a write word in the window's title or static text. Undefined: the click may be probed.
 */
export function probeBlock(node: TreeNode, roots: TreeNode[], windowTitle: string): string | undefined {
  const { item } = node;
  if (hasWriteWord(item.name) || hasWriteWord(item.automationId)) return `its name or id reads like a write (save, post, submit, confirm, ok and the like)`;
  if (looksDestructive(item.name, item.automationId)) return 'its name or id reads like it deletes, cancels, rejects or signs out';
  if (!PROBE_CLICKABLE.has(item.controlType)) return `a ${item.controlType} is not a control the repair clicks`;
  for (let p = node.parent; p; p = p.parent) if (p.item.controlType === 'ComboBox' || p.item.className === 'ComboLBox') return 'it is an item of a combo box';
  const texts: TreeNode[] = [];
  const walk = (n: TreeNode) => { if (n.item.controlType === 'Text') texts.push(n); n.children.forEach(walk); };
  roots.forEach(walk);
  if (hasWriteWord(windowTitle) || texts.some((t) => hasWriteWord(t.item.name))) return 'its window\'s title or text reads like a write (save, post, submit, confirm, ok and the like)';
  return undefined;
}

/** A window of the run as a selector for the view: every non-empty field the runner reported. */
function selectorOf(w: RunnerWindow): WindowSel {
  return { exe: w.exe, ...(w.title ? { title: w.title } : {}), ...(w.automationId ? { automationId: w.automationId } : {}), ...(w.className ? { className: w.className } : {}) };
}

/** The view as the model reads it: masked names (the view's own masking), the run's other windows, then one line per element. */
function renderView(view: DesktopView, others: string[]): string {
  const lines = [`Window: "${view.window.title}" (${view.window.exe})${view.truncated ? ' (cut short: too many elements)' : ''}`];
  if (others.length) lines.push(`Other windows: ${others.join(', ')}`);
  for (const it of view.items) {
    const parts = [`${'  '.repeat(Math.min(it.depth, 12))}[${it.ref}] ${it.controlType} "${it.name.replace(/"/g, "'")}"`];
    if (it.automationId) parts.push(`#${it.automationId}`);
    if (it.value !== undefined) parts.push(`value="${it.value.replace(/"/g, "'")}"`);
    if (it.valueHidden) parts.push('value=(hidden)');
    if (!it.enabled) parts.push('(disabled)');
    lines.push(parts.join(' '));
  }
  const body = neutralize(lines.join('\n')).slice(0, VIEW_TEXT_MAX);
  return `<page_content>\n${body}\n</page_content>`;
}

export class DesktopRepairSession {
  doc: DesktopScript;
  /** Per step of `doc`: how a step the repair added or changed acts before approval; undefined for an approved step. */
  marks: (ChangedStep | undefined)[];
  /** Per step of `doc`: true when AI repair added it (add_step, a recorded menu or tab). */
  isNew: boolean[];
  failure: DesktopRepairHandoff['failure'];
  recorded: Recorded[] = [];
  added = 0;
  fixes = 0;
  end?: DesktopSessionEnd;
  readonly actions: DesktopRepairAction[] = [];
  lastRepeat = 0;
  private repeats = new Map<string, number>();
  private seen = new Set<string>();
  private viewState = '';
  private windowTitle = '';
  private lastWindows: RunnerWindow[] = [];
  private progress = false;
  /** Names of the menu-bar headers (MenuItem directly under a MenuBar) seen in any view. */
  private topHeaders = new Set<string>();

  constructor(private readonly h: DesktopRepairHandoff) {
    this.doc = structuredClone(h.base);
    this.marks = h.base.steps.map(() => undefined);
    this.isNew = h.base.steps.map(() => false);
    this.failure = h.failure;
  }

  private get surface(): DesktopSurface { return this.h.surface; }
  private get masker(): Masker { return this.h.mask(); }
  private get timeout(): number { return Math.min(EXPLORE_MS, this.h.ctx.defaultTimeoutMs); }

  /** A fresh view: the window in front, or `window` (a number from "Other windows"). Every earlier ref stops working. */
  async look(window?: number): Promise<string> {
    const wins = await this.surface.windows();
    this.lastWindows = wins;
    const chosen = window !== undefined && Number.isInteger(window) && window > 0 ? wins[window] : undefined;
    if (window !== undefined && !chosen) throw new ToolError(`there is no window ${String(window).slice(0, 10)}; use a number from "Other windows"`);
    const view = await this.surface.view(this.masker, chosen ? { window: selectorOf(chosen) } : {});
    const raw = this.surface.rawItems();
    const byRef = new Map(raw.map((i) => [i.ref, i]));
    for (const i of raw) if (i.controlType === 'MenuItem' && i.parent && byRef.get(i.parent)?.controlType === 'MenuBar' && i.name) this.topHeaders.add(i.name);
    this.windowTitle = this.surface.nodeOf(view.items[0]?.ref ?? '')?.window.title ?? '';
    this.viewState = createHash('sha256').update(JSON.stringify([this.windowTitle, raw.map((i) => [i.controlType, i.name, i.automationId])])).digest('hex').slice(0, 32);
    if (!this.seen.has(this.viewState)) {
      this.seen.add(this.viewState);
      this.progress = true;
    }
    const m = this.masker;
    const others = wins.map((w, i) => (i === 0 ? '' : `[${i}] "${maskClipped(m, w.title, 80)}" (${maskClipped(m, w.exe, 60)})`)).filter(Boolean);
    return renderView(view, others);
  }

  /** The first user message: the failed step, the steps around it and the first view. */
  async first(): Promise<string> {
    const i = this.failure.index;
    return desktopRepairFirstMessage({
      stepNumber: i + 1, intent: this.failure.intent, message: this.failure.message,
      before: this.doc.steps.slice(0, i).map((s) => s.intent), after: this.doc.steps.slice(i + 1).map((s) => s.intent), view: await this.look(),
    }, this.masker);
  }

  /** Runs one tool call and counts it for the circle guard. */
  async run(call: ToolCall): Promise<{ text: string; error: boolean; done?: { outcome: 'repaired' | 'gave_up' | 'failed'; note: string } }> {
    const key = this.actionKey(call);
    this.progress = false;
    const name = String(call.name).slice(0, 40);
    let out: { text: string; error: boolean };
    try {
      out = { text: await this.runTool(name, call.args && typeof call.args === 'object' ? call.args : {}), error: false };
      this.actions.push({ tool: name, ok: true });
    } catch (err) {
      const message = err instanceof ToolError || err instanceof TargetError || err instanceof PatchError || err instanceof RunnerError
        ? (err as Error).message : `${(err as Error)?.message ?? String(err)}`;
      const note = this.masker.mask(message).slice(0, 300);
      out = { text: `ERROR: ${note}`, error: true };
      this.actions.push({ tool: name, ok: false, note });
    }
    if (this.progress || this.end) {
      this.repeats.clear();
      this.lastRepeat = 0;
    } else {
      this.lastRepeat = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, this.lastRepeat);
    }
    if (this.end) {
      const note = this.end.kind === 'repaired' ? `repaired ${this.end.fixes} step${this.end.fixes === 1 ? '' : 's'}`
        : this.end.kind === 'gave_up' ? this.end.note : this.end.message;
      return { ...out, done: { outcome: this.end.kind, note } };
    }
    return out;
  }

  /** The circle guard's key: the view state, the tool and each argument (a ref read as the control it names). */
  private actionKey(call: ToolCall): string {
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const parts = Object.keys(args).sort().map((k) => {
      const v = args[k];
      const n = typeof v === 'string' ? this.surface.nodeOf(v)?.node : undefined;
      return [k, n ? [n.controlType, n.name ?? '', n.automationId ?? ''] : v];
    });
    return createHash('sha256').update(JSON.stringify([this.viewState, String(call.name), parts])).digest('hex').slice(0, 32);
  }

  private ref(args: Record<string, unknown>): string {
    const r = args.ref;
    if (typeof r !== 'string' || !/^e\d{1,7}$/.test(r)) throw new ToolError('ref must be an element ref from the latest view, such as e12');
    if (!this.surface.nodeOf(r)) throw new ToolError(`element ${r} is no longer on the screen; call look for fresh refs`);
    return r;
  }

  /** The tree node behind a ref of the last view, with the view's roots. */
  private nodeAt(ref: string): { node: TreeNode; roots: TreeNode[] } {
    const roots = buildTree(this.surface.rawItems());
    const stack = [...roots];
    for (let n = stack.pop(); n; n = stack.pop()) {
      if (n.ref === ref) return { node: n, roots };
      stack.push(...n.children);
    }
    throw new ToolError(`element ${ref} is no longer on the screen; call look for fresh refs`);
  }

  private async locate(ref: string): Promise<DesktopLocator> {
    return desktopCandidatesFor(this.surface, ref, { masker: this.masker, base: this.doc });
  }

  /** An exploration act in the runner's repair mode (never recorded against a step). */
  private async explore(loc: DesktopLocator | undefined, action: RunnerAction, value?: string): Promise<string | undefined> {
    const s = this.surface;
    const r = await s.client.callWithin('act', {
      runId: s.runId, ...(loc ? { target: runnerTarget(loc) } : {}), action, ...(value !== undefined ? { value } : {}), mode: 'repair', timeoutMs: this.timeout,
    });
    return r.text;
  }

  private async withLook(text: string): Promise<string> {
    return `${text}\n${await this.look()}`;
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'look':
        return this.look(typeof args.window === 'number' ? args.window : undefined);
      case 'expand': {
        const ref = this.ref(args);
        const { node } = this.nodeAt(ref);
        const loc = await this.locate(ref);
        await this.explore(loc, 'expand');
        if (MENU_TYPES.has(node.item.controlType)) {
          this.recorded.push({ kind: 'openMenu', loc, name: node.item.name, topLevel: node.parent?.item.controlType === 'MenuBar' });
        }
        return this.withLook(`Expanded ${ref}.`);
      }
      case 'select_item': {
        const ref = this.ref(args);
        const { node } = this.nodeAt(ref);
        if (!SELECTABLE.has(node.item.controlType)) throw new ToolError(`select_item takes a tab, list item or tree item, not a ${node.item.controlType}`);
        const loc = await this.locate(ref);
        await this.explore(loc, 'click');
        this.recorded.push({ kind: 'select', loc, name: node.item.name });
        return this.withLook(`Selected ${ref}.`);
      }
      case 'read': {
        const ref = this.ref(args);
        const loc = await this.locate(ref);
        const text = await this.explore(loc, 'read');
        return `<page_content>\n${neutralize(maskClipped(this.masker, text ?? '', READ_CLIP))}\n</page_content>`;
      }
      case 'escape':
        await this.explore(undefined, 'key', 'Escape');
        this.recorded.push({ kind: 'escape' });
        return this.withLook('Pressed Escape.');
      case 'use_target':
        return this.useTarget(this.ref(args));
      case 'add_step':
        return this.addStep(this.ref(args));
      case 'give_up': {
        const reason = typeof args.reason === 'string' ? args.reason : '';
        this.end = { kind: 'gave_up', note: `the repair gave up: ${neutralize(this.masker.mask(reason)).slice(0, 300) || 'no reason given'}` };
        return 'Stopped.';
      }
      default:
        throw new ToolError(`unknown tool ${DESKTOP_AGENT_TOOL_NAMES.has(name) ? name : 'name'}; use one of ${[...DESKTOP_AGENT_TOOL_NAMES].join(', ')}`);
    }
  }

  private markMap(marks = this.marks): Map<number, ChangedStep> {
    return new Map(marks.flatMap((m, i): [number, ChangedStep][] => (m ? [[i, m]] : [])));
  }

  /** Whether a step clicks a menu-bar header seen in a view (the only kind of step a fix may fold). */
  private isTopHeader(step: DesktopStep): boolean {
    if (!('click' in step)) return false;
    const path = step.click.uia.path;
    const last = path.at(-1);
    return path.length === 1 && last?.controlType === 'MenuItem' && last.name !== undefined && this.topHeaders.has(last.name);
  }

  /** The patch of one fix and the new per-step marks. Throws PatchError (engine text) when the patch breaks a rule. */
  private patch(fix: { loc?: DesktopLocator; targetName?: string; recorded: Recorded[] }) {
    const f = this.failure;
    const out = compileFix(this.doc, {
      failedIndex: f.index, part: f.part, recorded: fix.recorded, isSecretVar: (n) => this.h.isSecretVar(n), isTopHeader: (st) => this.isTopHeader(st),
      ...(fix.loc ? { loc: fix.loc, targetName: fix.targetName } : {}),
    }, (s) => this.masker.mask(s));
    const marks = [...this.marks];
    const isNew = [...this.isNew];
    // A check-only change keeps the approved action (step mode); a retargeted action acts in probe mode.
    const failedMark: ChangedStep | undefined = !fix.loc ? this.marks[f.index] : f.part === 'expect' ? (this.marks[f.index] ?? 'checkOnly') : 'probe';
    marks.splice(out.from, f.index - out.from + 1, ...out.addedKinds.map((k) => MARK_OF[k]), failedMark);
    isNew.splice(out.from, f.index - out.from + 1, ...out.addedKinds.map(() => true), this.isNew[f.index]!);
    return { ...out, marks, isNew };
  }

  private commit(p: ReturnType<DesktopRepairSession['patch']>): void {
    this.doc = p.doc;
    this.marks = p.marks;
    this.isNew = p.isNew;
    this.fixes++;
    this.recorded = [];
    this.progress = true;
  }

  /** Ends the session: the steps up to `stop` are repaired (stop null: all of them ran). */
  private finish(stop: RepairStop | null): void {
    this.end = {
      kind: 'repaired', doc: this.doc, fixes: this.fixes, stop, marks: this.markMap(),
      changed: [...this.markMap().keys()].filter((i) => !this.isNew[i]), added: this.isNew.flatMap((n, i) => (n ? [i] : [])),
    };
  }

  /** Runs steps [from, to) of the current doc on the live run; changed steps act as their marks say. */
  private async runRange(from: number, to: number, marks = this.marks, doc = this.doc) {
    const s = this.surface;
    s.changedSteps.clear();
    for (const [i, m] of this.markMap(marks)) s.changedSteps.set(i, m);
    s.errors.clear();
    s.waitCapMs = this.h.runOnWaitMs ?? runOnWaitMs(this.h.state.log);
    try {
      return await runSteps(this.h.ctx, doc.steps.slice(0, to) as unknown as Step[], this.h.state, { startAt: from });
    } finally {
      s.changedSteps.clear();
      s.waitCapMs = undefined;
    }
  }

  /** Why a changed step may not run before approval, or undefined when it may (judged on the view the agent chose it from). */
  private holdReason(step: DesktopStep, ref: string): string | undefined {
    const action = actionOf(step);
    if (action === undefined || action === 'read') return undefined;
    if (action !== 'click' && action !== 'doubleClick') return 'it types, chooses, checks or presses a key, and AI repair runs such a step only after approval';
    const { node, roots } = this.nodeAt(ref);
    const block = probeBlock(node, roots, this.windowTitle);
    return block ? `${block}, so AI repair does not click it before approval` : undefined;
  }

  private async useTarget(ref: string): Promise<string> {
    const f = this.failure;
    const { node } = this.nodeAt(ref);
    // A step that did not look like a write is never moved onto a control that does, or onto a destructive one (name or id).
    const writeLike = hasWriteWord(node.item.name) || hasWriteWord(node.item.automationId);
    if ((writeLike && !looksLikeWrite(this.doc.steps[f.index]!)) || looksDestructive(node.item.name, node.item.automationId)) {
      throw new ToolError(`refused: ${ref} reads like a write or a destructive action, and step ${f.index + 1} does not; choose another control or give_up`);
    }
    const loc = await this.locate(ref);
    const p = this.patch({ loc, targetName: node.item.name, recorded: this.recorded });
    const step = p.doc.steps[p.retargetedIndex]!;
    if (f.part === 'expect') {
      // The step's action already ran; only its check moves to the new control.
      if (!(await this.surface.isVisible(loc as never))) throw new ToolError(`element ${ref} is not visible; look again`);
      this.commit(p);
      return this.goOn(p.retargetedIndex + 1, `Fixed step ${p.retargetedIndex + 1}: its check now looks at ${ref}.`);
    }
    const hold = this.holdReason(step, ref);
    if (hold) {
      this.commit(p);
      this.finish({ index: p.retargetedIndex, reason: 'held', why: hold });
      return `Step ${p.retargetedIndex + 1} now targets ${ref}; ${hold}. The repair stops here.`;
    }
    const res = await this.runRange(p.retargetedIndex, p.retargetedIndex + 1, p.marks, p.doc);
    if (!res.ok) {
      const cause = this.surface.errors.get(p.retargetedIndex);
      if (cause instanceof PolicyRefusedError) {
        // The runner's own probe rule held it: the step waits for approval.
        this.commit(p);
        this.finish({ index: p.retargetedIndex, reason: 'held', why: `the runner did not run it before approval (${this.masker.mask(cause.message).slice(0, 200)})` });
        return `Step ${p.retargetedIndex + 1} now targets ${ref}; the runner holds it for approval. The repair stops here.`;
      }
      throw new ToolError(`the step still failed on that control: ${this.masker.mask(res.failure.message).slice(0, 300)}; look again and choose another control, or give_up`);
    }
    this.commit(p);
    return this.goOn(p.retargetedIndex + 1, `Fixed step ${p.retargetedIndex + 1}: it now acts on ${ref}.`);
  }

  private async addStep(ref: string): Promise<string> {
    if (this.added >= DESKTOP_MAX_ADDED) throw new ToolError(`a repair may add at most ${DESKTOP_MAX_ADDED} steps`);
    // An added click goes before the failed step, which then runs again: after a failed check that would act twice.
    if (this.failure.part === 'expect') {
      throw new ToolError(`step ${this.failure.index + 1} acted and only its check failed: call use_target on the control the check should look at, or give_up`);
    }
    const { node, roots } = this.nodeAt(ref);
    if (!PROBE_CLICKABLE.has(node.item.controlType)) throw new ToolError(`add_step takes a button, menu item, link, tab or list item, not a ${node.item.controlType}`);
    // A destructive name is refused. A destructive automation id alone (an icon-only btnReject, or v2's btnConfirmExport
    // behind "Continue") is never clicked either: probeBlock holds it, so it is added for the approver and the repair stops.
    if (looksDestructive(node.item.name, '')) throw new ToolError(`refused: ${ref} looks like it deletes, cancels, pays, sends or otherwise changes something`);
    const loc = await this.locate(ref);
    const rec: Recorded = { kind: 'inserted', loc, name: node.item.name };
    const block = probeBlock(node, roots, this.windowTitle);
    // Compiled before anything is clicked: a fix over its cap is refused without a click.
    const withRec = this.patch({ recorded: [...this.recorded, rec] });
    const hold = (why: string) => {
      const p = withRec;
      this.added++;
      this.commit(p);
      const at = p.retargetedIndex - 1;
      this.finish({ index: at, reason: 'held', why });
      return `Added step ${at + 1} (a click on ${ref}) without clicking it: ${why}. The repair stops here.`;
    };
    if (block) return hold(`${block}, so AI repair does not click it before approval`);
    try {
      await this.surface.client.callWithin('act', { runId: this.surface.runId, target: runnerTarget(loc), action: 'click', mode: 'probe', timeoutMs: this.timeout });
    } catch (err) {
      if (err instanceof PolicyRefusedError) return hold(`the runner did not click it before approval (${this.masker.mask(err.message).slice(0, 200)})`);
      throw err;
    }
    this.added++;
    this.recorded.push(rec);
    // The failed step, unchanged, right after the added click.
    const p = withRec;
    const res = await this.runRange(p.retargetedIndex, p.retargetedIndex + 1, p.marks, p.doc);
    if (!res.ok) return this.withLook(`Clicked ${ref}, but step ${f1(this.failure.index)} still fails: ${this.masker.mask(res.failure.message).slice(0, 300)}.`);
    this.commit(p);
    return this.goOn(p.retargetedIndex + 1, `Added a click on ${ref}; step ${p.retargetedIndex + 1} passed.`);
  }

  /** After a fix: the steps go on up to the first step that writes or looks like a write (resolved only), or to the end. */
  private async goOn(from: number, done: string): Promise<string> {
    const opts: StopOpts = { isSecretVar: (n) => this.h.isSecretVar(n), changed: new Set(this.markMap().keys()) };
    let stopAt = firstStopIndex(this.doc, from, opts);
    // A sign-in step (DR10b) runs only when its window is clear when it is reached; otherwise the run-on stops there.
    let cur = from;
    let res: Awaited<ReturnType<typeof this.runRange>> | undefined;
    for (const c of signInChecks(this.doc, from, stopAt, opts)) {
      res = await this.runRange(cur, c);
      if (!res.ok) break;
      cur = c;
      if (!(await signInWindowClear(this.surface, this.masker, signInWindow(this.doc, c)))) { stopAt = c; break; }
    }
    if ((!res || res.ok) && cur < stopAt) res = await this.runRange(cur, stopAt);
    if (res) {
      if (!res.ok) {
        const j = res.failure.index;
        const step = this.doc.steps[j]!;
        const c = this.h.classify(j, res.failure.message);
        if (!c.repair) {
          this.end = { kind: 'failed', code: c.code, message: `step ${j + 1} (${step.intent}) failed after the repair: ${this.masker.mask(res.failure.message)}${c.why ? ` (${c.why})` : ''}` };
          return 'Stopped.';
        }
        if (this.marks[j] !== undefined) {
          this.end = { kind: 'failed', code: 'drift_detected', message: `step ${j + 1}, which the repair changed, failed again: ${this.masker.mask(res.failure.message)}` };
          return 'Stopped.';
        }
        const refused = unrepairable(step, (n) => this.h.isSecretVar(n));
        if (refused) {
          this.end = { kind: 'gave_up', note: `step ${j + 1} (${step.intent}) failed too, and ${refused}` };
          return 'Stopped.';
        }
        if (this.fixes >= DESKTOP_MAX_FIXES) {
          this.end = { kind: 'failed', code: 'drift_detected', message: `the repair fixed ${this.fixes} steps and step ${j + 1} still fails` };
          return 'Stopped.';
        }
        const cause = this.surface.errors.get(j);
        const part: FailedPart = cause?.name === 'DesktopDriftError' && cause.message.startsWith('expected ') ? 'expect' : 'target';
        this.failure = { index: j, intent: step.intent, message: this.masker.mask(res.failure.message), part };
        this.recorded = [];
        return desktopNextFailureText({ done, stepNumber: j + 1, intent: step.intent, message: this.failure.message, view: await this.look() }, this.masker);
      }
    }
    if (stopAt < this.doc.steps.length) {
      const write = this.doc.steps[stopAt]!;
      const target = stepTarget(write);
      let found = target === undefined;
      if (target) {
        try {
          await this.surface.client.callWithin('resolve', { runId: this.surface.runId, target: runnerTarget(target), timeoutMs: this.h.ctx.defaultTimeoutMs });
          found = true;
        } catch (err) {
          if (!(err instanceof RunnerError) || err instanceof PolicyRefusedError) throw err;
        }
      }
      const declared = write.write === true;
      const what = declared ? 'a declared write step' : 'a step that looks like a write (the review page flags it)';
      if (!found) {
        this.end = { kind: 'gave_up', note: `step ${stopAt + 1} (${write.intent}) is ${what} and no longer finds its control; AI repair does not run or change such a step: update it by hand` };
        return 'Stopped.';
      }
      this.finish({ index: stopAt, reason: declared ? 'write' : 'flagged', why: `it is ${what}: its control was found, and it was not run` });
      return `${done} The steps ran up to step ${stopAt + 1}, ${what}, which was found and not run.`;
    }
    this.finish(null);
    return `${done} Every step ran.`;
  }
}

const f1 = (i: number) => i + 1;

/** A masker that asks for the run's masker at every use: typed values the steps add later are masked too. */
export function liveMasker(current: () => Masker): Masker {
  return {
    mask: (t) => current().mask(t),
    containsSecret: (t) => current().containsSecret(t),
    get secrets() { return current().secrets; },
    get maxLength() { return current().maxLength; },
    add: (values, opts) => current().add(values, opts),
  };
}

/** Runs the repair conversation on the live run. Never throws for model errors. */
export async function runDesktopRepairSession(h: DesktopRepairHandoff): Promise<DesktopSessionResult> {
  const session = new DesktopRepairSession(h);
  const loop = await driveAgentLoop<'repaired' | 'gave_up' | 'failed'>({
    model: h.model, tools: session, toolDefs: DESKTOP_AGENT_TOOLS, toolNames: DESKTOP_AGENT_TOOL_NAMES,
    system: desktopRepairSystemPrompt({ ...(h.goal ? { goal: h.goal } : {}), exe: h.base.app.exe }),
    first: () => session.first(), unreadable: 'the app could not be read', masker: liveMasker(h.mask), budget: h.budget,
    ...(h.signal ? { signal: h.signal } : {}),
    nudgeText: DESKTOP_CIRCLE_NUDGE_TEXT,
    circlingNote: (n) => `it did the same action on the same screen ${n} times without finding anything new`,
    idleText: 'Reply with exactly one tool call. Call give_up if you cannot repair the step.',
  });
  return { end: session.end, loop, actions: session.actions };
}
