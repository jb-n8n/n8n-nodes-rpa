import type { Locator as PwLocator, Page } from 'playwright-core';
import type { Interrupt } from '../types.js';
import { build, isVisibleNow } from './locator.js';

/** Lets signIn switch overlay handlers off while credentials are typed. */
export interface InterruptHandle {
  /** Clicks any declared overlay that is visible now (only inside the overlay), then removes the handlers. */
  pause(): Promise<void>;
  /** Re-installs the handlers. Does nothing unless paused. */
  resume(): Promise<void>;
}

/** Overlays that may appear before any action (cookie banners, "what's new" modals). Primary locators only. */
export async function installInterrupts(page: Page, interrupts: Interrupt[] = []): Promise<InterruptHandle> {
  const installed: PwLocator[] = [];
  const add = async () => {
    for (const it of interrupts) {
      const target = build(page, it.target);
      await page.addLocatorHandler(
        target,
        async () => {
          await build(page, it.click).first().click({ timeout: 5000 });
        },
        { noWaitAfter: true },
      );
      installed.push(target);
    }
  };
  await add();
  let paused = false;
  return {
    async pause() {
      if (paused) return;
      // Clear what is already showing, clicking only inside the overlay so a first-match click can never hit the login form.
      // Best-effort: a failure here must not leave handlers half-removed, so every step is guarded and `paused` is set regardless.
      for (const it of interrupts) {
        try {
          if (await isVisibleNow(page, it.target)) await build(build(page, it.target), it.click).first().click({ timeout: 5000 });
        } catch { /* keep going */ }
      }
      for (const l of installed.splice(0)) await page.removeLocatorHandler(l).catch(() => undefined);
      paused = true;
    },
    async resume() {
      if (!paused) return;
      paused = false;
      if (!page.isClosed()) await add();
    },
  };
}
