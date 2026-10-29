import type { Snapshot, SnapshotOptions } from '../agent/snapshot.js';
import type { Masker } from '../secrets/mask.js';
import type { Expect, Locator } from '../types.js';

/** What a run drives: a web page through the browser, or (later) a Windows desktop through the desktop runner. */
export type SurfaceKind = 'browser' | 'desktop';

/**
 * What the step runner and the repair agent need from whatever a run drives. Step handlers are registered per surface
 * kind (steps/handlers/index.ts): finding an element and acting on it stay inside each kind's handlers.
 *
 * Browser-only, outside this interface (on StepContext.page and the session): the network allow-list and redirect
 * guard, write windows and armSubmit, signIn and detect, goto, popup, submit and download (network quiet),
 * extractTable with idPattern, screenshot masks, interrupts, step hooks (trace groups, live-view markers) and the
 * agent's browser tool set.
 */
export interface Surface {
  readonly kind: SurfaceKind;
  /** True once the surface can no longer act (page closed, session gone). */
  isClosed(): boolean;
  /** The raw current address (browser: the page URL). Used for state keys and login-page checks; mask before showing. */
  address(): string;
  /** Whether a target is visible now (a step's `when`, `expect.visible`). */
  isVisible(target: Locator): Promise<boolean>;
  /** A step's `expect`, polled until it holds or the timeout passes; the error names what did not hold. */
  checkExpect(expect: Expect, timeoutMs: number): Promise<void>;
  /** What the repair agent reads. */
  snapshot(masker: Masker, opts?: SnapshotOptions): Promise<Snapshot & { nextRef: number }>;
}
