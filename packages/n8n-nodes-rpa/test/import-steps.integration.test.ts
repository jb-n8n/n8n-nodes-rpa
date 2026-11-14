// Import Steps against the sandbox with the real engine (a local headless browser, as integration.test.ts): the Chrome
// SAP export recording imports, adopts, comes out on Repaired Steps, signs through Sign Steps, and the signed steps run.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ICredentialDataDecryptedObject, IDataObject, INodeExecutionData } from 'n8n-workflow';
import { totp, type Script } from 'n8n-rpa-engine';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { loadEngine, type Engine } from '../nodes/Playwright/engine.js';
import { resetGuardsForTests } from '../nodes/Playwright/guard.js';
import { executeImportSteps } from '../nodes/Playwright/operations/importSteps.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { nodeContext, runStepsParams, signStepsParams, siteLoginData } from './feed-fixtures.js';
import { SECRETS, SIGNING_KEY } from './fixtures.js';

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

const FIXTURE = readFileSync(new URL('../../engine/test/fixtures/import/chrome-sap-export.json', import.meta.url), 'utf8');
const SEPTEMBER = `LINEITEMS_1000_${SANDBOX.erp.from}_${SANDBOX.erp.to}.csv`;
const VARIABLES = { values: [{ name: 'company', value: SANDBOX.erp.company }, { name: 'from', value: SANDBOX.erp.from }, { name: 'to', value: SANDBOX.erp.to }] };

/** The sandbox Site Login, with the SAP web GUI's read-only POSTs listed (the engine's sapPolicy). */
function credentials(): Record<string, ICredentialDataDecryptedObject> {
  const readPosts = SANDBOX.erp.readPosts(portal.host).map((r: { host: string; path: string }) => `POST ${r.host}${r.path}`).join('\n');
  return {
    playwrightBrowserApi: { mode: 'local', headless: true },
    playwrightSiteLoginApi: { ...siteLoginData(portal), readPosts },
    playwrightScriptSigningApi: { secretKey: SIGNING_KEY },
  };
}
const importParams = {
  operation: 'importSteps', source: 'chrome', inputFrom: 'binary', binaryPropertyName: 'data', stepsName: 'sap-export', startUrl: '', aiRepair: false, goal: '', idPattern: '',
  expectedFile: { file: { fileType: ['csv'], namePattern: '^LINEITEMS_1000_', requiredColumns: 'Document, Posting Date, Company Code, Amount, Currency', minRows: 1 } },
  options: { variables: VARIABLES, allowPrivateNetwork: true, timeout: 5, maxSeconds: 60, saveTrace: 'never' },
};
const recording = (): INodeExecutionData => {
  const bytes = Buffer.from(FIXTURE.split('http://localhost:8080').join(portal.url));
  return { json: {}, binary: { data: { data: bytes.toString('base64'), mimeType: 'application/json', fileName: 'sap-export.json', bytes: bytes.length } } };
};
/**
 * The UiPath project recorded against the light web GUI (a sign-in with an authentication code, then the export), zipped
 * as a user uploads it, pointed at the sandbox.
 */
const uipathLight = (): INodeExecutionData => {
  const root = fileURLToPath(new URL('../../engine/test/fixtures/import/uipath-sap-light/', import.meta.url));
  const entries: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries[`SAP Line Item Export/${relative(root, path).split('\\').join('/')}`] = strToU8(readFileSync(path, 'utf8').split('http://localhost:8080').join(portal.url));
    }
  };
  walk(root);
  const project = Buffer.from(zipSync(entries));
  return { json: {}, binary: { data: { data: project.toString('base64'), mimeType: 'application/zip', fileName: 'project.zip', bytes: project.length } } };
};
async function sign(json: IDataObject): Promise<IDataObject> {
  const params = signStepsParams();
  const [out] = await executeSignSteps(nodeContext({ params, rawParameters: params, items: [{ json }], credentials: credentials(), continueOnFail: true }), engine);
  return out[0].json;
}

describe('Import Steps against the sandbox (real engine)', () => {
  it('an imported item signs with Sign Steps, and a tampered one is refused; the signed steps deliver the file', async () => {
    const out = await executeImportSteps(nodeContext({
      params: importParams, rawParameters: importParams, items: [recording()], credentials: credentials(), continueOnFail: true,
    }), engine, { executionsMode: 'regular' });
    const [data, repaired] = out;
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 1500)).toBeUndefined();
    expect(repaired).toHaveLength(1);
    const item = repaired[0].json;
    expect(item).toMatchObject({ name: 'sap-export', baseVersion: null, version: 1 });
    expect(item.evidence).toMatchObject({ file: { fileName: SEPTEMBER, rows: SANDBOX.erp.rowsInSeptember1000 } });
    expect((data[0].json.drafts as IDataObject[])[0]).toMatchObject({ name: 'sap-export', adopted: true });
    // Nothing from the Site Login in any output item.
    const text = JSON.stringify(out.flat().map((i) => i.json)).toLowerCase();
    for (const secret of [SECRETS.username, SECRETS.password, SECRETS.totpSecret]) expect(text).not.toContain(secret.toLowerCase());

    // A step changed after review (hash recomputed): refused, nothing signed.
    const steps = structuredClone(item.steps) as unknown as Script;
    const at = steps.steps.findIndex((s) => 'click' in s);
    steps.steps[at] = { ...steps.steps[at], intent: 'Click Delete all' } as Script['steps'][number];
    const tampered = await sign({ ...item, steps: steps as unknown as IDataObject, hash: engine.scriptHash(steps) });
    expect(String(tampered.error)).toContain('the repaired steps changed after they were reviewed');

    // Unchanged: signed as version 1, and the signed steps run on the script lane and deliver the September file.
    const record = await sign(item);
    expect(record).toMatchObject({ name: 'sap-export', version: 1, status: 'active' });
    const run = runStepsParams(record, {}, { name: 'sap-export', idPattern: '', totalPattern: '', variables: VARIABLES, timeout: 5 });
    const [result] = await executeRunSteps(nodeContext({ params: run, rawParameters: run, credentials: credentials(), continueOnFail: true }), engine);
    expect(result[0].json, JSON.stringify(result[0].json).slice(0, 1500)).toMatchObject({ lane: 'script', version: 1, llmCalls: 0 });
    expect((result[0].json.files as IDataObject[]).map((f) => f.fileName)).toEqual([SEPTEMBER]);
  }, 180_000);

  it('Sign Steps signs a not-replayed browser item, and the signed list loads and runs in Run Steps', async () => {
    // A hand-written list that submits the sandbox's contact form. No Site Login: Run Steps then allows a declared target
    // on a site the steps may open, here the start site.
    const posts = async () => ((await (await fetch(`${portal.url}/public/api/counters`)).json()) as { posts: unknown[] }).posts;
    const doc = { startUrl: `${portal.url}/public/form`, steps: [
      { intent: 'Type the name', fill: { field: { label: 'Name' }, value: '{{var.name}}' } },
      { intent: 'Send', submit: { path: '/public/form/submit', button: { role: 'button', name: 'Send' } } },
    ] };
    const signing = { playwrightScriptSigningApi: { secretKey: SIGNING_KEY } };
    const params = {
      ...importParams, source: 'steps', inputFrom: 'text', sourceText: JSON.stringify(doc), stepsName: 'contact', expectedFile: {},
      options: { allowPrivateNetwork: true, saveTrace: 'never' },
    };
    // Nothing runs, so no RPA Browser credential is attached.
    const [data, repaired] = await executeImportSteps(nodeContext({
      params, rawParameters: params, items: [{ json: {} }], credentials: signing, continueOnFail: true,
    }), engine, { executionsMode: 'regular' });
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 1500)).toBeUndefined();
    expect(repaired).toHaveLength(1);
    expect(String(repaired[0].json.evidenceLine)).toMatch(/^Not replayed: these browser steps were never run by the import/);
    expect(await posts()).toEqual([]);

    const signParams = signStepsParams();
    const [signed] = await executeSignSteps(nodeContext({ params: signParams, rawParameters: signParams, items: [{ json: repaired[0].json }], credentials: signing, continueOnFail: true }), engine);
    const record = signed[0].json;
    expect(record, JSON.stringify(record).slice(0, 1500)).toMatchObject({ name: 'contact', version: 1, status: 'active' });

    // Signed steps required, the same credentials (no Site Login): the list loads and its submit goes out.
    const run = runStepsParams(record, { startUrl: `${portal.url}/public/form` }, {
      name: 'contact', idPattern: '', totalPattern: '', variables: { values: [{ name: 'name', value: 'Ada Lovelace' }] }, timeout: 5,
    });
    const [result] = await executeRunSteps(nodeContext({
      params: run, rawParameters: run, credentials: { playwrightBrowserApi: { mode: 'local', headless: true }, ...signing }, continueOnFail: true,
    }), engine);
    expect(result[0].json, JSON.stringify(result[0].json).slice(0, 1500)).toMatchObject({ lane: 'script', version: 1, submitted: true });
    expect(await posts()).toEqual([{ path: '/public/form/submit', name: 'Ada Lovelace' }]);
  }, 180_000);

  it('a UiPath browser project with the Expected File template 5 sends (name pattern and columns) replays its download and signs', async () => {
    portal.setState({ mfa: 'totp' });
    const expectedFile = { file: { namePattern: '^LINEITEMS_1000_', requiredColumns: 'Document, Amount' } };
    const params = { ...importParams, source: 'uipath', stepsName: 'line-item-export', expectedFile };
    const [data, repaired] = await executeImportSteps(nodeContext({
      params, rawParameters: params, credentials: credentials(), continueOnFail: true, items: [uipathLight()],
    }), engine, { executionsMode: 'regular' });
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 1500)).toBeUndefined();
    expect(JSON.stringify(data[0].json.report)).not.toContain('stays a click');
    expect(repaired).toHaveLength(1);
    expect(repaired[0].json.evidence).toMatchObject({ file: { fileName: SEPTEMBER } });
    const record = await sign(repaired[0].json);
    expect(record, JSON.stringify(record).slice(0, 1500)).toMatchObject({ name: 'line-item-export-1', version: 1, status: 'active' });
  }, 180_000);

  it('the code is in neither the report, the Data output nor the generated workflow', async () => {
    // The UiPath project recorded against the light web GUI: a sign-in with an authentication code, then the export.
    const project = Buffer.from(uipathLight().binary!.data.data, 'base64');
    portal.setState({ mfa: 'totp' });
    // The Site Login has no TOTP Secret: the code can only come from the One-Time Code Workflow, which reads it as an
    // authenticator app would.
    const creds = credentials();
    creds.playwrightSiteLoginApi = { ...creds.playwrightSiteLoginApi, totpSecret: '' };
    const codes: string[] = [];
    // Debug Trace Always: the proof's trace, where the code was typed, comes out on Repaired Steps and is searched too.
    const params = { ...importParams, source: 'uipath', options: { ...importParams.options, saveTrace: 'always', codeWorkflowId: 'wf-code-1' } };
    const out = await executeImportSteps(nodeContext({
      params, rawParameters: params, credentials: creds, continueOnFail: true,
      items: [{ json: {}, binary: { data: { data: project.toString('base64'), mimeType: 'application/zip', fileName: 'project.zip', bytes: project.length } } }],
      executeWorkflow: async () => {
        const code = totp(SECRETS.totpSecret);
        codes.push(code);
        return { executionId: 'sub-1', data: [[{ json: { code } }]] };
      },
    }), engine, { executionsMode: 'regular' });
    const [data, repaired] = out;
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 1500)).toBeUndefined();
    expect(repaired).toHaveLength(1);
    expect(repaired[0].json.steps).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ signIn: expect.objectContaining({ totp: expect.objectContaining({ source: 'workflow' }) }) })]) });
    expect(Object.keys(data[0].binary ?? {})).toContain('workflow');
    // The import's run and its replay each asked the workflow for a code.
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(repaired[0].binary ?? {})).toContain('trace');
    const texts = out.flat().flatMap((i) => [JSON.stringify(i.json), ...Object.entries(i.binary ?? {}).flatMap(([key, b]) => {
      const bytes = Buffer.from(b.data, 'base64');
      return key === 'trace' ? Object.values(unzipSync(bytes)).map((entry) => Buffer.from(entry).toString('latin1')) : [bytes.toString('latin1')];
    })]);
    for (const code of codes) for (const text of texts) expect(new RegExp(`(?<![0-9])${code}(?![0-9])`).test(text)).toBe(false);
  }, 180_000);
});
