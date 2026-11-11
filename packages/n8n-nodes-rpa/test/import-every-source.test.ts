import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import * as real from 'n8n-rpa-engine';
import type { AdoptInput, AdoptResult, Script } from 'n8n-rpa-engine';
import { zip } from '../../engine/test/zip-fixtures.js';
import type { Engine } from '../nodes/Playwright/engine.js';
import type { WorkflowJson } from '../nodes/Playwright/import/workflow.js';
import { executeImportSteps, SOURCE_NOT_DETECTED } from '../nodes/Playwright/operations/importSteps.js';
import { fakeEngine } from './fake-engine.js';
import { nodeContext, siteLoginData } from './feed-fixtures.js';
import { SECRETS } from './fixtures.js';

// Every source, through Import Steps with Source → Work It Out From the File: the source is read from the file, and the
// generated workflow parses, names only node types the generator knows, and holds no secret and no value of a secret
// variable.

const SITE = { url: 'https://erp.example.com', host: 'erp.example.com' };
const FIXTURES = new URL('../../engine/test/fixtures/import/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES));
/** Node types and versions the generator emits (import-workflow.test.ts has the same table, checked against n8n). */
const KNOWN = new Map<string, number>([
  ['n8n-nodes-base.manualTrigger', 1], ['n8n-nodes-base.scheduleTrigger', 1.2], ['n8n-nodes-base.stickyNote', 1], ['n8n-nodes-base.dataTable', 1.1],
  ['n8n-nodes-rpa.playwright', 1], ['n8n-nodes-base.awsS3', 2], ['n8n-nodes-base.extractFromFile', 1.1], ['n8n-nodes-base.convertToFile', 1.1],
  ['n8n-nodes-base.httpRequest', 4.2], ['n8n-nodes-base.emailSend', 2.1], ['n8n-nodes-base.wait', 1.1], ['n8n-nodes-base.if', 2.2],
  ['@n8n/n8n-nodes-langchain.lmChatAnthropic', 1.5], ['n8n-nodes-base.executeWorkflow', 1.2],
]);
/** A value of a secret run variable, given to the import as Options → Variables: it must never reach the workflow file. */
const EXPORT_PASSWORD = 'Export-Secret-7731';

const fileItem = (data: Buffer | string, fileName: string): INodeExecutionData => {
  const bytes = Buffer.from(data);
  return { json: {}, binary: { data: { data: bytes.toString('base64'), mimeType: 'application/octet-stream', fileName, bytes: bytes.length } } };
};
/** The real engine's pure functions; adoptDraft proves the draft as version 1 (no browser opens). */
function engine(): Engine {
  return Object.assign(fakeEngine(() => {
    throw new Error('Import Steps never calls runTask');
  }), {
    adoptDraft: async (input: AdoptInput): Promise<AdoptResult> => {
      const script: Script = { ...input.draft, version: 1 };
      const prove = { ok: true, rows: [], total: null, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [] } as unknown as Parameters<typeof real.buildProposal>[0]['prove'];
      const proposal = real.buildProposal({ script, prove, masker: real.createMasker([]), safetyFlags: real.validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags });
      return { ok: true, lane: 'script', proposal, digest: real.proposalDigest(proposal), llmCalls: 0, durationMs: 1 };
    },
  });
}
async function importFile(data: Buffer | string, fileName: string, options: IDataObject = {}) {
  const params = {
    operation: 'importSteps', source: 'auto', inputFrom: 'binary', binaryPropertyName: 'data', stepsName: 'bot', startUrl: '', aiRepair: false, goal: '', idPattern: 'N26-\\d{4}',
    expectedFile: {}, options: { saveTrace: 'never', ...options },
  };
  const ctx = nodeContext({
    params, rawParameters: params, items: [fileItem(data, fileName)], continueOnFail: true,
    credentials: { playwrightBrowserApi: { mode: 'local', headless: true }, playwrightSiteLoginApi: siteLoginData(SITE) },
  });
  const [out, repaired] = await executeImportSteps(ctx, engine(), { executionsMode: 'regular' });
  return { item: out[0], repaired };
}
/** The generated workflow on the item, with the checks every source shares. */
function workflowOf(item: INodeExecutionData): WorkflowJson {
  const text = Buffer.from(String(item.binary?.workflow?.data ?? ''), 'base64').toString('utf8');
  const wf = JSON.parse(text) as WorkflowJson;
  for (const n of wf.nodes) expect(KNOWN.get(n.type), `${n.name}: ${n.type}`).toBe(n.typeVersion);
  for (const s of [SECRETS.username, SECRETS.password, SECRETS.totpSecret, EXPORT_PASSWORD]) expect(text).not.toContain(s);
  expect(text).not.toContain('allowPrivateNetwork');
  expect(wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger')).toMatchObject({ disabled: true });
  expect(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
  return wf;
}
const runNodes = (wf: WorkflowJson) => wf.nodes.filter((n) => n.type === 'n8n-nodes-rpa.playwright');
const optionsOf = (n: WorkflowJson['nodes'][number]) => (n.parameters as { options: IDataObject }).options;

function uipathZip(dir: string, folder: string): Buffer {
  const root = fileURLToPath(new URL(`${dir}/`, FIXTURES));
  const entries: { name: string; raw: Buffer; usize: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const data = readFileSync(path);
        entries.push({ name: `${folder}/${relative(root, path).split('\\').join('/')}`, raw: deflateRawSync(data), usize: data.length });
      }
    }
  };
  walk(root);
  return zip(entries);
}

describe('every source ends in a workflow that runs', () => {
  it('a Chrome recording: one browser pair under the Name, with the Max Seconds the import was proven with', async () => {
    const chrome = fixture('chrome-sap-export.json').toString('utf8').split('http://localhost:8080').join(SITE.url);
    const { item, repaired } = await importFile(chrome, 'export.json', { maxSeconds: 240, timeout: 10 });
    expect(item.json.error).toBeUndefined();
    expect(item.json.report).toMatchObject({ source: 'chrome' });
    expect(repaired).toHaveLength(1);
    const wf = workflowOf(item);
    expect(wf.name).toBe('bot (imported from a Chrome recording)');
    const [run] = runNodes(wf);
    expect(optionsOf(run)).toMatchObject({ name: 'bot', maxSeconds: 240 });
    expect(wf.nodes.find((n) => n.name === 'Get active steps (bot)')?.parameters).toMatchObject({ filters: { conditions: [{ keyName: 'name', keyValue: 'bot' }, { keyName: 'status', keyValue: 'active' }] } });
  });

  it('Playwright code: one browser pair; the default Max Seconds is not written', async () => {
    const code = fixture('playwright-sap-export.ts.txt').toString('utf8').split('http://localhost:8080').join(SITE.url);
    const { item } = await importFile(code, 'export.spec.ts');
    expect(item.json.error).toBeUndefined();
    expect(item.json.report).toMatchObject({ source: 'playwright' });
    const wf = workflowOf(item);
    expect(wf.name).toBe('bot (imported from Playwright code)');
    expect(optionsOf(runNodes(wf)[0])).not.toHaveProperty('maxSeconds');
  });

  it('a browser step document that types a secret: the secret variable is named for the RPA Secret Variables credential, its value never written', async () => {
    const doc = JSON.stringify({
      startUrl: `${SITE.url}/acme/login`,
      steps: [
        { intent: 'Open the report', goto: '/acme/reports' },
        { intent: 'Type the export password', fill: { field: { css: '#exportPassword' }, value: '{{var.exportPassword}}', secret: true } },
        { intent: 'Choose the company', fill: { field: { css: '#company' }, value: '{{var.company}}' } },
        { intent: 'Export', submit: { button: { css: '#export' }, path: '/acme/reports/export' } },
      ],
    });
    const { item, repaired } = await importFile(doc, 'steps.json', { variables: { values: [{ name: 'exportPassword', value: EXPORT_PASSWORD }, { name: 'company', value: '1000' }] } });
    expect(item.json.error, JSON.stringify(item.json).slice(0, 600)).toBeUndefined();
    expect(item.json.report).toMatchObject({ source: 'steps' });
    expect(repaired).toHaveLength(1);
    const wf = workflowOf(item);
    const [run] = runNodes(wf);
    expect(optionsOf(run).variables).toEqual({ values: [{ name: 'company', value: '' }] });
    expect(run.notes).toContain('exportPassword: put it in an RPA Secret Variables credential (type rpaSecretVariablesApi, field Variables) and select it here.');
  });

  it('a desktop step document: one desktop pair on the RPA Desktop Runner', async () => {
    const doc = JSON.stringify({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Search', click: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ controlType: 'Button', automationId: 'btnSearch' }] } } }] });
    const { item } = await importFile(doc, 'desktop.json');
    expect(item.json.error).toBeUndefined();
    const wf = workflowOf(item);
    const [run] = runNodes(wf);
    expect(run.credentials).toEqual({ rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' } });
    expect(optionsOf(run)).toMatchObject({ name: 'bot' });
  });

  it('an RPA recording: one name, its variables start with the recorded values, the secret one has none', async () => {
    const rec = JSON.parse(fixture('recording-erp/erp.rpa-recording.json').toString('utf8')) as { events: IDataObject[]; variables?: IDataObject };
    (rec.events.find((e) => e.kind === 'select') as IDataObject).option = '{{var.in_CompanyCode}}';
    rec.variables = { in_CompanyCode: '2000' };
    const { item, repaired } = await importFile(JSON.stringify(rec), 'erp.rpa-recording.json');
    expect(item.json.error).toBeUndefined();
    expect(repaired[0].json.name).toBe('bot');
    expect((item.json.drafts as IDataObject[])[0]).toMatchObject({ name: 'bot', startValues: { in_CompanyCode: '2000' }, secretVariables: ['password'] });
    const wf = workflowOf(item);
    const [run] = runNodes(wf);
    expect(optionsOf(run)).toMatchObject({ name: 'bot', variables: { values: [{ name: 'in_CompanyCode', value: '2000' }] } });
    expect(run.notes).toContain('The Variables start with the values that were recorded: change them here. password: put it in an RPA Secret Variables credential');
    expect(String(wf.nodes.find((n) => n.name === 'Fill in the variables (bot)')?.parameters.content)).toContain('`in_CompanyCode` (starts as `2000`)');
  });

  it('a UiPath project: the project\'s own flow, its step lists named <Name>-1, -2', async () => {
    const { item } = await importFile(uipathZip('uipath-sap-report', 'SAP Line Item Report'), 'project.zip');
    expect(item.json.report).toMatchObject({ source: 'uipath' });
    const wf = workflowOf(item);
    expect(runNodes(wf).map((n) => optionsOf(n).name)).toEqual(['bot-1']);
  });

  it('a file Import Steps cannot place: a configuration error that says what to do, and nothing is imported', async () => {
    const { item } = await importFile('just some notes', 'notes.txt');
    expect(item.json.error).toBe(SOURCE_NOT_DETECTED);
    expect(item.binary).toBeUndefined();
  });
});
