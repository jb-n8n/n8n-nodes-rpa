import type { PortalPolicy } from '../types.js';

export type ReadPost = { host: string; path: string };

/** The entry as shown in logs and Session.readPostsUsed: never the concrete URL (SAP puts its session id in the path). */
export function readPostLabel(r: ReadPost): string {
  return `POST ${r.host}${r.path}`;
}

const STAR_OK = /^[A-Za-z0-9_.()=~-]$/;

/**
 * How many characters of `s` at `k` one more step of a star takes: 1 for a plain character, 3 for the exact triplet
 * `%3D` / `%3d` (an encoded `=`, as in percent-encoded SAP session ids), 0 when the star must stop there.
 */
function starStep(s: string, k: number): number {
  if (STAR_OK.test(s[k] as string)) return 1;
  return s[k] === '%' && s[k + 1] === '3' && (s[k + 2] === 'D' || s[k + 2] === 'd') ? 3 : 0;
}

/** One path segment against one pattern segment: iterative wildcard match, O(n*m) worst case, no regex backtracking. */
function segmentMatches(p: string, s: string): boolean {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] !== '*' && p[i] === s[j]) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i; mark = j; i++; }
    else if (star >= 0) {
      // The star takes one more step: plain characters or `%3D` only, never another `%`, `;` `\\` or anything a server
      // might decode or strip.
      const step = starStep(s, mark);
      if (step === 0) return false;
      mark += step; j = mark; i = star + 1;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/**
 * Anchored match of a pathname against a pattern. Literal parts compare exactly. `*` matches within one segment (never
 * across `/`) and only the characters `A-Za-z0-9_.()=~-` plus the exact triplet `%3D`/`%3d` (decodes to `=`): no other
 * `%`, no `;`, `\` or anything else a server or proxy could decode or strip to route elsewhere.
 * Linear-ish: the pathname comes from the page.
 */
export function readPathMatches(pattern: string, pathname: string): boolean {
  const ps = pattern.split('/');
  const xs = pathname.split('/');
  return ps.length === xs.length && ps.every((seg, k) => segmentMatches(seg, xs[k] as string));
}

/** The first read-only entry a request matches: method POST (any case), same host (port included), pathname only. */
export function matchingReadPost(policy: Pick<PortalPolicy, 'readPosts'>, url: string, method: string): ReadPost | undefined {
  if (method.toUpperCase() !== 'POST' || !policy.readPosts?.length) return undefined;
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  return policy.readPosts.find((r) => r.host === u.host && readPathMatches(r.path, u.pathname));
}

/** A pattern that would admit nearly every path: `**`, or nothing but `/` and `*`. */
export function readPathTooBroad(pattern: string): boolean {
  return pattern.includes('**') || !/[^/*]/.test(pattern);
}

/**
 * Why a policy's read-only list cannot be used, or undefined when it can. openSession refuses such a policy (defence in
 * depth: the node's credential parsing already refuses these entries, with the same wording).
 */
export function readPostsProblem(readPosts: unknown): string | undefined {
  if (readPosts === undefined) return undefined;
  if (!Array.isArray(readPosts)) return 'Read-only requests must be a list';
  for (const [k, r] of readPosts.entries()) {
    const e = r as Partial<ReadPost> | null;
    if (typeof e !== 'object' || e === null || typeof e.host !== 'string' || !e.host || typeof e.path !== 'string' || !e.path.startsWith('/')) {
      return `Read-only request ${k + 1} must have a host and a path starting with /`;
    }
    const shown = JSON.stringify(readPostLabel(e as ReadPost));
    if (e.path.includes('**')) return `Read-only request ${shown}: use a single * (it never matches /)`;
    if (readPathTooBroad(e.path)) return `Read-only request ${shown} must name at least one part of the path besides *`;
  }
  return undefined;
}
