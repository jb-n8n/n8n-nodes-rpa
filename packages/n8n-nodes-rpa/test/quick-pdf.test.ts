import { describe, expect, it } from 'vitest';
import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { properties } from '../nodes/Playwright/description/index.js';
import { compileQuickOp, executeQuickOp, quickFieldNames, type QuickParams } from '../nodes/Playwright/operations/quick.js';
import { quickEnvelope } from '../nodes/Playwright/output.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, binaryOf, BROWSER, failResult, okResult, optionsFor, PAGE_URL, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const base: QuickParams = { url: PAGE_URL, waitUntil: 'load', options: {} };
const OPEN = { intent: 'Open the page', goto: PAGE_URL, waitUntil: 'load' };
const PDF = Buffer.from('%PDF-1.4\n%test\n');
const pdfOut = { index: 1, verb: 'pdf' as const, binary: { name: 'pdf_1', fileName: 'pdf_1.pdf', mimeType: 'application/pdf', data: PDF } };

describe('compileQuickOp: pdf', () => {
  it('A4 (default), no background', () => {
    const c = compileQuickOp('pdf', { ...base, paper: null });
    expect(c).toEqual({ script: { steps: [OPEN, { intent: 'Save the page as PDF', pdf: { paper: 'A4', background: false } }] }, vars: {} });
    assertRunnable(c);
  });
  it('Letter', () => {
    expect(compileQuickOp('pdf', { ...base, paper: 'Letter' }).script.steps[1]).toEqual({ intent: 'Save the page as PDF', pdf: { paper: 'Letter', background: false } });
  });
  it('Options → Print Background turns on background', () => {
    const c = compileQuickOp('pdf', { ...base, paper: 'A4', options: { printBackground: true } });
    expect(c.script.steps[1]).toEqual({ intent: 'Save the page as PDF', pdf: { paper: 'A4', background: true } });
    assertRunnable(c);
  });
  it('Put Output in Field "trace" is a configuration error', () => {
    expect(() => compileQuickOp('pdf', { ...base, paper: 'A4', options: { pdfProperty: 'trace' } })).toThrow('must not be "trace"');
  });
  it('an unknown paper size is a configuration error', () => {
    expect(() => compileQuickOp('pdf', { ...base, paper: 'A3' })).toThrow('Paper must be A4 or Letter');
  });
});

describe('Save as PDF output (fake engine)', () => {
  it('puts the PDF under binary "pdf" with the envelope as json', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [pdfOut] }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('pdf'), credentials: BROWSER }), engine, 'pdf');
    expect(Object.keys(item.binary ?? {})).toEqual(['pdf']);
    expect(item.binary?.pdf.mimeType).toBe('application/pdf');
    expect(binaryOf(item, 'pdf').equals(PDF)).toBe(true);
    expect(item.json).toEqual(quickEnvelope(okResult(), compileQuickOp('pdf', base)));
    expect(engine.calls[0].script).toEqual(compileQuickOp('pdf', base).script);
  });
  it('Options → Put Output in Field renames the binary', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [pdfOut] }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('pdf', {}, { pdfProperty: 'invoice' }), credentials: BROWSER }), engine, 'pdf');
    expect(Object.keys(item.binary ?? {})).toEqual(['invoice']);
  });
  it('a headed or CDP browser fails incomplete with "Save as PDF needs headless Chromium"', async () => {
    const engine = fakeEngine(() => failResult('incomplete', 'Save as PDF needs headless Chromium'));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('pdf'), credentials: BROWSER, continueOnFail: true }), engine, 'pdf');
    expect(item.json.error).toBe('incomplete: Save as PDF needs headless Chromium');
    await expect(executeQuickOp(harness({ params: quickParams('pdf'), credentials: BROWSER }), engine, 'pdf')).rejects.toThrow(
      'incomplete: Save as PDF needs headless Chromium',
    );
  });
  it('a missing PDF output is an error, never a silent success', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [] }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('pdf'), credentials: BROWSER, continueOnFail: true }), engine, 'pdf');
    expect(item.json.error).toBe('incomplete: the run finished without a pdf output');
  });
});

describe('Save as PDF description', () => {
  it('Paper: A4 (default) or Letter', () => {
    const p = properties.find((x) => x.name === 'paper');
    expect(p).toMatchObject({ displayName: 'Paper', type: 'options', default: 'A4', displayOptions: { show: { operation: ['pdf'] } } });
    expect((p?.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['A4', 'A4'], ['Letter', 'Letter']]);
  });
  it('reads exactly Paper; options are the quick options plus Print Background and Put Output in Field', () => {
    expect(quickFieldNames('pdf')).toEqual(['paper']);
    expect(optionsFor('pdf').sort()).toEqual([...QUICK_COMMON_OPTIONS, 'printBackground', 'pdfProperty'].sort());
    const entries = properties.find((x) => x.name === 'options')?.options as INodeProperties[];
    expect(entries.find((o) => o.name === 'printBackground')).toMatchObject({ displayName: 'Print Background', type: 'boolean', default: false });
    expect(entries.find((o) => o.name === 'pdfProperty')).toMatchObject({ displayName: 'Put Output in Field', type: 'string', default: 'pdf' });
  });
});
