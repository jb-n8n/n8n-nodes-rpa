import type { Masker } from '../secrets/mask.js';
import type { DownloadedFile } from '../types.js';

/** The file a file task's proof downloaded, as the reviewer sees it. Strings are masked; at most 50 columns of 80 characters. */
export type FileEvidence = { fileName: string; mimeType: string; bytes: number; columns: string[] | null; rows: number | null };

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
