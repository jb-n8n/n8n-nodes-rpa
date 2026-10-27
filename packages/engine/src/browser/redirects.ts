import type { Browser, BrowserContext, CDPSession, Frame, Page } from 'playwright-core';
import type { RequestFrame } from './window.js';

/**
 * The redirect guard: every redirect hop is checked before the browser sends it.
 *
 * context.route sees only the first URL of a redirect chain: Playwright continues every later hop itself, before any
 * client code runs, so the session's `request` watchdog can only ever see a hop that has already been sent (and on
 * Linux Playwright sometimes emits no `request` event for a hop at all). The guard closes that gap with a browser-level
 * DevTools session that intercepts every request (Fetch domain, request stage) after Playwright's own interception:
 * a request does not leave the browser until both have let it through. It works the same in Local Browser, Browser
 * Server (the DevTools session travels over the Playwright protocol) and CDP modes.
 *
 * - A request whose chain the guard has not seen before is the first URL, which context.route has already decided. It
 *   must still meet the floor, else it is failed without a record: a host the policy lists at all, at an allowed
 *   address (`onPolicy`), and for a method other than GET/HEAD/OPTIONS, a request context.route itself let through
 *   (`expect`). That catches a hop the guard failed to recognise, a request Playwright never routed, and a request
 *   decided under a policy that restrict() has since replaced.
 * - A hop (the same network id as an earlier request, or a redirectedRequestId) is decided by the session (`decide`)
 *   with the same rules as context.route: host list, write rules, write windows, address check. Off the policy it is
 *   failed and recorded; it never leaves the browser.
 *
 * Whose a request is (remote browsers, which other sessions may share): a hop belongs to its chain's first request. A
 * request is another context's only when a DevTools target positively says so (then it passes untouched). A first URL
 * that cannot be tied to this session either way (a same-process frame in none of this session's frame trees) passes:
 * its own context's route handler decides it. A hop of such a chain is checked all the same (fail closed), but not
 * recorded or counted here.
 *
 * The browser keeps doing all the networking: no URL, cookie, cache, proxy or DNS-pinning behaviour changes. Fetching
 * hops in n8n's process with route.fetch instead would bypass the browser's pinned addresses (Local Browser) and the
 * server address check, and would send requests from n8n's network in CDP mode.
 */

/** What the session decides for a redirect hop. */
export type HopVerdict = 'continue' | 'blocked' | 'unresolved';

export interface Hop {
  url: string;
  method: string;
  isNavigation: boolean;
  frame: RequestFrame | undefined;
  /**
   * false when the hop's chain could not be tied to this session for sure (shared browsers: a frame found neither as a
   * target nor in this context's frame trees). It is checked all the same (fail closed); the session only does not
   * record or count it.
   */
  attributed: boolean;
}

export interface RedirectGuardOptions {
  /**
   * The browser may serve other clients (a CDP endpoint, or a Playwright server that shares one browser between its
   * clients): only this session's browser context is checked and other clients' requests pass untouched. Otherwise
   * (Local Browser) the browser was launched for this session alone and every request is checked.
   */
  shared: boolean;
  /** Decides a hop before it is sent; records any violation itself. */
  decide(hop: Hop): Promise<HopVerdict>;
  /** The floor every request must meet: a host the policy lists at all (or the '*' rule), at an allowed address. */
  onPolicy(url: string, method: string): Promise<boolean>;
  closed(): boolean;
  /** The guard's DevTools session ended while the session was open: nothing checks hops any more. */
  onLost(): void;
}

export interface RedirectGuard {
  /** Learns this session's browser context from its first page (shared browsers only); call before the page loads anything. */
  adopt(page: Page): Promise<void>;
  /** context.route let this write through (a method other than GET/HEAD/OPTIONS): the guard's floor admits it once. */
  expect(method: string, url: string): void;
  /**
   * Resolves true when the guard decided (or decides, before `done` settles or `waitMs` passes) a hop with this method
   * and URL (fragment ignored), once per hop. The watchdog then leaves that hop's window slot and write count to the
   * guard. Only accounting depends on it: violations are recorded by both and kept once.
   */
  whenDecided(method: string, url: string, done: Promise<void>, waitMs: number): Promise<boolean>;
  /**
   * Stops intercepting: fails every request still paused (unless positively another context's), then detaches. Call it
   * once the context is closed. Never throws.
   */
  detach(): Promise<void>;
}

/** Network ids of chains the guard has seen, with whose they are; the oldest are forgotten past this many (the floor still applies). */
const MAX_CHAINS = 100_000;
/** Hops decided by the guard and not yet matched by the watchdog. */
const MAX_DECIDED = 10_000;
/** Writes context.route let through and the guard has not seen yet. */
const MAX_EXPECTED = 10_000;
/** Frame ownership verdicts and targets kept (shared browsers); the oldest are forgotten and looked up again. */
const MAX_FRAMES = 50_000;

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * Whose a request is. 'foreign' only when a target positively names another browser context: anything unsure is
 * checked (fail closed).
 */
type Owner = 'ours' | 'foreign' | 'unknown';
const key = (method: string, url: string) => `${method.toUpperCase()} ${url.split('#')[0]}`;

/** A bounded map: past `max` entries the oldest goes. */
function setBounded<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > max) m.delete(m.keys().next().value as K);
}
/** A bounded multiset kept in a map of counts. */
const addOne = (m: Map<string, number>, k: string, max: number) => setBounded(m, k, (m.get(k) ?? 0) + 1, max);
const takeOne = (m: Map<string, number>, k: string): boolean => {
  const n = m.get(k) ?? 0;
  if (n === 0) return false;
  if (n === 1) m.delete(k);
  else m.set(k, n - 1);
  return true;
};

type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };

function walk(tree: FrameTree, visit: (id: string, url: string) => void): void {
  visit(tree.frame.id, tree.frame.url);
  for (const child of tree.childFrames ?? []) walk(child, visit);
}

export async function startRedirectGuard(browser: Browser, context: BrowserContext, opts: RedirectGuardOptions): Promise<RedirectGuard> {
  const cdp = await browser.newBrowserCDPSession();
  /** networkId → whose the chain is. */
  const chains = new Map<string, Owner>();
  const decided = new Map<string, number>();
  /** Watchdogs waiting for the guard's word on a hop, by method and URL. */
  const waiters = new Map<string, (() => void)[]>();
  const expected = new Map<string, number>();
  /** frameId → whose it is, only when known for sure (shared browsers). */
  const owners = new Map<string, 'ours' | 'foreign'>();
  /** targetId → its browser context and type, from target discovery: kept after the target closes (its last requests). */
  const targets = new Map<string, { ctx: string; type: string }>();
  /** Page and out-of-process frame sessions opened to read frame trees (null: a frame without one); detached with the guard. */
  const sessions = new Map<Page | Frame, Promise<CDPSession | null>>();
  let detached = false;
  let contextId: string | undefined;
  let setContextId: (id: string) => void = () => undefined;
  const contextKnown = new Promise<string>((resolve) => { setContextId = resolve; });

  const sessionFor = (target: Page | Frame): Promise<CDPSession | null> => {
    let s = sessions.get(target);
    if (!s) {
      // A same-process frame has no session of its own; if it later moves to its own process, it is a new target.
      s = context.newCDPSession(target).catch(() => null);
      sessions.set(target, s);
    }
    return s;
  };

  /**
   * A frame that is not a DevTools target (part of its page's process), found in the frame trees of this context's pages
   * and out-of-process frames. Every frame seen on the way is remembered as this session's.
   */
  const findFrame = async (frameId: string): Promise<{ url: string } | undefined> => {
    let hit: { url: string } | undefined;
    for (const page of context.pages()) {
      for (const target of [page, ...page.frames().filter((f) => f !== page.mainFrame())]) {
        const s = await sessionFor(target);
        if (!s) continue;
        const tree = await s.send('Page.getFrameTree').then((r) => r.frameTree as FrameTree, () => undefined);
        if (!tree) continue;
        walk(tree, (id, url) => {
          if (opts.shared) setBounded(owners, id, 'ours', MAX_FRAMES);
          if (id === frameId) hit = { url };
        });
        if (hit) return hit;
      }
    }
    return undefined;
  };

  const targetInfo = (frameId: string) =>
    cdp.send('Target.getTargetInfo', { targetId: frameId }).then((r) => r.targetInfo, () => undefined);

  /** Whose a request from this frame is. Only a target naming another browser context makes it 'foreign'. */
  const ownerOf = async (frameId: string): Promise<Owner> => {
    if (!opts.shared) return 'ours';
    if (!frameId) return 'unknown';
    const ours = contextId ?? await contextKnown;
    const known = owners.get(frameId);
    if (known !== undefined) return known;
    const ctx = targets.get(frameId)?.ctx ?? (await targetInfo(frameId))?.browserContextId;
    if (ctx) {
      const owner = ctx === ours ? 'ours' : 'foreign';
      setBounded(owners, frameId, owner, MAX_FRAMES);
      return owner;
    }
    // Not a target: a same-process frame, found in this context's frame trees or not known for sure (not remembered).
    return (await findFrame(frameId)) !== undefined ? 'ours' : 'unknown';
  };

  /** The hop's frame as checkRequest sees it. A same-process sub-frame's address is looked up only for a write. */
  const frameOf = async (frameId: string, method: string): Promise<RequestFrame | undefined> => {
    if (!frameId) return undefined;
    const info = await targetInfo(frameId);
    if (info) return { isMain: info.type === 'page', url: info.url };
    // A closed target's last requests: a page's main frame, or an out-of-process frame; address unknown.
    const closed = targets.get(frameId);
    if (closed) return { isMain: closed.type === 'page', url: '' };
    if (SAFE.has(method.toUpperCase())) return { isMain: false, url: '' };
    return { isMain: false, url: (await findFrame(frameId))?.url ?? '' };
  };

  /** Requests paused and not yet answered, with their owner once known: detach() fails every one not positively foreign. */
  const pending = new Map<string, Owner | undefined>();
  const fail = (requestId: string, errorReason: 'BlockedByClient' | 'NameNotResolved') => {
    pending.delete(requestId);
    return cdp.send('Fetch.failRequest', { requestId, errorReason }).catch(() => undefined);
  };
  const cont = (requestId: string) => {
    // A decision that comes after detach() is not acted on: detach() has failed the request already (unless foreign).
    if (detached) return pending.get(requestId) === 'foreign' ? undefined : fail(requestId, 'BlockedByClient');
    pending.delete(requestId);
    return cdp.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
  };

  const handle = async (e: { requestId: string; request: { url: string; method: string }; frameId: string; resourceType: string; networkId?: string; redirectedRequestId?: string }) => {
    const { requestId, request: { url, method }, frameId, networkId } = e;
    // Own browser: a closing session sends nothing more. A shared one first tells its own requests from others'.
    if (!opts.shared && opts.closed()) return fail(requestId, 'BlockedByClient');
    const chain = networkId !== undefined ? chains.get(networkId) : undefined;
    const hop = chain !== undefined || e.redirectedRequestId !== undefined;
    // A hop belongs to whoever its chain's first request belonged to, even once that frame or page is gone; a chain
    // known only as 'unknown' is looked up again (it may since be found as this session's).
    const owner = chain === 'ours' || chain === 'foreign' ? chain : await ownerOf(frameId);
    if (pending.has(requestId)) pending.set(requestId, owner);
    if (!hop && networkId !== undefined) setBounded(chains, networkId, owner, MAX_CHAINS);
    if (owner === 'foreign') return cont(requestId);
    // A first URL nobody can tie to this session (a shared browser's same-process frame found in none of this session's
    // frame trees): its own context's route handler decides it, so it passes here. Its hops stay checked (fail closed).
    if (!hop && owner === 'unknown') return cont(requestId);
    if (opts.closed()) return fail(requestId, 'BlockedByClient');
    if (!hop) {
      const floor = (SAFE.has(method.toUpperCase()) || takeOne(expected, key(method, url))) && await opts.onPolicy(url, method);
      return floor ? cont(requestId) : fail(requestId, 'BlockedByClient');
    }
    const attributed = owner === 'ours';
    if (attributed) {
      const k = key(method, url);
      const list = waiters.get(k);
      const waiting = list?.shift();
      if (list?.length === 0) waiters.delete(k);
      if (waiting) waiting();
      else addOne(decided, k, MAX_DECIDED);
    }
    const verdict = await opts.decide({ url, method, isNavigation: e.resourceType === 'Document', frame: await frameOf(frameId, method), attributed });
    if (verdict === 'continue') return cont(requestId);
    return fail(requestId, verdict === 'unresolved' ? 'NameNotResolved' : 'BlockedByClient');
  };

  cdp.on('Fetch.requestPaused', (e) => {
    // Paused while detaching: failed, not left for the detach to let go (fail closed, whoever's it is).
    if (detached) return void fail(e.requestId, 'BlockedByClient');
    pending.set(e.requestId, undefined);
    // Anything unexpected fails the request: a paused request is never left hanging, nor let through unchecked.
    void handle(e).catch(() => fail(e.requestId, 'BlockedByClient'));
  });
  cdp.on('close', () => { if (!detached) opts.onLost(); });
  if (opts.shared) {
    const learn = (t: { targetId: string; type: string; browserContextId?: string }) => {
      if (t.browserContextId) setBounded(targets, t.targetId, { ctx: t.browserContextId, type: t.type }, MAX_FRAMES);
    };
    cdp.on('Target.targetCreated', (e) => learn(e.targetInfo));
    cdp.on('Target.targetInfoChanged', (e) => learn(e.targetInfo));
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  return {
    async adopt(page) {
      if (!opts.shared) return;
      const s = await context.newCDPSession(page);
      try {
        const id = (await s.send('Target.getTargetInfo')).targetInfo.browserContextId;
        // Without it nothing would count as this session's: refuse the session rather than check nothing.
        if (!id) throw new Error('the browser did not name the browser context');
        contextId = id;
        setContextId(id);
      } finally {
        await s.detach().catch(() => undefined);
      }
    },
    expect(method, url) {
      if (!SAFE.has(method.toUpperCase())) addOne(expected, key(method, url), MAX_EXPECTED);
    },
    whenDecided(method, url, done, waitMs) {
      const k = key(method, url);
      if (takeOne(decided, k)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const list = waiters.get(k) ?? [];
        const onDecided = () => { clearTimeout(timer); resolve(true); };
        list.push(onDecided);
        waiters.set(k, list);
        const giveUp = () => {
          clearTimeout(timer);
          const at = list.indexOf(onDecided);
          if (at < 0) return; // already handed a decision
          list.splice(at, 1);
          if (list.length === 0) waiters.delete(k);
          resolve(takeOne(decided, k));
        };
        timer = setTimeout(giveUp, waitMs);
        void done.then(giveUp);
      });
    },
    async detach() {
      if (detached) return;
      detached = true;
      // Chromium lets a paused request go when the session detaches: fail each first (fail closed if still undecided).
      const held = [...pending].filter(([, owner]) => owner !== 'foreign').map(([id]) => id);
      await Promise.all(held.map((id) => fail(id, 'BlockedByClient')));
      await cdp.detach().catch(() => undefined);
      await Promise.all([...sessions.values()].map(async (s) => (await s)?.detach().catch(() => undefined)));
    },
  };
}
