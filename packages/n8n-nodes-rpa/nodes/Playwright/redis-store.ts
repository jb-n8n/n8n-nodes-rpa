import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { ConfigError, type CredentialData } from './config.js';
import { isRecord } from './breaker-record.js';
import type { BreakerRecord, GuardStore, Lock } from './guard-store.js';

export const REDIS_KEY_PREFIX = 'playwrightGuard:';
/** The credential test's message: no run is involved. */
export const REDIS_TEST_UNREACHABLE = (reason: string) => `The Redis server could not be reached (${reason}).`;
export const REDIS_UNREACHABLE = (reason: string) => `The Redis server could not be reached (${reason}), so no login was tried.`;
export const REDIS_TEST_REFUSED = (reason: string) => `The Redis server refused the credential (${reason}).`;
export const REDIS_REFUSED = (reason: string) => `The Redis server refused the credential (${reason}), so no login was tried.`;
export const REDIS_NO_ANSWER = (ms: number) => `The Redis server did not answer within ${ms} ms.`;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** Every command after connect: a connection that went silent during a long run must not hang the release or the trip. */
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
/** Redis replies that mean the server was reached but refused the user, the password or a command for that user. */
const AUTH_REPLY = /^(WRONGPASS|NOAUTH|NOPERM)\b/;
const COMPARE_AND_DELETE = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0";

const text = (data: CredentialData, key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '');

/** The RPA Redis credential (its fields mirror n8n's own Redis credential), mapped the way n8n's Redis node does it. Fails fast: no reconnects. */
function clientOptions(data: CredentialData, connectTimeoutMs: number) {
  const ssl = data.ssl === true;
  const port = Number(data.port);
  const socket = {
    host: text(data, 'host') || 'localhost',
    port: Number.isFinite(port) && port > 0 ? port : 6379,
    connectTimeout: connectTimeoutMs,
    reconnectStrategy: false as const,
  };
  const database = Number(data.database);
  return {
    socket: ssl ? { ...socket, tls: true as const, ...(data.disableTlsVerification === true ? { rejectUnauthorized: false } : {}) } : socket,
    username: text(data, 'user') || undefined,
    password: text(data, 'password') || undefined,
    database: Number.isInteger(database) && database > 0 ? database : undefined,
  };
}

/** Node's dual-stack connect fails with an AggregateError whose message is empty: fall back to the code, then the first inner error. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const inner = (error as { errors?: unknown }).errors;
    const first = Array.isArray(inner) ? (inner[0] as { message?: unknown; code?: unknown } | undefined) : undefined;
    if (error.message) return error.message;
    if (typeof code === 'string' && code) return code;
    if (typeof first?.message === 'string' && first.message) return first.message;
    if (typeof first?.code === 'string' && first.code) return first.code;
  }
  return String(error);
}

/** The message for a failed connect: a refused credential, or a server that could not be reached; `test` is the credential test's. */
export function connectFailureMessage(error: unknown, kind: 'run' | 'test'): string {
  const reason = reasonOf(error);
  if (AUTH_REPLY.test(reason)) return (kind === 'run' ? REDIS_REFUSED : REDIS_TEST_REFUSED)(reason);
  return (kind === 'run' ? REDIS_UNREACHABLE : REDIS_TEST_UNREACHABLE)(reason);
}

async function connect(data: CredentialData, connectTimeoutMs: number, kind: 'run' | 'test') {
  const client = createClient(clientOptions(data, connectTimeoutMs));
  client.on('error', () => {}); // surfaced through the failing command or connect(), never as an unhandled event
  // The throw stays out of the catch block (as in config.ts), where the lint rule would ask for a NodeApiError.
  const failure = await client.connect().then(() => undefined, (error: unknown) => ({ error }));
  if (failure) {
    client.destroy();
    throw new ConfigError(connectFailureMessage(failure.error, kind));
  }
  return client;
}

/** Rejects with REDIS_NO_ANSWER when `p` has not settled within `ms`. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(REDIS_NO_ANSWER(ms))), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The serialisation setBreaker writes and deleteBreaker compares: keys in a fixed order. */
const serialise = (r: BreakerRecord): string => JSON.stringify({ code: r.code, at: r.at, resetKey: r.resetKey, message: r.message });

function parseBreaker(raw: string | null): BreakerRecord | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isRecord(value) ? { code: value.code, at: value.at, resetKey: value.resetKey, message: value.message } : undefined;
}

/** The commands the store sends: a connected node-redis client, or a fake in tests. */
export interface GuardClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { condition: 'NX'; expiration: { type: 'PX'; value: number } }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
  destroy(): void;
}

/** The store on a connected client. Every command rejects after `commandTimeoutMs`; close() then destroys the client. */
export function guardStoreOnClient(client: GuardClient, opts: { commandTimeoutMs?: number } = {}): GuardStore {
  const ms = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const breakerKey = (key: string) => `${REDIS_KEY_PREFIX}breaker:${key}`;
  const lockKey = (key: string) => `${REDIS_KEY_PREFIX}lock:${key}`;
  const compareAndDelete = (key: string, value: string) => bounded(client.eval(COMPARE_AND_DELETE, { keys: [key], arguments: [value] }), ms);
  return {
    shared: true,
    async getBreaker(key) {
      return parseBreaker(await bounded(client.get(breakerKey(key)), ms));
    },
    async setBreaker(key, record) {
      await bounded(client.set(breakerKey(key), serialise(record)), ms);
    },
    async deleteBreaker(key, expected) {
      await compareAndDelete(breakerKey(key), serialise(expected));
    },
    async acquireLock(key, ttlMs) {
      const token = randomUUID();
      const set = await bounded(client.set(lockKey(key), token, { condition: 'NX', expiration: { type: 'PX', value: Math.max(1, Math.ceil(ttlMs)) } }), ms);
      return set === 'OK' ? ({ token, expiresAt: Date.now() + ttlMs } satisfies Lock) : null;
    },
    async releaseLock(key, lock) {
      await compareAndDelete(lockKey(key), lock.token);
    },
    async close() {
      try {
        await bounded(client.quit(), ms);
      } catch {
        client.destroy();
      }
    },
  };
}

/** Connects with an RPA Redis credential; throws ConfigError when the server cannot be reached or refuses the credential. */
export async function redisGuardStore(credentials: CredentialData, opts: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {}): Promise<GuardStore> {
  const client = await connect(credentials, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 'run');
  return guardStoreOnClient(client, opts);
}

/** Connects and PINGs, for the credential test. Rejects with a ConfigError when unreachable or refused. */
export async function pingRedis(credentials: CredentialData): Promise<void> {
  const client = await connect(credentials, DEFAULT_CONNECT_TIMEOUT_MS, 'test');
  try {
    await bounded(client.ping(), DEFAULT_COMMAND_TIMEOUT_MS);
  } finally {
    try {
      await bounded(client.quit(), DEFAULT_COMMAND_TIMEOUT_MS);
    } catch {
      client.destroy();
    }
  }
}
