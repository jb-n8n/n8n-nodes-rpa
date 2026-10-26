import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FIRST_STEP_GOTO } from './messages.js';
import { parseScript, ScriptShapeError } from './steps/parse.js';

/** Domain separator of the step-list MAC. A v1 script MAC never verifies as a pw-steps/2 MAC. */
export const MAC_DOMAIN = 'pw-steps/2';

/** What a signature binds besides the step document itself. */
export interface SignBinding {
  approvedBy: string;
  /** Id of the Site Login credential attached when signing. Absent or '' means none, and is bound as an empty line. */
  siteLoginId?: string;
}

/** Stable JSON: object keys sorted, undefined object values dropped, undefined array items become null. */
export function canonicalize(value: unknown): string {
  if (value === undefined) throw new Error('canonicalize: undefined is not allowed');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function scriptHash(script: unknown): string {
  return createHash('sha256').update(canonicalize(script)).digest('hex');
}

/** Host of the steps' start URL as the run opens it; '' when the document does not parse. */
export function startHostOf(raw: unknown): string {
  try {
    return new URL(parseScript(raw).startUrl).host;
  } catch {
    return '';
  }
}

/** startHostOf, except that a document with no start of its own (no startUrl, no absolute first goto) throws FIRST_STEP_GOTO. */
function signedStartHost(raw: unknown): string {
  try {
    return new URL(parseScript(raw).startUrl).host;
  } catch (err) {
    if (err instanceof ScriptShapeError && err.issues.includes(FIRST_STEP_GOTO)) throw new Error(FIRST_STEP_GOTO);
    return '';
  }
}

function nameAndVersion(raw: unknown): { name: string; version: number } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { name, version } = raw as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || name === '' || typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  return { name, version };
}

const LINE_BREAK = /[\r\n]/;
/** The MAC joins its fields with '\n': a line break in a bound value could move text from one field to the next. */
const multiLine = (b: SignBinding) => LINE_BREAK.test(b.approvedBy) || LINE_BREAK.test(b.siteLoginId ?? '');

/** HMAC-SHA-256, lowercase hex, over `pw-steps/2\n<hash>\n<name>\n<version>\n<startHost>\n<siteLoginId or empty>\n<approvedBy>`. */
function mac(key: string, hash: string, name: string, version: number, startHost: string, b: SignBinding): string {
  const input = [MAC_DOMAIN, hash, name, String(version), startHost, b.siteLoginId ?? '', b.approvedBy].join('\n');
  return createHmac('sha256', key).update(input).digest('hex');
}

/**
 * Signs the raw step document. Throws when the key or approver is empty, a bound value spans lines, name/version are
 * missing, or the document has no start host of its own (no startUrl and no absolute first goto: FIRST_STEP_GOTO).
 */
export function signScript(raw: unknown, key: string, binding: SignBinding): { hash: string; signature: string } {
  if (!key?.trim()) throw new Error('signing key is empty');
  if (!binding.approvedBy) throw new Error('approver id is empty');
  if (multiLine(binding)) throw new Error('approver id and Site Login id must be single-line');
  const nv = nameAndVersion(raw);
  if (!nv) throw new Error('signing needs a name and a version');
  const startHost = signedStartHost(raw);
  const hash = scriptHash(raw);
  return { hash, signature: mac(key, hash, nv.name, nv.version, startHost, binding) };
}

const SIGNATURE = /^[0-9a-f]{64}$/;

/** True only when `signature` is the lowercase hex pw-steps/2 MAC of this exact document and these bound values. Never throws. */
export function verifyScript(raw: unknown, key: string, binding: SignBinding & { signature: string }): boolean {
  const { signature } = binding;
  if (!key || !binding.approvedBy || multiLine(binding) || typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
  const nv = nameAndVersion(raw);
  if (!nv) return false;
  let expected: string;
  try {
    expected = mac(key, scriptHash(raw), nv.name, nv.version, startHostOf(raw), binding);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
