// A step document as an import source: steps written by hand, as Run Steps takes them (a step document, a bare array of
// steps, or a desktop step set). It is data: it is read as JSON and checked by the step parsers, and nothing in it is
// evaluated. A browser document becomes one draft and a desktop step set one desktop draft, under the import's Name and
// as version 1, so each goes the way every import's drafts go: a browser draft is run once and replayed without writes,
// a desktop draft goes to approval as written. A signature that came with the document is not imported.
import { createMasker } from '../secrets/mask.js';
import { isDesktopDocument, parseDesktopScript, parseScript, ScriptShapeError } from '../steps/parse.js';
import type { DesktopScript, Script } from '../types.js';
import { isObject, MAX_IMPORT_JSON_BYTES, readJson, type Json } from './read.js';
import { MIN_SECRET_LENGTH } from './draft.js';
import type { ImportOptions, ImportReport, ImportResult } from './types.js';
import { desktopDraftOf } from './desktop-draft.js';

/** A step document larger than this is refused before it is parsed, as a Chrome recording is. */
const MAX_STEPS_DOCUMENT_BYTES = MAX_IMPORT_JSON_BYTES;

const WHAT = 'Step document';
const TOO_LARGE = 'the step document is larger than 5 MiB, so it was not read';
const NOT_TEXT = 'the step document must be text or a file';
const NOT_JSON = 'the step document is not valid JSON: give the steps as JSON, as Run Steps takes them';
const NOT_STEPS = (issues: string[]) => `the step document is not valid steps: ${issues.slice(0, 5).join('; ')}`;
/** Said first when `steps` is text: a row copied from the steps table holds its steps as JSON text. */
const LOOKS_LIKE_ROW = 'this looks like a row of the steps table: paste the value of its steps column';
const NAMES_SECRET = "the step document names a value of the RPA Site Login, so it was not imported: a signIn step types the Site Login's values";
const SIGNATURE_DROPPED =
  'imported steps are a first version for approval, so the signature and Approved By the document carried were not imported: Sign Steps signs the steps when a person approves them';
const RENAMED = (name: string) => `the steps are named ${JSON.stringify(name)}, version 1: imported steps are a first version under the import's Name`;
const EXPECTED_FILE_UNUSED = 'the download steps of a step document carry their own checks: Expected File is not used';

const issuesOf = (err: unknown): string[] => (err instanceof ScriptShapeError ? err.issues : [err instanceof Error ? err.message : String(err)]);

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
  const read = readJson(data, MAX_STEPS_DOCUMENT_BYTES);
  if ('problem' in read) return fail({ tooLarge: TOO_LARGE, notText: NOT_TEXT, notJson: NOT_JSON }[read.problem]);
  const raw = Array.isArray(read.value) ? { steps: read.value } : read.value;
  if (!isObject(raw)) return fail(NOT_STEPS(['script must be an object']));

  const { signature: _signature, approvedBy: _approvedBy, ...doc } = raw;
  // A note, not a step left out (the approval lists dropped steps as left out).
  if (Object.hasOwn(raw, 'signature') || Object.hasOwn(raw, 'approvedBy')) report.items.push({ at: '', kind: 'converted', what: 'Signature', reason: SIGNATURE_DROPPED });
  if ((doc.name !== undefined && doc.name !== opts.name) || (doc.version !== undefined && doc.version !== 1)) {
    report.items.push({ at: '', kind: 'converted', what: 'Name and version', reason: masker.mask(RENAMED(opts.name)) });
  }
  // A note, not a step the import could not take.
  if (opts.download) report.items.push({ at: '', kind: 'converted', what: 'Expected File', reason: EXPECTED_FILE_UNUSED });
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
    return { drafts: [], desktopDrafts: [desktopDraftOf(opts.name, script, report, { authorMarked: declared })], report };
  }

  let script: Script;
  try {
    script = parseScript(named, opts.startUrl ? { defaultStartUrl: opts.startUrl } : {});
  } catch (err) {
    return fail(NOT_STEPS(typeof doc.steps === 'string' ? [LOOKS_LIKE_ROW, ...issuesOf(err)] : issuesOf(err)));
  }
  report.steps += script.steps.length;
  return { drafts: [{ name: opts.name, script }], report };
}
