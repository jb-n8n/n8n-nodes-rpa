// Adoption: an imported draft runs once in draft mode and, when it runs clean, is replayed in a fresh
// browser and becomes a proposal with no base (version 1). A drift heals through the existing agent lane with the draft
// as its base. Either way the only output is a Proposal for the approval workflow and Sign Steps: nothing is delivered.
import { FILE_WITHHELD, IMPORT_NOT_ADOPTABLE, IMPORT_PROOF_FAILED, IMPORT_REFUSES_WRITES, ROWS_WITHHELD } from '../messages.js';
import { noWritePolicy } from '../policy/derive.js';
import { flattenSteps, validateScript } from '../policy/validate.js';
import { buildProposal, proposalDigest, stepChanges, type Proposal } from '../proposal/proposal.js';
import { proveScript } from '../prove/prove.js';
import { scriptHash } from '../sign.js';
import { parseScript } from '../steps/parse.js';
import { shownMessage } from '../steps/urls.js';
import type { ErrorCode, OutputSpec, Script } from '../types.js';
import { CANCELLED, clampBudget, laneFailure, laneMasker, traceOn } from '../lane/script-lane.js';
import { draftWrites, runDraft } from '../lane/draft.js';
import { repairPrecondition, type TaskFailure, type TaskInput, type TaskResult } from '../lane/task.js';

export interface AdoptInput extends Omit<TaskInput, 'script' | 'trust' | 'startStatus'> {
  /** The imported step document (ImportResult.drafts[n].script). */
  draft: Script;
}
export type AdoptResult =
  | { ok: true; lane: 'script' | 'agent'; proposal: Proposal; digest: string; llmCalls: number; durationMs: number }
  | (TaskFailure & { adoptable?: false });

const CAPTURES = ['screenshot', 'pdf', 'read'];
const ROWS_NEED = 'Rows need an ID Pattern and an extract or table step.';
const FILE_NEEDS =
  'A file needs exactly one download step, outside paginate, with a check that names the file or its columns, and no extract step.';
const NO_CAPTURES = 'Screenshot, PDF and read steps cannot be proved.';

/**
 * What prove can judge: rows (an ID Pattern, an extract or table step, no download) or one file (exactly one
 * top-level download, none inside paginate, whose check names the file or its columns, and no extract). Screenshot,
 * PDF and read steps are never adoptable. Returns the kind, or why not (IMPORT_NOT_ADOPTABLE first, then what is missing).
 */
export function adoptableKind(script: Script, output: OutputSpec | undefined): { kind: 'rows' | 'file' } | { refused: string } {
  const all = flattenSteps(script.steps);
  const downloads = all.filter((s): s is Extract<typeof s, { download: unknown }> => 'download' in s);
  const extracts = all.filter((s) => 'extract' in s || 'extractTable' in s);
  const why = (detail?: string) => ({ refused: detail ? `${IMPORT_NOT_ADOPTABLE} ${detail}` : IMPORT_NOT_ADOPTABLE });
  if (all.some((s) => CAPTURES.some((verb) => verb in s))) return why(NO_CAPTURES);
  if (downloads.length === 0 && extracts.length === 0) return why(output?.idPattern ? ROWS_NEED : undefined);
  if (downloads.length === 0) return output?.idPattern ? { kind: 'rows' } : why(ROWS_NEED);
  const top = script.steps.filter((s) => 'download' in s);
  const check = downloads[0].download.check;
  const namesFile = !!check && (check.name !== undefined || check.columns !== undefined);
  if (downloads.length !== 1 || top.length !== 1 || extracts.length > 0 || !namesFile) return why(FILE_NEEDS);
  return { kind: 'file' };
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
 * document, not the repair's difference from the draft. Version 1 with no base, the change list against nothing, and
 * the safety flags of a first approval (every download, host and handler is new) together with the repair's own. The
 * hash is recomputed and the caller recomputes the digest; the proof, its evidence, screenshots and trace stay (the
 * proved steps are the same apart from the version).
 */
function firstVersion(p: Proposal, input: AdoptInput, mask: (s: string) => string): Proposal {
  const steps: Script = { ...p.steps, version: 1 };
  const fresh = validateScript(steps, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags.map(mask);
  return {
    ...p, baseVersion: null, version: 1, steps, hash: scriptHash(steps), changes: stepChanges(undefined, steps, mask),
    safetyFlags: [...new Set([...fresh, ...p.safetyFlags])],
  };
}

/**
 * Adopts an imported draft. In order, and refusing before any browser: writes (IMPORT_REFUSES_WRITES),
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
  const adoptable = adoptableKind(draft, input.output);
  if ('refused' in adoptable) return { ...fail('policy_violation', adoptable.refused, { configError: true }), adoptable: false };
  const { kind } = adoptable;
  const policy = noWritePolicy(input.policy);
  const checked = validateScript(draft, { policy, secrets: input.secrets, mode: 'load' });
  if (!checked.ok) return fail('policy_violation', checked.violations.join('; '), { configError: true });

  // Repair heals a drift only when its preconditions hold; otherwise the draft runs without the model and a drift says why.
  const refusedRepair = input.repair ? repairPrecondition(draft, input.output, { ...(draft.name ? { name: draft.name } : {}) }) : undefined;
  // A file is never delivered without a passing proof; rows from an unproven repair are not delivered either.
  const repair = input.repair && !refusedRepair ? { ...input.repair, deliverUnconfirmed: false } : undefined;
  const { repair: _repair, ...withoutRepair } = rest;
  const r = await runDraft({ ...withoutRepair, ...(repair ? { repair } : {}), script: draft });
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
  const script: Script = { ...draft, version: 1 };
  // The run may have typed a sign-in code just now: the proof's full replay never types the same code again (a site may
  // refuse a code used twice), so it waits for the next 30 s window when the sign-in has a code step.
  const mayHaveTypedCode = !!input.secrets?.totpSecret && script.steps.some((s) => 'signIn' in s && s.signIn.totp);
  const prove = await proveScript({
    script, policy, secrets: input.secrets, ...(input.vars ? { vars: input.vars } : {}), output: input.output ?? {},
    endpoint: input.endpoint, masker, budgetMs: clampBudget(input.budgetMs), agentRows: [],
    ...(input.defaultStepTimeoutMs ? { defaultStepTimeoutMs: input.defaultStepTimeoutMs } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(kind === 'file' ? { expectFile: true } : {}), ...(mayHaveTypedCode ? { freshTotpAfter: Date.now() } : {}), trace: traceOn(input.saveTrace),
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
  // The proof is the only run whose rows are judged: there are no agent rows to compare with, so no ID list is shown.
  const proposal = buildProposal({
    script, prove: { ...prove, diff: { missing: [], extra: [] } },
    safetyFlags: validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags, masker,
    ...(prove.screenshot ? { afterScreenshot: prove.screenshot } : {}), ...(prove.trace ? { proofTrace: prove.trace } : {}),
  });
  return { ok: true, lane: 'script', proposal, digest: proposalDigest(proposal), llmCalls, durationMs: Date.now() - t0 };
}
