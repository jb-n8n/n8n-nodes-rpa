import { describe, expect, it } from 'vitest';
import { detectTotal, verifyRows } from '../src/verify/verify.js';
import type { Evidence, Row } from '../src/types.js';
import { countMismatch } from '../src/messages.js';

const ev = (text: string, url = 'http://p/acme/notices'): Evidence => ({ url, text });
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const TP = '\\d+\\s*[-–]\\s*\\d+\\s+of\\s+(\\d[\\d,]*)'; // an explicit Stated Total Pattern ("x-y of N")
const IDS = ['N26-0417', 'N26-0412', 'N26-0398', 'N26-0391', 'N26-0384', 'N26-0376', 'N26-0369'];

describe('detectTotal', () => {
  it('with no pattern detects nothing', () => {
    expect(detectTotal([ev('Showing 1-4 of 7 notices')])).toEqual({ total: null, text: null, conflict: null, unparsed: false, invalid: false });
  });
  it('reads a pattern "x-y of N" and ignores "Page 1 of 2"', () => {
    expect(detectTotal([ev('Showing 1-4 of 7 notices ... Page 1 of 2')], TP)).toEqual({ total: 7, text: '1-4 of 7', conflict: null, unparsed: false, invalid: false });
    expect(detectTotal([ev('Page 1 of 2')], TP)).toEqual({ total: null, text: null, conflict: null, unparsed: false, invalid: false });
  });
  it('agrees across pages and reports conflicts', () => {
    expect(detectTotal([ev('Showing 1-4 of 7'), ev('Showing 5–7 of 7')], TP).total).toBe(7);
    expect(detectTotal([ev('Showing 1-4 of 7'), ev('Showing 5-8 of 8')], TP).conflict).toEqual([7, 8]);
  });
  it('uses a custom pattern capture group', () => {
    expect(detectTotal([ev('Total orders: 12')], 'Total orders:\\s*(\\d+)').total).toBe(12);
  });
  it('parses thousands separators in totals', () => {
    expect(detectTotal([ev('Showing 1-1 of 1,234')], TP).total).toBe(1234);
  });
  it('reports unparsed when custom pattern matches but has no capture group', () => {
    expect(detectTotal([ev('Total orders: 12')], 'Total orders:\\s*\\d+').unparsed).toBe(true);
  });
  it('marks invalid patterns with invalid flag', () => {
    expect(detectTotal([ev('test')], '(').invalid).toBe(true);
  });
  it('rejects bare comma in total', () => {
    expect(detectTotal([ev('Showing 1-4 of , x')], TP).total).toBe(null);
  });
  it('preserves unparsed across multiple chunks', () => {
    expect(detectTotal([ev('Total orders: none'), ev('Total orders: 12')], 'Total orders:\\s*(\\d+|none)').unparsed).toBe(true);
  });
});

describe('verifyRows', () => {
  it('without a totalPattern, stated totals in page text are ignored (no mismatch, no conflict, total null)', () => {
    const ids = ['N26-0417', 'N26-0412', 'N26-0398'];
    const r = verifyRows({ rows: rows(...ids), evidence: [ev(`Showing 1-3 of 5 ${ids.join(' ')} 4-5 of 5 stars 1-2 of 9`)], output: { idPattern: 'N26-\\d{4}' }, requireGrounding: true });
    expect(r).toEqual({ ok: true, reasons: [], count: 3, total: null });
  });
  const output = { idPattern: 'N26-\\d{4}' };
  const withTotal = { ...output, totalPattern: TP };
  it('passes when count matches the stated total', () => {
    const r = verifyRows({ rows: rows(...IDS), evidence: [ev(`Showing 1-7 of 7 notices ${IDS.join(' ')}`)], output: withTotal, requireGrounding: true });
    expect(r).toEqual({ ok: true, reasons: [], count: 7, total: 7 });
  });
  it('fails on empty rows, bad ids, duplicates and missing fields', () => {
    expect(verifyRows({ rows: [], evidence: [], output, requireGrounding: false }).reasons).toContain('no rows were extracted');
    expect(verifyRows({ rows: rows('N26-04'), evidence: [], output, requireGrounding: false }).reasons[0]).toMatch(/does not match the ID pattern/);
    expect(verifyRows({ rows: rows('', 'N26-0417'), evidence: [], output, requireGrounding: false }).reasons[0]).toMatch(/empty ID/);
    expect(verifyRows({ rows: rows('N26-0417', 'N26-0417'), evidence: [], output, requireGrounding: false }).reasons[0]).toMatch(/duplicate ID N26-0417/);
    const f = verifyRows({ rows: [{ id: 'N26-0417', title: ' ' }], evidence: [], output: { ...output, requiredFields: ['title'] }, requireGrounding: false });
    expect(f.reasons[0]).toMatch(/field "title" is empty/);
  });
  it('fails on a count mismatch or conflicting totals', () => {
    const r = verifyRows({ rows: rows(...IDS.slice(0, 4)), evidence: [ev('Showing 1-4 of 7 notices')], output: withTotal, requireGrounding: false });
    expect(r.reasons).toContain(countMismatch(7, '1-4 of 7', 4));
    const c = verifyRows({ rows: rows(...IDS), evidence: [ev('1-4 of 7'), ev('5-8 of 8')], output: withTotal, requireGrounding: false });
    expect(c.reasons[0]).toMatch(/conflicting totals 7, 8/);
  });
  it('grounding needs every field of a row inside one evidence chunk, with whole-word IDs', () => {
    const planted = [{ id: 'N26-0417', title: 'Rear seat belt buckle may not latch' }];
    const split = [ev('N26-0417 something'), ev('Rear seat belt buckle may not latch')];
    expect(verifyRows({ rows: planted, evidence: split, output, requireGrounding: true }).reasons[0]).toMatch(/not found together/);
    const together = [ev('N26-0417  Rear seat\nbelt buckle may not latch')];
    expect(verifyRows({ rows: planted, evidence: together, output, requireGrounding: true }).ok).toBe(true);
    const sub = verifyRows({ rows: rows('N26-041'), evidence: [ev('N26-0417')], output: {}, requireGrounding: true });
    expect(sub.ok).toBe(false);
  });
  it('grounding is required by default', () => {
    expect(verifyRows({ rows: rows('N26-9999'), evidence: [], output }).ok).toBe(false);
  });
  it('custom pattern without capture group is reported as unparsed', () => {
    const r = verifyRows({ rows: rows('N26-0417'), evidence: [ev('Total orders: 12')], output: { totalPattern: 'Total orders:\\s*\\d+' }, requireGrounding: false });
    expect(r.reasons).toContain('total pattern matched but did not capture a number');
  });
  it('thousands separators in totals are parsed correctly', () => {
    const r = verifyRows({ rows: rows('N26-0417'), evidence: [ev('Showing 1-1 of 1,234')], output: withTotal, requireGrounding: false });
    expect(r.reasons).toContain(countMismatch(1234, '1-1 of 1,234', 1));
  });
  it('invalid ID pattern is reported', () => {
    const r = verifyRows({ rows: rows('N26-0417'), evidence: [], output: { idPattern: '(' }, requireGrounding: false });
    expect(r.reasons).toContain('invalid ID pattern');
  });
  it('invalid total pattern is reported', () => {
    const r = verifyRows({ rows: rows('N26-0417'), evidence: [ev('test')], output: { idPattern: 'N26-\\d{4}', totalPattern: '(' }, requireGrounding: false });
    expect(r.reasons).toContain('invalid total pattern');
  });
});

describe('empty results', () => {
  const output = { idPattern: 'N26-\\d{4}' };
  const withTotal = { ...output, totalPattern: TP };
  it('zero rows still fail without an empty pattern', () => {
    expect(verifyRows({ rows: [], evidence: [ev('No active notices available through this portal.')], output }).reasons).toEqual(['no rows were extracted']);
  });
  it('zero rows pass only when the page itself says there is nothing', () => {
    const withPattern = { ...output, emptyPattern: 'no active notices' };
    expect(verifyRows({ rows: [], evidence: [ev('No active notices available through this portal.')], output: withPattern }).ok).toBe(true);
    expect(verifyRows({ rows: [], evidence: [ev('Something went wrong, please retry.')], output: withPattern }).reasons)
      .toEqual(['no rows were extracted and the page did not say it has none']);
  });
  it('a stated non-zero total still wins over the empty pattern', () => {
    const r = verifyRows({ rows: [], evidence: [ev('No active notices. Showing 1-7 of 7 notices')], output: { ...withTotal, emptyPattern: 'no active notices' } });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(countMismatch(7, '1-7 of 7', 0));
  });
  it('every evidence entry must match the empty pattern', () => {
    const o = { ...output, emptyPattern: 'no active notices' };
    expect(verifyRows({ rows: [], evidence: [ev('No active notices'), ev('Something went wrong')], output: o }).ok).toBe(false);
    expect(verifyRows({ rows: [], evidence: [ev('No active notices'), ev('no active notices here')], output: o }).ok).toBe(true);
    expect(verifyRows({ rows: [], evidence: [], output: o }).ok).toBe(false);
  });
  it('a pattern that matches the empty string is rejected', () => {
    for (const emptyPattern of ['.*', 'x*']) {
      expect(verifyRows({ rows: [], evidence: [ev('anything')], output: { ...output, emptyPattern } }).reasons).toContain('invalid empty pattern');
    }
  });
  it('an invalid empty pattern is reported', () => {
    expect(verifyRows({ rows: [], evidence: [ev('x')], output: { ...output, emptyPattern: '(' } }).reasons).toContain('invalid empty pattern');
  });
});

describe('verification without an ID Pattern, and the golden count message', () => {
  it('no ID Pattern: no empty-ID, pattern or duplicate reasons; required fields name the row number', () => {
    const r = verifyRows({ rows: [{ title: 'Blue mug' }, { title: 'Blue mug' }, { title: '' }], evidence: [ev('Blue mug Blue mug')], output: { requiredFields: ['title'] } });
    expect(r.reasons).toEqual(['row 3: field "title" is empty']);
  });
  it('a stated total that differs is the golden count mismatch', () => {
    const found = Array.from({ length: 117 }, (_, i) => ({ code: `R-${i}` }));
    const r = verifyRows({ rows: found, evidence: [ev(`Showing 120 results ${found.map((x) => x.code).join(' ')}`)], output: { totalPattern: '(\\d+) results' } });
    expect(r.reasons).toEqual([countMismatch(120, '120 results', 117)]);
    expect(r.reasons[0]).toBe('Expected 120 rows (the page says "120 results") but found 117. Nothing was marked successful.');
  });
  it('zero rows pass when Text That Means No Results matches', () => {
    expect(verifyRows({ rows: [], evidence: [ev('No results found')], output: { emptyPattern: 'No results found' } }).ok).toBe(true);
    expect(verifyRows({ rows: [], evidence: [ev('Loading')], output: {} }).reasons).toEqual(['no rows were extracted']);
  });
  it('detectTotal reports the text the total came from', () => {
    expect(detectTotal([ev('Showing 120 results')], '(\\d+) results')).toEqual({ total: 120, text: '120 results', conflict: null, unparsed: false, invalid: false });
  });
});

describe('attribute-sourced fields skip grounding only', () => {
  const evidence = [ev('Blue mug $4.00')];
  it('a listed field is not grounded; text fields still are', () => {
    const row = { title: 'Blue mug', link: 'http://shop.example/items/1' };
    expect(verifyRows({ rows: [row], evidence, output: {} }).reasons).toEqual(['row 1: values were not found together on any page that was read']);
    expect(verifyRows({ rows: [row], evidence, output: {}, ungroundedFields: ['link'] }).ok).toBe(true);
    expect(verifyRows({ rows: [{ title: 'Green mug', link: 'x' }], evidence, output: {}, ungroundedFields: ['link'] }).ok).toBe(false);
  });
  it('the ID and count checks are unchanged', () => {
    const r = verifyRows({ rows: [{ id: 'X-1', link: 'a' }, { id: 'X-1', link: 'b' }], evidence: [ev('X-1 X-1 1-2 of 3')], output: { idPattern: 'X-\\d', totalPattern: TP }, ungroundedFields: ['link'] });
    expect(r.reasons).toEqual(['duplicate ID X-1', countMismatch(3, '1-2 of 3', 2)]);
  });
});

describe('regex subjects are capped at 1 MiB', () => {
  const MIB = 1024 * 1024;
  it('a total, an empty text and an ID found only past the first MiB of evidence are not seen', () => {
    const pad = 'x '.repeat(MIB / 2);
    expect(detectTotal([ev(`${pad}Showing 1-4 of 7`)], TP).total).toBeNull();
    expect(detectTotal([ev(`${pad}Total: 7`)], 'Total: (\\d+)').total).toBeNull();
    expect(detectTotal([ev(`Showing 1-4 of 7 ${pad}`)], TP).total).toBe(7);
    const empty = verifyRows({ rows: [], evidence: [ev(`${pad}No results`)], output: { emptyPattern: 'no results' } });
    expect(empty.reasons).toContain('no rows were extracted and the page did not say it has none');
    // Grounding matches an escaped literal (linear, no backtracking): it is exempt and still reads the whole evidence.
    const grounded = verifyRows({ rows: rows('N26-0417'), evidence: [ev(`${pad} N26-0417`)], output: { idPattern: 'N26-\\d{4}' } });
    expect(grounded.ok).toBe(true);
  });
});
