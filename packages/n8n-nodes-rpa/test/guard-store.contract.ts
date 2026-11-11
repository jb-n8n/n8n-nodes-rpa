import { describe, expect, it } from 'vitest';
import { runGuarded } from '../nodes/Playwright/execute.js';
import { loginFingerprints, type SiteLoginSecrets } from '../nodes/Playwright/guard.js';
import type { BreakerRecord, GuardStore } from '../nodes/Playwright/guard-store.js';
import { harness } from './harness.js';

const K = 'site-login:contract';
const R1: BreakerRecord = { code: 'login_failed', at: '2026-10-20T10:00:00.000Z', resetKey: 'one', message: 'first' };
const R2: BreakerRecord = { code: 'account_locked', at: '2026-10-20T11:00:00.000Z', resetKey: 'two', message: 'second' };
const LOGIN = { salt: Buffer.alloc(16, 1).toString('base64'), hash: Buffer.alloc(32, 2).toString('base64') };
const OLD_LOGIN: SiteLoginSecrets = { username: 'contract-user', password: 'first-pass-1' };
const NEW_LOGIN: SiteLoginSecrets = { username: 'contract-user', password: 'second-pass-2' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two make() calls stand in for two workers. `reset` clears shared state before each test. */
export function guardStoreContract(name: string, make: () => Promise<GuardStore>, reset: () => Promise<void> = async () => {}): void {
  describe(`GuardStore contract: ${name}`, () => {
    const open: GuardStore[] = [];
    const made = async () => {
      const s = await make();
      open.push(s);
      return s;
    };
    const beforeEachTest = async () => {
      await Promise.all(open.splice(0).map((s) => s.close()));
      await reset();
    };

    it('only one of two stores gets the lock', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      const [la, lb] = await Promise.all([a.acquireLock(K, 10_000), b.acquireLock(K, 10_000)]);
      expect([la, lb].filter(Boolean)).toHaveLength(1);
    });

    it("a release with another holder's token does not free the lock", async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      expect(await a.acquireLock(K, 10_000)).not.toBeNull();
      await b.releaseLock(K, { token: 'x', expiresAt: 0 });
      expect(await b.acquireLock(K, 10_000)).toBeNull();
    });

    it('a release by the holder frees the lock', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      const lock = await a.acquireLock(K, 10_000);
      await a.releaseLock(K, lock!);
      expect(await b.acquireLock(K, 10_000)).not.toBeNull();
    });

    it('an unreleased lock expires at its ttl', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      expect(await a.acquireLock(K, 300)).not.toBeNull();
      expect(await b.acquireLock(K, 300)).toBeNull();
      await sleep(400);
      expect(await b.acquireLock(K, 300)).not.toBeNull();
    });

    it('a breaker set through one store is read through the other', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      await a.setBreaker(K, R1);
      expect(await b.getBreaker(K)).toEqual(R1);
    });

    it('a reset with a matching record deletes the breaker', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      await a.setBreaker(K, R1);
      await b.deleteBreaker(K, { ...R1 });
      expect(await a.getBreaker(K)).toBeUndefined();
    });

    it('a reset with a stale record does not delete a newer trip', async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      await a.setBreaker(K, R1);
      expect(await b.getBreaker(K)).toEqual(R1);
      await a.setBreaker(K, R2);
      await b.deleteBreaker(K, R1);
      expect(await a.getBreaker(K)).toEqual(R2);
    });

    it("a breaker's login fingerprint is read through the other store, and only a reset with the same fingerprint deletes it", async () => {
      await beforeEachTest();
      const [a, b] = [await made(), await made()];
      await a.setBreaker(K, { ...R1, login: LOGIN });
      expect(await b.getBreaker(K)).toEqual({ ...R1, login: LOGIN });
      await b.deleteBreaker(K, R1);
      await b.deleteBreaker(K, { ...R1, login: { ...LOGIN, hash: Buffer.alloc(32, 3).toString('base64') } });
      expect(await a.getBreaker(K)).toEqual({ ...R1, login: LOGIN });
      await b.deleteBreaker(K, { ...R1, login: { ...LOGIN } });
      expect(await a.getBreaker(K)).toBeUndefined();
    });

    /** One guarded call in a new execution on a new store (a worker): `login_failed` makes the site reject the login. */
    const run = async (login: SiteLoginSecrets, outcome: 'ok' | 'login_failed', resetKey = '') => {
      let logins = 0;
      const result = await runGuarded(harness({ params: {} }), {
        guard: { key: K, resetKey, store: await made(), ttlMs: 10_000, lockedOutMessage: () => 'locked out', busyMessage: 'busy', fingerprints: loginFingerprints(login) },
        call: async () => { logins++; return outcome; },
        loginFailure: (o) => (o === 'login_failed' ? { code: 'login_failed', message: 'the site rejected the sign-in' } : undefined),
      });
      return { result, logins };
    };
    const stored = async () => (await made()).getBreaker(K);

    it('after login_failed, a run with the same password is locked_out and tries no login', async () => {
      await beforeEachTest();
      expect((await run(OLD_LOGIN, 'login_failed')).result).toMatchObject({ kind: 'ran', tripped: true });
      expect(await run(OLD_LOGIN, 'ok')).toEqual({ result: { kind: 'blocked', code: 'locked_out', message: 'locked out' }, logins: 0 });
      // The reset key works as before, also on a record with a fingerprint.
      expect(await run(OLD_LOGIN, 'ok', 'new-key')).toEqual({ result: { kind: 'ran', result: 'ok', tripped: false }, logins: 1 });
    });

    it('after login_failed, a run with another password tries once; when that fails too the breaker holds the new fingerprint', async () => {
      await beforeEachTest();
      await run(OLD_LOGIN, 'login_failed');
      const first = await stored();
      expect(await run(NEW_LOGIN, 'login_failed')).toEqual({ result: { kind: 'ran', result: 'login_failed', tripped: true }, logins: 1 });
      const second = await stored();
      expect(second).toMatchObject({ code: 'login_failed', resetKey: '', login: { salt: expect.any(String), hash: expect.any(String) } });
      expect(second?.login?.salt).not.toBe(first?.login?.salt);
      expect(await run(NEW_LOGIN, 'ok')).toEqual({ result: { kind: 'blocked', code: 'locked_out', message: 'locked out' }, logins: 0 });
    });

    it('two runs at once with a corrected password try one login between them', async () => {
      await beforeEachTest();
      await run(OLD_LOGIN, 'login_failed');
      const both = await Promise.all([run(NEW_LOGIN, 'login_failed'), run(NEW_LOGIN, 'login_failed')]);
      expect(both[0].logins + both[1].logins).toBe(1);
      const other = both.find((r) => r.logins === 0)!.result;
      expect(other.kind === 'blocked' && ['busy', 'locked_out'].includes(other.code)).toBe(true);
    });
  });
}
