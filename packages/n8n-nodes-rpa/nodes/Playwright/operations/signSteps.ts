import { NodeOperationError, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { DesktopProposal, IntentChange, PortalPolicy, Proposal, Script, Step } from 'n8n-rpa-engine';
import { checkUrl, ConfigError, CREDENTIALS, policyFor, readPostLabelLocal, signingKey, siteLoginConfig, type SiteLogin } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configNodeError, errorJson } from '../errors.js';
import { changeList, evidenceLine, fullSafetyFlags, hasDownloadStep, isFileDocument, safetyLine } from '../format.js';
import { configErrorItem } from '../output.js';
import { rejectedRecord, signedRecord, type StepsRecord } from '../rows.js';
import { asBoolean, asString, checkMaxItems, credentialId, errorMessage, isObject, literalRaw, SITE_LOGIN_NO_ID, splitList } from './common.js';

export const WRITE_STEPS_BROWSER = 'Write Steps applies to desktop steps only: clear it for browser steps.';
export const NOT_REPAIRED_STEPS = 'The input item is not a Repaired steps item from Run Steps (it has no digest). Only Repaired steps items can be signed.';
export const MISSING_NAME_OR_VERSION = 'The Repaired steps item has no name or version.';
export const APPROVER_NOT_ALLOWED = 'Approved By is not on the Approver Allowlist';
export const SIGN_NEEDS_KEY = 'Sign Steps needs an RPA Step Signing credential';
export const SHOWN_TEXT_CHANGED = 'the evidence, change list or safety line changed after it was reviewed';
export const RECORD_HOLDS_SECRET = 'the Repaired steps contain a credential secret';
export const SAFETY_FLAGS_INCOMPLETE = 'the safety flags do not list every host, form submission, download and pop-up handler the steps have';
export const READ_POSTS_NOT_LISTED = 'the evidence lists read-only requests this Site Login does not allow';
export const FILE_EVIDENCE_MISMATCH = 'the Repaired steps item has file evidence that does not match its steps';
export const EVIDENCE_MALFORMED = 'the Repaired steps item has malformed evidence';
export const CHANGE_LIST_MISMATCH = 'the change list names a step or pop-up handler that is not in the steps';
/** The engine's STEPS_HASH_MISMATCH wording (the engine is loaded lazily, so its constants are not imported here). */
export const HASH_MISMATCH = 'the steps do not match the hash that was reviewed';
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
  };
}

/** True when a line the item carries differs from the recomputed one. A body too malformed to format is left to the digest check. */
function shownTextChanged(engine: Engine, p: Proposal | DesktopProposal, shown: ParsedProposal['shownText']): boolean {
  /** The plain-English lines a reviewer reads, recomputed from the fields the digest covers. */
  type Any = Proposal | DesktopProposal;
  const formats: Record<keyof ParsedProposal['shownText'], (p: Any) => string> = { evidenceLine: (q) => evidenceLine(q, engine), changeList, safetyLine };
  for (const [name, format] of Object.entries(formats) as [keyof typeof formats, (p: Any) => string][]) {
    const value = shown[name];
    if (value === undefined) continue;
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
 */
function signingPolicy(script: Script, siteLogin: SiteLogin | undefined): PolicyResult {
  let result: PolicyResult;
  try {
    if (siteLogin) {
      result = { ok: true, policy: policyFor({ siteLogin, allowedHosts: [], allowPrivateNetwork: false, operation: 'signSteps' }) };
    } else {
      const start = checkUrl(script.startUrl);
      const others = [...new Set(absoluteGotoHosts(script.steps).filter((h) => h !== start.host))];
      result = { ok: true, policy: policyFor({ url: start.href, allowedHosts: others, allowPrivateNetwork: false, operation: 'signSteps' }) };
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
function safetyFlagsProblem(engine: Engine, script: Script, p: ParsedProposal): string | undefined {
  let expected: string[];
  try {
    expected = fullSafetyFlags(engine, script, { unverifiedCount: p.evidence.total === null && !p.evidence.file, fieldsDropped: p.safetyFlags.includes(engine.EXTRACT_FIELDS_DROPPED) });
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

async function signOne(ctx: NodeContext, engine: Engine, i: number, json: IDataObject, at: Date): Promise<SignOutcome> {
  const paired: IPairedItemData[] = [{ item: i }];
  const siteLoginId = credentialId(ctx, CREDENTIALS.siteLogin);
  let key: string;
  let siteLogin: SiteLogin | undefined = undefined;
  let approverId: string;
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
    approverId = asString(ctx.getNodeParameter('approverId', i, '')).trim();
    allowlist = splitList(asString(ctx.getNodeParameter('approverAllowlist', i, ''))).map((a) => a.toLowerCase());
    // An unknown answer (for example a send-and-wait that timed out) is a rejection, never an approval.
    approved = asBoolean(ctx.getNodeParameter('approved', i, false), false);
    // Desktop steps only: the steps the approver declares writes. An expression (the approval form's answer) is expected.
    writeStepsText = asString(ctx.getNodeParameter('writeSteps', i, '')).trim();
    key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
    if (siteLoginId !== undefined) siteLogin = siteLoginConfig(await ctx.getCredentials(CREDENTIALS.siteLogin, i));
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
  if (!approverId || !allowlist.includes(approverId.toLowerCase())) return refuse([APPROVER_NOT_ALLOWED]);
  if (!approved) {
    // Template 3 marks the row with this hash rejected, so the hash must be the hash of these steps.
    if (!hashMatches(engine, p.steps, p.hash)) return refuse([HASH_MISMATCH]);
    return record(rejectedRecord({ name: p.name, version: p.version, hash: p.hash }, approverId, at));
  }
  if (engine.isDesktopDocument(p.steps)) return signDesktop(engine, p, { key, approverId, writeStepsText, secrets: siteSecrets, at, refuse, record });
  if (writeStepsText) return refuse([WRITE_STEPS_BROWSER]);

  const proposal: Proposal = {
    name: p.name, baseVersion: p.baseVersion, version: p.version, steps: p.steps as Script, hash: p.hash,
    evidence: p.evidence, changes: p.changes, safetyFlags: p.safetyFlags, screenshots: {},
  };
  if (malformedEvidence(p.evidence)) return refuse([EVIDENCE_MALFORMED]);
  if (readPostsProblem(p.evidence.readPosts, siteLogin)) return refuse([READ_POSTS_NOT_LISTED]);
  if (fileEvidenceProblem(p)) return refuse([FILE_EVIDENCE_MISMATCH]);
  if (shownTextChanged(engine, proposal, p.shownText)) return refuse([SHOWN_TEXT_CHANGED]);
  // Parsed once for the checks below; engine.signSteps parses the steps it signs itself.
  let script: Script;
  try {
    script = engine.parseScript(p.steps);
  } catch (error) {
    return refuse([errorMessage(error)]);
  }
  const flags = safetyFlagsProblem(engine, script, p);
  if (flags) return refuse([flags]);
  // Sign Steps has no base steps, so it cannot recompute the change list: every entry that says what a step or pop-up
  // handler is now must describe one the steps have, masked as Run Steps masks them. Reported with the engine's
  // reasons (an edited step fails the hash check first), never instead of them.
  const changes = engine.changeListMatches(script, p.changes, (s) => masker.mask(s)) ? undefined : CHANGE_LIST_MISMATCH;
  const policy = signingPolicy(script, siteLogin);
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
  const reasons = [...(result.ok ? [] : result.reasons), ...(changes ? [changes] : [])];
  if (!result.ok || changes) return refuse(reasons);
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
  c: { key: string; approverId: string; writeStepsText: string; secrets: (string | undefined)[]; at: Date; refuse: (r: string[]) => SignOutcome; record: (r: StepsRecord) => SignOutcome },
): SignOutcome {
  const writeSteps = engine.parseWriteSteps(c.writeStepsText);
  if ('error' in writeSteps) return c.refuse([writeSteps.error]);
  if (malformedEvidence(p.evidence)) return c.refuse([EVIDENCE_MALFORMED]);
  const proposal = {
    name: p.name ?? '', baseVersion: p.baseVersion, version: p.version ?? 0, steps: p.steps, hash: p.hash,
    evidence: p.evidence, changes: p.changes, safetyFlags: p.safetyFlags, screenshots: {},
  } as unknown as DesktopProposal;
  if (shownTextChanged(engine, proposal, p.shownText)) return c.refuse([SHOWN_TEXT_CHANGED]);
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
  if (!result.ok) return c.refuse(result.reasons);
  // What was signed as writes, by number and intent, so the approver's choice is confirmed in words.
  const writes = result.row.writeSteps.map((n) => ({ step: n, intent: result.row.steps.steps[n - 1].intent }));
  return c.record({ ...signedRecord(result.row), writeSteps: writes, writeLine: desktopWriteLine(writes) });
}

/** `Signed as writes: step 16 (Click Save)`, or none. */
export function desktopWriteLine(writes: { step: number; intent: string }[]): string {
  if (writes.length === 0) return 'Signed as writes: none (no step was listed in Write Steps)';
  return `Signed as writes: ${writes.map((w) => `step ${w.step} (${w.intent.replace(/\s+/g, ' ').trim()})`).join(', ')}`;
}

/**
 * Sign Steps: one steps-table record per input item, `active` (signed) or `rejected`. No browser is opened.
 * Refusals and configuration errors are error items under continue-on-fail (n8n routes them to the error output).
 */
export async function executeSignSteps(ctx: NodeContext, engine: Engine, now: () => Date = () => new Date()): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const refused = checkMaxItems(ctx, items);
  if (refused) return [refused];
  const out: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    let r: SignOutcome;
    try {
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
