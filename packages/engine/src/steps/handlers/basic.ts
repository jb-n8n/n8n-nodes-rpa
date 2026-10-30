import type { BrowserContext, Locator as PwLocator, Request } from 'playwright-core';
import { formPostsElsewhere, notHttp, offListSite, PASSWORD_FILL_REFUSED, PASSWORD_FILL_REFUSED_STEPS } from '../../messages.js';
import { renderVars } from '../../secrets/render.js';
import type { RunState, Step } from '../../types.js';
import { PolicyError } from '../errors.js';
import { formTarget as formTargetInPage, type FormTarget } from '../form-target.js';
import { build, resolveUnique } from '../locator.js';
import { shownUrl } from '../urls.js';
import { poll, sleep } from '../poll.js';
import { settle, type Handler, type StepContext } from '../run.js';
import { registerHandlers } from './index.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

/** Network quiet that ends the write window: nothing in flight for this long. */
const QUIET_MS = 500;

/**
 * Requests of a browser context from now on. `quiet` resolves once nothing started since then is still in flight and
 * nothing changed for QUIET_MS, when the context closes (cancel, budget, disconnect), or after timeoutMs, whichever
 * comes first. A request the click starts reaches the session's route handler while it is in flight, so the window
 * cannot close before the session has decided on it. A navigation stays in flight until its document arrives, so this
 * also covers "waits for the next page load".
 */
function watchNetwork(context: BrowserContext) {
  const inFlight = new Set<Request>();
  let lastChange = Date.now();
  let closed = false;
  const started = (r: Request) => { inFlight.add(r); lastChange = Date.now(); };
  const ended = (r: Request) => { if (inFlight.delete(r)) lastChange = Date.now(); };
  const gone = () => { closed = true; };
  context.on('request', started);
  context.on('requestfinished', ended);
  context.on('requestfailed', ended);
  context.on('close', gone);
  return {
    async quiet(timeoutMs: number): Promise<void> {
      const until = Date.now() + timeoutMs;
      while (!closed && Date.now() < until) {
        if (inFlight.size === 0 && Date.now() - lastChange >= QUIET_MS) return;
        await sleep(Math.max(1, Math.min(50, until - Date.now())));
      }
    },
    stop() {
      context.off('request', started);
      context.off('requestfinished', ended);
      context.off('requestfailed', ended);
      context.off('close', gone);
    },
  };
}

/**
 * Where clicking this element submits its form (steps/form-target.ts: null when it submits nothing, so it is not
 * pre-checked). This is an early, readable refusal only: the session enforces the window hosts on every request
 * whatever this returns.
 */
function formTarget(locator: PwLocator): Promise<FormTarget | null> {
  return locator.evaluate(formTargetInPage, false);
}

/** Fails the step before the click when the form would POST to a host outside the window. */
async function assertFormTarget(ctx: StepContext, locator: PwLocator): Promise<void> {
  const hosts = ctx.policy.writeWindow?.hosts ?? [];
  const target = await formTarget(locator);
  if (!target || target.method !== 'POST') return;
  let host: string;
  let where = '';
  if (URL.canParse(target.action)) {
    const u = new URL(target.action);
    host = u.protocol === 'http:' || u.protocol === 'https:' ? u.host : u.protocol;
    where = shownUrl(target.action);
  } else {
    host = 'an address that is not a URL';
  }
  if (hosts.includes(host)) return;
  // Masked first, then capped: a secret across the cap is never left half visible.
  ctx.violations.push({ kind: 'write', url: ctx.masker.mask(where).slice(0, 300), method: 'POST', fatal: true });
  throw new PolicyError(formPostsElsewhere(ctx.masker.mask(host).slice(0, 300), hosts));
}

/** Opening and closing one of the session's write windows: Fill and Submit's, or a declared step's own (Session.armSubmit). */
export interface WindowGate { open(): void; close(): void }

/**
 * Runs `act` (a click) with `win` open and closes it however that ends; no window, no gate. With `quietMs` the window
 * stays open until network quiet after the click (at most quietMs): requests the click started reach the session's
 * route handler while in flight, so they are decided before the window closes.
 */
export async function withWindow<T>(ctx: StepContext, win: WindowGate | undefined, act: () => Promise<T>, quietMs?: number): Promise<T> {
  const net = quietMs === undefined ? undefined : watchNetwork(ctx.page.context());
  win?.open();
  try {
    const out = await act();
    await net?.quiet(quietMs as number);
    return out;
  } finally {
    win?.close();
    net?.stop();
  }
}

/** The submit click with the write window open: check the target, open, click, wait for quiet, always close. */
async function clickInWriteWindow(ctx: StepContext, locator: PwLocator, state: RunState, timeout: number): Promise<void> {
  const win = ctx.writeWindow;
  if (!win || !ctx.policy.writeWindow) throw new Error('the write window is not available in this session');
  // Playwright's actionability wait (visible, stable, enabled) happens outside the window: it covers only the real click.
  // The form target is read once the control is actionable, right before the window opens.
  await locator.click({ trial: true, timeout });
  await assertFormTarget(ctx, locator);
  try {
    await withWindow(ctx, win, () => locator.click({ timeout }), timeout);
  } finally {
    if (win.posts.length > 0) state.submitted = true;
  }
  await settle(ctx.page);
}

/**
 * Whether the element fill/selectOption actually types into is a password input; with `clear`, a password input found
 * there also loses its value. The control is found the way playwright-core 1.63 retargets for fill and selectOption
 * ('follow-label'): an element that is not a form control, a control role or contenteditable is replaced by its
 * closest button/[role=button]/[role=checkbox]/[role=radio], and then, if still not a control, by the control of its
 * enclosing label. So a locator on a label (`{ text: 'Password' }`, `label[for=pw]`) is checked against the input.
 */
async function passwordControl(locator: PwLocator, clear: boolean): Promise<boolean> {
  return locator.evaluate((node, wipe) => {
    let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return false;
    const editable = (e: Element) => e instanceof HTMLElement && e.isContentEditable;
    if (!el.matches('input, textarea, select') && !editable(el)) el = el.closest('button, [role=button], [role=checkbox], [role=radio]') ?? el;
    if (!el.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]') && !editable(el)) {
      const control = el.closest('label')?.control;
      if (control) el = control;
    }
    if (!(el instanceof HTMLInputElement) || el.type !== 'password') return false;
    if (wipe) el.value = '';
    return true;
  }, clear);
}

function refusePassword(ctx: StepContext): never {
  ctx.violations.push({ kind: 'signin', url: ctx.masker.mask(shownUrl(ctx.page.url())).slice(0, 300), fatal: true });
  throw new PolicyError(ctx.policy.writeWindow ? PASSWORD_FILL_REFUSED : PASSWORD_FILL_REFUSED_STEPS);
}

/**
 * fill/select never type into a password input: only signIn types passwords. Checked before
 * typing, and again afterwards, because a field can turn into a password input on focus: then its value is cleared and
 * the step fails the same way.
 */
async function withoutPasswords(ctx: StepContext, locator: PwLocator, act: () => Promise<unknown>): Promise<void> {
  if (await passwordControl(locator, false)) refusePassword(ctx);
  try {
    await act();
  } finally {
    // Also after a failed fill: whatever was typed into a field that is now a password input is wiped, and the refusal wins.
    if (await passwordControl(locator, true).catch(() => false)) refusePassword(ctx);
  }
}

const goto: Handler = async (ctx, step, _state, timeout) => {
  const s = step as S<'goto'>;
  const parsed = new URL(renderVars(s.goto, ctx.vars, ctx.masker), ctx.script.startUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.violations.push({ kind: 'host', url: ctx.masker.mask(`${parsed.protocol}${parsed.pathname}`).slice(0, 300), fatal: true });
    throw new PolicyError(notHttp(parsed.protocol));
  }
  if (!ctx.policy.navHosts.includes(parsed.host)) {
    ctx.violations.push({ kind: 'host', url: parsed.origin + parsed.pathname, host: parsed.host, fatal: true });
    throw new PolicyError(offListSite(parsed.host, ctx.policy.navHosts));
  }
  const url = parsed.toString();
  const res = await ctx.page.goto(url, { timeout, waitUntil: s.waitUntil ?? 'domcontentloaded' });
  if (res && res.status() >= 500) throw new Error(`HTTP ${res.status()} at ${shownUrl(url)}`);
};

const click: Handler = async (ctx, step, state, timeout) => {
  const s = step as S<'click'>;
  const { locator, candidate } = await resolveUnique(ctx.page, s.click, timeout);
  if (ctx.writeStep) {
    await clickInWriteWindow(ctx, locator, state, timeout);
    return candidate;
  }
  await locator.click({ timeout });
  await settle(ctx.page);
  return candidate;
};

const fill: Handler = async (ctx, step, _state, timeout) => {
  const s = step as S<'fill'>;
  const { locator, candidate } = await resolveUnique(ctx.page, s.fill.field, timeout);
  await withoutPasswords(ctx, locator, () => locator.fill(renderVars(s.fill.value, ctx.vars, ctx.masker), { timeout }));
  return candidate;
};

const select: Handler = async (ctx, step, _state, timeout) => {
  const s = step as S<'select'>;
  const { locator, candidate } = await resolveUnique(ctx.page, s.select.field, timeout);
  await withoutPasswords(ctx, locator, () => locator.selectOption(
    Array.isArray(s.select.value) ? s.select.value.map((v) => renderVars(v, ctx.vars, ctx.masker)) : renderVars(s.select.value, ctx.vars, ctx.masker), { timeout },
  ));
  return candidate;
};

const check: Handler = async (ctx, step, _state, timeout) => {
  const s = step as S<'check'>;
  const { locator, candidate } = await resolveUnique(ctx.page, s.check.field, timeout);
  await locator.setChecked(s.check.checked ?? true, { timeout });
  return candidate;
};

const waitFor: Handler = async (ctx, step, _state, timeout) => {
  const w = (step as S<'waitFor'>).waitFor;
  if (w.response) {
    const needle = w.response.urlContains;
    await ctx.page.waitForResponse((r) => r.url().includes(needle), { timeout });
  }
  if (!w.target) return;
  const target = w.target;
  if (w.minCount) {
    const min = w.minCount;
    const ok = await poll(async () => (await build(ctx.page, target).count()) >= min, timeout);
    if (!ok) throw new Error(`waited for at least ${min} matching elements`);
  } else {
    await build(ctx.page, target).first().waitFor({ state: w.state ?? 'visible', timeout });
  }
  if (w.hasText) {
    const text = w.hasText;
    // A closed page (cancel, budget, disconnect) ends the wait now instead of polling until the step timeout.
    const read = () => build(ctx.page, target).first().innerText().catch((err: unknown) => {
      if (ctx.page.isClosed()) throw err;
      return '';
    });
    const ok = await poll(async () => ((await read()) || '').includes(text), timeout);
    if (!ok) throw new Error(`waited for text "${text}"`);
  }
};

registerHandlers('browser', { goto, click, fill, select, check, waitFor });
