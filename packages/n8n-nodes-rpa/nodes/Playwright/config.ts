import type { BrowserEndpoint, PortalPolicy, PortalSecrets, SecretTargets } from 'n8n-rpa-engine';

export const CREDENTIALS = {
  browser: 'playwrightBrowserApi',
  siteLogin: 'playwrightSiteLoginApi',
  signing: 'playwrightScriptSigningApi',
  redis: 'playwrightRedisApi',
  desktopRunner: 'rpaDesktopRunnerApi',
  secretVariables: 'rpaSecretVariablesApi',
} as const;

/**
 * The node's versions. A stored node keeps its version; a new node gets the last. Version 2 shows less: Runs On starts
 * at A browser, RPA Redis shows only with Share Login Breaker Across Workers on, and Signature and Approved By are on the
 * node's Settings tab. Every parameter and credential keeps its name.
 */
export const NODE_VERSIONS = [1, 2];
/** The version the import's workflow file and the templates give an RPA node. */
export const NODE_VERSION = 2;

/**
 * Runs On (Run Steps and Import Steps): which credential slots the node shows. It never decides where steps run: the
 * steps' own surface does. In version 1 the default shows every slot, so a node saved without it keeps every credential
 * it holds (n8n drops a credential whose slot is hidden). In version 2 the default is A browser.
 */
export type RunsOn = 'browserAndDesktop' | 'browser' | 'desktop';
/** Runs On's default in version 1. */
export const RUNS_ON_DEFAULT: RunsOn = 'browserAndDesktop';
/** Runs On's default in version 2. */
export const RUNS_ON_DEFAULT_V2: RunsOn = 'browser';
/** Runs On's default for a node of this version (a node without a version is version 1). */
export const runsOnDefault = (typeVersion: number | undefined): RunsOn => ((typeVersion ?? 1) >= 2 ? RUNS_ON_DEFAULT_V2 : RUNS_ON_DEFAULT);
/**
 * Version 2's switch for RPA Redis (Run Steps and Import Steps): off, its slot is hidden and the node runs as a version 1
 * node without the credential. Version 1 has no switch and always shows the slot.
 */
export const SHARE_ACROSS_WORKERS = 'shareAcrossWorkers';
export const RUNS_ON_NAMES: Record<RunsOn, string> = { browserAndDesktop: 'Browser and desktop apps', browser: 'A browser', desktop: 'A Windows desktop app' };
/** The operations that show Runs On. */
export const RUNS_ON_OPERATIONS: readonly string[] = ['runSteps', 'importSteps'];
/** The credential types each narrower choice hides. The credentials' displayOptions in Playwright.node.ts say the same (test/runs-on.test.ts). */
export const HIDDEN_BY_RUNS_ON: Record<Exclude<RunsOn, 'browserAndDesktop'>, readonly string[]> = {
  browser: [CREDENTIALS.desktopRunner],
  desktop: [CREDENTIALS.browser, CREDENTIALS.siteLogin, CREDENTIALS.redis],
};

/** The most Max Seconds may be, in seconds. A test pins it to the engine's MAX_BUDGET_MS; the node must not import the engine at load time. */
export const MAX_SECONDS = 600;

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
const shown = (entry: string): string => (entry.split(/\s+/).some(hasUserinfo) ? 'an entry with credentials' : `"${entry.replace(/[?#]\S*/g, '')}"`);
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

/** Field labels the Site Login's error messages use. */
const SITE_LOGIN_LABELS = {
  start: 'Login Page URL', nav: 'Sites the Browser May Open', sub: 'Sites It May Load Files From', login: 'Password page', submit: 'Form', read: 'Read-only request',
} as const;

/**
 * RPA Site Login credential (playwrightSiteLoginApi) → the engine's policy and secrets (SiteLogin). Security settings only
 * ever come from the credential; policyFor adds writeMode and allowPrivateNetwork.
 * `loginOptional`: an empty Username or Password is no error (Sign Steps, which never signs in: a Site Login whose
 * username and password are expressions on the account items is empty on an approval item).
 */
export function siteLoginConfig(data: CredentialData, opts: { loginOptional?: boolean } = {}): SiteLogin {
  const l = SITE_LOGIN_LABELS;
  const start = parseUrl(text(data, 'loginUrl'));
  if (!start) throw new ConfigError(`${l.start} must be a full URL such as https://example.com/login`);
  if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new ConfigError(`${l.start} must use http or https`);
  if (start.username || start.password) throw new ConfigError(`${l.start} must not contain a username or password: use the Username and Password fields`);
  if (start.hostname.endsWith('.')) throw new ConfigError(`${l.start} host must not end with a dot`);
  const startHost = normalizeHost(`${start.protocol}//${start.host}`);
  const username = text(data, 'username');
  const password = typeof data.password === 'string' ? data.password : '';
  if ((!username || !password) && !opts.loginOptional) throw new ConfigError('Username and Password are required');
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

/** Upper bound for the RPA Browser credential's Slow Motion (ms). */
const MAX_SLOW_MO = 2000;

/**
 * The Certificate Fingerprint field as text, '' for no fingerprint. Only a missing value or a blank string means no
 * fingerprint; a pasted value is trimmed. A value that is not text (it can only come from an expression or the API) is
 * never read as no fingerprint: it is passed on as text, and the engine checks that text like a typed value.
 */
function fingerprintText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  // An empty array's text is empty, which would read as no fingerprint: its type name is passed instead.
  return String(value).trim() || `(${typeof value})`;
}

/**
 * The two kinds of Connection Line the Windows installer prints: the scheme, the path after the port, the path of the
 * wss:// URL it stands for (as the installer's URL line prints it: the browser's without a trailing slash, which the engine
 * reads as the same address), the credential.
 */
const LINE_KINDS = {
  runner: { scheme: 'rpa-runner', path: '/rpa/v1', urlPath: '/rpa/v1', credential: 'RPA Desktop Runner', what: "desktop runner's" },
  browser: { scheme: 'rpa-browser', path: '/', urlPath: '', credential: 'RPA Browser', what: "browser's" },
} as const;
type LineKind = keyof typeof LINE_KINDS;
const FINGERPRINT_HEX = /^(?:[0-9A-Fa-f]{64}|(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/;

/**
 * A Connection Line (`rpa-runner://<address>:<port>/rpa/v1#token=<token>&fingerprint=<64 hex>`, or `rpa-browser://…/#…`)
 * → the wss:// address, the token and the fingerprint. The line holds the token: no message repeats any part of it, each
 * says only what is wrong. The fingerprint is passed on as written; the engine checks it as it checks the separate field.
 */
export function parseConnectionLine(kind: LineKind, line: string): { url: string; token: string; fingerprint: string } {
  const k = LINE_KINDS[kind];
  const other = LINE_KINDS[kind === 'runner' ? 'browser' : 'runner'];
  const inLine = `The Connection Line in the ${k.credential} credential`;
  const ofLine = (part: string) => `The ${part} in the Connection Line of the ${k.credential} credential`;
  const m = /^(rpa-runner|rpa-browser):\/\/([^/?#]*)([^#]*)(?:#(.*))?$/is.exec(line);
  if (!m) throw new ConfigError(`${inLine} must be the whole line that starts with ${k.scheme}://, as the installer prints it.`);
  if (m[1].toLowerCase() !== k.scheme) {
    throw new ConfigError(`${inLine} is the ${other.what} line (${other.scheme}://). Paste it into an ${other.credential} credential, and here the line that starts with ${k.scheme}://.`);
  }
  const hostPort = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_.-]+):(\d+)$/.exec(m[2]);
  const noAddress = `${inLine} has no address and port: it starts ${k.scheme}:// followed by the address, a colon and the port, then ${k.path}.`;
  if (!hostPort) throw new ConfigError(noAddress);
  const port = Number(hostPort[2]);
  if (port < 1 || port > 65535) throw new ConfigError(`${ofLine('port')} must be a number from 1 to 65535.`);
  const url = `wss://${hostPort[1]}:${hostPort[2]}${k.urlPath}`;
  if (!parseUrl(url)?.hostname) throw new ConfigError(noAddress);
  if (m[3] !== k.path) throw new ConfigError(`${inLine} must continue with ${k.path} after the port.`);
  const parts = new Map<string, string>();
  for (const part of m[4] ? m[4].split('&') : []) {
    const eq = part.indexOf('=');
    const key = eq > 0 ? part.slice(0, eq) : '';
    if ((key !== 'token' && key !== 'fingerprint') || parts.has(key)) throw new ConfigError(`${inLine} may hold only token= and fingerprint=, once each, after the #.`);
    parts.set(key, part.slice(eq + 1));
  }
  const token = parts.get('token') ?? '';
  // Without -ShowTokens the installer prints token=<hidden: run with -ShowTokens>.
  if (token.startsWith('<')) throw new ConfigError(`${inLine} has no token: the installer hides it. On that machine, in an administrator PowerShell, run & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens and paste the line it prints.`);
  if (!token) throw new ConfigError(`${inLine} has no token (token=…).`);
  const fingerprint = parts.get('fingerprint') ?? '';
  if (!fingerprint) throw new ConfigError(`${inLine} has no fingerprint (fingerprint=…).`);
  if (!FINGERPRINT_HEX.test(fingerprint)) throw new ConfigError(`${ofLine('fingerprint')} is not 64 hex digits.`);
  return { url, token, fingerprint };
}

/** RPA Browser credential (playwrightBrowserApi) → endpoint. Empty fields fall back to the reference compose stack. */
export function browserConfig(data: CredentialData): BrowserEndpoint {
  const mode = text(data, 'mode') || 'playwright';
  // Slow Motion (ms): only a positive number counts, at most MAX_SLOW_MO.
  const slow = typeof data.slowMo === 'number' && Number.isFinite(data.slowMo) && data.slowMo >= 1 ? { slowMo: Math.min(MAX_SLOW_MO, Math.floor(data.slowMo)) } : {};
  if (mode === 'local') return { mode: 'local', headless: data.headless !== false, ...slow };
  if (mode !== 'playwright' && mode !== 'cdp') throw new ConfigError('Mode must be Browser Server, Chrome DevTools Protocol (CDP) or Local Browser');
  const privateNetwork = data.privateNetwork === true ? { privateNetwork: true } : {};
  // Connection Line: Browser Server mode only, where the field shows. Filled, it replaces Endpoint URL, Token and
  // Certificate Fingerprint.
  const line = mode === 'playwright' ? text(data, 'connectionLine') : '';
  if (line) {
    const { url, token, fingerprint } = parseConnectionLine('browser', line);
    return { mode, wsUrl: url, token, fingerprint, ...privateNetwork, ...slow };
  }
  const wsUrl = text(data, 'wsUrl') || DEFAULT_ENDPOINT_URL;
  const token = typeof data.token === 'string' && data.token ? data.token : undefined;
  // Certificate Fingerprint (SHA-256): Browser Server mode only, where the field shows. The engine checks its format and
  // that the Endpoint URL is wss://.
  const fingerprint = mode === 'playwright' ? fingerprintText(data.fingerprint) : '';
  return { mode, wsUrl, ...(token ? { token } : {}), ...(fingerprint ? { fingerprint } : {}), ...privateNetwork, ...slow };
}

/**
 * The RPA Desktop Runner credential as the engine's RunnerEndpoint: from the Connection Line when it is filled, else from
 * the three fields. The engine checks the URL and fingerprint formats.
 */
export function desktopRunnerConfig(data: CredentialData): { url: string; token: string; fingerprint: string } {
  const line = text(data, 'connectionLine');
  if (line) return parseConnectionLine('runner', line);
  const url = text(data, 'url');
  const fingerprint = text(data, 'fingerprint');
  const token = typeof data.token === 'string' ? data.token : '';
  if (!url) throw new ConfigError('The RPA Desktop Runner credential needs the Runner URL (wss://host:8765).');
  if (!token) throw new ConfigError('The RPA Desktop Runner credential needs the Token.');
  if (!fingerprint) throw new ConfigError('The RPA Desktop Runner credential needs the Certificate Fingerprint the runner prints at start.');
  return { url, token, fingerprint };
}

/** A run variable's name, in Options → Variables and in the RPA Secret Variables credential. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The shortest value the RPA Secret Variables credential takes: the length from which the desktop lane masks a typed value
 * (the engine's MIN_MASKED_TYPED; a test pins the two). A shorter value masked everywhere would also hide ordinary text.
 */
export const MIN_SECRET_VARIABLE_LENGTH = 4;

/**
 * The RPA Secret Variables credential (rpaSecretVariablesApi) → name → value. Its messages name a variable by its name only
 * once the name is a valid one (a value typed into the name box is never shown), and never show a value. A row with neither
 * name nor value is skipped.
 */
export function secretVariablesConfig(data: CredentialData): Record<string, string> {
  const vars: Record<string, string> = {};
  const values = (data.variables as { values?: unknown } | undefined)?.values;
  (Array.isArray(values) ? values : []).forEach((entry: unknown, i) => {
    const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const value = typeof row.value === 'string' ? row.value : '';
    if (!name && !value) return;
    if (!name) throw new ConfigError(`Secret variable ${i + 1} in the RPA Secret Variables credential has a value but no name.`);
    if (!VARIABLE_NAME.test(name)) {
      throw new ConfigError(`The name of secret variable ${i + 1} in the RPA Secret Variables credential may only use letters, digits and _, and may not start with a digit.`);
    }
    if (Object.hasOwn(vars, name)) throw new ConfigError(`The secret variable "${name}" is listed twice in the RPA Secret Variables credential.`);
    if (value.length < MIN_SECRET_VARIABLE_LENGTH) {
      throw new ConfigError(
        `The secret variable "${name}" in the RPA Secret Variables credential is shorter than ${MIN_SECRET_VARIABLE_LENGTH} characters: a value that short cannot be masked without also hiding ordinary text. Put a value that is not secret in Options → Variables.`,
      );
    }
    vars[name] = value;
  });
  return vars;
}

/** The RPA Secret Variables credential's field that limits where its values may be typed. */
export const MAY_BE_TYPED_INTO = 'May Be Typed Into';
const IN_SECRET_VARIABLES = 'in the RPA Secret Variables credential';
/** A program file name as the desktop runner's allowedApps names one: no folder, no drive, ends in .exe. */
const APP_FILE_NAME = /^[^\\/:*?"<>|\u0000-\u001f]+\.exe$/i;
export const MAY_BE_TYPED_INTO_EXPRESSION = `${MAY_BE_TYPED_INTO} ${IN_SECRET_VARIABLES} must be typed in, not set with an expression.`;
/**
 * A May Be Typed Into line that is refused. It names the line's number and at most its first 40 characters (without a
 * query or fragment), and nothing of a line that holds one of the credential's values or a user:password@ part.
 */
export const mayBeTypedIntoLineRefused = (n: number, line: string, hidden: 'value' | 'userinfo' | false): string => {
  // A query or fragment (which can carry a token) is cut first, as in every other entry a message shows.
  const cut = line.replace(/[?#]\S*/g, '');
  const shownLine = hidden ? '' : ` ("${cut.length > 40 ? `${cut.slice(0, 40)}…` : cut}")`;
  const why = hidden === 'value'
    ? "it holds one of this credential's values: list where they may be typed, not the values"
    : line.includes('*') ? 'wildcards are not allowed, list each exact host' : 'it is neither a program file name such as ErpDemo.exe nor a site host such as erp.example.com';
  return `Line ${n} of ${MAY_BE_TYPED_INTO} ${IN_SECRET_VARIABLES}${shownLine}: ${why}.`;
};

/** The host of an Also Allow These Sites entry (allowedHost), or undefined: kept out of a catch block, the caller throws. */
function hostEntry(entry: string): string | undefined {
  try {
    return allowedHost(entry);
  } catch {
    return undefined;
  }
}

/**
 * The RPA Secret Variables credential's May Be Typed Into → the engine's SecretTargets; undefined when it is empty, which
 * means no limit. One entry per line: a program file name (ErpDemo.exe, compared without case by the engine) or a site
 * host, read by the same function as Also Allow These Sites (allowedHost: an exact host, or an http(s) site, no
 * wildcard, no path). The field takes no expression: a value that is not text, starts with "=" or holds "{{" is refused,
 * as the node refuses an expression in its literal-only settings. `values` are the credential's secret values, never shown.
 */
export function secretTargetsConfig(data: CredentialData, values: readonly string[] = []): SecretTargets | undefined {
  const raw = data.mayBeTypedInto;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trimStart().startsWith('=') || raw.includes('{{')) throw new ConfigError(MAY_BE_TYPED_INTO_EXPRESSION);
  const apps: string[] = [];
  const hosts: string[] = [];
  raw.split(/\r?\n/).forEach((text, i) => {
    const line = text.trim();
    if (!line) return;
    if (values.some((v) => v !== '' && line.includes(v))) throw new ConfigError(mayBeTypedIntoLineRefused(i + 1, line, 'value'));
    if (line.length <= 260 && APP_FILE_NAME.test(line)) {
      if (!apps.some((a) => a.toLowerCase() === line.toLowerCase())) apps.push(line);
      return;
    }
    const host = line.includes('*') ? undefined : hostEntry(line);
    if (host === undefined) throw new ConfigError(mayBeTypedIntoLineRefused(i + 1, line, line.split(/\s+/).some(hasUserinfo) ? 'userinfo' : false));
    if (!hosts.includes(host)) hosts.push(host);
  });
  return apps.length || hosts.length ? { apps, hosts } : undefined;
}

export function signingKey(data: CredentialData): string {
  const key = typeof data.secretKey === 'string' ? data.secretKey : '';
  if (key.length < MIN_SIGNING_KEY_LENGTH) {
    throw new ConfigError(`The Step Signing key must be at least ${MIN_SIGNING_KEY_LENGTH} characters (let your password manager generate a password of 32 or more characters)`);
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
export const SITE_LOGIN_ONLY_RUN_OR_SIGN = 'A Site Login can be attached only to Run Steps, Sign Steps and Import Steps';
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
