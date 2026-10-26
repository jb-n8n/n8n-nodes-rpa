import type { Page } from 'playwright-core';
import { CARD_AUTOCOMPLETE, hidesValue, SNAPSHOT_HIDDEN_FIELD } from '../secrets/credential-field.js';
import { maskClipped, type Masker } from '../secrets/mask.js';
import { formTarget } from '../steps/form-target.js';

export interface SnapshotElement {
  /** Engine-assigned reference (e1, e2, …), unique within one run and valid only until the next snapshot. */
  ref: string;
  /** ARIA role as Playwright's getByRole matches it; '' when there is none (password inputs, summary, generic). */
  role: string;
  /** Masked, clipped to 80 characters. For display. */
  name: string;
  /** Masked accessible name up to 500 characters. Safety checks (destructive denylist) must use this, not `name`. */
  fullName: string;
  /** Masked visible text (up to 200 characters), only when it differs from the accessible name. */
  visibleText?: string;
  tag: string;
  type?: string;
  /** Path for same-origin links, origin + path otherwise. Never a query or fragment. */
  href?: string;
  /**
   * Where activating the element navigates, query included (fragment dropped): a link's URL, or for a submit control
   * the URL its form submits to (formaction or action; for a GET form, with the form's fields as the query). Masked and
   * clipped. Never shown to the model: only the destructive check reads it.
   */
  target?: string;
  /** The target was longer than the snapshot keeps, so it cannot be checked in full: the destructive check refuses it. */
  targetClipped?: true;
  /**
   * What the field holds now: a text-like input's or a textarea's value, or a select's selected option labels. Masked,
   * control characters removed, clipped to 80 characters; absent when empty. Read-only and disabled fields show theirs
   * on purpose (a computed total tells the agent where it is). Never for a password field, a hidden one, one the page
   * masks like a password with -webkit-text-security, or one whose texts or autocomplete look like a credential
   * (hidesValue); a page that masks a field with a symbol font instead is not detected (the masker still covers every
   * Site Login secret). None at all on a declared login page (SnapshotOptions.values).
   */
  value?: string;
  /** A field whose value is hidden for the reasons above holds something (only that, never its content). */
  valueHidden?: true;
  /** Ref of the covering overlay this element sits in. */
  overlay?: string;
  /**
   * ARIA and native toggle states (aria-selected, aria-expanded, aria-checked, aria-pressed, checked), e.g.
   * "selected=true expanded=false". Only part of the page-state fingerprint; never shown to the model.
   */
  states?: string;
}
export interface Snapshot {
  /** Origin + pathname of the page. */
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  overlays: string[];
}
export interface SnapshotOptions {
  /** First ref number to assign. The caller keeps the counter so refs never repeat in a run, even across navigations. */
  refStart?: number;
  maxElements?: number;
  maxText?: number;
  /** Read field values (SnapshotElement.value, valueHidden). Default true; false on a declared login page. */
  values?: boolean;
}

export const REF_ATTR = 'data-pw-ref';
const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=option], [onclick]';

interface RawElement {
  ref: string; role: string; name: string; visible: string; tag: string; type?: string; href?: string; target?: string; targetClipped?: true;
  overlay?: string; states?: string;
  /** The field's raw value (clipped like a name), when not empty and the page found no reason to hide it. shownValue filters it again. */
  value?: string;
  /** The raw value was longer than the page reads: shownValue drops a tail that may be a cut secret. */
  valueCut?: true;
  /** The field's own texts (name, id, aria-label, placeholder, title, label) and autocomplete, for the credential check. */
  fieldTexts?: string[];
  autocomplete?: string;
  /** A field hidden for policy reasons holds something; its content is never read into the result. */
  hasValue?: true;
}
interface RawSnapshot {
  title: string;
  text: string;
  elements: RawElement[];
  overlays: string[];
  next: number;
}

/** In-page bounds of a name or visible text, and of the page text. */
const PAGE_CLIP = 1000;
const PAGE_TEXT = 200_000;
/** In-page bound of each of a field's own texts (RawElement.fieldTexts). */
const FIELD_TEXT_CLIP = 200;
/** In-page bound of an element's navigation target (SnapshotElement.target). */
const TARGET_CLIP = 8192;

/** What collect lists and how it bounds it, the same for every call. */
/** How much of a raw value the page reads (and joins of a multi-select's labels) before cleaning and clipping it. */
const VALUE_READ = 4 * PAGE_CLIP;
const PAGE_ARGS = {
  selector: INTERACTIVE, attr: REF_ATTR, clipAt: PAGE_CLIP, textAt: PAGE_TEXT, targetAt: TARGET_CLIP, fieldTextAt: FIELD_TEXT_CLIP, valueRead: VALUE_READ,
  // The page checks a field's texts with the same patterns as hidesValue, so a hidden field's content never leaves it.
  hidden: SNAPSHOT_HIDDEN_FIELD.map((re) => re.source), card: CARD_AUTOCOMPLETE.source,
};
type CollectArg = typeof PAGE_ARGS & { start: number; max: number; verify?: string; values?: boolean };

/**
 * Runs collect in the page with formTarget as its second argument. Both are self-contained page functions, so the
 * page gets their sources joined into one expression, the argument JSON-encoded (one round trip; page.evaluate cannot
 * pass a function).
 */
function collectIn(page: Page, arg: CollectArg): Promise<RawSnapshot> {
  return page.evaluate(`(${collect.toString()})(${JSON.stringify(arg)}, ${formTarget.toString()})`) as Promise<RawSnapshot>;
}

// Runs in the page (collectIn). Self-contained: no closures over module scope.
function collect(arg: CollectArg, targetOf: typeof formTarget): RawSnapshot {
  // Attributes through the prototype: a form control named "getAttribute" (or hasAttribute, setAttribute) shadows the
  // method on its <form>, and the walks below can reach a form.
  const attr = (e: Element, name: string) => Element.prototype.getAttribute.call(e, name);
  const hasAttr = (e: Element, name: string) => Element.prototype.hasAttribute.call(e, name);
  const setAttr = (e: Element, name: string, value: string) => Element.prototype.setAttribute.call(e, name, value);
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  // Bounds what crosses to Node: one character past the limit, so the caller can tell a cut field (maskClipped drops a
  // partial secret at the cut; masking alone cannot).
  const clip = (s: string | null | undefined) => squash(s).slice(0, arg.clipAt + 1);
  if (!arg.verify) for (const el of Array.from(document.querySelectorAll(`[${arg.attr}]`))) Element.prototype.removeAttribute.call(el, arg.attr);
  let next = arg.start;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const overlayRefs = new Map<Element, string>();
  const overlayOf = (el: Element): string | undefined => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.position === 'fixed' || cs.position === 'sticky') && (parseInt(cs.zIndex, 10) || 0) > 0) {
        const r = n.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        if (w * h >= 0.3 * vw * vh) {
          let ref = overlayRefs.get(n) ?? attr(n, arg.attr) ?? undefined;
          if (!ref) {
            ref = `e${next++}`;
            setAttr(n, arg.attr, ref);
          }
          overlayRefs.set(n, ref);
          return ref;
        }
      }
    }
    return undefined;
  };
  const roleOf = (el: Element): string => {
    const explicit = squash(attr(el, 'role'));
    if (explicit) return explicit.split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A') return hasAttr(el, 'href') ? 'link' : '';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type;
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'search') return 'searchbox';
      if (t === 'number') return 'spinbutton';
      if (t === 'range') return 'slider';
      if (['text', 'email', 'tel', 'url', ''].includes(t)) return 'textbox';
      return '';
    }
    return '';
  };
  const nameOf = (el: Element): string => {
    const aria = clip(attr(el, 'aria-label'));
    if (aria) return aria;
    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy) {
      const t = clip(labelledBy.split(/\s+/).map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText ?? '').join(' '));
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const label = clip((el as HTMLInputElement).labels?.[0]?.innerText);
      if (label) return label;
      // The value attribute of a submit/button/reset input is its static caption; .value is never read.
      if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes((el as HTMLInputElement).type)) return clip(attr(el, 'value') ?? (el as HTMLInputElement).type);
      return clip(attr(el, 'placeholder') || attr(el, 'title') || attr(el, 'name'));
    }
    const alts = Array.from(el.querySelectorAll('img[alt]')).map((i) => attr(i, 'alt') ?? '').join(' ');
    return clip((el as HTMLElement).innerText || alts || attr(el, 'title'));
  };
  // A field's current value: a text-like input's, a textarea's, or a select's selected option labels, read up to
  // valueRead characters. `hidden`: a password input (by its type or declared type), a declared hidden one, one the page
  // masks like a password with -webkit-text-security, or one whose texts or autocomplete look like a credential; for it
  // only whether it holds something is read. Undefined for every other element.
  const TEXT_TYPES = ['text', 'email', 'tel', 'url', 'search', 'number', 'date', 'datetime-local', 'month', 'week', 'time'];
  const hiddenRes = arg.hidden.map((src) => new RegExp(src, 'i'));
  const cardRe = new RegExp(arg.card, 'i');
  const fieldTexts = (el: Element): string[] => {
    const own = ['name', 'id', 'aria-label', 'placeholder', 'title'].map((k) => attr(el, k));
    const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.innerText);
    return [...own, ...labels].map((t) => squash(t).slice(0, arg.fieldTextAt)).filter(Boolean);
  };
  type FieldValue = { hidden: boolean; has: boolean; read: () => { text: string; cut: boolean } };
  const fieldValue = (el: Element, name: string): FieldValue | undefined => {
    const tag = el.tagName;
    let hidden = false;
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type;
      const declared = squash(attr(el, 'type')).toLowerCase();
      if (!TEXT_TYPES.includes(t) && t !== 'password') return undefined;
      hidden = t === 'password' || declared === 'password' || declared === 'hidden';
    } else if (tag !== 'TEXTAREA' && tag !== 'SELECT') return undefined;
    const security = getComputedStyle(el).getPropertyValue('-webkit-text-security');
    if (security && security !== 'none') hidden = true;
    const ac = squash(attr(el, 'autocomplete')).slice(0, arg.fieldTextAt);
    if (cardRe.test(ac) || [name, ac, ...fieldTexts(el)].some((t) => hiddenRes.some((re) => re.test(t)))) hidden = true;
    if (tag === 'SELECT') {
      const s = el as HTMLSelectElement;
      return {
        hidden, has: s.selectedIndex >= 0,
        read: () => {
          let text = '';
          for (const o of Array.from(s.selectedOptions)) {
            text += (text ? ', ' : '') + o.label.slice(0, arg.valueRead);
            if (text.length > arg.valueRead) return { text: text.slice(0, arg.valueRead), cut: true };
          }
          return { text, cut: false };
        },
      };
    }
    const v = el as HTMLInputElement | HTMLTextAreaElement;
    return { hidden, has: v.value !== '', read: () => ({ text: v.value.slice(0, arg.valueRead), cut: v.value.length > arg.valueRead }) };
  };
  if (arg.verify) {
    const el = document.querySelector(`[${arg.attr}="${arg.verify}"]`);
    const found = el ? [{ ref: arg.verify, role: roleOf(el), name: nameOf(el), visible: '', tag: '' }] : [];
    return { title: '', text: '', elements: found, overlays: [], next };
  }
  const elements: RawElement[] = [];
  // Covering overlays first, so a late cookie banner is never lost behind the element cap.
  const visible: { el: Element; overlay?: string }[] = [];
  for (const el of Array.from(document.querySelectorAll(arg.selector))) {
    const he = el as HTMLElement;
    if (typeof he.checkVisibility === 'function' && !he.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const rect = he.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    visible.push({ el, overlay: overlayOf(el) });
  }
  const ordered = [...visible.filter((v) => v.overlay), ...visible.filter((v) => !v.overlay)];
  for (const { el, overlay } of ordered) {
    if (elements.length >= arg.max) break;
    if (hasAttr(el, arg.attr)) continue; // already an overlay container
    const ref = `e${next++}`;
    setAttr(el, arg.attr, ref);
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    const item: RawElement = { ref, role: roleOf(el), name, visible: clip((el as HTMLElement).innerText), tag };
    if (tag === 'input') item.type = (el as HTMLInputElement).type;
    const field = arg.values === false ? undefined : fieldValue(el, name);
    if (field?.hidden) {
      if (field.has) item.hasValue = true;
    } else if (field?.has) {
      const { text, cut } = field.read();
      const value = clip(text);
      if (value) {
        item.value = value;
        if (cut) item.valueCut = true;
        item.fieldTexts = fieldTexts(el);
        const ac = squash(attr(el, 'autocomplete')).slice(0, arg.fieldTextAt);
        if (ac) item.autocomplete = ac;
      }
    }
    if (tag === 'a') {
      try {
        const u = new URL((el as HTMLAnchorElement).href);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          item.href = u.origin === location.origin ? u.pathname : `${u.origin}${u.pathname}`;
          item.target = `${u.origin}${u.pathname}${u.search}`;
        }
      } catch { /* not a navigable link */ }
    }
    // A submit control (or an element inside one): the URL its form goes to, as the browser would build it (a GET form
    // puts its fields in the query). An action that is not a URL submits nothing. Should the page make the lookup
    // throw, the element is refused rather than passed unchecked.
    if (tag !== 'a') {
      try {
        const t = targetOf(el, true);
        if (t && URL.canParse(t.action)) {
          const u = new URL(t.action);
          item.target = `${u.origin}${u.pathname}${u.search}`;
        }
      } catch { item.targetClipped = true; }
    }
    if (item.target !== undefined && item.target.length > arg.targetAt) {
      item.target = item.target.slice(0, arg.targetAt);
      item.targetClipped = true;
    }
    if (overlay) item.overlay = overlay;
    const states = ['selected', 'expanded', 'checked', 'pressed'].flatMap((k) => {
      const v = attr(el, `aria-${k}`);
      return v === null ? [] : [`${k}=${v}`];
    });
    if (tag === 'input' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type)) states.push(`native=${(el as HTMLInputElement).checked}`);
    if (states.length) item.states = states.join(' ');
    elements.push(item);
  }
  return { title: document.title, text: squash(document.body?.innerText).slice(0, arg.textAt + 1), elements, overlays: [...new Set(overlayRefs.values())], next };
}

/**
 * Masks first, then clips, so a secret straddling a length limit is never exposed in part. A name longer than the
 * in-page clip was cut there: its partial tail is dropped as well (maskClipped).
 */
export function maskedName(masker: Masker, rawName: string): { name: string; fullName: string } {
  const full = maskClipped(masker, rawName, PAGE_CLIP);
  return { name: full.slice(0, 80), fullName: full.slice(0, 500) };
}

/** Characters a shown value never keeps: controls (whitespace becomes a space) and invisible format characters. */
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const SHOWN_VALUE = 80;

/**
 * What the model may see of a field's value: `hidden` for a field the page reported holding something it may not
 * show, and for a password or hidden field or one whose texts, name or autocomplete look like a credential (checked
 * again here: the page's check runs in a world the page controls); else the value cleaned of control characters,
 * masked, then clipped. A value cut in the page (longer than the in-page clip, or than it reads) drops its partial tail
 * as well (as maskClipped).
 */
function shownValue(masker: Masker, e: RawElement): { value: string } | { hidden: true } | undefined {
  if (e.hasValue) return { hidden: true };
  if (!e.value) return undefined;
  if (e.type === 'password' || e.type === 'hidden' || hidesValue([e.name, ...(e.fieldTexts ?? [])], e.autocomplete)) return { hidden: true };
  const cut = e.valueCut === true || e.value.length > PAGE_CLIP;
  const clean = e.value.slice(0, PAGE_CLIP).replace(CONTROL, (c) => (/\s/.test(c) ? ' ' : '')).replace(/\s+/g, ' ').trim();
  let masked = masker.mask(clean);
  if (cut) masked = masked.slice(0, Math.max(0, masked.length - masker.maxLength));
  const value = masked.slice(0, SHOWN_VALUE);
  return value ? { value } : undefined;
}

/** Role and masked name of whatever element currently carries `ref`, computed with the snapshot's own logic. */
export async function currentIdentity(page: Page, masker: Masker, ref: string): Promise<{ role: string; name: string } | undefined> {
  const raw = await collectIn(page, { ...PAGE_ARGS, start: 0, max: 0, verify: ref });
  const e = raw.elements[0];
  return e ? { role: e.role, name: maskedName(masker, e.name).name } : undefined;
}

/** Masked, ref-annotated view of the current page for the model. Refs are fresh; earlier refs stop resolving. */
export async function snapshot(page: Page, masker: Masker, opts: SnapshotOptions = {}): Promise<Snapshot & { nextRef: number }> {
  const raw = await collectIn(page, { ...PAGE_ARGS, start: opts.refStart ?? 1, max: opts.maxElements ?? 120, values: opts.values !== false });
  let url = page.url();
  try { const u = new URL(url); url = `${u.origin}${u.pathname}`; } catch { /* keep as is */ }
  return {
    url: masker.mask(url),
    title: masker.mask(raw.title).slice(0, 200),
    // Mask the whole text first so a secret cut by the limit cannot leak partially (and drop a tail cut in the page).
    text: maskClipped(masker, raw.text, PAGE_TEXT).slice(0, opts.maxText ?? 4000),
    elements: raw.elements.map((r) => {
      const { name: rawName, visible, value: _value, valueCut: _cut, fieldTexts: _texts, autocomplete: _ac, hasValue: _has, ...e } = r;
      const n = maskedName(masker, rawName);
      const vis = maskClipped(masker, visible, PAGE_CLIP).slice(0, 200);
      const shown = opts.values === false ? undefined : shownValue(masker, r);
      return {
        ...e, ...n, ...(vis && vis !== n.fullName.slice(0, 200) ? { visibleText: vis } : {}), ...(e.href ? { href: masker.mask(e.href) } : {}),
        ...(e.target ? { target: masker.mask(e.target) } : {}), ...(shown && 'value' in shown ? { value: shown.value } : {}), ...(shown && 'hidden' in shown ? { valueHidden: true as const } : {}),
      };
    }),
    overlays: raw.overlays,
    nextRef: raw.next,
  };
}
