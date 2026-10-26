import { NodeConnectionTypes, NodeOperationError, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { BrowserEndpoint, DownloadTemplate, ErrorCode, FileCheck, OutputSpec, PortalPolicy, TaskInput, TaskResult } from 'n8n-rpa-engine';
import { browserConfig, ConfigError, CREDENTIALS, policyFor, signingKey, siteLoginConfig, UrlPolicyError, type SiteLogin } from '../config.js';
import type { NodeContext } from '../context.js';
import { nodeOutputs } from '../description/io.js';
import type { Engine } from '../engine.js';
import { configNodeError, stepsRunError, type FailureDetails } from '../errors.js';
import { LOCK_GRACE_MS, runOne, SITE_LOGIN_BUSY, siteLoginLockedOut, type GuardSpec, type RunOneResult } from '../execute.js';
import { siteLoginKey } from '../guard.js';
import { openGuardStore, type GuardStore, type GuardStoreDeps } from '../guard-store.js';
import { lazyChatModel } from '../model.js';
import { configErrorItem, dataItem, failureItem, repairedStepsItem } from '../output.js';
import {
  asBoolean, asNumber, asString, checkMaxItems, clamp, credentialId, errorMessage, field, isObject, literalBoolean, literalString, rawParameter, readCommonOptions, rowCheckPatterns,
  refuseCdpDownload, rowChecks, hasDownloadStep, SITE_LOGIN_NO_ID, splitList, type CommonOptions,
} from './common.js';

export const STEPS_EMPTY_NEEDS_REPAIR = 'Steps is empty. Add steps, or turn on AI Repair to build them from the Goal.';
export const NO_MODEL = 'AI repair is on but no chat model is connected. Connect one to the Model input.';
export const EXPECTED_VERSION_WHOLE = 'Expected Version must be a whole number';
export const GOAL_NEEDS_TEXT = 'Goal is required when AI Repair is on';

export type StepsValue = { kind: 'empty' } | { kind: 'steps'; raw: unknown };

/** JSON text → value, or the parser's message (kept out of a catch block: the caller throws). */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  let result: { ok: true; value: unknown } | { ok: false; message: string };
  try {
    result = { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    result = { ok: false, message: errorMessage(error) };
  }
  return result;
}

/**
 * The Steps parameter → empty (a first run) or the raw step document. Text is parsed once (a Data Table column holds
 * JSON text). Empty is exactly the engine's isEmptySteps: undefined, null, blank, [], or an object whose `steps` is [].
 * A valid document with the wrong shape is left to the engine (policy_violation).
 */
export function parseStepsParam(value: unknown): StepsValue {
  let v = value;
  if (typeof v === 'string') {
    if (v.trim() === '') return { kind: 'empty' };
    const parsed = parseJson(v);
    if (!parsed.ok) throw new ConfigError(`Steps is not valid JSON: ${parsed.message}`);
    v = parsed.value;
    if (typeof v === 'string' && v.trim() === '') return { kind: 'empty' };
  }
  if (v === undefined || v === null) return { kind: 'empty' };
  if (Array.isArray(v) && v.length === 0) return { kind: 'empty' };
  if (isObject(v) && Array.isArray(v.steps) && v.steps.length === 0) return { kind: 'empty' };
  return { kind: 'steps', raw: v };
}

export interface RunStepsParams {
  steps: StepsValue;
  startUrl: string;
  requireSignedSteps: boolean;
  signature: string;
  approvedBy: string;
  aiRepair: boolean;
  goal: string;
  /** Expected File's raw collection value; turned into RepairInput.download with the engine's MIME table (expectedDownload). */
  expectedFile: unknown;
  output?: OutputSpec;
  vars: Record<string, string>;
  name: string;
  expectedVersion?: number;
  allowUnsignedWrites: boolean;
  deliverUnconfirmed: boolean;
  maxActions: number;
  maxTokens: number;
  breakerResetKey: string;
  common: CommonOptions;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Expected Version: absent when empty; otherwise digits only after trimming (Data Table numbers may arrive as text), or
 * a configuration error. Number('0x3'), Number('1e0') and negative numbers are refused, not coerced.
 */
function expectedVersionOption(v: unknown): number | undefined {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return undefined;
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d+$/.test(text)) throw new ConfigError(EXPECTED_VERSION_WHOLE);
  return Number(text);
}

/** Options → Variables: fixedCollection { values: [{ name, value }] }. Not n8n expressions; {{var.name}} is replaced in steps. */
export function variablesOption(v: unknown): Record<string, string> {
  const vars: Record<string, string> = {};
  const entries = field(v, 'values');
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = asString(field(entry, 'name')).trim();
    if (!name) continue;
    if (!VAR_NAME.test(name)) throw new ConfigError(`Variable name "${name}" may only use letters, digits and underscores`);
    vars[name] = asString(field(entry, 'value'));
  }
  return vars;
}

/** The configured row checks, or undefined when none is set (only the configured checks run). */
function outputOption(opt: (name: string) => unknown): OutputSpec | undefined {
  return rowChecks(rowCheckPatterns(opt), splitList(asString(opt('requiredFields'))));
}

/**
 * Expected File (First Version) → RepairInput.download: only the fields that are set, and undefined when none is.
 * Numbers below 1 are "not set" (a fraction is floored first), like an empty text.
 */
export function expectedDownload(engine: Pick<Engine, 'MIME'>, v: unknown): DownloadTemplate | undefined {
  const file = field(v, 'file');
  const opt = (name: string): unknown => field(file, name);
  const types = opt('fileType');
  const mime = (Array.isArray(types) ? types : []).flatMap((t) => (typeof t === 'string' && t in engine.MIME ? [engine.MIME[t as keyof typeof engine.MIME] as string] : []));
  const positive = (x: unknown): number | undefined => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : Number.NaN;
    return Number.isFinite(n) && Math.floor(n) >= 1 ? Math.floor(n) : undefined;
  };
  const name = asString(opt('namePattern')).trim();
  const minBytes = positive(opt('minBytes'));
  const columns = splitList(asString(opt('requiredColumns')));
  const minRows = positive(opt('minRows'));
  const check: FileCheck = {
    ...(name ? { name } : {}),
    ...(minBytes !== undefined ? { minBytes } : {}),
    ...(columns.length ? { columns } : {}),
    ...(minRows !== undefined ? { minRows } : {}),
  };
  if (!mime.length && Object.keys(check).length === 0) return undefined;
  return { ...(mime.length ? { mime } : {}), check };
}

export function readRunStepsParams(ctx: NodeContext, i: number): RunStepsParams {
  const get = (name: string, fallback: unknown): unknown => ctx.getNodeParameter(name, i, fallback);
  // Literal-only switches first: an expression in any of them stops the item before anything else is read.
  const requireSignedSteps = literalBoolean(ctx, i, 'requireSignedSteps', 'Require Signed Steps', true);
  const allowUnsignedWrites = literalBoolean(ctx, i, 'options.allowUnsignedWrites', 'Allow Unsigned Writes', false);
  const deliverUnconfirmed = literalBoolean(ctx, i, 'options.deliverUnconfirmed', 'Deliver Unconfirmed Rows', false);
  // Literal and the same for every item: a per-item key would reset the login breaker item by item.
  const breakerResetKey = literalString(ctx, 'options.breakerResetKey', 'Login Breaker Reset Key');
  const common = readCommonOptions(ctx, i);
  const options = get('options', {});
  const opt = (name: string): unknown => field(options, name);
  const aiRepair = asBoolean(get('aiRepair', false), false);
  const goal = asString(get('goal', '')).trim();
  if (aiRepair && !goal) throw new ConfigError(GOAL_NEEDS_TEXT);
  const output = outputOption(opt);
  const expectedVersion = expectedVersionOption(opt('expectedVersion'));
  return {
    steps: parseStepsParam(get('steps', '')),
    startUrl: asString(get('startUrl', '')).trim(),
    requireSignedSteps,
    signature: asString(get('signature', '')).trim(),
    approvedBy: asString(get('approvedBy', '')).trim(),
    aiRepair,
    goal,
    expectedFile: get('expectedFile', {}),
    ...(output ? { output } : {}),
    vars: variablesOption(opt('variables')),
    name: asString(opt('name')).trim(),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    allowUnsignedWrites,
    deliverUnconfirmed,
    maxActions: clamp(Math.floor(asNumber(opt('maxActions'), 40)), 1, 200),
    maxTokens: clamp(Math.floor(asNumber(opt('maxTokens'), 200_000)), 1000, 1_000_000),
    breakerResetKey,
    common,
  };
}

/** Decided once per execution from the raw parameters, so an expression-valued AI Repair keeps the Repaired Steps output. */
function aiRepairOutputs(ctx: NodeContext): boolean {
  return nodeOutputs(rawParameter(ctx, 'operation'), rawParameter(ctx, 'aiRepair')).length === 2;
}

type ItemOutcome =
  | { kind: 'ok'; data?: INodeExecutionData; repaired?: INodeExecutionData }
  | { kind: 'error'; item: INodeExecutionData; error: NodeOperationError };

/**
 * One repair per execution. The flag lives in n8n's per-execution context data ('flow'), so it
 * covers every item, a node that runs again in the same execution (Loop Over Items) and every Run Steps node of the
 * workflow, and it is gone when the execution ends.
 */
const REPAIR_RAN = 'playwrightRepairRan';
export const repairAlreadyRan = (ctx: NodeContext): boolean => ctx.getContext('flow')[REPAIR_RAN] === true;
export function noteRepairRan(ctx: NodeContext): void {
  ctx.getContext('flow')[REPAIR_RAN] = true;
}

interface Identity { name: string | null; version: number | null; hash: string }

/** Name, version and hash of the steps as given, for error items and agent-lane Data (the engine reports them for script runs). */
function stepsIdentity(engine: Engine, steps: StepsValue, optionName: string): Identity {
  if (steps.kind === 'empty') return { name: optionName || null, version: null, hash: '' };
  const doc = isObject(steps.raw) ? steps.raw : undefined;
  const name = typeof doc?.name === 'string' && doc.name.trim() ? doc.name : optionName || null;
  const version = typeof doc?.version === 'number' ? doc.version : null;
  let hash = '';
  try {
    hash = engine.scriptHash(steps.raw);
  } catch {
    hash = '';
  }
  return { name, version, hash };
}

/** Options → Name for an error item when the parameters could not be read (never throws). */
function safeOptionName(ctx: NodeContext, i: number): string | null {
  let name: unknown;
  try {
    name = ctx.getNodeParameter('options.name', i, '');
  } catch {
    name = '';
  }
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Breaker and lock for a Site Login: keyed by its credential id, golden messages naming only the login host. The lock lasts `budgetMs` (the longest the guarded run can take) plus LOCK_GRACE_MS. */
export function siteLoginGuard(siteLogin: SiteLogin, id: string, resetKey: string, budgetMs: number): (store: GuardStore) => GuardSpec {
  const loginHost = new URL(siteLogin.policy.startUrl).host;
  return (store) => ({
    key: siteLoginKey(id), resetKey, store, ttlMs: budgetMs + LOCK_GRACE_MS,
    lockedOutMessage: () => siteLoginLockedOut(loginHost), busyMessage: SITE_LOGIN_BUSY,
  });
}

/** Test seam for the guard store: the Redis factory and how the n8n execution mode is read. */
export type RunStepsDeps = GuardStoreDeps;

async function runStepsItem(ctx: NodeContext, engine: Engine, i: number, deps: RunStepsDeps): Promise<ItemOutcome> {
  const node = ctx.getNode();
  const paired: IPairedItemData[] = [{ item: i }];
  /** A configuration error item; `submitted` when the engine refused after a write had already left the browser. */
  const configError = (message: string, name: string | null, submitted = false): ItemOutcome => {
    const item = configErrorItem(message, name, paired);
    const error = configNodeError(node, message, i);
    if (submitted) {
      (item.json.details as IDataObject).submitted = true;
      Object.assign(error.context, { submitted: true });
    }
    return { kind: 'error', item, error };
  };

  const siteLoginId = credentialId(ctx, CREDENTIALS.siteLogin);
  let p: RunStepsParams;
  let endpoint: BrowserEndpoint;
  let siteLogin: SiteLogin | undefined = undefined;
  let key: string | undefined = undefined;
  try {
    // An empty id would key every id-less Site Login together ("site-login:") and bind signatures to nothing.
    if (siteLoginId === '') throw new ConfigError(SITE_LOGIN_NO_ID);
    p = readRunStepsParams(ctx, i);
    endpoint = browserConfig(await ctx.getCredentials(CREDENTIALS.browser, i));
    // A CDP connection cannot read downloaded files: stored steps with a download, or a first run asked for an Expected File.
    refuseCdpDownload(engine, endpoint, (p.steps.kind === 'steps' && hasDownloadStep(p.steps.raw)) || (p.steps.kind === 'empty' && p.aiRepair && expectedDownload(engine, p.expectedFile) !== undefined));
    if (siteLoginId !== undefined) siteLogin = siteLoginConfig(await ctx.getCredentials(CREDENTIALS.siteLogin, i));
    if (credentialId(ctx, CREDENTIALS.signing) !== undefined) key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
  } catch (error) {
    return configError(errorMessage(error), safeOptionName(ctx, i));
  }

  const id = stepsIdentity(engine, p.steps, p.name);
  /**
   * A failure item. `ran` is what the engine run did (lane, write): if attaching the screenshot or trace fails, the
   * item is rebuilt without them and still says what the run did, so `submitted` stays true after a write.
   */
  const failure = async (
    f: Extract<TaskResult, { ok: false }> | { code: ErrorCode; message: string }, ran?: { lane: string; submitted?: boolean },
  ): Promise<ItemOutcome> => {
    let item: INodeExecutionData;
    try {
      item = await failureItem(ctx, f, id, paired);
    } catch {
      item = await failureItem(ctx, { code: f.code, message: f.message }, id, paired);
      ran = ran ?? ('ok' in f ? { lane: f.lane, submitted: f.submitted } : undefined);
    }
    if (ran) Object.assign(item.json.details as IDataObject, { lane: ran.lane, submitted: ran.submitted === true });
    return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
  };

  const budgetMs = p.common.maxSeconds * 1000;
  let policy: PortalPolicy;
  let guardFor: ((store: GuardStore) => GuardSpec) | undefined;
  try {
    policy = policyFor({
      siteLogin, url: p.startUrl || undefined, allowedHosts: p.common.allowedHosts, allowPrivateNetwork: p.common.allowPrivateNetwork, operation: 'runSteps',
    });
    guardFor = siteLogin && siteLoginId ? siteLoginGuard(siteLogin, siteLoginId, p.breakerResetKey, budgetMs) : undefined;
  } catch (error) {
    if (error instanceof UrlPolicyError) return failure({ code: 'policy_violation', message: error.message });
    return configError(errorMessage(error), id.name);
  }

  const modelConnected = ctx.getParentNodes(node.name, { connectionType: NodeConnectionTypes.AiLanguageModel, depth: 1 }).some((n) => !n.disabled);
  if (p.steps.kind === 'empty' && !p.aiRepair) return configError(STEPS_EMPTY_NEEDS_REPAIR, id.name);
  if (p.steps.kind === 'empty' && !modelConnected) return configError(NO_MODEL, id.name);

  const trust: TaskInput['trust'] = {
    required: p.requireSignedSteps,
    signature: p.signature,
    approvedBy: p.approvedBy,
    ...(key ? { key } : {}),
    allowUnsignedWrites: p.allowUnsignedWrites,
    expect: {
      ...(p.name ? { name: p.name } : {}),
      ...(p.expectedVersion !== undefined ? { version: p.expectedVersion } : {}),
      ...(siteLoginId ? { siteLoginId } : {}),
    },
  };
  const download = p.aiRepair ? expectedDownload(engine, p.expectedFile) : undefined;
  const repair: TaskInput['repair'] = p.aiRepair && modelConnected
    ? {
        model: lazyChatModel(() => ctx.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, i)),
        goal: p.goal,
        ...(p.name ? { name: p.name } : {}),
        agentBudget: { maxActions: p.maxActions, maxTokens: p.maxTokens },
        deliverUnconfirmed: p.deliverUnconfirmed,
        alreadyRan: repairAlreadyRan(ctx),
        ...(download ? { download } : {}),
      }
    : undefined;
  // Repair preconditions are configuration errors before the breaker, the lock and the browser.
  if (repair) {
    const refused = engine.repairPrecondition(p.steps.kind === 'steps' ? p.steps.raw : null, p.output, { name: p.name, ...(download ? { download } : {}) });
    if (refused !== undefined) return configError(refused, id.name);
  }
  const signal = ctx.getExecutionCancelSignal();
  const input = (): TaskInput => ({
    script: p.steps.kind === 'steps' ? p.steps.raw : null,
    trust,
    policy,
    ...(siteLogin ? { secrets: siteLogin.secrets } : {}),
    endpoint,
    ...(p.output ? { output: p.output } : {}),
    vars: p.vars,
    budgetMs,
    defaultStepTimeoutMs: p.common.timeoutMs,
    viewport: p.common.viewport,
    saveTrace: p.common.saveTrace,
    ...(signal ? { signal } : {}),
    ...(repair ? { repair } : {}),
  });

  let ran: RunOneResult;
  try {
    // One store per item: runOne closes it. Opened last, after every other configuration check, so none leaks a connection.
    const guard = guardFor ? guardFor(await openGuardStore(ctx, i, deps)) : undefined;
    ran = await runOne(ctx, engine, { itemIndex: i, ...(guard ? { guard } : {}), input });
  } catch (error) {
    return configError(errorMessage(error), id.name);
  }
  if (ran.kind === 'blocked') return failure({ code: ran.code, message: ran.message });
  const r = ran.result;
  // The repair is used up only by model effort: a model call, or repaired steps. Refusals before any model call
  // (field extraction, no browser, start page down, cancelled early, configuration errors) leave it for a later item.
  if (repair && r.lane === 'agent' && ((r.llmCalls ?? 0) > 0 || (r.ok && r.proposal !== undefined))) noteRepairRan(ctx);
  if (!r.ok) {
    if (r.configError) return configError(r.message, id.name, r.submitted === true);
    const hint = r.code === 'drift_detected' && p.aiRepair && !modelConnected ? ` (${NO_MODEL})` : '';
    return failure({ ...r, message: `${r.message}${hint}` });
  }
  try {
    const repaired = r.lane === 'agent' && r.proposal ? { ...(await repairedStepsItem(ctx, engine, r.proposal)), pairedItem: paired } : undefined;
    // A first run's only output is the Repaired steps item: nothing reads the site's data until
    // version 1 is approved, so the agent's rows never reach Data.
    if (p.steps.kind === 'empty') return { kind: 'ok', ...(repaired ? { repaired } : {}) };
    const data: INodeExecutionData = { ...(await dataItem(ctx, r, { name: id.name, version: id.version, hash: id.hash || null })), pairedItem: paired };
    return { kind: 'ok', data, ...(repaired ? { repaired } : {}) };
  } catch (error) {
    // The run finished but its output could not be built (for example the binary store failed). Report a runtime
    // failure that keeps what the run did: `submitted` must stay true after a write, so nobody re-runs it blindly.
    return failure({ code: 'incomplete', message: `the run finished but its output could not be built: ${errorMessage(error)}` }, { lane: r.lane, submitted: r.submitted });
  }
}

/**
 * Run Steps: one run per input item, in order. Returns [Data] or [Data, Repaired Steps]. Error items
 * (`{ error, message, details }`) go into Data; n8n moves them to the error output. Under continue-on-fail nothing is
 * thrown per item: n8n would copy the input items to output 0.
 */
export async function executeRunSteps(ctx: NodeContext, engine: Engine, deps: RunStepsDeps = {}): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const withRepaired = aiRepairOutputs(ctx);
  const shape = (data: INodeExecutionData[], repaired: INodeExecutionData[]) => (withRepaired ? [data, repaired] : [data]);
  const refused = checkMaxItems(ctx, items);
  if (refused) return shape(refused, []);
  const data: INodeExecutionData[] = [];
  const repaired: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    let outcome: ItemOutcome;
    try {
      outcome = await runStepsItem(ctx, engine, i, deps);
    } catch (error) {
      // runStepsItem turns every expected problem into an outcome. Anything else (an output builder or n8n helper that
      // throws) becomes a configuration error item, as in executeQuickOp: never a throw under continue-on-fail, where n8n
      // would copy the input items to Data as if they had succeeded.
      const message = errorMessage(error);
      const thrown = error instanceof NodeOperationError ? error : configNodeError(ctx.getNode(), message, i);
      outcome = { kind: 'error', item: configErrorItem(message, safeOptionName(ctx, i), [{ item: i }]), error: thrown };
    }
    if (outcome.kind === 'error') {
      if (!ctx.continueOnFail()) throw outcome.error;
      data.push(outcome.item);
      continue;
    }
    if (outcome.data) data.push(outcome.data);
    if (outcome.repaired && withRepaired) repaired.push(outcome.repaired);
  }
  return shape(data, repaired);
}
