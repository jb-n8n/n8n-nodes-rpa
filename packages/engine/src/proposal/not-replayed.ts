// Browser steps that go to approval without a replay. An import runs a browser draft once and replays it under no-write
// rules, so steps that submit a form, download through a form, type a secret or set a new password cannot be proven
// that way. A step document with any of them is not run at all: the approver reviews it as written, as desktop step
// sets are, and Sign Steps signs it only as a first version with empty evidence.
import { draftWrites } from '../lane/draft.js';
import { hasChangePassword, hasSecretFill } from '../lane/trust.js';
import { flattenSteps, validateScript } from '../policy/validate.js';
import { SECRET_FILL_VALUE } from '../secrets/render.js';
import { scriptHash } from '../sign.js';
import { parseScript } from '../steps/parse.js';
import type { Script, Step } from '../types.js';
import { stepChanges, type Proposal } from './proposal.js';

/**
 * Whether the steps need approval as written: a submit, a download through a form (draftWrites, paginate bodies
 * included), a fill marked secret, or a signIn with changePassword (the trust gate's own checks). An import never runs
 * such steps.
 */
export function needsApprovalAsWritten(steps: Step[]): boolean {
  return draftWrites(steps).length > 0 || hasSecretFill(steps) || hasChangePassword(steps);
}

/** `{{var.name}}` as the parser accepts it for a secret value, written without spaces; never a value. */
const variableOf = (value: string): string => `{{var.${SECRET_FILL_VALUE.exec(value)?.[1] ?? ''}}}`;

/**
 * One flag per run variable that a secret fill types or a password change sets, which the full safety flags do not name:
 * the variable by name, never a value. No step number: the browser change list does not number its steps. The same
 * flag is listed once.
 */
export function notReplayedFlags(script: Script): string[] {
  const flags = new Set<string>();
  for (const s of flattenSteps(script.steps)) {
    if ('fill' in s && s.fill.secret === true) flags.add(`secret fill: a step types the run variable ${variableOf(s.fill.value)}`);
    if ('signIn' in s && s.signIn.changePassword) flags.add(`password change: a step sets a new password from the run variable ${variableOf(s.signIn.changePassword.value)}`);
  }
  return [...flags];
}

/**
 * The reviewable proposal of browser steps that were not run: version 1 with no base, empty evidence (as a desktop
 * proposal's), every step listed as added, and the safety flags of a first approval and notReplayedFlags. No page was
 * read, so there is no count-unverified flag. Every description and flag goes through `mask`.
 */
export function notReplayedProposal(script: Script, mask: (s: string) => string = (s) => s): Proposal {
  const steps = parseScript(script);
  const policy = { startUrl: steps.startUrl, navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] };
  const flags = [...validateScript(steps, { policy, mode: 'proposal' }).safetyFlags, ...notReplayedFlags(steps)];
  return {
    name: steps.name ?? '',
    baseVersion: null,
    version: steps.version ?? 1,
    steps: script,
    hash: scriptHash(script),
    evidence: { count: 0, total: null, diff: { missing: [], extra: [] } },
    changes: stepChanges(undefined, steps, mask),
    safetyFlags: flags.map(mask),
    screenshots: {},
  };
}
