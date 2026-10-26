import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigError, CREDENTIALS } from './config.js';
import type { NodeContext } from './context.js';
import { redisGuardStore } from './redis-store.js';

export type BreakerCode = 'login_failed' | 'account_locked';
export type BreakerRecord = { code: BreakerCode; at: string; resetKey: string; message: string };
export type Lock = { token: string; expiresAt: number };

/** Field-by-field equality of two breaker records. */
export function sameRecord(a: BreakerRecord | undefined, b: BreakerRecord | undefined): boolean {
  return a !== undefined && b !== undefined && a.code === b.code && a.at === b.at && a.resetKey === b.resetKey && a.message === b.message;
}

/** Where the login breaker and the run lock live. */
export interface GuardStore {
  /**
   * True when every n8n process sees the same store (Redis). Then the breaker is not written to workflow static data
   * except as a fallback when the store write fails: a queue-mode worker saves static data whole, from a copy that
   * starts empty, so writing it would overwrite other nodes' static data.
   */
  readonly shared: boolean;
  getBreaker(key: string): Promise<BreakerRecord | undefined>;
  setBreaker(key: string, record: BreakerRecord): Promise<void>;
  /** Deletes only if the stored record still equals `expected` (field by field). */
  deleteBreaker(key: string, expected: BreakerRecord): Promise<void>;
  /** Null when another holder has an unexpired lock. */
  acquireLock(key: string, ttlMs: number): Promise<Lock | null>;
  /** Releases only if `lock.token` still holds it. */
  releaseLock(key: string, lock: Lock): Promise<void>;
  close(): Promise<void>;
}

// Process-wide state. Static data is a per-execution copy that n8n saves only when a non-manual execution
// ends, so it cannot serialize overlapping executions (locks) and is not saved for manual runs (breakers).
const breakers = new Map<string, BreakerRecord>();
const locks = new Map<string, Lock>();

const memoryStore: GuardStore = {
  shared: false,
  async getBreaker(key) {
    return breakers.get(key);
  },
  async setBreaker(key, record) {
    breakers.set(key, record);
  },
  async deleteBreaker(key, expected) {
    if (sameRecord(breakers.get(key), expected)) breakers.delete(key);
  },
  async acquireLock(key, ttlMs) {
    const now = performance.now();
    const held = locks.get(key);
    if (held && held.expiresAt > now) return null;
    const lock: Lock = { token: randomUUID(), expiresAt: now + ttlMs };
    locks.set(key, lock);
    return lock;
  },
  async releaseLock(key, lock) {
    if (locks.get(key)?.token === lock.token) locks.delete(key);
  },
  async close() {},
};

/** The one process-wide in-memory store; close() is a no-op. */
export function memoryGuardStore(): GuardStore {
  return memoryStore;
}

export function resetMemoryGuardStoreForTests(): void {
  breakers.clear();
  locks.clear();
}

export const QUEUE_NEEDS_REDIS =
  'n8n runs in queue mode, so Run Steps and Import Steps with an RPA Site Login need an RPA Redis credential: without it the login breaker and run lock would not be shared between workers. Attach an RPA Redis credential (the Redis that n8n\'s queue uses works).';

/** Test seams for where the guard store comes from: the Redis factory and how n8n's execution mode is read. */
export type GuardStoreDeps = {
  redis?: typeof redisGuardStore;
  /** Default: process.env.EXECUTIONS_MODE. */
  executionsMode?: string | undefined;
  /** Default: process.argv (n8n's `worker` command forces queue mode in its own config). */
  argv?: readonly string[];
  /** Default: process.env.EXECUTIONS_MODE_FILE (n8n reads the mode from this file when it is set). */
  executionsModeFile?: string | undefined;
  readFile?: (path: string) => string;
};

/**
 * True when this n8n process runs in queue mode: EXECUTIONS_MODE=queue, the `worker` command, or an
 * EXECUTIONS_MODE_FILE that says queue. A mode file that cannot be read counts as queue mode (fail closed).
 */
export function isQueueMode(deps: GuardStoreDeps = {}): boolean {
  const mode = 'executionsMode' in deps ? deps.executionsMode : process.env.EXECUTIONS_MODE;
  if (mode?.trim() === 'queue') return true;
  const argv = 'argv' in deps ? deps.argv : process.argv;
  if (argv?.[2] === 'worker') return true;
  const file = 'executionsModeFile' in deps ? deps.executionsModeFile : process.env.EXECUTIONS_MODE_FILE;
  if (!file) return false;
  try {
    return (deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')))(file).trim() === 'queue';
  } catch {
    return true;
  }
}

/**
 * The store for one Run Steps item: Redis when an RPA Redis credential is attached, else the in-process store, except
 * in queue mode where that would not be shared between workers (a ConfigError). The caller closes it.
 */
export async function openGuardStore(ctx: NodeContext, itemIndex: number, deps: GuardStoreDeps = {}): Promise<GuardStore> {
  if (ctx.getNode().credentials?.[CREDENTIALS.redis]) {
    return await (deps.redis ?? redisGuardStore)(await ctx.getCredentials(CREDENTIALS.redis, itemIndex));
  }
  if (isQueueMode(deps)) throw new ConfigError(QUEUE_NEEDS_REDIS);
  return memoryGuardStore();
}
