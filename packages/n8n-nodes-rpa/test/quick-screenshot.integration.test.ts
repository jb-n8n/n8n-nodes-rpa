import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { executeQuickOp } from '../nodes/Playwright/operations/quick.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { harness } from './harness.js';
import { binaryOf, BROWSER, pageTitle, PNG_MAGIC, pngSize, publicCounters, quickParams } from './quick-fixtures.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

/** Screenshot of a sandbox page with Allow Private Network on (the sandbox is on 127.0.0.1). */
const screenshot = (path: string, fields: IDataObject = {}, options: IDataObject = {}) =>
  executeQuickOp(
    harness({ params: quickParams('screenshot', { url: `${portal.url}${path}`, ...fields }, { allowPrivateNetwork: true, ...options }), credentials: BROWSER, continueOnFail: true }),
    engine,
    'screenshot',
  );

describe('Screenshot against the sandbox (real engine)', () => {
  it('/public/table: a PNG under "screenshot", the envelope with status 200 and the compiled steps', async () => {
    const [[item]] = await screenshot('/public/table');
    expect(item.json.error).toBeUndefined();
    const png = binaryOf(item, 'screenshot');
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(item.binary?.screenshot.mimeType).toBe('image/png');
    expect(item.binary?.screenshot.fileName).toBe('screenshot.png');
    expect(pngSize(png).width).toBe(1280);
    expect(item.json).toMatchObject({ url: `${portal.url}/public/table`, title: await pageTitle(`${portal.url}/public/table`), status: 200 });
    expect(item.json).not.toHaveProperty('blockedRequests');
    expect(item.json.steps).toEqual({
      steps: [
        { intent: 'Open the page', goto: `${portal.url}/public/table`, waitUntil: 'load' },
        { intent: 'Take a screenshot', screenshot: { capture: 'full' } },
      ],
    });
  });

  it('Viewport capture follows Options → Viewport', async () => {
    const [[item]] = await screenshot('/public/table', { capture: 'viewport' }, { viewport: { size: { width: 800, height: 600 } } });
    expect(pngSize(binaryOf(item, 'screenshot'))).toEqual({ width: 800, height: 600 });
  });

  it('One Element captures only the table', async () => {
    const [[item]] = await screenshot('/public/table', { capture: 'element', element: { locator: { findBy: 'css', css: 'table.results' } } });
    const { width, height } = pngSize(binaryOf(item, 'screenshot'));
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(1280);
    expect(height).toBeGreaterThan(0);
  });

  it('Options → Put Output in Field renames the binary', async () => {
    const [[item]] = await screenshot('/public/table', {}, { screenshotProperty: 'tablePng' });
    expect(Object.keys(item.binary ?? {})).toEqual(['tablePng']);
    expect(binaryOf(item, 'tablePng').subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('the steps output pastes into Run Steps unchanged (unsigned), and each run loads the page once', async () => {
    const [[item]] = await screenshot('/public/table');
    const [data] = await executeRunSteps(
      harness({
        params: {
          operation: 'runSteps', steps: item.json.steps, startUrl: `${portal.url}/public/table`, requireSignedSteps: false, signature: '', approvedBy: '',
          aiRepair: false, goal: '', options: { allowPrivateNetwork: true, saveTrace: 'never' },
        },
        credentials: BROWSER,
        continueOnFail: true,
      }),
      engine,
    );
    expect(data[0].json.error).toBeUndefined();
    expect(data[0].json).toMatchObject({ status: 200, lane: 'script' });
    expect(binaryOf(data[0], 'screenshot_1').subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // One document load per run: the start page is the first goto, not fetched twice.
    expect((await publicCounters(portal.url)).hits['/public/table']).toBe(2);
  });

  it('/public/missing fails not_found', async () => {
    const [[item]] = await screenshot('/public/missing');
    expect(String(item.json.error)).toMatch(/^not_found: /);
  });

  it('/public/forbidden succeeds and reports status 403 (the workflow can branch on it)', async () => {
    const [[item]] = await screenshot('/public/forbidden');
    expect(item.json.error).toBeUndefined();
    expect(item.json.status).toBe(403);
    expect(binaryOf(item, 'screenshot').subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it('/public/styled: the stylesheet on localhost (a private address) is blocked without failing the run', async () => {
    const [[item]] = await screenshot('/public/styled');
    expect(item.json.error).toBeUndefined();
    expect(item.json.status).toBe(200);
    expect(item.json).not.toHaveProperty('blockedRequests'); // a blocked GET is not a blocked write
    expect((await publicCounters(portal.url)).css).toBe(0);
  });

  it('without Allow Private Network the sandbox is refused with the golden message and never fetched', async () => {
    const [[item]] = await executeQuickOp(
      harness({ params: quickParams('screenshot', { url: `${portal.url}/public/table` }), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot',
    );
    expect(String(item.json.error)).toMatch(/^policy_violation: /);
    expect(String(item.json.message).endsWith(
      `Blocked: ${portal.host} resolves to a private network address. Turn on Options → Allow Private Network if this site is on your own network.`,
    )).toBe(true);
    expect((await publicCounters(portal.url)).hits['/public/table'] ?? 0).toBe(0);
  });
});
