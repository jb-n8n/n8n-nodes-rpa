import type { Snapshot, SnapshotElement, SnapshotOptions } from '../agent/snapshot.js';
import { hidesValue } from '../secrets/credential-field.js';
import { maskClipped, type Masker } from '../secrets/mask.js';
import { poll } from '../steps/poll.js';
import type { Surface } from '../surface/surface.js';
import type { DesktopApp, DesktopLocator, Expect, Locator, UiaTarget } from '../types.js';
import type { RunnerClient } from './client.js';
import type { RunnerMethod, RunnerMethods, RunnerTarget } from './protocol.js';

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
  /** Every text the run typed or selected (rendered values): the desktop task masks them out of messages and logs. */
  readonly typed: string[];
  /** Tells the surface which top-level step is running, for `errors`. */
  trackStep(current: () => number | undefined): void;
  /** Records an error against the running step. */
  record(err: unknown): void;
  /** A runner call with this run's id, recorded on failure. `waitMs`: see RunnerClient.call. */
  rpc<M extends RunnerMethod>(method: M, params: Omit<RunnerMethods[M]['params'], 'runId'>, waitMs?: number): Promise<RunnerMethods[M]['result']>;
  /** Refreshes the window `address()` names (a one-node snapshot). Never throws. */
  refreshWindow(): Promise<void>;
  /** The window title of the last snapshot ('' before any). */
  windowTitle(): string;
}

/** Creates the desktop surface for one run (run.begin already answered). */
export function createDesktopSurface(client: RunnerClient, runId: string, app: DesktopApp): DesktopSurface {
  const errors = new Map<number, Error>();
  const refs = new Map<string, string>();
  const typed: string[] = [];
  let current: () => number | undefined = () => undefined;
  let window = { title: '', exe: app.exe.split(/[\\/]/).pop() ?? app.exe };

  const record = (err: unknown) => {
    const at = current() ?? -1;
    if (err instanceof Error && !errors.has(at)) errors.set(at, err);
  };
  const rpc = async <M extends RunnerMethod>(method: M, params: Omit<RunnerMethods[M]['params'], 'runId'>, waitMs?: number) => {
    const full = { ...params, runId } as RunnerMethods[M]['params'];
    try {
      const timeoutMs = (full as { timeoutMs?: unknown }).timeoutMs;
      return typeof timeoutMs === 'number' && waitMs === undefined
        ? await client.callWithin(method, full as RunnerMethods[M]['params'] & { timeoutMs: number })
        : await client.call(method, full, waitMs);
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
    async refreshWindow() {
      try {
        const snap = await client.call('snapshot', { runId, maxNodes: 1, maxDepth: 0 });
        window = { title: snap.window.title, exe: snap.window.exe };
      } catch {
        // Keeps the last known window.
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
