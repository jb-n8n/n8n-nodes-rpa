// Screenshot masks shared by the capture handler and the lanes' failure screenshots. A leaf module: type imports only.
import type { Locator, Page } from 'playwright-core';
import type { PortalSecrets } from '../types.js';

/**
 * Locators masked in screenshots: every visible form control, plus the text of 3+ chars of the username and password when
 * secrets exist, and of each value a secret fill may type (`typed`: secretFillValues of the run's masker, which holds the
 * secret variables' values).
 */
export function screenshotMasks(page: Page, secrets?: PortalSecrets, typed: Iterable<string> = []): Locator[] {
  const masks = [page.locator('input:not([type=hidden]), textarea, select')];
  if (secrets?.username && secrets.username.length >= 3) masks.push(page.getByText(secrets.username, { exact: false }));
  if (secrets?.password && secrets.password.length >= 3) masks.push(page.getByText(secrets.password, { exact: false }));
  for (const value of typed) if (value.length >= 3) masks.push(page.getByText(value, { exact: false }));
  return masks;
}
