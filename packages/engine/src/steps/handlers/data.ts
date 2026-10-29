import type { Locator as PwLocator } from 'playwright-core';
import { describeForUser, locatorNotUnique, tooManyRows } from '../../messages.js';
import type { Masker } from '../../secrets/mask.js';
import { MAX_ROWS, type FieldSpec, type Locator, type Row, type Step } from '../../types.js';
import { build, firstPresent, resolveUnique } from '../locator.js';
import { poll } from '../poll.js';
import { runSteps, settle, type Handler } from '../run.js';
import { registerHandlers } from './index.js';
import { DETECTED_PREFIX } from '../../classify/classify.js';
import { assertRowTextRoom, regexMatches, regexSubject } from '../limits.js';

const DEFAULT_NEXT_WAIT_MS = 1500;
/** Nested failures whose prefix drives classification keep their message unchanged. */
const VERBATIM = [DETECTED_PREFIX, 'download ', 'paginate:', 'limit: ', 'capture: '];

type S<K extends string> = Extract<Step, Record<K, unknown>>;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The text of one element or of a list of elements, run inside the page (it must stay self-contained: Playwright
 * serialises it). 'text' is innerText; 'textContent' is textContent without innerText's visibility rules, where
 * block-level and table boundaries become spaces so cells do not fuse.
 */
const elementTexts = (target: Element | Element[], m: 'text' | 'textContent'): string[] => {
  const block = new Set('P DIV LI TD TH TR DT DD H1 H2 H3 H4 H5 H6 SECTION ARTICLE TABLE UL OL DL DETAILS SUMMARY BR HEADER FOOTER MAIN NAV'.split(' '));
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return n.nodeValue ?? '';
    if (n.nodeType !== 1) return '';
    const inner = Array.from(n.childNodes).map(walk).join('');
    return block.has((n as Element).tagName) ? ` ${inner} ` : inner;
  };
  return (Array.isArray(target) ? target : [target]).map((el) => (m === 'textContent' ? walk(el) : (el as HTMLElement).innerText ?? ''));
};

async function readText(l: PwLocator, mode: 'text' | 'textContent', timeout?: number): Promise<string> {
  const raw = mode === 'textContent'
    ? ((await l.evaluate(elementTexts, mode))[0] ?? '')
    : await l.innerText(timeout === undefined ? undefined : { timeout });
  return squash(raw);
}

/** The text of every match in one browser call (a 10,000-item list is one round trip, not 10,000). */
async function readTexts(items: PwLocator, mode: 'text' | 'textContent'): Promise<string[]> {
  return (await items.evaluateAll(elementTexts, mode)).map(squash);
}

/** One field inside one item: no match is '', more than one is drift; href/src become absolute URLs. */
async function readField(item: PwLocator, f: FieldSpec, mode: 'text' | 'textContent', pageUrl: string, masker: Masker): Promise<string> {
  const loc = f.locator as Locator;
  const fl = build(item, loc);
  const n = await fl.count();
  if (n === 0) return '';
  if (n > 1) throw new Error(locatorNotUnique(describeForUser(loc), n));
  const attribute = f.attribute ?? 'text';
  if (attribute === 'text') return masker.mask(await readText(fl, mode));
  const value = squash((await fl.getAttribute(attribute)) ?? '');
  if ((attribute === 'href' || attribute === 'src') && value && URL.canParse(value, pageUrl)) return masker.mask(new URL(value, pageUrl).href);
  return masker.mask(value);
}

const emptyRegex = (pattern: string | undefined): RegExp | undefined => {
  if (!pattern) return undefined;
  try {
    const re = new RegExp(pattern, 'i');
    return re.test('') ? undefined : re;
  } catch {
    return undefined;
  }
};

const extract: Handler = async (ctx, step, state, timeout) => {
  const spec = (step as S<'extract'>).extract;
  const mode = spec.textMode ?? 'text';
  const { locator: scope, candidate } = await resolveUnique(ctx.page, spec.scope, timeout);
  const idRe = spec.idPattern !== undefined ? new RegExp(spec.idPattern) : undefined;
  const emptyRe = emptyRegex(ctx.emptyPattern);
  const itemsOf = () => build(scope, spec.item as Locator);
  // Script-rendered content (tabs, lazy lists) can arrive after the scope: wait for the first ID (with an ID Pattern) or
  // the first item (without), or for the page's own "no results" text, never past the step timeout. Read errors are
  // never mistaken for "no rows": a closed page fails at once; other errors are retried until the timeout and, if no
  // read ever succeeded, the last one is thrown (masked).
  const end = Date.now() + timeout;
  let text = '';
  let readOk = false;
  let lastErr: unknown;
  await poll(async () => {
    try {
      text = ctx.masker.mask(await readText(scope, mode, Math.max(1, end - Date.now())));
      readOk = true;
      lastErr = undefined;
      // Page-controlled subjects are capped for every regex (ReDoS bound, steps/limits.ts).
      if (emptyRe?.test(regexSubject(text))) return true;
      return idRe ? idRe.test(regexSubject(text)) : (await itemsOf().count()) > 0;
    } catch (e) {
      if (ctx.page.isClosed()) throw new Error(ctx.masker.mask(e instanceof Error ? e.message : String(e)));
      lastErr = e;
      return false;
    }
  }, timeout);
  if (!readOk && lastErr !== undefined) throw new Error(ctx.masker.mask(lastErr instanceof Error ? lastErr.message.split('\n')[0] : String(lastErr)));
  state.evidence.push({ url: ctx.page.url(), text });
  state.extractRan = true;
  const seen = new Set(state.rows.flatMap((r) => (r.id !== undefined ? [r.id] : [])));
  const fresh: Row[] = [];
  const add = (row: Row) => {
    if (row.id !== undefined) {
      if (seen.has(row.id)) return;
      seen.add(row.id);
    }
    fresh.push(row);
    if (state.rows.length + fresh.length > MAX_ROWS) throw new Error(tooManyRows(MAX_ROWS));
  };
  if (!spec.item) {
    // All of the text is searched in 1 MiB windows (ReDoS bound); a match crossing a window end is taken once, whole.
    for (const id of regexMatches(text, spec.idPattern as string)) add({ id });
    assertRowTextRoom(state, fresh);
    state.rows.push(...fresh);
    return candidate;
  }
  const items = itemsOf();
  // Without an ID Pattern every item is a row: refuse an oversized list before reading it.
  if (!idRe && state.rows.length + (await items.count()) > MAX_ROWS) throw new Error(tooManyRows(MAX_ROWS));
  const texts = await readTexts(items, mode);
  const fields = Object.entries(spec.fields ?? {});
  for (const [name, f] of fields) {
    if (f.locator && f.attribute && f.attribute !== 'text' && !state.attributeFields.includes(name)) state.attributeFields.push(name);
  }
  const pageUrl = ctx.page.url();
  for (let k = 0; k < texts.length; k++) {
    const itemText = ctx.masker.mask(texts[k]);
    const row: Row = {};
    if (idRe) {
      const idMatch = idRe.exec(regexSubject(itemText));
      if (!idMatch) continue;
      row.id = idMatch[0];
    }
    for (const [name, f] of fields) {
      if (f.pattern) {
        const m = new RegExp(f.pattern).exec(regexSubject(itemText));
        row[name] = m ? (m[1] ?? m[0]).trim() : '';
      } else if (f.locator) {
        row[name] = await readField(items.nth(k), f, mode, pageUrl, ctx.masker);
      }
    }
    if (!idRe && fields.length === 0) row.text = itemText;
    add(row);
  }
  assertRowTextRoom(state, fresh);
  state.rows.push(...fresh);
  return candidate;
};

const paginate: Handler = async (ctx, step, state, timeout) => {
  const p = (step as S<'paginate'>).paginate;
  let usedCandidate = 0; // highest `next` candidate that was needed on any page, so a fallback-only paginate shows in the log
  for (let n = 0; ; n++) {
    const r = await runSteps(ctx, p.each, state, { nested: true });
    if (!r.ok) {
      const m = r.failure.message;
      throw new Error(VERBATIM.some((v) => m.startsWith(v)) ? m : `${r.failure.intent}: ${m}`);
    }
    const next = await firstPresent(ctx.page, p.next, p.nextWaitMs ?? DEFAULT_NEXT_WAIT_MS);
    if (!next) return usedCandidate;
    usedCandidate = Math.max(usedCandidate, next.candidate);
    const el = next.locator.first();
    if (!(await el.isVisible())) return usedCandidate;
    if (p.until === 'disabled' && (await el.isDisabled())) return usedCandidate;
    if (n + 1 >= p.max) throw new Error(`paginate: still a next page after ${p.max} pages`);
    const bodyText = () => ctx.page.evaluate(() => document.body?.innerText ?? '');
    const before = await bodyText();
    await el.click({ timeout });
    await settle(ctx.page);
    const changed = await poll(async () => (await bodyText().catch((err: unknown) => {
      if (ctx.page.isClosed()) throw err; // the browser is gone: stop now, never wait out the timeout
      return before;
    })) !== before, timeout);
    if (!changed) throw new Error('paginate: page did not change after clicking next');
  }
};

const clickAll: Handler = async (ctx, step, _state, timeout) => {
  const c = (step as S<'clickAll'>).clickAll;
  const found = await firstPresent(ctx.page, c.target, timeout);
  if (!found) throw new Error('clickAll: no matching elements');
  const n = await found.locator.count();
  if (n > c.max) throw new Error(`clickAll: ${n} matches is more than max ${c.max}`);
  // Click the elements that matched up front: a target such as `details:not([open]) > summary` stops matching what was
  // clicked, so a live nth(k) would skip elements and then run past the end.
  const handles = await found.locator.elementHandles();
  try {
    for (const h of handles) await h.click({ timeout });
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => undefined)));
  }
  return found.candidate;
};

registerHandlers('browser', { extract, paginate, clickAll });
