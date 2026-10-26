// UiPath selectors: a full selector is a fragment of sibling XML elements, such as
// `<html app='chrome.exe' title='Logon' /><webctrl tag='INPUT' aaname='User' />`. The last `webctrl` is the target; its
// attributes become locator candidates, best first. `html` and `wnd` scope elements say where, not what, and `wnd`,
// `ctrl`, `sap` (and other desktop elements) mean the activity drives a desktop application, which the browser cannot.
import { parseXml, type XmlNode } from './xml.js';
import type { Candidate } from './types.js';

export interface SelectorRead {
  /** Best first: role, label or text from the accessible name and text, then css from id, name, tag and class, css-selector. */
  candidates: Candidate[];
  /** The selector names a desktop element (wnd, ctrl, sap, uia, java): the activity cannot run in the browser. */
  desktop: boolean;
  /** What was not imported, for the report: wildcards, positions, fuzzy or regex matching, variables, an unreadable selector. */
  issues: string[];
  /** Selector text for credential detection (aaname, id, name, type, tag): never copied into steps. */
  hints: string[];
}

/** Selector fragments longer than this are not read: real ones are a few hundred characters. */
const MAX_SELECTOR = 64 * 1024;
const DESKTOP = new Set(['wnd', 'ctrl', 'sap', 'uia', 'java', 'sapjava', 'jav', 'acc']);
const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

/** A CSS identifier, escaped as CSS.escape does (CSSOM §2.1.1). */
export function cssEscape(s: string): string {
  let out = '';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '�';
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 48 && c <= 57) || (i === 1 && c >= 48 && c <= 57 && s.charCodeAt(0) === 45)) {
      out += `\\${c.toString(16)} `;
    } else if (i === 0 && n === 1 && c === 45) out += '\\-';
    else if (c >= 0x80 || c === 45 || c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) out += s[i];
    else out += `\\${s[i]}`;
  }
  return out;
}

/** A CSS attribute value in double quotes. */
const cssString = (s: string): string => `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

const hasWildcard = (v: string): boolean => v.includes('*') || v.includes('?');
/** The longest literal run between `*`/`?` wildcards, trimmed: what any match must contain. */
function longestLiteral(v: string): string {
  let best = '';
  let start = 0;
  for (let i = 0; i <= v.length; i++) {
    if (i === v.length || v[i] === '*' || v[i] === '?') {
      const part = v.slice(start, i).trim();
      if (part.length > best.length) best = part;
      start = i + 1;
    }
  }
  return best;
}

/**
 * Reads a UiPath selector (already decoded once from its XAML attribute) into locator candidates for the last `webctrl`:
 * - `aaname` on BUTTON, A, or INPUT of type submit/button/reset/image: role button (link for A) with that exact name;
 *   on INPUT, TEXTAREA or SELECT: an exact label; otherwise exact text.
 * - `check:text`, `innertext` and `visibleinnertext`: exact text.
 * - `id`: css `#id` (escaped); `name`: css `tag[name="…"]`; `tag` plus `class`: css `tag.c1.c2`; `css-selector`: css.
 * - `parentid`: `within: css #parentid` on every candidate; an IFRAME or FRAME webctrl before the target: its `frame`.
 * - A `*` or `?` wildcard keeps the longest literal part without `exact` (`id` becomes `[id*="…"]`) and is reported;
 *   `matching:<attr>='regex'` drops that attribute, `='fuzzy'` drops `exact`; `idx` and `{{variable}}` values are
 *   reported and not imported.
 * - `html` and `wnd` scope elements are ignored, except that `wnd`, `ctrl`, `sap` (and uia, java) make it desktop.
 * `tagHint` stands in for a missing `tag` (the target's element type). Never throws: an unreadable selector (a bare `&`)
 * has no candidates and one issue. Linear in the selector.
 */
export function readSelector(selector: string, tagHint?: string): SelectorRead {
  const out: SelectorRead = { candidates: [], desktop: false, issues: [], hints: [] };
  if (!selector.trim()) return out;
  if (selector.length > MAX_SELECTOR) {
    out.issues.push('the selector is longer than 64 KiB, so it was not read');
    return out;
  }
  // A full selector is several root elements: wrapped, it is one document for the strict reader.
  const doc = parseXml(`<s>${selector}</s>`, { maxDepth: 4, maxElements: 1_000 });
  if ('error' in doc) {
    out.issues.push(`the selector cannot be read (${doc.error}): rebuild this step`);
    return out;
  }
  const els = doc.children;
  for (const el of els) if (DESKTOP.has(el.name.toLowerCase())) out.desktop = true;
  let last = -1;
  els.forEach((el, i) => { if (el.name.toLowerCase() === 'webctrl') last = i; });
  if (last < 0) return out;
  const target = els[last];
  let frame: string | undefined;
  let frames = 0;
  for (let i = 0; i < last; i++) {
    const el = els[i];
    if (el.name.toLowerCase() !== 'webctrl') continue;
    const tag = (el.attrs.tag ?? '').toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') continue;
    if (++frames === 2) out.issues.push('nested frames: only the innermost is used; add the outer frame by hand');
    const id = plain(el, 'id', out);
    const name = plain(el, 'name', out);
    frame = id ? `${tag}#${cssEscape(id)}` : name ? `${tag}[name=${cssString(name)}]` : undefined;
    if (!frame) out.issues.push('the element is inside a frame the selector does not name: add the frame by hand');
  }
  readTarget(target, tagHint, out);
  const parentId = plain(target, 'parentid', out);
  if (parentId || frame) {
    out.candidates = out.candidates.map((c) => ({ ...c, ...(parentId ? { within: { css: `#${cssEscape(parentId)}` } } : {}), ...(frame ? { frame } : {}) }));
  }
  return out;
}

/** The candidates alone (see readSelector). */
export function selectorToCandidates(selector: string, tagHint?: string): Candidate[] {
  return readSelector(selector, tagHint).candidates;
}

/** An attribute value usable as is: not a variable (reported), not regex-matched (reported). Wildcards are kept. */
function plain(el: XmlNode, key: string, out: SelectorRead): string | undefined {
  const v = el.attrs[key];
  if (v === undefined || v === '') return undefined;
  if (v.includes('{{')) {
    out.issues.push(`the selector's ${key} is a variable (${v.slice(0, 80)}), which is not imported`);
    return undefined;
  }
  const matching = (el.attrs[`matching:${key}`] ?? '').toLowerCase();
  if (matching === 'regex') {
    out.issues.push(`the selector's ${key} is a regular expression, which is not imported`);
    return undefined;
  }
  return v;
}

function readTarget(el: XmlNode, tagHint: string | undefined, out: SelectorRead): void {
  const tag = (plain(el, 'tag', out) ?? tagHint ?? '').toLowerCase();
  const type = (el.attrs.type ?? '').toLowerCase();
  if (el.attrs.idx !== undefined) out.issues.push('the selector picks the element by position (idx), which is not imported');
  for (const k of ['aaname', 'id', 'name', 'type', 'tag']) if (el.attrs[k]) out.hints.push(el.attrs[k]);

  let wildcard = false;
  /** A name-like value: exact unless it has a wildcard or is fuzzy-matched. */
  const named = (key: string): { value: string; exact: boolean } | undefined => {
    const v = plain(el, key, out);
    if (v === undefined) return undefined;
    const fuzzy = (el.attrs[`matching:${key}`] ?? '').toLowerCase() === 'fuzzy';
    if (fuzzy) out.issues.push(`the selector matches ${key} with fuzzy matching: the step matches the text approximately instead`);
    if (hasWildcard(v)) {
      wildcard = true;
      const part = longestLiteral(v);
      return part ? { value: part, exact: false } : undefined;
    }
    return { value: v, exact: !fuzzy };
  };
  const withExact = <T extends object>(c: T, exact: boolean): T => (exact ? { ...c, exact: true } : c);

  const aaname = named('aaname');
  if (aaname) {
    if (tag === 'button' || (tag === 'input' && BUTTON_TYPES.has(type))) out.candidates.push(withExact({ role: 'button', name: aaname.value }, aaname.exact));
    else if (tag === 'a') out.candidates.push(withExact({ role: 'link', name: aaname.value }, aaname.exact));
    else if (FIELD_TAGS.has(tag)) out.candidates.push(withExact({ label: aaname.value }, aaname.exact));
    else out.candidates.push(withExact({ text: aaname.value }, aaname.exact));
  }
  for (const key of ['check:text', 'innertext', 'visibleinnertext']) {
    const t = named(key);
    if (t) out.candidates.push(withExact({ text: t.value }, t.exact));
  }
  const id = plain(el, 'id', out);
  if (id) {
    if (hasWildcard(id)) {
      wildcard = true;
      const part = longestLiteral(id);
      if (part) out.candidates.push({ css: `${tag ? cssEscape(tag) : ''}[id*=${cssString(part)}]` });
    } else out.candidates.push({ css: `#${cssEscape(id)}` });
  }
  const name = plain(el, 'name', out);
  if (name) {
    if (hasWildcard(name)) wildcard = true;
    else out.candidates.push({ css: `${tag ? cssEscape(tag) : ''}[name=${cssString(name)}]` });
  }
  const cls = plain(el, 'class', out);
  if (cls && tag) {
    const classes = cls.split(/[ \t\n\r\f]+/).filter((c) => c !== '');
    if (classes.some(hasWildcard)) wildcard = true;
    else if (classes.length) out.candidates.push({ css: `${cssEscape(tag)}${classes.map((c) => `.${cssEscape(c)}`).join('')}` });
  }
  const css = plain(el, 'css-selector', out);
  // Playwright-style chains (`a >> b`) and engine prefixes (`text=…`, `xpath=…`) are not CSS.
  if (css && (css.includes('>>') || /^[a-z_-]+=/i.test(css))) out.issues.push(`the selector's css-selector is not plain CSS (${css.slice(0, 80)}), which is not imported`);
  else if (css) out.candidates.push({ css });
  // A password field named by nothing but its type: the last resort.
  if (out.candidates.length === 0 && tag === 'input' && type === 'password') out.candidates.push({ css: 'input[type="password"]' });
  if (wildcard) out.issues.push('the selector uses a wildcard (* or ?): the step matches the longest fixed part instead, not exactly');
}
