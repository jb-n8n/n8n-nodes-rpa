import type { Snapshot, SnapshotElement, SnapshotOptions } from '../agent/snapshot.js';
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
export interface DesktopView { window: { title: string; exe: string }; truncated: boolean; items: DesktopViewItem[] }
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
  /** The value of every variable the run typed into a field: the desktop task masks them out of messages, logs and read outputs. */
  readonly typed: string[];
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
  view(masker: Masker, opts?: { window?: WindowSel; maxNodes?: number }): Promise<DesktopView>;
  /** The raw node behind a ref of the last view; undefined after a newer view or snapshot. */
  nodeOf(ref: string): DesktopViewNode | undefined;
}

/** Creates the desktop surface for one run (run.begin already answered). */
export function createDesktopSurface(client: RunnerClient, runId: string, app: DesktopApp): DesktopSurface {
  const errors = new Map<number, Error>();
  const refs = new Map<string, string>();
  const typed: string[] = [];
  let current: () => number | undefined = () => undefined;
  let window = { title: '', exe: app.exe.split(/[\\/]/).pop() ?? app.exe };
  /** The raw nodes of the last view, by ref; cleared on every view and snapshot. */
  const viewNodes = new Map<string, DesktopViewNode>();
  let nextViewRef = 1;

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
    client, runId, app, errors, refs, typed,
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
      const ok = await poll(() => isVisible(visible), timeoutMs, POLL_MS);
      if (!ok) {
        const err = new DesktopDriftError(`expected ${describeDesktopLocator(visible as unknown as DesktopLocator)} to be visible within ${Math.round(timeoutMs / 100) / 10} s`);
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
    async view(given: Masker, opts: { window?: WindowSel; maxNodes?: number } = {}): Promise<DesktopView> {
      viewNodes.clear();
      const snap = await rpc('snapshot', { ...(opts.window ? { window: opts.window } : {}), maxNodes: opts.maxNodes ?? 400 });
      // The run's typed variable values are masked here too, whatever masker the caller built.
      const long = typed.filter((t) => t.length >= MIN_MASKED_TYPED && !given.secrets.includes(t));
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
      return { window: { title: masker.mask(raw.title).slice(0, 200), exe: masker.mask(raw.exe) }, truncated, items };
    },
    nodeOf: (ref) => viewNodes.get(ref),
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

/** The app no longer matches the steps (an expectation or a wait did not hold), as opposed to a runner fault. */
export class DesktopDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopDriftError';
  }
}
