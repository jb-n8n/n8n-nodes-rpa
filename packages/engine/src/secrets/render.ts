import { INPUT_CONTAINS_SECRET, renderedTooLong } from '../messages.js';
import type { Masker } from './mask.js';

const TEMPLATE = /\{\{\s*([^}]*?)\s*\}\}/g;
/** Longest value a template may render to. */
export const MAX_RENDERED = 10_000;

/** Renders {{var.NAME}} from inputs. Secrets are never rendered here: only signIn uses them. */
export function renderVars(template: string, vars: Record<string, string>, masker: Masker): string {
  const out = template.replace(TEMPLATE, (_m, expr: string) => {
    if (expr.startsWith('secret.')) throw new Error('secrets can only be used by signIn steps');
    const m = /^var\.([A-Za-z0-9_]+)$/.exec(expr);
    if (!m) throw new Error(`unknown template "{{${expr}}}"`);
    const name = m[1];
    if (!Object.hasOwn(vars, name)) throw new Error(`missing input "${name}"`);
    const v = vars[name];
    if (typeof v !== 'string') throw new Error(`missing input "${name}"`);
    return v;
  });
  if (out.length > MAX_RENDERED) throw new Error(renderedTooLong(MAX_RENDERED));
  if (masker.containsSecret(out)) throw new Error(INPUT_CONTAINS_SECRET);
  return out;
}
