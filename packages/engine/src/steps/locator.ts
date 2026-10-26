import type { FrameLocator, Locator as PwLocator, Page } from 'playwright-core';
import type { Locator } from '../types.js';
import { describeForUser, locatorNotFound, locatorNotUnique } from '../messages.js';
import { poll } from './poll.js';
import { shownUrl } from './urls.js';

export type Root = Page | PwLocator | FrameLocator;
type AriaRole = Parameters<Page['getByRole']>[0];
// Page, Locator and FrameLocator share these methods; this view lets one code path build on any of them.
type Buildable = Pick<PwLocator, 'frameLocator' | 'getByRole' | 'getByLabel' | 'getByText' | 'getByTestId' | 'locator'>;

export function build(root: Root, loc: Locator): PwLocator {
  let r = root as unknown as Buildable;
  if (loc.frame) r = r.frameLocator(loc.frame) as unknown as Buildable;
  if (loc.within) r = build(r as unknown as Root, loc.within) as unknown as Buildable;
  if ('role' in loc) return r.getByRole(loc.role as AriaRole, { name: loc.name, exact: loc.exact });
  if ('label' in loc) return r.getByLabel(loc.label, { exact: loc.exact });
  if ('text' in loc) return r.getByText(loc.text, { exact: loc.exact });
  if ('testId' in loc) return r.getByTestId(loc.testId);
  return r.locator(loc.css);
}

/** The page a root belongs to, so a polling loop can tell "not there yet" from "the browser is gone". */
export function pageOf(root: Root): Page {
  if ('isClosed' in root) return root;
  if ('owner' in root) return root.owner().page();
  return root.page();
}

export function candidatesOf(loc: Locator): Locator[] {
  const { fallbacks, ...primary } = loc;
  return [primary as Locator, ...(fallbacks ?? [])];
}

export function describeLocator(loc: Locator): string {
  let s: string;
  if ('role' in loc) s = `role=${loc.role}${loc.name !== undefined ? `[name="${loc.name}"]` : ''}`;
  else if ('label' in loc) s = `label="${loc.label}"`;
  else if ('text' in loc) s = `text="${loc.text}"`;
  else if ('testId' in loc) s = `testId="${loc.testId}"`;
  else s = `css=${loc.css}`;
  if (loc.frame) s += ` in frame ${loc.frame}`;
  if (loc.within) s += ` within ${describeLocator(loc.within)}`;
  return s;
}

/**
 * Exactly one visible match of the primary candidate or, failing that, of a fallback, polled until the timeout.
 * The failure names the primary: "matches N elements" when its last poll saw more than one, else "No element found".
 */
export async function resolveUnique(root: Root, loc: Locator, timeoutMs: number): Promise<{ locator: PwLocator; candidate: number }> {
  const cands = candidatesOf(loc);
  let primaryCount = 0;
  const hit = await poll(async () => {
    for (let i = 0; i < cands.length; i++) {
      try {
        const l = build(root, cands[i]);
        const n = await l.count();
        if (i === 0) primaryCount = n;
        if (n === 1 && (await l.isVisible())) return { locator: l, candidate: i };
      } catch (err) {
        // A closed page (cancel, budget, disconnect) ends the wait now instead of polling until the step timeout.
        if (pageOf(root).isClosed()) throw err;
        // Race: element appeared/changed between count and isVisible; treat as no match yet.
      }
    }
    return undefined;
  }, timeoutMs);
  if (hit) return hit;
  const desc = describeForUser(cands[0]);
  if (primaryCount > 1) throw new Error(locatorNotUnique(desc, primaryCount));
  throw new Error(locatorNotFound(desc, shownUrl(pageOf(root).url()), Math.max(1, Math.round(timeoutMs / 1000))));
}

export async function firstPresent(root: Root, loc: Locator, timeoutMs: number): Promise<{ locator: PwLocator; candidate: number } | null> {
  const cands = candidatesOf(loc);
  const hit = await poll(async () => {
    for (let i = 0; i < cands.length; i++) {
      try {
        const l = build(root, cands[i]);
        if ((await l.count()) >= 1) return { locator: l, candidate: i };
      } catch (err) {
        if (pageOf(root).isClosed()) throw err;
        // Race: element appeared/changed; treat as no match yet.
      }
    }
    return undefined;
  }, timeoutMs);
  return hit ?? null;
}

export async function isVisibleNow(root: Root, loc: Locator): Promise<boolean> {
  for (const c of candidatesOf(loc)) {
    try {
      const l = build(root, c);
      if ((await l.count()) >= 1 && (await l.first().isVisible())) return true;
    } catch (err) {
      if (pageOf(root).isClosed()) throw err;
      // Race: element appeared/changed; treat as not visible.
    }
  }
  return false;
}
