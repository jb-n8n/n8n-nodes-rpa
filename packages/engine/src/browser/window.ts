import { isAllowedSubmit, sameSubmit, type AllowedSubmit } from '../policy/submits.js';
import { hostOf } from '../steps/urls.js';
import type { PortalPolicy, RequestRecord } from '../types.js';

// The session's write windows: a write the request rules (checkRequest) refuse passes while an open window admits it.
// The Fill and Submit window and a declared submit or download step's own target are two
// instances of the same window, with their own rule.

/** Never more than this many writes per window, whatever a rule or a policy says. */
const MAX_WINDOW_POSTS = 3;

/** Which frame issued a request. A missing frame means unknown, which is treated like the main frame (strictest). */
export interface RequestFrame {
  isMain: boolean;
  url: string;
}

/** A write window as step handlers see it. Single use: open() after close() does nothing. */
export interface WriteWindow {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** The writes the window let through, in order (origin-free: method, host, path). */
  readonly posts: RequestRecord[];
}

/** What a window admits. Each check gets the policy active at request time, so restrict() changes them. */
interface WindowRule {
  /** The write (method uppercased) is one this window is for. */
  matches(policy: PortalPolicy, u: URL, method: string): boolean;
  /** The frame that issued the write may use this window. */
  frameOk(policy: PortalPolicy, frame: RequestFrame | undefined): boolean;
  /** At most this many writes (an integer 0..3); anything else means 3. */
  maxPosts?(policy: PortalPolicy): unknown;
}

/**
 * A write window with the session side attached. `admit` is called synchronously from the route handler (and the
 * redirect watchdog), right after checkRequest found a write and before any await: it reserves one of at most 3 slots,
 * so concurrent requests can never exceed the cap. A slot reserved for a request the address check then blocks is not
 * given back.
 */
export function createWindow(rule: WindowRule): {
  handle: WriteWindow; admit(policy: PortalPolicy, url: string, method: string, frame: RequestFrame | undefined): boolean;
} {
  let open = false;
  let used = false;
  const posts: RequestRecord[] = [];
  const handle: WriteWindow = {
    open() {
      if (used) return;
      used = true;
      open = true;
    },
    close() { open = false; },
    get isOpen() { return open; },
    get posts() { return posts.map((p) => ({ ...p })); },
  };
  return {
    handle,
    admit(policy, url, method, frame) {
      if (!open || !URL.canParse(url)) return false;
      const u = new URL(url);
      const m = method.toUpperCase();
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (!rule.frameOk(policy, frame) || !rule.matches(policy, u, m)) return false;
      // A malformed value must not lift the cap (NaN compares false).
      const want = rule.maxPosts?.(policy);
      const max = Number.isInteger(want) ? Math.min(MAX_WINDOW_POSTS, Math.max(0, want as number)) : MAX_WINDOW_POSTS;
      if (posts.length >= max) return false;
      posts.push({ method: m, host: u.host, path: u.pathname });
      return true;
    },
  };
}

/**
 * Fill and Submit (policy.writeWindow): POSTs to the window hosts, from a known, attached main frame only. requestFrame()
 * returns undefined for a detached frame and for requests without one (service workers, a popup's navigation issued
 * before its frame exists), so those never use this window. The hosts and cap come from the policy active at request
 * time, so restrict() to a policy without a writeWindow ends it.
 */
export const FILL_AND_SUBMIT: WindowRule = {
  matches: (policy, u, method) => method === 'POST' && (policy.writeWindow?.hosts.includes(u.host) ?? false),
  frameOk: (_policy, frame) => frame !== undefined && frame.isMain,
  maxPosts: (policy) => policy.writeWindow?.maxPosts,
};

/**
 * A declared submit or download step's own target: exactly its method, host and path, and only while the policy
 * active at request time lists it as an allowed submission. From the main frame (or an unknown one), or from a sub-frame
 * on a navigation host.
 */
export function submitTargetRule(target: AllowedSubmit): WindowRule {
  return {
    matches: (policy, u, method) => sameSubmit(target, { method, host: u.host, path: u.pathname }) && isAllowedSubmit(policy, target),
    frameOk: (policy, frame) => frame === undefined || frame.isMain || policy.navHosts.includes(hostOf(frame.url)),
  };
}

