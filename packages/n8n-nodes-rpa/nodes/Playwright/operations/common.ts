import { NodeOperationError, type INodeExecutionData } from 'n8n-workflow';
import type { OutputSpec, SaveTrace } from 'n8n-rpa-engine';
import { ConfigError } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configErrorItem } from '../output.js';

export const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v));
export const asBoolean = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback);
export function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}
export const splitList = (text: string): string[] => text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const field = (obj: unknown, key: string): unknown => (isObject(obj) ? obj[key] : undefined);
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** An attached Site Login with an empty id: a configuration error in Run Steps, a refusal in Sign Steps. */
export const SITE_LOGIN_NO_ID = 'The RPA Site Login credential has no id. Save the credential, then select it again on this node.';

/** The attached credential's id ('' when n8n has none), or undefined when the credential is not attached to the node. */
export function credentialId(ctx: NodeContext, type: string): string | undefined {
  const c = ctx.getNode().credentials?.[type];
  return c ? (c.id ?? '') : undefined;
}

/** The node's raw (unresolved) parameter at a dotted path. Expressions are strings starting with '='. */
export function rawParameter(ctx: NodeContext, path: string): unknown {
  let v: unknown = ctx.getNode().parameters;
  for (const part of path.split('.')) v = field(v, part);
  return v;
}

const expressionRefused = (label: string): ConfigError => new ConfigError(`${label} must be set directly, not with an expression.`);
/** An expression as a raw text parameter holds it: "=…", or "{{" (n8n strips the "=" of a noDataExpression parameter). */
const isExpressionText = (raw: unknown): boolean => typeof raw === 'string' && (raw.startsWith('=') || raw.includes('{{'));

/**
 * The raw (unresolved) parameter at a dotted path, for a security setting that must be a literal. Throws
 * "<label> must be set directly, not with an expression." when a string sits on any ancestor (for example the whole
 * Options collection set by one expression) or when `isExpression` holds for the value itself.
 */
export function literalRaw(ctx: NodeContext, path: string, label: string, isExpression: (raw: unknown) => boolean = isExpressionText): unknown {
  const parts = path.split('.');
  for (let depth = 1; depth < parts.length; depth++) {
    if (typeof rawParameter(ctx, parts.slice(0, depth).join('.')) === 'string') throw expressionRefused(label);
  }
  const raw = rawParameter(ctx, path);
  if (isExpression(raw)) throw expressionRefused(label);
  return raw;
}

/**
 * A security switch that must be a literal. The raw parameter is checked, not the resolved value, so an
 * expression is refused even when it resolves to the default. A literal switch is a boolean, so ANY string is refused:
 * n8n 2.41 strips the leading "=" of an expression in a noDataExpression parameter, so "={{ true }}" arrives raw as
 * "{{ true }}". A string on any ancestor (for example the whole Options collection, `options: '={{…}}'`) is
 * refused too, as defence in depth. In n8n 2.41 that case never reaches the node: the Workflow constructor normalizes a
 * string-valued collection to its defaults, so every switch under it reads as off and the expression has no effect
 * (pinned by the "real n8n" test in run-steps.test.ts).
 */
export function literalBoolean(ctx: NodeContext, i: number, path: string, label: string, fallback: boolean): boolean {
  literalRaw(ctx, path, label, (raw) => typeof raw === 'string');
  return asBoolean(ctx.getNodeParameter(path, i, fallback), fallback);
}

/**
 * A security text setting that must be a literal (the Login Breaker Reset Key). The raw parameter is checked: a value
 * starting with "=" (an expression) or holding "{{" (the form n8n saves for a noDataExpression parameter) is
 * refused, as is a string on any ancestor (the whole Options collection set by one expression). The value is read
 * from item 0: being literal, it is the same for every item of the execution.
 */
export function literalString(ctx: NodeContext, path: string, label: string): string {
  const raw = literalRaw(ctx, path, label);
  if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') throw expressionRefused(label);
  return asString(raw);
}

export interface CommonOptions {
  timeoutMs: number;
  maxSeconds: number;
  viewport: { width: number; height: number };
  allowedHosts: string[];
  allowPrivateNetwork: boolean;
  saveTrace: SaveTrace;
}

/** Options → Viewport, clamped to the bounds the UI allows (description/options.ts), as Timeout and Max Seconds are. */
const VIEWPORT_BOUNDS = { width: [320, 3840], height: [240, 2160] } as const;
const dimension = (size: unknown, key: 'width' | 'height', fallback: number): number =>
  clamp(Math.floor(asNumber(field(size, key), fallback)), VIEWPORT_BOUNDS[key][0], VIEWPORT_BOUNDS[key][1]);

/** The Options every browser operation shares. Allowed Hosts are normalised later by policyFor. */
export function readCommonOptions(ctx: NodeContext, i: number): CommonOptions {
  const options = ctx.getNodeParameter('options', i, {});
  const opt = (name: string): unknown => field(options, name);
  const size = field(opt('viewport'), 'size');
  const trace = asString(opt('saveTrace'), 'onFailure');
  return {
    timeoutMs: Math.round(clamp(asNumber(opt('timeout'), 30), 1, 300) * 1000),
    maxSeconds: clamp(asNumber(opt('maxSeconds'), 180), 10, 300),
    viewport: { width: dimension(size, 'width', 1280), height: dimension(size, 'height', 800) },
    allowedHosts: asString(opt('allowedHosts')).split(/[\s,]+/).filter(Boolean),
    allowPrivateNetwork: literalBoolean(ctx, i, 'options.allowPrivateNetwork', 'Allow Private Network', false),
    saveTrace: trace === 'always' || trace === 'never' ? trace : 'onFailure',
  };
}

const maxItemsMessage = (n: number, max: number): string => `This node received ${n} items, more than Options → Max Items (${max}). Nothing ran.`;

function maxItemsOption(ctx: NodeContext): number {
  let options: unknown;
  try {
    options = ctx.getNodeParameter('options', 0, {});
  } catch {
    options = {};
  }
  return Math.max(1, Math.floor(asNumber(field(options, 'maxItems'), 100)));
}

/**
 * Options → Max Items: more input items fail the execution before any run. Under continue-on-fail it returns
 * one configuration error item per input item (never throws: n8n would copy the inputs to the output). Returns
 * undefined when the item count is fine.
 */
export function checkMaxItems(ctx: NodeContext, items: INodeExecutionData[]): INodeExecutionData[] | undefined {
  const max = maxItemsOption(ctx);
  if (items.length <= max) return undefined;
  const message = maxItemsMessage(items.length, max);
  if (!ctx.continueOnFail()) {
    const error = new NodeOperationError(ctx.getNode(), message, { description: 'Split the input, for example with Loop Over Items, or raise Options → Max Items.' });
    error.message = message;
    throw error;
  }
  return items.map((_, item) => configErrorItem(message, null, [{ item }]));
}

const REGEX_MAX = 500;

/** The parser's message for an invalid pattern, or undefined (kept out of a catch block: the caller throws). */
function regexProblem(pattern: string, flags: string): string | undefined {
  let problem: string | undefined;
  try {
    new RegExp(pattern, flags);
    problem = undefined;
  } catch (error) {
    problem = errorMessage(error);
  }
  return problem;
}

/** A regex option, checked (invalid → configuration error with the parser message; at most 500 characters). */
export function regexOption(value: string, label: string, flags = ''): string {
  if (value.length > REGEX_MAX) throw new ConfigError(`${label} is longer than ${REGEX_MAX} characters.`);
  const problem = regexProblem(value, flags);
  if (problem !== undefined) throw new ConfigError(`${label} is not a valid regular expression: ${problem}. Example: INV-\\d{4}.`);
  return value;
}

export const EMPTY_PATTERN_MATCHES_EMPTY = 'Text That Means No Results (Regex) must not match empty text: use the page\'s own "no results" wording';
export type RowCheckPatterns = Pick<OutputSpec, 'idPattern' | 'totalPattern' | 'emptyPattern'>;

/** Options → ID Pattern, Stated Total Pattern and Text That Means No Results: trimmed and checked, absent when empty. */
export function rowCheckPatterns(opt: (name: string) => unknown): RowCheckPatterns {
  const read = (name: string, label: string, flags?: string) => {
    const value = asString(opt(name)).trim();
    return value ? regexOption(value, label, flags) : undefined;
  };
  const idPattern = read('idPattern', 'ID Pattern');
  const totalPattern = read('totalPattern', 'Stated Total Pattern');
  const emptyPattern = read('emptyPattern', 'Text That Means No Results', 'i');
  // regexOption compiled it already; a pattern that matches empty text would turn every empty page into a success.
  if (emptyPattern !== undefined && new RegExp(emptyPattern, 'i').test('')) throw new ConfigError(EMPTY_PATTERN_MATCHES_EMPTY);
  return { idPattern, totalPattern, emptyPattern };
}

/** The configured row checks, or undefined when none is set (only the configured checks run). */
export function rowChecks({ idPattern, totalPattern, emptyPattern }: RowCheckPatterns, requiredFields: string[]): OutputSpec | undefined {
  const output: OutputSpec = {
    ...(idPattern ? { idPattern } : {}),
    ...(requiredFields.length ? { requiredFields } : {}),
    ...(totalPattern ? { totalPattern } : {}),
    ...(emptyPattern ? { emptyPattern } : {}),
  };
  return Object.keys(output).length ? output : undefined;
}

/** True when a step list (parsed or raw, paginate bodies included) has a `download` step. Reads defensively: the steps are not validated yet. */
export function hasDownloadStep(steps: unknown): boolean {
  const list = Array.isArray(steps) ? steps : isObject(steps) && Array.isArray((steps as { steps?: unknown }).steps) ? (steps as { steps: unknown[] }).steps : [];
  return list.some((step) => {
    if (!isObject(step)) return false;
    if ('download' in step) return true;
    const paginate = (step as { paginate?: unknown }).paginate;
    return isObject(paginate) && hasDownloadStep((paginate as { each?: unknown }).each);
  });
}

/** Downloads need the Browser Server or Local Browser: a CDP connection cannot read the downloaded file. Throws a ConfigError before the browser opens. */
export function refuseCdpDownload(engine: Pick<Engine, 'DOWNLOAD_NEEDS_BROWSER_SERVER'>, endpoint: { mode: string }, wantsDownload: boolean): void {
  if (wantsDownload && endpoint.mode === 'cdp') throw new ConfigError(engine.DOWNLOAD_NEEDS_BROWSER_SERVER);
}
