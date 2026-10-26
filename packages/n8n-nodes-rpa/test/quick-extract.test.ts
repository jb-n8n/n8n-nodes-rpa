import { describe, expect, it } from 'vitest';
import type { IDataObject, INodeProperties, INodePropertyCollection, INodePropertyOptions } from 'n8n-workflow';
import { OPERATIONS, properties } from '../nodes/Playwright/description/index.js';
import { ATTRIBUTE_OPTIONS, extractProperties, FIELD_LOCATION } from '../nodes/Playwright/description/extract.js';
import { locatorGroupValues } from '../nodes/Playwright/description/locator.js';
import { COMPILERS, compileQuickOp, executeQuickOp, OUTPUTS, quickFieldNames, type QuickParams, type QuickRun } from '../nodes/Playwright/operations/quick.js';
import { compileExtract, extractOutput } from '../nodes/Playwright/operations/quick/extract.js';
import { extractItems } from '../nodes/Playwright/output.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, BROWSER, okResult, optionsFor, PAGE_URL, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
const css = (selector: string) => ({ locator: { findBy: 'css', css: selector } });
const q = (over: IDataObject = {}, options: IDataObject = {}): QuickParams =>
  ({ url: PAGE_URL, waitUntil: 'load', shape: 'table', table: css('table.results'), item: null, fields: null, ...over, options }) as QuickParams;
const last = (p: QuickParams) => compileQuickOp('extract', p).script.steps.at(-1);
const LIST_FIELDS = {
  field: [
    { name: 'title', findBy: 'css', css: 'a.title', attribute: 'text' },
    { name: 'link', findBy: 'css', css: 'a.title', attribute: 'href' },
    { name: 'image', findBy: 'css', css: 'img.thumb', attribute: 'src' },
    { name: 'label', findBy: 'css', css: 'img.thumb', attribute: 'aria-label' },
  ],
};
const ROWS3 = [
  { id: 'SKU-1001', Code: 'SKU-1001', Product: 'Widget' },
  { id: 'SKU-1002', Code: 'SKU-1002', Product: 'Gadget' },
  { id: 'SKU-1003', Code: 'SKU-1003', Product: 'Gizmo' },
];
const BLOCKED = [{ method: 'POST', host: 'collector.example.net', path: '/collect' }];
const PRODUCTS = { url: PAGE_URL, title: 'Products', status: 200 };

describe('compileQuickOp: extract', () => {
  it('Table: one extractTable step after the open step, no output checks, runnable under the quick policy', () => {
    const c = compileQuickOp('extract', q());
    expect(c).toEqual({
      script: { steps: [{ intent: 'Open the page', goto: PAGE_URL, waitUntil: 'load' }, { intent: 'Read the table', extractTable: { table: { css: 'table.results' } } }] },
      vars: {},
    });
    assertRunnable(c);
  });
  it('Table with ID Pattern, Stated Total Pattern and Text That Means No Results fills the step and the output', () => {
    const c = compileQuickOp('extract', q({}, { idPattern: 'SKU-\\d{4}', totalPattern: 'Showing (\\d+) results', emptyPattern: 'No results found' }));
    expect(c.script.steps.at(-1)).toEqual({ intent: 'Read the table', extractTable: { table: { css: 'table.results' }, idPattern: 'SKU-\\d{4}' } });
    expect(c.output).toEqual({ idPattern: 'SKU-\\d{4}', totalPattern: 'Showing (\\d+) results', emptyPattern: 'No results found' });
    assertRunnable(c);
  });
  it('Table ignores Required Fields (it is a List of Items option)', () => {
    expect(compileQuickOp('extract', q({}, { requiredFields: 'Price' })).output).toBeUndefined();
  });
  it('List of Items: the item scope is the page body; attribute is left out for Text and kept otherwise', () => {
    const p = q({ shape: 'list', table: null, item: css('li.item'), fields: LIST_FIELDS });
    expect(last(p)).toEqual({
      intent: 'Read the list',
      extract: {
        scope: { css: 'body' },
        item: { css: 'li.item' },
        fields: {
          title: { locator: { css: 'a.title' } },
          link: { locator: { css: 'a.title' }, attribute: 'href' },
          image: { locator: { css: 'img.thumb' }, attribute: 'src' },
          label: { locator: { css: 'img.thumb' }, attribute: 'aria-label' },
        },
      },
    });
    assertRunnable(compileQuickOp('extract', p));
  });
  it('List of Items without Fields reads each item text into a field named text', () => {
    expect(last(q({ shape: 'list', item: css('li.item') }))).toEqual({
      intent: 'Read the list', extract: { scope: { css: 'body' }, item: { css: 'li.item' }, fields: { text: { pattern: '[\\s\\S]+' } } },
    });
  });
  it('List of Items with ID Pattern and Required Fields', () => {
    const c = compileQuickOp('extract', q({ shape: 'list', item: css('li.item'), fields: LIST_FIELDS }, { idPattern: 'SKU-\\d{4}', requiredFields: 'title, link' }));
    expect((c.script.steps.at(-1) as { extract: { idPattern?: string } }).extract.idPattern).toBe('SKU-\\d{4}');
    expect(c.output).toEqual({ idPattern: 'SKU-\\d{4}', requiredFields: ['title', 'link'] });
  });
  it('Next Page and Max Pages wrap the read step in paginate (until absent; default 10 pages)', () => {
    expect(last(q({}, { nextPage: { locator: { findBy: 'text', text: 'Next page' } }, maxPages: 3 }))).toEqual({
      intent: 'Read every page',
      paginate: { next: { text: 'Next page' }, until: 'absent', max: 3, each: [{ intent: 'Read the table', extractTable: { table: { css: 'table.results' } } }] },
    });
    expect((last(q({}, { nextPage: css('a.next') })) as { paginate: { max: number } }).paginate.max).toBe(10);
    assertRunnable(compileQuickOp('extract', q({}, { nextPage: css('a.next') })));
  });
  it('configuration errors', () => {
    expect(() => compileExtract(q({}, { idPattern: '(' }))).toThrow(/^ID Pattern is not a valid regular expression: .+\. Example: INV-\\d\{4\}\.$/);
    expect(() => compileExtract(q({}, { totalPattern: '[' }))).toThrow(/^Stated Total Pattern is not a valid regular expression/);
    expect(() => compileExtract(q({}, { emptyPattern: '.*' }))).toThrow('Text That Means No Results (Regex) must not match empty text: use the page\'s own "no results" wording');
    for (const maxPages of [0, 101, 2.5, 'abc']) expect(() => compileExtract(q({}, { nextPage: css('a.next'), maxPages }))).toThrow('Max Pages must be a whole number from 1 to 100');
    expect(() => compileExtract(q({ shape: 'grid' }))).toThrow('Shape must be Table or List of Items');
    expect(() => compileExtract(q({}, { outputMode: 'columns' }))).toThrow('Output must be One Item per Row or All Rows in One Item');
    expect(() => compileExtract(q({ table: null }))).toThrow('Table needs a value');
    expect(() => compileExtract(q({ shape: 'list' }))).toThrow('Item needs a value');
    const list = (entries: IDataObject[], options: IDataObject = {}) => compileExtract(q({ shape: 'list', item: css('li.item'), fields: { field: entries } }, options));
    expect(() => list([{ name: ' ', findBy: 'css', css: 'a' }])).toThrow('Field 1 needs a name');
    expect(() => list([{ name: 'a', findBy: 'css', css: 'a' }, { name: 'a', findBy: 'css', css: 'b' }])).toThrow('Field name "a" is used twice');
    // _meta holds the page facts; the engine de-duplicates on any row.id (with or without an ID Pattern); the last three
    // would reach Object.prototype through the fields record.
    for (const name of ['_meta', 'id', '__proto__', 'constructor', 'prototype']) {
      expect(() => list([{ name, findBy: 'css', css: 'a' }])).toThrow(`Field name "${name}" is reserved`);
      expect(() => list([{ name, findBy: 'css', css: 'a' }], { idPattern: 'A-\\d+' })).toThrow(`Field name "${name}" is reserved`);
    }
    expect(() => list([{ name: 'v', findBy: 'css', css: 'input', attribute: 'value' }])).toThrow('Attribute must be one of text, href, src, title, alt or aria-label');
    expect(() => list([{ name: 'v', findBy: 'css', css: '' }])).toThrow('Field "v" needs a value');
    expect(() => list([{ name: 'title', findBy: 'css', css: 'a' }], { requiredFields: 'price' })).toThrow('Required Fields lists "price", which is not one of the Fields');
  });
  it('is registered in COMPILERS and OUTPUTS', () => {
    expect(COMPILERS.extract).toBe(compileExtract);
    expect(OUTPUTS.extract).toBe(extractOutput);
  });
});

describe('extractItems', () => {
  const compiled = compileQuickOp('extract', q({}, { totalPattern: 'Showing (\\d+) results' }));
  it('confirmed is false without a Stated Total Pattern, even if an engine result claimed it', () => {
    const unchecked = compileQuickOp('extract', q());
    const result = okResult({ rows: ROWS3, confirmed: true });
    expect(extractItems(result, unchecked, 'rowPerItem').map((i) => (i.json._meta as IDataObject).confirmed)).toEqual([false, false, false]);
    expect(extractItems(result, unchecked, 'allInOne')[0].json.confirmed).toBe(false);
    expect(extractItems(okResult({ rows: ROWS3, confirmed: false }), compiled, 'allInOne')[0].json.confirmed).toBe(false);
  });
  it('One Item per Row: the row fields plus _meta; only the first row carries steps and blockedRequests', () => {
    const items = extractItems(okResult({ page: PRODUCTS, rows: ROWS3, confirmed: true, blockedRequests: BLOCKED }), compiled, 'rowPerItem');
    expect(items).toHaveLength(3);
    expect(items[0].json).toEqual({ ...ROWS3[0], _meta: { ...PRODUCTS, rowCount: 3, confirmed: true, row: 1, steps: compiled.script, blockedRequests: BLOCKED } });
    expect(items[1].json).toEqual({ ...ROWS3[1], _meta: { ...PRODUCTS, rowCount: 3, confirmed: true, row: 2 } });
    expect(items.every((i) => i.pairedItem === undefined)).toBe(true); // executeQuickOp pairs them
  });
  it('no blockedRequests key when nothing was blocked', () => {
    const [first] = extractItems(okResult({ rows: ROWS3 }), compiled, 'rowPerItem');
    expect(first.json._meta).not.toHaveProperty('blockedRequests');
    expect(first.json._meta).toHaveProperty('steps');
  });
  it('All Rows in One Item: the envelope plus rows, rowCount and confirmed', () => {
    expect(extractItems(okResult({ page: PRODUCTS, rows: ROWS3, confirmed: true }), compiled, 'allInOne')).toEqual([
      { json: { ...PRODUCTS, steps: compiled.script, rows: ROWS3, rowCount: 3, confirmed: true } },
    ]);
  });
  it('All Rows in One Item puts the operation fields before steps and blockedRequests', () => {
    const [item] = extractItems(okResult({ page: PRODUCTS, rows: ROWS3, confirmed: true, blockedRequests: BLOCKED }), compiled, 'allInOne');
    expect(Object.keys(item.json)).toEqual(['url', 'title', 'status', 'rows', 'rowCount', 'confirmed', 'steps', 'blockedRequests']);
  });
  it('One Item per Row renames a row key _meta to the next free _meta_<n>, in place, before adding the page facts', () => {
    const rows: Record<string, string>[] = [{ Code: 'A-1', _meta: 'column one', _meta_2: 'column two' }, { Code: 'A-2', _meta: 'x' }];
    const items = extractItems(okResult({ rows }), compiled, 'rowPerItem');
    expect(Object.keys(items[0].json)).toEqual(['Code', '_meta_3', '_meta_2', '_meta']);
    expect(items[0].json).toMatchObject({ _meta_3: 'column one', _meta_2: 'column two', _meta: { row: 1, rowCount: 2 } });
    expect(items[1].json).toMatchObject({ Code: 'A-2', _meta_2: 'x', _meta: { row: 2 } });
    expect(rows[0]).toEqual({ Code: 'A-1', _meta: 'column one', _meta_2: 'column two' }); // the engine's rows are not mutated
  });
  it('a zero-row success is one item with rowCount 0 in both modes', () => {
    expect(extractItems(okResult({ page: PRODUCTS }), compiled, 'rowPerItem')).toEqual([
      { json: { _meta: { ...PRODUCTS, rowCount: 0, confirmed: false, row: null, steps: compiled.script } } },
    ]);
    expect(extractItems(okResult(), compiled, 'allInOne')[0].json).toMatchObject({ rows: [], rowCount: 0, confirmed: false });
  });
  it('extractOutput reads Output from the options', async () => {
    const run = (outputMode?: string): QuickRun => ({ op: 'extract', params: q({}, outputMode ? { outputMode } : {}), compiled, result: okResult({ rows: ROWS3 }) });
    expect(await extractOutput(harness({ params: {} }), run())).toHaveLength(3);
    expect(await extractOutput(harness({ params: {} }), run('allInOne'))).toHaveLength(1);
  });
});

describe('executeQuickOp: extract (fake engine)', () => {
  const tableParams = quickParams('extract', { shape: 'table', table: css('table.results') }, { idPattern: 'SKU-\\d{4}' });
  const emptyListParams = quickParams('extract', { url: 'https://example.com/empty', shape: 'list', item: css('li.item') }, { emptyPattern: 'No results found' });
  it('passes the compiled steps, the output checks, no trust requirement and status reporting to the engine', async () => {
    const engine = fakeEngine(() => okResult({ rows: ROWS3 }));
    await executeQuickOp(harness({ params: tableParams, credentials: BROWSER }), engine, 'extract');
    const input = engine.calls[0];
    expect(input).toMatchObject({ trust: { required: false }, startStatus: 'report', output: { idPattern: 'SKU-\\d{4}' } });
    expect((input.script as { steps: unknown[] }).steps.at(-1)).toEqual({ intent: 'Read the table', extractTable: { table: { css: 'table.results' }, idPattern: 'SKU-\\d{4}' } });
    expect(input.policy.subresourceHosts).toBe('*');
    expect(input.policy.writeWindow).toBeUndefined();
  });
  it('two input items with 3 and 0 rows give 4 items, three paired to item 0 and one rowCount 0 item paired to item 1', async () => {
    const engine = fakeEngine((_input, call) =>
      call === 0 ? okResult({ page: PRODUCTS, rows: ROWS3, confirmed: true, blockedRequests: BLOCKED }) : okResult({ page: { url: 'https://example.com/empty', title: 'Empty', status: 200 } }));
    const h = harness({ items: [{ json: {} }, { json: {} }], credentials: BROWSER, params: (i) => (i === 0 ? tableParams : emptyListParams) });
    const [data] = await executeQuickOp(h, engine, 'extract');
    expect(engine.calls[1].output).toEqual({ emptyPattern: 'No results found' });
    expect(data).toHaveLength(4);
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 0 }], [{ item: 0 }], [{ item: 1 }]]);
    const metas = data.map((d) => d.json._meta as IDataObject);
    expect(metas.map((m) => m.rowCount)).toEqual([3, 3, 3, 0]);
    expect(metas.map((m) => 'steps' in m)).toEqual([true, false, false, true]);
    expect(metas.map((m) => 'blockedRequests' in m)).toEqual([true, false, false, false]);
    expect(metas[0].blockedRequests).toEqual(BLOCKED);
    expect(metas[3]).toMatchObject({ url: 'https://example.com/empty', row: null, confirmed: false });
    expect(Object.keys(data[3].json)).toEqual(['_meta']);
  });
  it('a kept trace goes on the first row item only', async () => {
    const engine = fakeEngine(() => okResult({ rows: ROWS3, trace: Buffer.from('PK') }));
    const [data] = await executeQuickOp(harness({ params: { ...tableParams, options: { saveTrace: 'always' } }, credentials: BROWSER }), engine, 'extract');
    expect(data.map((d) => Object.keys(d.binary ?? {}))).toEqual([['trace'], [], []]);
  });
  it('All Rows in One Item gives one item per input item', async () => {
    const engine = fakeEngine(() => okResult({ rows: ROWS3, confirmed: true }));
    const [data] = await executeQuickOp(harness({ params: { ...tableParams, options: { outputMode: 'allInOne', totalPattern: 'Showing (\\d+) results', saveTrace: 'never' } }, credentials: BROWSER }), engine, 'extract');
    expect(data).toHaveLength(1);
    expect(data[0].json).toMatchObject({ rowCount: 3, confirmed: true, rows: ROWS3 });
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
  });
  it('a bad ID Pattern is a configuration error and never reaches the engine', async () => {
    const engine = fakeEngine(() => okResult());
    const [data] = await executeQuickOp(harness({ params: { ...tableParams, options: { idPattern: '(' } }, credentials: BROWSER, continueOnFail: true }), engine, 'extract');
    expect(engine.calls).toHaveLength(0);
    expect(JSON.stringify(data[0].json)).toContain('"configError":true');
    expect(String(data[0].json.message)).toMatch(/^ID Pattern is not a valid regular expression/);
  });
});

describe('Extract Data description', () => {
  const byName = (name: string) => properties.find((p) => p.name === name);
  const entries = () => (byName('options')?.options ?? []) as INodeProperties[];
  const option = (name: string) => {
    const o = entries().find((x) => x.name === name);
    if (!o) throw new Error(`no option ${name}`);
    return o;
  };
  const uiTexts = (node: unknown, out: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const n of node) uiTexts(n, out);
      return out;
    }
    if (typeof node !== 'object' || node === null) return out;
    const o = node as Record<string, unknown>;
    for (const k of ['displayName', 'description', 'hint', 'placeholder', 'action']) if (typeof o[k] === 'string') out.push(o[k] as string);
    if ('value' in o && typeof o.name === 'string') out.push(o.name);
    for (const k of ['options', 'values']) if (k in o) uiTexts(o[k], out);
    return out;
  };

  it('lists Extract Data with its action text', () => {
    expect(OPERATIONS.options).toContainEqual(expect.objectContaining({ name: 'Extract Data', value: 'extract', action: 'Extract a table or list from a page' }));
  });
  it('has Shape, Table, Item and Fields, each shown only for Extract Data and its shape; readQuickParams reads exactly these', () => {
    expect(extractProperties.map((p) => p.name)).toEqual(['shape', 'table', 'item', 'fields']);
    expect(quickFieldNames('extract')).toEqual(['shape', 'table', 'item', 'fields']);
    for (const p of extractProperties) expect(byName(p.name)).toBe(p);
    expect(byName('shape')).toMatchObject({ default: 'table', noDataExpression: true, displayOptions: { show: { operation: ['extract'] } } });
    expect((byName('shape')?.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['Table', 'table'], ['List of Items', 'list']]);
    expect(byName('table')?.displayOptions?.show).toEqual({ operation: ['extract'], shape: ['table'] });
    expect(byName('item')?.displayOptions?.show).toEqual({ operation: ['extract'], shape: ['list'] });
    expect(byName('fields')?.displayOptions?.show).toEqual({ operation: ['extract'], shape: ['list'] });
  });
  it('each Field has a name, the locator inputs (described as inside each item) and an attribute that is never value', () => {
    const group = ((byName('fields')?.options ?? []) as INodePropertyCollection[])[0];
    expect(group.name).toBe('field');
    const names = group.values.map((v) => v.name);
    expect(names).toEqual(['name', ...locatorGroupValues().map((v) => v.name), 'attribute']);
    expect(group.values.find((v) => v.name === 'findBy')?.description).toBe(FIELD_LOCATION);
    const attribute = group.values.find((v) => v.name === 'attribute');
    expect(attribute?.default).toBe('text');
    expect(ATTRIBUTE_OPTIONS.map((o) => o.value)).toEqual(['text', 'href', 'src', 'title', 'alt', 'aria-label']);
    expect(attribute?.options).toBe(ATTRIBUTE_OPTIONS);
  });
  it('Options: the quick options, Output, Next Page, Max Pages, and the four row checks shared with Run Steps', () => {
    expect(optionsFor('extract').sort()).toEqual(
      [...QUICK_COMMON_OPTIONS, 'outputMode', 'nextPage', 'maxPages', 'idPattern', 'totalPattern', 'requiredFields', 'emptyPattern'].sort(),
    );
    expect(option('outputMode')).toMatchObject({ displayName: 'Output', default: 'rowPerItem', displayOptions: { show: { '/operation': ['extract'] } } });
    expect((option('outputMode').options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['One Item per Row', 'rowPerItem'], ['All Rows in One Item', 'allInOne']]);
    expect(option('nextPage')).toMatchObject({ displayName: 'Next Page', type: 'fixedCollection', displayOptions: { show: { '/operation': ['extract'] } } });
    expect(option('maxPages')).toMatchObject({ displayName: 'Max Pages', default: 10, typeOptions: { minValue: 1, maxValue: 100 } });
    for (const name of ['idPattern', 'totalPattern', 'emptyPattern']) expect(option(name).displayOptions?.show).toEqual({ '/operation': ['extract', 'runSteps'] });
    expect(option('requiredFields').displayOptions).toEqual({ show: { '/operation': ['extract', 'runSteps'] }, hide: { '/shape': ['table'] } });
    expect(optionsFor('runSteps')).toEqual(expect.arrayContaining(['idPattern', 'totalPattern', 'requiredFields', 'emptyPattern']));
  });
  it('has no use-case words', () => {
    const texts = uiTexts([...extractProperties, option('outputMode'), option('nextPage'), option('maxPages')]);
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) expect(t).not.toMatch(USE_CASE_WORDS);
  });
});
