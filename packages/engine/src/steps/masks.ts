// Screenshot masks shared by the capture handler and the lanes' failure screenshots. A leaf module: type imports only.
import type { Locator, Page } from 'playwright-core';
import type { PortalSecrets } from '../types.js';

/** Locators masked in screenshots: every visible form control, plus username and password text of 3+ chars when secrets exist. */
export function screenshotMasks(page: Page, secrets?: PortalSecrets): Locator[] {
  const masks = [page.locator('input:not([type=hidden]), textarea, select')];
  if (secrets?.username && secrets.username.length >= 3) masks.push(page.getByText(secrets.username, { exact: false }));
  if (secrets?.password && secrets.password.length >= 3) masks.push(page.getByText(secrets.password, { exact: false }));
  return masks;
}
