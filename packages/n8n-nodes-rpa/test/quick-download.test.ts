import { describe, expect, it } from 'vitest';
import type { IBinaryData, IDataObject, INodeProperties } from 'n8n-workflow';
import { DEFAULT_MIME, MIME } from 'n8n-rpa-engine';
import { DEFAULT_FILE_TYPES, downloadProperties, FILE_TYPES } from '../nodes/Playwright/description/download.js';
import { OPERATIONS, properties } from '../nodes/Playwright/description/index.js';
import { COMPILERS, compileQuickOp, executeQuickOp, OUTPUTS, quickFieldNames, type QuickParams } from '../nodes/Playwright/operations/quick.js';
import { compileDownload, downloadOutput } from '../nodes/Playwright/operations/quick/download.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, BROWSER, okResult, optionsFor, PAGE_URL, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const trigger = { locator: { findBy: 'text', text: 'Export CSV' } };
const q = (over: IDataObject = {}, options: IDataObject = {}): QuickParams => ({ url: PAGE_URL, waitUntil: 'load', downloadTrigger: trigger, ...over, options }) as QuickParams;
const downloadOf = (p: QuickParams) =>
  (compileQuickOp('download', p).script.steps.at(-1) as { download: { trigger: unknown; mime: string[]; maxBytes: number; via?: unknown } }).download;
const CSV = { fileName: 'report.csv', mimeType: 'text/csv', data: Buffer.from('code,name\nSKU-1,Widget\n'), binaryName: 'file_1' };

describe('compileQuickOp: download', () => {
  it('defaults: CSV, plain text, PDF and XLSX, 50 MB, never a POST (no via); runnable under the quick policy', () => {
    const c = compileQuickOp('download', q());
    expect(c.script.steps.at(-1)).toEqual({ intent: 'Download the file', download: { trigger: { text: 'Export CSV' }, mime: DEFAULT_FILE_TYPES, maxBytes: 52_428_800 } });
    expect(downloadOf(q()).via).toBeUndefined();
    expect(c.output).toBeUndefined();
    expect(c.vars).toEqual({});
    assertRunnable(c);
  });
  it('listed types and sizes', () => {
    expect(downloadOf(q({}, { allowedFileTypes: ['application/zip', 'application/json'] })).mime).toEqual(['application/zip', 'application/json']);
    expect(downloadOf(q({}, { allowedFileTypes: 'text/csv, image/png' })).mime).toEqual(['text/csv', 'image/png']);
    expect(downloadOf(q({}, { maxFileSizeMb: 200 })).maxBytes).toBe(209_715_200);
    expect(downloadOf(q({}, { maxFileSizeMb: 1 })).maxBytes).toBe(1_048_576);
    expect(downloadOf(q({}, { maxFileSizeMb: 0.00001 })).maxBytes).toBe(10);
    expect(downloadOf(q({}, { maxFileSizeMb: '2' })).maxBytes).toBe(2_097_152);
  });
  it('configuration errors', () => {
    for (const maxFileSizeMb of [0, -1, 201, 'abc']) expect(() => compileDownload(q({}, { maxFileSizeMb }))).toThrow('Max File Size must be more than 0 and at most 200 MB');
    expect(() => compileDownload(q({}, { allowedFileTypes: [] }))).toThrow('Allowed File Types needs at least one type');
    expect(() => compileDownload(q({}, { allowedFileTypes: ['application/x-msdownload'] }))).toThrow('Allowed File Types has an unknown type "application/x-msdownload"');
    expect(() => compileDownload(q({ downloadTrigger: null }))).toThrow('Download Link or Button needs a value');
  });
  it('the file types are exactly the engine MIME constants, and the default is the engine default', () => {
    expect(FILE_TYPES.map((t) => t.value).sort()).toEqual(Object.values(MIME).sort());
    expect(FILE_TYPES.map((t) => t.name)).toEqual(['CSV', 'Plain Text', 'PDF', 'XLSX', 'JSON', 'ZIP', 'PNG', 'JPEG', 'DOCX']);
    expect(DEFAULT_FILE_TYPES).toEqual([MIME.csv, MIME.text, MIME.pdf, XLSX]);
    expect([...DEFAULT_FILE_TYPES].sort()).toEqual([...DEFAULT_MIME].sort());
  });
  it('is registered in COMPILERS and OUTPUTS', () => {
    expect(COMPILERS.download).toBe(compileDownload);
    expect(OUTPUTS.download).toBe(downloadOutput);
  });
});

describe('executeQuickOp: download (fake engine)', () => {
  const params = quickParams('download', { downloadTrigger: trigger });
  it('read-only quick policy: any-host GET sub-resources, block-and-log, no write window, no output checks', async () => {
    const engine = fakeEngine(() => okResult({ files: [CSV] }));
    await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'download');
    const input = engine.calls[0];
    expect(input.policy).toMatchObject({ subresourceHosts: '*', writeMode: 'block', allowedSubmits: [] });
    expect(input.policy.writeWindow).toBeUndefined();
    expect(input.output).toBeUndefined();
    expect(input).toMatchObject({ trust: { required: false }, startStatus: 'report' });
  });
  it('outputs fileName, mimeType and bytes in the documented key order, with the file in binary "file"', async () => {
    const engine = fakeEngine(() => okResult({ files: [CSV] }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'download');
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0].json)).toEqual(['url', 'title', 'status', 'fileName', 'mimeType', 'bytes', 'steps']);
    expect(data[0].json).toMatchObject({ url: PAGE_URL, title: 'Pricing', status: 200, fileName: 'report.csv', mimeType: 'text/csv', bytes: CSV.data.length });
    expect(Object.keys(data[0].binary ?? {})).toEqual(['file']);
    const file = data[0].binary?.file as IBinaryData;
    expect(file).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv' });
    expect(Buffer.from(file.data, 'base64').toString()).toBe('code,name\nSKU-1,Widget\n');
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
  });
  it('Options → Put Output in Field renames the binary', async () => {
    const engine = fakeEngine(() => okResult({ files: [CSV] }));
    const [data] = await executeQuickOp(harness({ params: quickParams('download', { downloadTrigger: trigger }, { fileProperty: 'report' }), credentials: BROWSER }), engine, 'download');
    expect(Object.keys(data[0].binary ?? {})).toEqual(['report']);
  });
  it('a success without a downloaded file is an error, never a silent success', async () => {
    const engine = fakeEngine(() => okResult({ files: [] }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER, continueOnFail: true }), engine, 'download');
    expect(data[0].json.error).toBe('incomplete: the run finished without a downloaded file');
  });
});

describe('Download File description', () => {
  const entries = () => (properties.find((p) => p.name === 'options')?.options ?? []) as INodeProperties[];
  const option = (name: string) => {
    const o = entries().find((x) => x.name === name);
    if (!o) throw new Error(`no option ${name}`);
    return o;
  };
  it('lists Download File with its action text', () => {
    expect(OPERATIONS.options).toContainEqual(expect.objectContaining({ name: 'Download File', value: 'download', action: 'Download a file from a page' }));
  });
  it('has the Download Link or Button locator, required, shown only for Download File; readQuickParams reads exactly it', () => {
    expect(downloadProperties.map((p) => p.name)).toEqual(['downloadTrigger']);
    expect(quickFieldNames('download')).toEqual(['downloadTrigger']);
    expect(properties.find((x) => x.name === 'downloadTrigger')).toMatchObject({
      displayName: 'Download Link or Button', type: 'fixedCollection', required: true, displayOptions: { show: { operation: ['download'] } },
    });
  });
  it('Options: the quick options plus Allowed File Types, Max File Size and Put Output in Field', () => {
    expect(optionsFor('download').sort()).toEqual([...QUICK_COMMON_OPTIONS, 'allowedFileTypes', 'maxFileSizeMb', 'fileProperty'].sort());
    expect(option('allowedFileTypes')).toMatchObject({ type: 'multiOptions', default: DEFAULT_FILE_TYPES, displayOptions: { show: { '/operation': ['download'] } } });
    expect(option('allowedFileTypes').options).toEqual(FILE_TYPES.map((t) => ({ name: t.name, value: t.value })));
    expect(option('maxFileSizeMb')).toMatchObject({ type: 'number', default: 50, typeOptions: { maxValue: 200 } });
    expect(option('fileProperty')).toMatchObject({ displayName: 'Put Output in Field', default: 'file' });
  });
  it('has no use-case words', () => {
    const texts = [...downloadProperties, option('allowedFileTypes'), option('maxFileSizeMb'), option('fileProperty')]
      .flatMap((p) => [p.displayName, p.description, p.hint, p.placeholder]).filter((t): t is string => typeof t === 'string');
    expect(texts.length).toBeGreaterThan(4);
    for (const t of texts) expect(t).not.toMatch(USE_CASE_WORDS);
  });
});

describe('executeQuickOp: download refuses a CDP browser connection', () => {
  const params = quickParams('download', { downloadTrigger: trigger });
  const MESSAGE =
    'Downloads need the Browser Server or Local Browser mode: a Chrome DevTools Protocol (CDP) connection cannot read downloaded files. Pick an RPA Browser credential in Browser Server mode for this node.';
  it('is a configuration error before the browser opens', async () => {
    const engine = fakeEngine(() => okResult({ files: [CSV] }));
    const [data] = await executeQuickOp(
      harness({ params, credentials: { playwrightBrowserApi: { mode: 'cdp', wsUrl: 'wss://cdp.example.net/' } }, continueOnFail: true }), engine, 'download');
    expect(data[0].json.error).toBe(MESSAGE);
    expect(engine.calls).toHaveLength(0);
  });
});
