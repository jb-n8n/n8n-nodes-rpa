// Run Steps' parameters: the Steps document, the trust and repair settings, Options → Variables with the RPA Secret
// Variables credential merged in, and Expected File. Import Steps reads Variables and Expected File the same way.
import type { DownloadTemplate, FileCheck, OutputSpec, TrustInput } from 'n8n-rpa-engine';
import { ConfigError, CREDENTIALS, secretVariablesConfig, VARIABLE_NAME } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { codeWorkflowOptions } from './codeWorkflow.js';
import {
  asBoolean, asNumber, asString, clamp, credentialId, errorMessage, field, isObject, literalBoolean, literalString, readCommonOptions, rowCheckPatterns, rowChecks,
  splitList, type CommonOptions,
} from './common.js';

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
  /** The names in `vars` that came from the RPA Secret Variables credential (withSecretVariables); [] without it. */
  secretVars: string[];
  name: string;
  expectedVersion?: number;
  allowUnsignedWrites: boolean;
  deliverUnconfirmed: boolean;
  maxActions: number;
  maxTokens: number;
  breakerResetKey: string;
  /** Options → One-Time Code Workflow: the workflow ID, '' when not set. */
  codeWorkflowId: string;
  /** Options → Code Timeout (Seconds), in ms. */
  codeTimeoutMs: number;
  common: CommonOptions;
}

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
    if (!VARIABLE_NAME.test(name)) throw new ConfigError(`Variable name "${name}" may only use letters, digits and underscores, and may not start with a digit`);
    vars[name] = asString(field(entry, 'value'));
  }
  return vars;
}

export const SECRET_VARIABLE_TWICE = (name: string) =>
  `Variable "${name}" is set both in Options → Variables and in the RPA Secret Variables credential: keep it in one of them.`;

/**
 * The run variables with the RPA Secret Variables credential's pairs merged in, as secret variables (the engine masks
 * their values from the run start, and only signed steps type them). A name in both places is a configuration
 * error that names the variable, never a value. Without the credential, `p` as it is.
 */
export async function withSecretVariables(ctx: NodeContext, i: number, p: RunStepsParams): Promise<RunStepsParams> {
  if (credentialId(ctx, CREDENTIALS.secretVariables) === undefined) return p;
  const secret = secretVariablesConfig(await ctx.getCredentials(CREDENTIALS.secretVariables, i));
  for (const name of Object.keys(secret)) if (Object.hasOwn(p.vars, name)) throw new ConfigError(SECRET_VARIABLE_TWICE(name));
  return { ...p, vars: { ...p.vars, ...secret }, secretVars: Object.keys(secret) };
}

export const MISSING_VARIABLE_HINT = 'a secret goes in an RPA Secret Variables credential, any other value in Options → Variables';
/** A run that stopped on a variable nobody supplied (the engine's `missing input "<name>"`) says where its value goes. */
export const withVariableHint = (message: string): string => (/missing input "[A-Za-z0-9_]+"/.test(message) ? `${message} (${MISSING_VARIABLE_HINT})` : message);

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
    secretVars: [],
    name: asString(opt('name')).trim(),
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    allowUnsignedWrites,
    deliverUnconfirmed,
    maxActions: clamp(Math.floor(asNumber(opt('maxActions'), 40)), 1, 200),
    maxTokens: clamp(Math.floor(asNumber(opt('maxTokens'), 200_000)), 1000, 1_000_000),
    breakerResetKey,
    ...codeWorkflowOptions(ctx, opt),
    common,
  };
}

export interface Identity { name: string | null; version: number | null; hash: string }

/** Name, version and hash of the steps as given, for error items and agent-lane Data (the engine reports them for script runs). */
export function stepsIdentity(engine: Engine, steps: StepsValue, optionName: string): Identity {
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

/** The engine's trust settings for a run of these steps; `siteLoginId` (browser steps) binds the signature to the Site Login. */
export function trustInput(p: RunStepsParams, key: string | undefined, siteLoginId?: string): TrustInput {
  return {
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
}
