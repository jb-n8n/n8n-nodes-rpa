import type { Page } from 'playwright-core';
import type { Expect } from '../types.js';
import { describeLocator, isVisibleNow } from './locator.js';
import { poll } from './poll.js';
import { maskSessionSegments } from './urls.js';

/** The page address without query or fragment: those can carry tokens or personal data, and messages reach logs and models. */
function where(page: Page): string {
  try {
    const u = new URL(page.url());
    return maskSessionSegments(u.origin === 'null' ? `${u.protocol}${u.pathname}` : `${u.origin}${u.pathname}`);
  } catch {
    return '';
  }
}

export async function checkExpect(page: Page, expect: Expect, timeoutMs: number): Promise<void> {
  const ok = await poll(async () => {
    if (page.isClosed()) throw new Error(`expectation abandoned: the page was closed (at ${where(page)})`);
    if (expect.url && !page.url().includes(expect.url)) return false;
    if (expect.heading && !(await page.getByRole('heading', { name: expect.heading }).first().isVisible().catch(() => false))) return false;
    if (expect.visible && !(await isVisibleNow(page, expect.visible))) return false;
    return true;
  }, timeoutMs);
  if (!ok) {
    const parts = [
      expect.url && `url contains "${expect.url}"`,
      expect.heading && `heading "${expect.heading}"`,
      expect.visible && `visible ${describeLocator(expect.visible)}`,
    ].filter(Boolean);
    throw new Error(`expectation failed: ${parts.join(', ')} (at ${where(page)})`);
  }
}
