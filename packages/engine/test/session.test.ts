import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { chromium, type BrowserServer } from 'playwright-core';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import {
  BrowserUnavailableError, checkRequest, CONNECT_TIMEOUT_MS, localLaunchArgs, openSession, PLAYWRIGHT_VERSION, PrivateNetworkError, violationMessage,
} from '../src/browser/session.js';
import { createWindow, FILL_AND_SUBMIT, submitTargetRule } from '../src/browser/window.js';
import { browserUnreachable, browserVersionMismatch, CHROMIUM_MISSING, ENDPOINT_NOT_SECURE, offListSite, privateAddress, tokenRefused } from '../src/messages.js';
import { createGate, MIN_TOKEN_LENGTH } from 'n8n-rpa-gate';
import { defaultResolveHost } from '../src/browser/address.js';
import { noWritePolicy } from '../src/policy/derive.js';
import { PolicyError } from '../src/steps/errors.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint, PortalPolicy } from '../src/types.js';
import { LOCAL, policyFor } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
const masker = createMasker([]);

describe('checkRequest', () => {
  const policy = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
  it('allows listed hosts and login writes; an allowed submission passes only through its step window', () => {
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/home', method: 'GET', isNavigation: true })).toBeNull();
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/login', method: 'POST', isNavigation: true })).toBeNull();
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/reports/export', method: 'POST', isNavigation: true })).toMatchObject({ kind: 'write', method: 'POST' });
    expect(checkRequest(policy, { url: 'data:text/plain,hi', method: 'GET', isNavigation: false })).toBeNull();
  });
  it('is port-sensitive and blocks other writes', () => {
    expect(checkRequest(policy, { url: 'http://127.0.0.1:1/acme/home', method: 'GET', isNavigation: true })?.kind).toBe('host');
    expect(checkRequest(policy, { url: 'http://localhost:9999/acme/home', method: 'GET', isNavigation: true })?.kind).toBe('host');
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/notices/acknowledge', method: 'POST', isNavigation: true })).toMatchObject({ kind: 'write', method: 'POST' });
  });
  it("a step's window admits only its own allowed target; login POSTs always pass", () => {
    const exportUrl = 'http://127.0.0.1:9999/acme/reports/export';
    const exportTarget = { host: '127.0.0.1:9999', path: '/acme/reports/export', method: 'POST' };
    const opened = (target: typeof exportTarget) => {
      const w = createWindow(submitTargetRule(target));
      w.handle.open();
      return w;
    };
    expect(checkRequest(policy, { url: exportUrl, method: 'POST', isNavigation: true })).toMatchObject({ kind: 'write', method: 'POST' });
    const closed = createWindow(submitTargetRule(exportTarget));
    expect(closed.admit(policy, exportUrl, 'POST', undefined)).toBe(false);
    expect(opened(exportTarget).admit(policy, exportUrl, 'POST', undefined)).toBe(true);
    expect(opened({ ...exportTarget, method: 'post' }).admit(policy, exportUrl, 'post', undefined)).toBe(true);
    // Another target, or a target the policy does not list, never lets the form through.
    expect(opened({ ...exportTarget, path: '/acme/notices/acknowledge' }).admit(policy, exportUrl, 'POST', undefined)).toBe(false);
    const ackUrl = 'http://127.0.0.1:9999/acme/notices/acknowledge';
    expect(opened({ ...exportTarget, path: '/acme/notices/acknowledge' }).admit(policy, ackUrl, 'POST', undefined)).toBe(false);
    // The same rule in a sub-frame on a navigation host; never from a frame elsewhere.
    expect(opened(exportTarget).admit(policy, exportUrl, 'POST', { isMain: false, url: 'http://127.0.0.1:9999/acme/reports' })).toBe(true);
    expect(opened(exportTarget).admit(policy, exportUrl, 'POST', { isMain: false, url: 'https://widget.example/w' })).toBe(false);
    // At most 3, and closed means closed.
    const w = opened(exportTarget);
    expect([1, 2, 3, 4].map(() => w.admit(policy, exportUrl, 'POST', undefined))).toEqual([true, true, true, false]);
    w.handle.close();
    w.handle.open();
    expect(w.handle.isOpen).toBe(false);
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/login', method: 'POST', isNavigation: true })).toBeNull();
  });
  it('the Fill and Submit window admits POSTs to its hosts from a known main frame only, at most maxPosts (capped at 3)', () => {
    const url = 'http://127.0.0.1:9999/acme/notices/acknowledge';
    const main = { isMain: true, url: 'http://127.0.0.1:9999/acme/home' };
    const fill = (maxPosts: number) => {
      const w = createWindow(FILL_AND_SUBMIT);
      w.handle.open();
      return { w, p: { ...policy, writeWindow: { step: 0, maxPosts: maxPosts as 3, hosts: ['127.0.0.1:9999'] } } };
    };
    const { w, p } = fill(3);
    expect(w.admit(policy, url, 'POST', main)).toBe(false); // no writeWindow in the policy now
    expect(w.admit(p, url, 'PUT', main)).toBe(false);
    expect(w.admit(p, url, 'POST', undefined)).toBe(false);
    expect(w.admit(p, url, 'POST', { isMain: false, url: main.url })).toBe(false);
    expect(w.admit(p, url, 'POST', main)).toBe(true);
    expect(w.handle.posts).toEqual([{ method: 'POST', host: '127.0.0.1:9999', path: '/acme/notices/acknowledge' }]);
    for (const [max, admitted] of [[1, 1], [0, 0], [99, 3], [Number.NaN, 3]]) {
      const f = fill(max);
      expect([1, 2, 3, 4].filter(() => f.w.admit(f.p, url, 'POST', main))).toHaveLength(admitted);
    }
  });
  it('uses subresourceHosts only for non-navigation requests', () => {
    const p = { ...policy, subresourceHosts: ['cdn.example'] };
    expect(checkRequest(p, { url: 'https://cdn.example/a.js', method: 'GET', isNavigation: false })).toBeNull();
    expect(checkRequest(p, { url: 'https://cdn.example/', method: 'GET', isNavigation: true })?.kind).toBe('host');
  });
});

describe('checkRequest login writes and localLaunchArgs', () => {
  const policy = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
  it('allows only POST to a login path', () => {
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/login', method: 'PUT', isNavigation: true })).toMatchObject({ kind: 'write', method: 'PUT' });
  });
  it('pins every allowed hostname to its checked address, then refuses every other name', () => {
    const p = { ...policy, navHosts: ['127.0.0.1:9999', '127.0.0.1:8000'], subresourceHosts: ['cdn.example', 'cdn.example:8443'] };
    const pins = new Map([['127.0.0.1', '127.0.0.1'], ['cdn.example', '93.184.215.14'], ['not-listed.example', '93.184.215.15']]);
    const args = localLaunchArgs(p, pins);
    const rule = args.find((a) => a.startsWith('--host-resolver-rules='));
    expect(rule).toBe('--host-resolver-rules=MAP 127.0.0.1 127.0.0.1, MAP cdn.example 93.184.215.14, MAP * ~NOTFOUND');
    expect(rule).not.toMatch(/EXCLUDE/);
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args).toContain('--dns-prefetch-disable');
    expect(args.some((a) => a.startsWith('--disable-features'))).toBe(false);
  });
  it('maps a pinned public name exactly as resolved', () => {
    const p = { ...policy, startUrl: 'https://example.com/', navHosts: ['example.com'] };
    expect(localLaunchArgs(p, new Map([['example.com', '93.184.215.14']]))).toContain('--host-resolver-rules=MAP example.com 93.184.215.14, MAP * ~NOTFOUND');
  });
});

describe('localLaunchArgs ipv6', () => {
  it('pins IPv6 hosts without brackets and maps them to a bracketed address', () => {
    const policy = policyFor({ url: 'http://x', host: 'x' });
    const rule = localLaunchArgs({ ...policy, navHosts: ['[::1]:8080'], subresourceHosts: [] }, new Map([['::1', '::1']]))
      .find((a) => a.startsWith('--host-resolver-rules='));
    expect(rule).toBe('--host-resolver-rules=MAP ::1 [::1], MAP * ~NOTFOUND');
  });
});

describe('openSession (local)', () => {
  it('navigates to allowed pages', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      const r = await s.page.goto(`${portal.url}/acme/login`);
      expect(r?.status()).toBe(200);
      expect(s.violations).toEqual([]);
    } finally { await s.close(); }
  });
  it('blocks and records navigation to an off-list host', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await expect(s.page.goto(`http://localhost:${portal.port}/acme/login`)).rejects.toThrow();
      expect(s.violations[0]).toMatchObject({ kind: 'host', fatal: true });
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('kills the session on a redirect to an off-list host', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/p/redirect-out`).catch(() => undefined);
      // Either the route handler aborts the hop or the redirect watchdog kills the session; both are fatal.
      await expect.poll(() => s.violations.some((v) => v.fatal && v.url.includes('localhost'))).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('kills the session when a sub-request redirects off-list', async () => {
    // The hop goes to an off-list port that listens, so the browser sends it: that is the hop the watchdog is for.
    const off = createHttpServer((_q, res) => { res.end('x'); });
    await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
    const port = (off.address() as { port: number }).port;
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate((u) => fetch(u).catch(() => null), `${portal.url}/acme/p/redirect-sub?port=${port}`).catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.fatal && v.kind === 'host' && v.url.startsWith(`http://127.0.0.1:${port}/`))).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
      expect(s.closeReason).toBe('violation');
    } finally { await s.close(); off.closeAllConnections(); await new Promise((r) => off.close(r)); }
  });
  it('records why the session closed: first reason wins, disconnect marks it closed', async () => {
    const a = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    expect(a.closeReason).toBeNull();
    await a.close('budget');
    await a.close('caller');
    expect(a.closed).toBe(true);
    expect(a.closeReason).toBe('budget');
    const b = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await b.browser.close();
      await expect.poll(() => b.closed).toBe(true);
      expect(b.closeReason).toBe('disconnected');
    } finally { await b.close(); }
  });
  it('blocks a disallowed POST as a fatal write violation', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate((u) => fetch(u, { method: 'POST' }).catch(() => null), `${portal.url}/acme/notices/acknowledge`).catch(() => undefined);
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('records an off-list subresource as non-fatal and keeps the session open', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate((u) => { const i = document.createElement('img'); i.src = u; document.body.append(i); }, `http://localhost:${portal.port}/x.png`);
      await expect.poll(() => s.violations.some((v) => v.kind === 'host' && !v.fatal)).toBe(true);
      expect(s.closed).toBe(false);
    } finally { await s.close(); }
  });
  it('closes websockets and records them as non-fatal', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/p/ws`);
      await expect.poll(() => s.violations.some((v) => v.kind === 'websocket' && !v.fatal)).toBe(true);
    } finally { await s.close(); }
  });
});

describe('openSession (remote modes)', () => {
  it('refuses non-wss remote endpoints', async () => {
    await expect(openSession({ endpoint: { mode: 'playwright', wsUrl: 'ws://browser.example:3000/' }, policy: policyFor(portal), masker }))
      .rejects.toThrow(ENDPOINT_NOT_SECURE);
  });
  it('masks a URL-embedded token when the endpoint rejects the connection', async () => {
    const srv = createHttpServer((_q, res) => { res.statusCode = 401; res.end('nope'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const err = await openSession({ endpoint: { mode: 'cdp', wsUrl: `http://127.0.0.1:${port}/?token=SEKRET-TOKEN` }, policy: policyFor(portal), masker })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).not.toContain('SEKRET-TOKEN');
      const err2 = await openSession({ endpoint: { mode: 'cdp', wsUrl: `http://127.0.0.1:${port}/SEKRET-TOKEN/x`, token: 'SEKRET-TOKEN' }, policy: policyFor(portal), masker })
        .catch((e: Error) => e);
      expect(err2).toBeInstanceOf(BrowserUnavailableError);
      expect((err2 as Error).message).not.toContain('SEKRET-TOKEN');
    } finally { await new Promise((r) => srv.close(r)); }
  });
  it('masks the token in connection errors', async () => {
    const m = createMasker(['SEKRET-TOKEN']);
    const err = await openSession({ endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/?token=SEKRET-TOKEN', token: 'SEKRET-TOKEN' }, policy: policyFor(portal), masker: m })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect(String((err as Error).message)).not.toContain('SEKRET-TOKEN');
  });
  it('connects over the Playwright protocol', async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const s = await openSession({ endpoint: { mode: 'playwright', wsUrl: server.wsEndpoint() }, policy: policyFor(portal), masker });
      try { expect((await s.page.goto(`${portal.url}/acme/login`))?.status()).toBe(200); } finally { await s.close(); }
    } finally { await server.close(); }
  });
  it('waits Slow Motion before each browser action (for watching a run in a live view)', async () => {
    const s = await openSession({ endpoint: { ...LOCAL, slowMo: 300 }, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const t0 = Date.now();
      await s.page.fill('#username', 'a');
      await s.page.fill('#password', 'b');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    } finally { await s.close(); }
  });
  it('connects over CDP', async () => {
    const port = await new Promise<number>((resolve) => { const srv = createServer().listen(0, () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); }); });
    const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    try {
      const s = await openSession({ endpoint: { mode: 'cdp', wsUrl: `http://127.0.0.1:${port}` }, policy: policyFor(portal), masker });
      try { expect((await s.page.goto(`${portal.url}/acme/login`))?.status()).toBe(200); } finally { await s.close(); }
    } finally { await browser.close(); }
  });
});

describe('checkRequest frames', () => {
  const base = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
  const policy = { ...base, frameHosts: ['widget.example'] };
  const widget = { isMain: false, url: 'https://widget.example/w' };
  it('lets sub-frames load from and post to frame hosts', () => {
    expect(checkRequest(policy, { url: 'https://widget.example/w', method: 'GET', isNavigation: true, frame: { isMain: false, url: '' } })).toBeNull();
    expect(checkRequest(policy, { url: 'https://widget.example/api', method: 'POST', isNavigation: false, frame: widget })).toBeNull();
  });
  it('never lets the main frame navigate to or post to a frame host', () => {
    expect(checkRequest(policy, { url: 'https://widget.example/w', method: 'GET', isNavigation: true, frame: { isMain: true, url: 'http://127.0.0.1:9999/acme/login' } })?.kind).toBe('host');
    expect(checkRequest(policy, { url: 'https://widget.example/api', method: 'POST', isNavigation: false })?.kind).toBe('host');
  });
  it('refuses sub-frame writes outside the frame-host and nav-host rules', () => {
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/notices/acknowledge', method: 'POST', isNavigation: false, frame: widget })).toMatchObject({ kind: 'write', method: 'POST' });
    expect(checkRequest(policy, { url: 'https://widget.example/api', method: 'POST', isNavigation: false, frame: { isMain: false, url: 'http://127.0.0.1:9999/acme/x' } })).toMatchObject({ kind: 'write' });
    expect(checkRequest(base, { url: 'https://widget.example/w', method: 'GET', isNavigation: true, frame: { isMain: false, url: '' } })?.kind).toBe('host');
  });
  it("allows a same-origin iframe on a nav host to post to an allowed submit through its step's window, but not elsewhere", () => {
    const portalFrame = { isMain: false, url: 'http://127.0.0.1:9999/acme/p/frame' };
    const exportUrl = 'http://127.0.0.1:9999/acme/reports/export';
    const step = createWindow(submitTargetRule({ host: '127.0.0.1:9999', path: '/acme/reports/export', method: 'POST' }));
    step.handle.open();
    expect(checkRequest(policy, { url: exportUrl, method: 'POST', isNavigation: false, frame: portalFrame })).toMatchObject({ kind: 'write' });
    expect(step.admit(policy, exportUrl, 'POST', portalFrame)).toBe(true);
    expect(step.admit(policy, exportUrl, 'POST', widget)).toBe(false);
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/acme/notices/acknowledge', method: 'POST', isNavigation: false, frame: portalFrame })).toMatchObject({ kind: 'write' });
    expect(step.admit(policy, 'http://127.0.0.1:9999/acme/notices/acknowledge', 'POST', portalFrame)).toBe(false);
  });
  it('pins frame hosts too', () => {
    const pins = new Map([['127.0.0.1', '127.0.0.1'], ['widget.example', '93.184.215.20']]);
    expect(localLaunchArgs(policy, pins).find((a) => a.startsWith('--host-resolver-rules=')))
      .toBe('--host-resolver-rules=MAP 127.0.0.1 127.0.0.1, MAP widget.example 93.184.215.20, MAP * ~NOTFOUND');
  });
});

describe('checkRequest read-only POSTs', () => {
  const host = '127.0.0.1:9999';
  const policy = { ...policyFor({ url: `http://${host}`, host }), frameHosts: ['widget.example'], readPosts: [{ host, path: '/sap*/bc/gui/sap/its/webgui' }] };
  const gui = `http://${host}/sap(abc)/bc/gui/sap/its/webgui`;
  it('only POST to the listed host and path is a read', () => {
    expect(checkRequest(policy, { url: gui, method: 'POST', isNavigation: false })).toBeNull();
    expect(checkRequest(policy, { url: gui, method: 'POST', isNavigation: true })).toBeNull();
    expect(checkRequest(policy, { url: gui, method: 'PUT', isNavigation: false })).toMatchObject({ kind: 'write' });
    expect(checkRequest(policy, { url: gui, method: 'DELETE', isNavigation: false })).toMatchObject({ kind: 'write' });
    expect(checkRequest({ ...policy, navHosts: [host, '127.0.0.1:9998'] }, { url: 'http://127.0.0.1:9998/sap(abc)/bc/gui/sap/its/webgui', method: 'POST', isNavigation: false })).toMatchObject({ kind: 'write' });
    expect(checkRequest(policy, { url: `http://${host}/acme/notices/acknowledge`, method: 'POST', isNavigation: false })).toMatchObject({ kind: 'write' });
  });
  it('a read from a sub-frame on a nav host passes; from a frame host it does not', () => {
    expect(checkRequest(policy, { url: gui, method: 'POST', isNavigation: false, frame: { isMain: false, url: `http://${host}/acme/p/frame` } })).toBeNull();
    expect(checkRequest(policy, { url: gui, method: 'POST', isNavigation: false, frame: { isMain: false, url: 'https://widget.example/w' } })).toMatchObject({ kind: 'write' });
  });
});

describe('openSession read-only POSTs', () => {
  it('a read-only POST is let through and not counted', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), readPosts: SANDBOX.erp.readPosts(portal.host) };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.getByLabel('Dealer user ID').fill(SANDBOX.username);
      await s.page.getByLabel('Password').fill(SANDBOX.password);
      await s.page.getByRole('button', { name: 'Sign in' }).click();
      await s.page.waitForURL(/\/acme\/(?!login)/);
      const before = s.writesSent;
      await s.page.goto(`${portal.url}${SANDBOX.erp.webguiPath}`);
      await s.page.getByRole('button', { name: 'Line Item Report' }).click();
      await s.page.getByRole('heading', { name: 'Line Item Report' }).waitFor();
      expect(s.writesSent).toBe(before);
      expect(s.writesSent).toBe(0);
      expect([...s.readPostsUsed]).toEqual([`POST ${portal.host}/sap*/bc/gui/sap/its/webgui`]);
      expect(s.violations).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('openSession refuses an invalid read-only list (defence in depth)', () => {
  it('a too-broad or malformed entry never opens a browser', async () => {
    const open = (readPosts: unknown) => openSession({ endpoint: { mode: 'playwright', wsUrl: 'ws://never.invalid/' }, policy: { ...policyFor(portal), readPosts } as PortalPolicy, masker });
    await expect(open([{ host: portal.host, path: '/*' }])).rejects.toThrow(`Read-only request "POST ${portal.host}/*" must name at least one part of the path besides *`);
    await expect(open([{ host: portal.host, path: '/*' }])).rejects.toBeInstanceOf(PolicyError);
    await expect(open([{ host: portal.host, path: '/a/**' }])).rejects.toThrow('use a single * (it never matches /)');
    await expect(open([{ host: 42, path: '/x' }])).rejects.toThrow('Read-only request 1 must have a host and a path starting with /');
  });
});

describe('openSession blocked requests on session-shaped paths', () => {
  it('blockedRequests masks the session id in the path', async () => {
    portal.reset();
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), writeMode: 'block' }, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate(() => fetch('/sap(cz1TSUQ6QU5PTjoxMjM0NTY3OA%3D%3D)/bc/gui/sap/its/webgui', { method: 'POST' }).catch(() => undefined));
      await expect.poll(() => s.blockedRequests).toEqual([{ method: 'POST', host: portal.host, path: '/sap(…)/bc/gui/sap/its/webgui' }]);
    } finally { await s.close(); }
  });
});

describe('openSession read-only POSTs and redirects', () => {
  const signIn = async (s: Awaited<ReturnType<typeof openSession>>) => {
    await s.page.goto(`${portal.url}/acme/login`);
    await s.page.getByLabel('Dealer user ID').fill(SANDBOX.username);
    await s.page.getByLabel('Password').fill(SANDBOX.password);
    await s.page.getByRole('button', { name: 'Sign in' }).click();
    await s.page.waitForURL(/\/acme\/(?!login)/);
  };
  it('a listed read that 307s to an unlisted path is a fatal policy violation', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), readPosts: [{ host: portal.host, path: '/sap/test/redirect' }] };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await signIn(s);
      await s.page.goto(`${portal.url}/sap/test/redirect-form?to=${encodeURIComponent('/acme/notices/acknowledge')}`);
      await s.page.getByRole('button', { name: 'Send' }).click().catch(() => undefined);
      await expect.poll(() => s.closed).toBe(true);
      expect(s.closeReason).toBe('violation');
      expect(s.violations.some((v) => v.kind === 'write')).toBe(true);
    } finally { await s.close(); }
  });
  it('a request that 307s to a listed read path is not counted and takes no window slot', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), readPosts: [{ host: portal.host, path: '/sap/test/redirect' }, { host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }], writeWindow: { step: 0, maxPosts: 3 as const, hosts: [portal.host] } };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await signIn(s);
      s.writeWindow?.open();
      await s.page.goto(`${portal.url}/sap/test/redirect-form?to=${encodeURIComponent('/sap(zz)/bc/gui/sap/its/webgui')}`);
      await s.page.getByRole('button', { name: 'Send' }).click();
      await s.page.waitForURL(/webgui/);
      expect(s.writesSent).toBe(0);
      expect(s.violations).toEqual([]);
      expect(s.writeWindow?.posts).toEqual([]);
      expect([...s.readPostsUsed]).toEqual([`POST ${portal.host}/sap/test/redirect`, `POST ${portal.host}/sap*/bc/gui/sap/its/webgui`]);
    } finally { await s.close(); }
  });
  it('readPostsUsed holds at most 100 labels', async () => {
    portal.reset();
    const readPosts = Array.from({ length: 120 }, (_, i) => ({ host: portal.host, path: `/sap/t/n${i}` }));
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), readPosts }, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate(async () => { for (let i = 0; i < 120; i++) await fetch(`/sap/t/n${i}`, { method: 'POST' }); });
      expect(s.writesSent).toBe(0);
      expect(s.readPostsUsed.size).toBe(100);
    } finally { await s.close(); }
  });
  it('a frame-host frame POST to a host that is also a nav host with a read entry counts as a write', async () => {
    portal.reset();
    const other = `localhost:${portal.port}`;
    const policy = { ...policyFor(portal), navHosts: [portal.host, other], frameHosts: [other], readPosts: [{ host: other, path: '/acme/p/widget' }] };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/p/frame`);
      await expect.poll(() => s.page.frameLocator('#widget-frame').locator('#widget').textContent()).toBe('widget posted');
      expect(s.writesSent).toBe(1);
      expect([...s.readPostsUsed]).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('openSession frames and navigations', () => {
  it('loads a listed iframe widget and lets it post to itself', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), frameHosts: [`localhost:${portal.port}`] };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/p/frame`);
      await expect.poll(() => s.page.frameLocator('#widget-frame').locator('#widget').textContent()).toBe('widget posted');
      expect(s.violations).toEqual([]);
      expect(portal.state().widgetPosts).toBe(1);
    } finally { await s.close(); }
  });
  it('blocks an unlisted iframe without ending the run', async () => {
    portal.reset();
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/p/frame`);
      await expect.poll(() => s.violations.some((v) => v.kind === 'host' && !v.fatal && v.url.includes('localhost'))).toBe(true);
      expect(s.closed).toBe(false);
      expect(portal.state().widgetPosts).toBe(0);
    } finally { await s.close(); }
  });
  it('never treats a frame host as a top-level navigation target', async () => {
    const policy = { ...policyFor(portal), frameHosts: [`localhost:${portal.port}`] };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await expect(s.page.goto(`http://localhost:${portal.port}/acme/p/widget`)).rejects.toThrow();
      expect(s.violations[0]).toMatchObject({ kind: 'host', fatal: true });
    } finally { await s.close(); }
  });
  it('records main-frame navigations once each, in order, including popups', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.goto(`${portal.url}/acme/p/frame`);
      await s.page.goto(`${portal.url}/acme/login?error=1`);
      const [popup] = await Promise.all([
        s.context.waitForEvent('page'),
        s.page.evaluate((u) => { window.open(u); }, `${portal.url}/acme/p/ws`),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      await expect.poll(() => s.navigations.size).toBe(3);
      expect([...s.navigations]).toEqual([`${portal.url}/acme/login`, `${portal.url}/acme/p/frame`, `${portal.url}/acme/p/ws`]);
    } finally { await s.close(); }
  });
  it('ignores history.pushState paths in navigations', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate(() => history.pushState({}, '', '/acme/notices/delete-all'));
      expect([...s.navigations]).toEqual([`${portal.url}/acme/login`]);
    } finally { await s.close(); }
  });
  it('keeps at most 500 distinct navigations', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      for (let i = 0; i < 505; i++) await s.page.goto(`${portal.url}/public/nav-${i}`, { waitUntil: 'commit' });
      await expect.poll(() => s.navigations.size).toBe(500);
      expect([...s.navigations][0]).toBe(`${portal.url}/public/nav-0`);
      expect(s.navigations.has(`${portal.url}/public/nav-500`)).toBe(false);
    } finally { await s.close(); }
  }, 60_000);
  it('attributes requests to their frame: a frame-host POST is allowed from a sub-frame and blocked from the main frame', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), frameHosts: [`localhost:${portal.port}`] };
    const s = await openSession({ endpoint: LOCAL, policy, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/p/frame`);
      await expect.poll(() => portal.state().widgetPosts).toBe(1);
      expect(s.violations).toEqual([]);
      // The same POST from the main frame is a host violation (frame hosts are not main-frame targets).
      await s.page.evaluate((u) => fetch(u, { method: 'POST' }).then(() => undefined, () => undefined), `http://localhost:${portal.port}/acme/p/widget`);
      expect(s.violations.some((v) => v.kind === 'host' && v.url.includes('localhost'))).toBe(true);
      expect(portal.state().widgetPosts).toBe(1);
    } finally { await s.close(); }
  });
  it('lets a same-origin iframe post to an allowed submit without a violation', async () => {
    portal.reset();
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      s.armSubmit({ host: portal.host, path: '/acme/reports/export', method: 'POST' });
      await s.page.evaluate(() => { const f = document.createElement('iframe'); f.src = '/acme/login'; document.body.append(f); });
      await expect.poll(() => s.page.frames().length).toBe(2);
      const child = s.page.frames().find((f) => f !== s.page.mainFrame())!;
      await child.waitForLoadState('domcontentloaded');
      await child.evaluate(() => fetch('/acme/reports/export', { method: 'POST' }).then(() => undefined, () => undefined));
      expect(s.violations).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('private network block', () => {
  let server: BrowserServer;
  let remote: BrowserEndpoint;
  beforeAll(async () => { server = await chromium.launchServer({ headless: true }); remote = { mode: 'playwright', wsUrl: server.wsEndpoint() }; });
  afterAll(async () => { await server.close(); });
  const table = () => `${portal.url}/public/table`;
  /** The engine default: no allowPrivateNetwork key at all. */
  const withoutOptIn = (over: Partial<PortalPolicy> = {}): PortalPolicy => {
    const { allowPrivateNetwork: _drop, ...rest } = policyFor(portal);
    return { ...rest, startUrl: table(), ...over };
  };

  it('local: without the opt-in the loopback start host is refused before the browser starts', async () => {
    const err = await openSession({ endpoint: LOCAL, policy: withoutOptIn(), masker }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PrivateNetworkError);
    expect((err as Error).message).toBe(privateAddress(portal.host));
  });
  it('remote: without the opt-in a navigation to a loopback literal is a fatal private violation', async () => {
    const policy = withoutOptIn();
    const s = await openSession({ endpoint: remote, policy, masker });
    try {
      await expect(s.page.goto(table())).rejects.toThrow();
      expect(s.violations[0]).toMatchObject({ kind: 'private', host: portal.host, fatal: true });
      expect(violationMessage(s.violations[0], policy)).toBe(privateAddress(portal.host));
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('with the opt-in the same page loads, locally and remotely', async () => {
    for (const endpoint of [LOCAL, remote]) {
      const s = await openSession({ endpoint, policy: { ...policyFor(portal), startUrl: table() }, masker });
      try {
        expect((await s.page.goto(table()))?.status()).toBe(200);
        await s.idle();
        expect(s.violations).toEqual([]);
      } finally { await s.close(); }
    }
  });
  it('a name that resolves to a private address is refused before any request', async () => {
    const resolveHost = vi.fn(async (h: string) => (h === 'example.test' ? ['10.0.0.5'] : []));
    const policy = withoutOptIn({ startUrl: 'http://example.test/', navHosts: ['example.test'] });
    const err = await openSession({ endpoint: LOCAL, policy, masker, resolveHost }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PrivateNetworkError);
    expect((err as Error).message).toBe(privateAddress('example.test'));
    const s = await openSession({ endpoint: remote, policy, masker, resolveHost });
    try {
      await expect(s.page.goto('http://example.test/')).rejects.toThrow();
      expect(s.violations[0]).toMatchObject({ kind: 'private', host: 'example.test', url: 'http://example.test/', fatal: true });
    } finally { await s.close(); }
    expect(resolveHost).toHaveBeenCalledWith('example.test');
  });
  it('the opt-in never reaches sub-resource hosts', async () => {
    const resolveHost = async (h: string) => (h === 'cdn.test' ? ['10.0.0.7'] : []);
    const err = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), subresourceHosts: ['cdn.test'] }, masker, resolveHost })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(PrivateNetworkError);
    expect((err as Error).message).toBe(privateAddress('cdn.test'));
  });
  it('a redirect hop to an allowlisted name that resolves privately is fatal', async () => {
    // Through the seams 127.0.0.1 counts as public and localhost resolves to 10.0.0.5.
    const isPrivate = (ip: string) => ip.startsWith('10.');
    const resolveHost = async (h: string) => (h === 'localhost' ? ['10.0.0.5'] : []);
    const other = `localhost:${portal.port}`;
    const s = await openSession({ endpoint: remote, policy: withoutOptIn({ navHosts: [portal.host, other] }), masker, resolveHost, isPrivate });
    try {
      await s.page.goto(`${portal.url}/public/redirect?to=${encodeURIComponent(`http://${other}/public/table`)}`).catch(() => undefined);
      await s.idle();
      await expect.poll(() => s.violations.some((v) => v.kind === 'private' && v.fatal && v.host === other)).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('a redirect hop to a host that is not on the allowlist is fatal (the host rule comes first)', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try {
      await s.page.goto(`${portal.url}/public/redirect?to=${encodeURIComponent(`http://localhost:${portal.port}/public/table`)}`).catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.kind === 'host' && v.fatal && v.url.includes('localhost'))).toBe(true);
    } finally { await s.close(); }
  });
  it('the server address is checked: a name that resolved public but connected to loopback is fatal (rebinding)', async () => {
    const other = `localhost:${portal.port}`;
    const policy = withoutOptIn({ startUrl: `http://${other}/public/table`, navHosts: [other] });
    const s = await openSession({ endpoint: remote, policy, masker, resolveHost: async () => ['93.184.215.14'] });
    try {
      await s.page.goto(`http://${other}/public/table`).catch(() => undefined);
      await s.idle();
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'private', host: other, fatal: true }));
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('remote: a private sub-resource is aborted and logged as non-fatal, and the session stays open', async () => {
    // Both names resolve to 10.0.0.7 through the seam. localhost would really reach the sandbox if the request were sent.
    const resolveHost = async (h: string) => (h === 'cdn.test' || h === 'localhost' ? ['10.0.0.7'] : []);
    const local = `localhost:${portal.port}`;
    const policy = { ...policyFor(portal), startUrl: table(), subresourceHosts: ['cdn.test', local] };
    const hits = async () => ((await (await fetch(`${portal.url}/public/api/counters`)).json()) as { hits: Record<string, number> }).hits;
    const s = await openSession({ endpoint: remote, policy, masker, resolveHost });
    try {
      const failed: string[] = [];
      s.page.on('requestfailed', (r) => failed.push(`${new URL(r.url()).host} ${r.failure()?.errorText ?? ''}`));
      expect((await s.page.goto(table()))?.status()).toBe(200);
      const before = (await hits())['/public/table-edge'] ?? 0;
      await s.page.evaluate(async (urls) => {
        for (const u of urls) await fetch(u, { mode: 'no-cors' }).catch(() => undefined);
      }, ['http://cdn.test/lib.js', `http://${local}/public/table-edge`]);
      await s.idle();
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'private', host: 'cdn.test', fatal: false }));
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'private', host: local, fatal: false }));
      expect(s.violations.some((v) => v.fatal)).toBe(false);
      expect(s.closed).toBe(false);
      // Aborted by the guard before any connection: the sandbox never saw the request.
      expect((await hits())['/public/table-edge'] ?? 0).toBe(before);
      expect(failed).toHaveLength(2);
      expect(failed[0]).toMatch(/^cdn\.test net::ERR_BLOCKED_BY_CLIENT/);
      expect(failed[1].startsWith(`${local} net::ERR_BLOCKED_BY_CLIENT`)).toBe(true);
    } finally { await s.close(); }
  });
  it('a failing address check fails closed: a main-frame navigation is a fatal violation', async () => {
    const isPrivate = () => { throw new Error('classifier broke'); };
    const policy = { ...policyFor(portal), startUrl: table() };
    const s = await openSession({ endpoint: remote, policy, masker, isPrivate });
    try {
      await expect(s.page.goto(table())).rejects.toThrow();
      expect(s.violations[0]).toMatchObject({ kind: 'private', host: portal.host, fatal: true });
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('a failing address check on a redirect hop is fatal', async () => {
    const other = `localhost:${portal.port}`;
    // 127.0.0.1 passes; the classifier throws for the address localhost resolves to.
    const isPrivate = (ip: string) => { if (ip === '10.9.9.9') throw new Error('classifier broke'); return false; };
    const resolveHost = async (h: string) => (h === 'localhost' ? ['10.9.9.9'] : []);
    const s = await openSession({ endpoint: remote, policy: withoutOptIn({ navHosts: [portal.host, other] }), masker, resolveHost, isPrivate });
    try {
      await s.page.goto(`${portal.url}/public/redirect?to=${encodeURIComponent(`http://${other}/public/table`)}`).catch(() => undefined);
      await s.idle();
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'private', host: other, fatal: true }));
      await expect.poll(() => s.closed).toBe(true);
    } finally { await s.close(); }
  });
  it('an off-list main-frame navigation gets the golden off-list message', async () => {
    const policy = policyFor(portal);
    const s = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await expect(s.page.goto(`http://localhost:${portal.port}/public/table`)).rejects.toThrow();
      expect(violationMessage(s.violations[0], policy)).toBe(offListSite(`localhost:${portal.port}`, [portal.host]));
    } finally { await s.close(); }
  });
});

describe('browser endpoint rules and golden connect errors', () => {
  const docker = async (h: string) => (h === 'browser' || h === 'h' ? ['172.18.0.3'] : []);
  it('plain ws:// to a private-network host needs Private Network Endpoint and a token', async () => {
    const base = { mode: 'playwright' as const, wsUrl: 'ws://browser:3000/' };
    for (const endpoint of [base, { ...base, privateNetwork: true }, { ...base, token: 'tok-123456' }]) {
      const err = await openSession({ endpoint, policy: policyFor(portal), masker, resolveHost: docker }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(ENDPOINT_NOT_SECURE);
    }
    const accepted = await openSession({ endpoint: { ...base, privateNetwork: true, token: 'tok-123456' }, policy: policyFor(portal), masker, resolveHost: docker })
      .catch((e: Error) => e);
    expect(accepted).toBeInstanceOf(BrowserUnavailableError);
    expect((accepted as Error).message).toBe(browserUnreachable('ws://browser:3000/'));
    expect((accepted as Error).message).toBe(
      'Could not connect to the browser server at ws://browser:3000/. Is it running? Start it with: docker compose up -d browser (README: Where the browser runs).');
  });
  it('a compose browser that is stopped (its name does not resolve) gets the golden unreachable message', async () => {
    const endpoint = { mode: 'playwright' as const, wsUrl: 'ws://browser:3000/?x=1', privateNetwork: true, token: 'tok-123456' };
    const notFound = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND browser'), { code: 'ENOTFOUND' }); };
    const tryAgain = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN browser'), { code: 'EAI_AGAIN' }); };
    for (const resolveHost of [notFound, tryAgain, async () => [] as string[]]) {
      const err = await openSession({ endpoint, policy: policyFor(portal), masker, resolveHost }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(browserUnreachable('ws://browser:3000/'));
    }
    // Without the opt-in or the token the rule is unchanged: plain ws:// to a non-local name is refused as not secure.
    for (const e of [{ ...endpoint, privateNetwork: false }, { ...endpoint, token: undefined }]) {
      const err = await openSession({ endpoint: e, policy: policyFor(portal), masker, resolveHost: notFound }).catch((x: Error) => x);
      expect((err as Error).message).toBe(ENDPOINT_NOT_SECURE);
    }
    // Any other lookup failure is not read as "stopped".
    const other = async () => { throw Object.assign(new Error('boom'), { code: 'ESERVFAIL' }); };
    const err = await openSession({ endpoint, policy: policyFor(portal), masker, resolveHost: other }).catch((x: Error) => x);
    expect((err as Error).message).toBe(ENDPOINT_NOT_SECURE);
  });
  it('a public host on plain ws:// is refused even with the opt-in and a token', async () => {
    const err = await openSession({
      endpoint: { mode: 'playwright', wsUrl: 'ws://browser.example:3000/', privateNetwork: true, token: 'tok-123456' },
      policy: policyFor(portal), masker, resolveHost: async () => ['93.184.215.14'],
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(ENDPOINT_NOT_SECURE);
  });
  it('connection errors show the URL without its query string, userinfo or token', async () => {
    const m = createMasker(['tok-123456']);
    const err = await openSession({
      endpoint: { mode: 'playwright', wsUrl: 'ws://h:1/?token=abc', token: 'tok-123456', privateNetwork: true }, policy: policyFor(portal), masker: m, resolveHost: docker,
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(browserUnreachable('ws://h:1/'));
    expect((err as Error).message).not.toMatch(/abc|tok-123456|\?token/);
    const local = await openSession({ endpoint: { mode: 'playwright', wsUrl: 'ws://user:pw@127.0.0.1:1/x?y=1' }, policy: policyFor(portal), masker })
      .catch((e: Error) => e);
    expect((local as Error).message).toBe(browserUnreachable('ws://127.0.0.1:1/x'));
  });
  it('a token the gate refuses (401) gets the golden "refused the token" message', async () => {
    const gate = createGate({ token: 'g'.repeat(MIN_TOKEN_LENGTH), upstreamPort: 1, upstreamPath: `/${'a'.repeat(32)}` });
    await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
    try {
      const port = (gate.address() as { port: number }).port;
      const m = createMasker(['wrong-token-123456']);
      const err = await openSession({
        endpoint: { mode: 'playwright', wsUrl: `ws://someone:hunter22@127.0.0.1:${port}/pw?session=abc`, token: 'wrong-token-123456' }, policy: policyFor(portal), masker: m,
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(tokenRefused(`ws://127.0.0.1:${port}/pw`));
      expect((err as Error).message).toBe(`The browser server at ws://127.0.0.1:${port}/pw refused the token. Check the Token in the RPA Browser credential.`);
      expect((err as Error).message).not.toMatch(/abc|wrong-token|someone|hunter22/);
    } finally { await new Promise((r) => gate.close(r)); }
  });
  it('a 403 on the upgrade gets the same message', async () => {
    const srv = createHttpServer((_q, res) => { res.statusCode = 404; res.end(); });
    srv.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = (srv.address() as { port: number }).port;
      const err = await openSession({ endpoint: { mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/` }, policy: policyFor(portal), masker }).catch((e: Error) => e);
      expect((err as Error).message).toBe(tokenRefused(`ws://127.0.0.1:${port}/`));
    } finally { await new Promise((r) => srv.close(r)); }
  });
  it('a server on another Playwright version gets the golden mismatch message', async () => {
    const srv = createHttpServer((_q, res) => { res.statusCode = 404; res.end(); });
    srv.on('upgrade', (_req, socket) => {
      socket.end('HTTP/1.1 428 Precondition Required\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n'
        + 'Playwright version mismatch:\n  - server version: v1.62\n  - client version: v1.63\n');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const err = await openSession({ endpoint: { mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/` }, policy: policyFor(portal), masker }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(browserVersionMismatch('1.62', PLAYWRIGHT_VERSION));
      expect((err as Error).message).toBe('The browser server is version 1.62 but this node needs 1.63.0. Use image mcr.microsoft.com/playwright:v1.63.0.');
    } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  });
  it('a missing local Chromium gets the golden message', async () => {
    const spy = vi.spyOn(chromium, 'launch').mockRejectedValueOnce(
      new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome-linux/chrome"),
    );
    try {
      const err = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(CHROMIUM_MISSING);
    } finally { spy.mockRestore(); }
  });
  it('pins the Playwright version and the connect timeout', () => {
    const require = createRequire(import.meta.url);
    expect(PLAYWRIGHT_VERSION).toBe((require('playwright-core/package.json') as { version: string }).version);
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('checkRequest with the sub-resource wildcard', () => {
  const policy: PortalPolicy = { ...policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' }), subresourceHosts: '*' };
  it('admits any http(s) host for main-frame sub-resource reads', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(checkRequest(policy, { url: 'https://cdn.other.com/app.css', method, isNavigation: false })).toBeNull();
    }
  });
  it('never for navigations, main frame or sub-frame', () => {
    expect(checkRequest(policy, { url: 'https://cdn.other.com/', method: 'GET', isNavigation: true })?.kind).toBe('host');
    expect(checkRequest(policy, { url: 'https://ads.other.com/', method: 'GET', isNavigation: true, frame: { isMain: false, url: '' } })?.kind).toBe('host');
  });
  it('admits only safe methods: a non-GET to an unlisted host is an off-list request, a same-host write is still a write', () => {
    // '*' is "any host for GET sub-resources". A beacon to a third party is blocked and logged, never a write.
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(checkRequest(policy, { url: 'https://cdn.other.com/collect?u=1', method, isNavigation: false }))
        .toEqual({ kind: 'host', url: 'https://cdn.other.com/collect', method });
    }
    expect(checkRequest(policy, { url: 'https://cdn.other.com/collect', method: 'POST', isNavigation: false, frame: { isMain: false, url: 'http://127.0.0.1:9999/x' } })?.kind).toBe('host');
    // A write to a listed host stays a write.
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/x', method: 'PUT', isNavigation: false })).toMatchObject({ kind: 'write', method: 'PUT' });
    expect(checkRequest(policy, { url: 'http://127.0.0.1:9999/collect', method: 'POST', isNavigation: false })).toMatchObject({ kind: 'write', method: 'POST' });
  });
  it('sub-frames may read from any host', () => {
    expect(checkRequest(policy, { url: 'https://cdn.other.com/w.js', method: 'GET', isNavigation: false, frame: { isMain: false, url: 'http://127.0.0.1:9999/x' } })).toBeNull();
  });
  it('non-http(s) schemes are still refused and data: still passes', () => {
    expect(checkRequest(policy, { url: 'ftp://cdn.other.com/a', method: 'GET', isNavigation: false })?.kind).toBe('host');
    expect(checkRequest(policy, { url: 'data:text/plain,hi', method: 'GET', isNavigation: false })).toBeNull();
  });
  it("Local Browser never applies the '*' wildcard", () => {
    const p = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
    const pins = new Map([['127.0.0.1', '127.0.0.1'], ['cdn.other.test', '93.184.215.14']]);
    expect(localLaunchArgs({ ...p, subresourceHosts: '*' }, pins)).toEqual(localLaunchArgs({ ...p, subresourceHosts: [] }, pins));
    expect(localLaunchArgs({ ...p, subresourceHosts: '*' }, pins).join(' ')).not.toContain('cdn.other.test');
  });
});

describe('write modes, wildcard, restrict and viewport', () => {
  let server: BrowserServer;
  let remote: BrowserEndpoint;
  beforeAll(async () => { server = await chromium.launchServer({ headless: true }); remote = { mode: 'playwright', wsUrl: server.wsEndpoint() }; });
  afterAll(async () => { await server.close(); });
  const counters = async () => (await (await fetch(`${portal.url}/public/api/counters`)).json()) as { collect: number; css: number };
  // isPrivate: () => false makes localhost:<port> count as a second public host.
  // Names admitted only by '*' are resolved with c-ares, which never reads /etc/hosts: the seam stands in
  // for a public DNS answer for the second host.
  const resolveHost = async (h: string) => (h === 'localhost' ? ['127.0.0.1'] : defaultResolveHost(h));
  const open = (over: Partial<PortalPolicy>) => openSession({
    endpoint: remote, policy: { ...policyFor(portal), ...over }, masker, isPrivate: () => false, resolveHost,
  });

  it("block mode with '*': beacons, keepalive fetches and same-host POSTs are blocked and logged, and the run goes on", async () => {
    portal.reset();
    const other = `localhost:${portal.port}`;
    const s = await open({ writeMode: 'block', subresourceHosts: '*' });
    try {
      await s.page.goto(`${portal.url}/public/beacon`, { waitUntil: 'load' });
      // The beacon and the keepalive fetch hit the same method, host and path: one record (dedupe).
      await expect.poll(() => s.blockedRequests.length).toBe(2);
      expect(s.blockedRequests).toContainEqual({ method: 'POST', host: other, path: '/public/collect' });
      expect(s.blockedRequests).toContainEqual({ method: 'POST', host: portal.host, path: '/public/collect' });
      // The third-party beacon is an off-list request; the same-host POST is a blocked write.
      expect(s.violations.filter((v) => v.kind === 'write' && !v.fatal)).toEqual([expect.objectContaining({ url: `${portal.url}/public/collect` })]);
      expect(s.violations.filter((v) => v.kind === 'host' && !v.fatal)).toEqual([expect.objectContaining({ url: `http://${other}/public/collect` })]);
      expect(s.violations.some((v) => v.fatal)).toBe(false);
      expect(s.closed).toBe(false);
      expect((await counters()).collect).toBe(0);
    } finally { await s.close(); }
  });
  it("fatal mode with '*': a third-party beacon alone is blocked and logged, never fatal", async () => {
    portal.reset();
    const other = `localhost:${portal.port}`;
    const s = await open({ subresourceHosts: '*' });
    try {
      await s.page.goto(`${portal.url}/public/beacon-third-party`, { waitUntil: 'load' });
      await s.page.locator('#sent').waitFor();
      await expect.poll(() => s.blockedRequests).toEqual([{ method: 'POST', host: other, path: '/public/collect' }]);
      expect(s.violations).toEqual([expect.objectContaining({ kind: 'host', fatal: false, method: 'POST', url: `http://${other}/public/collect` })]);
      expect(s.closed).toBe(false);
      expect((await counters()).collect).toBe(0);
    } finally { await s.close(); }
  });
  it('fatal mode (the default) ends the run on the same page', async () => {
    portal.reset();
    const s = await open({ subresourceHosts: '*' });
    try {
      await s.page.goto(`${portal.url}/public/beacon`).catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.fatal)).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
      expect(s.closeReason).toBe('violation');
      expect((await counters()).collect).toBe(0);
    } finally { await s.close(); }
  });
  it("'*' loads a stylesheet from a second host; an empty list blocks it without ending the run", async () => {
    portal.reset();
    const any = await open({ subresourceHosts: '*' });
    try {
      await any.page.goto(`${portal.url}/public/styled`, { waitUntil: 'load' });
      expect((await counters()).css).toBe(1);
      expect(any.violations).toEqual([]);
    } finally { await any.close(); }
    portal.reset();
    const none = await open({ subresourceHosts: [] });
    try {
      await none.page.goto(`${portal.url}/public/styled`, { waitUntil: 'load' });
      expect((await counters()).css).toBe(0);
      expect(none.violations).toContainEqual(expect.objectContaining({ kind: 'host', fatal: false, url: `http://localhost:${portal.port}/public/style.css` }));
      expect(none.closed).toBe(false);
    } finally { await none.close(); }
  });
  it('a main-frame POST navigation is fatal even in block mode', async () => {
    const s = await open({ writeMode: 'block', subresourceHosts: '*' });
    try {
      await s.page.goto(`${portal.url}/public/files`);
      await s.page.getByRole('button', { name: 'Export via POST' }).click().catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.fatal && v.url.endsWith('/public/files/export'))).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
      expect(s.blockedRequests).toEqual([]);
    } finally { await s.close(); }
  });
  it('restrict() swaps the policy for later requests', async () => {
    const policy = policyFor(portal);
    const s = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const post = () => s.page.evaluate((u) => fetch(u, { method: 'POST' }).then(() => 'sent', () => 'blocked'), `${portal.url}/acme/reports/export`)
        .catch(() => 'blocked');
      s.armSubmit({ host: portal.host, path: '/acme/reports/export', method: 'POST' });
      expect(await post()).toBe('sent');
      expect(s.violations).toEqual([]);
      s.restrict(noWritePolicy(policy));
      expect(await post()).toBe('blocked');
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
    } finally { await s.close(); }
  });
  it('armSubmit() opens an allowed submission for one target; restrict() disarms it', async () => {
    const policy = policyFor(portal);
    const target = { host: portal.host, path: '/acme/reports/export', method: 'POST' };
    const post = (s: Awaited<ReturnType<typeof openSession>>) => s.page.evaluate((u) => fetch(u, { method: 'POST' }).then(() => 'sent', () => 'blocked'), `${portal.url}/acme/reports/export`)
      .catch(() => 'blocked');
    const s = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      s.armSubmit(target);
      expect(await post(s)).toBe('sent');
      s.armSubmit(null);
      expect(s.violations).toEqual([]);
      expect(await post(s)).toBe('blocked');
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
    } finally { await s.close(); }
    const t = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await t.page.goto(`${portal.url}/acme/login`);
      t.armSubmit(target);
      t.restrict(policy);
      expect(await post(t)).toBe('blocked');
    } finally { await t.close(); }
  });
  it('an armed step sends at most 3 submissions to its target, even concurrently; re-arming starts a new count (cap)', async () => {
    const policy = policyFor(portal);
    const target = { host: portal.host, path: '/acme/reports/export', method: 'POST' };
    const burst = (s: Awaited<ReturnType<typeof openSession>>, n: number) => s.page.evaluate(([u, k]) =>
      Promise.all(Array.from({ length: k as number }, () => fetch(u as string, { method: 'POST' }).then(() => 'sent', () => 'blocked'))), [`${portal.url}/acme/reports/export`, n] as const)
      .catch(() => [] as string[]);
    const s = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      s.armSubmit(target);
      await burst(s, 5); // the 4th submission is fatal and closes the session, so the page may not answer
      expect(s.writesSent).toBe(3);
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
    } finally { await s.close(); }
    const t = await openSession({ endpoint: LOCAL, policy, masker });
    try {
      await t.page.goto(`${portal.url}/acme/login`);
      t.armSubmit(target);
      expect((await burst(t, 3)).filter((r) => r === 'sent')).toHaveLength(3);
      t.armSubmit(target);
      expect((await burst(t, 1)).filter((r) => r === 'sent')).toHaveLength(1);
      expect(t.violations).toEqual([]);
    } finally { await t.close(); }
  });
  it('uses the viewport only when one is given', async () => {
    const a = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker, viewport: { width: 800, height: 600 } });
    try { expect(a.page.viewportSize()).toEqual({ width: 800, height: 600 }); } finally { await a.close(); }
    const b = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
    try { expect(b.page.viewportSize()).toEqual({ width: 1280, height: 720 }); } finally { await b.close(); }
  });
  it('Local Browser pinning looks hosts up in parallel through the limiter: never more than 2 at once', async () => {
    let active = 0;
    let peak = 0;
    const asked: string[] = [];
    const resolveHost = async (h: string) => {
      asked.push(h);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return h === 'localhost' ? ['127.0.0.1'] : ['93.184.215.14'];
    };
    const subs = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example'];
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), subresourceHosts: subs }, masker, resolveHost });
    await s.close();
    expect(asked.sort()).toEqual([...subs].sort());
    expect(peak).toBe(2);
  });
  it("a local session never tries to resolve '*'", async () => {
    const resolveHost = vi.fn(async () => [] as string[]);
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), subresourceHosts: '*' }, masker, resolveHost });
    await s.close();
    expect(resolveHost).not.toHaveBeenCalledWith('*');
  });
});

describe('destructive navigations under noWritePolicy', () => {
  const policy = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
  const nav = (url: string, frame?: { isMain: boolean; url: string }) => ({ url, method: 'GET', isNavigation: true, ...(frame ? { frame } : {}) });
  it('a main-frame navigation whose decoded path or query names a destructive action is a write in agent and prove sessions only', () => {
    const n = noWritePolicy(policy);
    for (const url of ['http://127.0.0.1:9999/acme/orders/7?action=cancel', 'http://127.0.0.1:9999/admin/purge', 'http://127.0.0.1:9999/acme/x?op=%63ancel', 'http://127.0.0.1:9999/acme/x?op=%2563ancel', 'http://127.0.0.1:9999/acme/orders?action=refund&id=1', 'http://127.0.0.1:9999/acme/x?q=pay+now']) {
      expect(checkRequest(n, nav(url)), url).toMatchObject({ kind: 'write', method: 'GET', url: url.split('?')[0] });
      expect(checkRequest(n, nav(url, { isMain: true, url: 'http://127.0.0.1:9999/acme/home' })), url).toMatchObject({ kind: 'write' });
      // Script-lane sessions are unchanged; sub-frames and sub-resources are not navigations of the page.
      expect(checkRequest(policy, nav(url)), url).toBeNull();
      expect(checkRequest(n, nav(url, { isMain: false, url: 'http://127.0.0.1:9999/acme/home' })), url).toBeNull();
      expect(checkRequest(n, { url, method: 'GET', isNavigation: false }), url).toBeNull();
    }
    for (const url of ['http://127.0.0.1:9999/acme/home', 'http://127.0.0.1:9999/acme/service/field-actions', 'http://127.0.0.1:9999/acme/reports?page=2', 'http://127.0.0.1:9999/acme/orders?status=cancelled']) {
      expect(checkRequest(n, nav(url)), url).toBeNull();
    }
  });
  it('the start URL and the login pages are never refused, but a destructive query on a login page is', () => {
    const n = noWritePolicy({ ...policy, startUrl: 'http://127.0.0.1:9999/acme/payment/history?confirm=1', login: [...policy.login, { host: '127.0.0.1:9999', path: '/acme/mfa/confirm' }] });
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/payment/history?confirm=1'))).toBeNull();
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/mfa/confirm'))).toBeNull();
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/mfa/confirm?next=/acme/home'))).toBeNull();
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/payment/history?confirm=2'))).toMatchObject({ kind: 'write' });
    // Login pages are exempt by path only.
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/login?action=cancel'))).toMatchObject({ kind: 'write', url: 'http://127.0.0.1:9999/acme/login' });
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/mfa/confirm?then=purge'))).toMatchObject({ kind: 'write' });
  });
  it('decodes leniently: a malformed escape does not stop the decoding of the rest', () => {
    const n = noWritePolicy(policy);
    for (const url of ['http://127.0.0.1:9999/acme/orders/7/%ZZ/%63ancel', 'http://127.0.0.1:9999/acme/orders/7?x=%ZZ&op=%63ancel', 'http://127.0.0.1:9999/acme/x?a=%E0%A4%A&op=%63ancel', 'http://127.0.0.1:9999/acme/x?a=%&op=%2570urge', 'http://127.0.0.1:9999/acme/%c3%28/%64elete']) {
      expect(checkRequest(n, nav(url)), url).toMatchObject({ kind: 'write' });
    }
    expect(checkRequest(n, nav('http://127.0.0.1:9999/acme/x?a=%ZZ&page=2'))).toBeNull();
  });
  it('a redirect hop to a destructive address in an agent or prove session ends the run (the hop itself was already sent)', async () => {
    let hits = 0;
    const server = createHttpServer((req, res) => {
      if (req.url === '/r') { res.writeHead(302, { Location: '/orders/7?action=cancel' }); res.end(); return; }
      if (req.url?.startsWith('/orders/')) hits++;
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>ok</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
    const p: PortalPolicy = { startUrl: `http://${host}/start`, navHosts: [host], subresourceHosts: [], login: [], allowedSubmits: [], allowPrivateNetwork: true };
    const s = await openSession({ endpoint: LOCAL, policy: noWritePolicy(p), masker });
    try {
      await s.page.goto(`http://${host}/r`).catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.fatal && v.url === `http://${host}/orders/7`)).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
      expect(hits).toBeLessThanOrEqual(1);
    } finally {
      await s.close();
      await new Promise((r) => server.close(r));
    }
  });
  it('a session under noWritePolicy ends the run on a destructive GET navigation and never sends it', async () => {
    portal.reset();
    const s = await openSession({ endpoint: LOCAL, policy: noWritePolicy(policyFor(portal)), masker });
    let sent = 0;
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      s.page.on('requestfinished', (r) => { if (r.url().includes('action=cancel')) sent++; });
      await s.page.setContent(`<a id="go" href="${portal.url}/acme/orders/7?action=cancel">Reports</a>`);
      await s.page.click('#go').catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.method === 'GET' && v.fatal && v.url === `${portal.url}/acme/orders/7`)).toBe(true);
      await expect.poll(() => s.closed).toBe(true);
      expect(sent).toBe(0);
    } finally { await s.close(); }
  });
});

describe('frame-host writes under noWritePolicy', () => {
  const policy: PortalPolicy = {
    ...policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' }),
    frameHosts: ['widget.example'], login: [{ host: 'widget.example', path: '/login' }],
  };
  const fromWidget = (url: string, method = 'POST', isNavigation = false) =>
    ({ url, method, isNavigation, frame: { isMain: false, url: 'https://widget.example/frame' } });
  it('refuses a frame-host POST between frame hosts, keeps declared login POSTs and frame loads', () => {
    expect(checkRequest(policy, fromWidget('https://widget.example/collect'))).toBeNull();
    const n = noWritePolicy(policy);
    expect(checkRequest(n, fromWidget('https://widget.example/collect'))).toMatchObject({ kind: 'write', method: 'POST' });
    expect(checkRequest(n, fromWidget('https://widget.example/login'))).toBeNull();
    expect(checkRequest(n, fromWidget('https://widget.example/frame', 'GET', true))).toBeNull();
  });
  it('a session under noWritePolicy loads the widget frame and refuses its POST', async () => {
    portal.reset();
    const p = noWritePolicy({ ...policyFor(portal), frameHosts: [`localhost:${portal.port}`] });
    const s = await openSession({ endpoint: LOCAL, policy: p, masker, isPrivate: () => false });
    try {
      await s.page.goto(`${portal.url}/acme/p/frame`).catch(() => undefined);
      // The POST comes from the widget's own script, so the frame loaded.
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.fatal && v.url === `http://localhost:${portal.port}/acme/p/widget`)).toBe(true);
      expect(s.violations.some((v) => v.kind === 'host')).toBe(false);
      expect(portal.state().widgetPosts).toBe(0);
    } finally { await s.close(); }
  });
});

describe('bounded and masked logs, restrict during the address check', () => {
  let server: BrowserServer;
  let remote: BrowserEndpoint;
  beforeAll(async () => { server = await chromium.launchServer({ headless: true }); remote = { mode: 'playwright', wsUrl: server.wsEndpoint() }; });
  afterAll(async () => { await server.close(); });
  const key = (x: object) => JSON.stringify(x);

  it('blockedRequests and non-fatal violations are deduped and capped at 100; fatal violations are always kept', async () => {
    portal.reset();
    const other = `localhost:${portal.port}`;
    const s = await openSession({
      endpoint: remote, policy: { ...policyFor(portal), writeMode: 'block', subresourceHosts: '*' }, masker, isPrivate: () => false,
    });
    try {
      await s.page.goto(`${portal.url}/public/table`, { waitUntil: 'load' });
      await s.page.evaluate((o) => {
        for (let i = 0; i < 500; i++) navigator.sendBeacon(`http://${o}/public/c${i % 5}`, 'x');
      }, other);
      await expect.poll(() => s.blockedRequests.length).toBe(5);
      await s.page.evaluate((o) => {
        for (let i = 0; i < 300; i++) void fetch(`http://${o}/public/u${i}`, { method: 'POST', mode: 'no-cors' }).catch(() => undefined);
      }, other);
      await expect.poll(() => s.blockedRequests.length).toBe(100);
      await new Promise((r) => setTimeout(r, 500));
      expect(s.blockedRequests).toHaveLength(100);
      expect(new Set(s.blockedRequests.map(key)).size).toBe(100);
      const nonFatal = s.violations.filter((v) => !v.fatal);
      expect(nonFatal.length).toBeLessThanOrEqual(100);
      expect(new Set(nonFatal.map(key)).size).toBe(nonFatal.length);
      await s.page.goto('http://evil.invalid/').catch(() => undefined);
      await expect.poll(() => s.violations.some((v) => v.fatal && v.kind === 'host')).toBe(true);
    } finally { await s.close(); }
  });
  it('masks and caps a page-chosen method', async () => {
    const m = createMasker(['summit-ops']);
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), writeMode: 'block' }, masker: m });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.evaluate(() => fetch('/acme/x1', { method: 'summit-ops' }).then(() => undefined, () => undefined));
      await s.page.evaluate(() => fetch('/acme/x2', { method: 'A'.repeat(40) }).then(() => undefined, () => undefined));
      await expect.poll(() => s.blockedRequests.length).toBe(2);
      for (const b of s.blockedRequests) {
        expect(b.method.toLowerCase()).not.toContain('summit-ops');
        expect(b.method.length).toBeLessThanOrEqual(16);
      }
      for (const v of s.violations) expect((v.method ?? '').toLowerCase()).not.toContain('summit-ops');
    } finally { await s.close(); }
  });
  it('masks before capping: a secret across the 300-character boundary is still masked', async () => {
    const secret = 'demo-password';
    const m = createMasker([secret]);
    const s = await openSession({ endpoint: LOCAL, policy: { ...policyFor(portal), writeMode: 'block' }, masker: m });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const inPath = `/${'a'.repeat(295)}${secret}`; // the secret starts at path index 296
      const inUrl = `/${'b'.repeat(300 - portal.url.length - 6)}${secret}`; // the secret starts at URL index 295
      for (const p of [inPath, inUrl]) await s.page.evaluate((u) => fetch(u, { method: 'POST' }).then(() => undefined, () => undefined), p);
      await expect.poll(() => s.blockedRequests.length).toBe(2);
      const shown = [...s.blockedRequests.map((b) => b.path), ...s.violations.map((v) => v.url)];
      for (const x of shown) {
        expect(x).not.toContain(secret);
        for (let k = 3; k < secret.length; k++) expect(x.endsWith(secret.slice(0, k))).toBe(false);
      }
    } finally { await s.close(); }
  });
  it('a restrict() during the address check decides the request under the new policy', async () => {
    const other = `localhost:${portal.port}`;
    const base = policyFor(portal);
    const policy: PortalPolicy = {
      ...base, navHosts: [...base.navHosts, other],
      allowedSubmits: [...base.allowedSubmits, { host: other, path: '/acme/reports/export', method: 'POST' }],
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let asked!: () => void;
    const askedFor = new Promise<void>((r) => { asked = r; });
    const resolveHost = async (h: string) => {
      if (h === 'localhost') { asked(); await gate; }
      return ['127.0.0.1'];
    };
    const s = await openSession({ endpoint: remote, policy, masker, resolveHost });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      s.armSubmit({ host: other, path: '/acme/reports/export', method: 'POST' });
      void s.page.evaluate((u) => { void fetch(u, { method: 'POST', mode: 'no-cors' }).catch(() => undefined); }, `http://${other}/acme/reports/export`)
        .catch(() => undefined);
      await askedFor;
      s.restrict(noWritePolicy(policy));
      release();
      await expect.poll(() => s.violations.some((v) => v.kind === 'write' && v.fatal && v.url === `http://${other}/acme/reports/export`)).toBe(true);
    } finally { release(); await s.close(); }
  });
});
