import { createHash } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import type { TaskResult } from 'n8n-rpa-engine';
import { readRepairStop } from './breaker-record.js';
import { CREDENTIALS } from './config.js';
import { REPAIR_HELD_WORDS } from './errors.js';
import type { NodeContext } from './context.js';
import { isQueueMode, memoryGuardStore, redisAttached, type GuardStore, type GuardStoreDeps, type RepairStop } from './guard-store.js';
import { redisGuardStore } from './redis-store.js';

// A repair that failed is not tried again until a person acts (the owner's decision of 2026-11-16): each try can cost up
// to its Max LLM Tokens. The record is kept per workflow, steps name, version and hash, where the login breaker keeps its
// own (guard.ts): workflow static data with n8n's in-process store, or Redis when the node shares its login breaker across
// workers. A new approved version (a new key) or a changed AI Repair Reset Key lets it try again.

/** The workflow static data key of the failed-repair records, beside `playwrightLoginBreakers`. */
export const REPAIR_STOP_KEY = 'playwrightRepairStops';
/** Records kept in static data per workflow: the oldest go first. */
export const MAX_REPAIR_STOPS = 20;

export type { RepairStop } from './guard-store.js';

/** The steps a record belongs to: the name, version and hash the run reports (runStepsParams stepsIdentity). */
export interface StepsKey { name: string | null; version: number | null; hash: string }

/**
 * The record's key: the workflow, the steps' name, version and hash, and the Goal (the guidance asks a person to say in
 * the Goal where the data is now: a new Goal tries again). A short SHA-256, so none of them is kept in static data or
 * Redis keys as text. Empty steps (a first build) have no version and no hash.
 */
export function repairStopKey(workflowId: string, steps: StepsKey, goal: string): string {
  const id = createHash('sha256').update([workflowId, steps.name ?? '', steps.version ?? '', steps.hash, goal.trim()].join('\0')).digest('hex').slice(0, 24);
  return `repair:${id}`;
}

/** The sentence a held run ends with (in brackets after the step's own failure, or alone for a first build). */
export const repairHeld = (version: number | null, firstBuild: boolean): string =>
  `a repair already failed for ${firstBuild ? 'the first version of these steps' : version !== null ? `steps version ${version}` : 'these steps'}${REPAIR_HELD_WORDS}change the Goal, approve a new version of the steps, or change AI Repair Reset Key in Options, to let it try again`;

/** The sentence a failed repair's own message ends with, so the person learns at once that the next runs do not try. */
export const REPAIR_NOT_AGAIN = 'The next runs do not try AI Repair again for these steps until the Goal, the steps or AI Repair Reset Key change.';

/** Where the records live for one item, and whether static data may be written. */
interface StopPlace { store: GuardStore; staticData?: IDataObject }

/**
 * Redis when the node shares its login breaker across workers (redisAttached), else the in-process store with static data.
 * In queue mode without Redis, the in-process store only: a queue-mode worker saves static data whole (guard-store.ts),
 * so this never writes it there, and each worker remembers its own failures. Never a configuration error.
 */
async function openPlace(ctx: NodeContext, itemIndex: number, deps: GuardStoreDeps): Promise<StopPlace> {
  if (redisAttached(ctx.getNode())) return { store: await (deps.redis ?? redisGuardStore)(await ctx.getCredentials(CREDENTIALS.redis, itemIndex)) };
  if (isQueueMode(deps)) return { store: memoryGuardStore() };
  return { store: memoryGuardStore(), staticData: ctx.getWorkflowStaticData('global') };
}

function persisted(staticData: IDataObject | undefined): Record<string, RepairStop> {
  const all = staticData?.[REPAIR_STOP_KEY];
  const out: Record<string, RepairStop> = {};
  if (typeof all !== 'object' || all === null || Array.isArray(all)) return out;
  for (const [k, v] of Object.entries(all)) {
    const record = readRepairStop(v);
    if (record) out[k] = record;
  }
  return out;
}

/** Writes the records as a new top-level object (n8n's ObservableObject only notices writes to the top level). */
function writeStatic(staticData: IDataObject, records: Record<string, RepairStop>): void {
  const kept = Object.entries(records).sort(([, a], [, b]) => a.at.localeCompare(b.at)).slice(-MAX_REPAIR_STOPS);
  staticData[REPAIR_STOP_KEY] = Object.fromEntries(kept);
}

/** Field-by-field equality of two records (a write only when something differs: static data is saved when it changes). */
const sameStop = (a: RepairStop | undefined, b: RepairStop): boolean =>
  a !== undefined && a.at === b.at && a.resetKey === b.resetKey && a.version === b.version && a.code === b.code && a.llmCalls === b.llmCalls && a.tokens === b.tokens;

async function within<T>(ctx: NodeContext, itemIndex: number, deps: GuardStoreDeps, use: (place: StopPlace) => Promise<T>): Promise<T> {
  const place = await openPlace(ctx, itemIndex, deps);
  try {
    return await use(place);
  } finally {
    await place.store.close().catch(() => undefined);
  }
}

/**
 * The failed repair that holds this run, or undefined. A record holds while AI Repair Reset Key is what it was when the
 * repair failed (both trimmed); any other value clears it and lets the repair run. A record only the store knows is
 * written back to static data, as the login breaker does. When the store cannot be read (Redis down), the repair is held
 * with that reason: a run never spends on the model because the record could not be checked.
 */
export async function heldRepair(ctx: NodeContext, itemIndex: number, deps: GuardStoreDeps, key: string, resetKey: string): Promise<RepairStop | { unreadable: string } | undefined> {
  const current = resetKey.trim();
  try {
    return await within(ctx, itemIndex, deps, async ({ store, staticData }) => {
      const fromStatic = persisted(staticData)[key];
      const fromStore = await store.getRepairStop(key);
      const records = [fromStore, fromStatic].filter((r): r is RepairStop => r !== undefined);
      if (records.length === 0) return undefined;
      const record = records.find((r) => r.resetKey.trim() === current);
      if (!record) {
        await store.deleteRepairStop(key);
        if (staticData && fromStatic) {
          const all = persisted(staticData);
          delete all[key];
          writeStatic(staticData, all);
        }
        return undefined;
      }
      if (!sameStop(fromStore, record)) await store.setRepairStop(key, record);
      if (staticData && !sameStop(fromStatic, record)) writeStatic(staticData, { ...persisted(staticData), [key]: record });
      return record;
    });
  } catch (error) {
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
}

/** The text a run held because the record could not be read ends with (the Redis message without its login words). */
export const repairUnchecked = (reason: string): string =>
  `AI Repair did not run: whether a repair of these steps already failed could not be checked (${reason.replace(/, so no login was tried\.?$/, '')})`;

/**
 * Whether this result is a failed repair to remember: the agent lane failed after at least one chat model call, or
 * delivered rows without proven steps (Deliver Unconfirmed Rows). Not a run that was cancelled (`cancelled`: a person or
 * n8n stopped the execution), not a login the site rejected or a locked account (the login breaker holds those), not a
 * configuration error.
 */
export function repairFailed(r: TaskResult, cancelled: boolean): boolean {
  if (cancelled || r.lane !== 'agent' || (r.llmCalls ?? 0) === 0) return false;
  if (r.ok) return r.proposal === undefined;
  return !r.configError && r.code !== 'login_failed' && r.code !== 'account_locked';
}

/**
 * Remembers a failed repair. Best effort: a store that cannot take it leaves static data (when it may be written) as the
 * record, and a run never fails because of it.
 */
export async function noteRepairFailed(ctx: NodeContext, itemIndex: number, deps: GuardStoreDeps, key: string, record: RepairStop): Promise<void> {
  try {
    await within(ctx, itemIndex, deps, async ({ store, staticData }) => {
      if (staticData) writeStatic(staticData, { ...persisted(staticData), [key]: record });
      await store.setRepairStop(key, record).catch(() => undefined);
    });
  } catch {
    // The store could not be opened (Redis down): nothing is remembered this time.
  }
}
