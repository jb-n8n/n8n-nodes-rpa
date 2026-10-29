import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { LOOKS_DESTRUCTIVE, NO_TOTP_SECRET } from '../messages.js';
import type { Masker } from '../secrets/mask.js';
import { beginSignIn, findUsernamePage, submitPasswordPage, submitTotp, submitUsername } from '../steps/handlers/auth.js';
import { DETECTED_PREFIX } from '../classify/classify.js';
import { candidatesOf } from '../steps/locator.js';
import { poll } from '../steps/poll.js';
import { isLoginPage } from '../steps/urls.js';
import { FILE_CHECK_FAILED_PREFIX, type DownloadTemplate } from '../steps/file-check.js';
import { runSteps, type StepContext } from '../steps/run.js';
import { surfaceOf } from '../surface/browser.js';
import type { Interrupt, Locator, OutputSpec, RunState, Step } from '../types.js';
import { candidatesFor } from './candidates.js';
import { DENYLIST, fold, INVISIBLE, isDestructive, isDestructiveUrl, normalizeForDenylist } from '../policy/destructive.js';
import { currentIdentity, type Snapshot, type SnapshotElement } from './snapshot.js';

export { DENYLIST, isDestructive, normalizeForDenylist };

/** OpenAI/LangChain-style function tool definition (also accepted by LangChain's bindTools for Anthropic models). */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type AgentToolName = 'look' | 'click' | 'fill' | 'select' | 'sign_in' | 'enter_code' | 'dismiss' | 'expand_all' | 'next_page' | 'extract' | 'download' | 'back' | 'done';
export type DoneOutcome = 'found' | 'not_found' | 'blocked';

/** One tool call as it was executed. Compile uses only `ok` actions. */
export interface AgentAction {
  tool: string;
  ok: boolean;
  /** Origin + pathname of the page the action started on (unmasked; mask before output). */
  url: string;
  /** Masked reason for a refusal or failure, or the done note. */
  note?: string;
  /** The DSL step that ran: click, fill, select, signIn, clickAll, extract, or a when-guarded dismiss click. */
  step?: Step;
  /** dismiss of a control inside an overlay: the interrupt the compiled script installs. */
  interrupt?: Interrupt;
  /** enter_code: the code field and its submit button (compiled into the signIn step's totp). */
  totp?: { field: Locator; submit: Locator };
  /**
   * Fingerprint of the page as the agent last saw it before this action: the full URL (query and fragment included),
   * the title, the masked page text (a superset of the text the model sees) and every snapshot element with its ARIA
   * toggle states. Successful actions only; absent when the page could not be read. Compile
   * uses it only to recognise a return to an identical page and cut the exploration loop in between.
   */
  pageState?: string;
}

/** The page-state fingerprint of a snapshot (AgentAction.pageState). A hash: it never carries page text. */
function pageStateOf(href: string, s: Pick<Snapshot, 'title' | 'elements' | 'text'>): string {
  const elements = s.elements.map((e) => [e.role, e.name, e.tag, e.type ?? '', e.href ?? '', e.overlay ? 1 : 0, e.states ?? '']);
  return createHash('sha256').update(JSON.stringify([href, s.title, elements, s.text])).digest('hex').slice(0, 32);
}
export interface ToolOutcome {
  text: string;
  error: boolean;
  done?: { outcome: DoneOutcome; note: string };
}
export interface AgentToolsInit {
  ctx: StepContext;
  state: RunState;
  output: OutputSpec;
  /** A file task: the agent gets the download tool instead of extract and next_page, and may not finish before a file passes. */
  download?: DownloadTemplate;
}

export const MAX_TYPED = 64;
const MAX_REF_ECHO = 20;
const MAX_TOOL_NAME = 40;
const PAGE_TEXT_FOR_MODEL = 1500;
/** How long one agent action waits for its control; never more than the run's step timeout. */
const AGENT_ACTION_TIMEOUT_MS = 5_000;

const str = (description: string) => ({ type: 'string', description });
const REF = str('Element ref from the latest result, for example e12');
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export const AGENT_TOOLS: ToolDef[] = [
  tool('look', 'Take a fresh look at the current page.'),
  tool('click', 'Click a link, button or tab.', { ref: REF }, ['ref']),
  tool('fill', 'Type short, non-secret text (a search term or a date) into a field. Never credentials.', { ref: REF, value: str('Text to type, at most 64 characters') }, ['ref', 'value']),
  tool('select', 'Choose an option in a drop-down.', { ref: REF, value: str('Option label or value') }, ['ref', 'value']),
  tool('sign_in', 'Sign in with the login form. The engine types the username and password itself. One page: username_ref, password_ref and submit_ref. Username and password on separate pages: first username_ref and next_ref (the button that leads to the password page), then password_ref and submit_ref.', {
    username_ref: REF, next_ref: str('Ref of the button that leads from the username page to the password page'), password_ref: REF, submit_ref: REF,
  }),
  tool('enter_code', 'Answer an authenticator-app code prompt after sign_in. The engine generates and types the code.', { field_ref: REF, submit_ref: REF }, ['field_ref', 'submit_ref']),
  tool('dismiss', 'Close a cookie banner or pop-up, or skip an interstitial page (for example "Remind me later") that is not on the way to the data.', { ref: str('Ref of the control that closes or skips it') }, ['ref']),
  tool('expand_all', 'Open every collapsed section on the page.'),
  tool('next_page', 'Go to the next page of a list of results.', { ref: str('Ref of the next-page control') }, ['ref']),
  tool('extract', 'Read the rows on the current page. Call it on every page of the results.', { scope_ref: str('Optional ref of a region to read; the main content by default') }),
  tool('back', 'Go back to the previous page.'),
  tool('done', 'Finish the task.', {
    outcome: { type: 'string', enum: ['found', 'not_found', 'blocked'], description: 'found: every row was extracted; not_found: the data is not there; blocked: you cannot continue' },
    note: str('One sentence on what you found or why you stopped'),
  }, ['outcome', 'note']),
];

/** The tools of a file task: no extract or next_page, plus download, and a done that names the file. */
export const FILE_AGENT_TOOLS: ToolDef[] = [
  ...AGENT_TOOLS.filter((t) => t.function.name !== 'extract' && t.function.name !== 'next_page').map((t): ToolDef => {
    if (t.function.name !== 'done') return t;
    const props = t.function.parameters.properties as Record<string, { description?: string }>;
    return tool('done', t.function.description, {
      ...props,
      outcome: { ...props.outcome, description: 'found: the file was downloaded and passed the checks; not_found: the file is not there; blocked: you cannot continue' },
    }, ['outcome', 'note']);
  }),
  tool('download', 'Click the control that downloads the file. The engine checks the file.', { ref: REF }, ['ref']),
];

const PAGE_CONTENT_TOKEN = /page[\s_\-‐-―]*content/g;

/**
 * Neutralizes every `page_content` token in page-derived text (`</page_content foo>`, `<page_content/>`, `PAGE-CONTENT`,
 * zero-width or full-width variants…) by replacing it with `page-data`, so nothing can open or close the untrusted-data
 * wrapper. Matching runs on folded text; replacement maps back onto the original, so no other character changes.
 */
export function neutralize(s: string): string {
  const { chars, owner } = fold(s);
  const folded = chars.join('').toLowerCase();
  // toLowerCase keeps the length for the folded (NFKC, mark-free, Latin-mapped) characters we match on; guard anyway.
  if ([...folded].length !== chars.length) return [...s].filter((c) => !INVISIBLE.test(c)).join('').replace(/page[\s_\-]*content/gi, 'page-data');
  const cps = [...s];
  const spans: [number, number][] = [];
  for (const m of folded.matchAll(PAGE_CONTENT_TOKEN)) {
    const start = [...folded.slice(0, m.index)].length;
    const end = start + [...m[0]].length - 1;
    spans.push([owner[start], owner[end]]);
  }
  if (!spans.length) return s;
  let out = '';
  let at = 0;
  for (const [a, b] of spans) {
    out += cps.slice(at, a).join('') + 'page-data';
    at = b + 1;
  }
  return out + cps.slice(at).join('');
}
const wrap = (s: string) => `<page_content>\n${neutralize(s)}\n</page_content>`;
const label = (el: SnapshotElement) => neutralize(el.name || el.tag).slice(0, 80);
const clipRef = (ref: string) => ref.slice(0, MAX_REF_ECHO);

/** The snapshot as plain lines, without the wrapper. */
function snapshotBody(s: Snapshot, maxText: number): string {
  const lines = s.elements.map((e) => {
    let line = `[${e.ref}] ${e.role || e.tag} ${JSON.stringify(e.name)}`;
    if (e.visibleText) line += ` text=${JSON.stringify(e.visibleText.slice(0, 80))}`;
    if (e.type) line += ` type=${e.type}`;
    if (e.value) line += ` value=${JSON.stringify(e.value)}`;
    else if (e.valueHidden) line += ' value=(hidden)';
    if (e.href) line += ` -> ${e.href}`;
    if (e.overlay) line += ` (in overlay ${e.overlay})`;
    return line;
  });
  const overlays = s.overlays.length ? `\nOverlays covering the page: ${s.overlays.join(', ')}` : '';
  return `Page: ${JSON.stringify(s.title)} at ${s.url}${overlays}\nElements:\n${lines.join('\n') || '(none)'}\nText:\n${s.text.slice(0, maxText)}`;
}

/** Renders a snapshot for the model; everything page-derived is inside one page_content block. */
export function renderSnapshot(s: Snapshot, maxText = PAGE_TEXT_FOR_MODEL): string {
  return wrap(snapshotBody(s, maxText));
}

/** A bad tool argument: the message is engine text and goes back to the model as is. */
class ToolInputError extends Error {}

/** What phase 1 of a two-page sign_in waits for on the next page: any visible password field. */
const ANY_PASSWORD_FIELD: Locator = { css: 'input[type="password"]' };

export class AgentTools {
  readonly actions: AgentAction[] = [];
  /** When enter_code last typed a code (epoch ms); a full prove replay waits for the next TOTP window after it. */
  codeSubmittedAt?: number;
  private nextRef = 1;
  private current = new Map<string, SnapshotElement>();
  /** pageStateOf the latest snapshot; undefined while there is none (or it failed). */
  private seenState?: string;
  /** seenState when the running tool call started: the state its action is recorded with. */
  private startState?: string;
  /** How often each page state was seen in this run, and the count for the latest snapshot (loop feedback). */
  private visits = new Map<string, number>();
  private lastVisit = 0;
  /** A two-page sign_in after phase 1: the username page's locators and where its (stepless) action sits in `actions`. */
  private pendingSignIn?: { username: Locator; next: Locator; at: number };
  /**
   * 'pending': phase 1 of a two-page sign_in typed the username and moved to the password page, and phase 2 has not run;
   * 'username_rejected': the site sent the username page back. The agent lane reads it (login_failed, auth_blocked).
   */
  signInStage?: 'pending' | 'username_rejected';

  constructor(private readonly init: AgentToolsInit) {}

  private get ctx(): StepContext { return this.init.ctx; }
  private get page(): Page { return this.init.ctx.page; }
  private get masker(): Masker { return this.init.ctx.masker; }

  /** Takes a fresh snapshot (every earlier ref stops working) and renders it for the model. */
  async look(): Promise<string> {
    const body = await this.lookBody();
    return `${this.revisitNote()}${wrap(body)}`;
  }

  /** Engine text before the page block when the agent is back on a page it already saw: it nudges it out of a loop. */
  private revisitNote(): string {
    return this.lastVisit > 1
      ? `This is visit ${this.lastVisit} to this exact page in this run. If the data was not here before, try a different section instead of repeating the same path.\n`
      : '';
  }

  /** Fresh snapshot, unwrapped, so a result can put page data and the snapshot in one page_content block. */
  private async lookBody(): Promise<string> {
    // Invalidate first: if the snapshot fails, no earlier ref may keep working.
    const previous = this.seenState;
    this.current = new Map();
    this.seenState = undefined;
    this.lastVisit = 0;
    // No field values on a declared login page: split code boxes and the username field hold sign-in data.
    const surface = surfaceOf(this.ctx);
    const s = await surface.snapshot(this.masker, { refStart: this.nextRef, values: !isLoginPage(this.ctx.policy, surface.address()) });
    this.nextRef = s.nextRef;
    this.current = new Map(s.elements.map((e) => [e.ref, e]));
    this.seenState = pageStateOf(surface.address(), s);
    // A visit is arriving on a page: reading the same page again (extract, a failed click) is not a new visit.
    if (this.seenState !== previous) {
      this.lastVisit = (this.visits.get(this.seenState) ?? 0) + 1;
      this.visits.set(this.seenState, this.lastVisit);
    }
    return snapshotBody(s, PAGE_TEXT_FOR_MODEL);
  }

  /** Page-derived data plus a fresh snapshot, in a single page_content block. Empty when the page cannot be read. */
  private async pageBlock(data?: string): Promise<string> {
    let body = '';
    try { body = await this.lookBody(); } catch { /* the page is gone, for example after a blocked request closed the session */ }
    const content = [data, body].filter(Boolean).join('\n');
    const note = body ? this.revisitNote() : '';
    return `${content ? `\n${note}${wrap(content)}` : ''}${body ? '' : '\n(the page could not be read; call look)'}`;
  }

  async run(call: ToolCall): Promise<ToolOutcome> {
    const url = this.here();
    this.startState = this.seenState;
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const name = String(call.name).slice(0, MAX_TOOL_NAME);
    // Half way through a two-page sign_in, nothing may act on the password page but the second sign_in call: a code or a
    // click there could submit the form without the password (a failed attempt that counts toward a lockout).
    if (this.pendingSignIn && !['look', 'sign_in', 'done'].includes(call.name)) {
      return this.refuse(name, url, 'refused: finish signing in first; call sign_in with password_ref and submit_ref on the password page');
    }
    // The username was typed but no password was submitted, and nothing is pending (a failed phase 2, or a sign-in that
    // stopped before its submit): any page-changing tool could post the form with an empty password. Only look and done.
    const { credentialsSubmitted, submitClicked } = this.init.state;
    if (!this.pendingSignIn && credentialsSubmitted && !submitClicked && !['look', 'done'].includes(call.name)) {
      return this.refuse(name, url, "refused: the username was typed but the sign-in didn't finish; call done");
    }
    try {
      switch (call.name) {
        case 'look':
          return await this.success({ tool: 'look', ok: true, url }, 'current page');
        case 'click': return await this.click(args, url);
        case 'fill': return await this.type(args, url, 'fill');
        case 'select': return await this.type(args, url, 'select');
        case 'sign_in': return await this.signIn(args, url);
        case 'enter_code': return await this.enterCode(args, url);
        case 'dismiss': return await this.dismiss(args, url);
        case 'expand_all': return await this.expandAll(url);
        case 'next_page': if (this.init.download) return await this.refuse(name, url, `unknown tool "${name}"`); return await this.nextPage(args, url);
        case 'extract': if (this.init.download) return await this.refuse(name, url, `unknown tool "${name}"`); return await this.extract(args, url);
        case 'download': if (!this.init.download) return await this.refuse(name, url, `unknown tool "${name}"`); return await this.download(args, url, this.init.download);
        case 'back': return await this.back(url);
        case 'done': return this.done(args, url);
        default: return await this.refuse(name, url, `unknown tool "${name}"`);
      }
    } catch (err) {
      if (err instanceof ToolInputError) return this.refuse(name, url, err.message);
      return this.refuse(name, url, `${name} failed`, (err as Error).message);
    }
  }

  private here(): string {
    try { const u = new URL(this.page.url()); return `${u.origin}${u.pathname}`; } catch { return ''; }
  }

  private element(args: Record<string, unknown>, key: string): SnapshotElement {
    const ref = args[key];
    if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) throw new ToolInputError(`${key} must be an element ref like e12`);
    const el = this.current.get(ref);
    if (!el) throw new ToolInputError(`${clipRef(ref)} is not on the latest page (refs change after every action); use a ref from the latest result`);
    return el;
  }

  /**
   * Any of the element's names (display, full accessible, visible text) or its link matching the denylist refuses it,
   * and so does its navigation target: a link's full URL or a submit control's form submission URL, decoded, query
   * included (`/orders/7?action=cancel`, a GET form to `/admin/purge`). A target too long to check in full is refused.
   */
  private denied(el: SnapshotElement): boolean {
    if (el.targetClipped || (el.target !== undefined && isDestructiveUrl(el.target))) return true;
    return [el.name, el.fullName, el.visibleText ?? '', el.href ?? ''].some(isDestructive);
  }

  private refuseDestructive(toolName: string, url: string, el: SnapshotElement): Promise<ToolOutcome> {
    return this.refuse(toolName, url, `refused: ${el.ref} ${LOOKS_DESTRUCTIVE}`);
  }

  /**
   * Validated locator for a control the agent wants to click. Icon buttons often carry their meaning only in an id or
   * test id, so every candidate (normalized) is checked against the denylist too; undefined means refuse.
   */
  private async clickLocator(el: SnapshotElement): Promise<Locator | undefined> {
    const loc = await candidatesFor(this.page, el, this.masker);
    return isDestructive(JSON.stringify(loc)) ? undefined : loc;
  }

  /**
   * Runs one agent action as a step. The agent acts on an element it saw a moment ago, so a hidden or vanished control
   * fails within AGENT_ACTION_TIMEOUT_MS and the model looks again, instead of waiting the replay lane's step timeout
   * (a closed hamburger menu cost 30 s per click). The recorded step carries no timeout of its own: replays wait
   * the full step timeout.
   */
  private async exec(step: Step): Promise<{ ok: true } | { ok: false; message: string }> {
    // Trace groups and live-view markers name agent actions "AI: …" (step hooks).
    const r = await runSteps(this.ctx, [step], this.init.state, { label: 'AI', maxTimeoutMs: AGENT_ACTION_TIMEOUT_MS });
    return r.ok ? { ok: true } : { ok: false, message: r.failure.message };
  }

  /** Records a refusal or failure; `details` is page-derived and goes inside page_content. */
  private async refuse(toolName: string, url: string, message: string, details?: string, step?: Step): Promise<ToolOutcome> {
    // A fatal policy violation (pushed by a handler or the session) has stopped the run; say so, so the model does not retry.
    if (this.ctx.violations.some((v) => v.fatal)) message += '; the run was stopped by a policy violation';
    const status = neutralize(this.masker.mask(message));
    const detail = details ? neutralize(this.masker.mask(details.split('\n')[0])).slice(0, 300) : '';
    const note = neutralize(this.masker.mask(detail ? `${message}: ${detail}` : message)).slice(0, 300);
    this.actions.push({ tool: toolName.slice(0, MAX_TOOL_NAME), ok: false, url, note, ...(step ? { step } : {}) });
    return { text: `ERROR: ${status}${await this.pageBlock(detail ? `Details: ${detail}` : undefined)}`, error: true };
  }

  private async success(action: AgentAction, message: string, pageData?: string): Promise<ToolOutcome> {
    this.actions.push({ ...action, ...(this.startState ? { pageState: this.startState } : {}) });
    return { text: `OK: ${message}${await this.pageBlock(pageData ? this.masker.mask(pageData) : undefined)}`, error: false };
  }

  private async click(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const el = this.element(args, 'ref');
    if (this.denied(el)) return this.refuseDestructive('click', url, el);
    if (el.overlay) return this.refuse('click', url, `${el.ref} is inside an overlay; use dismiss to close overlays`);
    const click = await this.clickLocator(el);
    if (!click) return this.refuseDestructive('click', url, el);
    const step: Step = { intent: `${el.role === 'link' ? 'Open' : 'Click'} ${label(el)}`, click };
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('click', url, `clicking ${el.ref} failed`, r.message, step);
    return this.success({ tool: 'click', ok: true, url, step }, `clicked ${el.ref}`);
  }

  private async type(args: Record<string, unknown>, url: string, verb: 'fill' | 'select'): Promise<ToolOutcome> {
    const el = this.element(args, 'ref');
    const value = args.value;
    if (typeof value !== 'string') throw new ToolInputError('value must be a string');
    if (this.masker.containsSecret(value)) return this.refuse(verb, url, 'refused: the value contains a credential; only sign_in types credentials');
    if (value.includes('{{')) return this.refuse(verb, url, 'refused: templates are not allowed in typed values');
    if (value.length > MAX_TYPED) return this.refuse(verb, url, `refused: typed values are limited to ${MAX_TYPED} characters`);
    if (el.type === 'password') return this.refuse(verb, url, 'refused: password fields are only filled by sign_in');
    const field = await candidatesFor(this.page, el, this.masker);
    const step: Step = verb === 'fill'
      ? { intent: `Fill ${label(el)}`, fill: { field, value } }
      : { intent: `Choose ${neutralize(value)} in ${label(el)}`, select: { field, value } };
    const r = await this.exec(step);
    if (!r.ok) return this.refuse(verb, url, `${verb} ${el.ref} failed`, r.message, step);
    return this.success({ tool: verb, ok: true, url, step }, `${verb === 'fill' ? 'filled' : 'selected in'} ${el.ref}`);
  }

  private async signIn(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const has = (k: string) => args[k] !== undefined;
    if (this.pendingSignIn) {
      if (has('username_ref') || has('next_ref') || !has('password_ref') || !has('submit_ref')) {
        return this.refuse('sign_in', url, 'refused: the username was already typed; call sign_in with only password_ref and submit_ref on the password page');
      }
      return this.signInPasswordPage(args, url, this.pendingSignIn);
    }
    if (this.init.state.credentialsSubmitted) return this.refuse('sign_in', url, 'refused: credentials were already submitted in this run');
    if (has('next_ref')) {
      if (has('password_ref') || has('submit_ref')) throw new ToolInputError('on a two-page login, call sign_in with username_ref and next_ref first, then with password_ref and submit_ref');
      return this.signInUsernamePage(args, url);
    }
    if (!has('username_ref')) return this.refuse('sign_in', url, 'refused: no username was typed yet; call sign_in with username_ref and next_ref first, or with username_ref, password_ref and submit_ref on a one-page login');
    const u = this.element(args, 'username_ref');
    const p = this.element(args, 'password_ref');
    const s = this.element(args, 'submit_ref');
    const step: Step = {
      intent: 'Sign in',
      signIn: { username: await candidatesFor(this.page, u, this.masker), password: await candidatesFor(this.page, p, this.masker), submit: await candidatesFor(this.page, s, this.masker) },
    };
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('sign_in', url, 'sign-in failed', r.message, step);
    return this.success({ tool: 'sign_in', ok: true, url, step }, 'submitted the sign-in form');
  }

  /** A run log entry for a phase of the two-page sign_in (it does not run through runSteps): masked, one line. */
  private logSignIn(started: number, ok: boolean, note: string): void {
    this.init.state.log.push({ index: 0, intent: 'Sign in', status: ok ? 'ok' : 'failed', ms: Date.now() - started, note: this.masker.mask(note.split('\n')[0]).slice(0, 300) });
  }

  /**
   * Two-page sign_in, phase 1: the signIn step's `next` path up to the password page (beginSignIn, findUsernamePage,
   * submitUsername), waiting for any password field. On success the action is recorded without a step; phase 2 replaces it.
   */
  private async signInUsernamePage(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const u = this.element(args, 'username_ref');
    const n = this.element(args, 'next_ref');
    // A one-page login: next would post the username with an empty password.
    if ([...this.current.values()].some((e) => e.type === 'password')) {
      return this.refuse('sign_in', url, 'refused: this page has a password field: call sign_in with username_ref, password_ref and submit_ref');
    }
    if (this.denied(n)) return this.refuseDestructive('sign_in', url, n);
    const username = await candidatesFor(this.page, u, this.masker);
    const next = await this.clickLocator(n);
    if (!next) return this.refuseDestructive('sign_in', url, n);
    const timeout = this.ctx.defaultTimeoutMs;
    const started = Date.now();
    try {
      const secrets = beginSignIn(this.ctx, this.init.state);
      const found = await findUsernamePage(this.ctx, { username, next }, timeout);
      await this.ctx.interrupts?.pause();
      try {
        await submitUsername(this.ctx, { username, password: ANY_PASSWORD_FIELD }, found, secrets, this.init.state, timeout);
      } finally {
        await this.ctx.interrupts?.resume().catch(() => undefined);
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logSignIn(started, false, message);
      if (message === `${DETECTED_PREFIX}login_failed`) {
        this.signInStage = 'username_rejected';
        return this.refuse('sign_in', url, 'the site rejected the username');
      }
      return this.refuse('sign_in', url, 'sign-in failed', message);
    }
    if (this.ctx.violations.some((v) => v.fatal)) {
      this.logSignIn(started, false, 'a blocked request was attempted');
      return this.refuse('sign_in', url, 'sign-in failed');
    }
    this.pendingSignIn = { username, next, at: this.actions.length };
    this.signInStage = 'pending';
    this.logSignIn(started, true, 'typed the username and moved to the password page');
    return this.success({ tool: 'sign_in', ok: true, url }, 'typed the username and moved to the password page; now call sign_in with password_ref and submit_ref');
  }

  /**
   * Two-page sign_in, phase 2 (once, while phase 1 is pending): type the password and submit (submitPasswordPage). The
   * outcome replaces phase 1's action in place, with the combined step { username, next, password, submit } and phase 1's
   * page, so compile sees one sign-in that starts on the username page and emits signIn.next.
   */
  private async signInPasswordPage(args: Record<string, unknown>, url: string, pending: NonNullable<AgentTools['pendingSignIn']>): Promise<ToolOutcome> {
    const p = this.element(args, 'password_ref');
    const s = this.element(args, 'submit_ref');
    // A wrong ref is a refusal that keeps the sign-in pending: nothing has been typed on this page yet.
    if (p.type !== 'password') return this.refuse('sign_in', url, 'refused: password_ref must be a password field');
    const password = await candidatesFor(this.page, p, this.masker);
    const submit = await candidatesFor(this.page, s, this.masker);
    const spec = { username: pending.username, next: pending.next, password, submit };
    const step: Step = { intent: 'Sign in', signIn: spec };
    const phase1 = this.actions[pending.at];
    this.pendingSignIn = undefined;
    this.signInStage = undefined;
    const place = (out: ToolOutcome): ToolOutcome => {
      const a = this.actions.pop()!;
      this.actions[pending.at] = { ...a, url: phase1.url, ...(phase1.pageState ? { pageState: phase1.pageState } : {}) };
      return out;
    };
    const started = Date.now();
    await this.ctx.interrupts?.pause();
    try {
      await submitPasswordPage(this.ctx, spec, this.ctx.secrets!, this.init.state, this.ctx.defaultTimeoutMs);
    } catch (err) {
      this.logSignIn(started, false, (err as Error).message);
      return place(await this.refuse('sign_in', url, 'sign-in failed', (err as Error).message, step));
    } finally {
      await this.ctx.interrupts?.resume().catch(() => undefined);
    }
    if (this.ctx.violations.some((v) => v.fatal)) {
      this.logSignIn(started, false, 'a blocked request was attempted');
      return place(await this.refuse('sign_in', url, 'sign-in failed', undefined, step));
    }
    this.logSignIn(started, true, 'submitted the sign-in form');
    return place(await this.success({ tool: 'sign_in', ok: true, url, step }, 'submitted the sign-in form'));
  }

  private async enterCode(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    // Only once a password was submitted (submitClicked): a typed username alone (a two-page sign_in) is not a sign-in.
    if (!this.init.state.submitClicked) return this.refuse('enter_code', url, 'refused: sign in first');
    if (!this.ctx.secrets?.totpSecret) return this.refuse('enter_code', url, NO_TOTP_SECRET);
    const f = this.element(args, 'field_ref');
    const s = this.element(args, 'submit_ref');
    const totp = { field: await candidatesFor(this.page, f, this.masker), submit: await candidatesFor(this.page, s, this.masker) };
    await this.ctx.interrupts?.pause();
    try {
      await submitTotp(this.ctx, totp, this.ctx.defaultTimeoutMs);
      this.codeSubmittedAt = Date.now();
    } catch (err) {
      return await this.refuse('enter_code', url, 'entering the code failed', (err as Error).message);
    } finally {
      await this.ctx.interrupts?.resume();
    }
    return this.success({ tool: 'enter_code', ok: true, url, totp }, 'entered the authentication code');
  }

  private async dismiss(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const el = this.element(args, 'ref');
    if (this.denied(el)) return this.refuseDestructive('dismiss', url, el);
    const click = await this.clickLocator(el);
    if (!click) return this.refuseDestructive('dismiss', url, el);
    if (el.overlay) {
      let target: Locator;
      try {
        // The overlay container carries a ref from the same snapshot; candidatesFor re-checks its identity, so pass the current one.
        const id = await currentIdentity(this.page, this.masker, el.overlay);
        if (!id) throw new Error('overlay is gone');
        target = candidatesOf(await candidatesFor(this.page, { ref: el.overlay, role: id.role, name: id.name, fullName: id.name, tag: 'div' }, this.masker))[0];
      } catch { target = candidatesOf(click)[0]; }
      const interrupt: Interrupt = { target, click: candidatesOf(click)[0] };
      const step: Step = { intent: `Dismiss ${label(el)}`, click };
      const r = await this.exec(step);
      if (!r.ok) return this.refuse('dismiss', url, `dismissing with ${el.ref} failed`, r.message);
      return this.success({ tool: 'dismiss', ok: true, url, interrupt }, `dismissed the overlay with ${el.ref}`);
    }
    // A full-page interstitial (e.g. a survey after sign-in): replayed as a click that runs only when the control is visible.
    const step: Step = { intent: `Dismiss ${label(el)}`, when: { visible: click }, click };
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('dismiss', url, `dismissing with ${el.ref} failed`, r.message, step);
    return this.success({ tool: 'dismiss', ok: true, url, step }, `skipped the page with ${el.ref}`);
  }

  private async expandAll(url: string): Promise<ToolOutcome> {
    // Only closed sections: clicking an open summary would collapse it.
    const sections = 'details:not([open]) > summary';
    // Each summary's text plus the naming attributes of it and everything inside it (icon buttons hide meaning in ids).
    const words = await this.page.locator(sections).evaluateAll((els) => els.map((el) => {
      const parts = [(el as HTMLElement).innerText ?? ''];
      for (const n of [el, ...Array.from(el.querySelectorAll('*'))]) {
        for (const a of ['aria-label', 'title', 'alt', 'id', 'data-testid', 'href', 'value', 'name']) {
          const v = n.getAttribute(a);
          if (v) parts.push(v);
        }
      }
      return parts;
    }));
    const n = words.length;
    if (n === 0) return this.refuse('expand_all', url, 'there are no collapsed sections on this page');
    if (n > 100) return this.refuse('expand_all', url, 'there are more than 100 sections on this page');
    if (words.some((parts) => parts.some(isDestructive))) return this.refuse('expand_all', url, `refused: a section header contains a control that ${LOOKS_DESTRUCTIVE}`);
    const step: Step = { intent: 'Expand all sections', clickAll: { target: { css: sections }, max: n } };
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('expand_all', url, 'expanding the sections failed', r.message, step);
    return this.success({ tool: 'expand_all', ok: true, url, step }, `expanded ${n} sections`);
  }

  /** The page text, or '' while it cannot be read. A closed page throws, so a poll never reads '' as "the page changed". */
  private bodyText(): Promise<string> {
    return this.page.evaluate(() => document.body?.innerText ?? '').catch((err: unknown) => {
      if (this.page.isClosed()) throw err;
      return '';
    });
  }

  private async nextPage(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const el = this.element(args, 'ref');
    if (this.denied(el)) return this.refuseDestructive('next_page', url, el);
    const click = await this.clickLocator(el);
    if (!click) return this.refuseDestructive('next_page', url, el);
    const step: Step = { intent: 'Go to the next page', click };
    const before = await this.bodyText();
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('next_page', url, `clicking ${el.ref} failed`, r.message, step);
    const changed = await poll(async () => (await this.bodyText()) !== before, this.ctx.defaultTimeoutMs);
    if (this.page.isClosed()) return this.refuse('next_page', url, 'the page was closed', undefined, step);
    if (!changed) return this.refuse('next_page', url, 'the page did not change after clicking next', undefined, step);
    return this.success({ tool: 'next_page', ok: true, url, step }, `moved to the next page with ${el.ref}`);
  }

  private async extract(args: Record<string, unknown>, url: string): Promise<ToolOutcome> {
    const { output, state } = this.init;
    if (!output.idPattern) return this.refuse('extract', url, 'this task has no ID pattern for rows, so extract cannot be used');
    const scope: Locator = args.scope_ref !== undefined
      ? await candidatesFor(this.page, this.element(args, 'scope_ref'), this.masker)
      : (await this.page.locator('main').count()) === 1 ? { css: 'main' } : { css: 'body' };
    const step: Step = { intent: 'Read the rows on this page', extract: { scope, idPattern: output.idPattern, textMode: 'textContent' } };
    const before = state.rows.length;
    const r = await this.exec(step);
    if (!r.ok) return this.refuse('extract', url, 'extract failed', r.message, step);
    const added = state.rows.slice(before).flatMap((x) => (typeof x.id === 'string' ? [x.id] : []));
    return this.success({ tool: 'extract', ok: true, url, step }, `extracted ${added.length} new rows (${state.rows.length} in total)`, `Rows read: ${added.join(', ') || '(none)'}`);
  }

  private async download(args: Record<string, unknown>, url: string, template: DownloadTemplate): Promise<ToolOutcome> {
    const { state } = this.init;
    if (state.downloads.length > 0) return this.refuse('download', url, 'refused: a file was already downloaded in this run');
    const el = this.element(args, 'ref');
    if (this.denied(el)) return this.refuseDestructive('download', url, el);
    if (el.overlay) return this.refuse('download', url, `${el.ref} is inside an overlay; use dismiss to close overlays`);
    const trigger = await this.clickLocator(el);
    if (!trigger) return this.refuseDestructive('download', url, el);
    const step: Step = { intent: `Download with ${label(el)}`, download: { trigger, ...template } };
    const r = await this.exec(step);
    // The handler marks a trigger click that went through without bringing a file (RunState.clickedTrigger; exec runs
    // the step as a top-level step, so the marker is set here too). The click still changed the page (SAP's Export
    // opens a format dialog): it is recorded as the click it was, so compile replays it before what the agent does
    // next. A policy stop or a closed page keeps the failure.
    const clicked = !r.ok && state.clickedTrigger !== undefined && !this.ctx.violations.some((v) => v.fatal) && !this.page.isClosed();
    delete state.clickedTrigger;
    if (clicked) {
      const click: Step = { intent: `${el.role === 'link' ? 'Open' : 'Click'} ${label(el)}`, click: trigger };
      // The wait exec actually gave the download (runSteps caps the step timeout at the agent's), so a slow export can be told from a dialog.
      const waited = +(Math.min(this.ctx.defaultTimeoutMs, AGENT_ACTION_TIMEOUT_MS) / 1000).toFixed(1);
      return this.success({ tool: 'click', ok: true, url, step: click },
        `clicked ${el.ref}, but no file arrived within ${waited} s; the page may have changed (a dialog or menu may have opened), or the file may be slow: look at the page below`);
    }
    if (!r.ok) {
      // The reason may carry the file name or a header from the site: it goes inside page_content, masked.
      if (r.message.startsWith(FILE_CHECK_FAILED_PREFIX)) return this.refuse('download', url, 'the file did not pass the checks', r.message.slice(FILE_CHECK_FAILED_PREFIX.length), step);
      return this.refuse('download', url, `downloading with ${el.ref} failed`, r.message, step);
    }
    const file = state.downloads.at(-1);
    if (!file) return this.refuse('download', url, 'no file arrived', undefined, step);
    const cols = file.facts?.columns ? `, columns: ${file.facts.columns.slice(0, 20).map((c) => c.slice(0, 80)).join(', ')}` : '';
    const rows = file.facts?.rows != null ? `, rows: ${file.facts.rows}` : '';
    const facts = `File: ${JSON.stringify(file.fileName)} (${file.mimeType}, ${file.data.length} bytes)${cols}${rows}`;
    return this.success({ tool: 'download', ok: true, url, step }, 'downloaded the file; it passed the checks', facts);
  }

  private async back(url: string): Promise<ToolOutcome> {
    const before = this.page.url();
    const res = await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.ctx.defaultTimeoutMs });
    if (res === null && this.page.url() === before) return this.refuse('back', url, 'there is no previous page');
    return this.success({ tool: 'back', ok: true, url }, 'went back');
  }

  private done(args: Record<string, unknown>, url: string): ToolOutcome {
    const outcome = args.outcome;
    if (outcome !== 'found' && outcome !== 'not_found' && outcome !== 'blocked') throw new ToolInputError('outcome must be "found", "not_found" or "blocked"');
    if (this.init.download && outcome === 'found' && this.init.state.downloads.length === 0) throw new ToolInputError('refused: no file has passed the checks yet; use download');
    const note = neutralize(this.masker.mask(typeof args.note === 'string' ? args.note : '')).slice(0, 300);
    this.actions.push({ tool: 'done', ok: true, url, note });
    return { text: 'OK: finished', error: false, done: { outcome, note } };
  }
}
