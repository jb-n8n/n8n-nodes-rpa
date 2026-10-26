import type { PortalPolicy, PortalSecrets, Script, Step } from '../types.js';
import { verbOf } from '../steps/parse.js';
import { secretInLocation, SIGNIN_NEEDS_SITE_LOGIN, WINDOW_STEP_NOT_CLICK } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { canonicalize } from '../sign.js';
import { interruptAction } from '../proposal/describe.js';
import { declaredTarget, isAllowedSubmit, submitKey, submitLabel } from './submits.js';
import { signInIndex } from './login-block.js';

export interface PolicyContext {
  policy: PortalPolicy;
  /** The Site Login secrets; absent when no Site Login is attached (then signIn is refused and literal-secret checks are skipped). */
  secrets?: PortalSecrets;
  mode: 'load' | 'proposal';
  previous?: Script;
  observedNavigations?: string[];
}
export interface PolicyResult {
  ok: boolean;
  violations: string[];
  safetyFlags: string[];
}

const MIN_SECRET_LEN_FOR_LITERAL_CHECK = 4;
/** Literal fill/select values: AI-compiled (proposal) steps vs steps loaded for a run. */
export const MAX_LITERAL_PROPOSAL = 64;
export const MAX_LITERAL_LOAD = 1_024;

export function flattenSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    out.push(s);
    if ('paginate' in s) out.push(...flattenSteps(s.paginate.each));
  }
  return out;
}

/**
 * Index of the step that ends the leading login block: the signIn, then any consecutive `when`-gated steps (e.g.
 * dismissing a survey), then an immediately following detect. A detect elsewhere is never part of the block.
 * -1 when the script has no signIn.
 */
export function loginBlockEnd(script: Script): number {
  const signIn = signInIndex(script);
  if (signIn < 0) return -1;
  let end = signIn;
  while (end + 1 < script.steps.length && 'when' in script.steps[end + 1] && !('detect' in script.steps[end + 1])) end++;
  if (end + 1 < script.steps.length && 'detect' in script.steps[end + 1]) end++;
  return end;
}

export function resolveGoto(goto: string, startUrl: string): URL | null {
  // Reject control characters anywhere
  if (/[\u0000-\u001F\u007F]/.test(goto)) return null;

  // Find first ? or # to mark where templates become allowed
  const queryOrFragStart = Math.min(
    goto.indexOf('?') >= 0 ? goto.indexOf('?') : Infinity,
    goto.indexOf('#') >= 0 ? goto.indexOf('#') : Infinity
  );

  // Check that templates only appear after ? or #
  const beforeQuery = queryOrFragStart === Infinity ? goto : goto.slice(0, queryOrFragStart);
  const hasTemplateInPath = /\{\{[^}]*\}\}/.test(beforeQuery);
  if (hasTemplateInPath) return null;

  // Replace templates with 'x' for URL resolution
  const withResolvedTemplates = goto.replace(/\{\{[^}]*\}\}/g, 'x');

  try {
    const url = new URL(withResolvedTemplates, startUrl);

    // Reject non-http(s) protocols
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    // Reject userinfo (username or password in URL)
    if (url.username || url.password) return null;

    return url;
  } catch {
    return null;
  }
}

const pageKey = (u: URL) => `${u.origin}${u.pathname}`;
const TEMPLATE_REGEX = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Generic recursive walker yielding all string values and object keys in any structure */
function* allStrings(value: unknown, path: string = ''): Generator<{ path: string; value: string }> {
  if (typeof value === 'string') {
    yield { path, value };
  } else if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        yield* allStrings(value[i], path ? `${path}[${i}]` : `[${i}]`);
      }
    } else {
      for (const [key, val] of Object.entries(value)) {
        const newPath = path ? `${path}.${key}` : key;
        yield { path: newPath, value: key }; // Yield the key itself
        yield* allStrings(val, newPath);
      }
    }
  }
}

function collect(script: Script) {
  const steps = flattenSteps(script.steps);
  const hosts = new Set<string>([new URL(script.startUrl).host]);
  const submits = new Set<string>();
  const gotos = new Set<string>();
  let downloads = 0;
  // Pop-up handlers click whenever their target shows, so each one is reviewed like a host or a form: the flag names
  // the target and every locator the handler may click.
  const interrupts = new Map((script.interrupts ?? []).map((it) => [canonicalize(it), it]));
  for (const s of steps) {
    if ('goto' in s) {
      const u = resolveGoto(s.goto, script.startUrl);
      if (u) { hosts.add(u.host); gotos.add(pageKey(u)); }
    }
    const target = declaredTarget(s);
    if (target) {
      const k = submitKey(target, script.startUrl);
      hosts.add(k.host);
      submits.add(submitLabel(k));
    }
    if ('download' in s) downloads++;
  }
  return { steps, hosts, submits, gotos, downloads, interrupts };
}

export function validateScript(script: Script, ctx: PolicyContext): PolicyResult {
  const violations: string[] = [];
  const safetyFlags: string[] = [];
  const { policy } = ctx;

  // Create masker for literal secret detection (only secrets >= 4 chars)
  const secretsToMask = [ctx.secrets?.username, ctx.secrets?.password, ctx.secrets?.totpSecret]
    .filter((s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LEN_FOR_LITERAL_CHECK);
  const masker = createMasker(secretsToMask);

  const startUrl = new URL(script.startUrl);
  const startHost = startUrl.host;
  if (!policy.navHosts.includes(startHost)) violations.push(`startUrl host ${startHost} is not in the allowed hosts`);

  // For proposal mode: startUrl origin+pathname must match policy.startUrl
  if (ctx.mode === 'proposal') {
    const policyUrl = new URL(policy.startUrl);
    if (pageKey(startUrl) !== pageKey(policyUrl)) violations.push(`startUrl must match the credential's start URL`);
  }

  // Check for literal secrets over the entire script (name, startUrl, interrupts, steps)
  const reportedSecretLocations = new Set<string>();
  for (const { path, value } of allStrings(script)) {
    if (masker.containsSecret(value)) {
      // Normalize path for deduping: remove paginate.each indices so nested steps are grouped with parent
      const normalized = path.replace(/\.paginate\.each\[\d+\]/g, '');
      if (!reportedSecretLocations.has(normalized)) {
        reportedSecretLocations.add(normalized);
        let location = `script field ${normalized}`;
        const match = normalized.startsWith('steps[') ? normalized.match(/steps\[(\d+)\]/) : null;
        const step = match ? script.steps[parseInt(match[1])] : undefined;
        if (match && step) {
          location = `step "${step.intent}"`;
          const suffix = normalized.slice(match[0].length);
          if (suffix) location += ` ${suffix}`;
        }
        violations.push(secretInLocation(location));
      }
    }
  }

  // Check for secret templates in raw strings (not JSON-stringified, to catch real tabs/newlines)
  for (let stepIndex = 0; stepIndex < script.steps.length; stepIndex++) {
    const step = script.steps[stepIndex];
    const verb = verbOf(step);
    const where = `step "${step.intent}"`;

    for (const { value } of allStrings(step)) {
      let templateMatch: RegExpExecArray | null;
      TEMPLATE_REGEX.lastIndex = 0;
      while ((templateMatch = TEMPLATE_REGEX.exec(value)) !== null) {
        const expr = templateMatch[1];
        if (verb === 'signIn') {
          // signIn steps must not contain ANY templates
          violations.push(`${where}: signIn steps must not contain templates`);
          break; // Report once per step
        } else if (expr.startsWith('secret.')) {
          // Other steps cannot use secret templates
          violations.push(`${where}: secret template outside signIn`);
          break; // Report once per step
        }
      }
    }
  }

  const mine = collect(script);
  const prev = ctx.previous ? collect(ctx.previous) : undefined;
  const observed = new Set((ctx.observedNavigations ?? []).flatMap((u) => { try { return [pageKey(new URL(u))]; } catch { return []; } }));
  observed.add(pageKey(startUrl));

  let signIns = 0;
  for (let stepIndex = 0; stepIndex < mine.steps.length; stepIndex++) {
    const s = mine.steps[stepIndex];
    const verb = verbOf(s);
    const where = `step "${s.intent}"`;
    if (verb === 'signIn') signIns++;

    const maxLiteral = ctx.mode === 'proposal' ? MAX_LITERAL_PROPOSAL : MAX_LITERAL_LOAD;
    const literal = 'fill' in s ? s.fill.value : 'select' in s ? s.select.value : undefined;
    if (literal !== undefined && literal.length > maxLiteral) violations.push(`limit: ${where}: value is longer than ${maxLiteral} characters`);
    if ('goto' in s) {
      const u = resolveGoto(s.goto, script.startUrl);
      if (!u) { violations.push(`${where}: goto must be a literal http(s) URL or path; templates are allowed only in the query or fragment`); continue; }
      if (!policy.navHosts.includes(u.host)) violations.push(`${where}: goto host ${u.host} is not in the allowed hosts`);
      else if (ctx.mode === 'proposal' && !observed.has(pageKey(u)) && !prev?.gotos.has(pageKey(u))) {
        violations.push(`${where}: goto to an unobserved URL ${pageKey(u)}`);
      }
    }
    const target = declaredTarget(s);
    if (target) {
      const k = submitKey(target, script.startUrl);
      if (!isAllowedSubmit(policy, k)) violations.push(`${where}: ${submitLabel(k)} is not an allowed submission`);
    }
  }
  if (signIns > 1) violations.push('script has more than one signIn step');
  // The Fill and Submit window opens on exactly one top-level click (nested paginate steps have no index of their own).
  if (policy.writeWindow) {
    const at = policy.writeWindow.step;
    const target = Number.isInteger(at) && at >= 0 ? script.steps[at] : undefined;
    if (!target || !('click' in target)) violations.push(WINDOW_STEP_NOT_CLICK);
  }
  if (signIns > 0 && !ctx.secrets) violations.push(SIGNIN_NEEDS_SITE_LOGIN);

  // A first approval (a proposal with no previous version) compares against an empty script: everything is new.
  const baseline = prev ?? (ctx.mode === 'proposal' ? { submits: new Set<string>(), downloads: 0, hosts: new Set<string>(), interrupts: new Set<string>() } : undefined);
  if (baseline) {
    for (const sub of mine.submits) if (!baseline.submits.has(sub)) safetyFlags.push(`new form submission: ${sub}`);
    if (mine.downloads > 0 && baseline.downloads === 0) safetyFlags.push('new download step');
    for (const h of mine.hosts) if (!baseline.hosts.has(h)) safetyFlags.push(`new host: ${h}`);
    const handlers = new Set<string>();
    for (const [key, it] of mine.interrupts) if (!baseline.interrupts.has(key)) handlers.add(`new interrupt: ${interruptAction(it)}`);
    safetyFlags.push(...handlers);
  }

  // Mask all violations and safety flags to prevent secret leakage
  const maskedViolations = violations.map((v) => masker.mask(v));
  const maskedFlags = safetyFlags.map((f) => masker.mask(f));

  return { ok: maskedViolations.length === 0, violations: maskedViolations, safetyFlags: maskedFlags };
}
