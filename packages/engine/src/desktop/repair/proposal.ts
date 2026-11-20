// The proposal of a desktop repair: the whole repaired step list as the next version, for a person to review and
// approve as a whole. No step carries a write flag: the approver marks the writes again when signing (writes are marked
// only at approval, never by an import or a repair). The change list and the safety flags are those of a first
// version (every step listed as added; candidate writes flagged), and the proof's evidence says which steps ran in a
// fresh start of the app, which step it stopped at and why, and which steps the repair changed or added.
import { DESKTOP_NO_EVIDENCE, desktopSafetyFlags, desktopStepChanges, type DesktopProposal } from '../../proposal/desktop.js';
import { proposalDigest } from '../../proposal/proposal.js';
import { scriptHash } from '../../sign.js';
import { parseDesktopScript } from '../../steps/parse.js';
import type { DesktopScript } from '../../types.js';
import type { DesktopProofEvidence } from './prove.js';

export interface DesktopRepairProposal extends Omit<DesktopProposal, 'evidence'> {
  evidence: DesktopProposal['evidence'] & { proof: DesktopProofEvidence };
}

/** The steps without any write flag. */
export function withoutWrites(doc: DesktopScript): DesktopScript {
  const out = structuredClone(doc);
  for (const s of out.steps) delete s.write;
  return out;
}

/** Version N+1 of the base: the repaired steps, no write flags, the proof's evidence. */
export function desktopRepairProposal(input: { base: DesktopScript; doc: DesktopScript; proof: DesktopProofEvidence; mask?: (s: string) => string }): { proposal: DesktopRepairProposal; digest: string } {
  const mask = input.mask ?? ((s: string) => s);
  const baseVersion = input.base.version ?? 1;
  const steps = parseDesktopScript({ ...withoutWrites(input.doc), ...(input.base.name !== undefined ? { name: input.base.name } : {}), version: baseVersion + 1 });
  const proposal: DesktopRepairProposal = {
    name: steps.name ?? '',
    baseVersion,
    version: baseVersion + 1,
    steps,
    hash: scriptHash(steps),
    evidence: { ...structuredClone(DESKTOP_NO_EVIDENCE), proof: input.proof },
    changes: desktopStepChanges(steps, mask),
    safetyFlags: desktopSafetyFlags(steps).map(mask),
    screenshots: {},
  };
  return { proposal, digest: proposalDigest(proposal) };
}
