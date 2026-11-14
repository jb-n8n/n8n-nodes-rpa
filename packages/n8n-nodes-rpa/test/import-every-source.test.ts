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
import { nodeContext, SITE_LOGIN_ID, siteLoginData } from './feed-fixtures.js';
import { WORKFLOW_NODE_TYPES } from './fixtures.js';
import { SECRETS } from './fixtures.js';

// Every source, through Import Steps with Source → Work It Out From the File: the source is read from the file, and the
// generated workflow parses, names only node types the generator knows, and holds no secret and no value of a secret
// variable.

const SITE = { url: 'https://erp.example.com', host: 'erp.example.com' };
const FIXTURES = new URL('../../engine/test/fixtures/import/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES));
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
/** Import Steps' two slots that are only passed on: their data is never read, so it is not even valid here. */
const PASS_ON = { playwrightScriptSigningApi: { secretKey: 'never-read' }, rpaDesktopRunnerApi: { connectionLine: 'never-read' } };
async function importFile(data: Buffer | string, fileName: string, options: IDataObject = {}, passOn: IDataObject = {}) {
  const params = {
    operation: 'importSteps', source: 'auto', inputFrom: 'binary', binaryPropertyName: 'data', stepsName: 'bot', startUrl: '', aiRepair: false, goal: '', idPattern: 'N26-\\d{4}',
    expectedFile: {}, options: { saveTrace: 'never', ...options },
  };
  const ctx = nodeContext({
    params, rawParameters: params, items: [fileItem(data, fileName)], continueOnFail: true,
    credentials: { playwrightBrowserApi: { mode: 'local', headless: true }, playwrightSiteLoginApi: siteLoginData(SITE), ...passOn } as never,
  });
  // Which credentials the import reads: never the ones it only passes on.
  const read: string[] = [];
  const getCredentials = ctx.getCredentials.bind(ctx);
  ctx.getCredentials = async (type: string, i?: number) => { read.push(type); return await getCredentials(type, i as number); };
  const [out, repaired] = await executeImportSteps(ctx, engine(), { executionsMode: 'regular' });
  return { item: out[0], repaired, read };
}
/** The generated workflow on the item, with the checks every source shares. */
function workflowOf(item: INodeExecutionData): WorkflowJson {
  const text = Buffer.from(String(item.binary?.workflow?.data ?? ''), 'base64').toString('utf8');
  const wf = JSON.parse(text) as WorkflowJson;
  for (const n of wf.nodes) expect(WORKFLOW_NODE_TYPES[n.type], `${n.name}: ${n.type}`).toBe(n.typeVersion);
  for (const s of [SECRETS.username, SECRETS.password, SECRETS.totpSecret, EXPORT_PASSWORD]) expect(text).not.toContain(s);
  expect(text).not.toContain('allowPrivateNetwork');
  expect(wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger')).toMatchObject({ disabled: true });
  expect(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
  // It runs as generated: no node that needs a credential or a workflow the person has not been told to pick. The only
  // credentials are the RPA node's, which Set once names; no Chat model and no Execute Workflow.
  expect(wf.nodes.filter((n) => n.type.startsWith('@n8n/n8n-nodes-langchain.') || n.type === 'n8n-nodes-base.executeWorkflow')).toEqual([]);
  const setOnce = String(wf.nodes.find((n) => n.name === 'Set once')?.parameters.content);
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-rpa.playwright')) {
    expect(n.parameters.aiRepair, n.name).toBe(false);
    expect(setOnce, n.name).toContain(`**RPA Step Signing**`);
    // A node is named where something is still to pick on it; with every RPA credential picked, none is.
    if (!/Nothing to pick: |Already set on the RPA node/.test(setOnce)) expect(setOnce, n.name).toContain(n.name.length <= 100 ? `**${n.name}**` : '**');
  }
  return wf;
}
const runNodes = (wf: WorkflowJson) => wf.nodes.filter((n) => n.type === 'n8n-nodes-rpa.playwright');
const optionsOf = (n: WorkflowJson['nodes'][number]) => (n.parameters as { options: IDataObject }).options;

function uipathZip(dir: string, folder: string, changes: Record<string, (text: string) => string> = {}): Buffer {
  const root = fileURLToPath(new URL(`${dir}/`, FIXTURES));
  const entries: { name: string; raw: Buffer; usize: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(root, path).split('\\').join('/');
        const data = changes[rel] ? Buffer.from(changes[rel](readFileSync(path, 'utf8'))) : readFileSync(path);
        entries.push({ name: `${folder}/${rel}`, raw: deflateRawSync(data), usize: data.length });
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
    expect(run.notes).toContain('exportPassword: put it in an RPA Secret Variables credential and select it here.');
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

  it('a UiPath desktop project: its variables start with the values the project gives them; the secret one has none', async () => {
    const { item } = await importFile(uipathZip('uipath-erp-desktop', 'ERP Demo Line Items'), 'project.zip');
    expect(item.json.error).toBeUndefined();
    expect((item.json.drafts as IDataObject[])[0]).toMatchObject({
      name: 'bot-1', startValues: { in_CompanyCode: '1000', in_DateFrom: '2026-01-01', in_DateTo: '2026-12-31' }, secretVariables: ['password'],
    });
    const wf = workflowOf(item);
    const [run] = runNodes(wf);
    expect(optionsOf(run).variables).toEqual({ values: [
      { name: 'username', value: '' }, { name: 'in_CompanyCode', value: '1000' }, { name: 'in_DateFrom', value: '2026-01-01' }, { name: 'in_DateTo', value: '2026-12-31' },
    ] });
    expect(run.notes).toContain('The Variables start with the values the UiPath project gave them: change them here.');
    expect(String(wf.nodes.find((n) => n.name === 'Fill in the variables (bot-1)')?.parameters.content)).toContain('`in_CompanyCode` (starts as `1000`)');
  });

  it('a secret\'s default is in no output: found secret after it was noted, under another casing, or equal to a removed secret', async () => {
    const cases: Record<string, (t: string) => string> = {
      // Typed as Sesame into a plain field first, and only later as sesame into the password field.
      'open-sesame-77': (t) => t.replace('<ui:GetRobotCredential ', '<ui:Comment ')
        .replace('<Variable x:TypeArguments="ss:SecureString" Name="password" />', '<Variable x:TypeArguments="x:String" Default="open-sesame-77" Name="Sesame" />')
        .replace('Text="[username]"', 'Text="[Sesame]"').replace('SecureText="[password]"', 'SecureText="[sesame]"'),
      // The company code's default equals a value typed into the password field elsewhere.
      Zx9: (t) => t.replace('Default="1000" Name="companyCode"', 'Default="Zx9" Name="companyCode"')
        .replace("DisplayName=\"Type Into 'User name'\"", "DisplayName=\"Type Into 'Password'\"").replace('Text="[username]"', 'Text="Zx9"'),
    };
    for (const [value, change] of Object.entries(cases)) {
      const { item, repaired } = await importFile(uipathZip('uipath-erp-desktop', 'ERP Demo Line Items', { 'Main.xaml': change }), 'project.zip');
      expect(item.json.error, value).toBeUndefined();
      const file = Buffer.from(String(item.binary?.workflow?.data ?? ''), 'base64').toString('utf8');
      expect(file, value).not.toContain(value);
      expect(JSON.stringify(item.json), value).not.toContain(value);
      expect(JSON.stringify(repaired.map((r) => r.json)), value).not.toContain(value);
      // An ordinary argument still starts with its value.
      expect(optionsOf(runNodes(workflowOf(item))[0]).variables, value).toMatchObject({ values: expect.arrayContaining([{ name: 'in_DateFrom', value: '2026-01-01' }]) });
    }
  });

  it('a file Import Steps cannot place: a configuration error that says what to do, and nothing is imported', async () => {
    const { item } = await importFile('just some notes', 'notes.txt');
    expect(item.json.error).toBe(SOURCE_NOT_DETECTED);
    expect(item.binary).toBeUndefined();
  });
});

describe('the workflow file arrives with the credentials the import was given, by id and name', () => {
  const ref = (type: string) => ({ id: `${type}-1`, name: `${type} credential` });
  const BROWSER_RUN = { playwrightBrowserApi: ref('playwrightBrowserApi'), playwrightSiteLoginApi: { id: SITE_LOGIN_ID, name: 'playwrightSiteLoginApi credential' }, playwrightScriptSigningApi: ref('playwrightScriptSigningApi') };
  const DESKTOP_RUN = { rpaDesktopRunnerApi: ref('rpaDesktopRunnerApi'), playwrightScriptSigningApi: ref('playwrightScriptSigningApi') };
  /** Every credential on a node is n8n's { id, name } and nothing else: no value of a credential is in the file. */
  function onlyRefs(wf: WorkflowJson): void {
    for (const n of wf.nodes) {
      for (const [type, c] of Object.entries(n.credentials ?? {})) {
        expect(Object.keys(c).sort(), `${n.name} ${type}`).toEqual(['id', 'name']);
        expect(n.type, n.name).toBe('n8n-nodes-rpa.playwright');
      }
    }
    expect(JSON.stringify(wf)).not.toContain('never-read');
    expect(String(wf.nodes.find((n) => n.name === 'Set once')?.parameters.content)).toMatch(/Nothing to pick: .* set on the RPA nodes?\.|Already set on the RPA nodes?: /);
  }

  it('a Chrome recording: RPA Browser, RPA Site Login and RPA Step Signing on Run steps; the import reads neither passed-on slot', async () => {
    const chrome = fixture('chrome-sap-export.json').toString('utf8').split('http://localhost:8080').join(SITE.url);
    const { item, read } = await importFile(chrome, 'export.json', {}, PASS_ON);
    expect(item.json.error).toBeUndefined();
    expect(read).not.toContain('playwrightScriptSigningApi');
    expect(read).not.toContain('rpaDesktopRunnerApi');
    const wf = workflowOf(item);
    onlyRefs(wf);
    const [run] = runNodes(wf);
    expect(run.credentials).toEqual(BROWSER_RUN);
    expect(run.notes).toContain('RPA Browser, RPA Site Login and RPA Step Signing are picked for you: check them.');
    expect(run.notes).not.toMatch(/Pick RPA/);
  });

  it('a desktop recording: RPA Desktop Runner and RPA Step Signing, and no Site Login (desktop steps refuse one)', async () => {
    const rec = fixture('recording-erp/erp.rpa-recording.json').toString('utf8');
    const { item, read } = await importFile(rec, 'erp.rpa-recording.json', {}, PASS_ON);
    expect(item.json.error).toBeUndefined();
    expect(read).not.toContain('rpaDesktopRunnerApi');
    const wf = workflowOf(item);
    onlyRefs(wf);
    const [run] = runNodes(wf);
    expect(run.credentials).toEqual(DESKTOP_RUN);
    expect(run.notes).toContain('RPA Desktop Runner and RPA Step Signing are picked for you: check them.');
  });

  it('a UiPath project and a step document with both kinds: each Run steps gets the credentials of its kind', async () => {
    const uipath = await importFile(uipathZip('uipath-sap-report', 'SAP Line Item Report'), 'project.zip', {}, PASS_ON);
    const uwf = workflowOf(uipath.item);
    onlyRefs(uwf);
    for (const run of runNodes(uwf)) expect(run.credentials, run.name).toEqual(BROWSER_RUN);
    // The UiPath credential lookup no longer asks for a pick: the Site Login is there.
    const cred = uwf.nodes.find((n) => n.name.startsWith('Credential: '));
    expect(String(cred?.parameters.content)).toContain('the RPA Site Login on the Run steps node(s) holds that login');
    expect(String(cred?.parameters.content)).not.toContain('Pick one there');

    const desktop = JSON.stringify({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Search', click: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ controlType: 'Button', automationId: 'btnSearch' }] } } }] });
    const doc = await importFile(desktop, 'desktop.json', {}, PASS_ON);
    const [run] = runNodes(workflowOf(doc.item));
    expect(run.credentials).toEqual(DESKTOP_RUN);
  });

  it('without the passed-on slots: the import\'s own Browser and Site Login are still picked, Step Signing is left to pick, the runner is named by name', async () => {
    const chrome = fixture('chrome-sap-export.json').toString('utf8').split('http://localhost:8080').join(SITE.url);
    const [run] = runNodes(workflowOf((await importFile(chrome, 'export.json')).item));
    expect(run.credentials).toEqual({ playwrightBrowserApi: BROWSER_RUN.playwrightBrowserApi, playwrightSiteLoginApi: BROWSER_RUN.playwrightSiteLoginApi });
    expect(run.notes).toContain('RPA Browser and RPA Site Login are picked for you: check them. Pick RPA Step Signing here.');
    const desktop = JSON.stringify({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Search', click: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ controlType: 'Button', automationId: 'btnSearch' }] } } }] });
    const [drun] = runNodes(workflowOf((await importFile(desktop, 'desktop.json')).item));
    expect(drun.credentials).toEqual({ rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' } });
    expect(drun.notes).toContain('Pick RPA Desktop Runner and RPA Step Signing here.');
  });
});
