import type { ElementHandle, Page } from 'playwright-core';
import { PRESS_PASSWORD_REFUSED } from '../../messages.js';
import type { Step } from '../../types.js';
import { toPlaywrightKey } from '../browser-keys.js';
import { resolveUnique } from '../locator.js';
import { settle, type Handler } from '../run.js';
import { passwordControl, refusePassword } from './basic.js';
import { registerHandlers } from './index.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

/**
 * The element that has the focus, followed through frames and open shadow roots: where a key press lands. Null when the
 * page has no focused element. The handles of the frames on the way are released.
 */
async function focusedElement(page: Page): Promise<ElementHandle<Element> | null> {
  let frame = page.mainFrame();
  for (;;) {
    const handle = await frame.evaluateHandle(() => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return el;
    });
    const el = handle.asElement() as ElementHandle<Element> | null;
    if (!el) { await handle.dispose(); return null; }
    const inner = await el.contentFrame();
    if (!inner) return el;
    await el.dispose();
    frame = inner;
  }
}

/**
 * One key chord, to the target (focused first) or to the element that has the focus. Refused like a fill there (fatal)
 * when the target is a password input (found the way fill finds it, through its label) or the focus is on one. Not a
 * declared write: a key that posts a form meets the session's request rules like a click on its button.
 */
const press: Handler = async (ctx, step, _state, timeout) => {
  const s = (step as S<'press'>).press;
  let candidate: number | undefined;
  if (s.target) {
    const r = await resolveUnique(ctx.page, s.target, timeout);
    candidate = r.candidate;
    if (await passwordControl(r.locator, false)) refusePassword(ctx, PRESS_PASSWORD_REFUSED);
    await r.locator.focus({ timeout });
  }
  // Checked where the key lands: focusing the target can leave the focus elsewhere (a label is not focusable).
  const focused = await focusedElement(ctx.page);
  try {
    if (focused && await focused.evaluate((el) => el instanceof HTMLInputElement && el.type === 'password')) refusePassword(ctx, PRESS_PASSWORD_REFUSED);
    // ElementHandle.press, like a click, waits for a navigation the key starts: a refused form post fails this step.
    if (focused) await focused.press(toPlaywrightKey(s.key), { timeout });
    else await ctx.page.keyboard.press(toPlaywrightKey(s.key));
  } finally {
    await focused?.dispose().catch(() => undefined);
  }
  await settle(ctx.page);
  return candidate;
};

const hover: Handler = async (ctx, step, _state, timeout) => {
  const { locator, candidate } = await resolveUnique(ctx.page, (step as S<'hover'>).hover, timeout);
  await locator.hover({ timeout });
  return candidate;
};

registerHandlers('browser', { press, hover });
