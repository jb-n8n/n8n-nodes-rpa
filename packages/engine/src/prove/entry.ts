// Where a reused healing session starts the work. Some portals keep each window's state on the server
// (SAP GUI for HTML: /sap(<context>)/...): the page URL captured right after sign-in names a window the repair has since
// moved on, so prove and the agent's restart open the work's entry page with the reused cookies instead (a fresh window).
import type { Page } from 'playwright-core';
import { resolveGoto } from '../policy/validate.js';
import { openStartPage, type StartPageResult } from '../lane/start-page.js';
import type { Masker } from '../secrets/mask.js';
import { isLoginPage, SESSION_SEGMENT } from '../steps/urls.js';
import type { PortalPolicy, Script } from '../types.js';

export interface WorkEntry {
  url: string;
  /** True when the entry is the goto at the resumed step (that step still runs: the page loads twice), false for the start URL. */
  fromGoto: boolean;
}

/** An http(s) URL with each session-shaped path segment (`/sap(<token>)/`) cut to its name (`/sap/`): never a window of one session. */
function sessionFree(u: URL): string {
  const path = u.pathname.split('/').map((seg) => (SESSION_SEGMENT.test(seg) ? seg.slice(0, seg.indexOf('(')) : seg)).join('/');
  if (path === u.pathname) return u.href;
  const out = new URL(u.href);
  out.pathname = path;
  return out.href;
}

/** The captured URL with its session segments cut, or undefined when it is no http(s) URL. */
function capturedPage(captured: string | undefined): string | undefined {
  if (captured === undefined) return undefined;
  try {
    const u = new URL(captured);
    return u.protocol === 'http:' || u.protocol === 'https:' ? sessionFree(u) : undefined;
  } catch { return undefined; }
}

/**
 * `raw` (resolved against base) as a session-free entry URL, or undefined when it is not one the policy lets the run open,
 * or it is a declared login page (opening a sign-in page with a signed-in session can sign the user out). The one login
 * page allowed is the captured page itself with its session segment cut (`captured`, compared by origin and path): the
 * portal serves the signed-in work at its sign-in address, as SAP GUI for HTML does at `/sap/bc/gui/sap/its/webgui`, and
 * the session was seen signed in there.
 */
function allowed(raw: string, base: string, policy: PortalPolicy, captured: string | undefined): string | undefined {
  // Run variables need the run's values (and may be secret-adjacent): a templated URL is never an entry.
  if (raw.includes('{{')) return undefined;
  const u = resolveGoto(raw, base);
  if (!u || !policy.navHosts.includes(u.host)) return undefined;
  const url = sessionFree(u);
  if (!isLoginPage(policy, url)) return url;
  const page = (href: string) => { const x = new URL(href); return `${x.origin}${x.pathname}`; };
  const cap = capturedPage(captured);
  return cap !== undefined && cap !== captured && page(cap) === page(url) ? url : undefined;
}

/**
 * The work's entry page for a session reused from step `from` on: that step's URL when it is a plain goto (no `when`, no run
 * variables), else the script's startUrl; session-free, only on a navigation host of the policy (never wider than the
 * run's own navigation), and never a declared login page unless it is the captured page (`capturedUrl`) with its session
 * segment cut. Undefined when neither qualifies: the caller keeps the captured page URL.
 */
export function workEntry(script: Script, from: number, policy: PortalPolicy, capturedUrl?: string): WorkEntry | undefined {
  const step = script.steps[from];
  if (step && 'goto' in step && !step.when) {
    const url = allowed(step.goto, script.startUrl, policy, capturedUrl);
    if (url) return { url, fromGoto: true };
  }
  const url = allowed(script.startUrl, script.startUrl, policy, capturedUrl);
  return url ? { url, fromGoto: false } : undefined;
}

export interface ReusedOpen {
  start: StartPageResult;
  /** The entry page opened and is usable (loaded, below 400, not a login page); false when the captured URL was opened. */
  atEntry: boolean;
  entry?: WorkEntry;
}

/**
 * Opens the reused session's first page: the work's entry page (workEntry), or the captured URL when there is no entry,
 * or the entry did not load, answered 400 or more, or landed on a login page (a portal whose sign-in page does not send a
 * signed-in user on). `stopped` is asked after the entry loaded: a blocked request or a cancel ends it there. `timeoutMs`
 * covers both loads: with none of it left after the entry, the entry's result is returned (not usable, so not at entry).
 */
export async function openReusedSession(page: Page, opts: {
  script: Script; from: number; policy: PortalPolicy; masker: Masker; capturedUrl: string; timeoutMs?: number; stopped: () => boolean;
}): Promise<ReusedOpen> {
  const { policy, masker } = opts;
  const startedAt = Date.now();
  // `timeoutMs` bounds both page loads together: the fallback gets only what the entry left (never twice the timeout).
  const timing = () => (opts.timeoutMs !== undefined ? { timeoutMs: Math.max(1, opts.timeoutMs - (Date.now() - startedAt)) } : {});
  const entry = workEntry(opts.script, opts.from, policy, opts.capturedUrl);
  if (entry) {
    const start = await openStartPage(page, entry.url, { policy, masker, ...timing() });
    const usable = start.error === undefined && start.responded && start.status !== null && start.status < 400 && !isLoginPage(policy, page.url());
    const timeLeft = opts.timeoutMs === undefined || Date.now() - startedAt < opts.timeoutMs;
    if (usable || opts.stopped() || !timeLeft) return { start, atEntry: usable, entry };
  }
  const start = await openStartPage(page, opts.capturedUrl, { policy, masker, ...timing() });
  return { start, atEntry: false, ...(entry ? { entry } : {}) };
}
