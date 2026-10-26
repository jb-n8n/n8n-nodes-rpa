import type { BreakerRecord } from './guard-store.js';

/** True for a well-formed stored breaker record. A leaf module, so guard.ts and redis-store.ts share it without a cycle. */
export function isRecord(v: unknown): v is BreakerRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (r.code === 'login_failed' || r.code === 'account_locked') && typeof r.at === 'string' && typeof r.resetKey === 'string' && typeof r.message === 'string';
}
