import type { IDataObject, INodeExecutionData, IPairedItemData } from 'n8n-workflow';
import type { RunnerEndpoint, TaskResult, TrustInput } from 'n8n-rpa-engine';
import { ConfigError, CREDENTIALS, desktopRunnerConfig, signingKey } from '../config.js';
import type { NodeContext } from '../context.js';
import type { Engine } from '../engine.js';
import { configNodeError, stepsRunError, type FailureDetails } from '../errors.js';
import { configErrorItem, dataItem, failureItem } from '../output.js';
import { credentialId, errorMessage, isObject } from './common.js';
import type { ItemOutcome, RunStepsParams } from './runSteps.js';

export const DESKTOP_STEPS_NEED_RUNNER_CREDENTIAL =
  'These are desktop steps (surface "desktop"): they run on a desktop runner. Attach an RPA Desktop Runner credential.';
export const BROWSER_STEPS_NEED_BROWSER_CREDENTIAL = 'These are browser steps: they run in a browser. Attach an RPA Browser credential.';
export const DESKTOP_NO_SITE_LOGIN = 'Desktop steps do not use an RPA Site Login yet: remove it from this node.';
export const DESKTOP_NO_REPAIR = 'AI repair is not available for desktop steps yet: turn AI Repair off.';
export const DESKTOP_NO_ROW_CHECKS = 'Row checks (ID Pattern, Stated Total Pattern, Required Fields, Text That Means No Results) do not apply to desktop steps: clear them.';

/**
 * One Run Steps item whose steps are desktop steps (`surface: "desktop"`): the engine's desktop lane on the RPA Desktop
 * Runner, with the same trust settings as a browser run and the same Data and error items. No Site Login, no AI repair
 * and no login breaker: the runner's own run lock is what keeps two runs apart.
 */
export async function runDesktopStepsItem(ctx: NodeContext, engine: Engine, i: number, p: RunStepsParams): Promise<ItemOutcome> {
  const node = ctx.getNode();
  const paired: IPairedItemData[] = [{ item: i }];
  const raw = p.steps.kind === 'steps' ? p.steps.raw : undefined;
  const doc = isObject(raw) ? raw : {};
  let hash = '';
  try {
    hash = engine.scriptHash(raw);
  } catch {
    hash = '';
  }
  const id = {
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name : p.name || null,
    version: typeof doc.version === 'number' ? doc.version : null,
    hash,
  };
  const configError = (message: string): ItemOutcome => ({ kind: 'error', item: configErrorItem(message, id.name, paired), error: configNodeError(node, message, i) });

  let runner: RunnerEndpoint;
  let key: string | undefined;
  try {
    if (credentialId(ctx, CREDENTIALS.desktopRunner) === undefined) throw new ConfigError(DESKTOP_STEPS_NEED_RUNNER_CREDENTIAL);
    if (credentialId(ctx, CREDENTIALS.siteLogin) !== undefined) throw new ConfigError(DESKTOP_NO_SITE_LOGIN);
    if (p.aiRepair) throw new ConfigError(DESKTOP_NO_REPAIR);
    // Desktop steps read no rows, so a configured row check would silently never run.
    if (p.output) throw new ConfigError(DESKTOP_NO_ROW_CHECKS);
    runner = desktopRunnerConfig(await ctx.getCredentials(CREDENTIALS.desktopRunner, i));
    if (credentialId(ctx, CREDENTIALS.signing) !== undefined) key = signingKey(await ctx.getCredentials(CREDENTIALS.signing, i));
  } catch (error) {
    return configError(errorMessage(error));
  }

  const trust: TrustInput = {
    required: p.requireSignedSteps,
    signature: p.signature,
    approvedBy: p.approvedBy,
    ...(key ? { key } : {}),
    allowUnsignedWrites: p.allowUnsignedWrites,
    expect: { ...(p.name ? { name: p.name } : {}), ...(p.expectedVersion !== undefined ? { version: p.expectedVersion } : {}) },
  };
  const signal = ctx.getExecutionCancelSignal();
  let r: TaskResult;
  try {
    r = await engine.runDesktopTask({
      script: raw, trust, runner, vars: p.vars, budgetMs: p.common.maxSeconds * 1000, defaultStepTimeoutMs: p.common.timeoutMs, ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return configError(errorMessage(error));
  }
  if (!r.ok) {
    if (r.configError) return configError(r.message);
    const item = await failureItem(ctx, r, id, paired);
    return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
  }
  try {
    const data: INodeExecutionData = { ...(await dataItem(ctx, r, id)), pairedItem: paired };
    return { kind: 'ok', data };
  } catch (error) {
    const message = `the run finished but its output could not be built: ${errorMessage(error)}`;
    const item = await failureItem(ctx, { code: 'incomplete', message }, id, paired);
    Object.assign(item.json.details as IDataObject, { lane: r.lane, submitted: r.submitted });
    return { kind: 'error', item, error: stepsRunError(node, item.json.details as FailureDetails, i) };
  }
}
