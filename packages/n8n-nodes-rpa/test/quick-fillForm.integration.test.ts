import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { executeQuickOp } from '../nodes/Playwright/operations/quick.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { harness } from './harness.js';
import { BROWSER, publicCounters, quickParams } from './quick-fixtures.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const SEND = { locator: { findBy: 'role', role: 'button', roleName: 'Send' } };
const field = (label: string, value: string) => ({ findBy: 'label', label, value });
const params = (path: string, fields: IDataObject[] = [], options: IDataObject = {}) =>
  quickParams('fillForm', { url: `${portal.url}${path}`, formFields: { field: fields }, submitButton: SEND }, { allowPrivateNetwork: true, timeout: 10, ...options });
async function run(p: IDataObject): Promise<INodeExecutionData> {
  const [data] = await executeQuickOp(harness({ params: p, credentials: BROWSER, continueOnFail: true }), engine, 'fillForm');
  expect(data).toHaveLength(1);
  return data[0];
}
const failed = (item: INodeExecutionData, code: string): string => {
  expect(String(item.json.error)).toMatch(new RegExp(`^${code}: `));
  return String(item.json.message);
};
const posts = async () => (await publicCounters(portal.url)).posts as { path: string; name?: string }[];

describe('Fill and Submit Form against the sandbox (real engine)', () => {
  it('/public/form: one allowed POST, the thanks page text, submitted and writes', async () => {
    const item = await run(params('/public/form', [field('Name', 'Ada'), field('Message', 'Hello there')]));
    expect(item.json).toMatchObject({
      url: `${portal.url}/public/form/submit`, status: 200, submitted: true, writes: [{ method: 'POST', host: portal.host, path: '/public/form/submit' }],
    });
    expect(String(item.json.text)).toContain('Thanks');
    expect(String(item.json.text)).toContain('Received from Ada');
    expect(item.json).not.toHaveProperty('blockedRequests');
    expect(await posts()).toEqual([{ path: '/public/form/submit', name: 'Ada' }]);
  });
  it('/public/form-cross and /public/form-formaction: a form that posts to another host fails before the click, nothing posted', async () => {
    for (const path of ['/public/form-cross', '/public/form-formaction']) {
      const item = await run(params(path));
      expect(failed(item, 'policy_violation')).toBe(
        `Submit the form: the form posts to localhost:${portal.port}, which is not allowed. This run only submits to ${portal.host}.`,
      );
      expect(await posts()).toEqual([]);
    }
  });
  it('/public/form-script: the script fetch POST inside the window is allowed and listed', async () => {
    const item = await run(params('/public/form-script'));
    expect(item.json).toMatchObject({ submitted: true, writes: [{ method: 'POST', host: portal.host, path: '/public/api/submit' }] });
    expect(String(item.json.text)).toContain('Saved');
    expect((await posts()).map((p) => p.path)).toEqual(['/public/api/submit']);
  });
  it('/public/form-many: three POSTs are allowed, the fourth is blocked and logged, the run succeeds', async () => {
    const item = await run(params('/public/form-many'));
    const write = { method: 'POST', host: portal.host, path: '/public/api/submit' };
    expect(item.json).toMatchObject({ submitted: true, writes: [write, write, write], blockedRequests: [write] });
    expect(await posts()).toHaveLength(3);
  });
  it('a password field is refused with the golden message, nothing posted, the value never shown', async () => {
    const item = await run(params('/public/form', [field('Name', 'Ada'), field('Password', 'hunter2')]));
    expect(failed(item, 'policy_violation').endsWith('Fill and Submit Form cannot fill password fields. For sites behind a login, use Run Steps with a Site Login.')).toBe(true);
    expect(await posts()).toEqual([]);
    expect(JSON.stringify(item.json)).not.toContain('hunter2');
  });
  it('a password field found by CSS Selector is refused the same way', async () => {
    const item = await run(params('/public/form', [field('Name', 'Ada'), { findBy: 'css', css: 'input[name=password]', value: 'hunter2' }]));
    expect(failed(item, 'policy_violation').endsWith('Fill and Submit Form cannot fill password fields. For sites behind a login, use Run Steps with a Site Login.')).toBe(true);
    expect(await posts()).toEqual([]);
    expect(JSON.stringify(item.json)).not.toContain('hunter2');
  });
  it('a value over 10,000 characters is refused before the browser opens', async () => {
    const item = await run(params('/public/form', [field('Message', 'x'.repeat(10_001))]));
    expect(failed(item, 'incomplete')).toBe('input "f0" is longer than 10000 characters');
    expect((await publicCounters(portal.url)).hits['/public/form']).toBeUndefined();
  });
  it('dispatches through the node class', async () => {
    const h = harness({ params: params('/public/form', [field('Name', 'Grace')]), credentials: BROWSER });
    const [data] = await new Playwright().execute.call(h as unknown as IExecuteFunctions);
    expect(data[0].json).toMatchObject({ submitted: true });
    expect(await posts()).toEqual([{ path: '/public/form/submit', name: 'Grace' }]);
  });
});
