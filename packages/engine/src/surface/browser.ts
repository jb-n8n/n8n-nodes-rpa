import type { Page } from 'playwright-core';
import { snapshot } from '../agent/snapshot.js';
import { checkExpect } from '../steps/expect.js';
import { isVisibleNow } from '../steps/locator.js';
import type { Surface } from './surface.js';

/** The browser behind the Surface interface. `page` is read on every call, so the surface follows a page a popup step replaced. */
export function createBrowserSurface(page: () => Page): Surface {
  return {
    kind: 'browser',
    isClosed: () => page().isClosed(),
    address: () => page().url(),
    isVisible: (target) => isVisibleNow(page(), target),
    checkExpect: (expect, timeoutMs) => checkExpect(page(), expect, timeoutMs),
    snapshot: (masker, opts) => snapshot(page(), masker, opts),
  };
}
