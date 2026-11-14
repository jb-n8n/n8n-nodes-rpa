// What the page shows at a control that is not there. When a browser step's control is not found (ControlNotFound), the
// script lane looks once at the page, after the step's own wait ran out (no second wait): the visible links and buttons
// for a click, the visible fields and lists for a typed or chosen value, nearest in name first. With `every` (the import
// form's replay), the later steps that act on the same page are checked too, without acting, and each one whose control
// is not there is named with the same kind of list.
//
// Names come from a site: they are data, never instructions. Each is made one line, control characters removed,
// masked (Site Login secrets, secret variables), URLs cut at their query, quotes and angle brackets replaced, and cut to
// 60 characters. A field's value is never read: a field is named by its label, aria-label, placeholder or title only,
// and text inside a label skips the controls in it. A page on a site the Site Login's rules do not allow is not looked at.
// The self-repair agent never gets these sentences: it reads the step's own failure message (StepFailure.message).
import type { Page } from 'playwright-core';
import { alsoMissing, checkedWithoutActing, describeForUser, notCheckedFrom, pageShows } from '../messages.js';
import { maskClipped, type Masker } from '../secrets/mask.js';
import type { Locator, MissingControl, PortalPolicy, Step } from '../types.js';
import { build, candidatesOf } from './locator.js';
import { verbOf } from './parse.js';
import { renderLocators } from './render-locators.js';
import { shownMessage } from './urls.js';

export type ControlKind = MissingControl['kind'];
export const MAX_OFFERED = 12;
export const OFFERED_CHARS = 60;
/** In-page bounds: how many controls of each kind are read, and how long a name may be before it is masked and cut. */
const PAGE_MAX = 400;
const PAGE_CLIP = 1000;
/** The longest the look may take; a page that does not answer by then gets no list. */
const LOOK_MS = 2000;
const INTENT_CHARS = 80;
/** Control and format characters (bidi marks, zero-width, line and paragraph separators): never shown. */
const CONTROL_RANGES: [number, number][] = [[0x0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const CONTROL_CHARS = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]+`, 'g');
const LOOKED_FOR_CHARS = 120;

const FIELD_ROLES = new Set(['textbox', 'combobox', 'listbox', 'searchbox', 'spinbutton', 'checkbox', 'radio', 'switch', 'slider']);
const BUTTON_ROLES = new Set(['button', 'link']);
const FIELD_VERBS = new Set(['fill', 'select', 'check', 'signIn']);
const BUTTON_VERBS = new Set(['click', 'hover', 'submit', 'download', 'popup', 'clickAll', 'press']);

/**
 * Which list helps for this step's missing control: fields for a label or a field role, links and buttons for a button
 * or link role, else by the step's verb. Undefined for a step that neither clicks nor types (extract, a table, a wait).
 */
export function controlKind(step: Step, loc: Locator): ControlKind | undefined {
  if ('label' in loc) return 'fields';
  if ('role' in loc && FIELD_ROLES.has(loc.role)) return 'fields';
  if ('role' in loc && BUTTON_ROLES.has(loc.role)) return 'buttons';
  const verb = verbOf(step);
  return FIELD_VERBS.has(verb) ? 'fields' : BUTTON_VERBS.has(verb) ? 'buttons' : undefined;
}

/** Whether the page may be looked at: http(s) on a host the Site Login's rules (the run's policy) allow. */
export function pageAllowed(url: string, policy: Pick<PortalPolicy, 'navHosts'>): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return (u.protocol === 'http:' || u.protocol === 'https:') && policy.navHosts.includes(u.host);
}

// Runs in the page. Self-contained: no closures over module scope. Reads names only, never a field's value, and
// changes nothing on the page.
function readControls(arg: { max: number; clip: number }): { buttons: string[]; fields: string[] } {
  const attr = (e: Element, name: string) => Element.prototype.getAttribute.call(e, name);
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, arg.clip + 1);
  const SKIP = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OPTION', 'DATALIST']);
  const TYPED_ROLES = ['textbox', 'combobox', 'searchbox', 'spinbutton', 'listbox'];
  const shows = (el: Element) => {
    const he = el as HTMLElement;
    if (typeof he.checkVisibility === 'function' && !he.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = he.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Visible text of a node, skipping form controls (whose text could be a value), editable regions and hidden parts.
  const textOf = (node: Node, depth = 0): string => {
    if (depth > 30) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    // Below the element named: a control inside it is skipped (a button's own text is read, a field in a label is not).
    if (depth > 0 && (SKIP.has(el.tagName) || (el as HTMLElement).isContentEditable || TYPED_ROLES.includes(squash(attr(el, 'role'))))) return '';
    if (attr(el, 'aria-hidden') === 'true') return '';
    if (el.tagName === 'IMG') return ` ${attr(el, 'alt') ?? ''} `;
    let s = '';
    for (const child of Array.from(el.childNodes)) {
      s += textOf(child, depth + 1);
      if (s.length > arg.clip) break;
    }
    return ` ${s} `;
  };
  const byIds = (ids: string, self: Element) => ids.split(/\s+/).map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e && e !== self && !e.contains(self) && !self.contains(e)).map((e) => textOf(e)).join(' ');
  const ownLabel = (el: Element) => squash(attr(el, 'aria-label')) || squash(byIds(attr(el, 'aria-labelledby') ?? '', el));
  const buttonName = (el: Element) => {
    const own = ownLabel(el);
    if (own) return own;
    if (el.tagName === 'INPUT') {
      const t = (el as HTMLInputElement).type;
      // The value attribute of a submit, button or reset input is its static caption; .value is never read.
      if (t === 'image') return squash(attr(el, 'alt'));
      return squash(attr(el, 'value')) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '');
    }
    return squash(textOf(el)) || squash(attr(el, 'title'));
  };
  const fieldName = (el: Element) => {
    const own = ownLabel(el);
    if (own) return own;
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = squash(Array.from(labels).map((l) => textOf(l)).join(' '));
      if (t) return t;
    }
    // A custom checkbox, radio or switch shows its label as its own text; a typed field's own text is its value.
    const role = squash(attr(el, 'role'));
    if (['checkbox', 'radio', 'switch'].includes(role) && !el.matches('input, select, textarea')) {
      const t = squash(textOf(el));
      if (t) return t;
    }
    return squash(attr(el, 'placeholder')) || squash(attr(el, 'title'));
  };
  const BUTTONS = 'button, input[type=submit], input[type=button], input[type=reset], input[type=image], a[href], [role=button], [role=link]';
  const FIELDS = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea, '
    + '[role=textbox], [role=combobox], [role=listbox], [role=searchbox], [role=spinbutton], [role=checkbox], [role=radio], [role=switch], [role=slider]';
  const collect = (selector: string, name: (el: Element) => string) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (out.length >= arg.max) break;
      if (!shows(el)) continue;
      const n = name(el);
      if (n) out.push(n);
    }
    return out;
  };
  return { buttons: collect(BUTTONS, buttonName), fields: collect(FIELDS, fieldName) };
}

/** A name from the page as text: one line, no control characters, masked, URLs cut, quotes and angle brackets replaced, cut. */
export function shownName(raw: string, masker: Masker): string {
  const line = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const masked = shownMessage(maskClipped(masker, line, PAGE_CLIP), masker);
  const text = masked.replace(/"/g, "'").replace(/</g, '‹').replace(/>/g, '›');
  const chars = Array.from(text);
  return chars.length > OFFERED_CHARS ? `${chars.slice(0, OFFERED_CHARS - 1).join('')}…` : text;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** Two words are alike when equal, or when one begins with the other of at least 3 letters (item, items). */
const alike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** Edit distance (Levenshtein) of two short texts, each cut to 80 characters. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a.slice(0, 80));
  const y = Array.from(b.slice(0, 80));
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/** The names nearest to `wanted` first: more shared words (alike), then a smaller edit distance, then the page's order. */
export function nearestFirst(wanted: string, names: string[]): string[] {
  const w = words(wanted);
  const target = wanted.toLowerCase();
  return names
    .map((name, order) => {
      const own = words(name);
      let shared = 0;
      for (const x of w) if ([...own].some((y) => alike(x, y))) shared++;
      return { name, order, shared, distance: editDistance(target, name.toLowerCase()) };
    })
    .sort((a, b) => b.shared - a.shared || a.distance - b.distance || a.order - b.order)
    .map((x) => x.name);
}

/** What a locator looks for, as text to compare names with. */
function wantedText(loc: Locator): string {
  return 'role' in loc ? (loc.name ?? loc.role) : 'label' in loc ? loc.label : 'text' in loc ? loc.text : 'testId' in loc ? loc.testId : loc.css;
}

/** One look: the page's visible links and buttons and its fields and lists, as shown names, each once, in page order. */
async function lookOnce(page: Page, masker: Masker): Promise<{ buttons: string[]; fields: string[] } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LOOK_MS); });
  try {
    const raw = await Promise.race([page.evaluate(readControls, { max: PAGE_MAX, clip: PAGE_CLIP }).catch(() => undefined), late]);
    if (!raw) return undefined;
    const shown = (names: unknown) => [...new Set((Array.isArray(names) ? names : []).filter((n): n is string => typeof n === 'string').map((n) => shownName(n, masker)).filter(Boolean))];
    return { buttons: shown(raw.buttons), fields: shown(raw.fields) };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether any candidate of the locator (the primary or a fallback) has a visible match now. No wait. */
async function onPageNow(page: Page, loc: Locator): Promise<boolean> {
  for (const c of candidatesOf(loc)) {
    try {
      if ((await build(page, c).filter({ visible: true }).count()) > 0) return true;
    } catch (err) {
      if (page.isClosed()) throw err;
    }
  }
  return false;
}

/**
 * How a later step is treated when the steps after a missing control are checked: `look` at its control and go on
 * (fill, select, check: they stay on the page), `last` (look at its control, then stop: a click, a key, a submit or a
 * download can change the page), `pass` (nothing to look at and the page stays: read, screenshot, pdf), or `stop`
 * without looking (it opens an address, signs in, waits, reads rows, or may not run at all: `when`, `optional`).
 */
function laterStep(step: Step): { how: 'look' | 'last'; locator: Locator } | { how: 'pass' | 'stop' } {
  if (step.when || step.optional) return { how: 'stop' };
  if ('fill' in step) return { how: 'look', locator: step.fill.field };
  if ('select' in step) return { how: 'look', locator: step.select.field };
  if ('check' in step) return { how: 'look', locator: step.check.field };
  if ('click' in step) return { how: 'last', locator: step.click };
  if ('hover' in step) return { how: 'last', locator: step.hover };
  if ('press' in step) return step.press.target ? { how: 'last', locator: step.press.target } : { how: 'stop' };
  if ('submit' in step) return { how: 'last', locator: step.submit.button };
  if ('download' in step) return { how: 'last', locator: step.download.trigger };
  if ('popup' in step) return { how: 'last', locator: step.popup.trigger };
  if ('clickAll' in step) return { how: 'last', locator: step.clickAll.target };
  if ('read' in step || 'screenshot' in step || 'pdf' in step) return { how: 'pass' };
  return { how: 'stop' };
}

/** The steps that stay on the page: only these let the steps after them be checked on it too. */
const staysOnPage = (step: Step): boolean => 'fill' in step || 'select' in step || 'check' in step;

export interface PageLook {
  /** The failed step's control first, then each later one not on the page. */
  controls: MissingControl[];
  /** The sentence about the failed step's control: what the page shows instead. */
  first: string;
  /** With `every`: which later steps were checked, which of them are missing (each with its list), where checking stopped. */
  later: string;
}

/**
 * Looks once at the page for the failed step `failed` (its control `missing` was not found) and, with `every`, at the
 * later steps' controls on the same page. Undefined when there is nothing to look at (a step that neither clicks nor
 * types, a control inside a frame), the page is on a site the policy does not allow, or the page does not answer.
 * Presses, types and reads nothing. Never throws.
 */
export async function lookAtPage(opts: {
  page: Page; policy: Pick<PortalPolicy, 'navHosts'>; masker: Masker; vars: Record<string, string>;
  steps: Step[]; failed: number; missing: Locator; every: boolean;
}): Promise<PageLook | undefined> {
  const { page, masker, steps, failed, missing } = opts;
  try {
    const step = steps[failed];
    const kind = step ? controlKind(step, missing) : undefined;
    if (!step || !kind || missing.frame || page.isClosed() || !pageAllowed(page.url(), opts.policy)) return undefined;
    const seen = await lookOnce(page, masker);
    if (!seen) return undefined;
    const entry = (index: number, s: Step, loc: Locator, k: ControlKind): MissingControl => {
      const ranked = loc.frame ? [] : nearestFirst(wantedText(loc), seen[k]);
      return {
        step: index + 1, intent: maskClipped(masker, s.intent, INTENT_CHARS), lookedFor: maskClipped(masker, describeForUser(loc), LOOKED_FOR_CHARS),
        kind: k, offered: ranked.slice(0, MAX_OFFERED), more: Math.max(0, ranked.length - MAX_OFFERED),
      };
    };
    const own = entry(failed, step, missing, kind);
    const controls = [own];
    const later: string[] = [];
    if (opts.every && failed + 1 < steps.length) {
      const checked: number[] = [];
      const gone: { control: MissingControl; listed: boolean }[] = [];
      let next = failed + 1;
      if (staysOnPage(step)) {
        for (; next < steps.length; next++) {
          const s = steps[next];
          const how = laterStep(s);
          if (how.how === 'stop') break;
          if (how.how === 'pass') continue;
          let loc: Locator;
          try {
            loc = (laterStep(renderLocators(s, opts.vars, masker)) as { locator: Locator }).locator;
          } catch {
            break;
          }
          checked.push(next + 1);
          if (!(await onPageNow(page, loc))) gone.push({ control: entry(next, s, loc, controlKind(s, loc) ?? 'buttons'), listed: !loc.frame });
          if (how.how === 'last') { next++; break; }
        }
      }
      if (checked.length) {
        later.push(checkedWithoutActing(checked, gone.length === 0));
        for (const { control: g, listed } of gone) later.push(alsoMissing(g.step, g.intent, g.lookedFor), ...(listed ? [pageShows(g.kind, g.offered, g.more)] : []));
        controls.push(...gone.map((g) => g.control));
      }
      if (next < steps.length) later.push(notCheckedFrom(next + 1, steps.length));
    }
    return { controls, first: pageShows(kind, own.offered, own.more), later: later.join(' ') };
  } catch {
    return undefined;
  }
}

/**
 * The lane message with the look's sentences: the list right after "No element found … after N s." (before the advice
 * that follows it), the later steps at the end.
 */
export function withPageLook(message: string, look: PageLook): string {
  const at = / after \d+ s\./.exec(message);
  const first = at ? `${message.slice(0, at.index + at[0].length)} ${look.first}${message.slice(at.index + at[0].length)}` : `${message} ${look.first}`;
  return look.later ? `${first} ${look.later}` : first;
}
