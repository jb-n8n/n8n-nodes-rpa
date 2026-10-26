import { STEPS_CHANGED_AFTER_REVIEW, STEPS_HASH_MISMATCH, STEPS_NAME_MISMATCH, STEPS_VERSION_MISMATCH } from '../messages.js';
import { flattenSteps, validateScript } from '../policy/validate.js';
import type { ProveResult } from '../prove/prove.js';
import { createMasker, type Masker } from '../secrets/mask.js';
import { canonicalize, scriptHash, signScript } from '../sign.js';
import { parseScript } from '../steps/parse.js';
import type { Interrupt, PortalPolicy, PortalSecrets, Script, Step } from '../types.js';
import { ALSO_CHANGED, changedFields, describeInterrupt, describeStep, withoutBody } from './describe.js';
import { fileEvidence, type FileEvidence } from './evidence.js';

export { ALSO_CHANGED, describeCheck, describeInterrupt, describeStep, reviewLocator } from './describe.js';
export type { FileEvidence } from './evidence.js';

/** One entry of the change list: a step or pop-up handler as it was and as it is now (describeStep, describeInterrupt). */
export interface IntentChange {
  was: string | null;
  now: string | null;
}
/** A repaired steps item: the proven steps the agent lane built, waiting for Sign Steps. */
export interface Proposal {
  name: string;
  baseVersion: number | null;
  version: number;
  steps: Script;
  hash: string;
  evidence: {
    count: number; total: number | null; diff: { missing: string[]; extra: string[] };
    /** The read-only POST entries the proof used (labels, never concrete paths); only when there were any. */
    readPosts?: string[];
    /** A file task: the file the proof downloaded. Covered by the digest, like the rest of the evidence. */
    file?: FileEvidence;
  };
  changes: IntentChange[];
  safetyFlags: string[];
  screenshots: { before?: Buffer; after?: Buffer };
  /** The proof run's scrubbed trace: the new steps replayed alone in a fresh browser, for the reviewer. Not part of the digest. */
  trace?: Buffer;
}
/** A signed record shaped as a row of the steps table. */
export interface SignedStepsRow {
  name: string;
  version: number;
  steps: Script;
  hash: string;
  signature: string;
  approvedBy: string;
  approvedAt: string;
  status: 'active';
}

export const NO_REVIEW_DIGEST = 'the proposal has no review digest';
export const UNVERIFIED_COUNT_FLAG = 'count unverified: the page that was read states no total';

/** Digest of everything a reviewer saw (screenshots excluded); approval can be pinned to it. */
export function proposalDigest(proposal: Proposal): string {
  const { name, baseVersion, version, steps, changes, safetyFlags, evidence } = proposal;
  return scriptHash({ name, baseVersion, version, steps, changes, safetyFlags, evidence });
}

/** LCS diff of two lists compared by `key`; removals and additions between unchanged items are paired in order. */
function diffBy<T>(before: T[], after: T[], key: (x: T) => string): { was: T | null; now: T | null }[] {
  const b = before.map(key);
  const a = after.map(key);
  const n = b.length;
  const m = a.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = b[i] === a[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: { was: T | null; now: T | null }[] = [];
  let removed: T[] = [];
  let added: T[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) out.push({ was: removed[k] ?? null, now: added[k] ?? null });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && b[i] === a[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) added.push(after[j++]!);
    else removed.push(before[i++]!);
  }
  flush();
  return out;
}

/** Compared without a paginate's nested steps: those are listed on their own. */
const stepKey = (s: Step) => canonicalize(withoutBody(s));

/** What the change list describes: every step (paginate bodies included) and every pop-up handler. */
const listedItems = (script: Script | undefined): { steps: Step[]; interrupts: Interrupt[] } => ({
  steps: script ? flattenSteps(script.steps) : [],
  interrupts: script?.interrupts ?? [],
});

/**
 * The change list: every step (paginate bodies included) and every pop-up handler, compared by its
 * canonical form, not its intent, so a step whose locator, target or value changed is listed even when its intent is
 * the same. Steps first, then handlers that were added or removed. `mask` is applied to every description.
 */
export function stepChanges(base: Script | undefined, script: Script, mask: (s: string) => string = (s) => s): IntentChange[] {
  const show = (s: Step) => mask(describeStep(s));
  const old = listedItems(base);
  const cur = listedItems(script);
  const steps = diffBy(old.steps, cur.steps, stepKey).map(({ was, now }) => {
    if (!was || !now) return { was: was && show(was), now: now && show(now) };
    const w = show(was);
    const n = show(now);
    // A change the description cannot show (an expectation, a timeout) names the fields that changed.
    return { was: w, now: n === w ? `${n}${ALSO_CHANGED}${changedFields(was, now).join(', ')})` : n };
  });
  const before = new Map(old.interrupts.map((it) => [canonicalize(it), it]));
  const after = new Map(cur.interrupts.map((it) => [canonicalize(it), it]));
  const handlers: IntentChange[] = [
    ...[...before].filter(([k]) => !after.has(k)).map(([, it]) => ({ was: mask(describeInterrupt(it)), now: null })),
    ...[...after].filter(([k]) => !before.has(k)).map(([, it]) => ({ was: null, now: mask(describeInterrupt(it)) })),
  ];
  return [...steps, ...handlers];
}

/** The suffix stepChanges adds to a changed step that reads the same as before: ` (also changed: expect, timeoutMs)`. */
const ALSO_CHANGED_SUFFIX = new RegExp(`${ALSO_CHANGED.replace(/[()]/g, '\\$&')}[\\w.]+(?:, [\\w.]+)*\\)$`);

/**
 * True when every change-list entry that says what a step or pop-up handler is now describes one `script` has
 * (describeStep / describeInterrupt through `mask`, as stepChanges shows them; the also-changed suffix aside). Sign
 * Steps has no base steps, so it cannot recompute the change list: this keeps a crafted item from showing a harmless
 * description for a step that does something else. Entries are untrusted: a `now` that is not a known description fails.
 */
export function changeListMatches(script: Script, changes: readonly unknown[], mask: (s: string) => string = (s) => s): boolean {
  const { steps, interrupts } = listedItems(script);
  const known = new Set([...steps.map((s) => mask(describeStep(s))), ...interrupts.map((it) => mask(describeInterrupt(it)))]);
  return changes.every((c) => {
    const now = typeof c === 'object' && c !== null ? (c as { now?: unknown }).now : undefined;
    return now === null || now === undefined || (typeof now === 'string' && known.has(now.replace(ALSO_CHANGED_SUFFIX, '')));
  });
}

/** The reviewable proposal for a proven candidate script. Every string is masked. */
export function buildProposal(input: {
  base?: Script;
  script: Script;
  prove: ProveResult;
  safetyFlags: string[];
  masker: Masker;
  beforeScreenshot?: Buffer;
  afterScreenshot?: Buffer;
  /** The proof run's scrubbed trace. */
  proofTrace?: Buffer;
}): Proposal {
  const { masker } = input;
  if (!input.prove.ok) throw new Error(masker.mask('a proposal needs a passing prove'));
  const safetyFlags = input.safetyFlags.map((f) => masker.mask(f));
  // A file's evidence is the file itself (its checks passed): no page total is expected.
  const file = input.prove.file;
  if (input.prove.total === null && !file && !safetyFlags.includes(UNVERIFIED_COUNT_FLAG)) safetyFlags.push(UNVERIFIED_COUNT_FLAG);
  return {
    name: input.script.name ?? '',
    baseVersion: input.base?.version ?? null,
    version: input.script.version ?? 0,
    steps: input.script,
    hash: scriptHash(input.script),
    evidence: {
      count: input.prove.rows.length,
      total: input.prove.total,
      diff: { missing: input.prove.diff.missing.map((x) => masker.mask(x)), extra: input.prove.diff.extra.map((x) => masker.mask(x)) },
      ...(input.prove.readPosts.length ? { readPosts: input.prove.readPosts.map((x) => masker.mask(x)) } : {}),
      ...(file ? { file: fileEvidence({ fileName: file.fileName, mimeType: file.mimeType, bytes: file.bytes, facts: { columns: file.columns, rows: file.rows } }, masker) } : {}),
    },
    changes: stepChanges(input.base, input.script, (s) => masker.mask(s)),
    safetyFlags,
    screenshots: {
      ...(input.beforeScreenshot ? { before: input.beforeScreenshot } : {}),
      ...(input.afterScreenshot ? { after: input.afterScreenshot } : {}),
    },
    ...(input.proofTrace ? { trace: input.proofTrace } : {}),
  };
}

/** Re-checks a repaired steps item and signs it into a steps-table row. Never throws. */
export function signSteps(input: {
  proposal: Proposal;
  key: string;
  approverId: string;
  policy: PortalPolicy;
  /** Site Login secrets; absent without a Site Login. */
  secrets?: PortalSecrets;
  now?: Date;
  /** proposalDigest of what the reviewer saw (AgentLaneSuccess.digest). Required: approval is always bound to a review. */
  reviewedDigest: string;
  /** Id of the Site Login credential attached to Sign Steps; bound into the signature. */
  siteLoginId?: string;
}): { ok: true; row: SignedStepsRow } | { ok: false; reasons: string[] } {
  const { proposal } = input;
  // Nothing is signed without the digest of what the reviewer saw (callers outside TypeScript may still omit it).
  if (typeof input.reviewedDigest !== 'string' || !input.reviewedDigest.trim()) return { ok: false, reasons: [NO_REVIEW_DIGEST] };
  const masker = createMasker([input.secrets?.username, input.secrets?.password, input.secrets?.totpSecret, input.key]);
  let script: Script;
  try {
    script = parseScript(proposal.steps);
  } catch (err) {
    return { ok: false, reasons: [masker.mask((err as Error).message)] };
  }
  const { name, version } = script;
  // Signing binds name and version (signScript refuses without them); say so instead of throwing.
  if (name === undefined || version === undefined) return { ok: false, reasons: ['signing needs a name and a version'] };
  const reasons: string[] = [];
  if (proposal.hash !== scriptHash(proposal.steps)) reasons.push(STEPS_HASH_MISMATCH);
  if (name !== proposal.name) reasons.push(STEPS_NAME_MISMATCH);
  if (version !== proposal.version) reasons.push(STEPS_VERSION_MISMATCH);
  if (proposal.baseVersion !== null && version <= proposal.baseVersion) {
    reasons.push(`version ${version} is not newer than the base version ${proposal.baseVersion}`);
  }
  reasons.push(...validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'load' }).violations);
  if (input.reviewedDigest !== proposalDigest(proposal)) reasons.push(STEPS_CHANGED_AFTER_REVIEW);
  if (!input.approverId.trim()) reasons.push('approver id is empty');
  if (!input.key.trim()) reasons.push('signing key is empty');
  const at = input.now ?? new Date();
  if (Number.isNaN(at.getTime())) reasons.push('approval time is invalid');
  if (reasons.length) return { ok: false, reasons: reasons.map((r) => masker.mask(r)) };
  let signed: { hash: string; signature: string };
  try {
    signed = signScript(proposal.steps, input.key, {
      approvedBy: input.approverId, ...(input.siteLoginId ? { siteLoginId: input.siteLoginId } : {}),
    });
  } catch (err) {
    return { ok: false, reasons: [masker.mask((err as Error).message)] };
  }
  const { hash, signature } = signed;
  return {
    ok: true,
    row: {
      name,
      version,
      steps: proposal.steps,
      hash,
      signature,
      approvedBy: input.approverId,
      approvedAt: at.toISOString(),
      status: 'active',
    },
  };
}
