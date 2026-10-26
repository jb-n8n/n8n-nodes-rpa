import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeHelpers, NodeOperationError, type IDataObject, type INodeExecutionData, type INodeProperties, type INodePropertyOptions } from 'n8n-workflow';
import * as real from 'n8n-rpa-engine';
import type { AdoptInput, AdoptResult, Draft, ImportResult, Script } from 'n8n-rpa-engine';
import { zip } from '../../engine/test/zip-fixtures.js';
import { OPERATIONS } from '../nodes/Playwright/description/index.js';
import { nodeInputs, nodeOutputs } from '../nodes/Playwright/description/io.js';
import type { Engine } from '../nodes/Playwright/engine.js';
import { resetGuardsForTests } from '../nodes/Playwright/guard.js';
import { memoryGuardStore } from '../nodes/Playwright/guard-store.js';
import { executeImportSteps, MAX_IMPORT_BYTES, STEPS_WITHHELD } from '../nodes/Playwright/operations/importSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { repairedStepsJson } from '../nodes/Playwright/output.js';
import { DISPATCH, Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine } from './fake-engine.js';
import { credentialsV2, nodeContext, signStepsParams, siteLoginData } from './feed-fixtures.js';
import { SECRETS } from './fixtures.js';
import type { Harness } from './harness.js';

afterEach(() => resetGuardsForTests());

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
const FILE_TOO_LARGE = 'The file is larger than 20 MiB, so it was not read.';
const TEXT_TOO_LARGE = 'Recording or Code is larger than 20 MiB, so it was not read.';
const NAME_REQUIRED = 'Name is required: it names the imported steps.';
const NAME_EQUALS = 'Name must not start with "=".';
const CDP_DOWNLOAD =
  'Downloads need the Browser Server or Local Browser mode: a Chrome DevTools Protocol (CDP) connection cannot read downloaded files. Pick an RPA Browser credential in Browser Server mode for this node.';
const NO_MODEL = 'AI repair is on but no chat model is connected. Connect one to the Model input.';
const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;

const SITE = { url: 'https://erp.example.com', host: 'erp.example.com' };
const ENGINE_FIXTURES = new URL('../../engine/test/fixtures/import/', import.meta.url);
const CHROME = readFileSync(new URL('chrome-sap-export.json', ENGINE_FIXTURES), 'utf8').split('http://localhost:8080').join(SITE.url);
const BROWSER = { mode: 'local', headless: true };
const CREDS = { playwrightBrowserApi: BROWSER, playwrightSiteLoginApi: siteLoginData(SITE) };
const VARIABLES = { values: [{ name: 'company', value: '1000' }, { name: 'from', value: '2026-09-01' }, { name: 'to', value: '2026-09-30' }] };
const EXPECTED_FILE = { file: { fileType: ['csv'], namePattern: '^LINEITEMS_1000_', requiredColumns: 'Document, Amount', minRows: 1 } };
const SEPTEMBER = 'LINEITEMS_1000_2026-09-01_2026-09-30.csv';

function params(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'importSteps', source: 'chrome', inputFrom: 'binary', binaryPropertyName: 'data', stepsName: 'sap-export', startUrl: '', aiRepair: false, goal: '',
    idPattern: '', expectedFile: EXPECTED_FILE, options: { variables: VARIABLES, saveTrace: 'never', ...options }, ...over,
  };
}
const fileItem = (data: Buffer | string, fileName = 'recording.json', mimeType = 'application/json'): INodeExecutionData => {
  const bytes = Buffer.from(data);
  return { json: {}, binary: { data: { data: bytes.toString('base64'), mimeType, fileName, bytes: bytes.length } } };
};

// ---- the UiPath fixture project, zipped as a user would upload it ----
const UIPATH_DIR = fileURLToPath(new URL('uipath-sap-report/', ENGINE_FIXTURES));
function projectZip(): Buffer {
  const entries: { name: string; raw: Buffer; usize: number }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const data = readFileSync(path);
        entries.push({ name: `SAP Line Item Report/${relative(UIPATH_DIR, path).split('\\').join('/')}`, raw: deflateRawSync(data), usize: data.length });
      }
    }
  };
  walk(UIPATH_DIR);
  return zip(entries);
}

type ImportEngine = Engine & { readonly adoptions: AdoptInput[]; readonly imports: Parameters<Engine['importSource']>[] };

/**
 * The real engine's pure functions (importSource included), with adoptDraft scripted and runTask and openSession
 * refused: no browser opens. `importSource` may be replaced to return hand-built drafts (several UiPath sequences).
 */
function importEngine(
  adopt: (input: AdoptInput, call: number) => AdoptResult | Promise<AdoptResult>,
  importSource?: (...args: Parameters<Engine['importSource']>) => ImportResult,
): ImportEngine {
  const adoptions: AdoptInput[] = [];
  const imports: Parameters<Engine['importSource']>[] = [];
  const base = fakeEngine(() => {
    throw new Error('Import Steps never calls runTask');
  });
  return Object.assign(base, {
    adoptions,
    imports,
    importSource: (...args: Parameters<Engine['importSource']>) => {
      imports.push(args);
      return (importSource ?? real.importSource)(...args);
    },
    adoptDraft: async (input: AdoptInput) => {
      adoptions.push(input);
      return adopt(input, adoptions.length - 1);
    },
  });
}

/** What adoptDraft returns for a clean import: the draft proved as version 1 by the real proposal builder (adopt.ts, script lane). */
function proved(input: AdoptInput, over: { lane?: 'script' | 'agent'; llmCalls?: number } = {}): AdoptResult {
  const script: Script = { ...input.draft, version: 1 };
  const download = script.steps.some((s) => 'download' in s);
  const prove = {
    ok: true, rows: [], total: null, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [],
    ...(download ? { file: { fileName: SEPTEMBER, mimeType: 'text/csv', bytes: 2048, columns: ['Document', 'Amount'], rows: 12 } } : {}),
  };
  const masker = real.createMasker([input.secrets?.username, input.secrets?.password, input.secrets?.totpSecret]);
  const proposal = real.buildProposal({
    script, prove, masker, afterScreenshot: Buffer.from('after-png'),
    safetyFlags: real.validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags,
  });
  return { ok: true, lane: over.lane ?? 'script', proposal, digest: real.proposalDigest(proposal), llmCalls: over.llmCalls ?? 0, durationMs: 1000 };
}
const adoptFailure = (code: Extract<AdoptResult, { ok: false }>['code'], message: string, over: Partial<Extract<AdoptResult, { ok: false }>> = {}): AdoptResult => ({
  ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 900, lane: 'script', ...over,
});
const NOT_ADOPTABLE = `${real.IMPORT_NOT_ADOPTABLE} Screenshot, PDF and read steps cannot be proved.`;

/** The Chrome fixture's draft, renamed: hand-built UiPath drafts reuse its steps. */
function chromeDraft(name: string): Draft {
  const r = real.importSource('chrome', CHROME, {
    name, hasSiteLogin: true, secrets: SECRETS, vars: { company: '1000', from: '2026-09-01', to: '2026-09-30' },
    download: { mime: ['text/csv'], check: { name: '^LINEITEMS_1000_' } },
  });
  const draft = r.drafts[0];
  if (!draft) throw new Error('the Chrome fixture gave no draft');
  return draft;
}
/** A UiPath import of `n` browser sequences: drafts `sap-report-1` … `sap-report-n` and the flow around them. */
function uipathResult(n: number, report: Partial<ImportResult['report']> = {}): () => ImportResult {
  return () => ({
    drafts: Array.from({ length: n }, (_, k) => chromeDraft(`sap-report-${k + 1}`)),
    report: { source: 'uipath', steps: 9 * n, items: [], ...report },
    flow: { name: 'SAP Report', nodes: Array.from({ length: n }, (_, k) => ({ kind: 'browser' as const, sequence: k + 1, displayName: `Use Browser ${k + 1}` })) },
  });
}

/** A trace zip as the engine's trace scrubber reads it (the hand-built zip, with the end record's per-disk entry count set too). */
function traceZip(entries: Record<string, string>): Buffer {
  const out = zip(Object.entries(entries).map(([name, text]) => ({ name, raw: deflateRawSync(Buffer.from(text)), usize: Buffer.byteLength(text) })));
  out.writeUInt16LE(Object.keys(entries).length, out.length - 14);
  return out;
}
/** The entries of a zip the engine wrote (local headers carry the sizes): name → text. */
function unzipTexts(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at + 30 <= data.length && data.readUInt32LE(at) === 0x04034b50) {
    const method = data.readUInt16LE(at + 8);
    const size = data.readUInt32LE(at + 18);
    const nameLength = data.readUInt16LE(at + 26);
    const extra = data.readUInt16LE(at + 28);
    const name = data.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    const raw = data.subarray(start, start + size);
    out[name] = (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    at = start + size;
  }
  return out;
}
const binaryText = (item: INodeExecutionData, key: string) => Buffer.from(String(item.binary?.[key]?.data), 'base64');

interface RunOptions {
  params?: Record<string, unknown>;
  rawParameters?: Record<string, unknown>;
  items?: INodeExecutionData[];
  credentials?: Record<string, IDataObject>;
  model?: unknown;
  continueOnFail?: boolean;
  binaryFileSizes?: Record<string, number>;
}
function context(o: RunOptions = {}): Harness {
  return nodeContext({
    params: o.params ?? params(), ...(o.rawParameters ? { rawParameters: o.rawParameters } : {}), items: o.items ?? [fileItem(CHROME)],
    credentials: (o.credentials ?? CREDS) as never, model: o.model, continueOnFail: o.continueOnFail ?? true, binaryFileSizes: o.binaryFileSizes,
  }) as Harness;
}
const run = (engine: Engine, o: RunOptions = {}, ctx: Harness = context(o)) => executeImportSteps(ctx, engine, { executionsMode: 'regular' });
const details = (item: INodeExecutionData) => item.json.details as IDataObject;
const drafts = (item: INodeExecutionData) => item.json.drafts as IDataObject[];

describe('Import Steps: the description', () => {
  const d = new Playwright().description;
  const own = d.properties.filter((p) => p.name !== 'options' && p.displayOptions?.show?.operation?.includes('importSteps'));
  const field = (name: string): INodeProperties => {
    const p = own.find((x) => x.name === name);
    if (!p) throw new Error(`no Import Steps field "${name}"`);
    return p;
  };
  const optionsFor = (op: string) =>
    ((d.properties.find((p) => p.name === 'options')?.options ?? []) as INodeProperties[]).filter((o) => o.displayOptions?.show?.['/operation']?.includes(op));

  it('Import Steps shows its fields only for importSteps', () => {
    expect(own.map((p) => p.name)).toEqual([
      'importNotice', 'source', 'inputFrom', 'binaryPropertyName', 'sourceText', 'stepsName', 'startUrl', 'aiRepair', 'goal', 'idPattern', 'expectedFile',
    ]);
    for (const p of own) expect(p.displayOptions?.show?.operation, p.name).toEqual(['importSteps']);
    expect((field('source').options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([
      ['Chrome Recorder (JSON)', 'chrome'], ['Playwright Code (JavaScript or TypeScript)', 'playwright'], ['UiPath Project (ZIP or XAML)', 'uipath'],
    ]);
    expect(field('source').default).toBe('chrome');
    expect(field('inputFrom')).toMatchObject({ default: 'binary', displayOptions: { show: { operation: ['importSteps'] }, hide: { source: ['uipath'] } } });
    expect((field('inputFrom').options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['Binary File', 'binary'], ['Text', 'text']]);
    expect(field('binaryPropertyName')).toMatchObject({ displayName: 'Input Binary Field', default: 'data', displayOptions: { hide: { inputFrom: ['text'] } } });
    expect(field('sourceText')).toMatchObject({
      displayName: 'Recording or Code', typeOptions: { rows: 10 }, displayOptions: { show: { operation: ['importSteps'], inputFrom: ['text'] }, hide: { source: ['uipath'] } },
    });
    expect(field('stepsName')).toMatchObject({ displayName: 'Name', required: true, default: '' });
    expect(field('aiRepair')).toMatchObject({ displayName: 'AI Repair', type: 'boolean', default: true });
    expect(field('goal').displayOptions?.show).toEqual({ operation: ['importSteps'], aiRepair: [true] });
    expect(field('idPattern').displayName).toBe('ID Pattern (Regex)');
    const file = field('expectedFile');
    expect(file.displayName).toBe('Expected File (First Version)');
    expect((file.options as { values: INodeProperties[] }[])[0].values.map((v) => v.displayName)).toEqual([
      'File Type', 'File Name Pattern (Regex)', 'Minimum Size (Bytes)', 'Required Columns', 'Minimum Rows',
    ]);
    expect(optionsFor('importSteps').map((o) => o.name)).toEqual([
      'timeout', 'maxSeconds', 'viewport', 'allowedHosts', 'allowPrivateNetwork', 'variables', 'breakerResetKey', 'saveTrace', 'maxItems',
    ]);
    // Credentials: the browser, the Site Login and its Redis guard store. No signing key: Sign Steps signs.
    expect((d.credentials ?? []).filter((c) => NodeHelpers.displayParameter({ operation: 'importSteps' }, c, null, d)).map((c) => c.name)).toEqual([
      'playwrightBrowserApi', 'playwrightSiteLoginApi', 'playwrightRedisApi',
    ]);
    expect((OPERATIONS.options as INodePropertyOptions[]).at(-1)).toEqual({
      name: 'Import Steps', value: 'importSteps', action: 'Import steps from a recording, code or a UiPath bot',
      description: 'Advanced: turn a Chrome Recorder export, Playwright code or a UiPath project into steps for approval',
    });
    expect(Object.keys(DISPATCH)).toContain('importSteps');
  });

  it('says that an import can take about twice Max Seconds, which must leave room for a TOTP wait, and only on Import Steps', () => {
    const maxSeconds = optionsFor('importSteps').filter((o) => o.name === 'maxSeconds');
    expect(maxSeconds).toHaveLength(1);
    expect(maxSeconds[0]).toMatchObject({ default: 180, typeOptions: { minValue: 10, maxValue: 300 } });
    expect(maxSeconds[0].description).toContain('so it can take about twice this. On sites with an authenticator code, Max Seconds must leave room for up to a 30 s wait.');
    // Every other operation shows the plain help, without the import sentence.
    for (const op of ['runSteps', 'screenshot', 'download']) {
      const other = optionsFor(op).filter((o) => o.name === 'maxSeconds');
      expect(other, op).toHaveLength(1);
      expect(other[0].description, op).toBe('One deadline for the whole run, AI repair and proof included');
    }
    const notice = field('importNotice').displayName;
    for (const text of ['no form submissions or writes; Requests That Only Read still pass', 'about twice Options → Max Seconds',
      'On sites with an authenticator code, Max Seconds must leave room for up to a 30 s wait']) expect(notice, text).toContain(text);
  });

  it('has the Model input when AI Repair is on (its default) and always both outputs', () => {
    const MAIN = { type: 'main', displayName: '' };
    const MODEL = { type: 'ai_languageModel', displayName: 'Model', maxConnections: 1, required: false };
    const OUTS = [{ type: 'main', displayName: 'Data' }, { type: 'main', displayName: 'Repaired Steps' }];
    expect(nodeInputs('importSteps', true)).toEqual([MAIN, MODEL]);
    expect(nodeInputs('importSteps', undefined)).toEqual([MAIN, MODEL]);
    expect(nodeInputs('importSteps', '={{ $json.repair }}')).toEqual([MAIN, MODEL]);
    expect(nodeInputs('importSteps', false)).toEqual([MAIN]);
    for (const aiRepair of [true, false, undefined]) expect(nodeOutputs('importSteps', aiRepair)).toEqual(OUTS);
  });

  it('the description has no use-case words and names Playwright only as the code source', () => {
    const texts: string[] = [];
    const visit = (item: unknown): void => {
      if (typeof item !== 'object' || item === null) return;
      const o = item as Record<string, unknown>;
      for (const key of ['displayName', 'name', 'description', 'hint', 'placeholder', 'action']) if (typeof o[key] === 'string') texts.push(o[key] as string);
      for (const key of ['options', 'values']) if (Array.isArray(o[key])) (o[key] as unknown[]).forEach(visit);
    };
    [...own, ...optionsFor('importSteps'), (OPERATIONS.options as INodePropertyOptions[]).find((o) => o.value === 'importSteps')].forEach(visit);
    for (const t of texts) expect(t, t).not.toMatch(USE_CASE_WORDS);
    expect(texts.filter((t) => /playwright/i.test(t))).toEqual([
      'Playwright Code (JavaScript or TypeScript)',
      'Advanced: turn a Chrome Recorder export, Playwright code or a UiPath project into steps for approval',
    ]);
  });
});

describe('Import Steps: execution', () => {
  it('the Chrome source from a binary emits a Repaired Steps item and a report', async () => {
    const engine = importEngine((input) => proved(input));
    const out = await run(engine);
    expect(out).toHaveLength(2);
    const [data, repaired] = out;

    // The import: the file's bytes, the Expected File through Run Steps' helper, the Site Login's secrets and the variables.
    const [source, bytes, opts] = engine.imports[0];
    expect(source).toBe('chrome');
    expect(Buffer.isBuffer(bytes) && bytes.toString('utf8')).toBe(CHROME);
    expect(opts).toEqual({
      name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: { company: '1000', from: '2026-09-01', to: '2026-09-30' },
      download: { mime: ['text/csv'], check: { name: '^LINEITEMS_1000_', columns: ['Document', 'Amount'], minRows: 1 } },
    });

    // The adoption: the draft with the Site Login's policy and secrets, no model (AI Repair off), no ID Pattern.
    expect(engine.adoptions).toHaveLength(1);
    const input = engine.adoptions[0];
    expect(input.draft.name).toBe('sap-export');
    expect(input.draft.steps.some((s) => 'download' in s && s.download.check?.name === '^LINEITEMS_1000_')).toBe(true);
    expect(input.policy).toMatchObject({ startUrl: `${SITE.url}/acme/login`, navHosts: [SITE.host], writeMode: 'fatal', allowPrivateNetwork: false });
    expect(input).toMatchObject({ secrets: SECRETS, vars: { company: '1000', from: '2026-09-01', to: '2026-09-30' }, budgetMs: 180_000, saveTrace: 'never', endpoint: { mode: 'local' } });
    expect(input.output).toBeUndefined();
    expect(input.repair).toBeUndefined();
    expect(input).not.toHaveProperty('trust');
    expect(JSON.stringify(input.draft)).not.toContain(SECRETS.password);

    // Repaired Steps: exactly the item Run Steps emits for the same proposal.
    expect(repaired).toHaveLength(1);
    const proposal = (await proved(input)) as Extract<AdoptResult, { ok: true }>;
    expect(repaired[0].json).toEqual(repairedStepsJson(engine, proposal.proposal, 'after'));
    expect(repaired[0].json).toMatchObject({ name: 'sap-export', baseVersion: null, version: 1 });
    expect(repaired[0].binary?.after).toMatchObject({ mimeType: 'image/png', fileName: 'after-v1.png' });
    expect(repaired[0].pairedItem).toEqual([{ item: 0 }]);

    // Data: the report and the draft, adopted.
    expect(data).toHaveLength(1);
    expect(data[0].json.error).toBeUndefined();
    expect(data[0].json.report).toMatchObject({ source: 'chrome', steps: 9 });
    expect((data[0].json.report as { items: { kind: string }[] }).items.some((i) => i.kind === 'secret')).toBe(true);
    expect(drafts(data[0])).toEqual([{ name: 'sap-export', steps: JSON.parse(JSON.stringify(input.draft)), adopted: true }]);
    expect(data[0].json).not.toHaveProperty('workflowName');
    expect(data[0].binary).toBeUndefined();
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
  });

  it('reads the recording from Text, and a binary from a property other than data', async () => {
    const fromText = importEngine((input) => proved(input));
    const [, repaired] = await run(fromText, { params: params({ inputFrom: 'text', sourceText: CHROME }), items: [{ json: {} }] });
    expect(repaired).toHaveLength(1);
    expect(fromText.imports[0][1]).toBe(CHROME);

    const fromField = importEngine((input) => proved(input));
    const item = fileItem(CHROME);
    const [, other] = await run(fromField, { params: params({ binaryPropertyName: 'recording' }), items: [{ json: {}, binary: { recording: item.binary!.data } }] });
    expect(other).toHaveLength(1);

    const missing = importEngine((input) => proved(input));
    const [data] = await run(missing, { params: params({ binaryPropertyName: 'recording' }) });
    expect(String(data[0].json.error)).toContain("binary file 'recording'");
    expect(details(data[0])).toMatchObject({ configError: true });
    expect(missing.imports).toHaveLength(0);
  });

  it('a UiPath project emits one Repaired Steps item per sequence and the workflow binary', async () => {
    let inFlight = 0;
    let most = 0;
    const engine = importEngine(async (input) => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return proved(input);
    }, uipathResult(2));
    const [data, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }), items: [fileItem('PK', 'bot.zip', 'application/zip')] });
    expect(most).toBe(1); // one adoption at a time
    expect(engine.adoptions.map((a) => a.draft.name)).toEqual(['sap-report-1', 'sap-report-2']);
    expect(repaired.map((r) => r.json.name)).toEqual(['sap-report-1', 'sap-report-2']);
    expect(drafts(data[0]).map((x) => [x.name, x.adopted])).toEqual([['sap-report-1', true], ['sap-report-2', true]]);
    expect(data[0].json.workflowName).toBe('SAP Report (imported from UiPath)');
    const file = data[0].binary?.workflow;
    expect(file).toMatchObject({ mimeType: 'application/json', fileName: 'sap-report.workflow.json' });
    const workflow = JSON.parse(Buffer.from(String(file?.data), 'base64').toString('utf8')) as { name: string; nodes: { name: string }[] };
    expect(workflow.name).toBe('SAP Report (imported from UiPath)');
    expect(workflow.nodes.map((n) => n.name)).toContain('Get active steps (sap-report-2)');
  });

  it('the UiPath fixture project, uploaded as a zip, adopts its browser sequence and returns the workflow', async () => {
    const engine = importEngine((input) => proved(input));
    const [data, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }), items: [fileItem(projectZip(), 'SAP.zip', 'application/zip')] });
    expect(engine.imports[0][0]).toBe('uipath');
    expect(repaired.map((r) => r.json.name)).toEqual(['sap-report-1']);
    expect((data[0].json.report as { source: string }).source).toBe('uipath');
    expect(data[0].binary?.workflow).toMatchObject({ mimeType: 'application/json', fileName: 'sap-report.workflow.json' });
  });

  describe('a very large UiPath project gives bounded outputs', () => {
    const NS = 'xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"';
    const xaml = (cls: string, body: string) => `<Activity x:Class="${cls}" ${NS}><Sequence DisplayName="${cls}">${body}</Sequence></Activity>`;
    const entry = (name: string, text: string) => {
      const data = Buffer.from(text, 'utf8');
      return { name, raw: deflateRawSync(data), usize: data.length };
    };
    const MIB = 1024 * 1024;
    async function importBig(file: Buffer, fileName: string) {
      const engine = importEngine((input) => proved(input));
      const started = performance.now();
      const [data, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'big-bot' }), items: [fileItem(file, fileName, 'application/zip')] });
      const ms = performance.now() - started;
      const json = JSON.stringify(data[0].json);
      const workflow = binaryText(data[0], 'workflow');
      return { data, repaired, ms, jsonBytes: Buffer.byteLength(json, 'utf8'), workflowBytes: workflow.length, workflow: JSON.parse(workflow.toString('utf8')) as { nodes: { name: string; parameters: { content?: string } }[] } };
    }

    it('8 workflows of 24,000 untranslated activities: a Data item and a workflow file each under 1 MiB, a clear report, in under 2 s', async () => {
      const PER = 24_000;
      const files = Array.from({ length: 8 }, (_, w) =>
        entry(`P${w}.xaml`, xaml(`P${w}`, Array.from({ length: PER }, (_, i) => `<ui:MysteryActivity DisplayName="Mystery ${w}-${i}" />`).join(''))));
      const main = entry('Main.xaml', xaml('Main', Array.from({ length: 8 }, (_, w) => `<ui:InvokeWorkflowFile DisplayName="Invoke P${w}" WorkflowFileName="P${w}.xaml" />`).join('')));
      const { data, repaired, ms, jsonBytes, workflowBytes, workflow } = await importBig(zip([main, ...files]), 'big.zip');
      expect(data[0].json.error).toBeUndefined();
      expect(repaired).toEqual([]);
      const items = (data[0].json.report as { items: { at: string; kind: string; what: string; reason: string }[] }).items;
      expect(items).toHaveLength(501);
      expect(items).toContainEqual(expect.objectContaining({ at: '', what: 'Browser steps' }));
      const shown = items.filter((i) => i.what.startsWith('Mystery ')).length;
      expect(items.at(-1)).toMatchObject({ kind: 'untranslated', what: `…and ${(8 * PER - shown).toLocaleString('en-US')} more not translated` });
      expect(jsonBytes).toBeLessThan(MIB);
      expect(workflowBytes).toBeLessThan(MIB);
      expect(workflow.nodes.length).toBeLessThanOrEqual(510);
      const more = workflow.nodes.find((n) => / more activities$/.test(n.name));
      expect(more?.parameters.content).toContain('more activities: see the report.');
      expect(ms).toBeLessThan(2000);
      process.stdout.write(`[bounded outputs] 8x24k: Data item ${jsonBytes} B, workflow file ${workflowBytes} B, ${Math.round(ms)} ms\n`);
    });

    it('one XAML with 20,000 Ifs stays bounded', async () => {
      const ifs = Array.from({ length: 20_000 }, (_, i) => `<If Condition="[n &gt; ${i}]" DisplayName="If ${i}"><If.Then><ui:MysteryActivity DisplayName="Inside ${i}" /></If.Then></If>`).join('');
      const { data, ms, jsonBytes, workflowBytes, workflow } = await importBig(Buffer.from(xaml('Main', ifs)), 'Main.xaml');
      expect(data[0].json.error).toBeUndefined();
      expect((data[0].json.report as { items: unknown[] }).items).toHaveLength(501);
      expect(jsonBytes).toBeLessThan(MIB);
      expect(workflowBytes).toBeLessThan(MIB);
      expect(workflow.nodes.length).toBeLessThanOrEqual(510);
      expect(workflow.nodes.some((n) => / more activities$/.test(n.name))).toBe(true);
      expect(ms).toBeLessThan(2000);
      process.stdout.write(`[bounded outputs] 20k Ifs: Data item ${jsonBytes} B, workflow file ${workflowBytes} B, ${Math.round(ms)} ms\n`);
    });
  });

  it('a non-adoptable draft goes to Data with adopted false and no Repaired Steps', async () => {
    const engine = importEngine(() => adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true }));
    const [data, repaired] = await run(engine, { continueOnFail: false });
    expect(repaired).toEqual([]);
    expect(data).toHaveLength(1);
    expect(data[0].json.error).toBeUndefined();
    expect(drafts(data[0])).toEqual([{ name: 'sap-export', steps: expect.any(Object), adopted: false, code: 'policy_violation', reason: NOT_ADOPTABLE }]);
    expect(data[0].json.report).toMatchObject({ source: 'chrome' });
  });

  it('a draft that fails adoption is an error item with the report; without continue-on-fail it throws', async () => {
    const drift = () => adoptFailure('drift_detected', 'No element found for Visible Text "Line Item Report"', { transcript: [], agentLog: [] });
    const engine = importEngine(drift);
    const [data, repaired] = await run(engine);
    expect(repaired).toEqual([]);
    expect(data[0].json.error).toBe('drift_detected: No element found for Visible Text "Line Item Report"');
    expect(details(data[0])).toMatchObject({ code: 'drift_detected', configError: false, name: 'sap-export' });
    expect(details(data[0]).report).toMatchObject({ source: 'chrome' });
    expect((details(data[0]).drafts as IDataObject[])[0]).toMatchObject({ name: 'sap-export', adopted: false, code: 'drift_detected' });
    await expect(run(importEngine(drift), { continueOnFail: false })).rejects.toThrow(NodeOperationError);
    await expect(run(importEngine(drift), { continueOnFail: false })).rejects.toThrow('drift_detected: No element found');
  });

  it('nothing imported is an error item carrying the report', async () => {
    const engine = importEngine((input) => proved(input));
    const [data] = await run(engine, { items: [fileItem('{ not json')] });
    expect(String(data[0].json.error)).toMatch(/^Nothing was imported: /);
    expect(details(data[0]).report).toMatchObject({ source: 'chrome' });
    expect(engine.adoptions).toHaveLength(0);
  });

  it('an imported item signs with Sign Steps, and a tampered one is refused', async () => {
    const engine = importEngine((input) => proved(input));
    const [, repaired] = await run(engine);
    const sign = async (json: IDataObject) => {
      const p = signStepsParams();
      const [out] = await executeSignSteps(nodeContext({ params: p, rawParameters: p, items: [{ json }], credentials: credentialsV2(SITE), continueOnFail: true }), engine);
      return out[0].json;
    };
    // Unchanged, exactly as it left Import Steps: digest, change list, evidence and file evidence all pass.
    const record = await sign(repaired[0].json);
    expect(record).toMatchObject({ name: 'sap-export', version: 1, status: 'active', approvedBy: 'approver@example.com' });
    expect(String(record.signature)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(record.steps))).toEqual(repaired[0].json.steps);

    // A step changed after review, with the hash recomputed: the digest no longer matches.
    const steps = structuredClone(repaired[0].json.steps) as unknown as Script;
    const at = steps.steps.findIndex((s) => 'click' in s);
    steps.steps[at] = { ...steps.steps[at], intent: 'Click Delete all' } as Script['steps'][number];
    const tampered = await sign({ ...repaired[0].json, steps: steps as unknown as IDataObject, hash: real.scriptHash(steps) });
    expect(String(tampered.error)).toMatch(/^Sign Steps refused: /);
    expect(String(tampered.error)).toContain('the repaired steps changed after they were reviewed');
    expect(tampered).not.toHaveProperty('signature');
  });

  it('files over 20 MiB are a configuration error', async () => {
    expect(MAX_IMPORT_BYTES).toBe(20 * 1024 * 1024);
    const big = MAX_IMPORT_BYTES + 1;
    // The size n8n recorded: refused before the file is read.
    const engine = importEngine((input) => proved(input));
    const sized = context({ items: [{ json: {}, binary: { data: { data: '', mimeType: 'application/zip', fileName: 'bot.zip', bytes: big } } }] });
    const [bySize] = await run(engine, {}, sized);
    expect(bySize[0].json.error).toBe(FILE_TOO_LARGE);
    expect(details(bySize[0])).toMatchObject({ configError: true });
    expect(sized.binaryReads).toBe(0);
    // A file in the binary data store: its stored size, also before reading.
    const stored = context({ items: [{ json: {}, binary: { data: { data: 'filesystem-v2', mimeType: 'application/zip', id: 'filesystem-v2:abc' } } }], binaryFileSizes: { 'filesystem-v2:abc': big } });
    const [byMetadata] = await run(engine, {}, stored);
    expect(byMetadata[0].json.error).toBe(FILE_TOO_LARGE);
    expect(stored.binaryReads).toBe(0);
    // A size that understates the file: checked again after reading.
    const understated = context({ items: [{ json: {}, binary: { data: { data: Buffer.alloc(big).toString('base64'), mimeType: 'application/zip', bytes: 10 } } }] });
    const [byLength] = await run(engine, {}, understated);
    expect(byLength[0].json.error).toBe(FILE_TOO_LARGE);
    // Text.
    const [text] = await run(engine, { params: params({ inputFrom: 'text', sourceText: 'x'.repeat(big) }) });
    expect(text[0].json.error).toBe(TEXT_TOO_LARGE);
    expect(engine.imports).toHaveLength(0);
    // Exactly 20 MiB is read and handed to the importer (which applies its own, smaller limits).
    const edge = context({ items: [{ json: {}, binary: { data: { data: Buffer.alloc(MAX_IMPORT_BYTES).toString('base64'), mimeType: 'application/json', bytes: MAX_IMPORT_BYTES } } }] });
    await run(engine, {}, edge);
    expect(engine.imports).toHaveLength(1);
  });

  it('Name is required and must not start with "="; it is checked before the import', async () => {
    const engine = importEngine((input) => proved(input));
    const [empty] = await run(engine, { params: params({ stepsName: '  ' }) });
    expect(empty[0].json.error).toBe(NAME_REQUIRED);
    const [expression] = await run(engine, { params: params({ stepsName: '=sap' }) });
    expect(expression[0].json.error).toBe(NAME_EQUALS);
    expect(engine.imports).toHaveLength(0);
  });

  it('an Expected File on a CDP browser is refused before the import; a draft that downloads is not adopted there', async () => {
    const cdp = { playwrightBrowserApi: { mode: 'cdp', wsUrl: 'ws://chrome.internal:9222/' }, playwrightSiteLoginApi: siteLoginData(SITE) };
    const engine = importEngine((input) => proved(input));
    const [refused] = await run(engine, { credentials: cdp });
    expect(refused[0].json.error).toBe(CDP_DOWNLOAD);
    expect(details(refused[0])).toMatchObject({ configError: true });
    expect(engine.imports).toHaveLength(0);
    // Without Expected File the draft may still download (an explicit download in the source): it is not adopted on CDP.
    const explicit = importEngine((input) => proved(input), uipathResult(1));
    const [data] = await run(explicit, { credentials: cdp, params: params({ source: 'uipath', stepsName: 'sap-report', expectedFile: {} }) });
    expect(explicit.adoptions).toHaveLength(0);
    expect(details(data[0]).drafts).toEqual([expect.objectContaining({ name: 'sap-report-1', adopted: false, reason: CDP_DOWNLOAD })]);
  });

  it('a rejected login trips the Site Login breaker: later drafts are not tried (locked_out)', async () => {
    const engine = importEngine(() => adoptFailure('login_failed', 'The site rejected the username or password.'), uipathResult(2));
    const [data] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }) });
    expect(engine.adoptions).toHaveLength(1);
    expect((details(data[0]).drafts as IDataObject[]).map((x) => x.code)).toEqual(['login_failed', 'locked_out']);
    expect(String(data[0].json.error)).toMatch(/^None of the 2 imported step lists could be adopted\. sap-report-1: login_failed: /);
    // The same execution's next import with that Site Login is locked out too, before any import.
    const next = importEngine((input) => proved(input));
    const [locked] = await run(next);
    expect(next.adoptions).toHaveLength(0);
    expect((details(locked[0]).drafts as IDataObject[])[0]).toMatchObject({ code: 'locked_out' });
  });

  it('adopts at most 10 drafts per import; the rest are reported, not tried', async () => {
    const engine = importEngine((input) => proved(input), uipathResult(12));
    const [data, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }) });
    expect(engine.adoptions).toHaveLength(10);
    expect(repaired).toHaveLength(10);
    const rest = drafts(data[0]).slice(10);
    expect(rest.map((x) => x.name)).toEqual(['sap-report-11', 'sap-report-12']);
    for (const x of rest) expect(x).toMatchObject({ adopted: false, reason: 'not tried: an import adopts at most 10 step lists' });
  });

  it('AI Repair with a model heals a drift; one repair per execution, so a later draft gets none', async () => {
    const model = { bindTools: () => ({ invoke: async () => ({ content: 'done', tool_calls: [] }) }) };
    const engine = importEngine((input, call) => proved(input, call === 0 ? { lane: 'agent', llmCalls: 3 } : {}), uipathResult(2));
    const [, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report', aiRepair: true, goal: '' }), model });
    expect(repaired).toHaveLength(2);
    const [first, second] = engine.adoptions;
    expect(first.repair).toMatchObject({ goal: 'Do what the imported steps do, on the page as it is now.', name: 'sap-report-1', deliverUnconfirmed: false, alreadyRan: false });
    expect(second.repair).toMatchObject({ name: 'sap-report-2', alreadyRan: true });
    // A Goal you type is used as is.
    const typed = importEngine((input) => proved(input));
    await run(typed, { params: params({ aiRepair: true, goal: 'Download the September line items' }), model });
    expect(typed.adoptions[0].repair?.goal).toBe('Download the September line items');
    expect(typed.adoptions[0].output).toBeUndefined();
  });

  it('AI Repair on without a model adopts without repair, and a drift says to connect one', async () => {
    const engine = importEngine(() => adoptFailure('drift_detected', 'No element found for Visible Text "Line Item Report"'));
    const [data] = await run(engine, { params: params({ aiRepair: true }) });
    expect(engine.adoptions[0].repair).toBeUndefined();
    expect(data[0].json.error).toBe(`drift_detected: No element found for Visible Text "Line Item Report" (${NO_MODEL})`);
  });

  it('ID Pattern goes to the import and the adoption as the row check', async () => {
    const engine = importEngine((input) => proved(input));
    await run(engine, { params: params({ idPattern: '19\\d{8}', expectedFile: {} }) });
    expect(engine.imports[0][2]).toMatchObject({ idPattern: '19\\d{8}' });
    expect(engine.imports[0][2]).not.toHaveProperty('download');
    expect(engine.adoptions[0].output).toEqual({ idPattern: '19\\d{8}' });
    const [bad] = await run(engine, { params: params({ idPattern: '(' }) });
    expect(String(bad[0].json.error)).toMatch(/^ID Pattern is not a valid regular expression/);
  });

  it('without a Site Login the policy comes from Start URL, or from the first page the steps open', async () => {
    const browserOnly = { playwrightBrowserApi: BROWSER };
    const fromDraft = importEngine((input) => proved(input));
    await run(fromDraft, { credentials: browserOnly });
    expect(fromDraft.imports[0][2]).toMatchObject({ hasSiteLogin: false });
    expect(fromDraft.imports[0][2]).not.toHaveProperty('secrets');
    expect(fromDraft.adoptions[0].policy).toMatchObject({ startUrl: `${SITE.url}/acme/login`, navHosts: [SITE.host], login: [], allowedSubmits: [] });
    expect(fromDraft.adoptions[0]).not.toHaveProperty('secrets');

    const typed = importEngine((input) => proved(input));
    await run(typed, { credentials: browserOnly, params: params({ startUrl: 'https://other.example.com/start' }) });
    expect(typed.imports[0][2]).toMatchObject({ startUrl: 'https://other.example.com/start' });
    expect(typed.adoptions[0].policy).toMatchObject({ startUrl: 'https://other.example.com/start', navHosts: ['other.example.com'] });
  });

  it('no Site Login secret, transcript or page snapshot reaches any output item', async () => {
    const leakyReport = { items: [{ at: 'step 1', kind: 'untranslated' as const, what: 'Field', reason: `typed ${SECRETS.password} here` }] };
    const engine = importEngine((input, call) => {
      if (call === 0) return proved(input);
      if (call === 1) return adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true });
      return adoptFailure('drift_detected', 'No element found for Role and Name button "Run"', {
        lane: 'agent', llmCalls: 2,
        transcript: [{ role: 'user', content: `page snapshot: textbox "Password" value ${SECRETS.password}` }] as never,
        agentLog: [{ tool: 'fill', ok: true, url: `${SITE.url}/acme/login`, note: SECRETS.username }],
        screenshot: Buffer.from(`png ${SECRETS.username}`), trace: Buffer.from(`trace ${SECRETS.totpSecret}`),
      });
    }, uipathResult(3, leakyReport));
    const ctx = context({ params: params({ source: 'uipath', stepsName: 'sap-report', options: { variables: VARIABLES, saveTrace: 'always' } }) });
    const out = await run(engine, {}, ctx);
    const items = out.flat();
    expect(items.length).toBeGreaterThan(1);
    const binaries = items.flatMap((i) => Object.values(i.binary ?? {}).map((b) => Buffer.from(b.data, 'base64').toString('latin1')));
    const text = [JSON.stringify(items.map((i) => i.json)), ...binaries].join('\n');
    for (const secret of [SECRETS.username, SECRETS.password, SECRETS.totpSecret]) expect(text).not.toContain(secret);
    for (const word of ['transcript', 'agentLog', 'page snapshot']) expect(text).not.toContain(word);
    expect(JSON.stringify(out[0][0].json.report)).toContain('[secret]');
    // The planted screenshot names the username and the planted trace is not a zip: neither is attached.
    expect(Object.keys(out[0][0].binary ?? {})).toEqual(['workflow']);
    expect(drafts(out[0][0])[2]).not.toHaveProperty('traceRef');
  });

  it('a guard store that cannot be opened for a later draft fails only that draft: the earlier proposal is still emitted', async () => {
    let opened = 0;
    const deps = {
      executionsMode: 'regular',
      redis: async () => {
        if (++opened === 2) throw new Error('connect ECONNREFUSED 10.0.0.5:6379');
        return memoryGuardStore();
      },
    };
    const engine = importEngine((input) => proved(input), uipathResult(3));
    const ctx = context({
      params: params({ source: 'uipath', stepsName: 'sap-report' }),
      credentials: { ...CREDS, playwrightRedisApi: { host: 'redis', port: 6379, database: 1 } },
    });
    const [data, repaired] = await executeImportSteps(ctx, engine, deps);
    expect(opened).toBe(3);
    expect(engine.adoptions.map((a) => a.draft.name)).toEqual(['sap-report-1', 'sap-report-3']);
    expect(repaired.map((r) => r.json.name)).toEqual(['sap-report-1', 'sap-report-3']);
    expect(data[0].json.error).toBeUndefined();
    const second = drafts(data[0])[1];
    expect(second).toMatchObject({ name: 'sap-report-2', adopted: false, code: 'incomplete' });
    expect(String(second.reason)).toContain('ECONNREFUSED');
  });

  it('Debug Trace: a failed draft carries its trace, scrubbed again, and its screenshot, unless Debug Trace is Never', async () => {
    const trace = traceZip({ 'trace.trace': `{"type":"before","title":"click Line Item Report","note":"typed ${SECRETS.password}"}\n` });
    const png = Buffer.from('\x89PNG failure');
    const drift = () => adoptFailure('drift_detected', 'No element found for Visible Text "Line Item Report"', { screenshot: png, trace });
    // One draft, every draft failed: the error item has `screenshot` and `trace`, as a Run Steps failure item does.
    const [failed] = await run(importEngine(drift), { params: params({}, { variables: VARIABLES, saveTrace: 'onFailure' }) });
    expect(failed[0].json.error).toMatch(/^drift_detected: /);
    expect(Object.keys(failed[0].binary ?? {}).sort()).toEqual(['screenshot', 'trace']);
    expect(failed[0].binary?.trace).toMatchObject({ mimeType: 'application/zip', fileName: 'sap-export-trace.zip' });
    expect(failed[0].binary?.screenshot).toMatchObject({ mimeType: 'image/png', fileName: 'sap-export-failure.png' });
    expect(binaryText(failed[0], 'screenshot')).toEqual(png);
    const entries = unzipTexts(binaryText(failed[0], 'trace'));
    expect(entries['trace.trace']).toContain('click Line Item Report');
    expect(entries['trace.trace']).not.toContain(SECRETS.password);
    expect(details(failed[0])).toMatchObject({ traceRef: 'trace' });
    expect((details(failed[0]).drafts as IDataObject[])[0]).toMatchObject({ traceRef: 'trace' });

    // Debug Trace Never: no page capture leaves the node.
    const [never] = await run(importEngine(drift), { params: params({}, { variables: VARIABLES, saveTrace: 'never' }) });
    expect(never[0].binary).toBeUndefined();
    expect(details(never[0])).toMatchObject({ traceRef: null });
    expect((details(never[0]).drafts as IDataObject[])[0]).not.toHaveProperty('traceRef');

    // Several drafts, some adopted: each failed draft's trace is `trace-<n>` (n its index in drafts) on the Data item.
    const mixed = importEngine((input, call) => (call === 1 ? drift() : proved(input)), uipathResult(3));
    const [data, repaired] = await run(mixed, { params: params({ source: 'uipath', stepsName: 'sap-report', options: { variables: VARIABLES, saveTrace: 'onFailure' } }) });
    expect(repaired).toHaveLength(2);
    expect(data[0].json.error).toBeUndefined();
    expect(Object.keys(data[0].binary ?? {}).sort()).toEqual(['trace-1', 'workflow']);
    expect(data[0].binary?.['trace-1']).toMatchObject({ mimeType: 'application/zip', fileName: 'sap-report-2-trace.zip' });
    expect(unzipTexts(binaryText(data[0], 'trace-1'))['trace.trace']).not.toContain(SECRETS.password);
    expect(drafts(data[0]).map((x) => x.traceRef ?? null)).toEqual([null, 'trace-1', null]);

    // Several drafts, all failed: the first failure's are `screenshot` and `trace`, the others' `trace-<n>`.
    const allFailed = importEngine(drift, uipathResult(2));
    const [error] = await run(allFailed, { params: params({ source: 'uipath', stepsName: 'sap-report', options: { variables: VARIABLES, saveTrace: 'onFailure' } }) });
    expect(String(error[0].json.error)).toMatch(/^None of the 2 imported step lists could be adopted\./);
    expect(Object.keys(error[0].binary ?? {}).sort()).toEqual(['screenshot', 'trace', 'trace-1', 'workflow']);
    expect((details(error[0]).drafts as IDataObject[]).map((x) => x.traceRef)).toEqual(['trace', 'trace-1']);
  });

  it('a binary in the data store is checked against the larger of its recorded size and the store size', async () => {
    const big = MAX_IMPORT_BYTES + 1;
    const engine = importEngine((input) => proved(input));
    // `bytes` understates the file; the store knows better: refused before the file is read.
    const lying = context({
      items: [{ json: {}, binary: { data: { data: 'filesystem-v2', mimeType: 'application/zip', id: 'filesystem-v2:lies', bytes: 10 } } }],
      binaryFileSizes: { 'filesystem-v2:lies': big },
    });
    const [refused] = await run(engine, {}, lying);
    expect(refused[0].json.error).toBe(FILE_TOO_LARGE);
    expect(lying.binaryReads).toBe(0);
    // And the other way round: a recorded size over the limit is refused even when the store reports less.
    const understatedStore = context({
      items: [{ json: {}, binary: { data: { data: 'filesystem-v2', mimeType: 'application/zip', id: 'filesystem-v2:small', bytes: big } } }],
      binaryFileSizes: { 'filesystem-v2:small': 10 },
    });
    const [also] = await run(engine, {}, understatedStore);
    expect(also[0].json.error).toBe(FILE_TOO_LARGE);
    expect(understatedStore.binaryReads).toBe(0);
    expect(engine.imports).toHaveLength(0);
  });

  it('draft steps that contain a Site Login secret are withheld from Data', async () => {
    const leaky = (): ImportResult => {
      const draft = chromeDraft('sap-export');
      const script = structuredClone(draft.script);
      script.steps.push({ intent: 'Type the note', fill: { field: { label: 'Note' }, value: `ref ${SECRETS.password}` } } as Script['steps'][number]);
      return { drafts: [{ ...draft, script }], report: { source: 'chrome', steps: 10, items: [] } };
    };
    const engine = importEngine(() => adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true }), leaky);
    const [data] = await run(engine);
    const entry = drafts(data[0])[0];
    expect(entry).toMatchObject({ name: 'sap-export', steps: null, adopted: false, code: 'policy_violation' });
    expect(entry.reason).toBe(`${NOT_ADOPTABLE} ${STEPS_WITHHELD}`);
    expect(STEPS_WITHHELD).toBe('The steps are not shown: they contain a value of the RPA Site Login.');
    expect(JSON.stringify(data[0].json)).not.toContain(SECRETS.password);
    // A clean draft keeps its steps.
    const clean = importEngine(() => adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true }));
    const [ok] = await run(clean);
    expect(drafts(ok[0])[0].steps).toEqual(expect.objectContaining({ name: 'sap-export' }));
  });

  it('a Site Login secret shorter than 4 characters is matched only whole: in the report and in the withheld-steps check', async () => {
    const SHORT = 'ab';
    const step = (value: string) => ({ intent: 'Type the note', fill: { field: { label: 'Note' }, value } }) as Script['steps'][number];
    const withStep = (name: string, value: string): Draft => {
      const draft = chromeDraft(name);
      return { ...draft, script: { ...draft.script, steps: [...draft.script.steps, step(value)] } };
    };
    const result = (): ImportResult => ({
      drafts: [withStep('sap-report-1', 'Lab table'), withStep('sap-report-2', ' AB ')],
      report: { source: 'uipath', steps: 20, items: [
        { at: 'Main.xaml: Type', kind: 'secret', what: 'ab', reason: 'the value typed into Table about tabs was removed' },
      ] },
      flow: { name: 'SAP Report', nodes: [{ kind: 'browser', sequence: 1, displayName: 'Use Browser 1' }, { kind: 'browser', sequence: 2, displayName: 'Use Browser 2' }] },
    });
    const engine = importEngine(() => adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true }), result);
    const credentials = { ...CREDS, playwrightSiteLoginApi: siteLoginData(SITE, SHORT) };
    const [data] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }), credentials });
    expect(data[0].json.error).toBeUndefined();
    // Text that merely contains the letters is left alone; the whole value is masked.
    expect((data[0].json.report as ImportResult['report']).items).toEqual([
      { at: 'Main.xaml: Type', kind: 'secret', what: '[secret]', reason: 'the value typed into Table about tabs was removed' },
    ]);
    const [lab, exact] = drafts(data[0]);
    expect(lab).toMatchObject({ name: 'sap-report-1', reason: NOT_ADOPTABLE });
    expect(JSON.stringify(lab.steps)).toContain('Lab table');
    expect(exact).toMatchObject({ name: 'sap-report-2', steps: null, reason: `${NOT_ADOPTABLE} ${STEPS_WITHHELD}` });
    // A secret of 4 or more characters is still found inside text.
    const long = importEngine(() => adoptFailure('policy_violation', NOT_ADOPTABLE, { adoptable: false, configError: true }), () => ({
      drafts: [withStep('sap-report-1', `ref ${SECRETS.password} ok`)], report: { source: 'uipath', steps: 10, items: [] },
    }));
    const [withLong] = await run(long, { params: params({ source: 'uipath', stepsName: 'sap-report' }) });
    expect(drafts(withLong[0])[0]).toMatchObject({ steps: null });
  });

  it('a UiPath import with no step list but a workflow keeps the workflow file on the error item', async () => {
    const engine = importEngine((input) => proved(input), () => ({
      drafts: [],
      report: { source: 'uipath', steps: 0, items: [{ at: 'Workflows/Upload.xaml', kind: 'error', what: 'UiPath project', reason: 'Workflows/Upload.xaml cannot be read: unclosed tag' }] },
      flow: { name: 'SAP Report', nodes: [{ kind: 'wait', seconds: 3, displayName: 'Pause' }] },
    }));
    const [data, repaired] = await run(engine, { params: params({ source: 'uipath', stepsName: 'sap-report' }), items: [fileItem('PK', 'bot.zip', 'application/zip')] });
    expect(repaired).toEqual([]);
    expect(data[0].json.error).toBe('Nothing was imported: Workflows/Upload.xaml cannot be read: unclosed tag');
    expect(details(data[0])).toMatchObject({ configError: true, workflowName: 'SAP Report (imported from UiPath)', report: { source: 'uipath' } });
    expect(Object.keys(data[0].binary ?? {})).toEqual(['workflow']);
    expect(data[0].binary?.workflow).toMatchObject({ mimeType: 'application/json', fileName: 'sap-report.workflow.json' });
    const workflow = JSON.parse(binaryText(data[0], 'workflow').toString('utf8')) as { nodes: { name: string }[] };
    expect(workflow.nodes.map((n) => n.name)).toContain('Pause');
    expect(engine.adoptions).toHaveLength(0);
  });

  it('Sign Steps refuses the Data item and the all-failed error item', async () => {
    const sign = async (json: IDataObject) => {
      const p = signStepsParams();
      const [out] = await executeSignSteps(nodeContext({ params: p, rawParameters: p, items: [{ json }], credentials: credentialsV2(SITE), continueOnFail: true }), engine);
      return out[0].json;
    };
    const engine = importEngine((input) => proved(input));
    const [data] = await run(engine);
    expect(data[0].json.error).toBeUndefined();
    const fromData = await sign(data[0].json);
    expect(String(fromData.error)).toMatch(/^Sign Steps refused: /);
    expect(fromData).not.toHaveProperty('signature');

    const failing = importEngine(() => adoptFailure('drift_detected', 'No element found for Visible Text "Line Item Report"'));
    const [error] = await run(failing);
    expect(String(error[0].json.error)).toMatch(/^drift_detected: /);
    const fromError = await sign(error[0].json);
    expect(String(fromError.error)).toMatch(/^Sign Steps refused: /);
    expect(fromError).not.toHaveProperty('signature');
  });

  it('several input items are imported one after another; Max Items applies', async () => {
    const engine = importEngine((input) => proved(input));
    const [data, repaired] = await run(engine, { items: [fileItem(CHROME), fileItem(CHROME)] });
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }]]);
    expect(repaired.map((r) => r.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }]]);
    const [refused] = await run(engine, { items: [fileItem(CHROME), fileItem(CHROME)], params: params({}, { maxItems: 1 }) });
    expect(String(refused[0].json.error)).toContain('more than Options → Max Items (1)');
  });
});
