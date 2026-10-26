import { token } from '../proposal/describe.js';
import type { PortalPolicy, Step } from '../types.js';

// One rule for naming and matching form submissions: the policy's allowedSubmits, the steps' declared submit and
// download.via targets (validate, derive, the submit and download handlers) and the session's step window.

/** One allowed submission: method, host and path, matched exactly (the method in any case). */
export type AllowedSubmit = PortalPolicy['allowedSubmits'][number];

/** The submission a step declares: its submit, or its download's form (via); undefined for any other step. */
export function declaredTarget(s: Step) {
  return 'submit' in s ? s.submit : 'download' in s ? s.download.via : undefined;
}

/** A declared submit or download.via target as a submission: the host defaults to the start URL's, the method to POST (uppercased). */
export function submitKey(t: { path: string; host?: string; method?: string }, startUrl: string): AllowedSubmit {
  return { host: t.host ?? new URL(startUrl).host, path: t.path, method: (t.method ?? 'POST').toUpperCase() };
}

/** How a submission is shown and keyed: `POST host/path`. */
export function submitLabel(t: AllowedSubmit): string {
  return `${t.method.toUpperCase()} ${token(t.host)}${token(t.path)}`;
}

/** Same method (in any case), host and path. */
export function sameSubmit(a: AllowedSubmit, b: AllowedSubmit): boolean {
  return a.host === b.host && a.path === b.path && a.method.toUpperCase() === b.method.toUpperCase();
}

/** True when the policy lists this submission. */
export function isAllowedSubmit(policy: Pick<PortalPolicy, 'allowedSubmits'>, t: AllowedSubmit): boolean {
  return policy.allowedSubmits.some((a) => sameSubmit(a, t));
}
