import { NodeOperationError, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { DesktopProposal, IntentChange, PortalPolicy, Proposal, Script, Step } from 'n8n-rpa-engine';
import { checkUrl, ConfigError, CREDENTIALS, policyFor, readPostLabelLocal, signingKey, siteLoginConfig, type SiteLogin } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configNodeError, errorJson } from '../errors.js';
import {
  changeList, DESKTOP_EVIDENCE_LINES, evidenceLine, fullSafetyFlags, hasDownloadStep, importAddedSteps, isDesktopProposal, isFileDocument, leftOutList,
  NOT_REPLAYED_EVIDENCE_LINE, reviewChanges, reviewSteps, safetyLine, type ReviewStep,
} from '../format.js';
import { configErrorItem } from '../output.js';
import { rejectedRecord, signedRecord, type StepsRecord } from '../rows.js';
import { asBoolean, asString, checkMaxItems, credentialId, errorMessage, isObject, literalRaw, SITE_LOGIN_NO_ID, splitList } from './common.js';

export const WRITE_STEPS_BROWSER = 'Write Steps applies to desktop steps only: clear it for browser steps.';
export const NOT_REPAIRED_STEPS = 'The input item is not a Repaired steps item from Run Steps or Import Steps (it has no digest). Only Repaired steps items can be signed.';
export const MISSING_NAME_OR_VERSION = 'The Repaired steps item has no name or version.';
export const APPROVER_NOT_ALLOWED = 'Approved By is not on the Approver Allowlist';
export const APPROVER_NEEDED = 'Approved By is empty, and the Approver Allowlist holds more than one address: set Approved By to the one who decided';
export const SIGNED_IN_NOT_ALLOWED = 'The n8n user who submitted the approval form is not on the Approver Allowlist';
export const APPROVER_FROM_UNKNOWN = 'Approver must be Approved By or Who Signed In to n8n on the Approval Form.';
export const APPROVAL_FORM_PAGE_INVALID = 'Approval Form Page must be the name of the form page where the approver decides (no { or }).';
/** No n8n user on the approval form page: the form does not use n8n User Auth, or the page is not the one named. */
export const notSignedIn = (page: string) =>
  `No n8n user signed in on the form page "${page}": with Approver set to who signed in to n8n, the form must use n8n User Auth (Authentication on its form trigger), and Approval Form Page must name the page where the approver decides`;
export const SIGN_NEEDS_KEY = 'Sign Steps needs an RPA Step Signing credential';
export const SHOWN_TEXT_CHANGED = 'the evidence, change list or safety line changed after it was reviewed';
export const RECORD_HOLDS_SECRET = 'the Repaired steps contain a credential secret';
export const SAFETY_FLAGS_INCOMPLETE = 'the safety flags do not list every host, form submission, download and pop-up handler the steps have';
export const READ_POSTS_NOT_LISTED = 'the evidence lists read-only requests this Site Login does not allow';
export const FILE_EVIDENCE_MISMATCH = 'the Repaired steps item has file evidence that does not match its steps';
export const EVIDENCE_MALFORMED = 'the Repaired steps item has malformed evidence';
export const CHANGE_LIST_MISMATCH = 'the change list names a step or pop-up handler that is not in the steps';
export const NOT_REPLAYED_EVIDENCE_INVALID = 'the steps were not replayed, so their evidence must be empty (no rows, no total, no file, no read-only requests)';
export const NOT_REPLAYED_NEEDS_WRITE =
  'the evidence line says the steps were not replayed, but they have no submit, download through a form, secret fill or password change: steps without those are replayed at import, so they cannot be signed as not replayed';
export const NOT_REPLAYED_NEEDS_FIRST_VERSION = 'steps that were not replayed must be a first version (no base version) that shows every step';
export const NOT_REPLAYED_CHANGES_MISMATCH = 'the change list does not show every step of the steps, in order, as added';
export const PROVEN_FIRST_VERSION_WRITES =
  'the evidence line says the steps were proven in a fresh browser, but a first version that submits a form, downloads through a form, types a secret or changes a password is never replayed: it must carry the not-replayed evidence line';
export const LEFT_OUT_MALFORMED = 'the left-out steps are not a list of text';
export const REVIEW_STEPS_CHANGED = 'the steps shown for approval are not the steps to sign: import the steps again';
/** Site Login secrets shorter than this are not looked for in records (the engine's MIN_SECRET_LEN_FOR_LITERAL_CHECK). */
const MIN_SECRET_LEN = 4;

/** A Repaired steps item as read from the input (no field trusted yet; the digest check covers them). */
export interface ParsedProposal {
  name: string | null;
  baseVersion: number | null;
  version: number | null;
  steps: unknown;
  hash: string;
  digest: string;
  evidence: Proposal['evidence'];
  changes: IntentChange[];
  safetyFlags: string[];
  shownText: { evidenceLine?: unknown; changeList?: unknown; safetyLine?: unknown };
  /** The steps an import left out (absent on items that have none, and on every item made before the field existed). */
  leftOut: unknown;
  /** The shown text of `leftOut` (format.ts leftOutList). */
  leftOutList: unknown;
}

const wholeNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  return Number.isInteger(n) ? n : null;
};

/** JSON text → value once; anything else (or text that is not JSON) is returned as is for the engine to refuse. */
function parseOnce(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v) as unknown;
  } catch {
    parsed = v;
  }
  return parsed;
}

/** The incoming item's JSON → the fields the digest covers, plus the three lines the reviewer read. */
export function parseRepairedSteps(json: IDataObject): ParsedProposal {
  return {
    name: typeof json.name === 'string' && json.name.trim() ? json.name : null,
    baseVersion: json.baseVersion === null || json.baseVersion === undefined ? null : wholeNumber(json.baseVersion),
    version: wholeNumber(json.version),
    steps: parseOnce(json.steps),
    hash: typeof json.hash === 'string' ? json.hash : '',
    digest: typeof json.digest === 'string' && json.digest.trim() ? json.digest : '',
    // Passed through as given: a changed or malformed value fails the digest check in engine.signSteps.
    evidence: (isObject(json.evidence) ? json.evidence : { count: 0, total: null, diff: { missing: [], extra: [] } }) as unknown as Proposal['evidence'],
    changes: (Array.isArray(json.changes) ? json.changes : []) as unknown as IntentChange[],
    safetyFlags: Array.isArray(json.safetyFlags) ? json.safetyFlags.map(String) : [],
    shownText: { evidenceLine: json.evidenceLine, changeList: json.changeList, safetyLine: json.safetyLine },
    leftOut: json.leftOut,
    leftOutList: json.leftOutList,
  };
}

/**
 * Why the item's left-out steps cannot be signed, or undefined. When the item has `leftOut` (a non-empty list of text;
 * the digest covers it), the shown `leftOutList` must be its formatting; without it, there must be no shown list. So a
 * list removed or edited after the email was made is refused, as long as the digest was not recomputed.
 */
function leftOutProblem(p: ParsedProposal): string | undefined {
  if (p.leftOut === undefined) return p.leftOutList === undefined || p.leftOutList === '' ? undefined : SHOWN_TEXT_CHANGED;
  if (!Array.isArray(p.leftOut) || p.leftOut.length === 0 || !p.leftOut.every((l) => typeof l === 'string')) return LEFT_OUT_MALFORMED;
  return p.leftOutList === leftOutList({ leftOut: p.leftOut as string[] }) ? undefined : SHOWN_TEXT_CHANGED;
}

/** True when a line the item carries differs from the recomputed one. A body too malformed to format is left to the digest check. */
function shownTextChanged(engine: Engine, p: Proposal | DesktopProposal, shown: ParsedProposal['shownText']): boolean {
  /** The plain-English lines a reviewer reads, recomputed from the fields the digest covers. */
  type Any = Proposal | DesktopProposal;
  const formats: Record<keyof ParsedProposal['shownText'], (p: Any) => string> = { evidenceLine: (q) => evidenceLine(q, engine), changeList, safetyLine };
  for (const [name, format] of Object.entries(formats) as [keyof typeof formats, (p: Any) => string][]) {
    const value = shown[name];
    if (value === undefined) continue;
    // A desktop item's evidence line names where its steps came from, which the evidence does not record: any of them passes.
    if (name === 'evidenceLine' && isDesktopProposal(p) && typeof value === 'string' && DESKTOP_EVIDENCE_LINES.includes(value)) continue;
    // Browser steps that were not replayed: signOne checks the conditions under which this line may stand.
    if (name === 'evidenceLine' && !isDesktopProposal(p) && value === NOT_REPLAYED_EVIDENCE_LINE) continue;
    let expected: string | undefined;
    try {
      expected = format(p);
    } catch {
      expected = undefined;
    }
    if (expected !== undefined && value !== expected) return true;
  }
  return false;
}

/** A variable's start value, which the import knows and the item does not record: shown only, never compared. */
const STARTS_AS = /^(variable [A-Za-z_][A-Za-z0-9_]*), starts as [\s\S]*$/;

/** True when an entry of the item's `reviewSteps` says what the rebuilt entry says (see reviewStepsProblem). */
function sameReviewStep(shown: unknown, built: ReviewStep): boolean {
  if (!isObject(shown) || shown.text !== built.text || !Array.isArray(shown.marks)) return false;
  // The author's description beside the sentence: there exactly when the rebuilt step has one, and the same text. An
  // item made before the description had its own field carries it inside `text`, which then differs: it is refused,
  // so nothing is signed that a person saw worded another way.
  if (shown.describedAs !== built.describedAs) return false;
  // Shown quietly only when the rebuilt step is quiet too. An item made before the mark existed has none: its page and
  // emails showed every description as a warning, which says more, never less, than the rebuilt one.
  if (shown.quiet !== undefined && !(shown.quiet === true && built.quiet === true)) return false;
  const marks = shown.marks.map((m) => (typeof m === 'string' ? m.replace(STARTS_AS, '$1') : m));
  if (marks.length !== built.marks.length || marks.some((m, i) => m !== built.marks[i])) return false;
  // Only a step the import may add (a wait for a window, a returned file) may be shown as added.
  if (shown.added !== undefined && !(shown.added === true && built.added === true)) return false;
  if (shown.each === undefined && built.each === undefined) return true;
  return Array.isArray(shown.each) && built.each !== undefined && shown.each.length === built.each.length && shown.each.every((e, i) => sameReviewStep(e, built.each![i]));
}

/**
 * Why the steps the review page and the approval email showed (`reviewSteps`, shown only and outside the digest) cannot
 * stand for the steps to sign, or undefined. Each sentence is rebuilt from the item's own steps with the function the
 * import used, entry by entry (a paginate's inner lines too), with the marks: the variables (secret ones as the item's
 * `secretVariables` name them on desktop steps, from the step on browser steps), a returned file, a read's output, a
 * sign-in, and "added" only on a step the import may add. A start value is not recorded on the item and is not compared.
 * An item without `reviewSteps` (an older one, or one from Run Steps) is signed as before.
 */
function reviewStepsProblem(engine: Engine, p: ParsedProposal, json: IDataObject): string | undefined {
  const shown = json.reviewSteps;
  if (shown === undefined) return undefined;
  const steps = isObject(p.steps) ? p.steps.steps : undefined;
  if (!Array.isArray(shown) || !Array.isArray(steps)) return REVIEW_STEPS_CHANGED;
  let built: ReviewStep[];
  try {
    const secretVariables = Array.isArray(json.secretVariables) ? json.secretVariables.filter((v): v is string => typeof v === 'string') : [];
    built = engine.isDesktopDocument(p.steps)
      ? reviewSteps(steps, { desktop: true, secretVariables, added: importAddedSteps(steps as never) })
      : reviewSteps(steps, { desktop: false, shownUrl: engine.shownUrl, startUrl: isObject(p.steps) && typeof p.steps.startUrl === 'string' ? p.steps.startUrl : undefined });
  } catch {
    return REVIEW_STEPS_CHANGED;
  }
  return shown.length === built.length && shown.every((e, i) => sameReviewStep(e, built[i])) ? undefined : REVIEW_STEPS_CHANGED;
}

/**
 * Why the change list the approval emails showed (`reviewChanges`, shown only and outside the digest) cannot stand for
 * the item's change list, or undefined: it is built again from the item's steps and change list (format.ts
 * reviewChanges) and must be the same. An item without it is signed as before.
 */
function reviewChangesProblem(engine: Engine, p: ParsedProposal, json: IDataObject): string | undefined {
  if (json.reviewChanges === undefined) return undefined;
  const doc = isObject(p.steps) ? p.steps : undefined;
  if (!doc || !Array.isArray(doc.steps) || engine.isDesktopDocument(doc)) return REVIEW_STEPS_CHANGED;
  let built: string;
  try {
    const changes = p.changes.map((c) => ({ was: typeof c.was === 'string' ? c.was : null, now: typeof c.now === 'string' ? c.now : null }));
    built = engine.canonicalize(reviewChanges(engine, doc.steps, changes, { shownUrl: engine.shownUrl, startUrl: typeof doc.startUrl === 'string' ? doc.startUrl : undefined }));
    return engine.canonicalize(json.reviewChanges) === built ? undefined : REVIEW_STEPS_CHANGED;
  } catch {
    return REVIEW_STEPS_CHANGED;
  }
}

/** Hosts of the absolute http(s) gotos, paginate bodies included. */
function absoluteGotoHosts(steps: Step[]): string[] {
  const hosts: string[] = [];
  for (const s of steps) {
    if ('goto' in s && URL.canParse(s.goto)) {
      const u = new URL(s.goto);
      if (u.protocol === 'http:' || u.protocol === 'https:') hosts.push(u.host);
    }
    if ('paginate' in s) hosts.push(...absoluteGotoHosts(s.paginate.each));
  }
  return hosts;
}

type PolicyResult = { ok: true; policy: PortalPolicy } | { ok: false; reason: string };

/**
 * The policy the run will use: the Site Login's when attached. Otherwise it is derived from the
 * steps: the normalised start host plus the hosts of the steps' absolute gotos. Those hosts all
 * appear as safety flags the reviewer saw. The run's own policy re-validates the steps at load.
 * A declared submit or download through a form is judged by the rule Run Steps applies with the same credentials
 * (engine effectivePolicy): with a Site Login, only the forms it lists; without one, the declared targets on those hosts.
 * Import Steps checks steps it does not run against this same policy.
 */
export function signingPolicy(engine: Pick<Engine, 'effectivePolicy'>, script: Script, siteLogin: SiteLogin | undefined): PolicyResult {
  let result: PolicyResult;
  try {
    if (siteLogin) {
      result = { ok: true, policy: policyFor({ siteLogin, allowedHosts: [], allowPrivateNetwork: false, operation: 'signSteps' }) };
    } else {
      const start = checkUrl(script.startUrl);
      const others = [...new Set(absoluteGotoHosts(script.steps).filter((h) => h !== start.host))];
      const policy = policyFor({ url: start.href, allowedHosts: others, allowPrivateNetwork: false, operation: 'signSteps' });
      // As Run Steps without a Site Login: signed steps, no secrets, the declared targets on a navigation host.
      const { allowedSubmits } = engine.effectivePolicy({ ...policy, submitsFromSteps: true }, script, { signed: true, hasSecrets: false });
      result = { ok: true, policy: { ...policy, allowedSubmits } };
    }
  } catch (error) {
    result = { ok: false, reason: errorMessage(error) };
  }
  return result;
}

type SignOutcome =
  | { kind: 'record'; record: StepsRecord }
  | { kind: 'error'; item: INodeExecutionData; error: NodeOperationError };

function refusal(ctx: NodeContext, i: number, reasons: string[], name: string | null, version: number | null): SignOutcome {
  const message = `Sign Steps refused: ${reasons.join('; ')}`;
  const error = new NodeOperationError(ctx.getNode(), message, { itemIndex: i, description: 'Nothing was signed. Fix the reasons, or reject the Repaired steps.' });
  error.message = message;
  Object.assign(error.context, { code: null, reasons, name, version });
  return { kind: 'error', item: { json: errorJson(message, message, { code: null, reasons, name, version }), pairedItem: [{ item: i }] }, error };
}

/**
 * The digest is an unkeyed hash over fields the item carries, so a crafted item can carry a matching digest and
 * flags that hide a host. The flags are therefore recomputed from the steps, as Run Steps computes them
 * (fullSafetyFlags): the count-unverified flag from the evidence, extract-fields-dropped (which needs the base steps)
 * from the item. The item's flags must be the same set, and its safety line the formatting of the recomputed list.
 * Returns the refusal reason, or undefined.
 */
function safetyFlagsProblem(engine: Engine, script: Script, p: ParsedProposal, notReplayed: boolean): string | undefined {
  let expected: string[];
  try {
    expected = fullSafetyFlags(engine, script, notReplayed
      ? { unverifiedCount: false, fieldsDropped: false, notReplayed: true }
      : { unverifiedCount: p.evidence.total === null && !p.evidence.file, fieldsDropped: p.safetyFlags.includes(engine.EXTRACT_FIELDS_DROPPED) });
  } catch (error) {
    return errorMessage(error);
  }
  const given = new Set(p.safetyFlags);
  if (given.size !== p.safetyFlags.length || given.size !== expected.length || expected.some((f) => !given.has(f))) return SAFETY_FLAGS_INCOMPLETE;
  if (p.shownText.safetyLine !== safetyLine({ safetyFlags: expected } as Proposal)) return SHOWN_TEXT_CHANGED;
  return undefined;
}

/**
 * True when the evidence's read-only requests are not all among the Site Login's own (none without a Site Login). Absent is fine.
 * A label the engine masked (a Site Login secret inside a listed path shows as `[secret]`) never equals the credential's
 * entry, so it is refused with READ_POSTS_NOT_LISTED: fails closed, on purpose.
 */
function readPostsProblem(listed: unknown, siteLogin: SiteLogin | undefined): boolean {
  if (listed === undefined) return false;
  if (!Array.isArray(listed) || !listed.every((e) => typeof e === 'string')) return true;
  const allowed = new Set((siteLogin?.policy.readPosts ?? []).map(readPostLabelLocal));
  return listed.some((e: string) => !allowed.has(e));
}

const MAX_EVIDENCE_TEXT = 200;
/** Control (Cc) and format (Cf, bidi overrides such as U+202E included) characters, and the line and paragraph separators. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const plainText = (v: unknown): boolean => typeof v === 'string' && v.length <= MAX_EVIDENCE_TEXT && !UNSHOWABLE.test(v);
const wholeOrNull = (v: unknown, orNull: boolean): boolean => (orNull && v === null) || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((e) => typeof e === 'string');

/**
 * True when the evidence is not shaped as the engine writes it: `count` a whole number from 0, `total` one or null, and
 * `diff` two lists of text. The evidence line prints them, so a text total could add a line to the approval text.
 */
function malformedEvidence(e: unknown): boolean {
  if (!isObject(e)) return true;
  return !(wholeOrNull(e.count, false) && wholeOrNull(e.total, true) && isObject(e.diff) && strings(e.diff.missing) && strings(e.diff.extra));
}

/** Not-replayed evidence is exactly empty: no rows, no total, no file, no read-only requests, an empty diff. */
function notReplayedEvidenceProblem(e: Proposal['evidence']): boolean {
  return e.count !== 0 || e.total !== null || e.file !== undefined || e.readPosts !== undefined || e.diff.missing.length !== 0 || e.diff.extra.length !== 0;
}

/** Whether a download check can tell the right file from the wrong one: it sets `name` or `columns` (the engine's rule). */
const namesFile = (check: unknown): boolean => isObject(check) && (check.name !== undefined || check.columns !== undefined);

/** A MIME type as the engine's sniffMime writes it: type/subtype of lowercase letters, digits, dot, plus and hyphen. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

/** True when the evidence's file is not shaped as the engine writes it (strings without control characters, whole counts). */
function malformedFile(f: unknown): boolean {
  if (!isObject(f)) return true;
  return !(
    plainText(f.fileName) && plainText(f.mimeType) && MIME_SHAPE.test(f.mimeType as string) && wholeOrNull(f.bytes, false) && wholeOrNull(f.rows, true)
    && (f.columns === null || strings(f.columns))
  );
}

/**
 * True when file evidence and the steps do not go together: file evidence needs a well-formed file, a file document
 * (isFileDocument) and a download check that sets `name` or `columns`, as repair requires; without it, the steps must
 * have no download step. null counts as absent. Steps that are not a document are left to the later checks.
 */
function fileEvidenceProblem(p: ParsedProposal): boolean {
  const steps = isObject(p.steps) ? p.steps.steps : Array.isArray(p.steps) ? p.steps : undefined;
  if (!Array.isArray(steps)) return false;
  const file = isObject(p.evidence) ? p.evidence.file : undefined;
  try {
    if (file === undefined || file === null) return hasDownloadStep(steps as Step[]);
    if (malformedFile(file) || !isFileDocument(steps as Step[])) return true;
    const download = (steps as Step[]).find((s): s is Extract<Step, { download: unknown }> => 'download' in s);
    return !namesFile(download?.download.check);
  } catch {
    return false;
  }
}

/** `leftOut` for the proposal the digest is checked over: only when the item has it (leftOutProblem checked its shape). */
const leftOutOf = (p: ParsedProposal): { leftOut?: string[] } => (p.leftOut === undefined ? {} : { leftOut: p.leftOut as string[] });

/** True when the item's change list is exactly `expected`: the same entries, in order. Entries are untrusted. */
function changesExactly(changes: readonly unknown[], expected: IntentChange[]): boolean {
  return changes.length === expected.length && changes.every((c, i) => {
    const e = c as { was?: unknown; now?: unknown } | null;
    return e !== null && typeof e === 'object' && e.was === expected[i].was && e.now === expected[i].now;
  });
}

/** True when `hash` is the hash of `steps`. Steps the engine cannot hash (missing, undefined inside) never match. */
function hashMatches(engine: Engine, steps: unknown, hash: string): boolean {
  let matches: boolean;
  try {
    matches = hash !== '' && steps !== undefined && engine.scriptHash(steps) === hash;
  } catch {
    matches = false;
  }
  return matches;
}

/**
 * The email of the n8n user who submitted the form page `page` in this execution, or '' when there is none. n8n's Form
 * node puts the signed-in submitter in that page's output as `user` ({ id, email, firstName, lastName }), written after
 * the page's fields, so no form field can stand in for it. Anything else there (no page run, no `user`, a `user` without
 * an id and an email as text) is no one.
 */
function formSubmitter(ctx: NodeContext, page: string, i: number): string {
  let user: unknown;
  try {
    user = ctx.evaluateExpression(`{{ $(${JSON.stringify(page)}).first().json.user }}`, i);
  } catch {
    return '';
  }
  if (!isObject(user) || typeof user.id !== 'string' || !user.id.trim() || typeof user.email !== 'string') return '';
  return user.email.trim();
}

async function signOne(ctx: NodeContext, engine: Engine, i: number, json: IDataObject, at: Date): Promise<SignOutcome> {
  const paired: IPairedItemData[] = [{ item: i }];
  const siteLoginId = credentialId(ctx, CREDENTIALS.siteLogin);
  let key: string;
  let siteLogin: SiteLogin | undefined = undefined;
  let approverId: string;
  /** The approval form page, when the approver is who signed in to n8n there. */
  let signInPage: string | undefined;
  let allowlist: string[];
  let approved: boolean;
  let writeStepsText: string;
  try {
    // n8n cannot make a credential required for one operation only: checked here.
    if (credentialId(ctx, CREDENTIALS.signing) === undefined) throw new ConfigError(SIGN_NEEDS_KEY);
    // Who may approve is part of the security configuration: never taken from the incoming data.
    // No address contains "{{". Not literalString: that also refuses a raw object or boolean, which is read as text here.
    literalRaw(ctx, 'approverAllowlist', 'Approver Allowlist');
    // Read here, inside the try: a parameter whose expression fails is a configuration error item, never a raw throw.
    const listed = splitList(asString(ctx.getNodeParameter('approverAllowlist', i, '')));
    allowlist = listed.map((a) => a.toLowerCase());
    const approverFrom = asString(ctx.getNodeParameter('approverFrom', i, 'approvedBy'));
    if (approverFrom === 'formSignIn') {
      // Which page is the approval is part of the security configuration: a literal, like the allowlist.
      literalRaw(ctx, 'approvalFormPage', 'Approval Form Page');
      signInPage = asString(ctx.getNodeParameter('approvalFormPage', i, 'Review and approve')).trim();
      if (!signInPage || /[{}]/.test(signInPage)) throw new ConfigError(APPROVAL_FORM_PAGE_INVALID);
      // The person n8n signed in, never a typed or mapped value: no default from the allowlist, and Approved By is not read.
      approverId = formSubmitter(ctx, signInPage, i);
    } else if (approverFrom === 'approvedBy') {
      approverId = asString(ctx.getNodeParameter('approverId', i, '')).trim();
      // The approver typed once: with one address on the (literal) allowlist, an empty Approved By is that address, as
      // the allowlist spells it. Any Approved By that is given must still be on the allowlist (below).
      if (!approverId && new Set(allowlist).size === 1) approverId = listed[0];
    } else throw new ConfigError(APPROVER_FROM_UNKNOWN);
    // An unknown answer (for example a send-and-wait that timed out) is a rejection, never an approval.
    approved = asBoolean(ctx.getNodeParameter('approved', i, false), false);
    // Desktop steps only: the steps the approver declares writes. An expression (the approval form's answer) is expected.
    writeStepsText = asString(ctx.getNodeParameter('writeSteps', i, '')).trim();
    key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
    // Signing reads the sites and binds the credential id, it never signs in: a Site Login whose username and password
    // are expressions on the account items resolves to empty values on this approval item, and that is no error.
    if (siteLoginId !== undefined) siteLogin = siteLoginConfig(await ctx.getCredentials(CREDENTIALS.siteLogin, i), { loginOptional: true });
  } catch (error) {
    const message = errorMessage(error);
    return { kind: 'error', item: configErrorItem(message, null, paired), error: configNodeError(ctx.getNode(), message, i) };
  }

  const secrets = siteLogin?.secrets;
  const siteSecrets = [secrets?.username, secrets?.password, secrets?.totpSecret];
  const masker = engine.createMasker([key, ...siteSecrets]);
  // The record check ignores Site Login secrets shorter than 4 characters, as the engine's literal-secret check does:
  // a username such as "jo" would otherwise block every approval whose steps contain those letters.
  const recordMasker = engine.createMasker([key, ...siteSecrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LEN)]);
  const p = parseRepairedSteps(json);
  const shownName = p.name === null ? null : masker.mask(p.name);
  const refuse = (reasons: string[]): SignOutcome => refusal(ctx, i, reasons.map((r) => masker.mask(r)), shownName, p.version);
  // A record goes into the Data Table as is (masking would break the signature), so one carrying a secret is refused.
  const record = (r: StepsRecord): SignOutcome =>
    recordMasker.containsSecret(JSON.stringify({ name: r.name, steps: r.steps })) ? refuse([RECORD_HOLDS_SECRET]) : { kind: 'record', record: r };

  // An empty id would be bound as "no Site Login" (Run Steps refuses the same credential).
  if (siteLoginId === '') return refuse([SITE_LOGIN_NO_ID]);
  if (!p.digest) return refuse([NOT_REPAIRED_STEPS]);
  if (p.name === null || p.version === null) return refuse([MISSING_NAME_OR_VERSION]);
  if (signInPage !== undefined) {
    if (!approverId) return refuse([notSignedIn(signInPage)]);
    if (!allowlist.includes(approverId.toLowerCase())) return refuse([SIGNED_IN_NOT_ALLOWED]);
  }
  if (!approverId && allowlist.length > 1) return refuse([APPROVER_NEEDED]);
  if (!approverId || !allowlist.includes(approverId.toLowerCase())) return refuse([APPROVER_NOT_ALLOWED]);
  if (!approved) {
    // Template 3 marks the row with this hash rejected, so the hash must be the hash of these steps.
    if (!hashMatches(engine, p.steps, p.hash)) return refuse([engine.STEPS_HASH_MISMATCH]);
    return record(rejectedRecord({ name: p.name, version: p.version, hash: p.hash }, approverId, at));
  }
  const leftOut = leftOutProblem(p);
  if (leftOut) return refuse([leftOut]);
  // Reported after the engine's own reasons (a step edited after review fails the digest check first), never instead.
  const shownSteps = reviewStepsProblem(engine, p, json) ?? reviewChangesProblem(engine, p, json);
  if (engine.isDesktopDocument(p.steps)) return signDesktop(engine, p, { key, approverId, writeStepsText, secrets: siteSecrets, at, refuse, record, shownSteps });
  if (writeStepsText) return refuse([WRITE_STEPS_BROWSER]);

  const proposal: Proposal = {
    name: p.name, baseVersion: p.baseVersion, version: p.version, steps: p.steps as Script, hash: p.hash,
    evidence: p.evidence, changes: p.changes, safetyFlags: p.safetyFlags, screenshots: {}, ...leftOutOf(p),
  };
  // Browser steps that went to approval without a replay (a step document that writes or types a secret).
  const notReplayed = p.shownText.evidenceLine === NOT_REPLAYED_EVIDENCE_LINE;
  if (malformedEvidence(p.evidence)) return refuse([EVIDENCE_MALFORMED]);
  // Nothing ran, so there is nothing to show: any count, total, file or read-only request refuses the item.
  if (notReplayed && notReplayedEvidenceProblem(p.evidence)) return refuse([NOT_REPLAYED_EVIDENCE_INVALID]);
  if (readPostsProblem(p.evidence.readPosts, siteLogin)) return refuse([READ_POSTS_NOT_LISTED]);
  // A download that was never run has no file evidence: the evidence line tells the approver the file was never seen.
  if (!notReplayed && fileEvidenceProblem(p)) return refuse([FILE_EVIDENCE_MISMATCH]);
  if (shownTextChanged(engine, proposal, p.shownText)) return refuse([SHOWN_TEXT_CHANGED]);
  // shownTextChanged skips a missing text (older items may lack one). The point of a not-replayed approval is that the
  // approver saw every step, so its change list must be there.
  if (notReplayed && (typeof p.shownText.changeList !== 'string' || p.shownText.changeList === '')) return refuse([SHOWN_TEXT_CHANGED]);
  // Parsed once for the checks below; engine.signSteps parses the steps it signs itself.
  let script: Script;
  try {
    script = engine.parseScript(p.steps);
  } catch (error) {
    return refuse([errorMessage(error)]);
  }
  const asWritten = engine.needsApprovalAsWritten(script.steps);
  if (notReplayed) {
    // A list the import could have replayed cannot be signed as not replayed, and only a first version is reviewed whole.
    if (!asWritten) return refuse([NOT_REPLAYED_NEEDS_WRITE]);
    if (p.baseVersion !== null) return refuse([NOT_REPLAYED_NEEDS_FIRST_VERSION]);
  } else if (asWritten && p.baseVersion === null) {
    // No first version that writes or types a secret is ever replayed, so it never carries a proven line.
    return refuse([PROVEN_FIRST_VERSION_WRITES]);
  }
  const flags = safetyFlagsProblem(engine, script, p, notReplayed);
  if (flags) return refuse([flags]);
  // Sign Steps has no base steps, so it cannot recompute the change list: every entry that says what a step or pop-up
  // handler is now must describe one the steps have, masked as Run Steps masks them. Reported with the engine's
  // reasons (an edited step fails the hash check first), never instead of them. Steps that were not replayed are a
  // first version, so their change list must be exactly every step, in order, as added (as for desktop steps).
  // The exact list is masked as the import masks it: Site Login secrets of 4 characters or more (steps that hold one are
  // refused as a record anyway), so a short username such as "jo" does not refuse a step that reads "Open the job list".
  const changes = notReplayed
    ? (changesExactly(p.changes, engine.stepChanges(undefined, script, (s) => recordMasker.mask(s))) ? undefined : NOT_REPLAYED_CHANGES_MISMATCH)
    : (engine.changeListMatches(script, p.changes, (s) => masker.mask(s)) ? undefined : CHANGE_LIST_MISMATCH);
  const policy = signingPolicy(engine, script, siteLogin);
  if (!policy.ok) return refuse([policy.reason]);
  // signSteps returns refusals, but signScript inside it throws for inputs it can never sign (an empty key or
  // approver, or one that spans lines). Those become refusals too, never a raw throw under continue-on-fail.
  let result: ReturnType<Engine['signSteps']>;
  try {
    result = engine.signSteps({
      proposal, key, approverId, policy: policy.policy, ...(secrets ? { secrets } : {}), ...(siteLoginId ? { siteLoginId } : {}), now: at, reviewedDigest: p.digest,
    });
  } catch (error) {
    return refuse([errorMessage(error)]);
  }
  const reasons = [...(result.ok ? [] : result.reasons), ...(changes ? [changes] : []), ...(shownSteps ? [shownSteps] : [])];
  if (!result.ok || changes || shownSteps) return refuse(reasons);
  return record(signedRecord(result.row));
}

/**
 * Desktop steps (an imported desktop draft's Repaired steps item): the approver's Write Steps are added to exactly the
 * listed steps and the result is signed, bound to the app the steps launch (engine signDesktopSteps, which re-checks
 * the hash, the digest, the safety flags and the change list). The lines the approver read must be the ones the fields
 * give. No Site Login is bound (desktop runs refuse one); its secrets still keep a record that names one out.
 */
function signDesktop(
  engine: Engine, p: ParsedProposal,
  c: {
    key: string; approverId: string; writeStepsText: string; secrets: (string | undefined)[]; at: Date; refuse: (r: string[]) => SignOutcome; record: (r: StepsRecord) => SignOutcome;
    /** Why the shown steps (reviewSteps) do not match, reported after the engine's reasons. */
    shownSteps?: string;
  },
): SignOutcome {
  const writeSteps = engine.parseWriteSteps(c.writeStepsText);
  if ('error' in writeSteps) return c.refuse([writeSteps.error]);
  if (malformedEvidence(p.evidence)) return c.refuse([EVIDENCE_MALFORMED]);
  const proposal = {
    name: p.name ?? '', baseVersion: p.baseVersion, version: p.version ?? 0, steps: p.steps, hash: p.hash,
    evidence: p.evidence, changes: p.changes, safetyFlags: p.safetyFlags, screenshots: {}, ...leftOutOf(p),
  } as unknown as DesktopProposal;
  if (shownTextChanged(engine, proposal, p.shownText)) return c.refuse([SHOWN_TEXT_CHANGED]);
  // Desktop steps are reviewed as written, so the change list the approver read must be there (shownTextChanged skips a
  // missing one, which older browser items need).
  if (typeof p.shownText.changeList !== 'string' || p.shownText.changeList === '') return c.refuse([SHOWN_TEXT_CHANGED]);
  let expected: string[] | undefined;
  try {
    expected = engine.desktopSafetyFlags(engine.parseDesktopScript(p.steps));
  } catch {
    expected = undefined; // signDesktopSteps refuses steps that do not parse, with the reason
  }
  // As for browser steps, the safety line the approver read is required and must be the recomputed one.
  if (expected && p.shownText.safetyLine !== safetyLine({ safetyFlags: expected })) return c.refuse([SHOWN_TEXT_CHANGED]);
  let result: ReturnType<Engine['signDesktopSteps']>;
  try {
    result = engine.signDesktopSteps({ proposal, key: c.key, approverId: c.approverId, reviewedDigest: p.digest, writeSteps, secrets: c.secrets, now: c.at });
  } catch (error) {
    return c.refuse([errorMessage(error)]);
  }
  if (!result.ok) return c.refuse([...result.reasons, ...(c.shownSteps ? [c.shownSteps] : [])]);
  if (c.shownSteps) return c.refuse([c.shownSteps]);
  // What was signed as writes, by number and intent, so the approver's choice is confirmed in words.
  const writes = result.row.writeSteps.map((n) => ({ step: n, intent: result.row.steps.steps[n - 1].intent }));
  return c.record({ ...signedRecord(result.row), writeSteps: writes, writeLine: desktopWriteLine(writes) });
}

/** `Signed as writes: step 16 (Click Save)`, or none. */
export function desktopWriteLine(writes: { step: number; intent: string }[]): string {
  if (writes.length === 0) return 'Signed as writes: none';
  return `Signed as writes: ${writes.map((w) => `step ${w.step} (${w.intent.replace(/\s+/g, ' ').trim()})`).join(', ')}`;
}

/** What Check Only gives for one item. Names and yes or no only: never a key, a signature or a credential's data. */
export interface SigningCheck {
  checkOnly: true;
  /** The name of the RPA Site Login on this node, or null when it has none. Desktop steps are signed without it. */
  siteLogin: string | null;
  /**
   * The approved version the item carries (an active row of the steps table: steps, signature, approvedBy), or null
   * when it carries no signature. `signatureFits` is what the run's own check (engine verifyScript) says with this
   * node's Step Signing key and, for browser steps, its Site Login: null when this node has no key to check with.
   */
  approvedVersion: { version: number | null; desktop: boolean; signatureFits: boolean | null } | null;
}

/**
 * The name of the credential of `type` on this node, or null. n8n gives a node the id and the name of each credential
 * picked on it; only getCredentials reads its data, and this does not call it.
 */
function credentialName(ctx: NodeContext, type: string): string | null {
  if (credentialId(ctx, type) === undefined) return null;
  const name = ctx.getNode().credentials?.[type]?.name;
  return typeof name === 'string' ? name : null;
}

/**
 * Check Only: signs and records nothing. Names the RPA Site Login this node signs for and, when the item carries an
 * approved version, says whether its signature verifies with this node's Step Signing key and Site Login, with the
 * verification a run makes (engine verifyScript): a browser signature binds the Site Login's id, a desktop signature
 * binds none (signDesktop). The Site Login's data is never read. Never an error: a missing key gives null.
 */
async function checkOne(ctx: NodeContext, engine: Engine, i: number, json: IDataObject): Promise<SigningCheck> {
  const siteLogin = credentialName(ctx, CREDENTIALS.siteLogin);
  const signature = json.signature;
  if (typeof signature !== 'string' || signature.trim() === '') return { checkOnly: true, siteLogin, approvedVersion: null };
  const steps = parseOnce(json.steps);
  const desktop = engine.isDesktopDocument(steps);
  let key: string | undefined;
  try {
    key = credentialId(ctx, CREDENTIALS.signing) === undefined ? undefined : signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
  } catch {
    key = undefined;
  }
  const siteLoginId = desktop ? undefined : credentialId(ctx, CREDENTIALS.siteLogin) || undefined;
  const signatureFits = key === undefined ? null : engine.verifyScript(steps, key, { approvedBy: asString(json.approvedBy), signature, ...(siteLoginId ? { siteLoginId } : {}) });
  return { checkOnly: true, siteLogin, approvedVersion: { version: wholeNumber(json.version), desktop, signatureFits } };
}

/**
 * Sign Steps: one steps-table record per input item, `active` (signed) or `rejected`. No browser is opened.
 * Refusals and configuration errors are error items under continue-on-fail (n8n routes them to the error output).
 * With Check Only on, one SigningCheck per item instead (checkOne): nothing is signed.
 */
export async function executeSignSteps(ctx: NodeContext, engine: Engine, now: () => Date = () => new Date()): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const refused = checkMaxItems(ctx, items);
  if (refused) return [refused];
  const out: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    let r: SignOutcome;
    try {
      if (asBoolean(ctx.getNodeParameter('checkOnly', i, false), false)) {
        out.push({ json: { ...(await checkOne(ctx, engine, i, items[i].json)) }, pairedItem: [{ item: i }] });
        continue;
      }
      r = await signOne(ctx, engine, i, items[i].json, now());
    } catch (error) {
      // signOne turns every expected problem into an outcome; anything else is a configuration error item, as in
      // executeQuickOp, never a throw under continue-on-fail (n8n would copy the input items to the output).
      const message = errorMessage(error);
      r = { kind: 'error', item: configErrorItem(message, null, [{ item: i }]), error: error instanceof NodeOperationError ? error : configNodeError(ctx.getNode(), message, i) };
    }
    if (r.kind === 'record') {
      out.push({ json: { ...r.record }, pairedItem: [{ item: i }] });
      continue;
    }
    if (!ctx.continueOnFail()) throw r.error;
    out.push(r.item);
  }
  return [out];
}
