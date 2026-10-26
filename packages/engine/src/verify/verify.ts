import { countMismatch } from '../messages.js';
import { regexSubject } from '../steps/limits.js';
import type { Evidence, OutputSpec, Row } from '../types.js';

const stripCommas = (s: string) => s.replace(/,/g, '');

/**
 * The row total the page states. `text` is the matched wording of that total (for the count-mismatch message).
 * Only a configured `totalPattern` is checked (its first capture group, or the whole match, is the number); with none,
 * nothing is detected, so page text such as "1-3 of 5" or "4-5 of 5 stars" can never fail or confirm a run.
 */
export function detectTotal(evidence: Evidence[], totalPattern?: string): {
  total: number | null; text: string | null; conflict: number[] | null; unparsed: boolean; invalid: boolean;
} {
  const totals = new Map<number, string>();
  if (!totalPattern) return { total: null, text: null, conflict: null, unparsed: false, invalid: false };
  let unparsed = false;
  let patternRegex: RegExp | undefined;
  if (totalPattern) {
    try {
      patternRegex = new RegExp(totalPattern, 'i');
    } catch {
      return { total: null, text: null, conflict: null, unparsed: false, invalid: true };
    }
  }
  for (const e of evidence) {
    if (patternRegex) {
      // Evidence is page text: every regex subject is capped (ReDoS bound, steps/limits.ts).
      const m = patternRegex.exec(regexSubject(e.text));
      if (m) {
        const num = Number(stripCommas(m[1] ?? m[0]));
        if (Number.isFinite(num)) { if (!totals.has(num)) totals.set(num, m[0]); } else unparsed = true;
      }
    }
  }
  const list = [...totals.keys()].sort((a, b) => a - b);
  if (list.length === 0) return { total: null, text: null, conflict: null, unparsed, invalid: false };
  if (list.length > 1) return { total: null, text: null, conflict: list, unparsed, invalid: false };
  return { total: list[0], text: totals.get(list[0]) ?? null, conflict: null, unparsed, invalid: false };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Chunk { text: string; flat: string }
function chunkHas(chunk: Chunk, field: string, value: string): boolean {
  // An escaped literal with fixed-width lookarounds: linear, no backtracking, so the whole evidence is searched.
  if (field === 'id') return new RegExp(`(?<![\\w-])${escapeRe(value)}(?![\\w-])`).test(chunk.text);
  return chunk.flat.includes(squash(value));
}

export interface VerifyResult {
  ok: boolean;
  reasons: string[];
  count: number;
  total: number | null;
}

/**
 * Checks extracted rows with the configured checks only: at least one row (unless the page's own empty text matches),
 * IDs (non-empty, matching, unique) only when `output.idPattern` is set, required fields, the count against the total
 * the page states only when `output.totalPattern` is set, and (grounding, on by default) every row's values found together in one piece of evidence.
 * `ungroundedFields` (attribute-sourced fields: DOM values the text evidence cannot contain) skip grounding only.
 * Returns all failure reasons, never throws.
 */
export function verifyRows(input: {
  rows: Row[]; evidence: Evidence[]; output: OutputSpec; requireGrounding?: boolean; ungroundedFields?: readonly string[];
}): VerifyResult {
  const { rows, evidence, output } = input;
  const reasons: string[] = [];
  if (rows.length === 0) {
    let pageSaysEmpty = false;
    if (output.emptyPattern) {
      try {
        const re = new RegExp(output.emptyPattern, 'i');
        if (re.test('')) reasons.push('invalid empty pattern');
        else pageSaysEmpty = evidence.length > 0 && evidence.every((e) => re.test(regexSubject(e.text)));
      } catch {
        reasons.push('invalid empty pattern');
      }
    }
    if (!pageSaysEmpty) reasons.push(output.emptyPattern ? 'no rows were extracted and the page did not say it has none' : 'no rows were extracted');
  }

  let idRe: RegExp | null = null;
  if (output.idPattern) {
    try {
      idRe = new RegExp(`^(?:${output.idPattern})$`);
    } catch {
      reasons.push('invalid ID pattern');
    }
  }
  const label = (r: Row, i: number) => (output.idPattern && r.id ? r.id : String(i + 1));
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (output.idPattern) {
      if (!r.id || !r.id.trim()) { reasons.push('a row has an empty ID'); return; }
      if (idRe && !idRe.test(regexSubject(r.id))) reasons.push(`ID ${r.id} does not match the ID pattern`);
      if (seen.has(r.id)) reasons.push(`duplicate ID ${r.id}`);
      seen.add(r.id);
    }
    for (const f of output.requiredFields ?? []) if (!r[f] || !r[f].trim()) reasons.push(`row ${label(r, i)}: field "${f}" is empty`);
  });

  const { total, text, conflict, unparsed, invalid } = detectTotal(evidence, output.totalPattern);
  if (invalid) reasons.push('invalid total pattern');
  if (unparsed) reasons.push('total pattern matched but did not capture a number');
  if (conflict) reasons.push(`the page shows conflicting totals ${conflict.join(', ')}`);
  if (total !== null && total !== rows.length) reasons.push(countMismatch(total, text ?? String(total), rows.length));

  if (input.requireGrounding ?? true) {
    const chunks: Chunk[] = evidence.map((e) => ({ text: e.text, flat: squash(e.text) }));
    const skip = new Set(input.ungroundedFields ?? []);
    rows.forEach((r, i) => {
      const fields = Object.entries(r).filter(([k, v]) => !skip.has(k) && typeof v === 'string' && v.trim());
      const grounded = chunks.some((c) => fields.every(([k, v]) => chunkHas(c, k, v)));
      if (!grounded) reasons.push(`row ${label(r, i)}: values were not found together on any page that was read`);
    });
  }
  return { ok: reasons.length === 0, reasons, count: rows.length, total };
}
