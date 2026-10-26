// Run-wide output limits shared by the capture and file handlers and the lanes. A leaf module: no handler or lane imports.
import { rowTextTooLarge, runBinaryTooLarge } from '../messages.js';
import type { Row, RunState } from '../types.js';

/** Every capture and download of one run together. */
export const MAX_RUN_BINARY_BYTES = 262_144_000;

/** The UTF-8 bytes of row text one run may hold, across all its rows. */
export const MAX_ROW_TEXT_BYTES = 20 * 1024 * 1024;

/** The UTF-8 bytes of every value of these rows. */
function rowTextBytes(rows: readonly Row[]): number {
  let total = 0;
  for (const r of rows) for (const v of Object.values(r)) if (typeof v === 'string') total += Buffer.byteLength(v, 'utf8');
  return total;
}

/** Throws the `limit:` error when the run's rows plus `adding` would hold more than MAX_ROW_TEXT_BYTES of text. */
export function assertRowTextRoom(state: Pick<RunState, 'rows'>, adding: readonly Row[], max = MAX_ROW_TEXT_BYTES): void {
  const total = rowTextBytes(state.rows) + rowTextBytes(adding);
  if (total > max) throw new Error(rowTextTooLarge(total));
}

/**
 * The longest page-controlled text a user-supplied regex (ID Pattern, Text That Means No Results, Total Pattern, field
 * patterns) is run against: 1 MiB. ReDoS bound: V8 regexes cannot be interrupted, so a super-linear pattern on page text
 * of unbounded length could stall the n8n process; capping the subject bounds the cost of any polynomial backtracking.
 * (An exponential pattern stays the author's responsibility: these patterns come from the node configuration.)
 */
export const MAX_REGEX_SUBJECT = 1024 * 1024;
/**
 * Overlap of consecutive windows in regexMatches. Each window owns the matches that start in its first
 * (size - overlap) characters, so a match up to `overlap` characters long is always seen whole by its owner. A longer
 * match (an ID over 4096 characters) can be cut at a window end.
 */
const REGEX_WINDOW_OVERLAP = 4096;

/** `text` cut to MAX_REGEX_SUBJECT characters for a regex match. */
export function regexSubject(text: string): string {
  return text.length > MAX_REGEX_SUBJECT ? text.slice(0, MAX_REGEX_SUBJECT) : text;
}

/**
 * Every match of `pattern` in all of `text`, in order and lazily, each regex run on a window of at most `size` characters
 * (MAX_REGEX_SUBJECT). Windows overlap by `overlap`; a window other than the last keeps only the matches that start
 * before `size - overlap`, so a match that crosses a window end (seen cut off there) is taken from the next window,
 * whole, and exactly once. `limits` is a test seam.
 */
export function* regexMatches(
  text: string, pattern: string, limits: { size: number; overlap: number } = { size: MAX_REGEX_SUBJECT, overlap: REGEX_WINDOW_OVERLAP },
): Generator<string, void, undefined> {
  const { size, overlap } = limits;
  if (!(overlap >= 0 && overlap < size)) throw new Error('regexMatches: the overlap must be smaller than the window');
  const step = size - overlap;
  // A generator: matches are found one at a time, so a caller that stops at its row cap never materialises the rest.
  for (let start = 0; ; start += step) {
    const last = start + size >= text.length;
    for (const m of text.slice(start, start + size).matchAll(new RegExp(pattern, 'g'))) {
      if (last || m.index < step) yield m[0];
    }
    if (last) return;
  }
}

/** Every binary byte a run produced: captures and downloads. */
export function runBinaryBytes(state: Pick<RunState, 'outputs' | 'downloads'>): number {
  let total = 0;
  for (const o of state.outputs) total += o.binary?.data.length ?? 0;
  for (const d of state.downloads) total += d.data.length;
  return total;
}

/** The limit message when a run's binaries exceed `max` (default 262,144,000 bytes), else undefined. */
export function runBinaryProblem(state: Pick<RunState, 'outputs' | 'downloads'>, max = MAX_RUN_BINARY_BYTES): string | undefined {
  const total = runBinaryBytes(state);
  return total > max ? runBinaryTooLarge(total) : undefined;
}

/**
 * Throws the `limit:` run-cap error when adding `adding` bytes would take the run's binaries over `max`. Handlers call
 * it before they keep a capture or download, so the run never holds more than the cap (runBinaryProblem is the backstop).
 */
export function assertRunBinaryRoom(state: Pick<RunState, 'outputs' | 'downloads'>, adding: number, max = MAX_RUN_BINARY_BYTES): void {
  const total = runBinaryBytes(state) + adding;
  if (total > max) throw new Error(runBinaryTooLarge(total));
}
