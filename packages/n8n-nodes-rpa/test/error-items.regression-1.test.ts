// Regression: n8n's normalizeNodeErrors wipes structured fields from error items
import { afterEach, describe, expect, it } from 'vitest';
import type { GenericValue, IDataObject, INodeExecutionData, IPairedItemData } from 'n8n-workflow';
import type { TaskFailure } from 'n8n-rpa-engine';
import { resetGuardsForTests } from '../nodes/Playwright/guard.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { fakeEngine } from './fake-engine.js';
import { credentialsV2, FEED_NAME, nodeContext, runStepsParams, signStepsParams } from './feed-fixtures.js';
import { APPROVER, baselineScript } from './fixtures.js';

afterEach(() => resetGuardsForTests());

/*
 * A faithful emulation of what n8n core does to a node's output, from n8n 2.41
 * packages/core/src/execution-engine/workflow-execute.ts:
 *  1. runNode calls handleNodeErrorOutput when the node has onError 'continueErrorOutput'. For every output except the
 *     last (the error output), an item goes to the error output if `item.error` is set, or if `item.json.error` is truthy
 *     and every json key is 'error', 'message' or 'details'. A routed item with a resolvable paired item becomes
 *     `{ ...item, json: { ...pairedSourceItem.json, ...item.json } }`.
 *  2. Then normalizeNodeErrors runs for every node: any item with `item.error !== undefined` gets
 *     `json = { error: item.error.message }`.
 * `$getPairedItem` is emulated as "the input item at pairedItem.item" (one previous node, input 0).
 */
function handleNodeErrorOutput(nodeSuccessData: INodeExecutionData[][], inputItems: INodeExecutionData[], mainOutputs: number): void {
  const errorItems: INodeExecutionData[] = [];
  for (let outputIndex = 0; outputIndex < mainOutputs - 1; outputIndex++) {
    const successItems: INodeExecutionData[] = [];
    const items = nodeSuccessData[outputIndex]?.length ? nodeSuccessData[outputIndex] : [];
    while (items.length) {
      const item = items.shift();
      if (item === undefined) continue;
      let errorData: GenericValue | undefined;
      if (item.error) {
        errorData = item.error as unknown as GenericValue;
      } else if (item.json.error && Object.keys(item.json).every((key) => ['error', 'message', 'details'].includes(key))) {
        errorData = item.json.error;
      }
      if (errorData) {
        const pairedItemData: IPairedItemData | undefined = item.pairedItem && typeof item.pairedItem === 'object'
          ? Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem
          : undefined;
        const source = pairedItemData === undefined ? undefined : inputItems[pairedItemData.item];
        if (source === undefined) errorItems.push(item);
        else errorItems.push({ ...item, json: { ...source.json, ...item.json } });
      } else {
        successItems.push(item);
      }
    }
    nodeSuccessData[outputIndex] = successItems;
  }
  nodeSuccessData[mainOutputs - 1] = errorItems;
}

function normalizeNodeErrors(nodeSuccessData: INodeExecutionData[][]): void {
  for (const execution of nodeSuccessData) {
    for (const lineResult of execution) {
      if (lineResult.json !== undefined && lineResult.json.$error !== undefined && lineResult.json.$json !== undefined) {
        lineResult.error = lineResult.json.$error as NonNullable<INodeExecutionData['error']>;
        lineResult.json = { error: lineResult.error.message };
      } else if (lineResult.error !== undefined) {
        lineResult.json = { error: lineResult.error.message };
      }
    }
  }
}

/** The node's outputs as the next node sees them, with n8n's error output appended after the node's own outputs. */
function throughN8n(output: INodeExecutionData[][], inputItems: INodeExecutionData[], onError: 'continueErrorOutput' | 'continueRegularOutput' = 'continueErrorOutput') {
  const data = output.map((items) => [...items]);
  if (onError === 'continueErrorOutput') handleNodeErrorOutput(data, inputItems, output.length + 1);
  normalizeNodeErrors(data);
  return data;
}

const SITE = { url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' };
const V1 = { ...baselineScript(SITE.url, 1), name: FEED_NAME };
const HASH = 'a1'.repeat(32);
/** The active row from Get active steps, as Run steps' input item (n8n merges it into routed error items). */
const ROW: IDataObject = { name: FEED_NAME, version: 1, steps: JSON.stringify(V1), hash: HASH, signature: 'f'.repeat(64), approvedBy: APPROVER, status: 'active' };
const INPUT: INodeExecutionData[] = [{ json: ROW }];
/** A connected chat model, so a drift message carries no "no chat model" text. */
const STUB_MODEL = { bindTools: () => ({ invoke: async () => ({ content: 'done', tool_calls: [] }) }) };
const DRIFT_MESSAGE = 'Open Recalls & Stop-Sales: Visible Text "Recalls" matches 3 elements. Use a more specific locator; it must match exactly one.';
const DRIFT = {
  ok: false, code: 'drift_detected', message: DRIFT_MESSAGE, violations: [], log: [], durationMs: 900, lane: 'script', version: 1, hash: HASH,
  failure: { index: 4, intent: 'Open Recalls & Stop-Sales', message: 'Visible Text "Recalls" matches 3 elements. Use a more specific locator; it must match exactly one.' },
  trace: Buffer.from('zip'),
} as unknown as TaskFailure;

function runSteps(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}, onEngine: () => TaskFailure = () => DRIFT) {
  const params = runStepsParams(ROW, over, options);
  return executeRunSteps(nodeContext({ params, rawParameters: params, items: INPUT, credentials: credentialsV2(SITE), continueOnFail: true, model: STUB_MODEL }), fakeEngine(onEngine));
}

describe('v2 error items keep their structured fields through n8n', () => {
  it('a drift failure with AI Repair on reaches the error output at index 2 with details.code, name, version, hash, lane and log, and the trace', async () => {
    const out = await runSteps({ aiRepair: true });
    expect(out).toHaveLength(2);
    const [data, repaired, errors] = throughN8n(out, INPUT);
    expect(data).toEqual([]);
    expect(repaired).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].json.error).toBe(`drift_detected: ${DRIFT_MESSAGE}`);
    expect(errors[0].json.message).toBe(DRIFT_MESSAGE);
    const details = errors[0].json.details as IDataObject;
    expect(details).toMatchObject({ code: 'drift_detected', name: FEED_NAME, version: 1, hash: HASH, lane: 'script' });
    expect(Array.isArray(details.log)).toBe(true);
    expect(details.portal).toBeUndefined();
    expect(errors[0].binary?.trace?.mimeType).toBe('application/zip');
  });
  it('with AI Repair off the same failure reaches the error output at index 1', async () => {
    const out = await runSteps();
    expect(out).toHaveLength(1);
    const [data, errors] = throughN8n(out, INPUT);
    expect(data).toEqual([]);
    expect(errors[0].json.details).toMatchObject({ code: 'drift_detected', name: FEED_NAME });
  });
  it('a configuration error reaches the error output with details.configError', async () => {
    const out = await runSteps({}, { idPattern: '(' }, () => {
      throw new Error('a configuration error never reaches the engine');
    });
    const [data, errors] = throughN8n(out, INPUT);
    expect(data).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0].json.error)).toMatch(/^ID Pattern.* is not a valid regular expression: /);
    expect(errors[0].json.details).toMatchObject({ configError: true, name: FEED_NAME });
  });
  it("Sign Steps' refusal reaches the error output (index 1) with code null, reasons, name and version", async () => {
    const input: INodeExecutionData[] = [{ json: { name: FEED_NAME, version: 2, steps: {} } }];
    const params = signStepsParams(true);
    const out = await executeSignSteps(
      nodeContext({ params, rawParameters: params, items: input, credentials: credentialsV2(SITE), continueOnFail: true }),
      fakeEngine(() => DRIFT),
    );
    const [records, errors] = throughN8n(out, input);
    expect(records).toEqual([]);
    expect(errors).toHaveLength(1);
    const reason = 'The input item is not a Repaired steps item from Run Steps (it has no digest). Only Repaired steps items can be signed.';
    expect(errors[0].json.error).toBe(`Sign Steps refused: ${reason}`);
    expect(errors[0].json.details).toEqual({ code: null, reasons: [reason], name: FEED_NAME, version: 2 });
  });
  it('with "Continue (regular output)" the failure stays on Data with its details intact', async () => {
    const out = await runSteps();
    const [data] = throughN8n(out, INPUT, 'continueRegularOutput');
    expect(data).toHaveLength(1);
    expect(data[0].json.details).toMatchObject({ code: 'drift_detected', lane: 'script', version: 1 });
    expect(data[0].binary?.trace).toBeDefined();
  });
});
