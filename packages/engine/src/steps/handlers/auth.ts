import type { Locator } from 'playwright-core';
import { msUntilNextWindow, totp } from '../../secrets/totp.js';
import type { Locator as DslLocator, PortalSecrets, RunState, SignInSpec, Step } from '../../types.js';
import { build, candidatesOf, isVisibleNow, resolveUnique } from '../locator.js';
import { poll, sleep } from '../poll.js';
import { settle, type Handler, type StepContext } from '../run.js';
import { registerHandlers } from './index.js';
import { PolicyError } from '../errors.js';
import { DETECTED_PREFIX } from '../../classify/classify.js';
import { SIGNIN_NEEDS_SITE_LOGIN, SIGNIN_NEXT_NO_PASSWORD } from '../../messages.js';
import { isLoginPage } from '../urls.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

export class SignInPolicyError extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = 'SignInPolicyError';
  }
}

// Defined in the leaf module urls.ts so the session and trace scrubbing can use it without loading the step handlers.
export { isLoginPage };
function onLoginPage(ctx: StepContext): boolean {
  return isLoginPage(ctx.policy, ctx.page.url());
}
function assertLoginPage(ctx: StepContext) {
  if (onLoginPage(ctx)) return;
  const u = new URL(ctx.page.url());
  ctx.violations.push({ kind: 'signin', url: `${u.origin}${u.pathname}`, fatal: true });
  throw new SignInPolicyError(`signIn refused: ${u.host}${u.pathname} is not a declared login page`);
}

function inLoginList(ctx: StepContext, href: string): boolean {
  return isLoginPage(ctx.policy, href);
}
async function assertFieldOnLoginPage(ctx: StepContext, locator: Locator, kind: 'username' | 'password' | 'totp'): Promise<void> {
  const info = await locator.evaluate((el) => ({
    href: el.ownerDocument.location.href,
    tag: el.tagName,
    type: (el as HTMLInputElement).type,
    form: (el as HTMLInputElement).form?.action ?? null,
  }));
  if (!inLoginList(ctx, info.href) || (info.form !== null && !inLoginList(ctx, info.form))) {
    const bad = inLoginList(ctx, info.href) ? (info.form as string) : info.href;
    let url = bad;
    try { const u = new URL(bad); url = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
    ctx.violations.push({ kind: 'signin', url, fatal: true });
    throw new SignInPolicyError(`signIn refused: the ${kind} field is not on a declared login page`);
  }
  if (kind === 'password' && !(info.tag === 'INPUT' && info.type === 'password')) throw new Error('signIn: the password locator is not a password input');
  if (kind === 'username' && !(info.tag === 'INPUT' && ['text', 'email', 'tel', ''].includes(info.type))) throw new Error('signIn: the username locator is not a text input');
  if (kind === 'totp' && info.tag !== 'INPUT') throw new Error('signIn: the authentication code locator is not an input');
}

/**
 * A button about to be clicked during signIn (next, submit) must not post off the declared login pages: its own
 * formaction when it has one, else its form's action. A button outside any form (or not a form control) is not checked.
 * Otherwise a fatal signin violation, like assertFieldOnLoginPage.
 */
async function assertButtonPostsToLoginPage(ctx: StepContext, locator: Locator, kind: 'next' | 'submit'): Promise<void> {
  const target = await locator.evaluate((el) => {
    const b = el as HTMLButtonElement;
    if (b.hasAttribute('formaction') && 'formAction' in b) return b.formAction;
    return b.form?.action ?? null;
  });
  if (target === null || inLoginList(ctx, target)) return;
  let url = target;
  try { const u = new URL(target); url = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
  ctx.violations.push({ kind: 'signin', url, fatal: true });
  throw new SignInPolicyError(`signIn refused: the ${kind} button does not post to a declared login page`);
}

/** Visible and editable now (not read-only, not disabled): an IdP may echo the username read-only on the password page. */
async function editableNow(ctx: StepContext, loc: DslLocator): Promise<boolean> {
  for (const c of candidatesOf(loc)) {
    try {
      const l = build(ctx.page, c);
      const n = Math.min(await l.count(), 5);
      for (let i = 0; i < n; i++) {
        const e = l.nth(i);
        if ((await e.isVisible()) && (await e.isEditable())) return true;
      }
    } catch (err) {
      if (ctx.page.isClosed()) throw err;
      // Race, or not an input: treat as not editable.
    }
  }
  return false;
}

/** Types the TOTP code into a declared login page's code field and submits it. Shared by signIn and the agent's enter_code tool. */
export async function submitTotp(ctx: StepContext, spec: { field: DslLocator; submit: DslLocator }, timeout: number): Promise<void> {
  const totpSecret = ctx.secrets?.totpSecret;
  if (!totpSecret) throw new Error(`${DETECTED_PREFIX}mfa_totp`);
  const field = await resolveUnique(ctx.page, spec.field, timeout);
  const button = await resolveUnique(ctx.page, spec.submit, timeout);
  const left = msUntilNextWindow(Date.now());
  if (left < 3000) await sleep(left + 250);
  assertLoginPage(ctx);
  await assertFieldOnLoginPage(ctx, field.locator, 'totp');
  const now = Date.now();
  const code = totp(totpSecret, now);
  // The code is a secret too: Playwright traces keep fill values and DOM snapshots, and a page may echo it. The run's
  // masker (shared with the trace scrubbing) learns it, and the adjacent windows', before it is typed.
  ctx.masker.add([totp(totpSecret, now - 30_000), code, totp(totpSecret, now + 30_000)], { wholeNumber: true });
  await field.locator.fill(code, { timeout });
  await button.locator.click({ timeout });
  await settle(ctx.page);
}

/**
 * The checks every sign-in starts with (the signIn step and the agent's sign_in): a Site Login is attached, no
 * credentials were submitted yet in this run, and the page is a declared login page. Returns the Site Login secrets.
 */
export function beginSignIn(ctx: StepContext, state: RunState): PortalSecrets {
  // validateScript refuses this at load; the handler refuses again so nothing is typed without a Site Login.
  const secrets = ctx.secrets;
  if (!secrets) {
    let url = ctx.page.url();
    try { const u = new URL(url); url = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
    ctx.violations.push({ kind: 'signin', url, fatal: true });
    throw new SignInPolicyError(SIGNIN_NEEDS_SITE_LOGIN);
  }
  if (state.credentialsSubmitted) throw new Error('signIn refused: credentials were already submitted in this run');
  assertLoginPage(ctx);
  return secrets;
}

const signIn: Handler = async (ctx, step, state, timeout) => {
  const s = (step as S<'signIn'>).signIn;
  const secrets = beginSignIn(ctx, state);
  if (s.next) return signInTwoPage(ctx, s, s.next, secrets, state, timeout);
  const user = await resolveUnique(ctx.page, s.username, timeout);
  const pass = await resolveUnique(ctx.page, s.password, timeout);
  await assertFieldOnLoginPage(ctx, user.locator, 'username');
  await assertFieldOnLoginPage(ctx, pass.locator, 'password');
  await ctx.interrupts?.pause();
  try {
    // Pausing may have clicked an overlay that navigated: re-check before typing anything.
    assertLoginPage(ctx);
    await assertFieldOnLoginPage(ctx, user.locator, 'username');
    await assertFieldOnLoginPage(ctx, pass.locator, 'password');
    state.credentialsSubmitted = true;
    await user.locator.fill(secrets.username, { timeout });
    await assertFieldOnLoginPage(ctx, pass.locator, 'password');
    await pass.locator.fill(secrets.password, { timeout });
    await submitPassword(ctx, s, pass.locator, state, timeout);
  } finally {
    await ctx.interrupts?.resume().catch(() => undefined);
  }
};

/**
 * After the password is typed (both paths): click submit, then, when the step declares a code and the page is still a
 * login page, wait for the code field (or a rejected password) and type the code.
 */
async function submitPassword(ctx: StepContext, s: Pick<SignInSpec, 'password' | 'submit' | 'totp'>, pass: Locator, state: RunState, timeout: number): Promise<void> {
  const submit = await resolveUnique(ctx.page, s.submit, timeout);
  const typed = await pass.elementHandle({ timeout });
  await assertButtonPostsToLoginPage(ctx, submit.locator, 'submit');
  await submit.locator.click({ timeout });
  state.submitClicked = true;
  await settle(ctx.page);
  if (!s.totp || !onLoginPage(ctx)) return;
  const totpSpec = s.totp;
  const password = s.password;
  // The field we typed into is gone and a password field is visible again: the page reloaded with a rejection.
  const reloaded = async () => !(await typed.evaluate((el) => el.isConnected).catch(() => false));
  const next = await poll(async () => {
    if (await isVisibleNow(ctx.page, totpSpec.field)) return 'totp';
    if ((await reloaded()) && (await isVisibleNow(ctx.page, password))) return 'rejected';
    return undefined;
  }, Math.min(timeout, 5000));
  if (next !== 'totp') return;
  await submitTotp(ctx, totpSpec, timeout);
}

/** How long the re-rendered username page must stay without a password field before next counts as rejected. */
const REJECTED_STABLE_MS = 1000;

/**
 * A two-page (identity-first) sign-in: resolve the username field and next, type the username, click next
 * (if it posts to a declared login page), wait for the password field, then re-check the new page and the password field
 * before typing the password. The password locator is resolved only on the second page. A rejected username (the
 * username page comes back without a password field: `detected:login_failed`), a password field that does not appear
 * (drift) or a second page that is not a declared login page (a fatal signin violation) stops the run before the
 * password is typed. The caller has run beginSignIn. The agent's two-call sign_in runs the same three phases.
 */
async function signInTwoPage(ctx: StepContext, s: SignInSpec, next: DslLocator, secrets: PortalSecrets, state: RunState, timeout: number): Promise<void> {
  const found = await findUsernamePage(ctx, { username: s.username, next }, timeout);
  await ctx.interrupts?.pause();
  try {
    await submitUsername(ctx, s, found, secrets, state, timeout);
    await submitPasswordPage(ctx, s, secrets, state, timeout);
  } finally {
    await ctx.interrupts?.resume().catch(() => undefined);
  }
}

/** The username field and the next button of a two-page sign-in, resolved before anything is typed. */
export interface UsernamePage { user: Locator; button: Locator }

/**
 * Two-page sign-in, phase 1a (before the caller pauses the overlay handlers): resolve the username field and next, and
 * check the field is on a declared login page. Resolving next first means a renamed or missing Next button is drift with
 * no credential typed.
 */
export async function findUsernamePage(ctx: StepContext, spec: { username: DslLocator; next: DslLocator }, timeout: number): Promise<UsernamePage> {
  const user = await resolveUnique(ctx.page, spec.username, timeout);
  const button = await resolveUnique(ctx.page, spec.next, timeout);
  await assertFieldOnLoginPage(ctx, user.locator, 'username');
  return { user: user.locator, button: button.locator };
}

/**
 * Two-page sign-in, phase 1b (overlay handlers paused by the caller): re-check, type the username, click next, then wait
 * up to min(timeout, 15 s) for `spec.password` to show. Throws `detected:login_failed` when the username page comes back
 * (a rejected username), SIGNIN_NEXT_NO_PASSWORD when the password field does not appear, and a SignInPolicyError when
 * next led off the declared login pages. Sets credentialsSubmitted, not submitClicked.
 */
export async function submitUsername(
  ctx: StepContext, spec: { username: DslLocator; password: DslLocator }, found: UsernamePage, secrets: PortalSecrets, state: RunState, timeout: number,
): Promise<void> {
  const { user, button } = found;
  // Pausing may have clicked an overlay that navigated: re-check before typing anything.
  assertLoginPage(ctx);
  await assertFieldOnLoginPage(ctx, user, 'username');
  state.credentialsSubmitted = true;
  await user.fill(secrets.username, { timeout });
  const typedUser = await user.elementHandle({ timeout });
  await assertButtonPostsToLoginPage(ctx, button, 'next');
  // Not the credentials' submit: submitClicked stays false until the password is submitted (the agent lane reads it).
  await button.click({ timeout });
  await settle(ctx.page);
  // The username field we typed into is gone (a new document or a re-render) and an editable username field shows
  // again with no password field, for a whole REJECTED_STABLE_MS on a loaded document: the site sent the username page
  // back. A username field that stays in the page but hidden (single-page identity forms), or a read-only echo of the
  // username on the password page, is not a rejection.
  let rejectedSince: number | undefined;
  const moved = await poll(async () => {
    if (await isVisibleNow(ctx.page, spec.password)) return 'password';
    const back = !(await typedUser.evaluate((el) => el.isConnected).catch(() => false))
      && (await ctx.page.evaluate(() => document.readyState !== 'loading').catch(() => false))
      && (await editableNow(ctx, spec.username));
    if (!back) { rejectedSince = undefined; return undefined; }
    rejectedSince ??= Date.now();
    return Date.now() - rejectedSince >= REJECTED_STABLE_MS ? 'rejected' : undefined;
  }, Math.min(timeout, 15_000));
  // Wherever next led, a page that is not a declared login page stops the run (a fatal signin violation naming it).
  assertLoginPage(ctx);
  // The site sent the username page back: a rejected login (the login breaker trips; no repair), not drift.
  if (moved === 'rejected') throw new Error(`${DETECTED_PREFIX}login_failed`);
  // The password field did not appear in time: drift.
  if (moved !== 'password') throw new Error(SIGNIN_NEXT_NO_PASSWORD);
}

/**
 * Two-page sign-in, phase 2 (overlay handlers paused by the caller): on a declared login page, resolve the password field
 * (only now), check it, type the password, submit, and type the code when `spec.totp` is set.
 */
export async function submitPasswordPage(
  ctx: StepContext, spec: Pick<SignInSpec, 'password' | 'submit' | 'totp'>, secrets: PortalSecrets, state: RunState, timeout: number,
): Promise<void> {
  // The agent calls this a model turn after phase 1: the page must still be a declared login page.
  assertLoginPage(ctx);
  const pass = await resolveUnique(ctx.page, spec.password, timeout);
  await assertFieldOnLoginPage(ctx, pass.locator, 'password');
  await pass.locator.fill(secrets.password, { timeout });
  await submitPassword(ctx, spec, pass.locator, state, timeout);
}

const detect: Handler = async (ctx, step, state, timeout) => {
  const d = (step as S<'detect'>).detect;
  const hit = await poll(async () => {
    for (const [name, loc] of Object.entries(d.checks)) if (await isVisibleNow(ctx.page, loc)) return name;
    return undefined;
  }, timeout);
  if (!hit) throw new Error(`detect ${d.name}: none of ${Object.keys(d.checks).join(', ')} appeared`);
  state.detected[d.name] = hit;
  if (d.require && hit !== d.require) throw new Error(`${DETECTED_PREFIX}${hit}`);
};

registerHandlers({ signIn, detect });
