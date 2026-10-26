import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObservableObject, type IDataObject } from 'n8n-workflow';
import {
  BREAKER_KEY, openBreaker, resetBreaker, resetGuardsForTests, siteLoginKey, tripBreaker,
} from '../nodes/Playwright/guard.js';
import { memoryGuardStore, type GuardStore } from '../nodes/Playwright/guard-store.js';

afterEach(() => {
  vi.restoreAllMocks();
  resetGuardsForTests();
});

const store = memoryGuardStore();
/** Takes the lock as if the monotonic clock read `now`. */
const lockAt = (key: string, ttlMs: number, now: number) => {
  vi.spyOn(performance, 'now').mockReturnValue(now);
  return store.acquireLock(key, ttlMs);
};

const KEY = siteLoginKey('cred-1');
const AT = new Date('2026-10-05T10:00:00Z');
const trip = (s: IDataObject, resetKey = '') => tripBreaker(store, s, KEY, { code: 'login_failed', resetKey, message: 'login_failed: the site rejected the sign-in' }, AT);

describe('login breaker', () => {
  it('opens on a trip and stays open until the reset key changes, then stays closed', async () => {
    const s: IDataObject = {};
    expect(await openBreaker(store, s, KEY, '')).toBeNull();
    await trip(s);
    expect(await openBreaker(store, s, KEY, '')).toEqual({ code: 'login_failed', at: '2026-10-05T10:00:00.000Z', resetKey: '', message: 'login_failed: the site rejected the sign-in' });
    expect(await openBreaker(store, s, KEY, '2026-10-06')).toBeNull();
    expect(await openBreaker(store, s, KEY, '2026-10-06')).toBeNull();
    expect(s[BREAKER_KEY]).toEqual({});
  });
  it('a trip under a key stays open for an empty current key, and a different non-empty key resets it', async () => {
    const s: IDataObject = {};
    await trip(s, '2026-10-06');
    expect(await openBreaker(store, s, KEY, '2026-10-06')).not.toBeNull();
    expect(await openBreaker(store, s, KEY, '')).not.toBeNull();
    expect(await openBreaker(store, s, KEY, '2026-10-07')).toBeNull();
    expect(await openBreaker(store, s, KEY, '2026-10-06')).toBeNull();
  });
  it('a stale static record cannot wipe a newer in-process trip', async () => {
    const s: IDataObject = {};
    await trip(s, 'a');
    await trip({}, 'b'); // newer trip in this process only
    s[BREAKER_KEY] = { [KEY]: { code: 'login_failed', at: AT.toISOString(), resetKey: 'a', message: 'm' } };
    expect(await openBreaker(store, s, KEY, 'b')).toMatchObject({ resetKey: 'b' });
  });
  it('ignores whitespace-only differences in the reset key', async () => {
    const s: IDataObject = {};
    await trip(s, 'r1');
    expect(await openBreaker(store, s, KEY, 'r1 ')).not.toBeNull();
    expect(await openBreaker(store, s, KEY, ' r1')).not.toBeNull();
  });
  it('a second workflow with a different non-empty key resets and is allowed (deliberate)', async () => {
    await trip({}, 'r1');
    const other: IDataObject = {};
    expect(await openBreaker(store, other, KEY, 'r2')).toBeNull();
    expect(await openBreaker(store, {}, KEY, 'r1')).toBeNull();
  });
  it('keeps the original time and message when re-tripped to write back', async () => {
    await trip({}, 'r1');
    const fresh: IDataObject = {};
    const rec = (await openBreaker(store, fresh, KEY, 'r1'))!;
    const again = await tripBreaker(store, fresh, KEY, { code: 'account_locked', resetKey: 'r1', message: 'new' }, new Date('2027-01-01T00:00:00Z'));
    expect(again.at).toBe(rec.at);
    expect(again.message).toBe(rec.message);
    expect((fresh[BREAKER_KEY] as IDataObject)[KEY]).toEqual(rec);
  });
  it('writes a new top-level object, so n8n marks static data as changed and saves it', async () => {
    const s = ObservableObject.create({});
    await trip(s);
    expect(s.__dataChanged).toBe(true);
  });
  it('keeps other Site Logins untouched on reset', async () => {
    const s: IDataObject = {};
    const other = siteLoginKey('cred-2');
    await trip(s);
    await tripBreaker(store, s, other, { code: 'account_locked', resetKey: '', message: 'account_locked' }, AT);
    await resetBreaker(store, s, KEY);
    expect(Object.keys(s[BREAKER_KEY] as IDataObject)).toEqual([other]);
  });
  it('survives a workflow re-save, a node rename and a restart', async () => {
    const s: IDataObject = {};
    await trip(s);
    // n8n stores static data as JSON and loads it into the next execution. The key holds no node name.
    const reloaded = JSON.parse(JSON.stringify(s)) as IDataObject;
    resetGuardsForTests(); // a restarted process has no in-memory state
    expect(await openBreaker(store, reloaded, KEY, '')).toMatchObject({ code: 'login_failed' });
  });
  it('stays open in this process when static data is overwritten (public API update) or never saved (manual run)', async () => {
    await trip({});
    const fresh: IDataObject = {};
    expect(await openBreaker(store, fresh, KEY, '')).toMatchObject({ code: 'login_failed' });
    // ...and is written back to the static data the execution will save
    await trip(fresh);
    expect(Object.keys(fresh[BREAKER_KEY] as IDataObject)).toEqual([KEY]);
  });
  it('openBreaker writes a process-only record back into cleared static data (as a new top-level object)', async () => {
    const s: IDataObject = {};
    await trip(s, 'r1');
    const cleared = ObservableObject.create({});
    const rec = await openBreaker(store, cleared, KEY, 'r1');
    expect(rec).toMatchObject({ code: 'login_failed', resetKey: 'r1' });
    expect((cleared[BREAKER_KEY] as IDataObject)[KEY]).toEqual(rec);
    expect(cleared.__dataChanged).toBe(true);
    // already persisted: no rewrite
    const persistedAlready = ObservableObject.create(JSON.parse(JSON.stringify(cleared)) as IDataObject);
    await openBreaker(store, persistedAlready, KEY, 'r1');
    expect(persistedAlready.__dataChanged).toBe(false);
  });
  it('ignores malformed static data', async () => {
    expect(await openBreaker(store, { [BREAKER_KEY]: { [KEY]: 'garbage' } }, KEY, '')).toBeNull();
    expect(await openBreaker(store, { [BREAKER_KEY]: ['x'] }, KEY, '')).toBeNull();
  });
});

it('a static-data breaker blocks with an empty store', async () => {
  const s: IDataObject = { [BREAKER_KEY]: { [KEY]: { code: 'login_failed', at: AT.toISOString(), resetKey: '', message: 'm' } } };
  expect(await openBreaker(memoryGuardStore(), s, KEY, '')).toMatchObject({ code: 'login_failed' });
  expect(await memoryGuardStore().getBreaker(KEY)).toMatchObject({ code: 'login_failed' }); // written through to the store
});

describe('a shared store (Redis): static data is left alone unless the store fails', () => {
  const shared = (over: Partial<GuardStore> = {}): GuardStore => ({ ...memoryGuardStore(), shared: true, ...over });
  it('openBreaker reports a store-only record without writing it back to static data', async () => {
    const s = shared();
    await s.setBreaker(KEY, { code: 'login_failed', at: AT.toISOString(), resetKey: '', message: 'm' });
    const fresh = ObservableObject.create({});
    expect(await openBreaker(s, fresh, KEY, '')).toMatchObject({ code: 'login_failed' });
    expect(fresh.__dataChanged).toBe(false);
    expect(fresh[BREAKER_KEY]).toBeUndefined();
  });
  it('tripBreaker writes the store and not static data', async () => {
    const s = shared();
    const data = ObservableObject.create({});
    const rec = await tripBreaker(s, data, KEY, { code: 'login_failed', resetKey: '', message: 'm' }, AT);
    expect(await s.getBreaker(KEY)).toEqual(rec);
    expect(data.__dataChanged).toBe(false);
  });
  it('tripBreaker falls back to static data when the store write fails (fail closed)', async () => {
    const s = shared({ setBreaker: () => Promise.reject(new Error('redis down')) });
    const data: IDataObject = {};
    const rec = await tripBreaker(s, data, KEY, { code: 'login_failed', resetKey: '', message: 'm' }, AT);
    expect((data[BREAKER_KEY] as IDataObject)[KEY]).toEqual(rec);
  });
  it('the memory store is not shared (single instance: static data is kept as before)', () => {
    expect(memoryGuardStore().shared).toBe(false);
  });
});

describe('per-Site Login lock', () => {
  it('lets one run in and turns the second away', async () => {
    const first = await lockAt(KEY, 60_000, 1000);
    expect(first).not.toBeNull();
    expect(await lockAt(KEY, 60_000, 2000)).toBeNull();
    expect(await lockAt(siteLoginKey('cred-2'), 60_000, 2000)).not.toBeNull();
    await store.releaseLock(KEY, first!);
    expect(await lockAt(KEY, 60_000, 3000)).not.toBeNull();
  });
  it('releases only with the matching token, and an expired lock can be taken over', async () => {
    const first = (await lockAt(KEY, 1000, 0))!;
    await store.releaseLock(KEY, { token: 'someone-else', expiresAt: 0 });
    expect(await lockAt(KEY, 1000, 500)).toBeNull();
    const second = (await lockAt(KEY, 1000, 1001))!;
    expect(second.token).not.toBe(first.token);
    await store.releaseLock(KEY, first); // the stale holder cannot release the new lock
    expect(await lockAt(KEY, 1000, 1500)).toBeNull();
  });
  it('is acquirable at exactly the expiry instant', async () => {
    await lockAt(KEY, 1000, 0);
    expect(await lockAt(KEY, 1000, 999)).toBeNull();
    expect(await lockAt(KEY, 1000, 1000)).not.toBeNull();
  });
});
