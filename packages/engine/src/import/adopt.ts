// Adoption: an imported draft runs once in draft mode and, when it runs clean, is replayed in a fresh
// browser and becomes a proposal with no base (version 1). A drift heals through the existing agent lane with the draft
// as its base. Either way the only output is a Proposal for the approval workflow and Sign Steps: nothing is delivered.
import { FILE_WITHHELD, IMPORT_NOT_ADOPTABLE, IMPORT_PROOF_FAILED, IMPORT_REFUSES_WRITES, IMPORT_ROWS_NEED_ID, importCannotProve, ROWS_WITHHELD } from '../messages.js';
import { noWritePolicy } from '../policy/derive.js';
import { flattenSteps, validateScript } from '../policy/validate.js';
import { buildProposal, proposalDigest, stepChanges, type Proposal } from '../proposal/proposal.js';
import { proveScript } from '../prove/prove.js';
import { scriptHash } from '../sign.js';
import { parseScript } from '../steps/parse.js';
import { DEFAULT_MIME, sanitizeFileName } from '../steps/handlers/files.js';
import { shownMessage } from '../steps/urls.js';
import type { ErrorCode, OutputSpec, Script, Step } from '../types.js';
import { CANCELLED, clampBudget, codeSettings, laneFailure, laneMasker, traceOn } from '../lane/script-lane.js';
import { draftWrites, runDraft } from '../lane/draft.js';
import { repairPrecondition, type TaskFailure, type TaskInput, type TaskResult } from '../lane/task.js';

export interface AdoptInput extends Omit<TaskInput, 'script' | 'trust' | 'startStatus'> {
  /** The imported step document (ImportResult.drafts[n].script). */
  draft: Script;
}
export type AdoptResult =
  | { ok: true; lane: 'script' | 'agent'; proposal: Proposal; digest: string; llmCalls: number; durationMs: number }
  | (TaskFailure & { adoptable?: false });

const ROWS_NEED = 'Rows need an ID Pattern and an extract or table step.';
/**
 * The ID Pattern the steps state for their rows: the idPattern of their extract and extractTable steps (inside paginate
 * too), when every one of them has one. Different ones are joined as alternatives. Undefined when the steps read no rows
 * or a step reads rows without one (its rows then have no ID to check).
 */
export function statedIdPattern(script: Script): string | undefined {
  const patterns = flattenSteps(script.steps).flatMap((s) => ('extract' in s ? [s.extract.idPattern] : 'extractTable' in s ? [s.extractTable.idPattern] : []));
  if (patterns.length === 0 || patterns.some((p) => !p)) return undefined;
  const distinct = [...new Set(patterns as string[])];
  return distinct.length === 1 ? distinct[0] : distinct.map((p) => `(?:${p})`).join('|');
}

/** "1 file", "3 files": a count and its noun. */
const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c". */
const listed = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
/** "step 4", "steps 4 and 9": the 1-based numbers of the top-level steps. */
const stepsNamed = (numbers: number[]) => `${numbers.length === 1 ? 'step' : 'steps'} ${listed(numbers.map(String))}`;

/** A top-level step and its number (1-based); a step inside paginate carries the number of its paginate. */
interface Numbered { step: Step; at: number; nested: boolean }
function numbered(steps: Step[]): Numbered[] {
  return steps.flatMap((step, i) => [
    { step, at: i + 1, nested: false },
    ...('paginate' in step ? flattenSteps(step.paginate.each).map((inner) => ({ step: inner, at: i + 1, nested: true })) : []),
  ]);
}

/**
 * What prove can judge: rows (an ID Pattern, an extract or table step, no download or screenshot), one file (exactly one
 * download, whose check names the file or its columns, and no screenshot), or files (several such downloads, or
 * screenshots with or without them). Every download must be outside paginate and checked; PDF and read steps are never
 * adoptable, and neither are rows together with files. Returns the kind, or why not: IMPORT_NOT_ADOPTABLE when the steps
 * read, download and capture nothing, IMPORT_ROWS_NEED_ID for rows without an ID Pattern, else importCannotProve, which
 * says what the steps do and what keeps the replay from proving it.
 */
export function adoptableKind(script: Script, output: OutputSpec | undefined): { kind: 'rows' | 'file' | 'files' } | { refused: string } {
  const all = numbered(script.steps);
  const of = (verb: string) => all.filter((n) => verb in n.step);
  const downloads = of('download');
  const shots = of('screenshot');
  const pdfs = of('pdf');
  const reads = of('read');
  const extracts = all.filter((n) => 'extract' in n.step || 'extractTable' in n.step);
  const found = listed([
    ...(extracts.length ? ['read rows'] : []),
    ...(downloads.length ? [`download ${counted(downloads.length, 'file')}`] : []),
    ...(shots.length ? [`take ${counted(shots.length, 'screenshot')}`] : []),
    ...(pdfs.length ? [`save ${counted(pdfs.length, 'PDF')}`] : []),
    ...(reads.length ? [`read the page in ${counted(reads.length, 'step')}`] : []),
  ]);
  const cannot = (why: string) => ({ refused: importCannotProve(found, why) });
  const at = (list: Numbered[]) => stepsNamed([...new Set(list.map((n) => n.at))]);
  if (pdfs.length || reads.length) return cannot(`a replay cannot prove a PDF or read step (${at([...pdfs, ...reads])})`);
  if (downloads.length === 0 && shots.length === 0) {
    if (extracts.length === 0) return { refused: output?.idPattern ? `${IMPORT_NOT_ADOPTABLE} ${ROWS_NEED}` : IMPORT_NOT_ADOPTABLE };
    return output?.idPattern ? { kind: 'rows' } : { refused: IMPORT_ROWS_NEED_ID };
  }
  if (extracts.length) return cannot('a replay proves rows or files, not both in one step list');
  const repeated = [...downloads, ...shots].filter((n) => n.nested);
  if (repeated.length) return cannot(`a download or screenshot inside paginate (${at(repeated)}) repeats, so the replay cannot tell what to expect`);
  const unchecked = downloads.filter((n) => {
    const check = (n.step as Extract<Step, { download: unknown }>).download.check;
    return !check || (check.name === undefined && check.columns === undefined);
  });
  if (unchecked.length) {
    return cannot(`the download in ${at(unchecked)} has no check that names the file or its columns (check.name or check.columns), so the replay cannot tell the right file from a wrong one`);
  }
  return downloads.length === 1 && shots.length === 0 ? { kind: 'file' } : { kind: 'files' };
}

/** A MIME type as sniffMime writes it: type/subtype of lowercase letters, digits, dot, plus and hyphen. */
const MIME_SHAPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Why evidence of several files or a screenshot (`files`, `screenshots`: untrusted, as an item carries them) does not
 * go with the steps `raw`, or undefined when it does. One rule for the import's proof (adoptDraft checks its own result
 * with it) and for Sign Steps, which signs only what this accepts:
 * - the steps are of the kind such a proof covers (adoptableKind 'files': no extract, table, PDF or read step, no
 *   download or screenshot inside paginate, every download with a check that names its file or columns, and several
 *   downloads or a screenshot);
 * - each file comes from a distinct top-level download step and each screenshot from a distinct top-level screenshot
 *   step; nothing extra, nothing twice, at least one of either;
 * - every download step without `when` has its file, and every screenshot step without `when` that is not optional has
 *   its screenshot (a step whose condition was not met proves nothing and is not listed, as the proof lists it);
 * - each file is shaped as a download makes it: its name is a sanitized file name (sanitizeFileName gives it back
 *   unchanged, so it holds no "; ", quote, line break or path), its type a MIME type the step allows (`mime`, else the
 *   default list), whole bytes and rows, columns a list of text or null.
 */
export function filesEvidenceProblem(raw: unknown, files: unknown, screenshots: unknown): string | undefined {
  let script: Script;
  try {
    script = parseScript(structuredClone(raw), { defaultStartUrl: 'https://steps.invalid/' });
  } catch {
    return 'the steps do not parse';
  }
  const kind = adoptableKind(script, undefined);
  if (!('kind' in kind) || kind.kind !== 'files') return 'the steps are not ones a proof of several files or a screenshot covers';
  if (!Array.isArray(files) || !Array.isArray(screenshots)) return 'files and screenshots must both be lists';
  if (files.length + screenshots.length === 0) return 'the proof lists no file and no screenshot';
  const top = script.steps;
  const stepOf = (n: unknown): Step | undefined => (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= top.length ? top[n - 1] : undefined);
  const withFile = new Set<number>();
  for (const f of files) {
    if (!isRecord(f)) return 'a file is not an object';
    const step = stepOf(f.step);
    if (!step || !('download' in step)) return 'a file names no download step';
    if (withFile.has(f.step as number)) return `step ${f.step as number} is listed twice`;
    withFile.add(f.step as number);
    if (typeof f.fileName !== 'string' || sanitizeFileName(f.fileName) !== f.fileName) return `the file of step ${f.step as number} has a name no download gets`;
    if (typeof f.mimeType !== 'string' || !MIME_SHAPE.test(f.mimeType) || !(step.download.mime ?? DEFAULT_MIME).includes(f.mimeType)) {
      return `the file of step ${f.step as number} has a type its step does not allow`;
    }
    if (!whole(f.bytes) || !(f.rows === null || whole(f.rows)) || !(f.columns === null || (Array.isArray(f.columns) && f.columns.every((c) => typeof c === 'string')))) {
      return `the file of step ${f.step as number} is not shaped as a download makes it`;
    }
  }
  const shot = new Set<number>();
  for (const n of screenshots) {
    const step = stepOf(n);
    if (!step || !('screenshot' in step)) return 'a screenshot names no screenshot step';
    if (shot.has(n as number)) return `step ${n as number} is listed twice`;
    shot.add(n as number);
  }
  for (const [i, step] of top.entries()) {
    if ('download' in step && !step.when && !withFile.has(i + 1)) return `the download of step ${i + 1} is missing`;
    if ('screenshot' in step && !step.when && !step.optional && !shot.has(i + 1)) return `the screenshot of step ${i + 1} is missing`;
  }
  return undefined;
}

/**
 * An adoption failure without the agent's transcript and action log: they quote page snapshots, and an import's
 * failure only needs to say what went wrong (code, message, failing step, violations, screenshot, trace).
 */
function withoutPages(r: Extract<TaskResult, { ok: false }>): TaskFailure {
  const { transcript: _transcript, agentLog: _agentLog, ...rest } = r;
  return rest;
}

/**
 * A healed draft as the first version: the draft was never signed, so the approver reviews the whole
 * document, not the repair's difference from the draft. The draft's version (1, or the import's) with no base, the change list against nothing, and
 * the safety flags of a first approval (every download, host and handler is new) together with the repair's own. The
 * hash is recomputed and the caller recomputes the digest; the proof, its evidence, screenshots and trace stay (the
 * proved steps are the same apart from the version).
 */
function firstVersion(p: Proposal, input: AdoptInput, mask: (s: string) => string): Proposal {
  const version = input.draft.version ?? 1;
  const steps: Script = { ...p.steps, version };
  const fresh = validateScript(steps, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags.map(mask);
  return {
    ...p, baseVersion: null, version, steps, hash: scriptHash(steps), changes: stepChanges(undefined, steps, mask),
    safetyFlags: [...new Set([...fresh, ...p.safetyFlags])],
  };
}

/**
 * Adopts an imported draft. Without an ID Pattern in `output`, the one the steps state is used (statedIdPattern).
 * In order, and refusing before any browser: writes (IMPORT_REFUSES_WRITES),
 * the adoptable kind (IMPORT_NOT_ADOPTABLE with `adoptable: false`), the policy (validateScript). Then one run in
 * draft mode, with AI repair only when it is connected and its preconditions hold:
 * - a script-lane success is replayed by proveScript in a fresh browser with no model and the no-write policy, imported
 *   fallbacks allowed (they are the author's own recording), and becomes a proposal with no base, version 1;
 * - an agent-lane success returns the repair's proposal rebased as a first version (firstVersion; its own steps
 *   followed the fallback rule in compile and its proof);
 * - anything else is the run's failure without page snapshots (a drift without a model: the step's error, drift_detected).
 * Every string is masked. Never throws.
 */
export async function adoptDraft(input: AdoptInput): Promise<AdoptResult> {
  const t0 = Date.now();
  const { draft: raw, ...rest } = input;
  const masker = laneMasker({ secrets: input.secrets, endpoint: input.endpoint });
  const fail = (code: ErrorCode, message: string, extra: Partial<TaskFailure> = {}): TaskFailure => ({
    ...laneFailure(t0, masker, code, shownMessage(message, masker)), lane: 'script', ...extra,
  });
  let draft: Script;
  try {
    draft = parseScript(structuredClone(raw), { defaultStartUrl: input.policy.startUrl });
  } catch (err) {
    return fail('policy_violation', err instanceof Error ? err.message : 'the steps could not be read', { configError: true });
  }
  if (draftWrites(draft.steps).length > 0) return fail('policy_violation', IMPORT_REFUSES_WRITES, { configError: true });
  const stated = input.output?.idPattern ? undefined : statedIdPattern(draft);
  const output: OutputSpec | undefined = stated ? { ...input.output, idPattern: stated } : input.output;
  const adoptable = adoptableKind(draft, output);
  if ('refused' in adoptable) return { ...fail('policy_violation', adoptable.refused, { configError: true }), adoptable: false };
  const { kind } = adoptable;
  const policy = noWritePolicy(input.policy);
  const checked = validateScript(draft, { policy, secrets: input.secrets, mode: 'load' });
  if (!checked.ok) return fail('policy_violation', checked.violations.join('; '), { configError: true });

  // Repair heals a drift only when its preconditions hold; otherwise the draft runs without the model and a drift says why.
  const refusedRepair = input.repair ? repairPrecondition(draft, output, { ...(draft.name ? { name: draft.name } : {}) }) : undefined;
  // A file is never delivered without a passing proof; rows from an unproven repair are not delivered either.
  const repair = input.repair && !refusedRepair ? { ...input.repair, deliverUnconfirmed: false } : undefined;
  const { repair: _repair, ...withoutRepair } = rest;
  const r = await runDraft({ ...withoutRepair, ...(output ? { output } : {}), ...(repair ? { repair } : {}), script: draft });
  const llmCalls = (r as { llmCalls?: number }).llmCalls ?? 0;
  if (!r.ok) {
    const failed = withoutPages(r);
    if (refusedRepair && r.code === 'drift_detected') return { ...failed, message: masker.mask(`${r.message} (${refusedRepair})`) };
    // A repair whose proof did not pass: nothing was going to be delivered, so the message names the proof, not the option.
    const withheld = [ROWS_WITHHELD, FILE_WITHHELD].find((w) => r.message.startsWith(w));
    return withheld ? { ...failed, message: `${IMPORT_PROOF_FAILED}${r.message.slice(withheld.length)}` } : failed;
  }
  if (r.submitted) return fail('policy_violation', IMPORT_REFUSES_WRITES);
  if (r.lane === 'agent') {
    if (!r.proposal) return fail('incomplete', IMPORT_PROOF_FAILED, { lane: 'agent', llmCalls });
    const proposal = firstVersion(r.proposal, input, masker.mask);
    return { ok: true, lane: 'agent', proposal, digest: proposalDigest(proposal), llmCalls, durationMs: Date.now() - t0 };
  }

  if (input.signal?.aborted) return fail('incomplete', CANCELLED);
  // The draft's own version: 1, or the one the import gave (ImportOptions.version).
  const script: Script = { ...draft, version: draft.version ?? 1 };
  // The run may have typed a sign-in code just now (from the TOTP secret or the code provider): the proof's full replay
  // never types the same code again (a site may refuse a code used twice), so it waits for the next 30 s window when the
  // sign-in has a code step. The proof asks the same code provider as the run.
  const mayHaveTypedCode = (!!input.secrets?.totpSecret || !!input.codeProvider) && script.steps.some((s) => 'signIn' in s && s.signIn.totp);
  const prove = await proveScript({
    script, policy, secrets: input.secrets, ...codeSettings(input), ...(input.vars ? { vars: input.vars } : {}), output: output ?? {},
    endpoint: input.endpoint, masker, budgetMs: clampBudget(input.budgetMs), agentRows: [],
    ...(input.defaultStepTimeoutMs ? { defaultStepTimeoutMs: input.defaultStepTimeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(kind === 'file' ? { expectFile: true } : kind === 'files' ? { expectFiles: true } : {}), ...(mayHaveTypedCode ? { freshTotpAfter: Date.now() } : {}), trace: traceOn(input.saveTrace),
  });
  if (prove.policyViolation) {
    return fail('policy_violation', 'the imported steps attempted a blocked request during the proof', {
      violations: prove.violations ?? [], ...(prove.trace ? { trace: prove.trace } : {}),
    });
  }
  if (!prove.ok) {
    const code: ErrorCode = prove.failureCode === 'login_failed' || prove.failureCode === 'account_locked' ? prove.failureCode : 'incomplete';
    const why = prove.reasons[0];
    return fail(code, why ? `${IMPORT_PROOF_FAILED}. Reason: ${why}` : IMPORT_PROOF_FAILED, {
      ...(prove.screenshot ? { screenshot: prove.screenshot } : {}), ...(prove.trace ? { trace: prove.trace } : {}),
    });
  }
  // A proof of several files or a screenshot passes only when Sign Steps would take its evidence: the one rule for both.
  const unfit = kind === 'files' ? filesEvidenceProblem(script, prove.files, prove.screenshots) : undefined;
  if (unfit) return fail('incomplete', `${IMPORT_PROOF_FAILED}. Reason: ${unfit}`);
  // The proof is the only run whose rows are judged: there are no agent rows to compare with, so no ID list is shown.
  const proposal = buildProposal({
    script, prove: { ...prove, diff: { missing: [], extra: [] } },
    safetyFlags: validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags, masker,
    ...(prove.screenshot ? { afterScreenshot: prove.screenshot } : {}), ...(prove.trace ? { proofTrace: prove.trace } : {}),
  });
  return { ok: true, lane: 'script', proposal, digest: proposalDigest(proposal), llmCalls, durationMs: Date.now() - t0 };
}
