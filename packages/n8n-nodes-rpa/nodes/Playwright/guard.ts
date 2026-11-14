import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { readRecord } from './breaker-record.js';
import { resetMemoryGuardStoreForTests, sameRecord, type BreakerRecord, type GuardStore, type LoginFingerprint } from './guard-store.js';

/** The one key this node writes in global workflow static data. */
export const BREAKER_KEY = 'playwrightLoginBreakers';

export type { BreakerCode, BreakerRecord, Lock, LoginFingerprint } from './guard-store.js';

/**
 * Breaker and lock key of one account of an RPA Site Login credential: the credential id and a short SHA-256 of the
 * username (trimmed, lower case). A Site Login whose username is an expression signs in as a different account per
 * item, and each account gets its own breaker, lock and password-change block. The hash keeps the username out of
 * static data and Redis keys, but anyone who reads them can still test a guessed username.
 */
export function siteLoginKey(credentialId: string, username: string): string {
  const account = createHash('sha256').update(`${credentialId}\0${username.trim().toLowerCase()}`).digest('hex').slice(0, 16);
  return `site-login:${credentialId}:${account}`;
}

/** The key of version 0.2.0 and earlier, the credential id only: a breaker still kept under it stops every account. */
export function legacySiteLoginKey(credentialId: string): string {
  return `site-login:${credentialId}`;
}

function persisted(staticData: IDataObject): Record<string, BreakerRecord> {
  const all = staticData[BREAKER_KEY];
  const out: Record<string, BreakerRecord> = {};
  if (typeof all !== 'object' || all === null || Array.isArray(all)) return out;
  for (const [k, v] of Object.entries(all)) {
    const record = readRecord(v);
    if (record) out[k] = record;
  }
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
  // Not a record with a login fingerprint: a run gets past one only with a corrected login, whose failure replaces it.
  const record: BreakerRecord = existing && existing.resetKey.trim() === resetKey && !existing.login
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

/** The Site Login values a login fingerprint is made of. */
export type SiteLoginSecrets = { username: string; password: string; totpSecret?: string };

/** Fixed scrypt cost of a login fingerprint: about 32 MiB and some tens of milliseconds for each hash. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** Login fingerprints of one Site Login. The values stay in this closure; a fingerprint is never logged or output. */
export interface LoginFingerprints {
  /** A fingerprint with a new random salt, for the record of a login the site rejected. */
  create(): Promise<LoginFingerprint>;
  /** Whether `stored` is a fingerprint of this login (a constant-time comparison). */
  matches(stored: LoginFingerprint): Promise<boolean>;
}

/**
 * scrypt (salted, slow) of `username NUL password`, so that correcting either one gives a new fingerprint. With a TOTP
 * Secret the input is first HMAC-SHA256 keyed with it, so testing a guess against the stored value also needs that
 * secret. Each salt's hash is computed once per instance.
 */
export function loginFingerprints(secrets: SiteLoginSecrets): LoginFingerprints {
  const material = Buffer.from(`${secrets.username}\0${secrets.password}`, 'utf8');
  const input = secrets.totpSecret ? createHmac('sha256', secrets.totpSecret).update(material).digest() : material;
  const derive = (salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
    scrypt(input, salt, HASH_BYTES, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
  const bySalt = new Map<string, Promise<Buffer>>();
  return {
    async create() {
      const salt = randomBytes(SALT_BYTES);
      return { salt: salt.toString('base64'), hash: (await derive(salt)).toString('base64') };
    },
    async matches(stored) {
      let hash = bySalt.get(stored.salt);
      if (!hash) {
        hash = derive(Buffer.from(stored.salt, 'base64'));
        bySalt.set(stored.salt, hash);
      }
      const expected = Buffer.from(stored.hash, 'base64');
      const actual = await hash;
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}

/**
 * True when `record` stops a login_failed with a fingerprint that is not of the current login: the run is then let
 * through for one try. Never for an account_locked record, a record without a fingerprint or a guard without a login.
 * A fingerprint that cannot be computed counts as the same login (the breaker stays open).
 */
export async function loginCorrected(record: BreakerRecord, login: LoginFingerprints | undefined): Promise<boolean> {
  if (record.code !== 'login_failed' || !record.login || !login) return false;
  return !(await login.matches(record.login).catch(() => true));
}

export function resetGuardsForTests(): void {
  resetMemoryGuardStoreForTests();
}
