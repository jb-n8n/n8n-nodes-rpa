// What the template tests share: loading a template file, finding its nodes, evaluating its expressions as n8n does, and
// template 5's import form (its form item, its resolved parameters, the review page, Sign steps, the change path).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { NOT_REPLAYED_EVIDENCE_LINE } from '../nodes/Playwright/format.js';
import { APPROVER } from './fixtures.js';
import { NodeHelpers, Workflow, type IDataObject, type INodeExecutionData, type INodeParameters } from 'n8n-workflow';
import { IMPORT_NOT_ADOPTABLE, importSource as realImportSource, type AdoptInput, type AdoptResult } from 'n8n-rpa-engine';
import { zip } from '../../engine/test/zip-fixtures.js';
import type { Engine } from '../nodes/Playwright/engine.js';
import { executeImportSteps } from '../nodes/Playwright/operations/importSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine } from './fake-engine.js';
import { nodeContext, siteLoginData } from './feed-fixtures.js';
import { harness } from './harness.js';
import { nodeTypes } from './n8n-harness.js';
import { expect } from 'vitest';

/** A review entry as the page shows it: the sentence, then the author's description under the page's own label. */
export const line = (r: { text: string; describedAs?: string }) => (r.describedAs === undefined ? r.text : `${r.text} (described differently as: ${r.describedAs})`);

export interface TemplateNode {
  id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown>;
  onError?: string; alwaysOutputData?: boolean; executeOnce?: boolean; notes?: string;
}
export type Connection = { node: string; type: string; index: number };
export interface Template { name: string; nodes: TemplateNode[]; connections: Record<string, Record<string, Connection[][]>>; settings?: Record<string, unknown> }
export type Condition = { keyName: string; condition: string; keyValue: unknown };
export type TableParams = {
  resource: string; operation: string; dataTableId: { mode: string; value: string }; matchType?: string; filters?: { conditions: Condition[] };
  returnAll?: boolean; limit?: number; orderBy?: boolean; orderByColumn?: string; orderByDirection?: string;
  columns?: { mappingMode: string; value: Record<string, unknown>; schema?: { id: string }[] };
};

export const FILES = {
  '0-connection-check.json': 'RPA: 0 Connection check',
  '2-data-feed.json': 'RPA: 2 Data feed',
  '3-approve-steps.json': 'RPA: 3 Approve steps',
  '5-import-a-bot.json': 'RPA: 5 Import a bot',
  'hello-world.json': 'RPA: Hello world',
} as const;
export const load = (file: string): Template => JSON.parse(readFileSync(new URL(`../templates/${file}`, import.meta.url), 'utf8')) as Template;
export const NODE_TYPE = 'n8n-nodes-rpa.playwright';
export const STICKY = 'n8n-nodes-base.stickyNote';
export const DATA_TABLE = 'n8n-nodes-base.dataTable';
/** n8n sticky colours (design-system tokens --sticky--color--background--variant-N): 4 green, 2 gold (n8n's nearest to orange), 7 grey. */
export const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
export const SETTINGS_NAME = "$('Settings').item.json.name";

export function byName(t: Template, name: string): TemplateNode {
  const n = t.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" in ${t.name}`);
  return n;
}
export const targets = (t: Template, from: string, type = 'main') => (t.connections[from]?.[type] ?? []).map((out) => out.map((c) => c.node));
export const table = (n: TemplateNode) => n.parameters as unknown as TableParams;
export const sticky = (t: Template, name: string) => byName(t, name).parameters as { content: string; color: number };

/** Evaluates one n8n expression ("={{ … }}", or "{{ … }}" as a node evaluates one) as JavaScript with the given globals. */
export function evaluate(expression: string, scope: Record<string, unknown>): unknown {
  const code = expression.replace(/^=?\{\{/, '').replace(/\}\}$/, '');
  return new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope)) as unknown;
}
/**
 * A JSON-mode form's fields as n8n 2.45 builds them (Form utils parseJsonFormFields): the expression must not hold "{{" or
 * "}}" inside (n8n cuts it there), and its text is put in place with String.replace, so the text must hold no "$" (the
 * templates write it as \u0024) for "$&" or "$$" in step text not to change what the page shows.
 */
export function jsonFormFields(expression: string, scope: Record<string, unknown>): { fieldLabel?: string; fieldName?: string; fieldType?: string; html?: string; defaultValue?: string; fieldOptions?: { values: { option: string }[] }; requiredField?: boolean; placeholder?: string }[] {
  expect(expression.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
  const text = String(evaluate(expression, scope));
  expect(text).not.toContain('$');
  return JSON.parse(text) as ReturnType<typeof jsonFormFields>;
}
/** A Set once sticky is a checklist: a heading, then at most six numbered lines. */
export function expectChecklist(content: string) {
  const [heading, ...lines] = content.split('\n');
  expect(heading).toMatch(/^### Set once/);
  expect(lines.length).toBeLessThanOrEqual(6);
  lines.forEach((l, i) => expect(l).toMatch(new RegExp(`^${i + 1}\\. `)));
}
/** Renders a text parameter with {{ … }} parts. */
export function render(text: string, scope: Record<string, unknown>): string {
  return text.replace(/^=/, '').replace(/\{\{(.+?)\}\}/gs, (_, code: string) => String(evaluate(`={{${code}}}`, scope)));
}
/** n8n loads the node with its real description: parameters normalised, connections computed. */
export function loadInN8n(n: TemplateNode) {
  const playwright = new Playwright();
  const workflow = new Workflow({
    nodes: [{ id: n.id, name: n.name, type: n.type, typeVersion: n.typeVersion, position: n.position, parameters: n.parameters as INodeParameters, onError: 'continueErrorOutput' }],
    connections: {}, active: false, nodeTypes: nodeTypes(playwright.description),
  });
  const loaded = workflow.getNode(n.name);
  if (!loaded) throw new Error(`n8n did not load ${n.name}`);
  return {
    parameters: loaded.parameters,
    outputs: NodeHelpers.getNodeOutputs(workflow, loaded, playwright.description).map((o) => (typeof o === 'string' ? o : String(o.displayName))),
    inputs: NodeHelpers.getNodeInputs(workflow, loaded, playwright.description).map((i) => (typeof i === 'string' ? i : i.type)),
  };
}

/** The heading both approval emails put over the steps an import left out. */
export const LEFT_OUT_HEADING = 'Left out by the import (the source does these, the steps do not):';
/** The evidence line of browser steps that go to approval without a replay (format.ts), written out. */
export const NOT_REPLAYED_LINE = NOT_REPLAYED_EVIDENCE_LINE;

export const template5 = load('5-import-a-bot.json');
const t = template5;

export const form = byName(t, 'Import a bot');
export const imp = byName(t, 'Import steps');
export type FormField = { fieldLabel: string; fieldName: string; fieldType: string; requiredField?: boolean; multipleFiles?: boolean; fieldOptions?: { values: { option: string }[] } };
export const fields = (form.parameters.formFields as { values: FormField[] }).values;
export const COMPLETION = 'n8n-nodes-base.form';

/**
 * What n8n 2.41's Form Trigger emits for a submission with one file (nodes/Form/utils/utils.ts prepareFormReturnItem,
 * binary mode "separate", the default): each field under its Field Name, and the file as binary named after the Field
 * Name with non-word characters replaced by "_". The "_0", "_1", ... suffix comes only when the browser posts two or
 * more files for the field (the multipart parser then gives an array), so one file is always `bot`, whatever
 * multipleFiles says; multipleFiles only wraps the JSON file entry in an array.
 */
export function formItem(source: string, file: Buffer, values: Record<string, string> = {}): INodeExecutionData {
  const upload = fields.find((f) => f.fieldType === 'file')!;
  const binaryName = upload.fieldName.replace(/\W/g, '_');
  const entry = { filename: 'bot', mimetype: 'application/octet-stream', size: file.length };
  return {
    json: { [upload.fieldName]: upload.multipleFiles ? [entry] : entry, source, name: 'line-item-export', expectedFileName: '', columns: '', ...values, submittedAt: '2026-10-22T10:00:00.000Z', formMode: 'test' },
    binary: { [binaryName]: { data: file.toString('base64'), mimeType: 'application/octet-stream', fileName: 'bot', bytes: file.length } },
  };
}
/** The form's workflow as n8n's expressions see it ($workflow), and the running execution ($execution: its form-waiting address). */
export const FORM_WORKFLOW = { id: 'wf-5', name: 'RPA: 5 Import a bot (Sample accounts)', active: true };
export const FORM_EXECUTION = { id: '12', resumeFormUrl: 'http://localhost:5720/form-waiting/12' };
/** Import steps' parameters as n8n resolves them for one form item, with the nodes that ran before it (`ran`). */
export function resolved(item: INodeExecutionData, ran: Record<string, INodeExecutionData[][]> = {}): Record<string, unknown> {
  const walk = (v: unknown): unknown => typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $json: item.json, $: nodesRan(ran), $workflow: FORM_WORKFLOW, $execution: FORM_EXECUTION })
    : typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(imp.parameters) as Record<string, unknown>;
}
export const SITE = { url: 'https://erp.example.com', host: 'erp.example.com' };
export const fixture = (name: string) => readFileSync(new URL(`../../engine/test/fixtures/import/${name}`, import.meta.url), 'utf8');
export const CHROME = Buffer.from(fixture('chrome-sap-export.json').split('http://localhost:8080').join(SITE.url));
/** The real importSource; adoptDraft scripted (no browser opens). */
export const importEngine = (adopt: (input: AdoptInput) => AdoptResult): Engine => Object.assign(fakeEngine(() => {
  throw new Error('Import Steps never calls runTask');
}), { importSource: realImportSource, adoptDraft: async (input: AdoptInput) => adopt(input) });
export const failure = (code: Extract<AdoptResult, { ok: false }>['code'], message: string, over: Partial<Extract<AdoptResult, { ok: false }>> = {}): AdoptResult => ({
  ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 900, lane: 'script', ...over,
});
export const NOT_ADOPTABLE = failure('policy_violation', IMPORT_NOT_ADOPTABLE, { adoptable: false, configError: true });
export const runImport = async (item: INodeExecutionData, adopt: (input: AdoptInput) => AdoptResult, ran: Record<string, INodeExecutionData[][]> = {}) => {
  const params = resolved(item, ran);
  const ctx = nodeContext({
    params, rawParameters: imp.parameters, items: [item], continueOnFail: true,
    credentials: { playwrightBrowserApi: { mode: 'local', headless: true }, playwrightSiteLoginApi: siteLoginData(SITE) },
  });
  return executeImportSteps(ctx, importEngine(adopt), { executionsMode: 'regular' });
};
/**
 * One of the engine's UiPath fixture projects, zipped under `folder` as a user uploads it; `toSite` points its sandbox
 * address at SITE.
 */
export function uipathZip(fixtureName = 'uipath-sap-report', folder = 'SAP Line Item Report', toSite = false): Buffer {
  const dir = fileURLToPath(new URL(`../../engine/test/fixtures/import/${fixtureName}/`, import.meta.url));
  const entries: { name: string; raw: Buffer; usize: number }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const data = toSite ? Buffer.from(readFileSync(path, 'utf8').split('http://localhost:8080').join(SITE.url)) : readFileSync(path);
        entries.push({ name: `${folder}/${relative(dir, path).split('\\').join('/')}`, raw: deflateRawSync(data), usize: data.length });
      }
    }
  };
  walk(dir);
  return zip(entries);
}
export const completion = (name: string) => byName(t, name).parameters as { operation: string; respondWith: string; completionTitle: string; completionMessage: string; inputDataFieldName?: string };
export const REVIEW = 'Review and approve';
export const review = byName(t, REVIEW);
/**
 * The review page's fields after its opening lines: the first field is always html that names the RPA Site Login Sign
 * steps signs for (or that desktop steps are signed without one), after the comparison line on the change path, before
 * the warning when the approved version does not fit.
 */
export function reviewFields(scope: Record<string, unknown>) {
  const all = jsonFormFields(String(review.parameters.jsonOutput), scope);
  expect(all[0].fieldType).toBe('html');
  expect(String(all[0].html)).toMatch(/<p>(Signs for the Site Login named "|These steps do not sign in, and are signed for the Site Login named "|Signs for no RPA Site Login|Desktop steps are signed)/);
  return all.slice(1);
}
/** The review page's opening lines (its first field). */
export const reviewHead = (scope: Record<string, unknown>) => String(jsonFormFields(String(review.parameters.jsonOutput), scope)[0].html);
export const settingsJson = () => Object.fromEntries((byName(t, 'Settings').parameters as { assignments: { assignments: { name: string; value: string }[] } }).assignments.assignments.map((a) => [a.name, a.value])) as IDataObject;
/** `$('<node>')` as an n8n expression sees it: the node's outputs in this execution (by output index) and its parameters. */
export function nodesRan(ran: Record<string, INodeExecutionData[][]>) {
  return (name: string) => {
    const outputs = ran[name];
    const ran_ = () => {
      if (!outputs) throw new Error(`${name} has not run`);
      return outputs;
    };
    // An earlier run of the node, as n8n gives it for first(branch, run) and all(branch, run): `<name>#<run>` when
    // given, else the last run.
    const of = (run?: number) => (run !== undefined && ran[`${name}#${run}`] ? ran[`${name}#${run}`] : ran_());
    return { isExecuted: outputs !== undefined, params: byName(t, name).parameters, first: (branch = 0, run?: number) => of(run)[branch]?.[0], all: (branch = 0, run?: number) => of(run)[branch] ?? [] };
  };
}
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
/** The ERP Demo recording imported on the form, and what the review page's expressions see. */
export async function importedRecording() {
  const rec = readFileSync(new URL('../../engine/test/fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
  const [data, repaired] = await runImport(formItem('RPA recording', rec), () => {
    throw new Error('a recording is never adopted in a browser');
  });
  expect(data[0].json.error).toBeUndefined();
  return { data, repaired, ran: { Settings: [[{ json: { ...formItem('RPA recording', rec).json, ...settingsJson() } }]], 'Import steps': [data, repaired] } as Record<string, INodeExecutionData[][]> };
}
/** The n8n user on a form page's output, as n8n 2.45 writes it for a signed-in submitter (after the page's fields). */
export const signedIn = (email: string) => ({ id: 'user-1', email, firstName: 'Ann', lastName: 'Approver' });
/**
 * The review page answered with `answer` (n8n gives each field under its fieldName) by `user` (the signed-in n8n user:
 * the approver by default; null for none, as with Basic Auth), then Step lists, Step lists to sign (one item per list,
 * Split Out) and Sign steps with its parameters resolved per item, as n8n resolves them.
 */
export async function signAfterReview(ran: Record<string, INodeExecutionData[][]>, answer: IDataObject, over: IDataObject = {}, withSiteLogin = false, user: IDataObject | null = signedIn(APPROVER), formAuthentication?: string, key = 'k'.repeat(32)) {
  const after = { ...ran, [REVIEW]: [[{ json: { ...answer, submittedAt: '2026-11-11T10:00:00.000Z', formMode: 'production', ...(user ? { user } : {}) } }]] };
  // The form's Authentication as the user set it (the template's own when not given).
  const ran_ = nodesRan(after);
  const $ = (name: string) => (name === 'Import a bot' && formAuthentication ? { ...ran_(name), params: { ...form.parameters, authentication: formAuthentication } } : ran_(name));
  const { lists } = evaluate(String(byName(t, 'Step lists').parameters.jsonOutput), { $ }) as { lists: IDataObject[] };
  expect(byName(t, 'Step lists to sign').parameters).toEqual({ fieldToSplitOut: 'lists', options: {} });
  const sign = { ...byName(t, 'Sign steps').parameters, ...over };
  const params = (i: number) => Object.fromEntries(Object.entries(sign).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $, $itemIndex: i }) : v]));
  const ctx = harness({
    params, rawParameters: sign, items: lists.map((json) => ({ json })), credentials: { playwrightScriptSigningApi: { secretKey: key }, ...(withSiteLogin ? { playwrightSiteLoginApi: siteLoginData(SITE) } : {}) }, continueOnFail: true,
    evaluateExpression: (expression, i) => evaluate(expression, { $, $itemIndex: i }),
  });
  const out = await executeSignSteps(ctx, importEngine(() => NOT_ADOPTABLE), () => new Date('2026-11-11T10:00:01.000Z'));
  const items = out[0].map((i) => i.json);
  return { lists, signed: items.filter((j) => j.error === undefined), errors: items.filter((j) => j.error !== undefined) };
}

/**
 * The change path as n8n's expressions see it: the first page submitted with no file and `name`, Approved bots giving
 * `rows`, then The bot to change. `authentication` is the form's sign-in as the user set it.
 */
export function changePath(name: string, rows: IDataObject[], authentication = 'n8nUserAuth', formQueryParameters?: IDataObject) {
  const ran: Record<string, INodeExecutionData[][]> = {
    Settings: [[{ json: { bot: null, source: null, name, ...settingsJson(), ...(formQueryParameters ? { formQueryParameters } : {}) } }]], 'Approved bots': [rows.map((json) => ({ json }))],
  };
  const $ = (n: string) => (n === 'Import a bot' ? { ...nodesRan(ran)(n), params: { ...form.parameters, authentication } } : nodesRan(ran)(n));
  const bot = evaluate(String(byName(t, 'The bot to change').parameters.jsonOutput), { $ }) as IDataObject;
  ran['The bot to change'] = [[{ json: bot }]];
  return { $, bot, ran };
}
/**
 * The change page answered with `text` in its box ('' for left empty), through Compared with the approved version (the
 * steps to review), The steps as a file (n8n's Convert to Text File: the string as UTF-8, n8n 2.45 utils/binary.ts
 * createBinaryFromJson) and The upload.
 */
export function changedUpload(ran: Record<string, INodeExecutionData[][]>, text: string): INodeExecutionData {
  return changedUploadOf({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]], [COMPARED]: [[{ json: compared(ran, text) as unknown as IDataObject }]] });
}
/** The upload made from what Compared with the approved version gave in `ran`, through The steps as a file and The upload. */
export function changedUploadOf(ran: Record<string, INodeExecutionData[][]>): INodeExecutionData {
  expect(byName(t, 'The steps as a file')).toMatchObject({ type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, parameters: { operation: 'toText', sourceProperty: 'steps', binaryPropertyName: 'bot' } });
  const steps = String(ran[COMPARED][0][0].json.steps);
  const file = { json: {}, binary: { bot: { data: Buffer.from(steps, 'utf8').toString('base64'), mimeType: 'text/plain', fileName: 'steps.json', bytes: Buffer.byteLength(steps) } } };
  const $ = nodesRan({ ...ran, 'The steps as a file': [[file]] });
  const json: IDataObject = {};
  let binary: INodeExecutionData['binary'];
  for (const a of (byName(t, 'The upload').parameters.assignments as { assignments: { name: string; value: string; type: string }[] }).assignments) {
    const v = evaluate(a.value, { $ });
    if (a.type === 'binary') binary = { [a.name]: v as NonNullable<INodeExecutionData['binary']>[string] };
    else json[a.name] = v as string;
  }
  return { json, ...(binary ? { binary } : {}) };
}
export const COMPARED = 'Compared with the approved version';
/**
 * What Compared with the approved version gives for the box submitted as `text` ('' for left empty; n8n gives null for
 * a box it did not get), from the row read in `ran`: the steps to review, and the line for the review page.
 */
export function compared(ran: Record<string, INodeExecutionData[][]>, text: string | null): { steps: string; changed: boolean; unchanged: boolean; compared: string } {
  const node = byName(t, COMPARED);
  expect(node).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
  const code = String(node.parameters.jsonOutput);
  // n8n cuts an expression at "}}": none inside.
  expect(code.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
  return evaluate(code, { $: nodesRan({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]] }) }) as ReturnType<typeof compared>;
}
