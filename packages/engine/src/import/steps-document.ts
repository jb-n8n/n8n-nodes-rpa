// A step document as an import source: steps written by hand, as Run Steps takes them (a step document, a bare array of
// steps, or a desktop step set). It is data: it is read as JSON and checked by the step parsers, and nothing in it is
// evaluated. A browser document becomes one draft and a desktop step set one desktop draft, under the import's Name and
// as version 1, so each goes the way every import's drafts go: a browser draft is run once and replayed without writes,
// a desktop draft goes to approval as written. A signature that came with the document is not imported.
import { createMasker } from '../secrets/mask.js';
import { isDesktopDocument, parseDesktopScript, parseScript, ScriptShapeError } from '../steps/parse.js';
import type { DesktopScript, Script } from '../types.js';
import { MAX_CHROME_BYTES } from './chrome.js';
import { MIN_SECRET_LENGTH } from './draft.js';
import type { ImportOptions, ImportReport, ImportResult } from './types.js';
import { desktopDraftOf } from './uipath-desktop.js';

/** A step document larger than this is refused before it is parsed, as a Chrome recording is. */
export const MAX_STEPS_DOCUMENT_BYTES = MAX_CHROME_BYTES;

const WHAT = 'Step document';
const TOO_LARGE = 'the step document is larger than 5 MiB, so it was not read';
const NOT_TEXT = 'the step document must be text or a file';
const NOT_JSON = 'the step document is not valid JSON: give the steps as JSON, as Run Steps takes them';
const NOT_STEPS = (issues: string[]) => `the step document is not valid steps: ${issues.slice(0, 5).join('; ')}`;
const NAMES_SECRET = "the step document names a value of the RPA Site Login, so it was not imported: a signIn step types the Site Login's values";
const SIGNATURE_DROPPED =
  'imported steps are a first version for approval, so the signature and Approved By the document carried were not imported: Sign Steps signs the steps when a person approves them';
const RENAMED = (name: string) => `the steps are named ${JSON.stringify(name)}, version 1: imported steps are a first version under the import's Name`;
const EXPECTED_FILE_UNUSED = 'the download steps of a step document carry their own checks: Expected File is not used';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const issuesOf = (err: unknown): string[] => (err instanceof ScriptShapeError ? err.issues : [err instanceof Error ? err.message : String(err)]);

/**
 * The document's bytes or text as JSON, refusing more than MAX_STEPS_DOCUMENT_BYTES before anything is decoded or parsed.
 * JSON.parse's own message quotes the input, so it is never copied into the report.
 */
function readJson(data: unknown): { value: unknown } | { error: string } {
  let text: string;
  if (typeof data === 'string') {
    // A string has no more UTF-16 units than UTF-8 bytes, so a long one is refused without measuring it.
    if (data.length > MAX_STEPS_DOCUMENT_BYTES || Buffer.byteLength(data, 'utf8') > MAX_STEPS_DOCUMENT_BYTES) return { error: TOO_LARGE };
    text = data;
  } else if (data instanceof Uint8Array) {
    if (data.byteLength > MAX_STEPS_DOCUMENT_BYTES) return { error: TOO_LARGE };
    text = new TextDecoder('utf-8').decode(data);
  } else {
    return { error: NOT_TEXT };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: NOT_JSON };
  }
}

/**
 * Imports a step document (`data`: the file's bytes or its text) as one draft, or one desktop draft for a desktop step
 * set (`surface: "desktop"`). The steps keep their `{{var.name}}` templates; a `signature` and `approvedBy` beside them
 * are dropped and reported; the name becomes `opts.name` and the version 1. A desktop step's `write` is removed and the
 * step becomes a candidate write, as every desktop import leaves writes to the approver. A document that does not
 * parse, or that names a Site Login value, is an `error` item and no draft.
 */
export function importStepsDocument(data: unknown, opts: ImportOptions, report: ImportReport): ImportResult {
  const masker = createMasker([opts.secrets?.username, opts.secrets?.password, opts.secrets?.totpSecret].filter((s) => (s?.length ?? 0) >= MIN_SECRET_LENGTH));
  const fail = (reason: string): ImportResult => {
    report.items.push({ at: '', kind: 'error', what: WHAT, reason: masker.mask(reason) });
    return { drafts: [], report };
  };
  const read = readJson(data);
  if ('error' in read) return fail(read.error);
  const raw = Array.isArray(read.value) ? { steps: read.value } : read.value;
  if (!isObject(raw)) return fail(NOT_STEPS(['script must be an object']));

  const { signature: _signature, approvedBy: _approvedBy, ...doc } = raw;
  if (Object.hasOwn(raw, 'signature') || Object.hasOwn(raw, 'approvedBy')) report.items.push({ at: '', kind: 'dropped', what: 'Signature', reason: SIGNATURE_DROPPED });
  if ((doc.name !== undefined && doc.name !== opts.name) || (doc.version !== undefined && doc.version !== 1)) {
    report.items.push({ at: '', kind: 'converted', what: 'Name and version', reason: masker.mask(RENAMED(opts.name)) });
  }
  if (opts.download) report.items.push({ at: '', kind: 'untranslated', what: 'Expected File', reason: EXPECTED_FILE_UNUSED });
  const named: Json = { ...doc, name: opts.name, version: 1 };
  // Defence in depth behind the run's own checks: a document that names a Site Login secret is never a draft.
  if (masker.containsSecret(JSON.stringify(named))) return fail(NAMES_SECRET);

  if (isDesktopDocument(named)) {
    let script: DesktopScript;
    const declared: number[] = [];
    try {
      // Parsed as written first, so a write where none may be gets the parser's message; then without the writes.
      const parsed = parseDesktopScript(named);
      script = parseDesktopScript({
        ...parsed,
        steps: parsed.steps.map((s, i) => {
          const { write, ...step } = s;
          if (write === true) declared.push(i + 1);
          return step;
        }),
      });
    } catch (err) {
      return fail(NOT_STEPS(issuesOf(err)));
    }
    return { drafts: [], desktopDrafts: [desktopDraftOf(opts.name, script, report, { alsoCandidates: declared })], report };
  }

  let script: Script;
  try {
    script = parseScript(named, opts.startUrl ? { defaultStartUrl: opts.startUrl } : {});
  } catch (err) {
    return fail(NOT_STEPS(issuesOf(err)));
  }
  report.steps += script.steps.length;
  return { drafts: [{ name: opts.name, script }], report };
}
