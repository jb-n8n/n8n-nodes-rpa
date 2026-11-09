import { canonicalize } from '../sign.js';
import type { DownloadTemplate } from '../steps/file-check.js';
import { verbOf } from '../steps/parse.js';
import type { Interrupt, Locator, Step, SubmitTarget } from '../types.js';

// How the change list and the safety flags describe steps, pop-up handlers and locators. Run Steps
// builds the change list with these; Sign Steps checks it against the same descriptions of the steps it signs.

const q = (v: string): string => oneLine(JSON.stringify(v));

const UNSAFE_CHAR = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const SHORT_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

/** A value on one line: every control, format and line-separator character becomes its JSON escape (`\n`, `\u200b`). Nothing else changes. */
export function oneLine(s: string): string {
  return s.replace(UNSAFE_CHAR, (c) => SHORT_ESCAPES[c] ?? Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''));
}

/** A value as one bare word when it is plain, else JSON-quoted (and on one line), so it cannot fake a clause or a separator. */
export function token(s: string): string {
  return oneLine(s) === s && /^[^\s;,()"]+$/.test(s) ? s : oneLine(JSON.stringify(s));
}

/**
 * Every element a locator may match, for a reviewer: the primary candidate with `exact`, its frame and its `within`
 * scope, then each fallback, joined by " or ". Names and selectors are JSON-quoted, so page text cannot fake a
 * separator or a second candidate.
 */
export function reviewLocator(loc: Locator): string {
  let s: string;
  if ('role' in loc) s = `role ${q(loc.role)}${loc.name !== undefined ? ` name ${q(loc.name)}` : ''}`;
  else if ('label' in loc) s = `label ${q(loc.label)}`;
  else if ('text' in loc) s = `text ${q(loc.text)}`;
  else if ('testId' in loc) s = `test id ${q(loc.testId)}`;
  else s = `css ${q(loc.css)}`;
  if ('exact' in loc && loc.exact) s += ' exact';
  if (loc.frame !== undefined) s += ` in frame ${q(loc.frame)}`;
  if (loc.within) s += ` within [${reviewLocator(loc.within)}]`;
  return [s, ...(loc.fallbacks ?? []).map(reviewLocator)].join(' or ');
}

/** A download's declared checks, for a reviewer: type, name, size, columns and rows, each only when set. */
export function describeCheck(d: DownloadTemplate): string {
  const c = d.check;
  const out = [
    d.mime?.length ? `type ${d.mime.map(token).join(', ')}` : '',
    c.name !== undefined ? ((t) => (t === c.name ? `name /${t}/` : `name ${t}`))(token(c.name)) : '',
    c.minBytes !== undefined ? `at least ${c.minBytes} bytes` : '',
    c.columns !== undefined ? `columns ${c.columns.map(q).join(', ')}` : '',
    c.minRows !== undefined ? `at least ${c.minRows} ${c.minRows === 1 ? 'row' : 'rows'}` : '',
  ].filter(Boolean);
  return out.length ? out.join('; ') : 'no checks';
}

const target = (t: SubmitTarget) => `${(t.method ?? 'POST').toUpperCase()} ${t.host !== undefined ? token(t.host) : 'the start site'}${token(t.path)}`;

/** What a step does, in a few words: the verb, its locators and its target or value. */
function stepAction(step: Step): string {
  const verb = verbOf(step);
  let s: string;
  if ('goto' in step) s = `go to ${q(step.goto)}`;
  else if ('signIn' in step) {
    const { username, next, password, submit, totp } = step.signIn;
    s = `sign in with ${reviewLocator(username)}, ${next ? `next ${reviewLocator(next)}, ` : ''}${reviewLocator(password)}, submit ${reviewLocator(submit)}`
      + (totp
        ? `${totp.via ? `, then click ${totp.via.map(reviewLocator).join(', then ')} if shown` : ''}, code in ${reviewLocator(totp.field)}`
          + `${totp.check ? `, tick ${totp.check.map(reviewLocator).join(', ')}` : ''}, submit ${reviewLocator(totp.submit)}`
        : '');
  } else if ('click' in step) s = `click ${reviewLocator(step.click)}`;
  else if ('fill' in step) s = `fill ${reviewLocator(step.fill.field)} with ${q(step.fill.value)}`;
  else if ('select' in step) s = `select ${q([step.select.value].flat().join(', '))} in ${reviewLocator(step.select.field)}`;
  else if ('check' in step) s = `${step.check.checked === false ? 'uncheck' : 'check'} ${reviewLocator(step.check.field)}`;
  else if ('clickAll' in step) s = `click every ${reviewLocator(step.clickAll.target)}, at most ${step.clickAll.max}`;
  else if ('waitFor' in step) {
    const w = step.waitFor;
    s = ['wait for', w.target ? reviewLocator(w.target) : 'the page', w.state, w.hasText !== undefined ? `with text ${q(w.hasText)}` : '',
      w.minCount !== undefined ? `at least ${w.minCount}` : '', w.response ? `and a response from ${q(w.response.urlContains)}` : '']
      .filter(Boolean).join(' ');
  } else if ('paginate' in step) s = `paginate next ${reviewLocator(step.paginate.next)} until ${step.paginate.until}, at most ${step.paginate.max} pages`;
  else if ('extract' in step) {
    const e = step.extract;
    s = `extract rows from ${reviewLocator(e.scope)}${e.item ? `, items ${reviewLocator(e.item)}` : ''}${e.idPattern ? `, ID pattern ${token(e.idPattern)}` : ''}`
      + (e.fields ? `, fields ${Object.keys(e.fields).map(q).join(', ')}` : '');
  } else if ('submit' in step) s = `submit with ${reviewLocator(step.submit.button)} to ${target(step.submit)}`;
  else if ('download' in step) {
    const d = step.download;
    s = `download with ${reviewLocator(d.trigger)}${d.via ? ` through ${target(d.via)}` : ''}`
      + (d.check ? `; checks: ${describeCheck({ mime: d.mime, maxBytes: d.maxBytes, check: d.check })}` : '');
  }
  else if ('popup' in step) s = `open a new tab with ${reviewLocator(step.popup.trigger)}`;
  else if ('detect' in step) s = `detect ${q(step.detect.name)}: ${Object.entries(step.detect.checks).map(([k, l]) => `${q(k)} ${reviewLocator(l)}`).join('; ')}`;
  else if ('screenshot' in step) s = `screenshot ${step.screenshot.capture}${step.screenshot.element ? ` of ${reviewLocator(step.screenshot.element)}` : ''}`;
  else if ('read' in step) s = `read the ${step.read.what}`;
  else if ('extractTable' in step) s = `extract table ${reviewLocator(step.extractTable.table)}${step.extractTable.idPattern ? `, ID pattern ${token(step.extractTable.idPattern)}` : ''}`;
  else s = verb;
  return step.when ? `if ${reviewLocator(step.when.visible)} shows, ${s}` : s;
}

/**
 * A step as the change list shows it: its intent and, in brackets, what it does (verb, locator, target or value).
 * The intent comes from page text, so the action is what a reviewer should check. The action is always the LAST
 * bracketed group: an intent may itself contain parentheses (only line breaks and control characters are escaped).
 */
export function describeStep(step: Step): string {
  return `${oneLine(step.intent)} (${stepAction(step)})`;
}

/** What a pop-up handler (interrupt) does: the change list and the safety flags show it with their own prefixes. */
export function interruptAction(it: Interrupt): string {
  return `when ${reviewLocator(it.target)} shows, click ${reviewLocator(it.click)}`;
}

/** A pop-up handler (interrupt) as the change list shows it. */
export function describeInterrupt(it: Interrupt): string {
  return `Pop-up handler: ${interruptAction(it)}`;
}

/** A step without a paginate's nested steps: the change list lists those on their own. */
export const withoutBody = (step: Step): Step => ('paginate' in step ? { ...step, paginate: { ...step.paginate, each: [] } } : step);

/** Opens the list of fields that changed when a changed step reads the same as before (stepChanges). */
export const ALSO_CHANGED = ' (also changed: ';

/**
 * The fields that differ between two versions of a step, as dotted names (`expect`, `click.fallbacks`, `timeoutMs`).
 * A paginate's nested steps are not compared: they are listed on their own.
 */
export function changedFields(was: Step, now: Step): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    const plain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
    if (depth < 2 && plain(a) && plain(b)) {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        walk(a[k], b[k], path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    if ((a === undefined ? '' : canonicalize(a)) !== (b === undefined ? '' : canonicalize(b))) out.push(path);
  };
  walk(withoutBody(was), withoutBody(now), '', 0);
  return out;
}
