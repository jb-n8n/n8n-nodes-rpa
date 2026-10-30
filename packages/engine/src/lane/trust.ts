import {
  nameMismatch, SIGNATURE_INVALID, SIGNATURE_WITHOUT_KEY, startSiteMismatch, UNSIGNED_REQUIRED, UNSIGNED_SECRET_FILL, UNSIGNED_WRITES, versionMismatch,
} from '../messages.js';
import { flattenSteps } from '../policy/validate.js';
import { startHostOf, verifyScript } from '../sign.js';
import { parseScript } from '../steps/parse.js';
import { hostOf } from '../steps/urls.js';
import type { PortalPolicy, Script, Step } from '../types.js';

/** Everything the run knows about who approved the steps. JSON-serialisable. */
export interface TrustInput {
  /** Require Signed Steps. */
  required: boolean;
  signature?: string;
  approvedBy?: string;
  /** The Step Signing key. */
  key?: string;
  /** Options → Allow Unsigned Writes. */
  allowUnsignedWrites?: boolean;
  /** Values the signed steps must match: Options → Name, Expected Version, and the attached Site Login credential id. */
  expect?: { name?: string; version?: number; siteLoginId?: string };
}

export type TrustResult = { ok: true; signed: boolean } | { ok: false; code: 'script_untrusted'; message: string };

/** Empty steps: undefined, null, a blank string, [] or an object whose `steps` is []. Nothing else (`{}` is not empty). */
export function isEmptySteps(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'string') return raw.trim() === '';
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === 'object') {
    const steps = (raw as { steps?: unknown }).steps;
    return Array.isArray(steps) && steps.length === 0;
  }
  return false;
}

/** A signature is present when it is a string that is not blank. 'null' and 'undefined' are present (and never valid). */
export function hasSignature(t: TrustInput): boolean {
  return typeof t.signature === 'string' && t.signature.trim() !== '';
}

/** Intents of the steps unsigned steps may not contain: signIn, submit and download with `via`, inside paginate too. */
export function unsignedWrites(steps: Step[]): string[] {
  return flattenSteps(steps)
    .filter((s) => 'signIn' in s || 'submit' in s || ('download' in s && s.download.via !== undefined))
    .map((s) => s.intent);
}

/** Whether any step, paginate bodies included, is a fill with `secret: true`. */
export function hasSecretFill(steps: Step[]): boolean {
  return flattenSteps(steps).some((s) => 'fill' in s && s.fill.secret === true);
}

const refuse = (message: string): TrustResult => ({ ok: false, code: 'script_untrusted', message });
function tryParse(raw: unknown, defaultStartUrl: string): Script | undefined {
  try {
    // Same default start as the lane, so a document the lane runs is always the document the gate checked.
    return parseScript(raw, { defaultStartUrl });
  } catch {
    return undefined;
  }
}

/**
 * The trust gate. It runs before the browser opens, in this order: first-run exemption; a present signature is
 * always verified (no key → SIGNATURE_WITHOUT_KEY; invalid → UNSIGNED_REQUIRED when required, else SIGNATURE_INVALID);
 * absent and required → UNSIGNED_REQUIRED; a fill with secret in unsigned steps → UNSIGNED_SECRET_FILL; unsigned writes without Allow Unsigned Writes → UNSIGNED_WRITES; signed
 * steps must then match Expected Name, Expected Version and the run's start site. A document that does not parse
 * passes the gate when nothing else refuses it, and the shape check reports it as policy_violation.
 */
export function checkTrust(raw: unknown, trust: TrustInput, ctx: { policy: PortalPolicy; firstRun: boolean }): TrustResult {
  // Nothing from the input runs on a first run, and its only output is a Repaired steps item that still needs Sign Steps.
  if (ctx.firstRun) return { ok: true, signed: false };
  const script = tryParse(raw, ctx.policy.startUrl);
  if (hasSignature(trust)) {
    if (!trust.key || trust.key.trim() === '') return refuse(SIGNATURE_WITHOUT_KEY);
    const valid = verifyScript(raw, trust.key, {
      approvedBy: trust.approvedBy ?? '',
      signature: trust.signature as string,
      ...(trust.expect?.siteLoginId ? { siteLoginId: trust.expect.siteLoginId } : {}),
    });
    if (!valid) return refuse(trust.required ? UNSIGNED_REQUIRED : SIGNATURE_INVALID);
    if (!script) return { ok: true, signed: true };
    return boundValues(raw, script, trust, ctx.policy);
  }
  if (trust.required) return refuse(UNSIGNED_REQUIRED);
  if (!script) return { ok: true, signed: false };
  // Stricter than the unsigned-writes switch: a secret fill is never run from unsigned steps.
  if (hasSecretFill(script.steps)) return refuse(UNSIGNED_SECRET_FILL);
  if (!trust.allowUnsignedWrites && unsignedWrites(script.steps).length > 0) return refuse(UNSIGNED_WRITES);
  return { ok: true, signed: false };
}

function boundValues(raw: unknown, script: Script, trust: TrustInput, policy: PortalPolicy): TrustResult {
  const want = trust.expect ?? {};
  // Trimmed the same way runTask trims Options → Name: spaces around Expected Name never refuse, blank means unset.
  const wantName = typeof want.name === 'string' ? want.name.trim() : '';
  if (wantName && script.name !== wantName) return refuse(nameMismatch(script.name ?? '', wantName));
  const rawVersion: unknown = want.version;
  const versionSet = !(rawVersion === undefined || rawVersion === null || (typeof rawVersion === 'string' && rawVersion.trim() === ''));
  if (versionSet) {
    const wantVersion = Number(rawVersion);
    if (!Number.isInteger(wantVersion) || script.version !== wantVersion) return refuse(versionMismatch(script.version ?? 0, rawVersion as number));
  }
  const signedHost = startHostOf(raw);
  const runHost = hostOf(policy.startUrl);
  if (signedHost !== runHost) return refuse(startSiteMismatch(signedHost, runHost));
  return { ok: true, signed: true };
}
