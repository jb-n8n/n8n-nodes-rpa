import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { executeQuickOp } from '../nodes/Playwright/operations/quick.js';
import { harness } from './harness.js';
import { BROWSER, pageTitle, publicCounters, quickParams } from './quick-fixtures.js';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const getPage = (url: string, fields: IDataObject = {}) =>
  executeQuickOp(
    harness({ params: quickParams('getPage', { url, ...fields }, { allowPrivateNetwork: true }), credentials: BROWSER, continueOnFail: true }),
    engine,
    'getPage',
  );

describe('Get Page against the sandbox (real engine)', () => {
  it('Text of /public/table contains the table values', async () => {
    const [[item]] = await getPage(`${portal.url}/public/table`);
    expect(item.json.error).toBeUndefined();
    expect(item.json).toMatchObject({ url: `${portal.url}/public/table`, status: 200 });
    expect(String(item.json.text)).toContain('SKU-1001');
    expect(String(item.json.text)).toContain('Widget');
    expect(item.json).not.toHaveProperty('html');
    expect(item.json).not.toHaveProperty('truncated');
  });

  it('HTML of /public/table contains the table markup', async () => {
    const [[item]] = await getPage(`${portal.url}/public/table`, { pageContent: 'html' });
    expect(String(item.json.html)).toContain('<table');
    expect(String(item.json.html)).toContain('SKU-1003');
    expect(item.json).not.toHaveProperty('text');
  });

  it('Title and URL Only returns the page title and no text', async () => {
    const [[item]] = await getPage(`${portal.url}/public/table`, { pageContent: 'titleUrl' });
    expect(item.json).toMatchObject({ url: `${portal.url}/public/table`, title: await pageTitle(`${portal.url}/public/table`), status: 200 });
    expect(item.json).not.toHaveProperty('text');
    expect(item.json).not.toHaveProperty('html');
  });

  it('a 6 MiB page comes back cut at 5 MiB with truncated: true', async () => {
    const [[item]] = await getPage(`${portal.url}/public/big?mb=6`);
    expect(item.json.error).toBeUndefined();
    expect(item.json.truncated).toBe(true);
    const bytes = Buffer.byteLength(String(item.json.text), 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(bytes).toBeGreaterThan(MAX_TEXT_BYTES - 1024);
  });

  it('a redirect reports the final URL', async () => {
    const [[item]] = await getPage(`${portal.url}/public/redirect?to=${encodeURIComponent(`${portal.url}/public/table`)}`, { pageContent: 'titleUrl' });
    expect(item.json.error).toBeUndefined();
    expect(item.json.url).toBe(`${portal.url}/public/table`);
    expect(item.json.status).toBe(200);
  });

  it('/public/error (HTTP 500) fails site_down', async () => {
    const [[item]] = await getPage(`${portal.url}/public/error`);
    expect(String(item.json.error)).toMatch(/^site_down: /);
  });

  it('/public/beacon: beacons and POSTs are blocked and listed, the run still succeeds, nothing reaches the collector (Node)', async () => {
    const [[item]] = await getPage(`${portal.url}/public/beacon`);
    expect(item.json.error).toBeUndefined();
    expect(item.json.status).toBe(200);
    expect(item.json.blockedRequests).toContainEqual({ method: 'POST', host: portal.host, path: '/public/collect' });
    expect((await publicCounters(portal.url)).collect).toBe(0);
  });
});
