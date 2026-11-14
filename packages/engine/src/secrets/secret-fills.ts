import type { Step } from '../types.js';
import type { Masker } from './mask.js';
import { renderVars, SECRET_FILL_VALUE } from './render.js';

/** Rendered values of fill.secret steps, per run masker: the masker holds them, so renderVars would refuse a second use. */
const typedSecrets = new WeakMap<Masker, Set<string>>();

/** The fill.secret values the run's masker already holds (registerSecretFills, or a secret fill that ran). */
export function secretFillValues(masker: Masker): Set<string> {
  const known = typedSecrets.get(masker) ?? new Set<string>();
  typedSecrets.set(masker, known);
  return known;
}

/**
 * The value a secret template types (a fill.secret's, or signIn.changePassword's): `template` is exactly one {{var.name}}
 * (the caller checked) and `name` is that variable. Never a Site Login credential (renderVars refuses it); a value the
 * masker already holds as a secret fill value (registerSecretFills) is taken as is. Added to the masker before it returns,
 * so before anything types it.
 */
export function renderSecretValue(name: string, template: string, vars: Record<string, string>, masker: Masker): string {
  const known = secretFillValues(masker);
  const raw = Object.hasOwn(vars, name) ? vars[name] : undefined;
  const value = typeof raw === 'string' && known.has(raw) ? raw : renderVars(template, vars, masker);
  masker.add([value]);
  known.add(value);
  return value;
}

/**
 * The value template of every fill.secret step, nested paginate steps included, and of signIn.changePassword: the new
 * password is a secret fill's variable too (masked from run start, never tested by a condition).
 */
function secretFillTemplates(steps: readonly Step[], out: string[] = []): string[] {
  for (const step of steps) {
    if ('fill' in step && step.fill.secret === true && typeof step.fill.value === 'string') out.push(step.fill.value);
    if ('signIn' in step && typeof step.signIn?.changePassword?.value === 'string') out.push(step.signIn.changePassword.value);
    if ('paginate' in step && Array.isArray(step.paginate.each)) secretFillTemplates(step.paginate.each, out);
  }
  return out;
}

/** The names of the variables the fill.secret steps type (a value that is not one {{var.name}} names none). */
export function secretFillVariables(steps: readonly Step[]): Set<string> {
  const names = new Set<string>();
  for (const template of secretFillTemplates(steps)) {
    const name = SECRET_FILL_VALUE.exec(template)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/**
 * Secret variables (TaskInput.secretVars; in n8n, the RPA Secret Variables credential): their values join the run's masker
 * as the run starts, whether or not a step uses them. Messages, the log, outputs, traces, page text and the chat model see
 * [secret] in their place, and renderVars refuses every template that renders one (a locator, a plain fill, a URL, a
 * condition). A secret fill still types one: the value becomes a known secret fill value (secretFillValues), unless the
 * masker already held it (a Site Login secret, a token, the signing key), which no secret fill may type. Idempotent per
 * masker.
 */
export function registerSecretVars(names: readonly string[] | undefined, vars: Record<string, string>, masker: Masker): void {
  const known = secretFillValues(masker);
  const values: string[] = [];
  for (const name of names ?? []) {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (typeof value !== 'string' || value === '' || known.has(value) || values.includes(value)) continue;
    values.push(value);
  }
  if (!values.length) return;
  // Checked against what the masker held before any of these values joined it.
  const typable = values.filter((v) => !masker.containsSecret(v));
  masker.add(values);
  for (const v of typable) known.add(v);
}

/**
 * At run start: the value of every variable a fill.secret step names goes into the run's masker, so the steps before the
 * secret fill (a locator or plain fill rendering it, a page error showing it) never show it, and refuse to render it.
 * Each value is checked as the secret fill checks it (renderVars against the masker before any is added: never a Site
 * Login credential); a value that fails the check is left for the step itself to refuse. Idempotent per masker.
 */
export function registerSecretFills(steps: readonly Step[], vars: Record<string, string>, masker: Masker): void {
  const known = secretFillValues(masker);
  const values: string[] = [];
  for (const template of secretFillTemplates(steps)) {
    if (!SECRET_FILL_VALUE.test(template)) continue;
    let value: string;
    try {
      value = renderVars(template, vars, masker);
    } catch {
      continue;
    }
    if (!known.has(value)) values.push(value);
  }
  if (!values.length) return;
  masker.add(values);
  for (const v of values) known.add(v);
}
