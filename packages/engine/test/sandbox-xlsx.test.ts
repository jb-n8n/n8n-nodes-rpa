import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { xlsxBytes } from 'n8n-rpa-sandbox/xlsx.js';

describe('sandbox XLSX', () => {
  it('the sandbox XLSX reads with fflate', () => {
    const files = unzipSync(xlsxBytes([['Document', 'Amount'], ['1900000201', 1234.56]]));
    expect(files['xl/worksheets/sheet1.xml']).toBeDefined();
    expect(files['xl/sharedStrings.xml']).toBeDefined();
    const strings = new TextDecoder().decode(files['xl/sharedStrings.xml']);
    const items = [...strings.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
    expect(items.slice(0, 2)).toEqual(['Document', 'Amount']);
  });
});
