// AI Repair of desktop steps through the node: Run Steps on ERP Demo v2 with signed v1 steps and a chat model (the
// engine's fake model playing the live model's turns) → Repaired Steps → Sign Steps with Write Steps → the next run on
// version 2 calls no model. Then the failed-repair hold, the cost and the not-again sentence, and no model connected.
import { afterEach, describe, expect, it } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import { fakeModel, type FakeTurn } from '../../engine/test/fake-model.js';
import { call, V2_TURNS } from '../../engine/test/erp-v2-turns.js';
import { ERP_PASSWORD, ERP_POLICY, FakeRunner } from '../../engine/test/fake-runner.js';
import { EXPECTED, VARS } from '../../engine/test/fixtures/erp-steps.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { APPROVER } from './fixtures.js';
import { fakeEngine, scriptOk } from './fake-engine.js';
import { harness } from './harness.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const GOAL = 'Export the line items of company 1000 for 2026 as a CSV file';
let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

/** Version 1 as the owner approved it: Save (step 16) a write. */
function signedV1(): { steps: unknown; signature: string } {
  const p = engine.desktopProposal(EXPECTED);
  const signed = engine.signDesktopSteps({ proposal: p, key: KEY, approverId: APPROVER, reviewedDigest: engine.proposalDigest(p), writeSteps: [16] });
  if (!signed.ok) throw new Error(signed.reasons.join('; '));
  return { steps: signed.row.steps, signature: signed.row.signature };
}
const plainVars = Object.entries(VARS).filter(([k]) => k !== 'password').map(([name, value]) => ({ name, value }));
const creds = (endpoint: object) => ({
  rpaDesktopRunnerApi: { ...endpoint }, playwrightScriptSigningApi: { secretKey: KEY },
  rpaSecretVariablesApi: { variables: { values: [{ name: 'password', value: ERP_PASSWORD }] } },
});
function runParams(row: { steps: unknown; signature: string }, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'runSteps', runsOn: 'desktop', steps: row.steps, startUrl: '', requireSignedSteps: true, signature: row.signature, approvedBy: APPROVER,
    aiRepair: true, goal: GOAL, options: { saveTrace: 'never', variables: { values: plainVars }, timeout: 1, maxSeconds: 120 }, ...over,
  };
}
const details = (j: IDataObject) => j.details as IDataObject;
const run = async (row: { steps: unknown; signature: string }, model: unknown, o: { staticData?: IDataObject; flow?: IDataObject; over?: Record<string, unknown> } = {}) => {
  const h = harness({ params: runParams(row, o.over), credentials: creds(runner!.endpoint), continueOnFail: true, ...(model ? { model } : {}), ...(o.staticData ? { staticData: o.staticData } : {}) });
  return { out: await executeRunSteps(h, fakeEngine(() => scriptOk())), h };
};

describe('AI Repair of desktop steps through the node', () => {
  it('repairs v1 on ERP Demo v2, the approver signs version 2 with its writes, and the next run uses it without the model', async () => {
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const v1 = signedV1();
    const model = fakeModel(V2_TURNS);
    const { out } = await run(v1, model);
    expect(out).toHaveLength(2);
    const [data, repaired] = out as [INodeExecutionData[], INodeExecutionData[]];
    // The proof stopped at Continue (held for approval): nothing ran to the end, so no Data item.
    expect(data).toEqual([]);
    expect(repaired).toHaveLength(1);
    const item = repaired[0]!.json;
    expect(item).toMatchObject({ name: 'erp-1', baseVersion: 1, version: 2 });
    expect(item.evidenceLine).toBe(
      'Proven in a fresh start of ErpDemo.exe: steps 1 to 13 ran; step 14 was found and not run (it looks like a write). AI repair retargeted steps 9 and 13 and added steps 12 and 14; every other step is as in version 1. Check every step, and mark each step that saves, posts or submits as a write.',
    );
    expect((item.evidence as IDataObject).proof).toEqual({ replayed: 13, stoppedAt: 14, stoppedBecause: 'looks like a write', changedSteps: [9, 13], addedSteps: [12, 14] });
    expect(item.reviewSteps as unknown[]).toHaveLength(18);
    expect(item.secretVariables).toEqual(['password']);
    expect(JSON.stringify(out)).not.toContain(ERP_PASSWORD);

    // Sign Steps: Continue (14) and Save (17) ticked as writes.
    const signP = { operation: 'signSteps', approved: true, approverId: APPROVER, approverAllowlist: APPROVER, writeSteps: '14, 17' };
    const [signed] = await executeSignSteps(harness({ params: signP, items: [{ json: item }], credentials: { playwrightScriptSigningApi: { secretKey: KEY } }, continueOnFail: true }), engine);
    const row = signed[0]!.json;
    expect(row.error).toBeUndefined();
    expect(row).toMatchObject({ name: 'erp-1', version: 2, status: 'active', writeLine: 'Signed as writes: step 14 (Click Continue), step 17 (Click Save)' });

    // An import's evidence line on a repair item is refused: the line is rebuilt from the proof.
    const swapped = { ...item, evidenceLine: 'Not replayed: desktop steps imported from a recording are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.' };
    const [refused] = await executeSignSteps(harness({ params: signP, items: [{ json: swapped }], credentials: { playwrightScriptSigningApi: { secretKey: KEY } }, continueOnFail: true }), engine);
    expect(String(refused[0]!.json.error)).toContain('the evidence, change list or safety line changed after it was reviewed');

    // The next run: version 2 on v2, no model call, the file comes back.
    await runner.close();
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const model2 = fakeModel([]);
    const next = await run({ steps: row.steps, signature: String(row.signature) }, model2);
    const nd = next.out[0]![0]!.json;
    expect(nd.error).toBeUndefined();
    expect(nd).toMatchObject({ name: 'erp-1', version: 2, lane: 'script', llmCalls: 0 });
    expect(model2.invocations).toHaveLength(0);
    expect((nd.files as IDataObject[]).map((f) => f.fileName)).toEqual(['line-items.csv']);
  });

  it('a repair that gives up says what it cost and that the next runs do not try again; the next run is held without a model call', async () => {
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const v1 = signedV1();
    const staticData: IDataObject = {};
    const giveUp: FakeTurn[] = [call('give_up', { reason: 'the Search button is gone and nothing like it is on the window' })];
    const first = await run(v1, fakeModel(giveUp), { staticData });
    const err = first.out[0]![0]!.json;
    expect(details(err)).toMatchObject({ code: 'drift_detected', lane: 'agent', llmCalls: 1 });
    expect(String(err.message)).toContain('AI repair did not fix it: the repair gave up: the Search button is gone');
    expect(String(err.message)).toContain('It used 1 chat model call');
    expect(String(err.message)).toMatch(/The next runs do not try AI Repair again for these steps until the Goal, the steps or AI Repair Reset Key change\.$/);
    const model = fakeModel(giveUp);
    const second = await run(v1, model, { staticData });
    expect(model.invocations).toHaveLength(0);
    expect(String(second.out[0]![0]!.json.message)).toContain('a repair already failed for steps version 1');
    // A new AI Repair Reset Key lets it try again.
    const third = fakeModel(giveUp);
    const reset = runParams(v1);
    (reset.options as IDataObject).repairResetKey = 'tried-again';
    await executeRunSteps(harness({ params: reset, credentials: creds(runner.endpoint), continueOnFail: true, model: third, staticData }), fakeEngine(() => scriptOk()));
    expect(third.invocations).toHaveLength(1);
  });

  it('AI Repair on with no chat model: the drift says to connect one, and no repair runs', async () => {
    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2' });
    const { out } = await run(signedV1(), undefined);
    const err = out[0]![0]!.json;
    expect(details(err)).toMatchObject({ code: 'drift_detected', lane: 'script' });
    expect(String(err.message)).toContain('(AI repair is on but no chat model is connected. Connect one to the Model input.)');
  });
});
