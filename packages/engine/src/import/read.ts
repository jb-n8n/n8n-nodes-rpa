// Reading an imported file: its bytes or text, refused over a size cap before anything is decoded or parsed.

/** The cap for an imported JSON file: a Chrome Recorder export, an RPA recording or a step document. */
export const MAX_IMPORT_JSON_BYTES = 5 * 1024 * 1024;

export type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a file was not read; each importer words it for its own source. */
export type ReadProblem = 'tooLarge' | 'notText' | 'notJson';

/** The text of `data` (a string or bytes, decoded as UTF-8), or why not: more than `maxBytes`, or neither. A leading BOM is dropped. */
export function readText(data: unknown, maxBytes: number): { text: string } | { problem: ReadProblem } {
  let text: string;
  if (typeof data === 'string') {
    // A string has no more UTF-16 units than UTF-8 bytes, so a long one is refused without measuring it.
    if (data.length > maxBytes || Buffer.byteLength(data, 'utf8') > maxBytes) return { problem: 'tooLarge' };
    text = data;
  } else if (data instanceof Uint8Array) {
    if (data.byteLength > maxBytes) return { problem: 'tooLarge' };
    text = new TextDecoder('utf-8').decode(data);
  } else {
    return { problem: 'notText' };
  }
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}

/** readText, then JSON. JSON.parse's own message quotes the input, which may hold a typed password, so it is never kept. */
export function readJson(data: unknown, maxBytes: number): { value: unknown } | { problem: ReadProblem } {
  const read = readText(data, maxBytes);
  if ('problem' in read) return read;
  try {
    return { value: JSON.parse(read.text) as unknown };
  } catch {
    return { problem: 'notJson' };
  }
}
