import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { changeList, NOT_REPLAYED_EVIDENCE_LINE, reviewChanges, reviewSteps } from '../nodes/Playwright/format.js';
import { describeStep, shownUrl, signScript, stepChanges, USE_CASE_WORDS } from 'n8n-rpa-engine';
import { APPROVER } from './fixtures.js';
import {
  NodeHelpers, Workflow, type IDataObject, type INodeExecutionData, type INodeParameters, type INodeProperties, type INodeTypes,
} from 'n8n-workflow';
import {
  adoptDraft as realAdoptDraft, buildProposal, checkDesktopTrust, createMasker, IMPORT_NOT_ADOPTABLE, IMPORT_ROWS_NEED_ID, importSource as realImportSource, notReplayedProposal, parseScript, proposalDigest, scriptHash, validateScript,
  type AdoptInput, type AdoptResult,
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
import { RUN_TABLE, RUN_TABLE_COLUMNS, RUN_TABLE_FIRST_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { agentOk, fakeEngine, scriptOk, taskFail } from './fake-engine.js';
import { tablesNotMadeFirst, used } from './tables-made-first.js';
import { nodeContext, siteLoginData } from './feed-fixtures.js';
import { harness } from './harness.js';

/** A review entry as the page shows it: the sentence, then the author's description under the page's own label. */
const line = (r: { text: string; describedAs?: string }) => (r.describedAs === undefined ? r.text : `${r.text} (described differently as: ${r.describedAs})`);

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

/**
 * What template 3's approval emails make of an address in text from the steps, so that mail programs do not make a
 * link of it: a zero-width space (U+200B) inside "://" and after each ".".
 */
const unlinked = (address: string) => address.split('://').join(':\u200b//').split('.').join('.\u200b');
/** Evaluates one n8n expression ("={{ … }}", or "{{ … }}" as a node evaluates one) as JavaScript with the given globals. */
function evaluate(expression: string, scope: Record<string, unknown>): unknown {
  const code = expression.replace(/^=?\{\{/, '').replace(/\}\}$/, '');
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

describe('every Data Table is made before anything reads or writes it, on every path (a new n8n has none)', () => {
  it.each(Object.keys(FILES))('%s', (file) => {
    expect(tablesNotMadeFirst(load(file))).toEqual([]);
  });
  it('the reads of template 5 are covered: the check finds the round 12 wiring, where the tables were made late', () => {
    const t = load('5-import-a-bot.json');
    expect(t.nodes.filter((n) => used(n) !== undefined).map((n) => n.name).sort()).toEqual([
      'Approved bots', 'Record rejection', 'Running versions', 'Save signed steps', 'Supersede older versions',
    ]);
    // As at 1ac5167: Settings → Change an approved bot? only, and the tables made after Approve on this form?.
    const late = structuredClone(t);
    late.connections['Settings'] = { main: [[{ node: 'Change an approved bot?', type: 'main', index: 0 }]] };
    late.connections['Approve on this form?'].main[0] = [{ node: 'Create steps table', type: 'main', index: 0 }];
    late.connections['Create run log table'] = { main: [[{ node: 'Compared with the running version', type: 'main', index: 0 }]] };
    expect(tablesNotMadeFirst(late)).toEqual(['Running versions uses playwright_steps', 'Approved bots uses playwright_steps']);
    // The order matters too: the tables' branch below the rest would run after it, so nothing is made first.
    const below = structuredClone(t);
    byName(below, 'Create steps table').position = [660, 600];
    expect(tablesNotMadeFirst(below)).toEqual(['Running versions uses playwright_steps', 'Approved bots uses playwright_steps', 'Save signed steps uses playwright_steps', 'Supersede older versions uses playwright_steps', 'Record rejection uses playwright_steps']);
  });
  it('no read of a Data Table goes on with an error item: none has onError set', () => {
    for (const file of Object.keys(FILES)) for (const n of load(file).nodes.filter((x) => used(x) !== undefined && table(x).operation === 'get')) expect(n.onError, `${file}: ${n.name}`).toBeUndefined();
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
      runsOn: 'browser',
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
      // Only the first ten columns: a table made by an earlier version has them, so the data feed never fails on one.
      expect(Object.keys(table(byName(t, name)).columns?.value ?? {})).toEqual(RUN_TABLE_FIRST_COLUMNS.map((c) => c.name));
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
    for (const field of ['evidenceLine', 'changeList', 'safetyLine', 'hash']) expect(String(email.html)).toMatch(new RegExp(`(\\$json|\\bj)\\.${field}\\b`));
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
    expect(String(ask.message)).toContain("Review digest: {{ ((s, lines) => String(s ?? '')");
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
      + 'Not tried by the import: read every step before you approve.\n\nThe steps:\n1. Wait for the window\n2. Click Save \u2039b\u203a\n3. Type into User name (variable username)\n4. Type "2026-11-30" into Date to\n5. Read the count (gives its text to n8n as out_count)\n6. Return the file (returns a file)');
    // A secret variable is marked as one, as on the review page (the item names them; never a value).
    const secret = render(String(ask.message), { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : { ...received, secretVariables: ['username'] } } }) });
    expect(secret).toContain('\n3. Type into User name (secret variable username)\n');
    // An item from Import Steps carries the steps as the node words them (reviewSteps): the email shows those, so a
    // description can neither replace the action nor hide the value. The inline wording above stays for an older item.
    const post = { uia: { path: [{ controlType: 'Button', name: 'Post' }] } };
    const bare = { uia: { path: [{ controlType: 'Edit' }] } };
    const misleading = [
      { intent: 'Read the total', click: post },
      { intent: 'Read the total', fill: { field: bare, value: '<b>9999</b>' } },
      { intent: 'Type into User name', fill: { field: { uia: { path: [{ name: 'User name' }] } }, value: '{{var.username}}' } },
    ];
    const fromNode = { ...received, secretVariables: ['username'], steps: { ...received.steps, steps: misleading }, reviewSteps: reviewSteps(misleading, { desktop: true, secretVariables: ['username'] }) };
    const shownSteps = (json: object) => render(String(ask.message), { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : json } }) })
      .split('The steps:\n')[1].split('\n\nClick Review and decide')[0];
    // A description that says something else is marked ⚠ (the message is plain text).
    expect(shownSteps(fromNode)).toBe('1. Click Post ⚠ (described differently as: Read the total)\n'
      + '2. Type "\u2039b\u203a9999\u2039/b\u203a" into a field without a name ⚠ (described differently as: Read the total)\n'
      + '3. Type into User name (secret variable username)');
    // Without reviewSteps, or with a list that does not match the steps, the email words the steps itself, as before.
    const { reviewSteps: _r, ...older } = fromNode;
    expect(shownSteps(older)).toBe('1. Read the total\n2. Type "\u2039b\u203a9999\u2039/b\u203a" into Read the total\n3. Type into User name (secret variable username)');
    expect(shownSteps({ ...fromNode, reviewSteps: fromNode.reviewSteps.slice(1) })).toBe(shownSteps(older));
    // A start value is not on the item, so Sign Steps cannot check it: the email leaves it out of the marks.
    const started = fromNode.reviewSteps.map((r, i) => (i === 2 ? { ...r, marks: ['variable username, starts as jdoe'] } : r));
    expect(shownSteps({ ...fromNode, reviewSteps: started })).toContain('\n3. Type into User name (variable username)');
    expect(shownSteps({ ...fromNode, reviewSteps: started })).not.toContain('jdoe');
    expect(message).toContain('tick the steps that save, send or submit (none is ticked for you), then approve or reject.');
    expect(message).toContain('Ticked steps are allowed to save or send. An unticked step is stopped only when it tries to use a control or key that your administrator has protected on the bot machine.');
    // The full detail below: the item's own change list, evidence and flags.
    expect(message).toContain('Details of every step (how each one finds its control):\nEvidence: Not replayed\nSafety flags: desktop app: "ErpDemo.exe"\nStep 1: Wait for the window\nStep 2: Click Save \u2039b\u203a\n');
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

  /**
   * What n8n 2.45 makes of a send-and-wait message (nodes-base utils/sendAndWait/utils.ts getSendAndWaitConfig, lines
   * 520-522): its escapeHtml (utils/utilities.ts 387) turns &amp; &lt; &gt; &#39; &quot; BACK into characters, then \n
   * (a backslash and n) and <br> become line breaks, and email-templates.ts puts the result into
   * <p style="white-space: pre-line;">${message}</p> as it is. A later n8n might escape the message instead.
   */
  const n8nNow = (m: string) => m.trim().replace(/&amp;|&lt;|&gt;|&#39;|&quot;/g, (x) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"' })[x] ?? x)
    .replace(/\\n/g, '\n').replace(/<br>/g, '\n');
  const n8nEscaping = (m: string) => m.trim().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  /** HTML text as a reader sees it: entities shown as their characters. */
  const seen = (html: string) => html.replace(/&amp;|&lt;|&gt;|&#39;|&quot;/g, (x) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"' })[x] ?? x);

  it('every piece of data in both approval messages arrives as text, whatever n8n does to the message', () => {
    const MARKUP = ['<a href="https://evil.example/">Approve here</a>', '<img src=x onerror=alert(1)>', '&lt;script&gt;alert(1)&lt;/script&gt;', 'Tom &amp; Jerry &#60;b&#62;', 'one\\ntwo<br>three'];
    const evil = (k: number) => `${MARKUP[k % MARKUP.length]} ${k}`;
    const stepsData = { surface: 'desktop', app: { exe: evil(0) }, steps: [{ intent: evil(1), click: { uia: { path: [{ name: evil(2) }] } } }, { intent: 'x', fill: { field: { uia: { path: [{ name: 'Note' }] } }, value: evil(3) } }] };
    const data = {
      version: evil(4), name: evil(0), hash: evil(1), digest: evil(2), evidenceLine: evil(3), safetyLine: evil(4),
      leftOutList: `${evil(0)}\n${evil(1)}`, changeList: `${evil(2)}\n${evil(3)}\n${evil(4)}`,
      steps: stepsData, reviewSteps: [{ text: evil(0), describedAs: evil(1), marks: [evil(2)] }, { text: evil(3), marks: [evil(4)] }],
    };
    const t3 = load('3-approve-steps.json');
    for (const name of ['Ask for approval', 'Ask for approval (desktop steps)']) {
      const ask = (json: object) => render(String(byName(t3, name).parameters.message), { $: (n: string) => ({ item: { json: n === 'Settings' ? { approvalTimeoutHours: 72 } : json } }) });
      for (const json of [data, { ...data, reviewSteps: undefined }, { ...data, steps: { ...stepsData, steps: [] }, reviewSteps: [] }]) {
        const message = ask(json);
        // Today: n8n un-escapes, then puts the text into HTML. Nothing in it is a tag, an entity or a <br>.
        const now = n8nNow(message);
        expect(now, name).not.toMatch(/[<&]/);
        // A later n8n that escapes the message shows the same text: there is nothing to show as &lt; or &amp;.
        expect(seen(n8nEscaping(message)), name).toBe(message.trim());
        // The data is there, as text, with look-alikes for the three characters that make markup.
        expect(message, name).toContain(`‹a href="${unlinked('https://evil.example/')}"›Approve here‹/a›`);
        // No address in the data is one a mail program makes a link of.
        expect(message, name).not.toMatch(/:\/\/|evil\.example/);
        expect(message, name).toContain('‹img src=x onerror=alert(1)›');
        expect(message, name).toContain('＆lt;script＆gt;');
        // A backslash and n in the data never makes a line of its own; the template's own line breaks stay.
        expect(now.split('\n').filter((l) => /^three \d$|^two/.test(l)), name).toEqual([]);
        expect(now, name).toContain('\nHash: ');
      }
    }
  });

  it('the values the email shows are all there, each as text', () => {
    expect(out).toContain('Steps v4‹i› for feed‹b›x‹/b›');
    expect(out).toContain('Evidence (as reported by the run): 7 rows ‹img src=x onerror=alert(1)›');
    expect(out).toContain(`Safety flags: host: ${unlinked('a.example')}' ‹script›`);
    expect(out).toContain('Hash: ab"c');
    expect(out).toContain("Review digest: d'e");
    expect(out).toContain('expires after 72 hours');
  });

  it('says what Approve and Reject cause, and prints the change list, so the email stands on its own', () => {
    const withChanges = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : { ...item, changeList: 'step 2 now clicks "Next"\n<div>' } } }) });
    expect(withChanges).toContain('What changed (as reported by the run):\nstep 2 now clicks "Next"\n\u2039div\u203a');
    expect(out).toContain('Approve: these exact steps are signed and n8n runs them with the stored login, without asking again, until the site changes.');
    expect(out).toContain('Reject: nothing is signed; the version in use, if any, stays in use.');
    expect(out).not.toContain('previous email');
    expect(out.indexOf('Approve: these exact steps')).toBeLessThan(out.indexOf('Hash:'));
    expect(out.indexOf('Hash:')).toBeLessThan(out.indexOf('Review digest:'));
  });

  it('never says that browser steps that were not replayed ran: the labels follow the evidence line', () => {
    const notReplayed = { ...item, evidenceLine: NOT_REPLAYED_LINE, changeList: 'Added: Send the form (submit POST /send)' };
    const shown = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : notReplayed } }) });
    expect(shown).toContain(`Evidence: ${NOT_REPLAYED_LINE}`);
    expect(shown).toContain('What changed (as written; these steps were never run):\nAdded: Send the form');
    expect(shown).not.toContain('as reported by the run');
    expect(shown).not.toContain('Proven');
  });

  it('shows the left-out steps under their own heading before the evidence, escaped; with none, no heading', () => {
    const withLeftOut = { ...item, leftOutList: 'step 4, Pick <b>Status</b>: only one option is imported\nstep 9, Wait: a fixed wait is not imported' };
    const shown = render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : withLeftOut } }) });
    expect(shown).toContain(`${LEFT_OUT_HEADING}\nstep 4, Pick \u2039b\u203aStatus\u2039/b\u203a: only one option is imported\nstep 9, Wait: a fixed wait is not imported\n`);
    expect(shown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(shown.indexOf('Evidence'));
    expect(out).not.toContain('Left out');
    const desktop = String(byName(load('3-approve-steps.json'), 'Ask for approval (desktop steps)').parameters.message);
    const desktopShown = render(desktop, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : withLeftOut } }) });
    expect(desktopShown).toContain(`${LEFT_OUT_HEADING}\nstep 4, Pick \u2039b\u203aStatus\u2039/b\u203a: only one option is imported\nstep 9, Wait`);
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

  it('shows every value from the run as text, with look-alikes for <, > and & as the approval email does, so page or model text cannot restyle or hide parts of the email', () => {
    expect(out).not.toMatch(/<img|<script|<div|<b>feed/);
    expect(out).toContain('feed\u2039b\u203a');
    expect(out).toContain('\u2039img src=x onerror=alert(1)\u203a');
    expect(out).toContain('clicks "Next"<br>\u2039div style="display:none"\u203a');
    expect(out).toContain(`host: ${unlinked('a.example')}' \u2039script\u203a`);
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
    expect(shown).toContain(`<b>Evidence:</b> ${NOT_REPLAYED_LINE}`);
    expect(shown).toContain('<b>What changed (as written; these steps were never run):</b><br>step 2 now clicks');
    expect(shown).not.toContain('as reported by the run');
  });

  it('shows the left-out steps in red under their own heading, after the safety flags and before the evidence; with none, nothing', () => {
    const shown = render(html, { $json: { ...hostile, leftOutList: 'step 4, Pick <b>Status</b>: only one option\nstep 9, Wait' } });
    expect(shown).toContain(`<p style="color:#b00020"><b>${LEFT_OUT_HEADING}</b><br>step 4, Pick \u2039b\u203aStatus\u2039/b\u203a: only one option<br>step 9, Wait</p>`);
    expect(shown.indexOf('Safety flags')).toBeLessThan(shown.indexOf(LEFT_OUT_HEADING));
    expect(shown.indexOf(LEFT_OUT_HEADING)).toBeLessThan(shown.indexOf('Evidence'));
    expect(out).not.toContain('Left out');
  });

  it('says the evidence and the change list are as reported by the run (Sign Steps recomputes only the safety flags)', () => {
    expect(out).toContain('<b>Evidence (as reported by the run):</b> 7 rows');
    expect(out).toContain('<b>What changed (as reported by the run):</b><br>step 2 now clicks');
  });
});

describe('template 3 emails lead with what browser steps do (reviewSteps), as the review page does', () => {
  const t3 = load('3-approve-steps.json');
  const html = String(byName(t3, 'Email repaired steps').parameters.html);
  const message = String(byName(t3, 'Ask for approval').parameters.message);
  const steps = [
    { intent: 'Type the first day of September 2026 into From', fill: { field: { label: 'From', exact: true }, value: '2026-09-01' } },
    { intent: 'Click Export <b>.', click: { role: 'button', name: 'Export <b>' } },
    { intent: 'Read every page', paginate: { next: { text: 'Next' }, until: 'absent', max: 3, each: [{ intent: 'Read the total', click: { role: 'button', name: 'Delete' } }] } },
  ];
  const reviewed = reviewSteps(steps, { desktop: false, shownUrl: (u: string) => u });
  const item = {
    name: 'line-items', version: 1, hash: 'h', digest: 'd', safetyLine: 'host: a.example', evidenceLine: 'Proven in a fresh browser: 8 rows',
    changeList: 'Added: Type the first day of September 2026 into From (fill label "From" exact with "2026-09-01")', steps: { startUrl: 'https://a.example/', steps }, reviewSteps: reviewed,
  };
  const ask = (json: object) => render(message, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : json } }) });

  it('the review email: the sentences built from the steps, a description that names another action in red, a harmless one in grey, then the change list in the details', () => {
    const out = render(html, { $json: item });
    expect(out).toContain('<ol><li>Type into From: "2026-09-01" <i style="color:#7e8186">(the author calls it: Type the first day of September 2026 into From)</i></li>'
      + '<li>Click Export \u2039b\u203a</li>'
      + '<li>Page through with Next, at most 3 pages, 1 step on each <i style="color:#7e8186">(the author calls it: Read every page)</i>'
      + '<ul><li>On each page: Click Delete <b style="color:#b00020">(described differently as: Read the total)</b></li></ul></li></ol>');
    // What the steps do comes before the evidence and the change list, which stay as they are.
    expect(out.indexOf('<b>The steps</b>')).toBeLessThan(out.indexOf('Evidence'));
    expect(out.indexOf('<b>The steps</b>')).toBeLessThan(out.indexOf('What changed'));
    expect(out).toContain('<b>What changed (as reported by the run):</b><br>Added: Type the first day of September 2026 into From (fill label "From" exact with "2026-09-01")');
    expect(out).not.toMatch(/<b>Export|<b>feed/);
  });

  it('the approval email: the same sentences, ⚠ before a description that names another action or site', () => {
    const out = ask(item);
    expect(out).toContain('\nThe steps (what each one does, built from the step):\n'
      + '1. Type into From: "2026-09-01" (the author calls it: Type the first day of September 2026 into From)\n'
      + '2. Click Export \u2039b\u203a\n'
      + '3. Page through with Next, at most 3 pages, 1 step on each (the author calls it: Read every page)\n'
      + '   On each page: Click Delete ⚠ (described differently as: Read the total)\nEvidence');
    expect(out.indexOf('The steps')).toBeLessThan(out.indexOf('What changed'));
  });

  it('an item without reviewSteps (from Run Steps or older), or with a list that does not fit the steps, shows the change list alone, as before', () => {
    const { reviewSteps: _r, ...older } = item;
    for (const json of [older, { ...item, reviewSteps: reviewed.slice(1) }, { ...item, reviewSteps: [] }]) {
      expect(render(html, { $json: json })).not.toContain('The steps');
      expect(ask(json)).not.toContain('The steps');
      expect(ask(json)).toContain('What changed (as reported by the run):');
    }
  });

  it('the emails write the label themselves and show each field escaped: a marker, brackets or angle brackets inside a name, a value or a description change nothing', () => {
    const MARK = ' (described differently as: ';
    const odd = [
      { intent: `Open the list${MARK}Click Pay now) <b>`, fill: { field: { label: 'Amount' }, value: '1' } },
      { intent: 'Click it', click: { role: 'button', name: `Save${MARK}Delete all) <i>` } },
    ];
    const json = { ...item, steps: { startUrl: 'https://a.example/', steps: odd }, reviewSteps: reviewSteps(odd, { desktop: false, shownUrl: (u: string) => u }) };
    const page = render(html, { $json: json });
    expect(page).toContain('<li>Type into Amount: "1" <b style="color:#b00020">(described differently as: Open the list (described differently as: Click Pay now) \u2039b\u203a)</b></li>'
      + '<li>Click "Save (described differently as: Delete all) \u2039i\u203a" <i style="color:#7e8186">(the author calls it: Click it)</i></li>');
    expect(ask(json)).toContain('1. Type into Amount: "1" ⚠ (described differently as: Open the list (described differently as: Click Pay now) \u2039b\u203a)\n'
      + '2. Click "Save (described differently as: Delete all) \u2039i\u203a" (the author calls it: Click it)\n');
    // Desktop steps: the one approval email, the same way.
    const desktop = String(byName(t3, 'Ask for approval (desktop steps)').parameters.message);
    const dsteps = [{ intent: `Read it${MARK}x) <b>`, click: { uia: { path: [{ controlType: 'Button', name: `Post${MARK}y) <i>` }] } } }];
    const djson = { name: 'erp', version: 1, steps: { surface: 'desktop', app: { exe: 'App.exe' }, steps: dsteps }, reviewSteps: reviewSteps(dsteps, { desktop: true }) };
    const dshown = render(desktop, { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : djson } }) });
    expect(dshown).toContain('\n1. Click "Post (described differently as: y) \u2039i\u203a" ⚠ (described differently as: Read it (described differently as: x) \u2039b\u203a)\n');
  });

  it('What changed: left out of both emails for an import (every entry Added, every step listed); for a repair, each entry from the step\'s sentence', () => {
    // An import: the change list is every step again, as Added, led by the author's description. Not shown.
    const imported = { ...item, changes: steps.map((s) => ({ was: null, now: String(s.intent) })) };
    expect(render(html, { $json: imported })).not.toContain('What changed');
    expect(ask(imported)).not.toContain('What changed');
    expect(ask(imported)).toContain(`\nSafety flags: host: ${unlinked('a.example')}\n\nApprove: `);
    // Without the step list (an item from Run Steps), or with one that does not fit, the change list stays as before.
    const { reviewSteps: _r, ...older } = imported;
    expect(render(html, { $json: older })).toContain('<b>What changed (as reported by the run):</b><br>Added: Type the first day');
    expect(ask(older)).toContain('\nWhat changed (as reported by the run):\nAdded: Type the first day');
    // A repair: each entry names its step by number, with the sentence built from the step and the description marked.
    const base = { startUrl: 'https://a.example/', steps: [steps[0], { intent: 'Click Export', click: { role: 'button', name: 'Export' } }] };
    const now = { startUrl: 'https://a.example/', steps: [steps[0], { intent: 'Read the total', click: { role: 'button', name: 'Delete' } }, { intent: 'Open the list', goto: 'https://a.example/list' }] };
    const changes = stepChanges(parseScript(base), parseScript(now));
    const repair = { ...item, baseVersion: 1, version: 2, steps: now, changes, changeList: changeList({ changes } as unknown as Proposal), reviewSteps: undefined,
      reviewChanges: reviewChanges({ describeStep }, now.steps, changes, { shownUrl: (u: string) => u, startUrl: now.startUrl }) };
    expect(repair.reviewChanges).toEqual([
      { change: 'Changed', step: 2, text: 'Click Delete', describedAs: 'Read the total', was: 'Click Export (click role "button" name "Export")' },
      { change: 'Added', step: 3, text: 'Open a.example/list', describedAs: 'Open the list', quiet: true },
    ]);
    expect(render(html, { $json: repair })).toContain('<b>What changed (as reported by the run):</b><br>'
      + 'Changed: step 2, Click Delete <b style="color:#b00020">(described differently as: Read the total)</b> <i style="color:#7e8186">(was: Click Export (click role "button" name "Export"))</i><br>'
      + `Added: step 3, Open ${unlinked('a.example/list')} <i style="color:#7e8186">(the author calls it: Open the list)</i></p>`);
    expect(ask(repair)).toContain('\nWhat changed (as reported by the run):\n'
      + 'Changed: step 2, Click Delete ⚠ (described differently as: Read the total) (was: Click Export (click role "button" name "Export"))\n'
      + `Added: step 3, Open ${unlinked('a.example/list')} (the author calls it: Open the list)\n\nApprove: `);
    // A removed step keeps the run's words: there is no step to build a sentence from.
    const removed = stepChanges(parseScript(now), parseScript(base));
    const back = reviewChanges({ describeStep }, base.steps, removed, { shownUrl: (u: string) => u });
    expect(back.find((c) => c.change === 'Removed')).toEqual({ change: 'Removed', was: 'Open the list (go to "https://a.example/list")' });
    expect(ask({ ...repair, changes: removed, reviewChanges: back })).toContain(`Removed: Open the list (go to "${unlinked('https://a.example/list')}")`);
  });

  it('both approval emails show text from the steps through one function: look-alikes for <, > and &, and no address a mail program makes a link of', () => {
    const desktopMessage = String(byName(t3, 'Ask for approval (desktop steps)').parameters.message);
    const fns = (text: string) => [...text.matchAll(/\(\(s, lines\) => String\(s \?\? ''\)[\s\S]*?split\('\.'\)\.join\('\.\\u200b'\)\)\)/g)].map((m) => m[0]);
    const all = [...fns(html), ...fns(message), ...fns(desktopMessage)];
    expect(all.length).toBeGreaterThan(20);
    expect(new Set(all).size).toBe(1);
    // No other escaping is left in them: the review email showed &lt; where the approval email showed ‹.
    for (const text of [html, message, desktopMessage]) {
      expect(text).not.toContain("'&lt;'");
      expect(text).not.toMatch(/\.replace\(\/\[&<>/);
    }
    // A description that holds a link, and addresses in a value and a goto.
    const LINK = '<a href="http://evil.example/x">http://evil.example/x</a>';
    const linked = [
      { intent: LINK, click: { role: 'button', name: 'Pay' } },
      { intent: 'Type the address', fill: { field: { label: 'Site' }, value: 'see www.evil.example/pay' } },
      { intent: 'Open the shop', goto: 'https://shop.example/cart' },
    ];
    const json = { ...item, name: 'feed.example', steps: { startUrl: 'https://shop.example/', steps: linked }, reviewSteps: reviewSteps(linked, { desktop: false, shownUrl: (u: string) => u, startUrl: 'https://shop.example/' }),
      changeList: `Added: ${LINK}`, evidenceLine: 'Proven at https://shop.example/cart', leftOutList: 'step 2, go to http://evil.example/y' };
    const review = render(html, { $json: json });
    const approval = ask(json);
    // What a plain-text view of the HTML shows (tags removed): the same text.
    const plain = review.replace(/<[^>]*>/g, ' ');
    for (const [name, text] of [['review email', plain], ['approval email', approval]] as const) {
      expect(text, name).not.toMatch(/:\/\/|evil\.example|shop\.example|www\.evil/);
      expect(text, name).toContain(`\u2039a href="${unlinked('http://evil.example/x')}"\u203a${unlinked('http://evil.example/x')}\u2039/a\u203a`);
      expect(text, name).toContain(unlinked('www.evil.example/pay'));
      expect(text, name).toContain(`Open ${unlinked('shop.example/cart')}`);
    }
    expect(review).not.toMatch(/<a |href="http:\/\//);
    // A file name stays as it is.
    expect(ask({ ...item, evidenceLine: 'downloaded "report.csv" and ErpDemo.exe' })).toContain('downloaded "report.csv" and ErpDemo.exe');
    // Only the emails: the review page and what is signed keep the address as it is.
    expect(json.reviewSteps[2].text).toBe('Open shop.example/cart');
    expect(String(byName(load('5-import-a-bot.json'), 'Review and approve').parameters.jsonOutput)).not.toContain('u200b');
  });

  it('Sign Steps checks the sentences the emails showed: the item goes to Sign steps whole, reviewSteps included', () => {
    expect(byName(t3, 'Repaired steps to sign').parameters.jsonOutput).toBe("={{ $('Repaired steps received').item.json }}");
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
  /** Import steps' parameters as n8n resolves them for one form item, with the nodes that ran before it (`ran`). */
  function resolved(item: INodeExecutionData, ran: Record<string, INodeExecutionData[][]> = {}): Record<string, unknown> {
    const walk = (v: unknown): unknown => typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $json: item.json, $: nodesRan(ran) })
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
  const runImport = async (item: INodeExecutionData, adopt: (input: AdoptInput) => AdoptResult, ran: Record<string, INodeExecutionData[][]> = {}) => {
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
  /**
   * The review page's fields after its opening lines: the first field is always html that names the RPA Site Login Sign
   * steps signs for (or that desktop steps are signed without one), after the comparison line on the change path, before
   * the warning when the approved version does not fit.
   */
  function reviewFields(scope: Record<string, unknown>) {
    const all = jsonFormFields(String(review.parameters.jsonOutput), scope);
    expect(all[0].fieldType).toBe('html');
    expect(String(all[0].html)).toMatch(/<p>(Signs for the Site Login named "|Signs for no RPA Site Login|Desktop steps are signed)/);
    return all.slice(1);
  }
  /** The review page's opening lines (its first field). */
  const reviewHead = (scope: Record<string, unknown>) => String(jsonFormFields(String(review.parameters.jsonOutput), scope)[0].html);
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
  /** The n8n user on a form page's output, as n8n 2.45 writes it for a signed-in submitter (after the page's fields). */
  const signedIn = (email: string) => ({ id: 'user-1', email, firstName: 'Ann', lastName: 'Approver' });
  /**
   * The review page answered with `answer` (n8n gives each field under its fieldName) by `user` (the signed-in n8n user:
   * the approver by default; null for none, as with Basic Auth), then Step lists, Step lists to sign (one item per list,
   * Split Out) and Sign steps with its parameters resolved per item, as n8n resolves them.
   */
  async function signAfterReview(ran: Record<string, INodeExecutionData[][]>, answer: IDataObject, over: IDataObject = {}, withSiteLogin = false, user: IDataObject | null = signedIn(APPROVER), formAuthentication?: string, key = 'k'.repeat(32)) {
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

  it('the import template wires the form, Settings, Import steps, the review page and Sign steps; approval by email is a switched-off hand-off', () => {
    expect(form).toMatchObject({ type: 'n8n-nodes-base.formTrigger', typeVersion: 2.6 });
    expect(imp).toMatchObject({ type: NODE_TYPE, typeVersion: 1, onError: 'continueErrorOutput' });
    // An address that carries values for the form's fields ends the run before anything is read.
    expect(targets(t, 'Import a bot')).toEqual([['Plain address?']]);
    expect(targets(t, 'Plain address?')).toEqual([['Settings'], ['Address with values']]);
    // First the two Data Tables, made when missing (v1 order runs the topmost child's branch to its end first), so that on
    // a new n8n nothing reads playwright_steps before it exists. Then, no file on the first page: the change path (an
    // approved bot by its name, its steps to read, an empty box). With a file: the import.
    expect(targets(t, 'Settings')).toEqual([['Create steps table', 'Change an approved bot?']]);
    expect(byName(t, 'Create steps table').position[1]).toBeLessThan(byName(t, 'Change an approved bot?').position[1]);
    expect(targets(t, 'Create steps table')).toEqual([['Create run log table']]);
    expect(targets(t, 'Create run log table')).toEqual([]);
    expect(targets(t, 'Change an approved bot?')).toEqual([['Approved bots'], ['Read the upload']]);
    // Read the upload gives Asks about a download? the file's text (one Extract From File node; an error item passes on).
    expect(targets(t, 'Read the upload')).toEqual([['Asks about a download?']]);
    expect(byName(t, 'Read the upload')).toMatchObject({ type: 'n8n-nodes-base.extractFromFile', typeVersion: 1.1, onError: 'continueRegularOutput', parameters: { operation: 'text', destinationKey: 'text' } });
    expect(targets(t, 'Approved bots')).toEqual([['The bot to change']]);
    expect(targets(t, 'The bot to change')).toEqual([['Approved bot found?']]);
    expect(targets(t, 'Approved bot found?')).toEqual([['Change or sign again'], ['No approved bot']]);
    expect(targets(t, 'Change or sign again')).toEqual([['Compared with the approved version']]);
    expect(targets(t, 'Compared with the approved version')).toEqual([['The steps as a file']]);
    expect(targets(t, 'The steps as a file')).toEqual([['The upload']]);
    // The download question only for a browser source, on a second page; Import steps always reads The upload.
    // An upload then reads what runs under its name (What it replaces), so that it becomes the next version.
    expect(targets(t, 'Asks about a download?')).toEqual([['The file it downloads'], ['Running versions']]);
    expect(targets(t, 'The file it downloads')).toEqual([['Running versions']]);
    expect(targets(t, 'Running versions')).toEqual([['What it replaces']]);
    expect(targets(t, 'What it replaces')).toEqual([['The upload']]);
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
    // Sign steps checks first (Check Only, before the review page): The approved version is what it checks, then Checked?
    // sends that item to the review page. After the review page, it signs, and Checked? sends the records to Signed?.
    // A file under the name of an approved bot: Compared with the running version gives the review page its first line.
    expect(targets(t, 'Approve on this form?')).toEqual([['Compared with the running version'], ['Workflow file?']]);
    expect(targets(t, 'Compared with the running version')).toEqual([['The approved version']]);
    expect(targets(t, 'The approved version')).toEqual([['Sign steps']]);
    expect(targets(t, 'Checked?')).toEqual([[REVIEW], ['Signed?']]);
    // v1 order runs the topmost child's branch to its end first: every step list is signed and saved before the last page.
    expect(targets(t, REVIEW)).toEqual([['Step lists', 'Workflow file?']]);
    expect(byName(t, 'Step lists').position[1]).toBeLessThan(byName(t, 'Workflow file?').position[1]);
    expect(targets(t, 'Step lists')).toEqual([['Step lists to sign']]);
    expect(targets(t, 'Step lists to sign')).toEqual([['Sign steps']]);
    expect(targets(t, 'Sign steps')).toEqual([['Checked?'], []]);
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
      'Add the login page', 'Address with values', 'Approval by email?', 'Approve on this form?', 'Approve steps', 'Approved bot found?', 'Approved bots', 'Asks about a download?', 'Change an approved bot?',
      'Change or sign again', 'Checked?', 'Compared with the approved version', 'Compared with the running version', 'Create run log table', 'Create steps table', 'Import a bot', 'Import failed', 'Import steps', 'Imported', 'Imported, with the workflow file', 'Missing login page?',
      'No approved bot', 'Plain address?', 'Read the upload', 'Record rejection', REVIEW, 'Running versions', 'Save signed steps', 'Settings', 'Sign steps', 'Signed?', 'Step lists', 'Step lists to sign', 'Supersede older versions',
      'The approved version', 'The bot to change', 'The file it downloads', 'The steps as a file', 'The upload', 'What it replaces', 'Workflow file?',
    ]);
    expect(t.nodes.filter((n) => n.type === COMPLETION).map((n) => n.typeVersion)).toEqual([2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5]);
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
    expect(into('Signed?')).toEqual([['Checked?', 1]]);
    expect(into('Checked?')).toEqual([['Sign steps', 0]]);
    expect(into(REVIEW)).toEqual([['Checked?', 0]]);
    const checkedCond = (byName(t, 'Checked?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(checkedCond).toEqual([expect.objectContaining({ leftValue: '={{ $json.checkOnly === true }}', operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    // A record never carries checkOnly, and the check never carries a status: neither can reach the other's path.
    expect([{ checkOnly: true, siteLogin: null, approvedVersion: null }, { status: 'active' }, { status: 'rejected' }, {}].map(($json) => evaluate(checkedCond[0].leftValue, { $json }))).toEqual([true, false, false, false]);
    // Check Only exactly while the review page has not run: the check before it, the signing after it.
    const checkOnly = (reviewed: boolean) => evaluate(String(byName(t, 'Sign steps').parameters.checkOnly), { $: (n: string) => ({ isExecuted: n === REVIEW ? reviewed : true }) });
    expect([checkOnly(false), checkOnly(true)]).toEqual([true, false]);
    expect(into('Record rejection')).toEqual([['Signed?', 1]]);
    expect(into('Supersede older versions')).toEqual([['Save signed steps', 0]]);
    const signed = byName(t, 'Signed?').parameters as { conditions: { conditions: { leftValue: string; rightValue: string; operator: unknown }[] } };
    expect(signed.conditions.conditions).toEqual([expect.objectContaining({ leftValue: '={{ $json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } })]);
    const sign = byName(t, 'Sign steps');
    expect(sign).toMatchObject({ type: NODE_TYPE, onError: 'continueErrorOutput', parameters: { operation: 'signSteps', approverAllowlist: APPROVER } });
    // The approver is the n8n user who submitted the review page; with Basic Auth on the form, Approved By as before
    // (left empty, so Sign Steps records the allowlist's one address). Any other form login is no one: refused.
    expect(sign.parameters).not.toHaveProperty('approverId');
    expect(sign.parameters.approvalFormPage).toBe(REVIEW);
    const approverFrom = (authentication: string) => evaluate(String(sign.parameters.approverFrom), { $: (name: string) => ({ params: name === 'Import a bot' ? { authentication } : {} }) });
    expect(['n8nUserAuth', 'basicAuth', 'none', ''].map(approverFrom)).toEqual(['formSignIn', 'approvedBy', 'formSignIn', 'formSignIn']);
    expect(sign.notes).toContain('Approver: the n8n user who submitted Review and approve (with Basic Auth on Import a bot, Approved By)');
    expect(sign.notes).toContain('Approver Allowlist: the n8n address of each person who may approve, typed here');
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
    // The file is not required: left empty, the name picks an approved bot to change or sign again. No new field.
    expect(fields.map((f) => [f.fieldName, f.fieldType, f.requiredField === true])).toEqual([['bot', 'file', false], ['source', 'dropdown', false], ['name', 'text', true]]);
    expect(fields[1].fieldLabel).toBe('Source (optional)');
    const page = byName(t, 'The file it downloads');
    expect(page).toMatchObject({ type: COMPLETION, typeVersion: 2.5, parameters: { operation: 'page', options: { formTitle: 'The file it downloads', buttonLabel: 'Import' } } });
    expect((page.parameters.formFields as { values: FormField[] }).values.map((f) => [f.fieldName, f.fieldType, f.requiredField === true])).toEqual([['expectedFileName', 'text', false], ['columns', 'text', false]]);
    // Asked unless the Source or the file name says recording (the recorder makes its export step). A UiPath project is
    // asked too: its browser steps need the Expected File to make their download a checked one.
    const asks = (byName(t, 'Asks about a download?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    /** Settings' item, Read the upload's text (when it read the file), and whether the page is asked. */
    const ask = (source: string | null, filename: string, text?: string) =>
      evaluate(asks, { $json: text === undefined ? { error: 'No binary data property "none"' } : { text }, $: (n: string) => ({ first: () => ({ json: n === 'Settings' ? { source, bot: { filename } } : {} }) }) });
    expect(ask(null, 'export.json')).toBe(true);
    expect(ask('Chrome Recorder', 'export.json')).toBe(true);
    // A step document is not asked: its download steps carry their own checks, and the answers are not used for it.
    expect(ask('Step document', 'steps.json')).toBe(true);
    expect(ask('Step document', 'steps.json', JSON.stringify({ steps: [{ intent: 'Open', goto: '/' }] }))).toBe(false);
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
      : { isExecuted: name === 'The file it downloads' && asked, last: () => ({ json: { expectedFileName: '^X_', columns: null } }) }) });
    expect(values.map((a) => evaluate(a.value, scope(true)))).toEqual(['n', '', '^X_', '', { fileName: 'export.json' }]);
    expect(values.map((a) => evaluate(a.value, scope(false)))).toEqual(['n', '', '', '', { fileName: 'export.json' }]);
    // One file per import: the form refuses a second, so the upload is always binary `bot` (n8n adds `_0`, `_1` only for 2+ files).
    expect(fields[0].multipleFiles).toBe(false);
    expect(fields[1].fieldOptions?.values.map((o) => o.option)).toEqual(Object.keys(SOURCES));
    // Sign-in on by default: an anonymous form could start logins with the attached Site Login (login breaker trips)
    // and model spend. n8n's own sign-in (Form Trigger 2.6), limited to people who may run this workflow: each page then
    // gives the n8n user who submitted it, and the review page's is the approver. No credential to pick.
    expect(form).toMatchObject({ typeVersion: 2.6, parameters: { authentication: 'n8nUserAuth', requireExecuteAccess: true } });
    expect(form.parameters).not.toHaveProperty('options.includeUserInOutput');
    expect(form).not.toHaveProperty('credentials');
    expect(form.notes).toContain('For approvers without an n8n account: Authentication → Basic Auth, and pick or create a Basic Auth credential here.');
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
    // Read the upload, as n8n runs it: the text of a file that may be a step document, else an error item.
    const read = byName(t, 'Read the upload').parameters as { binaryPropertyName: string; destinationKey: string };
    const field = evaluate(read.binaryPropertyName, { $json: settings.json });
    const readOut = field === 'bot' && settings.binary?.bot ? { text: Buffer.from(settings.binary.bot.data, 'base64').toString('utf8') } : { error: `No binary data property "${String(field)}"` };
    const asked = evaluate(asks, { $json: readOut, $: (name: string) => ({ first: () => (name === 'Settings' ? settings : { json: {} }) }) }) === true;
    const pageRan = asked && answer !== null;
    const scope = { $: (name: string) => (name === 'Settings' ? { first: () => settings } : { isExecuted: name === 'The file it downloads' && pageRan, last: () => ({ json: answer ?? {} }) }) };
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
  it('The file it downloads is asked for every upload but a recording and a step document: each kind of upload, through Read the upload', () => {
    const asked = (source: string, file: Buffer, filename: string) => {
      const item = formItem(source, file);
      (item.json.bot as IDataObject).filename = filename;
      return throughTheDownloadPage(item, null).asked;
    };
    const doc = (o: unknown) => Buffer.from(JSON.stringify(o));
    const auto = 'Work it out from the file';
    // Step documents: a download with its own check, one that reads rows, a desktop one, and one that only clicks.
    const download = { steps: [{ intent: 'Download with Export', download: { trigger: { role: 'button', name: 'Export' }, check: { name: '^X_', columns: ['A'] } } }] };
    const rows = { steps: [{ intent: 'Read the rows', extractTable: { scope: { css: 'table' }, idPattern: 'N\\d+' } }] };
    const desktop = { surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { uia: { path: [{ name: 'Save' }] } } }] };
    const clicks = [{ intent: 'Click Go', click: { text: 'Go' } }];
    for (const d of [download, rows, desktop, clicks]) {
      expect(asked(auto, doc(d), 'bot.steps.json'), JSON.stringify(d)).toBe(false);
      expect(asked('Step document', doc(d), 'steps.json'), JSON.stringify(d)).toBe(false);
    }
    // Asked: a Chrome Recorder export, Playwright code, a UiPath project, and a file that is not a step document.
    expect(asked(auto, CHROME, 'export.json')).toBe(true);
    expect(asked('Chrome Recorder', CHROME, 'export.json')).toBe(true);
    expect(asked(auto, Buffer.from("await page.goto('https://a.example/');"), 'bot.js')).toBe(true);
    expect(asked(auto, Buffer.from('PK\u0003\u0004'), 'Project.zip')).toBe(true);
    expect(asked('UiPath project', Buffer.from('<Activity />'), 'Main.xaml')).toBe(true);
    expect(asked(auto, Buffer.from('not json'), 'notes.json')).toBe(true);
    expect(asked(auto, doc({ steps: [] }), 'empty.json')).toBe(true);
    // A step document named as a ZIP is not read, and so asked (the import then refuses it as a project).
    expect(asked(auto, doc(download), 'steps.zip')).toBe(true);
    // Never asked: a recording, by name, by Source or by its format.
    expect(asked(auto, doc({ format: 'rpa-recording/1' }), 'erp.rpa-recording.json')).toBe(false);
    expect(asked('RPA recording', doc({}), 'renamed.json')).toBe(false);
    expect(asked(auto, doc({ format: 'rpa-recording/1', events: [] }), 'renamed.json')).toBe(false);
    // A file over 5 MB is not read: asked, as before.
    const big = formItem(auto, doc(download));
    Object.assign(big.json.bot as IDataObject, { filename: 'big.json', size: 6 * 1024 * 1024 });
    expect(throughTheDownloadPage(big, null).asked).toBe(true);
  });

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
    expect(reviewFields({ $: nodesRan(ran) }).map((f) => f.fieldType)).toEqual(['html', 'radio']);
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

  it('a step document that reads rows: imported with the ID Pattern its steps state, shown and signed, and its workflow file runs with it; without one the refusal names the field', async () => {
    const sample = readFileSync(new URL('../../../docs/samples/sandbox-rows.steps.json', import.meta.url), 'utf8').split('http://sandbox:8080').join(SITE.url);
    // A step document: the download page is not asked (nothing on it is about rows, and Import steps does not use it).
    const { asked, upload } = throughTheDownloadPage(formItem('Step document', Buffer.from(sample)), { expectedFileName: null, columns: null });
    expect(asked).toBe(false);
    const seen: AdoptInput[] = [];
    const [data, repaired] = await runImport(upload, provedWithoutBrowser(seen));
    expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 800)).toBeUndefined();
    expect(seen[0].output).toEqual({ idPattern: 'N26-\\d{4}' });
    expect(data[0].json.drafts).toEqual([expect.objectContaining({ adopted: true })]);
    // The workflow file's Run steps checks the rows with the same ID Pattern, typed.
    const file = JSON.parse(Buffer.from(String(data[0].binary?.workflow?.data), 'base64').toString('utf8')) as { nodes: { parameters: IDataObject }[] };
    const runs = file.nodes.filter((n) => n.parameters.operation === 'runSteps');
    expect(runs).toHaveLength(1);
    expect((runs[0].parameters.options as IDataObject).idPattern).toBe('N26-\\d{4}');
    // The review page shows the steps and the proof's rows, and Sign steps signs them as version 1.
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [data, repaired] } as Record<string, INodeExecutionData[][]>;
    const shown = reviewFields({ $: nodesRan(ran) });
    expect(shown.map((f) => f.fieldType)).toEqual(['html', 'radio']);
    expect(String(shown[0].html)).toContain('On each page: Read the notices table on this page');
    expect(String(shown[0].html)).toContain('Proven in a fresh browser:');
    const approved = await signAfterReview(ran, { decision_0: 'Approve and sign' }, {}, true);
    expect(approved.errors).toEqual([]);
    expect(approved.signed).toEqual([expect.objectContaining({ status: 'active', name: 'line-item-export', version: 1 })]);

    // The same bot whose extract step states no ID Pattern: refused before any browser, and the page says what to add.
    const bare = JSON.parse(sample) as { steps: { paginate?: { each: { extractTable: IDataObject }[] } }[] };
    delete bare.steps.at(-1)!.paginate!.each[0].extractTable.idPattern;
    const [refused] = await runImport(formItem('Step document', Buffer.from(JSON.stringify(bare))), (input) => realAdoptDraft(input) as never);
    expect(refused[0].json.drafts).toEqual([expect.objectContaining({ adopted: false, code: 'policy_violation', reason: IMPORT_ROWS_NEED_ID })]);
    const page = render(completion('Imported, with the workflow file').completionMessage, { $: nodesRan({ Settings: [[{ json: settingsJson() }]], 'Import steps': [refused, []] }) });
    expect(page.split('\n')[1]).toBe(`0 of 1 step list passed the replay. line-item-export: ${escapeHtml(IMPORT_ROWS_NEED_ID)}`);
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
    const fields = reviewFields({ $: nodesRan(ran) });
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
    const noFileFields = reviewFields({ $: nodesRan({ ...ran, 'Import steps': [[{ json: data[0].json }], [{ json: noFile }]] }) });
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
    const noDrafts = reviewFields({ $: nodesRan({ ...ran, 'Import steps': [[{ json: { ...data[0].json, drafts: [] } }], repaired] }) });
    expect(noDrafts).toEqual(fields);
    expect(fields[0].html).not.toContain('candidate');
    expect(fields[3]).toMatchObject({ fieldLabel: 'Any other step that saves, sends or submits (its number, optional)', placeholder: '7, 9' });
    expect(fields[3]).not.toHaveProperty('requiredField');
    expect(fields[2].html).toBe('<p><em>Ticked steps are allowed to save or send. An unticked step is stopped only when it tries to use a control or key that your administrator has protected on the bot machine.</em></p>');
    expect(fields[4]).toEqual({ fieldLabel: 'Decision', fieldName: 'decision_0', fieldType: 'radio', fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] }, requiredField: true });
    // The page ends at the decision. Settings → showDetails puts the full detail (the item's own texts, escaped, small and
    // grey) back, above the question, in place of the pointer.
    expect(settingsJson().showDetails).toBe(false);
    const detailed = reviewFields({ $: nodesRan({ ...ran, Settings: [[{ json: { ...settingsJson(), showDetails: true } }]] }) });
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

  it('approved, a bot that types a secret gets on the last page what to copy into its RPA Secret Variables credential, never the value', async () => {
    // The ERP Demo recording types {{var.password}} into ErpDemo.exe.
    const { ran } = await importedRecording();
    const approved = await signAfterReview(ran, { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' });
    const name = String(approved.signed[0].name);
    const after = (signed: IDataObject[], more: Record<string, INodeExecutionData[][]> = {}) => ({
      ...ran, [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [signed.map((json) => ({ json })), []], ...more,
    });
    const BLOCK = `\n\n${name} types a secret. In n8n, make an RPA Secret Variables credential (+ → New credential), select it on the bot's RPA node, and copy these into it:`
      + '\nCredential: <code>RPA Secret Variables</code>\nName: <code>password</code>\nMay Be Typed Into: <code>ErpDemo.exe</code>\nType the value there only: this form never asks for it.';
    for (const page of ['Imported, with the workflow file', 'Imported']) {
      const p = completion(page);
      const shown = render(p.completionMessage, { $: nodesRan(after(approved.signed)) });
      expect(shown.endsWith(BLOCK), page).toBe(true);
      // One click selects a value to copy.
      expect((p as { options?: { customCss?: string } }).options?.customCss).toBe('code { user-select: all; -webkit-user-select: all; }');
      // Rejected, or on the change page (the credential is there already): no block.
      expect(render(p.completionMessage, { $: nodesRan(after([{ ...approved.signed[0], status: 'rejected' }])) })).not.toContain('types a secret');
      expect(render(p.completionMessage, { $: nodesRan(after(approved.signed, { 'Change or sign again': [[{ json: { changedSteps: '' } }]], 'The bot to change': [[{ json: { name, version: 1 } }]] })) })).not.toContain('types a secret');
    }
    // Names and an app or host only: escaped like every other text on the page.
    const odd = render(completion('Imported').completionMessage, { $: nodesRan({
      Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [{ name: 'a<b', forApproval: true, secretVariables: ['pin'], mayBeTypedInto: 'erp.example.com' }, { name: 'plain', adopted: true }] } }], []],
      [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [[{ json: { status: 'active', name: 'a<b', version: 1 } }, { json: { status: 'active', name: 'plain', version: 1 } }], []],
    }) });
    expect(odd).toContain('\n\na&lt;b types a secret.');
    expect(odd).toContain('\nName: <code>pin</code>\nMay Be Typed Into: <code>erp.example.com</code>\n');
    expect(odd.match(/types a secret/g)).toHaveLength(1);
  });

  it('a Sign steps refusal signs nothing and the last page names the reason; an approver not on the allowlist is refused', async () => {
    const { ran } = await importedRecording();
    const refused = await signAfterReview(ran, { writes_0: [], moreWrites_0: '99', decision_0: 'Approve and sign' });
    expect(refused.signed).toEqual([]);
    expect(String(refused.errors[0].error)).toBe('Sign Steps refused: Write Steps: there is no step 99 (the steps are numbered 1 to 17)');
    const approve = { decision_0: 'Approve and sign' };
    const twoListed = { approverAllowlist: `someone-else@example.com, ${APPROVER}` };
    // n8n sign-in: the n8n user who submitted the review page is the approver, recorded as n8n gives the address.
    expect((await signAfterReview(ran, approve)).signed[0]).toMatchObject({ status: 'active', approvedBy: APPROVER });
    expect((await signAfterReview(ran, approve, twoListed)).signed[0]).toMatchObject({ status: 'active', approvedBy: APPROVER });
    // Signed in, but not on the allowlist (a member who has the review page's address): refused, nothing signed.
    const other = await signAfterReview(ran, approve, {}, false, signedIn('member@example.com'));
    expect(other.signed).toEqual([]);
    expect(String(other.errors[0].error)).toBe('Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist');
    // No one signed in on the review page (its form switched to None): refused, even with one address on the allowlist,
    // and a review answer that carries a field named like the user does not stand in for one.
    for (const [answer, auth] of [[approve, 'none'], [{ ...approve, user: APPROVER }, undefined]] as const) {
      const none = await signAfterReview(ran, answer, {}, false, null, auth);
      expect(none.signed).toEqual([]);
      expect(String(none.errors[0].error)).toMatch(/^Sign Steps refused: No n8n user signed in on the form page "Review and approve"/);
    }
    // Basic Auth on the form: as before. The allowlist's one address is recorded; with a second address on the allowlist,
    // Approved By must say which one decided: an empty one is refused.
    expect((await signAfterReview(ran, approve, {}, false, null, 'basicAuth')).signed[0]).toMatchObject({ status: 'active', approvedBy: APPROVER });
    const two = await signAfterReview(ran, approve, twoListed, false, null, 'basicAuth');
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
    const fields = reviewFields({ $: nodesRan(ran) });
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
        // A typed value: the short list shows it, from the step. Its description names another action: a warning.
        { intent: 'Read the note', fill: { field: { css: '#n' }, value: 'hello <b>' } },
      ] },
      safetyFlags: ['host: a.example\' <script>', 'form submission: POST a.example/send', 'download step', 'secret fill: a step types the run variable {{var.exportPassword}}'],
      safetyLine: 'host: a.example\' <script>; …', evidenceLine: '7 rows <img src=x onerror=alert(1)>; compared with the repair run: 0 missing, 0 extra',
      changeList: 'Added: Open the list\nAdded: Read "rows" $& $$', leftOutList: 'step 4, Pick <b>Status</b>\nstep 9, Wait',
    };
    // As Import steps builds it from the steps.
    const withLines = { ...item, reviewSteps: reviewSteps(item.steps.steps, { desktop: false, shownUrl }) };
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [] } }], [{ json: withLines }]] } as Record<string, INodeExecutionData[][]>;
    const fields = reviewFields({ $: nodesRan(ran) });
    expect(fields.map((f) => f.fieldType)).toEqual(['html', 'radio']);
    const POINTER = '<p><em>How each step finds its control is in this run\'s execution in n8n (the Import steps node\'s output), and in the approval email when approval is by email.</em></p>';
    expect(fields[0].html).toBe('<p>Opens a.example&#39; &lt;script&gt;.<br>Signs in with the RPA Site Login.<br>Submits a form: POST a.example/send.<br>Returns a file to n8n: step 5.<br>'
      + 'Types a secret: the run variable {{var.exportPassword}}.<br>7 rows &lt;img src=x onerror=alert(1)&gt;.</p>'
      + '<p><b>⚠ Left out by the import:</b><br>step 4, Pick &lt;b&gt;Status&lt;/b&gt;<br>step 9, Wait</p>'
      + '<p><b>The steps</b></p><ol><li>Open a.example/list <em>(the author calls it: Open the list)</em></li><li>Sign in <em>· signs in with the RPA Site Login</em></li>'
      + '<li>Type into the element matching &quot;#p&quot;: a secret <em>(the author calls it: Type the export password)</em> <em>· secret variable exportPassword</em></li>'
      + '<li>Choose an option set by a variable in the element matching &quot;#s&quot; <em>(the author calls it: Pick &lt;b&gt;Status&lt;/b&gt;)</em> <em>· variable status</em></li>'
      + '<li>Download with an element <em>(the author calls it: Download the report)</em> <em>· returns a file</em></li>'
      + '<li>Type into the element matching &quot;#n&quot;: &quot;hello &lt;b&gt;&quot; <strong>(described differently as: Read the note)</strong></li></ol>' + POINTER);
    // Every flag the opening lines do not already say in their own words is worded as a sentence, never shown raw.
    const opening = (safetyFlags: string[]) => String(reviewFields({
      $: nodesRan({ ...ran, 'Import steps': [ran['Import steps'][0], [{ json: { ...withLines, safetyFlags, leftOutList: undefined, evidenceLine: 'Proven in a fresh browser: 7 rows (the page states no total)' } }]] }),
    })[0].html).split('</p>')[0].replace(/^<p>/, '').split('<br>');
    expect(opening([
      'count unverified: the page that was read states no total', 'extract-fields-dropped',
      'interrupt: when the dialog "Cookies" shows, click the button "Accept"', 'secret fill: a step types the run variable {{var.pin}}',
      'password change: a step sets a new password from the run variable {{var.newPassword}}',
      'clipboard read: step 4 (Copy the total) returns the clipboard\'s text to n8n as "total" (the desktop runner allows it only when its policy sets clipboardRead, only while the run\'s window is in front, and only for text the run\'s app copied in the last step that acted on it, at most 10 seconds earlier)',
      'a flag a later engine adds',
    ])).toEqual([
      'Signs in with the RPA Site Login.', 'Returns a file to n8n: step 5.',
      'The page states no total, so the number of rows read is not checked against one.',
      'Reads fewer fields than the version before: check that each row still has what you need.',
      'Closes a pop-up: when the dialog &quot;Cookies&quot; shows, it clicks the button &quot;Accept&quot;.',
      'Types a secret: the run variable {{var.pin}}.',
      'Sets a new password from the run variable {{var.newPassword}} when the site asks for one.',
      'Gives the clipboard&#39;s text to n8n: step 4 (Copy the total), as &quot;total&quot;. The desktop runner allows this only when its policy allows clipboard reads.',
      'A flag a later engine adds.',
      // Said once: the line above says the page states no total.
      'Proven in a fresh browser: 7 rows.',
    ]);
    const detailed = reviewFields({ $: nodesRan({ ...ran, Settings: [[{ json: { ...settingsJson(), showDetails: true } }]] }) });
    expect(detailed[0].html).toBe(String(fields[0].html).replace(POINTER, '') + '<h4>Details of every step (how each one finds its control)</h4><p><em><b>Safety flags:</b> host: a.example&#39; &lt;script&gt;; …</em></p>'
      + '<p><em><b>Left out by the import (the source does these, the steps do not):</b><br>step 4, Pick &lt;b&gt;Status&lt;/b&gt;<br>step 9, Wait</em></p>'
      + '<p><em><b>Evidence (as reported by the run):</b> 7 rows &lt;img src=x onerror=alert(1)&gt;; compared with the repair run: 0 missing, 0 extra</em></p>'
      + '<p><em><b>What changed (as reported by the run):</b><br>Added: Open the list<br>Added: Read &quot;rows&quot; $&amp; $$</em></p>'
      + '<p><em>Screenshots of the replay are in this execution in n8n, on the Repaired Steps output of Import steps.</em></p>');
    const notRun = reviewFields({ $: nodesRan({ Settings: [[{ json: { ...settingsJson(), showDetails: true } }]], 'Import steps': [ran['Import steps'][0], [{ json: { ...withLines, evidenceLine: NOT_REPLAYED_LINE, attachmentNames: '', leftOutList: undefined } }]] }) });
    expect(notRun[0].html).toContain('<br>Not run by the import: check every step, each form&#39;s target and each download before you approve.</p><p><b>The steps</b></p><ol>');
    expect(notRun[0].html).toContain(`<b>Evidence:</b> ${escapeHtml(NOT_REPLAYED_LINE)}</em></p><p><em><b>What changed (as written; these steps were never run):</b>`);
    expect(notRun[0].html).not.toContain('Screenshots');
    // A variable written with spaces gets its mark too (the page's own regex used to miss it).
    expect(reviewSteps([{ intent: 'Type the note', fill: { field: { label: 'Note' }, value: '{{ var.note }}' } }], { desktop: false, shownUrl }))
      .toEqual([{ text: 'Type into Note: a variable', describedAs: 'Type the note', quiet: true, marks: ['variable note'] }]);
    expect(reviewSteps([{ intent: 'Pick', select: { field: { uia: { path: [{ controlType: 'ComboBox', name: 'Plant' }] } }, option: '{{ var.plant }}' } }], { desktop: true }))
      .toEqual([{ text: 'Choose an item in Plant', marks: ['variable plant'] }]);
    // A desktop read names its control by the name a person sees, never by its automation id, and says the output once.
    const read = (cond: Record<string, string>) => ({ intent: `Read ${cond.name ?? cond.automationId} as out_result_count`, read: { target: { uia: { window: { exe: 'erpdemo.exe' }, path: [{ automationId: 'gridResults' }, cond] } }, as: 'out_result_count' } });
    expect(reviewSteps([read({ controlType: 'Text', automationId: 'lblResultCount' }), read({ controlType: 'Text', automationId: 'lblCount', name: ' Result count ' })], { desktop: true })).toEqual([
      { text: 'Read a value from the app', marks: ['gives its text to n8n as out_result_count'] },
      { text: 'Read Result count', marks: ['gives its text to n8n as out_result_count'] },
    ]);
    // A control with neither a name nor an id: the action and the value come from the step, as for a named control. The
    // intent is the author's own description and is shown as that: it can neither replace the action nor hide the value.
    const bare = { uia: { path: [{ controlType: 'Edit' }] } };
    expect(reviewSteps([
      { intent: 'Type into the date field', fill: { field: bare, value: '2026-01-20' } },
      { intent: 'Read the total (a value such as a)', fill: { field: bare, value: 'a' } },
      { intent: 'Type the date', fill: { field: bare, value: '{{var.date}}' } },
      { intent: 'Pick the plant', select: { field: bare, option: '1000' } },
      { intent: 'Uncheck the box', check: { field: bare, checked: true } },
      { intent: '', check: { field: bare, checked: false } },
    ], { desktop: true }).map(line)).toEqual([
      'Type "2026-01-20" into a field without a name (described differently as: Type into the date field)',
      'Type "a" into a field without a name (described differently as: Read the total (a value such as a))',
      'Type into a field without a name (described differently as: Type the date)',
      'Choose "1000" in a field without a name (described differently as: Pick the plant)',
      'Check a box without a name (described differently as: Uncheck the box)',
      'Uncheck a box without a name',
    ]);
    // A click names its control from the step, too. A description that says something else stands beside it, in brackets.
    const post = { uia: { path: [{ controlType: 'Button', name: 'Post' }] } };
    expect(reviewSteps([
      { intent: 'Click Post', click: post },
      { intent: 'Read the total', click: post },
      { intent: 'Open the row', doubleClick: post },
      { intent: 'Look at the list', click: { uia: { path: [{ controlType: 'Pane' }] } } },
    ], { desktop: true }).map(line)).toEqual([
      'Click Post',
      'Click Post (described differently as: Read the total)',
      'Double-click Post (described differently as: Open the row)',
      'Click a control without a name (described differently as: Look at the list)',
    ]);
  });

  it('a description is the author\'s words, shown quietly; a warning only when it names another kind of action or another site', () => {
    const one = (step: IDataObject, startUrl?: string) => reviewSteps([step], { desktop: false, shownUrl, ...(startUrl ? { startUrl } : {}) })[0];
    // The samples of the films: a harmless rewording is quiet.
    expect(one({ intent: 'Type the PIN', fill: { field: { label: 'PIN' }, value: '{{var.pin}}', secret: true } }))
      .toEqual({ text: 'Type into PIN: a secret', describedAs: 'Type the PIN', quiet: true, marks: ['secret variable pin'] });
    expect(one({ intent: 'Open the products page', goto: 'http://sandbox:8080/public/table' }))
      .toEqual({ text: 'Open http://sandbox:8080/public/table', describedAs: 'Open the products page', quiet: true, marks: [] });
    // Another kind of action: a warning.
    expect(one({ intent: 'Read the total', click: { role: 'button', name: 'Delete all' } })).toEqual({ text: 'Click Delete all', describedAs: 'Read the total', marks: [] });
    // Another site: a warning, whatever the verb; the step's own host, or the start site's, is quiet.
    expect(one({ intent: 'Open https://bank.example', goto: 'https://evil.example/login' })).toEqual({ text: 'Open evil.example/login', describedAs: 'Open https://bank.example', marks: [] });
    expect(one({ intent: 'Open bank.example', goto: 'https://evil.example/login' })).not.toHaveProperty('quiet');
    expect(one({ intent: 'Open https://evil.example', goto: 'https://evil.example/login' })).toMatchObject({ quiet: true });
    expect(one({ intent: 'Open https://shop.example/orders', goto: '/orders' }, 'https://shop.example/')).toMatchObject({ quiet: true });
    expect(one({ intent: 'Open https://bank.example/orders', goto: '/orders' }, 'https://shop.example/')).not.toHaveProperty('quiet');
    expect(one({ intent: 'Type user@mail.example', fill: { field: { label: 'Email' }, value: 'user@mail.example' } })).toMatchObject({ quiet: true });
    expect(one({ intent: 'Type the address of bank.example', fill: { field: { label: 'Email' }, value: 'x' } })).not.toHaveProperty('quiet');
    // A file name is not a site.
    expect(one({ intent: 'Download report.csv', download: { trigger: { text: 'Export' } } })).toMatchObject({ quiet: true });
    // The same words as the sentence: nothing beside it, as before.
    expect(one({ intent: 'Click Delete all.', click: { role: 'button', name: 'Delete all' } })).toEqual({ text: 'Click Delete all', marks: [] });
    // A first word the table does not know is quiet; each kind its own words, two-word ones included.
    expect(one({ intent: 'Remove the banner', click: { text: 'OK' } })).toMatchObject({ quiet: true });
    for (const [intent, step, quiet] of [
      ['Navigate to the list', { goto: 'https://a.example/list' }, true], ['Visit the list', { goto: 'https://a.example/list' }, true],
      ['Click the list', { goto: 'https://a.example/list' }, false], ['Enter 5', { fill: { field: { label: 'N' }, value: '5' } }, true],
      ['Wait for the total', { fill: { field: { label: 'N' }, value: '5' } }, false], ['Tap Save', { click: { text: 'Save' } }, true],
      ['Open the order', { click: { text: 'Order 7' } }, true], ['Export the list', { click: { text: 'Export' } }, true],
      ['Tick Agree', { check: { field: { label: 'Agree' } } }, true], ['Get the rows', { check: { field: { label: 'Agree' } } }, false],
      ['Pick north', { select: { field: { label: 'Region' }, value: 'north' } }, true], ['Upload the file', { click: { text: 'Send' } }, false],
      ['Log in as the admin', { signIn: {} }, true], ['Sign in as the admin', { click: { text: 'Delete' } }, false],
      ['Save the order', { submit: { path: '/save', button: { text: 'Save' } } }, true], ['Read the order', { submit: { path: '/save', button: { text: 'Save' } } }, false],
    ] as const) {
      const r = one({ intent, ...step });
      expect(r.describedAs, intent).toBe(intent);
      expect(r.quiet === true, intent).toBe(quiet);
    }
    // Desktop steps alike.
    const field = { uia: { path: [{ name: 'Total' }] } };
    expect(reviewSteps([{ intent: 'Read the total', click: field }, { intent: 'Press the button', click: field }], { desktop: true })).toEqual([
      { text: 'Click Total', describedAs: 'Read the total', marks: [] }, { text: 'Click Total', describedAs: 'Press the button', quiet: true, marks: [] },
    ]);
  });

  it('a browser step\'s sentence comes from the step itself; the description stands beside it only when it says something else', () => {
    const texts = (steps: object[]) => reviewSteps(steps, { desktop: false, shownUrl }).map(line);
    const save = { role: 'button', name: 'Save', exact: true };
    // Every kind that acts on the page or sends something, with the descriptions an import writes: no brackets.
    expect(texts([
      { intent: 'Open a.example/acme/list', goto: 'https://user:pw@a.example/acme/list?token=abc#top' },
      { intent: 'Open a.example', goto: 'https://a.example/' },
      { intent: 'Sign in', signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: save } },
      { intent: 'Sign in with an authentication code', signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: save, totp: { field: { label: 'Code' }, submit: save } } },
      { intent: 'Click Save', click: save },
      { intent: 'Click Beta', click: { text: 'Beta' }, modifiers: ['Ctrl', 'Shift'] },
      { intent: 'Type into Note', fill: { field: { label: 'Note' }, value: 'hello' } },
      { intent: 'Choose north, south in Region', select: { field: { label: 'Region' }, value: ['north', 'south'] } },
      { intent: 'Check Agree', check: { field: { role: 'checkbox', name: 'Agree' } } },
      { intent: 'Uncheck Agree', check: { field: { role: 'checkbox', name: 'Agree' }, checked: false } },
      { intent: 'Click every Expand', clickAll: { target: { text: 'Expand' }, max: 5 } },
      { intent: 'Press Enter in Search', press: { key: 'Enter', target: { label: 'Search' } } },
      { intent: 'Press Escape', press: { key: 'Escape' } },
      { intent: 'Hover over menu', hover: { testId: 'menu' } },
      { intent: 'Open Report in a new tab', popup: { trigger: { role: 'link', name: 'Report' } } },
      { intent: 'Download with Export', download: { trigger: { text: 'Export' } } },
      { intent: 'Click "Send (F8)" to submit a form', submit: { path: '/acme/send', button: { role: 'button', name: 'Send (F8)' } } },
      { intent: 'Page through with Next', paginate: { next: { role: 'button', name: 'Next' }, until: 'absent', max: 3, each: [{ intent: 'Click Row', click: { text: 'Row' } }] } },
    ])).toEqual([
      'Open a.example/acme/list',
      'Open a.example',
      'Sign in',
      'Sign in with an authentication code',
      'Click Save',
      'Click Beta, holding Ctrl+Shift',
      'Type into Note: "hello"',
      'Choose "north", "south" in Region',
      'Check Agree',
      'Uncheck Agree',
      'Click every Expand, at most 5',
      'Press Enter in Search',
      'Press Escape',
      'Hover over menu',
      'Open Report in a new tab',
      'Download with Export',
      'Click "Send (F8)" to submit a form to POST the start site at /acme/send',
      'Page through with Next, at most 3 pages, 1 step on each',
    ]);
    // A description that says something else stands beside the sentence: on a fill, a click, a goto and a submit.
    expect(texts([
      { intent: 'Read the total', fill: { field: { label: 'Amount' }, value: '9999' } },
      { intent: 'Click Cancel', click: { role: 'button', name: 'Pay now' } },
      { intent: 'Open the help page', goto: 'https://pay.example/transfer' },
      { intent: 'Close the dialog', submit: { host: 'b.example', path: '/pay', method: 'post', button: save } },
      { intent: 'Download the report', download: { trigger: { text: 'Export' }, via: { path: '/export' } } },
    ])).toEqual([
      'Type into Amount: "9999" (described differently as: Read the total)',
      'Click Pay now (described differently as: Click Cancel)',
      'Open pay.example/transfer (described differently as: Open the help page)',
      'Click Save to submit a form to POST b.example/pay (described differently as: Close the dialog)',
      'Download with Export, through a form sent to POST the start site at /export (described differently as: Download the report)',
    ]);
    // A short value the description happens to contain still shows, from the step. Case, double quotes and spaces aside, a
    // description that says the action is not repeated.
    expect(texts([
      { intent: 'Type a into Note', fill: { field: { label: 'Note' }, value: 'a' } },
      { intent: '  type INTO   note: "a" ', fill: { field: { label: 'Note' }, value: 'a' } },
      { intent: 'Choose 1000 in Company Code', select: { field: { label: 'Company Code' }, value: '1000' } },
    ])).toEqual(['Type into Note: "a" (described differently as: Type a into Note)', 'Type into Note: "a"', 'Choose "1000" in Company Code']);
    // Single and curly quotes and a full stop at the end aside too. Another verb, target or value still shows: no list
    // of verbs that "mean the same" is guessed, so a description cannot pass for a step it does not describe.
    expect(texts([
      { intent: "Type into From: '2026-09-01'.", fill: { field: { label: 'From' }, value: '2026-09-01' } },
      { intent: 'Click \u201cLine Item Report\u201d.', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'click line item report', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Click Line Item Reports', click: { role: 'button', name: 'Line Item Report' } },
      { intent: 'Type into From: "2026-09-02"', fill: { field: { label: 'From' }, value: '2026-09-01' } },
      { intent: 'Type into To: "2026-09-01"', fill: { field: { label: 'From' }, value: '2026-09-01' } },
      { intent: 'Click Line Item Report..', click: { role: 'button', name: 'Line Item Report' } },
    ])).toEqual([
      'Type into From: "2026-09-01"', 'Click Line Item Report', 'Click Line Item Report',
      'Click Line Item Report (described differently as: Open Line Item Report)',
      'Click Line Item Report (described differently as: Click Line Item Reports)',
      'Type into From: "2026-09-01" (described differently as: Type into From: "2026-09-02")',
      'Type into From: "2026-09-01" (described differently as: Type into To: "2026-09-01")',
      'Click Line Item Report (described differently as: Click Line Item Report..)',
    ]);
    // A secret fill shows "a secret", a variable "a variable": never a value, never the template.
    const secret = texts([
      { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{var.exportPassword}}', secret: true } },
      { intent: 'Type into Note', fill: { field: { label: 'Note' }, value: 'Dear {{ var.name }}' } },
      { intent: 'Pick', select: { field: { label: 'Region' }, value: ['north', '{{var.region}}'] } },
    ]);
    expect(secret).toEqual([
      'Type into Export password: a secret (described differently as: Type the export password)',
      'Type into Note: a variable',
      'Choose "north", an option set by a variable in Region (described differently as: Pick)',
    ]);
    expect(secret.join('\n')).not.toContain('{{');
    // A CSS selector shows itself, cut; a long description is cleaned to one line and cut; a quote in a value stays a quote.
    const long = `div.results > ${'span.cell '.repeat(20)}`;
    expect(texts([
      { intent: `Click\nthe​ first cell ${'x'.repeat(200)}`, click: { css: long } },
      { intent: 'Type into Name', fill: { field: { label: 'Name' }, value: 'say "hi"\nbye' } },
    ])).toEqual([
      `Click the element matching ${JSON.stringify(long.slice(0, 80))}… (described differently as: Click the first cell ${'x'.repeat(99)}…)`,
      'Type into Name: "say \\"hi\\"\\nbye"',
    ]);
    // A plain http address keeps its "http://"; an https one is shown without its scheme. The importer's wording, which
    // leaves out either scheme, still matches; a description that says something else does not.
    expect(texts([
      { intent: 'Open localhost:8080/acme/login', goto: 'http://localhost:8080/acme/login?x=1' },
      { intent: 'Open a.example', goto: 'http://a.example/' },
      { intent: 'Open the bank', goto: 'http://pay.example/transfer' },
      { intent: 'Open pay.example/transfer', goto: 'https://pay.example/transfer' },
    ])).toEqual([
      'Open http://localhost:8080/acme/login',
      'Open http://a.example',
      'Open http://pay.example/transfer (described differently as: Open the bank)',
      'Open pay.example/transfer',
    ]);
    // Steps that only read or wait keep their description as their sentence.
    expect(texts([
      { intent: 'Wait for the table', waitFor: { target: { css: 'table' } } },
      { intent: 'Read the rows', extract: { scope: { css: 'table' }, item: { css: 'tr' } } },
      { intent: 'Read the page title', read: { what: 'title' } },
    ])).toEqual(['Wait for the table', 'Read the rows', 'Read the page title']);
  });

  it('the change list the email and the details block show says every acting step\'s action and value from the step, whatever its description', () => {
    // Every description says something else than its step does. The change list is signed and digested: unchanged here.
    const save = { role: 'button', name: 'Save' };
    const said = 'Read the total';
    const steps = [
      { intent: said, goto: '/acme/pay' },
      { intent: said, signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: save } },
      { intent: said, click: { role: 'button', name: 'Pay now' }, modifiers: ['Ctrl'] },
      { intent: said, fill: { field: { label: 'Amount' }, value: '9999' } },
      { intent: said, select: { field: { label: 'Region' }, value: 'north' } },
      { intent: said, check: { field: { label: 'Agree' }, checked: false } },
      { intent: said, clickAll: { target: { text: 'Delete' }, max: 5 } },
      { intent: said, press: { key: 'Enter', target: { label: 'Search' } } },
      { intent: said, hover: { testId: 'menu' } },
      { intent: said, popup: { trigger: { text: 'Report' } } },
      { intent: said, submit: { path: '/pay', button: save } },
      { intent: said, download: { trigger: { text: 'Export' }, via: { path: '/export' } } },
      { intent: said, paginate: { next: save, until: 'absent', max: 3, each: [{ intent: said, fill: { field: { label: 'Note' }, value: 'x' } }] } },
    ];
    const lines = changeList(notReplayedProposal(parseScript({ name: 'pay', version: 1, startUrl: 'https://a.example/', steps }))).split('\n');
    expect(lines).toEqual([
      'Added: Read the total (go to "/acme/pay")',
      'Added: Read the total (sign in with label "User", label "Password", submit role "button" name "Save")',
      'Added: Read the total (Ctrl+click role "button" name "Pay now")',
      'Added: Read the total (fill label "Amount" with "9999")',
      'Added: Read the total (select "north" in label "Region")',
      'Added: Read the total (uncheck label "Agree")',
      'Added: Read the total (click every text "Delete", at most 5)',
      'Added: Read the total (press Enter on label "Search")',
      'Added: Read the total (hover over test id "menu")',
      'Added: Read the total (open a new tab with text "Report")',
      'Added: Read the total (submit with role "button" name "Save" to POST the start site/pay)',
      'Added: Read the total (download with text "Export" through POST the start site/export)',
      'Added: Read the total (paginate next role "button" name "Save" until absent, at most 3 pages)',
      'Added: Read the total (fill label "Note" with "x")',
    ]);
  });

  it('the review page writes the label itself and shows each field escaped, for browser and desktop entries alike', () => {
    const MARK = ' (described differently as: ';
    const entries = [
      { text: `Click "Save${MARK}Delete all) <i>"`, describedAs: `Open${MARK}x) <b>`, marks: [] },
      { text: `Type into Note: "v${MARK}w)"`, marks: [] },
    ];
    for (const steps of [{ startUrl: 'https://a.example/', steps: [{}, {}] }, { surface: 'desktop', app: { exe: 'App.exe' }, steps: [{}, {}] }]) {
      const item = { name: 'feed', version: 1, steps, safetyFlags: [], safetyLine: 'none', evidenceLine: '3 rows', changeList: '', reviewSteps: entries };
      const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [] } }], [{ json: item }]] } as Record<string, INodeExecutionData[][]>;
      const html = String(reviewFields({ $: nodesRan(ran) })[0].html);
      expect(html).toContain('<ol><li>Click &quot;Save (described differently as: Delete all) &lt;i&gt;&quot; <strong>(described differently as: Open (described differently as: x) &lt;b&gt;)</strong></li>'
        + '<li>Type into Note: &quot;v (described differently as: w)&quot;</li></ol>');
      // Only describedAs is in red: the sentence's own words are never.
      expect(html.match(/<strong>/g)).toHaveLength(1);
    }
  });

  it('a paginate lists the steps it runs on each page under its own line, each worded from the step, with its own marks', () => {
    // paginate is the only step that holds steps (no nested paginate, no signIn inside): its body comes under it.
    const steps = [
      { intent: 'Open the list', goto: 'https://a.example/list' },
      { intent: 'Go through the pages', paginate: { next: { role: 'button', name: 'Next' }, until: 'absent', max: 3, each: [
        { intent: 'Read the rows', extract: { scope: { css: 'table' }, item: { css: 'tr' } } },
        { intent: 'Read the note', fill: { field: { label: 'Note' }, value: '<b>{{var.note}}</b>' } },
        { intent: 'Close the banner', click: { text: 'Delete <all>' } },
      ] } },
      { intent: 'Download with Export', download: { trigger: { text: 'Export' } } },
    ];
    const listed = reviewSteps(steps, { desktop: false, shownUrl });
    expect(listed[1]).toEqual({
      text: 'Page through with Next, at most 3 pages, 3 steps on each', describedAs: 'Go through the pages', quiet: true, marks: [],
      each: [
        { text: 'Read the rows', marks: [] },
        // "Read" names another kind of action than typing: a warning. "Close" is not in the table: the author's words.
        { text: 'Type into Note: a variable', describedAs: 'Read the note', marks: ['variable note'] },
        { text: 'Click Delete <all>', describedAs: 'Close the banner', quiet: true, marks: [] },
      ],
    });
    expect(listed.map((r) => r.each === undefined)).toEqual([true, false, true]);
    // On the page: nested under the paginate's item, so the numbers of the steps after it do not move. Escaped once.
    const item = { name: 'feed', version: 1, steps: { startUrl: 'https://a.example/', steps }, safetyFlags: [], safetyLine: 'none', evidenceLine: '3 rows', changeList: '', reviewSteps: listed };
    const ran = { Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 3, items: [] }, drafts: [] } }], [{ json: item }]] } as Record<string, INodeExecutionData[][]>;
    const html = String(reviewFields({ $: nodesRan(ran) })[0].html);
    // A description that names another kind of action is a warning: <strong>, which the page's style shows in red. Any
    // other description stands beside the sentence quietly (<em>, grey), as the author's words.
    expect(html).toContain('<ol><li>Open a.example/list <em>(the author calls it: Open the list)</em></li>'
      + '<li>Page through with Next, at most 3 pages, 3 steps on each <em>(the author calls it: Go through the pages)</em><ul>'
      + '<li>On each page: Read the rows</li>'
      + '<li>On each page: Type into Note: a variable <strong>(described differently as: Read the note)</strong> <em>· variable note</em></li>'
      + '<li>On each page: Click Delete &lt;all&gt; <em>(the author calls it: Close the banner)</em></li></ul></li>'
      + '<li>Download with Export <em>· returns a file</em></li></ol>');
    expect(html).toContain('Returns a file to n8n: step 3.');
    expect(String(review.parameters.options && (review.parameters.options as IDataObject).customCss)).toContain('div.html strong { color: #b00020; font-weight: 600; }');
  });

  it('a recording\'s marks name its secret variables from the import, never a value', async () => {
    const { repaired, ran } = await importedRecording();
    const data = ran['Import steps'][0][0].json as { drafts: IDataObject[] };
    expect(data.drafts[0]).toMatchObject({ surface: 'desktop', secretVariables: ['password'] });
    expect((repaired[0].json.reviewSteps as IDataObject[])[2]).toEqual({ text: 'Type into Password', marks: ['secret variable password'] });
    const fields = reviewFields({ $: nodesRan(ran) });
    expect(fields[0].html).toContain('<li>Type into Password <em>· secret variable password</em></li>');
  });

  it('a step\'s variable mark comes from what it types or chooses, never from its description: on the page, in the email and in Sign steps\' rebuilt copy', async () => {
    const choose = (option: string) => ({ intent: 'Choose {{var.company_code}} in Company code', select: { field: { uia: { path: [{ name: 'Company code' }] } }, option } });
    const doc = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [choose('{{var.company_code}}')] };
    // Approved with the variable: the description says what the step does.
    expect(reviewSteps(doc.steps, { desktop: true })).toEqual([{ text: 'Choose an item in Company code', marks: ['variable company_code'] }]);
    // The value changed to a fixed 2000 on the change page, the description left as it was: no variable mark, and the
    // description shows beside the sentence as saying something else.
    const fixed = { ...doc, steps: [choose('2000')] };
    expect(reviewSteps(fixed.steps, { desktop: true })).toEqual([{ text: 'Choose "2000" in Company code', describedAs: 'Choose {{var.company_code}} in Company code', quiet: true, marks: [] }]);
    // A browser step alike.
    expect(reviewSteps([{ intent: 'Type {{var.code}} into Code', fill: { field: { label: 'Code' }, value: '2000' } }], { desktop: false, shownUrl: (u: string) => u })[0].marks).toEqual([]);
    const { ran } = changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: JSON.stringify(doc), status: 'active' }]);
    const [data, repaired] = await runImport(changedUpload(ran, JSON.stringify(fixed)), () => {
      throw new Error('desktop steps are never replayed');
    }, ran);
    expect(data[0].json.error).toBeUndefined();
    expect(repaired[0].json.reviewSteps).toEqual([{ text: 'Choose "2000" in Company code', describedAs: 'Choose {{var.company_code}} in Company code', quiet: true, marks: [] }]);
    const after = { ...ran, 'Change or sign again': [[{ json: { changedSteps: JSON.stringify(fixed) } }]], [COMPARED]: [[{ json: compared(ran, JSON.stringify(fixed)) }]], 'Import steps': [data, repaired] };
    const page = String(reviewFields({ $: nodesRan(after) })[0].html);
    expect(page).toContain('<li>Choose &quot;2000&quot; in Company code <em>(the author calls it: Choose {{var.company_code}} in Company code)</em></li>');
    expect(page).not.toContain('variable company_code');
    // Sign steps rebuilds the same sentence and marks, and signs.
    const signed = await signAfterReview(after, { decision_0: 'Approve and sign' });
    expect(signed.errors).toEqual([]);
    expect(signed.signed[0]).toMatchObject({ status: 'active', version: 2 });
    // Template 3's desktop email: from reviewSteps, and from the steps alone for an item without them.
    const t3 = load('3-approve-steps.json');
    const email = (json: IDataObject) => render(String(byName(t3, 'Ask for approval (desktop steps)').parameters.message), { $: (name: string) => ({ item: { json: name === 'Settings' ? { approvalTimeoutHours: 72 } : json } }) });
    const item = { ...repaired[0].json };
    for (const json of [item, { ...item, reviewSteps: undefined }]) {
      const text = email(json);
      expect(text).toMatch(/\n1\. Choose \S+2000\S+ in Company code/);
      expect(text).not.toContain('variable company_code');
    }
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
    expect(shown).toMatchObject({ operation: 'completion', respondWith: 'text' });
    expect(render(shown.completionTitle, { $: nodesRan({}) })).toBe('Imported');
    const [data] = await runImport(formItem('Chrome Recorder', CHROME), () => NOT_ADOPTABLE);
    const page = (message: string, ran: Record<string, INodeExecutionData[][]>) => render(message, { $: nodesRan({ Settings: [[{ json: settingsJson() }]], ...ran }) });
    const message = page(shown.completionMessage, { 'Import steps': [data, []] });
    // The fixture's report: 9 steps, one recorder step not translated, three typed values (username, password, code) removed.
    const items = (data[0].json.report as { items: { kind: string }[] }).items;
    expect(items.filter((i) => i.kind === 'untranslated')).toHaveLength(1);
    expect(items.filter((i) => i.kind === 'secret')).toHaveLength(3);
    expect(message).toContain('Imported: 9 steps; 1 not translated, 3 removed as secrets.');
    // A step list that could not be proved says why, on the page.
    expect(message).toContain(`removed as secrets.\n0 of 1 step list passed the replay. line-item-export: ${IMPORT_NOT_ADOPTABLE}\n`);
    // Only what applies: no zero counts, and a workflow that is not from a UiPath project is the bot's own.
    const first = (report: Record<string, unknown>) => page(shown.completionMessage, { 'Import steps': [[{ json: { report, drafts: [] } }], []] }).split('\n')[0];
    expect(first({ steps: 17, items: [] })).toBe('Imported: 17 steps.');
    expect(first({ steps: 1, items: [{ kind: 'secret' }] })).toBe('Imported: 1 step; 1 removed as secrets.');
    expect(first({ steps: 5, items: [{ kind: 'untranslated' }, { kind: 'untranslated' }] })).toBe('Imported: 5 steps; 2 not translated.');
    const fileLine = (report: Record<string, unknown>) => page(completion('Imported, with the workflow file').completionMessage, {
      'Import steps': [[{ json: { report, drafts: [] }, binary: { workflow: { fileName: 'bot.workflow.json', data: '', mimeType: 'application/json' } } }], []],
    }).split('\n').at(-1);
    expect(fileLine({ source: 'recording', steps: 17, items: [] })).toBe('Your browser downloads bot.workflow.json: the workflow that runs the bot. Open it in n8n with ⋯ → Import → From File.');
    expect(fileLine({ source: 'chrome', steps: 9, items: [{ kind: 'untranslated' }] })).toBe('Your browser downloads bot.workflow.json: the workflow that runs the bot. Open it in n8n with ⋯ → Import → From File.');
    expect(fileLine({ source: 'uipath', steps: 9, items: [] })).toBe('Your browser downloads bot.workflow.json: the rest of the bot as an n8n workflow. Open it in n8n with ⋯ → Import → From File.');
    expect(fileLine({ source: 'uipath', steps: 9, items: [{ kind: 'untranslated' }] }))
      .toBe('Your browser downloads bot.workflow.json: the rest of the bot as an n8n workflow. Open it in n8n with ⋯ → Import → From File; grey notes in it mark what was not translated.');
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
      'Approved and signed: erp&lt;1&gt; version 1 is now the version that runs under that name. Signed as writes: step 16 (Click Save).',
      'Approved and signed: feed version 1 is now the version that runs under that name.',
      'Rejected: other version 1. Nothing was signed.',
      'Not signed: bad version 1. Sign Steps refused: the steps do not match the hash that was reviewed.',
      'Not signed. Sign Steps needs an RPA Step Signing credential.',
    ]);
    expect(reviewed([], [], [draft({ surface: 'desktop', forApproval: true })])).toEqual(['Nothing was signed: the review page was not answered in time.']);
    // Both pages say the same about the step lists.
    const lists = (m: string) => /\{\{ \$\('Review and approve'\)\.isExecuted[\s\S]*? \}\}/.exec(m)?.[0];
    expect(lists(completion('Imported, with the workflow file').completionMessage)).toBeDefined();
    expect(lists(completion('Imported, with the workflow file').completionMessage)).toBe(lists(shown.completionMessage));
    const ifParams = byName(t, 'Workflow file?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } };
    expect(ifParams.conditions.conditions).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    // Every import with steps comes with a workflow file now, a Chrome recording's too.
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [data, []] }) })).toBe(true);
    expect(evaluate(ifParams.conditions.conditions[0].leftValue, { $: nodesRan({ 'Import steps': [[{ json: { report: {}, drafts: [] } }], []] }) })).toBe(false);
    // After the review page, the file comes only when Sign steps signed a step list: a rejected bot, or one Sign steps
    // refused (an approver not on the allowlist), gets no workflow to run, and the page does not say a file comes.
    const afterReview = (answer: IDataObject, signed?: IDataObject[], refused: IDataObject[] = []) => evaluate(ifParams.conditions.conditions[0].leftValue, {
      $: nodesRan({ 'Import steps': [data, []], [REVIEW]: [[{ json: answer }]], ...(signed ? { 'Sign steps': [signed.map((json) => ({ json })), refused.map((json) => ({ json }))] } : {}) }),
    });
    expect(afterReview({ decision_0: 'Approve and sign' }, [{ status: 'active', name: 'a', version: 1 }])).toBe(true);
    expect(afterReview({ decision_0: 'Reject', decision_1: 'Approve and sign' }, [{ status: 'rejected' }, { status: 'active' }])).toBe(true);
    expect(afterReview({ decision_0: 'Reject' }, [{ status: 'rejected' }])).toBe(false);
    expect(afterReview({ decision_0: 'Reject', decision_1: 'Reject' }, [{ status: 'rejected' }, { status: 'rejected' }])).toBe(false);
    // Approved, but Sign Steps refused: nothing was signed, so no file.
    const notOnList = { error: 'Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist', details: { name: 'owner-started', version: 1 } };
    expect(afterReview({ decision_0: 'Approve and sign' }, [], [notOnList])).toBe(false);
    expect(afterReview({ decision_0: 'Approve and sign', decision_1: 'Approve and sign' }, [{ status: 'active' }], [notOnList])).toBe(true);
    // Not answered in time: the page gives its input item on, with no decision, and Sign steps gets no step list.
    expect(afterReview({ name: 'steps table' })).toBe(false);
    expect(afterReview({ name: 'steps table' }, [])).toBe(false);
    // The page without the file never says the browser downloads one.
    expect(shown.completionMessage).not.toContain('Your browser downloads');

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
    expect(uiMessage).toContain('⋯ → Import → From File');
    expect(uiMessage).not.toContain('Import from file');
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
    const shown = render(page.completionMessage, { $json: data[0].json, $: nodesRan({}) });
    // As text: the completion page renders HTML (n8n sanitises it, and keeps a link), so the reason is escaped.
    expect(shown).toMatch(/^drift_detected: No element found for Visible Text &quot;Line Item Report&quot;\n/);
    expect(render(page.completionMessage, { $json: { error: 'config_error: <a href="https://evil.example/">x</a>' }, $: nodesRan({}) }).split('\n')[0])
      .toBe('config_error: &lt;a href=&quot;https://evil.example/&quot;&gt;x&lt;/a&gt;');
    expect(shown).toContain('\nDetails, including the import report when there is one, are in the error output of Import steps in this execution.');
  });

  /**
   * The change path as n8n's expressions see it: the first page submitted with no file and `name`, Approved bots giving
   * `rows`, then The bot to change. `authentication` is the form's sign-in as the user set it.
   */
  function changePath(name: string, rows: IDataObject[], authentication = 'n8nUserAuth', formQueryParameters?: IDataObject) {
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
  function changedUpload(ran: Record<string, INodeExecutionData[][]>, text: string): INodeExecutionData {
    expect(byName(t, 'The steps as a file')).toMatchObject({ type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, parameters: { operation: 'toText', sourceProperty: 'steps', binaryPropertyName: 'bot' } });
    const steps = String(compared(ran, text).steps);
    const file = { json: {}, binary: { bot: { data: Buffer.from(steps, 'utf8').toString('base64'), mimeType: 'text/plain', fileName: 'steps.json', bytes: Buffer.byteLength(steps) } } };
    const $ = nodesRan({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]], 'The steps as a file': [[file]] });
    const json: IDataObject = {};
    let binary: INodeExecutionData['binary'];
    for (const a of (byName(t, 'The upload').parameters.assignments as { assignments: { name: string; value: string; type: string }[] }).assignments) {
      const v = evaluate(a.value, { $ });
      if (a.type === 'binary') binary = { [a.name]: v as NonNullable<INodeExecutionData['binary']>[string] };
      else json[a.name] = v as string;
    }
    return { json, ...(binary ? { binary } : {}) };
  }

  /**
   * Sign steps' first run, before the review page: The approved version (from `ran`), then Sign steps with the parameters
   * it reads then resolved as n8n resolves them (Check Only on: the review page has not run; the parameters that read the
   * review page are never read), the key `key` and the Site Login `siteLogin` (none when not given). Returns `ran` with both.
   */
  async function checkBeforeReview(ran_: Record<string, INodeExecutionData[][]>, key: string, siteLogin?: { id: string; name: string }) {
    // Compared with the running version runs first on every path to the review page (its line only for an upload).
    const ran = { ...ran_, [RUNNING]: [[{ json: evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan(ran_) }) as IDataObject }]] };
    const $ = nodesRan(ran);
    const item = evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $ }) as IDataObject;
    const sign = byName(t, 'Sign steps').parameters;
    const params = Object.fromEntries(Object.entries(sign).flatMap(([k, v]) => {
      if (typeof v !== 'string' || !v.startsWith('=')) return [[k, v]];
      try {
        return [[k, evaluate(v, { $, $itemIndex: 0 })]];
      } catch {
        return [];
      }
    }));
    expect(params.checkOnly).toBe(true);
    const out = await executeSignSteps(harness({
      params, rawParameters: sign, items: [{ json: item }], continueOnFail: true,
      credentials: { playwrightScriptSigningApi: { secretKey: key }, ...(siteLogin ? { playwrightSiteLoginApi: siteLoginData(SITE) } : {}) },
      ...(siteLogin ? { credentialIds: { playwrightSiteLoginApi: siteLogin.id }, credentialNames: { playwrightSiteLoginApi: siteLogin.name } } : {}),
    }), importEngine(() => NOT_ADOPTABLE));
    expect(out[0]).toHaveLength(1);
    expect(out[0][0].json.checkOnly).toBe(true);
    return { ...ran, 'The approved version': [[{ json: item }]], 'Sign steps': [out[0], []] } as Record<string, INodeExecutionData[][]>;
  }
  const COMPARED = 'Compared with the approved version';
  const RUNNING = 'Compared with the running version';
  /**
   * What Compared with the approved version gives for the box submitted as `text` ('' for left empty; n8n gives null for
   * a box it did not get), from the row read in `ran`: the steps to review, and the line for the review page.
   */
  function compared(ran: Record<string, INodeExecutionData[][]>, text: string | null): { steps: string; changed: boolean; unchanged: boolean; compared: string } {
    const node = byName(t, COMPARED);
    expect(node).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const code = String(node.parameters.jsonOutput);
    // n8n cuts an expression at "}}": none inside.
    expect(code.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
    return evaluate(code, { $: nodesRan({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]] }) }) as ReturnType<typeof compared>;
  }
  /** The line Compared with the approved version gives the review page for the box submitted as `text`. */
  const compare = (ran: Record<string, INodeExecutionData[][]>, text: string | null): string => compared(ran, text).compared;

  it('Compared with the approved version: unchanged, each changed step (at most three) with its values old → new, added and missing steps, the other signed fields, or no comparison', () => {
    const doc = {
      startUrl: `${SITE.url}/a`, name: 'feed', version: 1,
      steps: Array.from({ length: 25 }, (_, i) => ({ intent: `Open page ${i + 1}`, goto: `/p${i + 1}` })) as IDataObject[],
    };
    const { ran, bot } = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(doc), status: 'active' }]);
    const box = String(bot.steps);
    const edit = (f: (d: typeof doc & IDataObject) => void) => {
      const d = JSON.parse(box) as typeof doc & IDataObject;
      f(d);
      return JSON.stringify(d, null, 2);
    };
    expect(compare(ran, box)).toBe('feed: unchanged from the approved version 4.');
    // Spacing, key order and the box's own name and version do not count: the import sets those.
    expect(compare(ran, JSON.stringify({ steps: doc.steps, version: 9, name: 'x', startUrl: doc.startUrl }))).toBe('feed: unchanged from the approved version 4.');
    expect(compare(ran, edit((d) => { d.steps[2] = { goto: '/p3', intent: 'Open page 3' }; }))).toBe('feed: unchanged from the approved version 4.');
    // What changed, not only where: the step's number and its changed values, old → new.
    expect(compare(ran, edit((d) => { d.steps[6].goto = '/other'; }))).toBe('feed: changed from the approved version 4: step 7: goto "/p7" → "/other".');
    expect(compare(ran, edit((d) => { d.steps[1].intent = 'x'; d.steps[9].goto = '/y'; }))).toBe('feed: changed from the approved version 4: step 2: intent "Open page 2" → "x"; step 10: goto "/p10" → "/y".');
    // A field added or taken away shows (none) on its other side; two fields of one step are listed together.
    expect(compare(ran, edit((d) => { (d.steps[0] as IDataObject).waitFor = 3; d.steps[0].goto = '/a'; }))).toBe('feed: changed from the approved version 4: step 1: goto "/p1" → "/a", waitFor (none) → 3.');
    // More than three fields of one step: "several fields". More than three steps: three, then the others by number.
    expect(compare(ran, edit((d) => { d.steps[3] = { intent: 'a', goto: '/b', fill: { selector: '#c', value: 'd' } } as typeof d.steps[0]; })))
      .toBe('feed: changed from the approved version 4: step 4: several fields.');
    expect(compare(ran, edit((d) => { for (const i of [2, 4, 6, 8, 10]) d.steps[i].goto = `/n${i}`; })))
      .toBe('feed: changed from the approved version 4: step 3: goto "/p3" → "/n2"; step 5: goto "/p5" → "/n4"; step 7: goto "/p7" → "/n6"; and more: steps 9, 11.');
    // Added at the end, and one taken out in the middle (every later step moves up).
    expect(compare(ran, edit((d) => { d.steps.push({ intent: 'Open more', goto: '/more' }); }))).toBe('feed: changed from the approved version 4: step 26: added. 26 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(22, 1); })))
      .toBe('feed: changed from the approved version 4: step 23: intent "Open page 23" → "Open page 24", goto "/p23" → "/p24"; step 24: intent "Open page 24" → "Open page 25", goto "/p24" → "/p25"; step 25: removed. 24 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(0, 1); })))
      .toBe(`feed: changed from the approved version 4: step 1: intent "Open page 1" → "Open page 2", goto "/p1" → "/p2"; step 2: intent "Open page 2" → "Open page 3", goto "/p2" → "/p3"; step 3: intent "Open page 3" → "Open page 4", goto "/p3" → "/p4"; and more: steps ${Array.from({ length: 20 }, (_, i) => i + 4).join(', ')}, …. 24 steps now, 25 in the approved version.`);
    // A value is shown on one line, cut at 60 characters; markup stays text (the page escapes the line, as everything
    // else); a secret variable is shown as written, by its name: no secret is in the steps.
    const long = `${'a'.repeat(70)}\nsecond line`;
    expect(compare(ran, edit((d) => { d.steps[4].intent = long; }))).toBe(`feed: changed from the approved version 4: step 5: intent "Open page 5" → "${'a'.repeat(59)}…".`);
    expect(compare(ran, edit((d) => { d.steps[4].intent = 'two\nlines\there'; }))).toBe('feed: changed from the approved version 4: step 5: intent "Open page 5" → "two lines here".');
    expect(compare(ran, edit((d) => { d.steps[4].goto = '<b>x</b> & "y"'; }))).toBe('feed: changed from the approved version 4: step 5: goto "/p5" → "<b>x</b> & "y"".');
    expect(compare(ran, edit((d) => { (d.steps[4] as IDataObject).fill = { selector: '#pin', value: '{{var.pin}}' }; })))
      .toBe('feed: changed from the approved version 4: step 5: selector (none) → "#pin", value (none) → "{{var.pin}}".');
    // The other fields the box can change and the signature covers: the start site, the pop-up handlers, the app.
    expect(compare(ran, edit((d) => { d.startUrl = 'https://elsewhere.example.com/'; }))).toBe('feed: changed from the approved version 4: the start site.');
    expect(compare(ran, edit((d) => { d.interrupts = [{ when: { text: 'Session' }, click: 'OK' }]; d.steps[0].goto = '/z'; }))).toBe('feed: changed from the approved version 4: step 1: goto "/p1" → "/z"; the pop-up handlers.');
    const desktop = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { uia: { path: [{ name: 'Save' }] } } }] };
    const d = changePath('erp', [{ id: 2, name: 'erp', version: 2, steps: JSON.stringify(desktop), status: 'active' }]);
    expect(compare(d.ran, JSON.stringify({ ...desktop, app: { exe: 'Other.exe' } }))).toBe('erp: changed from the approved version 2: the app.');
    expect(compare(d.ran, JSON.stringify({ ...desktop, surface: undefined, startUrl: 'https://x.example.com/' }))).toBe('erp: changed from the approved version 2: the start site, browser or desktop.');
    // No comparison: the stored steps do not parse, the box does not parse, or nothing was found.
    // It names the list and never says unchanged.
    expect(compare(changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: '{broken', status: 'active' }]).ran, '{"steps":[]}')).toBe('erp: could not be compared with the approved version 1: read every step.');
    expect(compare(ran, '{ not json')).toBe('feed: could not be compared with the approved version 4: read every step.');
    expect(compare(ran, '{"startUrl":"https://a.example.com"}')).toBe('feed: could not be compared with the approved version 4: read every step.');
    expect(compare(changePath('gone', []).ran, box)).toBe('gone: could not be compared with the approved version: read every step.');
  });

  it('an address that carries values for the form\'s fields is refused before anything is read, imported, shown or signed; a plain address goes through', () => {
    // n8n 2.45 keeps the first page's query as the trigger's formQueryParameters, only when it has a key (Form
    // utils.ts 574-579), and fills the fields of every later page from it (utils.ts 634-648 and 337): the review page's
    // decision and write ticks, the steps box. A later page's own ?signature= never gets there.
    const cond = (byName(t, 'Plain address?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(cond).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    const plain = (query?: unknown) => evaluate(cond[0].leftValue, { $json: { ...formItem('Chrome Recorder', CHROME).json, ...(query === undefined ? {} : { formQueryParameters: query }) } });
    expect(plain()).toBe(true);
    expect(plain({})).toBe(true);
    expect(plain('')).toBe(true);
    // The two keys n8n adds itself when it shows a form inside its connect-accounts frame.
    expect(plain({ n8nShellInner: '1' })).toBe(true);
    expect(plain({ n8nShellHosted: '1', n8nShellInner: '1' })).toBe(true);
    const doc = { startUrl: `${SITE.url}/a`, name: 'feed', version: 1, steps: [{ intent: 'Open the report', goto: '/report' }] };
    const planted = JSON.stringify({ ...doc, steps: [{ intent: 'Open the report', goto: 'https://elsewhere.example.com/' }] });
    for (const query of [{ decision_0: 'Approve and sign' }, { writes_0: 'Step 16: Click Save' }, { steps: planted }, { name: 'feed' }, { utm_source: 'mail' }, { n8nShellInner: '1', decision_0: 'Approve and sign' }, 'x']) {
      expect(plain(query), JSON.stringify(query)).toBe(false);
    }
    // Refused: one last page, and nothing after it. Settings, and everything that reads, imports or signs, comes after
    // the true output only.
    const after = (from: string): Set<string> => {
      const seen = new Set<string>();
      const walk = (n: string) => targets(t, n).flat().forEach((m) => (seen.has(m) ? undefined : (seen.add(m), walk(m))));
      walk(from);
      return seen;
    };
    expect(targets(t, 'Address with values')).toEqual([]);
    expect([...after('Import a bot')].sort()).toEqual([...new Set(['Plain address?', 'Address with values', 'Settings', ...after('Settings')])].sort());
    for (const n of ['Settings', 'Approved bots', 'Import steps', REVIEW, 'Sign steps']) expect(after('Address with values').has(n), n).toBe(false);
    const page = completion('Address with values');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Open the form by its plain address' });
    expect(page.completionMessage).toBe("This address carries values for the form's fields. Open the form by its plain address: the address up to the question mark.\nNothing was imported, shown or signed.");
    // Steps that reach the box another way (a slip of the hand) while the person meant to change nothing: the review
    // page says they changed, and where.
    const rows = [{ id: 1, name: 'feed', version: 1, steps: JSON.stringify(doc), status: 'active' }];
    expect(compare(changePath('feed', rows).ran, planted)).toBe('feed: changed from the approved version 1: step 1: goto "/report" → "https://elsewhere.example.com/".');
  });

  it('template 3 has no form that n8n fills from an address, and template 2 has no form', () => {
    // Send-and-wait renders its custom form with an empty query (n8n 2.45 utils/sendAndWait/utils.ts 392 and 460), and
    // its Approve and Reject links are signed resume links. Template 2 has no form node at all.
    const t3 = load('3-approve-steps.json');
    expect(t3.nodes.filter((n) => /\.form(Trigger)?$/.test(n.type))).toEqual([]);
    expect(t3.nodes.filter((n) => n.parameters.operation === 'sendAndWait').map((n) => n.type)).toEqual(['n8n-nodes-base.emailSend', 'n8n-nodes-base.emailSend']);
    expect(load('2-data-feed.json').nodes.filter((n) => /form/i.test(n.type) || n.parameters.operation === 'sendAndWait')).toEqual([]);
  });

  it('the first page with no file leads to an approved bot by its name; with a file, the import goes on as before', () => {
    const cond = (byName(t, 'Change an approved bot?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(cond).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    const change = (item: IDataObject) => evaluate(cond[0].leftValue, { $: () => ({ first: () => item }) });
    expect(change({ json: { name: 'erp' } })).toBe(true);
    expect(change({ json: { name: 'erp' }, binary: {} })).toBe(true);
    expect(change({ json: { name: 'erp' }, binary: { bot: { fileName: 'export.json' } } })).toBe(false);
    // A first-time import meets no new field and no new page: with its file it takes the import path, unchanged.
    expect(change(formItem('Chrome Recorder', CHROME) as unknown as IDataObject)).toBe(false);
    expect(byName(t, 'Change an approved bot?').position[1]).toBe(byName(t, 'Asks about a download?').position[1]);
    // Every row this workflow may read (the active ones are the approved bots; every row of a name gives its next version
    // number); no row (an empty item) finds nothing. The table was made first (Create steps table), so the read never
    // gives an error item: n8n 2.45 cannot read one in an expression.
    const get = byName(t, 'Approved bots');
    expect(get).toMatchObject({ type: DATA_TABLE, typeVersion: 1.1, alwaysOutputData: true });
    expect(get).not.toHaveProperty('onError');
    expect(table(get)).toEqual({ resource: 'row', operation: 'get', dataTableId: { __rl: true, mode: 'name', value: STEPS_TABLE }, returnAll: true });
    expect(byName(t, 'The bot to change')).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
  });

  it('The bot to change: the newest active row of exactly that name, its steps as the table holds them; none found names the approved bots', () => {
    const doc = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { name: 'Save' } }] };
    const rows: IDataObject[] = [
      { id: 1, name: 'erp', version: 1, steps: '{"old":true}', status: 'active' },
      { id: 2, name: 'erp', version: 3, steps: JSON.stringify(doc), status: 'active' },
      { id: 4, name: 'other<b>', version: 1, steps: '{}', status: 'active' },
      { id: 5, name: 'erp', version: 9, steps: '', status: 'active' },
      { error: 'The Data Table playwright_steps does not exist' }, {},
    ];
    // next: one more than the highest version any row of the name has (an active row without steps counts too).
    const found = { name: 'erp', found: true, version: 3, steps: JSON.stringify(doc), signature: '', approvedBy: '', names: ['erp', 'other<b>'], next: 10 };
    expect(changePath('erp', rows).bot).toEqual(found);
    expect(changePath('  erp ', rows).bot).toEqual(found);
    // Exactly the name: another casing is another bot.
    expect(changePath('ERP', rows).bot).toEqual({ name: 'ERP', found: false, version: null, steps: '', signature: '', approvedBy: '', names: ['erp', 'other<b>'], next: 1 });
    // A rejected or superseded row is not a running version, but its number is used: the next attempt takes the one after
    // the highest of them, so the table never holds two rows of one name and version.
    const used: IDataObject[] = [
      { id: 1, name: 'erp', version: 2, steps: '{}', status: 'superseded' }, { id: 2, name: 'erp', version: 3, steps: JSON.stringify(doc), status: 'active' },
      { id: 3, name: 'erp', version: 4, steps: '', status: 'rejected' }, { id: 4, name: 'erp', version: 5, steps: '', status: 'rejected' }, { id: 5, name: 'erp-1', version: 7, steps: '', status: 'rejected' },
    ];
    expect(changePath('erp', used).bot).toMatchObject({ found: true, version: 3, next: 6, names: ['erp'] });
    // A row whose steps are not JSON is shown as it is: Import steps then says what is wrong with it.
    expect(changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: '{broken', status: 'active' }]).bot).toMatchObject({ found: true, steps: '{broken' });
    // No row (the table was made first: there is never an error item to read).
    expect(changePath('erp', []).bot).toEqual({ name: 'erp', found: false, version: null, steps: '', signature: '', approvedBy: '', names: [], next: 1 });
    // The row's signature and approver come along for Sign steps' check, as the table holds them (never shown on a page).
    expect(changePath('erp', [{ id: 2, name: 'erp', version: 3, steps: '{}', signature: 'ab12', approvedBy: 'approver@example.com', status: 'active' }]).bot)
      .toMatchObject({ found: true, signature: 'ab12', approvedBy: 'approver@example.com' });
    expect(changePath('erp', [{}]).bot).toMatchObject({ found: false, names: [] });
    const foundCond = (byName(t, 'Approved bot found?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect([found, { found: false }, {}].map(($json) => evaluate(foundCond, { $json }))).toEqual([true, false, false]);

    // None of that name: a last page names the approved bots, escaped, and how to import instead; none at all says so.
    const none = completion('No approved bot');
    expect(none).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'No approved bot of that name' });
    expect(byName(t, 'No approved bot').parameters).toMatchObject({ limitWaitTime: true, resumeAmount: 1, resumeUnit: 'hours' });
    expect(render(none.completionMessage, { $: changePath('ERP', rows).$ })).toBe('No approved bot is named ERP. The approved bots: erp, other&lt;b&gt;.\n'
      + 'To import a bot, open the form again and upload its file. To change an approved bot or sign it again, open the form again, leave Bot file empty and type its name.');
    expect(render(none.completionMessage, { $: changePath('erp', []).$ }).split('\n')[0]).toBe('No bot has been approved yet.');
  });

  it('the workflow file is handed over after approval on this form: Import steps says so, so its notes do not ask to approve again', () => {
    const upload = formItem('RPA recording', Buffer.from('{}'));
    const on = (approval: string) => resolved(upload, { Settings: [[{ json: { ...upload.json, ...settingsJson(), approval } }]] }).options as IDataObject;
    expect(on('on this form').approvedBeforeHandOver).toBe(true);
    // By email the form hands the file over before anyone approved (template 3 approves later).
    expect(on('by email').approvedBeforeHandOver).toBe(false);
  });

  it('Change or sign again shows the active steps to read in a block of the page, one empty box, and five short sentences', () => {
    const doc = { startUrl: `${SITE.url}/a`, name: 'feed <b>', version: 1, steps: [{ intent: 'Type $& and $$ <b>Tom & Jerry</b> café', goto: '/b?x=$1&y=<2>' }] };
    const page = byName(t, 'Change or sign again');
    expect(page).toMatchObject({ type: COMPLETION, typeVersion: 2.5, parameters: { operation: 'page', defineForm: 'json', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours', options: { buttonLabel: 'Review', formDescription: 'Nothing changes until you approve on the next page.' } } });
    const rows = [{ id: 3, name: 'feed <b>', version: 1, steps: JSON.stringify(doc), status: 'active' }];
    // With n8n's sign-in, a later page needs a signed-in n8n user; with Basic Auth (or none) it needs only its address.
    const ANYONE = 'Anyone who has the address of this page can read these steps, so do not share it.';
    for (const [auth, who] of [['n8nUserAuth', 'Any signed-in n8n user who has the address of this page can read these steps, so do not share it.'], ['basicAuth', ANYONE], ['none', ANYONE]]) {
      const { $ } = changePath('feed <b>', rows, auth);
      // jsonFormFields also checks that no "$" reaches n8n's String.replace, so "$&" in a step stays as written.
      const fields = jsonFormFields(String(page.parameters.jsonOutput), { $ });
      expect(fields.map((f) => f.fieldType)).toEqual(['html', 'textarea']);
      // The box is empty and optional: the approved steps never go to the browser and come back through it. n8n escapes
      // < and > in every field's text but html (n8n-workflow type-validation.ts tryToParseJsonToFormFields), so a
      // default value would come back changed.
      expect(fields[1]).toEqual({ fieldLabel: 'Changed steps (JSON). Leave empty to sign the steps again as they are.', fieldName: 'changedSteps', fieldType: 'textarea', requiredField: false });
      const html = String(fields[0].html);
      // The steps in a <pre> (n8n's sanitizer keeps pre and code, Form utils.ts sanitizeHtml), escaped once: the page
      // shows, and a person copies, the real text.
      const pre = /<pre>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? '';
      expect(pre).toBe(escapeHtml(JSON.stringify(doc, null, 2)));
      const unescaped = pre.replace(/&(amp|lt|gt|quot|#39);/g, (_, x: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[x] ?? '');
      expect(JSON.parse(unescaped)).toEqual(doc);
      // Five sentences: the description and four on the page, nothing else.
      expect(html.replace(/<pre>[\s\S]*<\/pre>/, '<pre/>')).toBe('<p>These are the steps that run now as <b>feed &lt;b&gt;</b> (version 1).</p><pre/>'
        + '<p>Leave the box empty to sign them again, or paste changed steps.</p>'
        + '<p><em>This form cannot tell steps signed with an older key from steps changed in the table, so read every step on the next page.</em></p>'
        + `<p><em>${who}</em></p>`);
      expect(render(String((page.parameters.options as IDataObject).formTitle), { $ })).toBe('Change or sign again: feed <b>');
    }
    // The block scrolls at a sensible height and one click selects it all.
    expect(String((page.parameters.options as IDataObject).customCss)).toMatch(/div\.html pre \{ max-height: 24em; overflow: auto;[^}]*user-select: all;/);
    // Long lines wrap inside the block (a desktop step's window name is longer than the page is wide): no sideways scroll.
    expect(String((page.parameters.options as IDataObject).customCss)).toMatch(/div\.html pre \{[^}]*white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;/);
    expect(String((page.parameters.options as IDataObject).customCss)).not.toMatch(/white-space: pre;/);
    // A row whose steps are not JSON is shown as it is.
    const broken = jsonFormFields(String(page.parameters.jsonOutput), { $: changePath('x', [{ id: 1, name: 'x', version: 2, steps: '{broken <', status: 'active' }]).$ });
    expect(String(broken[0].html)).toContain('<pre>{broken &lt;</pre>');
  });

  it('an empty box signs the table\'s own steps byte for byte; a pasted text is the change; text that does not parse changes nothing', async () => {
    const doc = {
      surface: 'desktop', name: 'erp', version: 3, app: { exe: 'ErpDemo.exe' },
      steps: [{ intent: 'Type <b>Tom & Jerry</b> $5 $HOME $& in Note', fill: { field: { uia: { path: [{ name: 'Note' }] } }, value: '<b>Tom & Jerry</b> café $5 $HOME $& \\ "q"' } }],
    };
    // As the table holds it (another spacing than JSON.stringify gives, on purpose).
    const stored = JSON.stringify(doc, null, 1);
    const { ran } = changePath('erp', [{ id: 4, name: 'erp', version: 3, steps: stored, status: 'active' }]);
    // Left empty (or blank): the steps to review are the row's text exactly as read, the box's text never.
    for (const empty of ['', '  \r\n ', null]) {
      expect(compared(ran, empty)).toEqual({ steps: stored, changed: false, unchanged: true, compared: 'erp: unchanged from the approved version 3.' });
    }
    const upload = changedUpload(ran, '');
    expect(Buffer.from(String(upload.binary?.bot.data), 'base64').equals(Buffer.from(stored, 'utf8'))).toBe(true);
    const never = () => {
      throw new Error('desktop steps are never replayed');
    };
    const [data, repaired] = await runImport(upload, never, ran);
    expect(data[0].json.error).toBeUndefined();
    // Imported as the next version, every step as stored: <, >, &, $, a backslash, a quote and é included.
    expect(repaired[0].json).toMatchObject({ name: 'erp', version: 4 });
    expect(repaired[0].json.steps).toEqual({ ...doc, version: 4 });
    // Pasted: the text is the new step document, compared with the row and named on the review page. A browser sends a
    // line break in a box as CR LF (multipart form data); n8n hands on the rest as typed (Form utils.ts
    // addFormResponseDataToReturnItem: a textarea is neither trimmed nor escaped).
    const pasted = JSON.stringify({ ...doc, steps: [{ ...doc.steps[0], fill: { ...doc.steps[0].fill, value: '<i>2000</i> & $1' } }] }, null, 2).replace(/\n/g, '\r\n');
    expect(compared(ran, pasted)).toEqual({ steps: pasted, changed: true, unchanged: false, compared: 'erp: changed from the approved version 3: step 1: value "<b>Tom & Jerry</b> café $5 $HOME $& \\ "q"" → "<i>2000</i> & $1".' });
    expect(compared(ran, JSON.stringify(doc))).toMatchObject({ changed: true, unchanged: true, compared: 'erp: unchanged from the approved version 3.' });
    const [changed, changedOut] = await runImport(changedUpload(ran, pasted), never, ran);
    expect(changed[0].json.error).toBeUndefined();
    expect((changedOut[0].json.steps as { steps: { fill: { value: string } }[] }).steps[0].fill.value).toBe('<i>2000</i> & $1');
    // Text that does not parse: Import steps refuses it on its error output, and the page after it says so and that the
    // approved version keeps running. Nothing reaches the review page or Sign steps.
    expect(compare(ran, '{ "steps": [ <oops')).toBe('erp: could not be compared with the approved version 3: read every step.');
    // (n8n moves an item with an error to the error output: onError continueErrorOutput.)
    const [failed, none] = await runImport(changedUpload(ran, '{ "steps": [ <oops'), never, ran);
    expect(none).toEqual([]);
    expect(String(failed[0].json.error)).toContain('the step document is not valid JSON');
    expect(targets(t, 'Missing login page?')[1]).toEqual(['Import failed']);
    const page = render(completion('Import failed').completionMessage, { $json: failed[0].json, $: nodesRan({ ...ran, 'Change or sign again': [[{ json: { changedSteps: '{ "steps": [ <oops' } }]] }) });
    expect(page.split('\n').slice(1)).toEqual(['Nothing changed: erp version 3 keeps running.', 'Details, including the import report when there is one, are in the error output of Import steps in this execution.']);
    // An ordinary import's failure page says nothing about a bot that keeps running.
    expect(render(completion('Import failed').completionMessage, { $json: failed[0].json, $: nodesRan({}) }).split('\n')).toHaveLength(2);
  });

  it('sign again: the same steps are reviewed and become a new row under the current key that supersedes the old one; a change is signed as changed; a rejected change leaves the old version running', async () => {
    const OLD_KEY = 'o'.repeat(32);
    const NEW_KEY = 'n'.repeat(32);
    // The bot as it was approved and saved, under the old key.
    const { ran: first } = await importedRecording();
    const old = (await signAfterReview(first, { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, OLD_KEY)).signed[0];
    const oldRow: IDataObject = { id: 7, name: old.name, version: old.version, steps: old.steps, hash: old.hash, signature: old.signature, approvedBy: old.approvedBy, approvedAt: old.approvedAt, status: 'active' };
    const trust = (steps: unknown, signature: unknown, key: string) => checkDesktopTrust(JSON.parse(String(steps)), { required: true, signature: String(signature), approvedBy: APPROVER, key });
    expect(trust(oldRow.steps, oldRow.signature, OLD_KEY)).toEqual({ ok: true, signed: true });
    // The key changed: the row no longer runs. To the new key it looks exactly like a row changed in the table.
    expect(trust(oldRow.steps, oldRow.signature, NEW_KEY)).toMatchObject({ ok: false });

    const { bot, ran } = changePath(String(old.name), [oldRow, { id: 3, name: 'other', version: 1, steps: '{}', status: 'active' }]);
    expect(bot).toMatchObject({ found: true, version: 1 });
    // What a person copies from the page's block of steps: the text as the page shows it (one escape undone).
    const shownHtml = String(jsonFormFields(String(byName(t, 'Change or sign again').parameters.jsonOutput), { $: changePath(String(old.name), [oldRow]).$ })[0].html);
    const box = (/<pre>([\s\S]*)<\/pre>/.exec(shownHtml)?.[1] ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, x: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[x] ?? '');
    expect(JSON.parse(box)).toEqual(JSON.parse(String(old.steps)));
    const never = () => {
      throw new Error('desktop steps are never replayed');
    };
    /** Submits the box with `text` ('' for left empty): Import steps, the review page, then Sign steps under the new key with `answer`. */
    const review = async (text: string, answer: IDataObject, by: IDataObject = signedIn(APPROVER)) => {
      const upload = changedUpload(ran, text);
      expect(upload.json).toMatchObject({ name: old.name, source: 'Step document', expectedFileName: '', columns: '' });
      // The next version: the approved one plus one, from The bot to change (the active row), never from the box.
      expect(resolved(upload, ran)).toMatchObject({ source: 'steps', inputFrom: 'binary', binaryPropertyName: 'bot', stepsName: old.name, options: { version: 2 } });
      const [data, repaired] = await runImport(upload, never, ran);
      expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 600)).toBeUndefined();
      expect(repaired).toHaveLength(1);
      const line = compared(ran, text);
      // Sign steps checks the approved version first, with the new key: signed with the old one, it does not fit.
      const after = await checkBeforeReview({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]], [COMPARED]: [[{ json: line }]], 'Import steps': [data, repaired] }, NEW_KEY);
      expect(after['Sign steps'][0][0].json).toEqual({ checkOnly: true, siteLogin: null, approvedVersion: { version: 1, desktop: true, signatureFits: false } });
      // The review page of an import, with its opening lines on top: how these steps relate to the approved version, what
      // a desktop signature binds, and the warning. Desktop steps bind no Site Login, so it names the key, and, as for
      // browser steps, a row changed after approval: the page cannot tell the two apart and says to read every step.
      const all = jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan(after) });
      expect(all[0]).toEqual({
        fieldType: 'html',
        html: `<p><b>${escapeHtml(line.compared)}</b></p><p>Desktop steps are signed for the app they start, without a Site Login.</p>`
          + "<p><strong>⚠ Version 1 does not fit this form: it was signed with another signing key, or its row was changed after it was approved. This page cannot tell which. Read every step before you approve: approving signs the steps shown here with this form's key, which is the way back after a new signing key.</strong></p>",
      });
      const fields = all.slice(1);
      // Its first sentence stands again directly above the Decision, as for browser steps.
      expect(fields.map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'writes_0', 'html', 'moreWrites_0', 'html', 'decision_0']);
      expect(fields[4].html).toBe('<p><strong>⚠ Version 1 does not fit this form: it was signed with another signing key, or its row was changed after it was approved. The warning at the top says what to do.</strong></p>');
      // Every step list is the same without the line: an ordinary import shows none.
      expect(jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan({ ...after, [COMPARED]: undefined as never }) }).slice(1)).toEqual(fields);
      const signed = await signAfterReview(after, answer, {}, false, by, undefined, NEW_KEY);
      return { after, fields, ...signed };
    };

    // Sign again: the box left empty. The steps are the active row's, as read from the table.
    const again = await review('', { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' });
    expect(compare(ran, '')).toBe(`${String(old.name)}: unchanged from the approved version 1.`);
    // Pasting the copied block back is the same steps: the review page says so too.
    expect(compare(ran, box)).toBe(`${String(old.name)}: unchanged from the approved version 1.`);
    expect(again.fields[1].defaultValue).toBe('Step 16: Click Save');
    expect(again.errors).toEqual([]);
    const fresh = again.signed[0];
    /** The last page after the review page was answered with `answer`, and what Sign steps gave. */
    const lastPage = (r: { after: Record<string, INodeExecutionData[][]>; signed: IDataObject[]; errors: IDataObject[] }, answer: IDataObject = { decision_0: 'Approve and sign' }) => {
      const $ = nodesRan({ ...r.after, [REVIEW]: [[{ json: answer }]], 'Sign steps': [r.signed.map((json) => ({ json })), r.errors.map((json) => ({ json }))] });
      return { title: render(completion('Imported').completionTitle, { $ }), text: render(completion('Imported').completionMessage, { $ }) };
    };
    // It says what happened to the bot, in those words: never "Imported: 17 steps.", never a report to look for.
    expect(lastPage(again)).toEqual({ title: 'Change or sign again', text: `Signed again: ${String(old.name)} version 2, unchanged. Signed as writes: step 16 (Click Save).` });
    // Signed again with unchanged steps: a new approval, so the next version, and the steps as they were apart from it.
    expect(fresh).toMatchObject({ status: 'active', name: old.name, version: 2, approvedBy: APPROVER, writeLine: 'Signed as writes: step 16 (Click Save)' });
    expect({ ...JSON.parse(String(fresh.steps)), version: 1 }).toEqual(JSON.parse(String(old.steps)));
    expect(JSON.parse(String(fresh.steps)).version).toBe(2);
    // The review page names it, and what it replaces; the item it shows is the item Sign steps signed.
    const title = evaluate(String((byName(t, REVIEW).parameters.options as IDataObject).formTitle), { $: nodesRan(again.after) });
    expect(title).toBe(`${old.name}, version 2, replacing version 1`);
    expect(again.lists[0]).toMatchObject({ version: 2, baseVersion: null });
    expect(fresh.signature).not.toBe(old.signature);
    expect(trust(fresh.steps, fresh.signature, NEW_KEY)).toEqual({ ok: true, signed: true });
    // Saved as a new row, Supersede older versions turns the old row (and only it) superseded.
    const newRow = { ...fresh, id: 8 };
    const supersede = table(byName(t, 'Supersede older versions')).filters!.conditions;
    const lists = again.lists;
    const matches = (row: IDataObject) => supersede.every((c) => {
      const want = typeof c.keyValue === 'string' && c.keyValue.startsWith('=') ? evaluate(c.keyValue, { $json: newRow, $: () => ({ item: { json: lists[0] } }) }) : c.keyValue;
      const have = row[c.keyName];
      return c.condition === 'eq' ? have === want : c.condition === 'neq' ? have !== want : Number(have) <= Number(want);
    });
    expect(matches(oldRow)).toBe(true);
    expect(matches(newRow)).toBe(false);
    expect(matches({ ...oldRow, id: 3, name: 'other' })).toBe(false);
    // The last page gives no workflow file: the bot's workflow exists already.
    const fileCond = (byName(t, 'Workflow file?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const withReview = { ...again.after, [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [[{ json: { status: 'active' } }], []] };
    expect(evaluate(fileCond, { $: nodesRan(withReview) })).toBe(false);
    const importOnly = Object.fromEntries(Object.entries(withReview).filter(([k]) => k !== 'Change or sign again'));
    expect(evaluate(fileCond, { $: nodesRan(importOnly) })).toBe(true);

    // A change: the company code typed in step 6. The review page shows the new value; the signed steps hold it.
    expect(box).toContain('"2000"');
    const changed = await review(box.replace('"2000"', '"3000"'), { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' });
    expect(compare(ran, box.replace('"2000"', '"3000"'))).toBe(`${String(old.name)}: changed from the approved version 1: step 6: option "2000" → "3000".`);
    expect(String(changed.fields[0].html)).toContain('<li>Choose &quot;3000&quot; in Company code</li>');
    expect(changed.signed[0]).toMatchObject({ status: 'active', name: old.name });
    expect(String(changed.signed[0].steps)).toContain('"3000"');
    expect(trust(changed.signed[0].steps, changed.signed[0].signature, NEW_KEY)).toEqual({ ok: true, signed: true });
    // W5: a change approved on the form is version 2 everywhere: the review page's title, Sign steps' record, the steps it
    // signed, the row Save signed steps writes, and the last page.
    expect(evaluate(String((byName(t, REVIEW).parameters.options as IDataObject).formTitle), { $: nodesRan(changed.after) })).toBe(`${String(old.name)}, version 2, replacing version 1`);
    expect(changed.signed[0].version).toBe(2);
    expect(JSON.parse(String(changed.signed[0].steps)).version).toBe(2);
    const saved = table(byName(t, 'Save signed steps')).columns!.value;
    expect(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $json: changed.signed[0] }) : v]))).toMatchObject({ name: old.name, version: 2, status: 'active' });
    expect(lastPage(changed).text).toBe(`Changed: ${String(old.name)} version 2 is now the version that runs, replacing version 1. Signed as writes: step 16 (Click Save).`);

    // A rejected change: a rejected row, no steps, no signature. Only Save signed steps leads to Supersede older versions,
    // so the old row stays active and keeps running (under the key it was signed with).
    const rejected = await review(box.replace('"2000"', '"3000"'), { writes_0: [], decision_0: 'Reject' });
    expect(rejected.signed).toEqual([expect.objectContaining({ status: 'rejected', steps: '', signature: '' })]);
    // The last page does not say that a version was rejected that keeps running.
    expect(lastPage(rejected, { decision_0: 'Reject' }).text).toBe(`Nothing changed: ${String(old.name)} version 1 keeps running.`);
    // Sign steps refused (an approver not on the list), or the review page not answered: the old version keeps running too.
    const refused = await review('', { writes_0: [], decision_0: 'Approve and sign' }, signedIn('member@example.com'));
    expect(lastPage(refused).text.split('\n')).toEqual([
      `Not signed: ${String(old.name)} version 2. Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist. Ask the person who set up this form to approve it, or to put you on its Approver Allowlist.`,
      `Nothing changed: ${String(old.name)} version 1 keeps running.`,
    ]);
    expect(lastPage({ after: rejected.after, signed: [], errors: [] }, { name: 'steps table' }).text.split('\n')).toEqual([
      'Nothing was signed: the review page was not answered in time.', `Nothing changed: ${String(old.name)} version 1 keeps running.`,
    ]);
    expect(targets(t, 'Signed?')).toEqual([['Save signed steps'], ['Record rejection']]);
    expect(targets(t, 'Record rejection')).toEqual([]);
  });

  it('the review page names the Site Login Sign steps signs for; on a change or sign again, a warning when the approved version does not fit its key and Site Login', async () => {
    const KEY = 'k'.repeat(32);
    const doc = { startUrl: `${SITE.url}/list`, name: 'feed', version: 4, steps: [{ intent: 'Open the list', goto: `${SITE.url}/list` }] };
    /** The active row of `doc` as Sign Steps saved it: signed with `key` for the Site Login id `siteLoginId` (none when not given). */
    const row = (key: string, siteLoginId?: string): IDataObject => ({
      id: 9, name: 'feed', version: 4, steps: JSON.stringify(doc), signature: signScript(doc, key, { approvedBy: APPROVER, ...(siteLoginId ? { siteLoginId } : {}) }).signature,
      approvedBy: APPROVER, status: 'active',
    });
    /** The Repaired steps item of the next version, as the review page lists it. */
    const next = (surface?: string) => ({ json: { name: 'feed', version: 5, baseVersion: null, steps: { ...doc, version: 5, ...(surface ? { surface } : {}) }, reviewSteps: [], safetyFlags: [] } });
    const checked = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => {
      const { ran } = changePath('feed', [r]);
      return checkBeforeReview({ ...ran, 'Change or sign again': [[{ json: { changedSteps: '' } }]], [COMPARED]: [[{ json: compared(ran, '') }]], 'Import steps': [[{ json: {} }], [next()]] }, key, siteLogin);
    };
    const head = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => reviewHead({ $: nodesRan(await checked(r, key, siteLogin)) });
    /** The page's fields after its opening lines. */
    const fieldsOf = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => reviewFields({ $: nodesRan(await checked(r, key, siteLogin)) });
    const SHOP = { id: 'site-a', name: 'Shop <login>' };
    const UNCHANGED = '<p><b>feed: unchanged from the approved version 4.</b></p>';
    // The name in quotes: n8n's default credential name, "RPA Site Login account", does not read doubled.
    const NAMED = '<p>Signs for the Site Login named "<b>Shop &lt;login&gt;</b>". The workflow that runs the bot must use this Site Login.</p>';
    // Signed with this key for this Site Login: the line names it, and nothing more is said.
    expect(await head(row(KEY, SHOP.id), KEY, SHOP)).toBe(UNCHANGED + NAMED);
    // Signed for another Site Login (the many-accounts one): the warning leads with what the person can check, this
    // form's Site Login, not with keys; then the two causes' advice, shortest first. Its first sentence stands again
    // directly above the Decision.
    const FIT = '⚠ Version 4 does not fit this form: it was signed for another Site Login than "Shop &lt;login&gt;", or with another signing key, or its row was changed after it was approved.';
    const READ = "This page cannot tell which. Read every step before you approve: approving signs the steps shown here with this form's key, which is the way back after a new signing key.";
    const WARNING = `<p><strong>${FIT} ${READ} If the bot's workflow uses another Site Login, a version approved here will not run there: put that Site Login on Import steps and Sign steps first.</strong></p>`;
    expect(await head(row(KEY, 'site-b'), KEY, SHOP)).toBe(UNCHANGED + NAMED + WARNING);
    expect((await fieldsOf(row(KEY, 'site-b'), KEY, SHOP)).map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'html', 'decision_0']);
    expect((await fieldsOf(row(KEY, 'site-b'), KEY, SHOP))[1].html).toBe(`<p><strong>${FIT} The warning at the top says what to do.</strong></p>`);
    // It fits: no line above the Decision either.
    expect((await fieldsOf(row(KEY, SHOP.id), KEY, SHOP)).map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'decision_0']);
    // Signed with another key: the same warning (the row alone cannot tell the two apart), and it does not refuse.
    expect(await head(row('o'.repeat(32), SHOP.id), KEY, SHOP)).toBe(UNCHANGED + NAMED + WARNING);
    // No Site Login on Sign steps: the line says so, and a version signed for one does not fit.
    const NONE = '<p>Signs for no RPA Site Login. The workflow that runs the bot must have none.</p>';
    expect(await head(row(KEY), KEY)).toBe(UNCHANGED + NONE);
    expect(await head(row(KEY, SHOP.id), KEY)).toBe(UNCHANGED + NONE + `<p><strong>⚠ Version 4 does not fit this form: it was signed for a Site Login, which this form does not have, or with another signing key, or its row was changed after it was approved. ${READ} If the bot's workflow uses a Site Login, a version approved here will not run there: put that Site Login on Import steps and Sign steps first.</strong></p>`);
    // No key, signature or Site Login data is shown.
    const shown = await head(row(KEY, 'site-b'), KEY, SHOP);
    for (const secret of [KEY, String(row(KEY, 'site-b').signature), 'site-a', 'site-b']) expect(shown).not.toContain(secret);

    // A new bot: no approved version to check, only the line. Sign steps' check gets an empty item.
    const fresh = await checkBeforeReview({ Settings: [[{ json: { name: 'feed', ...settingsJson() } }]], 'Import steps': [[{ json: {} }], [next()]] }, KEY, SHOP);
    expect(fresh['The approved version'][0][0].json).toEqual({});
    expect(fresh['Sign steps'][0][0].json).toEqual({ checkOnly: true, siteLogin: SHOP.name, approvedVersion: null });
    expect(reviewHead({ $: nodesRan(fresh) })).toBe(NAMED);
    // Desktop steps bind no Site Login: the line says what they bind, whatever Sign steps holds.
    const desktop = { ...fresh, 'Import steps': [[{ json: {} }], [next('desktop')]] };
    expect(reviewHead({ $: nodesRan(desktop) })).toBe('<p>Desktop steps are signed for the app they start, without a Site Login.</p>');
    expect(reviewHead({ $: nodesRan({ ...desktop, 'Import steps': [[{ json: {} }], [next(), next('desktop')]] }) }))
      .toBe('<p>Signs for the Site Login named "<b>Shop &lt;login&gt;</b>". The workflow that runs the bot must use this Site Login. Desktop steps are signed for the app they start, without a Site Login.</p>');

    // The page was not answered: Sign steps' last run is its check, which the last page never counts as signed or rejected.
    const last = render(completion('Imported').completionMessage, { $: nodesRan({ ...fresh, 'Import steps': [[{ json: { drafts: [], report: { steps: 1, items: [] } } }], [next()]], [REVIEW]: [[{ json: {} }]] }) });
    expect(last).toContain('Nothing was signed: the review page was not answered in time.');
    expect(last).not.toContain('Rejected');
  });

  it('a file uploaded under the name of an approved bot is its next version, and the review page and the last page say which version it replaces', () => {
    const get = byName(t, 'Running versions');
    expect(get).toMatchObject({ type: DATA_TABLE, typeVersion: 1.1, alwaysOutputData: true });
    expect(get).not.toHaveProperty('onError');
    expect(table(get)).toEqual(table(byName(t, 'Approved bots')));
    expect(byName(t, 'What it replaces')).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const upload = formItem('Step document', Buffer.from('{}'));
    /** The file path as n8n's expressions see it, with Running versions giving `rows`. */
    const filePath = (rows: IDataObject[]) => {
      const ran: Record<string, INodeExecutionData[][]> = { Settings: [[{ json: { ...upload.json, ...settingsJson() } }]], 'Running versions': [rows.map((json) => ({ json }))] };
      const code = String(byName(t, 'What it replaces').parameters.jsonOutput);
      expect(code.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
      ran['What it replaces'] = [[{ json: evaluate(code, { $: nodesRan(ran) }) as IDataObject }]];
      return ran;
    };
    const row = (name: string, version: number, status = 'active'): IDataObject => ({ id: version, name, version, steps: '{}', signature: 's', approvedBy: APPROVER, status });
    // Version 4 runs: before this change the upload was version 1 and superseded it. Now it is version 5.
    const ran = filePath([row('line-item-export', 3, 'superseded'), row('line-item-export', 4), row('other', 9)]);
    expect(ran['What it replaces'][0][0].json).toEqual({ running: [{ name: 'line-item-export', version: 4, steps: '{}', signature: 's', approvedBy: APPROVER }], next: 5 });
    expect(resolved(upload, ran)).toMatchObject({ stepsName: 'line-item-export', options: { version: 5 } });
    // The step lists an import names after it (a UiPath project's line-item-export-1, -2) count; another name does not.
    const many = filePath([row('line-item-export-1', 3), row('line-item-export-2', 7), row('line-item-exporter', 12), row('line-item-export-x', 11)]);
    expect((many['What it replaces'][0][0].json.running as IDataObject[]).map((r) => r.name)).toEqual(['line-item-export-1', 'line-item-export-2']);
    expect(resolved(upload, many)).toMatchObject({ options: { version: 8 } });
    // Nothing runs under the name (a new n8n: the table was just made, empty): version 1, and no word about replacing.
    for (const rows of [[], [{}]]) {
      const none = filePath(rows);
      expect(none['What it replaces'][0][0].json).toEqual({ running: [], next: 1 });
      expect(resolved(upload, none)).toMatchObject({ options: { version: 1 } });
    }
    // A rejected attempt keeps its number: the next one takes the number after the highest any row of the name has
    // (active, rejected or superseded), and what it replaces is still the version that runs.
    const rejected = filePath([row('line-item-export', 4, 'rejected')]);
    expect(rejected['What it replaces'][0][0].json).toEqual({ running: [], next: 5 });
    expect(resolved(upload, rejected)).toMatchObject({ options: { version: 5 } });
    const again = filePath([row('line-item-export', 3, 'superseded'), row('line-item-export', 4), row('line-item-export', 5, 'rejected'), row('line-item-export', 6, 'rejected')]);
    expect((again['What it replaces'][0][0].json.running as IDataObject[]).map((r) => r.version)).toEqual([4]);
    expect(resolved(upload, again)).toMatchObject({ options: { version: 7 } });
    expect(resolved(upload)).toMatchObject({ options: { version: 1 } });

    // The review page: its title, and each block of several, name the version it replaces.
    const list = (name: string, version: number) => ({ json: { name, version, baseVersion: null, steps: { startUrl: SITE.url, steps: [] }, reviewSteps: [], safetyFlags: [] } });
    const title = (r: Record<string, INodeExecutionData[][]>) => evaluate(String((review.parameters.options as IDataObject).formTitle), { $: nodesRan(r) });
    expect(title({ ...ran, 'Import steps': [[{ json: {} }], [list('line-item-export', 5)]] })).toBe('line-item-export, version 5, replacing version 4');
    expect(title({ ...filePath([]), 'Import steps': [[{ json: {} }], [list('line-item-export', 1)]] })).toBe('line-item-export, version 1');
    // After rejected attempts: the next number, replacing the version that runs (not the number minus one).
    expect(title({ ...again, 'Import steps': [[{ json: {} }], [list('line-item-export', 7)]] })).toBe('line-item-export, version 7, replacing version 4');
    const blocks = reviewFields({ $: nodesRan({ ...many, 'Import steps': [[{ json: {} }], [list('line-item-export-1', 8), list('line-item-export-3', 8)]] }) })
      .filter((f) => f.fieldType === 'html').map((f) => /<h3>(.*?)<\/h3>/.exec(String(f.html))?.[1]);
    expect(blocks).toEqual(['1 of 2: line-item-export-1, version 8, replacing version 3', '2 of 2: line-item-export-3, version 8']);
    // Each step list's part of the review page says how that list differs from its own running version, with the change
    // path's words and its name: the same comparison (one function body, called per list with its running row and the
    // steps the import built). A list without a running version is new and gets no line; nothing goes in the page's top.
    const fn = String(byName(t, COMPARED).parameters.jsonOutput);
    const body = fn.slice('={{ ((bot, typed) => { '.length, fn.lastIndexOf('})('));
    expect(body).toMatch(/^const n = String\(bot\.version\); /);
    expect(String(byName(t, RUNNING).parameters.jsonOutput)).toContain(`(bot, typed) => { ${body}}`);
    expect(String(byName(t, RUNNING).parameters.jsonOutput).split('const n = String(bot.version)')).toHaveLength(2);
    expect(byName(t, RUNNING)).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const doc = (to: string, name: string) => ({ startUrl: SITE.url, name, steps: [{ intent: 'Open the report', goto: `${SITE.url}/r` }, { intent: 'Type the To date', fill: { selector: '#to', value: to } }] });
    const stored = (name: string, version: number, to: string) => ({ ...row(name, version), steps: JSON.stringify({ ...doc(to, name), version }) });
    const imported = (name: string, to: string, version = 9) => ({ json: { ...list(name, version).json, steps: { ...doc(to, name), version } } });
    /** The review page after Compared with the running version: its top field, and each list's part. */
    const page = (rows: IDataObject[], lists: { json: IDataObject }[]) => {
      const r = { ...filePath(rows), 'Import steps': [[{ json: {} }], lists] } as Record<string, INodeExecutionData[][]>;
      const after = { ...r, [RUNNING]: [[{ json: evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan(r) }) as IDataObject }]] };
      const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(after) });
      const lines = fields.slice(1).filter((f) => f.fieldType === 'html' && /<ol>/.test(String(f.html))).map((f) => /^(?:<h3>.*?<\/h3>)?(?:<p><b>(.*?)<\/b><\/p>)?/.exec(String(f.html))?.[1] ?? null);
      return { item: after[RUNNING][0][0].json, top: String(fields[0].html), lines };
    };
    // One list (as the pickup found it): the To date taken back from 2026-09-15 to 2026-09-30 is step 2.
    const one = page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-30', 5)]);
    // The page shows the line escaped, as it escapes everything else.
    expect(one.lines).toEqual(['line-item-export: changed from the approved version 4: step 2: value &quot;2026-09-15&quot; → &quot;2026-09-30&quot;.']);
    expect(one.top).toMatch(/^<p>Signs for /);
    expect(page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-15', 5)]).lines).toEqual(['line-item-export: unchanged from the approved version 4.']);
    // Two lists (a project's -1 and -2): each compared with its own version, one unchanged and one changed.
    const two = page([stored('line-item-export-1', 3, '2026-09-15'), stored('line-item-export-2', 7, '2026-09-15')], [imported('line-item-export-1', '2026-09-15'), imported('line-item-export-2', '2026-09-30')]);
    expect(two.lines).toEqual(['line-item-export-1: unchanged from the approved version 3.', 'line-item-export-2: changed from the approved version 7: step 2: value &quot;2026-09-15&quot; → &quot;2026-09-30&quot;.']);
    expect(two.top).toMatch(/^<p>Signs for /);
    // Only the second has a running version: the first is new and says nothing about a comparison.
    const second = page([stored('line-item-export-2', 7, '2026-09-15')], [imported('line-item-export-1', '2026-09-15'), imported('line-item-export-2', '2026-09-15')]);
    expect(second.lines).toEqual([null, 'line-item-export-2: unchanged from the approved version 7.']);
    expect(second.item).toEqual({ lists: [{ name: 'line-item-export-2', unchanged: true, compared: 'line-item-export-2: unchanged from the approved version 7.' }] });
    // Stored steps that do not parse, or two lists of one name: could not be compared, never unchanged.
    expect(page([{ ...row('line-item-export', 4), steps: '{broken' }], [imported('line-item-export', '2026-09-15', 5)]).lines).toEqual(['line-item-export: could not be compared with the approved version 4: read every step.']);
    expect(page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-15', 5), imported('line-item-export', '2026-09-15', 5)]).lines)
      .toEqual(Array(2).fill('line-item-export: could not be compared with the approved version 4: two step lists have this name. Read every step.'));
    // A new bot: no line anywhere.
    expect(page([], [imported('line-item-export', '2026-09-30', 1)]).item).toEqual({ lists: [] });
    // Desktop steps: the approved version holds which steps are writes (chosen on the review page); a file never does.
    // That mark alone is not a change, the line says that it is not compared, and a real change is still named by its step.
    const desk = (save: string, write: boolean) => ({ surface: 'desktop', name: 'line-item-export', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Type the date', fill: { uia: { path: [{ name: 'To' }] }, value: '2026-09-30' } }, { intent: 'Click Save', click: { uia: { path: [{ name: save }] } }, ...(write ? { write: true } : {}) }] });
    const deskRow = (save: string) => ({ ...row('line-item-export', 3), steps: JSON.stringify({ ...desk(save, true), version: 3 }) });
    const deskFile = (save: string) => ({ json: { ...list('line-item-export', 4).json, steps: { ...desk(save, false), version: 4 } } });
    const NOT_COMPARED = ' Which steps are writes is not compared: it is chosen again on this page.';
    expect(page([deskRow('Save')], [deskFile('Save')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: `line-item-export: unchanged from the approved version 3.${NOT_COMPARED}` }] });
    expect(page([deskRow('Save')], [deskFile('Save all')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: false, compared: `line-item-export: changed from the approved version 3: step 2: name "Save" → "Save all".${NOT_COMPARED}` }] });
    // A file that carries a mark of its own, where the approved version has none: the same, and the line still says so.
    const marked = { json: { ...list('line-item-export', 4).json, steps: { ...desk('Save', true), version: 4 } } };
    const plainRow = { ...row('line-item-export', 3), steps: JSON.stringify({ ...desk('Save', false), version: 3 }) };
    expect(page([plainRow], [marked]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: `line-item-export: unchanged from the approved version 3.${NOT_COMPARED}` }] });
    expect(page([plainRow], [deskFile('Save')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: 'line-item-export: unchanged from the approved version 3.' }] });
    // Only a step's own mark is left out: a field named write deeper in a step still counts.
    const deep = { json: { ...list('line-item-export', 4).json, steps: { ...desk('Save', false), version: 4, steps: [desk('Save', false).steps[0], { ...desk('Save', false).steps[1], click: { uia: { path: [{ name: 'Save' }] }, write: true } }] } } };
    expect(page([deskRow('Save')], [deep]).item).toMatchObject({ lists: [{ unchanged: false, compared: `line-item-export: changed from the approved version 3: step 2: write (none) → true.${NOT_COMPARED}` }] });
    // The change path keeps its own line at the top (Compared with the approved version); this node finds no upload there.
    expect(evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan({ Settings: [[{ json: { name: 'line-item-export' } }]], 'Import steps': [[{ json: {} }], [imported('line-item-export', '2026-09-30')]] }) })).toEqual({ lists: [] });
    // The version that runs is what Sign steps checks before the review page, as on a change.
    expect(evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $: nodesRan(ran) })).toEqual({ name: 'line-item-export', version: 4, steps: '{}', signature: 's', approvedBy: APPROVER });
    expect(evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $: nodesRan(filePath([])) })).toEqual({});

    // The last page: approved, it replaces version 4; rejected or refused, version 4 keeps running.
    const last = (signed: IDataObject[], errors: IDataObject[] = []) => render(completion('Imported').completionMessage, { $: nodesRan({
      ...ran, 'Import steps': [[{ json: { drafts: [{ name: 'line-item-export', forApproval: true }], report: { steps: 1, items: [] } } }], [list('line-item-export', 5)]],
      [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [signed.map((json) => ({ json })), errors.map((json) => ({ json }))],
    }) }).split('\n').slice(1);
    expect(last([{ status: 'active', name: 'line-item-export', version: 5 }])[0]).toBe('Approved and signed: line-item-export version 5 is now the version that runs, replacing version 4.');
    expect(last([{ status: 'rejected', name: 'line-item-export', version: 5 }])[0]).toBe('Rejected: line-item-export version 5. Nothing was signed. Version 4 keeps running.');
    expect(last([], [{ error: 'Sign Steps refused: a reason', details: { name: 'line-item-export', version: 5 } }]).slice(0, 2))
      .toEqual(['Not signed: line-item-export version 5. Sign Steps refused: a reason.', 'Nothing changed: line-item-export version 4 keeps running.']);
    // Approved, Supersede older versions turns version 4 superseded (an upload is a first version: every older active row).
    const supersede = table(byName(t, 'Supersede older versions')).filters!.conditions;
    const lte = supersede.find((c) => c.condition === 'lte')!;
    expect(evaluate(String(lte.keyValue), { $: () => ({ item: { json: { baseVersion: null, version: 5 } } }) })).toBe(2147483647);
  });

  it('a member who may not approve: the last page ends its sentence, says whom to ask, and points to no execution', () => {
    const POINTER = 'The full report is on the Data output of Import steps in this execution.';
    const page = (error: string) => render(completion('Imported').completionMessage, { $: nodesRan({
      Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [{ name: 'feed', forApproval: true }] } }], []],
      [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [[], [{ json: { error, details: { name: 'feed', version: 1 } } }]],
    }) }).split('\n');
    const member = page('Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist');
    expect(member).toEqual(['Imported: 2 steps.', 'Not signed: feed version 1. Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist. Ask the person who set up this form to approve it, or to put you on its Approver Allowlist.']);
    expect(page('Sign Steps refused: Approved By is not on the Approver Allowlist').join('\n')).not.toContain(POINTER);
    // Any other refusal: the owner reads the execution, so the page still says where the full report is.
    expect(page('Sign Steps refused: the steps do not match the hash that was reviewed')).toEqual(['Imported: 2 steps.', 'Not signed: feed version 1. Sign Steps refused: the steps do not match the hash that was reviewed.', POINTER]);
    // A reason that ends its own sentence gets no second full stop.
    expect(page('Sign Steps refused: the steps changed.')[1]).toBe('Not signed: feed version 1. Sign Steps refused: the steps changed.');
    // A deliberate Reject, with every step list decided: the page does not point to the reason for a step list that
    // failed. When one did fail its replay, it does.
    const decided = (drafts: IDataObject[]) => render(completion('Imported').completionMessage, { $: nodesRan({
      Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts } }], []],
      [REVIEW]: [[{ json: { decision_0: 'Reject' } }]], 'Sign steps': [[{ json: { status: 'rejected', name: 'feed', version: 1 } }], []],
    }) }).split('\n');
    expect(decided([{ name: 'feed', adopted: true }])).toEqual(['Imported: 2 steps.', '1 of 1 step list passed the replay.', 'Rejected: feed version 1. Nothing was signed.', POINTER]);
    expect(decided([{ name: 'feed', adopted: true }, { name: 'feed-2', reason: 'no download' }]).at(-1))
      .toBe('The full report, and the reason for any step list that could not be proved, is on the Data output of Import steps in this execution.');
  });

  it('has the stickies: About (grey), Set once (green, a checklist), Approval by email (grey, the option), Why approval (grey)', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    expect(sticky(t, 'Approval by email').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Why approval').color).toBe(COLOUR.grey);
    // Five sentences. The wait after Submit is said before it, so the spinner is expected. What is replayed, what is
    // not and how step lists are named are on the review page and in move-a-bot.md.
    const form = (byName(t, 'Import a bot').parameters as { formDescription?: string }).formDescription ?? '';
    expect(form).toBe('Upload a bot: an RPA recording, a UiPath project (ZIP or XAML), a Chrome Recorder export (JSON), Playwright code, or steps you wrote (JSON). After Submit, the import takes up to about half a minute: it runs a browser bot\'s steps twice, to prove them. You review every step on the next page. Nothing is signed until you approve it. To change an approved bot, or sign it again after the signing key changed, leave Bot file empty and type its name.');
    const about = sticky(t, 'About this workflow').content;
    for (const s of ['Chrome Recorder', 'Playwright code', 'UiPath', 'RPA: 2 Data feed', 'each step list gets its own approval',
      '**step document**', 'this is how hand-written steps get approved and signed']) expect(about, s).toContain(s);
    const set = sticky(t, 'Set once').content;
    expectChecklist(set);
    for (const s of ['opens with your n8n sign-in', 'set its **Authentication** to Basic Auth and pick or create a Basic Auth credential', '**RPA Browser**', '**RPA Site Login**',
      '**RPA Step Signing**', '**Sign steps → Approver Allowlist**', '**Options → Allow Private Network**', 'Publish']) expect(set, s).toContain(s);
    expect(set).toContain('type the n8n address of each person who may approve');
    expect(set).toContain('With Basic Auth, type your address once: it is recorded as the approver.');
    expect(set).not.toContain('Settings → approver');
    // The default path needs no other template.
    expect(set).not.toContain('RPA: 3');
    const email = sticky(t, 'Approval by email').content;
    for (const s of ['**RPA: 3 Approve steps**', 'publish it', 'In **Approve steps**, choose **RPA: 3 Approve steps**, then turn the node on', 'set `approval` to `by email`']) expect(email, s).toContain(s);
    const why = sticky(t, 'Why approval').content;
    for (const s of ['never', 'Sign Steps', 'password', 'the review page ticks the steps that may save, send or submit']) expect(why, s).toContain(s);
  });
});
