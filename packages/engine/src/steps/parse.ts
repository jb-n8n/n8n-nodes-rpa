import { STEP_VERBS, type Script, type Step, type StepVerb } from '../types.js';
import { FIRST_STEP_GOTO } from '../messages.js';

export class ScriptShapeError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid script: ${issues.join('; ')}`);
    this.name = 'ScriptShapeError';
  }
}

const BASE_KEYS = new Set(['intent', 'optional', 'when', 'expect', 'checkpoint', 'timeoutMs']);
const LOCATOR_KINDS = ['role', 'label', 'text', 'testId', 'css'] as const;
const LOCATOR_KEYS = new Set([...LOCATOR_KINDS, 'name', 'exact', 'within', 'frame', 'fallbacks']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'];
const FIELD_ATTRIBUTES = ['text', 'href', 'src', 'title', 'alt', 'aria-label'];

/** An absolute http(s) URL without a {{template}}, normalised as the browser will load it; undefined otherwise. */
export function absoluteHttpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '' || v.includes('{{') || !URL.canParse(v)) return undefined;
  const u = new URL(v);
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function checkKeys(obj: Obj, allowed: readonly string[], path: string, issues: string[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) issues.push(`${path} has unknown key "${k}"`);
}

export function verbOf(step: Step): StepVerb {
  const v = STEP_VERBS.find((k) => Object.hasOwn(step, k));
  if (!v) throw new Error(`step "${step.intent}" has no action`);
  return v;
}

function checkRegex(src: unknown, path: string, issues: string[]) {
  if (!isStr(src)) { issues.push(`${path} must be a non-empty regex string`); return; }
  try { new RegExp(src); } catch { issues.push(`${path} is not a valid regex`); }
}

/** Names a field in an issue: `${path}.${key}` for a step; a template passes labels (downloadTemplateIssues). */
type FieldName = (key: string) => string;

function checkFileCheck(v: unknown, path: string, issues: string[], at: FieldName = (k) => `${path}.${k}`) {
  if (!isObj(v)) { issues.push(`${path} must be an object`); return; }
  checkKeys(v, ['name', 'minBytes', 'columns', 'minRows'], path, issues);
  if (v.name !== undefined) checkRegex(v.name, at('name'), issues);
  if (v.minBytes !== undefined && !isInt(v.minBytes, 1, 200 * 1024 * 1024)) issues.push(`${at('minBytes')} must be between 1 and 209715200`);
  if (v.minRows !== undefined && !isInt(v.minRows, 0, 1_000_000_000)) issues.push(`${at('minRows')} must be a whole number from 0 to 1000000000`);
  if (v.columns !== undefined && !(Array.isArray(v.columns) && v.columns.length >= 1 && v.columns.length <= 50 && v.columns.every((c) => isStr(c) && c.length <= 200))) {
    issues.push(`${at('columns')} must be 1 to 50 strings of at most 200 characters`);
  }
}

/** A download step's `maxBytes`, `mime` and `check`, the rules a step and a download template share. */
function checkDownloadFile(v: Obj, path: string, issues: string[], at: FieldName = (k) => `${path}.${k}`, atCheck?: FieldName) {
  if (v.maxBytes !== undefined && !isInt(v.maxBytes, 1, 200 * 1024 * 1024)) issues.push(`${at('maxBytes')} must be between 1 and 209715200`);
  if (v.mime !== undefined && !(Array.isArray(v.mime) && v.mime.length > 0 && v.mime.every(isStr))) issues.push(`${at('mime')} must be a non-empty array of strings`);
  if (v.check !== undefined) checkFileCheck(v.check, at('check'), issues, atCheck);
}

/** The node's Expected File labels for a template's fields; the raw key stays in brackets for API callers. */
const TEMPLATE_LABELS: Record<string, string> = {
  mime: 'File Type (mime)', maxBytes: 'maxBytes', check: 'check',
  'check.name': 'File Name Pattern (check.name)', 'check.minBytes': 'Minimum Size (check.minBytes)',
  'check.columns': 'Required Columns (check.columns)', 'check.minRows': 'Minimum Rows (check.minRows)',
};

/**
 * What is wrong with a download template (`{ mime?, maxBytes?, check }`, a first run's Expected File) under the same
 * rules parseScript applies to a download step; [] when it is valid. Never throws.
 */
export function downloadTemplateIssues(v: unknown): string[] {
  const issues: string[] = [];
  if (!isObj(v)) return ['download must be an object'];
  checkKeys(v, ['mime', 'maxBytes', 'check'], 'download', issues);
  checkDownloadFile(v, 'download', issues, (k) => TEMPLATE_LABELS[k] ?? k, (k) => TEMPLATE_LABELS[`check.${k}`] ?? `check.${k}`);
  return issues;
}

function checkLocator(v: unknown, path: string, issues: string[], allowFallbacks = true) {
  if (!isObj(v)) { issues.push(`${path} must be a locator object`); return; }
  for (const k of Object.keys(v)) if (!LOCATOR_KEYS.has(k)) issues.push(`${path} has unknown key "${k}"`);
  const kinds = LOCATOR_KINDS.filter((k) => Object.hasOwn(v, k));
  if (kinds.length !== 1 || !isStr(v[kinds[0]])) issues.push(`${path} must have exactly one of ${LOCATOR_KINDS.join('/')} as a non-empty string`);
  if (v.name !== undefined && typeof v.name !== 'string') issues.push(`${path}.name must be a string`);
  if (v.exact !== undefined && typeof v.exact !== 'boolean') issues.push(`${path}.exact must be a boolean`);
  if (v.frame !== undefined && !isStr(v.frame)) issues.push(`${path}.frame must be a CSS selector`);
  if (v.within !== undefined) checkLocator(v.within, `${path}.within`, issues, false);
  if (v.fallbacks !== undefined) {
    if (!allowFallbacks) { issues.push(`${path} has nested fallbacks`); return; }
    if (!Array.isArray(v.fallbacks) || v.fallbacks.length > 5) { issues.push(`${path}.fallbacks must be an array of at most 5 locators`); return; }
    v.fallbacks.forEach((f, i) => {
      if (isObj(f) && Object.hasOwn(f, 'fallbacks')) issues.push(`${path}.fallbacks[${i}] has nested fallbacks`);
      else checkLocator(f, `${path}.fallbacks[${i}]`, issues, false);
    });
  }
}

function checkSubmitTarget(v: Obj, path: string, issues: string[]) {
  if (!isStr(v.path) || !v.path.startsWith('/')) issues.push(`${path}.path must start with "/"`);
  if (v.host !== undefined && !isStr(v.host)) issues.push(`${path}.host must be a string`);
  if (v.method !== undefined && !(typeof v.method === 'string' && METHODS.has(v.method.toUpperCase()))) issues.push(`${path}.method must be one of ${[...METHODS].join(', ')}`);
}

function checkSteps(steps: unknown, path: string, issues: string[], nested: boolean) {
  if (!Array.isArray(steps) || steps.length === 0) { issues.push(`${path} must be a non-empty array`); return; }
  if (steps.length > 200) issues.push(`${path} has more than 200 steps`);
  steps.forEach((s, i) => checkStep(s, `${path}[${i}]`, issues, nested));
}

function checkStep(s: unknown, path: string, issues: string[], nested: boolean) {
  if (!isObj(s)) { issues.push(`${path} must be an object`); return; }
  if (!isStr(s.intent) || s.intent.length > 200) issues.push(`${path}.intent must be a non-empty string of at most 200 characters`);
  // waitUntil belongs to goto only; on any other verb it is reported as an unknown key.
  const verbExtras = Object.hasOwn(s, 'goto') ? ['waitUntil'] : [];
  const verbs = Object.keys(s).filter((k) => !BASE_KEYS.has(k) && !verbExtras.includes(k));
  const known = verbs.filter((k) => (STEP_VERBS as readonly string[]).includes(k));
  if (known.length !== 1 || verbs.length !== 1) {
    const unknown = verbs.filter((k) => !(STEP_VERBS as readonly string[]).includes(k));
    if (known.length === 1 && unknown.length) unknown.forEach((k) => issues.push(`${path} has unknown key "${k}"`));
    else issues.push(`${path} must have exactly one action (${STEP_VERBS.join(', ')})`);
    return;
  }
  if (s.optional !== undefined && typeof s.optional !== 'boolean') issues.push(`${path}.optional must be a boolean`);
  if (s.checkpoint !== undefined && typeof s.checkpoint !== 'boolean') issues.push(`${path}.checkpoint must be a boolean`);
  if (s.timeoutMs !== undefined && !isInt(s.timeoutMs, 100, 120_000)) issues.push(`${path}.timeoutMs must be an integer between 100 and 120000`);
  if (s.when !== undefined) {
    if (!isObj(s.when)) issues.push(`${path}.when must be an object`);
    else {
      checkKeys(s.when, ['visible'], `${path}.when`, issues);
      checkLocator(s.when.visible, `${path}.when.visible`, issues);
    }
  }
  if (s.expect !== undefined) {
    if (!isObj(s.expect)) issues.push(`${path}.expect must be an object`);
    else {
      checkKeys(s.expect, ['url', 'heading', 'visible'], `${path}.expect`, issues);
      if (s.expect.url !== undefined && !isStr(s.expect.url)) issues.push(`${path}.expect.url must be a string`);
      if (s.expect.heading !== undefined && !isStr(s.expect.heading)) issues.push(`${path}.expect.heading must be a string`);
      if (s.expect.visible !== undefined) checkLocator(s.expect.visible, `${path}.expect.visible`, issues);
    }
  }
  const verb = known[0] as StepVerb;
  const v = s[verb];
  const p = `${path}.${verb}`;
  switch (verb) {
    case 'goto':
      if (!isStr(v)) issues.push(`${p} must be a URL or path string`);
      if (s.waitUntil !== undefined && !WAIT_UNTIL.includes(s.waitUntil as string)) {
        issues.push(`${path}.waitUntil must be "load", "domcontentloaded" or "networkidle"`);
      }
      break;
    case 'click':
      checkLocator(v, p, issues);
      break;
    case 'signIn':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      if (nested) issues.push(`${p}: signIn is not allowed inside paginate`);
      checkKeys(v, ['username', 'next', 'password', 'submit', 'totp'], p, issues);
      checkLocator(v.username, `${p}.username`, issues);
      if (v.next !== undefined) checkLocator(v.next, `${p}.next`, issues);
      checkLocator(v.password, `${p}.password`, issues);
      checkLocator(v.submit, `${p}.submit`, issues);
      if (v.totp !== undefined) {
        if (!isObj(v.totp)) issues.push(`${p}.totp must be an object`);
        else {
          checkKeys(v.totp, ['field', 'submit'], `${p}.totp`, issues);
          checkLocator(v.totp.field, `${p}.totp.field`, issues);
          checkLocator(v.totp.submit, `${p}.totp.submit`, issues);
        }
      }
      for (const [k, loc] of [['username', v.username], ['next', v.next], ['password', v.password], ['submit', v.submit], ['totp.field', (v.totp as Obj | undefined)?.field], ['totp.submit', (v.totp as Obj | undefined)?.submit]] as const) {
        if (isObj(loc) && loc.frame !== undefined) issues.push(`${p}.${k} cannot use frame`);
      }
      break;
    case 'fill':
    case 'select':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['field', 'value'], p, issues);
      checkLocator(v.field, `${p}.field`, issues);
      if (typeof v.value !== 'string') issues.push(`${p}.value must be a string`);
      break;
    case 'check':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['field', 'checked'], p, issues);
      checkLocator(v.field, `${p}.field`, issues);
      if (v.checked !== undefined && typeof v.checked !== 'boolean') issues.push(`${p}.checked must be a boolean`);
      break;
    case 'clickAll':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['target', 'max'], p, issues);
      checkLocator(v.target, `${p}.target`, issues);
      if (!isInt(v.max, 1, 100)) issues.push(`${p}.max must be an integer between 1 and 100`);
      break;
    case 'waitFor':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['target', 'state', 'hasText', 'minCount', 'response'], p, issues);
      if (v.target === undefined && v.response === undefined) issues.push(`${p} needs a target or a response`);
      if (v.target !== undefined) checkLocator(v.target, `${p}.target`, issues);
      if (v.state !== undefined && !['visible', 'hidden', 'attached'].includes(v.state as string)) issues.push(`${p}.state is invalid`);
      if (v.hasText !== undefined && !isStr(v.hasText)) issues.push(`${p}.hasText must be a string`);
      if (v.minCount !== undefined && !isInt(v.minCount, 1, 10_000)) issues.push(`${p}.minCount must be a positive integer`);
      if (v.response !== undefined) {
        if (!isObj(v.response)) issues.push(`${p}.response must be an object`);
        else {
          checkKeys(v.response, ['urlContains'], `${p}.response`, issues);
          if (!isStr(v.response.urlContains)) issues.push(`${p}.response.urlContains must be a string`);
        }
      }
      break;
    case 'paginate':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['next', 'until', 'max', 'nextWaitMs', 'each'], p, issues);
      if (nested) { issues.push(`${p}: nested paginate is not allowed`); break; }
      checkLocator(v.next, `${p}.next`, issues);
      if (!['absent', 'disabled'].includes(v.until as string)) issues.push(`${p}.until must be "absent" or "disabled"`);
      if (!isInt(v.max, 1, 100)) issues.push(`${p}.max must be an integer between 1 and 100`);
      if (v.nextWaitMs !== undefined && !isInt(v.nextWaitMs, 0, 10_000)) issues.push(`${p}.nextWaitMs must be an integer between 0 and 10000`);
      checkSteps(v.each, `${p}.each`, issues, true);
      break;
    case 'extract':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['scope', 'item', 'fields', 'idPattern', 'textMode'], p, issues);
      checkLocator(v.scope, `${p}.scope`, issues);
      if (v.item !== undefined) checkLocator(v.item, `${p}.item`, issues);
      if (v.idPattern !== undefined) checkRegex(v.idPattern, `${p}.idPattern`, issues);
      else if (v.item === undefined) issues.push(`${p} needs an item locator when it has no idPattern`);
      if (v.textMode !== undefined && !['text', 'textContent'].includes(v.textMode as string)) issues.push(`${p}.textMode is invalid`);
      if (v.fields !== undefined) {
        if (!isObj(v.fields)) issues.push(`${p}.fields must be an object`);
        else for (const [name, f] of Object.entries(v.fields)) {
          if (!isObj(f)) { issues.push(`${p}.fields.${name} must be an object`); continue; }
          checkKeys(f, ['locator', 'pattern', 'attribute'], `${p}.fields.${name}`, issues);
          const hasLocator = Object.hasOwn(f, 'locator');
          const hasPattern = Object.hasOwn(f, 'pattern');
          if (hasLocator === hasPattern) { issues.push(`${p}.fields.${name} needs exactly one of locator/pattern`); continue; }
          if (hasLocator) checkLocator(f.locator, `${p}.fields.${name}.locator`, issues);
          else checkRegex(f.pattern, `${p}.fields.${name}.pattern`, issues);
          if (f.attribute !== undefined) {
            if (!hasLocator) issues.push(`${p}.fields.${name}.attribute needs a locator`);
            else if (!FIELD_ATTRIBUTES.includes(f.attribute as string)) issues.push(`${p}.fields.${name}.attribute must be one of ${FIELD_ATTRIBUTES.join(', ')}`);
          }
        }
      }
      break;
    case 'submit':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['button', 'path', 'host', 'method'], p, issues);
      checkLocator(v.button, `${p}.button`, issues);
      checkSubmitTarget(v, p, issues);
      break;
    case 'download':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['trigger', 'via', 'maxBytes', 'mime', 'check'], p, issues);
      checkLocator(v.trigger, `${p}.trigger`, issues);
      if (v.via !== undefined) {
        if (!isObj(v.via)) issues.push(`${p}.via must be an object`);
        else {
          checkKeys(v.via, ['path', 'host', 'method'], `${p}.via`, issues);
          checkSubmitTarget(v.via, `${p}.via`, issues);
        }
      }
      checkDownloadFile(v, p, issues);
      break;
    case 'popup':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['trigger'], p, issues);
      checkLocator(v.trigger, `${p}.trigger`, issues);
      break;
    case 'detect':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['name', 'checks', 'require'], p, issues);
      if (!isStr(v.name)) issues.push(`${p}.name must be a string`);
      if (!isObj(v.checks) || Object.keys(v.checks).length === 0) { issues.push(`${p}.checks must be a non-empty object`); break; }
      for (const [k, loc] of Object.entries(v.checks)) checkLocator(loc, `${p}.checks.${k}`, issues);
      if (v.require !== undefined && !(isStr(v.require) && Object.hasOwn(v.checks, v.require))) issues.push(`${p}.require must name one of the checks`);
      break;
    case 'screenshot':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['capture', 'element'], p, issues);
      if (!['full', 'viewport', 'element'].includes(v.capture as string)) issues.push(`${p}.capture must be "full", "viewport" or "element"`);
      if (v.capture === 'element') checkLocator(v.element, `${p}.element`, issues);
      else if (v.element !== undefined) issues.push(`${p}.element is only used with capture "element"`);
      break;
    case 'pdf':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['paper', 'background'], p, issues);
      if (v.paper !== undefined && !['A4', 'Letter'].includes(v.paper as string)) issues.push(`${p}.paper must be "A4" or "Letter"`);
      if (v.background !== undefined && typeof v.background !== 'boolean') issues.push(`${p}.background must be a boolean`);
      break;
    case 'read':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['what'], p, issues);
      if (!['text', 'html', 'title', 'url'].includes(v.what as string)) issues.push(`${p}.what must be "text", "html", "title" or "url"`);
      break;
    case 'extractTable':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['table', 'idPattern'], p, issues);
      checkLocator(v.table, `${p}.table`, issues);
      if (v.idPattern !== undefined) checkRegex(v.idPattern, `${p}.idPattern`, issues);
      break;
  }
}

/**
 * Checks a step document (`{ name?, version?, startUrl?, interrupts?, steps }`, or a bare array of steps) and returns a
 * normalised clone whose `startUrl` is set: the document's own startUrl, else its first step's absolute goto, else
 * `opts.defaultStartUrl`. Hashing and signatures always use the raw input, never this clone.
 */
export function parseScript(input: unknown, opts: { defaultStartUrl?: string } = {}): Script {
  const issues: string[] = [];
  const doc: unknown = Array.isArray(input) ? { steps: input } : input;
  if (!isObj(doc)) throw new ScriptShapeError(['script must be an object']);
  for (const k of Object.keys(doc)) if (!['name', 'version', 'startUrl', 'interrupts', 'steps'].includes(k)) issues.push(`script has unknown key "${k}"`);
  if (doc.name !== undefined && !isStr(doc.name)) issues.push('name must be a non-empty string');
  if (doc.version !== undefined && !isInt(doc.version, 1, Number.MAX_SAFE_INTEGER)) issues.push('version must be a positive integer');
  let startUrl: string | undefined;
  if (doc.startUrl !== undefined) {
    let okUrl = false;
    if (isStr(doc.startUrl)) { try { okUrl = ['http:', 'https:'].includes(new URL(doc.startUrl).protocol); } catch { okUrl = false; } }
    if (okUrl) startUrl = doc.startUrl as string;
    else issues.push('startUrl must be an absolute http(s) URL');
  } else {
    const first = Array.isArray(doc.steps) && isObj(doc.steps[0]) ? doc.steps[0] : undefined;
    startUrl = absoluteHttpUrl(first?.goto) ?? absoluteHttpUrl(opts.defaultStartUrl);
    if (startUrl === undefined) issues.push(FIRST_STEP_GOTO);
  }
  if (doc.interrupts !== undefined) {
    if (!Array.isArray(doc.interrupts)) issues.push('interrupts must be an array');
    else doc.interrupts.forEach((it, i) => {
      if (!isObj(it)) { issues.push(`interrupts[${i}] must be an object`); return; }
      checkKeys(it, ['target', 'click'], `interrupts[${i}]`, issues);
      checkLocator(it.target, `interrupts[${i}].target`, issues, false);
      checkLocator(it.click, `interrupts[${i}].click`, issues, false);
    });
  }
  checkSteps(doc.steps, 'steps', issues, false);
  if (issues.length) throw new ScriptShapeError(issues);
  return structuredClone({ ...doc, startUrl }) as unknown as Script;
}
