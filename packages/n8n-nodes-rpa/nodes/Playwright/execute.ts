import { NodeOperationError } from 'n8n-workflow';
import type { ErrorCode, TaskInput, TaskResult } from 'n8n-rpa-engine';
import type { SiteLogin } from './config.js';
import type { NodeContext } from './context.js';
import type { Engine } from './engine.js';
import { legacySiteLoginKey, loginCorrected, loginFingerprints, openBreaker, resetBreaker, siteLoginKey, tripBreaker, type BreakerCode, type BreakerRecord, type LoginFingerprints } from './guard.js';
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
  /**
   * Where an older version kept this Site Login's breaker (legacySiteLoginKey). A breaker still open there stops this
   * run too, and gets the same one try for a corrected login. Only read: trips, the lock and the execution's maps use `key`.
   */
  legacyKey?: string;
  resetKey: string;
  /** Where the breaker and the lock live. runOne closes it when the run ends. */
  store: GuardStore;
  /** How long the lock is held at most (run budget plus LOCK_GRACE_MS). */
  ttlMs: number;
  lockedOutMessage: (b: BreakerRecord) => string;
  busyMessage: string;
  /**
   * The Site Login's fingerprints. With them, a login_failed record whose fingerprint is not of the current login lets
   * one run try (a corrected username or password), and a login_failed record gets the fingerprint of the login.
   */
  fingerprints?: LoginFingerprints;
}

/** Golden `locked_out` message for a Site Login: the breaker is kept per account, so it says this account (the item's `account` names it). */
export const siteLoginLockedOut = (loginHost: string): string => `A previous login of this account on ${loginHost} failed, so no login was tried.`;
/**
 * Golden `locked_out` message for a Site Login whose password a run changed earlier in this execution: the credential
 * still holds the old one, so no later item or node of the execution signs in with it.
 */
export const SITE_LOGIN_PASSWORD_CHANGED =
  'The password of this account was changed earlier in this execution, so no login was tried: store the new password where the Site Login reads it, then run again.';
/** Golden `busy` message for a Site Login. */
export const SITE_LOGIN_BUSY = 'another run using this Site Login is in progress';
/**
 * What a guarded call did: turned away by the breaker, the lock or a password changed earlier in the execution (then
 * `passwordChanged`), or ran (and whether its login failure tripped the breaker).
 */
export type GuardedResult<T> =
  | { kind: 'blocked'; code: ErrorCode; message: string; passwordChanged?: true }
  | { kind: 'ran'; result: T; tripped: boolean };
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
 * Guard keys whose Site Login password a run changed in this execution (signIn.changePassword), in the same per-execution
 * context data: every later guarded call for the key in the execution is turned away before any login, since the
 * credential still holds the old password. The breaker is not touched. Gone when the execution ends.
 */
const CHANGED_IN_EXECUTION = 'playwrightPasswordsChanged';
function changedInExecution(ctx: NodeContext): Record<string, true> {
  const flow = ctx.getContext('flow');
  const current = flow[CHANGED_IN_EXECUTION];
  if (isObject(current)) return current as Record<string, true>;
  const fresh: Record<string, true> = {};
  flow[CHANGED_IN_EXECUTION] = fresh;
  return fresh;
}

/**
 * One engine run behind the login breaker and the run lock. Order: a password changed earlier in this execution
 * (locked_out with SITE_LOGIN_PASSWORD_CHANGED, no login, the breaker untouched; a run that changed the password never
 * trips the breaker) → breaker (locked_out; a breaker tripped earlier in
 * this execution stays open whatever the reset key or the login) → lock (busy) → breaker again (another worker may
 * have tripped it between the first check and the lock) → engine.runTask(input()) → trip the breaker on login_failed /
 * account_locked (the result's code, or an agent run's proof replay failureCode) → release the lock. The trip comes
 * before the release, so no other worker can take the lock and log in before the breaker is open. A login_failed
 * breaker with the fingerprint of another login lets the run through (both checks); when the run then trips nothing,
 * the breaker is cleared. Without `guard` there is no breaker and no lock. `input` is called only once the lock is
 * held. Throws NodeOperationError when runTask (or `input`) throws; the lock is released on every path.
 */
export async function runOne(
  ctx: NodeContext,
  engine: Engine,
  opts: { itemIndex: number; guard?: GuardSpec; input: () => TaskInput },
): Promise<RunOneResult> {
  return await runGuarded(ctx, {
    ...(opts.guard ? { guard: opts.guard } : {}),
    call: () => runTask(ctx, engine, opts),
    passwordChanged: (result) => result.passwordChanged === true,
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
export async function runGuarded<T>(ctx: NodeContext, opts: GuardedOptions<T>): Promise<GuardedResult<T>> {
  try {
    return await guardedCall(ctx, opts);
  } finally {
    // Once, after the last store use (breaker check, lock, release, trip) on every path. A close error never fails a run.
    if (opts.guard) await opts.guard.store.close().catch(() => undefined);
  }
}

interface GuardedOptions<T> {
  guard?: GuardSpec;
  call: () => Promise<T>;
  loginFailure: (result: T) => { code: BreakerCode; message: string } | undefined;
  /** Whether the call changed the Site Login's password (later calls for the key in this execution are then turned away). */
  passwordChanged?: (result: T) => boolean;
}

async function guardedCall<T>(ctx: NodeContext, opts: GuardedOptions<T>): Promise<GuardedResult<T>> {
  const { guard } = opts;
  if (!guard) return { kind: 'ran', result: await opts.call(), tripped: false };
  if (changedInExecution(ctx)[guard.key]) return { kind: 'blocked', code: 'locked_out', message: SITE_LOGIN_PASSWORD_CHANGED, passwordChanged: true };
  const staticData = ctx.getWorkflowStaticData('global');
  /** The breaker that turns this call away, or the ones a corrected login gets past (`passed`: this key's, the legacy key's). */
  const breaker = async (): Promise<{ open: BreakerRecord } | { passed: { key: string; record: BreakerRecord }[] }> => {
    const tripped = trippedInExecution(ctx)[guard.key];
    if (tripped) return { open: tripped };
    const passed: { key: string; record: BreakerRecord }[] = [];
    for (const key of guard.legacyKey ? [guard.key, guard.legacyKey] : [guard.key]) {
      const record = await openBreaker(guard.store, staticData, key, guard.resetKey);
      if (!record) continue;
      if (!(await loginCorrected(record, guard.fingerprints))) return { open: record };
      passed.push({ key, record });
    }
    return { passed };
  };
  const lockedOut = (b: BreakerRecord): GuardedResult<T> => ({ kind: 'blocked', code: 'locked_out', message: guard.lockedOutMessage(b) });

  const before = await breaker();
  if ('open' in before) return lockedOut(before.open);
  const lock = await guard.store.acquireLock(guard.key, guard.ttlMs);
  if (!lock) return { kind: 'blocked', code: 'busy', message: guard.busyMessage };
  try {
    // Under the lock, so two workers with the same corrected login cannot both take its one try.
    const after = await breaker();
    if ('open' in after) return lockedOut(after.open);
    const result = await opts.call();
    // A run that changed the password signed in with the stored one: a later login failure in it says nothing about the
    // credential, so it does not open the breaker (the in-execution block stops later items).
    const changedNow = opts.passwordChanged?.(result) === true;
    if (changedNow) changedInExecution(ctx)[guard.key] = true;
    const login = changedNow ? undefined : opts.loginFailure(result);
    if (!login) {
      // The corrected login was not rejected: clear the breaker it got past. A failed clear only means the next run
      // compares the login again.
      for (const p of after.passed) await resetBreaker(guard.store, staticData, p.key, p.record).catch(() => undefined);
      return { kind: 'ran', result, tripped: false };
    }
    // Without a fingerprint (none could be computed) the record opens only with a new reset key.
    const fingerprint = login.code === 'login_failed' ? await guard.fingerprints?.create().catch(() => undefined) : undefined;
    const record = await tripBreaker(guard.store, staticData, guard.key, {
      code: login.code, resetKey: guard.resetKey, message: login.message, ...(fingerprint ? { login: fingerprint } : {}),
    });
    // The execution's copy only blocks, and n8n saves it with the execution: it does not need the fingerprint.
    trippedInExecution(ctx)[guard.key] = { code: record.code, at: record.at, resetKey: record.resetKey, message: record.message };
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

/**
 * One repair per execution. The flag lives in n8n's per-execution context data ('flow'), so it
 * covers every item, a node that runs again in the same execution (Loop Over Items) and every Run Steps node of the
 * workflow, and it is gone when the execution ends.
 */
const REPAIR_RAN = 'playwrightRepairRan';
export const repairAlreadyRan = (ctx: NodeContext): boolean => ctx.getContext('flow')[REPAIR_RAN] === true;
export function noteRepairRan(ctx: NodeContext): void {
  ctx.getContext('flow')[REPAIR_RAN] = true;
}

/**
 * Breaker and lock for one account of a Site Login: keyed by its credential id and username (siteLoginKey), so that
 * with an expression username one account's failure never stops another; golden messages naming only the login host,
 * and the login's fingerprints (a corrected username or password gets one try). The lock lasts `budgetMs` (the
 * longest the guarded run can take) plus LOCK_GRACE_MS.
 */
export function siteLoginGuard(siteLogin: SiteLogin, id: string, resetKey: string, budgetMs: number): (store: GuardStore) => GuardSpec {
  const loginHost = new URL(siteLogin.policy.startUrl).host;
  return (store) => ({
    key: siteLoginKey(id, siteLogin.secrets.username), legacyKey: legacySiteLoginKey(id), resetKey, store, ttlMs: budgetMs + LOCK_GRACE_MS,
    lockedOutMessage: () => siteLoginLockedOut(loginHost), busyMessage: SITE_LOGIN_BUSY, fingerprints: loginFingerprints(siteLogin.secrets),
  });
}
