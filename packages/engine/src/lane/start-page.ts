import type { Page } from 'playwright-core';
import { classifyFailure, toErrorCode } from '../classify/classify.js';
import { BROWSER_ERROR_PAGE, notLoaded, notReachedNetworkIdle } from '../messages.js';
import type { Masker } from '../secrets/mask.js';
import { isLoginPage } from '../steps/handlers/auth.js';
import { absoluteHttpUrl } from '../steps/parse.js';
import { MAX_TEXT_BYTES, truncateUtf8 } from '../steps/handlers/capture.js';
import { outputUrl, shownMessage } from '../steps/urls.js';
import type { ErrorCode, PageInfo, PortalPolicy, Script, WaitUntil } from '../types.js';
import type { LaneRuntime } from './script-lane.js';

/** The page's visible text, masked, for classifyFailure ('' when it cannot be read). */
export async function maskedPageText(page: Page, masker: Masker): Promise<string> {
  return masker.mask(await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''));
}

/** Timeout of a start page that is not itself a step (v1). A start page taken from steps[0] uses that step's timeout. */
export const START_TIMEOUT_MS = 30_000;

/** What the first navigation of a run (script lane, first run, prove) returned. */
export interface StartPageResult {
  /** HTTP status of the main document; null when goto threw or returned no response. */
  status: number | null;
  /** The masked first line of the navigation error, a golden timeout message, or the browser-error-page message. */
  error?: string;
  /** A response object came back (prove treats a null response as a failed start). */
  responded: boolean;
  /** v1 ('classify') rule: no error and (no status, status < 400, or a declared login page served with 401/403). */
  proceed: boolean;
}

/** Where a run starts. firstStep 1: startUrl came from steps[0].goto, so that step is the start page and is not replayed. */
interface StartPlan {
  url: string;
  waitUntil: WaitUntil;
  firstStep: 0 | 1;
}

export function startPlan(raw: unknown, script: Script): StartPlan {
  const doc = Array.isArray(raw) ? { steps: raw } : raw;
  const rawStart = typeof doc === 'object' && doc !== null ? (doc as { startUrl?: unknown }).startUrl : undefined;
  const first = script.steps[0];
  // Only a plain goto (no when/optional/expect) can stand in for the start page: the lane never replays a gated step.
  if (
    rawStart === undefined && first !== undefined && 'goto' in first && !first.when && !first.optional && !first.expect
    && absoluteHttpUrl(first.goto) === script.startUrl
  ) {
    return { url: script.startUrl, waitUntil: first.waitUntil ?? 'domcontentloaded', firstStep: 1 };
  }
  return { url: script.startUrl, waitUntil: 'domcontentloaded', firstStep: 0 };
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));
const isBrowserErrorPage = (url: string) => url.startsWith('chrome-error://');

/**
 * Loads the start page. Never throws. A timeout becomes the golden "did not reach network idle" / "did not finish
 * loading" message; any other error is its masked first line; a browser error page is never a success.
 */
export async function openStartPage(
  page: Page, url: string, opts: { policy: PortalPolicy; masker: Masker; timeoutMs?: number; waitUntil?: WaitUntil },
): Promise<StartPageResult> {
  const timeoutMs = opts.timeoutMs ?? START_TIMEOUT_MS;
  const waitUntil = opts.waitUntil ?? 'domcontentloaded';
  let status: number | null = null;
  let error: string | undefined;
  let responded = false;
  try {
    const res = await page.goto(url, { waitUntil, timeout: timeoutMs });
    responded = res !== null;
    status = res?.status() ?? null;
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    error = timedOut
      ? (waitUntil === 'networkidle' ? notReachedNetworkIdle(seconds(timeoutMs)) : notLoaded(seconds(timeoutMs)))
      : shownMessage((err instanceof Error ? err.message : String(err)).split('\n')[0], opts.masker);
  }
  if (error === undefined && isBrowserErrorPage(page.url())) error = BROWSER_ERROR_PAGE;
  // A login page may itself be served with 401/403 (forms auth); the steps decide from there.
  const loginPage401 = error === undefined && (status === 401 || status === 403) && isLoginPage(opts.policy, page.url());
  const proceed = error === undefined && (status === null || status < 400 || loginPage401);
  return { status, ...(error !== undefined ? { error } : {}), responded, proceed };
}

/** 'report' (quick operations): any status but 404, 410 and 5xx proceeds and is reported; 'classify' is v1. */
export function startProceeds(r: StartPageResult, mode: 'classify' | 'report' = 'classify'): boolean {
  if (mode === 'classify') return r.proceed;
  if (r.error !== undefined) return false;
  return r.status === null || (r.status !== 404 && r.status !== 410 && r.status < 500);
}

/**
 * The failure for a start page that did not proceed: a run-level outcome (fatal violation, disconnect, cancel, budget)
 * wins; otherwise the start-page classification. Callers await `Session.idle()` first, so a late private redirect hop
 * is already recorded and yields policy_violation.
 */
export function startPageFailure(runtime: LaneRuntime, r: StartPageResult, mode: 'classify' | 'report' = 'classify'): { code: ErrorCode; message: string } {
  const o = runtime.override('the start page');
  if (o) return o;
  const cls = classifyFailure({ violations: runtime.session.violations, startError: r.error, startStatus: r.status, startStatusMode: mode });
  return { code: toErrorCode(cls), message: r.error ?? `HTTP ${r.status} at the start page` };
}

/**
 * The envelope's url/title/status: the final URL sanitised by outputUrl (query kept: this is output, not a message;
 * no userinfo or fragment, sensitive parameter values redacted) and then masked, the masked title, and the status of the
 * last document response when it is this page (same origin and path; a popup or a download leaves it null).
 */
export async function pageInfo(page: Page, lastDocument: { url: string; status: number } | null, masker: Masker): Promise<PageInfo> {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const status = lastDocument && samePage(lastDocument.url, url) ? lastDocument.status : null;
  // The title is page-controlled: masked first, then capped like read: title.
  return { url: masker.mask(outputUrl(url)), title: truncateUtf8(masker.mask(title), MAX_TEXT_BYTES).text, status };
}

function samePage(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  const x = new URL(a);
  const y = new URL(b);
  return x.origin === y.origin && x.pathname === y.pathname;
}
