import type { Page } from 'playwright-core';
import type { AllowedSubmit, WriteWindow } from '../browser/session.js';
import { maskClipped, type Masker } from '../secrets/mask.js';
import type { PortalPolicy, PortalSecrets, RunState, Script, Step, StepLogEntry, StepsResult, Violation } from '../types.js';
import type { InterruptHandle } from './interrupts.js';
import { HANDLERS, type AnyVerb } from './handlers/index.js';
import { desktopVerbOf, verbOf } from './parse.js';
import { PolicyError } from './errors.js';
import { shownMessage } from './urls.js';
import { BLOCKED_STOP } from '../messages.js';
import { surfaceOf } from '../surface/browser.js';
import type { Surface } from '../surface/surface.js';

/**
 * What a step handler works with. `page` may be replaced (popup). `violations` is the session's live list:
 * handlers push policy refusals here, and any fatal entry stops the run. Secrets are only for signIn.
 */
export interface StepContext {
  page: Page;
  /** What the runner drives. Absent: the browser surface over `page` (surfaceOf), which follows a page a popup step replaced. */
  surface?: Surface;
  script: Script;
  policy: PortalPolicy;
  /** Site Login secrets, only for signIn; absent without a Site Login. */
  secrets?: PortalSecrets;
  vars: Record<string, string>;
  masker: Masker;
  defaultTimeoutMs: number;
  violations: Violation[];
  /** Overlay handlers of the current page; signIn pauses them while typing credentials. */
  interrupts?: InterruptHandle;
  /** Text That Means No Results (case-insensitive regex): extract stops waiting for rows once the scope shows it. */
  emptyPattern?: string;
  /** Index of the top-level step being run (runSteps sets it; nested paginate steps keep their parent's). Binary names use it. */
  stepIndex?: number;
  /** The top-level step being run (set with stepIndex): a handler compares it with its own step to know it is not nested. */
  topStep?: Step;
  /** True only while runSteps runs the top-level step at policy.writeWindow.step (set and cleared by runSteps). */
  writeStep?: boolean;
  /** The session's Fill and Submit window (Session.writeWindow), when the policy has one. */
  writeWindow?: WriteWindow;
  /**
   * Session.armSubmit: the submit and download handlers open a window for their own declared target around their
   * click; an allowed submission is admitted only through such a window (at most 3). Absent: none is ever admitted.
   */
  armSubmit?: (target: AllowedSubmit | null) => void;
  /** Called around each top-level step that runs (Session.stepHooks): named trace groups, and a marker for live views over CDP. */
  stepHooks?: StepHooks;
}
const HOOK_LABEL_MAX = 160;
/** Never throws into the step: a failed hook does not fail the run. Labels are masked and clipped to HOOK_LABEL_MAX. */
export interface StepHooks {
  start(page: Page, label: string): Promise<void>;
  end(page: Page, ok: boolean, label: string): Promise<void>;
}
export type Handler = (ctx: StepContext, step: Step, state: RunState, timeoutMs: number) => Promise<number | void>;

export function newRunState(): RunState {
  return { rows: [], evidence: [], downloads: [], outputs: [], detected: {}, lastCheckpoint: -1, log: [], credentialsSubmitted: false, submitClicked: false, extractRan: false, attributeFields: [], submitted: false };
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
}

/**
 * Playwright names what took a click on a later line of its call log ("<div id="menu" class="open">…</div> intercepts
 * pointer events"); the first line only says it timed out. Keep the tag and id: an open menu or a banner over the control is
 * something to close. The call log is not an API: the agent-tools tests pin this against the bundled Playwright.
 */
function coverHint(raw: string): string {
  if (!raw.includes('intercepts pointer events')) return '';
  const cover = /<([a-z][a-z0-9-]{0,20})\b([^>]*)>[^\n]*intercepts pointer events/i.exec(raw);
  if (!cover) return '';
  const id = /(?:^|\s)id="([\w-]{1,40})"/.exec(cover[2])?.[1];
  return `: another element covers it (${cover[1].toLowerCase()}${id ? `#${id}` : ''}); close or move it first`;
}

/** The single choke point for step failure messages: first line, URLs shown without query string, masked, capped. */
function messageOf(err: unknown, masker: Masker): string {
  const raw = err instanceof Error ? err.message : String(err);
  return shownMessage(raw.split('\n')[0] + coverHint(raw), masker).slice(0, 500);
}

/** The log entry's `output` for a step that produced one: read values, or the binary name (never the bytes). */
function logOutput(state: RunState, verb: AnyVerb, outputsBefore: number, downloadsBefore: number): StepLogEntry['output'] | undefined {
  // A desktop expectFile returns its file the way a download does.
  if ((verb === 'download' || verb === 'expectFile') && state.downloads.length > downloadsBefore) return { binary: state.downloads[state.downloads.length - 1].binaryName };
  if ((verb === 'screenshot' || verb === 'pdf' || verb === 'read') && state.outputs.length > outputsBefore) {
    const o = state.outputs[state.outputs.length - 1];
    return {
      ...(o.text !== undefined ? { text: o.text } : {}), ...(o.html !== undefined ? { html: o.html } : {}),
      ...(o.title !== undefined ? { title: o.title } : {}), ...(o.url !== undefined ? { url: o.url } : {}),
      ...(o.binary ? { binary: o.binary.name } : {}), ...(o.truncated ? { truncated: true } : {}),
    };
  }
  return undefined;
}

/**
 * Runs steps in order. `afterStep` is awaited with the index of each top-level step the run got past (it passed, or
 * was skipped because its `when` condition was not met or because it is optional), before the next step starts.
 */
export async function runSteps(
  ctx: StepContext, steps: Step[], state: RunState = newRunState(),
  opts: {
    nested?: boolean; afterStep?: (index: number) => void | Promise<void>; startAt?: number;
    /** How stepHooks labels a step: "Step N: intent" by default, "AI: intent" for agent actions, "Proof: intent" in prove. */
    label?: 'AI' | 'Proof';
    /** Upper bound for every step's timeout (agent actions); the steps themselves keep none. */
    maxTimeoutMs?: number;
  } = {},
): Promise<StepsResult> {
  const surface = surfaceOf(ctx);
  // Step hooks take a Playwright page: they belong to browser runs only.
  const hooks = surface.kind === 'browser' ? ctx.stepHooks : undefined;
  // startAt 1: the lane already ran step 0 (the start page) and logged it.
  for (let i = opts.startAt ?? 0; i < steps.length; i++) {
    const step = steps[i];
    if (!opts.nested) {
      ctx.stepIndex = i;
      ctx.topStep = step;
      // The marker belongs to the step that set it: a later step never inherits it (RunState.clickedTrigger).
      delete state.clickedTrigger;
    }
    // Log entries carry the top-level step index: steps nested in paginate log under their paginate step.
    const at = ctx.stepIndex ?? i;
    const log = (status: StepLogEntry['status'], ms: number, more: Pick<StepLogEntry, 'note' | 'candidate' | 'output'> = {}) => {
      state.log.push({ index: at, intent: step.intent, status, ms, ...more });
    };
    const outputsBefore = state.outputs.length;
    const downloadsBefore = state.downloads.length;
    const t0 = Date.now();
    let lastError: unknown;
    const timeout = Math.min(step.timeoutMs ?? ctx.defaultTimeoutMs, opts.maxTimeoutMs ?? Infinity);
    let hookLabel: string | undefined;
    const endHook = async (ok: boolean) => {
      if (hookLabel !== undefined) await hooks?.end(ctx.page, ok, hookLabel).catch(() => undefined);
    };
    try {
      if (step.when && !(await surface.isVisible(step.when.visible))) {
        log('skipped', 0, { note: 'condition not met' });
        if (!opts.nested) await opts.afterStep?.(i);
        continue;
      }
      if (hooks && !opts.nested) {
        hookLabel = maskClipped(ctx.masker, opts.label ? `${opts.label}: ${step.intent}` : `Step ${at + 1}: ${step.intent}`, HOOK_LABEL_MAX);
        await hooks.start(ctx.page, hookLabel).catch(() => undefined);
      }
      // Desktop steps are a different document (DesktopScript): their verbs include key and expectFile.
      const verb: AnyVerb = surface.kind === 'browser' ? verbOf(step) : desktopVerbOf(step);
      const handler = HANDLERS[surface.kind][verb];
      if (!handler) throw new Error(`step type "${verb}" has no handler${surface.kind === 'browser' ? '' : ` for the ${surface.kind} surface`}`);
      // The write window belongs to one top-level step; nested (paginate) runs never get it.
      ctx.writeStep = !opts.nested && ctx.policy.writeWindow !== undefined && ctx.policy.writeWindow.step === i;
      let candidate: number | void;
      try {
        candidate = await handler(ctx, step, state, timeout);
      } finally {
        ctx.writeStep = false;
      }
      if (step.expect) await surface.checkExpect(step.expect, timeout);
      if (step.checkpoint && !opts.nested) state.lastCheckpoint = i;
      const output = logOutput(state, verb, outputsBefore, downloadsBefore);
      log('ok', Date.now() - t0, { ...(typeof candidate === 'number' ? { candidate } : {}), ...(output ? { output } : {}) });
      await endHook(true);
    } catch (err) {
      lastError = err;
      await endHook(false);
      const message = messageOf(err, ctx.masker);
      // A run limit (`limit: …`) always ends the run as incomplete: `optional` never swallows it.
      if (step.optional && !message.startsWith('limit: ')) {
        log('skipped', Date.now() - t0, { note: message });
      } else if (!ctx.violations.some((v) => v.fatal)) {
        log('failed', Date.now() - t0, { note: message });
        return { ok: false, state, failure: { index: i, intent: step.intent, message } };
      }
    }
    if (ctx.violations.some((v) => v.fatal)) {
      const message = lastError instanceof PolicyError ? messageOf(lastError, ctx.masker) : BLOCKED_STOP;
      const last = state.log[state.log.length - 1];
      if (last && last.index === at) { last.status = 'failed'; last.note = message; }
      else log('failed', Date.now() - t0, { note: message });
      return { ok: false, state, failure: { index: i, intent: step.intent, message } };
    }
    if (!opts.nested) await opts.afterStep?.(i);
  }
  return { ok: true, state };
}

import './handlers/basic.js';
import './handlers/data.js';
import './handlers/auth.js';
import './handlers/files.js';
import './handlers/capture.js';
