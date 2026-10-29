import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { snapshot } from '../src/agent/snapshot.js';
import { createMasker } from '../src/secrets/mask.js';
import { createBrowserSurface } from '../src/surface/browser.js';

let browser: Browser;
const masker = createMasker(['summit-ops']);
const BODY = '<!doctype html><title>Orders</title><body><h1>Open orders</h1><button>Export</button><input aria-label="Dealer" value="summit-ops"></body>';

async function openPage(path: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route('http://surface.test/**', (route) => route.fulfill({ contentType: 'text/html', body: BODY }));
  await page.goto(`http://surface.test/${path}`);
  return page;
}

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });

describe('browser surface', () => {
  it('kind is browser and address is the page URL', async () => {
    const page = await openPage('orders?session=tok-1');
    const s = createBrowserSurface(() => page);
    expect(s.kind).toBe('browser');
    expect(s.address()).toBe(page.url());
    await page.close();
  });

  it('isVisible matches isVisibleNow', async () => {
    const page = await openPage('orders');
    const s = createBrowserSurface(() => page);
    expect(await s.isVisible({ role: 'heading', name: 'Open orders' })).toBe(true);
    expect(await s.isVisible({ css: '#no-such-element' })).toBe(false);
    await page.close();
  });

  it('checkExpect passes and fails like checkExpect', async () => {
    const page = await openPage('orders');
    const s = createBrowserSurface(() => page);
    await expect(s.checkExpect({ heading: 'Open orders' }, 2000)).resolves.toBeUndefined();
    await expect(s.checkExpect({ heading: 'No Such Heading' }, 300)).rejects.toThrow(/^expectation failed: heading "No Such Heading"/);
    await page.close();
  });

  it('snapshot equals the direct snapshot', async () => {
    const page = await openPage('orders');
    const s = createBrowserSurface(() => page);
    const viaSurface = await s.snapshot(masker);
    const direct = await snapshot(page, masker);
    expect(JSON.stringify(viaSurface.elements)).toBe(JSON.stringify(direct.elements));
    expect(viaSurface.elements.some((e) => e.name === 'Export')).toBe(true);
    await page.close();
  });

  it('follows a replaced page', async () => {
    const first = await openPage('first');
    const second = await openPage('second');
    let current = first;
    const s = createBrowserSurface(() => current);
    expect(s.address()).toBe('http://surface.test/first');
    current = second;
    expect(s.address()).toBe('http://surface.test/second');
    await first.close();
    await second.close();
  });

  it('a closed page ends checks at once', async () => {
    const page = await openPage('orders');
    const s = createBrowserSurface(() => page);
    await page.close();
    expect(s.isClosed()).toBe(true);
    const t0 = Date.now();
    await expect(s.checkExpect({ heading: 'x' }, 5000)).rejects.toThrow(/^expectation abandoned: the page was closed/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
