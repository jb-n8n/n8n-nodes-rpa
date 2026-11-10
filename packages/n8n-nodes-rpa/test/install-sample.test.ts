// The sample flow of the Windows install guide (docs/install/samples): the ERP Demo's steps, the workflow that runs them
// and the policy change that allows the ERP Demo on the runner. The guide tells a person to apply the change, import the
// workflow and run it; these tests keep the three files working together.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Workflow, type INodeParameters, type INodeTypes } from 'n8n-workflow';
import { ERP_CSV_HEADER, ERP_PASSWORD, ERP_USER, FakeRunner, type FakePolicy } from '../../engine/test/fake-runner.js';
import { EXPECTED, VARS } from '../../engine/test/fixtures/erp-steps.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine, scriptOk } from './fake-engine.js';
import { harness } from './harness.js';

const SAMPLES = new URL('../../../docs/install/samples/', import.meta.url);
const text = (file: string) => readFileSync(new URL(file, SAMPLES), 'utf8');
const json = (file: string) => JSON.parse(text(file)) as Record<string, unknown>;

interface WorkflowNode { id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown>; credentials?: unknown }
interface SampleWorkflow { name: string; nodes: WorkflowNode[]; connections: Record<string, { main: { node: string }[][] }> }

const workflow = json('erp-demo.workflow.json') as unknown as SampleWorkflow;
const steps = json('erp-demo-steps.json');
const change = json('erp-demo-policy-change.json');
const runNode = () => {
  const runs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-rpa.playwright');
  expect(runs).toHaveLength(1);
  return runs[0];
};

/** The node as n8n loads it from the file: its parameters with the node's defaults filled in. */
function loaded(n: WorkflowNode): INodeParameters {
  const playwright = new Playwright();
  const nodeTypes = { getByName: () => playwright, getByNameAndVersion: () => playwright, getKnownTypes: () => ({}) } as unknown as INodeTypes;
  const wf = new Workflow({
    nodes: [{ id: n.id, name: n.name, type: n.type, typeVersion: n.typeVersion, position: n.position, parameters: n.parameters as INodeParameters }],
    connections: {}, active: false, nodeTypes,
  });
  const node = wf.getNode(n.name);
  if (!node) throw new Error(`n8n did not load ${n.name}`);
  return node.parameters;
}

// RunnerPolicy and PolicyChange (desktop/runner/src/Rpa.Runner.Core/Policy): the keys a change file and its entries may
// have. The sample uses three of the five top-level keys.
const SAMPLE_KEYS = ['allowedApps', 'writeControls', 'gatedKeys'];
const APP_KEYS = ['exe', 'path', 'sha256', 'allowedArgs', 'allowUserWritable'];
const WRITE_CONTROL_KEYS = ['exe', 'automationId'];
const INSTALLED_DEMO = 'C:\\Program Files\\RPA Runner\\erp-demo\\';

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

describe('the install guide\'s sample flow', () => {
  it('the sample workflow\'s Run Steps node runs the sample steps against the fake runner and returns the CSV', async () => {
    // The sample steps are the ERP Demo steps the UiPath importer makes (the engine's fixture), named for the guide.
    expect(steps).toEqual({ ...EXPECTED, name: 'erp-demo' });
    const node = runNode();
    const params = loaded(node);
    expect(params.operation).toBe('runSteps');
    expect(JSON.parse(String(params.steps))).toEqual(steps);
    // The trigger starts the Run Steps node.
    expect(Object.values(workflow.connections).flatMap((c) => c.main.flat().map((t) => t.node))).toEqual([node.name]);

    // The runner holds exactly what the sample policy change allows.
    const policy: FakePolicy = {
      allowedApps: (change.allowedApps as { exe: string }[]).map((a) => ({ exe: a.exe })),
      writeControls: change.writeControls as FakePolicy['writeControls'],
      gatedKeys: change.gatedKeys as string[],
      maxFileBytes: 20 * 1024 * 1024,
    };
    runner = await FakeRunner.start({ app: 'erp', policy });
    const eng = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(harness({ params, credentials: { rpaDesktopRunnerApi: { ...runner.endpoint } }, continueOnFail: true }), eng);
    expect(eng.calls).toHaveLength(0); // the browser lane never ran
    expect(data).toHaveLength(1);
    const out = data[0].json;
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({ name: 'erp-demo', version: 1, lane: 'script', values: { out_ResultCount: '12 line items', out_FirstDocument: '1000-0001' } });
    const files = out.files as { fileName: string; mimeType: string; binaryProperty: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ fileName: 'line-items.csv', mimeType: 'text/csv' });
    const binary = data[0].binary?.[files[0].binaryProperty];
    expect(binary).toMatchObject({ fileName: 'line-items.csv', mimeType: 'text/csv' });
    const lines = Buffer.from(String(binary?.data), 'base64').toString('utf8').split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(ERP_CSV_HEADER);
    expect(lines.slice(1)).toHaveLength(12);
    // The sign-in typed from the run variables never shows in the output.
    expect(JSON.stringify(out)).not.toContain(ERP_PASSWORD);
  });

  it('the sample policy change is accepted by the same rules as RpaPolicy', () => {
    for (const key of Object.keys(change)) expect(SAMPLE_KEYS, key).toContain(key);
    const apps = change.allowedApps as Record<string, unknown>[];
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) {
      for (const key of Object.keys(app)) expect(APP_KEYS, key).toContain(key);
      // The ERP Demo ships under Program Files, which only administrators can change: no allowUserWritable.
      expect(app).not.toHaveProperty('allowUserWritable');
      const path = String(app.path);
      expect(path.startsWith(INSTALLED_DEMO), path).toBe(true);
      expect(path.split('\\').at(-1)).toBe(app.exe);
      expect(path).not.toMatch(/~\d/);
    }
    for (const control of change.writeControls as Record<string, unknown>[]) {
      expect(Object.keys(control).sort()).toEqual([...WRITE_CONTROL_KEYS].sort());
    }
    for (const chord of change.gatedKeys as unknown[]) expect(typeof chord).toBe('string');
    // The app the steps launch is the one the change allows.
    expect(apps.map((a) => a.exe)).toContain((steps.app as { exe: string }).exe);
  });

  it('the sample policy change has no allowUserWritable anywhere', () => {
    expect(text('erp-demo-policy-change.json')).not.toContain('allowUserWritable');
  });

  it('the sample workflow file has no credential id and no URL with a real host', () => {
    for (const n of workflow.nodes) expect(n.credentials, n.name).toBeUndefined();
    const file = text('erp-demo.workflow.json');
    expect(file).not.toMatch(/"credentials"|"instanceId"|"meta"/);
    for (const [url] of file.matchAll(/\b(?:https?|wss?):\/\/[^\s"\\)]+/g)) {
      expect(new URL(url).hostname, url).toMatch(/(^|\.)example\.(com|org|net)$/);
    }
    // The ERP Demo's documented sign-in, as run variables: no other secret is in the file.
    const variables = (runNode().parameters.options as { variables: { values: { name: string; value: string }[] } }).variables.values;
    expect(Object.fromEntries(variables.map((v) => [v.name, v.value]))).toEqual({ ...VARS, username: ERP_USER, password: ERP_PASSWORD });
  });
});
