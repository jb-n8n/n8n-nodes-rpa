import type { PortalPolicy } from '../types.js';

// The destructive-action denylist. The agent's tools refuse controls that match it (agent/tools.ts), and agent and prove
// sessions refuse main-frame navigations whose path or query matches it (destructiveNavigation, via checkRequest).

/**
 * Destructive controls, tested with letter boundaries. Apply it through `isDestructive`, which normalizes first
 * (homoglyphs, zero-width characters, camelCase, `_`/`-`), so `deleteAll`, `delete_all` and `Dеlete` (Cyrillic е) match too.
 * Whole words only: `Cancelled orders`, `Confirmed`, `Sender` and `Payroll` are not destructive.
 */
export const DENYLIST = new RegExp(
  '(?<![a-z])((?:delete|remove|acknowledge|ack|approve|reject|cancel|archive|confirm|pay|payment|send|transfer|deactivate|revoke|purge|destroy|refund|unsubscribe)(?: ?all)?'
  + '|log ?out|log ?off|sign ?out|cancel ?order|submit ?order)(?![a-z])',
  'i',
);
/** Zero-width and soft-hyphen characters: invisible on the page, used to split words past a filter. */
export const INVISIBLE = /[­​-‍⁠﻿]/;
/** Cyrillic and Greek letters that render like Latin ones. */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', һ: 'h',
  А: 'A', В: 'B', Е: 'E', Ё: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', Ԁ: 'D', Ӏ: 'I',
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};

/**
 * Folds text for matching: per code point NFKC, diacritics and invisible characters dropped, homoglyphs mapped to Latin.
 * Case is kept. `owner[j]` is the index (in code points of the input) that produced folded character j.
 */
export function fold(s: string): { chars: string[]; owner: number[] } {
  const chars: string[] = [];
  const owner: number[] = [];
  [...s].forEach((c, i) => {
    if (INVISIBLE.test(c)) return;
    for (const f of c.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')) {
      chars.push(HOMOGLYPHS[f] ?? f);
      owner.push(i);
    }
  });
  return { chars, owner };
}

/** Text as the denylist sees it: folded, camelCase split, `_` and `-` as spaces, whitespace collapsed, lowercase. */
export function normalizeForDenylist(s: string): string {
  return fold(s).chars.join('')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/[_\-‐-―]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** True when the text names a destructive action (after normalization). */
export function isDestructive(s: string): boolean {
  return DENYLIST.test(normalizeForDenylist(s));
}

/** One lenient pass: every run of valid `%XX` escapes is decoded (as UTF-8, else byte by byte); malformed `%` is kept. */
function decodeOnce(s: string): string {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))); }
  });
}

/**
 * Percent-decodes up to five times (so `%2563ancel` reads as `cancel`). Lenient, as servers are: a malformed escape
 * (`%ZZ`, a cut UTF-8 sequence) does not stop the decoding of the rest.
 */
function decodeRepeatedly(s: string): string {
  let out = s;
  for (let i = 0; i < 5; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** True when a URL query (`?a=b&c=d`, `+` read as a space) names a destructive action once decoded. */
function destructiveQuery(search: string): boolean {
  return isDestructive(decodeRepeatedly(search.replace(/\+/g, ' ')));
}

/** True when a parsed URL's decoded path or query names a destructive action. */
function destructivePathOrQuery(u: URL): boolean {
  return isDestructive(decodeRepeatedly(u.pathname)) || destructiveQuery(u.search);
}

/**
 * True when a URL's decoded path or query names a destructive action (`/orders/7?action=cancel`, `/admin/purge`,
 * `?op=%63ancel`). `+` in the query reads as a space. Host and fragment are not checked. Text that is not a URL is
 * checked as it is.
 */
export function isDestructiveUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw, 'http://placeholder.invalid'); } catch { return isDestructive(decodeRepeatedly(raw)); }
  return destructivePathOrQuery(u);
}

/** The last start URL parsed, so a navigation does not parse policy.startUrl again (null: not a URL, nothing exempt). */
let lastStart: { raw: string; url: URL | null } | undefined;
function startUrlOf(raw: string): URL | null {
  if (lastStart?.raw !== raw) lastStart = { raw, url: URL.canParse(raw) ? new URL(raw) : null };
  return lastStart.url;
}

/**
 * Agent and prove sessions (`refuseDestructiveNavigation`, set by noWritePolicy): checkRequest refuses a main-frame
 * navigation whose decoded path or query names a destructive action as a write, which ends the run (policy_violation).
 * A GET can change something on a site, and injected page text can steer the model towards one. The start URL (as
 * typed) is exempt, and so is the path of a declared login page (its query is still checked). Sub-frames and
 * sub-resources are not checked. The violation shows no query.
 *
 * checkRequest calls this only for an http(s) main-frame navigation under such a policy, with the URL it parsed and
 * whether that URL is a declared login page. A redirect hop is checked by the session's redirect guard
 * (browser/redirects.ts), through checkRequest, before the browser sends it: a destructive hop ends the run.
 */
export function destructiveNavigation(policy: PortalPolicy, u: URL, loginPage: boolean): boolean {
  const start = startUrlOf(policy.startUrl);
  if (start && start.host === u.host && start.pathname === u.pathname && start.search === u.search) return false;
  return loginPage ? destructiveQuery(u.search) : destructivePathOrQuery(u);
}
