import { NodeOperationError, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { BrowserEndpoint, ErrorCode, PortalPolicy, Step, TaskFailure, TaskInput, WaitUntil } from 'n8n-rpa-engine';
import { browserConfig, ConfigError, policyFor, URL_REQUIRED, UrlPolicyError } from '../config.js';
import type { NodeContext } from '../context.js';
import { properties } from '../description/index.js';
import type { Engine } from '../engine.js';
import { configNodeError, stepsRunError, type FailureDetails } from '../errors.js';
import { runOne, type RunOneResult } from '../execute.js';
import { configErrorItem, failureItem } from '../output.js';
import { browserCredentials, checkMaxItems, errorMessage, isObject, readCommonOptions, refuseCdpDownload, type CommonOptions } from './common.js';
import { compileGetPage, getPageOutput } from './quick/getPage.js';
import { compilePdf, pdfOutput } from './quick/pdf.js';
import { compileDownload, downloadOutput } from './quick/download.js';
import { compileFillForm, fillFormOutput } from './quick/fillForm.js';
import { compileScreenshot, screenshotOutput } from './quick/screenshot.js';
import { compileExtract, extractOutput } from './quick/extract.js';
import { choice, locatorValue, toLocator, type Compiled, type LaneSuccess, type QuickCompiler, type QuickOp, type QuickOutput, type QuickParams, type QuickRun } from './quick/shared.js';

export { locatorValue, outputProperty, toLocator } from './quick/shared.js';
export type { Compiled, LaneSuccess, LocatorParam, QuickOp, QuickParams, QuickRun } from './quick/shared.js';

// ---- Registries ----

/** Operation → compiler of its own steps (compileQuickOp adds the open and wait steps). */
export const COMPILERS: Partial<Record<QuickOp, QuickCompiler>> = {
  screenshot: compileScreenshot,
  getPage: compileGetPage,
  pdf: compilePdf,
  extract: compileExtract,
  fillForm: compileFillForm,
  download: compileDownload,
};

/** Operation → Data items of a successful run. */
export const OUTPUTS: Record<QuickOp, QuickOutput> = {
  screenshot: screenshotOutput,
  getPage: getPageOutput,
  pdf: pdfOutput,
  extract: extractOutput,
  fillForm: fillFormOutput,
  download: downloadOutput,
};

// ---- Compile ----

export const WAIT_UNTIL_INVALID = 'Wait Until must be Load, DOM Content Loaded or Network Idle';
/** A resolved URL may not carry step templates: the goto would expand {{var.x}} (quick operations have no variables). */
export const URL_TEMPLATE = 'URL must not contain {{ }} templates';
const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle'] as const;
/** Read by readQuickParams itself, never as an operation field (waitUntil and waitFor live in Options). */
const SHARED_FIELDS = new Set(['operation', 'url', 'options', 'waitUntil', 'waitFor']);

/** Top-level fields the description shows for this operation (its description/<op>.ts), excluding notices. */
export function quickFieldNames(op: QuickOp): string[] {
  const names = properties
    .filter((p) => !SHARED_FIELDS.has(p.name) && p.type !== 'notice')
    .filter((p) => {
      const ops = p.displayOptions?.show?.operation;
      return Array.isArray(ops) && ops.includes(op);
    })
    .map((p) => p.name);
  return [...new Set(names)];
}

/**
 * The operation as a step document (pure). Steps start with
 * `{ intent: 'Open the page', goto: url, waitUntil }`, then `{ intent: 'Wait for the element', waitFor: { target } }`
 * when Wait for Element is set, then the compiler's steps. `writeStep` is shifted past the added steps.
 */
export function compileQuickOp(op: QuickOp, params: QuickParams): Compiled {
  const compiler = COMPILERS[op];
  if (!compiler) throw new ConfigError(`The ${op} operation is not available in this version of the node`);
  const body = compiler(params);
  const head: Step[] = [{ intent: 'Open the page', goto: params.url, waitUntil: params.waitUntil }];
  if (params.waitFor) head.push({ intent: 'Wait for the element', waitFor: { target: toLocator(params.waitFor, 'Wait for Element') } });
  return {
    script: { steps: [...head, ...body.script.steps] },
    vars: { ...body.vars },
    ...(body.output ? { output: body.output } : {}),
    ...(body.writeStep !== undefined ? { writeStep: body.writeStep + head.length } : {}),
  };
}

/** URL (required, trimmed), Options → Wait Until / Wait for Element, the Options collection, and the operation's fields. */
export function readQuickParams(ctx: NodeContext, i: number, op: QuickOp): QuickParams {
  const rawUrl = ctx.getNodeParameter('url', i, '');
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) throw new ConfigError(URL_REQUIRED);
  if (url.includes('{{')) throw new ConfigError(URL_TEMPLATE);
  const rawOptions = ctx.getNodeParameter('options', i, {});
  const options: IDataObject = isObject(rawOptions) ? (rawOptions as IDataObject) : {};
  const waitUntil: WaitUntil = choice(options.waitUntil, WAIT_UNTIL, 'load', WAIT_UNTIL_INVALID);
  const waitFor = locatorValue(options.waitFor);
  const params: QuickParams = { url, waitUntil, options, ...(waitFor ? { waitFor } : {}) };
  // n8n's getNodeParameter throws for a missing parameter unless the fallback is defined: hidden fields read as null.
  for (const name of quickFieldNames(op)) params[name] = ctx.getNodeParameter(name, i, null);
  return params;
}

// ---- Execute ----

/**
 * One run per input item, sequential, with a fresh browser context; no Site Login, no breaker, no lock. Error
 * items go into Data like Run Steps; under continue-on-fail nothing is thrown per item (n8n would copy the inputs).
 */
export async function executeQuickOp(ctx: NodeContext, engine: Engine, op: QuickOp): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const refused = checkMaxItems(ctx, items);
  if (refused) return [refused];
  const data: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    const paired: IPairedItemData[] = [{ item: i }];
    try {
      data.push(...(await runQuickItem(ctx, engine, op, i, paired)));
    } catch (error) {
      // runQuickItem turns every expected problem into an item (or, without continue-on-fail, a NodeOperationError that
      // is rethrown as is). Anything else is reported like a Run Steps configuration error, never a silent success.
      if (!ctx.continueOnFail()) throw error instanceof NodeOperationError ? error : configNodeError(ctx.getNode(), errorMessage(error), i);
      data.push(configErrorItem(errorMessage(error), null, paired));
    }
  }
  return [data];
}

async function runQuickItem(ctx: NodeContext, engine: Engine, op: QuickOp, i: number, paired: IPairedItemData[]): Promise<INodeExecutionData[]> {
  let params: QuickParams;
  let compiled: Compiled;
  let common: CommonOptions;
  let endpoint: BrowserEndpoint;
  try {
    params = readQuickParams(ctx, i, op);
    compiled = compileQuickOp(op, params);
    common = readCommonOptions(ctx, i);
    endpoint = browserConfig(await browserCredentials(ctx, i));
    refuseCdpDownload(engine, endpoint, op === 'download');
  } catch (error) {
    return configFailed(ctx, error, i, paired);
  }
  let policy: PortalPolicy;
  try {
    policy = policyFor({
      url: params.url, allowedHosts: common.allowedHosts, allowPrivateNetwork: common.allowPrivateNetwork,
      operation: op === 'fillForm' ? 'fillForm' : 'quick',
    });
  } catch (error) {
    if (error instanceof UrlPolicyError) return await failed(ctx, { code: 'policy_violation', message: error.message }, i, paired);
    return configFailed(ctx, error, i, paired);
  }
  // Fill and Submit: writes are allowed only during the submit click, to the navigation hosts.
  // Keyed on the operation too (defence in depth): no other compiler can open a write window by returning writeStep.
  if (op === 'fillForm' && compiled.writeStep !== undefined) policy = { ...policy, writeWindow: { step: compiled.writeStep, maxPosts: 3, hosts: [...policy.navHosts] } };
  const signal = ctx.getExecutionCancelSignal();
  const input: TaskInput = {
    script: compiled.script,
    trust: { required: false },
    policy,
    endpoint,
    ...(compiled.output ? { output: compiled.output } : {}),
    vars: compiled.vars,
    budgetMs: common.maxSeconds * 1000,
    defaultStepTimeoutMs: common.timeoutMs,
    viewport: common.viewport,
    saveTrace: common.saveTrace,
    startStatus: 'report',
    ...(signal ? { signal } : {}),
  };
  let ran: RunOneResult;
  try {
    ran = await runOne(ctx, engine, { itemIndex: i, input: () => input });
  } catch (error) {
    return configFailed(ctx, error, i, paired); // the engine threw (Run Steps reports it the same way)
  }
  if (ran.kind === 'blocked') return await failed(ctx, { code: ran.code, message: ran.message }, i, paired);
  const r = ran.result;
  if (!r.ok) return r.configError ? configFailed(ctx, new ConfigError(r.message), i, paired) : await failed(ctx, r, i, paired);
  if (r.lane !== 'script') return configFailed(ctx, new Error('A quick operation returned an AI repair result'), i, paired);
  const run: QuickRun = { op, params, compiled, result: r };
  let built: INodeExecutionData[];
  try {
    built = await OUTPUTS[op](ctx, run);
  } catch (error) {
    // A builder that finds no capture (stepBinary) fails the run as incomplete, keeping its log, writes and trace.
    if (error instanceof ConfigError) return configFailed(ctx, error, i, paired);
    return await failed(ctx, incompleteRun(r, errorMessage(error)), i, paired);
  }
  if (r.trace && built.length > 0) {
    const trace = await ctx.helpers.prepareBinaryData(r.trace, 'rpa-trace.zip', 'application/zip');
    built[0] = { ...built[0], binary: { ...(built[0].binary ?? {}), trace } };
  }
  return built.map((item) => ({ ...item, pairedItem: paired }));
}

/** A successful run whose output could not be built, as an `incomplete` failure with the run's log, writes and trace. */
function incompleteRun(r: LaneSuccess, message: string): TaskFailure {
  return {
    ok: false, code: 'incomplete', message, lane: 'script', violations: r.violations, log: r.log, blockedRequests: r.blockedRequests,
    durationMs: r.durationMs, hash: r.hash,
    ...(r.version !== null ? { version: r.version } : {}),
    ...(r.trace ? { trace: r.trace } : {}),
    ...(r.submitted ? { submitted: true } : {}),
  };
}

/** A run failure: an error item under continue-on-fail, otherwise a NodeOperationError whose message starts with the code. */
async function failed(ctx: NodeContext, f: TaskFailure | { code: ErrorCode; message: string }, i: number, paired: IPairedItemData[]): Promise<INodeExecutionData[]> {
  const item = await failureItem(ctx, f, { name: null, version: null, hash: '' }, paired);
  if (ctx.continueOnFail()) return [item];
  throw stepsRunError(ctx.getNode(), item.json.details as FailureDetails, i);
}

/** A configuration problem: a configError item under continue-on-fail, otherwise a NodeOperationError. */
function configFailed(ctx: NodeContext, error: unknown, i: number, paired: IPairedItemData[]): INodeExecutionData[] {
  const message = errorMessage(error);
  if (ctx.continueOnFail()) return [configErrorItem(message, null, paired)];
  throw configNodeError(ctx.getNode(), message, i);
}
