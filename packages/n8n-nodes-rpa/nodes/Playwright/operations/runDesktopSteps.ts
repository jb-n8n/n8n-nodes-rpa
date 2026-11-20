import { NodeConnectionTypes, type IDataObject, type INodeExecutionData, type IPairedItemData } from 'n8n-workflow';
import type { DesktopRepairInput, DesktopTaskResult, RunnerEndpoint } from 'n8n-rpa-engine';
import { ConfigError, CREDENTIALS, desktopRunnerConfig, signingKey } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configNodeError, stepsRunError, type FailureDetails } from '../errors.js';
import { noteRepairRan, repairAlreadyRan } from '../execute.js';
import type { GuardStoreDeps } from '../guard-store.js';
import { lazyChatModel } from '../model.js';
import { configErrorItem, dataItem, desktopRepairedStepsJson, failureItem, OUTPUT_NOT_BUILT } from '../output.js';
import { heldRepair, noteRepairFailed, REPAIR_NOT_AGAIN, repairHeld, repairStopKey, repairUnchecked } from '../repair-stop.js';
import { credentialId, errorMessage, NO_MODEL, slotNote } from './common.js';
import type { ItemOutcome } from './runSteps.js';
import { stepsIdentity, trustInput, withVariableHint, type RunStepsParams } from './runStepsParams.js';

export const DESKTOP_STEPS_NEED_RUNNER_CREDENTIAL =
  'These are desktop steps (surface "desktop"): they run on a desktop runner. Attach an RPA Desktop Runner credential.';
export const BROWSER_STEPS_NEED_BROWSER_CREDENTIAL = 'These are browser steps: they run in a browser. Attach an RPA Browser credential.';
export const DESKTOP_NO_SITE_LOGIN = 'Desktop steps do not use an RPA Site Login yet: remove it from this node.';
/** Deliver Unconfirmed Rows hands over a browser repair's rows without proof: desktop steps read no rows. */
export const DESKTOP_NO_UNCONFIRMED = 'Deliver Unconfirmed Rows applies to browser steps only: turn it off for desktop steps.';
/**
 * What a desktop repair used, on its Repaired Steps item: the Data item's names (llmCalls, llmTokens) and the sentence a
 * failed repair ends with (costLine). Shown only: neither the digest nor the signature covers them, and Sign Steps reads
 * neither, so an item with other numbers signs the same steps the same way.
 */
export function repairCost(engine: Engine, llmCalls: number, tokens: number, pictures?: { count: number; tokens: number }): IDataObject {
  return { llmCalls, llmTokens: tokens, costLine: engine.costSentence(llmCalls, tokens, pictures) };
}

export const DESKTOP_NO_ROW_CHECKS = 'Row checks (ID Pattern, Stated Total Pattern, Required Fields, Text That Means No Results) do not apply to desktop steps: clear them.';

/**
 * One Run Steps item whose steps are desktop steps (`surface: "desktop"`): the engine's desktop lane on the RPA Desktop
 * Runner, with the same trust settings as a browser run and the same Data and error items. No Site Login and no login
 * breaker: the runner's own run lock is what keeps two runs apart. AI Repair works as for browser steps: with a chat
 * model connected and a Goal, a run that drifted on signed steps is repaired once per execution, proven in a fresh start
 * of the app, and the repaired version comes out on Repaired Steps (never run until it is approved and signed); a repair
 * that failed is not tried again until a new version, a new Goal or a new AI Repair Reset Key (repair-stop.ts).
 */
export async function runDesktopStepsItem(ctx: NodeContext, engine: Engine, i: number, p: RunStepsParams, deps: GuardStoreDeps = {}): Promise<ItemOutcome> {
  const node = ctx.getNode();
  const paired: IPairedItemData[] = [{ item: i }];
  const raw = p.steps.kind === 'steps' ? p.steps.raw : undefined;
  const id = stepsIdentity(engine, p.steps, p.name);
  const configError = (message: string): ItemOutcome => ({ kind: 'error', item: configErrorItem(message, id.name, paired), error: configNodeError(node, message, i) });

  let runner: RunnerEndpoint;
  let key: string | undefined;
  try {
    if (credentialId(ctx, CREDENTIALS.desktopRunner) === undefined) throw new ConfigError(`${DESKTOP_STEPS_NEED_RUNNER_CREDENTIAL}${slotNote(ctx, CREDENTIALS.desktopRunner)}`);
    if (credentialId(ctx, CREDENTIALS.siteLogin) !== undefined) throw new ConfigError(DESKTOP_NO_SITE_LOGIN);
    if (p.aiRepair && p.deliverUnconfirmed) throw new ConfigError(DESKTOP_NO_UNCONFIRMED);
    // Desktop steps read no rows, so a configured row check would silently never run.
    if (p.output) throw new ConfigError(DESKTOP_NO_ROW_CHECKS);
    runner = desktopRunnerConfig(await ctx.getCredentials(CREDENTIALS.desktopRunner, i));
    if (credentialId(ctx, CREDENTIALS.signing) !== undefined) key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
  } catch (error) {
    return configError(errorMessage(error));
  }

  const modelConnected = ctx.getParentNodes(node.name, { connectionType: NodeConnectionTypes.AiLanguageModel, depth: 1 }).some((n) => !n.disabled);
  const repair: DesktopRepairInput | undefined = p.aiRepair && modelConnected
    ? {
        model: lazyChatModel(() => ctx.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, i)),
        goal: p.goal,
        agentBudget: { maxActions: p.maxActions, maxTokens: p.maxTokens },
        alreadyRan: repairAlreadyRan(ctx),
        // The runner's masked, labelled screenshots (Show the Model Screenshots). No film folder: that is for engine scripts only.
        pictures: p.showModelScreenshots,
      }
    : undefined;
  // A repair that failed for these steps and Goal is not tried again until a person acts (repair-stop.ts).
  const stopKey = repair ? repairStopKey(ctx.getWorkflow?.().id ?? '', id, p.goal) : undefined;
  let held: string | undefined;
  if (repair && stopKey && !repair.alreadyRan) {
    const found = await heldRepair(ctx, i, deps, stopKey, p.repairResetKey);
    if (found) held = 'unreadable' in found ? repairUnchecked(found.unreadable) : repairHeld(id.version, false);
  }

  const trust = trustInput(p, key);
  const signal = ctx.getExecutionCancelSignal();
  let r: DesktopTaskResult;
  try {
    r = await engine.runDesktopTask({
      script: raw, trust, runner, vars: p.vars, ...(p.secretVars.length ? { secretVars: p.secretVars } : {}), ...(p.secretTargets ? { secretTargets: p.secretTargets } : {}),
      budgetMs: p.common.maxSeconds * 1000, defaultStepTimeoutMs: p.common.timeoutMs, ...(signal ? { signal } : {}),
      ...(repair ? { repair: held ? { ...repair, held } : repair } : {}),
    });
  } catch (error) {
    return configError(errorMessage(error));
  }
  const agent = r.lane === 'agent';
  const llmCalls = agent && 'llmCalls' in r ? r.llmCalls ?? 0 : 0;
  // The repair is used up only by model effort: a model call, or repaired steps.
  if (repair && agent && (llmCalls > 0 || (r.ok && 'proposal' in r))) noteRepairRan(ctx);
  // A repair that called the model and proposed nothing is remembered, as for browser steps (repairFailed).
  const failedRepair = !!repair && !!stopKey && !held && agent && llmCalls > 0 && !r.ok && !r.configError && signal?.aborted !== true;
  if (failedRepair && stopKey && !r.ok) {
    await noteRepairFailed(ctx, i, deps, stopKey, {
      at: new Date().toISOString(), resetKey: p.repairResetKey.trim(), version: id.version, code: r.code, llmCalls, tokens: r.tokens ?? 0,
    });
  }
  if (!r.ok) {
    if (r.configError) return configError(r.message);
    const hint = r.code === 'drift_detected' && p.aiRepair && !modelConnected ? ` (${NO_MODEL})` : '';
    const said = `${withVariableHint(r.message)}${hint}`;
    const message = failedRepair ? `${said}${/[.!?]$/.test(said) ? '' : '.'} ${REPAIR_NOT_AGAIN}` : said;
    const item = await failureItem(ctx, { ...r, message }, id, paired);
    return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
  }
  if (r.lane === 'agent') {
    // Repaired: the new version goes to Repaired Steps for approval. The run's data comes out on Data only when the proof
    // ran every step (no write, nothing held); otherwise the bot's work waits for the approved version. What the repair
    // used is on the item either way (shown only: outside the digest, and Sign Steps never reads it).
    try {
      const repaired: INodeExecutionData = {
        json: { ...desktopRepairedStepsJson(engine, r.proposal, undefined, p.secretVars), ...repairCost(engine, r.llmCalls, r.tokens, r.pictures) }, pairedItem: paired,
      };
      if (!r.completed) return { kind: 'ok', repaired };
      const files = r.files;
      const data: INodeExecutionData = {
        ...(await dataItem(ctx, {
          ok: true, lane: 'script', name: r.name, version: r.version, hash: r.hash, rows: [], files, outputs: r.outputs, log: r.log, violations: [], blockedRequests: [],
          page: { url: '', title: '', status: null }, verified: false, confirmed: false, writes: [], submitted: false, durationMs: r.durationMs,
        }, id)),
        pairedItem: paired,
      };
      Object.assign(data.json, { lane: 'agent', llmCalls: r.llmCalls, llmTokens: r.tokens });
      return { kind: 'ok', data, repaired };
    } catch (error) {
      const item = await failureItem(ctx, { code: 'incomplete', message: OUTPUT_NOT_BUILT(errorMessage(error)) }, id, paired);
      Object.assign(item.json.details as IDataObject, { lane: r.lane, submitted: false });
      return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
    }
  }
  try {
    const data: INodeExecutionData = { ...(await dataItem(ctx, r, id)), pairedItem: paired };
    return { kind: 'ok', data };
  } catch (error) {
    const message = OUTPUT_NOT_BUILT(errorMessage(error));
    const item = await failureItem(ctx, { code: 'incomplete', message }, id, paired);
    Object.assign(item.json.details as IDataObject, { lane: r.lane, submitted: r.submitted });
    return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
  }
}
