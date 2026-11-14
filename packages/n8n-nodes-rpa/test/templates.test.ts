// Every template file: a well-formed workflow, and its Data Tables made before anything uses them. Each template's own
// checks are in template-2, template-3, template-0-hello, template-5-import and template-5-change.
import { describe, expect, it } from 'vitest';
import { USE_CASE_WORDS } from 'n8n-rpa-engine';
import { type INodeProperties } from 'n8n-workflow';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { tablesNotMadeFirst, used } from './tables-made-first.js';
import { COLOUR, DATA_TABLE, FILES, NODE_TYPE, SETTINGS_NAME, STICKY, type Template, byName, load, table } from './template-harness.js';

const rowNodes = (t: Template) => t.nodes.filter((n) => n.type === DATA_TABLE && n.parameters.resource === 'row');
const columnsOf: Record<string, string[]> = { [STEPS_TABLE]: STEPS_TABLE_COLUMNS.map((c) => c.name), [RUN_TABLE]: RUN_TABLE_COLUMNS.map((c) => c.name) };

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
      'Approved bots', 'Record rejection', 'Running versions', 'Save signed steps', 'Supersede older versions', 'Versions now',
    ]);
    // As at 1ac5167: Settings → Change an approved bot? only, and the tables made after Approve on this form?.
    const late = structuredClone(t);
    late.connections['Settings'] = { main: [[{ node: 'Change an approved bot?', type: 'main', index: 0 }]] };
    late.connections['Approve on this form?'].main[0] = [{ node: 'Create steps table', type: 'main', index: 0 }];
    late.connections['Create run log table'] = { main: [[{ node: 'Compared with the running version', type: 'main', index: 0 }]] };
    // The change path reaches Sign steps' check, and through it the review page, before Approve on this form? there.
    expect(tablesNotMadeFirst(late)).toEqual(['Running versions uses playwright_steps', 'Approved bots uses playwright_steps', 'Versions now uses playwright_steps', 'Save signed steps uses playwright_steps', 'Supersede older versions uses playwright_steps', 'Record rejection uses playwright_steps']);
    // The order matters too: the tables' branch below the rest would run after it, so nothing is made first.
    const below = structuredClone(t);
    byName(below, 'Create steps table').position = [660, 600];
    expect(tablesNotMadeFirst(below)).toEqual(['Running versions uses playwright_steps', 'Approved bots uses playwright_steps', 'Versions now uses playwright_steps', 'Save signed steps uses playwright_steps', 'Supersede older versions uses playwright_steps', 'Record rejection uses playwright_steps']);
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
