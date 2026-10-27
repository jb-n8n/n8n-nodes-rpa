import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { checkFile, fileFacts } from '../src/steps/file-check.js';
import { bound } from './timing.js';

const CSV = 'text/csv';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function xlsx(sheet: string, shared = '<sst><si><t>Document</t></si><si><t>Amount</t></si></sst>'): Buffer {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook/>'),
    'xl/sharedStrings.xml': strToU8(shared),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  }));
}

describe('fileFacts', () => {
  it('CSV columns and rows', () => {
    const data = Buffer.from('﻿Document,"Posting Date",Amount\n1,2026-09-01,"a\nb"\n2,2026-09-02,3\n');
    expect(fileFacts(data, CSV)).toEqual({ columns: ['Document', 'Posting Date', 'Amount'], rows: 2 });
  });
  it('reads semicolon CSV', () => {
    expect(fileFacts(Buffer.from('A;B\r\n1;2\r\n'), CSV)).toEqual({ columns: ['A', 'B'], rows: 1 });
  });
  it('XLSX first-row columns and row count', () => {
    const sheet = '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>5</v></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>6</v></c></row>'
      + '</sheetData></worksheet>';
    expect(fileFacts(xlsx(sheet), XLSX)).toEqual({ columns: ['Document', 'Amount'], rows: 2 });
    const shared = '<sst><si><t>Document</t></si><si><t>Amount</t></si></sst>';
    const s2 = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>';
    expect(fileFacts(xlsx(s2, shared), XLSX)).toEqual({ columns: ['Document', 'Amount'], rows: 0 });
  });
  it('file facts handle malformed and edge-case files', () => {
    const good = xlsx('<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row></sheetData></worksheet>');
    const cases = [
      () => fileFacts(good.subarray(0, 40), XLSX),
      () => fileFacts(Buffer.from('PK\u0003\u0004garbage'), XLSX),
      () => fileFacts(Buffer.alloc(0), XLSX),
      () => fileFacts(Buffer.alloc(0), CSV),
      () => fileFacts(Buffer.from('%PDF-1.7'), 'application/pdf'),
      () => fileFacts(Buffer.from('"unterminated,quote\n'), CSV),
    ];
    for (const c of cases) expect(c).not.toThrow();
    expect(cases[0]()).toEqual({ error: expect.stringMatching(/cannot read the spreadsheet/) });
    expect(cases[3]()).toEqual({ columns: [], rows: 0 });
    expect(cases[4]()).toEqual({ columns: null, rows: null });
  });
});

describe('checkFile', () => {
  const file = (over: Partial<{ fileName: string; mimeType: string; data: Buffer }> = {}) =>
    ({ fileName: 'x.csv', mimeType: CSV, data: Buffer.from('A,B\n'), ...over });
  const reason = (r: ReturnType<typeof checkFile>) => (r.ok ? null : r.reason);
  it('checkFile reasons', () => {
    expect(reason(checkFile(file(), { name: '^LINEITEMS_' }))).toBe('file name "x.csv" does not match /^LINEITEMS_/');
    expect(reason(checkFile(file({ data: Buffer.from('abc') }), { minBytes: 10 }))).toBe('the file has 3 bytes, fewer than 10');
    expect(reason(checkFile(file(), { columns: [' a ', 'Currency'] }))).toBe('the file has no column "Currency"');
    expect(reason(checkFile(file(), { minRows: 1 }))).toBe('the file has 0 rows, fewer than 1');
    expect(reason(checkFile(file({ fileName: 'x.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF') }), { columns: ['A'] })))
      .toBe('columns cannot be read from application/pdf');
  });
  it('passes with facts, and ignores unreadable files when only name/size are checked', () => {
    expect(checkFile(file(), { columns: ['b', 'A'], minRows: 0 })).toEqual({ ok: true, facts: { columns: ['A', 'B'], rows: 0 } });
    expect(checkFile(file({ mimeType: XLSX, data: Buffer.from('bad') }), { minBytes: 1 })).toEqual({ ok: true, facts: { columns: null, rows: null } });
    expect(reason(checkFile(file({ mimeType: XLSX, data: Buffer.from('bad') }), { minRows: 1 }))).toMatch(/cannot read the spreadsheet/);
  });
});

describe('bounded cost on page-controlled files', () => {
  const sheetZip = (sheet: string | Uint8Array, shared = '<sst/>') => zipSync({
    'xl/sharedStrings.xml': strToU8(shared),
    'xl/worksheets/sheet1.xml': typeof sheet === 'string' ? strToU8(sheet) : sheet,
  });
  const timed = <T>(f: () => T): { out: T; ms: number } => { const t = Date.now(); const out = f(); return { out, ms: Date.now() - t }; };

  it('80k unclosed rows and 20k unclosed <si> finish fast', () => {
    const rows = timed(() => fileFacts(Buffer.from(sheetZip('<worksheet>' + '<row r="1">'.repeat(80_000))), XLSX));
    expect(rows.ms).toBeLessThan(bound(100));
    expect('error' in rows.out || Array.isArray(rows.out.columns)).toBe(true);
    const si = timed(() => fileFacts(Buffer.from(sheetZip(
      '<row><c t="s"><v>19999999</v></c></row>', '<sst>' + '<si>'.repeat(20_000))), XLSX));
    expect(si.ms).toBeLessThan(bound(100));
    expect(si.out).toEqual({ columns: [''], rows: 0 });
    const cells = timed(() => fileFacts(Buffer.from(sheetZip('<row>' + '<c r="A1">'.repeat(80_000))), XLSX));
    expect(cells.ms).toBeLessThan(bound(100));
  });
  it('does not count <rowBreaks> or <rows> as rows', () => {
    const s = '<row><c t="inlineStr"><is><t>A</t></is></c></row><rowBreaks count="1"/><rows/>';
    expect(fileFacts(Buffer.from(sheetZip(s)), XLSX)).toEqual({ columns: ['A'], rows: 0 });
  });
  it('refuses a declared-huge and a lying zip entry without inflating them', () => {
    const big = new Uint8Array(20 * 1024 * 1024);
    const declaredHuge = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': big }));
    declaredHuge.writeUInt32LE(0xfffffff0, 22);
    const lying = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': big }));
    lying.writeUInt32LE(100, 22);
    for (const z of [declaredHuge, lying]) {
      const { out, ms } = timed(() => fileFacts(z, XLSX));
      expect(out).toEqual({ error: 'the file is too large to read its columns' });
      expect(ms).toBeLessThan(bound(2000));
    }
  });
  it('64 MiB of commas is read with a capped header', () => {
    const data = Buffer.alloc(64 * 1024 * 1024, ',');
    const { out, ms } = timed(() => fileFacts(data, CSV));
    expect(ms).toBeLessThan(bound(5000));
    if ('error' in out) throw new Error(out.error);
    expect(out.columns?.length).toBe(200);
    const miss = checkFile({ fileName: 'x.csv', mimeType: CSV, data }, { columns: ['Z'] });
    expect(miss.ok ? '' : miss.reason).toBe('the file has no column "Z" (only the first 200 columns are read)');
  });
  it('an unterminated quote keeps one capped header column', () => {
    const out = fileFacts(Buffer.from('"' + 'a'.repeat(100_000)), CSV);
    expect(out).toEqual({ columns: ['a'.repeat(200)], rows: 0 });
  });
});

describe('other layouts', () => {
  it('reads namespaced XLSX tags', () => {
    const sheet = '<x:worksheet><x:sheetData><x:row r="1"><x:c t="s"><x:v>0</x:v></x:c><x:c t="inlineStr"><x:is><x:t>B</x:t></x:is></x:c></x:row>'
      + '<x:row r="2"><x:c><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>';
    expect(fileFacts(xlsx(sheet, '<x:sst><x:si><x:t>A</x:t></x:si></x:sst>'), XLSX)).toEqual({ columns: ['A', 'B'], rows: 1 });
  });
  it('reads tab-delimited text', () => {
    expect(fileFacts(Buffer.from('Doc\tAmount\n1\t2\n3\t4\n'), 'text/plain')).toEqual({ columns: ['Doc', 'Amount'], rows: 2 });
  });
});

describe('hostile archives (central-directory reader)', () => {
  interface Ent { name: string; raw: Buffer; method?: number; usize: number; flags?: number }
  /** A zip built by hand, so sizes and flags can lie. Local headers carry zero sizes when flag bit 3 is set. */
  function zip(entries: Ent[], cdCopies = 1): Buffer {
    const locals: Buffer[] = [];
    const central: Buffer[] = [];
    let off = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name);
      const flags = e.flags ?? 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(e.method ?? 8, 8);
      if (!(flags & 8)) { lh.writeUInt32LE(e.raw.length, 18); lh.writeUInt32LE(e.usize, 22); }
      lh.writeUInt16LE(name.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(e.method ?? 8, 10);
      ch.writeUInt32LE(e.raw.length, 20); ch.writeUInt32LE(e.usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      locals.push(lh, name, e.raw);
      for (let i = 0; i < cdCopies; i++) central.push(ch, name);
      off += 30 + name.length + e.raw.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length * cdCopies, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  }
  const SHEET = 'xl/worksheets/sheet1.xml';
  const TOO_BIG = { error: 'the file is too large to read its columns' };
  const CANNOT = { error: 'cannot read the spreadsheet' };
  const zeros = (mb: number) => deflateRawSync(Buffer.alloc(mb * 1024 * 1024));
  const timed = <T>(f: () => T): { out: T; ms: number } => { const t = Date.now(); const out = f(); return { out, ms: Date.now() - t }; };
  const quick = (z: Buffer, expected: unknown) => {
    const { out, ms } = timed(() => fileFacts(z, XLSX));
    expect(out).toEqual(expected);
    expect(ms).toBeLessThan(bound(2000));
  };

  it('a real bomb (declared size 100) and the same with a data descriptor are refused', () => {
    const raw = zeros(256);
    expect(raw.length).toBeLessThan(1024 * 1024);
    quick(zip([{ name: SHEET, raw, usize: 100 }]), TOO_BIG);
    quick(zip([{ name: SHEET, raw, usize: 100, flags: 8 }]), TOO_BIG);
  });
  it('1,000 copies of a 15.99 MiB sheet are refused (as duplicates, and by the total budget)', () => {
    const raw = deflateRawSync(Buffer.alloc(Math.floor(15.99 * 1024 * 1024)));
    quick(zip(Array.from({ length: 1000 }, () => ({ name: SHEET, raw, usize: 100 }))), CANNOT);
    const shared = { name: 'xl/sharedStrings.xml', raw, usize: 100 };
    quick(zip([{ name: SHEET, raw, usize: 100 }, shared]), TOO_BIG);
  });
  it('a duplicated wanted name, a corrupt deflate stream, an encrypted entry and other methods read as unreadable', () => {
    const ok = deflateRawSync(Buffer.from('<row/>'));
    quick(zip([{ name: SHEET, raw: ok, usize: 6 }, { name: SHEET, raw: ok, usize: 6 }]), CANNOT);
    quick(zip([{ name: SHEET, raw: Buffer.alloc(40, 0xff), usize: 6 }]), CANNOT);
    quick(zip([{ name: SHEET, raw: ok, usize: 6, flags: 1 }]), CANNOT);
    quick(zip([{ name: SHEET, raw: ok, usize: 6, method: 12 }]), CANNOT);
  });
  it('refuses 10,001 entries quickly and reads 8,000 harmless entries plus the two wanted', () => {
    const tiny = deflateRawSync(Buffer.from('x'));
    const filler = (n: number) => Array.from({ length: n }, (_v, i) => ({ name: `f${i}`, raw: tiny, usize: 1 }));
    quick(zip(filler(10_001)), CANNOT);
    const sheet = deflateRawSync(Buffer.from('<row><c t="inlineStr"><is><t>A</t></is></c></row><row/>'));
    quick(zip([...filler(8000), { name: SHEET, raw: sheet, usize: 60 }]), { columns: ['A'], rows: 1 });
  });
  it('a first row that never closes is unreadable', () => {
    quick(Buffer.from(zipSync({ [SHEET]: strToU8('<row><c t="inlineStr"><is><t>A</t></is></c><row><c><v>X</v></c></row>') })), CANNOT);
  });
  it('a self-closing <rPh/> does not hide the next shared string', () => {
    const shared = '<sst><si><t>A</t><rPh/></si><si><t>B</t><rPh><t>phonetic</t></rPh></si></sst>';
    const sheet = '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>';
    quick(Buffer.from(zipSync({ 'xl/sharedStrings.xml': strToU8(shared), [SHEET]: strToU8(sheet) })), { columns: ['A', 'B'], rows: 0 });
  });
});

describe('the header below a title line', () => {
  const REPORT = 'Line Item Report\n\nDocument,Posting Date,Amount\n1,2026-09-01,3\n2,2026-09-02,4';
  const inline = (s: string) => `<c t="inlineStr"><is><t>${s}</t></is></c>`;
  const timed = <T>(f: () => T): { out: T; ms: number } => { const t = performance.now(); const out = f(); return { out, ms: performance.now() - t }; };

  it('the header can sit below a title line', () => {
    expect(fileFacts(Buffer.from(REPORT), CSV, { columns: ['Document', 'Amount'] }))
      .toEqual({ columns: ['Document', 'Posting Date', 'Amount'], rows: 2 });
    const sheet = '<worksheet><sheetData>'
      + `<row r="1">${inline('Line Item Report')}</row>`
      + `<row r="2"><c t="s"><v>0</v></c>${inline('Posting Date')}<c t="s"><v>1</v></c></row>`
      + '<row r="3"><c><v>1</v></c><c><v>46266</v></c><c><v>3</v></c></row>'
      + '<row r="4"><c><v>2</v></c><c><v>46267</v></c><c><v>4</v></c></row>'
      + '</sheetData></worksheet>';
    expect(fileFacts(xlsx(sheet), XLSX, { columns: ['document', ' AMOUNT '] }))
      .toEqual({ columns: ['Document', 'Posting Date', 'Amount'], rows: 2 });
    expect(checkFile({ fileName: 'r.csv', mimeType: CSV, data: Buffer.from(REPORT) }, { columns: ['Document', 'Amount'], minRows: 2 }))
      .toEqual({ ok: true, facts: { columns: ['Document', 'Posting Date', 'Amount'], rows: 2 } });
  });

  it('the header may be the 10th non-empty record, not the 11th', () => {
    const pre = (n: number) => Array.from({ length: n }, (_v, i) => `Preamble ${i + 1}\n\n`).join('');
    expect(fileFacts(Buffer.from(pre(9) + 'Document,Amount\n1,2\n'), CSV, { columns: ['Document'] })).toEqual({ columns: ['Document', 'Amount'], rows: 1 });
    const rows = (n: number) => Array.from({ length: n }, (_v, i) => `<row r="${i + 1}">${inline(`Preamble ${i + 1}`)}</row><row/>`).join('');
    const sheet = (n: number) => `<worksheet><sheetData>${rows(n)}<row>${inline('Document')}${inline('Amount')}</row><row><c><v>1</v></c></row></sheetData></worksheet>`;
    expect(fileFacts(xlsx(sheet(9)), XLSX, { columns: ['Document'] })).toEqual({ columns: ['Document', 'Amount'], rows: 1 });
    expect(fileFacts(xlsx(sheet(10)), XLSX, { columns: ['Document'] })).toEqual({ columns: ['Preamble 1'], rows: 21 });
  });

  it('a header beyond the first 10 rows falls back to the first row', () => {
    const data = Buffer.from(Array.from({ length: 11 }, (_v, i) => `Preamble ${i + 1}`).join('\n') + '\nDocument,Amount\n1,2\n');
    expect(fileFacts(data, CSV, { columns: ['Document'] })).toEqual({ columns: ['Preamble 1'], rows: 12 });
    const r = checkFile({ fileName: 'r.csv', mimeType: CSV, data }, { columns: ['Document'] });
    expect(r.ok ? '' : r.reason).toBe('the file has no column "Document"');
  });

  it('without columns the first non-empty line is the header', () => {
    expect(fileFacts(Buffer.from(REPORT), CSV)).toEqual({ columns: ['Line Item Report'], rows: 3 });
    expect(fileFacts(Buffer.from(REPORT), CSV, { columns: [] })).toEqual({ columns: ['Line Item Report'], rows: 3 });
    expect(fileFacts(Buffer.from(REPORT), CSV, { columns: ['Currency'] })).toEqual({ columns: ['Line Item Report'], rows: 3 });
    const sheet = `<worksheet><sheetData><row/><row>${inline('Title')}</row><row>${inline('A')}</row></sheetData></worksheet>`;
    expect(fileFacts(xlsx(sheet), XLSX)).toEqual({ columns: ['Title'], rows: 1 });
  });

  it('delimiter by count', () => {
    expect(fileFacts(Buffer.from('Amount, EUR\tDocument\n1\t2'), CSV)).toEqual({ columns: ['Amount, EUR', 'Document'], rows: 1 });
    // A title line does not fix the delimiter; delimiters inside quotes do not count.
    expect(fileFacts(Buffer.from('Report; Q3, 2026\nA,B,C\n1,2,3\n'), CSV, { columns: ['C'] })).toEqual({ columns: ['A', 'B', 'C'], rows: 1 });
    expect(fileFacts(Buffer.from('"a,b,c,d"\tX\n1\t2\n'), CSV)).toEqual({ columns: ['a,b,c,d', 'X'], rows: 1 });
    // Ties go to tab, then semicolon, then comma.
    expect(fileFacts(Buffer.from('A,B\tC\n'), CSV)).toEqual({ columns: ['A,B', 'C'], rows: 0 });
    expect(fileFacts(Buffer.from('A,B;C\n'), CSV)).toEqual({ columns: ['A,B', 'C'], rows: 0 });
    expect(fileFacts(Buffer.from('A B C\n'), CSV)).toEqual({ columns: ['A B C'], rows: 0 });
  });

  it('delimiter by consistent per-line counts', () => {
    const decimals = 'A;B;C\n' + '1,5;2,5;3,5\n'.repeat(9);
    expect(fileFacts(Buffer.from(decimals), CSV, { columns: ['C'] })).toEqual({ columns: ['A', 'B', 'C'], rows: 9 });
    expect(checkFile({ fileName: 'r.csv', mimeType: CSV, data: Buffer.from(decimals) }, { columns: ['A', 'B'] }).ok).toBe(true);
    expect(fileFacts(Buffer.from('Vendor;Amount;Tax\nMüller, Hans GmbH;1.234,56;234,56\n'), CSV))
      .toEqual({ columns: ['Vendor', 'Amount', 'Tax'], rows: 1 });
    const titled = 'Report, Q3 2026\nDocument;Amount\n1,5;2,5\n3,5;4,5\n';
    expect(fileFacts(Buffer.from(titled), CSV, { columns: ['Document', 'Amount'] })).toEqual({ columns: ['Document', 'Amount'], rows: 2 });
  });

  it('the header falls back to the candidate with the most required columns, earliest on ties', () => {
    const r = checkFile({ fileName: 'r.csv', mimeType: CSV, data: Buffer.from('Title\nDocument,Net\n1,2') }, { columns: ['Document', 'Amount'] });
    expect(r.ok ? '' : r.reason).toBe('the file has no column "Amount"');
    expect(fileFacts(Buffer.from('Title\nDocument,Net\nDocument,Amount\n1,2'), CSV, { columns: ['Document', 'Amount', 'X'] }))
      .toEqual({ columns: ['Document', 'Amount'], rows: 1 });
    expect(fileFacts(Buffer.from('Title\nA,Net\nA,Other\n1,2'), CSV, { columns: ['A', 'B'] })).toEqual({ columns: ['A', 'Net'], rows: 2 });
    const sheet = `<worksheet><sheetData><row>${inline('Title')}</row><row>${inline('Document')}${inline('Net')}</row><row><c><v>1</v></c></row></sheetData></worksheet>`;
    expect(fileFacts(xlsx(sheet), XLSX, { columns: ['Document', 'Amount'] })).toEqual({ columns: ['Document', 'Net'], rows: 1 });
  });

  it('bounded on adversarial input', () => {
    const MiB = 1024 * 1024;
    const unclosed = Buffer.from(('x,"' + 'a,'.repeat(MiB / 2) + '\n').repeat(10) + 'Document,Amount\n1,2\n');
    const wide = Buffer.from((',;\t'.repeat(MiB / 3) + '\n').repeat(10) + 'Document,Amount\n1,2\n');
    const quotes = Buffer.from(('"'.repeat(MiB) + '\n').repeat(10) + 'Document,Amount\n1,2\n');
    for (const data of [unclosed, wide, quotes]) {
      const { out, ms } = timed(() => fileFacts(data, CSV, { columns: ['Document', 'Missing'] }));
      expect(ms).toBeLessThan(bound(200));
      if ('error' in out) throw new Error(out.error);
      expect(out.columns!.length).toBeGreaterThan(0);
      expect(out.columns!.length).toBeLessThanOrEqual(200);
      for (const c of out.columns!) expect(c.length).toBeLessThanOrEqual(200);
    }
    const cells = '<c t="inlineStr"><is><t>' + 'w'.repeat(5000) + '</t></is></c>';
    const sheet = '<worksheet><sheetData>' + `<row>${cells.repeat(300)}</row>`.repeat(10) + `<row>${inline('Document')}</row></sheetData></worksheet>`;
    const z = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(sheet) }));
    const { out, ms } = timed(() => fileFacts(z, XLSX, { columns: ['Document'] }));
    expect(ms).toBeLessThan(bound(500));
    if ('error' in out) throw new Error(out.error);
    expect(out.columns).toHaveLength(200);
    expect(out.columns![0]).toBe('w'.repeat(200));
    expect(out.rows).toBe(10);
  });
});

describe('readEntries: a method-8 entry with compressed size 0', () => {
  it('a method-8 entry with compressed size 0 cannot be read', () => {
    // The sheet is declared deflated (method 8) with zero compressed bytes, and an uncompressed size of 0 or 6.
    const name = 'xl/worksheets/sheet1.xml';
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
    for (const usize of [0, 6]) {
      lh.writeUInt32LE(usize, 22); ch.writeUInt32LE(usize, 24);
      const cd = Buffer.concat([ch, Buffer.from(name)]);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length, 16);
      const bad = Buffer.concat([lh, Buffer.from(name), cd, end]);
      expect(fileFacts(bad, XLSX)).toEqual({ error: 'cannot read the spreadsheet' });
    }
  });
});
