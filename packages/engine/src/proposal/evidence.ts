import type { Masker } from '../secrets/mask.js';
import type { DownloadedFile } from '../types.js';

/** The file a file task's proof downloaded, as the reviewer sees it. Strings are masked; at most 50 columns of 80 characters. */
export type FileEvidence = { fileName: string; mimeType: string; bytes: number; columns: string[] | null; rows: number | null };

/** One of several files a proof downloaded: the file's evidence and the number of the step that downloaded it (1-based). */
export type StepFileEvidence = { step: number } & FileEvidence;

const MAX_EVIDENCE_COLUMNS = 50;
const MAX_EVIDENCE_COLUMN_CHARS = 80;

/** Evidence for a downloaded file (or evidence again, idempotently): every page-derived string masked, columns clipped. */
export function fileEvidence(file: Pick<DownloadedFile, 'fileName' | 'mimeType' | 'facts'> & { bytes: number }, masker: Masker): FileEvidence {
  const columns = file.facts?.columns ?? null;
  return {
    fileName: masker.mask(file.fileName),
    mimeType: masker.mask(file.mimeType),
    bytes: file.bytes,
    columns: columns ? columns.slice(0, MAX_EVIDENCE_COLUMNS).map((c) => masker.mask(c).slice(0, MAX_EVIDENCE_COLUMN_CHARS)) : null,
    rows: file.facts?.rows ?? null,
  };
}

/**
 * The evidence line of a proof with several files or a screenshot, without the "; …" tail the caller may add: each step
 * that downloaded a file (its name, type, size and rows when counted) or took a screenshot, in step order. Holds no
 * "; " (file names are sanitized and MIME types are type/subtype), so a page that shows the line up to its first "; "
 * shows every file.
 */
export function filesEvidenceText(e: { files: StepFileEvidence[]; screenshots: number[] }): string {
  const parts = [
    ...e.files.map((f) => ({ step: f.step, text: `step ${f.step} downloaded ${JSON.stringify(f.fileName)} (${f.mimeType}, ${f.bytes} bytes${f.rows !== null ? `, ${f.rows} rows` : ''})` })),
    ...e.screenshots.map((step) => ({ step, text: `step ${step} took a screenshot` })),
  ].sort((a, b) => a.step - b.step).map((p) => p.text);
  const all = parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `Proven in a fresh browser: ${all}${e.files.length ? '; every file passed the checks its step declares' : ''}`;
}
