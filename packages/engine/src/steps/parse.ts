import { DESKTOP_VERBS, STEP_VERBS, type DesktopScript, type DesktopVerb, type Script, type Step, type StepVerb } from '../types.js';
import {
  BROWSER_STEPS_NEED_BROWSER, browserLocatorOnDesktop, browserStepOnDesktop, DESKTOP_STEPS_NEED_RUNNER, desktopLocatorInBrowser, exportDirOnlyInFill,
  FIRST_STEP_GOTO, reservedTemplate, secretFillValue,
} from '../messages.js';
import { SECRET_FILL_VALUE } from '../secrets/render.js';
import { DESKTOP_WRITE_VERBS, READ_NAME, stepChordProblem } from './desktop-vocabulary.js';

export class ScriptShapeError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid script: ${issues.join('; ')}`);
    this.name = 'ScriptShapeError';
  }
}

const SURFACE_INVALID = 'surface must be "browser" or "desktop"';
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
  if (Object.hasOwn(v, 'uia')) { issues.push(desktopLocatorInBrowser(path)); return; }
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
          checkKeys(v.totp, ['field', 'submit', 'source'], `${p}.totp`, issues);
          checkLocator(v.totp.field, `${p}.totp.field`, issues);
          checkLocator(v.totp.submit, `${p}.totp.submit`, issues);
          if (v.totp.source !== undefined && v.totp.source !== 'seed' && v.totp.source !== 'workflow') issues.push(`${p}.totp.source must be "seed" or "workflow"`);
        }
      }
      for (const [k, loc] of [['username', v.username], ['next', v.next], ['password', v.password], ['submit', v.submit], ['totp.field', (v.totp as Obj | undefined)?.field], ['totp.submit', (v.totp as Obj | undefined)?.submit]] as const) {
        if (isObj(loc) && loc.frame !== undefined) issues.push(`${p}.${k} cannot use frame`);
      }
      break;
    case 'fill':
    case 'select':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, verb === 'fill' ? ['field', 'value', 'secret'] : ['field', 'value'], p, issues);
      checkLocator(v.field, `${p}.field`, issues);
      if (verb === 'select' && Array.isArray(v.value)) {
        if (v.value.length === 0 || v.value.length > 100 || !v.value.every((x) => typeof x === 'string')) issues.push(`${p}.value must be a string or a non-empty array of at most 100 strings`);
      } else if (typeof v.value !== 'string') issues.push(`${p}.value must be a string${verb === 'select' ? ' or an array of strings' : ''}`);
      if (verb === 'fill' && v.secret !== undefined) {
        if (typeof v.secret !== 'boolean') issues.push(`${p}.secret must be a boolean`);
        else if (v.secret && typeof v.value === 'string' && !SECRET_FILL_VALUE.test(v.value)) issues.push(secretFillValue(`${p}.value`));
      }
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
  // Fail closed on the surface: a desktop step set never runs in a browser, and an unknown surface is refused.
  // Own properties only: the hash (canonicalize) covers own properties, so routing never reads an inherited one.
  const surface = Object.hasOwn(doc, 'surface') ? doc.surface : undefined;
  if (surface === 'desktop') throw new ScriptShapeError([DESKTOP_STEPS_NEED_RUNNER]);
  if (surface !== undefined && surface !== 'browser') throw new ScriptShapeError([SURFACE_INVALID]);
  for (const k of Object.keys(doc)) if (!['surface', 'name', 'version', 'startUrl', 'interrupts', 'steps'].includes(k)) issues.push(`script has unknown key "${k}"`);
  checkBrowserTemplates(doc.steps, issues);
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

// Reserved templates. `{{$name}}` is kept apart from the steps' own `{{var.x}}` templates: the only one there is,
// {{$exportDir}}, is the desktop runner's export directory, and it is accepted only in a desktop fill value.

/** A `{{$name}}` template, also behind extra braces or spaces (`{{{ $name }}}`), so none slips past the check. */
const RESERVED = /\{\{[\s{]*(\$[^}]*?)\s*\}\}/g;
/** {{$exportDir}} as a fill value may write it (the same spacing renderVars accepts). */
export const EXPORT_DIR_TOKEN = /\{\{\s*\$exportDir\s*\}\}/g;

/**
 * Refuses every `{{$...}}` template in any string of `v`, except {{$exportDir}} where `exportDirAllowed` accepts the
 * string's path. Paths are `steps[0].fill.value` style, without a leading dot.
 */
function checkTemplates(v: unknown, path: string, exportDirAllowed: (path: string) => boolean, issues: string[]) {
  if (typeof v === 'string') {
    for (const m of v.matchAll(RESERVED)) {
      const expr = m[1];
      const at = path || 'script';
      if (expr !== '$exportDir') issues.push(reservedTemplate(at, expr));
      else if (!exportDirAllowed(path)) issues.push(exportDirOnlyInFill(at));
    }
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => checkTemplates(x, `${path}[${i}]`, exportDirAllowed, issues)); return; }
  if (isObj(v)) for (const [k, x] of Object.entries(v)) checkTemplates(x, path ? `${path}.${k}` : k, exportDirAllowed, issues);
}

/**
 * Browser step sets: the values the run renders (goto, fill and select values, paginate bodies included) may not hold a
 * `{{$...}}` template. Other strings (intents, locator texts, regexes) are never rendered and stay as they were: a page
 * can show a literal `{{ $ctrl.x }}` that a text locator matches.
 */
function checkBrowserTemplates(steps: unknown, issues: string[], path = 'steps') {
  if (!Array.isArray(steps)) return;
  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    const at = `${path}[${i}]`;
    if (typeof s.goto === 'string') checkTemplates(s.goto, `${at}.goto`, () => false, issues);
    for (const verb of ['fill', 'select']) {
      const v = s[verb];
      if (isObj(v) && typeof v.value === 'string') checkTemplates(v.value, `${at}.${verb}.value`, () => false, issues);
      else if (isObj(v) && Array.isArray(v.value)) v.value.forEach((x, j) => { if (typeof x === 'string') checkTemplates(x, `${at}.${verb}.value[${j}]`, () => false, issues); });
    }
    if (isObj(s.paginate)) checkBrowserTemplates(s.paginate.each, issues, `${at}.paginate.each`);
  });
}

const DESKTOP_BASE_KEYS = new Set(['intent', 'optional', 'when', 'expect', 'checkpoint', 'timeoutMs', 'write']);
const BROWSER_LOCATOR_KEYS = ['role', 'label', 'text', 'testId', 'css', 'name', 'exact', 'within', 'frame'];
const WINDOW_KEYS = ['exe', 'title', 'titlePattern', 'automationId', 'className'];
const COND_TEXT_KEYS = ['controlType', 'automationId', 'name', 'className'];
const MAX_UIA_TEXT = 500;
/**
 * The largest file an expectFile step may ask for: the desktop runner's ceiling (its policy's maxFileBytes may be at
 * most 36 MiB, so that one answer stays under the 50 MiB frame limit). The runner's policy maxFileBytes (20 MiB by
 * default) is the effective limit; a larger file is refused by the runner (policy_refused).
 */
export const MAX_EXPECTED_FILE_BYTES = 36 * 1024 * 1024;
const isText = (v: unknown, max = MAX_UIA_TEXT): v is string => isStr(v) && v.length <= max && !/[\r\n]/.test(v);

function checkWindowSel(v: unknown, path: string, issues: string[]) {
  if (!isObj(v)) { issues.push(`${path} must be an object`); return; }
  checkKeys(v, WINDOW_KEYS, path, issues);
  if (!WINDOW_KEYS.some((k) => Object.hasOwn(v, k))) issues.push(`${path} needs at least one of ${WINDOW_KEYS.join(', ')}`);
  for (const k of WINDOW_KEYS) {
    if (v[k] === undefined) continue;
    if (k === 'titlePattern') checkRegex(v[k], `${path}.${k}`, issues);
    else if (!isText(v[k])) issues.push(`${path}.${k} must be a non-empty single-line string of at most ${MAX_UIA_TEXT} characters`);
  }
}

function checkUiaTarget(v: unknown, path: string, issues: string[]) {
  if (!isObj(v)) { issues.push(`${path} must be an object`); return; }
  checkKeys(v, ['window', 'path'], path, issues);
  if (v.window !== undefined) checkWindowSel(v.window, `${path}.window`, issues);
  if (!Array.isArray(v.path) || v.path.length === 0 || v.path.length > 20) { issues.push(`${path}.path must be an array of 1 to 20 conditions`); return; }
  v.path.forEach((c, i) => {
    const at = `${path}.path[${i}]`;
    if (!isObj(c)) { issues.push(`${at} must be an object`); return; }
    checkKeys(c, [...COND_TEXT_KEYS, 'index'], at, issues);
    if (!COND_TEXT_KEYS.some((k) => Object.hasOwn(c, k))) issues.push(`${at} needs at least one of ${COND_TEXT_KEYS.join(', ')}`);
    for (const k of COND_TEXT_KEYS) if (c[k] !== undefined && !isText(c[k])) issues.push(`${at}.${k} must be a non-empty single-line string of at most ${MAX_UIA_TEXT} characters`);
    if (c.index !== undefined && !isInt(c.index, 0, 10_000)) issues.push(`${at}.index must be an integer between 0 and 10000`);
  });
}

function checkDesktopLocator(v: unknown, path: string, issues: string[], allowFallbacks = true) {
  if (!isObj(v)) { issues.push(`${path} must be a locator object`); return; }
  const browserKind = BROWSER_LOCATOR_KEYS.find((k) => Object.hasOwn(v, k));
  if (browserKind) { issues.push(browserLocatorOnDesktop(path, browserKind)); return; }
  checkKeys(v, ['uia', 'fallbacks'], path, issues);
  if (!Object.hasOwn(v, 'uia')) { issues.push(`${path} must have uia`); return; }
  checkUiaTarget(v.uia, `${path}.uia`, issues);
  if (v.fallbacks === undefined) return;
  if (!allowFallbacks) { issues.push(`${path} has nested fallbacks`); return; }
  if (!Array.isArray(v.fallbacks) || v.fallbacks.length > 5) { issues.push(`${path}.fallbacks must be an array of at most 5 locators`); return; }
  v.fallbacks.forEach((f, i) => {
    if (isObj(f) && Object.hasOwn(f, 'fallbacks')) issues.push(`${path}.fallbacks[${i}] has nested fallbacks`);
    else checkDesktopLocator(f, `${path}.fallbacks[${i}]`, issues, false);
  });
}

function checkDesktopStep(s: unknown, path: string, issues: string[]) {
  if (!isObj(s)) { issues.push(`${path} must be an object`); return; }
  if (!isStr(s.intent) || s.intent.length > 200) issues.push(`${path}.intent must be a non-empty string of at most 200 characters`);
  const verbs = Object.keys(s).filter((k) => !DESKTOP_BASE_KEYS.has(k));
  const browserOnly = verbs.filter((k) => (STEP_VERBS as readonly string[]).includes(k) && !(DESKTOP_VERBS as readonly string[]).includes(k));
  for (const k of browserOnly) issues.push(browserStepOnDesktop(path, k));
  if (browserOnly.length) return;
  const known = verbs.filter((k) => (DESKTOP_VERBS as readonly string[]).includes(k));
  if (known.length !== 1 || verbs.length !== 1) {
    const unknown = verbs.filter((k) => !(DESKTOP_VERBS as readonly string[]).includes(k));
    if (known.length === 1 && unknown.length) unknown.forEach((k) => issues.push(`${path} has unknown key "${k}"`));
    else issues.push(`${path} must have exactly one action (${DESKTOP_VERBS.join(', ')})`);
    return;
  }
  const verb = known[0] as DesktopVerb;
  if (s.optional !== undefined && typeof s.optional !== 'boolean') issues.push(`${path}.optional must be a boolean`);
  if (s.checkpoint !== undefined && typeof s.checkpoint !== 'boolean') issues.push(`${path}.checkpoint must be a boolean`);
  if (s.timeoutMs !== undefined && !isInt(s.timeoutMs, 100, 120_000)) issues.push(`${path}.timeoutMs must be an integer between 100 and 120000`);
  if (s.write !== undefined) {
    if (typeof s.write !== 'boolean') issues.push(`${path}.write must be a boolean`);
    else if (s.write && !DESKTOP_WRITE_VERBS.has(verb)) issues.push(`${path}.write is only allowed on click, fill, select, check and key steps`);
  }
  if (s.when !== undefined) {
    if (!isObj(s.when)) issues.push(`${path}.when must be an object`);
    else {
      checkKeys(s.when, ['visible'], `${path}.when`, issues);
      checkDesktopLocator(s.when.visible, `${path}.when.visible`, issues);
    }
  }
  if (s.expect !== undefined) {
    if (!isObj(s.expect)) issues.push(`${path}.expect must be an object`);
    else {
      for (const k of ['url', 'heading']) if (Object.hasOwn(s.expect, k)) issues.push(`${path}.expect.${k} is a browser check, not allowed in a desktop step set`);
      checkKeys(s.expect, ['url', 'heading', 'visible'], `${path}.expect`, issues);
      if (s.expect.visible !== undefined) checkDesktopLocator(s.expect.visible, `${path}.expect.visible`, issues);
    }
  }
  const v = s[verb];
  const p = `${path}.${verb}`;
  switch (verb) {
    case 'click':
      checkDesktopLocator(v, p, issues);
      break;
    case 'fill':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['field', 'value'], p, issues);
      checkDesktopLocator(v.field, `${p}.field`, issues);
      if (typeof v.value !== 'string') issues.push(`${p}.value must be a string`);
      break;
    case 'select':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['field', 'option'], p, issues);
      checkDesktopLocator(v.field, `${p}.field`, issues);
      if (!isStr(v.option)) issues.push(`${p}.option must be a non-empty string`);
      break;
    case 'check':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['field', 'checked'], p, issues);
      checkDesktopLocator(v.field, `${p}.field`, issues);
      if (v.checked !== undefined && typeof v.checked !== 'boolean') issues.push(`${p}.checked must be a boolean`);
      break;
    case 'waitFor':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['target', 'state'], p, issues);
      checkDesktopLocator(v.target, `${p}.target`, issues);
      if (v.state !== undefined && !['visible', 'hidden'].includes(v.state as string)) issues.push(`${p}.state must be "visible" or "hidden"`);
      break;
    case 'read': {
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      // An element's text (target), or the clipboard's (clipboard: true, read through the runner's policy-gated
      // clipboard.read): exactly one of the two.
      checkKeys(v, ['target', 'clipboard', 'as'], p, issues);
      const clipboard = Object.hasOwn(v, 'clipboard');
      if (clipboard && v.clipboard !== true) issues.push(`${p}.clipboard must be true (or leave it out and give a target)`);
      else if (clipboard === Object.hasOwn(v, 'target')) issues.push(`${p} needs either a target or clipboard: true, not both`);
      else if (!clipboard) checkDesktopLocator(v.target, `${p}.target`, issues);
      if (typeof v.as !== 'string' || !READ_NAME.test(v.as)) issues.push(`${p}.as must be a name of letters, digits and underscores (at most 64)`);
      break;
    }
    case 'key':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['key', 'target'], p, issues);
      {
        const problem = stepChordProblem(v.key);
        if (problem) issues.push(`${p}.key ${problem}`);
      }
      if (v.target !== undefined) checkDesktopLocator(v.target, `${p}.target`, issues);
      break;
    case 'expectFile':
      if (!isObj(v)) { issues.push(`${p} must be an object`); break; }
      checkKeys(v, ['pattern', 'check', 'maxBytes', 'mime'], p, issues);
      checkRegex(v.pattern, `${p}.pattern`, issues);
      checkDownloadFile(v, p, issues);
      if (isInt(v.maxBytes, MAX_EXPECTED_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER)) issues.push(`${p}.maxBytes must be at most ${MAX_EXPECTED_FILE_BYTES} (the most the desktop runner sends; its policy maxFileBytes, 20 MiB by default, is the effective limit)`);
      break;
  }
}

/** A desktop step's verb (parseDesktopScript checked there is exactly one). */
export function desktopVerbOf(step: object): DesktopVerb {
  const v = DESKTOP_VERBS.find((k) => Object.hasOwn(step, k));
  if (!v) throw new Error(`step "${(step as { intent?: string }).intent ?? ''}" has no desktop action`);
  return v;
}

/** Whether a raw document declares itself a desktop step set (`surface: "desktop"`). Never throws. */
export function isDesktopDocument(raw: unknown): boolean {
  return isObj(raw) && Object.hasOwn(raw, 'surface') && raw.surface === 'desktop';
}

/**
 * Checks a desktop step document (`{ surface: "desktop", name?, version?, app: { exe, args? }, interrupts?, steps }`)
 * and returns a clone. Browser steps, browser locators and browser checks are refused, and so is every `{{$...}}`
 * template except {{$exportDir}} in a fill value. Like parseScript, hashing and signatures use the raw input.
 */
export function parseDesktopScript(input: unknown): DesktopScript {
  const issues: string[] = [];
  if (!isObj(input)) throw new ScriptShapeError(['script must be an object']);
  const doc = input;
  const surface = Object.hasOwn(doc, 'surface') ? doc.surface : undefined;
  if (surface !== 'desktop') throw new ScriptShapeError([surface === undefined || surface === 'browser' ? BROWSER_STEPS_NEED_BROWSER : SURFACE_INVALID]);
  checkKeys(doc, ['surface', 'name', 'version', 'app', 'interrupts', 'steps'], 'script', issues);
  if (Object.hasOwn(doc, 'startUrl')) issues.push('startUrl is a browser setting, not allowed in a desktop step set: set app instead');
  if (doc.name !== undefined && !isStr(doc.name)) issues.push('name must be a non-empty string');
  if (doc.version !== undefined && !isInt(doc.version, 1, Number.MAX_SAFE_INTEGER)) issues.push('version must be a positive integer');
  if (!isObj(doc.app)) issues.push('app must be an object with exe');
  else {
    checkKeys(doc.app, ['exe', 'args'], 'app', issues);
    if (!isText(doc.app.exe, 260) || doc.app.exe.includes('{{')) issues.push('app.exe must be a non-empty single-line file name or path of at most 260 characters, without templates');
    const args = doc.app.args;
    if (args !== undefined && !(Array.isArray(args) && args.length <= 50 && args.every((a) => typeof a === 'string' && a.length <= 1000 && !a.includes('{{')))) {
      issues.push('app.args must be at most 50 strings of at most 1000 characters, without templates');
    }
  }
  // Overlay handlers are a browser feature for now: accepted only empty, so nothing in them is silently ignored.
  if (doc.interrupts !== undefined && !(Array.isArray(doc.interrupts) && doc.interrupts.length === 0)) issues.push('interrupts are not supported in a desktop step set yet');
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) issues.push('steps must be a non-empty array');
  else {
    if (doc.steps.length > 200) issues.push('steps has more than 200 steps');
    doc.steps.forEach((s, i) => checkDesktopStep(s, `steps[${i}]`, issues));
    // A read's `as` names its text in the run outputs: two reads with one name would overwrite each other.
    const seen = new Set<string>();
    doc.steps.forEach((s, i) => {
      const as = isObj(s) && isObj(s.read) && typeof s.read.as === 'string' ? s.read.as : undefined;
      if (as === undefined) return;
      if (seen.has(as)) issues.push(`steps[${i}].read.as "${as}" is already used by an earlier read step`);
      seen.add(as);
    });
  }
  checkTemplates(doc, '', (path) => /^steps\[\d+\]\.fill\.value$/.test(path), issues);
  if (issues.length) throw new ScriptShapeError(issues);
  return structuredClone(doc) as unknown as DesktopScript;
}
