import type { ElementHandle, Locator } from 'playwright-core';
import { secretHostNotListed } from '../messages.js';
import { hostOf } from '../secrets/secret-targets.js';
import { PolicyError } from './errors.js';
import type { StepContext } from './run.js';
import { shownUrl } from './urls.js';

/** Whether typing `value` is limited: the run has a May Be Typed Into limit and `value` is one of its credential's values. */
const limited = (ctx: StepContext, value: string): boolean => ctx.secretTyping?.values.has(value) === true;

/**
 * The field's element, once the page's host at this moment and the host of the frame the field is in are both listed
 * in ctx.secretTyping. Otherwise a fatal 'secret' violation and a PolicyError naming the host (the run ends as
 * policy_violation). The frame comes from the browser itself (ElementHandle.ownerFrame), never from the page's scripts;
 * a page or frame without a host (about:blank, about:srcdoc) is never listed. The message names the host, never the
 * value or the variable. The caller disposes the handle.
 */
async function checkedField(ctx: StepContext, field: Locator, timeout: number): Promise<ElementHandle> {
  const hosts = ctx.secretTyping?.hosts ?? new Set<string>();
  const handle = await field.elementHandle({ timeout });
  try {
    const frameUrl = (await handle.ownerFrame())?.url() ?? '';
    for (const url of [ctx.page.url(), frameUrl]) {
      const host = hostOf(url);
      if (host !== '' && hosts.has(host)) continue;
      const shown = ctx.masker.mask(shownUrl(url)).slice(0, 300);
      ctx.violations.push({ kind: 'secret', url: shown, fatal: true });
      throw new PolicyError(secretHostNotListed(host ? ctx.masker.mask(host) : shown || 'a page without an address'));
    }
  } catch (err) {
    await handle.dispose().catch(() => undefined);
    throw err;
  }
  return handle;
}

/** Before anything of a multi-field step is typed: the check typeSecret makes, for a field typed later. */
export async function assertSecretTarget(ctx: StepContext, field: Locator, value: string, timeout: number): Promise<void> {
  if (!limited(ctx, value)) return;
  await (await checkedField(ctx, field, timeout)).dispose().catch(() => undefined);
}

/**
 * Types a secret value (a secret fill's, or signIn.changePassword's) into `field`. When the value is one of the RPA
 * Secret Variables credential's and the credential's May Be Typed Into is filled, the hosts are checked first and the
 * value goes into the very element that was checked: if its document navigated away since, the fill fails instead of
 * typing into the new page. Otherwise a plain Locator.fill, as before.
 */
export async function typeSecret(ctx: StepContext, field: Locator, value: string, timeout: number): Promise<void> {
  if (!limited(ctx, value)) return void await field.fill(value, { timeout });
  const handle = await checkedField(ctx, field, timeout);
  try {
    await handle.fill(value, { timeout });
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}
