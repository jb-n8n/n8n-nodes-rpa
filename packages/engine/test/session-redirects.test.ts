import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chromium, type BrowserServer } from 'playwright-core';
import { startRedirectGuard } from '../src/browser/redirects.js';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint, PortalPolicy } from '../src/types.js';
import { LOCAL } from './helpers.js';

// Redirect hops are decided before the browser sends them (browser/redirects.ts). Each test counts what actually reached
// the servers: an off-list hop must never arrive, not merely be reported afterwards.

const masker = createMasker([]);

type Hit = { method: string; path: string; cookie: string; body: string };

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ server: Server; port: number; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      hits.push({ method: req.method ?? '', path: u.pathname, cookie: req.headers.cookie ?? '', body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port, hits };
}

const stop = async (s: Server) => { s.closeAllConnections(); await new Promise((r) => s.close(r)); };

let site: Awaited<ReturnType<typeof listen>>;
let off: Awaited<ReturnType<typeof listen>>;
let base: string;
let host: string;

beforeAll(async () => {
  // Off the policy: a listening port on the same address, so a hop that got out would really be answered.
  off = await listen((_req, res) => { res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); res.end('off'); });
  site = await listen((req, res, body) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = (k: string) => u.searchParams.get(k);
    const html = (b: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); };
    if (u.pathname === '/page' || u.pathname === '/landing' || u.pathname === '/final') return html(`<h1>${u.pathname}</h1>`);
    // /hop?to=<url>&code=302&cookie=name=value: one redirect, anywhere.
    if (u.pathname.startsWith('/hop')) {
      const headers: Record<string, string> = {};
      // Sent as UTF-8 bytes, as a server would send an IDN Location.
      if (q('to') !== null) headers.location = Buffer.from(q('to') as string, 'utf8').toString('latin1');
      if (q('cookie')) headers['set-cookie'] = `${q('cookie')}; Path=/`;
      res.writeHead(Number(q('code') ?? 302), headers);
      return res.end('moved');
    }
    // /chain/<n>: n redirects, then a page.
    const chain = /^\/chain\/(\d+)$/.exec(u.pathname);
    if (chain) {
      const n = Number(chain[1]);
      if (n === 0) return html('<h1>end</h1>');
      res.writeHead(302, { location: `/chain/${n - 1}` });
      return res.end();
    }
    if (u.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ method: req.method, cookie: req.headers.cookie ?? '', body }));
    }
    res.writeHead(404);
    res.end();
  });
  host = `127.0.0.1:${site.port}`;
  base = `http://${host}`;
});
afterAll(async () => { await stop(site.server); await stop(off.server); });
beforeEach(() => { site.hits.length = 0; off.hits.length = 0; });

const policy = (over: Partial<PortalPolicy> = {}): PortalPolicy => ({
  startUrl: `${base}/page`, navHosts: [host], subresourceHosts: [],
  login: [{ host, path: '/hop-login' }, { host, path: '/echo' }],
  allowedSubmits: [], allowPrivateNetwork: true, ...over,
});
const offUrl = (path = '/x') => `http://127.0.0.1:${off.port}${path}`;
const hop = (to: string, extra = '') => `${base}/hop?to=${encodeURIComponent(to)}${extra}`;
/** fetch() from the page: [status, final URL, redirected, body], the error text, or 'closed' (a fatal violation closed the session). */
const pageFetch = (s: Session, url: string, init: RequestInit = {}) =>
  s.page.evaluate(async ([u, i]) => {
    try {
      const r = await fetch(u, i);
      return [r.status, r.url, r.redirected, await r.text()] as const;
    } catch (e) { return String(e); }
  }, [url, init] as const).catch(() => 'closed');
/** Lets the watchdog's late look at a finished hop run, so a second violation would show. */
const settle = async (s: Session) => { await s.idle(); await new Promise((r) => setTimeout(r, 300)); };
const offViolations = (s: Session) => s.violations.filter((v) => v.url.includes(`//127.0.0.1:${off.port}/`));

async function withSession(endpoint: BrowserEndpoint, p: PortalPolicy, fn: (s: Session) => Promise<void>, extra: { redirectGuard?: boolean } = {}) {
  const s = await openSession({ endpoint, policy: p, masker, ...extra });
  try {
    await s.page.goto(`${base}/page`);
    await fn(s);
  } finally { await s.close(); }
}

describe('redirect hops are decided before they are sent', () => {
  it('a sub-request redirected to an off-list port is blocked, recorded once as fatal, and never arrives', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      expect(await pageFetch(s, hop(offUrl('/leak?secret=1')))).toMatch(/TypeError|closed/);
      await settle(s);
      expect(off.hits).toEqual([]);
      expect(offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true, url: `http://127.0.0.1:${off.port}/leak` })]);
      expect(s.closeReason).toBe('violation');
    });
  });
  it('an image, a script and a style sheet redirected off the list are blocked the same way', async () => {
    for (const tag of ['img', 'script', 'link']) {
      await withSession(LOCAL, policy(), async (s) => {
        await s.page.evaluate(([t, u]) => {
          const el = document.createElement(t);
          if (t === 'link') { el.setAttribute('rel', 'stylesheet'); el.setAttribute('href', u); } else el.setAttribute('src', u);
          document.head.append(el);
        }, [tag, hop(offUrl(`/${tag}`))] as const);
        await expect.poll(() => offViolations(s).length).toBe(1);
        await settle(s);
        expect(off.hits, tag).toEqual([]);
        expect(offViolations(s), tag).toHaveLength(1);
      });
    }
  });
  it('a main-frame navigation redirected off the list is blocked before it is sent and ends the run', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      // Refused by the guard, or aborted by the close that the watchdog's record of the same hop starts.
      await expect(s.page.goto(hop(offUrl('/nav')))).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/);
      await settle(s);
      expect(off.hits).toEqual([]);
      expect(offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
      expect(s.closeReason).toBe('violation');
    });
  });
  it('the second and later hops of a chain are checked too (navigation and fetch)', async () => {
    const twice = (path: string) => hop(hop(offUrl(path)));
    await withSession(LOCAL, policy(), async (s) => {
      expect(await pageFetch(s, twice('/second'))).toMatch(/TypeError|closed/);
      await settle(s);
      expect(off.hits).toEqual([]);
      expect(offViolations(s)).toHaveLength(1);
    });
    await withSession(LOCAL, policy(), async (s) => {
      await expect(s.page.goto(twice('/second-nav'))).rejects.toThrow();
      await settle(s);
      expect(off.hits).toEqual([]);
      expect(offViolations(s)).toHaveLength(1);
    });
  });
  it('a Location that changes only the scheme, or spells the address another way, is checked on the canonical host', async () => {
    for (const to of [`https://127.0.0.1:${off.port}/s`, `http://2130706433:${off.port}/d`, `http://0x7f.0.0.1:${off.port}/h`, `//127.0.0.1:${off.port}/p`]) {
      await withSession(LOCAL, policy(), async (s) => {
        await pageFetch(s, hop(to));
        await settle(s);
        expect(off.hits, to).toEqual([]);
        expect(offViolations(s), to).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
      });
    }
  });
  it('an IDN host is checked in its ASCII form', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      await pageFetch(s, hop('http://bücher.example/x'));
      await settle(s);
      expect(s.violations).toEqual([expect.objectContaining({ kind: 'host', fatal: true, url: 'http://xn--bcher-kva.example/x' })]);
    });
  });
  it('a missing, invalid, data: or javascript: Location sends nothing anywhere and records nothing', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      for (const extra of ['', `&to=${encodeURIComponent('http://[::1')}`, `&to=${encodeURIComponent('data:text/plain,hi')}`, `&to=${encodeURIComponent('javascript:alert(1)')}`]) {
        await pageFetch(s, `${base}/hop?x=1${extra}`);
      }
      await s.page.goto(`${base}/hop?to=${encodeURIComponent('data:text/html,<h1>x</h1>')}`).catch(() => undefined);
      await settle(s);
      expect(off.hits).toEqual([]);
      expect(s.violations).toEqual([]);
      expect(s.closed).toBe(false);
    });
  });
});

describe('redirect chains on the policy work as in the browser', () => {
  it('a fetch follows an on-list chain and keeps the browser semantics (final URL, redirected)', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      expect(await pageFetch(s, `${base}/chain/3`)).toEqual([200, `${base}/chain/0`, true, '<h1>end</h1>']);
      expect(s.violations).toEqual([]);
    });
  });
  it('a navigation follows an on-list chain and the page ends on the final address', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      const r = await s.page.goto(`${base}/chain/3`);
      expect(r?.status()).toBe(200);
      expect(s.page.url()).toBe(`${base}/chain/0`);
      expect(site.hits.map((h) => h.path)).toEqual(['/page', '/chain/3', '/chain/2', '/chain/1', '/chain/0']);
      expect(s.violations).toEqual([]);
      expect(s.lastDocument).toEqual({ url: `${base}/chain/0`, status: 200 });
    });
  });
  it("the browser's own redirect limit still applies", async () => {
    await withSession(LOCAL, policy(), async (s) => {
      await expect(s.page.goto(`${base}/chain/25`)).rejects.toThrow(/ERR_TOO_MANY_REDIRECTS/);
      expect(site.hits.filter((h) => h.path.startsWith('/chain/')).length).toBeLessThanOrEqual(21);
      expect(s.violations).toEqual([]);
    });
  });
  it('POST then 303 continues as a GET', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      const r = await pageFetch(s, hop('/echo', '&code=303').replace('/hop?', '/hop-login?'), { method: 'POST', body: 'a=1' });
      expect(r).toEqual([200, `${base}/echo`, true, JSON.stringify({ method: 'GET', cookie: '', body: '' })]);
      expect(s.violations).toEqual([]);
      expect(s.writesSent).toBe(0);
    });
  });
  it('307 keeps the method and body; to a path the policy does not admit, the re-POST is blocked and never sent', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      const r = await pageFetch(s, hop('/echo', '&code=307').replace('/hop?', '/hop-login?'), { method: 'POST', body: 'a=1' });
      expect(r).toEqual([200, `${base}/echo`, true, JSON.stringify({ method: 'POST', cookie: '', body: 'a=1' })]);
      expect(s.violations).toEqual([]);
    });
    await withSession(LOCAL, policy(), async (s) => {
      await pageFetch(s, hop('/landing', '&code=307').replace('/hop?', '/hop-login?'), { method: 'POST', body: 'a=1' });
      await settle(s);
      expect(site.hits.filter((h) => h.path === '/landing')).toEqual([]);
      expect(s.violations).toEqual([expect.objectContaining({ kind: 'write', method: 'POST', fatal: true, url: `${base}/landing` })]);
    });
  });
  it('a 307 re-POST a write window admits takes one slot and counts once', async () => {
    const p = policy({ login: [], writeWindow: { step: 0, maxPosts: 3, hosts: [host] } });
    await withSession(LOCAL, p, async (s) => {
      s.writeWindow?.open();
      const r = await pageFetch(s, hop('/echo', '&code=307'), { method: 'POST', body: 'b=2' });
      expect(r).toEqual([200, `${base}/echo`, true, JSON.stringify({ method: 'POST', cookie: '', body: 'b=2' })]);
      await settle(s);
      expect(s.writeWindow?.posts).toEqual([{ method: 'POST', host, path: '/hop' }, { method: 'POST', host, path: '/echo' }]);
      expect(s.writesSent).toBe(2);
      expect(s.violations).toEqual([]);
    });
  });
  it('cookies set on a hop are kept by the browser and sent on the next hop', async () => {
    await withSession(LOCAL, policy(), async (s) => {
      const r = await pageFetch(s, hop('/echo', '&cookie=hop=1'));
      expect(r).toEqual([200, `${base}/echo`, true, JSON.stringify({ method: 'GET', cookie: 'hop=1', body: '' })]);
      expect((await s.context.cookies(base)).map((c) => `${c.name}=${c.value}`)).toEqual(['hop=1']);
    });
  });
});

describe('redirect guard in the remote modes', () => {
  let server: BrowserServer;
  beforeAll(async () => { server = await chromium.launchServer({ headless: true }); });
  afterAll(async () => { await server.close(); });
  it('Browser Server: an off-list hop is blocked before it is sent', async () => {
    const remote: BrowserEndpoint = { mode: 'playwright', wsUrl: server.wsEndpoint() };
    await withSession(remote, policy(), async (s) => {
      await pageFetch(s, hop(offUrl('/remote')));
      await settle(s);
      expect(offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
    });
    await withSession(remote, policy(), async (s) => {
      await expect(s.page.goto(hop(offUrl('/remote-nav')))).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/);
      await settle(s);
      expect(offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
    });
    expect(off.hits).toEqual([]);
  });
  it('closing the session while a hop waits for its address check never lets the hop go', async () => {
    // '*' admits localhost for a GET; its lookup is slow and private (seams), and localhost really reaches the off server.
    const p = policy({ subresourceHosts: '*' });
    const resolveHost = async (h: string) => {
      if (h !== 'localhost') return [];
      await new Promise((r) => setTimeout(r, 1_000));
      return ['10.0.0.5'];
    };
    const s = await openSession({ endpoint: { mode: 'playwright', wsUrl: server.wsEndpoint() }, policy: p, masker, resolveHost, isPrivate: (ip) => ip.startsWith('10.') });
    try {
      await s.page.goto(`${base}/page`);
      void pageFetch(s, hop(`http://localhost:${off.port}/late`));
      await expect.poll(() => site.hits.some((h) => h.path === '/hop')).toBe(true);
      await s.close();
      await new Promise((r) => setTimeout(r, 1_500));
      expect(off.hits).toEqual([]);
      expect(s.violations).toEqual([]);
    } finally { await s.close(); }
  });
  it('Browser Server sharing one browser: two sessions at once neither block nor report each other', async () => {
    const remote: BrowserEndpoint = { mode: 'playwright', wsUrl: server.wsEndpoint() };
    const a = await openSession({ endpoint: remote, policy: policy(), masker });
    // B allows nothing A uses.
    const b = await openSession({ endpoint: remote, policy: policy({ navHosts: ['b.example'], login: [] }), masker });
    try {
      expect((await a.page.goto(`${base}/chain/2`))?.status()).toBe(200);
      expect(await pageFetch(a, `${base}/chain/2`)).toEqual([200, `${base}/chain/0`, true, '<h1>end</h1>']);
      await pageFetch(a, hop(offUrl('/a')));
      await settle(a);
      expect(off.hits).toEqual([]);
      expect(offViolations(a)).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
      expect(b.violations).toEqual([]);
      expect(b.closed).toBe(false);
      // A first URL from A's same-process sub-frame: B cannot tie it to A by target, and lets A's route handler decide it.
      const a2 = await openSession({ endpoint: remote, policy: policy(), masker });
      try {
        await a2.page.goto(`${base}/page`);
        await a2.page.setContent(`<iframe src="${base}/page"></iframe>`);
        const frame = a2.page.frames()[1];
        await frame.waitForLoadState();
        expect(await frame.evaluate(async (u) => (await fetch(u)).status, `${base}/echo`)).toBe(200);
        expect(a2.violations).toEqual([]);
        expect(b.violations).toEqual([]);
      } finally { await a2.close(); }
    } finally { await a.close(); await b.close(); }
  });
  it("CDP: this session's hops are guarded; another client's context on the same browser is left alone", async () => {
    const port = await new Promise<number>((resolve) => { const srv = createNetServer().listen(0, () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); }); });
    const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    try {
      const other = await browser.newContext();
      const otherPage = await other.newPage();
      await withSession({ mode: 'cdp', wsUrl: `http://127.0.0.1:${port}` }, policy(), async (s) => {
        // The other client: its pages are DevTools targets of another browser context, so their requests pass untouched.
        await otherPage.goto(`${base}/page`);
        expect(await otherPage.evaluate(async (u) => (await fetch(u)).text(), hop(offUrl('/other')))).toBe('off');
        expect(await otherPage.goto(hop(offUrl('/other-nav'))).then((r) => r?.status())).toBe(200);
        // A same-process sub-frame is not a target and cannot be tied to either session for sure: the guard fails closed
        // and checks its hop against this session's policy, but does not record it here, and this session runs on.
        await otherPage.goto(`${base}/page`);
        await otherPage.setContent(`<iframe src="${base}/page"></iframe>`);
        const frame = otherPage.frames()[1];
        await frame.waitForLoadState();
        expect(await frame.evaluate(async (u) => fetch(u).then((r) => r.text(), (e: Error) => e.name), hop(offUrl('/other-frame')))).toBe('TypeError');
        expect(off.hits.map((h) => h.path)).toEqual(['/other', '/other-nav']);
        expect(s.violations).toEqual([]);
        expect(s.closed).toBe(false);
        // This session: a same-process sub-frame of its own page (found in its page's frame tree, not a DevTools target).
        await s.page.setContent(`<iframe src="${base}/page"></iframe>`);
        const mine = s.page.frames()[1];
        await mine.waitForLoadState();
        // The fatal violation closes the session, possibly before evaluate returns.
        await mine.evaluate(async (u) => { await fetch(u).catch(() => undefined); }, hop(offUrl('/mine'))).catch(() => undefined);
        await settle(s);
        expect(off.hits.map((h) => h.path)).toEqual(['/other', '/other-nav']);
        expect(offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true, url: offUrl('/mine') })]);
      });
      // Detached: the other client's requests are no longer paused by a session that has ended.
      await otherPage.goto(`${base}/page`);
      expect(await otherPage.evaluate(async (u) => (await fetch(u)).text(), hop(offUrl('/after')))).toBe('off');
    } finally { await browser.close(); }
  });
});

describe('the guard on detach', () => {
  it('a hop still paused when the guard detaches is failed, never let go', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      let decisions = 0;
      const guard = await startRedirectGuard(browser, context, {
        shared: false,
        // A decision that never comes: the hop stays paused until detach.
        decide: () => { decisions++; return new Promise(() => undefined); },
        onPolicy: async () => true,
        closed: () => false,
        onLost: () => undefined,
      });
      const page = await context.newPage();
      await page.goto(`${base}/page`);
      const result = page.evaluate(async (u) => fetch(u).then((r) => r.text(), (e: Error) => e.name), hop(offUrl('/held')));
      await expect.poll(() => decisions).toBe(1);
      await guard.detach();
      expect(await result).toBe('TypeError');
      await new Promise((r) => setTimeout(r, 300));
      expect(off.hits).toEqual([]);
    } finally { await browser.close(); }
  });
});

describe('the watchdog behind the guard', () => {
  it('with the guard off (test seam), the watchdog still records an off-list navigation hop as fatal', async () => {
    // A navigation hop: for a cross-origin fetch hop Playwright sometimes emits no request event on Linux, which is the gap
    // the guard closes, so the watchdog alone cannot be relied on there.
    await withSession(LOCAL, policy(), async (s) => {
      await s.page.goto(hop(offUrl('/watchdog'))).catch(() => undefined);
      await expect.poll(() => offViolations(s)).toEqual([expect.objectContaining({ kind: 'host', fatal: true })]);
      await expect.poll(() => s.closed).toBe(true);
    }, { redirectGuard: false });
  });
});
