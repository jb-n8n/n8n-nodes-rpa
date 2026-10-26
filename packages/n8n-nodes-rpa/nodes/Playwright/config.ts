import type { BrowserEndpoint, PortalPolicy, PortalSecrets } from 'n8n-rpa-engine';

export const CREDENTIALS = {
  browser: 'playwrightBrowserApi',
  siteLogin: 'playwrightSiteLoginApi',
  signing: 'playwrightScriptSigningApi',
  redis: 'playwrightRedisApi',
} as const;

/** The reference compose stack's browser server (the compose service `browser`). */
export const DEFAULT_ENDPOINT_URL = 'ws://browser:3000/';

/** Decrypted credential data as n8n hands it to a node. */
export type CredentialData = Readonly<Record<string, unknown>>;

/** A problem with node parameters or credentials: the user has to fix the configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const MIN_SIGNING_KEY_LENGTH = 32;

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'];
const text = (data: CredentialData, key: string): string => {
  const v = data[key];
  return typeof v === 'string' ? v.trim() : '';
};
/** URL.canParse keeps the failure path out of a catch block: the caller throws a ConfigError itself. */
const parseUrl = (value: string): URL | undefined => (URL.canParse(value) ? new URL(value) : undefined);
/**
 * An entry as an error message may show it: one with userinfo (user:pass@) is never echoed, and a query
 * string or fragment (which can carry a token) is cut from every word of it.
 */
const hasUserinfo = (token: string): boolean => /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(token);
const shown = (entry: string): string => (entry.split(/\s+/).some(hasUserinfo) ? '<entry with credentials>' : `"${entry.replace(/[?#]\S*/g, '')}"`);
const lines = (value: string): string[] => value.split('\n').map((l) => l.trim()).filter(Boolean);

/** Exact host as the engine compares it: lowercase, no trailing dot, no default port, no path, no wildcard. */
export function normalizeHost(raw: string): string {
  const input = raw.trim();
  if (!input) throw new ConfigError('a host entry is empty');
  if (input.includes('*')) throw new ConfigError(`${shown(input)}: wildcards are not allowed, list each exact host`);
  if (input.startsWith('/')) throw new ConfigError(`${shown(input)} must be a host such as example.com, without a path`);
  const hasScheme = SCHEME.test(input);
  const u = parseUrl(hasScheme ? input : `https://${input}`);
  if (!u?.hostname) throw new ConfigError(`${shown(input)} is not a valid host`);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
    throw new ConfigError(`${shown(input)}: only http, https, ws and wss are accepted, or give just the host`);
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new ConfigError(`${shown(input)} must be a host such as example.com, without a path`);
  }
  const hostname = u.hostname.replace(/\.$/, '');
  if (!hostname || hostname.endsWith('.')) throw new ConfigError(`${shown(input)} is not a valid host`);
  // Bare hosts are parsed as https, which already drops :443; drop :80 too (http's default port).
  const port = !hasScheme && u.port === '80' ? '' : u.port;
  return port ? `${hostname}:${port}` : hostname;
}

export function parseHosts(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean).map(normalizeHost))];
}

function hostAndPath(entry: string, label: string): { host: string; path: string } {
  if (SCHEME.test(entry)) {
    const u = parseUrl(entry);
    if (!u) throw new ConfigError(`${label} ${shown(entry)} is not a valid URL`);
    if (u.username || u.password) throw new ConfigError(`${label} ${shown(entry)} must not contain credentials`);
    return { host: normalizeHost(`${u.protocol}//${u.host}`), path: u.pathname };
  }
  const slash = entry.indexOf('/');
  if (slash <= 0) throw new ConfigError(`${label} ${shown(entry)} must look like example.com/path`);
  const host = normalizeHost(entry.slice(0, slash));
  // The URL parser percent-encodes and resolves dot segments, as the browser will see the path.
  const parsed = parseUrl(`https://placeholder.invalid${entry.slice(slash)}`);
  if (!parsed) throw new ConfigError(`${label} ${shown(entry)} is not a valid path`);
  return { host, path: parsed.pathname };
}

export function parseLoginPages(value: string, label = 'Login page'): { host: string; path: string }[] {
  return lines(value).map((l) => hostAndPath(l, label));
}

export function parseAllowedSubmits(value: string, label = 'Allowed submission'): { host: string; path: string; method: string }[] {
  return lines(value).map((l) => {
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(l);
    const method = m ? m[1].toUpperCase() : 'POST';
    if (!METHODS.includes(method)) throw new ConfigError(`${label} ${shown(l)}: method ${method} is not allowed`);
    return { ...hostAndPath(m ? m[2] : l, label), method };
  });
}

/**
 * The engine's read-post matching (policy/read-posts.ts), repeated here because this module must not load the engine at
 * module load (see notHttp below). config.test.ts pins both to the engine's behaviour.
 */
export const readPostLabelLocal = (r: { host: string; path: string }): string => `POST ${r.host}${r.path}`;
const STAR_OK = /^[A-Za-z0-9_.()=~-]$/;
/** 1 for a plain character, 3 for the exact `%3D` / `%3d` triplet, 0 where a star must stop. */
function starStep(s: string, k: number): number {
  if (STAR_OK.test(s[k] as string)) return 1;
  return s[k] === '%' && s[k + 1] === '3' && (s[k + 2] === 'D' || s[k + 2] === 'd') ? 3 : 0;
}
function segmentMatches(p: string, s: string): boolean {
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] !== '*' && p[i] === s[j]) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i; mark = j; i++; }
    else if (star >= 0) {
      const step = starStep(s, mark);
      if (step === 0) return false;
      mark += step; j = mark; i = star + 1;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}
export function readPathMatchesLocal(pattern: string, pathname: string): boolean {
  const ps = pattern.split('/');
  const xs = pathname.split('/');
  return ps.length === xs.length && ps.every((seg, k) => segmentMatches(seg, xs[k] as string));
}
export const readPathTooBroadLocal = (pattern: string): boolean => pattern.includes('**') || !/[^/*]/.test(pattern);

/** Requests That Only Read: `[POST] host/path` per line, with `*` inside one part of the path. Only POST can be listed. */
export function parseReadPosts(value: string, label = 'Read-only request'): { host: string; path: string }[] {
  return lines(value).map((l) => {
    const m = /^([A-Za-z]+)\s+(\S+)$/.exec(l);
    if (m && m[1].toUpperCase() !== 'POST') throw new ConfigError(`${label} ${shown(l)}: only POST can be listed`);
    const r = hostAndPath(m ? m[2] : l, label);
    if (r.path.includes('**')) throw new ConfigError(`${label} ${shown(l)}: use a single * (it never matches /)`);
    if (readPathTooBroadLocal(r.path)) throw new ConfigError(`${label} ${shown(l)} must name at least one part of the path besides *`);
    return r;
  });
}

/** Field labels a credential's error messages use. */
interface SiteLabels { startKey: string; start: string; nav: string; sub: string; login: string; submit: string; read: string }
const SITE_LOGIN_LABELS: SiteLabels = {
  startKey: 'loginUrl', start: 'Login Page URL', nav: 'Sites the Browser May Open', sub: 'Sites It May Load Files From', login: 'Password page', submit: 'Form', read: 'Read-only request',
};

/** A login credential → the engine's policy and secrets. Security settings only ever come from the credential. */
function siteFromCredential(data: CredentialData, l: SiteLabels): SiteLogin {
  const start = parseUrl(text(data, l.startKey));
  if (!start) throw new ConfigError(`${l.start} must be a full URL such as https://example.com/login`);
  if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new ConfigError(`${l.start} must use http or https`);
  if (start.username || start.password) throw new ConfigError(`${l.start} must not contain a username or password: use the Username and Password fields`);
  if (start.hostname.endsWith('.')) throw new ConfigError(`${l.start} host must not end with a dot`);
  const startHost = normalizeHost(`${start.protocol}//${start.host}`);
  const username = text(data, 'username');
  const password = typeof data.password === 'string' ? data.password : '';
  if (!username || !password) throw new ConfigError('Username and Password are required');
  const navHosts = [...new Set([startHost, ...parseHosts(text(data, 'navHosts'))])];
  const subresourceHosts = parseHosts(text(data, 'subresourceHosts'));
  const frameHosts = parseHosts(text(data, 'frameHosts'));
  const listedLogin = parseLoginPages(text(data, 'login'), l.login);
  const login = listedLogin.length ? listedLogin : [{ host: startHost, path: start.pathname }];
  for (const page of login) if (!navHosts.includes(page.host)) throw new ConfigError(`${l.login} host ${page.host} is not in ${l.nav}`);
  const allowedSubmits = parseAllowedSubmits(text(data, 'allowedSubmits'), l.submit);
  for (const s of allowedSubmits) {
    if (!navHosts.includes(s.host) && !subresourceHosts.includes(s.host)) throw new ConfigError(`${l.submit} host ${s.host} is not in ${l.nav} or ${l.sub}`);
  }
  const readPosts = parseReadPosts(text(data, 'readPosts'), l.read);
  for (const r of readPosts) {
    const entry = shown(readPostLabelLocal(r));
    if (!navHosts.includes(r.host) && !subresourceHosts.includes(r.host)) throw new ConfigError(`${l.read} host ${r.host} is not in ${l.nav} or ${l.sub}`);
    const form = allowedSubmits.find((s) => s.host === r.host && readPathMatchesLocal(r.path, s.path));
    if (form) throw new ConfigError(`${l.read} ${entry} also matches ${l.submit} ${shown(`${form.method} ${form.host}${form.path}`)}: list a request in one field only`);
  }
  const totp = typeof data.totpSecret === 'string' ? data.totpSecret.replace(/\s+/g, '') : '';
  return {
    policy: { startUrl: start.href, navHosts, subresourceHosts, ...(frameHosts.length ? { frameHosts } : {}), login, allowedSubmits, ...(readPosts.length ? { readPosts } : {}) },
    secrets: { username, password, ...(totp ? { totpSecret: totp } : {}) },
  };
}

/** RPA Site Login credential (playwrightSiteLoginApi) → SiteLogin. policyFor adds writeMode and allowPrivateNetwork. */
export function siteLoginConfig(data: CredentialData): SiteLogin {
  return siteFromCredential(data, SITE_LOGIN_LABELS);
}

/** Upper bound for the RPA Browser credential's Slow Motion (ms). */
const MAX_SLOW_MO = 2000;

/** RPA Browser credential (playwrightBrowserApi) → endpoint. Empty fields fall back to the reference compose stack. */
export function browserConfig(data: CredentialData): BrowserEndpoint {
  const mode = text(data, 'mode') || 'playwright';
  // Slow Motion (ms): only a positive number counts, at most MAX_SLOW_MO.
  const slow = typeof data.slowMo === 'number' && Number.isFinite(data.slowMo) && data.slowMo >= 1 ? { slowMo: Math.min(MAX_SLOW_MO, Math.floor(data.slowMo)) } : {};
  if (mode === 'local') return { mode: 'local', headless: data.headless !== false, ...slow };
  if (mode !== 'playwright' && mode !== 'cdp') throw new ConfigError('Mode must be Browser Server, Chrome DevTools Protocol (CDP) or Local Browser');
  const wsUrl = text(data, 'wsUrl') || DEFAULT_ENDPOINT_URL;
  const token = typeof data.token === 'string' && data.token ? data.token : undefined;
  return { mode, wsUrl, ...(token ? { token } : {}), ...(data.privateNetwork === true ? { privateNetwork: true } : {}), ...slow };
}

export function signingKey(data: CredentialData): string {
  const key = typeof data.secretKey === 'string' ? data.secretKey : '';
  if (key.length < MIN_SIGNING_KEY_LENGTH) {
    throw new ConfigError(`The Step Signing key must be at least ${MIN_SIGNING_KEY_LENGTH} characters (generate one with: openssl rand -hex 32)`);
  }
  return key;
}

/** Which node operation a policy is for: it decides the sub-resource wildcard (never for Fill and Submit Form). */
export type PolicyOperation = 'quick' | 'fillForm' | 'runSteps' | 'signSteps';

/** A Site Login credential, read into the engine's policy and secrets. */
export interface SiteLogin {
  policy: PortalPolicy;
  secrets: PortalSecrets;
}

/** A URL the run may not open. The node reports it as policy_violation, never as a configuration error. */
export class UrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

export const ALLOWED_HOSTS_WITH_SITE_LOGIN = 'Also Allow These Sites must be empty when a Site Login is attached: the Site Login credential sets the allowed sites.';
export const START_URL_NOT_ON_SITE_LOGIN = (host: string) => `Start URL host ${host} is not one of the Site Login credential's Sites the Browser May Open.`;
export const SITE_LOGIN_ONLY_RUN_OR_SIGN = 'A Site Login can be attached only to Run Steps and Sign Steps';
export const ALLOWED_HOST_NOT_HTTP = (entry: string) => `Also Allow These Sites entry ${entry} must be an http:// or https:// site, or just the host`;
export const RUN_STEPS_NEEDS_START = 'Run Steps needs a Start URL or a Site Login';
export const URL_REQUIRED = 'URL is required';
export const URL_NOT_VALID = 'URL must be a full address such as https://example.com/page';
export const URL_NEEDS_HOST = 'URL must name a site after http:// or https://, such as https://example.com/page';
export const URL_HAS_USERINFO = 'URL must not contain a username or password';
/**
 * The engine's golden `notHttp` (messages.ts), repeated here because this module must not load the engine at module
 * load (the node is CommonJS and imports the engine lazily). policy-for.test.ts pins both to the same text.
 */
const notHttp = (protocol: string) => `URL must start with http:// or https:// (got "${protocol}").`;

/** An operation URL, Start URL or steps start URL: http(s) only, with a host, without userinfo. */
export function checkUrl(raw: string): URL {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const u = parseUrl(value);
  if (!u) throw new UrlPolicyError(URL_NOT_VALID);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlPolicyError(notHttp(u.protocol));
  // The URL parser repairs "https:///path" and "http:/x.com" into a host; the text itself must name one after "//".
  if (!/^https?:\/\/[^/?#\\]/i.test(value) || !u.hostname || u.hostname.endsWith('.')) throw new UrlPolicyError(URL_NEEDS_HOST);
  if (u.username || u.password) throw new UrlPolicyError(URL_HAS_USERINFO);
  return u;
}

const hostOfUrl = (u: URL): string => normalizeHost(`${u.protocol}//${u.host}`);

/** An Also Allow These Sites entry: a bare host or an http(s) site; ws://, wss://, ftp:// and the rest are refused. */
function allowedHost(entry: string): string {
  const scheme = SCHEME.exec(entry.trim());
  if (scheme && !/^https?:\/\/$/i.test(scheme[0])) throw new ConfigError(ALLOWED_HOST_NOT_HTTP(shown(entry.trim())));
  return normalizeHost(entry);
}

/**
 * The policy a run uses. With a Site Login every security setting comes from the credential:
 * Start URL may only move the start page within its navigation hosts, Allowed Hosts must be empty, writes are fatal.
 * Without one, the URL's host plus Allowed Hosts are the only sites, writes are blocked and logged, and "any host" for
 * GET sub-resources is used only when Allowed Hosts is empty, the operation is not Fill and Submit Form and Allow
 * Private Network is off. Allow Private Network is copied from the (literal) node parameter in every branch.
 */
export function policyFor(input: {
  siteLogin?: SiteLogin; url?: string; allowedHosts: string[]; allowPrivateNetwork: boolean; operation: PolicyOperation;
}): PortalPolicy {
  const { siteLogin, allowedHosts, allowPrivateNetwork, operation } = input;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;
  if (siteLogin) {
    // Quick operations and Fill and Submit Form take no Site Login.
    if (operation !== 'runSteps' && operation !== 'signSteps') throw new ConfigError(SITE_LOGIN_ONLY_RUN_OR_SIGN);
    if (allowedHosts.length) throw new ConfigError(ALLOWED_HOSTS_WITH_SITE_LOGIN);
    let startUrl = siteLogin.policy.startUrl;
    if (url) {
      const u = checkUrl(url);
      const host = hostOfUrl(u);
      if (!siteLogin.policy.navHosts.includes(host)) throw new ConfigError(START_URL_NOT_ON_SITE_LOGIN(host));
      startUrl = u.href;
    }
    return { ...siteLogin.policy, startUrl, writeMode: 'fatal', allowPrivateNetwork };
  }
  if (!url) throw new ConfigError(operation === 'runSteps' ? RUN_STEPS_NEEDS_START : URL_REQUIRED);
  const u = checkUrl(url);
  const extra = allowedHosts.map(allowedHost);
  return {
    startUrl: u.href,
    navHosts: [...new Set([hostOfUrl(u), ...extra])],
    // The wildcard never comes with Allow Private Network: the opt-in widens only the navigation hosts.
    subresourceHosts: extra.length || operation === 'fillForm' || allowPrivateNetwork ? [] : '*',
    login: [],
    allowedSubmits: [],
    writeMode: 'block',
    allowPrivateNetwork,
    // Run Steps without a Site Login: declared submits on a navigation host are the allowed writes.
    submitsFromSteps: operation === 'runSteps',
  };
}
