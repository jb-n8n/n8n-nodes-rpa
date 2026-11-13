import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVER } from './fixtures.js';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import { ERP_PASSWORD, ERP_POLICY, ERP_USER, erpCsv, erpLineItems, FakeRunner } from '../../engine/test/fake-runner.js';
import type { DesktopStep } from 'n8n-rpa-engine';
import { importAddedSteps, signInKeySteps } from '../nodes/Playwright/format.js';
import { buildWorkflow } from '../nodes/Playwright/import/workflow.js';
import { executeImportSteps } from '../nodes/Playwright/operations/importSteps.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { fakeEngine } from './fake-engine.js';
import { harness, type HarnessOptions } from './harness.js';

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
const KEY = 'desktop-import-signing-key-0123456789';
const DIR = fileURLToPath(new URL('../../engine/test/fixtures/import/uipath-erp-desktop/', import.meta.url));

function sampleZip(): Buffer {
  const entries: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else entries[`ERP Demo Line Items/${relative(DIR, p).split('\\').join('/')}`] = strToU8(readFileSync(p, 'utf8'));
    }
  };
  walk(DIR);
  return Buffer.from(zipSync(entries));
}
const fileItem = (data: Buffer): INodeExecutionData => ({ json: {}, binary: { data: { data: data.toString('base64'), mimeType: 'application/zip', fileName: 'erp.zip', bytes: data.length } } });
const importParams = { operation: 'importSteps', source: 'uipath', binaryPropertyName: 'data', stepsName: 'erp', startUrl: '', aiRepair: false, goal: '', idPattern: '', expectedFile: {}, options: { saveTrace: 'never' } };
/** The real engine, with the browser lanes refused: a desktop import never opens a browser. */
const noBrowser = () => Object.assign(fakeEngine(() => { throw new Error('a desktop import never runs a browser'); }), {
  adoptDraft: () => { throw new Error('a desktop draft is never adopted in a browser'); },
});

async function importSample(credentials: HarnessOptions['credentials'] = {}) {
  const [data, repaired] = await executeImportSteps(harness({ params: importParams, items: [fileItem(sampleZip())], credentials, continueOnFail: true }), noBrowser());
  return { data, repaired };
}
async function sign(item: IDataObject, over: Record<string, unknown> = {}, credentials: HarnessOptions['credentials'] = {}) {
  const params = { operation: 'signSteps', approved: true, approverId: APPROVER, approverAllowlist: APPROVER, writeSteps: '', ...over };
  const out = await executeSignSteps(harness({ params, items: [{ json: item }], credentials: { playwrightScriptSigningApi: { secretKey: KEY }, ...credentials }, continueOnFail: true }), engine, () => new Date('2026-10-29T12:00:00.000Z'));
  return out[0][0].json;
}

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

describe('Import Steps with a UiPath desktop project', () => {
  it('needs no RPA Browser credential: the desktop draft goes to approval as a Repaired steps item, not replayed', async () => {
    const { data, repaired } = await importSample();
    expect(data).toHaveLength(1);
    const json = data[0].json;
    expect(json.error).toBeUndefined();
    expect(json.workflowName).toBe('ERP Demo Line Items (imported from UiPath)');
    expect(data[0].binary?.workflow).toBeDefined();
    expect(json.drafts).toEqual([expect.objectContaining({
      name: 'erp-1', surface: 'desktop', adopted: false, forApproval: true, writeCandidates: [4, 16],
      variables: ['username', 'password', 'in_CompanyCode', 'in_DateFrom', 'in_DateTo'], secretVariables: ['password'],
      reason: 'Desktop steps are not replayed at import: they go to approval as imported. Review every step, and mark each step that saves, posts or submits as a write when you approve.',
    })]);
    expect(repaired).toHaveLength(1);
    const item = repaired[0].json;
    expect(item).toMatchObject({ name: 'erp-1', baseVersion: null, version: 1, attachmentNames: '' });
    expect(item.evidenceLine).toBe('Not replayed: desktop steps imported from UiPath are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.');
    expect(String(item.safetyLine)).toContain('candidate write: step 16 (Click Save) may save, post or submit');
    expect(String(item.changeList).split('\n')).toHaveLength(17);
    expect((item.steps as { steps: unknown[] }).steps.some((s) => Object.hasOwn(s as object, 'write'))).toBe(false);
    // The names of its secret variables, for the approval email to mark them (shown, not reviewed: never a value).
    expect(item.secretVariables).toEqual(['password']);
    // For the review page: Enter in the password field signs in, so it starts unticked there. Only a recording marks the
    // steps its import added (a UiPath project's waits come from its own activities).
    expect(item.writeCandidates).toEqual([{ step: 4, intent: 'Press Enter in Password', signsIn: true }, { step: 16, intent: 'Click Save' }]);
    expect((item.reviewSteps as IDataObject[]).filter((r) => r.added)).toEqual([]);
  });

  it('a project with browser steps still needs the RPA Browser credential', async () => {
    const xaml = `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence>
      <uix:NApplicationCard DisplayName="Use Browser"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence><uix:NClick DisplayName="Click 'Go'"><uix:NClick.Target><uix:TargetAnchorable FullSelectorArgument="&lt;webctrl tag='BUTTON' aaname='Go' /&gt;" /></uix:NClick.Target></uix:NClick></Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp Url="https://portal.example.com/" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard></Sequence></Activity>`;
    const [data] = await executeImportSteps(harness({ params: importParams, items: [fileItem(Buffer.from(xaml))], continueOnFail: true }), noBrowser());
    expect(data[0].json.error).toBe('The project has browser steps: attach an RPA Browser credential to replay them.');
    expect((data[0].json.details as IDataObject).report).toBeDefined();
    // On a node set to A Windows desktop app the browser slot is hidden: the message says where it shows.
    const onDesktop = { ...importParams, runsOn: 'desktop' };
    const [hidden] = await executeImportSteps(harness({ params: onDesktop, items: [fileItem(Buffer.from(xaml))], credentials: { playwrightBrowserApi: { mode: 'local' } }, continueOnFail: true }), noBrowser());
    expect(hidden[0].json.error).toBe('The project has browser steps: attach an RPA Browser credential to replay them. Its slot shows when Runs On is A browser or Browser and desktop apps.');
  });

  it('Runs On does not change what is imported; a slot it hides is not passed on to the workflow file', async () => {
    const credentials = { rpaDesktopRunnerApi: { connectionLine: 'x' }, playwrightScriptSigningApi: { secretKey: KEY } };
    const workflowOf = (item: INodeExecutionData) => JSON.parse(Buffer.from(item.binary!.workflow.data, 'base64').toString('utf8')) as { nodes: { type: string; parameters: IDataObject; credentials?: IDataObject }[] };
    const runOf = async (runsOn?: string) => {
      const [data, repaired] = await executeImportSteps(harness({ params: { ...importParams, ...(runsOn ? { runsOn } : {}) }, items: [fileItem(sampleZip())], credentials, continueOnFail: true }), noBrowser());
      expect(data[0].json.error).toBeUndefined();
      expect(repaired).toHaveLength(1);
      return workflowOf(data[0]).nodes.find((n) => n.type === 'n8n-nodes-rpa.playwright')!;
    };
    const ref = (type: string) => ({ id: 'cred-1', name: `${type} credential` });
    const passedOn = { rpaDesktopRunnerApi: ref('rpaDesktopRunnerApi'), playwrightScriptSigningApi: ref('playwrightScriptSigningApi') };
    expect((await runOf()).credentials).toEqual(passedOn);
    expect((await runOf('desktop')).credentials).toEqual(passedOn);
    // Set to A browser, the runner slot is hidden: the generated desktop node names the runner by name, as without one.
    const onBrowser = await runOf('browser');
    expect(onBrowser.parameters.runsOn).toBe('desktop');
    expect(onBrowser.credentials).toEqual({ rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' }, playwrightScriptSigningApi: ref('playwrightScriptSigningApi') });
  });

  it('the workflow file wires a desktop Run steps on the RPA Desktop Runner credential with the variables to fill in', async () => {
    const r = engine.importSource('uipath', sampleZip(), { name: 'erp', hasSiteLogin: false });
    const wf = buildWorkflow(r.flow!, r.drafts, { name: 'erp', desktopDrafts: r.desktopDrafts });
    const run = wf.nodes.find((n) => n.type === 'n8n-nodes-rpa.playwright')!;
    // Named after its step list (the name typed, and the sequence's number), as Get active steps, the notes and the run
    // log name it: never after the project's first activity (Open Application 'ERP Demo - Sign in').
    expect(run.name).toBe('erp-1');
    expect(run.parameters).toEqual({
      operation: 'runSteps', runsOn: 'desktop', steps: "={{ $('Get active steps (erp-1)').first().json.steps ?? '' }}", requireSignedSteps: true,
      signature: "={{ $('Get active steps (erp-1)').first().json.signature }}", approvedBy: "={{ $('Get active steps (erp-1)').first().json.approvedBy }}", aiRepair: false,
      options: {
        name: 'erp-1', expectedVersion: "={{ $('Get active steps (erp-1)').first().json.version }}",
        // The secret one (password) is not here: it comes from the RPA Secret Variables credential the note names. The
        // others start with what the project passes in (Main's variable defaults); username has none.
        variables: { values: [
          { name: 'username', value: '' }, { name: 'in_CompanyCode', value: '1000' }, { name: 'in_DateFrom', value: '2026-01-01' }, { name: 'in_DateTo', value: '2026-12-31' },
        ] },
      },
    });
    expect(run.credentials).toEqual({ rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' } });
    // No chat model and no Approve steps for desktop steps (no AI repair yet); no secret anywhere in the file.
    expect(wf.nodes.map((n) => n.type)).not.toContain('@n8n/n8n-nodes-langchain.lmChatAnthropic');
    expect(wf.connections['Get active steps (erp-1)'].main).toEqual([[{ node: run.name, type: 'main', index: 0 }]]);
    const get = wf.nodes.find((n) => n.name === 'Get active steps (erp-1)')!;
    expect(get.parameters).toMatchObject({ dataTableId: { value: 'playwright_steps' }, filters: { conditions: [{ keyName: 'name', keyValue: 'erp-1' }, { keyName: 'status', keyValue: 'active' }] } });
    const gold = wf.nodes.find((n) => n.name === 'Fill in the variables (erp-1)')!;
    expect(String(gold.parameters.content)).toBe('### Fill in the variables (gold)\nOn **erp-1**, Options → Variables: `username`, `in_CompanyCode` (starts as `1000`), `in_DateFrom` (starts as `2026-01-01`), `in_DateTo` (starts as `2026-12-31`). Desktop steps run only once approved: import the project with **RPA: 5 Import a bot** and approve `erp-1` on its review page.\nSecret: make an **RPA Secret Variables** credential, select it on **erp-1**, and copy these into it. Type the value there, never here.\n```\nCredential: RPA Secret Variables\nName: password\nMay Be Typed Into: ErpDemo.exe\n```');
    expect(run.notes).toContain('password: put it in an RPA Secret Variables credential and select it here.');
    const credentialSticky = wf.nodes.find((n) => n.name.startsWith('Credential:'))!;
    expect(String(credentialSticky.parameters.content)).toContain("Desktop steps type the user name and password from their Run steps' **Variables**");
    expect(String(wf.nodes[1].parameters.content)).toContain('- **RPA Secret Variables**: make one, pick it on the Run steps that name its variables, and copy these into it. Type each value there, never in this workflow.\n```\nCredential: RPA Secret Variables\nName: password\nMay Be Typed Into: ErpDemo.exe\n```');
    expect(wf.description).toBe('Imported from the UiPath project ERP Demo Line Items: 0 browser sequences and 1 desktop sequence as signed RPA steps, 0 other activities as n8n nodes, 0 not translated.');
    expect(JSON.stringify(wf)).not.toContain(ERP_PASSWORD);
  });
});

describe('approving imported desktop steps: Sign Steps with Write Steps', () => {
  it('signs the reviewed steps with exactly the declared writes; the record verifies in Run Steps and the run returns the CSV', async () => {
    const { repaired } = await importSample();
    const record = await sign(repaired[0].json, { writeSteps: '16' });
    expect(record).toMatchObject({ name: 'erp-1', version: 1, status: 'active', approvedBy: APPROVER, approvedAt: '2026-10-29T12:00:00.000Z' });
    const steps = JSON.parse(String(record.steps)) as { steps: { write?: boolean }[] };
    expect(steps.steps.flatMap((s, i) => (s.write ? [i + 1] : []))).toEqual([16]);
    // The template saves the record over the pending row of the reviewed hash: the signed hash differs (the write flag).
    expect(record.hash).not.toBe(repaired[0].json.hash);

    runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY });
    const variables = { values: [['username', ERP_USER], ['password', ERP_PASSWORD], ['in_CompanyCode', '1000'], ['in_DateFrom', '2026-01-01'], ['in_DateTo', '2026-12-31']].map(([name, value]) => ({ name, value })) };
    const params = {
      operation: 'runSteps', steps: record.steps, startUrl: '', requireSignedSteps: true, signature: record.signature, approvedBy: record.approvedBy, aiRepair: false, goal: '',
      options: { name: 'erp-1', expectedVersion: 1, saveTrace: 'never', variables, timeout: 3000 },
    };
    const [data] = await executeRunSteps(harness({ params, credentials: { rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } }, continueOnFail: true }), fakeEngine(() => { throw new Error('no browser'); }));
    const json = data[0].json;
    expect(json.error).toBeUndefined();
    expect(json).toMatchObject({ name: 'erp-1', version: 1, values: { out_ResultCount: '12 line items', out_FirstDocument: '1000-0001' } });
    expect(json.files).toEqual([expect.objectContaining({ fileName: 'line-items.csv', mimeType: 'text/csv', binaryProperty: 'file_16' })]);
    expect(Buffer.from(data[0].binary!.file_16.data, 'base64').toString('utf8')).toBe(erpCsv(erpLineItems('1000', '2026-01-01', '2026-12-31')));
    expect(JSON.stringify(json)).not.toContain(ERP_PASSWORD);
  });

  it('refuses Write Steps it cannot apply, Write Steps on browser steps, and edited desktop steps; a rejection records the reviewed hash', async () => {
    const { repaired } = await importSample();
    const item = repaired[0].json;
    expect(String((await sign(item, { writeSteps: '1' })).error)).toContain('Write Steps: step 1 is a waitFor step, which cannot be a write');
    expect(String((await sign(item, { writeSteps: 'save' })).error)).toContain('Write Steps must list step numbers, such as 7, 9');
    const edited: IDataObject = { ...item, steps: { ...(item.steps as IDataObject), app: { exe: 'Other.exe' } } };
    expect(String((await sign(edited)).error)).toContain('the evidence, change list or safety line changed after it was reviewed');
    const { safetyLine: _s, ...noSafetyLine } = item;
    expect(String((await sign(noSafetyLine)).error)).toContain('the evidence, change list or safety line changed after it was reviewed');
    // A typed value changed, the item's lines left as they were: the engine's hash check refuses it.
    const steps = structuredClone(item.steps) as { steps: { fill?: { value: string } }[] };
    steps.steps[1].fill!.value = 'someone-else';
    const { evidenceLine: _e, ...bare } = { ...item, steps } as IDataObject;
    expect(String((await sign(bare)).error)).toContain('the steps do not match the hash that was reviewed');
    // Desktop steps are reviewed as written: without the change list the approver read, the item is refused.
    const { changeList: _c, ...noChangeList } = item;
    expect(String((await sign(noChangeList)).error)).toContain('the evidence, change list or safety line changed after it was reviewed');
    const browserItem = { ...item, steps: { name: 'erp-1', version: 1, startUrl: 'https://example.com/', steps: [{ intent: 'Open', goto: 'https://example.com/' }] } };
    expect(String((await sign(browserItem, { writeSteps: '1' })).error)).toContain('Write Steps applies to desktop steps only: clear it for browser steps.');
    expect(await sign(item, { approved: false, writeSteps: '16' })).toMatchObject({ status: 'rejected', hash: item.hash, steps: '' });
  });

  it('numbers the change list for desktop steps, and Sign Steps names the steps it signed as writes with their intents', async () => {
    const { repaired } = await importSample();
    const item = repaired[0].json;
    const lines = String(item.changeList).split('\n');
    expect(lines).toHaveLength(17);
    lines.forEach((l, i) => expect(l.startsWith(`Step ${i + 1}: `), l).toBe(true));
    expect(lines[15]).toMatch(/^Step 16: Click Save \(click "Button" id "1" /);
    // The numbered list is recomputed from the digest's fields, so the signature check still holds.
    const record = await sign(item, { writeSteps: '16' });
    expect(record).toMatchObject({ status: 'active', writeSteps: [{ step: 16, intent: 'Click Save' }], writeLine: 'Signed as writes: step 16 (Click Save)' });
    const two = await sign(item, { writeSteps: '4, 16' });
    expect(two).toMatchObject({ writeSteps: [{ step: 4, intent: 'Press Enter in Password' }, { step: 16, intent: 'Click Save' }], writeLine: 'Signed as writes: step 4 (Press Enter in Password), step 16 (Click Save)' });
    const none = await sign(item, { writeSteps: '' });
    expect(none).toMatchObject({ status: 'active', writeSteps: [], writeLine: 'Signed as writes: none' });
  });

  it('says plainly that an unlisted step can still save unless the runner policy lists its control', async () => {
    const { repaired } = await importSample();
    expect(String(repaired[0].json.safetyLine)).toContain(
      'candidate write: step 16 (Click Save) may save, post or submit',
    );
    const { signStepsProperties } = await import('../nodes/Playwright/description/signSteps.js');
    const description = String(signStepsProperties.find((p) => p.name === 'writeSteps')!.description);
    expect(description).toContain('leaving a step unlisted does not stop it from saving unless its control is in the runner policy');
    expect(description).not.toContain('Only these steps may act');
  });

  it('a Site Login on Sign Steps is not bound into a desktop signature (desktop runs refuse one)', async () => {
    const { repaired } = await importSample();
    const record = await sign(repaired[0].json, {}, { playwrightSiteLoginApi: { loginUrl: 'https://login.example.com/', username: 'someone', password: 'Long-password-1' } });
    expect(record.status).toBe('active');
    expect(engine.checkDesktopTrust(JSON.parse(String(record.steps)), { required: true, signature: String(record.signature), approvedBy: APPROVER, key: KEY })).toEqual({ ok: true, signed: true });
  });
});

describe('RPA: 5 Import a bot with a desktop project', () => {
  it('with approval by email, the completion page counts the desktop step lists waiting for approval without a replay', async () => {
    const t = JSON.parse(readFileSync(new URL('../templates/5-import-a-bot.json', import.meta.url), 'utf8')) as { nodes: { name: string; parameters: Record<string, unknown> }[] };
    const message = String(t.nodes.find((n) => n.name === 'Imported')!.parameters.completionMessage);
    const { data } = await importSample();
    // $('<node>') as n8n gives it: Import steps ran, the review page did not, Settings say by email and Approve steps names its workflow.
    const ran: Record<string, { json: unknown }[][]> = { 'Import steps': [data], Settings: [[{ json: { approval: 'by email' } }]] };
    const $ = (name: string) => ({
      isExecuted: name in ran, params: name === 'Approve steps' ? { workflowId: { value: 'wf-3' } } : {},
      first: (branch = 0) => ran[name][branch][0], all: (branch = 0) => ran[name][branch] ?? [],
    });
    const render = (text: string) => text.replace(/^=/, '').replace(/\{\{(.+?)\}\}/gs, (_, code: string) => String(new Function('$', `return (${code});`)($)));
    const shown = render(message);
    expect(shown).toContain('\n1 desktop step list is waiting for approval in RPA: 3 Approve steps, not replayed: review every step');
    expect(shown).not.toContain('passed the replay');
  });
});

const RECORDING = fileURLToPath(new URL('../../engine/test/fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
type Json = Record<string, any>;
/** A fresh copy of the ERP Demo recording the engine's fixture holds. */
const recording = (): Json => JSON.parse(readFileSync(RECORDING, 'utf8'));
const recordingItem = (rec: Json): INodeExecutionData => {
  const data = Buffer.from(JSON.stringify(rec));
  return { json: {}, binary: { data: { data: data.toString('base64'), mimeType: 'application/json', fileName: 'erp.rpa-recording.json', bytes: data.length } } };
};
const recordingParams = { ...importParams, source: 'recording' };
async function importRecording(rec: Json = recording(), over: Record<string, unknown> = {}, credentials: HarnessOptions['credentials'] = {}) {
  const [data, repaired] = await executeImportSteps(harness({ params: { ...recordingParams, ...over }, items: [recordingItem(rec)], credentials, continueOnFail: true }), noBrowser());
  return { data, repaired };
}
const RECORDING_LINE = 'Not replayed: desktop steps imported from a recording are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.';

describe('Import Steps with an RPA recording', () => {
  it('Import Steps offers RPA Recording and reads it only from a file', async () => {
    // Input From is hidden for a recording, as for a UiPath project: a pasted text left in the node is not read.
    const { data } = await importRecording(recording(), { inputFrom: 'text', sourceText: 'not a recording' });
    expect(data[0].json.error).toBeUndefined();
    expect(data[0].json.report).toMatchObject({ source: 'recording', steps: 17 });
  });

  it('a recording imports without an RPA Browser credential', async () => {
    const { data, repaired } = await importRecording();
    expect(data[0].json.error).toBeUndefined();
    expect(repaired).toHaveLength(1);
    // An Expected File left on the node is not used, so a CDP browser credential does not refuse the import either.
    const cdp = await importRecording(recording(), { expectedFile: { file: { namePattern: '^line-items' } } }, { playwrightBrowserApi: { mode: 'cdp', wsUrl: 'wss://cdp.example.net/' } });
    expect(cdp.data[0].json.error).toBeUndefined();
    expect(cdp.repaired).toHaveLength(1);
  });

  it('the ERP Demo recording gives a desktop entry for approval with writeCandidates [4, 16] and a workflow file', async () => {
    const { data, repaired } = await importRecording();
    const json = data[0].json;
    expect(json.drafts).toEqual([expect.objectContaining({
      name: 'erp', surface: 'desktop', adopted: false, forApproval: true, writeCandidates: [4, 16], variables: ['password'], secretVariables: ['password'],
      reason: 'Desktop steps are not replayed at import: they go to approval as imported. Review every step, and mark each step that saves, posts or submits as a write when you approve.',
    })]);
    expect(json.workflowName).toBe('ERP Demo line items (imported from a recording)');
    expect(data[0].binary?.workflow).toMatchObject({ mimeType: 'application/json', fileName: 'erp.workflow.json' });
    const item = repaired[0].json;
    expect(item).toMatchObject({ name: 'erp', baseVersion: null, version: 1, attachmentNames: '' });
    expect(String(item.changeList).split('\n')).toHaveLength(17);
    expect(String(item.safetyLine)).toContain('candidate write: step 16 (Click Save) may save, post or submit');
    // For the review page: the key that signs in (step 4, Enter in Password) and the steps the import added (the waits for
    // each window, the returned file). Shown only: neither is signed or reviewed.
    expect(item.writeCandidates).toEqual([{ step: 4, intent: 'Press Enter in Password', signsIn: true }, { step: 16, intent: 'Click Save' }]);
    expect((item.reviewSteps as IDataObject[]).flatMap((r, i) => (r.added ? [i + 1] : []))).toEqual([1, 5, 12, 14, 17]);
  });

  it('the approval evidence line for a recording says it was imported from a recording, and for a UiPath project it is unchanged', async () => {
    const { repaired } = await importRecording();
    expect(repaired[0].json.evidenceLine).toBe(RECORDING_LINE);
    const uipath = await importSample();
    expect(uipath.repaired[0].json.evidenceLine).toBe('Not replayed: desktop steps imported from UiPath are reviewed as written (there is no desktop proof yet). Check every step, and mark each step that saves, posts or submits as a write.');
    // Sign Steps takes the recording's item, with its line, and signs exactly the declared writes.
    const record = await sign(repaired[0].json, { writeSteps: '4, 16' });
    expect(record).toMatchObject({ name: 'erp', version: 1, status: 'active', writeLine: 'Signed as writes: step 4 (Press Enter in Password), step 16 (Click Save)' });
    // The line is one Sign Steps knows: another text is refused.
    expect(String((await sign({ ...repaired[0].json, evidenceLine: RECORDING_LINE.replace('a recording', 'somewhere') })).error)).toContain('changed after it was reviewed');
  });

  it('Sign Steps refuses an item whose shown steps (reviewSteps) are not those its steps give; an honest item and one without them sign', async () => {
    const REFUSED = 'Sign Steps refused: the steps shown for approval are not the steps to sign: import the steps again';
    for (const { repaired } of [await importSample(), await importRecording()]) {
      const item = repaired[0].json;
      const shown = item.reviewSteps as { text: string; marks: string[]; added?: true }[];
      const click = shown.findIndex((r) => r.text.startsWith('Click '));
      const forge = async (list: unknown) => {
        const out = await sign({ ...item, reviewSteps: list as IDataObject[] }, { writeSteps: '16' });
        expect(out.error).toBe(REFUSED);
        expect(out).not.toHaveProperty('signature');
      };
      // A text that says something else, an entry missing or added, a click shown as one the import added, a secret
      // variable shown as a plain one.
      await forge(shown.map((r, i) => (i === click ? { ...r, text: 'Click Cancel' } : r)));
      await forge(shown.slice(1));
      await forge([...shown, { text: 'Click Save', marks: [] }]);
      await forge(shown.map((r, i) => (i === click ? { ...r, added: true } : r)));
      const secret = shown.findIndex((r) => r.marks.some((m) => m.startsWith('secret variable')));
      await forge(shown.map((r, i) => (i === secret ? { ...r, marks: r.marks.map((m) => m.replace('secret variable', 'variable')) } : r)));
      // Honest, and without the shown list (an older item): both sign.
      expect(await sign(item, { writeSteps: '16' })).toMatchObject({ status: 'active' });
      const { reviewSteps: _r, ...older } = item;
      expect(await sign(older, { writeSteps: '16' })).toMatchObject({ status: 'active' });
    }
    // A recording's start value for a plain variable is not on the item: shown, not compared (the email leaves it out).
    // It only adds to a mark, never to the sentence.
    const { repaired } = await importSample();
    const started = (repaired[0].json.reviewSteps as { text: string; marks: string[] }[])
      .map((r) => ({ ...r, marks: r.marks.map((m) => (m.startsWith('variable in_CompanyCode') ? 'variable in_CompanyCode, starts as 2000' : m)) }));
    expect(JSON.stringify(started)).toContain('starts as 2000');
    expect(await sign({ ...repaired[0].json, reviewSteps: started as unknown as IDataObject[] }, { writeSteps: '16' })).toMatchObject({ status: 'active' });
  });

  it('the generated workflow\'s desktop pair and name say "recording"', async () => {
    const r = engine.importSource('recording', readFileSync(RECORDING), { name: 'erp', hasSiteLogin: false });
    const wf = buildWorkflow(r.flow!, r.drafts, { name: 'erp', desktopDrafts: r.desktopDrafts, source: 'recording' });
    expect(wf.name).toBe('ERP Demo line items (imported from a recording)');
    expect(wf.description).toBe('Imported from the recording ERP Demo line items: 1 desktop step list as signed RPA steps.');
    const run = wf.nodes.find((n) => n.type === 'n8n-nodes-rpa.playwright')!;
    expect(run.name).toBe('ERP Demo line items');
    // The recording's only variable, password, is secret: no Variables here, the RPA Secret Variables credential holds it.
    expect(run.parameters).toMatchObject({ operation: 'runSteps', aiRepair: false, options: { name: 'erp' } });
    expect(run.parameters.options).not.toHaveProperty('variables');
    expect(run.credentials).toEqual({ rpaDesktopRunnerApi: { id: null, name: 'RPA Desktop Runner' } });
    expect(run.notes).toBe('Runs the signed desktop steps erp on the desktop runner. Pick RPA Desktop Runner and RPA Step Signing here. password: put it in an RPA Secret Variables credential and select it here.');
    const gold = String(wf.nodes.find((n) => n.name === 'Fill in the variables (erp)')!.parameters.content);
    expect(gold).toContain('import the recording with **RPA: 5 Import a bot**');
    const text = JSON.stringify(wf);
    expect(text).not.toMatch(/UiPath|project/);
  });

  it('a step the recording drops (nothing left to find its element by) is listed in leftOut', async () => {
    const rec = recording();
    rec.events.splice(10, 0, {
      at: '2026-11-10T22:59:31.0000000+00:00', kind: 'click', label: 'Refresh',
      target: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' }, path: [{ controlType: 'Button', automationId: '3f2a9c1e-77b0-4c1d-9a55-0123456789ab' }] },
    });
    const { data, repaired } = await importRecording(rec);
    expect(data[0].json.error).toBeUndefined();
    const line = '2026-11-10T22:59:31.0000000+00:00, Refresh: the automation id looks generated (it may change from run to run) and nothing else names the element, so this step was left out: add it by hand';
    expect(repaired[0].json.leftOut).toEqual([line]);
    expect(String(repaired[0].json.leftOutList)).toContain('Refresh');
    // Converted steps (the generated id dropped, the row position) are notes, not left out.
    expect(String(repaired[0].json.leftOutList)).not.toContain('row position');
  });

  it('a recording named ={{ $env.SECRET }} reaches the workflow file only as plain text', async () => {
    // The engine refuses every {{$...}} template in a recording: nothing is imported and no workflow file is written.
    const refused = recording();
    refused.name = '={{ $env.SECRET }}';
    const { data: none } = await importRecording(refused);
    expect(String(none[0].json.error)).toBe("Nothing was imported: the recording is not valid, so nothing was imported: name holds a {{$...}} template: only a fill's value may hold {{$exportDir}}");
    expect(none[0].binary?.workflow).toBeUndefined();
    // An expression without a $ passes the engine: in the workflow file it is only text.
    const rec = recording();
    rec.name = '={{ process.env.SECRET }}';
    rec.events[8].label = '={{ process.env.SECRET }}';
    const { data } = await importRecording(rec);
    expect(data[0].json.error).toBeUndefined();
    const wf = JSON.parse(Buffer.from(data[0].binary!.workflow.data, 'base64').toString('utf8')) as { name: string; nodes: { name: string; parameters: Record<string, unknown>; notes?: string }[] };
    // Every parameter n8n would read as an expression is one the generator wrote; none holds the recording's text.
    const expressions: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') { if (v.startsWith('=')) expressions.push(v); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const n of wf.nodes) walk(n.parameters);
    expect(expressions.length).toBeGreaterThan(0);
    for (const e of expressions) expect(e).not.toContain('process.env');
    for (const n of wf.nodes) expect(n.name.startsWith('='), n.name).toBe(false);
    expect(wf.name).toBe('{{ process.env.SECRET }} (imported from a recording)');
    // The text is still there to read, as text: in the About sticky.
    expect(String(wf.nodes.find((n) => n.name === 'About this import')!.parameters.content)).toContain('`{{ process.env.SECRET }}`');
  });
});

describe('review page hints for desktop steps', () => {
  const field = (automationId: string, title = 'Sign in') => ({ uia: { window: { exe: 'app.exe', title }, path: [{ controlType: 'Edit', automationId }] } });
  /** The same target written with its keys in another order (as two recorded events may be). */
  const reordered = (automationId: string) => ({ uia: { path: [{ automationId, controlType: 'Edit' }], window: { title: 'Sign in', exe: 'app.exe' } } });
  const steps: DesktopStep[] = [
    { intent: 'Type into User name', fill: { field: field('user'), value: '{{var.username}}' } },
    { intent: 'Press Enter in User name', key: { key: 'Enter', target: field('user') } },
    { intent: 'Type into Password', fill: { field: field('pw'), value: '{{ var.password }}' } },
    { intent: 'Press Enter in Password', key: { key: 'Enter', target: reordered('pw') } },
    { intent: 'Press Enter', key: { key: 'Enter' } },
    { intent: 'Type into Code', fill: { field: field('code', 'Code'), value: 'x{{var.otp}}' } },
    { intent: 'Press Enter', key: { key: 'Enter' } },
    { intent: 'Press Enter in Password on another window', key: { key: 'Enter', target: field('pw', 'Other') } },
  ];
  it('a key pressed in a field a secret variable is typed into, or with no target right after such a fill, is a sign-in key', () => {
    expect(signInKeySteps(steps, ['password', 'otp'])).toEqual([4, 7]);
    // Step 5 follows a key, not the fill; step 8 is another window's field.
    expect(signInKeySteps(steps, ['username'])).toEqual([2]);
    expect(signInKeySteps(steps, [])).toEqual([]);
  });
  it('the steps an import adds to a recording are its window waits and its returned files', () => {
    const wait: DesktopStep = { intent: 'Wait for the window Sign in', waitFor: { target: field('user') } };
    const file: DesktopStep = { intent: 'Return the exported file a.csv', expectFile: { pattern: '^a\\.csv$' } };
    expect(importAddedSteps([wait, steps[0], steps[1], wait, file])).toEqual([1, 4, 5]);
    expect(importAddedSteps(steps)).toEqual([]);
  });
});
