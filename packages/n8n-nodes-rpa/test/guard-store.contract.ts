import { describe, expect, it } from 'vitest';
import type { BreakerRecord, GuardStore } from '../nodes/Playwright/guard-store.js';

const K = 'site-login:contract';
const R1: BreakerRecord = { code: 'login_failed', at: '2026-10-20T10:00:00.000Z', resetKey: 'one', message: 'first' };
const R2: BreakerRecord = { code: 'account_locked', at: '2026-10-20T11:00:00.000Z', resetKey: 'two', message: 'second' };
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
  });
}
