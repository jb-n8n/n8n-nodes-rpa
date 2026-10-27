import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium, type Browser, type BrowserContext, type BrowserContextOptions, type CDPSession, type Page, type Request, type Response as PwResponse,
} from 'playwright-core';
import {
  BLOCKED_REQUEST, browserUnreachable, browserVersionMismatch, CHROMIUM_MISSING, ENDPOINT_NOT_SECURE, noFreeBrowserSession, notHttp, offListSite,
  privateAddress, tokenRefused,
} from '../messages.js';
import { destructiveNavigation } from '../policy/destructive.js';
import type { Masker } from '../secrets/mask.js';
import { PolicyError } from '../steps/errors.js';
import type { StepHooks } from '../steps/run.js';
import { isLoginPage, maskSessionSegments, shownUrl } from '../steps/urls.js';
import { matchingReadPost, readPostLabel, readPostsProblem } from '../policy/read-posts.js';
import type { BrowserEndpoint, PortalPolicy, RequestRecord, Violation } from '../types.js';
import { createAddressGuard, defaultResolveHost, hostnameOf, isPrivateAddress, type AddressGuard, type ResolveHost } from './address.js';
import { HARDEN_SCRIPT } from './harden.js';
import { startRedirectGuard, type HopVerdict, type RedirectGuard } from './redirects.js';
import { createWindow, FILL_AND_SUBMIT, submitTargetRule, type RequestFrame, type WriteWindow } from './window.js';
import type { AllowedSubmit } from '../policy/submits.js';

export type { RequestFrame, WriteWindow } from './window.js';
export type { AllowedSubmit } from '../policy/submits.js';

/** The playwright-core version this engine is pinned to; a remote Playwright server must run the same version. */
export const PLAYWRIGHT_VERSION = '1.63.0';
/** How long connecting to a remote browser may take. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How long a Browser Server connection waits for a free session by default (BrowserEndpoint.sessionWaitMs). */
export const SESSION_WAIT_MS = 60_000;
/** The longest Session.idle() waits for pending address checks. */
const IDLE_MAX_MS = 2_000;
/** The longest the redirect watchdog waits for the redirect guard's word on a hop that writes. */
const WATCHDOG_WAIT_MS = 5_000;

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

/**
 * The browser service's gate had no free session for the whole session wait, or the run was cancelled or
 * ran out of time while waiting. The gate checks the token before capacity, so the token was accepted.
 */
export class NoFreeSessionError extends BrowserUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'NoFreeSessionError';
  }
}

/** A host on the policy resolves to a private address the policy does not admit. The lane reports policy_violation. */
export class PrivateNetworkError extends PolicyError {
  constructor(readonly host: string) {
    super(privateAddress(host));
    this.name = 'PrivateNetworkError';
  }
}

/** The policy itself cannot be used (a malformed or too-broad read-only list). The lane reports policy_violation. */
export class InvalidPolicyError extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPolicyError';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** At most this many distinct blocked requests, and this many distinct non-fatal violations, are kept per session. */
const MAX_LOGGED = 100;
/** Request methods come from page script: shown at most this long. */
const MAX_METHOD = 16;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Distinct navigations a session records (Session.navigations). */
const MAX_NAVIGATIONS = 500;

const cap = (x: string) => x.slice(0, 300);
const bare = (x: string) => cap(x.split(/[?#]/)[0] ?? '');

export function requestFrame(r: Request): RequestFrame | undefined {
  try {
    const f = r.frame();
    if (f.isDetached()) return undefined;
    return { isMain: f.parentFrame() === null, url: f.url() };
  } catch {
    // Service-worker requests and navigations issued before their frame exists have no frame.
    return undefined;
  }
}

/**
 * Checks one request against the credential's allowlists.
 * Main frame: navigations only to navHosts; other requests to navHosts ∪ subresourceHosts; writes only as a POST to a
 * declared login page. Sub-frames: any request to navHosts ∪ subresourceHosts ∪ frameHosts; writes only when the frame
 * is on a nav host and the write passes the normal rules, or when both the frame's own host and the target host are
 * frame hosts (unless frameHostWrites is false, which leaves only declared login POSTs). Addresses are checked
 * afterwards, by the session.
 * With subresourceHosts '*', non-navigation GET/HEAD/OPTIONS requests may go to any http(s) host; any other method to an
 * unlisted host is an off-list ('host') request.
 * Any other write is refused here; the session lets it through only while an open write window admits it
 * (browser/window.ts): an allowed submission while its own submit or download step runs (Session.armSubmit), and up
 * to 3 Fill and Submit POSTs.
 */
export function checkRequest(
  policy: PortalPolicy,
  req: { url: string; method: string; isNavigation: boolean; frame?: RequestFrame },
): Omit<Violation, 'fatal'> | null {
  let u: URL;
  try { u = new URL(req.url); } catch { return { kind: 'host', url: bare(req.url) }; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'host', url: bare(req.url) };
  const frameHosts = policy.frameHosts ?? [];
  const subFrame = req.frame !== undefined && !req.frame.isMain;
  const allowedHosts = subFrame
    ? [...policy.navHosts, ...listedSubresources(policy), ...frameHosts]
    : req.isNavigation ? policy.navHosts : [...policy.navHosts, ...listedSubresources(policy)];
  // '*' admits any http(s) host only for safe-method requests that are not navigations ("any host for
  // GET sub-resources"). A non-GET to an unlisted host is an off-list request: blocked and logged, never a write, so a
  // third-party analytics beacon does not end a run. A write to a listed host still meets the write rules (item 6).
  const wildcard = policy.subresourceHosts === '*' && !req.isNavigation && SAFE_METHODS.has(req.method.toUpperCase());
  if (!wildcard && !allowedHosts.includes(u.host)) return { kind: 'host', url: cap(`${u.origin}${u.pathname}`), method: req.method };
  const method = req.method.toUpperCase();
  const where = cap(`${u.origin}${u.pathname}`);
  const loginPage = policy.login.some((l) => l.host === u.host && l.path === u.pathname);
  if (policy.refuseDestructiveNavigation && req.isNavigation && !subFrame && destructiveNavigation(policy, u, loginPage)) {
    return { kind: 'write', url: where, method };
  }
  if (SAFE_METHODS.has(method)) return null;
  const isLogin = method === 'POST' && loginPage;
  const isRead = matchingReadPost(policy, req.url, method) !== undefined;
  if (subFrame) {
    let frameHost = '';
    try { frameHost = new URL(req.frame?.url ?? '').host; } catch { /* unknown frame origin: neither frame rule below can match */ }
    // Frame-host to frame-host writes pass unless the policy forbids them (noWritePolicy); declared login POSTs always do.
    if (frameHosts.includes(frameHost) && frameHosts.includes(u.host) && (policy.frameHostWrites !== false || isLogin)) return null;
    if (policy.navHosts.includes(frameHost) && (isLogin || isRead)) return null;
    return { kind: 'write', url: where, method };
  }
  return isLogin || isRead ? null : { kind: 'write', url: where, method };
}

/**
 * Whether a request from this frame may be filed as a read-only POST: the main frame, no frame, or a sub-frame on a
 * nav host that checkRequest's frame-host rule did not admit (a frame-host to frame-host POST is a counted write).
 */
function readFromFrame(policy: PortalPolicy, url: string, frame: RequestFrame | undefined): boolean {
  if (frame === undefined || frame.isMain) return true;
  let frameHost = '';
  let target = '';
  try { frameHost = new URL(frame.url).host; } catch { return false; }
  try { target = new URL(url).host; } catch { return false; }
  const frameHosts = policy.frameHosts ?? [];
  if (frameHosts.includes(frameHost) && frameHosts.includes(target)) return false;
  return policy.navHosts.includes(frameHost);
}

/** Sub-resource hosts listed by name; the '*' wildcard lists none (and is never applied in Local Browser mode). */
function listedSubresources(p: PortalPolicy): string[] {
  return Array.isArray(p.subresourceHosts) ? p.subresourceHosts : [];
}

/** The user-facing message for a fatal violation. URLs in violations never carry a query string. */
export function violationMessage(v: Violation, policy: PortalPolicy): string {
  let u: URL | undefined;
  try { u = new URL(v.url); } catch { u = undefined; }
  if (v.kind === 'private') return privateAddress(v.host ?? u?.host ?? '');
  if (v.kind === 'host') {
    if (u && u.protocol !== 'http:' && u.protocol !== 'https:') return notHttp(u.protocol);
    const host = v.host ?? u?.host;
    if (host) return offListSite(host, policy.navHosts);
  }
  return BLOCKED_REQUEST;
}

/** Why a session was closed. Only the first reason is kept. */
export type CloseReason = 'budget' | 'violation' | 'disconnected' | 'caller';
/** Cookies and local storage of a context, as returned by `context.storageState()`. */
export type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  violations: Violation[];
  /**
   * Origin + pathname of every main-frame navigation of every page in this context (popups included), deduped, in order;
   * the first 500 only (page script can navigate without limit).
   */
  readonly navigations: ReadonlySet<string>;
  /** The last main-frame document response that was not a redirect (any page of this context), or null. */
  readonly lastDocument: { url: string; status: number } | null;
  /** Writes that were aborted and logged without ending the run (method, masked host and path). */
  blockedRequests: RequestRecord[];
  /**
   * How many requests this session let through that were not GET/HEAD/OPTIONS and not a declared login POST: window
   * POSTs, a step's own submissions, frame-host writes, 307/308 re-posts.
   * Greater than 0 means a write left the browser.
   */
  readonly writesSent: number;
  /** Labels (`POST host/path*`, never the concrete URL) of the read-only POST entries that admitted a request, in first-use order. */
  readonly readPostsUsed: ReadonlySet<string>;
  /** Swaps the policy the route handler, redirect guard and watchdog, and address checks use for every later request; closes the windows. */
  restrict(policy: PortalPolicy): void;
  /**
   * Opens a write window for the declared target of the submit or download step now running, closing the previous one;
   * null closes it when the step ends. It admits at most 3 writes of exactly that target, and only while the policy lists
   * it as an allowed submission: it never adds one.
   */
  armSubmit(target: AllowedSubmit | null): void;
  /** The Fill and Submit window; non-null exactly when the session's policy had a writeWindow when it opened. */
  writeWindow: WriteWindow | null;
  readonly closed: boolean;
  /** The first reason the session was closed, or null while it is open. */
  readonly closeReason: CloseReason | null;
  /** Closes the context and browser. The reason defaults to 'caller'; a later call never overwrites the first reason. */
  close(reason?: CloseReason): Promise<void>;
  /** The raw Playwright trace zip when tracing was on: stops tracing if the session is open, else returns what close() saved. */
  takeTrace(): Promise<Buffer | undefined>;
  /** Resolves when the pending checks (redirect hops, server addresses) are done, or after 2 s. */
  idle(): Promise<void>;
  /**
   * StepContext.stepHooks for this session: each step becomes a named group in the trace (when tracing is on), and over
   * CDP a marker another DevTools client (a live view) can read. Never throws.
   */
  stepHooks: StepHooks;
}

/** Lookup failures that mean the name has no record (or none right now): a stopped container. */
const UNRESOLVED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA']);

type Seams = { resolveHost: ResolveHost; isPrivate: (ip: string) => boolean };

async function assertEndpoint(e: BrowserEndpoint, seams: Seams): Promise<void> {
  if (e.mode === 'local') return;
  if (!e.wsUrl) throw new BrowserUnavailableError(`a ${e.mode} endpoint needs a URL`);
  let u: URL;
  try { u = new URL(e.wsUrl); } catch { throw new BrowserUnavailableError('browser endpoint URL is not valid'); }
  if (u.protocol === 'wss:' || u.protocol === 'https:') return;
  const plain = u.protocol === 'ws:' || u.protocol === 'http:';
  if (plain && LOCAL_HOSTS.has(u.hostname)) return;
  // Plain ws:// to another host only on a private network (for example a docker network), opted in, with a token.
  if (plain && e.privateNetwork === true && !!e.token) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    let unresolved = false;
    if (isIPv4(host) || isIPv6(host)) addresses = [host];
    else {
      try {
        addresses = await seams.resolveHost(host);
        unresolved = addresses.length === 0;
      } catch (err) {
        addresses = [];
        unresolved = UNRESOLVED_CODES.has(String((err as { code?: unknown } | null)?.code));
      }
    }
    // A stopped compose container has no DNS record. Nothing is connected to, so this weakens nothing: the user is told
    // the server is not reachable instead of being told to switch to wss://.
    if (unresolved) throw new BrowserUnavailableError(browserUnreachable(shownEndpoint(e.wsUrl)));
    if (addresses.length > 0 && addresses.every((a) => seams.isPrivate(a))) return;
  }
  throw new BrowserUnavailableError(ENDPOINT_NOT_SECURE);
}

/**
 * Local Browser hardening. Every allowed hostname is mapped to its pre-resolved, checked address; every other name
 * fails to resolve. Chromium applies the first matching rule, so the catch-all comes last.
 */
export function localLaunchArgs(policy: PortalPolicy, pins: Map<string, string>): string[] {
  const allowed = new Set(
    [...policy.navHosts, ...listedSubresources(policy), ...(policy.frameHosts ?? [])].map(hostnameOf).filter((h) => h !== ''),
  );
  const maps = [...pins].filter(([name]) => allowed.has(name)).map(([name, ip]) => `MAP ${name} ${isIPv6(ip) ? `[${ip}]` : ip}`);
  return [
    `--host-resolver-rules=${[...maps, 'MAP * ~NOTFOUND'].join(', ')}`,
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--dns-prefetch-disable',
  ];
}

/**
 * Resolves and checks every listed host for Local Browser mode. A private name the policy does not admit refuses the
 * session. The lookups run in parallel through the session guard's limiter (2 at a time, 4 s each, 64 names at most).
 */
async function pinHosts(policy: PortalPolicy, guard: AddressGuard): Promise<Map<string, string>> {
  const pins = new Map<string, string>();
  const hosts = [...new Set([...policy.navHosts, ...listedSubresources(policy), ...(policy.frameHosts ?? [])])];
  const results = await Promise.all(hosts.map((host) => guard.check(host)));
  for (const [i, host] of hosts.entries()) {
    const res = results[i];
    if (!res.ok) {
      if (res.reason === 'private') throw new PrivateNetworkError(host);
      continue; // an unresolvable name stays unresolvable in the browser (MAP * ~NOTFOUND)
    }
    const name = hostnameOf(host);
    if (!pins.has(name)) pins.set(name, res.addresses.find((a) => isIPv4(a)) ?? res.addresses[0]);
  }
  return pins;
}

/** origin + pathname of the endpoint URL: no query string, no userinfo. */
function shownEndpoint(wsUrl?: string): string {
  try {
    const u = new URL(wsUrl ?? '');
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'the configured URL';
  }
}

function connectError(err: unknown, e: BrowserEndpoint): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (e.mode === 'local') return raw.includes("Executable doesn't exist") ? CHROMIUM_MISSING : `could not connect to the browser: ${raw.split('\n')[0]}`;
  // playwright run-server answers a version mismatch with 428 and a box containing "server version: v1.62".
  const version = /server version: v?(\d+\.\d+(?:\.\d+)?)/i.exec(raw);
  if (version) return browserVersionMismatch(version[1], PLAYWRIGHT_VERSION);
  // The endpoint answered the upgrade (or CDP's /json/version) with 401/403, e.g. the token gate: a wrong token.
  if (/\s(401|403)\b/.test(raw)) return tokenRefused(shownEndpoint(e.wsUrl));
  return browserUnreachable(shownEndpoint(e.wsUrl));
}

/**
 * The browser service's gate refusing a session it cannot take now: 503 with the body `rpa-browser busy` (every session
 * of this replica is in use) or `rpa-browser draining` (the replica is shutting down). playwright-core 1.63 puts the
 * status line and the body in the connect error: `WebSocket error: ws://…/ 503 Service Unavailable\nrpa-browser busy`.
 * A 503 without the marker (another proxy, a load balancer with no targets) is not retried: nothing says a session will
 * free up, so it fails at once as before.
 */
const GATE_NO_SESSION = /\s503\b[^\n]*\n\s*rpa-browser (?:busy|draining)\b/;
const gateHasNoSession = (err: unknown) => GATE_NO_SESSION.test(err instanceof Error ? err.message : String(err));

/** The backoff before the next connect: 1 s, 2 s, 4 s, then 5 s each time, ±20 % jitter. `random` is in [0, 1]. */
const backoffMs = (attempt: number, random: number) => Math.round(([1000, 2000, 4000][attempt] ?? 5000) * (0.8 + 0.4 * random));

/** Resolves after `ms`, or as soon as the signal aborts. */
const sleepUnlessAborted = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/** Test seams for the session wait: the clock, the sleep and the jitter source. */
export interface SessionWaitSeams {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

/**
 * connect(), and for a Browser Server endpoint whose gate has no free session, connect again with backoff. The
 * sleeps never add up to more than the session wait, nor run past the run's deadline or its cancellation; then the
 * session wait fails with noFreeBrowserSession. Every other error is thrown at once, as before.
 */
async function connectWaiting(
  e: BrowserEndpoint, policy: PortalPolicy, pins: Map<string, string>,
  opts: { signal?: AbortSignal; deadlineMs?: number; seams?: SessionWaitSeams },
): Promise<Browser> {
  const now = opts.seams?.now ?? Date.now;
  const sleep = opts.seams?.sleep ?? sleepUnlessAborted;
  const random = opts.seams?.random ?? Math.random;
  const started = now();
  const wait = typeof e.sessionWaitMs === 'number' && Number.isFinite(e.sessionWaitMs) ? Math.max(0, e.sessionWaitMs) : SESSION_WAIT_MS;
  const end = Math.min(started + wait, opts.deadlineMs ?? Infinity);
  const noSession = () => new NoFreeSessionError(noFreeBrowserSession(shownEndpoint(e.wsUrl), Math.round((now() - started) / 1000)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect(e, policy, pins);
    } catch (err) {
      if (e.mode !== 'playwright' || !gateHasNoSession(err)) throw err;
      const left = end - now();
      if (left <= 0 || opts.signal?.aborted) throw noSession();
      await sleep(Math.min(backoffMs(attempt, Math.min(1, Math.max(0, random()))), left), opts.signal);
      // Cancelled during the sleep: no further connect (the lanes report the cancellation).
      if (opts.signal?.aborted) throw noSession();
    }
  }
}

async function connect(e: BrowserEndpoint, policy: PortalPolicy, pins: Map<string, string>): Promise<Browser> {
  const headers = e.token ? { Authorization: `Bearer ${e.token}` } : undefined;
  // Slow Motion is applied by this client (Playwright delays its own commands): no browser server option is involved.
  const slowMo = e.slowMo && e.slowMo > 0 ? { slowMo: e.slowMo } : {};
  if (e.mode === 'local') return chromium.launch({ headless: e.headless ?? true, args: localLaunchArgs(policy, pins), ...slowMo });
  if (e.mode === 'playwright') return chromium.connect(e.wsUrl as string, { headers, timeout: CONNECT_TIMEOUT_MS, ...slowMo });
  return chromium.connectOverCDP(e.wsUrl as string, { headers, timeout: CONNECT_TIMEOUT_MS, ...slowMo });
}

export async function openSession(opts: {
  endpoint: BrowserEndpoint; policy: PortalPolicy; masker: Masker; storageState?: StorageState; trace?: boolean;
  viewport?: { width: number; height: number };
  /** The run's cancellation and absolute deadline (Date.now() scale): waiting for a free browser session stops at either. */
  signal?: AbortSignal; deadlineMs?: number;
  /**
   * Test seams only: never reachable from TaskInput. `redirectGuard: false` leaves redirect hops to the watchdog alone,
   * to test that defence in depth.
   */
  resolveHost?: ResolveHost; isPrivate?: (ip: string) => boolean; sessionWait?: SessionWaitSeams; redirectGuard?: boolean;
}): Promise<Session> {
  const { endpoint, policy, masker } = opts;
  // Defence in depth: the node refuses these entries already; a policy built some other way must not widen the reads.
  const readProblem = readPostsProblem(policy.readPosts);
  if (readProblem) throw new InvalidPolicyError(masker.mask(readProblem));
  const seams: Seams = { resolveHost: opts.resolveHost ?? defaultResolveHost, isPrivate: opts.isPrivate ?? isPrivateAddress };
  // Messages show the endpoint as origin + path; the query string, userinfo and token are redacted wherever they appear.
  const scrub = (msg: string) => {
    const needles: string[] = [];
    if (endpoint.wsUrl) {
      try {
        const u = new URL(endpoint.wsUrl);
        needles.push(u.search, u.username, u.password);
      } catch { /* invalid URL is rejected by assertEndpoint */ }
    }
    if (endpoint.token) needles.push(endpoint.token, encodeURIComponent(endpoint.token));
    let out = msg;
    for (const n of needles.filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) out = out.split(n).join('[redacted]');
    return masker.mask(out);
  };
  await assertEndpoint(endpoint, seams);
  // Listed hosts use dns.lookup; names admitted only by the '*' wildcard use c-ares unless a test injected resolveHost
  // (browser/address.ts).
  const guard = createAddressGuard(policy, seams);
  const pins = endpoint.mode === 'local' ? await pinHosts(policy, guard) : new Map<string, string>();
  let browser: Browser;
  try {
    browser = await connectWaiting(endpoint, policy, pins, { signal: opts.signal, deadlineMs: opts.deadlineMs, seams: opts.sessionWait });
  } catch (err) {
    if (err instanceof NoFreeSessionError) throw new NoFreeSessionError(scrub(err.message));
    throw new BrowserUnavailableError(scrub(connectError(err, endpoint)));
  }
  try {
    return await setup(browser, policy, scrub, {
      storageState: opts.storageState, trace: opts.trace, viewport: opts.viewport, guard, seams,
      markers: endpoint.mode !== 'local' && (endpoint.slowMo ?? 0) > 0,
      // A remote browser may serve other clients (a CDP endpoint, a Playwright server that shares one browser); Local
      // Browser is launched for this session alone.
      redirectGuard: opts.redirectGuard === false ? 'off' : endpoint.mode === 'local' ? 'own' : 'shared',
    });
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw new BrowserUnavailableError(scrub(`could not start the browser session: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`));
  }
}

async function setup(
  browser: Browser, policy: PortalPolicy, scrub: (m: string) => string,
  options: {
    storageState?: StorageState; trace?: boolean; viewport?: { width: number; height: number }; guard: AddressGuard; seams: Seams; markers?: boolean;
    redirectGuard: 'own' | 'shared' | 'off';
  },
): Promise<Session> {
  const context = await browser.newContext({
    serviceWorkers: 'block', acceptDownloads: true,
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  const violations: Violation[] = [];
  const blockedRequests: RequestRecord[] = [];
  /** The Fill and Submit window, when the policy had one when the session opened. */
  const win = policy.writeWindow ? createWindow(FILL_AND_SUBMIT) : null;
  /** The running submit or download step's own window (armSubmit); restrict() closes it. */
  let stepWin: ReturnType<typeof createWindow> | null = null;
  /** Whether an open window lets this refused write through, taking one of its slots: the step's window first. */
  const admit = (used: PortalPolicy, url: string, method: string, frame: RequestFrame | undefined) =>
    (stepWin?.admit(used, url, method, frame) ?? false) || (win?.admit(used, url, method, frame) ?? false);
  const closeWindows = () => {
    win?.handle.close();
    stepWin?.handle.close();
    stepWin = null;
  };
  const navigations = new Set<string>();
  let writesSent = 0;
  const readPostsUsed = new Set<string>();
  /** Counts a request that is being let through when it is a write: not a safe method, not a declared login POST. */
  const countWrite = (policy: PortalPolicy, url: string, method: string, frame: RequestFrame | undefined) => {
    const m = method.toUpperCase();
    if (SAFE_METHODS.has(m)) return;
    if (m === 'POST' && isLoginPage(policy, url)) return;
    const read = readFromFrame(policy, url, frame) ? matchingReadPost(policy, url, m) : undefined;
    if (read) {
      if (readPostsUsed.size < MAX_LOGGED) readPostsUsed.add(readPostLabel(read));
      return;
    }
    writesSent++;
  };
  let lastDocument: { url: string; status: number } | null = null;
  // restrict() swaps both for every later request.
  let current = policy;
  let guard = options.guard;
  let closed = false;
  let closeReason: CloseReason | null = null;
  let tracing = false;
  let savedTrace: Buffer | undefined;
  const saveTrace = async () => {
    if (!tracing) return;
    tracing = false;
    const dir = await mkdtemp(join(tmpdir(), 'pw-trace-'));
    try {
      const path = join(dir, 'trace.zip');
      await context.tracing.stop({ path });
      savedTrace = await readFile(path);
    } catch {
      // The browser is gone; there is no trace to keep.
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  let closing: Promise<void> | null = null;
  let redirects: RedirectGuard | null = null;
  // Requests are refused as soon as `closed` is set; the trace is saved before the context goes away.
  const close = (reason: CloseReason = 'caller'): Promise<void> => {
    if (closing) return closing;
    closed = true;
    closeReason = reason;
    closeWindows();
    closing = (async () => {
      await saveTrace();
      // The guard lets go of any paused request when it detaches: only once the context can send nothing more.
      await context.close().catch(() => undefined);
      await redirects?.detach();
      await browser.close().catch(() => undefined);
    })();
    return closing;
  };
  browser.on('disconnected', () => {
    if (closing) return;
    closed = true;
    closeReason = 'disconnected';
    closeWindows();
    closing = Promise.resolve();
  });
  if (options.trace) {
    await context.tracing.start({ screenshots: false, snapshots: true, sources: false });
    tracing = true;
  }
  // Checks that finish after their request (redirect hops, server addresses). idle() waits for them.
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
  };
  // Masked first, then capped, so a secret across the cap is never left half visible. Page script can repeat a
  // request without limit: non-fatal violations and blocked requests are deduped and capped; fatal ones always kept.
  const loggedViolations = new Set<string>();
  const loggedBlocked = new Set<string>();
  const loggedFatal = new Set<string>();
  /** `raw` is the request URL; the violation shows its masked origin + pathname, capped. */
  const record = (v: Omit<Violation, 'fatal'>, fatal: boolean, raw: string) => {
    const entry: Violation = {
      ...v, url: cap(scrub(shownUrl(raw))), ...(v.host !== undefined ? { host: cap(scrub(v.host)) } : {}),
      ...(v.method !== undefined ? { method: scrub(v.method).slice(0, MAX_METHOD) } : {}), fatal,
    };
    const key = JSON.stringify([entry.kind, entry.method ?? '', entry.url, entry.host ?? '']);
    if (!fatal) {
      if (loggedViolations.has(key) || loggedViolations.size >= MAX_LOGGED) return;
      loggedViolations.add(key);
    } else {
      // The redirect guard and the watchdog can both see one hop: the same fatal entry is kept once. (The first fatal
      // violation closes the session, so a repeat adds nothing.)
      if (loggedFatal.has(key)) return;
      loggedFatal.add(key);
    }
    violations.push(entry);
    if (fatal) void close('violation');
  };
  const recordBlocked = (method: string, url: string) => {
    let u: URL;
    try { u = new URL(url); } catch { return; /* unparseable: the violation already records it */ }
    const entry: RequestRecord = { method: scrub(method).slice(0, MAX_METHOD), host: cap(scrub(u.host)), path: cap(scrub(maskSessionSegments(u.pathname))) };
    const key = `${entry.method}|${entry.host}|${entry.path}`;
    if (loggedBlocked.has(key) || loggedBlocked.size >= MAX_LOGGED) return;
    loggedBlocked.add(key);
    blockedRequests.push(entry);
  };
  /** null: fine. 'unresolved': the name does not resolve. Otherwise: the private-address violation to record. */
  const addressCheck = async (url: string): Promise<Omit<Violation, 'fatal'> | 'unresolved' | null> => {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const res = await guard.check(u.host);
    if (res.ok) return null;
    if (res.reason === 'unresolved') return 'unresolved';
    return { kind: 'private', url: cap(`${u.origin}${u.pathname}`), host: u.host };
  };
  /** The private-address violation for a URL whose address check failed: a failed check counts as private (fail closed). */
  const unchecked = (url: string): Omit<Violation, 'fatal'> => {
    let u: URL | undefined;
    try { u = new URL(url); } catch { u = undefined; }
    return { kind: 'private', url: u ? cap(`${u.origin}${u.pathname}`) : bare(url), ...(u ? { host: u.host } : {}) };
  };
  /** The address the browser actually connected to: a private one the policy does not admit ends the run (rebinding). */
  const checkServer = async (res: PwResponse): Promise<void> => {
    if (closed) return;
    let u: URL;
    try { u = new URL(res.url()); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const addr = await res.serverAddr().catch(() => null);
    // The current guard: restrict() swaps it with the policy.
    if (closed || !addr || !options.seams.isPrivate(addr.ipAddress) || guard.admitted(u.host)) return;
    record({ kind: 'private', url: cap(`${u.origin}${u.pathname}`), host: u.host }, true, res.url());
  };

  /**
   * Decides one request before the browser sends it: the first URL of every request (context.route) and every redirect
   * hop (the redirect guard, browser/redirects.ts). Order: scheme → host allowlist → method/write rules (checkRequest) →
   * address. A write is never sent either way. A refused hop is always fatal: a listed site's own redirect sent it
   * off the policy.
   */
  const decide = async (req: {
    url: string; method: string; nav: boolean; frame: RequestFrame | undefined; hop: boolean;
    /**
     * false: a hop the guard cannot tie to this session for sure (a frame no longer found). It is checked and refused the
     * same way, but neither recorded nor counted, and no window admits it; the watchdog, which only sees this session's
     * requests, records it if it is this session's.
     */
    attributed?: boolean;
  }): Promise<HopVerdict> => {
    const { url, nav, frame, hop } = req;
    const attributed = req.attributed !== false;
    const method = req.method.toUpperCase();
    const mainNav = nav && !(frame !== undefined && !frame.isMain);
    // A window slot is reserved at most once per request. A request decided again after restrict() (which closes the
    // windows) never gets a second slot, so it is refused.
    let reserved = false;
    // A restrict() while the address check is pending means the request is decided again under the new policy.
    for (let attempt = 0; attempt < 3; attempt++) {
      const used = current;
      let v = checkRequest(used, { url, method, isNavigation: nav, frame });
      // A refused write passes while an open window admits it (a 307/308 re-POST of the submitted form takes one of its
      // window's slots). Decided here, synchronously, before any await, so the window caps hold for concurrent requests.
      if (v?.kind === 'write' && attributed && !reserved && admit(used, url, method, frame)) {
        reserved = true;
        v = null;
      }
      if (v) {
        // A blocked main-frame navigation or redirect hop always ends the run; a blocked write ends it unless writeMode is
        // 'block'; anything else (sub-resources, sub-frame navigations) is logged and the run goes on.
        const fatal = hop || mainNav || (v.kind === 'write' && used.writeMode !== 'block');
        if (attributed) record(v, fatal, url);
        if (attributed && !fatal && !SAFE_METHODS.has(method)) recordBlocked(method, url);
        return 'blocked';
      }
      const a = await addressCheck(url).catch(() => unchecked(url));
      if (current !== used) continue;
      // Closed while the check ran: nothing is sent, and nothing is recorded after the session's end.
      if (closed) break;
      if (a === 'unresolved') return 'unresolved';
      if (a) {
        // A private main-frame navigation or hop ends the run; a private sub-resource or sub-frame load is blocked and logged.
        const fatal = hop || mainNav;
        if (attributed) record(a, fatal, url);
        if (attributed && !fatal && !SAFE_METHODS.has(method)) recordBlocked(method, url);
        return 'blocked';
      }
      // Counted before it is sent: a write that may have left the browser is never missed (over-reporting is the safe side).
      if (attributed) countWrite(used, url, method, frame);
      return 'continue';
    }
    // Closed, or the policy kept changing under the request: fail closed.
    return 'blocked';
  };

  await context.route('**/*', async (route) => {
    if (closed) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    const r = route.request();
    const verdict = await decide({ url: r.url(), method: r.method(), nav: r.isNavigationRequest(), frame: requestFrame(r), hop: false });
    if (verdict === 'continue') {
      redirects?.expect(r.method(), r.url());
      await route.continue().catch(() => undefined);
    } else await route.abort(verdict === 'unresolved' ? 'namenotresolved' : 'blockedbyclient').catch(() => undefined);
  });
  // Defence in depth behind the redirect guard. Playwright continues a redirect hop before any client code sees it, so
  // this watchdog only ever sees a hop that has already been sent, if it sees it at all: an off-list or private one is
  // fatal, and the session is closed. Off-list hops are recorded at once (the guard, deciding the same hop, records the
  // same entry, which record() keeps once) and the address check starts at once. What takes a window slot or counts as
  // a write is the guard's when it decided the hop: the watchdog waits for the guard's word (until the hop is done, at
  // most WATCHDOG_WAIT_MS) and does it only for a hop the guard did not decide.
  context.on('request', (r) => {
    if (!r.redirectedFrom()) return;
    const hopFrame = requestFrame(r);
    const url = r.url();
    const method = r.method();
    const v = checkRequest(current, { url, method, isNavigation: r.isNavigationRequest(), frame: hopFrame });
    if (v && v.kind !== 'write') {
      record(v, true, url);
      return;
    }
    if (!v) {
      track((async () => {
        const a = await addressCheck(url).catch(() => unchecked(url));
        // Not after the session's end: the guard has refused anything still pending then.
        if (!closed && a && a !== 'unresolved') record(a, true, url);
      })());
    }
    if (!v && SAFE_METHODS.has(method.toUpperCase())) return;
    const act = () => {
      // A 307/308 re-POST of the submitted form takes one of its window's slots (same rule as the route handler).
      if (v && !admit(current, url, method, hopFrame)) record(v, true, url);
      // The hop has already been sent: a re-posted write counts.
      else countWrite(current, url, method, hopFrame);
    };
    if (!redirects) return act();
    const done = r.response().then(() => undefined, () => undefined);
    track(redirects.whenDecided(method, url, done, WATCHDOG_WAIT_MS).then((decided) => { if (!decided) act(); }));
  });
  // Shared workers, worker WebSockets, WebSocketStream, WebTransport and WebRTC never reach context.route or
  // routeWebSocket: every frame loses them before page script runs (browser/harden.ts).
  await context.addInitScript(HARDEN_SCRIPT);
  await context.routeWebSocket(/.*/, (ws) => {
    record({ kind: 'websocket', url: bare(ws.url()) }, false, ws.url());
    void ws.close().catch(() => undefined);
  });
  // Only document loads that went over the network count. framenavigated also fires for history.pushState,
  // which page script could use to fake an "observed" path.
  context.on('response', (res) => {
    track(checkServer(res).catch(() => undefined));
    const r = res.request();
    if (!r.isNavigationRequest() || (res.status() >= 300 && res.status() < 400)) return;
    // A popup's first navigation has no frame yet; any other frameless navigation is treated the same way.
    const frame = requestFrame(r);
    if (frame && !frame.isMain) return;
    let u: URL;
    try { u = new URL(res.url()); } catch { return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    lastDocument = { url: res.url(), status: res.status() };
    const key = `${u.origin}${u.pathname}`;
    if (navigations.size < MAX_NAVIGATIONS) navigations.add(key);
  });
  if (options.redirectGuard !== 'off') {
    redirects = await startRedirectGuard(browser, context, {
      shared: options.redirectGuard === 'shared',
      decide: (hop) => {
        const verdict = decide({ url: hop.url, method: hop.method, nav: hop.isNavigation, frame: hop.frame, hop: true, attributed: hop.attributed });
        track(verdict.then(() => undefined, () => undefined));
        return verdict;
      },
      onPolicy: async (url, method) => {
        let u: URL;
        try { u = new URL(url); } catch { return false; }
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const p = current;
        const listed = [...p.navHosts, ...listedSubresources(p), ...(p.frameHosts ?? [])].includes(u.host);
        if (!listed && !(p.subresourceHosts === '*' && SAFE_METHODS.has(method.toUpperCase()))) return false;
        return (await addressCheck(url).catch(() => unchecked(url))) === null;
      },
      closed: () => closed,
      onLost: () => { void close('disconnected'); },
    });
  }
  const page = await context.newPage();
  await redirects?.adopt(page);
  /**
   * Over CDP or a Browser Server with Slow Motion on (someone is watching the run), a live view attached to the same page reads the step as a
   * console event (Runtime.consoleAPICalled): it is logged from an isolated world, so the page's own script can neither
   * see nor fake it, and nothing on the page changes. The world lives until the document is replaced: it is created once
   * per document and again after a navigation, so a marker costs one round trip.
   */
  type MarkerTarget = { cdp: CDPSession; frameId: string; contextId?: number };
  const markerTargets = new WeakMap<Page, Promise<MarkerTarget>>();
  const markerTarget = (target: Page): Promise<MarkerTarget> => {
    let t = markerTargets.get(target);
    if (!t) {
      t = (async () => {
        const cdp = await context.newCDPSession(target);
        return { cdp, frameId: (await cdp.send('Page.getFrameTree')).frameTree.frame.id };
      })();
      markerTargets.set(target, t);
    }
    return t;
  };
  const marker = async (target: Page, event: string, label: string) => {
    if (!options.markers || closed) return;
    const t = await markerTarget(target);
    const expression = `console.debug("rpa-step", ${JSON.stringify(event)}, ${JSON.stringify(label)})`;
    for (let attempt = 0; attempt < 2; attempt++) {
      t.contextId ??= (await t.cdp.send('Page.createIsolatedWorld', { frameId: t.frameId, worldName: 'rpa-step-marker' })).executionContextId;
      try { await t.cdp.send('Runtime.evaluate', { contextId: t.contextId, expression }); return; } catch { t.contextId = undefined; }
    }
  };
  const stepHooks: StepHooks = {
    async start(target, label) {
      if (tracing) await context.tracing.group(label).catch(() => undefined);
      await marker(target, 'start', label).catch(() => undefined);
    },
    async end(target, ok, label) {
      if (tracing) await context.tracing.groupEnd().catch(() => undefined);
      await marker(target, ok ? 'ok' : 'failed', label).catch(() => undefined);
    },
  };
  return {
    stepHooks,
    browser,
    context,
    page,
    violations,
    blockedRequests,
    navigations,
    get writesSent() { return writesSent; },
    get readPostsUsed() { return readPostsUsed; },
    get lastDocument() { return lastDocument; },
    get closed() { return closed; },
    get closeReason() { return closeReason; },
    close,
    writeWindow: win?.handle ?? null,
    armSubmit(target: AllowedSubmit | null) {
      stepWin?.handle.close();
      stepWin = target ? createWindow(submitTargetRule({ ...target })) : null;
      stepWin?.handle.open();
    },
    restrict(next: PortalPolicy) {
      closeWindows();
      current = next;
      // Same lookups, cache and caps: a restrict() never gives page script a fresh lookup budget.
      guard = guard.withPolicy(next);
    },
    async takeTrace() {
      if (closing) await closing;
      else await saveTrace();
      return savedTrace;
    },
    async idle() {
      const end = Date.now() + IDLE_MAX_MS;
      while (pending.size > 0 && Date.now() < end) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, end - Date.now())); }),
        ]);
        clearTimeout(timer);
      }
    },
  };
}
