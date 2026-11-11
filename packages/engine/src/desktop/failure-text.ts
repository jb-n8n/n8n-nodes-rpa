// What a failed desktop step says first: the step, what it found, what to do, then the runner's own target. The runner
// (desktop/runner) words these failures around its locator; for the three a person meets most (several matches, a
// disabled element, a window of a copy of the app the run did not start) the lead is rebuilt from its text here. A
// runner text of another shape is shown as it came.
import { desktopDisabled, desktopNotUnique, desktopOtherCopy } from '../messages.js';
import { ElementNotUniqueError, PolicyRefusedError, RunnerError, RunnerTimeoutError } from './protocol.js';

const NOT_UNIQUE = /^not_unique: the primary target (.+) matched (\d+) visible elements\./;
const DISABLED = /^timeout: the element is disabled: the app reports it to UI Automation as not enabled \((.+)\)\. (.+)$/;
const OTHER_COPY = /^policy_refused: the window (.+) belongs to a copy of "([^"]+)" that this run did not start \(most often one that was already open before the run\)/;

/** The fields of the last condition of a runner target (`{…} :: {…} > {controlType="Button", name="Save"}`). */
function lastCondition(target: string): { controlType?: string; name?: string; automationId?: string } {
  const last = target.slice(target.lastIndexOf('{'));
  const out: Record<string, string> = {};
  for (const m of last.matchAll(/(controlType|name|automationId)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** A UI Automation control type as a person names it: `Button` → button, `Edit` → text box, `CheckBox` → check box. */
function controlWord(controlType: string | undefined): string | undefined {
  if (!controlType) return undefined;
  const special: Record<string, string> = { Edit: 'text box', Hyperlink: 'link', Text: 'label' };
  return special[controlType] ?? controlType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

const plural = (word: string): string => (/(s|x|ch|sh)$/.test(word) ? `${word}es` : `${word}s`);

/** `buttons named "Save"`, `button with the id "btnSave"`, `elements`. */
function what(target: string, count: number): string {
  const c = lastCondition(target);
  const word = controlWord(c.controlType);
  const noun = count === 1 ? word ?? 'element' : plural(word ?? 'element');
  if (c.name !== undefined) return `${noun} named "${c.name}"`;
  if (c.automationId !== undefined) return `${noun} with the id "${c.automationId}"`;
  return noun;
}

/** The conditions the target does not use yet, as the runner suggests them. */
function missingConditions(target: string): string {
  const c = lastCondition(target);
  const missing = [c.name === undefined ? 'name' : '', c.automationId === undefined ? 'automationId' : '', 'className'].filter(Boolean);
  return missing.length > 1 ? `${missing.slice(0, -1).join(', ')} or ${missing.at(-1)}` : missing[0];
}

/**
 * The lead of a failed desktop step whose runner error is one of the three above, or undefined to show the runner's
 * text as it came. `index`: the step's 0-based index (shown 1-based, as the review page and the emails number them).
 */
export function desktopFailureText(index: number, intent: string, err: unknown): string | undefined {
  if (!(err instanceof RunnerError)) return undefined;
  const step = { number: index + 1, intent: intent.replace(/\s+/g, ' ').trim() };
  if (err instanceof ElementNotUniqueError) {
    const m = NOT_UNIQUE.exec(err.message);
    if (m) return desktopNotUnique(step, `${m[2]} ${what(m[1], Number(m[2]))}`, missingConditions(m[1]), m[1]);
  }
  if (err instanceof RunnerTimeoutError) {
    const m = DISABLED.exec(err.message);
    if (m) return desktopDisabled(step, `the ${what(m[1], 1)}`, m[2], m[1]);
  }
  if (err instanceof PolicyRefusedError) {
    const m = OTHER_COPY.exec(err.message);
    if (m) return desktopOtherCopy(step, m[2], m[1]);
  }
  return undefined;
}
