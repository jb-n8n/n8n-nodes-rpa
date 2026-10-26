import type { IDataObject } from 'n8n-workflow';
import { isRecord } from './breaker-record.js';
import { resetMemoryGuardStoreForTests, sameRecord, type BreakerRecord, type GuardStore } from './guard-store.js';

/** The one key this node writes in global workflow static data. */
export const BREAKER_KEY = 'playwrightLoginBreakers';

export type { BreakerCode, BreakerRecord, Lock } from './guard-store.js';

/** Breaker and lock key of an RPA Site Login credential: the credential id only. */
export function siteLoginKey(credentialId: string): string {
  return `site-login:${credentialId}`;
}

function persisted(staticData: IDataObject): Record<string, BreakerRecord> {
  const all = staticData[BREAKER_KEY];
  const out: Record<string, BreakerRecord> = {};
  if (typeof all !== 'object' || all === null || Array.isArray(all)) return out;
  for (const [k, v] of Object.entries(all)) if (isRecord(v)) out[k] = { code: v.code, at: v.at, resetKey: v.resetKey, message: v.message };
  return out;
}

/**
 * The open breaker for this key, or null. Keys are trimmed. Open when any known record (static data or this
 * process) matches the current key, or when the current key is empty (an empty key never resets anything).
 * A non-empty current key that matches no record is a deliberate reset: it clears them and lets the run proceed.
 * (Deliberately, another workflow on the same Site Login with a different non-empty key also resets.)
 * An open record known only to the store is written back to static data, unless the store is shared (Redis).
 */
export async function openBreaker(store: GuardStore, staticData: IDataObject, key: string, resetKey: string): Promise<BreakerRecord | null> {
  const current = resetKey.trim();
  const fromStatic = persisted(staticData)[key];
  const fromStore = await store.getBreaker(key);
  const records = [fromStatic, fromStore].filter((r): r is BreakerRecord => r !== undefined);
  if (records.length === 0) return null;
  const record = records.find((r) => r.resetKey.trim() === current) ?? (current === '' ? records[0] : undefined);
  if (!record) {
    await resetBreaker(store, staticData, key, fromStore ?? records[0]);
    return null;
  }
  if (!sameRecord(fromStore, record)) await store.setBreaker(key, record);
  // A store-only record (static data cleared, overwritten or never saved) is written back so the execution saves it.
  // Not with a shared store: it already holds the record for every worker, and the write would clobber static data.
  if (!store.shared && !sameRecord(fromStatic, record)) staticData[BREAKER_KEY] = { ...persisted(staticData), [key]: record };
  return record;
}

export async function tripBreaker(store: GuardStore, staticData: IDataObject, key: string, input: Omit<BreakerRecord, 'at'>, now: Date = new Date()): Promise<BreakerRecord> {
  const resetKey = input.resetKey.trim();
  // The caller records the trip in the execution map whatever happens here, and a store failure never undoes it: a
  // Redis outage must not turn a rejected login into a breaker that is open nowhere.
  const existing = persisted(staticData)[key] ?? await store.getBreaker(key).catch(() => undefined);
  // Re-tripping an open breaker (writing a process record back to static data) keeps the original time and message.
  const record: BreakerRecord = existing && existing.resetKey.trim() === resetKey
    ? { ...existing, resetKey }
    : { ...input, resetKey, at: now.toISOString() };
  // Always a new top-level object: n8n's ObservableObject only notices writes to the top level.
  const writeStatic = () => { staticData[BREAKER_KEY] = { ...persisted(staticData), [key]: record }; };
  if (store.shared) {
    // Static data only when the shared store could not take it (openBreaker writes it to the store on a later run).
    await store.setBreaker(key, record).catch(writeStatic);
    return record;
  }
  // The memory store: static data first, so the trip outlives a restart.
  writeStatic();
  await store.setBreaker(key, record).catch(() => undefined);
  return record;
}

/** Clears the breaker from static data and (when it still equals `expected`, default: the stored one) from the store. */
export async function resetBreaker(store: GuardStore, staticData: IDataObject, key: string, expected?: BreakerRecord): Promise<void> {
  const target = expected ?? await store.getBreaker(key);
  if (target) await store.deleteBreaker(key, target);
  const all = persisted(staticData);
  if (!(key in all)) return;
  delete all[key];
  staticData[BREAKER_KEY] = all;
}

export function resetGuardsForTests(): void {
  resetMemoryGuardStoreForTests();
}
