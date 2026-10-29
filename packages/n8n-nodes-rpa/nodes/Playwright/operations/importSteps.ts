import { NodeConnectionTypes, NodeOperationError, type IBinaryKeyData, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type {
  AdoptInput, AdoptResult, BrowserEndpoint, Draft, ErrorCode, ImportOptions, ImportReport, ImportSource, Masker, OutputSpec, PortalPolicy, Proposal,
} from 'n8n-rpa-engine';
import { browserConfig, ConfigError, CREDENTIALS, policyFor, siteLoginConfig, type SiteLogin } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configNodeError, errorJson, GUIDANCE } from '../errors.js';
import { isBreakerCode, runGuarded, type GuardedResult } from '../execute.js';
import { isQueueMode, openGuardStore, QUEUE_NEEDS_REDIS, type GuardStoreDeps } from '../guard-store.js';
import { workflowFile } from '../import/workflow.js';
import { lazyChatModel } from '../model.js';
import { configErrorItem, repairedStepsItem, slug } from '../output.js';
import {
  asBoolean, asString, browserCredentials, checkMaxItems, credentialId, errorMessage, hasDownloadStep, literalString, readCommonOptions, refuseCdpDownload, regexOption,
  SITE_LOGIN_NO_ID, type CommonOptions,
} from './common.js';
import { expectedDownload, NO_MODEL, noteRepairRan, repairAlreadyRan, siteLoginGuard, variablesOption } from './runSteps.js';

/** The largest file or text Import Steps reads. The importers apply their own, smaller limits. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
/** The most drafts one input item adopts, one after another: each can take about twice Max Seconds. */
export const MAX_ADOPTIONS = 10;
/** How long the proof may wait for a fresh authenticator code window (engine adopt.ts, freshTotpAfter). */
const TOTP_WAIT_MS = 30_000;
/**
 * Site Login secrets shorter than this are not searched for inside text, only matched whole (the engine's importers'
 * MIN_SECRET_LENGTH and validateScript's MIN_SECRET_LEN_FOR_LITERAL_CHECK): a two-letter password would otherwise mask
 * every occurrence of those letters in the report and withhold every draft's steps.
 */
const MIN_SECRET_LENGTH = 4;

export const FILE_TOO_LARGE = 'The file is larger than 20 MiB, so it was not read.';
export const TEXT_TOO_LARGE = 'Recording or Code is larger than 20 MiB, so it was not read.';
export const NAME_REQUIRED = 'Name is required: it names the imported steps.';
export const NAME_EQUALS = 'Name must not start with "=".';
export const SOURCE_UNKNOWN = 'Source must be Chrome Recorder (JSON), Playwright Code (JavaScript or TypeScript) or UiPath Project (ZIP or XAML)';
export const IMPORT_NEEDS_START = 'Import Steps needs a Start URL or a Site Login: the imported steps do not open a page first.';
/** The repair goal when Goal is empty: the agent sees the imported steps as its base. */
export const DEFAULT_GOAL = 'Do what the imported steps do, on the page as it is now.';
export const NOT_TRIED_LIMIT = `not tried: an import adopts at most ${MAX_ADOPTIONS} step lists`;
export const NOT_TRIED_CANCELLED = 'not tried: the execution was cancelled';
export const NOTHING_IMPORTED = (reason: string) => `Nothing was imported: ${reason}`;
export const NONE_ADOPTED = (n: number, first: string) => `None of the ${n} imported step lists could be adopted. ${first}`;
/** Why a draft's steps are null on Data: they carry a Site Login value (defence in depth behind the importer's own stripping). */
export const STEPS_WITHHELD = 'The steps are not shown: they contain a value of the RPA Site Login.';

const SOURCES: readonly string[] = ['chrome', 'playwright', 'uipath'];

interface ImportParams {
  source: ImportSource;
  inputFrom: 'binary' | 'text';
  binaryPropertyName: string;
  name: string;
  startUrl: string;
  aiRepair: boolean;
  goal: string;
  idPattern?: string;
  expectedFile: unknown;
  vars: Record<string, string>;
  breakerResetKey: string;
  common: CommonOptions;
}

/** The parameters of one item. Name is checked first: buildWorkflow refuses an empty one or one starting with "=". */
function readImportParams(ctx: NodeContext, i: number): ImportParams {
  const get = (name: string, fallback: unknown): unknown => ctx.getNodeParameter(name, i, fallback);
  // Literal and the same for every item, as in Run Steps.
  const breakerResetKey = literalString(ctx, 'options.breakerResetKey', 'Login Breaker Reset Key');
  const common = readCommonOptions(ctx, i);
  const name = asString(get('stepsName', '')).trim();
  if (!name) throw new ConfigError(NAME_REQUIRED);
  if (name.startsWith('=')) throw new ConfigError(NAME_EQUALS);
  const source = asString(get('source', 'chrome'));
  if (!SOURCES.includes(source)) throw new ConfigError(SOURCE_UNKNOWN);
  const idPattern = asString(get('idPattern', '')).trim();
  return {
    source: source as ImportSource,
    // A UiPath project is always a file (Input From is hidden for it).
    inputFrom: source !== 'uipath' && asString(get('inputFrom', 'binary')) === 'text' ? 'text' : 'binary',
    binaryPropertyName: asString(get('binaryPropertyName', 'data')).trim() || 'data',
    name,
    startUrl: asString(get('startUrl', '')).trim(),
    aiRepair: asBoolean(get('aiRepair', true), true),
    goal: asString(get('goal', '')).trim(),
    ...(idPattern ? { idPattern: regexOption(idPattern, 'ID Pattern') } : {}),
    expectedFile: get('expectedFile', {}),
    vars: variablesOption(ctx.getNodeParameter('options.variables', i, {})),
    breakerResetKey,
    common,
  };
}

/** Bytes a base64 text decodes to, without decoding it. */
const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/**
 * The recording, code or project: Recording or Code as text, or the input binary as bytes. A binary's size is checked
 * before it is read whenever n8n knows it (for a stored binary the larger of the recorded byte count and the binary data
 * store's metadata; otherwise the recorded count, else the length of inline base64), and the bytes are checked again
 * after reading.
 */
async function readSource(ctx: NodeContext, i: number, p: ImportParams): Promise<Buffer | string> {
  if (p.inputFrom === 'text') {
    const text = asString(ctx.getNodeParameter('sourceText', i, ''));
    if (text.length > MAX_IMPORT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) throw new ConfigError(TEXT_TOO_LARGE);
    return text;
  }
  const binary = ctx.helpers.assertBinaryData(i, p.binaryPropertyName);
  const recorded = typeof binary.bytes === 'number' ? binary.bytes : undefined;
  // A stored binary: the larger of the recorded size and the store's, so a `bytes` an upstream node set too low is not trusted.
  const size = binary.id ? Math.max(recorded ?? 0, (await ctx.helpers.getBinaryMetadata(binary.id)).fileSize)
    : recorded ?? base64Bytes(binary.data);
  if (size > MAX_IMPORT_BYTES) throw new ConfigError(FILE_TOO_LARGE);
  const data = await ctx.helpers.getBinaryDataBuffer(i, p.binaryPropertyName);
  if (data.length > MAX_IMPORT_BYTES) throw new ConfigError(FILE_TOO_LARGE);
  return data;
}

/** What became of one draft. `code` is the engine's error code when the engine refused or failed it. */
type DraftOutcome =
  | { draft: Draft; kind: 'adopted'; proposal: Proposal }
  | { draft: Draft; kind: 'notAdoptable'; code?: ErrorCode; reason: string }
  | { draft: Draft; kind: 'failed'; code?: ErrorCode; reason: string; captures?: Captures };

/** A failed draft's failure screenshot and trace (Debug Trace not Never); the node scrubs the trace again before it is attached. */
interface Captures { screenshot?: Buffer; trace?: Buffer }

type ItemOutcome =
  | { kind: 'ok'; data: INodeExecutionData; repaired: INodeExecutionData[] }
  | { kind: 'error'; item: INodeExecutionData; error: NodeOperationError };

/** A JSON copy: n8n items must not share objects with the engine result. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Every string in a JSON value through the masker (the report and the reasons: defence in depth behind the engine's own masking). */
function maskDeep<T>(value: T, mask: (s: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mask(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(plain(value)) as T;
}

/** Options → Name for an error item when the parameters could not be read (never throws). */
function safeName(ctx: NodeContext, i: number): string | null {
  let name: unknown;
  try {
    name = ctx.getNodeParameter('stepsName', i, '');
  } catch {
    name = '';
  }
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Test seam for the guard store: the Redis factory and how the n8n execution mode is read (as Run Steps). */
export type ImportStepsDeps = GuardStoreDeps;

async function importItem(ctx: NodeContext, engine: Engine, i: number, deps: ImportStepsDeps): Promise<ItemOutcome> {
  const node = ctx.getNode();
  const paired: IPairedItemData[] = [{ item: i }];
  const configError = (message: string, name: string | null, extra: IDataObject = {}): ItemOutcome => {
    const item = configErrorItem(message, name, paired);
    Object.assign(item.json.details as IDataObject, extra);
    return { kind: 'error', item, error: configNodeError(node, message, i) };
  };

  const siteLoginId = credentialId(ctx, CREDENTIALS.siteLogin);
  let p: ImportParams;
  let endpoint: BrowserEndpoint;
  let siteLogin: SiteLogin | undefined = undefined;
  let fixedPolicy: PortalPolicy | undefined = undefined;
  let data: Buffer | string;
  try {
    // An empty id would key every id-less Site Login's breaker together ("site-login:").
    if (siteLoginId === '') throw new ConfigError(SITE_LOGIN_NO_ID);
    p = readImportParams(ctx, i);
    endpoint = browserConfig(await browserCredentials(ctx, i));
    // A CDP connection cannot read downloaded files: refused before anything is read.
    refuseCdpDownload(engine, endpoint, expectedDownload(engine, p.expectedFile) !== undefined);
    if (siteLoginId !== undefined) siteLogin = siteLoginConfig(await ctx.getCredentials(CREDENTIALS.siteLogin, i));
    if (siteLogin && !node.credentials?.[CREDENTIALS.redis] && isQueueMode(deps)) throw new ConfigError(QUEUE_NEEDS_REDIS);
    // With a Site Login or a Start URL the policy is known now; otherwise each draft's first page decides it.
    if (siteLogin || p.startUrl) fixedPolicy = policyOf(p, siteLogin, p.startUrl);
    data = await readSource(ctx, i, p);
  } catch (error) {
    return configError(errorMessage(error), safeName(ctx, i));
  }

  const download = expectedDownload(engine, p.expectedFile);
  const secrets = siteLogin?.secrets;
  const masker = engine.createMasker([secrets?.username, secrets?.password, secrets?.totpSecret]);
  // The report, the reasons and the withheld-steps check follow the importers' rule: secrets of MIN_SECRET_LENGTH or
  // more are found anywhere, shorter ones only as a whole string (trimmed, any case). The full masker above still
  // scrubs failure traces, where over-masking costs nothing.
  const slValues = [secrets?.username, secrets?.password, secrets?.totpSecret].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const textMasker = engine.createMasker(slValues.filter((s) => s.length >= MIN_SECRET_LENGTH));
  const short = slValues.filter((s) => s.length < MIN_SECRET_LENGTH).map((s) => s.trim().toLowerCase());
  const isShort = (s: string) => short.length > 0 && short.includes(s.trim().toLowerCase());
  const mask = (s: string) => (isShort(s) ? '[secret]' : textMasker.mask(s));
  const containsSecret = (v: unknown): boolean => {
    if (typeof v === 'string') return isShort(v) || textMasker.containsSecret(v);
    if (Array.isArray(v)) return v.some(containsSecret);
    if (v && typeof v === 'object') return Object.values(v).some(containsSecret);
    return false;
  };
  const opts: ImportOptions = {
    name: p.name,
    ...(p.startUrl ? { startUrl: p.startUrl } : {}),
    ...(Object.keys(p.vars).length ? { vars: p.vars } : {}),
    ...(download ? { download } : {}),
    ...(p.idPattern ? { idPattern: p.idPattern } : {}),
    ...(secrets ? { secrets } : {}),
    hasSiteLogin: siteLogin !== undefined,
  };
  const imported = engine.importSource(p.source, data, opts);
  const report = maskDeep<ImportReport>(imported.report, mask);

  // A UiPath project's flow becomes an n8n workflow for Import from file, whatever happens to its drafts.
  let workflow: { binary: IBinaryKeyData; name: string } | undefined;
  if (imported.flow) {
    try {
      const file = workflowFile(imported.flow, imported.drafts, { name: p.name });
      const name = (JSON.parse(file.data.toString('utf8')) as { name: string }).name;
      workflow = { binary: { workflow: await ctx.helpers.prepareBinaryData(file.data, file.fileName, file.mimeType) }, name };
    } catch (error) {
      return configError(mask(errorMessage(error)), p.name, { report });
    }
  }
  const firstError = report.items.find((item) => item.kind === 'error');
  if (imported.drafts.length === 0 && firstError) {
    // The workflow file was built from what could be read: the error item keeps it, so the rest of the bot is not lost.
    const failed = configError(NOTHING_IMPORTED(firstError.reason), p.name, { report, ...(workflow ? { workflowName: workflow.name } : {}) });
    if (workflow && failed.kind === 'error') failed.item.binary = { ...workflow.binary };
    return failed;
  }

  const outcomes = await adoptAll(ctx, engine, i, deps, { p, endpoint, siteLogin, siteLoginId, fixedPolicy, drafts: imported.drafts, masker, textMasker });
  const failed = outcomes.filter((o): o is Extract<DraftOutcome, { kind: 'failed' }> => o.kind === 'failed');
  // Every draft failed (a draft that cannot be adopted is a result, not a failure): the error output, with the report.
  const allFailed = outcomes.length > 0 && failed.length === outcomes.length;
  // Failure captures (Debug Trace not Never): on the error item the first failure's are `screenshot` and `trace`, as on a
  // Run Steps failure item; every other failed draft's trace is `trace-<n>`, n its index in `drafts`.
  const captures: IBinaryKeyData = {};
  const traceRefs = new Map<number, string>();
  for (const [k, o] of outcomes.entries()) {
    if (o.kind !== 'failed' || !o.captures) continue;
    const first = allFailed && o === failed[0];
    const label = slug(o.draft.name);
    const traceKey = first ? 'trace' : `trace-${k}`;
    try {
      if (o.captures.trace) {
        captures[traceKey] = await ctx.helpers.prepareBinaryData(o.captures.trace, `${label}-trace.zip`, 'application/zip');
        traceRefs.set(k, traceKey);
      }
      if (first && o.captures.screenshot) captures.screenshot = await ctx.helpers.prepareBinaryData(o.captures.screenshot, `${label}-failure.png`, 'image/png');
    } catch {
      // A capture that cannot be stored is left out; the item still says what happened.
    }
  }
  const entries: IDataObject[] = outcomes.map((o, k) => {
    const withheld = containsSecret(o.draft.script);
    const reason = o.kind !== 'adopted' ? mask(o.reason) : undefined;
    const why = withheld ? (reason ? `${reason} ${STEPS_WITHHELD}` : STEPS_WITHHELD) : reason;
    return {
      name: o.draft.name,
      steps: withheld ? null : (plain(o.draft.script) as unknown as IDataObject),
      adopted: o.kind === 'adopted',
      ...(o.kind !== 'adopted' && o.code ? { code: o.code } : {}),
      ...(why !== undefined ? { reason: why } : {}),
      ...(traceRefs.has(k) ? { traceRef: traceRefs.get(k) } : {}),
    };
  });
  const fields: IDataObject = { report: report as unknown as IDataObject, drafts: entries, ...(workflow ? { workflowName: workflow.name } : {}) };
  const binary: IBinaryKeyData = { ...(workflow?.binary ?? {}), ...captures };
  const binaryField = Object.keys(binary).length ? { binary } : {};

  if (allFailed) {
    const first = failed[0];
    const what = `${first.code ? `${first.code}: ` : ''}${mask(first.reason)}`;
    const message = outcomes.length === 1 ? what : NONE_ADOPTED(outcomes.length, `${first.draft.name}: ${what}`);
    const error = new NodeOperationError(node, message, {
      itemIndex: i, description: first.code ? `${first.code}: ${GUIDANCE[first.code]}` : 'Nothing was adopted. The reasons are in details.drafts.',
    });
    error.message = message;
    Object.assign(error.context, { code: first.code ?? null, name: p.name });
    const item: INodeExecutionData = {
      json: errorJson(message, message, { code: first.code ?? null, configError: false, name: p.name, traceRef: captures.trace ? 'trace' : null, ...fields }),
      pairedItem: paired,
      ...binaryField,
    };
    return { kind: 'error', item, error };
  }

  const repaired: INodeExecutionData[] = [];
  for (const o of outcomes) {
    if (o.kind === 'adopted') repaired.push({ ...(await repairedStepsItem(ctx, engine, o.proposal)), pairedItem: paired });
  }
  return { kind: 'ok', data: { json: fields, pairedItem: paired, ...binaryField }, repaired };
}

/**
 * A failure's screenshot and trace as the node attaches them. The engine already scrubbed the trace with this masker and
 * policy and masked the credential fields in the screenshot. The node scrubs the trace a second time (a trace that is
 * not a readable zip is left out). The screenshot relies on the engine's masks: its PNG bytes are compressed, so a text
 * search cannot find a value drawn in the image. The search below (secrets of MIN_SECRET_LENGTH or more, so a short one
 * does not match random bytes) only drops bytes that carry a value as plain text, never a real PNG: a harmless last
 * check, not a scrub.
 */
function checkedCaptures(engine: Engine, r: { screenshot?: Buffer; trace?: Buffer }, o: { masker: Masker; textMasker: Masker; policy: PortalPolicy }): Captures | undefined {
  let trace: Buffer | undefined;
  if (r.trace) {
    try {
      trace = engine.scrubTrace(r.trace, o);
    } catch {
      trace = undefined;
    }
  }
  const screenshot = r.screenshot && !o.textMasker.containsSecret(r.screenshot.toString('latin1')) ? r.screenshot : undefined;
  return trace || screenshot ? { ...(trace ? { trace } : {}), ...(screenshot ? { screenshot } : {}) } : undefined;
}

/** The policy for a run: the Site Login's (Start URL may move the start page within it), or Start URL's site plus Also Allow These Sites. */
function policyOf(p: ImportParams, siteLogin: SiteLogin | undefined, url: string): PortalPolicy {
  return policyFor({ siteLogin, url: url || undefined, allowedHosts: p.common.allowedHosts, allowPrivateNetwork: p.common.allowPrivateNetwork, operation: 'runSteps' });
}

/**
 * Adopts the drafts one after another (at most MAX_ADOPTIONS), each behind the Site Login's login breaker and run lock.
 * Repair follows Run Steps' rule: one per execution, used up by model effort. Never throws for a draft: a problem with
 * one draft is its outcome, a guard store (Redis) that cannot be opened for it included, so the drafts adopted before it
 * still come out.
 */
async function adoptAll(
  ctx: NodeContext, engine: Engine, i: number, deps: ImportStepsDeps,
  c: { p: ImportParams; endpoint: BrowserEndpoint; siteLogin?: SiteLogin; siteLoginId?: string; fixedPolicy?: PortalPolicy; drafts: Draft[]; masker: Masker; textMasker: Masker },
): Promise<DraftOutcome[]> {
  const { p, endpoint, siteLogin, siteLoginId } = c;
  const node = ctx.getNode();
  const modelConnected = ctx.getParentNodes(node.name, { connectionType: NodeConnectionTypes.AiLanguageModel, depth: 1 }).some((n) => !n.disabled);
  const budgetMs = p.common.maxSeconds * 1000;
  // An adoption runs the draft and then proves it with its own budget, and may wait for a fresh TOTP window: the lock lasts that long.
  const guardFor = siteLogin && siteLoginId ? siteLoginGuard(siteLogin, siteLoginId, p.breakerResetKey, 2 * budgetMs + TOTP_WAIT_MS) : undefined;
  const signal = ctx.getExecutionCancelSignal();
  const outcomes: DraftOutcome[] = [];
  for (const [k, draft] of c.drafts.entries()) {
    if (k >= MAX_ADOPTIONS) {
      outcomes.push({ draft, kind: 'failed', reason: NOT_TRIED_LIMIT });
      continue;
    }
    if (signal?.aborted) {
      outcomes.push({ draft, kind: 'failed', reason: NOT_TRIED_CANCELLED });
      continue;
    }
    if (endpoint.mode === 'cdp' && hasDownloadStep(draft.script)) {
      outcomes.push({ draft, kind: 'failed', reason: engine.DOWNLOAD_NEEDS_BROWSER_SERVER });
      continue;
    }
    let policy: PortalPolicy;
    try {
      const start = draft.script.startUrl;
      if (!c.fixedPolicy && !start) throw new ConfigError(IMPORT_NEEDS_START);
      policy = c.fixedPolicy ?? policyOf(p, undefined, start ?? '');
    } catch (error) {
      outcomes.push({ draft, kind: 'failed', code: 'policy_violation', reason: errorMessage(error) });
      continue;
    }
    const output: OutputSpec | undefined = p.idPattern ? { idPattern: p.idPattern } : undefined;
    const repair: AdoptInput['repair'] = p.aiRepair && modelConnected
      ? {
          model: lazyChatModel(() => ctx.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, i)),
          goal: p.goal || DEFAULT_GOAL,
          name: draft.name,
          agentBudget: { maxActions: 40, maxTokens: 200_000 },
          deliverUnconfirmed: false,
          alreadyRan: repairAlreadyRan(ctx),
        }
      : undefined;
    const input: AdoptInput = {
      draft: draft.script,
      policy,
      ...(siteLogin ? { secrets: siteLogin.secrets } : {}),
      endpoint,
      ...(output ? { output } : {}),
      vars: p.vars,
      budgetMs,
      defaultStepTimeoutMs: p.common.timeoutMs,
      viewport: p.common.viewport,
      saveTrace: p.common.saveTrace,
      ...(signal ? { signal } : {}),
      ...(repair ? { repair } : {}),
    };
    let ran: GuardedResult<AdoptResult>;
    try {
      // One store per adoption: runGuarded closes it. Queue mode without Redis was refused before the import.
      const guard = guardFor ? guardFor(await openGuardStore(ctx, i, deps)) : undefined;
      ran = await runGuarded(ctx, {
        ...(guard ? { guard } : {}),
        call: () => engine.adoptDraft(input),
        loginFailure: (r) => (!r.ok && isBreakerCode(r.code) ? { code: r.code, message: r.message } : undefined),
      });
    } catch (error) {
      outcomes.push({ draft, kind: 'failed', code: 'incomplete', reason: `the adoption stopped unexpectedly: ${errorMessage(error)}` });
      continue;
    }
    if (ran.kind === 'blocked') {
      outcomes.push({ draft, kind: 'failed', code: ran.code, reason: ran.message });
      continue;
    }
    const r = ran.result;
    if (repair && r.lane === 'agent' && ((r.llmCalls ?? 0) > 0 || r.ok)) noteRepairRan(ctx);
    if (r.ok) {
      outcomes.push({ draft, kind: 'adopted', proposal: r.proposal });
    } else if (r.adoptable === false) {
      outcomes.push({ draft, kind: 'notAdoptable', code: r.code, reason: r.message });
    } else {
      // The code and the message, and with Debug Trace the failure screenshot and trace: the transcript and action log
      // (page snapshots quoted for the model) never reach an output.
      const hint = r.code === 'drift_detected' && p.aiRepair && !modelConnected ? ` (${NO_MODEL})` : '';
      const captures = p.common.saveTrace === 'never' ? undefined : checkedCaptures(engine, r, { masker: c.masker, textMasker: c.textMasker, policy });
      outcomes.push({ draft, kind: 'failed', code: r.code, reason: `${r.message}${hint}`, ...(captures ? { captures } : {}) });
    }
  }
  return outcomes;
}

/**
 * Import Steps: per input item, the recording, code or project → engine.importSource → each draft
 * adopted (engine.adoptDraft) → [Data, Repaired Steps]. Repaired Steps holds one item per adopted draft, built exactly
 * as Run Steps builds it, so Sign Steps accepts it unchanged. Data holds `{ report, drafts, workflowName? }` and, for
 * UiPath, the workflow file as binary `workflow`. A configuration error, nothing imported, or every draft failed is an
 * error item in Data (n8n's error output), as in Run Steps.
 */
export async function executeImportSteps(ctx: NodeContext, engine: Engine, deps: ImportStepsDeps = {}): Promise<INodeExecutionData[][]> {
  const items = ctx.getInputData();
  const refused = checkMaxItems(ctx, items);
  if (refused) return [refused, []];
  const data: INodeExecutionData[] = [];
  const repaired: INodeExecutionData[] = [];
  for (let i = 0; i < items.length; i++) {
    let outcome: ItemOutcome;
    try {
      outcome = await importItem(ctx, engine, i, deps);
    } catch (error) {
      // Anything unexpected (an n8n helper that throws, the guard store) is a configuration error item, never a throw
      // under continue-on-fail, where n8n would copy the input items to Data as if they had succeeded.
      const message = errorMessage(error);
      const thrown = error instanceof NodeOperationError ? error : configNodeError(ctx.getNode(), message, i);
      outcome = { kind: 'error', item: configErrorItem(message, safeName(ctx, i), [{ item: i }]), error: thrown };
    }
    if (outcome.kind === 'error') {
      if (!ctx.continueOnFail()) throw outcome.error;
      data.push(outcome.item);
      continue;
    }
    data.push(outcome.data);
    repaired.push(...outcome.repaired);
  }
  return [data, repaired];
}
