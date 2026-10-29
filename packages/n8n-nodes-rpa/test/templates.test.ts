import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  NodeHelpers, Workflow, type IDataObject, type INodeExecutionData, type INodeParameters, type INodeProperties, type INodeTypes,
} from 'n8n-workflow';
import {
  IMPORT_NOT_ADOPTABLE, importSource as realImportSource, scriptHash, type AdoptResult, type Proposal, type Script, type TaskResult,
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
  '1-create-tables.json': 'RPA: 1 Create tables (run once)',
  '2-data-feed.json': 'RPA: 2 Data feed',
  '3-approve-steps.json': 'RPA: 3 Approve steps',
  '5-import-a-bot.json': 'RPA: 5 Import a bot',
  'hello-world.json': 'RPA: Hello world',
} as const;
const load = (file: string): Template => JSON.parse(readFileSync(new URL(`../templates/${file}`, import.meta.url), 'utf8')) as Template;
const NODE_TYPE = 'n8n-nodes-rpa.playwright';
const STICKY = 'n8n-nodes-base.stickyNote';
const DATA_TABLE = 'n8n-nodes-base.dataTable';
const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
/** n8n sticky colours (design-system tokens --sticky--color--background--variant-N): 4 green, 2 gold (n8n's nearest to orange), 7 grey. */
const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
const SETTINGS_NAME = "$('Settings').item.json.name";
const AI_REPAIR = "={{ $('Get pending').all().filter(i => i.json.hash && DateTime.fromISO(i.json.expiresAt) > $now).length === 0 }}";
const EXPIRES_AT = "={{ $now.plus({ hours: $('Settings').item.json.approvalTimeoutHours }).toISO() }}";
const APPROVER = 'approver@example.com';

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

describe('1-create-tables.json', () => {
  const t = load('1-create-tables.json');
  it('creates both Data Tables with the documented columns, if they do not exist', () => {
    const create = (name: string) => byName(t, name).parameters as { resource: string; operation: string; tableName: string; columns: { column: unknown[] }; options: IDataObject };
    expect(create('Create steps table')).toMatchObject({ resource: 'table', operation: 'create', tableName: STEPS_TABLE, options: { createIfNotExists: true } });
    expect(create('Create steps table').columns.column).toEqual(STEPS_TABLE_COLUMNS);
    expect(create('Create run log table')).toMatchObject({ resource: 'table', operation: 'create', tableName: RUN_TABLE, options: { createIfNotExists: true } });
    expect(create('Create run log table').columns.column).toEqual(RUN_TABLE_COLUMNS);
    expect(targets(t, 'Run once')).toEqual([['Create steps table']]);
    expect(targets(t, 'Create steps table')).toEqual([['Create run log table']]);
    expect(t.nodes.map((n) => n.name).sort()).toEqual(['About this workflow', 'Create run log table', 'Create steps table', 'Run once']);
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
    for (const s of ['**RPA Browser**: Run steps', '**RPA Site Login**: Run steps', '**RPA Step Signing**: Run steps', '**Chat model**', '**Alert on failure**', 'RPA: 3 Approve steps', 'RPA: 1 Create tables (run once)']) {
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
    expect(targets(t, 'Settings')).toEqual([['Get pending']]);
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
  it('needs at most 9 working nodes: stickies, the chat model and the destination placeholder not counted', () => {
    const working = t.nodes.filter((n) => ![STICKY, '@n8n/n8n-nodes-langchain.lmChatAnthropic', 'n8n-nodes-base.noOp'].includes(n.type)).map((n) => n.name);
    expect(working.sort()).toEqual(['Alert on failure', 'Approve steps', 'Every 6 hours', 'Get active steps', 'Get pending', 'Log failed run', 'Log run', 'Run steps', 'Settings']);
    // 16 nodes in total: 5 stickies, the chat model, the 9 working nodes and the destination placeholder.
    expect(t.nodes).toHaveLength(16);
    expect(t.nodes.filter((n) => n.type === STICKY)).toHaveLength(5);
    expect(t.nodes.filter((n) => n.type === 'n8n-nodes-base.noOp').map((n) => n.name)).toEqual(['Send data to destination']);
  });
});

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
  it('trigger → email → Settings → Mark pending → Desktop steps? → Ask for approval (desktop: form → Desktop answer) → Timed out? (yes → Record expiry, no → Repaired steps to sign → Sign steps)', () => {
    expect(targets(t, 'Repaired steps received')).toEqual([['Email repaired steps']]);
    expect(targets(t, 'Email repaired steps')).toEqual([['Settings']]);
    expect(targets(t, 'Settings')).toEqual([['Mark pending']]);
    expect(targets(t, 'Mark pending')).toEqual([['Desktop steps?']]);
    expect(targets(t, 'Desktop steps?')).toEqual([['Ask for approval (desktop steps)'], ['Ask for approval']]);
    expect(targets(t, 'Ask for approval')).toEqual([['Timed out?']]);
    expect(targets(t, 'Ask for approval (desktop steps)')).toEqual([['Desktop answer']]);
    expect(targets(t, 'Desktop answer')).toEqual([['Timed out?']]);
    expect(targets(t, 'Timed out?')).toEqual([['Record expiry'], ['Repaired steps to sign']]);
    expect(targets(t, 'Repaired steps to sign')).toEqual([['Sign steps']]);
    expect(byName(t, 'Settings').parameters).toMatchObject({
      assignments: { assignments: [{ name: 'name', value: "={{ $('Repaired steps received').item.json.name }}" }, { name: 'approvalTimeoutHours', value: 72, type: 'number' }] },
    });
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
    expect(table(byName(t, 'Record rejection')).columns?.value).toEqual({ status: 'rejected', approvedBy: APPROVER, approvedAt: '={{ $now.toISO() }}' });
  });
  it('Supersede older versions runs after Save signed steps: every other active row of the same name up to the new version becomes superseded (I1)', () => {
    expect(targets(t, 'Save signed steps')).toEqual([['Supersede older versions', 'Email signed steps']]);
    expect(targets(t, 'Supersede older versions')).toEqual([]);
    const n = table(byName(t, 'Supersede older versions'));
    expect(n).toMatchObject({ resource: 'row', operation: 'update', dataTableId: { value: STEPS_TABLE }, matchType: 'allConditions' });
    // A desktop import is always version 1: a second approval must retire the first (same version, another row), while a
    // higher version approved meanwhile stays active. $json is the row Save signed steps wrote (n8n returns updated rows with their id).
    expect(n.filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: `={{ ${SETTINGS_NAME} }}` },
      { keyName: 'status', condition: 'eq', keyValue: 'active' },
      { keyName: 'version', condition: 'lte', keyValue: "={{ $('Repaired steps received').item.json.version }}" },
      { keyName: 'id', condition: 'neq', keyValue: '={{ $json.id }}' },
    ]);
    expect(n.columns?.value).toEqual({ status: 'superseded' });
  });
  it('Email signed steps confirms what was signed, naming the steps signed as writes for desktop steps (I2)', () => {
    const p = byName(t, 'Email signed steps').parameters as { operation: string; toEmail: string; subject: string; text: string; emailFormat: string };
    expect(p).toMatchObject({ operation: 'send', toEmail: APPROVER, emailFormat: 'text' });
    const signed = { name: 'erp-1', version: 1, hash: 'h1', approvedBy: APPROVER, approvedAt: '2026-10-29T12:00:00.000Z', writeLine: 'Signed as writes: step 16 (Click Save)' };
    const scope = (json: IDataObject) => ({ $: (name: string) => { expect(name).toBe('Sign steps'); return { item: { json } }; } });
    expect(render(p.subject, scope(signed))).toBe('Signed: steps v1 for erp-1 are active');
    expect(render(p.text, scope(signed))).toBe(`Steps v1 for erp-1 are signed and active (hash h1), approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\nSigned as writes: step 16 (Click Save)`);
    const { writeLine: _w, ...browser } = signed;
    expect(render(p.text, scope(browser))).toMatch(/are signed and active \(hash h1\), approved by .*\.\n$/);
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
      operation: 'signSteps', approved: "={{ $('Timed out?').item.json.data.approved }}", approverId: APPROVER, approverAllowlist: APPROVER,
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
      const params = { ...sign, approved, writeSteps: '' };
      const ctx = harness({ params, rawParameters: sign, items: [{ json: restored }], credentials: { playwrightScriptSigningApi: { secretKey: 'k'.repeat(32) } } });
      return (await executeSignSteps(ctx, engine, () => new Date('2026-10-07T09:30:00.000Z')))[0][0].json;
    };
    expect(await run(false)).toMatchObject({ status: 'rejected', name: 'example-feed', version: 2, hash: received.hash, approvedBy: APPROVER });
    expect(await run(true)).toMatchObject({ status: 'active', name: 'example-feed', version: 2, hash: received.hash, approvedBy: APPROVER });
  });
  it('desktop steps get a form (Decision, Write steps); Desktop answer gives Sign steps approved and writeSteps, or no data on a timeout', () => {
    const branch = byName(t, 'Desktop steps?').parameters as { conditions: { conditions: { leftValue: string }[] } };
    const isDesktop = (steps: unknown) => evaluate(branch.conditions.conditions[0].leftValue, { $: () => ({ item: { json: { steps } } }) });
    expect(isDesktop({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [] })).toBe(true);
    expect(isDesktop({ name: 'feed', startUrl: 'https://example.com/', steps: [] })).toBe(false);
    expect(isDesktop(undefined)).toBe(false);
    const ask = byName(t, 'Ask for approval (desktop steps)').parameters;
    expect(ask).toMatchObject({
      operation: 'sendAndWait', responseType: 'customForm', toEmail: APPROVER,
      formFields: { values: [{ fieldLabel: 'Decision', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Approve' }, { option: 'Reject' }] }, requiredField: true }, { fieldLabel: 'Write steps' }] },
      options: { limitWaitTime: byName(t, 'Ask for approval').parameters.options && (byName(t, 'Ask for approval').parameters.options as { limitWaitTime: unknown }).limitWaitTime },
    });
    expect(String(ask.message)).toContain('The import never marks a step as a write: in Write steps, list the numbers of the steps that save, post or submit');
    // I2: the numbered change list is in the message and the candidates' numbers on the form; I3: what listing does, plainly.
    const received = {
      version: 1, name: 'erp-1', hash: 'h', digest: 'd', evidenceLine: 'Not replayed', safetyLine: 'desktop app: "ErpDemo.exe"',
      changeList: 'Step 1: Wait for the window\nStep 2: Click Save <b>', safetyFlags: ['desktop app: "ErpDemo.exe"', 'candidate write: step 2 (Click Save) may save, post or submit: list 2 in Write Steps if it does (…)'],
    };
    const $ = (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : received } });
    const message = render(String(ask.message), { $ });
    expect(message).toContain('The steps, numbered as Write steps counts them:\nStep 1: Wait for the window\nStep 2: Click Save &lt;b&gt;\n');
    expect(message).toContain('leaving a step unlisted does not stop it from saving unless its control is in the runner policy');
    expect(message).not.toContain('Only listed steps may use');
    const description = render(String((ask.options as IDataObject).responseFormDescription), { $ });
    expect(description).toContain('from the numbered list in the email (candidates: step 2)');
    expect(description).toContain('an unlisted step can still save through any other control');
    expect(render(String((ask.options as IDataObject).responseFormDescription), { $: () => ({ item: { json: { ...received, safetyFlags: [] } } }) })).toContain('(candidates: none)');
    const answer = String(byName(t, 'Desktop answer').parameters.jsonOutput);
    expect(evaluate(answer, { $json: { data: { Decision: 'Approve', 'Write steps': '16', respondedAt: 'x' } } })).toEqual({ data: { approved: true, writeSteps: '16' } });
    expect(evaluate(answer, { $json: { data: { Decision: 'Reject', respondedAt: 'x' } } })).toEqual({ data: { approved: false, writeSteps: '' } });
    expect(evaluate(answer, { $json: { name: 'feed', hash: 'h' } })).toEqual({});
    const timedOut = (byName(t, 'Timed out?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect(evaluate(timedOut, { $json: {} })).toBe(true);
    const sign = byName(t, 'Sign steps').parameters;
    const fromTimedOut = (json: unknown) => ({ $: (name: string) => { expect(name).toBe('Timed out?'); return { item: { json } }; } });
    expect(evaluate(String(sign.writeSteps), fromTimedOut({ data: { approved: true, writeSteps: '16' } }))).toBe('16');
    expect(evaluate(String(sign.writeSteps), fromTimedOut({ data: { approved: true, respondedAt: 'x' } }))).toBe('');
    expect(evaluate(String(sign.approved), fromTimedOut({ data: { approved: true, writeSteps: '' } }))).toBe(true);
  });
  it('uses one approver address in every approver field', () => {
    const emails = new Set<string>();
    let fields = 0;
    for (const n of t.nodes.filter((x) => x.type !== STICKY)) {
      const { fromEmail: _sender, ...rest } = n.parameters; // the sender is not an approver
      const found = JSON.stringify(rest).match(/[^\s,'"<>\\]+@[^\s,'"<>\\]+/g) ?? [];
      fields += found.length;
      for (const e of found) emails.add(e);
    }
    expect(fields).toBeGreaterThanOrEqual(5); // both emails, Approved By, the allowlist, approvedBy on the rejection
    expect([...emails]).toEqual([APPROVER]);
  });
  it('the stickies explain the pending lifecycle, configuration refusals and one approval per version', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    const notes = JSON.stringify(t.nodes.filter((n) => n.type === STICKY));
    for (const s of ['pending', 'expired', 'rejected', 'missing credential', 'one Repaired steps item per version']) expect(notes).toContain(s);
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
    expect(out).toContain('Evidence: 7 rows &lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('Safety flags: host: a.example&#39; &lt;script&gt;');
    expect(out).toContain('Hash: ab&quot;c');
    expect(out).toContain('Review digest: d&#39;e');
    expect(out).toContain('expires after 72 hours');
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
    expect(sentence('before,after')).toContain('Screenshots before and after the change are attached. A second email');
    const first = sentence('after');
    expect(first).toContain('A screenshot after the change is attached (a first run has no before). A second email');
    expect(first).not.toContain('Screenshots before and after');
    expect(sentence('before')).toContain('A screenshot before the change is attached.');
    for (const none of ['', undefined]) expect(sentence(none)).toContain('No screenshots are attached. A second email');
  });

  it('shows the safety flags before any page- or model-derived text', () => {
    expect(out.indexOf('Safety flags')).toBeLessThan(out.indexOf('Evidence'));
    expect(out.indexOf('Safety flags')).toBeLessThan(out.indexOf('What changed'));
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
  const SOURCES = { 'Chrome Recorder': 'chrome', 'Playwright code': 'playwright', 'UiPath project': 'uipath' };
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
  const importEngine = (adopt: () => AdoptResult): Engine => Object.assign(fakeEngine(() => {
    throw new Error('Import Steps never calls runTask');
  }), { importSource: realImportSource, adoptDraft: async () => adopt() });
  const failure = (code: Extract<AdoptResult, { ok: false }>['code'], message: string, over: Partial<Extract<AdoptResult, { ok: false }>> = {}): AdoptResult => ({
    ok: false, code, message, violations: [], log: [], blockedRequests: [], durationMs: 900, lane: 'script', ...over,
  });
  const NOT_ADOPTABLE = failure('policy_violation', IMPORT_NOT_ADOPTABLE, { adoptable: false, configError: true });
  const runImport = async (item: INodeExecutionData, adopt: () => AdoptResult) => {
    const params = resolved(item);
    const ctx = nodeContext({
      params, rawParameters: imp.parameters, items: [item], continueOnFail: true,
      credentials: { playwrightBrowserApi: { mode: 'local', headless: true }, playwrightSiteLoginApi: siteLoginData(SITE) },
    });
    return executeImportSteps(ctx, importEngine(adopt), { executionsMode: 'regular' });
  };
  /** The engine's UiPath fixture project, zipped as a user uploads it. */
  function uipathZip(): Buffer {
    const dir = fileURLToPath(new URL('../../engine/test/fixtures/import/uipath-sap-report/', import.meta.url));
    const entries: { name: string; raw: Buffer; usize: number }[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name);
        if (statSync(path).isDirectory()) walk(path);
        else {
          const data = readFileSync(path);
          entries.push({ name: `SAP Line Item Report/${relative(dir, path).split('\\').join('/')}`, raw: deflateRawSync(data), usize: data.length });
        }
      }
    };
    walk(dir);
    return zip(entries);
  }
  const completion = (name: string) => byName(t, name).parameters as { operation: string; respondWith: string; completionTitle: string; completionMessage: string; inputDataFieldName?: string };

  it('the import template wires the form, Import steps and approval', () => {
    expect(form).toMatchObject({ type: 'n8n-nodes-base.formTrigger', typeVersion: 2.5 });
    expect(imp).toMatchObject({ type: NODE_TYPE, typeVersion: 1, onError: 'continueErrorOutput' });
    expect(targets(t, 'Import a bot')).toEqual([['Import steps']]);
    expect(targets(t, 'Chat model', 'ai_languageModel')).toEqual([['Import steps']]);
    // Data → Workflow file? → a completion page; Repaired Steps → Approve steps; error (index 2) → its own completion page.
    expect(nodeOutputs('importSteps', imp.parameters.aiRepair)).toHaveLength(2);
    expect(targets(t, 'Import steps')).toEqual([['Workflow file?'], ['Approve steps'], ['Import failed']]);
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
    // v1 order runs the topmost child first: Approve steps before the completion pages, which pause the run until the browser resumes it.
    expect(byName(t, 'Approve steps').position[1]).toBeLessThan(Math.min(...['Workflow file?', 'Import failed'].map((n) => byName(t, n).position[1])));
    const working = t.nodes.filter((n) => n.type !== STICKY).map((n) => n.name).sort();
    expect(working).toEqual(['Approve steps', 'Chat model', 'Import a bot', 'Import failed', 'Import steps', 'Imported', 'Imported, with the workflow file', 'Workflow file?']);
    expect(t.nodes.filter((n) => n.type === COMPLETION).map((n) => n.typeVersion)).toEqual([2.5, 2.5, 2.5]);
    // A Form Ending page pauses the run until the browser loads it; a closed tab must not leave the execution waiting for ever.
    for (const n of t.nodes.filter((x) => x.type === COMPLETION)) {
      expect(n.parameters, n.name).toMatchObject({ limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours' });
    }
    // Credentials slots stay empty: nothing in the file names a credential.
    for (const n of t.nodes) expect(n, n.name).not.toHaveProperty('credentials');
  });

  it('the form asks for the bot file, its source, a name, and optionally the file it downloads', () => {
    expect(fields.map((f) => [f.fieldName, f.fieldType, f.requiredField === true])).toEqual([
      ['bot', 'file', true], ['source', 'dropdown', true], ['name', 'text', true], ['expectedFileName', 'text', false], ['columns', 'text', false],
    ]);
    // One file per import: the form refuses a second, so the upload is always binary `bot` (n8n adds `_0`, `_1` only for 2+ files).
    expect(fields[0].multipleFiles).toBe(false);
    expect(fields[1].fieldOptions?.values.map((o) => o.option)).toEqual(Object.keys(SOURCES));
    // Sign-in on by default: an anonymous form could start logins with the attached Site Login
    // (login breaker trips) and model spend. The Basic Auth credential slot stays empty: the user picks one first.
    expect(form.parameters.authentication).toBe('basicAuth');
    expect(form).not.toHaveProperty('credentials');
  });

  it('Import steps reads the form: Source mapped to its value, the binary bot, Name, AI Repair on, Expected File from the optional fields', () => {
    expect(imp.parameters).toMatchObject({ operation: 'importSteps', inputFrom: 'binary', binaryPropertyName: 'bot', stepsName: '={{ $json.name }}', aiRepair: true });
    for (const [label, value] of Object.entries(SOURCES)) expect(resolved(formItem(label, CHROME)).source).toBe(value);
    expect(resolved(formItem('Something else', CHROME)).source).toBe('');
    expect(resolved(formItem('Chrome Recorder', CHROME, { expectedFileName: '^LINEITEMS_', columns: 'Document, Amount' })).expectedFile)
      .toEqual({ file: { namePattern: '^LINEITEMS_', requiredColumns: 'Document, Amount' } });
    // n8n's Form Trigger sends null for a field that was not filled in.
    expect(resolved(formItem('Chrome Recorder', CHROME, { expectedFileName: null as unknown as string })).expectedFile).toEqual({ file: { namePattern: '', requiredColumns: '' } });
    const loaded = loadInN8n(imp);
    expect(loaded.parameters).toMatchObject(imp.parameters);
    expect(loaded.inputs).toEqual(['main', 'ai_languageModel']);
    expect(loaded.outputs).toEqual(['Data', 'Repaired Steps', 'Error']);
  });

  it('a form submission reaches the import: the file is read from the form binary and the report comes back on Data', async () => {
    const [data, repaired] = await runImport(formItem('Chrome Recorder', CHROME), () => NOT_ADOPTABLE);
    expect(repaired).toEqual([]);
    expect(data[0].json.error).toBeUndefined();
    expect(data[0].json.report).toMatchObject({ source: 'chrome', steps: 9 });
    expect(data[0].json.drafts).toEqual([expect.objectContaining({ name: 'line-item-export', adopted: false })]);
  });

  it('the Form completion page reports what was imported; a UiPath import also returns the workflow file (n8n 2.41 Form Ending: Return Binary File)', async () => {
    const shown = completion('Imported');
    expect(shown).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Imported' });
    const [data] = await runImport(formItem('Chrome Recorder', CHROME), () => NOT_ADOPTABLE);
    const message = render(shown.completionMessage, { $json: data[0].json });
    // The fixture's report: 9 steps, one recorder step not translated, three typed values (username, password, code) removed.
    const items = (data[0].json.report as { items: { kind: string }[] }).items;
    expect(items.filter((i) => i.kind === 'untranslated')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'secret')).toHaveLength(3);
    expect(message).toContain('Imported: 9 steps; 1 not translated, 3 removed as secrets.');
    expect(message).toContain('0 of 1 step lists passed the replay and are waiting for approval in RPA: 3 Approve steps.');
    const ifParams = byName(t, 'Workflow file?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } };
    expect(ifParams.conditions.conditions).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $json: data[0].json })).toBe(false);

    const withFile = completion('Imported, with the workflow file');
    expect(withFile).toMatchObject({ operation: 'completion', respondWith: 'returnBinary', inputDataFieldName: 'workflow', completionTitle: 'Imported' });
    const uipath = uipathZip();
    const [ui] = await runImport(formItem('UiPath project', uipath), () => NOT_ADOPTABLE);
    expect(ui[0].binary?.workflow).toMatchObject({ mimeType: 'application/json', fileName: 'line-item-export.workflow.json' });
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $json: ui[0].json })).toBe(true);
    const uiMessage = render(withFile.completionMessage, { $json: ui[0].json, $binary: ui[0].binary });
    expect(uiMessage).toMatch(/^Imported: \d+ steps; \d+ not translated, \d+ removed as secrets\./);
    expect(uiMessage).toContain('line-item-export.workflow.json');
    expect(uiMessage).toContain('Import from file');
  });

  it('a failed import shows its reason on a completion page', async () => {
    const page = completion('Import failed');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Nothing to approve' });
    const [data] = await runImport(formItem('Chrome Recorder', CHROME), () => failure('drift_detected', 'No element found for Visible Text "Line Item Report"'));
    // No model is connected here, so the reason also carries the NO_MODEL hint.
    expect(data[0].json.error).toBe('drift_detected: No element found for Visible Text "Line Item Report" (AI repair is on but no chat model is connected. Connect one to the Model input.)');
    const shown = render(page.completionMessage, { $json: data[0].json });
    expect(shown).toMatch(/^drift_detected: No element found for Visible Text "Line Item Report" \(AI repair is on/);
    expect(shown).toContain('\nDetails, including the import report when there is one, are in the error output of Import steps in this execution.');
  });

  it('has the stickies: About (grey), Set once (green, credential map, form security), Why approval (grey)', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    expect(sticky(t, 'Why approval').color).toBe(COLOUR.grey);
    const about = sticky(t, 'About this workflow').content;
    for (const s of ['Chrome Recorder', 'Playwright code', 'UiPath', 'RPA: 3 Approve steps', 'RPA: 2 Data feed', 'each step list gets its own approval']) expect(about, s).toContain(s);
    const set = sticky(t, 'Set once').content;
    for (const s of ['**Import a bot**: a Basic Auth credential', '**RPA Browser**: Import steps', '**RPA Site Login**', '**Chat model**', 'RPA: 3 Approve steps',
      '**Options → Allow Private Network**', 'Keep **Authentication** on', 'login breaker', 'chat model']) {
      expect(set, s).toContain(s);
    }
    const why = sticky(t, 'Why approval').content;
    for (const s of ['never', 'Sign Steps', 'password']) expect(why, s).toContain(s);
  });
});
