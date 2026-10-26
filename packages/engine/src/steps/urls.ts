// How page URLs leave the engine. Not re-exported from index.ts: lanes and handlers import these directly.
import type { Masker } from '../secrets/mask.js';
import type { PortalPolicy } from '../types.js';

/** The host (with port) of a URL, or '' when it does not parse. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

/** True when url is exactly (host and path) one of the policy's declared login pages. Unparseable URLs are not login pages. */
export function isLoginPage(policy: PortalPolicy, url: string): boolean {
  try {
    const u = new URL(url);
    return policy.login.some((l) => l.host === u.host && l.path === u.pathname);
  } catch { return false; }
}

/** A session-shaped path segment: letters, then 8 or more characters other than separators in parentheses (SAP's `/sap(<url64>)/`). */
export const SESSION_SEGMENT = /^[A-Za-z]+\([^/()?#\s;]{8,}\)$/;

/**
 * The part of a path a later run can expect: only a session-shaped segment (letters, then 8 or more id characters in
 * parentheses, as in SAP's `/sap(<url64>)/`, different on every run) is dropped along with what precedes it, so
 * `/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui` gives `/bc/gui/sap/its/webgui`. Any other path is unchanged.
 */
export function stablePath(path: string): string {
  const parts = path.split('/');
  const at = parts.findLastIndex((seg) => SESSION_SEGMENT.test(seg));
  return at < 0 ? path : parts.slice(at + 1).map((seg) => `/${seg}`).join('');
}

/**
 * A URL or text with every session-shaped path segment's token replaced by an ellipsis: `/sap(cz1...)/bc/gui` becomes
 * `/sap(…)/bc/gui`. For result and log fields: the session id is a credential of the live session and never a stable address.
 */
export function maskSessionSegments(text: string): string {
  return text.replace(/\/([A-Za-z]+)\([^/()?#\s;]{8,}\)(?=[/?#;\s"'<>`]|$)/g, '/$1(…)');
}

/** A URL as a message may show it: origin + path for http(s) (no query, fragment or userinfo), else the bare URL. */
export function shownUrl(url: string): string {
  if (URL.canParse(url)) {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return maskSessionSegments(`${u.origin}${u.pathname}`);
  }
  return maskSessionSegments(stripUserinfo(url.split(/[?#]/)[0] ?? ''));
}

/**
 * Drops the userinfo of an http(s) URL written as text. Userinfo runs to the LAST '@' before the authority ends ('/',
 * '\\', '?' or '#'), so a password containing '@' is dropped whole (greedy match).
 */
function stripUserinfo(url: string): string {
  return url.replace(/^(https?:\/\/)[^/\\?#]*@/i, '$1');
}

/** A message as it may leave the engine: masked, URLs shortened (withShownUrls), masked again. */
export function shownMessage(text: string, masker: Masker): string {
  return masker.mask(withShownUrls(masker.mask(text)));
}

/**
 * A message with every http(s) URL in it cut at its first ? or # and without userinfo. The rest is kept exactly as
 * written: never re-serialised, so nothing is percent-encoded or punycoded into a form the masker would not recognise.
 * Callers mask before and after.
 */
export function withShownUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>`]+/gi, (u) => maskSessionSegments(stripUserinfo(u.split(/[?#]/)[0] ?? '')));
}

/** Query parameter names (case-insensitive, exact or as a suffix) whose values never leave the engine in output. */
const SENSITIVE_PARAMS = [
  'token', 'access_token', 'id_token', 'refresh_token', 'code', 'session', 'sessionid', 'sid', 'sig', 'signature', 'key',
  'apikey', 'api_key', 'auth', 'password', 'passwd', 'secret', 'jwt', 'assertion', 'samlresponse', 'ticket', 'pwd', 'pass',
  'otp', 'code_verifier',
];
const REDACTED = '[redacted]';

function paramName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}
/** Array-style names (`token[]`) are matched without their trailing `[]`. */
function isSensitive(name: string): boolean {
  const base = name.endsWith('[]') ? name.slice(0, -2) : name;
  return SENSITIVE_PARAMS.some((p) => base === p || base.endsWith(p));
}

/**
 * A page URL as output may carry it (the envelope's `url`): the query is kept, because it is the page's own final URL,
 * but userinfo and the fragment (OAuth implicit flows put `#access_token=` there) are dropped, and the value of every
 * sensitive query parameter becomes `[redacted]`, keeping parameter names and order. Mask the result afterwards.
 */
export function outputUrl(url: string): string {
  if (!URL.canParse(url)) return maskSessionSegments(url.split('#')[0] ?? '');
  const u = new URL(url);
  u.username = '';
  u.password = '';
  u.hash = '';
  if (u.search.length > 1) {
    const parts = u.search.slice(1).split('&').map((part) => {
      const eq = part.indexOf('=');
      const rawName = eq === -1 ? part : part.slice(0, eq);
      return isSensitive(paramName(rawName)) ? `${rawName}=${REDACTED}` : part;
    });
    u.search = `?${parts.join('&')}`;
  }
  return maskSessionSegments(u.href);
}
