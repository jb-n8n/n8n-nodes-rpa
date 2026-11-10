import type { ElementHandle, Locator } from 'playwright-core';
import { msUntilNextWindow, totp } from '../../secrets/totp.js';
import {
  DEFAULT_CODE_TIMEOUT_MS, type ChangePasswordSpec, type CodeRequest, type Locator as DslLocator, type PortalSecrets, type RunState, type SignInSpec, type Step,
} from '../../types.js';
import { build, candidatesOf, isVisibleNow, resolveUnique } from '../locator.js';
import { poll, sleep } from '../poll.js';
import { settle, type Handler, type StepContext } from '../run.js';
import { registerHandlers } from './index.js';
import { PolicyError } from '../errors.js';
import { DETECTED_PREFIX } from '../../classify/classify.js';
import {
  CODE_WORKFLOW_NOT_A_CODE, CODE_WORKFLOW_NOT_SET, CODE_WORKFLOW_REJECTED_TWICE, codeWorkflowFailed, codeWorkflowTimedOut, SIGNIN_NEEDS_SITE_LOGIN,
  SIGNIN_NEXT_NO_PASSWORD, signInCodeFieldMissing, UNSIGNED_CHANGE_PASSWORD,
} from '../../messages.js';
import { SECRET_FILL_VALUE } from '../../secrets/render.js';
import { renderSecretValue } from '../../secrets/secret-fills.js';
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
type FieldKind = 'username' | 'password' | 'totp' | 'current password' | 'new password';
const PASSWORD_KINDS: readonly FieldKind[] = ['password', 'current password', 'new password'];
async function assertFieldOnLoginPage(ctx: StepContext, locator: Locator, kind: FieldKind): Promise<void> {
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
  if (PASSWORD_KINDS.includes(kind) && !(info.tag === 'INPUT' && info.type === 'password')) throw new Error(`signIn: the ${kind} locator is not a password input`);
  if (kind === 'username' && !(info.tag === 'INPUT' && ['text', 'email', 'tel', ''].includes(info.type))) throw new Error('signIn: the username locator is not a text input');
  if (kind === 'totp' && info.tag !== 'INPUT') throw new Error('signIn: the authentication code locator is not an input');
}

/**
 * A button about to be clicked during signIn (next, submit, a totp.via button) must not post off the declared login
 * pages: its own formaction when it has one, else its form's action. A button outside any form (or not a form control)
 * is not checked. A via button must also not be in a form (its own, or the one it sits in) with a password field: the
 * password is typed before the via clicks, and a via click must not be able to post it. Otherwise a fatal signin
 * violation, like assertFieldOnLoginPage.
 */
async function assertButtonPostsToLoginPage(ctx: StepContext, locator: Locator, kind: 'next' | 'submit' | 'via'): Promise<void> {
  const { target, withPassword } = await locator.evaluate((el) => {
    const b = el as HTMLButtonElement;
    const form = b.form ?? el.closest('form');
    return {
      target: b.hasAttribute('formaction') && 'formAction' in b ? b.formAction : (b.form?.action ?? null),
      withPassword: !!form && Array.from(form.elements).some((e) => e instanceof HTMLInputElement && e.type === 'password'),
    };
  });
  if (kind === 'via' && withPassword) {
    let url = ctx.page.url();
    try { const u = new URL(url); url = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
    ctx.violations.push({ kind: 'signin', url, fatal: true });
    throw new SignInPolicyError('signIn refused: the via button is in a form with a password field');
  }
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

/**
 * What typing a code needs: its field and submit, the checkboxes ticked between the two (signIn's totp.check), and
 * signIn's totp.via (its last button sends the code again on a retry, see resendCode).
 */
interface CodeSpec { field: DslLocator; submit: DslLocator; check?: DslLocator[]; via?: DslLocator[] }

/**
 * totp.check: tick each checkbox (setChecked true) after the code is typed and before its submit. Each must show within
 * the timeout (a missing one fails the step before the code is submitted). Not a secret write: no login-page check.
 */
async function tickChecks(ctx: StepContext, check: DslLocator[] | undefined, timeout: number): Promise<void> {
  for (const loc of check ?? []) {
    const box = await resolveUnique(ctx.page, loc, timeout);
    await box.locator.setChecked(true, { timeout });
  }
}

/** Types the TOTP code into a declared login page's code field and submits it. Shared by signIn and the agent's enter_code tool. */
export async function submitTotp(ctx: StepContext, spec: CodeSpec, timeout: number): Promise<void> {
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
  await tickChecks(ctx, spec.check, timeout);
  await button.locator.click({ timeout });
  await settle(ctx.page);
}

/**
 * What a code provider must return once its spaces are removed: 6 to 10 digits. Spaces only, or fewer than 6 digits
 * with spaces around them, are refused.
 */
export const WORKFLOW_CODE = /^[0-9]{6,10}$/;
/** Prefix of every failure of a code from the workflow: classified auth_blocked (a second factor the run could not answer). */
const CODE_FAILURE = `${DETECTED_PREFIX}mfa_code: `;
/** How long a submitted code may take to leave the code page before it counts as rejected. */
const CODE_REJECTED_WAIT_MS = 5000;
/** How long the code field must stay gone from a loaded document before the code counts as accepted. */
const CODE_GONE_STABLE_MS = 1000;

/**
 * Asks ctx.codeProvider for a code with `request`, racing it against ctx.codeTimeoutMs (a closed page ends the wait too).
 * Returns the code without spaces. Throws `detected:mfa_code: …` when there is no provider, it fails, times out or
 * returns no code.
 */
async function codeFromWorkflow(ctx: StepContext, request: CodeRequest): Promise<string> {
  const provider = ctx.codeProvider;
  if (!provider) throw new Error(CODE_FAILURE + CODE_WORKFLOW_NOT_SET);
  const limit = ctx.codeTimeoutMs !== undefined && Number.isFinite(ctx.codeTimeoutMs) && ctx.codeTimeoutMs > 0 ? ctx.codeTimeoutMs : DEFAULT_CODE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose: (() => void) | undefined;
  const outcome = await new Promise<{ value: unknown } | { error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: CODE_FAILURE + codeWorkflowTimedOut(limit / 1000) }), limit);
    onClose = () => resolve({ error: 'the page closed while the run waited for the one-time code' });
    ctx.page.once('close', onClose);
    let asked: Promise<string>;
    try {
      asked = Promise.resolve(provider({ requestedAt: request.requestedAt }));
    } catch (err) {
      asked = Promise.reject(err);
    }
    asked.then(
      (value) => resolve({ value }),
      (err: unknown) => resolve({ error: CODE_FAILURE + codeWorkflowFailed((err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)) }),
    );
  });
  clearTimeout(timer);
  if (onClose) ctx.page.off('close', onClose);
  if ('error' in outcome) throw new Error(outcome.error);
  const code = typeof outcome.value === 'string' ? outcome.value.replace(/ /g, '') : undefined;
  if (code === undefined || !WORKFLOW_CODE.test(code)) throw new Error(CODE_FAILURE + CODE_WORKFLOW_NOT_A_CODE);
  return code;
}

/**
 * After a code was submitted: true when the site kept the code page (a new code field after a reload, or the same field
 * still showing after CODE_REJECTED_WAIT_MS), false once the run left the login pages or the field stayed gone.
 */
async function codeRejected(ctx: StepContext, field: DslLocator, typed: ElementHandle, timeout: number): Promise<boolean> {
  let goneSince: number | undefined;
  const seen = await poll(async () => {
    if (!onLoginPage(ctx)) return 'accepted';
    if (await isVisibleNow(ctx.page, field)) {
      goneSince = undefined;
      return (await typed.evaluate((el) => el.isConnected).catch(() => false)) ? undefined : 'rejected';
    }
    // The field may be gone only while the next document loads: accepted once it stays gone on a loaded document.
    const loaded = await ctx.page.evaluate(() => document.readyState !== 'loading').catch(() => false);
    if (!loaded) { goneSince = undefined; return undefined; }
    goneSince ??= Date.now();
    return Date.now() - goneSince >= CODE_GONE_STABLE_MS ? 'accepted' : undefined;
  }, Math.min(timeout, CODE_REJECTED_WAIT_MS));
  if (seen) return seen === 'rejected';
  return onLoginPage(ctx) && (await isVisibleNow(ctx.page, field));
}

/**
 * The code field of a signIn whose totp.source is 'workflow': ask the code provider (only now that the field shows),
 * re-check the page, teach the run masker the code, type it and submit. A rejected code is asked for once more; a second
 * rejection stops the run (auth_blocked). Before the retry:
 * - with totp.via, when the code page shows the last via button (the one that sends the code, "Send me the code"):
 *   resendCode clicks it again, through the same gate as the via clicks, and re-stamps `request.requestedAt` right
 *   before the click, so an email-code workflow takes the new code, not the rejected one;
 * - otherwise (no via, or no such button on the code page, as for a code from an authenticator app): the run waits for
 *   the next 30-second code window and asks again with the same `request` (stamped by submitPassword), clicking nothing.
 */
async function submitWorkflowCode(ctx: StepContext, spec: CodeSpec, timeout: number, request: CodeRequest): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const field = await resolveUnique(ctx.page, spec.field, timeout);
    const button = await resolveUnique(ctx.page, spec.submit, timeout);
    assertLoginPage(ctx);
    await assertFieldOnLoginPage(ctx, field.locator, 'totp');
    const code = await codeFromWorkflow(ctx, request);
    // The provider may take minutes: the page must still be the declared code page before anything is typed.
    assertLoginPage(ctx);
    await assertFieldOnLoginPage(ctx, field.locator, 'totp');
    // As with a generated code: the masker (shared with the trace scrubbing) learns the code before it is typed.
    ctx.masker.add([code], { wholeNumber: true });
    await field.locator.fill(code, { timeout });
    const typed = await field.locator.elementHandle({ timeout });
    // A rejected code reloads the page, so the boxes are ticked again on every attempt.
    await tickChecks(ctx, spec.check, timeout);
    await button.locator.click({ timeout });
    await settle(ctx.page);
    if (!(await codeRejected(ctx, spec.field, typed, timeout))) return;
    if (attempt >= 2) throw new Error(CODE_FAILURE + CODE_WORKFLOW_REJECTED_TWICE);
    if (await resendCode(ctx, spec.via, request, timeout)) continue;
    await sleep(msUntilNextWindow(Date.now()) + 250);
    // A slow site may have accepted the code after all while the run waited: then there is nothing to ask again.
    if (!onLoginPage(ctx) || !(await isVisibleNow(ctx.page, spec.field))) return;
  }
}

/**
 * The retry of a rejected workflow code: when the declared code page shows the last of `via` (the button that sends the
 * code), click it again. Gated like every via click (assertButtonPostsToLoginPage 'via': no post off the login pages, not
 * in a form with a password field); `request.requestedAt` is re-stamped right before the click. Returns false, clicking
 * nothing, without via or when the button is not on the page.
 */
async function resendCode(ctx: StepContext, via: DslLocator[] | undefined, request: CodeRequest, timeout: number): Promise<boolean> {
  const send = via?.at(-1);
  if (!send || !onLoginPage(ctx) || !(await isVisibleNow(ctx.page, send))) return false;
  const button = await resolveUnique(ctx.page, send, timeout);
  await assertButtonPostsToLoginPage(ctx, button.locator, 'via');
  request.requestedAt = new Date().toISOString();
  await button.locator.click({ timeout });
  await settle(ctx.page);
  return true;
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
  // Like a secret fill, a new password is typed only by signed steps: refused before anything is typed.
  if (s.changePassword && !ctx.signed) {
    let url = ctx.page.url();
    try { const u = new URL(url); url = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
    ctx.violations.push({ kind: 'signin', url, fatal: true });
    throw new SignInPolicyError(UNSIGNED_CHANGE_PASSWORD);
  }
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
    await submitPassword(ctx, s, pass.locator, secrets, state, timeout);
  } finally {
    await ctx.interrupts?.resume().catch(() => undefined);
  }
};

/** A rejected password: classified login_failed, so the login breaker opens and no repair runs. Names no typed value. */
const PASSWORD_REJECTED = `${DETECTED_PREFIX}login_failed`;
/** How long signIn without a code step waits after the password submit for the site to leave the login page or answer. */
const PASSWORD_ANSWER_WAIT_MS = 15_000;
/** How long the password field must stay gone from a loaded login page before signIn stops watching for a rejection. */
const PASSWORD_GONE_STABLE_MS = 1000;
/**
 * How long a sign-in page that came back must stay before the sign-in counts as rejected: the username page after
 * `next` (submitUsername), or an empty password field after the password submit (passwordRejection).
 */
const REJECTED_STABLE_MS = 1000;

const documentLoaded = (ctx: StepContext): Promise<boolean> =>
  ctx.page.evaluate(() => document.readyState !== 'loading').catch(() => false);

/**
 * Whether a visible field matching `loc` (its first 5 matches per candidate) holds no value: the password field a site
 * sends back with a rejection. A field that still holds a value is a form redrawn while it is pending, not a rejection.
 */
async function emptyFieldShows(ctx: StepContext, loc: DslLocator): Promise<boolean> {
  for (const c of candidatesOf(loc)) {
    try {
      const l = build(ctx.page, c);
      const n = Math.min(await l.count(), 5);
      for (let i = 0; i < n; i++) {
        const e = l.nth(i);
        if ((await e.isVisible()) && (await e.inputValue({ timeout: 1000 })) === '') return true;
      }
    } catch (err) {
      if (ctx.page.isClosed()) throw err;
      // Race, or not an input: not an empty field.
    }
  }
  return false;
}

/**
 * After the password submit, a check to poll: true once the site sent the password page back. That is: on a declared
 * login page, with the document loaded, the field we typed into is gone (a new document or a re-render) and an empty
 * field matching `password` shows, for a whole REJECTED_STABLE_MS. The same field still showing is no rejection (the
 * submit may not have moved on yet), and neither is a redrawn field that still holds a value or a page without the
 * password field. Nor is a change-password page (`change`, signIn.changePassword.detect, showing): its empty password
 * fields may match `password`, and changePassword takes over there. Keeps its own state: one per submit.
 */
function passwordRejection(ctx: StepContext, password: DslLocator, typed: ElementHandle, change: DslLocator | undefined): () => Promise<boolean> {
  let since: number | undefined;
  return async () => {
    const back = onLoginPage(ctx)
      && !(change && (await isVisibleNow(ctx.page, change)))
      && !(await typed.evaluate((el) => el.isConnected).catch(() => false))
      && (await documentLoaded(ctx))
      && (await emptyFieldShows(ctx, password));
    if (!back) { since = undefined; return false; }
    since ??= Date.now();
    return Date.now() - since >= REJECTED_STABLE_MS;
  };
}

/**
 * signIn without a code step, after the password submit: waits up to min(timeout, PASSWORD_ANSWER_WAIT_MS) until the
 * run left the declared login pages (not rejected), the change-password page shows (`change`: not rejected), the
 * password page came back (`rejected`: true), or the password field stayed gone from a loaded document for
 * PASSWORD_GONE_STABLE_MS (not rejected: a code page or any other page). When the wait runs out with the same field
 * still showing, nothing is decided: not rejected.
 */
async function passwordRejected(
  ctx: StepContext, password: DslLocator, change: DslLocator | undefined, rejected: () => Promise<boolean>, timeout: number,
): Promise<boolean> {
  let goneSince: number | undefined;
  const seen = await poll(async () => {
    if (!onLoginPage(ctx)) return 'left';
    if (change && (await isVisibleNow(ctx.page, change))) return 'change';
    if (await rejected()) return 'rejected';
    if ((await isVisibleNow(ctx.page, password)) || !(await documentLoaded(ctx))) { goneSince = undefined; return undefined; }
    goneSince ??= Date.now();
    return Date.now() - goneSince >= PASSWORD_GONE_STABLE_MS ? 'gone' : undefined;
  }, Math.min(timeout, PASSWORD_ANSWER_WAIT_MS));
  return seen === 'rejected';
}

type SubmitSpec = Pick<SignInSpec, 'password' | 'submit' | 'totp' | 'changePassword'>;

/**
 * After the password is typed (both paths): submit it and type the code (submitCredentials), then, with
 * signIn.changePassword, set a new password when the site asks for one (changePassword).
 */
async function submitPassword(ctx: StepContext, s: SubmitSpec, pass: Locator, secrets: PortalSecrets, state: RunState, timeout: number): Promise<void> {
  await submitCredentials(ctx, s, pass, state, timeout);
  if (s.changePassword) await changePassword(ctx, s.changePassword, secrets, state, timeout);
}

/**
 * Click submit, then check the site's answer. Without a code step, a password page that comes back is a rejected
 * password (passwordRejected: `detected:login_failed`). When the step declares a code, wait for the code field or a
 * rejected password (the same check) and type the code. Without totp.via the code page must follow at once on a login
 * page (else no code was asked); with via, the pages in between are clicked through first (throughVia). A change-password
 * page (changePassword.detect) is never a rejected password, and ends the wait for a code field without via. The code
 * provider's requestedAt is stamped right before the password submit, and again right before the first via click: no
 * later than the click that makes the site send the code, so a workflow that takes only mail sent after requestedAt
 * finds it.
 */
async function submitCredentials(ctx: StepContext, s: SubmitSpec, pass: Locator, state: RunState, timeout: number): Promise<void> {
  const submit = await resolveUnique(ctx.page, s.submit, timeout);
  const typed = await pass.elementHandle({ timeout });
  await assertButtonPostsToLoginPage(ctx, submit.locator, 'submit');
  const request: CodeRequest = { requestedAt: new Date().toISOString() };
  await submit.locator.click({ timeout });
  state.submitClicked = true;
  await settle(ctx.page);
  const password = s.password;
  const change = s.changePassword?.detect;
  const rejected = passwordRejection(ctx, password, typed, change);
  if (!s.totp) {
    if (await passwordRejected(ctx, password, change, rejected, timeout)) throw new Error(PASSWORD_REJECTED);
    return;
  }
  const totpSpec = s.totp;
  // The pages between the password and the code (via) need not be login pages: only the code page is checked, by the
  // code's own checks before anything is typed (throughVia gates each via button before its click).
  if (!totpSpec.via && !onLoginPage(ctx)) return;
  const next = totpSpec.via
    ? await throughVia(ctx, { field: totpSpec.field, password, via: totpSpec.via }, rejected, request, timeout)
    : await poll(async () => {
      if (await isVisibleNow(ctx.page, totpSpec.field)) return 'totp';
      if (change && (await isVisibleNow(ctx.page, change))) return 'change';
      if (await rejected()) return 'rejected';
      return undefined;
    }, Math.min(timeout, 5000));
  if (next === 'rejected') throw new Error(PASSWORD_REJECTED);
  if (next !== 'totp') return;
  if (totpSpec.source === 'workflow') await submitWorkflowCode(ctx, totpSpec, timeout, request);
  else await submitTotp(ctx, totpSpec, timeout);
}

/**
 * totp.via, after the password submit: wait up to `timeout` for a rejected password, the first of the via locators not
 * passed yet, or the code field. A via locator that shows is clicked (an earlier one that did not show is skipped, and
 * one that shows together with the code field, a "Send code" button beside it, is still clicked first), and the wait
 * starts over from the next one. Returns once the code field shows with no via locator left to click, or the password
 * was rejected (no via button is clicked then). No via button is clicked while the password field still shows. Nothing
 * typed and the pages need not be login pages, but each button is gated like signIn's own buttons before its click
 * (assertButtonPostsToLoginPage: no post off the login pages, not in a form with a password field). Re-stamps
 * `request.requestedAt` right before the first click. Throws signInCodeFieldMissing (drift) when a wait runs out.
 */
async function throughVia(
  ctx: StepContext, spec: { field: DslLocator; password: DslLocator; via: DslLocator[] }, rejected: () => Promise<boolean>,
  request: CodeRequest, timeout: number,
): Promise<'totp' | 'rejected'> {
  const { field, password, via } = spec;
  let from = 0;
  let clicked = 0;
  for (;;) {
    const seen = await poll(async () => {
      if (await rejected()) return 'rejected' as const;
      // The password page is still there (the submit has not moved on yet): nothing on it is clicked.
      if (!(await isVisibleNow(ctx.page, password))) {
        for (let i = from; i < via.length; i++) if (await isVisibleNow(ctx.page, via[i])) return { via: i };
      }
      if (await isVisibleNow(ctx.page, field)) return 'totp' as const;
      return undefined;
    }, timeout);
    if (!seen) throw new Error(signInCodeFieldMissing(Math.max(1, Math.round(timeout / 1000)), clicked, via.length));
    if (typeof seen === 'string') return seen;
    const button = await resolveUnique(ctx.page, via[seen.via], timeout);
    await assertButtonPostsToLoginPage(ctx, button.locator, 'via');
    if (clicked === 0) request.requestedAt = new Date().toISOString();
    await button.locator.click({ timeout });
    clicked++;
    from = seen.via + 1;
    await settle(ctx.page);
  }
}

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
 * (only now), check it, type the password, submit, type the code when `spec.totp` is set, and set a new password when
 * `spec.changePassword` is set and the site asks for one.
 */
export async function submitPasswordPage(
  ctx: StepContext, spec: SubmitSpec, secrets: PortalSecrets, state: RunState, timeout: number,
): Promise<void> {
  // The agent calls this a model turn after phase 1: the page must still be a declared login page.
  assertLoginPage(ctx);
  const pass = await resolveUnique(ctx.page, spec.password, timeout);
  await assertFieldOnLoginPage(ctx, pass.locator, 'password');
  await pass.locator.fill(secrets.password, { timeout });
  await submitPassword(ctx, spec, pass.locator, secrets, state, timeout);
}

/**
 * The two ends of a password change that did not go through, both classified password_change_failed (the login breaker
 * stays closed). Neither names a value. The site sent its change page back: it did not take the new password.
 */
const PASSWORD_CHANGE_REFUSED = `${DETECTED_PREFIX}password_change_failed: the site sent its change-password page back, so it did not take the new password`;
/** The change page still showed when the wait for the site's answer ran out: the new password may or may not be in force. */
const passwordChangeUnconfirmed = (seconds: number) =>
  `${DETECTED_PREFIX}password_change_failed: the site did not confirm the new password within ${seconds} s, so it may or may not be in force`;
/** How long, once the sign-in is done, the step looks for changePassword.detect. */
const CHANGE_PAGE_WAIT_MS = 2000;
/** How long the site may take to answer the new password. */
const CHANGE_ANSWER_WAIT_MS = 15_000;
/** How long changePassword.detect must stay gone from a loaded document before the change counts as done. */
const CHANGE_GONE_STABLE_MS = 1000;

/**
 * signIn.changePassword, once the sign-in and its code are done (both sign-in paths end here). When `detect` shows on a
 * loaded document within CHANGE_PAGE_WAIT_MS: the page must be a declared login page, `current` (when given) and every
 * `new` field password inputs on one, and `submit` must post to one (else a fatal signin violation, before anything is
 * typed). The value is rendered as a secret fill's (the masker holds it before the first keystroke); then the Site Login
 * password goes into `current`, the value into each `new` field, and `submit` is clicked. Sets state.passwordChanged
 * once `detect` is gone (changeAnswer); throws `detected:password_change_failed: …` when the site sent the change page
 * back, or when it still showed once the wait ran out (then the text says the new password may or may not be in force).
 */
async function changePassword(ctx: StepContext, spec: ChangePasswordSpec, secrets: PortalSecrets, state: RunState, timeout: number): Promise<void> {
  const asked = await poll(async () => (await documentLoaded(ctx)) && (await isVisibleNow(ctx.page, spec.detect)), Math.min(timeout, CHANGE_PAGE_WAIT_MS));
  if (!asked) return;
  assertLoginPage(ctx);
  const current = spec.current ? (await resolveUnique(ctx.page, spec.current, timeout)).locator : undefined;
  const fresh: Locator[] = [];
  for (const loc of spec.new) fresh.push((await resolveUnique(ctx.page, loc, timeout)).locator);
  const submit = (await resolveUnique(ctx.page, spec.submit, timeout)).locator;
  if (current) await assertFieldOnLoginPage(ctx, current, 'current password');
  for (const field of fresh) await assertFieldOnLoginPage(ctx, field, 'new password');
  await assertButtonPostsToLoginPage(ctx, submit, 'submit');
  const name = SECRET_FILL_VALUE.exec(spec.value)?.[1];
  if (name === undefined) throw new Error('signIn: changePassword.value must be exactly one {{var.name}} template');
  const value = renderSecretValue(name, spec.value, ctx.vars, ctx.masker);
  // Each field is checked again right before it is typed into, as signIn does: the page may have moved since.
  if (current) {
    await assertFieldOnLoginPage(ctx, current, 'current password');
    await current.fill(secrets.password, { timeout });
  }
  for (const field of fresh) {
    await assertFieldOnLoginPage(ctx, field, 'new password');
    await field.fill(value, { timeout });
  }
  const typed = await fresh[0].elementHandle({ timeout });
  await submit.click({ timeout });
  await settle(ctx.page);
  const answer = await changeAnswer(ctx, spec.detect, typed, timeout);
  if (answer === 'refused') throw new Error(PASSWORD_CHANGE_REFUSED);
  if (answer === 'unconfirmed') throw new Error(passwordChangeUnconfirmed(Math.max(1, Math.round(Math.min(timeout, CHANGE_ANSWER_WAIT_MS) / 1000))));
  state.passwordChanged = true;
}

/**
 * After the change form's submit: 'accepted' once `detect` stayed gone from a loaded document for CHANGE_GONE_STABLE_MS;
 * 'refused' when the change page came back (a new document, or a re-render without the field we typed into, showing
 * `detect`); 'unconfirmed' when neither happened within min(timeout, CHANGE_ANSWER_WAIT_MS).
 */
async function changeAnswer(ctx: StepContext, detect: DslLocator, typed: ElementHandle, timeout: number): Promise<'accepted' | 'refused' | 'unconfirmed'> {
  let goneSince: number | undefined;
  const seen = await poll(async () => {
    if (!(await documentLoaded(ctx))) { goneSince = undefined; return undefined; }
    if (await isVisibleNow(ctx.page, detect)) {
      goneSince = undefined;
      return (await typed.evaluate((el) => el.isConnected).catch(() => false)) ? undefined : 'refused';
    }
    goneSince ??= Date.now();
    return Date.now() - goneSince >= CHANGE_GONE_STABLE_MS ? 'accepted' : undefined;
  }, Math.min(timeout, CHANGE_ANSWER_WAIT_MS));
  return seen ?? 'unconfirmed';
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

registerHandlers('browser', { signIn, detect });
