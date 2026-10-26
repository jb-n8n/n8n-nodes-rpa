import { unescapeXml } from '../import/xml.js';
import { readZipEntries } from './zip.js';
import type { FileCheck, FileFacts } from '../types.js';

export type { FileCheck, FileFacts };

/** A failed download check starts its message with this; classifyFailure treats it as drift (not an incomplete prefix). */
export const FILE_CHECK_FAILED_PREFIX = 'download check failed: ';

/** A download step minus trigger, via and intent: what the agent proposes and compile fills in. */
export type DownloadTemplate = { mime?: string[]; maxBytes?: number; check: FileCheck };

const MAX_FACTS_BYTES = 64 * 1024 * 1024;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEXTUAL = ['text/csv', 'text/plain'];

const MAX_COLUMNS = 200;
const MAX_CELL_CHARS = 200;
const TOO_LARGE = 'the file is too large to read its columns';

/** At most this many non-empty CSV/text records or XLSX rows are searched for the header. */
export const HEADER_SCAN_ROWS = 10;
/** The delimiter is chosen from at most this many characters at the start of the text. */
const SNIFF_CHARS = 1024 * 1024;

/** A header candidate: its cells (at most MAX_COLUMNS of MAX_CELL_CHARS characters) and the data rows after it. */
interface Candidate { cells: string[]; rowsAfter: number }

/**
 * The header is the first candidate whose cells (trimmed, case-insensitive) include every wanted column. Failing that, the
 * candidate with the most wanted columns (earliest on ties); with no match at all, the first candidate. No candidates
 * means an empty file.
 */
function pickHeader(found: Candidate[], columns: string[] = []): FileFacts {
  if (found.length === 0) return { columns: [], rows: 0 };
  const want = columns.map((c) => c.trim().toLowerCase());
  let header = found[0];
  let best = 0;
  for (const r of found) {
    const have = new Set(r.cells.map((c) => c.trim().toLowerCase()));
    const n = want.filter((w) => have.has(w)).length;
    if (n > best) { best = n; header = r; }
  }
  return { columns: header.cells, rows: header.rowsAfter };
}

/** The most common nonzero value in counts and how many entries equal it (support 0 when all are zero). */
function modeSupport(counts: number[]): number {
  const freq = new Map<number, number>();
  let support = 0;
  for (const n of counts) {
    if (n === 0) continue;
    const f = (freq.get(n) ?? 0) + 1;
    freq.set(n, f);
    if (f > support) support = f;
  }
  return support;
}

/**
 * Of tab, semicolon and comma, the one whose per-line count (outside quotes) is most consistent over the first
 * HEADER_SCAN_ROWS non-empty physical lines (within SNIFF_CHARS): its most common nonzero count, supported by the number
 * of lines with exactly that count. The highest support wins; ties go to tab, then semicolon, then comma. Quote state
 * restarts on every physical line, so a stray quote cannot hide the lines after it. Comma when none occurs.
 */
function sniffDelimiter(text: string, from: number): number {
  const tabs: number[] = [];
  const semis: number[] = [];
  const commas: number[] = [];
  let tab = 0;
  let semi = 0;
  let comma = 0;
  let blank = true;
  let quoted = false;
  const endLine = () => {
    if (!blank) { tabs.push(tab); semis.push(semi); commas.push(comma); }
    tab = semi = comma = 0;
    blank = true;
    quoted = false;
  };
  const end = Math.min(text.length, from + SNIFF_CHARS);
  for (let i = from; i < end && tabs.length < HEADER_SCAN_ROWS; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) { endLine(); continue; }
    if (c === 32 || c === 13) continue;
    blank = false;
    if (c === 34) quoted = !quoted;
    else if (!quoted) {
      if (c === 9) tab++;
      else if (c === 59) semi++;
      else if (c === 44) comma++;
    }
  }
  if (tabs.length < HEADER_SCAN_ROWS) endLine();
  const t = modeSupport(tabs);
  const s = modeSupport(semis);
  const m = modeSupport(commas);
  if (t === 0 && s === 0 && m === 0) return 44;
  return t >= s && t >= m ? 9 : s >= m ? 59 : 44;
}

/**
 * Reads delimited text in one pass without storing records: only the first HEADER_SCAN_ROWS non-empty records are kept,
 * each at most MAX_COLUMNS fields of MAX_CELL_CHARS characters, and every non-empty record is counted.
 */
function csvFacts(data: Buffer): Candidate[] {
  const text = data.toString('utf8');
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const delim = sniffDelimiter(text, i);
  const kept: string[][] = [];
  let keep = true; // kept.length < HEADER_SCAN_ROWS
  let cells: string[] = [];
  let total = 0;
  let field = '';
  let fieldCount = 0;
  let quoted = false;
  let content = false; // the record has a delimiter or a non-blank character
  const endField = () => {
    if (keep && cells.length < MAX_COLUMNS) cells.push(field.trim());
    field = '';
    fieldCount++;
  };
  const endRecord = () => {
    endField();
    if (content) {
      total++;
      if (keep) { kept.push(cells); keep = kept.length < HEADER_SCAN_ROWS; }
    }
    if (keep) cells = [];
    content = false;
    fieldCount = 0;
  };
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) { if (keep && field.length < MAX_CELL_CHARS) field += '"'; i++; } else quoted = false;
      } else if (keep && field.length < MAX_CELL_CHARS) field += text[i];
      continue;
    }
    if (c === 34) { quoted = true; content = true; }
    else if (c === delim) { endField(); content = true; }
    else if (c === 10) endRecord();
    else if (c === 13) { if (text.charCodeAt(i + 1) !== 10) endRecord(); }
    else {
      if (c !== 32 && c !== 9) content = true;
      if (keep && field.length < MAX_CELL_CHARS) field += text[i];
    }
  }
  if (field !== '' || fieldCount > 0 || content) endRecord();
  return kept.map((r, k) => ({ cells: r, rowsAfter: total - 1 - k }));
}

interface Tag { name: string; closing: boolean; selfClosing: boolean; attrs: string; start: number; end: number }

/** Linear XML tag scan (indexOf only, no backtracking): names lose any namespace prefix; stops at a tag with no closing ">". */
function* tags(xml: string): Generator<Tag> {
  let pos = 0;
  for (;;) {
    const start = xml.indexOf('<', pos);
    if (start < 0) return;
    const gt = xml.indexOf('>', start);
    if (gt < 0) return;
    pos = gt + 1;
    let j = start + 1;
    const closing = xml[j] === '/';
    if (closing) j++;
    if (xml[j] === '?' || xml[j] === '!') continue;
    let k = j;
    while (k < gt && !' \t\r\n/'.includes(xml[k])) k++;
    const raw = xml.slice(j, k);
    const colon = raw.lastIndexOf(':');
    yield { name: colon < 0 ? raw : raw.slice(colon + 1), closing, selfClosing: xml[gt - 1] === '/', attrs: xml.slice(k, gt), start, end: gt + 1 };
  }
}

const attr = (attrs: string, name: string): string | undefined => {
  const at = attrs.search(new RegExp(`(?:^|\\s)${name}="`));
  if (at < 0) return undefined;
  const from = attrs.indexOf('"', at) + 1;
  return attrs.slice(from, attrs.indexOf('"', from));
};

const SHEET = 'xl/worksheets/sheet1.xml';
const SHARED = 'xl/sharedStrings.xml';
/** At most 10,000 entries in the archive, 16 MiB per wanted entry and 24 MiB for both. */
const ZIP_CAPS = { maxEntries: 10_000, perEntry: 16 * 1024 * 1024, total: 24 * 1024 * 1024 };

/**
 * Keeps the cells of the first HEADER_SCAN_ROWS rows of sheet1 that have a value (at most MAX_COLUMNS each), resolves only
 * the shared strings those rows point at, and counts every row element. A row after the header counts as a data row.
 */
function xlsxFacts(data: Buffer): Candidate[] | { error: string } {
  const zip = readZipEntries(data, (n) => n === SHEET || n === SHARED, ZIP_CAPS);
  if (!(zip instanceof Map)) {
    if (zip.error === 'too-large') return { error: TOO_LARGE };
    throw new Error(zip.detail);
  }
  const sheet = zip.get(SHEET)?.toString('utf8');
  if (sheet === undefined) throw new Error('no first sheet');
  interface Cell { type?: string; v: string; t: string }
  const kept: { cells: Cell[]; ordinal: number }[] = [];
  let rowCount = 0;
  let inRow = false; // inside a row whose cells are kept
  let cells: Cell[] = [];
  let cell: Cell | null = null;
  let capture: 'v' | 't' | null = null;
  let prevEnd = 0;
  const endRow = () => {
    inRow = false;
    cell = null;
    if (cells.some((c) => c.v.trim() !== '' || c.t.trim() !== '')) kept.push({ cells, ordinal: rowCount });
  };
  for (const tag of tags(sheet)) {
    if (capture && cell && cell[capture].length < 1000) cell[capture] += sheet.slice(prevEnd, tag.start);
    prevEnd = tag.end;
    capture = null;
    if (tag.name === 'row') {
      if (!tag.closing) {
        if (inRow) throw new Error('row not closed');
        rowCount++;
        if (!tag.selfClosing && kept.length < HEADER_SCAN_ROWS) { inRow = true; cells = []; }
      } else if (inRow) endRow();
    } else if (inRow) {
      if (tag.name === 'c') {
        if (!tag.closing) {
          cell = { type: attr(tag.attrs, 't'), v: '', t: '' };
          if (tag.selfClosing) { if (cells.length < MAX_COLUMNS) cells.push(cell); cell = null; }
        } else if (cell) { if (cells.length < MAX_COLUMNS) cells.push(cell); cell = null; }
      } else if ((tag.name === 'v' || tag.name === 't') && !tag.closing && !tag.selfClosing) capture = tag.name;
    }
  }
  if (inRow) endRow();
  if (kept.length === 0) return [];
  // Only the shared strings the kept rows point at are resolved.
  const wanted = new Map<number, string>();
  for (const r of kept) for (const c of r.cells) if (c.type === 's' && /^\s*\d+\s*$/.test(c.v)) wanted.set(Number(c.v), '');
  const sst = zip.get(SHARED)?.toString('utf8');
  if (sst !== undefined && wanted.size > 0) {
    let last = 0;
    for (const k of wanted.keys()) if (k > last) last = k;
    let index = -1;
    let in_ = false;
    let skip = false;
    let grab = false;
    let acc = '';
    let end = 0;
    for (const tag of tags(sst)) {
      if (grab && in_ && !skip && acc.length < 1000) acc += sst.slice(end, tag.start);
      end = tag.end;
      grab = false;
      if (tag.name === 'si') {
        if (!tag.closing) { index++; in_ = !tag.selfClosing; acc = ''; if (index > last) break; } else {
          if (in_ && wanted.has(index)) wanted.set(index, acc);
          in_ = false;
        }
      } else if (tag.name === 'rPh') skip = !tag.closing && !tag.selfClosing;
      else if (tag.name === 't' && !tag.closing && !tag.selfClosing) grab = true;
    }
  }
  return kept.map((r) => ({
    cells: r.cells.map((c) => {
      const raw = c.type === 's' ? wanted.get(Number(c.v)) ?? '' : c.type === 'inlineStr' ? c.t : c.v;
      return unescapeXml(raw).trim().slice(0, MAX_CELL_CHARS);
    }),
    rowsAfter: rowCount - r.ordinal,
  }));
}

/**
 * The header columns and data-row count of a CSV, text or XLSX file; null for other types. The header is the first of the
 * first HEADER_SCAN_ROWS non-empty records or rows that has every one of `opts.columns`, else the first. Never throws.
 */
export function fileFacts(data: Buffer, mimeType: string, opts: { columns?: string[] } = {}): FileFacts | { error: string } {
  try {
    const textual = TEXTUAL.includes(mimeType);
    if (!textual && mimeType !== XLSX) return { columns: null, rows: null };
    if (data.length > MAX_FACTS_BYTES) return { error: TOO_LARGE };
    const found = textual ? csvFacts(data) : xlsxFacts(data);
    return 'error' in found ? found : pickHeader(found, opts.columns);
  } catch {
    return { error: 'cannot read the spreadsheet' };
  }
}

export type FileCheckResult =
  | { ok: true; facts: FileFacts }
  | { ok: false; reason: string; facts: FileFacts | null };

/** Applies a step's checks to a downloaded file: name, then size, then columns and rows. */
export function checkFile(file: { fileName: string; mimeType: string; data: Buffer }, check: FileCheck): FileCheckResult {
  if (check.name !== undefined && !new RegExp(check.name).test(file.fileName)) {
    return { ok: false, reason: `file name "${file.fileName}" does not match /${check.name}/`, facts: null };
  }
  if (check.minBytes !== undefined && file.data.length < check.minBytes) {
    return { ok: false, reason: `the file has ${file.data.length} bytes, fewer than ${check.minBytes}`, facts: null };
  }
  const read = fileFacts(file.data, file.mimeType, { columns: check.columns });
  const needsFacts = check.columns !== undefined || check.minRows !== undefined;
  if ('error' in read) {
    if (needsFacts) return { ok: false, reason: read.error, facts: null };
    return { ok: true, facts: { columns: null, rows: null } };
  }
  if (check.columns !== undefined) {
    if (read.columns === null) return { ok: false, reason: `columns cannot be read from ${file.mimeType}`, facts: read };
    const have = new Set(read.columns.map((c) => c.trim().toLowerCase()));
    const missing = check.columns.find((c) => !have.has(c.trim().toLowerCase()));
    if (missing !== undefined) {
      const capped = read.columns.length >= MAX_COLUMNS ? ` (only the first ${MAX_COLUMNS} columns are read)` : '';
      return { ok: false, reason: `the file has no column "${missing}"${capped}`, facts: read };
    }
  }
  if (check.minRows !== undefined) {
    if (read.rows === null) return { ok: false, reason: `rows cannot be counted in ${file.mimeType}`, facts: read };
    if (read.rows < check.minRows) return { ok: false, reason: `the file has ${read.rows} rows, fewer than ${check.minRows}`, facts: read };
  }
  return { ok: true, facts: read };
}
