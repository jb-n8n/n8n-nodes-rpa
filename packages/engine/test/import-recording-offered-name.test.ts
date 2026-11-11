import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importSource } from '../src/import/index.js';
import type { ImportOptions } from '../src/import/types.js';
import { parseDesktopScript } from '../src/steps/parse.js';

// The ERP Demo flow where the person kept the name the Save dialog offers (line-items, its extension hidden as Windows
// hides it by default). The recorder's tests check that it writes exactly this file for that flow.
const OFFERED = fileURLToPath(new URL('./fixtures/import/recording-erp/erp-default-name.rpa-recording.json', import.meta.url));
const TYPED = fileURLToPath(new URL('./fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
const OPTS: ImportOptions = { name: 'erp', hasSiteLogin: false };

const draftOf = (file: string) => {
  const r = importSource('recording', readFileSync(file, 'utf8'), OPTS);
  expect(r.report.items.filter((i) => i.kind === 'error')).toEqual([]);
  expect(r.desktopDrafts).toHaveLength(1);
  return { r, d: r.desktopDrafts![0] };
};

describe('a Save dialog accepted with the name it offers', () => {
  it('imports as the export step and the returned-file step, as a typed name does', () => {
    const { r, d } = draftOf(OFFERED);
    expect(r.report.steps).toBe(17);
    expect(d).toMatchObject({ writeCandidates: [4, 16], variables: ['password'], secretVariables: ['password'] });
    expect(d.script.steps.slice(13).map((s) => s.intent)).toEqual([
      'Wait for the window Export line items',
      'Type into File name:',
      'Click Save',
      'Return the exported file line-items',
    ]);
    expect(d.script.steps[14]).toMatchObject({ fill: { value: '{{$exportDir}}\\line-items' } });
    expect(d.script.steps[16]).toEqual({ intent: 'Return the exported file line-items', expectFile: { pattern: '^line-items(?:\\.[^.]+)?$' } });
    expect(r.report.items.filter((i) => i.kind === 'converted' && i.what === 'Return line-items')).toHaveLength(1);
    expect(parseDesktopScript(d.script)).toEqual(d.script);
  });

  it('the returned-file step finds the file the app wrote, with the extension the dialog added or none', () => {
    const pattern = new RegExp((draftOf(OFFERED).d.script.steps[16] as { expectFile: { pattern: string } }).expectFile.pattern);
    for (const name of ['line-items.csv', 'line-items.xlsx', 'line-items']) expect(pattern.test(name), name).toBe(true);
    for (const name of ['line-items.csv.tmp', 'line-items-2.csv', 'old-line-items.csv', 'line-items.', 'line-items\\x.csv']) expect(pattern.test(name), name).toBe(false);
  });

  it('a typed name with an extension still matches only that name', () => {
    const step = draftOf(TYPED).d.script.steps[16] as { expectFile: { pattern: string } };
    expect(step.expectFile.pattern).toBe('^line-items\\.csv$');
    const pattern = new RegExp(step.expectFile.pattern);
    expect(pattern.test('line-items.csv')).toBe(true);
    for (const name of ['line-items', 'line-items.csv.tmp', 'line-items.xlsx']) expect(pattern.test(name), name).toBe(false);
  });
});
