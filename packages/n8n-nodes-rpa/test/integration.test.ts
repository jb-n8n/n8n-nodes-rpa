import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Script } from 'n8n-rpa-engine';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { clickNamed, done, fakeModel, use } from '../../engine/test/fake-model.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { resetGuardsForTests } from '../nodes/Playwright/guard.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { credentialsV2, FEED_NAME, nodeContext, repairedItem, runStepsParams, signStepsParams, type Site } from './feed-fixtures.js';
import { baselineScript, SECRETS } from './fixtures.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let engine: Engine;
beforeAll(async () => {
  portal = await startPortal();
  engine = await loadEngine();
});
afterAll(async () => { await portal.close(); });
beforeEach(() => {
  portal.reset();
  resetGuardsForTests();
});

const v = (version: number): Script => ({ ...baselineScript(portal.url, version), name: FEED_NAME });
const HEAL = () => [clickNamed('Field Actions'), use('extract'), done('found', 'all bulletins')];
const ids = (item: INodeExecutionData) => (item.json.rows as { id: string }[]).map((r) => r.id).sort();
const jsonOnly = (items: INodeExecutionData[]) => JSON.stringify(items.map((i) => i.json));

async function sign(item: IDataObject, approved = true): Promise<IDataObject> {
  const params = signStepsParams(approved);
  const [records] = await executeSignSteps(nodeContext({ params, rawParameters: params, items: [{ json: item }], credentials: credentialsV2(portal) }), engine);
  return records[0].json;
}
function run(record: IDataObject | undefined, o: {
  site?: Site | null; model?: unknown; staticData?: IDataObject; signal?: AbortSignal; password?: string; over?: Record<string, unknown>; options?: Record<string, unknown>;
} = {}) {
  const params = runStepsParams(record, o.over, o.options);
  const site = o.site === null ? undefined : (o.site ?? portal);
  return executeRunSteps(nodeContext({
    params, rawParameters: params, credentials: credentialsV2(site, { password: o.password }), model: o.model, staticData: o.staticData, signal: o.signal, continueOnFail: true,
  }), engine);
}

describe('Run Steps and Sign Steps against the sandbox (real engine)', () => {
  it('signed steps run on the script lane: seven bulletins, no model call, the documented Data fields', async () => {
    const record = await sign(repairedItem(v(1), null));
    expect(record).toMatchObject({ name: FEED_NAME, version: 1, status: 'active' });
    const model = fakeModel([]);
    const out = await run(record, { model });
    expect(out).toHaveLength(1);
    const data = out[0][0].json;
    expect(data).toMatchObject({ lane: 'script', name: FEED_NAME, version: 1, hash: record.hash, llmCalls: 0, status: 200 });
    for (const key of ['url', 'title', 'status', 'name', 'version', 'hash', 'lane', 'confirmed', 'llmCalls', 'log', 'rows']) expect(data).toHaveProperty(key);
    expect(ids(out[0][0])).toEqual([...SANDBOX.bulletins].sort());
    expect(model.invocations).toHaveLength(0);
  });

  it('AI Repair heals drift; the Repaired steps item signs through Sign Steps; the next run is script lane v2 with no model call', async () => {
    const v1 = await sign(repairedItem(v(1), null));
    portal.setState({ label: 'Field Actions' });
    const [data, repaired] = await run(v1, { model: fakeModel(HEAL()), over: { aiRepair: true } });
    expect(data[0].json).toMatchObject({ lane: 'agent', confirmed: true });
    expect(repaired).toHaveLength(1);
    expect(repaired[0].json).toMatchObject({ name: FEED_NAME, baseVersion: 1, version: 2 });
    expect(repaired[0].json.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(String(repaired[0].json.changeList)).toContain('Changed: Open Recalls & Stop-Sales (click role "link" name "Recalls & Stop-Sales") -> Open Field Actions (click role "link" name "Field Actions" exact');
    expect(repaired[0].binary?.before?.mimeType).toBe('image/png');
    for (const secret of [SECRETS.password, SECRETS.username]) expect(jsonOnly([...data, ...repaired])).not.toContain(secret);

    // Edited after review, even with the hash recomputed: the digest covers the steps.
    const edited = JSON.parse(JSON.stringify(repaired[0].json.steps)) as Script;
    edited.steps[edited.steps.length - 1] = { ...edited.steps[edited.steps.length - 1], intent: 'Read every page (edited)' };
    await expect(sign({ ...repaired[0].json, steps: edited as unknown as IDataObject, hash: engine.scriptHash(edited) })).rejects.toThrow(/^Sign Steps refused: /);

    const v2 = await sign(repaired[0].json);
    expect(v2).toMatchObject({ name: FEED_NAME, version: 2, status: 'active' });
    const idle = fakeModel([]);
    const [next] = await run(v2, { model: idle, over: { aiRepair: true } });
    expect(next[0].json).toMatchObject({ lane: 'script', version: 2, llmCalls: 0 });
    expect(idle.invocations).toHaveLength(0);
  });

  it('a wrong password trips the breaker on the Site Login; the next run is locked_out (golden) with no login; a new reset key allows it', async () => {
    const record = await sign(repairedItem(v(1), null));
    const staticData: IDataObject = {};
    const [bad] = await run(record, { staticData, password: 'wrong-pass-123' });
    expect(bad[0].json.details).toMatchObject({ code: 'login_failed', name: FEED_NAME });
    expect(jsonOnly(bad)).not.toContain('wrong-pass-123');
    const logins = portal.state().logins;
    const [locked] = await run(record, { staticData });
    expect(locked[0].json.error).toBe(`locked_out: A previous login for ${portal.host} failed, so no login was tried.`);
    expect(portal.state().logins).toBe(logins);
    const [reset] = await run(record, { staticData, options: { breakerResetKey: '2026-10-06' } });
    expect(reset[0].json).toMatchObject({ lane: 'script', version: 1 });
  });

  it('an edited record, a blank signature or a wrong Expected Version is script_untrusted before any login', async () => {
    const record = await sign(repairedItem(v(1), null));
    const before = portal.state().logins;
    const steps = JSON.parse(String(record.steps)) as Script;
    steps.steps[3] = { ...steps.steps[3], intent: 'Open Service now' };
    const [edited] = await run({ ...record, steps: JSON.stringify(steps) });
    expect(edited[0].json.details).toMatchObject({ code: 'script_untrusted' });
    const [swapped] = await run({ ...record, approvedBy: 'mallory@example.com' });
    expect(swapped[0].json.details).toMatchObject({ code: 'script_untrusted' });
    const [blank] = await run({ ...record, signature: '' });
    expect(blank[0].json.error).toBe('script_untrusted: The steps are not signed, or the signature is not valid, and Require Signed Steps is on. Sign them with Sign Steps first.');
    const [rolledBack] = await run(record, { options: { expectedVersion: '2' } });
    expect(rolledBack[0].json.error).toBe('script_untrusted: the signed steps are version 1, but Expected Version is 2');
    expect(portal.state().logins).toBe(before);
  });

  it('unsigned Run Steps without a Site Login reads a public table and names the screenshot by its step index', async () => {
    const steps = [
      { intent: 'Read the table', extractTable: { table: { css: 'table.results' } } },
      { intent: 'Take a screenshot', screenshot: { capture: 'viewport' } },
    ];
    const [data] = await run(undefined, {
      site: null,
      over: { steps: JSON.stringify(steps), startUrl: `${portal.url}/public/table`, requireSignedSteps: false },
      options: { name: '', idPattern: '' },
    });
    expect(data[0].json).toMatchObject({ lane: 'script', name: null, version: null, status: 200, confirmed: false });
    expect(data[0].json.rows).toEqual([
      { Code: 'SKU-1001', Product: 'Widget', Price: '$10.00', Stock: '12' },
      { Code: 'SKU-1002', Product: 'Gadget', Price: '$12.50', Stock: '0' },
      { Code: 'SKU-1003', Product: 'Gizmo', Price: '$7.25', Stock: '5' },
    ]);
    expect(data[0].binary?.screenshot_1?.mimeType).toBe('image/png');
    expect((data[0].json.log as { output?: { binary?: string } }[]).some((e) => e.output?.binary === 'screenshot_1')).toBe(true);
    expect(data[0].json.blockedRequests).toBeUndefined();
  });

  it('cancelling mid-run releases the lock and leaves the breaker alone', async () => {
    const record = await sign(repairedItem(v(1), null));
    portal.setState({ label: 'Field Actions' }); // the failing step waits for its timeout, so the cancel lands mid-run
    const controller = new AbortController();
    const staticData: IDataObject = {};
    setTimeout(() => controller.abort(), 1500);
    const t0 = Date.now();
    const [data] = await run(record, { signal: controller.signal, staticData, options: { timeout: 8 } });
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(data[0].json.details).toMatchObject({ code: 'incomplete', message: 'run cancelled' });
    expect(staticData).toEqual({});
    portal.reset();
    const [next] = await run(record);
    expect(next[0].json).toMatchObject({ lane: 'script', version: 1 });
  });
});
