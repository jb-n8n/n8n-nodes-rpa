// Draft mode. Reachable only through adoptDraft: runTask never reads a draft flag, TaskInput has none, and
// this module is not exported from the package. Nothing a caller passes to runTask can turn it on.
import { IMPORT_EMPTY, IMPORT_REFUSES_WRITES } from '../messages.js';
import { noWritePolicy } from '../policy/derive.js';
import { flattenSteps } from '../policy/validate.js';
import { parseScript } from '../steps/parse.js';
import type { Script } from '../types.js';
import { laneFailure, laneMasker } from './script-lane.js';
import { runTask, type TaskFailure, type TaskInput, type TaskResult } from './task.js';
import { isEmptySteps } from './trust.js';

/** A draft-mode run: a task without trust (draft mode has its own) and without a start-status mode. */
export type DraftTaskInput = Omit<TaskInput, 'trust' | 'startStatus'>;

/** The steps an import may never run: form submissions and downloads through a form (paginate bodies included). */
export const draftWrites = (steps: Script['steps']) =>
  flattenSteps(steps).filter((s) => 'submit' in s || ('download' in s && s.download.via !== undefined));

/**
 * One run in draft mode. Before any browser: the document is copied (plain data only) and parsed, and one that is
 * empty, does not parse, or submits or downloads through a form is refused (policy_violation, configError). The copy
 * then runs as an ordinary task whose trust is a first run's (unsigned, writes allowed: the sign-in is the only one
 * left) under the no-write policy, so every session (script, agent, prove) is no-write and the Site Login rules still
 * decide where the password is typed. Rows, files and captures are removed from a success: nothing from an adoption
 * run is delivered. Never throws.
 */
export async function runDraft(input: DraftTaskInput): Promise<TaskResult> {
  const t0 = Date.now();
  // The run masker, without a signing key: draft mode has no trust input.
  const masker = laneMasker({ secrets: input.secrets, endpoint: input.endpoint });
  const refuse = (message: string): TaskFailure => ({ ...laneFailure(t0, masker, 'policy_violation', masker.mask(message)), lane: 'script', configError: true });
  if (isEmptySteps(input.script)) return refuse(IMPORT_EMPTY);
  let raw: unknown;
  let script: Script;
  try {
    // A plain-data copy: what was checked here is exactly what the lane parses and runs.
    raw = structuredClone(input.script);
    script = parseScript(raw, { defaultStartUrl: input.policy.startUrl });
  } catch (err) {
    return refuse(err instanceof Error ? err.message : 'the steps could not be read');
  }
  if (draftWrites(script.steps).length > 0) return refuse(IMPORT_REFUSES_WRITES);
  // Built key by key: nothing else from the caller reaches the task (a stray trust or startStatus included).
  const task: TaskInput = {
    script: raw, trust: { required: false, allowUnsignedWrites: true }, policy: noWritePolicy(input.policy), endpoint: input.endpoint,
    ...(input.secrets ? { secrets: input.secrets } : {}), ...(input.output ? { output: input.output } : {}), ...(input.vars ? { vars: input.vars } : {}),
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.defaultStepTimeoutMs !== undefined ? { defaultStepTimeoutMs: input.defaultStepTimeoutMs } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}), ...(input.saveTrace ? { saveTrace: input.saveTrace } : {}),
    ...(input.signal ? { signal: input.signal } : {}), ...(input.repair ? { repair: input.repair } : {}),
  };
  const r = await runTask(task);
  return r.ok ? { ...r, rows: [], files: [], outputs: [] } : r;
}
