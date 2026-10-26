import type { ErrorCode, StepFailure, Violation } from '../types.js';

/** Prefix of a step failure message that reports a named detect outcome (e.g. `detected:login_failed`). */
export const DETECTED_PREFIX = 'detected:';

export type FailureClass = ErrorCode | 'drift';
export interface FailureFacts {
  violations: Violation[];
  failure?: StepFailure;
  startStatus?: number | null;
  startError?: string;
  /** How a start-page status is read: 'classify' (v1: 404/410 drift) or 'report' (quick operations: 404/410 not_found). */
  startStatusMode?: 'classify' | 'report';
  pageText?: string;
  /** True once a detect step saw `logged_in`; lockout wording on the page is then ignored. */
  loginConfirmed?: boolean;
}

const LOCKED_TEXT = /account (has been |is )?(locked|disabled|suspended)|too many (failed )?(sign-in |login |log-in )?attempts/i;
const NETWORK = /net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|HTTP 5\d\d/;
const INCOMPLETE_PREFIXES = ['paginate: still a next page', 'download exceeds', 'download type ', 'limit: ', 'capture: '];
/** Prefixes that drive classification but are not shown: the lane message is the text after them, without the intent. */
export const SHOWN_PREFIXES = ['limit: ', 'capture: '] as const;
export function stripShownPrefix(message: string): string {
  const p = SHOWN_PREFIXES.find((x) => message.startsWith(x));
  return p ? message.slice(p.length) : message;
}
/** The lane message for a failed step: `<intent>: <message>`, or the bare text of a limit or capture failure. */
export function shownFailure(intent: string, message: string): string {
  const stripped = stripShownPrefix(message);
  return stripped !== message ? stripped : `${intent}: ${message}`;
}

/** Maps a failure class to its public error code ('drift' becomes 'drift_detected'). */
export function toErrorCode(c: FailureClass): ErrorCode {
  return c === 'drift' ? 'drift_detected' : c;
}

/**
 * Classifies a failed run. Order: fatal violation, start-page failure (404/410 = drift: the page moved; any other
 * 4xx/5xx or a network error = site_down, e.g. a WAF block or rate limit), detect outcomes, lockout text
 * (only before login is confirmed), runaway pagination or rejected downloads (incomplete), network errors;
 * anything else is drift (the page no longer matches the script).
 */
export function classifyFailure(f: FailureFacts): FailureClass {
  if (f.violations.some((v) => v.fatal)) return 'policy_violation';
  if (f.startStatus === 404 || f.startStatus === 410) return f.startStatusMode === 'report' ? 'not_found' : 'drift';
  if (f.startError || (f.startStatus ?? 0) >= 400) return 'site_down';
  const msg = f.failure?.message ?? '';
  if (msg.startsWith(`${DETECTED_PREFIX}login_failed`)) return 'login_failed';
  if (msg.startsWith(`${DETECTED_PREFIX}account_locked`)) return 'account_locked';
  if (msg.startsWith(`${DETECTED_PREFIX}mfa_`)) return 'auth_blocked';
  if (!f.loginConfirmed && f.pageText && LOCKED_TEXT.test(f.pageText)) return 'account_locked';
  if (INCOMPLETE_PREFIXES.some((p) => msg.startsWith(p))) return 'incomplete';
  if (NETWORK.test(msg)) return 'site_down';
  return 'drift';
}
