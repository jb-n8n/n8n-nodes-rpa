import { NodeConnectionTypes, NodeOperationError, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { BrowserEndpoint, ErrorCode, PortalPolicy, TaskInput, TaskResult } from 'n8n-rpa-engine';
import { browserConfig, ConfigError, CREDENTIALS, policyFor, signingKey, siteLoginConfig, UrlPolicyError, type SiteLogin } from '../config.js';
import type { NodeContext } from '../context.js';
import { nodeOutputs } from '../description/io.js';
import type { Engine } from '../engine.js';
import { configNodeError, stepsRunError, type FailureDetails } from '../errors.js';
import { noteRepairRan, repairAlreadyRan, runOne, siteLoginGuard, type GuardSpec, type RunOneResult } from '../execute.js';
import { openGuardStore, type GuardStore, type GuardStoreDeps } from '../guard-store.js';
import { lazyChatModel } from '../model.js';
import { configErrorItem, dataItem, failureItem, OUTPUT_NOT_BUILT, repairedStepsItem } from '../output.js';
import { codeSettingsFor } from './codeWorkflow.js';
import { browserCredentials, checkMaxItems, credentialId, errorMessage, hasDownloadStep, NO_MODEL, rawParameter, refuseCdpDownload, safeParam, SITE_LOGIN_NO_ID } from './common.js';
import { BROWSER_STEPS_NEED_BROWSER_CREDENTIAL, runDesktopStepsItem } from './runDesktopSteps.js';
import { expectedDownload, readRunStepsParams, stepsIdentity, trustInput, withSecretVariables, withVariableHint, type RunStepsParams } from './runStepsParams.js';

export const STEPS_EMPTY_NEEDS_REPAIR = 'Steps is empty. Add steps, or turn on AI Repair to build them from the Goal.';

/** Decided once per execution from the raw parameters, so an expression-valued AI Repair keeps the Repaired Steps output. */
function aiRepairOutputs(ctx: NodeContext): boolean {
  return nodeOutputs(rawParameter(ctx, 'operation'), rawParameter(ctx, 'aiRepair')).length === 2;
}

export type ItemOutcome =
  | { kind: 'ok'; data?: INodeExecutionData; repaired?: INodeExecutionData }
  | { kind: 'error'; item: INodeExecutionData; error: NodeOperationError };

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
    p = await withSecretVariables(ctx, i, readRunStepsParams(ctx, i));
  } catch (error) {
    return configError(errorMessage(error), safeParam(ctx, i, 'options.name'));
  }
  // Routed by the steps' own (signed) surface: desktop steps run on the desktop runner, never in a browser.
  if (p.steps.kind === 'steps' && engine.isDesktopDocument(p.steps.raw)) return await runDesktopStepsItem(ctx, engine, i, p);
  try {
    endpoint = browserConfig(await browserCredentials(ctx, i, BROWSER_STEPS_NEED_BROWSER_CREDENTIAL));
    // A CDP connection cannot read downloaded files: stored steps with a download, or a first run asked for an Expected File.
    refuseCdpDownload(engine, endpoint, (p.steps.kind === 'steps' && hasDownloadStep(p.steps.raw)) || (p.steps.kind === 'empty' && p.aiRepair && expectedDownload(engine, p.expectedFile) !== undefined));
    if (siteLoginId !== undefined) siteLogin = siteLoginConfig(await ctx.getCredentials(CREDENTIALS.siteLogin, i));
    if (credentialId(ctx, CREDENTIALS.signing) !== undefined) key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
  } catch (error) {
    return configError(errorMessage(error), safeParam(ctx, i, 'options.name'));
  }

  const id = stepsIdentity(engine, p.steps, p.name);
  /**
   * The user name the Site Login signs in with, on the Data item and the error item's details, so that a run of one of
   * many accounts says which account it was. Never the password, a one-time code or the TOTP Secret.
   */
  const account = siteLogin?.secrets.username || undefined;
  /**
   * A failure item. `ran` is what the engine run did (lane, write, a new password): if attaching the screenshot or trace
   * fails, the item is rebuilt without them and still says what the run did, so `submitted` stays true after a write and
   * `passwordChanged` after a password change.
   */
  const failure = async (
    f: Extract<TaskResult, { ok: false }> | { code: ErrorCode; message: string; passwordChanged?: true }, ran?: { lane: string; submitted?: boolean; passwordChanged?: true },
  ): Promise<ItemOutcome> => {
    let item: INodeExecutionData;
    try {
      item = await failureItem(ctx, f, id, paired);
    } catch {
      item = await failureItem(ctx, { code: f.code, message: f.message, ...(f.passwordChanged ? { passwordChanged: true as const } : {}) }, id, paired);
      ran = ran ?? ('ok' in f ? { lane: f.lane, submitted: f.submitted, passwordChanged: f.passwordChanged } : undefined);
    }
    if (ran) {
      Object.assign(item.json.details as IDataObject, { lane: ran.lane, submitted: ran.submitted === true }, ran.passwordChanged ? { passwordChanged: true } : {});
    }
    if (account) (item.json.details as IDataObject).account = account;
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

  const trust = trustInput(p, key, siteLoginId);
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
    ...codeSettingsFor(ctx, p),
    endpoint,
    ...(p.output ? { output: p.output } : {}),
    vars: p.vars,
    ...(p.secretVars.length ? { secretVars: p.secretVars } : {}),
    ...(p.secretTargets ? { secretTargets: p.secretTargets } : {}),
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
  if (ran.kind === 'blocked') return failure({ code: ran.code, message: ran.message, ...(ran.passwordChanged ? { passwordChanged: true as const } : {}) });
  const r = ran.result;
  // The repair is used up only by model effort: a model call, or repaired steps. Refusals before any model call
  // (field extraction, no browser, start page down, cancelled early, configuration errors) leave it for a later item.
  if (repair && r.lane === 'agent' && ((r.llmCalls ?? 0) > 0 || (r.ok && r.proposal !== undefined))) noteRepairRan(ctx);
  if (!r.ok) {
    if (r.configError) return configError(r.message, id.name, r.submitted === true);
    const hint = r.code === 'drift_detected' && p.aiRepair && !modelConnected ? ` (${NO_MODEL})` : '';
    return failure({ ...r, message: `${withVariableHint(r.message)}${hint}` });
  }
  try {
    const repaired = r.lane === 'agent' && r.proposal ? { ...(await repairedStepsItem(ctx, engine, r.proposal)), pairedItem: paired } : undefined;
    // A first run's only output is the Repaired steps item: nothing reads the site's data until
    // version 1 is approved, so the agent's rows never reach Data.
    if (p.steps.kind === 'empty') return { kind: 'ok', ...(repaired ? { repaired } : {}) };
    const data: INodeExecutionData = { ...(await dataItem(ctx, r, { name: id.name, version: id.version, hash: id.hash || null })), pairedItem: paired };
    if (account) data.json.account = account;
    return { kind: 'ok', data, ...(repaired ? { repaired } : {}) };
  } catch (error) {
    // The run finished but its output could not be built (for example the binary store failed). Report a runtime
    // failure that keeps what the run did: `submitted` must stay true after a write, so nobody re-runs it blindly, and
    // `passwordChanged` after a new password, so the workflow still stores it.
    return failure(
      { code: 'incomplete', message: OUTPUT_NOT_BUILT(errorMessage(error)) },
      { lane: r.lane, submitted: r.submitted, ...(r.passwordChanged ? { passwordChanged: true as const } : {}) },
    );
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
      outcome = { kind: 'error', item: configErrorItem(message, safeParam(ctx, i, 'options.name'), [{ item: i }]), error: thrown };
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
