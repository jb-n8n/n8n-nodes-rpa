// No typed secret is ever imported. Values are dropped here, before the draft builder sees the events:
// the recorded sign-in becomes one signIn event (with a Site Login) or is removed (without one), every other credential
// value is removed with its step, and labels, locators, addresses and report items that name a secret are redacted.
import { IMPORT_NEEDS_SITE_LOGIN } from '../messages.js';
import { CREDENTIAL_FIELD, STRICT_TOTP_FIELD } from '../secrets/credential-field.js';
import { createMasker, type Masker } from '../secrets/mask.js';
import { canonicalize } from '../sign.js';
import type { Locator } from '../types.js';
import { capEvent, MAX_CANDIDATE_CHARS, MIN_SECRET_LENGTH, nameOf } from './draft.js';
import type { Candidate, ImportEvent, ImportItem, ImportOptions, ImportReport } from './types.js';

const PASSWORD_TYPE = /type\s*=\s*["']?password\b/i;
/** A field labelled like a one-time code; with a 6 to 8 digit value it is the TOTP field. */
const TOTP_FIELD = /code|otp|token|2fa|verification|authenticat/i;
const TOTP_VALUE = /^\d{6,8}$/;
/** The hint a fill typed from a TOTP activity's output carries (the UiPath importer adds it): that fill is the code. */
export const TOTP_OUTPUT_HINT = 'one-time code (a TOTP activity output)';
/** A field that is a password field, not merely credential-looking ("Passenger"): only one starts a sign-in. */
const PASSWORD_NAMED = /password|passwd|passwort|kennwort|passcode|pwd|\bpin\b/i;
/** A field labelled like a username, preferred over the nearest fill when no value matches the Site Login username. */
const USERNAME_NAMED = /user|login|e-?mail|account|\bid\b/i;

/**
 * What a submit pressed with Enter becomes: the password form's submit button (a button without a type submits too).
 * The report says so, and adoption proves it on the live site.
 */
const ENTER_SUBMIT: Candidate[] = [{ css: 'form:has(input[type="password"]) [type="submit"]' }, { css: 'form:has(input[type="password"]) button:not([type])' }];
/** The code's submit, and an identity-first sign-in's Next, pressed with Enter: the form's submit button. */
const ENTER_FORM_SUBMIT: Candidate[] = [{ css: 'form [type="submit"]' }, { css: 'form button:not([type])' }];

const NEVER_IMPORTED = 'a sign-in value is never imported: the step was removed';
const CAPPED_VALUE = 'a locator of this field was too long to check, so its value counts as a sign-in value: the step was removed';
const AMBIGUOUS_USERNAME =
  'this field may hold the username (no typed value matches the Site Login username), and a sign-in value is never imported: the step was removed';
const SIGN_IN_PAGES =
  'the username and password are on different pages with more than one click, or a field, between them; the import builds signIn with next only when one click or Enter separates them: add the sign-in by hand';
const BETWEEN_PAGES = 'it checks the page between the username and the password, which signIn passes in one step (next)';
const CODE_FROM_EXPRESSION = 'the code is not typed text (an expression or a variable, such as a TOTP activity\'s output): the sign-in types a fresh code from the Site Login\'s authenticator secret';
const CODE_UNJOINED = 'the code step could not be joined to the sign-in: it must follow the sign-in\'s submit on the same page, then a click or Enter';
const SIGN_IN_INCOMPLETE =
  'the recorded sign-in needs a username field before the password and a submit control after it, on the same page: add a signIn step to the draft';

type Typed = Extract<ImportEvent, { kind: 'fill' | 'select' }>;
type Role = 'username' | 'password' | 'totp' | undefined;

/** Every string a locator carries (not its role), its scope's and its fallbacks' too. */
function locatorStrings(c: Locator): string[] {
  const own = ['name' in c ? c.name : undefined, 'label' in c ? c.label : undefined, 'text' in c ? c.text : undefined,
    'testId' in c ? c.testId : undefined, 'css' in c ? c.css : undefined, c.frame];
  return [...own.filter((s): s is string => typeof s === 'string'), ...(c.within ? locatorStrings(c.within) : []), ...(c.fallbacks ?? []).flatMap(locatorStrings)];
}
/** What credential detection reads of a field: each string cut to MAX_CANDIDATE_CHARS, so it sees oversized candidates too, at bounded cost. */
const fieldTexts = (e: Typed): string[] => [e.label, ...e.hints, ...e.target.flatMap(locatorStrings)].map((t) => t.slice(0, MAX_CANDIDATE_CHARS));
const isCredentialField = (e: Typed): boolean => e.secure === true || fieldTexts(e).some((t) => CREDENTIAL_FIELD.test(t) || PASSWORD_TYPE.test(t));
/** A code typed with a separator (`123 456`, `123-456`) is still a code. */
const compactCode = (v: string): string => v.replace(/[\s-]/g, '');
const isTotpLabelled = (e: Typed): boolean => fieldTexts(e).some((t) => TOTP_FIELD.test(t));
const isTotpField = (e: Typed): boolean => TOTP_VALUE.test(compactCode(e.value)) && isTotpLabelled(e);
/** A field typed from an expression that is the code: a TOTP activity's output, or its own texts name a code. */
const isExpressionCodeField = (e: Typed): boolean => e.hints.includes(TOTP_OUTPUT_HINT)
  || [e.label, ...e.target.flatMap(locatorStrings)].some((t) => STRICT_TOTP_FIELD.test(t.slice(0, MAX_CANDIDATE_CHARS).trim()));
/**
 * A value that is not typed text: none (an expression the source does not evaluate, such as UiPath's
 * `[strOtp]` from a TOTP activity) or only a template (`{{var.otp}}`, a mapped variable).
 */
const isExpressionValue = (v: string): boolean => v.trim() === '' || /^\s*\{\{[^{}]*\}\}\s*$/.test(v);
const isPasswordField = (e: Typed): boolean => e.secure === true || fieldTexts(e).some((t) => PASSWORD_TYPE.test(t) || PASSWORD_NAMED.test(t));
const isUsernameLike = (e: Typed): boolean => fieldTexts(e).some((t) => USERNAME_NAMED.test(t));
const sameElement = (a: Candidate[], b: Candidate[]): boolean => {
  const keys = new Set(a.map((c) => canonicalize({ ...c, fallbacks: undefined })));
  return b.some((c) => keys.has(canonicalize({ ...c, fallbacks: undefined })));
};

/**
 * Removes every typed secret from the events and reports each one by its field label, never its value:
 * - The sign-in: the first password field (type=password, secure, password-named, or holding the Site Login password),
 *   the username before it on the same page (the fill holding the Site Login username, else a username-like label, else
 *   the nearest fill), the next click or Enter (the submit), and a following code field (6 to 8 digits, spaces and
 *   hyphens ignored; or a field typed from an expression or a variable once the username and the submit
 *   were found, when the value is a UiPath TOTP activity's output or the field's own label or locator names a code) with its submit. With a Site Login they become one `signIn` event at the password's place, so other
 *   same-page fields recorded between username and password are filled first; without one they are removed and
 *   IMPORT_NEEDS_SITE_LOGIN is reported. A sign-in that cannot be joined (no submit, three pages, anything else between
 *   the pages) or a code that cannot be joined is reported `untranslated`; its values are stripped all the same.
 * - Identity-first: with no field on the password page before the password, the page before it is the
 *   username page when exactly one click or Enter left it, with only URL checks, waits and the password's focus click
 *   after it and no goto; and when the username is proven to be on that page (a fill holding the Site Login username is
 *   there, or no page back to the previous goto has another field). The username is chosen there by the same rules, the
 *   click becomes `next` (Enter: the form's submit button, reported `converted`), and the URL checks and waits after it
 *   are dropped and reported. A click marked `popup` is never `next`. A field on the password page while the Site Login
 *   username was typed on an earlier page is reported, never taken for the username. Without a confident username, every
 *   plausible fill on the pages before the password page (back to the previous goto) is stripped, even when a field on the
 *   password page becomes the username.
 * - A credential field is one whose selector, label, name, id or aria matches CREDENTIAL_FIELD, a `type=password` field, a
 *   field the source marked secure, a code field, or one whose typed value equals a Site Login secret.
 * - Every other fill or select whose field is a credential field, or whose value contains a Site Login secret or a
 *   value typed into a credential field, is removed.
 * - What remains is redacted: labels show `[secret]`, candidates naming a secret are dropped (the event too when none
 *   is left), an address loses its userinfo and, when it names a secret, its query and fragment (the goto too when its
 *   path does), and report items are masked.
 * Returns new events; the input is not changed.
 */
export function stripSecrets(input: ImportEvent[], opts: ImportOptions, report: ImportReport): ImportEvent[] {
  const items: ImportItem[] = [];
  const original = structuredClone(input);
  const sl = opts.hasSiteLogin ? opts.secrets : undefined;
  const slValues = [sl?.username, sl?.password, sl?.totpSecret].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const masker: Masker = createMasker(slValues.filter((s) => s.length >= MIN_SECRET_LENGTH));
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const equalsSecret = (v: string, secret: string | undefined) => !!secret && (v === secret || same(v, secret));
  // Secrets too short to search for inside text (as validateScript) still never appear as a whole label, name or value.
  const shortSecrets = slValues.filter((s) => s.length < MIN_SECRET_LENGTH);
  const isShortSecret = (t: string) => shortSecrets.some((x) => same(t, x));
  const maskText = (t: string) => (isShortSecret(t) ? '[secret]' : masker.mask(t));
  const add = (at: string, kind: ImportItem['kind'], what: string, reason: string) => items.push({ at, kind, what, reason });
  const reportSecret = (e: Typed, reason: string) => add(e.at, 'secret', nameOf(e.label, e.target) || 'a field', reason);

  const roleOf = (e: ImportEvent): Role => {
    if (e.kind !== 'fill') return undefined;
    if (equalsSecret(e.value, sl?.password)) return 'password';
    if (equalsSecret(e.value, sl?.username)) return 'username';
    if (isTotpField(e)) return 'totp';
    if (isCredentialField(e)) return 'password';
    return undefined;
  };
  // Roles come from the original candidates (fieldTexts reads a bounded prefix of each), so a candidate the size cap
  // drops still marks its field a credential. Then the cap: a fill or select that lost a candidate is stripped below
  // (fail closed), and any other event left with no candidate goes.
  const roles = original.map(roleOf);
  const capped = new Set<number>();
  const emptied: number[] = [];
  const events = original.map((e, i) => {
    const { event, item, empty } = capEvent(e);
    if (item) { items.push(item); capped.add(i); }
    if (empty && e.kind !== 'fill' && e.kind !== 'select') emptied.push(i);
    return event;
  });
  // A click right before a fill, select or check of the same element only focuses it: it goes with that field.
  const focusOf = new Map<number, number>();
  events.forEach((e, i) => {
    if (e.kind !== 'click') return;
    let j = i + 1;
    while (j < events.length && events[j].kind === 'report') j++;
    const next = events[j];
    if (next && (next.kind === 'fill' || next.kind === 'select' || next.kind === 'check') && sameElement(e.target, next.target)) focusOf.set(i, j);
  });

  const removed = new Set<number>(emptied);
  const typedSecrets: { value: string; wholeNumber: boolean }[] = [];
  const strip = (i: number, reason = NEVER_IMPORTED) => {
    const e = events[i] as Typed;
    if (removed.has(i)) return;
    removed.add(i);
    if (e.value) typedSecrets.push({ value: e.value, wholeNumber: roles[i] === 'totp' });
    if (e.value && roles[i] === 'totp') typedSecrets.push({ value: compactCode(e.value), wholeNumber: true });
    reportSecret(e, reason);
  };
  const removeWithFocus = (fields: number[]) => {
    for (const [click, field] of focusOf) if (fields.includes(field)) removed.add(click);
  };
  /** The submit after a field: the next click (not one that focuses a field) or Enter; -1 at a goto or another field. */
  const submitAfter = (from: number): number => {
    for (let k = from + 1; k < events.length; k++) {
      const e = events[k];
      if (e.kind === 'report' || e.kind === 'expectUrl' || e.kind === 'waitFor') continue;
      if (e.kind === 'click' && focusOf.has(k)) continue;
      return e.kind === 'click' || e.kind === 'enter' ? k : -1;
    }
    return -1;
  };

  // 1. The sign-in group, around the first password field (a real one: type=password, secure, password-named, or the
  // Site Login password typed into it). Only fields on the same page join it, or on the page one Next before.
  let signIn: { at: number; event: Extract<ImportEvent, { kind: 'signIn' }> } | undefined;
  const joined = new Set<number>();
  const p = original.findIndex((e, i) => roles[i] === 'password' && e.kind === 'fill' && (isPasswordField(e) || equalsSecret(e.value, sl?.password)));
  if (p >= 0) {
    // Back from `from` to the page's start: fills, selects and checks (and their focus clicks) are on this page; any
    // other click, Enter, URL check or goto means the page changed. `leaving`: first step over what left the page before
    // (URL checks and one click or Enter), to read the page before it.
    const pageFills = (from: number, leaving: boolean): { fills: number[]; change: number } => {
      const fills: number[] = [];
      let j = from - 1;
      for (let clicks = 0; leaving && j >= 0; j--) {
        const e = events[j];
        if (e.kind === 'report' || e.kind === 'waitFor' || e.kind === 'expectUrl') continue;
        if (((e.kind === 'click' && !focusOf.has(j)) || e.kind === 'enter') && clicks++ === 0) continue;
        break;
      }
      for (; j >= 0; j--) {
        const e = events[j];
        if (e.kind === 'report' || e.kind === 'waitFor' || (e.kind === 'click' && focusOf.has(j))) continue;
        if (e.kind === 'fill' || e.kind === 'select' || e.kind === 'check') {
          if (e.kind === 'fill' && roles[j] !== 'password' && roles[j] !== 'totp') fills.push(j);
          continue;
        }
        return { fills, change: e.kind === 'goto' ? -1 : j };
      }
      return { fills, change: -1 };
    };
    const usernameLike = (j: number) => isUsernameLike(original[j] as Typed);
    /**
     * Fail closed: only a fill holding the Site Login username is a confident username. Otherwise every fill that could
     * be it (the nearest one and each username-like one) loses its value, whichever signIn uses.
     */
    const plausible = (fills: number[]): { confident: number[]; ambiguous: number[] } => {
      const confident = fills.filter((j) => roles[j] === 'username');
      if (confident.length) return { confident, ambiguous: [] };
      return { confident, ambiguous: [...new Set([fills[0], ...fills.filter(usernameLike)].filter((j) => j !== undefined))] };
    };
    /**
     * The one click or Enter (`next`) that left the page before `to` for the page `to` is on, and the URL checks and
     * waits after it; undefined unless only those, report events and `to`'s focus click lie between `next` and `to`, and
     * only URL checks, waits and report events lie between the previous page's last field (or its focus click) and `next`.
     * A click marked `popup` is never `next`.
     */
    const leftFor = (to: number): { next: number; checks: number[] } | undefined => {
      const checks: number[] = [];
      let next = -1;
      for (let j = to - 1; j >= 0; j--) {
        const e = events[j];
        if (e.kind === 'report') continue;
        if (e.kind === 'expectUrl' || e.kind === 'waitFor') { if (next < 0) checks.push(j); continue; }
        if (next < 0 && e.kind === 'click' && focusOf.get(j) === to) continue;
        // A click that opened a popup left the page for another tab: the password page is not where `next` leads.
        if (next < 0 && e.kind === 'click' && e.popup) return undefined;
        if (next < 0 && ((e.kind === 'click' && !focusOf.has(j)) || e.kind === 'enter')) { next = j; continue; }
        const field = e.kind === 'fill' || e.kind === 'select' || e.kind === 'check' || (e.kind === 'click' && focusOf.has(j));
        return next >= 0 && field ? { next, checks } : undefined;
      }
      return undefined;
    };
    const { fills: sameFills, change: pageChange } = pageFills(p, false);
    // Every page before the password page, back to the previous goto (nearest first), stepping over each page's URL
    // checks and the one click or Enter that left it.
    const pages: number[][] = [];
    for (let from = pageChange + 1; pageChange >= 0;) {
      const { fills, change } = pageFills(from, true);
      pages.push(fills);
      if (change < 0 || change + 1 >= from) break;
      from = change + 1;
    }
    const confidentBefore = pages.flat().filter((j) => roles[j] === 'username');
    const here = plausible(sameFills);
    // A field on the password page while the Site Login username was typed on an earlier page is never the username:
    // the sign-in is reported (fields between the pages), and every field here that could be it is stripped.
    const split = sameFills.length > 0 && here.confident.length === 0 && confidentBefore.length > 0;
    let u = split ? -1 : here.confident[0] ?? sameFills.find(usernameLike) ?? sameFills[0] ?? -1;
    const ambiguous = here.ambiguous.filter((j) => j !== u);
    // Several pages (an identity provider's Email, Next, a method page, Continue, Password): every page back to the
    // previous goto may hold the username. A confident one is stripped; else each page's plausible fills are, also when
    // a field on the password page became the username (no value proves which of them holds it).
    const earlier: number[] = [];
    if (pageChange >= 0 && (u < 0 || here.confident.length === 0)) {
      earlier.push(...(confidentBefore.length ? confidentBefore : [...new Set(pages.flatMap((f) => plausible(f).ambiguous))]));
    }
    // Two pages joined by one click or Enter (`hop`), the username proven to be on the first of them.
    const hop = u < 0 && !split ? leftFor(p) : undefined;
    const first = pages[0] ?? [];
    if (hop && first.length > 0 && earlier.every((j) => first.includes(j))) {
      u = first.find((j) => roles[j] === 'username') ?? first.find(usernameLike) ?? first[0];
    }
    const twoPage = hop && u >= 0 ? hop : undefined;
    const s = submitAfter(p);
    // Once the group is built (a username and a submit), a code field typed from an expression or a
    // variable right after the submit is the code field too, whatever its value, when it is a TOTP activity's output or
    // its own label or locator names a code (STRICT_TOTP_FIELD); a literal value still needs 6 to 8 digits.
    const fromExpression = (k: number): boolean => {
      const e = original[k];
      return u >= 0 && e.kind === 'fill' && roles[k] === undefined && !capped.has(k) && isExpressionValue(e.value) && isExpressionCodeField(e);
    };
    const isCode = (k: number) => roles[k] === 'totp' || fromExpression(k);
    let t = -1;
    const between: number[] = [];
    if (s >= 0) {
      for (let k = s + 1; k < events.length; k++) {
        const e = events[k];
        if (e.kind === 'report') continue;
        if (e.kind === 'expectUrl' || e.kind === 'waitFor') { between.push(k); continue; }
        if (e.kind === 'click' && focusOf.has(k) && isCode(focusOf.get(k)!)) continue;
        if (e.kind === 'fill' && isCode(k)) t = k;
        break;
      }
    }
    let ts = t >= 0 ? submitAfter(t) : -1;
    // An expression code with no submit after it is left as it was (it never held a typed secret).
    if (t >= 0 && roles[t] !== 'totp') {
      if (ts >= 0) roles[t] = 'totp';
      else t = -1;
    }
    if (t < 0) ts = -1;
    const complete = u >= 0 && s >= 0;
    const fields = [...new Set([...earlier, u, ...ambiguous, p, ...(complete && ts >= 0 ? [t] : [])])].filter((i) => i >= 0).sort((a, b) => a - b);
    for (const i of fields) {
      const why = i === t && isExpressionValue((original[i] as Typed).value) ? CODE_FROM_EXPRESSION : NEVER_IMPORTED;
      strip(i, i !== u && (ambiguous.includes(i) || (earlier.includes(i) && roles[i] !== 'username')) ? AMBIGUOUS_USERNAME : why);
      joined.add(i);
    }
    removeWithFocus(fields);
    if (complete) {
      const hops = twoPage ? [twoPage.next, ...twoPage.checks] : [];
      const members = [s, ...hops, ...(ts >= 0 ? [ts, ...between] : [])];
      for (const i of members) removed.add(i);
      const checkName = (i: number, wait: string) => events[i].kind === 'expectUrl' ? `URL check ${(events[i] as { path: string }).path}` : wait;
      for (const i of twoPage ? [...twoPage.checks].reverse() : []) add(events[i].at, 'dropped', checkName(i, 'Wait between the username and the password'), BETWEEN_PAGES);
      for (const i of ts >= 0 ? between : []) add(events[i].at, 'dropped', checkName(i, 'Wait between the sign-in and the code'), 'it checks the page between the password and the code, which signIn passes in one step');
      const enterSubmit = (k: number, fallback: Candidate[]): Candidate[] => {
        const e = events[k];
        if (e.kind === 'click') return e.target;
        add(e.at, 'converted', `Press Enter in ${nameOf(e.kind === 'enter' ? e.label : '') || 'the field'}`, 'Enter became a click on the form\'s submit button');
        return structuredClone(fallback);
      };
      const target = (i: number) => (events[i] as Typed).target;
      if (opts.hasSiteLogin) {
        // At the password: same-page fields recorded between the username and the password are filled before signIn.
        signIn = {
          at: p,
          event: {
            at: events[p].at, kind: 'signIn', username: target(u), ...(twoPage ? { next: enterSubmit(twoPage.next, ENTER_FORM_SUBMIT) } : {}),
            password: target(p), submit: enterSubmit(s, ENTER_SUBMIT),
            ...(ts >= 0 ? { totp: { field: target(t), submit: enterSubmit(ts, ENTER_FORM_SUBMIT) } } : {}),
          },
        };
      }
    } else {
      add(events[p].at, 'untranslated', 'Sign in', u < 0 && pageChange >= 0 ? SIGN_IN_PAGES : SIGN_IN_INCOMPLETE);
    }
    if (!opts.hasSiteLogin) add(events[p].at, 'dropped', 'Sign in', IMPORT_NEEDS_SITE_LOGIN);
  }
  const unjoinedCode = roles.findIndex((r, i) => r === 'totp' && !joined.has(i));
  if (unjoinedCode >= 0) add(events[unjoinedCode].at, 'untranslated', 'Sign-in code', CODE_UNJOINED);

  // 2. Every other credential field and Site Login value.
  events.forEach((e, i) => {
    if (removed.has(i) || (e.kind !== 'fill' && e.kind !== 'select')) return;
    if (roles[i] || slValues.some((s) => equalsSecret(e.value, s)) || masker.containsSecret(e.value)) strip(i);
    else if (capped.has(i)) strip(i, CAPPED_VALUE);
  });
  // 3. Values typed into credential fields are secrets too, wherever else they appear (the username typed twice).
  for (const { value, wholeNumber } of typedSecrets) if (value.trim().length >= MIN_SECRET_LENGTH) masker.add([value, value.trim()], { wholeNumber });
  events.forEach((e, i) => {
    if (!removed.has(i) && (e.kind === 'fill' || e.kind === 'select') && masker.containsSecret(e.value)) strip(i);
  });

  // 4. Redact what remains.
  const clean = (cands: Candidate[]) => cands.filter((c) => !masker.containsSecret(JSON.stringify(c)) && !locatorStrings(c).some(isShortSecret));
  const cleanSignIn = (e: Extract<ImportEvent, { kind: 'signIn' }>): ImportEvent => ({
    ...e, username: clean(e.username), ...(e.next ? { next: clean(e.next) } : {}), password: clean(e.password), submit: clean(e.submit),
    ...(e.totp ? { totp: { field: clean(e.totp.field), submit: clean(e.totp.submit) } } : {}),
  });
  const out: ImportEvent[] = [];
  events.forEach((e, i) => {
    if (signIn?.at === i) {
      const s = signIn.event;
      out.push(cleanSignIn(s));
    }
    if (removed.has(i)) return;
    switch (e.kind) {
      case 'goto': {
        const url = cleanUrl(e.url, masker);
        if (url === undefined) { add(e.at, 'secret', 'Open an address', 'the address names a sign-in value: the step was removed'); return; }
        if (url !== e.url) add(e.at, 'secret', 'Open an address', 'the address carried sign-in values: they were removed from it');
        out.push({ ...e, url });
        return;
      }
      case 'expectUrl':
        if (masker.containsSecret(e.path)) { add(e.at, 'secret', 'URL check', 'the path names a sign-in value: the check was removed'); return; }
        out.push(e);
        return;
      case 'report':
        out.push({ ...e, item: { ...e.item, at: maskText(e.item.at), what: maskText(e.item.what), reason: maskText(e.item.reason) } });
        return;
      case 'enter':
        out.push({ ...e, label: maskText(e.label) });
        return;
      case 'signIn':
        // Parsers never emit one; a stray one is cleaned like the built one.
        out.push(cleanSignIn(e));
        return;
      default: {
        const target = clean(e.target);
        const label = maskText(e.label);
        if (target.length === 0 && e.target.length > 0) {
          add(e.at, 'secret', nameOf(label) || 'an element', 'every locator of this step names a sign-in value: the step was removed');
          return;
        }
        out.push({ ...e, target, label } as ImportEvent);
      }
    }
  });

  // Report items the parser added before, and ours, never name a secret either.
  for (const item of [...report.items, ...items]) {
    item.at = maskText(item.at);
    item.what = maskText(item.what);
    item.reason = maskText(item.reason);
  }
  // Every event's location too: it reaches report items the draft builder writes later.
  for (const e of out) e.at = maskText(e.at);
  report.items.push(...items);
  return out;
}

/**
 * A goto address without userinfo, and without its query and fragment when they name a secret. undefined when the rest
 * of the address (host or path) names one.
 */
function cleanUrl(url: string, masker: Masker): string | undefined {
  let out = url;
  if (URL.canParse(out)) {
    const u = new URL(out);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      out = u.href;
    }
  }
  if (!masker.containsSecret(out)) return out;
  const bare = out.split(/[?#]/)[0] ?? '';
  return masker.containsSecret(bare) ? undefined : bare;
}
