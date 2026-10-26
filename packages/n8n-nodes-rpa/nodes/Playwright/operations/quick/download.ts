import { ConfigError } from '../../config.js';
import { DEFAULT_FILE_TYPES, FILE_TYPES } from '../../description/download.js';
import { quickEnvelope } from '../../output.js';
import { asNumber, asString, splitList } from '../common.js';
import { locatorValue, outputProperty, toLocator, type QuickCompiler, type QuickOutput } from './shared.js';

export const MB = 1_048_576;
export const FILE_TYPES_EMPTY = 'Allowed File Types needs at least one type';
export const fileTypeUnknown = (t: string): string => `Allowed File Types has an unknown type "${t}"`;
export const MAX_FILE_SIZE_RANGE = 'Max File Size must be more than 0 and at most 200 MB';

const KNOWN = new Set(FILE_TYPES.map((t) => t.value));

/** Options → Allowed File Types: a multiOptions array (or comma-separated text from an expression); unset → the default four. */
function fileTypes(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [...DEFAULT_FILE_TYPES];
  const types = (Array.isArray(raw) ? raw.map((t) => asString(t).trim()) : splitList(asString(raw))).filter(Boolean);
  if (types.length === 0) throw new ConfigError(FILE_TYPES_EMPTY);
  for (const t of types) if (!KNOWN.has(t)) throw new ConfigError(fileTypeUnknown(t));
  return types;
}

/** Options → Max File Size in MB (decimals allowed), more than 0 and at most 200. */
function maxBytes(raw: unknown): number {
  const mb = raw === undefined || raw === null || raw === '' ? 50 : asNumber(raw, Number.NaN);
  if (!Number.isFinite(mb) || mb <= 0 || mb > 200) throw new ConfigError(MAX_FILE_SIZE_RANGE);
  return Math.max(1, Math.floor(mb * MB));
}

/** Download File → one download step. Never `via`: a download that needs a POST is a Run Steps job. */
export const compileDownload: QuickCompiler = (params) => {
  const label = 'Download Link or Button';
  outputProperty(params.options, 'fileProperty', 'file'); // a bad Put Output in Field fails before the run
  const trigger = toLocator(locatorValue(params.downloadTrigger), label);
  return {
    script: { steps: [{ intent: 'Download the file', download: { trigger, mime: fileTypes(params.options.allowedFileTypes), maxBytes: maxBytes(params.options.maxFileSizeMb) } }] },
    vars: {},
  };
};

/** The envelope plus fileName, mimeType and bytes, and the file under Options → Put Output in Field (default "file"). Never extracted. */
export const downloadOutput: QuickOutput = async (ctx, run) => {
  const file = run.result.files[0];
  if (!file) throw new Error('the run finished without a downloaded file');
  const property = outputProperty(run.params.options, 'fileProperty', 'file');
  return [
    {
      json: quickEnvelope(run.result, run.compiled, { fileName: file.fileName, mimeType: file.mimeType, bytes: file.data.length }),
      binary: { [property]: await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType) },
    },
  ];
};
