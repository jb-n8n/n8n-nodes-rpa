import type { Page } from 'playwright-core';
import type { Masker } from '../secrets/mask.js';
import { build } from '../steps/locator.js';
import type { Locator } from '../types.js';
import { hrefHasSession, looksGenerated } from './stable-ids.js';
import { REF_ATTR, currentIdentity, type SnapshotElement } from './snapshot.js';

interface ElementFacts {
  landmark: string;
  label: string;
  text: string;
  testId: string;
  id: string;
  escapedId: string; // CSS.escape needs the page
  rawHref: string;
}

// Runs in the page against the snapshot element.
function facts(el: Element): ElementFacts {
  // Attributes through the prototype: a form control named "getAttribute" shadows the method on its <form>.
  const attr = (e: Element, name: string) => Element.prototype.getAttribute.call(e, name);
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const LANDMARK_ROLES = ['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search'];
  const SECTIONING = new Set(['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION']);
  const landmarkOf = (start: Element): string => {
    for (let n = start.parentElement; n; n = n.parentElement) {
      const r = squash(attr(n, 'role'));
      if (LANDMARK_ROLES.includes(r)) return r;
      if (n.tagName === 'NAV') return 'navigation';
      if (n.tagName === 'MAIN') return 'main';
      if (n.tagName === 'ASIDE') return 'complementary';
      if (n.tagName === 'HEADER' || n.tagName === 'FOOTER') {
        let inside = false;
        for (let p = n.parentElement; p; p = p.parentElement) if (SECTIONING.has(p.tagName)) inside = true;
        if (!inside) return n.tagName === 'HEADER' ? 'banner' : 'contentinfo';
      }
    }
    return '';
  };
  const tag = el.tagName;
  const field = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const clickable = ['A', 'BUTTON', 'SUMMARY'].includes(tag) || ['button', 'link', 'tab', 'menuitem', 'option'].includes(squash(attr(el, 'role')));
  const id = el.id;
  const rawHref = tag === 'A' ? attr(el, 'href') ?? '' : '';
  return {
    landmark: landmarkOf(el),
    label: field ? squash((el as HTMLInputElement).labels?.[0]?.innerText) : '',
    text: clickable ? squash((el as HTMLElement).innerText) : '',
    testId: attr(el, 'data-testid') ?? '',
    id,
    escapedId: id ? CSS.escape(id) : '',
    rawHref,
  };
}

/**
 * Locator candidates for a snapshot element, each validated to match exactly this element. The first becomes the
 * primary; up to four more become fallbacks. Throws when the ref is stale or nothing validates.
 */
const gone = (ref: string) => `element ${ref} is no longer on the page; call look for fresh refs`;

export async function candidatesFor(page: Page, el: SnapshotElement, masker: Masker): Promise<Locator> {
  if (!/^e\d+$/.test(el.ref)) throw new Error(gone(el.ref));
  const target = page.locator(`[${REF_ATTR}="${el.ref}"]`);
  if ((await target.count()) !== 1) throw new Error(gone(el.ref));
  const now = await currentIdentity(page, masker, el.ref);
  if (!now || now.role !== el.role || now.name !== el.name) throw new Error(gone(el.ref));
  // Short: the element was just counted. If it detaches in between (an overlay that closes itself), fail now instead of
  // waiting Playwright's 30 s default for it to come back.
  const f = await target.evaluate(facts, undefined, { timeout: 2000 }).catch(() => {
    throw new Error(gone(el.ref));
  });
  const list: Locator[] = [];
  if (el.role && el.name) {
    if (f.landmark) list.push({ role: el.role, name: el.name, exact: true, within: { role: f.landmark } });
    list.push({ role: el.role, name: el.name, exact: true });
  }
  if (f.label) list.push({ label: f.label, exact: true });
  if (f.text && f.text.length <= 80) list.push({ text: f.text, exact: true });
  if (f.testId) list.push({ testId: f.testId });
  // Decided here, not in the page script (it cannot import): generated ids and session links never become fallbacks.
  if (f.id && !looksGenerated(f.id)) list.push({ css: `#${f.escapedId}` });
  const hrefPath = /^\/(?!\/)[^?#"\\]*$/.test(f.rawHref) ? f.rawHref : '';
  if (hrefPath && !hrefHasSession(hrefPath)) list.push({ css: `a[href="${hrefPath}"]` });
  const targetHandle = await target.elementHandle();
  const valid: Locator[] = [];
  try {
    for (const c of list) {
      if (masker.containsSecret(JSON.stringify(c))) continue;
      try {
        const l = build(page, c);
        if ((await l.count()) !== 1) continue;
        const h = await l.elementHandle({ timeout: 1000 });
        const same = await h.evaluate((a, b) => a === b, targetHandle);
        await h.dispose();
        if (same) valid.push(c);
      } catch {
        // The candidate did not resolve; it is simply not kept.
      }
    }
  } finally {
    await targetHandle.dispose();
  }
  if (valid.length === 0) throw new Error(`no stable locator for element ${el.ref}`);
  const [primary, ...rest] = valid;
  return rest.length ? ({ ...primary, fallbacks: rest.slice(0, 4) } as Locator) : primary;
}
