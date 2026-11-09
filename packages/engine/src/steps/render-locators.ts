import { renderVars } from '../secrets/render.js';
import type { Masker } from '../secrets/mask.js';
import { INPUT_CONTAINS_SECRET, renderedTooLong } from '../messages.js';
import { MAX_RENDERED } from '../secrets/render.js';

const VAR_REF = /\{\{\s*var\.[A-Za-z0-9_]+\s*\}\}/g;
const BROWSER_KINDS = ['role', 'label', 'text', 'testId', 'css'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Renders only {{var.NAME}} references; any other `{{...}}` stays literal (a page can show one that a text locator
 * matches). A rendered value that holds a secret is refused (the fill value rule). Each value is rendered once.
 */
function renderText(text: string, vars: Record<string, string>, masker: Masker): string {
  if (!VAR_REF.test(text)) return text;
  VAR_REF.lastIndex = 0;
  const out = text.replace(VAR_REF, (m) => renderVars(m, vars, masker));
  if (out.length > MAX_RENDERED) throw new Error(renderedTooLong(MAX_RENDERED));
  if (masker.containsSecret(out)) throw new Error(INPUT_CONTAINS_SECRET);
  return out;
}

/**
 * The step with {{var.x}} rendered into its locators for this run: a browser locator's `name` (role form) and `text`
 * (text form), and a desktop UI Automation condition's `name`. Hosts, URLs, window selectors and the signed text are
 * never touched: the result is a copy and the step keeps its template. A step without a template is returned as is.
 * `paginate.each` is left alone: the nested run renders its own steps, so no value is rendered twice.
 */
export function renderLocators<T>(step: T, vars: Record<string, string>, masker: Masker): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) {
      const mapped = v.map((x) => walk(x, key));
      return mapped.some((x, i) => x !== v[i]) ? mapped : v;
    }
    if (!isObj(v)) return v;
    let out: Obj | undefined;
    const set = (k: string, val: unknown) => { out ??= { ...v }; out[k] = val; };
    const kind = BROWSER_KINDS.find((k) => typeof v[k] === 'string');
    for (const [k, x] of Object.entries(v)) {
      if (key === 'paginate' && k === 'each') continue;
      const next = typeof x === 'string'
        ? ((kind === 'role' && k === 'name') || (kind === 'text' && k === 'text') || (key === 'path' && k === 'name') ? renderText(x, vars, masker) : x)
        : walk(x, k);
      if (next !== x) set(k, next);
    }
    return out ?? v;
  };
  return walk(step) as T;
}
