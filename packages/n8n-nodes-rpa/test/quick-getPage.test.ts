import { describe, expect, it } from 'vitest';
import type { INodePropertyOptions } from 'n8n-workflow';
import { properties } from '../nodes/Playwright/description/index.js';
import { compileQuickOp, executeQuickOp, quickFieldNames, type QuickParams } from '../nodes/Playwright/operations/quick.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, BROWSER, okResult, optionsFor, PAGE_URL, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const base: QuickParams = { url: PAGE_URL, waitUntil: 'load', options: {} };
const OPEN = { intent: 'Open the page', goto: PAGE_URL, waitUntil: 'load' };
const read = (over: { text?: string; html?: string; truncated?: boolean }) => ({ index: 1, verb: 'read' as const, ...over });
const run = (pageContent: string | undefined, result: ReturnType<typeof okResult>, continueOnFail = false) =>
  executeQuickOp(
    harness({ params: quickParams('getPage', pageContent === undefined ? {} : { pageContent }), credentials: BROWSER, continueOnFail }),
    fakeEngine(() => result),
    'getPage',
  );

describe('compileQuickOp: getPage', () => {
  it('Text (default) reads the visible text', () => {
    const c = compileQuickOp('getPage', { ...base, pageContent: null });
    expect(c).toEqual({ script: { steps: [OPEN, { intent: 'Read the page text', read: { what: 'text' } }] }, vars: {} });
    assertRunnable(c);
  });
  it('HTML reads the page HTML', () => {
    const c = compileQuickOp('getPage', { ...base, pageContent: 'html' });
    expect(c.script.steps).toEqual([OPEN, { intent: 'Read the page HTML', read: { what: 'html' } }]);
    assertRunnable(c);
  });
  it('Title and URL Only opens the page and adds no step', () => {
    const c = compileQuickOp('getPage', { ...base, pageContent: 'titleUrl' });
    expect(c.script.steps).toEqual([OPEN]);
    assertRunnable(c);
  });
  it('an unknown Return value is a configuration error', () => {
    expect(() => compileQuickOp('getPage', { ...base, pageContent: 'pdf' })).toThrow('Return must be Text, HTML or Title and URL Only');
  });
});

describe('Get Page output (fake engine)', () => {
  it('Text: the envelope plus text, in the documented key order', async () => {
    const [[item]] = await run('text', okResult({ outputs: [read({ text: 'Hello page' })] }));
    expect(item.json).toEqual({ url: PAGE_URL, title: 'Pricing', status: 200, text: 'Hello page', steps: compileQuickOp('getPage', { ...base, pageContent: 'text' }).script });
    expect(Object.keys(item.json)).toEqual(['url', 'title', 'status', 'text', 'steps']);
    expect(item.binary).toBeUndefined();
  });
  it('HTML: html instead of text', async () => {
    const [[item]] = await run('html', okResult({ outputs: [read({ html: '<html><body>Hi</body></html>' })] }));
    expect(item.json.html).toBe('<html><body>Hi</body></html>');
    expect(item.json).not.toHaveProperty('text');
  });
  it('a capped text carries truncated: true', async () => {
    const [[item]] = await run(undefined, okResult({ outputs: [read({ text: 'lorem ', truncated: true })] }));
    expect(Object.keys(item.json)).toEqual(['url', 'title', 'status', 'text', 'truncated', 'steps']);
    expect(item.json.truncated).toBe(true);
  });
  it('Title and URL Only: the envelope alone', async () => {
    const [[item]] = await run('titleUrl', okResult({ page: { url: `${PAGE_URL}?ref=1`, title: 'Pricing', status: 200 } }));
    expect(Object.keys(item.json)).toEqual(['url', 'title', 'status', 'steps']);
    expect(item.json.url).toBe(`${PAGE_URL}?ref=1`);
  });
  it('a missing read output is an error, never an empty success', async () => {
    const [[item]] = await run('text', okResult({ outputs: [] }), true);
    expect(item.json.error).toBe('incomplete: the run finished without the page text');
  });
});

describe('Get Page description', () => {
  it('Return: Text (default), HTML, Title and URL Only', () => {
    const p = properties.find((x) => x.name === 'pageContent');
    expect(p).toMatchObject({ displayName: 'Return', type: 'options', default: 'text', displayOptions: { show: { operation: ['getPage'] } } });
    expect((p?.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['Text', 'text'], ['HTML', 'html'], ['Title and URL Only', 'titleUrl']]);
  });
  it('reads exactly the Return field and shows only the quick options', () => {
    expect(quickFieldNames('getPage')).toEqual(['pageContent']);
    expect(optionsFor('getPage').sort()).toEqual([...QUICK_COMMON_OPTIONS].sort());
  });
});
