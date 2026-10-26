import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import type { Page } from 'playwright-core';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import type { LaneRuntime } from '../src/lane/script-lane.js';
import { MAX_TEXT_BYTES } from '../src/steps/handlers/capture.js';
import { openStartPage, pageInfo, startPageFailure, startPlan, startProceeds, type StartPageResult } from '../src/lane/start-page.js';
import { createMasker } from '../src/secrets/mask.js';
import type { PortalPolicy } from '../src/types.js';
import { LOCAL, policyFor, publicPolicy } from './helpers.js';
import { BROWSER_ERROR_PAGE } from '../src/messages.js';
import { parseScript } from '../src/steps/parse.js';

/** A port nothing listens on: bound once, then released. */
const closedPort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address() as AddressInfo;
    srv.close(() => resolve(port));
  });
});

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
let policy: PortalPolicy;
let deadPort: number;
beforeAll(async () => {
  portal = await startPortal();
  deadPort = await closedPort();
  policy = { ...policyFor(portal), navHosts: [portal.host, `127.0.0.1:${deadPort}`] };
  session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
});
afterAll(async () => {
  await session?.close();
  await portal.close();
});
const open = (path: string, masker = createMasker([])) => openStartPage(session.page, `${portal.url}${path}`, { policy, masker });

describe('openStartPage', () => {
  it('a page that loads proceeds', async () => {
    expect(await open('/acme/login')).toEqual({ status: 200, responded: true, proceed: true });
  });
  it('a 404 page, or a 403 page that is not a login page, does not proceed', async () => {
    expect(await open('/acme/p/status/404')).toEqual({ status: 404, responded: true, proceed: false });
    expect(await open('/acme/p/status/403')).toEqual({ status: 403, responded: true, proceed: false });
  });
  it('a declared login page served with 401 or 403 proceeds', async () => {
    expect(await open('/acme/login?status=401')).toEqual({ status: 401, responded: true, proceed: true });
    expect(await open('/acme/login?status=403')).toEqual({ status: 403, responded: true, proceed: true });
  });
  it('an unreachable server sets a masked one-line error and never proceeds', async () => {
    const r = await openStartPage(session.page, `http://127.0.0.1:${deadPort}/x?u=SEKRET-VALUE`, { policy, masker: createMasker(['SEKRET-VALUE']) });
    expect(r).toMatchObject({ status: null, responded: false, proceed: false });
    expect(r.error).toMatch(/ERR_CONNECTION_REFUSED/);
    expect(r.error).not.toContain('SEKRET-VALUE');
    expect(r.error).not.toContain('\n');
  });
  it('the error names the start URL without its query string or fragment', async () => {
    const r = await openStartPage(session.page, `http://127.0.0.1:${deadPort}/x?token=abc#frag`, { policy, masker: createMasker([]) });
    expect(r.error).toMatch(/ERR_CONNECTION_REFUSED/);
    expect(r.error).toContain(`http://127.0.0.1:${deadPort}/x`);
    expect(r.error).not.toMatch(/token|abc|#frag/);
  });
});

describe('startPageFailure', () => {
  const runtime = (override: { code: 'incomplete'; message: string } | null, seen: (string | undefined)[] = []) =>
    ({ override: (where?: string) => { seen.push(where); return override; }, session: { violations: [] } }) as unknown as LaneRuntime;
  const notFound: StartPageResult = { status: 404, responded: true, proceed: false };
  it('classifies the start page when no run-level outcome applies', () => {
    const seen: (string | undefined)[] = [];
    expect(startPageFailure(runtime(null, seen), notFound)).toEqual({ code: 'drift_detected', message: 'HTTP 404 at the start page' });
    expect(seen).toEqual(['the start page']);
  });
  it('reports the navigation error as the message', () => {
    expect(startPageFailure(runtime(null), { status: null, error: 'page.goto: net::ERR_CONNECTION_REFUSED', responded: false, proceed: false }).message)
      .toBe('page.goto: net::ERR_CONNECTION_REFUSED');
  });
  it('a run-level outcome wins over the classification', () => {
    expect(startPageFailure(runtime({ code: 'incomplete', message: 'run cancelled' }), notFound)).toEqual({ code: 'incomplete', message: 'run cancelled' });
  });
});

describe('start plan, status modes and browser error pages', () => {
  const plan = (doc: unknown) => startPlan(doc, parseScript(doc, { defaultStartUrl: 'https://example.com/default' }));
  it('the first goto is the start page only when startUrl is not set and the step is a plain goto', () => {
    expect(plan([{ intent: 'Open', goto: 'https://Example.com/a', waitUntil: 'networkidle' }])).toEqual({ url: 'https://example.com/a', waitUntil: 'networkidle', firstStep: 1 });
    expect(plan([{ intent: 'Open', goto: 'https://example.com/a' }])).toEqual({ url: 'https://example.com/a', waitUntil: 'domcontentloaded', firstStep: 1 });
    expect(plan({ startUrl: 'https://example.com/s', steps: [{ intent: 'Open', goto: 'https://example.com/a' }] })).toEqual({ url: 'https://example.com/s', waitUntil: 'domcontentloaded', firstStep: 0 });
    expect(plan([{ intent: 'Click', click: { css: 'a' } }])).toEqual({ url: 'https://example.com/default', waitUntil: 'domcontentloaded', firstStep: 0 });
    expect(plan([{ intent: 'Open', goto: '/relative' }])).toEqual({ url: 'https://example.com/default', waitUntil: 'domcontentloaded', firstStep: 0 });
    expect(plan([{ intent: 'Open', goto: 'https://example.com/a', expect: { heading: 'A' } }])).toMatchObject({ url: 'https://example.com/a', firstStep: 0 });
    expect(plan([{ intent: 'Open', goto: 'https://example.com/a', optional: true }])).toMatchObject({ firstStep: 0 });
  });
  it("'report' proceeds on any status but 404, 410 and 5xx; 'classify' keeps v1", () => {
    const r = (status: number | null, error?: string) => ({ status, responded: status !== null, proceed: !error && (status === null || status < 400), ...(error ? { error } : {}) });
    for (const s of [200, 401, 403, 429]) expect(startProceeds(r(s), 'report')).toBe(true);
    for (const s of [404, 410, 500, 503]) expect(startProceeds(r(s), 'report')).toBe(false);
    expect(startProceeds(r(null, 'net::ERR_CONNECTION_REFUSED'), 'report')).toBe(false);
    expect(startProceeds(r(403))).toBe(false);
    expect(startProceeds(r(200))).toBe(true);
  });
  it('a browser error page is never a success', async () => {
    const fake = { goto: async () => null, url: () => 'chrome-error://chromewebdata/' } as unknown as Page;
    const r = await openStartPage(fake, 'http://127.0.0.1:1/', { policy: publicPolicy({ url: 'http://127.0.0.1:1', host: '127.0.0.1:1' }), masker: createMasker([]) });
    expect(r).toEqual({ status: null, error: BROWSER_ERROR_PAGE, responded: false, proceed: false });
  });
});

describe('envelope status', () => {
  const page = (url: string) => ({ url: () => url, title: async () => 'Title' }) as unknown as Page;
  it('reports the last document status only when it is the page the run ended on (origin and path)', async () => {
    const masker = createMasker([]);
    expect(await pageInfo(page('https://a.example/list?page=2#top'), { url: 'https://a.example/list?page=1', status: 203 }, masker))
      .toEqual({ url: 'https://a.example/list?page=2', title: 'Title', status: 203 });
    expect((await pageInfo(page('https://a.example/list'), { url: 'https://a.example/export.csv', status: 200 }, masker)).status).toBeNull();
    expect((await pageInfo(page('https://a.example/list'), { url: 'https://popup.example/list', status: 200 }, masker)).status).toBeNull();
    expect((await pageInfo(page('https://a.example/list'), null, masker)).status).toBeNull();
  });
  it('caps the title like read: title, after masking', async () => {
    const secret = 'demo-password';
    const title = `${'a'.repeat(MAX_TEXT_BYTES - 5)}${secret}${'b'.repeat(1000)}`;
    const long = { url: () => 'https://a.example/', title: async () => title } as unknown as Page;
    const info = await pageInfo(long, null, createMasker([secret]));
    expect(Buffer.byteLength(info.title, 'utf8')).toBe(MAX_TEXT_BYTES);
    expect(info.title.endsWith('a'.repeat(10))).toBe(false);
    expect(info.title).not.toContain('demo-');
    expect(info.title.endsWith('[secr')).toBe(true);
  });
});
