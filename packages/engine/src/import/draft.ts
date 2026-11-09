// The shared draft builder: neutral import events, already through stripSecrets, become one step
// document (version 1, unsigned) and report items. No model: intents come from the source's labels, fallbacks from
// its alternative selectors, variables from substituteVars, and the export click becomes a checked download only when
// the author set an Expected File.
import { looksGenerated } from '../agent/stable-ids.js';
import { substituteVars } from '../compile/compile.js';
import { IMPORT_EMPTY } from '../messages.js';
import { createMasker } from '../secrets/mask.js';
import { canonicalize } from '../sign.js';
import { absoluteHttpUrl, parseScript, ScriptShapeError } from '../steps/parse.js';
import { SESSION_SEGMENT, stablePath } from '../steps/urls.js';
import type { Locator, Script, Step } from '../types.js';
import type { Candidate, Draft, ImportEvent, ImportItem, ImportOptions, ImportReport } from './types.js';

/** Labels in intents and report items are at most this many characters. */
export const MAX_LABEL = 80;
/** A step keeps its primary locator and at most this many of the source's alternatives. */
export const MAX_FALLBACKS = 3;
/** Click names that make a click the download trigger when the source did not say which click downloads. */
const EXPORT_NAME = /export|download|csv|xlsx|spreadsheet/i;
/** A dialog's confirmation, after an export-like click that opened it: Continue (Enter), OK, Save, Yes, Confirm. */
const CONFIRM_NAME = /^\s*(continue|ok|okay|save|confirm|yes)\b/i;
/** Site Login secrets shorter than this are only compared whole, as validateScript does (MIN_SECRET_LEN_FOR_LITERAL_CHECK). */
export const MIN_SECRET_LENGTH = 4;

const FORMAT_CHARS = /[\p{Cf}\p{Cs}]/gu;
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;

/** Page text as a label: format characters (zero-width, bidi) removed, control characters and runs of whitespace one space, at most MAX_LABEL characters. */
export function cleanLabel(s: string): string {
  const t = s.replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > MAX_LABEL ? chars.slice(0, MAX_LABEL).join('').trimEnd() : t;
}

/**
 * A cleaned label as an intent shows it: quoted when it has a bracket or a double quote, so that a label such as
 * `Export (CSV)` never ends the intent with a bracketed group a reviewer could take for the action describeStep appends
 * (the change list's action is always the last bracketed group). Double quotes inside become single quotes, so the
 * quoted label needs no escapes.
 */
function shown(label: string): string {
  return /[()"]/.test(label) ? `"${label.replaceAll('"', "'")}"` : label;
}

/** What a locator names (role name, label, text or test id), if anything. */
function locatorName(c: Locator): string | undefined {
  return 'role' in c ? c.name : 'label' in c ? c.label : 'text' in c ? c.text : 'testId' in c ? c.testId : undefined;
}

/** The event's label, cleaned; without one, the first name its candidates carry; '' when there is none. */
export function nameOf(label: string, target: Candidate[] = []): string {
  const own = cleanLabel(label);
  if (own) return own;
  for (const c of target) {
    const n = cleanLabel(locatorName(c) ?? '');
    if (n) return n;
  }
  return '';
}

/** Host and path of a goto URL (or the path of a relative one), for an intent. Never the query or fragment. */
function placeOf(url: string): string {
  if (URL.canParse(url)) {
    const u = new URL(url);
    return cleanLabel(`${u.host}${u.pathname === '/' ? '' : u.pathname}`);
  }
  return cleanLabel(url.split(/[?#]/)[0] ?? '');
}

/** The intent-like text of an event, for steps and report items. */
export function describeEvent(e: ImportEvent): string {
  const named = (fallback: string) => ('target' in e ? shown(nameOf(e.label, e.target) || fallback) : fallback);
  switch (e.kind) {
    case 'goto': return `Open ${shown(placeOf(e.url))}`;
    case 'click': return `Click ${named('the element')}`;
    case 'fill': return `Type into ${named('the field')}`;
    case 'select': return `Choose ${shown(cleanLabel(e.value) || 'an option')} in ${named('the list')}`;
    case 'check': return `${e.checked ? 'Check' : 'Uncheck'} ${named('the box')}`;
    case 'waitFor': return `Wait for ${named('the element')}`;
    case 'enter': { const n = cleanLabel(e.label); return n ? `Press Enter in ${shown(n)}` : 'Press Enter'; }
    case 'expectUrl': return `URL check ${shown(cleanLabel(stablePath(e.path)))}`;
    case 'signIn': return e.totp ? 'Sign in with an authentication code' : 'Sign in';
    case 'report': return cleanLabel(e.item.what);
  }
}

const HEX = /^[0-9a-fA-F]$/;
const IDENT_CHAR = /^[\w\u00a0-\uffff-]$/u;
const SPACE = /^\s$/;

/**
 * The element ids a CSS selector names (`#id` and `[id=…]`), CSS escapes undone. One linear pass that tracks quoted
 * strings and escapes, so a `#` inside a quoted value (`a[href="#section-2024-01-01"]`) is not an id, and no input (an
 * unterminated quote, a run of escaped quotes) makes it rescan: each character is read once.
 */
function cssIds(css: string): string[] {
  const ids: string[] = [];
  const n = css.length;
  /** The character an escape at `at` stands for, and the index after it. */
  const escape = (at: number): [string, number] => {
    let j = at + 1;
    let hex = '';
    while (j < n && hex.length < 6 && HEX.test(css[j])) hex += css[j++];
    if (!hex) return j < n ? [css[j], j + 1] : ['', j];
    if (j < n && SPACE.test(css[j])) j++;
    const cp = parseInt(hex, 16);
    return [cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd', j];
  };
  /** A quoted string starting at `at`, unescaped, and the index after its closing quote (the end when unterminated). */
  const quoted = (at: number): [string, number] => {
    const q = css[at];
    let out = '';
    let j = at + 1;
    while (j < n && css[j] !== q) {
      if (css[j] === '\\') { const [c, k] = escape(j); out += c; j = k; } else out += css[j++];
    }
    return [out, Math.min(n, j + 1)];
  };
  /** An identifier starting at `at`, unescaped, and the index after it. */
  const ident = (at: number): [string, number] => {
    let out = '';
    let j = at;
    while (j < n) {
      if (css[j] === '\\') { const [c, k] = escape(j); out += c; j = k; } else if (IDENT_CHAR.test(css[j])) out += css[j++]; else break;
    }
    return [out, j];
  };
  const spaces = (at: number) => { let j = at; while (j < n && SPACE.test(css[j])) j++; return j; };
  let i = 0;
  while (i < n) {
    const c = css[i];
    if (c === '"' || c === "'") { i = quoted(i)[1]; continue; }
    if (c === '\\') { i = escape(i)[1]; continue; }
    if (c === '#') {
      const [id, j] = ident(i + 1);
      if (id) ids.push(id);
      i = Math.max(j, i + 1);
      continue;
    }
    if (c === '[') {
      const [name, afterName] = ident(spaces(i + 1));
      let j = spaces(afterName);
      if (j < n && '~|^$*'.includes(css[j])) j++;
      if (j < n && css[j] === '=') {
        j = spaces(j + 1);
        let value = '';
        if (j < n && (css[j] === '"' || css[j] === "'")) [value, j] = quoted(j);
        else [value, j] = ident(j);
        if (name.toLowerCase() === 'id' && value) ids.push(value);
      }
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
  return ids;
}
/** True when a CSS selector names an element id that looks generated per response (agent/stable-ids.ts). */
function cssHasGeneratedId(css: string): boolean {
  return cssIds(css).some(looksGenerated);
}
function hasGeneratedId(c: Locator): boolean {
  return ('css' in c && cssHasGeneratedId(c.css)) || (c.within !== undefined && hasGeneratedId(c.within));
}

/**
 * A step's locator from a source's candidates, best first: the first usable one is the primary and the next
 * MAX_FALLBACKS are its fallbacks. Duplicates are dropped; a role name of 3 characters or fewer is always exact (a short
 * name like "Run" also matches "Running"); role, label and text keep `exact: true` as the parser set it (`exact: false`,
 * the default, is dropped). A candidate on an id
 * that looks generated per response is never used, as primary or fallback: on replay such an id is missing or, worse,
 * names a different element (a counter like `__button12`), which is why the agent never records one (candidates.ts).
 * undefined when no candidate is usable.
 */
export function pickLocator(target: Candidate[]): Locator | undefined {
  const seen = new Set<string>();
  const out: Locator[] = [];
  for (const c of target) {
    const loc = structuredClone(c);
    delete loc.fallbacks;
    // exact: false is the default: dropped, so it neither shows nor makes a second candidate of the same locator.
    if ('exact' in loc && loc.exact === false) delete loc.exact;
    if ('role' in loc && loc.name && Array.from(loc.name).length <= 3) loc.exact = true;
    if (hasGeneratedId(loc)) continue;
    const key = canonicalize(loc);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  if (out.length === 0) return undefined;
  const [primary, ...rest] = out;
  const fallbacks = rest.slice(0, MAX_FALLBACKS);
  return fallbacks.length ? { ...primary, fallbacks } : primary;
}

/** A candidate longer than this (as JSON) is never used: no selector is that long, and every later check stays cheap. */
export const MAX_CANDIDATE_CHARS = 4096;
const OVERSIZED = `a locator longer than ${MAX_CANDIDATE_CHARS} characters is never used`;

/**
 * One event without its candidates longer than MAX_CANDIDATE_CHARS. `item` reports what was cut (undefined when nothing
 * was); `empty`: the event has no candidate left for a locator it needs.
 */
export function capEvent(e: ImportEvent): { event: ImportEvent; item?: ImportItem; empty: boolean } {
  const fits = (c: Candidate) => JSON.stringify(c).length <= MAX_CANDIDATE_CHARS;
  const lists = 'target' in e ? [e.target] : e.kind === 'signIn' ? [e.username, ...(e.next ? [e.next] : []), e.password, e.submit, ...(e.totp ? [e.totp.field, e.totp.submit] : [])] : [];
  if (lists.every((l) => l.every(fits))) return { event: e, empty: false };
  const cut = (l: Candidate[]) => l.filter(fits);
  const event: ImportEvent = 'target' in e
    ? { ...e, target: cut(e.target) } as ImportEvent
    : e.kind === 'signIn'
      ? {
        ...e, username: cut(e.username), ...(e.next ? { next: cut(e.next) } : {}), password: cut(e.password), submit: cut(e.submit),
        ...(e.totp ? { totp: { field: cut(e.totp.field), submit: cut(e.totp.submit) } } : {}),
      }
      : e;
  const empty = 'target' in event ? event.target.length === 0
    : event.kind === 'signIn' && [event.username, event.password, event.submit, ...(event.next ? [event.next] : [])].some((l) => l.length === 0);
  return { event, empty, item: { at: e.at, kind: 'dropped', what: describeEvent(event), reason: empty ? `${OVERSIZED}, and the step has no other` : OVERSIZED } };
}

/**
 * Drops candidates longer than MAX_CANDIDATE_CHARS from every event, before any other work looks at them, and reports
 * each event that lost one; an event left with no candidate is dropped. Returns new events (the input is not changed).
 */
export function dropOversized(events: ImportEvent[], add: (item: ImportItem) => void): ImportEvent[] {
  const out: ImportEvent[] = [];
  for (const e of events) {
    const { event, item, empty } = capEvent(e);
    if (item) add(item);
    if (!empty) out.push(event);
  }
  return out;
}

/** A goto URL with each session-shaped path segment (`/sap(<token>)/`) cut to its name (`/sap/`): the token is a credential of one session. */
function withoutSession(url: string): string {
  const cut = (path: string) => path.split('/').map((seg) => (SESSION_SEGMENT.test(seg) ? seg.slice(0, seg.indexOf('(')) : seg)).join('/');
  if (URL.canParse(url)) {
    const u = new URL(url);
    const path = cut(u.pathname);
    if (path === u.pathname) return url;
    u.pathname = path;
    return u.href;
  }
  const at = url.search(/[?#]/);
  return at < 0 ? cut(url) : cut(url.slice(0, at)) + url.slice(at);
}

type Click = Extract<ImportEvent, { kind: 'click' }>;
const isClick = (e: ImportEvent): e is Click => e.kind === 'click';

/**
 * The index of the click that becomes the download, or -1. Explicit download clicks first, then the last export-like
 * click, then the last click. An export-like click that opens a dialog (SAP's "Select Spreadsheet") is followed by the
 * dialog's confirmation: when the recording's last click comes after it, reads like one (CONFIRM_NAME), and no goto or URL
 * check lies between them (the page did not change), that click downloads.
 */
function downloadIndex(events: ImportEvent[]): number {
  let explicit = -1;
  let named = -1;
  let last = -1;
  let confirms = false;
  events.forEach((e, i) => {
    if (!isClick(e) || e.popup) return;
    last = i;
    const names = [e.label, ...e.target.map((c) => locatorName(c) ?? '')];
    confirms = names.some((t) => CONFIRM_NAME.test(t));
    if (e.download) explicit = i;
    if (names.some((t) => EXPORT_NAME.test(t))) named = i;
  });
  if (explicit >= 0) return explicit;
  if (named >= 0) {
    const samePage = !events.slice(named + 1, last).some((e) => e.kind === 'goto' || e.kind === 'expectUrl');
    return last > named && confirms && samePage ? last : named;
  }
  return last;
}

/** The answers to an identity provider's "Stay signed in?" prompt, as a button's whole name (any case). */
const STAY_SIGNED_IN_ANSWER = /^(no|yes|don't show this again)$/i;
const apostrophes = (t: string): string => cleanLabel(t).replace(/[\u2018\u2019]/g, "'");
const isStaySignedInAnswer = (e: Click): boolean =>
  e.target.some((c) => 'role' in c && c.role === 'button' && STAY_SIGNED_IN_ANSWER.test(apostrophes(c.name ?? '')));
/** The prompt's "Don't show this again" checkbox (its whole name or label, any case): gated with the answer after it. */
const DONT_SHOW_AGAIN = /^don't show this again$/i;
const isDontShowAgainBox = (e: ImportEvent): boolean => (e.kind === 'check' || (isClick(e) && !e.popup)) && e.target.some((c) =>
  ('role' in c && c.role === 'checkbox' && DONT_SHOW_AGAIN.test(apostrophes(c.name ?? ''))) || ('label' in c && DONT_SHOW_AGAIN.test(apostrophes(c.label))));

/**
 * The clicks recorded right after a signIn event that answer "Stay signed in?" (a button named exactly No,
 * Yes or "Don't show this again", any case; several in a row each count), a checkbox named exactly "Don't show this
 * again" ticked before such an answer, and the URL checks and waits between the signIn and them, each mapped to that
 * signIn's index. Only URL checks, waits, that checkbox and report events may lie between; a click that
 * opens a popup or downloads (`dl`) never answers. The import does not know the Site Login's login pages, so the page is
 * judged by position only: right after the sign-in, before anything else happens, is where the prompt shows.
 */
function staySignedInAnswers(events: ImportEvent[], dl: number): { answers: Map<number, number>; between: Map<number, number> } {
  const answers = new Map<number, number>();
  const between = new Map<number, number>();
  events.forEach((e, i) => {
    if (e.kind !== 'signIn') return;
    let pending: number[] = [];
    let boxes: number[] = [];
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j];
      if (n.kind === 'report') continue;
      if (n.kind === 'expectUrl' || n.kind === 'waitFor') { pending.push(j); continue; }
      // The "Don't show this again" box: gated only when an answer follows it; it never ends the scan.
      if (j !== dl && isDontShowAgainBox(n) && !(isClick(n) && isStaySignedInAnswer(n))) { boxes.push(j); continue; }
      if (!isClick(n) || n.popup || j === dl || !isStaySignedInAnswer(n)) break;
      for (const k of [...boxes, j]) answers.set(k, i);
      for (const k of pending) between.set(k, i);
      pending = [];
      boxes = [];
    }
  });
  return { answers, between };
}

/**
 * Turns events (after stripSecrets) into a draft named `name`, adding what it could not translate to `report`. A
 * "Stay signed in?" answer right after a built signIn is gated on its own locator (staySignedInAnswers). The
 * draft is version 1, unsigned, and accepted by parseScript; when parseScript refuses it, or nothing could be built,
 * the report gets an `error` item and there is no draft.
 */
export function buildDraft(events: ImportEvent[], opts: ImportOptions, report: ImportReport, name: string): Draft | undefined {
  const masker = createMasker([opts.secrets?.username, opts.secrets?.password, opts.secrets?.totpSecret].filter((s) => (s?.length ?? 0) >= MIN_SECRET_LENGTH));
  const add = (at: string, kind: ImportItem['kind'], what: string, reason: string) =>
    report.items.push({ at: masker.mask(at), kind, what: masker.mask(what), reason: masker.mask(reason) });

  if (opts.idPattern) {
    add('', 'untranslated', 'ID Pattern', 'the recording reads no rows, and an import never invents an extract step: add one to read rows');
  }
  // Defence in depth for callers that skip stripSecrets (which drops them first).
  events = dropOversized(events, (item) => add(item.at, item.kind, item.what, item.reason));
  const dl = opts.download ? downloadIndex(events) : -1;
  if (opts.download && dl < 0) add('', 'untranslated', 'Expected File', 'the recording has no click to download the file with');

  const { answers, between } = staySignedInAnswers(events, dl);
  /** Indexes of the signIn events that built a step: only their "Stay signed in?" answers are gated. */
  const builtSignIns = new Set<number>();
  const answerOf = (i: number): boolean => answers.has(i) && builtSignIns.has(answers.get(i)!);

  const steps: Step[] = [];
  /** Indexes of select steps, whose intents name the value after variables are substituted. */
  const selects: { step: number; event: Extract<ImportEvent, { kind: 'fill' | 'select' }> }[] = [];
  // A navigation check belongs to the step the event before it built; when that event built nothing, the check goes too.
  let lastBuilt = false;
  const push = (step: Step) => { steps.push(step); lastBuilt = true; };
  const noLocator = (e: Extract<ImportEvent, { target: Candidate[] }>) => {
    add(e.at, 'dropped', describeEvent(e), e.target.length
      ? 'no usable locator: the recorded ones name ids that look generated per page load, which a later run would not find'
      : 'the source recorded no way to find the element');
    lastBuilt = false;
  };

  events.forEach((e, i) => {
    if (between.has(i) && builtSignIns.has(between.get(i)!)) {
      add(e.at, 'dropped', describeEvent(e), 'it checks the "Stay signed in?" page between the sign-in and its answer, which shows only sometimes: the answer runs only when it shows');
      return;
    }
    switch (e.kind) {
      case 'goto': {
        const url = withoutSession(e.url);
        const step = { intent: describeEvent({ ...e, url }), goto: url };
        if (url !== e.url) add(e.at, 'converted', step.intent, 'the session in the address was removed: it changes with every sign-in');
        push(step);
        break;
      }
      case 'click': {
        const loc = pickLocator(e.target);
        if (!loc) { noLocator(e); break; }
        const label = shown(nameOf(e.label, e.target) || 'the element');
        if (i === dl && opts.download) {
          const { mime, maxBytes, check } = opts.download;
          push({ intent: `Download with ${label}`, download: { trigger: loc, ...(mime !== undefined ? { mime: [...mime] } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}), check: structuredClone(check) } });
          add(e.at, 'converted', describeEvent(e), e.download
            ? 'the click the source marked as a download became the download step the Expected File checks'
            : 'the click became the download step the Expected File checks');
          break;
        }
        if (e.download) {
          add(e.at, 'untranslated', describeEvent(e), opts.download
            ? 'the steps download one file: this download stays a click'
            : 'without an Expected File this download stays a click: set an Expected File to import it as a checked download');
        }
        if (answerOf(i)) {
          // Gated on its own primary locator, so it joins the login block (loginBlockEnd) and is skipped when the
          // identity provider does not ask.
          const primary = structuredClone(loc);
          delete primary.fallbacks;
          push({ intent: describeEvent(e), when: { visible: primary }, click: loc });
          add(e.at, 'converted', describeEvent(e), 'it answers "Stay signed in?" right after the sign-in: it runs only when the button shows, as part of the sign-in');
          break;
        }
        push(e.popup ? { intent: `Open ${label} in a new tab`, popup: { trigger: loc } } : { intent: describeEvent(e), click: loc });
        break;
      }
      case 'fill':
      case 'select': {
        const field = pickLocator(e.target);
        if (!field) { noLocator(e); break; }
        if (e.kind === 'select') {
          selects.push({ step: steps.length, event: e });
          push({ intent: describeEvent(e), select: { field, value: e.value } });
        } else push({ intent: describeEvent(e), fill: { field, value: e.value } });
        break;
      }
      case 'check': {
        const field = pickLocator(e.target);
        if (!field) { noLocator(e); break; }
        if (answerOf(i)) {
          // The prompt's "Don't show this again" box before its answer joins the login block too.
          const primary = structuredClone(field);
          delete primary.fallbacks;
          push({ intent: describeEvent(e), when: { visible: primary }, check: { field, checked: e.checked } });
          add(e.at, 'converted', describeEvent(e), 'it is on the "Stay signed in?" prompt right after the sign-in: it runs only when the box shows, as part of the sign-in');
          break;
        }
        push({ intent: describeEvent(e), check: { field, checked: e.checked } });
        break;
      }
      case 'waitFor': {
        const target = pickLocator(e.target);
        if (!target) { noLocator(e); break; }
        push({ intent: describeEvent(e), waitFor: { target } });
        break;
      }
      case 'signIn': {
        const username = pickLocator(e.username);
        const next = e.next && pickLocator(e.next);
        const password = pickLocator(e.password);
        const submit = pickLocator(e.submit);
        const field = e.totp && pickLocator(e.totp.field);
        const totpSubmit = e.totp && pickLocator(e.totp.submit);
        if (!username || !password || !submit || (e.next && !next) || (e.totp && (!field || !totpSubmit))) {
          add(e.at, 'dropped', describeEvent(e), 'no usable locator for one of the sign-in fields');
          lastBuilt = false;
          break;
        }
        builtSignIns.add(i);
        push({
          intent: describeEvent(e),
          signIn: { username, ...(next ? { next } : {}), password, submit, ...(field && totpSubmit ? { totp: { field, submit: totpSubmit } } : {}) },
        });
        break;
      }
      case 'expectUrl': {
        const path = stablePath(e.path);
        const prev = steps[steps.length - 1];
        if (!lastBuilt || !prev || !path) {
          add(e.at, 'dropped', describeEvent(e), 'there is no step before it to check');
          break;
        }
        prev.expect = { ...(prev.expect ?? {}), url: path };
        break;
      }
      case 'enter':
        add(e.at, 'untranslated', describeEvent(e), 'pressing Enter is not a step: add a click on the button it presses');
        lastBuilt = false;
        break;
      case 'report':
        report.items.push({ ...e.item, at: masker.mask(e.item.at), what: masker.mask(e.item.what), reason: masker.mask(e.item.reason) });
        break;
    }
  });

  if (opts.vars) substituteVars(steps, opts.vars, 0);
  for (const { step, event } of selects) {
    const s = steps[step] as Extract<Step, { select: unknown }>;
    s.intent = describeEvent({ ...event, value: [s.select.value].flat().join(', ') });
  }

  if (steps.length === 0) {
    add('', 'error', name, IMPORT_EMPTY);
    return undefined;
  }
  const first = steps[0];
  const firstAbsolute = steps.map((s) => ('goto' in s ? absoluteHttpUrl(s.goto) : undefined)).find((u) => u !== undefined);
  const startUrl = opts.startUrl ?? ('goto' in first && absoluteHttpUrl(first.goto) ? undefined : firstAbsolute);
  const doc = { ...(name ? { name } : {}), version: 1, ...(startUrl ? { startUrl } : {}), steps };
  let script: Script;
  try {
    script = parseScript(doc);
  } catch (err) {
    const issues = err instanceof ScriptShapeError ? err.issues : [err instanceof Error ? err.message : String(err)];
    add('', 'error', name, `the draft is not valid steps: ${issues.slice(0, 5).join('; ')}`);
    return undefined;
  }
  // Defence in depth behind stripSecrets: a draft that still names a Site Login secret is never returned.
  if (masker.containsSecret(JSON.stringify(script))) {
    add('', 'error', name, 'the draft still named a sign-in value, so it was not returned');
    return undefined;
  }
  report.steps += script.steps.length;
  return { name, script };
}
