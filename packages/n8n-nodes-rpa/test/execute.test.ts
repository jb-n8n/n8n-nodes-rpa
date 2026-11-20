import { createHash, createHmac, scrypt } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeOperationError, type IDataObject } from 'n8n-workflow';
import type { ErrorCode, TaskInput, TaskResult } from 'n8n-rpa-engine';
import { LOCK_GRACE_MS, runOne, type GuardSpec } from '../nodes/Playwright/execute.js';
import { BREAKER_KEY, loginFingerprints, openBreaker, resetGuardsForTests, tripBreaker, type SiteLoginSecrets } from '../nodes/Playwright/guard.js';
import { memoryGuardStore, type GuardStore } from '../nodes/Playwright/guard-store.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';

afterEach(() => resetGuardsForTests());

const GUARD: GuardSpec = {
  key: 'cred-1:demo-sandbox', resetKey: '', store: memoryGuardStore(), ttlMs: 60_000 + LOCK_GRACE_MS,
  lockedOutMessage: (b) => `locked out since ${b.at} (${b.code})`, busyMessage: 'another run is in progress',
};
// runOne passes the input through untouched, so an opaque marker stands in for a full TaskInput.
const INPUT = { marker: 'task-input' } as unknown as TaskInput;
// runOne reads only ok, lane, code, message and prove: partial results keep this test independent of the result shape.
const SCRIPT_OK = { ok: true, lane: 'script', rows: [], log: [], violations: [], durationMs: 1 } as unknown as TaskResult;
const failed = (code: ErrorCode, message = `${code} happened`) =>
  ({ ok: false, code, message, lane: 'script', violations: [], log: [], durationMs: 1 }) as unknown as TaskResult;
const replayFailed = (failureCode: ErrorCode) => ({
  ok: true, lane: 'agent', rows: [], confirmed: false, agentLog: [], log: [], violations: [], tokens: 0, llmCalls: 1, durationMs: 1, note: '', transcript: [],
  prove: { ok: false, total: null, reasons: ['Check sign-in worked: detected login_failed'], diff: { missing: [], extra: [] }, failureCode },
}) as unknown as TaskResult;

describe('runOne', () => {
  it('breaker open: locked_out with the guard message; input and the engine are not reached', async () => {
    const h = harness({ params: {} });
    await tripBreaker(memoryGuardStore(), h.staticData, GUARD.key, { code: 'login_failed', resetKey: '', message: 'rejected' }, new Date('2026-10-06T00:00:00Z'));
    const engine = fakeEngine(() => SCRIPT_OK);
    let inputs = 0;
    const r = await runOne(h, engine, { itemIndex: 0, guard: GUARD, input: () => { inputs++; return INPUT; } });
    expect(r).toEqual({ kind: 'blocked', code: 'locked_out', message: 'locked out since 2026-10-06T00:00:00.000Z (login_failed)' });
    expect(inputs).toBe(0);
    expect(engine.calls).toHaveLength(0);
  });
  it('lock held: busy with the guard message, and nothing reaches the engine', async () => {
    const held = await memoryGuardStore().acquireLock(GUARD.key, 60_000);
    if (!held) throw new Error('expected the lock');
    const engine = fakeEngine(() => SCRIPT_OK);
    let inputs = 0;
    const r = await runOne(harness({ params: {} }), engine, { itemIndex: 0, guard: GUARD, input: () => { inputs++; return INPUT; } });
    expect(r).toEqual({ kind: 'blocked', code: 'busy', message: 'another run is in progress' });
    expect(inputs).toBe(0);
    expect(engine.calls).toHaveLength(0);
    await memoryGuardStore().releaseLock(GUARD.key, held);
  });
  it('input runs only once the lock is held, and its value reaches the engine unchanged', async () => {
    const engine = fakeEngine(() => SCRIPT_OK);
    let probe: Promise<unknown> = Promise.resolve(undefined);
    const r = await runOne(harness({ params: {} }), engine, {
      itemIndex: 0, guard: GUARD, input: () => { probe = memoryGuardStore().acquireLock(GUARD.key, 1); return INPUT; },
    });
    expect(await probe).toBeNull(); // the lock was held while input ran
    expect(engine.calls[0]).toBe(INPUT);
    expect(r).toEqual({ kind: 'ran', result: SCRIPT_OK, tripped: false });
    expect(await memoryGuardStore().acquireLock(GUARD.key, 1000)).not.toBeNull();
  });
  it('a login_failed result trips the breaker under the guard key, reports tripped and releases the lock', async () => {
    const h = harness({ params: {} });
    const r = await runOne(h, fakeEngine(() => failed('login_failed', 'Check sign-in worked: detected login_failed')), { itemIndex: 0, guard: GUARD, input: () => INPUT });
    expect(r).toMatchObject({ kind: 'ran', tripped: true });
    expect(Object.keys(h.staticData[BREAKER_KEY] as IDataObject)).toEqual([GUARD.key]);
    expect(await openBreaker(memoryGuardStore(), h.staticData, GUARD.key, '')).toMatchObject({ code: 'login_failed', message: 'Check sign-in worked: detected login_failed' });
    expect(await memoryGuardStore().acquireLock(GUARD.key, 1000)).not.toBeNull();
  });
  it('an agent run whose proof replay hit account_locked trips it too; other failures never do', async () => {
    const h = harness({ params: {} });
    const r = await runOne(h, fakeEngine(() => replayFailed('account_locked')), { itemIndex: 0, guard: GUARD, input: () => INPUT });
    expect(r).toMatchObject({ kind: 'ran', tripped: true });
    expect(await openBreaker(memoryGuardStore(), h.staticData, GUARD.key, '')).toMatchObject({ code: 'account_locked', message: 'the proof replay failed: Check sign-in worked: detected login_failed' });
    resetGuardsForTests();
    const clean = harness({ params: {} });
    for (const result of [failed('auth_blocked'), failed('drift_detected'), replayFailed('drift_detected')]) {
      expect(await runOne(clean, fakeEngine(() => result), { itemIndex: 0, guard: GUARD, input: () => INPUT })).toMatchObject({ kind: 'ran', tripped: false });
    }
    expect(clean.staticData).toEqual({});
  });
  it('an engine throw becomes a NodeOperationError and the lock is released', async () => {
    const engine = fakeEngine(() => { throw new Error('engine exploded'); });
    const err = await runOne(harness({ params: {} }), engine, { itemIndex: 0, guard: GUARD, input: () => INPUT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as NodeOperationError).message).toMatch(/engine exploded/);
    expect(await memoryGuardStore().acquireLock(GUARD.key, 1000)).not.toBeNull();
  });
  it('without a guard there is no breaker and no lock: a held lock does not block, and a login failure trips nothing', async () => {
    const held = await memoryGuardStore().acquireLock(GUARD.key, 60_000);
    const h = harness({ params: {} });
    const r = await runOne(h, fakeEngine(() => failed('login_failed')), { itemIndex: 0, input: () => INPUT });
    expect(r).toMatchObject({ kind: 'ran', tripped: false });
    expect(h.staticData).toEqual({});
    if (held) await memoryGuardStore().releaseLock(GUARD.key, held);
  });
  it('release failure keeps the run result', async () => {
    const store: GuardStore = { ...memoryGuardStore(), releaseLock: () => Promise.reject(new Error('redis down')) };
    const r = await runOne(harness({ params: {} }), fakeEngine(() => SCRIPT_OK), { itemIndex: 0, guard: { ...GUARD, store }, input: () => INPUT });
    expect(r).toEqual({ kind: 'ran', result: SCRIPT_OK, tripped: false });
  });
  it('release failure keeps the engine error', async () => {
    const store: GuardStore = { ...memoryGuardStore(), releaseLock: () => Promise.reject(new Error('redis down')) };
    const err = await runOne(harness({ params: {} }), fakeEngine(() => { throw new Error('engine boom'); }), { itemIndex: 0, guard: { ...GUARD, store }, input: () => INPUT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as Error).message).toContain('engine boom');
  });
  it.each(['setBreaker', 'getBreaker'] as const)('a store whose %s rejects during the trip keeps the run result and the breaker in the execution and static data', async (method) => {
    let ranTask = false; // the store works until the run is over, so the breaker check and the lock pass
    const store: GuardStore = { ...memoryGuardStore(), [method]: (...a: unknown[]) => (ranTask ? Promise.reject(new Error('redis down')) : (memoryGuardStore()[method] as (...x: unknown[]) => Promise<unknown>)(...a)) } as GuardStore;
    const guard = { ...GUARD, store };
    const h = harness({ params: {} });
    const failure = failed('login_failed');
    const r = await runOne(h, fakeEngine(() => { ranTask = true; return failure; }), { itemIndex: 0, guard, input: () => INPUT });
    expect(r).toEqual({ kind: 'ran', result: failure, tripped: true });
    expect((h.staticData[BREAKER_KEY] as Record<string, unknown>)[GUARD.key]).toMatchObject({ code: 'login_failed', resetKey: GUARD.resetKey });
    // the same execution: blocked from the execution map without asking the store
    const again = await runOne(h, fakeEngine(() => SCRIPT_OK), { itemIndex: 0, guard: { ...guard, store: { ...memoryGuardStore() } }, input: () => INPUT });
    expect(again).toMatchObject({ kind: 'blocked', code: 'locked_out' });
    // a later execution reads it back from static data
    expect(await openBreaker(memoryGuardStore(), h.staticData, GUARD.key, GUARD.resetKey)).toMatchObject({ code: 'login_failed' });
  });
  it('closes the store exactly once on locked_out, busy and ran paths, after tripBreaker', async () => {
    const events: string[] = [];
    const base = memoryGuardStore();
    const store: GuardStore = {
      ...base,
      setBreaker: (k, rec) => { events.push('setBreaker'); return base.setBreaker(k, rec); },
      close: () => { events.push('close'); return Promise.resolve(); },
    };
    const guard = { ...GUARD, store };
    const run = (h = harness({ params: {} }), code?: ErrorCode) =>
      runOne(h, fakeEngine(() => (code ? failed(code) : SCRIPT_OK)), { itemIndex: 0, guard, input: () => INPUT });

    // ran (and tripped): the trip writes to the store before it is closed
    expect(await run(undefined, 'login_failed')).toMatchObject({ kind: 'ran', tripped: true });
    expect(events).toEqual(['setBreaker', 'close']);
    // locked_out
    events.length = 0;
    expect(await run()).toMatchObject({ kind: 'blocked', code: 'locked_out' });
    expect(events).toEqual(['close']);
    // busy
    resetGuardsForTests();
    events.length = 0;
    const held = await base.acquireLock(GUARD.key, 60_000);
    expect(await run()).toMatchObject({ kind: 'blocked', code: 'busy' });
    expect(events).toEqual(['close']);
    await base.releaseLock(GUARD.key, held!);
    // plain ran
    events.length = 0;
    expect(await run()).toMatchObject({ kind: 'ran', tripped: false });
    expect(events).toEqual(['close']);
  });
  it('a shared (Redis) store: a locked_out run and a tripping run leave static data untouched (queue workers save it whole)', async () => {
    const shared: GuardStore = { ...memoryGuardStore(), shared: true };
    const guard = { ...GUARD, store: shared };
    // tripping run: the breaker lands in the store and the execution, not in static data
    const h = harness({ params: {} });
    const r = await runOne(h, fakeEngine(() => failed('login_failed')), { itemIndex: 0, guard, input: () => INPUT });
    expect(r).toMatchObject({ kind: 'ran', tripped: true });
    expect(h.staticData).toEqual({});
    expect(await shared.getBreaker(GUARD.key)).toMatchObject({ code: 'login_failed' });
    // a later execution (fresh static data) is locked out by the store and still writes nothing back
    const later = harness({ params: {} });
    expect(await runOne(later, fakeEngine(() => SCRIPT_OK), { itemIndex: 0, guard, input: () => INPUT })).toMatchObject({ kind: 'blocked', code: 'locked_out' });
    expect(later.staticData).toEqual({});
  });
  it('a shared store whose setBreaker rejects during the trip still writes the trip to static data', async () => {
    let ranTask = false;
    const base = memoryGuardStore();
    const shared: GuardStore = { ...base, shared: true, setBreaker: (k, rec) => (ranTask ? Promise.reject(new Error('redis down')) : base.setBreaker(k, rec)) };
    const h = harness({ params: {} });
    const r = await runOne(h, fakeEngine(() => { ranTask = true; return failed('login_failed'); }), { itemIndex: 0, guard: { ...GUARD, store: shared }, input: () => INPUT });
    expect(r).toMatchObject({ kind: 'ran', tripped: true });
    expect((h.staticData[BREAKER_KEY] as Record<string, unknown>)[GUARD.key]).toMatchObject({ code: 'login_failed' });
  });
  it('trips the breaker before it releases the lock, so no other worker can log in between', async () => {
    const events: string[] = [];
    const base = memoryGuardStore();
    const store: GuardStore = {
      ...base,
      setBreaker: (k, rec) => { events.push('setBreaker'); return base.setBreaker(k, rec); },
      releaseLock: (k, l) => { events.push('releaseLock'); return base.releaseLock(k, l); },
    };
    await runOne(harness({ params: {} }), fakeEngine(() => failed('login_failed')), { itemIndex: 0, guard: { ...GUARD, store }, input: () => INPUT });
    expect(events).toEqual(['setBreaker', 'releaseLock']);
  });
  it('a breaker tripped by another worker while this run took the lock blocks it: locked_out, no login, the lock released', async () => {
    const base = memoryGuardStore();
    const rec = { code: 'login_failed' as const, at: '2026-10-20T00:00:00.000Z', resetKey: '', message: 'rejected elsewhere' };
    const store: GuardStore = {
      ...base,
      shared: true,
      // the other worker trips the breaker after this run's first check, just before it takes the lock
      acquireLock: async (k, ttl) => { await base.setBreaker(k, rec); return base.acquireLock(k, ttl); },
    };
    const engine = fakeEngine(() => SCRIPT_OK);
    let inputs = 0;
    const r = await runOne(harness({ params: {} }), engine, { itemIndex: 0, guard: { ...GUARD, store }, input: () => { inputs++; return INPUT; } });
    expect(r).toEqual({ kind: 'blocked', code: 'locked_out', message: 'locked out since 2026-10-20T00:00:00.000Z (login_failed)' });
    expect(inputs).toBe(0);
    expect(engine.calls).toHaveLength(0);
    expect(await base.acquireLock(GUARD.key, 1000)).not.toBeNull(); // released
  });
  it('the lock grace period is one minute', () => {
    expect(LOCK_GRACE_MS).toBe(60_000);
  });
});

// The breaker's tests on both stores (same login, another login, two runs at once) are in guard-store.contract.ts.
describe('a corrected login after login_failed', () => {
  const LOGIN: SiteLoginSecrets = { username: 'dealer-7', password: 'first-pass-1' };
  const withLogin = (login: SiteLoginSecrets, resetKey = ''): GuardSpec => ({ ...GUARD, resetKey, fingerprints: loginFingerprints(login) });
  /** One run in a new execution; the engine answers `result`. */
  const run = async (guard: GuardSpec, result: TaskResult = SCRIPT_OK, h = harness({ params: {} })) => {
    const engine = fakeEngine(() => result);
    return { r: await runOne(h, engine, { itemIndex: 0, guard, input: () => INPUT }), logins: engine.calls.length, h };
  };
  const record = async () => memoryGuardStore().getBreaker(GUARD.key);
  const derive = (material: Buffer | string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
    scrypt(material, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key)));
  });

  it('correcting only the username also gives one try', async () => {
    const { h } = await run(withLogin(LOGIN), failed('login_failed'));
    const corrected = withLogin({ ...LOGIN, username: 'dealer-8' });
    // The execution that tripped the breaker stays blocked whatever the credential.
    expect(await run(corrected, SCRIPT_OK, h)).toMatchObject({ r: { kind: 'blocked', code: 'locked_out' }, logins: 0 });
    // A later execution tries once; the login is accepted, so the record is cleared.
    const later = await run(corrected);
    expect(later).toMatchObject({ r: { kind: 'ran', tripped: false }, logins: 1 });
    expect(await record()).toBeUndefined();
    expect(later.h.staticData[BREAKER_KEY]).toEqual({});
  });
  it('changing only the TOTP Secret gives one try', async () => {
    // The fingerprint is keyed with the TOTP Secret, so adding, replacing or removing it counts as a changed login.
    const withSeed = { ...LOGIN, totpSecret: 'JBSWY3DPEHPK3PXP' };
    for (const [before, after] of [[withSeed, { ...LOGIN, totpSecret: 'KRSXG5CTMVRXEZLU' }], [withSeed, LOGIN], [LOGIN, withSeed]] as const) {
      resetGuardsForTests();
      await run(withLogin(before), failed('login_failed'));
      expect(await run(withLogin(before))).toMatchObject({ r: { kind: 'blocked', code: 'locked_out' }, logins: 0 });
      expect(await run(withLogin(after))).toMatchObject({ r: { kind: 'ran', tripped: false }, logins: 1 });
    }
  });
  it('a record from before this change stays locked_out until the reset key changes', async () => {
    await tripBreaker(memoryGuardStore(), {}, GUARD.key, { code: 'login_failed', resetKey: '', message: 'rejected' });
    expect(await run(withLogin({ ...LOGIN, password: 'second-pass-2' }))).toMatchObject({ r: { kind: 'blocked', code: 'locked_out' }, logins: 0 });
    expect(await run(withLogin({ ...LOGIN, password: 'second-pass-2' }, '2026-11-10'))).toMatchObject({ r: { kind: 'ran' }, logins: 1 });
  });
  it('an account_locked record is not opened by a new password', async () => {
    await run(withLogin(LOGIN), failed('login_failed'));
    // The corrected login's one try finds the account locked: that record replaces the login_failed one.
    expect(await run(withLogin({ ...LOGIN, password: 'second-pass-2' }), failed('account_locked'))).toMatchObject({ r: { kind: 'ran', tripped: true }, logins: 1 });
    expect(await record()).toMatchObject({ code: 'account_locked' });
    expect((await record())?.login).toBeUndefined();
    expect(await run(withLogin({ ...LOGIN, password: 'third-pass-3' }))).toMatchObject({ r: { kind: 'blocked', code: 'locked_out' }, logins: 0 });
  });
  it("the record's login field holds a salt and a hash, and no text of the username or password", async () => {
    const { h } = await run(withLogin(LOGIN), failed('login_failed'));
    const login = (await record())?.login;
    const salt = Buffer.from(login?.salt ?? '', 'base64');
    expect(salt).toHaveLength(16);
    expect(Buffer.from(login?.hash ?? '', 'base64')).toHaveLength(32);
    // scrypt of `username NUL password` with the record's own salt (the Site Login has no TOTP Secret).
    expect((await derive(`${LOGIN.username}\0${LOGIN.password}`, salt)).toString('base64')).toBe(login?.hash);
    const saved = JSON.stringify(h.staticData);
    expect(saved).toContain(login?.hash);
    for (const text of [LOGIN.username, LOGIN.password]) expect(saved).not.toContain(text);
    // The execution's own copy of the breaker (saved with the execution) has no fingerprint.
    expect(JSON.stringify(h.getContext('flow'))).not.toContain(login?.salt);
  });
  it('the record holds no password and no unsalted or unkeyed hash of it', async () => {
    const totp = { ...LOGIN, totpSecret: 'JBSWY3DPEHPK3PXP' };
    const { h } = await run(withLogin(totp), failed('login_failed'));
    const saved = JSON.stringify(h.staticData);
    const login = (await record())?.login;
    const salt = Buffer.from(login?.salt ?? '', 'base64');
    const material = `${LOGIN.username}\0${LOGIN.password}`;
    for (const text of [LOGIN.password, LOGIN.username, totp.totpSecret]) expect(saved).not.toContain(text);
    for (const value of [LOGIN.password, material]) {
      for (const algorithm of ['md5', 'sha1', 'sha256', 'sha512']) {
        const digest = createHash(algorithm).update(value).digest();
        for (const encoding of ['hex', 'base64'] as const) expect(saved).not.toContain(digest.toString(encoding));
      }
    }
    // Keyed with the TOTP Secret: the scrypt of the bare login with the same salt is not what is stored.
    expect((await derive(material, salt)).toString('base64')).not.toBe(login?.hash);
    expect((await derive(createHmac('sha256', totp.totpSecret).update(material).digest(), salt)).toString('base64')).toBe(login?.hash);
  });
});
