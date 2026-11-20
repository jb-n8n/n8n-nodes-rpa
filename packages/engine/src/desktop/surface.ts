import type { ChatImage } from '../agent/model.js';
import type { Snapshot, SnapshotElement, SnapshotOptions } from '../agent/snapshot.js';
import { RUNNER_TOO_OLD_FOR_CLIPBOARD } from '../messages.js';
import { hidesValue } from '../secrets/credential-field.js';
import { createMasker, maskClipped, type Masker } from '../secrets/mask.js';
import { poll } from '../steps/poll.js';
import type { Surface } from '../surface/surface.js';
import type { DesktopApp, DesktopLocator, Expect, Locator, UiaTarget, WindowSel } from '../types.js';
import type { RunnerClient } from './client.js';
import {
  ElementNotFoundError, METHOD_NOT_FOUND, RunnerError, type RunnerMethod, type RunnerMethods, type RunnerNode, type RunnerTarget, type RunnerWindow,
} from './protocol.js';

/** The runner's Target for a step's locator: the primary target with the fallbacks inline. */
export function runnerTarget(loc: DesktopLocator): RunnerTarget {
  const one = (t: UiaTarget): RunnerTarget => ({ ...(t.window ? { window: t.window } : {}), path: t.path });
  return { ...one(loc.uia), ...(loc.fallbacks?.length ? { fallbacks: loc.fallbacks.map((f) => one(f.uia)) } : {}) };
}

/** A desktop locator as messages name it: `Edit #txtUser > Button "Sign in"` (the primary target). */
export function describeDesktopLocator(loc: DesktopLocator): string {
  const cond = loc.uia.path.map((c) => [
    c.controlType ?? '', c.automationId ? `#${c.automationId}` : '', c.name !== undefined ? `"${c.name}"` : '', c.className ? `.${c.className}` : '',
    c.index !== undefined ? `[${c.index}]` : '',
  ].filter(Boolean).join(' '));
  return `UI Automation ${cond.join(' > ')}`;
}

const NAME_CLIP = 80;
const FULL_NAME_CLIP = 500;
const TEXT_CLIP = 4000;
const POLL_MS = 250;
/**
 * Typed variable values (DesktopSurface.typed) this long or longer are masked out of messages, logs, read outputs and views;
 * shorter ones are not (a one-letter value would mask every such letter).
 */
export const MIN_MASKED_TYPED = 4;

/**
 * How a step AI repair added or changed acts before anyone approved it. 'probe': a retargeted or added click goes out in
 * the runner's probe mode, a retargeted read in repair mode. 'expand' / 'select': a click compiled from the agent's
 * repair-mode expand or select_item replays as that repair-mode act. 'escape': a kept Escape (no target) goes out in
 * repair mode (the runner allows it only while a menu is open). 'checkOnly': only the step's check changed; its action
 * is the approved one and acts in step mode.
 */
export type ChangedStep = 'probe' | 'expand' | 'select' | 'escape' | 'checkOnly';

/** One element of a desktop view: what the repair agent sees of it, masked. */
export interface DesktopViewItem {
  ref: string;
  /** The ref of the nearest preceding element one level up (absent for the window's root). */
  parent?: string;
  depth: number;
  controlType: string;
  /** Masked, at most 80 characters. */
  name: string;
  /** Masked, at most 500 characters. */
  fullName: string;
  /** Masked, at most 80 characters. */
  automationId: string;
  /** Masked, at most 80 characters. */
  className: string;
  enabled: boolean;
  /** Masked, at most 80 characters; never a password or credential-like value. */
  value?: string;
  valueHidden?: true;
}
/**
 * A pruned UI Automation view of one window of the run, for the repair agent. Its refs come from a counter separate from
 * snapshot()'s `refStart`, so a view ref and a snapshot ref may share a name. snapshot() clears both ref maps; view()
 * clears only its own, so the last snapshot's `refs` survive a view: never look a view ref up in `refs`.
 */
export interface DesktopView {
  window: { title: string; exe: string }; truncated: boolean; items: DesktopViewItem[];
  /** With `picture` asked for: the masked, labelled screenshot (label 12 is ref e12), or why there is none. */
  picture?: ChatImage & { masked: number };
  noPicture?: string;
}
/** The view's note when the runner has no `look` method. */
export const RUNNER_TOO_OLD_FOR_PICTURES = 'the desktop runner is too old to send a screenshot; update it';
/** The most texts, and the longest text, the runner's `look` takes to cover (RunnerService.MaxMaskTexts, MaxMaskTextLength). */
export const PICTURE_MAX_MASK_TEXTS = 64;
export const PICTURE_MAX_MASK_TEXT_LENGTH = 4096;
/** The view's note when the masked values do not fit what the runner can look for: then no picture, never a partial list. */
export const PICTURE_MASK_TOO_MANY = 'the run masks more values than the runner can look for in a screenshot';
export const PICTURE_MASK_TOO_SHORT = 'a masked value is shorter than the runner looks for in a screenshot';

/**
 * The texts the runner must cover in a screenshot: every secret the view's masker holds (secret variables, the runner
 * token) except the ones that never go to the runner (the step-signing key), and the run's typed variable values and
 * clipboard texts of MIN_MASKED_TYPED characters or more. Undefined with the reason when the runner could not look for
 * all of them (too many, too long, or a secret too short for its search): then no picture is asked for.
 */
export function pictureMaskTexts(secrets: readonly string[], typed: readonly string[], clipboard: readonly string[], neverToRunner: readonly string[]):
  { texts: string[] } | { refused: string } {
  const own = secrets.filter((t) => typeof t === 'string' && t.length > 0 && !neverToRunner.includes(t));
  if (own.some((t) => t.length < MIN_MASKED_TYPED)) return { refused: PICTURE_MASK_TOO_SHORT };
  const texts = [...new Set([...own, ...[...typed, ...clipboard].filter((t) => t.length >= MIN_MASKED_TYPED)])];
  if (texts.length > PICTURE_MAX_MASK_TEXTS || texts.some((t) => t.length > PICTURE_MAX_MASK_TEXT_LENGTH)) return { refused: PICTURE_MASK_TOO_MANY };
  return { texts };
}
/** The raw runner node behind a view ref (unmasked: for the engine only, never for a message). */
export interface DesktopViewNode { node: RunnerNode; parent?: string; window: { title: string; exe: string }; truncated: boolean }

/**
 * The desktop runner behind the Surface interface, plus what the desktop handlers need: the connection, the run, and a
 * record of the errors each top-level step met (the step runner keeps only messages; the desktop task classifies a
 * failure by its error).
 */
export interface DesktopSurface extends Surface {
  readonly kind: 'desktop';
  readonly client: RunnerClient;
  readonly runId: string;
  readonly app: DesktopApp;
  /** The first error each top-level step index met (runner errors and the handlers' own). */
  readonly errors: Map<number, Error>;
  /** Engine snapshot refs (e1, e2, …) to the runner's refs of the last snapshot. */
  readonly refs: Map<string, string>;
  /** The value of every variable the run typed into a field: the desktop task masks them out of messages, logs, views and read outputs. */
  readonly typed: string[];
  /**
   * Every text the run read from the clipboard, kept apart from `typed`: masked like typed values everywhere but in the
   * read's own output, where a text that is also a typed variable value still stays masked.
   */
  readonly clipboard: string[];
  /**
   * The steps AI repair added or changed, by index, and how each acts before approval (empty outside a repair or its
   * proof): see ChangedStep. Any action a mark does not allow is refused before it is sent.
   */
  readonly changedSteps: Map<number, ChangedStep>;
  /**
   * While AI repair runs steps on the live run (undefined otherwise): the longest a step waits for its control to appear
   * (resolve, a wait, a check), so a step that drifted too reaches the model without waiting out its full timeout. The
   * action itself keeps the step's own timeout; the proof and every other run wait the full step timeout.
   */
  waitCapMs: number | undefined;
  /** Tells the surface which top-level step is running, for `errors`. */
  trackStep(current: () => number | undefined): void;
  /** Records an error against the running step. */
  record(err: unknown): void;
  /** A runner call with this run's id, recorded on failure. `waitMs`: see RunnerClient.call. */
  rpc<M extends RunnerMethod>(method: M, params: Omit<RunnerMethods[M]['params'], 'runId'>, waitMs?: number): Promise<RunnerMethods[M]['result']>;
  /**
   * Refreshes the window `address()` names (a one-node snapshot). When the run has no window left (not_found) the last
   * known window stays; any other runner error is thrown.
   */
  refreshWindow(): Promise<void>;
  /** The window title of the last snapshot ('' before any). */
  windowTitle(): string;
  /**
   * The run's top-level windows (the runner's `windows`); [] from a runner older than the method. Other errors are thrown.
   * The titles (and all other fields) are the runner's raw, unmasked app text: mask them before putting them in any message.
   */
  windows(): Promise<RunnerWindow[]>;
  /**
   * A view of one window (the foreground window without a selector) with automation ids, classes and parents per ref.
   * Names and values are masked as snapshot() masks them, and for the run's typed variable values too; password and
   * credential-like values are never shown. Refs continue a counter of this surface, so they never repeat across views.
   * Does not change the window `address()` names.
   */
  view(masker: Masker, opts?: { window?: WindowSel; maxNodes?: number; picture?: boolean }): Promise<DesktopView>;
  /** The raw node behind a ref of the last view; undefined after a newer view or snapshot. */
  nodeOf(ref: string): DesktopViewNode | undefined;
  /**
   * The items of the last view in view order, built from the raw nodes: unmasked and unclipped, for the engine's local
   * matching against the runner's own conditions (never for a message). [] after a snapshot.
   */
  rawItems(): DesktopViewItem[];
  /**
   * The clipboard's text (the runner's clipboard.read), added to `clipboard` so it is masked everywhere but in its own
   * read output. A runner older than the method fails with RUNNER_TOO_OLD_FOR_CLIPBOARD; every failure is recorded.
   */
  readClipboard(): Promise<string>;
}

/** A runner answered "method not found" to a method this run needs: the runner must be updated. */
export class RunnerTooOldError extends RunnerError {
  constructor(code: number, message: string) {
    super(code, message);
    this.name = 'RunnerTooOldError';
  }
}

/** Creates the desktop surface for one run (run.begin already answered). */
/**
 * `neverToRunner`: secrets the view's masker holds that are never sent to the runner, not even for it to cover in a
 * screenshot (the step-signing key: the runner never gets it).
 */
export function createDesktopSurface(client: RunnerClient, runId: string, app: DesktopApp, opts: { neverToRunner?: readonly string[] } = {}): DesktopSurface {
  const neverToRunner = (opts.neverToRunner ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0);
  const errors = new Map<number, Error>();
  const refs = new Map<string, string>();
  const typed: string[] = [];
  const clipboard: string[] = [];
  let current: () => number | undefined = () => undefined;
  let window = { title: '', exe: app.exe.split(/[\\/]/).pop() ?? app.exe };
  /** The raw nodes of the last view, by ref; cleared on every view and snapshot. */
  const viewNodes = new Map<string, DesktopViewNode>();
  let nextViewRef = 1;
  /** The runner answered `look` with "method not found": views go back to `snapshot` for the rest of the run. */
  let noLook = false;

  const record = (err: unknown) => {
    const at = current() ?? -1;
    if (err instanceof Error && !errors.has(at)) errors.set(at, err);
  };
  /** A runner call with this run's id, not recorded. */
  const call = async <M extends RunnerMethod>(method: M, params: Omit<RunnerMethods[M]['params'], 'runId'>, waitMs?: number) => {
    const full = { ...params, runId } as RunnerMethods[M]['params'];
    const timeoutMs = (full as { timeoutMs?: unknown }).timeoutMs;
    return typeof timeoutMs === 'number' && waitMs === undefined
      ? await client.callWithin(method, full as RunnerMethods[M]['params'] & { timeoutMs: number })
      : await client.call(method, full, waitMs);
  };
  const rpc = async <M extends RunnerMethod>(method: M, params: Omit<RunnerMethods[M]['params'], 'runId'>, waitMs?: number) => {
    try {
      return await call(method, params, waitMs);
    } catch (err) {
      record(err);
      throw err;
    }
  };
  const isVisible = async (target: Locator) => (await rpc('isVisible', { target: runnerTarget(target as unknown as DesktopLocator) })).visible;

  const surface: DesktopSurface = {
    kind: 'desktop',
    client, runId, app, errors, refs, typed, clipboard, changedSteps: new Map<number, ChangedStep>(), waitCapMs: undefined,
    trackStep: (fn) => { current = fn; },
    record,
    rpc,
    isClosed: () => client.closed,
    address: () => `desktop://${window.exe}/${window.title}`,
    windowTitle: () => window.title,
    isVisible,
    async checkExpect(expect: Expect, timeoutMs: number) {
      // parseDesktopScript refuses url and heading in desktop step sets; refuse here too rather than ignore them.
      if (expect.url !== undefined || expect.heading !== undefined) {
        const err = new Error('expect.url and expect.heading are browser checks');
        record(err);
        throw err;
      }
      if (!expect.visible) return;
      const visible = expect.visible;
      const waitMs = capWait(surface, timeoutMs);
      const ok = await poll(() => isVisible(visible), waitMs, POLL_MS);
      if (!ok) {
        const err = new DesktopDriftError(`expected ${describeDesktopLocator(visible as unknown as DesktopLocator)} to be visible within ${Math.round(waitMs / 100) / 10} s`);
        record(err);
        throw err;
      }
    },
    async snapshot(masker: Masker, opts: SnapshotOptions = {}): Promise<Snapshot & { nextRef: number }> {
      const snap = await rpc('snapshot', { maxNodes: opts.maxElements ?? 400 });
      window = { title: snap.window.title, exe: snap.window.exe };
      refs.clear();
      viewNodes.clear();
      let next = opts.refStart ?? 1;
      const lines: string[] = [];
      const elements: SnapshotElement[] = snap.nodes.map((n) => {
        const ref = `e${next++}`;
        refs.set(ref, n.ref);
        const fullName = maskClipped(masker, n.name ?? '', FULL_NAME_CLIP);
        // The runner never sends password or credential-like values; the engine applies its own credential check too.
        const hidden = n.valueHidden === true || hidesValue([n.name ?? '', n.automationId ?? '']);
        const value = opts.values === false || hidden || !n.value ? undefined : maskClipped(masker, n.value, NAME_CLIP);
        lines.push(`${'  '.repeat(Math.min(n.depth, 25))}${n.controlType} "${fullName.slice(0, NAME_CLIP)}"`);
        return {
          ref, role: n.controlType, name: fullName.slice(0, NAME_CLIP), fullName, tag: n.controlType,
          ...(value ? { value } : {}), ...(hidden && (n.valueHidden || n.value) && opts.values !== false ? { valueHidden: true as const } : {}),
          ...(n.enabled === false ? { states: 'enabled=false' } : {}),
        };
      });
      return {
        url: masker.mask(`desktop://${window.exe}/${window.title}`),
        title: masker.mask(window.title).slice(0, 200),
        text: maskClipped(masker, lines.join('\n'), TEXT_CLIP * 2).slice(0, opts.maxText ?? TEXT_CLIP),
        elements, overlays: [], nextRef: next,
      };
    },
    async windows() {
      try {
        return (await call('windows', {})).windows;
      } catch (err) {
        // A runner older than the method: no windows to list, and no step failure.
        if (err instanceof RunnerError && err.code === METHOD_NOT_FOUND) return [];
        record(err);
        throw err;
      }
    },
    async view(given: Masker, opts: { window?: WindowSel; maxNodes?: number; picture?: boolean } = {}): Promise<DesktopView> {
      viewNodes.clear();
      const params = { ...(opts.window ? { window: opts.window } : {}), maxNodes: opts.maxNodes ?? 400 };
      // The runner covers the controls showing these texts in the picture (and what the run typed, and password fields):
      // the same values the text view masks. When they do not all fit, no picture: never a partial list.
      const masks = opts.picture ? pictureMaskTexts(given.secrets, typed, clipboard, neverToRunner) : undefined;
      let snap: RunnerMethods['look']['result'];
      let noPicture: string | undefined;
      if (masks && 'refused' in masks) {
        snap = await rpc('snapshot', params);
        noPicture = masks.refused;
      } else if (masks && !noLook) {
        try {
          snap = await call('look', { ...params, labelStart: nextViewRef, mask: masks.texts });
        } catch (err) {
          if (!(err instanceof RunnerError && err.code === METHOD_NOT_FOUND)) { record(err); throw err; }
          noLook = true;
          snap = await rpc('snapshot', params);
          noPicture = RUNNER_TOO_OLD_FOR_PICTURES;
        }
      } else {
        snap = await rpc('snapshot', params);
        if (opts.picture) noPicture = RUNNER_TOO_OLD_FOR_PICTURES;
      }
      // The run's typed variable values and clipboard texts are masked here too, whatever masker the caller built.
      const long = [...typed, ...clipboard].filter((t) => t.length >= MIN_MASKED_TYPED && !given.secrets.includes(t));
      const masker = long.length ? createMasker([...given.secrets, ...long]) : given;
      const raw = { title: snap.window.title, exe: snap.window.exe };
      const truncated = snap.truncated === true;
      /** The ref of the last node seen at each depth: a node's parent is the nearest preceding node one level up. */
      const at: string[] = [];
      const items = snap.nodes.map((n): DesktopViewItem => {
        const ref = `e${nextViewRef++}`;
        const parent = n.depth > 0 ? at[n.depth - 1] : undefined;
        at.length = Math.max(0, n.depth);
        at[n.depth] = ref;
        viewNodes.set(ref, { node: n, ...(parent ? { parent } : {}), window: raw, truncated });
        const fullName = maskClipped(masker, n.name ?? '', FULL_NAME_CLIP);
        // As snapshot(): the runner never sends password or credential-like values; the engine applies its own check too.
        const hidden = n.valueHidden === true || hidesValue([n.name ?? '', n.automationId ?? '']);
        const value = hidden || !n.value ? undefined : maskClipped(masker, n.value, NAME_CLIP);
        return {
          ref, ...(parent ? { parent } : {}), depth: n.depth, controlType: n.controlType, name: fullName.slice(0, NAME_CLIP), fullName,
          automationId: maskClipped(masker, n.automationId ?? '', NAME_CLIP), className: maskClipped(masker, n.className ?? '', NAME_CLIP), enabled: n.enabled !== false,
          ...(value ? { value } : {}), ...(hidden && (n.valueHidden || n.value) ? { valueHidden: true as const } : {}),
        };
      });
      const pic = snap.picture;
      const picture = opts.picture && pic && typeof pic.base64 === 'string' && pic.base64.length > 0 && pic.mime === 'image/png'
        && Number.isInteger(pic.width) && Number.isInteger(pic.height) && pic.width > 0 && pic.height > 0
        ? { mime: 'image/png' as const, base64: pic.base64, width: pic.width, height: pic.height, masked: Number(pic.masked) || 0 }
        : undefined;
      if (opts.picture && !picture) noPicture ??= typeof snap.noPicture === 'string' ? masker.mask(snap.noPicture).slice(0, 200) : 'the runner sent no picture';
      return {
        window: { title: masker.mask(raw.title).slice(0, 200), exe: masker.mask(raw.exe) }, truncated, items,
        ...(picture ? { picture } : {}), ...(noPicture ? { noPicture } : {}),
      };
    },
    nodeOf: (ref) => viewNodes.get(ref),
    rawItems: () => [...viewNodes].map(([ref, { node, parent }]): DesktopViewItem => ({
      ref, ...(parent ? { parent } : {}), depth: node.depth, controlType: node.controlType, name: node.name ?? '', fullName: node.name ?? '',
      automationId: node.automationId ?? '', className: node.className ?? '', enabled: node.enabled !== false,
    })),
    async readClipboard() {
      let r: { text: string };
      try {
        r = await call('clipboard.read', {});
      } catch (err) {
        const e = err instanceof RunnerError && err.code === METHOD_NOT_FOUND ? new RunnerTooOldError(err.code, RUNNER_TOO_OLD_FOR_CLIPBOARD) : err;
        record(e);
        throw e;
      }
      const text = typeof r?.text === 'string' ? r.text : '';
      if (text && !clipboard.includes(text)) clipboard.push(text);
      return text;
    },
    async refreshWindow() {
      try {
        // The smallest snapshot the runner takes (maxNodes and maxDepth are each at least 1): the window and its root.
        const snap = await client.call('snapshot', { runId, maxNodes: 1, maxDepth: 1 });
        window = { title: snap.window.title, exe: snap.window.exe };
      } catch (err) {
        // The app closed its last window (not_found): the last known window stays. Anything else is a real fault.
        if (!(err instanceof ElementNotFoundError)) throw err;
      }
    },
  };
  return surface;
}

/** How long a step waits for a control to appear: its timeout, or less while AI repair runs steps on (waitCapMs). */
export function capWait(surface: Pick<DesktopSurface, 'waitCapMs'>, timeoutMs: number): number {
  return surface.waitCapMs === undefined ? timeoutMs : Math.min(timeoutMs, surface.waitCapMs);
}

/** The app no longer matches the steps (an expectation or a wait did not hold), as opposed to a runner fault. */
export class DesktopDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopDriftError';
  }
}
