import { NodeOperationError } from 'n8n-workflow';
import type { ErrorCode, TaskInput, TaskResult } from 'n8n-rpa-engine';
import type { NodeContext } from './context.js';
import type { Engine } from './engine.js';
import { openBreaker, tripBreaker, type BreakerCode, type BreakerRecord } from './guard.js';
import type { GuardStore } from './guard-store.js';
import { isObject } from './operations/common.js';

/** The lock outlives the run budget by this much, in case a release is ever missed. */
export const LOCK_GRACE_MS = 60_000;

/**
 * The login breaker and run lock of a run that can type credentials: `key` names both. Run Steps writes the two
 * messages, so a blocked run never names anything but the Site Login's host.
 */
export interface GuardSpec {
  key: string;
  resetKey: string;
  /** Where the breaker and the lock live. runOne closes it when the run ends. */
  store: GuardStore;
  /** How long the lock is held at most (run budget plus LOCK_GRACE_MS). */
  ttlMs: number;
  lockedOutMessage: (b: BreakerRecord) => string;
  busyMessage: string;
}

/** Golden `locked_out` message for a Site Login. */
export const siteLoginLockedOut = (loginHost: string): string => `A previous login for ${loginHost} failed, so no login was tried.`;
/** Golden `busy` message for a Site Login. */
export const SITE_LOGIN_BUSY = 'another run using this Site Login is in progress';
/** What a guarded call did: turned away by the breaker or the lock, or ran (and whether its login failure tripped the breaker). */
export type GuardedResult<T> = { kind: 'blocked'; code: ErrorCode; message: string } | { kind: 'ran'; result: T; tripped: boolean };
export type RunOneResult = GuardedResult<TaskResult>;

export const isBreakerCode = (code: ErrorCode | undefined): code is BreakerCode => code === 'login_failed' || code === 'account_locked';

/**
 * Breakers tripped in this execution, by guard key, in n8n's per-execution context data ('flow'): shared by every item
 * and every node of the execution, gone when it ends. A breaker tripped here stays open for the rest of the execution
 * whatever reset key a later item or node carries; only a later execution can reset it.
 */
const TRIPPED_IN_EXECUTION = 'playwrightBreakersTripped';
function trippedInExecution(ctx: NodeContext): Record<string, BreakerRecord> {
  const flow = ctx.getContext('flow');
  const current = flow[TRIPPED_IN_EXECUTION];
  if (isObject(current)) return current as Record<string, BreakerRecord>;
  const fresh: Record<string, BreakerRecord> = {};
  flow[TRIPPED_IN_EXECUTION] = fresh;
  return fresh;
}

/**
 * One engine run behind the login breaker and the run lock. Order: breaker (locked_out; a breaker tripped earlier in
 * this execution stays open whatever the reset key) → lock (busy) → breaker again (another worker may have tripped it
 * between the first check and the lock) → engine.runTask(input()) → trip the breaker on login_failed / account_locked
 * (the result's code, or an agent run's proof replay failureCode) → release the lock. The trip comes before the
 * release, so no other worker can take the lock and log in before the breaker is open. Without `guard` there is no
 * breaker and no lock. `input` is called only once the lock is held. Throws NodeOperationError when runTask (or
 * `input`) throws; the lock is released on every path.
 */
export async function runOne(
  ctx: NodeContext,
  engine: Engine,
  opts: { itemIndex: number; guard?: GuardSpec; input: () => TaskInput },
): Promise<RunOneResult> {
  return await runGuarded(ctx, {
    ...(opts.guard ? { guard: opts.guard } : {}),
    call: () => runTask(ctx, engine, opts),
    loginFailure: (result) => {
      // A rejected or locked login trips the breaker, whether the script lane hit it or the agent lane's full replay did.
      const replay = result.ok && result.lane === 'agent' ? result.prove : undefined;
      const code = result.ok ? replay?.failureCode : result.code;
      if (!isBreakerCode(code)) return undefined;
      return { code, message: result.ok ? `the proof replay failed: ${replay?.reasons.join('; ') || code}` : result.message };
    },
  });
}

/**
 * Any call that can type a Site Login's password, behind the login breaker and the run lock, in runOne's order:
 * breaker → lock → breaker again → `call` → trip the breaker when `loginFailure` names a login_failed / account_locked
 * → release the lock. Import Steps' adoptions use it directly. The guard's store is closed once, on every path.
 */
export async function runGuarded<T>(
  ctx: NodeContext,
  opts: { guard?: GuardSpec; call: () => Promise<T>; loginFailure: (result: T) => { code: BreakerCode; message: string } | undefined },
): Promise<GuardedResult<T>> {
  try {
    return await guardedCall(ctx, opts);
  } finally {
    // Once, after the last store use (breaker check, lock, release, trip) on every path. A close error never fails a run.
    if (opts.guard) await opts.guard.store.close().catch(() => undefined);
  }
}

async function guardedCall<T>(
  ctx: NodeContext,
  opts: { guard?: GuardSpec; call: () => Promise<T>; loginFailure: (result: T) => { code: BreakerCode; message: string } | undefined },
): Promise<GuardedResult<T>> {
  const { guard } = opts;
  if (!guard) return { kind: 'ran', result: await opts.call(), tripped: false };
  const staticData = ctx.getWorkflowStaticData('global');
  const lockedOut = async (): Promise<GuardedResult<T> | undefined> => {
    const breaker = trippedInExecution(ctx)[guard.key] ?? await openBreaker(guard.store, staticData, guard.key, guard.resetKey);
    return breaker ? { kind: 'blocked', code: 'locked_out', message: guard.lockedOutMessage(breaker) } : undefined;
  };

  const before = await lockedOut();
  if (before) return before;
  const lock = await guard.store.acquireLock(guard.key, guard.ttlMs);
  if (!lock) return { kind: 'blocked', code: 'busy', message: guard.busyMessage };
  try {
    const after = await lockedOut();
    if (after) return after;
    const result = await opts.call();
    const login = opts.loginFailure(result);
    if (!login) return { kind: 'ran', result, tripped: false };
    trippedInExecution(ctx)[guard.key] = await tripBreaker(guard.store, staticData, guard.key, { code: login.code, resetKey: guard.resetKey, message: login.message });
    return { kind: 'ran', result, tripped: true };
  } finally {
    // A release error never replaces the run's result or error: the lock's TTL frees it.
    await guard.store.releaseLock(guard.key, lock).catch(() => undefined);
  }
}

async function runTask(ctx: NodeContext, engine: Engine, opts: { itemIndex: number; input: () => TaskInput }): Promise<TaskResult> {
  try {
    return await engine.runTask(opts.input());
  } catch (error) {
    throw new NodeOperationError(ctx.getNode(), error as Error, { itemIndex: opts.itemIndex });
  }
}
