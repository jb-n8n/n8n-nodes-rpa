import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject } from 'n8n-workflow';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { executeQuickOp } from '../nodes/Playwright/operations/quick.js';
import { harness } from './harness.js';
import { binaryOf, BROWSER, quickParams } from './quick-fixtures.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const savePdf = (fields: IDataObject = {}, options: IDataObject = {}) =>
  executeQuickOp(
    harness({ params: quickParams('pdf', { url: `${portal.url}/public/table`, ...fields }, { allowPrivateNetwork: true, ...options }), credentials: BROWSER, continueOnFail: true }),
    engine,
    'pdf',
  );

/** Width and height in points of the first page's MediaBox (Chromium writes page dictionaries uncompressed). */
function mediaBox(pdf: Buffer): { width: number; height: number } {
  const m = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox in the PDF');
  return { width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
}

describe('Save as PDF against the sandbox (real engine, headless)', () => {
  it('A4 by default: a real PDF under "pdf", the envelope with status 200 and the steps', async () => {
    const [[item]] = await savePdf();
    expect(item.json.error).toBeUndefined();
    const pdf = binaryOf(item, 'pdf');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(item.binary?.pdf.mimeType).toBe('application/pdf');
    const box = mediaBox(pdf);
    expect(Math.abs(box.width - 595)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - 842)).toBeLessThanOrEqual(2);
    expect(item.json).toMatchObject({ url: `${portal.url}/public/table`, status: 200 });
    expect(item.json.steps).toEqual({
      steps: [
        { intent: 'Open the page', goto: `${portal.url}/public/table`, waitUntil: 'load' },
        { intent: 'Save the page as PDF', pdf: { paper: 'A4', background: false } },
      ],
    });
  });

  it('Letter gives a 612 × 792 pt page', async () => {
    const [[item]] = await savePdf({ paper: 'Letter' });
    const box = mediaBox(binaryOf(item, 'pdf'));
    expect(Math.abs(box.width - 612)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - 792)).toBeLessThanOrEqual(2);
  });

  it('Print Background and Put Output in Field', async () => {
    const [[item]] = await savePdf({}, { printBackground: true, pdfProperty: 'tablePdf' });
    expect(item.json.error).toBeUndefined();
    expect(Object.keys(item.binary ?? {})).toEqual(['tablePdf']);
    expect(binaryOf(item, 'tablePdf').subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((item.json.steps as { steps: IDataObject[] }).steps[1]).toEqual({ intent: 'Save the page as PDF', pdf: { paper: 'A4', background: true } });
  });

  it('/public/missing fails not_found and produces no PDF', async () => {
    const [[item]] = await savePdf({ url: `${portal.url}/public/missing` });
    expect(String(item.json.error)).toMatch(/^not_found: /);
    expect(item.binary?.pdf).toBeUndefined();
  });
});
