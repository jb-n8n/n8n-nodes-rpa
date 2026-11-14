// Which import source a file holds, for Import Steps → Source → Work It Out From the File. The file name decides first
// (an RPA recording's .rpa-recording.json, a UiPath .zip or .xaml, Playwright .js or .ts); otherwise a ZIP's first bytes,
// and JSON by its shape. The file is only read as data: nothing in it is evaluated. Undefined when it cannot tell.
import { isObject, MAX_IMPORT_JSON_BYTES, readJson, type Json } from './read.js';
import { RECORDING_FORMAT } from './recording.js';
import type { ImportSource } from './types.js';
const nonEmptyList = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0;

/** The shape of parsed JSON: a recording, a Chrome Recorder export (steps with a type) or a step document (steps with an intent). */
function shapeOf(value: unknown): ImportSource | undefined {
  if (isObject(value) && value.format === RECORDING_FORMAT) return 'recording';
  if (isObject(value) && value.surface === 'desktop') return 'steps';
  const steps = isObject(value) ? value.steps : value;
  if (!nonEmptyList(steps) || !steps.every(isObject)) return undefined;
  const list = steps as Json[];
  if (list.every((s) => typeof s.type === 'string' && s.intent === undefined)) return isObject(value) ? 'chrome' : undefined;
  if (list.every((s) => typeof s.intent === 'string')) return 'steps';
  return undefined;
}

/** The import source of a file, from its name (may be empty) and its bytes or text; undefined when it cannot tell. Never throws. */
export function detectImportSource(fileName: string | undefined, data: Buffer | Uint8Array | string): ImportSource | undefined {
  const name = (fileName ?? '').toLowerCase();
  if (name.endsWith('.rpa-recording.json')) return 'recording';
  if (name.endsWith('.zip') || name.endsWith('.xaml')) return 'uipath';
  if (/\.(?:[cm]?js|ts)$/.test(name)) return 'playwright';
  const bytes = typeof data === 'string' ? undefined : data;
  if (bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'uipath';
  // At most what the importers read is parsed to look at its shape: they refuse larger JSON anyway.
  if ((bytes ? bytes.byteLength : data.length) > MAX_IMPORT_JSON_BYTES) return undefined;
  const read = readJson(data, Number.POSITIVE_INFINITY);
  return 'value' in read ? shapeOf(read.value) : undefined;
}
