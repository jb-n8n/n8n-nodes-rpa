import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IBinaryData, IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
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

const byCss = (selector: string) => ({ locator: { findBy: 'css', css: selector } });
const params = (downloadTrigger: IDataObject, options: IDataObject = {}) =>
  quickParams('download', { url: `${portal.url}/public/files`, downloadTrigger }, { allowPrivateNetwork: true, timeout: 10, ...options });
async function run(p: IDataObject): Promise<INodeExecutionData> {
  const [data] = await executeQuickOp(harness({ params: p, credentials: BROWSER, continueOnFail: true }), engine, 'download');
  expect(data).toHaveLength(1);
  return data[0];
}
const failed = (item: INodeExecutionData, code: string): string => {
  expect(String(item.json.error)).toMatch(new RegExp(`^${code}: `));
  return String(item.json.message);
};

describe('Download File against the sandbox (real engine)', () => {
  // status is null: the engine reports the status of the main document only when it is the page the run ends on,
  // and the download response is the last navigation (engine behavior).
  it('CSV with the default file types: fileName, mimeType, bytes and binary file', async () => {
    const item = await run(params(byCss('#csv')));
    expect(item.json).toMatchObject({ url: `${portal.url}/public/files`, status: null, fileName: 'report.csv', mimeType: 'text/csv', bytes: 23 });
    const file = item.binary?.file as IBinaryData;
    expect(file).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv' });
    expect(Buffer.from(file.data, 'base64').toString()).toBe('code,name\nSKU-1,Widget\n');
  });
  it('Put Output in Field renames the binary', async () => {
    const item = await run(params(byCss('#csv'), { fileProperty: 'report' }));
    expect(Object.keys(item.binary ?? {})).toEqual(['report']);
  });
  it('ZIP is refused with the default file types', async () => {
    const item = await run(params(byCss('#zip')));
    expect(failed(item, 'incomplete').endsWith('download type application/zip is not allowed')).toBe(true);
  });
  it('ZIP is allowed when listed, and stays one binary (files are never extracted)', async () => {
    const expected = Buffer.from(await (await fetch(`${portal.url}/public/files/archive.zip`)).arrayBuffer());
    const item = await run(params(byCss('#zip'), { allowedFileTypes: ['application/zip'] }));
    expect(item.json).toMatchObject({ fileName: 'archive.zip', mimeType: 'application/zip', bytes: expected.length });
    expect(Object.keys(item.binary ?? {})).toEqual(['file']);
    const data = Buffer.from((item.binary?.file as IBinaryData).data, 'base64');
    expect(data.equals(expected)).toBe(true);
    expect(data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });
  it('a file above Max File Size is incomplete', async () => {
    const item = await run(params(byCss('#csv'), { maxFileSizeMb: 0.00001 }));
    expect(failed(item, 'incomplete')).toContain('download exceeds 10 bytes');
  });
  it('JSON, JPEG and DOCX are sniffed by their bytes when listed', async () => {
    const all = ['application/json', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    for (const [id, mime] of [['#json', all[0]], ['#jpeg', all[1]], ['#docx', all[2]]] as const) {
      const item = await run(params(byCss(id), { allowedFileTypes: all }));
      expect(item.json.mimeType).toBe(mime);
    }
  });
  it('"Export via POST" is a main-frame write: policy_violation, and the POST never reaches the server', async () => {
    const item = await run(params({ locator: { findBy: 'text', text: 'Export via POST' } }));
    failed(item, 'policy_violation');
    expect((await publicCounters(portal.url)).hits['/public/files/export']).toBeUndefined();
  });
  it('dispatches through the node class', async () => {
    const h = harness({ params: params(byCss('#csv')), credentials: BROWSER });
    const [data] = await new Playwright().execute.call(h as unknown as IExecuteFunctions);
    expect(data[0].json).toMatchObject({ fileName: 'report.csv' });
  });
});
