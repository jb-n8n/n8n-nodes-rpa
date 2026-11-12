import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { NOT_REPLAYED_EVIDENCE_LINE, reviewSteps } from '../nodes/Playwright/format.js';
import { USE_CASE_WORDS } from 'n8n-rpa-engine';
import { APPROVER } from './fixtures.js';
import {
  NodeHelpers, Workflow, type IDataObject, type INodeExecutionData, type INodeParameters, type INodeProperties, type INodeTypes,
} from 'n8n-workflow';
import {
  buildProposal, createMasker, IMPORT_NOT_ADOPTABLE, importSource as realImportSource, proposalDigest, scriptHash, validateScript, type AdoptInput, type AdoptResult,
  type Proposal, type Script, type TaskResult,
} from 'n8n-rpa-engine';
import { zip } from '../../engine/test/zip-fixtures.js';
import { nodeOutputs } from '../nodes/Playwright/description/io.js';
import type { Engine } from '../nodes/Playwright/engine.js';
import { executeImportSteps } from '../nodes/Playwright/operations/importSteps.js';
import { toLocator } from '../nodes/Playwright/operations/quick.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { repairedStepsJson } from '../nodes/Playwright/output.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { agentOk, fakeEngine, scriptOk, taskFail } from './fake-engine.js';
import { nodeContext, siteLoginData } from './feed-fixtures.js';
import { harness } from './harness.js';

interface TemplateNode {
  id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown>;
  onError?: string; alwaysOutputData?: boolean; executeOnce?: boolean; notes?: string;
}
type Connection = { node: string; type: string; index: number };
interface Template { name: string; nodes: TemplateNode[]; connections: Record<string, Record<string, Connection[][]>>; settings?: Record<string, unknown> }
type Condition = { keyName: string; condition: string; keyValue: unknown };
type TableParams = {
  resource: string; operation: string; dataTableId: { mode: string; value: string }; matchType?: string; filters?: { conditions: Condition[] };
  returnAll?: boolean; limit?: number; orderBy?: boolean; orderByColumn?: string; orderByDirection?: string;
  columns?: { mappingMode: string; value: Record<string, unknown>; schema?: { id: string }[] };
};

const FILES = {
  '0-connection-check.json': 'RPA: 0 Connection check',
  '2-data-feed.json': 'RPA: 2 Data feed',
  '3-approve-steps.json': 'RPA: 3 Approve steps',
  '5-import-a-bot.json': 'RPA: 5 Import a bot',
  'hello-world.json': 'RPA: Hello world',
} as const;
const load = (file: string): Template => JSON.parse(readFileSync(new URL(`../templates/${file}`, import.meta.url), 'utf8')) as Template;
const NODE_TYPE = 'n8n-nodes-rpa.playwright';
const STICKY = 'n8n-nodes-base.stickyNote';
const DATA_TABLE = 'n8n-nodes-base.dataTable';
/** n8n sticky colours (design-system tokens --sticky--color--background--variant-N): 4 green, 2 gold (n8n's nearest to orange), 7 grey. */
const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
const SETTINGS_NAME = "$('Settings').item.json.name";
/** Template 3's Supersede filter: up to the approved version, or every version for a first version (no base). */
const SUPERSEDE_UP_TO = "={{ $('Repaired steps received').item.json.baseVersion === null ? 2147483647 : $('Repaired steps received').item.json.version }}";
const AI_REPAIR = "={{ $('Get pending').all().filter(i => i.json.hash && DateTime.fromISO(i.json.expiresAt) > $now).length === 0 }}";
const EXPIRES_AT = "={{ $now.plus({ hours: $('Settings').item.json.approvalTimeoutHours }).toISO() }}";
/** Template 3 takes the approver from its Settings everywhere except the Approver Allowlist, which must be typed. */
const SETTINGS_APPROVER = "={{ $('Settings').item.json.approver }}";

function byName(t: Template, name: string): TemplateNode {
  const n = t.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" in ${t.name}`);
  return n;
}
const targets = (t: Template, from: string, type = 'main') => (t.connections[from]?.[type] ?? []).map((out) => out.map((c) => c.node));
const table = (n: TemplateNode) => n.parameters as unknown as TableParams;
const rowNodes = (t: Template) => t.nodes.filter((n) => n.type === DATA_TABLE && n.parameters.resource === 'row');
const sticky = (t: Template, name: string) => byName(t, name).parameters as { content: string; color: number };
const columnsOf: Record<string, string[]> = { [STEPS_TABLE]: STEPS_TABLE_COLUMNS.map((c) => c.name), [RUN_TABLE]: RUN_TABLE_COLUMNS.map((c) => c.name) };

/** Evaluates one n8n expression ("={{ … }}") as JavaScript with the given globals. */
function evaluate(expression: string, scope: Record<string, unknown>): unknown {
  const code = expression.replace(/^=\{\{/, '').replace(/\}\}$/, '');
  return new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope)) as unknown;
}
/**
 * A JSON-mode form's fields as n8n 2.45 builds them (Form utils parseJsonFormFields): the expression must not hold "{{" or
 * "}}" inside (n8n cuts it there), and its text is put in place with String.replace, so the text must hold no "$" (the
 * templates write it as \u0024) for "$&" or "$$" in step text not to change what the page shows.
 */
function jsonFormFields(expression: string, scope: Record<string, unknown>): { fieldLabel?: string; fieldName?: string; fieldType?: string; html?: string; defaultValue?: string; fieldOptions?: { values: { option: string }[] }; requiredField?: boolean; placeholder?: string }[] {
  expect(expression.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
  const text = String(evaluate(expression, scope));
  expect(text).not.toContain('$');
  return JSON.parse(text) as ReturnType<typeof jsonFormFields>;
}
/** A Set once sticky is a checklist: a heading, then at most six numbered lines. */
function expectChecklist(content: string) {
  const [heading, ...lines] = content.split('\n');
  expect(heading).toMatch(/^### Set once/);
  expect(lines.length).toBeLessThanOrEqual(6);
  lines.forEach((l, i) => expect(l).toMatch(new RegExp(`^${i + 1}\\. `)));
}
/** Renders a text parameter with {{ … }} parts. */
function render(text: string, scope: Record<string, unknown>): string {
  return text.replace(/^=/, '').replace(/\{\{(.+?)\}\}/gs, (_, code: string) => String(evaluate(`={{${code}}}`, scope)));
}
/** n8n loads the node with its real description: parameters normalised, connections computed. */
function loadInN8n(n: TemplateNode) {
  const playwright = new Playwright();
  const nodeTypes = { getByName: () => playwright, getByNameAndVersion: () => playwright, getKnownTypes: () => ({}) } as unknown as INodeTypes;
  const workflow = new Workflow({
    nodes: [{ id: n.id, name: n.name, type: n.type, typeVersion: n.typeVersion, position: n.position, parameters: n.parameters as INodeParameters, onError: 'continueErrorOutput' }],
    connections: {}, active: false, nodeTypes,
  });
  const loaded = workflow.getNode(n.name);
  if (!loaded) throw new Error(`n8n did not load ${n.name}`);
  return {
    parameters: loaded.parameters,
    outputs: NodeHelpers.getNodeOutputs(workflow, loaded, playwright.description).map((o) => (typeof o === 'string' ? o : String(o.displayName))),
    inputs: NodeHelpers.getNodeInputs(workflow, loaded, playwright.description).map((i) => (typeof i === 'string' ? i : i.type)),
  };
}

describe.each(Object.keys(FILES) as (keyof typeof FILES)[])('%s is a well-formed workflow', (file) => {
  const t = load(file);
  it('has its numbered name', () => {
    expect(t.name).toBe(FILES[file]);
  });
  it('has unique node names and ids, and every node has a type, version, position and parameters', () => {
    expect(new Set(t.nodes.map((n) => n.name)).size).toBe(t.nodes.length);
    expect(new Set(t.nodes.map((n) => n.id)).size).toBe(t.nodes.length);
    for (const n of t.nodes) {
      expect(typeof n.type).toBe('string');
      expect(typeof n.typeVersion).toBe('number');
      expect(n.position).toHaveLength(2);
      expect(typeof n.parameters).toBe('object');
    }
  });
  it('connects only nodes that exist, with matching connection types', () => {
    for (const [from, byType] of Object.entries(t.connections)) {
      byName(t, from);
      for (const [type, outputs] of Object.entries(byType)) for (const out of outputs) for (const c of out) {
        byName(t, c.node);
        expect(c.type).toBe(type);
      }
    }
  });
  it("references only nodes that exist in $('…') expressions", () => {
    for (const m of JSON.stringify(t.nodes).matchAll(/\$\('([^']+)'\)/g)) byName(t, m[1]);
  });
  it('holds no secrets and no credential references', () => {
    expect(JSON.stringify(t)).not.toMatch(/demo-password|"credentials"|"secretKey"|"password"|"token"/);
  });
  it('gives the RPA node only parameters it defines, Options entries included', () => {
    const properties = new Playwright().description.properties;
    const names = new Set(properties.map((p) => p.name));
    const optionNames = new Set(((properties.find((p) => p.name === 'options')?.options ?? []) as INodeProperties[]).map((o) => o.name));
    for (const n of t.nodes.filter((x) => x.type === NODE_TYPE)) {
      for (const [key, value] of Object.entries(n.parameters)) {
        expect(names).toContain(key);
        if (key === 'options') for (const o of Object.keys(value as Record<string, unknown>)) expect(optionNames).toContain(o);
      }
    }
  });
  it('names the operation on every RPA node, so a change of the default operation never alters it', () => {
    for (const n of t.nodes.filter((x) => x.type === NODE_TYPE)) expect(typeof n.parameters.operation, n.name).toBe('string');
  });
  it('never shows a workflow builder the word Playwright (only stored identifiers: the node type, the Data Table names, the Source value; and Playwright code, the tool it names)', () => {
    const text = JSON.stringify(t).replaceAll(NODE_TYPE, '').replaceAll(STEPS_TABLE, '').replaceAll(RUN_TABLE, '')
      .replaceAll("'playwright'", '').replaceAll('Playwright code', '').replaceAll('npx playwright codegen', '');
    expect(text.match(/playwright/gi) ?? []).toEqual([]);
  });
  it('reads and writes only columns the Data Tables have', () => {
    for (const n of rowNodes(t)) {
      const p = table(n);
      const known = columnsOf[p.dataTableId.value];
      expect(known, `${n.name} uses an unknown table`).toBeDefined();
      // id is a system column every Data Table row has (n8n DATA_TABLE_SYSTEM_COLUMNS), so a filter may use it.
      for (const c of p.filters?.conditions ?? []) expect([...known, 'id']).toContain(c.keyName);
      for (const col of Object.keys(p.columns?.value ?? {})) expect(known).toContain(col);
      for (const s of p.columns?.schema ?? []) expect(known).toContain(s.id);
    }
  });
  it('no sticky covers a working node and no two working nodes overlap (a node is about 100 by 100 on the canvas)', () => {
    const working = t.nodes.filter((n) => n.type !== STICKY);
    for (const st of t.nodes.filter((n) => n.type === STICKY)) {
      const [x, y] = st.position;
      const { width = 240, height = 160 } = st.parameters as { width?: number; height?: number };
      for (const n of working) expect(n.position[0] + 100 > x && n.position[0] < x + width && n.position[1] + 100 > y && n.position[1] < y + height, `${st.name} covers ${n.name}`).toBe(false);
    }
    for (const a of working) for (const b of working) if (a !== b) expect(Math.abs(a.position[0] - b.position[0]) < 100 && Math.abs(a.position[1] - b.position[1]) < 100, `${a.name} and ${b.name}`).toBe(false);
  });
  it('uses v1 execution order', () => {
    expect(t.settings).toMatchObject({ executionOrder: 'v1' });
  });
  it('colour-codes its stickies and uses no use-case word in node names or sticky text', () => {
    for (const n of t.nodes) {
      expect(n.name).not.toMatch(USE_CASE_WORDS);
      expect(n.notes ?? '', n.name).not.toMatch(USE_CASE_WORDS);
      if (n.type !== STICKY) continue;
      const s = n.parameters as { content: string; color: number };
      expect(Object.values(COLOUR)).toContain(s.color);
      expect(s.content, n.name).not.toMatch(USE_CASE_WORDS);
    }
  });
});

describe('every Data Table read and write uses the Settings name', () => {
  it.each(['2-data-feed.json', '3-approve-steps.json'])('%s', (file) => {
    const t = load(file);
    expect(rowNodes(t).length).toBeGreaterThan(0);
    for (const n of rowNodes(t)) expect(JSON.stringify({ filters: table(n).filters, values: table(n).columns?.value }), n.name).toContain(SETTINGS_NAME);
  });
});

describe('2-data-feed.json', () => {
  const t = load('2-data-feed.json');
  const run = byName(t, 'Run steps');
  it('has the colour-coded stickies: Set once (green, credential map), Change per site (gold, checklist, no colour word in its title: n8n has no orange), First run and Why signed steps (grey)', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    expect(sticky(t, 'Change per site').color).toBe(COLOUR.gold);
    expect(sticky(t, 'Change per site').content.split('\n')[0]).toBe('### Change per site');
    expect(sticky(t, 'First run').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Why signed steps').color).toBe(COLOUR.grey);
    const map = sticky(t, 'Set once').content;
    for (const s of ['**RPA Browser**: Run steps', '**RPA Site Login**: Run steps', '**RPA Step Signing**: Run steps', '**Chat model**', '**Alert on failure**', 'RPA: 3 Approve steps', 'the two Data Tables are created on the first run']) {
      expect(map).toContain(s);
    }
    const checklist = sticky(t, 'Change per site').content;
    for (const s of ['`name` in **Settings**', '**RPA Site Login**', '**Goal**', '**Options → ID Pattern**', 'nothing else']) expect(checklist).toContain(s);
    // A different Site Login needs its own copy of workflow 3, and the copy's Approve steps must call it.
    expect(checklist).toContain('and point **Approve steps** at that copy (it signs with its own Site Login)');
    expect(checklist).not.toMatch(/\bfour\b/);
    expect(sticky(t, 'First run').content).toMatch(/empty item/);
    // While version 1 waits for approval the scheduled runs report the "turn on AI Repair" error: expected.
    expect(sticky(t, 'First run').content).toContain('While version 1 waits for approval, AI Repair is off, so scheduled runs end with the configuration error "Steps is empty. Add steps, or turn on AI Repair to build them from the Goal." That is expected until you approve.');
    expect(sticky(t, 'Why signed steps').content).toMatch(/script_untrusted/);
    // Accepted risk: Expected Version comes from the table it guards, so a table editor can roll back.
    expect(sticky(t, 'Why signed steps').content).toContain('Anyone who can edit the playwright_steps table can switch the feed back to an earlier approved version.');
  });
  it('Every 6 hours → Settings → Get pending → Get active steps → Run steps, with the chat model on the Model input', () => {
    expect(targets(t, 'Every 6 hours')).toEqual([['Settings']]);
    // The top branch first (v1 order): both Data Tables, created when they are missing, then the feed.
    expect(targets(t, 'Settings')).toEqual([['Create steps table', 'Get pending']]);
    expect(targets(t, 'Create steps table')).toEqual([['Create run log table']]);
    expect(targets(t, 'Create run log table')).toEqual([]);
    expect(byName(t, 'Create steps table').position[1]).toBeLessThan(byName(t, 'Get pending').position[1]);
    expect(targets(t, 'Get pending')).toEqual([['Get active steps']]);
    expect(targets(t, 'Get active steps')).toEqual([['Run steps']]);
    expect(targets(t, 'Chat model', 'ai_languageModel')).toEqual([['Run steps']]);
    expect(byName(t, 'Settings').parameters).toMatchObject({ assignments: { assignments: [{ name: 'name', value: 'example-feed', type: 'string' }] } });
  });
  it('Get active steps: the newest active row for the Settings name, exactly one item, even on the first run', () => {
    const n = byName(t, 'Get active steps');
    expect(n).toMatchObject({ type: DATA_TABLE, alwaysOutputData: true, executeOnce: true });
    expect(table(n)).toMatchObject({
      resource: 'row', operation: 'get', dataTableId: { mode: 'name', value: STEPS_TABLE }, matchType: 'allConditions',
      returnAll: false, limit: 1, orderBy: true, orderByColumn: 'version', orderByDirection: 'DESC',
    });
    expect(table(n).filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: `={{ ${SETTINGS_NAME} }}` },
      { keyName: 'status', condition: 'eq', keyValue: 'active' },
    ]);
  });
  it('Get pending: every pending row for the Settings name, always outputs', () => {
    const n = byName(t, 'Get pending');
    expect(n).toMatchObject({ type: DATA_TABLE, alwaysOutputData: true });
    expect(table(n)).toMatchObject({ resource: 'row', operation: 'get', dataTableId: { mode: 'name', value: STEPS_TABLE }, matchType: 'allConditions', returnAll: true });
    expect(table(n).filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: `={{ ${SETTINGS_NAME} }}` },
      { keyName: 'status', condition: 'eq', keyValue: 'pending' },
    ]);
  });
  it('Run steps has exactly the intended parameters: signed steps from the active row, Name and Expected Version, AI Repair off while a pending row is unexpired', () => {
    expect(run).toMatchObject({ type: NODE_TYPE, typeVersion: 1, onError: 'continueErrorOutput' });
    expect(run.parameters).toEqual({
      operation: 'runSteps',
      steps: "={{ $('Get active steps').item.json.steps ?? '' }}",
      requireSignedSteps: true,
      signature: "={{ $('Get active steps').item.json.signature }}",
      approvedBy: "={{ $('Get active steps').item.json.approvedBy }}",
      aiRepair: AI_REPAIR,
      goal: 'Read every current stop-sale and safety campaign bulletin for this location (IDs look like N26-0417). The section may be renamed or moved in the menu; skip archived bulletins.',
      options: {
        name: `={{ ${SETTINGS_NAME} }}`,
        expectedVersion: "={{ $('Get active steps').item.json.version }}",
        idPattern: 'N26-\\d{4}',
        totalPattern: 'Showing \\d+-\\d+ of (\\d+)',
        saveTrace: 'onFailure',
      },
    });
  });
  it('the AI Repair expression is off only while an unexpired pending row exists (bootstrap item and expired rows do not count)', () => {
    const at = (rows: IDataObject[]) => evaluate(AI_REPAIR, {
      $: (name: string) => {
        expect(name).toBe('Get pending');
        return { all: () => rows.map((json) => ({ json })) };
      },
      DateTime: { fromISO: (s: unknown) => new Date(String(s)) },
      $now: new Date('2026-10-06T12:00:00.000Z'),
    });
    expect(at([])).toBe(true);
    expect(at([{}])).toBe(true);
    expect(at([{ hash: 'h1', expiresAt: '2026-10-07T12:00:00.000Z' }])).toBe(false);
    expect(at([{ hash: 'h1', expiresAt: '2026-10-05T12:00:00.000Z' }])).toBe(true);
    expect(at([{ hash: 'h1', expiresAt: '2026-10-05T12:00:00.000Z' }, { hash: 'h2', expiresAt: '2026-10-09T00:00:00.000Z' }])).toBe(false);
  });
  it('Data → Log run → destination; Repaired Steps → Approve steps; the error output, index 2, → Alert on failure → Log failed run', () => {
    expect(nodeOutputs('runSteps', run.parameters.aiRepair)).toHaveLength(2); // so n8n appends the error output at index 2
    expect(targets(t, 'Run steps')).toEqual([['Log run'], ['Approve steps'], ['Alert on failure']]);
    expect(t.connections['Run steps'].main[2][0]).toEqual({ node: 'Alert on failure', type: 'main', index: 0 });
    expect(targets(t, 'Log run')).toEqual([['Send data to destination']]);
    expect(targets(t, 'Alert on failure')).toEqual([['Log failed run']]);
    expect(byName(t, 'Send data to destination').type).toBe('n8n-nodes-base.noOp');
    expect(byName(t, 'Approve steps')).toMatchObject({
      type: 'n8n-nodes-base.executeWorkflow',
      parameters: { source: 'database', workflowId: { cachedResultName: FILES['3-approve-steps.json'] }, options: { waitForSubWorkflow: false } },
    });
  });
  it('n8n keeps every Run steps parameter on load and gives the node a Model input, then Data, Repaired Steps and Error', () => {
    const loaded = loadInN8n(run);
    expect(loaded.parameters).toMatchObject(run.parameters);
    expect(loaded.inputs).toEqual(['main', 'ai_languageModel']);
    expect(loaded.outputs).toEqual(['Data', 'Repaired Steps', 'Error']);
  });
  it('Log run and Log failed run write one run row each, from a real Data item and a real error item (duration and tokens included)', async () => {
    for (const name of ['Log run', 'Log failed run']) {
      expect(table(byName(t, name))).toMatchObject({ operation: 'insert', dataTableId: { value: RUN_TABLE }, columns: { mappingMode: 'defineBelow' } });
      expect(Object.keys(table(byName(t, name)).columns?.value ?? {})).toEqual(RUN_TABLE_COLUMNS.map((c) => c.name));
    }
    const settings = { name: 'example-feed' };
    const row = (name: string, json: IDataObject, runItem: IDataObject = json) => Object.fromEntries(
      Object.entries(table(byName(t, name)).columns?.value ?? {}).map(([col, v]) => [col, typeof v === 'string' && v.startsWith('=') ? evaluate(v, {
        $json: json, $execution: { id: 'exec-9' },
        $: (node: string) => ({ item: { json: node === 'Settings' ? settings : node === 'Run steps' ? runItem : {} } }),
      }) : v]),
    );
    // What Run steps really emits for an engine result (Data item or error item), with AI Repair on and a model connected.
    const steps = {
      name: 'example-feed', version: 2, startUrl: 'https://example.com/list',
      steps: [{ intent: 'Open the list', goto: 'https://example.com/list' }, { intent: 'Read the items', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }],
    };
    const runParams = {
      operation: 'runSteps', steps, startUrl: 'https://example.com/list', requireSignedSteps: false, aiRepair: true, goal: 'Read every item in the list.',
      options: { name: 'example-feed', idPattern: 'N26-\\d{4}', saveTrace: 'never' },
    };
    const emitted = async (result: TaskResult, params: Record<string, unknown> = runParams): Promise<IDataObject> => {
      const ctx = harness({
        params, rawParameters: params, credentials: { playwrightBrowserApi: { mode: 'local', headless: true } }, continueOnFail: true,
        model: { bindTools: () => ({ invoke: async () => ({ content: 'done', tool_calls: [] }) }) },
      });
      return (await executeRunSteps(ctx, fakeEngine(() => result)))[0][0].json;
    };
    const ROWS = [{ id: 'N26-0001' }, { id: 'N26-0002' }];

    const script = await emitted(scriptOk({ name: 'example-feed', version: 2, hash: 'h2', verified: true, confirmed: true, rows: ROWS, durationMs: 1200 }));
    expect(row('Log run', script)).toEqual({
      name: 'example-feed', lane: 'script', version: 2, hash: 'h2', confirmed: true, rowCount: 2, durationMs: 1200, llmTokens: 0, code: '', executionId: 'exec-9',
    });
    const agent = await emitted(agentOk({ rows: ROWS, confirmed: true, llmCalls: 3, tokens: 5400, durationMs: 21_000 }));
    expect(row('Log run', agent)).toMatchObject({ lane: 'agent', version: 2, confirmed: true, rowCount: 2, durationMs: 21_000, llmTokens: 5400, code: '' });

    const failure = await emitted(taskFail('drift_detected', 'Open the list: no match', { lane: 'agent', version: 3, hash: 'h3', llmCalls: 2, tokens: 3100, durationMs: 4200 }));
    expect(row('Log failed run', { success: true }, failure)).toEqual({
      name: 'example-feed', lane: 'agent', version: 3, hash: 'h3', confirmed: false, rowCount: 0, durationMs: 4200, llmTokens: 3100, code: 'drift_detected', executionId: 'exec-9',
    });
    const config = await emitted(scriptOk(), { ...runParams, steps: '{' });
    expect((config.details as IDataObject).configError).toBe(true);
    expect(row('Log failed run', { success: true }, config)).toMatchObject({ code: 'config_error', version: 0, hash: '', lane: '', durationMs: 0, llmTokens: 0 });
  });
  it('Alert on failure names the code (config_error for configuration errors), the Settings name and the message', () => {
    const p = byName(t, 'Alert on failure').parameters as { subject: string; text: string; options: { fileAttachments: string } };
    const scope = (json: IDataObject) => ({ $json: json, $execution: { id: 'exec-9' }, $binary: {}, $: () => ({ item: { json: { name: 'example-feed' } } }) });
    const drift = { error: 'drift_detected: Open the list: no match', message: 'Open the list: no match', details: { code: 'drift_detected', version: 3, lane: 'script' } };
    expect(render(p.subject, scope(drift))).toBe('RPA drift_detected on example-feed');
    expect(render(p.text, scope(drift))).toMatch(/^drift_detected on example-feed \(steps v3, script lane\)\n\nOpen the list: no match\n/);
    const config = { error: 'Steps is not valid JSON', message: 'Steps is not valid JSON', details: { configError: true, code: null } };
    expect(render(p.subject, scope(config))).toBe('RPA config_error on example-feed');
    expect(p.options.fileAttachments).toContain('$binary.trace');
  });
  it('needs at most 9 working nodes: stickies, the chat model, the two table creations and the destination placeholder not counted', () => {
    const working = t.nodes
      .filter((n) => ![STICKY, '@n8n/n8n-nodes-langchain.lmChatAnthropic', 'n8n-nodes-base.noOp'].includes(n.type) && (n.parameters as { operation?: string }).operation !== 'create')
      .map((n) => n.name);
    expect(working.sort()).toEqual(['Alert on failure', 'Approve steps', 'Every 6 hours', 'Get active steps', 'Get pending', 'Log failed run', 'Log run', 'Run steps', 'Settings']);
    // 18 nodes in total: 5 stickies, the chat model, the 9 working nodes, the two table creations and the destination placeholder.
    expect(t.nodes).toHaveLength(18);
    expect(t.nodes.filter((n) => n.type === STICKY)).toHaveLength(5);
    expect(t.nodes.filter((n) => n.type === 'n8n-nodes-base.noOp').map((n) => n.name)).toEqual(['Send data to destination']);
  });
});

/** The heading both approval emails put over the steps an import left out. */
const LEFT_OUT_HEADING = 'Left out by the import (the source does these, the steps do not):';
/** The evidence line of browser steps that go to approval without a replay (format.ts), written out. */
const NOT_REPLAYED_LINE = NOT_REPLAYED_EVIDENCE_LINE;

describe('3-approve-steps.json', () => {
  const t = load('3-approve-steps.json');
  const conditions = (name: string) => table(byName(t, name)).filters?.conditions ?? [];
  it('receives the Repaired steps item with its screenshots and emails evidence, changes and red safety flags with attachments', () => {
    expect(byName(t, 'Repaired steps received')).toMatchObject({ type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: { inputSource: 'passthrough' } });
    const email = byName(t, 'Email repaired steps').parameters;
    expect(email).toMatchObject({ operation: 'send', emailFormat: 'html', options: { fileAttachments: '={{ $json.attachmentNames }}' } });
    for (const field of ['evidenceLine', 'changeList', 'safetyLine', 'hash']) expect(String(email.html)).toContain(`$json.${field}`);
    expect(String(email.html)).toContain('color:#b00020');
  });
  it('trigger → Settings → (first) the tables and Mark pending, (then) Desktop steps? → one desktop email, or the review email and Ask for approval → Timed out? → Sign steps', () => {
    expect(targets(t, 'Repaired steps received')).toEqual([['Settings']]);
    // v1 order runs the topmost child's branch first: the tables exist and the row is pending before an email goes out.
    expect(targets(t, 'Settings')).toEqual([['Create steps table', 'Desktop steps?']]);
    expect(byName(t, 'Create steps table').position[1]).toBeLessThan(byName(t, 'Desktop steps?').position[1]);
    expect(targets(t, 'Create steps table')).toEqual([['Create run log table']]);
    expect(targets(t, 'Create run log table')).toEqual([['Mark pending']]);
    expect(targets(t, 'Mark pending')).toEqual([]);
    // Desktop steps: one email (its form asks for the writes). Browser steps: the review email with the screenshots, then Approve / Reject.
    expect(targets(t, 'Desktop steps?')).toEqual([['Ask for approval (desktop steps)'], ['Email repaired steps']]);
    expect(targets(t, 'Email repaired steps')).toEqual([['Ask for approval']]);
    expect(targets(t, 'Ask for approval')).toEqual([['Timed out?']]);
    expect(targets(t, 'Ask for approval (desktop steps)')).toEqual([['Desktop answer']]);
    expect(targets(t, 'Desktop answer')).toEqual([['Timed out?']]);
    expect(targets(t, 'Timed out?')).toEqual([['Record expiry'], ['Repaired steps to sign']]);
    expect(targets(t, 'Repaired steps to sign')).toEqual([['Sign steps']]);
    // Settings keeps the item (and its screenshots, which Set 3.4 passes on) for the review email, and adds the approver.
    expect(byName(t, 'Settings').parameters).toMatchObject({
      includeOtherFields: true,
      assignments: { assignments: [
        { name: 'name', value: "={{ $('Repaired steps received').item.json.name }}" }, { name: 'approvalTimeoutHours', value: 72, type: 'number' },
        { name: 'approver', value: APPROVER, type: 'string' },
      ] },
    });
    expect(byName(t, 'Settings')).not.toHaveProperty('parameters.options.stripBinary');
  });
  it('creates both Data Tables with the documented columns when they are missing', () => {
    const create = (name: string) => byName(t, name).parameters as { resource: string; operation: string; tableName: string; columns: { column: unknown[] }; options: IDataObject };
    expect(create('Create steps table')).toMatchObject({ resource: 'table', operation: 'create', tableName: STEPS_TABLE, options: { createIfNotExists: true } });
    expect(create('Create steps table').columns.column).toEqual(STEPS_TABLE_COLUMNS);
    expect(create('Create run log table')).toMatchObject({ resource: 'table', operation: 'create', tableName: RUN_TABLE, options: { createIfNotExists: true } });
    expect(create('Create run log table').columns.column).toEqual(RUN_TABLE_COLUMNS);
    // Templates 2 and 5 create them with the same parameters.
    for (const file of ['2-data-feed.json', '5-import-a-bot.json']) {
      for (const name of ['Create steps table', 'Create run log table']) expect(byName(load(file), name).parameters, `${file}: ${name}`).toEqual(byName(t, name).parameters);
    }
  });
  it('Mark pending upserts by hash: status pending, expiresAt now + approvalTimeoutHours', () => {
    const p = table(byName(t, 'Mark pending'));
    expect(p).toMatchObject({ resource: 'row', operation: 'upsert', dataTableId: { value: STEPS_TABLE }, matchType: 'allConditions', columns: { mappingMode: 'defineBelow' } });
    expect(p.columns?.value).toEqual({
      name: `={{ ${SETTINGS_NAME} }}`, version: "={{ $('Repaired steps received').item.json.version }}", hash: "={{ $('Repaired steps received').item.json.hash }}",
      status: 'pending', expiresAt: EXPIRES_AT,
    });
  });
  it('the upsert and every update are keyed by hash (and the Settings name)', () => {
    for (const name of ['Mark pending', 'Record expiry', 'Save signed steps', 'Record rejection']) {
      expect(table(byName(t, name)).operation).toBe(name === 'Mark pending' ? 'upsert' : 'update');
      expect(conditions(name).map((c) => [c.keyName, c.condition])).toEqual([['hash', 'eq'], ['name', 'eq']]);
      expect(conditions(name)[1].keyValue).toBe(`={{ ${SETTINGS_NAME} }}`);
    }
    // Save signed steps updates the pending row of the reviewed hash and writes the signed hash: they differ only for
    // desktop steps with Write steps (the declared write flags are part of what is signed).
    for (const name of ['Mark pending', 'Record expiry', 'Save signed steps', 'Record rejection']) expect(conditions(name)[0].keyValue).toBe("={{ $('Repaired steps received').item.json.hash }}");
    expect(table(byName(t, 'Record expiry')).columns?.value).toEqual({ status: 'expired' });
    expect(table(byName(t, 'Save signed steps')).columns?.value).toEqual({
      status: 'active', steps: '={{ $json.steps }}', hash: '={{ $json.hash }}', signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}', approvedAt: '={{ $json.approvedAt }}',
    });
    expect(table(byName(t, 'Record rejection')).columns?.value).toEqual({ status: 'rejected', approvedBy: SETTINGS_APPROVER, approvedAt: '={{ $now.toISO() }}' });
  });
  it('Supersede older versions runs after Save signed steps: every other active row of the same name up to the new version becomes superseded', () => {
    expect(targets(t, 'Save signed steps')).toEqual([['Supersede older versions', 'Email signed steps']]);
    expect(targets(t, 'Supersede older versions')).toEqual([]);
    const n = table(byName(t, 'Supersede older versions'));
    expect(n).toMatchObject({ resource: 'row', operation: 'update', dataTableId: { value: STEPS_TABLE }, matchType: 'allConditions' });
    // A desktop import is always version 1: a second approval must retire the first (same version, another row), while a
    // higher version approved meanwhile stays active. $json is the row Save signed steps wrote (n8n returns updated rows with their id).
    expect(n.filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: `={{ ${SETTINGS_NAME} }}` },
      { keyName: 'status', condition: 'eq', keyValue: 'active' },
      { keyName: 'version', condition: 'lte', keyValue: SUPERSEDE_UP_TO },
      { keyName: 'id', condition: 'neq', keyValue: '={{ $json.id }}' },
    ]);
    expect(n.columns?.value).toEqual({ status: 'superseded' });
    // An approved first version (an import, always version 1) replaces whatever runs under its name, also a higher version;
    // a repair (with a base version) supersedes its version and lower ones, so a higher version approved meanwhile stays.
    const upTo = (received: IDataObject) => evaluate(SUPERSEDE_UP_TO, { $: (name: string) => { expect(name).toBe('Repaired steps received'); return { item: { json: received } }; } });
    expect(upTo({ baseVersion: null, version: 1 })).toBe(2147483647);
    expect(upTo({ baseVersion: 2, version: 3 })).toBe(3);
    expect(byName(t, 'Supersede older versions').notes).toContain('An approved first version (an import) replaces every other active row of its name');
    expect(sticky(t, 'About this workflow').content).toContain('An approved import becomes the version that runs under its name, also when a higher version was active.');
  });
  it('Email signed steps confirms what was signed, naming the steps signed as writes for desktop steps; the hash and the review digest are one reference line at the end', () => {
    const p = byName(t, 'Email signed steps').parameters as { operation: string; toEmail: string; subject: string; text: string; emailFormat: string };
    expect(p).toMatchObject({ operation: 'send', toEmail: SETTINGS_APPROVER, emailFormat: 'text' });
    const reviewed = { hash: 'h0', digest: 'd0' };
    const signed = {
      name: 'erp', version: 1, hash: 'h1', approvedBy: APPROVER, approvedAt: '2026-10-29T12:00:00.000Z',
      writeSteps: [{ step: 16, intent: 'Click Save' }], writeLine: 'Signed as writes: step 16 (Click Save)',
    };
    const scope = (json: IDataObject, received: IDataObject = reviewed) => ({
      $: (name: string) => { expect(['Sign steps', 'Repaired steps received']).toContain(name); return { item: { json: name === 'Sign steps' ? json : received } }; },
    });
    expect(render(p.subject, scope(signed))).toBe('Signed: steps v1 for erp are active');
    // A step marked as a write changes the hash: one sentence says so.
    expect(render(p.text, scope(signed))).toBe(
      `Steps v1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\nSigned as writes: step 16 (Click Save). The hash changed because step 16 was marked as a write.\n\nReference: hash h1, review digest d0.`,
    );
    const two = { ...signed, writeSteps: [{ step: 4, intent: 'Press Enter' }, { step: 16, intent: 'Click Save' }], writeLine: 'Signed as writes: step 4 (Press Enter), step 16 (Click Save)' };
    expect(render(p.text, scope(two)).split('\n')[1]).toBe('Signed as writes: step 4 (Press Enter), step 16 (Click Save). The hash changed because steps 4 and 16 were marked as writes.');
    const none = { ...signed, hash: 'h0', writeSteps: [], writeLine: 'Signed as writes: none' };
    expect(render(p.text, scope(none))).toBe(`Steps v1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\nSigned as writes: none.\n\nReference: hash h0, review digest d0.`);
    // Browser steps: no write line.
    const { writeLine: _w, writeSteps: _s, ...browser } = { ...signed, hash: 'h0' };
    expect(render(p.text, scope(browser))).toBe(`Steps v1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\n\nReference: hash h0, review digest d0.`);
  });
  it('Ask for approval waits at most approvalTimeoutHours; Timed out? is true when send-and-wait resumed without an answer', () => {
    const ask = byName(t, 'Ask for approval').parameters;
    expect(ask).toMatchObject({
      operation: 'sendAndWait', approvalOptions: { values: { approvalType: 'double' } },
      options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: "={{ $('Settings').item.json.approvalTimeoutHours }}", resumeUnit: 'hours' } } },
    });
    expect(String(ask.message)).toContain("Review digest: {{ String($('Repaired steps received').item.json.digest ?? '')");
    const timedOut = byName(t, 'Timed out?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[]; combinator: string } };
    expect(timedOut.conditions.combinator).toBe('and');
    expect(timedOut.conditions.conditions).toEqual([expect.objectContaining({ leftValue: '={{ $json.data === undefined }}', operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    expect(evaluate(timedOut.conditions.conditions[0].leftValue, { $json: { name: 'feed', hash: 'h', status: 'pending' } })).toBe(true);
    expect(evaluate(timedOut.conditions.conditions[0].leftValue, { $json: { data: { approved: false } } })).toBe(false);
  });
  it('Sign steps signs the restored Repaired steps item; signed → Save signed steps; rejected or refused (error output, index 1) → Record rejection', () => {
    expect(byName(t, 'Repaired steps to sign').parameters).toEqual({ mode: 'raw', jsonOutput: "={{ $('Repaired steps received').item.json }}", options: {} });
    const sign = byName(t, 'Sign steps');
    expect(sign).toMatchObject({ type: NODE_TYPE, onError: 'continueErrorOutput' });
    expect(sign.parameters).toEqual({
      operation: 'signSteps', approved: "={{ $('Timed out?').item.json.data.approved }}", approverId: SETTINGS_APPROVER, approverAllowlist: APPROVER,
      writeSteps: "={{ $('Timed out?').item.json.data.writeSteps ?? '' }}",
    });
    expect(nodeOutputs('signSteps', undefined)).toHaveLength(1);
    expect(loadInN8n(sign).outputs).toEqual(['Success', 'Error']);
    expect(targets(t, 'Sign steps')).toEqual([['Signed?'], ['Record rejection']]);
    expect(targets(t, 'Signed?')).toEqual([['Save signed steps'], ['Record rejection']]);
    const signed = byName(t, 'Signed?').parameters as { conditions: { conditions: { leftValue: string; rightValue: string; operator: unknown }[] } };
    expect(signed.conditions.conditions).toEqual([expect.objectContaining({ leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } })]);
  });
  it('a rejection and an approval reach Sign steps with the reviewed item unchanged, so the hash still matches its steps', async () => {
    const engine = fakeEngine(() => {
      throw new Error('Sign Steps never opens a browser');
    });
    const steps: Script = {
      name: 'example-feed', version: 2, startUrl: 'https://example.com/list',
      steps: [{ intent: 'Open the list', goto: 'https://example.com/list' }, { intent: 'Read the items', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }],
    };
    const proposal: Proposal = {
      name: 'example-feed', baseVersion: 1, version: 2, steps, hash: scriptHash(steps), evidence: { count: 3, total: 3, diff: { missing: [], extra: [] } },
      changes: [{ was: 'Read the list (extract rows from css "main")', now: 'Read the items (extract rows from css "main", ID pattern N26-\\d{4})' }], safetyFlags: [], screenshots: {},
    };
    const received = repairedStepsJson(engine, proposal);
    // Repaired steps to sign: the trigger's item, restored after the approval email.
    const restored = evaluate(String(byName(t, 'Repaired steps to sign').parameters.jsonOutput), {
      $: (name: string) => {
        expect(name).toBe('Repaired steps received');
        return { item: { json: received } };
      },
    }) as IDataObject;
    expect(restored).toEqual(received);
    const sign = byName(t, 'Sign steps').parameters;
    const run = async (approved: boolean) => {
      // Browser steps: Ask for approval's answer has no writeSteps, so the expression gives ''.
      const params = { ...sign, approved, approverId: APPROVER, writeSteps: '' };
      const ctx = harness({ params, rawParameters: sign, items: [{ json: restored }], credentials: { playwrightScriptSigningApi: { secretKey: 'k'.repeat(32) } } });
      return (await executeSignSteps(ctx, engine, () => new Date('2026-10-07T09:30:00.000Z')))[0][0].json;
    };
    expect(await run(false)).toMatchObject({ status: 'rejected', name: 'example-feed', version: 2, hash: received.hash, approvedBy: APPROVER });
    expect(await run(true)).toMatchObject({ status: 'active', name: 'example-feed', version: 2, hash: received.hash, approvedBy: APPROVER });
  });
  it('desktop steps get one email whose form has Decision and the candidate writes as tick boxes, none ticked; Desktop answer gives Sign steps approved and the ticked and typed numbers', () => {
    const branch = byName(t, 'Desktop steps?').parameters as { conditions: { conditions: { leftValue: string }[] } };
    const isDesktop = (steps: unknown) => evaluate(branch.conditions.conditions[0].leftValue, { $: () => ({ item: { json: { steps } } }) });
    expect(isDesktop({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [] })).toBe(true);
    expect(isDesktop({ name: 'feed', startUrl: 'https://example.com/', steps: [] })).toBe(false);
    expect(isDesktop(undefined)).toBe(false);
    const ask = byName(t, 'Ask for approval (desktop steps)').parameters;
    expect(ask).toMatchObject({
      operation: 'sendAndWait', responseType: 'customForm', defineForm: 'json', toEmail: SETTINGS_APPROVER,
      options: { limitWaitTime: (byName(t, 'Ask for approval').parameters.options as { limitWaitTime: unknown }).limitWaitTime },
    });
    expect(ask).not.toHaveProperty('formFields');
    expect(String(ask.subject)).toMatch(/^=Approve desktop steps v\{\{/);
    // I2: the numbered change list is in the message and the candidates on the form; I3: what ticking does, plainly.
    const received = {
      version: 1, name: 'erp-1', hash: 'h', digest: 'd', evidenceLine: 'Not replayed', safetyLine: 'desktop app: "ErpDemo.exe"',
      changeList: 'Step 1: Wait for the window\nStep 2: Click Save <b>',
      safetyFlags: ['desktop app: "ErpDemo.exe"', 'candidate write: step 2 (Click Save, then $& close) may save, post or submit', 'candidate write: step 7 (Press Enter) may save, post or submit'],
      steps: { surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [
        { intent: 'Wait for the window', waitFor: {} }, { intent: 'Click Save <b>', click: {} }, { intent: 'Type into User name', fill: { field: { uia: { path: [{ name: 'User name' }] } }, value: '{{var.username}}' } },
        { intent: 'Type into Date to', fill: { field: { uia: { path: [{ controlType: 'Edit', name: 'Date to' }] } }, value: '2026-11-30' } },
        { intent: 'Read the count', read: { as: 'out_count' } }, { intent: 'Return the file', expectFile: { pattern: 'x' } },
      ] },
    };
    const $ = (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : received } });
    const message = render(String(ask.message), { $ });
    // The short view first: what it does besides reading, then one short sentence per step with its marks.
    expect(message.split('\n\nClick Review and decide')[0]).toBe('Desktop steps v1 for erp-1, for your approval.\nOpens ErpDemo.exe on the desktop runner.\nReturns a file to n8n: step 6.\n'
      + 'Not tried by the import: read every step before you approve.\n\nThe steps:\n1. Wait for the window\n2. Click Save &lt;b&gt;\n3. Type into User name (variable username)\n4. Type &quot;2026-11-30&quot; into Date to\n5. Read the count (gives its text to n8n as out_count)\n6. Return the file (returns a file)');
    // A secret variable is marked as one, as on the review page (the item names them; never a value).
    const secret = render(String(ask.message), { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : { ...received, secretVariables: ['username'] } } }) });
    expect(secret).toContain('\n3. Type into User name (secret variable username)\n');
    expect(message).toContain('tick the steps that save, send or submit (none is ticked for you), then approve or reject.');
    expect(message).toContain('Ticked steps are allowed to save or send. An unticked step is stopped only when it tries to use a control or key that your administrator has protected on the bot machine.');
    // The full detail below: the item's own change list, evidence and flags.
    expect(message).toContain('Details of every step (how each one finds its control):\nEvidence: Not replayed\nSafety flags: desktop app: &quot;ErpDemo.exe&quot;\nStep 1: Wait for the window\nStep 2: Click Save &lt;b&gt;\n');
    expect(message).not.toContain('Write steps');
    const description = render(String((ask.options as IDataObject).responseFormDescription), { $ });
    expect(description).toBe('Steps v1 for erp-1. Tick the steps that save, send or submit, from the numbered list in the email; none is ticked for you. Ticked steps are allowed to save or send. An unticked step is stopped only when it tries to use a control or key that your administrator has protected on the bot machine.');
    const fields = jsonFormFields(String(ask.jsonOutput), { $ });
    expect(fields).toEqual([
      { fieldLabel: 'Decision', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] }, requiredField: true },
      // A second person decides unprompted: no defaultValue, so nothing is ticked.
      { fieldLabel: 'Steps that save, send or submit', fieldType: 'checkbox', fieldOptions: { values: [{ option: 'Step 2: Click Save; then $& close' }, { option: 'Step 7: Press Enter' }] } },
      { fieldLabel: 'Any other step that saves, sends or submits (its number)', fieldType: 'text', placeholder: '7, 9' },
    ]);
    // No candidate: no tick boxes.
    expect(jsonFormFields(String(ask.jsonOutput), { $: () => ({ item: { json: { ...received, safetyFlags: [] } } }) }).map((f) => f.fieldLabel)).toEqual(['Decision', 'Any other step that saves, sends or submits (its number)']);
    // send-and-wait answers are keyed by label (emailSend 2.1); a checkbox answers with the labels ticked.
    const answer = String(byName(t, 'Desktop answer').parameters.jsonOutput);
    const data = (d: IDataObject) => ({ $json: { data: { ...d, respondedAt: 'x' } } });
    expect(evaluate(answer, data({ Decision: 'Approve and sign', 'Steps that save, send or submit': ['Step 7: Press Enter'], 'Any other step that saves, sends or submits (its number)': '9' }))).toEqual({ data: { approved: true, writeSteps: '7 9' } });
    expect(evaluate(answer, data({ Decision: 'Approve and sign', 'Steps that save, send or submit': [], 'Any other step that saves, sends or submits (its number)': '' }))).toEqual({ data: { approved: true, writeSteps: '' } });
    expect(evaluate(answer, data({ Decision: 'Reject' }))).toEqual({ data: { approved: false, writeSteps: '' } });
    expect(evaluate(answer, { $json: { name: 'feed', hash: 'h' } })).toEqual({});
    const timedOut = (byName(t, 'Timed out?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect(evaluate(timedOut, { $json: {} })).toBe(true);
    const sign = byName(t, 'Sign steps').parameters;
    const fromTimedOut = (json: unknown) => ({ $: (name: string) => { expect(name).toBe('Timed out?'); return { item: { json } }; } });
    expect(evaluate(String(sign.writeSteps), fromTimedOut({ data: { approved: true, writeSteps: '16' } }))).toBe('16');
    expect(evaluate(String(sign.writeSteps), fromTimedOut({ data: { approved: true, respondedAt: 'x' } }))).toBe('');
    expect(evaluate(String(sign.approved), fromTimedOut({ data: { approved: true, writeSteps: '' } }))).toBe(true);
  });
  it('types the approver address in Settings and in the Approver Allowlist only; every other approver field reads Settings', () => {
    const typed: string[] = [];
    for (const n of t.nodes.filter((x) => x.type !== STICKY)) {
      const { fromEmail: _sender, ...rest } = n.parameters; // the sender is not an approver
      for (const e of JSON.stringify(rest).match(/[^\s,'"<>\\]+@[^\s,'"<>\\]+/g) ?? []) typed.push(`${n.name}: ${e}`);
    }
    expect(typed.sort()).toEqual([`Settings: ${APPROVER}`, `Sign steps: ${APPROVER}`]);
    expect(byName(t, 'Sign steps').parameters.approverAllowlist).toBe(APPROVER);
    for (const name of ['Email repaired steps', 'Ask for approval', 'Ask for approval (desktop steps)', 'Email signed steps']) expect(byName(t, name).parameters.toEmail, name).toBe(SETTINGS_APPROVER);
    expect(byName(t, 'Sign steps').parameters.approverId).toBe(SETTINGS_APPROVER);
  });
  it('the stickies explain the pending lifecycle, configuration refusals and one approval per version', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    const notes = JSON.stringify(t.nodes.filter((n) => n.type === STICKY));
    for (const s of ['pending', 'expired', 'rejected', 'missing credential', 'one Repaired steps item per version']) expect(notes).toContain(s);
    expectChecklist(sticky(t, 'Set once').content);
    for (const s of ['**Settings → approver**', '**Sign steps → Approver Allowlist**', 'SMTP', '**RPA Step Signing**']) expect(sticky(t, 'Set once').content).toContain(s);
  });
});

describe('template 3 approval email', () => {
  const message = String(byName(load('3-approve-steps.json'), 'Ask for approval').parameters.message);
  const item = {
    version: '4<i>', name: 'feed<b>x</b>', hash: 'ab"c', digest: "d'e",
    evidenceLine: '7 rows <img src=x onerror=alert(1)>', safetyLine: "host: a.example' <script>",
  };
  const $ = (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : item } });
  const out = render(message, { $ });

  it('HTML-escapes every value from the run in the send-and-wait message, as the review email does', () => {
    expect(out).not.toMatch(/<img|<script|<b>|<i>/);
    expect(out).toContain('Steps v4&lt;i&gt; for feed&lt;b&gt;x&lt;/b&gt;');
    expect(out).toContain('Evidence (as reported by the run): 7 rows &lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('Safety flags: host: a.example&#39; &lt;script&gt;');
    expect(out).toContain('Hash: ab&quot;c');
    expect(out).toContain('Review digest: d&#39;e');
    expect(out).toContain('expires after 72 hours');
  });

  it('says what Approve and Reject cause, and prints the change list, so the email stands on its own', () => {
    const withChanges = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : { ...item, changeList: 'step 2 now clicks "Next"\n<div>' } } }) });
    expect(withChanges).toContain('What changed (as reported by the run):\nstep 2 now clicks &quot;Next&quot;\n&lt;div&gt;');
    expect(out).toContain('Approve: these exact steps are signed and n8n runs them with the stored login, without asking again, until the site changes.');
    expect(out).toContain('Reject: nothing is signed; the version in use, if any, stays in use.');
    expect(out).not.toContain('previous email');
    expect(out.indexOf('Approve: these exact steps')).toBeLessThan(out.indexOf('Hash:'));
    expect(out.indexOf('Hash:')).toBeLessThan(out.indexOf('Review digest:'));
  });

  it('never says that browser steps that were not replayed ran: the labels follow the evidence line', () => {
    const notReplayed = { ...item, evidenceLine: NOT_REPLAYED_LINE, changeList: 'Added: Send the form (submit POST /send)' };
    const shown = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : notReplayed } }) });
    expect(shown).toContain(`Evidence: ${NOT_REPLAYED_LINE.replace(/'/g, '&#39;')}`);
    expect(shown).toContain('What changed (as written; these steps were never run):\nAdded: Send the form');
    expect(shown).not.toContain('as reported by the run');
    expect(shown).not.toContain('Proven');
  });

  it('shows the left-out steps under their own heading before the evidence, escaped; with none, no heading', () => {
    const withLeftOut = { ...item, leftOutList: 'step 4, Pick <b>Status</b>: only one option is imported\nstep 9, Wait: a fixed wait is not imported' };
    const shown = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : withLeftOut } }) });
    expect(shown).toContain(`${LEFT_OUT_HEADING}\nstep 4, Pick &lt;b&gt;Status&lt;/b&gt;: only one option is imported\nstep 9, Wait: a fixed wait is not imported\n`);
    expect(shown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(shown.indexOf('Evidence'));
    expect(out).not.toContain('Left out');
    const desktop = String(byName(load('3-approve-steps.json'), 'Ask for approval (desktop steps)').parameters.message);
    const desktopShown = render(desktop, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : withLeftOut } }) });
    expect(desktopShown).toContain(`${LEFT_OUT_HEADING}\nstep 4, Pick &lt;b&gt;Status&lt;/b&gt;`);
    expect(desktopShown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(desktopShown.indexOf('Evidence'));
    expect(render(desktop, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : item } }) })).not.toContain('Left out');
  });

  it('the desktop approval message says what Approve and Reject cause, with the two values under that sentence', () => {
    const desktop = String(byName(load('3-approve-steps.json'), 'Ask for approval (desktop steps)').parameters.message);
    const shown = render(desktop, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : { ...item, changeList: 'Step 1: Click Save' } } }) });
    expect(shown).not.toContain('previous email');
    expect(shown).toContain('Reject: nothing is signed; the version in use, if any, stays in use.');
    expect(shown).toContain('The two values below identify what you are approving; you do not need to compare them by hand.');
    expect(shown.indexOf('Step 1: Click Save')).toBeLessThan(shown.indexOf('Hash:'));
    expect(shown.indexOf('The two values below')).toBeLessThan(shown.indexOf('Hash:'));
    expect(shown.indexOf('Hash:')).toBeLessThan(shown.indexOf('Review digest:'));
  });

  it('numbers the two emails of a request, so the order survives an inbox that lists the newest first', () => {
    const t = load('3-approve-steps.json');
    expect(String(byName(t, 'Email repaired steps').parameters.subject)).toMatch(/^=1 of 2, review: steps v\{\{ \$json\.version \}\} for /);
    expect(String(byName(t, 'Ask for approval').parameters.subject)).toMatch(/^=2 of 2, approve steps v/);
    // Desktop steps get one email.
    expect(String(byName(t, 'Ask for approval (desktop steps)').parameters.subject)).toMatch(/^=Approve desktop steps v/);
  });
});

describe('template 3 review email', () => {
  const html = String(byName(load('3-approve-steps.json'), 'Email repaired steps').parameters.html);
  const hostile = {
    version: 4, name: 'feed<b>', hash: 'abc',
    evidenceLine: '7 rows <img src=x onerror=alert(1)>',
    changeList: 'step 2 now clicks "Next"\n<div style="display:none">', safetyLine: "host: a.example' <script>",
  };
  const out = render(html, { $json: hostile });

  it('HTML-escapes every value from the run, so page or model text cannot restyle or hide parts of the email', () => {
    expect(out).not.toMatch(/<img|<script|<div|<b>feed/);
    expect(out).toContain('feed&lt;b&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('clicks &quot;Next&quot;<br>&lt;div style=&quot;display:none&quot;&gt;');
    expect(out).toContain('host: a.example&#39; &lt;script&gt;');
  });

  it('names the attached screenshots from attachmentNames: both, after only (a first run), or none', () => {
    const sentence = (attachmentNames: unknown) => render(html, { $json: { ...hostile, attachmentNames } });
    expect(sentence('before,after')).toContain('Screenshots before and after the change are attached. The next email has the Approve and Reject buttons.');
    const first = sentence('after');
    expect(first).toContain('A screenshot after the change is attached (a first run has no before). The next email has the Approve and Reject buttons.');
    expect(first).not.toContain('Screenshots before and after');
    expect(sentence('before')).toContain('A screenshot before the change is attached.');
    for (const none of ['', undefined]) expect(sentence(none)).toContain('No screenshots are attached. The next email has the Approve and Reject buttons.');
  });

  it('says what the safety flags are', () => {
    expect(out).toContain('Safety flags (what these steps do besides reading pages):');
  });

  it('shows the safety flags before any page- or model-derived text', () => {
    expect(out.indexOf('Safety flags')).toBeLessThan(out.indexOf('Evidence'));
    expect(out.indexOf('Safety flags')).toBeLessThan(out.indexOf('What changed'));
  });

  it('never says that browser steps that were not replayed ran: the labels follow the evidence line', () => {
    const shown = render(html, { $json: { ...hostile, evidenceLine: NOT_REPLAYED_LINE } });
    expect(shown).toContain(`<b>Evidence:</b> ${NOT_REPLAYED_LINE.replace(/'/g, '&#39;')}`);
    expect(shown).toContain('<b>What changed (as written; these steps were never run):</b><br>step 2 now clicks');
    expect(shown).not.toContain('as reported by the run');
  });

  it('shows the left-out steps in red under their own heading, after the safety flags and before the evidence; with none, nothing', () => {
    const shown = render(html, { $json: { ...hostile, leftOutList: 'step 4, Pick <b>Status</b>: only one option\nstep 9, Wait' } });
    expect(shown).toContain(`<p style="color:#b00020"><b>${LEFT_OUT_HEADING}</b><br>step 4, Pick &lt;b&gt;Status&lt;/b&gt;: only one option<br>step 9, Wait</p>`);
    expect(shown.indexOf('Safety flags')).toBeLessThan(shown.indexOf(LEFT_OUT_HEADING));
    expect(shown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(shown.indexOf('Evidence'));
    expect(out).not.toContain('Left out');
  });

  it('says the evidence and the change list are as reported by the run (Sign Steps recomputes only the safety flags)', () => {
    expect(out).toContain('<b>Evidence (as reported by the run):</b> 7 rows');
    expect(out).toContain('<b>What changed (as reported by the run):</b><br>step 2 now clicks');
  });
});

describe('hello-world.json', () => {
  const t = load('hello-world.json');
  it('is named, has exactly four nodes (three working nodes and one sticky) and the right names', () => {
    expect(t.name).toBe('RPA: Hello world');
    expect(t.nodes.map((n) => n.name).sort()).toEqual(
      ['Before you click Execute', 'Click Execute', 'Extract the sandbox table', 'Screenshot example.com'],
    );
    expect(t.nodes.filter((n) => n.type !== STICKY)).toHaveLength(3);
  });
  it('runs Manual Trigger -> Screenshot -> Extract Data in a line', () => {
    expect(byName(t, 'Click Execute').type).toBe('n8n-nodes-base.manualTrigger');
    expect(targets(t, 'Click Execute')).toEqual([['Screenshot example.com']]);
    expect(targets(t, 'Screenshot example.com')).toEqual([['Extract the sandbox table']]);
    expect(targets(t, 'Extract the sandbox table')).toEqual([]);
  });
  it('screenshots a public site with private networks off', () => {
    const n = byName(t, 'Screenshot example.com');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.parameters).toEqual({ operation: 'screenshot', url: 'https://example.com' });
  });
  it('extracts the sandbox table by CSS with Allow Private Network on, and only there', () => {
    const n = byName(t, 'Extract the sandbox table');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.parameters).toMatchObject({
      operation: 'extract', url: 'http://sandbox:8080/public/table', shape: 'table', options: { allowPrivateNetwork: true },
    });
    const tableParam = n.parameters.table as { locator: Parameters<typeof toLocator>[0] };
    expect(toLocator(tableParam.locator, 'Table')).toEqual({ css: 'table.results' });
    expect(Object.keys(n.parameters.options as object)).toEqual(['allowPrivateNetwork']);
    expect(Object.keys(n.parameters).sort()).toEqual(['operation', 'options', 'shape', 'table', 'url']);
  });
  it('has a green sticky that starts with the credential instruction and explains the private-network switch', () => {
    const s = byName(t, 'Before you click Execute');
    expect(s.type).toBe(STICKY);
    const content = String(s.parameters.content);
    expect(content.replace(/^#+ .*\n/, '').startsWith('Set the RPA Browser credential, then click Execute.')).toBe(true);
    expect(content).toContain('Allow Private Network');
    expect(content).toContain('docker compose up -d browser');
    expect(s.parameters.color).toBe(COLOUR.green);
  });
  it('carries no credentials, no secrets and no use-case words', () => {
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/"credentials"|"password"|"secretKey"|"token"/);
    expect(text).not.toMatch(USE_CASE_WORDS);
  });
});

describe('0-connection-check.json (the first-day connection check)', () => {
  const t = load('0-connection-check.json');
  it('has three working nodes and one sticky with the right names', () => {
    expect(t.nodes.map((n) => n.name).sort()).toEqual(['Check the connection', 'Click Execute', 'Screenshot the site', 'Site to check']);
    expect(t.nodes.filter((n) => n.type !== STICKY)).toHaveLength(3);
  });
  it('runs Manual Trigger -> Set "Site to check" -> Screenshot in a line', () => {
    expect(byName(t, 'Click Execute').type).toBe('n8n-nodes-base.manualTrigger');
    expect(targets(t, 'Click Execute')).toEqual([['Site to check']]);
    expect(targets(t, 'Site to check')).toEqual([['Screenshot the site']]);
    expect(targets(t, 'Screenshot the site')).toEqual([]);
  });
  it('sets one url field, a public placeholder the user replaces', () => {
    const n = byName(t, 'Site to check');
    expect(n.type).toBe('n8n-nodes-base.set');
    expect(n.typeVersion).toBe(3.4);
    const p = n.parameters as { assignments: { assignments: { name: string; value: string; type: string }[] }; options: object };
    expect(p.assignments.assignments.map(({ name, value, type }) => ({ name, value, type }))).toEqual([{ name: 'url', value: 'https://example.com', type: 'string' }]);
  });
  it('screenshots the url from Site to check with the quick operation, private networks off, no credential picked', () => {
    const n = byName(t, 'Screenshot the site');
    expect(n.type).toBe(NODE_TYPE);
    expect(n.typeVersion).toBe(1);
    expect(n.parameters).toEqual({ operation: 'screenshot', url: "={{ $('Site to check').item.json.url }}" });
    expect(loadInN8n(n).parameters).toMatchObject({ operation: 'screenshot' });
  });
  it('has a green sticky: pick the credential, replace the URL with your login page, run it, see the screenshot', () => {
    const s = sticky(t, 'Check the connection');
    expect(s.color).toBe(COLOUR.green);
    for (const text of ['**RPA Browser**', '**Site to check**', 'login page', 'Execute', 'screenshot', '**Options → Allow Private Network**', 'browser_unavailable']) {
      expect(s.content, text).toContain(text);
    }
  });
});

describe('5-import-a-bot.json (the first-day import)', () => {
  const t = load('5-import-a-bot.json');
  const form = byName(t, 'Import a bot');
  const imp = byName(t, 'Import steps');
  type FormField = { fieldLabel: string; fieldName: string; fieldType: string; requiredField?: boolean; multipleFiles?: boolean; fieldOptions?: { values: { option: string }[] } };
  const fields = (form.parameters.formFields as { values: FormField[] }).values;
  const SOURCES = { 'Work it out from the file': 'auto', 'Chrome Recorder': 'chrome', 'Playwright code': 'playwright', 'UiPath project': 'uipath', 'Step document': 'steps', 'RPA recording': 'recording' };
  const COMPLETION = 'n8n-nodes-base.form';

  /**
   * What n8n 2.41's Form Trigger emits for a submission with one file (nodes/Form/utils/utils.ts prepareFormReturnItem,
   * binary mode "separate", the default): each field under its Field Name, and the file as binary named after the Field
   * Name with non-word characters replaced by "_". The "_0", "_1", ... suffix comes only when the browser posts two or
   * more files for the field (the multipart parser then gives an array), so one file is always `bot`, whatever
   * multipleFiles says; multipleFiles only wraps the JSON file entry in an array.
   */
  function formItem(source: string, file: Buffer, values: Record<string, string> = {}): INodeExecutionData {
    const upload = fields.find((f) => f.fieldType === 'file')!;
    const files = 1;
    const binaryName = upload.fieldName.replace(/\W/g, '_') + (files >= 2 ? '_0' : '');
    const entry = { filename: 'bot', mimetype: 'application/octet-stream', size: file.length };
    return {
      json: { [upload.fieldName]: upload.multipleFiles ? [entry] : entry, source, name: 'line-item-export', expectedFileName: '', columns: '', ...values, submittedAt: '2026-10-22T10:00:00.000Z', formMode: 'test' },
      binary: { [binaryName]: { data: file.toString('base64'), mimeType: 'application/octet-stream', fileName: 'bot', bytes: file.length } },
    };
  }
  /** Import steps' parameters as n8n resolves them for one form item: every "={{ … }}" evaluated with $json. */
  function resolved(item: INodeExecutionData): Record<string, unknown> {
    const walk = (v: unknown): unknown => typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $json: item.json })
      : typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
    return walk(imp.parameters) as Record<string, unknown>;
  }
  const SITE = { url: 'https://erp.example.com', host: 'erp.example.com' };
  const fixture = (name: string) => readFileSync(new URL(`../../engine/test/fixtures/import/${name}`, import.meta.url), 'utf8');
  const CHROME = Buffer.from(fixture('chrome-sap-export.json').split('http://localhost:8080').join(SITE.url));
  /** The real importSource; adoptDraft scripted (no browser opens). */
  const importEngine = (adopt: (input: AdoptInput) => AdoptResult): Engine => Object.assign(fakeEngine(() => {
    throw new Error('Import Steps never calls runTask');
  }), { importSource: realImportSource, adoptDraft: async (input: AdoptInput) => adopt(input) });
  const failure = (code: Extract<AdoptResult, { ok: false }>['code'], message: string, over: Partial<Extract<AdoptResult, { ok: false }>> = {}): AdoptResult => ({
    ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 900, lane: 'script', ...over,
  });
  const NOT_ADOPTABLE = failure('policy_violation', IMPORT_NOT_ADOPTABLE, { adoptable: false, configError: true });
  const runImport = async (item: INodeExecutionData, adopt: (input: AdoptInput) => AdoptResult) => {
    const params = resolved(item);
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
  function uipathZip(fixtureName = 'uipath-sap-report', folder = 'SAP Line Item Report', toSite = false): Buffer {
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
  const completion = (name: string) => byName(t, name).parameters as { operation: string; respondWith: string; completionTitle: string; completionMessage: string; inputDataFieldName?: string };
  const REVIEW = 'Review and approve';
  const review = byName(t, REVIEW);
  const settingsJson = () => Object.fromEntries((byName(t, 'Settings').parameters as { assignments: { assignments: { name: string; value: string }[] } }).assignments.assignments.map((a) => [a.name, a.value])) as IDataObject;
  /** `$('<node>')` as an n8n expression sees it: the node's outputs in this execution (by output index) and its parameters. */
  function nodesRan(ran: Record<string, INodeExecutionData[][]>) {
    return (name: string) => {
      const outputs = ran[name];
      const ran_ = () => {
        if (!outputs) throw new Error(`${name} has not run`);
        return outputs;
      };
      return { isExecuted: outputs !== undefined, params: byName(t, name).parameters, first: (branch = 0) => ran_()[branch]?.[0], all: (branch = 0) => ran_()[branch] ?? [] };
    };
  }
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  /** The ERP Demo recording imported on the form, and what the review page's expressions see. */
  async function importedRecording() {
    const rec = readFileSync(new URL('../../engine/test/fixtures/import/recording-erp/erp.rpa-recording.json', import.meta.url));
    const [data, repaired] = await runImport(formItem('RPA recording', rec), () => {
      throw new Error('a recording is never adopted in a browser');
    });
    expect(data[0].json.error).toBeUndefined();
    return { data, repaired, ran: { Settings: [[{ json: { ...formItem('RPA recording', rec).json, ...settingsJson() } }]], 'Import steps': [data, repaired] } as Record<string, INodeExecutionData[][]> };
  }
  /**
   * The review page answered with `answer` (n8n gives each field under its fieldName), then Step lists, Step lists to sign
   * (one item per list, Split Out) and Sign steps with its parameters resolved per item, as n8n resolves them.
   */
  async function signAfterReview(ran: Record<string, INodeExecutionData[][]>, answer: IDataObject, over: IDataObject = {}, withSiteLogin = false) {
    const after = { ...ran, [REVIEW]: [[{ json: { ...answer, submittedAt: '2026-11-11T10:00:00.000Z', formMode: 'production' } }]] };
    const { lists } = evaluate(String(byName(t, 'Step lists').parameters.jsonOutput), { $: nodesRan(after) }) as { lists: IDataObject[] };
    expect(byName(t, 'Step lists to sign').parameters).toEqual({ fieldToSplitOut: 'lists', options: {} });
    const sign = { ...byName(t, 'Sign steps').parameters, ...over };
    const params = (i: number) => Object.fromEntries(Object.entries(sign).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $: nodesRan(after), $itemIndex: i }) : v]));
    const ctx = harness({ params, rawParameters: sign, items: lists.map((json) => ({ json })), credentials: { playwrightScriptSigningApi: { secretKey: 'k'.repeat(32) }, ...(withSiteLogin ? { playwrightSiteLoginApi: siteLoginData(SITE) } : {}) }, continueOnFail: true });
    const out = await executeSignSteps(ctx, importEngine(() => NOT_ADOPTABLE), () => new Date('2026-11-11T10:00:01.000Z'));
    const items = out[0].map((i) => i.json);
    return { lists, signed: items.filter((j) => j.error === undefined), errors: items.filter((j) => j.error !== undefined) };
  }

  it('the import template wires the form, Settings, Import steps, the review page and Sign steps; approval by email is a switched-off hand-off', () => {
    expect(form).toMatchObject({ type: 'n8n-nodes-base.formTrigger', typeVersion: 2.5 });
    expect(imp).toMatchObject({ type: NODE_TYPE, typeVersion: 1, onError: 'continueErrorOutput' });
    expect(targets(t, 'Import a bot')).toEqual([['Settings']]);
    // The download question only for a browser source, on a second page; Import steps always reads The upload.
    expect(targets(t, 'Settings')).toEqual([['Asks about a download?']]);
    expect(targets(t, 'Asks about a download?')).toEqual([['The file it downloads'], ['The upload']]);
    expect(targets(t, 'The file it downloads')).toEqual([['The upload']]);
    expect(targets(t, 'The upload')).toEqual([['Import steps']]);
    // No chat model ships with it: a recording, a step document and a UiPath desktop sequence never use one, and n8n
    // would not publish the form while a model node has no credential. The README says how to add one.
    expect(t.nodes.filter((n) => n.type.startsWith('@n8n/n8n-nodes-langchain.'))).toEqual([]);
    expect(Object.values(t.connections).filter((c) => 'ai_languageModel' in c)).toEqual([]);
    // Data → Approve on this form? (the review path, or straight to the last page); Repaired Steps → Approval by email?; error (index 2) → its own page.
    expect(nodeOutputs('importSteps', imp.parameters.aiRepair)).toHaveLength(2);
    expect(targets(t, 'Import steps')).toEqual([['Approve on this form?'], ['Approval by email?'], ['Missing login page?']]);
    // A refusal that names a login page the Site Login does not list: a page that says what to add, then the same file again.
    expect(targets(t, 'Missing login page?')).toEqual([['Add the login page'], ['Import failed']]);
    expect(targets(t, 'Add the login page')).toEqual([['The upload']]);
    expect(targets(t, 'Approval by email?')).toEqual([['Approve steps'], []]);
    expect(targets(t, 'Approve on this form?')).toEqual([['Create steps table'], ['Workflow file?']]);
    expect(targets(t, 'Create steps table')).toEqual([['Create run log table']]);
    expect(targets(t, 'Create run log table')).toEqual([[REVIEW]]);
    // v1 order runs the topmost child's branch to its end first: every step list is signed and saved before the last page.
    expect(targets(t, REVIEW)).toEqual([['Step lists', 'Workflow file?']]);
    expect(byName(t, 'Step lists').position[1]).toBeLessThan(byName(t, 'Workflow file?').position[1]);
    expect(targets(t, 'Step lists')).toEqual([['Step lists to sign']]);
    expect(targets(t, 'Step lists to sign')).toEqual([['Sign steps']]);
    expect(targets(t, 'Sign steps')).toEqual([['Signed?'], []]);
    expect(targets(t, 'Signed?')).toEqual([['Save signed steps'], ['Record rejection']]);
    expect(targets(t, 'Save signed steps')).toEqual([['Supersede older versions']]);
    expect(targets(t, 'Workflow file?')).toEqual([['Imported, with the workflow file'], ['Imported']]);
    // Template 2's hand-off into "RPA: 3 Approve steps", fire and forget, but once for each item: a UiPath project gives
    // one Repaired Steps item per step list, and each needs its own approval. In n8n 2.41 (ExecuteWorkflow.node.ts,
    // mode "each") every item starts its own sub-execution with [items[i]] and doNotWaitToFinish when
    // waitForSubWorkflow is false; "once" would send all of them to one approval execution.
    const approve = byName(t, 'Approve steps');
    const feedApprove = byName(load('2-data-feed.json'), 'Approve steps');
    expect(approve).toMatchObject({ type: feedApprove.type, typeVersion: feedApprove.typeVersion });
    expect(approve.parameters).toEqual({ ...feedApprove.parameters, mode: 'each', options: { waitForSubWorkflow: false } });
    expect(feedApprove.parameters.mode).toBe('once'); // template 2 keeps "once"
    expect(approve.notes).toContain('every step list gets its own approval execution');
    // Off: n8n publishes a workflow only when an enabled Execute Workflow node names its workflow, and the default path needs none.
    expect(approve).toMatchObject({ disabled: true });
    expect(byName(t, 'Approve on this form?')).not.toHaveProperty('disabled');
    // v1 order runs the topmost child first: the hand-off before the review page and the last pages, which pause the run.
    expect(byName(t, 'Approval by email?').position[1]).toBeLessThan(Math.min(...['Approve on this form?', 'Import failed'].map((n) => byName(t, n).position[1])));
    const working = t.nodes.filter((n) => n.type !== STICKY).map((n) => n.name).sort();
    expect(working).toEqual([
      'Add the login page', 'Approval by email?', 'Approve on this form?', 'Approve steps', 'Asks about a download?', 'Create run log table', 'Create steps table', 'Import a bot',
      'Import failed', 'Import steps', 'Imported', 'Imported, with the workflow file', 'Missing login page?', 'Record rejection', REVIEW, 'Save signed steps', 'Settings', 'Sign steps',
      'Signed?', 'Step lists', 'Step lists to sign', 'Supersede older versions', 'The file it downloads', 'The upload', 'Workflow file?',
    ]);
    expect(t.nodes.filter((n) => n.type === COMPLETION).map((n) => n.typeVersion)).toEqual([2.5, 2.5, 2.5, 2.5, 2.5, 2.5]);
    // A form page pauses the run until the browser loads it; a closed tab must not leave the execution waiting for ever.
    for (const n of t.nodes.filter((x) => x.type === COMPLETION)) {
      expect(n.parameters, n.name).toMatchObject({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours' });
    }
    // Credentials slots stay empty: nothing in the file names a credential.
    for (const n of t.nodes) expect(n, n.name).not.toHaveProperty('credentials');
  });

  it('approves on this form by default: Settings holds approval "on this form" (the approver is typed once, in Sign steps); only "by email" hands over to RPA: 3', () => {
    const settings = byName(t, 'Settings');
    expect(settings).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4 });
    expect(settings.parameters).toMatchObject({
      includeOtherFields: true,
      assignments: { assignments: [{ name: 'approval', value: 'on this form', type: 'string' }, { name: 'showDetails', value: false, type: 'boolean' }] },
    });
    expect(settings.notes).not.toContain('approver');
    // Set 3.4 passes the upload (binary bot) on unless told to strip it.
    expect(settings).not.toHaveProperty('parameters.options.stripBinary');
    const cond = (name: string) => (byName(t, name).parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const scope = (approval: string, lists: number) => ({ $: nodesRan({ Settings: [[{ json: { approval } }]], 'Import steps': [[{ json: {} }], Array.from({ length: lists }, () => ({ json: {} }))] }) });
    for (const [approval, lists, byEmail, onForm] of [['on this form', 1, false, true], ['by email', 1, true, false], ['on this form', 0, false, false], ['anything else', 2, false, true]] as const) {
      expect(evaluate(cond('Approval by email?'), scope(approval, lists)), approval).toBe(byEmail);
      expect(evaluate(cond('Approve on this form?'), scope(approval, lists)), approval).toBe(onForm);
    }
  });

  it('creates both Data Tables when they are missing, as template 3 does, before the review page', () => {
    const t3 = load('3-approve-steps.json');
    for (const name of ['Create steps table', 'Create run log table']) expect(byName(t, name).parameters).toEqual(byName(t3, name).parameters);
  });

  it('nothing reaches Save signed steps except an active record on the success output of Sign steps; Sign steps\' allowlist is typed', () => {
    const into = (node: string) => Object.entries(t.connections).flatMap(([from, byType]) => (byType.main ?? []).flatMap((out, index) => out.filter((c) => c.node === node).map(() => [from, index])));
    expect(into('Save signed steps')).toEqual([['Signed?', 0]]);
    expect(into('Signed?')).toEqual([['Sign steps', 0]]);
    expect(into('Record rejection')).toEqual([['Signed?', 1]]);
    expect(into('Supersede older versions')).toEqual([['Save signed steps', 0]]);
    const signed = byName(t, 'Signed?').parameters as { conditions: { conditions: { leftValue: string; rightValue: string; operator: unknown }[] } };
    expect(signed.conditions.conditions).toEqual([expect.objectContaining({ leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } })]);
    const sign = byName(t, 'Sign steps');
    expect(sign).toMatchObject({ type: NODE_TYPE, onError: 'continueErrorOutput', parameters: { operation: 'signSteps', approverAllowlist: APPROVER } });
    // The approver typed once: Approved By is left empty, so Sign Steps records the allowlist's one address.
    expect(sign.parameters).not.toHaveProperty('approverId');
    expect(sign.notes).toContain('Approver Allowlist: your address, typed here once');
    expect(loadInN8n(sign).outputs).toEqual(['Success', 'Error']);
    // The allowlist is a literal: Sign Steps refuses an expression there, so item data cannot choose who may approve.
    expect(String(sign.parameters.approverAllowlist).startsWith('=')).toBe(false);
    // Save writes the record Sign steps gave, as active; the rejection writes a rejected row with no steps and no signature.
    expect(table(byName(t, 'Save signed steps'))).toMatchObject({ resource: 'row', operation: 'insert', dataTableId: { mode: 'name', value: STEPS_TABLE } });
    expect(table(byName(t, 'Save signed steps')).columns?.value).toEqual({
      name: '={{ $json.name }}', version: '={{ $json.version }}', steps: '={{ $json.steps }}', hash: '={{ $json.hash }}', signature: '={{ $json.signature }}',
      approvedBy: '={{ $json.approvedBy }}', approvedAt: '={{ $json.approvedAt }}', status: 'active',
    });
    expect(table(byName(t, 'Record rejection')).columns?.value).toEqual({
      name: '={{ $json.name }}', version: '={{ $json.version }}', hash: '={{ $json.hash }}', status: 'rejected', approvedBy: '={{ $json.approvedBy }}', approvedAt: '={{ $json.approvedAt }}',
    });
    const supersede = table(byName(t, 'Supersede older versions'));
    expect(supersede).toMatchObject({ resource: 'row', operation: 'update', dataTableId: { value: STEPS_TABLE }, matchType: 'allConditions', columns: { value: { status: 'superseded' } } });
    expect(supersede.filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: '={{ $json.name }}' },
      { keyName: 'status', condition: 'eq', keyValue: 'active' },
      { keyName: 'version', condition: 'lte', keyValue: "={{ $('Step lists to sign').item.json.baseVersion === null ? 2147483647 : $('Step lists to sign').item.json.version }}" },
      { keyName: 'id', condition: 'neq', keyValue: '={{ $json.id }}' },
    ]);
  });

  it('the form asks for the bot file, an optional source (worked out from the file to start with) and a name; the download, on a second page, for every upload but a recording', () => {
    expect(fields.map((f) => [f.fieldName, f.fieldType, f.requiredField === true])).toEqual([['bot', 'file', true], ['source', 'dropdown', false], ['name', 'text', true]]);
    expect(fields[1].fieldLabel).toBe('Source (optional)');
    const page = byName(t, 'The file it downloads');
    expect(page).toMatchObject({ type: COMPLETION, typeVersion: 2.5, parameters: { operation: 'page', options: { formTitle: 'The file it downloads', buttonLabel: 'Import' } } });
    expect((page.parameters.formFields as { values: FormField[] }).values.map((f) => [f.fieldName, f.fieldType, f.requiredField === true])).toEqual([['expectedFileName', 'text', false], ['columns', 'text', false]]);
    // Asked unless the Source or the file name says recording (the recorder makes its export step). A UiPath project is
    // asked too: its browser steps need the Expected File to make their download a checked one.
    const asks = (byName(t, 'Asks about a download?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const ask = (source: string | null, filename: string) => evaluate(asks, { $json: { source, bot: { filename } } });
    expect(ask(null, 'export.json')).toBe(true);
    expect(ask('Chrome Recorder', 'export.json')).toBe(true);
    expect(ask('Step document', 'steps.json')).toBe(true);
    expect(ask(null, 'Project.ZIP')).toBe(true);
    expect(ask(null, 'Main.xaml')).toBe(true);
    expect(ask('UiPath project', 'p.json')).toBe(true);
    expect(ask(null, 'erp.rpa-recording.json')).toBe(false);
    expect(ask(null, 'ERP.RPA-Recording.JSON')).toBe(false);
    expect(ask('RPA recording', 'renamed.json')).toBe(false);
    const page_ = page.parameters.options as { formDescription: string };
    expect(page_.formDescription).toBe('If the bot downloads a file in a browser, say which: the replay checks that it gets that file. Leave both empty when it downloads nothing, or when a desktop app saves the file.');
    // The upload: the file from the first page (Settings passed it on), its Name and Source, and the download answers when asked.
    const upload = byName(t, 'The upload');
    expect(upload).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4 });
    const values = (upload.parameters.assignments as { assignments: { name: string; value: string; type: string }[] }).assignments;
    expect(values.map((a) => [a.name, a.type])).toEqual([['name', 'string'], ['source', 'string'], ['expectedFileName', 'string'], ['columns', 'string'], ['bot', 'binary']]);
    const scope = (asked: boolean) => ({ $: (name: string) => (name === 'Settings'
      ? { first: () => ({ json: { name: 'n', source: null }, binary: { bot: { fileName: 'export.json' } } }) }
      : { isExecuted: asked, last: () => ({ json: { expectedFileName: '^X_', columns: null } }) }) });
    expect(values.map((a) => evaluate(a.value, scope(true)))).toEqual(['n', '', '^X_', '', { fileName: 'export.json' }]);
    expect(values.map((a) => evaluate(a.value, scope(false)))).toEqual(['n', '', '', '', { fileName: 'export.json' }]);
    // One file per import: the form refuses a second, so the upload is always binary `bot` (n8n adds `_0`, `_1` only for 2+ files).
    expect(fields[0].multipleFiles).toBe(false);
    expect(fields[1].fieldOptions?.values.map((o) => o.option)).toEqual(Object.keys(SOURCES));
    // Sign-in on by default: an anonymous form could start logins with the attached Site Login
    // (login breaker trips) and model spend. The Basic Auth credential slot stays empty: the user picks one first.
    expect(form.parameters.authentication).toBe('basicAuth');
    expect(form).not.toHaveProperty('credentials');
  });

  it('Import steps reads the form: Source mapped to its value, the binary bot, Name, AI Repair off, Expected File from the optional fields', () => {
    expect(imp.parameters).toMatchObject({ operation: 'importSteps', inputFrom: 'binary', binaryPropertyName: 'bot', stepsName: '={{ $json.name }}', aiRepair: false });
    for (const [label, value] of Object.entries(SOURCES)) expect(resolved(formItem(label, CHROME)).source).toBe(value);
    expect(resolved(formItem('Something else', CHROME)).source).toBe('');
    // Not chosen (n8n sends null; The upload passes it on as ''): worked out from the file.
    expect(resolved(formItem(null as unknown as string, CHROME)).source).toBe('auto');
    expect(resolved(formItem('', CHROME)).source).toBe('auto');
    expect(resolved(formItem('Chrome Recorder', CHROME, { expectedFileName: '^LINEITEMS_', columns: 'Document, Amount' })).expectedFile)
      .toEqual({ file: { namePattern: '^LINEITEMS_', requiredColumns: 'Document, Amount' } });
    // n8n's Form Trigger sends null for a field that was not filled in.
    expect(resolved(formItem('Chrome Recorder', CHROME, { expectedFileName: null as unknown as string })).expectedFile).toEqual({ file: { namePattern: '', requiredColumns: '' } });
    const loaded = loadInN8n(imp);
    expect(loaded.parameters).toMatchObject(imp.parameters);
    // AI Repair off: no Model input; the two outputs and n8n's error output stay.
    expect(loaded.inputs).toEqual(['main']);
    expect(loaded.outputs).toEqual(['Data', 'Repaired Steps', 'Error']);
  });

  /**
   * The first page's submission through Settings, Asks about a download? and, when it asks, The file it downloads
   * answered with `answer` (null: the page was not asked), then The upload as Import steps reads it.
   */
  function throughTheDownloadPage(first: INodeExecutionData, answer: IDataObject | null): { asked: boolean; upload: INodeExecutionData } {
    const settings = { json: { ...first.json, ...settingsJson() }, binary: first.binary };
    const asks = (byName(t, 'Asks about a download?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const asked = evaluate(asks, { $json: settings.json }) === true;
    const pageRan = asked && answer !== null;
    const scope = { $: (name: string) => (name === 'Settings' ? { first: () => settings } : { isExecuted: pageRan, last: () => ({ json: answer ?? {} }) }) };
    const values = (byName(t, 'The upload').parameters.assignments as { assignments: { name: string; value: string; type: string }[] }).assignments;
    const json: IDataObject = {};
    let binary: INodeExecutionData['binary'];
    for (const a of values) {
      const v = evaluate(a.value, scope);
      if (a.type === 'binary') binary = { [a.name]: v as NonNullable<INodeExecutionData['binary']>[string] };
      else json[a.name] = v as string;
    }
    return { asked, upload: { json, ...(binary ? { binary } : {}) } };
  }
  /** A draft "proved" by the real proposal builder (no browser), as the replay would return it, with the file it downloaded. */
  const provedWithoutBrowser = (seen: AdoptInput[]) => (input: AdoptInput): AdoptResult => {
    seen.push(input);
    const script: Script = { ...input.draft, version: 1 };
    const file = script.steps.some((s) => 'download' in s)
      ? { file: { fileName: 'LINEITEMS_1000_2026-09-01_2026-09-30.csv', mimeType: 'text/csv', bytes: 357, columns: ['Document', 'Amount'], rows: 8 } } : {};
    const prove = { ok: true, rows: [], total: null, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [], ...file } as unknown as Parameters<typeof buildProposal>[0]['prove'];
    const proposal = buildProposal({ script, prove, masker: createMasker([]), safetyFlags: validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags });
    return { ok: true, lane: 'script', proposal, digest: proposalDigest(proposal), llmCalls: 0, durationMs: 1 };
  };

  it('a UiPath browser project that downloads a file is asked about the file, imports its export as a checked download and can be signed', async () => {
    const project = uipathZip('uipath-sap-light', 'SAP Line Item Export', true);
    const answer = { expectedFileName: '^LINEITEMS_1000_', columns: 'Document, Amount' };
    for (const [source, fileName] of [['UiPath project', 'bot'], [null, 'SAP Line Item Export.zip']] as const) {
      const first = formItem(source as string, project);
      (first.json.bot as IDataObject).filename = fileName;
      expect(throughTheDownloadPage(first, answer).asked, String(source)).toBe(true);
    }
    const { upload } = throughTheDownloadPage(formItem('UiPath project', project), answer);
    expect(upload.json).toMatchObject({ source: 'UiPath project', ...answer });
    expect(resolved(upload)).toMatchObject({ source: 'uipath', expectedFile: { file: { namePattern: '^LINEITEMS_1000_', requiredColumns: 'Document, Amount' } } });
    const seen: AdoptInput[] = [];
    const [data, repaired] = await runImport(upload, provedWithoutBrowser(seen));
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 800)).toBeUndefined();
    // The Export click became the download step the Expected File checks; nothing says it stays a click.
    const download = seen[0].draft.steps.find((s) => 'download' in s) as { download: { check: IDataObject } } | undefined;
    expect(download?.download.check).toEqual({ name: '^LINEITEMS_1000_', columns: ['Document', 'Amount'] });
    const report = JSON.stringify(data[0].json.report);
    expect(report).toContain('the click the source marked as a download became the download step the Expected File checks');
    expect(report).not.toContain('stays a click');
    expect(data[0].json.drafts).toEqual([expect.objectContaining({ adopted: true })]);
    expect(repaired).toHaveLength(1);
    // The review page and Sign steps, as the template wires them: approved, it is signed as the active version 1.
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [data, repaired] } as Record<string, INodeExecutionData[][]>;
    expect(jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(ran) }).map((f) => f.fieldType)).toEqual(['html', 'radio']);
    // Sign steps holds the same Site Login as Import steps (the Set once note says so).
    const approved = await signAfterReview(ran, { decision_0: 'Approve and sign' }, {}, true);
    expect(approved.errors).toEqual([]);
    expect(approved.signed).toEqual([expect.objectContaining({ status: 'active', name: repaired[0].json.name, version: 1 })]);
    const signedSteps = JSON.parse(String(approved.signed[0].steps)) as { steps: IDataObject[] };
    expect(signedSteps.steps.some((s) => 'download' in s)).toBe(true);

    // Before this fix the page was skipped: no Expected File, the export stayed a click and nothing could be signed.
    const skipped = throughTheDownloadPage(formItem('UiPath project', project), null).upload;
    const [before] = await runImport(skipped, provedWithoutBrowser([]));
    expect(JSON.stringify(before[0].json.report)).toContain('without an Expected File this download stays a click');
  });

  it('a UiPath desktop project with both download fields left empty imports exactly as it did without the page', async () => {
    const project = uipathZip('uipath-erp-desktop', 'ERP Demo Line Items');
    const never = () => {
      throw new Error('desktop steps are never replayed');
    };
    const { asked, upload } = throughTheDownloadPage(formItem('UiPath project', project), { expectedFileName: null, columns: null });
    expect(asked).toBe(true);
    expect(upload.json).toMatchObject({ expectedFileName: '', columns: '' });
    const withPage = await runImport(upload, never);
    const withoutPage = await runImport(throughTheDownloadPage(formItem('UiPath project', project), null).upload, never);
    expect(withPage[0][0].json.error).toBeUndefined();
    const drafts = withPage[0][0].json.drafts as IDataObject[];
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d).toMatchObject({ surface: 'desktop', forApproval: true });
    expect(withPage[1]).toHaveLength(drafts.length);
    const shape = (out: INodeExecutionData[][]) => out.map((items) => items.map((i) => ({ json: i.json, binary: Object.fromEntries(Object.entries(i.binary ?? {}).map(([k, b]) => [k, { fileName: b.fileName, data: b.data }])) })));
    expect(shape(withPage)).toEqual(shape(withoutPage));
  });

  it('a form submission reaches the import: the file is read from the form binary and the report comes back on Data', async () => {
    const [data, repaired] = await runImport(formItem('Chrome Recorder', CHROME), () => NOT_ADOPTABLE);
    expect(repaired).toEqual([]);
    expect(data[0].json.error).toBeUndefined();
    expect(data[0].json.report).toMatchObject({ source: 'chrome', steps: 9 });
    expect(data[0].json.drafts).toEqual([expect.objectContaining({ name: 'line-item-export', adopted: false })]);
    // Steps written by hand, uploaded as a step document, take the same way.
    const steps = Buffer.from(JSON.stringify({ startUrl: `${SITE.url}/acme/login`, steps: [{ intent: 'Open the report', goto: '/acme/reports' }] }));
    const [fromDoc] = await runImport(formItem('Step document', steps), () => NOT_ADOPTABLE);
    expect(fromDoc[0].json.report).toMatchObject({ source: 'steps', steps: 1 });
    expect(fromDoc[0].json.drafts).toEqual([expect.objectContaining({ name: 'line-item-export', adopted: false })]);
  });

  it('an RPA recording: the review page shows its steps, the ones the import added in grey, and ticks its candidate writes but the sign-in key; Sign steps signs exactly the ticked and typed writes', async () => {
    const { data, repaired, ran } = await importedRecording();
    expect(data[0].json.report).toMatchObject({ source: 'recording', steps: 17 });
    expect(data[0].binary?.workflow).toMatchObject({ fileName: 'line-item-export.workflow.json' });
    expect(repaired).toHaveLength(1);
    const item = repaired[0].json;
    const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(ran) });
    expect(fields.map((f) => [f.fieldType, f.fieldName])).toEqual([['html', undefined], ['checkbox', 'writes_0'], ['html', undefined], ['text', 'moreWrites_0'], ['radio', 'decision_0']]);
    // A short top: the name and version as the page's title, two sentences.
    const options = review.parameters.options as IDataObject;
    expect(render(String(options.formTitle), { $: nodesRan(ran) })).toBe(`${String(item.name)}, version 1`);
    expect(options.formDescription).toBe('Approve and sign: these steps are signed and run under this name. Reject: nothing is signed.');
    expect(options.buttonLabel).toBe('Submit');
    // What it does besides reading, in short lines, then one short sentence per step: its verb, the value it types or
    // chooses and its field, as the recorder's bar words it; a secret variable never shows a value.
    const POINTER = '<p><em>How each step finds its control is in this run\'s execution in n8n (the Import steps node\'s output), and in the approval email when approval is by email.</em></p>';
    // The steps the import added (a wait for each window, the returned file) keep their numbers, in grey (<i>: the page's
    // CSS colours a list item that holds one, and its number), with one grey line above the list that counts them.
    const added = (l: string) => `<i>${l}</i>`;
    expect(fields[0].html).toBe('<p>Opens ErpDemo.exe on the desktop runner.<br>Returns a file to n8n: step 17.<br>Not tried by the import: read every step before you approve.</p><p><b>The steps</b></p>'
      + '<p><em>12 recorded steps, plus 5 the import added (waits for each window, the returned file)</em></p><ol>'
      + [
        added('Wait for the window ERP Demo - Sign in'), 'Type &quot;clerk&quot; into User name', 'Type into Password <em>· secret variable password</em>', 'Press Enter in Password',
        added('Wait for the window ERP Demo - Line items'), 'Choose &quot;2000&quot; in Company code', 'Type &quot;2026-01-20&quot; into Date from', 'Type &quot;2026-11-30&quot; into Date to',
        'Click Search', 'Click Vendor Row 1', 'Click File', added('Wait for the next window of erpdemo.exe'), 'Click Export...', added('Wait for the window Export line items'),
        'Save line-items.csv into the run&#39;s export folder', 'Click Save', added('Return the exported file line-items.csv <em>· returns a file</em>'),
      ].map((l) => `<li>${l}</li>`).join('') + `</ol>${POINTER}`);
    // The parenthesis names the returned file only when one of the added steps returns it.
    const noFile = { ...item, reviewSteps: (item.reviewSteps as { text: string; marks: string[]; added?: true }[]).filter((r) => !r.marks.includes('returns a file')) };
    const noFileFields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan({ ...ran, 'Import steps': [[{ json: data[0].json }], [{ json: noFile }]] }) });
    expect(noFileFields[0].html).toContain('<em>13 recorded steps, plus 4 the import added (waits for each window)</em>');
    expect(noFileFields[0].html).not.toContain('the returned file)');
    expect(String((review.parameters.options as IDataObject).customCss)).toContain('div.html li:has(> i) { color: #7e8186; }\ndiv.html li > i { font-style: normal; color: #7e8186; }');
    expect((item.steps as { steps: unknown[] }).steps).toHaveLength(17);
    // The candidate writes are asked, not explained twice: ticked to start with (the person here recorded or imported the
    // bot), except a key pressed in the password field: that signs in, it does not save. It stays in the list, unticked.
    expect(fields[1]).toEqual({
      fieldLabel: 'Which of these steps save, send or submit?', fieldName: 'writes_0', fieldType: 'checkbox',
      fieldOptions: { values: [{ option: 'Step 4: Press Enter in Password' }, { option: 'Step 16: Click Save' }] }, defaultValue: 'Step 16: Click Save',
    });
    // The page places what Import steps built (reviewSteps, writeCandidates); it reads nothing from Data's drafts.
    const noDrafts = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan({ ...ran, 'Import steps': [[{ json: { ...data[0].json, drafts: [] } }], repaired] }) });
    expect(noDrafts).toEqual(fields);
    expect(fields[0].html).not.toContain('candidate');
    expect(fields[3]).toMatchObject({ fieldLabel: 'Any other step that saves, sends or submits (its number, optional)', placeholder: '7, 9' });
    expect(fields[3]).not.toHaveProperty('requiredField');
    expect(fields[2].html).toBe('<p><em>Ticked steps are allowed to save or send. An unticked step is stopped only when it tries to use a control or key that your administrator has protected on the bot machine.</em></p>');
    expect(fields[4]).toEqual({ fieldLabel: 'Decision', fieldName: 'decision_0', fieldType: 'radio', fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] }, requiredField: true });
    // The page ends at the decision. Settings → showDetails puts the full detail (the item's own texts, escaped, small and
    // grey) back, above the question, in place of the pointer.
    expect(settingsJson().showDetails).toBe(false);
    const detailed = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan({ ...ran, Settings: [[{ json: { ...settingsJson(), showDetails: true } }]] }) });
    expect(detailed.map((f) => f.fieldType)).toEqual(['html', 'checkbox', 'html', 'text', 'radio']);
    expect(detailed[0].html).toBe(String(fields[0].html).replace(POINTER, '') + '<h4>Details of every step (how each one finds its control)</h4>'
      + `<p><em><b>Safety flags:</b> ${escapeHtml(String(item.safetyLine))}</em></p>`
      + `<p><em><b>Evidence:</b> ${escapeHtml(String(item.evidenceLine))}</em></p>`
      + `<p><em><b>The steps:</b><br>${escapeHtml(String(item.changeList)).split('\n').join('<br>')}</em></p>`);
    expect(String(options.customCss)).toContain('div.html em { font-style: normal; color: #7e8186; font-size: 12px; }');

    // Step 4 unticked, step 9 typed: exactly steps 9 and 16 are signed as writes.
    const approved = await signAfterReview(ran, { writes_0: ['Step 16: Click Save'], moreWrites_0: '9', decision_0: 'Approve and sign' });
    expect(approved.lists).toEqual([item]);
    expect(approved.signed).toHaveLength(1);
    expect(approved.signed[0]).toMatchObject({ status: 'active', name: item.name, version: 1, approvedBy: APPROVER, writeLine: 'Signed as writes: step 9 (Click Search), step 16 (Click Save)' });
    const steps = JSON.parse(String(approved.signed[0].steps)) as { steps: { write?: boolean }[] };
    expect(steps.steps.flatMap((s, i) => (s.write ? [i + 1] : []))).toEqual([9, 16]);
    // Everything unticked: no write.
    const none = await signAfterReview(ran, { writes_0: [], moreWrites_0: null, decision_0: 'Approve and sign' });
    expect(none.signed[0]).toMatchObject({ status: 'active', writeLine: 'Signed as writes: none' });
    // Reject: a rejected record, nothing signed.
    const rejected = await signAfterReview(ran, { writes_0: ['Step 16: Click Save'], decision_0: 'Reject' });
    expect(rejected.signed).toEqual([expect.objectContaining({ status: 'rejected', name: item.name, steps: '', signature: '', approvedBy: APPROVER })]);
    // A decision the form did not send (n8n gives null): a rejection too.
    expect((await signAfterReview(ran, { decision_0: null })).signed[0]).toMatchObject({ status: 'rejected' });
    // The page was not answered in time: it gives its input item on, with no decision, and no step list reaches Sign steps.
    expect(evaluate(String(byName(t, 'Step lists').parameters.jsonOutput), { $: nodesRan({ ...ran, [REVIEW]: [[{ json: { name: 'steps table' } }]] }) })).toEqual({ lists: [] });
    // The template 3 path keeps its texts for the same item.
    const t3 = load('3-approve-steps.json');
    const ask = render(String(byName(t3, 'Ask for approval (desktop steps)').parameters.message), {
      $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : item } }),
    });
    expect(ask).toContain('Evidence: Not replayed: desktop steps imported from a recording are reviewed as written');
    expect(sticky(t3, 'About this workflow').content).toContain('Desktop steps (imported from UiPath or a recording, or from a step document; not replayed)');
    expect(sticky(t, 'About this workflow').content).toContain('an **RPA recording** saved by the RPA recorder on the Windows machine');
  });

  it('a Sign steps refusal signs nothing and the last page names the reason; an approver not on the allowlist is refused', async () => {
    const { ran } = await importedRecording();
    const refused = await signAfterReview(ran, { writes_0: [], moreWrites_0: '99', decision_0: 'Approve and sign' });
    expect(refused.signed).toEqual([]);
    expect(String(refused.errors[0].error)).toBe('Sign Steps refused: Write Steps: there is no step 99 (the steps are numbered 1 to 17)');
    // With a second address on the allowlist, Approved By must say which one decided: an empty one is refused.
    const two = await signAfterReview(ran, { decision_0: 'Approve and sign' }, { approverAllowlist: `${APPROVER}, someone-else@example.com` });
    expect(two.signed).toEqual([]);
    expect(String(two.errors[0].error)).toBe('Sign Steps refused: Approved By is empty, and the Approver Allowlist holds more than one address: set Approved By to the one who decided');
  });

  it('several step lists: one block each, named, with its own decision; item n of Sign steps takes the answers of block n', async () => {
    const { data, repaired } = await importedRecording();
    // A candidate whose intent holds a comma and angle brackets: n8n compares the ticked-to-start labels with the options
    // after its JSON-form escaping of < and > (not applied to options) and splits the start value at commas.
    const candidate = { step: 3, intent: 'Save, then <b>close</b>' };
    const two = [repaired[0], { json: { ...repaired[0].json, name: 'second<b>', writeCandidates: [...(repaired[0].json.writeCandidates as IDataObject[]), candidate] } }];
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [data, two] } as Record<string, INodeExecutionData[][]>;
    const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(ran) });
    const html = fields.filter((f) => f.fieldType === 'html').map((f) => String(f.html));
    expect(html.map((h) => h.slice(0, 4))).toEqual(['<h3>', '<p><', '<h3>', '<p><']);
    expect(html[0]).toMatch(/^<h3>1 of 2: line-item-export, version 1<\/h3><p>Opens ErpDemo.exe/);
    expect(html[2]).toMatch(/^<h3>2 of 2: second&lt;b&gt;, version 1<\/h3>/);
    // The page ends at the last decision: no detail block after it.
    expect(fields.at(-1)).toMatchObject({ fieldType: 'radio', fieldName: 'decision_1' });
    expect(render(String((review.parameters.options as IDataObject).formTitle), { $: nodesRan(ran) })).toBe('Review 2 step lists');
    expect(fields.filter((f) => f.fieldType === 'radio').map((f) => [f.fieldName, f.fieldLabel])).toEqual([['decision_0', `${String(two[0].json.name)}: Decision`], ['decision_1', 'second<b>: Decision']]);
    const ticks = fields.find((f) => f.fieldName === 'writes_1');
    expect(ticks?.fieldOptions?.values.map((v) => v.option)).toEqual(['Step 4: Press Enter in Password', 'Step 16: Click Save', 'Step 3: Save; then \u2039b\u203aclose\u2039/b\u203a']);
    // Ticked to start with, but the key that signs in: the second list carries its own hints.
    expect(ticks?.defaultValue?.split(',')).toEqual(['Step 16: Click Save', 'Step 3: Save; then \u2039b\u203aclose\u2039/b\u203a']);
    expect(ticks?.fieldLabel).toBe('second<b>: Which of these steps save, send or submit?');
    const sign = byName(t, 'Sign steps').parameters;
    const answer = { decision_0: 'Reject', decision_1: 'Approve and sign', writes_1: ['Step 3: x'], moreWrites_1: '5' };
    const at = (i: number) => evaluate(String(sign.approved), { $: nodesRan({ ...ran, [REVIEW]: [[{ json: answer }]] }), $itemIndex: i });
    expect([at(0), at(1)]).toEqual([false, true]);
    expect(evaluate(String(sign.writeSteps), { $: nodesRan({ ...ran, [REVIEW]: [[{ json: answer }]] }), $itemIndex: 1 })).toBe('3 5');
    expect(evaluate(String(sign.writeSteps), { $: nodesRan({ ...ran, [REVIEW]: [[{ json: answer }]] }), $itemIndex: 0 })).toBe('');
  });

  it('browser steps on the review page: the sites, the sign-in, forms, files and what the replay proved in short lines; the steps with their variables; no write question; the full text below', async () => {
    const item = {
      name: 'feed<i>', version: 1, attachmentNames: 'after',
      steps: { startUrl: 'https://a.example/', steps: [
        { intent: 'Open the list', goto: 'https://a.example/list' }, { intent: 'Sign in', signIn: {} },
        { intent: 'Type the export password', fill: { field: { css: '#p' }, value: '{{var.exportPassword}}', secret: true } },
        { intent: 'Pick <b>Status</b>', select: { field: { css: '#s' }, value: '{{var.status}}' } }, { intent: 'Download the report', download: {} },
        // A typed value the intent does not say: the short list shows it.
        { intent: 'Type the note', fill: { field: { css: '#n' }, value: 'hello <b>' } },
      ] },
      safetyFlags: ['host: a.example\' <script>', 'form submission: POST a.example/send', 'download step', 'secret fill: a step types the run variable {{var.exportPassword}}'],
      safetyLine: 'host: a.example\' <script>; …', evidenceLine: '7 rows <img src=x onerror=alert(1)>; compared with the repair run: 0 missing, 0 extra',
      changeList: 'Added: Open the list\nAdded: Read "rows" $& $$', leftOutList: 'step 4, Pick <b>Status</b>\nstep 9, Wait',
    };
    // As Import steps builds it from the steps.
    const withLines = { ...item, reviewSteps: reviewSteps(item.steps.steps, { desktop: false }) };
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [] } }], [{ json: withLines }]] } as Record<string, INodeExecutionData[][]>;
    const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(ran) });
    expect(fields.map((f) => f.fieldType)).toEqual(['html', 'radio']);
    const POINTER = '<p><em>How each step finds its control is in this run\'s execution in n8n (the Import steps node\'s output), and in the approval email when approval is by email.</em></p>';
    expect(fields[0].html).toBe('<p>Opens a.example&#39; &lt;script&gt;.<br>Signs in with the RPA Site Login.<br>Submits a form: POST a.example/send.<br>Returns a file to n8n: step 5.<br>'
      + 'secret fill: a step types the run variable {{var.exportPassword}}<br>7 rows &lt;img src=x onerror=alert(1)&gt;.</p>'
      + '<p><b>⚠ Left out by the import:</b><br>step 4, Pick &lt;b&gt;Status&lt;/b&gt;<br>step 9, Wait</p>'
      + '<p><b>The steps</b></p><ol><li>Open the list</li><li>Sign in <em>· signs in with the RPA Site Login</em></li><li>Type the export password <em>· secret variable exportPassword</em></li>'
      + '<li>Pick &lt;b&gt;Status&lt;/b&gt; <em>· variable status</em></li><li>Download the report <em>· returns a file</em></li><li>Type the note: &quot;hello &lt;b&gt;&quot;</li></ol>' + POINTER);
    const detailed = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan({ ...ran, Settings: [[{ json: { ...settingsJson(), showDetails: true } }]] }) });
    expect(detailed[0].html).toBe(String(fields[0].html).replace(POINTER, '') + '<h4>Details of every step (how each one finds its control)</h4><p><em><b>Safety flags:</b> host: a.example&#39; &lt;script&gt;; …</em></p>'
      + '<p><em><b>Left out by the import (the source does these, the steps do not):</b><br>step 4, Pick &lt;b&gt;Status&lt;/b&gt;<br>step 9, Wait</em></p>'
      + '<p><em><b>Evidence (as reported by the run):</b> 7 rows &lt;img src=x onerror=alert(1)&gt;; compared with the repair run: 0 missing, 0 extra</em></p>'
      + '<p><em><b>What changed (as reported by the run):</b><br>Added: Open the list<br>Added: Read &quot;rows&quot; $&amp; $$</em></p>'
      + '<p><em>Screenshots of the replay are in this execution in n8n, on the Repaired Steps output of Import steps.</em></p>');
    const notRun = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan({ Settings: [[{ json: { ...settingsJson(), showDetails: true } }]], 'Import steps': [ran['Import steps'][0], [{ json: { ...withLines, evidenceLine: NOT_REPLAYED_LINE, attachmentNames: '', leftOutList: undefined } }]] }) });
    expect(notRun[0].html).toContain('<br>Not run by the import: check every step, each form&#39;s target and each download before you approve.</p><p><b>The steps</b></p><ol>');
    expect(notRun[0].html).toContain(`<b>Evidence:</b> ${escapeHtml(NOT_REPLAYED_LINE)}</em></p><p><em><b>What changed (as written; these steps were never run):</b>`);
    expect(notRun[0].html).not.toContain('Screenshots');
    // A variable written with spaces gets its mark too (the page's own regex used to miss it).
    expect(reviewSteps([{ intent: 'Type the note', fill: { field: { label: 'Note' }, value: '{{ var.note }}' } }], { desktop: false }))
      .toEqual([{ text: 'Type the note', marks: ['variable note'] }]);
    expect(reviewSteps([{ intent: 'Pick', select: { field: { uia: { path: [{ controlType: 'ComboBox', name: 'Plant' }] } }, option: '{{ var.plant }}' } }], { desktop: true }))
      .toEqual([{ text: 'Choose an item in Plant', marks: ['variable plant'] }]);
    // A desktop read names its control by the name a person sees, never by its automation id, and says the output once.
    const read = (cond: Record<string, string>) => ({ intent: `Read ${cond.name ?? cond.automationId} as out_result_count`, read: { target: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ automationId: 'gridResults' }, cond] } }, as: 'out_result_count' } });
    expect(reviewSteps([read({ controlType: 'Text', automationId: 'lblResultCount' }), read({ controlType: 'Text', automationId: 'lblCount', name: ' Result count ' })], { desktop: true })).toEqual([
      { text: 'Read a value from the app', marks: ['gives its text to n8n as out_result_count'] },
      { text: 'Read Result count', marks: ['gives its text to n8n as out_result_count'] },
    ]);
    // A control with neither a name nor an id: the step's own intent, with the typed or chosen value when the intent
    // does not say it, and never a variable's value.
    const bare = { uia: { path: [{ controlType: 'Edit' }] } };
    expect(reviewSteps([
      { intent: 'Type into the date field', fill: { field: bare, value: '2026-01-20' } },
      { intent: 'Type 2026-01-20 as the date', fill: { field: bare, value: '2026-01-20' } },
      { intent: 'Type the date', fill: { field: bare, value: '{{var.date}}' } },
      { intent: 'Pick the plant', select: { field: bare, option: '1000' } },
      { intent: 'Tick the box', check: { field: bare, checked: true } },
    ], { desktop: true }).map((r) => r.text)).toEqual([
      'Type into the date field: "2026-01-20"', 'Type 2026-01-20 as the date', 'Type the date', 'Pick the plant: "1000"', 'Tick the box',
    ]);
  });

  it('a recording\'s marks name its secret variables from the import, never a value', async () => {
    const { repaired, ran } = await importedRecording();
    const data = ran['Import steps'][0][0].json as { drafts: IDataObject[] };
    expect(data.drafts[0]).toMatchObject({ surface: 'desktop', secretVariables: ['password'] });
    expect((repaired[0].json.reviewSteps as IDataObject[])[2]).toEqual({ text: 'Type into Password', marks: ['secret variable password'] });
    const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(ran) });
    expect(fields[0].html).toContain('<li>Type into Password <em>· secret variable password</em></li>');
  });

  it('an import with an untranslated step puts it into leftOut and both emails show it', async () => {
    // The draft proved as version 1 by the real proposal builder (no browser).
    const proved = (input: AdoptInput): AdoptResult => {
      const script: Script = { ...input.draft, version: 1 };
      const prove = { ok: true, rows: [], total: null, reasons: [], diff: { missing: [], extra: [] }, policyViolation: false, readPosts: [] } as unknown as Parameters<typeof buildProposal>[0]['prove'];
      const proposal = buildProposal({ script, prove, masker: createMasker([]), safetyFlags: validateScript(script, { policy: input.policy, secrets: input.secrets, mode: 'proposal' }).safetyFlags });
      return { ok: true, lane: 'script', proposal, digest: proposalDigest(proposal), llmCalls: 0, durationMs: 1 };
    };
    const [data, repaired] = await runImport(formItem('Chrome Recorder', CHROME), proved);
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 800)).toBeUndefined();
    const item = repaired[0].json;
    const untranslated = 'step 11, Wait for a JavaScript condition: steps do not run page JavaScript: add a waitFor on what the page shows when it is ready';
    expect(item.leftOut).toContain(untranslated);
    const t3 = load('3-approve-steps.json');
    const review = render(String(byName(t3, 'Email repaired steps').parameters.html), { $json: item });
    const ask = render(String(byName(t3, 'Ask for approval').parameters.message), {
      $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : item } }),
    });
    for (const shown of [review, ask]) {
      expect(shown).toContain(LEFT_OUT_HEADING);
      expect(shown).toContain(untranslated);
      // Under its own heading, before the evidence.
      expect(shown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(shown.indexOf('Evidence'));
    }
  });

  it('the last page reports what was imported and, after the review page, what was signed; a UiPath import also returns the workflow file (n8n Form Ending: Return Binary File)', async () => {
    const shown = completion('Imported');
    expect(shown).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Imported' });
    const [data] = await runImport(formItem('Chrome Recorder', CHROME), () => NOT_ADOPTABLE);
    const page = (message: string, ran: Record<string, INodeExecutionData[][]>) => render(message, { $: nodesRan({ Settings: [[{ json: settingsJson() }]], ...ran }) });
    const message = page(shown.completionMessage, { 'Import steps': [data, []] });
    // The fixture's report: 9 steps, one recorder step not translated, three typed values (username, password, code) removed.
    const items = (data[0].json.report as { items: { kind: string }[] }).items;
    expect(items.filter((i) => i.kind === 'untranslated')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'secret')).toHaveLength(3);
    expect(message).toContain('Imported: 9 steps; 1 not translated, 3 removed as secrets.');
    expect(message).toContain('removed as secrets.\n0 of 1 step list passed the replay.\n');
    // Only what applies: no zero counts, and a workflow that is not from a UiPath project is the bot's own.
    const first = (report: Record<string, unknown>) => page(shown.completionMessage, { 'Import steps': [[{ json: { report, drafts: [] } }], []] }).split('\n')[0];
    expect(first({ steps: 17, items: [] })).toBe('Imported: 17 steps.');
    expect(first({ steps: 1, items: [{ kind: 'secret' }] })).toBe('Imported: 1 step; 1 removed as secrets.');
    expect(first({ steps: 5, items: [{ kind: 'untranslated' }, { kind: 'untranslated' }] })).toBe('Imported: 5 steps; 2 not translated.');
    const fileLine = (report: Record<string, unknown>) => page(completion('Imported, with the workflow file').completionMessage, {
      'Import steps': [[{ json: { report, drafts: [] }, binary: { workflow: { fileName: 'bot.workflow.json', data: '', mimeType: 'application/json' } } }], []],
    }).split('\n').at(-1);
    expect(fileLine({ source: 'recording', steps: 17, items: [] })).toBe('Your browser downloads bot.workflow.json: the workflow that runs the bot. Open it in n8n with Import from file.');
    expect(fileLine({ source: 'chrome', steps: 9, items: [{ kind: 'untranslated' }] })).toBe('Your browser downloads bot.workflow.json: the workflow that runs the bot. Open it in n8n with Import from file.');
    expect(fileLine({ source: 'uipath', steps: 9, items: [] })).toBe('Your browser downloads bot.workflow.json: the rest of the bot as an n8n workflow. Open it in n8n with Import from file.');
    expect(fileLine({ source: 'uipath', steps: 9, items: [{ kind: 'untranslated' }] }))
      .toBe('Your browser downloads bot.workflow.json: the rest of the bot as an n8n workflow. Open it in n8n with Import from file; grey notes in it mark what was not translated.');
    // Approval by email: the step lists wait in RPA: 3 (each count in the singular or the plural, "there too" once the workflow was named).
    const email = (drafts: Record<string, unknown>[]) => page(shown.completionMessage, {
      Settings: [[{ json: { ...settingsJson(), approval: 'by email' } }]], 'Import steps': [[{ json: { report: { steps: 9, items: [] }, drafts } }], []],
    }).split('\n')[1];
    const draft = (over: Record<string, unknown>) => ({ name: 'n', adopted: false, ...over });
    // Approve steps names no workflow in the file: the page says that nothing was sent.
    expect(email([draft({ adopted: true })])).toBe('Nothing was sent for approval: Settings say approval by email, but Approve steps names no workflow. Follow the sticky Approval by email, or set approval to on this form.');
    const setUp = (drafts: Record<string, unknown>[]) => render(shown.completionMessage, {
      $: (name: string) => (name === 'Approve steps'
        ? { ...nodesRan({})(name), params: { workflowId: { __rl: true, mode: 'list', value: 'wf-3' } } }
        : nodesRan({ Settings: [[{ json: { ...settingsJson(), approval: 'by email' } }]], 'Import steps': [[{ json: { report: { steps: 9, items: [] }, drafts } }], []] })(name)),
    }).split('\n')[1];
    expect(setUp([draft({ adopted: true })])).toBe('1 of 1 step list passed the replay and is waiting for approval in RPA: 3 Approve steps.');
    expect(setUp([draft({ adopted: true }), draft({ adopted: true }), draft({}), draft({ surface: 'desktop', forApproval: true }), draft({ surface: 'desktop', forApproval: true })]))
      .toBe('2 of 3 step lists passed the replay and are waiting for approval in RPA: 3 Approve steps. 2 desktop step lists are waiting there too, not replayed: review every step and tick the steps that save, send or submit.');
    expect(setUp([draft({}), draft({ forApproval: true }), draft({ forApproval: true })]))
      .toBe('0 of 1 step list passed the replay. 2 browser step lists are waiting for approval in RPA: 3 Approve steps, not replayed because the steps submit a form, download through a form, type a secret or change a password: check every step, the target of each form and each download.');
    expect(setUp([draft({ surface: 'desktop', forApproval: true }), draft({ forApproval: true })]))
      .toBe('1 desktop step list is waiting for approval in RPA: 3 Approve steps, not replayed: review every step and tick the steps that save, send or submit. 1 browser step list is waiting there too, not replayed because the steps submit a form, download through a form, type a secret or change a password: check every step, the target of each form and each download.');
    // After the review page: one line per step list, from Sign steps' outputs, escaped.
    const reviewed = (signed: IDataObject[], refused: IDataObject[], drafts = [draft({ adopted: true }), draft({})]) => page(shown.completionMessage, {
      'Import steps': [[{ json: { report: { steps: 9, items: [] }, drafts } }], []], [REVIEW]: [[{ json: { decision_0: 'Approve' } }]],
      'Sign steps': [signed.map((json) => ({ json })), refused.map((json) => ({ json }))],
    }).split('\n').slice(1, -1);
    expect(reviewed([
      { status: 'active', name: 'erp<1>', version: 1, writeLine: 'Signed as writes: step 16 (Click Save)' }, { status: 'active', name: 'feed', version: 1 }, { status: 'rejected', name: 'other', version: 1 },
    ], [{ error: 'Sign Steps refused: the steps do not match the hash that was reviewed', details: { name: 'bad', version: 1 } }, { error: 'Sign Steps needs an RPA Step Signing credential', details: { name: null } }])).toEqual([
      '1 of 2 step lists passed the replay.',
      'Approved and signed: erp&lt;1&gt; v1 is now the version that runs under that name. Signed as writes: step 16 (Click Save).',
      'Approved and signed: feed v1 is now the version that runs under that name.',
      'Rejected: other v1. Nothing was signed.',
      'Not signed: bad v1. Sign Steps refused: the steps do not match the hash that was reviewed',
      'Not signed. Sign Steps needs an RPA Step Signing credential',
    ]);
    expect(reviewed([], [], [draft({ surface: 'desktop', forApproval: true })])).toEqual(['Nothing was signed: the review page was not answered in time.']);
    // Both pages say the same about the step lists.
    expect(completion('Imported, with the workflow file').completionMessage.split('\n')[1]).toBe(shown.completionMessage.split('\n')[1]);
    const ifParams = byName(t, 'Workflow file?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } };
    expect(ifParams.conditions.conditions).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    // Every import with steps comes with a workflow file now, a Chrome recording's too.
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [data, []] }) })).toBe(true);
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [[{ json: { report: {}, drafts: [] } }], []] }) })).toBe(false);
    // After the review page, the file comes only when a step list was approved: a rejected bot gets no workflow to run.
    const afterReview = (answer: IDataObject) => evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [data, []], [REVIEW]: [[{ json: answer }]] }) });
    expect(afterReview({ decision_0: 'Approve and sign' })).toBe(true);
    expect(afterReview({ decision_0: 'Reject', decision_1: 'Approve and sign' })).toBe(true);
    expect(afterReview({ decision_0: 'Reject' })).toBe(false);
    expect(afterReview({ decision_0: 'Reject', decision_1: 'Reject' })).toBe(false);
    // Not answered in time: the page gives its input item on, with no decision.
    expect(afterReview({ name: 'steps table' })).toBe(false);

    const withFile = completion('Imported, with the workflow file');
    expect(withFile).toMatchObject({ operation: 'completion', respondWith: 'returnBinary', inputDataFieldName: 'workflow', completionTitle: 'Imported' });
    const uipath = uipathZip();
    const [ui] = await runImport(formItem('UiPath project', uipath), () => NOT_ADOPTABLE);
    expect(ui[0].binary?.workflow).toMatchObject({ mimeType: 'application/json', fileName: 'line-item-export.workflow.json' });
    // n8n's Return Binary File looks for the field on the page's parent nodes: Import steps is one of them on both paths.
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [ui, []] }) })).toBe(true);
    const uiMessage = page(withFile.completionMessage, { 'Import steps': [ui, []] });
    expect(uiMessage).toMatch(/^Imported: \d+ steps[;.]/);
    expect(uiMessage).toContain('line-item-export.workflow.json');
    expect(uiMessage).toContain('Import from file');
  });

  it('a refusal that names a login page the Site Login does not list: a page that says what to add where, and Import again with the same file', () => {
    const cond = (byName(t, 'Missing login page?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const refusal = 'auth_blocked: Sign in: the password field is on sandbox:8080/acme/signin <b>$&</b>, which is not listed in the Site Login under Pages Where the Password May Be Typed';
    expect(evaluate(cond, { $json: { error: refusal } })).toBe(true);
    expect(evaluate(cond, { $json: { error: 'drift_detected: No element found' } })).toBe(false);
    expect(evaluate(cond, { $json: {} })).toBe(false);
    const page = byName(t, 'Add the login page');
    expect(page).toMatchObject({ type: COMPLETION, parameters: { operation: 'page', defineForm: 'json', options: { formTitle: 'Add the login page', formDescription: 'Nothing was imported and nothing was signed.', buttonLabel: 'Import again' } } });
    const fields = jsonFormFields(String(page.parameters.jsonOutput), { $json: { error: refusal } });
    expect(fields).toEqual([{ fieldType: 'html', html: `<p><b>The sign-in was refused:</b> ${escapeHtml(refusal)}</p><ol><li>In n8n, open the <b>RPA Site Login</b> credential that Import steps uses.</li><li>Add the address named above to <b>Pages Where the Password May Be Typed</b> (one address per line) and save.</li><li>Click <b>Import again</b>: the same file is imported again.</li></ol>` }]);
  });

  it('a failed import shows its reason on a completion page', async () => {
    const page = completion('Import failed');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Nothing to approve' });
    const [data] = await runImport(formItem('Chrome Recorder', CHROME), () => failure('drift_detected', 'No element found for Visible Text "Line Item Report"'));
    // AI Repair is off and no model is connected: the reason is the step's own, with no word about a model.
    expect(data[0].json.error).toBe('drift_detected: No element found for Visible Text "Line Item Report"');
    const shown = render(page.completionMessage, { $json: data[0].json });
    expect(shown).toMatch(/^drift_detected: No element found for Visible Text "Line Item Report"\n/);
    expect(shown).toContain('\nDetails, including the import report when there is one, are in the error output of Import steps in this execution.');
  });

  it('has the stickies: About (grey), Set once (green, a checklist), Approval by email (grey, the option), Why approval (grey)', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    expect(sticky(t, 'Approval by email').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Why approval').color).toBe(COLOUR.grey);
    // Three sentences. What is replayed, what is not and how step lists are named are on the review page and in move-a-bot.md.
    const form = (byName(t, 'Import a bot').parameters as { formDescription?: string }).formDescription ?? '';
    expect(form).toBe('Upload a bot: an RPA recording, a UiPath project (ZIP or XAML), a Chrome Recorder export (JSON), Playwright code, or steps you wrote (JSON). You review every step on the next page. Nothing runs until you approve it.');
    const about = sticky(t, 'About this workflow').content;
    for (const s of ['Chrome Recorder', 'Playwright code', 'UiPath', 'RPA: 2 Data feed', 'each step list gets its own approval',
      '**step document**', 'this is how hand-written steps get approved and signed']) expect(about, s).toContain(s);
    const set = sticky(t, 'Set once').content;
    expectChecklist(set);
    for (const s of ['Keep **Authentication** on', 'Basic Auth credential on **Import a bot**', '**RPA Browser**', '**RPA Site Login**', '**RPA Step Signing**',
      '**Sign steps → Approver Allowlist**', '**Options → Allow Private Network**', 'Publish']) expect(set, s).toContain(s);
    expect(set).toContain('Type your address once, in **Sign steps → Approver Allowlist**');
    expect(set).not.toContain('Settings → approver');
    // The default path needs no other template.
    expect(set).not.toContain('RPA: 3');
    const email = sticky(t, 'Approval by email').content;
    for (const s of ['**RPA: 3 Approve steps**', 'publish it', 'In **Approve steps**, choose **RPA: 3 Approve steps**, then turn the node on', 'set `approval` to `by email`']) expect(email, s).toContain(s);
    const why = sticky(t, 'Why approval').content;
    for (const s of ['never', 'Sign Steps', 'password', 'the review page ticks the steps that may save, send or submit']) expect(why, s).toContain(s);
  });
});
