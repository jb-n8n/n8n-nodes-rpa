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

/** The value template of every fill.secret step, nested paginate steps included. */
function secretFillTemplates(steps: readonly Step[], out: string[] = []): string[] {
  for (const step of steps) {
    if ('fill' in step && step.fill.secret === true && typeof step.fill.value === 'string') out.push(step.fill.value);
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
