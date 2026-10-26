import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { ConfigError, type CredentialData } from '../nodes/Playwright/config.js';
import { isQueueMode, memoryGuardStore, openGuardStore, QUEUE_NEEDS_REDIS, resetMemoryGuardStoreForTests } from '../nodes/Playwright/guard-store.js';
import { connectFailureMessage, guardStoreOnClient, REDIS_KEY_PREFIX, redisGuardStore, type GuardClient } from '../nodes/Playwright/redis-store.js';
import { guardStoreContract } from './guard-store.contract.js';
import { harness } from './harness.js';

/** Parses REDIS_URL into the RPA Redis credential shape. */
export function getRedisUrlCredentials(url: string | undefined = process.env.REDIS_URL): CredentialData {
  const u = new URL(url ?? 'redis://localhost:6379/0');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    database: Number(u.pathname.slice(1) || 0),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: u.protocol === 'rediss:',
  };
}

describe('queue mode detection (no Redis credential)', () => {
  const none = { executionsMode: undefined, argv: ['node', 'n8n', 'start'], executionsModeFile: undefined };
  const unreadable = (): string => { throw new Error('ENOENT'); };
  it('EXECUTIONS_MODE=queue is queue mode; nothing set is not', () => {
    expect(isQueueMode({ ...none, executionsMode: 'queue' })).toBe(true);
    expect(isQueueMode({ ...none, executionsMode: 'regular' })).toBe(false);
    expect(isQueueMode(none)).toBe(false);
  });
  it('the n8n worker command is queue mode even without EXECUTIONS_MODE (n8n forces it there)', () => {
    expect(isQueueMode({ ...none, argv: ['/usr/local/bin/node', '/usr/local/bin/n8n', 'worker'] })).toBe(true);
    expect(isQueueMode({ ...none, argv: ['/usr/local/bin/node', '/usr/local/bin/n8n', 'webhook'] })).toBe(false);
  });
  it('EXECUTIONS_MODE_FILE is read: queue is queue mode, another value is not, an unreadable file is (fail closed)', () => {
    const read = (content: string) => (path: string) => { expect(path).toBe('/run/secrets/mode'); return content; };
    expect(isQueueMode({ ...none, executionsModeFile: '/run/secrets/mode', readFile: read('queue\n') })).toBe(true);
    expect(isQueueMode({ ...none, executionsModeFile: '/run/secrets/mode', readFile: read('regular') })).toBe(false);
    expect(isQueueMode({ ...none, executionsModeFile: '/run/secrets/mode', readFile: unreadable })).toBe(true);
  });
  it('a worker without EXECUTIONS_MODE and without Redis is the queue configuration error, not the memory store', async () => {
    const ctx = harness({ params: {} });
    const err = await openGuardStore(ctx, 0, { ...none, argv: ['node', 'n8n', 'worker'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(QUEUE_NEEDS_REDIS);
    expect(await openGuardStore(ctx, 0, none)).toBe(memoryGuardStore());
  });
});

guardStoreContract('memory', async () => memoryGuardStore(), async () => resetMemoryGuardStoreForTests());

describe('Redis connect failures', () => {
  const reply = (message: string) => Object.assign(new Error(message), { name: 'ErrorReply' });
  it.each([
    'WRONGPASS invalid username-password pair or user is disabled.',
    'NOAUTH Authentication required.',
    "NOPERM User rpa has no permissions to run the 'select' command",
  ])('an auth error (%s) says the server refused the credential, not that it could not be reached', (message) => {
    expect(connectFailureMessage(reply(message), 'run')).toBe(`The Redis server refused the credential (${message}), so no login was tried.`);
    expect(connectFailureMessage(reply(message), 'test')).toBe(`The Redis server refused the credential (${message}).`);
  });
  it('any other failure says the server could not be reached', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    expect(connectFailureMessage(refused, 'run')).toBe('The Redis server could not be reached (connect ECONNREFUSED 127.0.0.1:1), so no login was tried.');
    expect(connectFailureMessage(refused, 'test')).toBe('The Redis server could not be reached (connect ECONNREFUSED 127.0.0.1:1).');
  });
});

describe('Redis command timeout (a black-holed connection)', () => {
  const never = () => new Promise<never>(() => {});
  it('every store command rejects after the timeout instead of hanging, and close() gives up and destroys the client', async () => {
    let destroyed = 0;
    const client: GuardClient = { get: never, set: never, eval: never, quit: never, destroy: () => { destroyed++; } };
    const store = guardStoreOnClient(client, { commandTimeoutMs: 20 });
    const rec = { code: 'login_failed' as const, at: 'now', resetKey: '', message: 'm' };
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['getBreaker', () => store.getBreaker('k')],
      ['setBreaker', () => store.setBreaker('k', rec)],
      ['deleteBreaker', () => store.deleteBreaker('k', rec)],
      ['acquireLock', () => store.acquireLock('k', 1000)],
      ['releaseLock', () => store.releaseLock('k', { token: 't', expiresAt: 0 })],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow('The Redis server did not answer within 20 ms.');
    }
    await store.close();
    expect(destroyed).toBe(1);
    expect(store.shared).toBe(true);
  });
});

describe.skipIf(!process.env.REDIS_URL)('Redis GuardStore', () => {
  const creds = getRedisUrlCredentials();
  // FLUSHDB below: refuse to touch anything but the dedicated test database.
  if (process.env.REDIS_URL && creds.database !== 15) {
    throw new Error(`REDIS_URL must name database 15 (the tests run FLUSHDB); got database ${String(creds.database)}`);
  }
  let raw: ReturnType<typeof createClient>;
  beforeAll(async () => {
    raw = createClient({ url: process.env.REDIS_URL });
    await raw.connect();
  });
  afterAll(async () => {
    await raw?.quit();
  });
  const flush = async () => {
    await raw.flushDb();
  };

  guardStoreContract('redis', () => redisGuardStore(creds), flush);

  describe('redis specifics', () => {
    beforeEach(flush);

    it('keys start with playwrightGuard:', async () => {
      const s = await redisGuardStore(creds);
      await s.setBreaker('k', { code: 'login_failed', at: 'now', resetKey: '', message: 'm' });
      await s.acquireLock('k', 10_000);
      await s.close();
      const keys: string[] = [];
      for await (const batch of raw.scanIterator()) keys.push(...(Array.isArray(batch) ? batch : [batch]));
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(keys.every((k) => k.startsWith(REDIS_KEY_PREFIX))).toBe(true);
    });

    it('an invalid stored breaker reads as undefined', async () => {
      await raw.set(`${REDIS_KEY_PREFIX}breaker:k`, '{"code":"nope"}');
      await raw.set(`${REDIS_KEY_PREFIX}breaker:j`, 'not json');
      const s = await redisGuardStore(creds);
      expect(await s.getBreaker('k')).toBeUndefined();
      expect(await s.getBreaker('j')).toBeUndefined();
      await s.close();
    });

    it('an unreachable localhost names a real reason, not an empty AggregateError', async () => {
      const err = await redisGuardStore({ host: 'localhost', port: 1 }, { connectTimeoutMs: 500 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/ECONNREFUSED/);
    });

    it('a wrong password is a ConfigError saying the server refused the credential', async () => {
      const err = await redisGuardStore({ ...creds, user: 'no-such-rpa-user', password: 'wrong' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/^The Redis server refused the credential \(WRONGPASS .+\), so no login was tried\.$/);
    });

    it('an unreachable server is a ConfigError naming the reason', async () => {
      const err = await redisGuardStore({ host: '127.0.0.1', port: 1 }, { connectTimeoutMs: 500 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/^The Redis server could not be reached \(.+\), so no login was tried\.$/);
    });
  });
});
