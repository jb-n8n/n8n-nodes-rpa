import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { executeQuickOp } from '../nodes/Playwright/operations/quick.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { harness, type HarnessOptions } from './harness.js';
import { BROWSER, quickParams } from './quick-fixtures.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const css = (selector: string) => ({ locator: { findBy: 'css', css: selector } });
/** Extract Data on a sandbox page, Allow Private Network on (the sandbox runs on 127.0.0.1). */
const params = (path: string, fields: IDataObject, options: IDataObject = {}) =>
  quickParams('extract', { url: `${portal.url}${path}`, shape: 'table', ...fields }, { allowPrivateNetwork: true, timeout: 5, ...options });
const table = (path: string, selector: string, options: IDataObject = {}) => params(path, { table: css(selector) }, options);
const LIST_FIELDS = {
  field: [
    { name: 'title', findBy: 'css', css: 'a.title', attribute: 'text' },
    { name: 'link', findBy: 'css', css: 'a.title', attribute: 'href' },
    { name: 'image', findBy: 'css', css: 'img.thumb', attribute: 'src' },
    { name: 'code', findBy: 'css', css: 'span.code', attribute: 'text' },
    { name: 'price', findBy: 'css', css: 'span.price', attribute: 'text' },
  ],
};
const list = (path: string, options: IDataObject = {}) => params(path, { shape: 'list', item: css('li.item'), fields: LIST_FIELDS }, options);
async function run(p: HarnessOptions['params'], items?: INodeExecutionData[]): Promise<INodeExecutionData[]> {
  const [data] = await executeQuickOp(harness({ params: p, items, credentials: BROWSER, continueOnFail: true }), engine, 'extract');
  return data;
}
const failed = (item: INodeExecutionData, code: string): string => {
  expect(String(item.json.error)).toMatch(new RegExp(`^${code}: `));
  return String(item.json.message);
};
const rowOf = (item: INodeExecutionData): IDataObject => {
  const { _meta: _ignored, ...row } = item.json;
  return row;
};
const TABLE_ROWS = [
  { Code: 'SKU-1001', Product: 'Widget', Price: '$10.00', Stock: '12' },
  { Code: 'SKU-1002', Product: 'Gadget', Price: '$12.50', Stock: '0' },
  { Code: 'SKU-1003', Product: 'Gizmo', Price: '$7.25', Stock: '5' },
];

describe('Extract Data against the sandbox (real engine)', () => {
  it('/public/table: three rows keyed by the headers and by ID, confirmed by the stated total', async () => {
    const data = await run(table('/public/table', 'table.results', { idPattern: 'SKU-\\d{4}', totalPattern: 'Showing (\\d+) results' }));
    expect(data).toHaveLength(3);
    expect(data.map(rowOf)).toEqual(TABLE_ROWS.map((r) => ({ id: r.Code, ...r })));
    expect(data[0].json._meta).toMatchObject({ url: `${portal.url}/public/table`, status: 200, rowCount: 3, confirmed: true, row: 1 });
    expect(data[0].json._meta).toHaveProperty('steps');
    expect(data[1].json._meta).not.toHaveProperty('steps');
    // confirmed false here means extractTable records no page evidence: fix it in the engine.
  });
  it('/public/table without a Stated Total Pattern is not confirmed, and rows have no id key without an ID Pattern', async () => {
    const data = await run(table('/public/table', 'table.results'));
    expect(data.map(rowOf)).toEqual(TABLE_ROWS);
    expect(data.every((d) => (d.json._meta as IDataObject).confirmed === false)).toBe(true);
  });
  it('the steps in _meta paste into Run Steps unchanged and read the same rows', async () => {
    const [first] = await run(table('/public/table', 'table.results', { idPattern: 'SKU-\\d{4}' }));
    const steps = (first.json._meta as IDataObject).steps;
    const [runData] = await executeRunSteps(harness({
      credentials: BROWSER, continueOnFail: true,
      params: {
        operation: 'runSteps', steps: JSON.stringify(steps), startUrl: `${portal.url}/public/table`, requireSignedSteps: false, signature: '', approvedBy: '',
        aiRepair: false, goal: '', options: { allowPrivateNetwork: true, idPattern: 'SKU-\\d{4}', saveTrace: 'never' },
      },
    }), engine);
    expect(((runData[0].json.rows ?? []) as IDataObject[]).map((r) => r.id)).toEqual(['SKU-1001', 'SKU-1002', 'SKU-1003']);
  });
  it('/public/table-edge: empty header → column_2, duplicate → Name_2, colspan not expanded, missing cells empty', async () => {
    const data = await run(table('/public/table-edge', 'table.edge', { outputMode: 'allInOne' }));
    expect(data).toHaveLength(1);
    expect(data[0].json).toMatchObject({ status: 200, rowCount: 2, confirmed: false });
    expect(data[0].json.rows).toEqual([
      { Name: 'Alpha', column_2: 'wide', Name_2: 'n1', Notes: '' },
      { Name: 'Beta', column_2: 'b2', Name_2: 'b3', Notes: 'b4' },
    ]);
  });
  it('/public/tables-two: a table locator that matches two tables is drift', async () => {
    const [item] = await run(table('/public/tables-two', 'table.results'));
    expect(failed(item, 'drift_detected').endsWith('CSS Selector "table.results" matches 2 elements. Use a more specific locator; it must match exactly one.')).toBe(true);
  });
  it('a locator that is not a table is drift', async () => {
    const [item] = await run(table('/public/table', '#total'));
    expect(failed(item, 'drift_detected').endsWith('CSS Selector "#total" is not a table')).toBe(true);
  });
  it('/public/list over two pages: five rows, absolute href and src, no id key, empty price for the Saucer', async () => {
    const data = await run(list('/public/list?page=1', { nextPage: css('a.next'), maxPages: 10, outputMode: 'allInOne' }));
    expect(data).toHaveLength(1);
    const rows = data[0].json.rows as IDataObject[];
    const item = (n: number, title: string, price: string) => ({
      title, link: `${portal.url}/public/items/SKU-200${n}`, image: `${portal.url}/public/img/SKU-200${n}.png`, code: `SKU-200${n}`, price,
    });
    expect(rows).toEqual([item(1, 'Blue mug', '$4.00'), item(2, 'Red mug', '$4.50'), item(3, 'Green mug', '$5.00'), item(4, 'Tea pot', '$20.00'), item(5, 'Saucer', '')]);
    expect(rows.some((r) => 'id' in r)).toBe(false);
    expect(data[0].json).toMatchObject({ rowCount: 5, confirmed: false });
  });
  it('List of Items with no Fields: each item text goes into a field named text', async () => {
    const data = await run(params('/public/list?page=1', { shape: 'list', item: css('li.item'), fields: {} }, { nextPage: css('a.next') }));
    expect(data.map(rowOf)).toEqual([
      { text: 'Blue mug SKU-2001 $4.00' },
      { text: 'Red mug SKU-2002 $4.50' },
      { text: 'Green mug SKU-2003 $5.00' },
      { text: 'Tea pot SKU-2004 $20.00' },
      { text: 'Saucer SKU-2005' },
    ]);
    expect(data[0].json._meta).toMatchObject({ rowCount: 5, row: 1 });
  });
  it('Max Pages reached with a next page still there is incomplete', async () => {
    const [item] = await run(list('/public/list?page=1', { nextPage: css('a.next'), maxPages: 1 }));
    expect(failed(item, 'incomplete')).toMatch(/still a next page/);
  });
  it('Required Fields price fails the run as incomplete (SKU-2005 has no price)', async () => {
    const [item] = await run(list('/public/list?page=1', { nextPage: css('a.next'), requiredFields: 'price' }));
    expect(failed(item, 'incomplete')).toMatch(/price/);
  });
  it('/public/list-dup: a field locator that matches twice inside one item is drift', async () => {
    const [item] = await run(list('/public/list-dup'));
    expect(failed(item, 'drift_detected').endsWith('CSS Selector "span.price" matches 2 elements. Use a more specific locator; it must match exactly one.')).toBe(true);
  });
  it('/public/list-empty is incomplete, unless Text That Means No Results matches: then one rowCount 0 item', async () => {
    const [none] = await run(list('/public/list-empty', { timeout: 2 }));
    failed(none, 'incomplete');
    const data = await run(list('/public/list-empty', { timeout: 2, emptyPattern: 'No results found' }));
    expect(data).toHaveLength(1);
    expect(data[0].json._meta).toMatchObject({ rowCount: 0, confirmed: false, row: null, status: 200 });
  });
  it('two input items with 3 and 0 rows give 4 items paired to their inputs; steps only on the first item of each run', async () => {
    const data = await run(
      (i) => (i === 0 ? table('/public/table', 'table.results') : list('/public/list-empty', { timeout: 2, emptyPattern: 'No results found' })),
      [{ json: {} }, { json: {} }],
    );
    expect(data).toHaveLength(4);
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 0 }], [{ item: 0 }], [{ item: 1 }]]);
    const metas = data.map((d) => d.json._meta as IDataObject);
    expect(metas.map((m) => m.rowCount)).toEqual([3, 3, 3, 0]);
    expect(metas.map((m) => 'steps' in m)).toEqual([true, false, false, true]);
    expect(metas.some((m) => 'blockedRequests' in m)).toBe(false);
  });
  it('dispatches through the node class', async () => {
    const h = harness({ params: table('/public/table', 'table.results'), credentials: BROWSER });
    const [data] = await new Playwright().execute.call(h as unknown as IExecuteFunctions);
    expect(data).toHaveLength(3);
  });
});
