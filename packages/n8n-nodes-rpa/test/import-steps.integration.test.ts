// Import Steps against the sandbox with the real engine (a local headless browser, as integration.test.ts): the Chrome
// SAP export recording imports, adopts, comes out on Repaired Steps, signs through Sign Steps, and the signed steps run.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ICredentialDataDecryptedObject, IDataObject, INodeExecutionData } from 'n8n-workflow';
import type { Script } from 'n8n-rpa-engine';
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
});
