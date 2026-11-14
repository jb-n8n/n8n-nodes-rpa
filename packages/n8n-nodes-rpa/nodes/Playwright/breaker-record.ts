import type { BreakerRecord, LoginFingerprint } from './guard-store.js';

// A leaf module, so guard.ts and redis-store.ts share it without a cycle.

/** True for a well-formed stored breaker record. */
function isRecord(v: unknown): v is BreakerRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (r.code === 'login_failed' || r.code === 'account_locked') && typeof r.at === 'string' && typeof r.resetKey === 'string' && typeof r.message === 'string';
}

/** True for base64 text of exactly `bytes` bytes, in the form Buffer writes it. */
const base64Of = (v: unknown, bytes: number): v is string =>
  typeof v === 'string' && Buffer.from(v, 'base64').length === bytes && Buffer.from(v, 'base64').toString('base64') === v;

function loginOf(v: unknown): LoginFingerprint | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { salt, hash } = v as Record<string, unknown>;
  return base64Of(salt, 16) && base64Of(hash, 32) ? { salt, hash } : undefined;
}

/**
 * A stored breaker record, copied field by field, or undefined when it is not well formed. A login fingerprint that is
 * not well formed is left out, and the record still blocks: only a new reset key opens it then.
 */
export function readRecord(v: unknown): BreakerRecord | undefined {
  if (!isRecord(v)) return undefined;
  const login = v.code === 'login_failed' ? loginOf(v.login) : undefined;
  return { code: v.code, at: v.at, resetKey: v.resetKey, message: v.message, ...(login ? { login } : {}) };
}
