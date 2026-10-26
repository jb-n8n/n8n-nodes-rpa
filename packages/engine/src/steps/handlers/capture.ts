import type { Frame, Page } from 'playwright-core';
import {
  captureTooLarge, describeForUser, elementTooTall, FRAME_NOT_CHECKED, NOT_A_TABLE, PAGE_SHOWS_CREDENTIAL, PDF_NEEDS_HEADLESS, PDF_TIMED_OUT,
  screenshotTooTall, tooManyRows,
} from '../../messages.js';
import { MAX_ROWS, type Locator, type Row, type Step, type StepOutput } from '../../types.js';
import { PolicyError } from '../errors.js';
import { assertRowTextRoom, assertRunBinaryRoom, regexSubject } from '../limits.js';
import { resolveUnique } from '../locator.js';
import { screenshotMasks } from '../masks.js';
import { outputUrl, shownUrl } from '../urls.js';
import type { Handler, StepContext } from '../run.js';
import { binaryName, MIME, withTimeout } from './files.js';
import { registerHandlers } from './index.js';

/** Output caps for read and capture steps. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_SCREENSHOT_HEIGHT = 16_384;
export const MAX_CAPTURE_BYTES = 52_428_800;

type S<K extends string> = Extract<Step, Record<K, unknown>>;
const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0];
/** Chromium's ways of saying it cannot print (headed browsers, some CDP vendors). */
const PDF_UNSUPPORTED = /(pdf|print)[^\n]*(headless|not available|not supported|unsupported)|(headless|not available|not supported|unsupported)[^\n]*(pdf|print)/i;

/** Caps a string at maxBytes of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { text: s, truncated: false };
  const buf = Buffer.from(s, 'utf8');
  let cut = maxBytes;
  // buf[cut] is the first byte left out: if it continues a character, that character starts before the cut.
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

/**
 * Names that a header never takes as is: `id` is the row ID (set only by an ID Pattern), and the object-prototype names
 * would be dropped or misread as row keys. Each becomes name_2 (or the next free suffix).
 */
const RESERVED_HEADERS = ['id', '__proto__', 'constructor', 'prototype'];

/** Header names: an empty header becomes column_N (1-based), a repeat becomes name_2, name_3 … (always unique). */
export function tableHeaders(raw: string[]): string[] {
  const taken = new Set<string>(RESERVED_HEADERS);
  return raw.map((h, i) => {
    const base = h || `column_${i + 1}`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    return name;
  });
}

/**
 * What a PDF or screenshot of one document could show as text: the visible text, every form-control value (and the
 * selected option's text), and the text of every open shadow root, walked recursively. Shadow text is taken whole
 * (textContent, hidden text included): the check errs toward refusing.
 */
function documentShows(): string[] {
  const shown = [document.body?.innerText ?? ''];
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    for (const el of Array.from(root.querySelectorAll('input:not([type=hidden]), textarea, select'))) {
      shown.push((el as HTMLInputElement).value ?? '');
      if (el instanceof HTMLSelectElement) for (const o of Array.from(el.selectedOptions)) shown.push(o.text);
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const shadow = el.shadowRoot;
      if (shadow) {
        shown.push(shadow.textContent ?? '');
        roots.push(shadow);
      }
    }
  }
  return shown;
}

/** One frame's check, bounded by the step timeout. */
const frameShows = (frame: Frame, timeoutMs: number): Promise<string[]> =>
  withTimeout(frame.evaluate(documentShows), timeoutMs, async () => undefined, FRAME_NOT_CHECKED);

/**
 * Everything a capture of the page could show as text, from the main frame and every child frame. A detached child
 * frame is skipped; any other frame that cannot be read (error or timeout), the main frame included, refuses the
 * capture with an incomplete `capture:` failure: a capture never runs unchecked.
 */
async function pageShows(page: Page, timeoutMs: number): Promise<string[]> {
  const main = page.mainFrame();
  let shown: string[];
  try {
    shown = await frameShows(main, timeoutMs);
  } catch {
    throw new Error(FRAME_NOT_CHECKED);
  }
  for (const frame of page.frames()) {
    if (frame === main) continue;
    try {
      shown.push(...(await frameShows(frame, timeoutMs)));
    } catch {
      if (frame.isDetached()) continue;
      throw new Error(FRAME_NOT_CHECKED);
    }
  }
  return shown;
}

/**
 * With a Site Login, a capture of a page that shows a secret (visible text, a form value, or either inside a frame) is
 * refused.
 */
async function refuseIfSecretShown(ctx: StepContext, timeoutMs: number): Promise<void> {
  if (!ctx.secrets) return;
  const shown = await pageShows(ctx.page, timeoutMs);
  if (!shown.some((s) => ctx.masker.containsSecret(s))) return;
  // The violation's URL is shown in messages: origin + path only.
  ctx.violations.push({ kind: 'secret', url: shownUrl(ctx.page.url()), fatal: true });
  throw new PolicyError(PAGE_SHOWS_CREDENTIAL);
}

/** Runs a Playwright capture call; a failure (other than a closed page) becomes an incomplete `capture:` failure, not drift. */
async function captured<T>(ctx: StepContext, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (ctx.page.isClosed()) throw err;
    throw new Error(`capture: the ${what} could not be taken: ${firstLine(err)}`);
  }
}

/**
 * The page's full content height in CSS px, as a full-page screenshot would draw it: CDP layout metrics on Chromium
 * (they see content that scrollHeight misses), else the larger scrollHeight. The CDP session is always closed.
 */
async function contentHeight(page: Page): Promise<number> {
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const m = await cdp.send('Page.getLayoutMetrics');
      if (m.cssContentSize && Number.isFinite(m.cssContentSize.height)) return Math.ceil(m.cssContentSize.height);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    // Not Chromium, or CDP refused: fall back to the DOM.
  }
  return page.evaluate(() => Math.max(document.documentElement?.scrollHeight ?? 0, document.body?.scrollHeight ?? 0));
}

const screenshot: Handler = async (ctx, step, state, timeout) => {
  const s = (step as S<'screenshot'>).screenshot;
  const index = ctx.stepIndex ?? 0;
  await refuseIfSecretShown(ctx, timeout);
  const mask = ctx.secrets ? screenshotMasks(ctx.page, ctx.secrets) : [];
  let data: Buffer;
  let candidate: number | undefined;
  if (s.capture === 'element') {
    const hit = await resolveUnique(ctx.page, s.element as Locator, timeout);
    candidate = hit.candidate;
    const box = await hit.locator.boundingBox();
    if (box && box.height > MAX_SCREENSHOT_HEIGHT) throw new Error(elementTooTall(Math.ceil(box.height)));
    data = await captured(ctx, 'screenshot', () => hit.locator.screenshot({ timeout, mask }));
  } else {
    if (s.capture === 'full') {
      const height = await contentHeight(ctx.page);
      if (height > MAX_SCREENSHOT_HEIGHT) throw new Error(screenshotTooTall(height));
    }
    data = await captured(ctx, 'screenshot', () => ctx.page.screenshot({ fullPage: s.capture === 'full', timeout, mask }));
  }
  if (data.length > MAX_CAPTURE_BYTES) throw new Error(captureTooLarge('screenshot', data.length));
  assertRunBinaryRoom(state, data.length);
  const name = binaryName(state, 'screenshot', index);
  state.outputs.push({ index, verb: 'screenshot', binary: { name, fileName: `${name}.png`, mimeType: MIME.png, data } });
  return candidate;
};

const pdf: Handler = async (ctx, step, state, timeout) => {
  const p = (step as S<'pdf'>).pdf;
  const index = ctx.stepIndex ?? 0;
  await refuseIfSecretShown(ctx, timeout);
  let data: Buffer;
  try {
    data = await withTimeout(ctx.page.pdf({ format: p.paper ?? 'A4', printBackground: p.background ?? false }), timeout, async () => undefined, PDF_TIMED_OUT);
  } catch (err) {
    if (ctx.page.isClosed()) throw err;
    const message = firstLine(err);
    if (message === PDF_TIMED_OUT) throw err;
    if (PDF_UNSUPPORTED.test(message)) throw new Error(PDF_NEEDS_HEADLESS);
    throw new Error(`capture: the PDF could not be made: ${message}`);
  }
  if (data.length > MAX_CAPTURE_BYTES) throw new Error(captureTooLarge('PDF', data.length));
  assertRunBinaryRoom(state, data.length);
  const name = binaryName(state, 'pdf', index);
  state.outputs.push({ index, verb: 'pdf', binary: { name, fileName: `${name}.pdf`, mimeType: MIME.pdf, data } });
};

const read: Handler = async (ctx, step, state) => {
  const { what } = (step as S<'read'>).read;
  const out: StepOutput = { index: ctx.stepIndex ?? 0, verb: 'read' };
  if (what === 'text' || what === 'html') {
    // Visible text (innerText), not textContent; HTML is the serialised DOM (doctype + documentElement, as
    // page.content() builds it). Cut in the page to twice the cap before it crosses to Node: the margin lets a secret
    // that straddles the cut still be masked. Then masked, then capped.
    const page = await ctx.page.evaluate(([html, n]) => {
      let s: string;
      if (html) {
        const d = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '';
        s = d + (document.documentElement?.outerHTML ?? '');
      } else {
        s = document.body?.innerText ?? '';
      }
      return { s: s.slice(0, n), cut: s.length > n };
    }, [what === 'html', 2 * MAX_TEXT_BYTES] as const);
    // A secret cut by the slice end is only partly there and the masker misses it; masking can shrink the text below the
    // cap, so truncateUtf8 might keep that partial. Whole secrets are masked first; then the last maxLength characters of
    // a cut text are dropped: an unmasked partial is always shorter than that and always at the very end. (Dropping
    // before masking would only move the cut into the middle of another secret.)
    const masked = ctx.masker.mask(page.s);
    const kept = page.cut ? masked.slice(0, Math.max(0, masked.length - ctx.masker.maxLength)) : masked;
    const { text, truncated } = truncateUtf8(kept, MAX_TEXT_BYTES);
    out[what] = text;
    if (truncated || page.cut) out.truncated = true;
  } else if (what === 'title') {
    // Masked first, then capped, like text and HTML.
    const { text, truncated } = truncateUtf8(ctx.masker.mask(await ctx.page.title()), MAX_TEXT_BYTES);
    out.title = text;
    if (truncated) out.truncated = true;
  } else {
    // The page's own URL, query included (it is output, not a message), sanitised by outputUrl: no userinfo or
    // fragment, credential-named query values redacted. Then masked.
    out.url = ctx.masker.mask(outputUrl(ctx.page.url()));
  }
  state.outputs.push(out);
};

const extractTable: Handler = async (ctx, step, state, timeout) => {
  const t = (step as S<'extractTable'>).extractTable;
  const { locator, candidate } = await resolveUnique(ctx.page, t.table, timeout);
  const grid = await locator.evaluate((el) => {
    if (el.tagName !== 'TABLE') return null;
    const table = el as HTMLTableElement;
    const cellText = (c: Element) => ((c as HTMLElement).innerText ?? c.textContent ?? '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(table.rows);
    // Headers come from thead, else the first row; colspan is not expanded (cells are taken in order).
    const head = table.tHead && table.tHead.rows.length > 0 ? table.tHead.rows[0] : rows[0];
    const body = rows.filter((r) => r !== head && !(table.tHead !== null && table.tHead.contains(r)));
    return { headers: head ? Array.from(head.cells).map(cellText) : [], rows: body.map((r) => Array.from(r.cells).map(cellText)) };
  });
  if (!grid) throw new Error(NOT_A_TABLE(describeForUser(t.table)));
  const headers = tableHeaders(grid.headers.map((h) => ctx.masker.mask(h)));
  const idRe = t.idPattern !== undefined ? new RegExp(t.idPattern) : undefined;
  const seen = new Set(state.rows.flatMap((r) => (r.id !== undefined ? [r.id] : [])));
  const fresh: Row[] = [];
  for (const cells of grid.rows) {
    const values = cells.map((c) => ctx.masker.mask(c));
    const row: Row = {};
    headers.forEach((h, j) => { row[h] = values[j] ?? ''; });
    if (idRe) {
      // Cell text is page-controlled: the regex subject is capped (ReDoS bound, steps/limits.ts).
      const id = values.map((v) => idRe.exec(regexSubject(v))?.[0]).find((m) => m !== undefined);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      row.id = id;
    }
    fresh.push(row);
  }
  if (state.rows.length + fresh.length > MAX_ROWS) throw new Error(tooManyRows(MAX_ROWS));
  // Evidence is the page's visible text: grounding finds every cell, and a stated total outside the table still counts.
  const pageText = await ctx.page.evaluate(() => document.body?.innerText ?? '');
  assertRowTextRoom(state, fresh);
  state.evidence.push({ url: ctx.page.url(), text: ctx.masker.mask(pageText.replace(/\s+/g, ' ').trim()) });
  state.rows.push(...fresh);
  state.extractRan = true;
  return candidate;
};

registerHandlers({ screenshot, pdf, read, extractTable });
