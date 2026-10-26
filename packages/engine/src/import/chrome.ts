// Chrome Recorder exports: a hand-written reader of the @puppeteer/replay UserFlow schema
// (github.com/puppeteer/replay src/Schema.ts), not the package. Steps become neutral import events; whatever has no step
// equivalent goes in the report. Typed values only ever reach fill/select events, which stripSecrets checks and drops
// them: never a report item.
import { cleanLabel } from './draft.js';
import type { Candidate, ImportEvent, ImportItem, ImportReport } from './types.js';

/** A recording larger than this is refused before it is parsed. */
export const MAX_CHROME_BYTES = 5 * 1024 * 1024;
/** A recording with more steps than this is refused. */
export const MAX_CHROME_STEPS = 5_000;
/** A target keeps at most this many of the recorded selectors, in the recorder's order (the draft builder keeps one plus three fallbacks). */
const MAX_CANDIDATES = 4;

const WHAT = 'Chrome recording';
const TOO_LARGE = 'the recording is larger than 5 MiB, so it was not read';
const TOO_MANY = 'the recording has more than 5,000 steps, so it was not read';
const NOT_JSON = 'the file is not valid JSON: export the recording from Chrome DevTools as JSON';
const NOT_A_RECORDING = 'the file is not a Chrome Recorder export: it has no list of steps';
const NOT_TEXT = 'the recording must be text or a file';
const NO_SELECTOR = 'no selector the steps can use: XPath, pierce, Puppeteer-only and shadow DOM selectors are not imported';

const ENTER = new Set(['Enter', 'NumpadEnter', '\r', '\n']);
/**
 * Keys a report item may name, with the name it shows (a typed space is Space). Any other key (a letter, a digit, KeyA,
 * Digit1) is reported as "a key", because a recording that typed a password key by key must not spell it out.
 */
const NAMED_KEYS = new Map<string, string>([
  [' ', 'Space'],
  ...[
    'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft',
    'MetaRight', 'CapsLock', 'ContextMenu', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ].map((k): [string, string] => [k, k]),
]);

/** What the report counts once for the whole recording rather than once per step, in report order. */
const COUNTED = {
  viewport: ['Viewport changes', 'the node\'s Viewport option sets the window size'],
  scroll: ['Scrolls', 'each step scrolls to its element itself'],
  hover: ['Hovers', 'a hover is not a step: a menu that opens on hover needs a click on the menu'],
  keyUp: ['Key releases', 'pressing a key is one step: its release is not needed'],
  focus: ['Clicks into a field before typing', 'typing into a field focuses it, so the click before it is not needed'],
  xpath: ['XPath selectors', 'XPath selectors are not imported: each step keeps its other selectors'],
  pierce: ['Pierce selectors', 'pierce selectors (through shadow DOM) are not imported: each step keeps its other selectors'],
  puppeteer: ['Puppeteer selectors', 'Puppeteer-only selectors (::-p-…, >>>) are not imported: each step keeps its other selectors'],
  chain: ['Shadow DOM or frame selector chains', 'a selector chain through shadow DOM is not imported: each step keeps its other selectors'],
} as const;
type Counted = keyof typeof COUNTED;
/** A Map, so a step type such as `constructor` or `__proto__` is never mistaken for one of these. */
const SILENT = new Map<string, Counted>([['setViewport', 'viewport'], ['scroll', 'scroll'], ['hover', 'hover'], ['keyUp', 'keyUp']]);

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const error = (reason: string): ImportItem => ({ at: '', kind: 'error', what: WHAT, reason });

/**
 * Reads a recording's bytes or text as JSON, refusing more than MAX_CHROME_BYTES before anything is decoded or parsed.
 * undefined (and an `error` item) when it cannot be read. JSON.parse's own message quotes the input, which may hold a
 * typed password, so it is never copied into the report.
 */
export function readChromeJson(data: unknown, report: ImportReport): { value: unknown } | undefined {
  let text: string;
  if (typeof data === 'string') {
    // A string has no more UTF-16 units than UTF-8 bytes, so a long one is refused without measuring it.
    if (data.length > MAX_CHROME_BYTES || Buffer.byteLength(data, 'utf8') > MAX_CHROME_BYTES) { report.items.push(error(TOO_LARGE)); return undefined; }
    text = data;
  } else if (data instanceof Uint8Array) {
    if (data.byteLength > MAX_CHROME_BYTES) { report.items.push(error(TOO_LARGE)); return undefined; }
    text = new TextDecoder('utf-8').decode(data);
  } else {
    report.items.push(error(NOT_TEXT));
    return undefined;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    report.items.push(error(NOT_JSON));
    return undefined;
  }
}

/** The tag of the element a CSS selector names: the type selector of its last compound, lower case ('' when it has none). One linear scan. */
export function cssTargetTag(css: string): string {
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === '\'') quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === ',' || ch === '\t' || ch === '\n')) start = i + 1;
  }
  const m = /^[A-Za-z][A-Za-z0-9-]*/.exec(css.slice(start));
  return m ? m[0].toLowerCase() : '';
}

/**
 * An `aria/…` selector's accessible name and role. Puppeteer's syntax is the name followed by `[role="r"]` and/or
 * `[name="n"]` (a name attribute wins over the leading text); quotes are double, single or none.
 */
export function parseAria(rest: string): { name: string; role?: string } {
  let name = rest;
  const attrs: { name?: string; role?: string } = {};
  for (let k = 0; k < 4 && name.endsWith(']'); k++) {
    const open = name.lastIndexOf('[');
    if (open < 0) break;
    const m = /^\[\s*(name|role)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]"'\s]*))\s*\]$/.exec(name.slice(open));
    if (!m) break;
    attrs[m[1] as 'name' | 'role'] = m[2] ?? m[3] ?? m[4] ?? '';
    name = name.slice(0, open);
  }
  return { name: attrs.name ?? name, ...(attrs.role ? { role: attrs.role } : {}) };
}

interface Mapped {
  candidates: Candidate[];
  /** The accessible name or text the recorder saw, for intents. */
  label: string;
  /** Every selector string, for credential detection only (stripSecrets); never copied into steps. */
  hints: string[];
  /** A selector names a `<select>`: CSS tag `select`, or aria role combobox or listbox. */
  isSelect: boolean;
  counts: Partial<Record<Counted, number>>;
}

/**
 * A step's selectors as locator candidates, in the recorder's order:
 * - `aria/Name[role="r"]` gives `{ role, name, exact }` (the recorder writes the full accessible name, so exact).
 * - `aria/Name` gives label then text (exact) for a field, and text then label for anything else: a field is named by
 *   its label, a button or link by its text, and an icon button by its aria-label, which getByLabel finds.
 * - `text/X` gives `{ text: X }` (Puppeteer's text selector matches contained text, so not exact).
 * - CSS stays CSS (the draft builder drops ids that look generated).
 * - `xpath/`, `pierce/`, Puppeteer-only CSS (`::-p-…`, `>>>`) and chains (shadow DOM) are counted and dropped.
 */
function mapSelectors(raw: unknown, field: boolean): Mapped {
  const out: Mapped = { candidates: [], label: '', hints: [], isSelect: false, counts: {} };
  const count = (k: Counted) => { out.counts[k] = (out.counts[k] ?? 0) + 1; };
  const seen = new Set<string>();
  const add = (c: Candidate) => {
    const key = JSON.stringify(c);
    if (!seen.has(key)) { seen.add(key); out.candidates.push(c); }
  };
  let ariaName = '';
  let textName = '';
  for (const entry of Array.isArray(raw) ? raw : []) {
    let s: unknown = entry;
    if (Array.isArray(entry)) {
      for (const p of entry) if (typeof p === 'string') out.hints.push(p);
      if (entry.length > 1) { count('chain'); continue; }
      s = entry[0];
    }
    if (typeof s !== 'string' || !s.trim()) continue;
    if (!Array.isArray(entry)) out.hints.push(s);
    if (s.startsWith('aria/')) {
      const { name, role } = parseAria(s.slice(5));
      if (!name.trim()) continue;
      if (!ariaName) ariaName = name;
      if (role) {
        add({ role, name, exact: true });
        if (role === 'combobox' || role === 'listbox') out.isSelect = true;
      } else if (field) {
        add({ label: name, exact: true });
        add({ text: name, exact: true });
      } else {
        add({ text: name, exact: true });
        add({ label: name, exact: true });
      }
    } else if (s.startsWith('text/')) {
      const text = s.slice(5);
      if (!text.trim()) continue;
      if (!textName) textName = text;
      add({ text });
    } else if (s.startsWith('xpath/')) count('xpath');
    else if (s.startsWith('pierce/')) count('pierce');
    else if (s.includes('::-p-') || s.includes('>>>')) count('puppeteer');
    else {
      add({ css: s });
      if (cssTargetTag(s) === 'select') out.isSelect = true;
    }
  }
  out.candidates = out.candidates.slice(0, MAX_CANDIDATES);
  out.label = (ariaName || textName).trim();
  return out;
}

/** The first CSS candidate, to name an element that has no accessible name or text. */
const cssOf = (m: Mapped): string => {
  const c = m.candidates.find((x) => 'css' in x);
  return c && 'css' in c ? c.css : '';
};

/** Origin and path of a recorded address, for a report item (never its query, fragment or userinfo). */
function placeOf(url: string): string {
  if (URL.canParse(url)) {
    const u = new URL(url);
    return cleanLabel(`${u.host}${u.pathname === '/' ? '' : u.pathname}`);
  }
  return cleanLabel(url.split(/[?#]/)[0] ?? '');
}

/** The path an asserted navigation names (without query or fragment), or undefined. */
function navigationPath(url: string): string | undefined {
  if (URL.canParse(url)) {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.pathname : undefined;
  }
  return url.startsWith('/') ? (url.split(/[?#]/)[0] ?? undefined) : undefined;
}

/** A step's `target`, with the default written out. */
const targetOf = (step: Json): unknown => step.target ?? 'main';
/** A step's `frame` as a key: absent and empty are both the main frame. */
const frameOf = (step: Json): string => (Array.isArray(step.frame) && step.frame.length > 0 ? JSON.stringify(step.frame) : '[]');

/**
 * True when `click` only focuses the field `next` types into, so dropping the click loses nothing: `next` is a change
 * on the same selectors, in the same page and frame, that is itself imported (a string value, the main page and frame,
 * and at least one usable selector). Otherwise the click is kept, since nothing else would reach that element.
 */
function focusesNext(click: Json, next: unknown): boolean {
  if (!isObject(next) || next.type !== 'change' || typeof next.value !== 'string') return false;
  if (targetOf(next) !== targetOf(click) || targetOf(next) !== 'main' || frameOf(next) !== frameOf(click) || frameOf(next) !== '[]') return false;
  if (JSON.stringify(next.selectors) !== JSON.stringify(click.selectors)) return false;
  return mapSelectors(next.selectors, true).candidates.length > 0;
}

/**
 * A parsed Chrome Recorder export as import events, with what has no step equivalent added to `report`:
 * - navigate gives goto; click and doubleClick give click (a double click reported as converted); change gives fill, or
 *   select when a selector names a `<select>`; keyDown Enter gives enter; waitForElement (visible, one element) gives
 *   waitFor; an asserted navigation with a url gives expectUrl (its path).
 * - A click right before a change on the same selectors only focuses the field, and is dropped.
 * - A step in another tab or window (`target` other than main) or inside a frame is reported, not translated.
 * - setViewport, scroll, hover and keyUp are dropped and counted once; close, waitForExpression, customStep, other keys
 *   and unknown types are reported as untranslated.
 * - A value that is not a Chrome Recorder export, or one with more than MAX_CHROME_STEPS steps, gives an `error` item
 *   and no events.
 */
export function chromeEvents(json: unknown, report: ImportReport): ImportEvent[] {
  if (!isObject(json) || !Array.isArray(json.steps)) { report.items.push(error(NOT_A_RECORDING)); return []; }
  const steps: unknown[] = json.steps;
  if (steps.length > MAX_CHROME_STEPS) { report.items.push(error(TOO_MANY)); return []; }

  const events: ImportEvent[] = [];
  const counted = new Map<Counted, { at: string; n: number }>();
  const tally = (k: Counted, at: string, n = 1) => {
    const c = counted.get(k);
    if (c) c.n += n;
    else counted.set(k, { at, n });
  };
  const item = (at: string, kind: ImportItem['kind'], what: string, reason: string) => report.items.push({ at, kind, what, reason });
  const use = (m: Mapped, at: string) => { for (const [k, n] of Object.entries(m.counts)) tally(k as Counted, at, n); };
  /** The label of the last field typed into, for "Press Enter in …". */
  let lastField = '';

  const asserted = (step: Json, at: string) => {
    if (!Array.isArray(step.assertedEvents)) return;
    let path: string | undefined;
    let titleOnly = false;
    for (const ev of step.assertedEvents) {
      if (!isObject(ev) || ev.type !== 'navigation') continue;
      const p = typeof ev.url === 'string' ? navigationPath(ev.url) : undefined;
      if (p) path = p;
      else if (typeof ev.title === 'string') titleOnly = true;
    }
    if (path) events.push({ at, kind: 'expectUrl', path });
    else if (titleOnly) item(at, 'untranslated', 'Page title check', 'a page title check is not imported: only the address is checked');
  };

  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    if (!isObject(step) || typeof step.type !== 'string') { item(at, 'untranslated', 'An unreadable step', 'it is not a Chrome Recorder step'); return; }
    const type = step.type;
    const silent = SILENT.get(type);
    if (silent) { tally(silent, at); return; }

    const field = type === 'change';
    const mapped = 'selectors' in step ? mapSelectors(step.selectors, field) : undefined;
    const what = (): string => {
      const label = mapped?.label ? cleanLabel(mapped.label) : '';
      switch (type) {
        case 'navigate': return `Open ${typeof step.url === 'string' ? placeOf(step.url) : 'a page'}`;
        case 'click': case 'doubleClick': return `Click ${label || 'an element'}`;
        case 'change': return `Type into ${label || 'a field'}`;
        case 'waitForElement': return `Wait for ${label || (mapped && cleanLabel(cssOf(mapped))) || 'an element'}`;
        case 'keyDown': { const key = typeof step.key === 'string' ? NAMED_KEYS.get(step.key) : undefined; return key ? `Press ${key}` : 'Press a key'; }
        case 'close': return 'Close the page';
        case 'waitForExpression': return 'Wait for a JavaScript condition';
        case 'customStep': return 'Custom step';
        default: return `Step type "${cleanLabel(type)}"`;
      }
    };

    if (step.target !== undefined && step.target !== 'main') {
      item(at, 'untranslated', what(), 'it runs in another tab or window: steps follow one page, or a new tab opened with popup');
      return;
    }
    if (Array.isArray(step.frame) && step.frame.length > 0) {
      item(at, 'untranslated', what(), 'it runs inside a frame the recording names by position: add the step with a frame locator');
      return;
    }

    switch (type) {
      case 'navigate': {
        if (typeof step.url !== 'string' || !step.url) { item(at, 'untranslated', what(), 'the step has no address'); return; }
        events.push({ at, kind: 'goto', url: step.url });
        asserted(step, at);
        return;
      }
      case 'click':
      case 'doubleClick': {
        if (type === 'click' && focusesNext(step, steps[i + 1])) {
          tally('focus', at);
          return;
        }
        const m = mapped ?? mapSelectors(undefined, false);
        use(m, at);
        if (m.candidates.length === 0) { item(at, 'dropped', what(), NO_SELECTOR); return; }
        if (type === 'doubleClick') item(at, 'converted', what(), 'a double click became a single click: check that one click does the same');
        events.push({ at, kind: 'click', target: m.candidates, label: m.label });
        asserted(step, at);
        return;
      }
      case 'change': {
        const m = mapped ?? mapSelectors(undefined, true);
        use(m, at);
        if (typeof step.value !== 'string') { item(at, 'untranslated', what(), 'the step has no typed value'); return; }
        if (m.candidates.length === 0) { item(at, 'dropped', what(), NO_SELECTOR); return; }
        // The value goes to stripSecrets in this event and nowhere else: a credential's is dropped there.
        events.push({ at, kind: m.isSelect ? 'select' : 'fill', target: m.candidates, label: m.label, value: step.value, hints: m.hints });
        lastField = m.label;
        asserted(step, at);
        return;
      }
      case 'keyDown': {
        if (typeof step.key === 'string' && ENTER.has(step.key)) {
          events.push({ at, kind: 'enter', label: lastField });
          asserted(step, at);
          return;
        }
        item(at, 'untranslated', what(), 'only Enter is imported: add a step for what this key does');
        return;
      }
      case 'waitForElement': {
        const m = mapped ?? mapSelectors(undefined, false);
        use(m, at);
        const count = step.count === undefined ? 1 : step.count;
        const operator = step.operator === undefined ? '==' : step.operator;
        if (step.visible === false || count !== 1 || operator === '<=' || step.properties !== undefined || step.attributes !== undefined) {
          item(at, 'untranslated', what(), 'only a wait for one visible element is imported: waits for absence, counts, properties or attributes are not');
          return;
        }
        if (m.candidates.length === 0) { item(at, 'dropped', what(), NO_SELECTOR); return; }
        events.push({ at, kind: 'waitFor', target: m.candidates, label: m.label });
        return;
      }
      case 'close':
        item(at, 'untranslated', what(), 'the run closes the browser itself when the steps end');
        return;
      case 'waitForExpression':
        item(at, 'untranslated', what(), 'steps do not run page JavaScript: add a waitFor on what the page shows when it is ready');
        return;
      case 'customStep':
        item(at, 'untranslated', what(), 'a custom step is a Puppeteer extension the steps cannot run');
        return;
      default:
        item(at, 'untranslated', what(), 'this step type is not imported');
    }
  });

  for (const k of Object.keys(COUNTED) as Counted[]) {
    const c = counted.get(k);
    if (c) item(c.at, 'dropped', `${COUNTED[k][0]} (${c.n})`, COUNTED[k][1]);
  }
  return events;
}
