import type { RunState, Step, SubmitTarget } from '../../types.js';
import { checkFile, FILE_CHECK_FAILED_PREFIX } from '../file-check.js';
import { PolicyError } from '../errors.js';
import { unzipSync } from 'fflate';
import { runBinaryTooLarge } from '../../messages.js';
import { MAX_RUN_BINARY_BYTES, runBinaryBytes } from '../limits.js';
import { installInterrupts } from '../interrupts.js';
import { resolveUnique } from '../locator.js';
import { settle, type Handler, type StepContext } from '../run.js';
import { isAllowedSubmit, submitKey, submitLabel, type AllowedSubmit } from '../../policy/submits.js';
import { withWindow, type WindowGate } from './basic.js';
import { registerHandlers } from './index.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MIME = ['text/csv', 'text/plain', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
/** MIME types the node offers for downloads (Download File); the default allowlist is DEFAULT_MIME. */
export const MIME = {
  csv: 'text/csv',
  text: 'text/plain',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

/**
 * The binary property name for a capture or download of the top-level step `index`: screenshot_3, pdf_4, file_5, and
 * file_5_2, file_5_3 … for repeats (a download inside paginate). Unique across outputs and downloads of the run.
 */
export function binaryName(state: Pick<RunState, 'outputs' | 'downloads'>, verb: 'screenshot' | 'pdf' | 'download', index: number): string {
  const base = `${verb === 'download' ? 'file' : verb}_${index}`;
  const taken = new Set([...state.outputs.flatMap((o) => (o.binary ? [o.binary.name] : [])), ...state.downloads.map((d) => d.binaryName)]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  let clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^[.\s]+/, '').trim();
  if (clean.length > 120) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot - 1 >= 1 && clean.length - dot - 1 <= 10 ? clean.slice(dot) : '';
    clean = clean.slice(0, dot > 0 && ext ? dot : clean.length).slice(0, 120 - ext.length) + ext;
  }
  return clean || 'download';
}

/** The entry names of a ZIP archive (from its central directory, nothing is inflated), or undefined when it is not a readable ZIP. */
function zipEntryNames(data: Buffer): Set<string> | undefined {
  const names = new Set<string>();
  try {
    unzipSync(data, { filter: (file) => { names.add(file.name); return false; } });
  } catch {
    return undefined;
  }
  return names;
}

const BOM = /^\uFEFF/;
/** sniffMime runs JSON.parse only on files up to this size. */
const MAX_JSON_SNIFF_BYTES = 16 * 1024 * 1024;

/** The first byte that is not JSON whitespace (or a UTF-8 BOM), as a character; '' when there is none. */
function firstNonSpace(data: Buffer): string {
  let i = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  return i < data.length ? String.fromCharCode(data[i]) : '';
}

export function sniffMime(data: Buffer, fileName: string): string {
  const lower = fileName.toLowerCase();
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return MIME.pdf;
  if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    // Office files are told apart by their ZIP entry names, never by substrings of the raw bytes.
    const isXlsx = lower.endsWith('.xlsx');
    const isDocx = lower.endsWith('.docx');
    if (!isXlsx && !isDocx) return MIME.zip;
    const names = zipEntryNames(data);
    if (names?.has('[Content_Types].xml')) {
      if (isXlsx && names.has('xl/workbook.xml')) return MIME.xlsx;
      if (isDocx && names.has('word/document.xml')) return MIME.docx;
    }
    return MIME.zip;
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME.png;
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return MIME.jpeg;
  const head = data.subarray(0, 4096);
  if (head.includes(0)) return 'application/octet-stream';
  const start = head.toString('utf8').replace(BOM, '').trimStart().toLowerCase();
  if (['<!doctype', '<html', '<svg', '<?xml', '<head', '<body'].some((m) => start.startsWith(m))) return 'text/html';
  // JSON only when the bytes parse, and they are parsed only up to 16 MiB (a 200 MB parse would block the n8n process).
  // Above that: JSON when the name ends in .json and the first non-whitespace byte is { or [, else text.
  if (data.length > MAX_JSON_SNIFF_BYTES) {
    const first = firstNonSpace(data);
    if (lower.endsWith('.json') && (first === '{' || first === '[')) return MIME.json;
    return lower.endsWith('.csv') ? MIME.csv : MIME.text;
  }
  if (lower.endsWith('.json') || start.startsWith('{') || start.startsWith('[')) {
    try {
      JSON.parse(data.toString('utf8').replace(BOM, ''));
      return MIME.json;
    } catch {
      // Not JSON after all (for example "[x],y" in a CSV): fall through to text.
    }
  }
  return lower.endsWith('.csv') ? MIME.csv : MIME.text;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Promise<void>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { onTimeout().then(() => reject(new Error(message)), () => reject(new Error(message))); }, ms);
  });
  try { return await Promise.race([p, expired]); } finally { clearTimeout(timer); }
}

/** The declared target as an allowed submission, refused (fatal) when the policy does not allow it. */
function assertAllowedSubmit(ctx: StepContext, t: SubmitTarget): AllowedSubmit {
  const k = submitKey(t, ctx.script.startUrl);
  if (!isAllowedSubmit(ctx.policy, k)) {
    ctx.violations.push({ kind: 'write', url: `${k.host}${k.path}`, method: k.method, fatal: true });
    throw new PolicyError(`submit ${submitLabel(k)} is not an allowed submission`);
  }
  return k;
}

/** The window of a declared target: its form may be posted only while this step's click runs. */
function targetWindow(ctx: StepContext, target: AllowedSubmit): WindowGate {
  return { open: () => ctx.armSubmit?.(target), close: () => ctx.armSubmit?.(null) };
}

const submit: Handler = async (ctx, step, state, timeout) => {
  const s = (step as S<'submit'>).submit;
  const target = assertAllowedSubmit(ctx, s);
  const b = await resolveUnique(ctx.page, s.button, timeout);
  // This step's form may be posted only from here to network quiet after the click.
  await withWindow(ctx, targetWindow(ctx, target), async () => {
    await b.locator.click({ timeout });
    state.submitted = true; // once a submit was sent, results say so
  }, timeout);
  await settle(ctx.page);
  return b.candidate;
};

const download: Handler = async (ctx, step, state, timeout) => {
  const d = (step as S<'download'>).download;
  const via = d.via ? assertAllowedSubmit(ctx, d.via) : undefined;
  const trig = await resolveUnique(ctx.page, d.trigger, timeout);
  // A top-level plain download whose click went through but brought no file leaves a marker: the click still happened
  // (it may have opened a format dialog), so a repair from here replays it (RunState.clickedTrigger).
  const index = !via && ctx.topStep === step ? ctx.stepIndex : undefined;
  // The declared form may be posted only until its download arrives.
  const [dl] = await withWindow(ctx, via && targetWindow(ctx, via), () => {
    const clicked = trig.locator.click({ timeout }).then(() => {
      if (via) state.submitted = true;
      else if (index !== undefined) state.clickedTrigger = { index };
    });
    return Promise.all([ctx.page.waitForEvent('download', { timeout }), clicked]);
  });
  // A download came: the click did what the step expects, whatever happens to the file next.
  delete state.clickedTrigger;
  const max = d.maxBytes ?? DEFAULT_MAX_BYTES;
  // Playwright only streams finished downloads, so the byte cap is applied after completion;
  // the wait itself is bounded by the step timeout.
  const stream = await withTimeout(dl.createReadStream(), timeout, async () => { await dl.cancel().catch(() => undefined); }, `download did not finish within ${timeout} ms`);
  const chunks: Buffer[] = [];
  let size = 0;
  // The run-wide binary cap is checked while streaming, so an over-cap file is never held in full.
  const before = runBinaryBytes(state);
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > max) {
      stream.destroy();
      await dl.cancel().catch(() => undefined);
      throw new Error(`download exceeds ${max} bytes`);
    }
    if (before + size > MAX_RUN_BINARY_BYTES) {
      stream.destroy();
      await dl.cancel().catch(() => undefined);
      throw new Error(runBinaryTooLarge(before + size));
    }
    chunks.push(buf);
  }
  const data = Buffer.concat(chunks);
  const fileName = sanitizeFileName(ctx.masker.mask(dl.suggestedFilename()));
  const mimeType = sniffMime(data, fileName);
  const allowed = d.mime ?? DEFAULT_MIME;
  if (!allowed.includes(mimeType)) throw new Error(`download type ${mimeType} is not allowed`);
  const name = binaryName(state, 'download', ctx.stepIndex ?? 0);
  if (!d.check) {
    state.downloads.push({ fileName, mimeType, data, binaryName: name });
    return trig.candidate;
  }
  const checked = checkFile({ fileName, mimeType, data }, d.check);
  if (!checked.ok) throw new Error(`${FILE_CHECK_FAILED_PREFIX}${ctx.masker.mask(checked.reason)}`);
  // Header text comes from the page's file: it is masked like the file name.
  const facts = { columns: checked.facts.columns && checked.facts.columns.map((c) => ctx.masker.mask(c)), rows: checked.facts.rows };
  state.downloads.push({ fileName, mimeType, data, binaryName: name, facts });
  return trig.candidate;
};

const popup: Handler = async (ctx, step, _state, timeout) => {
  const p = (step as S<'popup'>).popup;
  const t = await resolveUnique(ctx.page, p.trigger, timeout);
  const [next] = await Promise.all([ctx.page.waitForEvent('popup', { timeout }), t.locator.click({ timeout })]);
  await next.waitForLoadState('domcontentloaded', { timeout });
  ctx.interrupts = await installInterrupts(next, ctx.script.interrupts);
  ctx.page = next;
  return t.candidate;
};

registerHandlers('browser', { submit, download, popup });
