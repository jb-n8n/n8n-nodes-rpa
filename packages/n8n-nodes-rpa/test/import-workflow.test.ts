import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Workflow, type IConnections, type INode, type INodeProperties, type INodeTypes } from 'n8n-workflow';
import { importSource, type Draft, type FlowNode, type ImportOptions, type UiPathFlow } from 'n8n-rpa-engine';
import { zip } from '../../engine/test/zip-fixtures.js';
import { buildWorkflow, MAX_WORKFLOW_NODES, workflowFile, type WorkflowJson, type WorkflowNode } from '../nodes/Playwright/import/workflow.js';
import { RPA_NODE_TYPE } from '../nodes/Playwright/node-type.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string };
const NODE_TYPE = `${PACKAGE.name}.playwright`;
const STICKY = 'n8n-nodes-base.stickyNote';
const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
/** Every node type and version the generator may emit, as they exist in n8n 2.41 (nodes-base at tag n8n@2.41.0). */
const TYPES: Record<string, number> = {
  'n8n-nodes-base.manualTrigger': 1,
  'n8n-nodes-base.stickyNote': 1,
  'n8n-nodes-base.dataTable': 1.1,
  [NODE_TYPE]: 1,
  'n8n-nodes-base.awsS3': 2,
  'n8n-nodes-base.extractFromFile': 1.1,
  'n8n-nodes-base.convertToFile': 1.1,
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.emailSend': 2.1,
  'n8n-nodes-base.wait': 1.1,
  'n8n-nodes-base.if': 2.2,
  // Each Run steps' Chat model (nodes-langchain at tag n8n@2.41.0) and its Approve steps.
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': 1.5,
  'n8n-nodes-base.executeWorkflow': 1.2,
};
const CHAT = '@n8n/n8n-nodes-langchain.lmChatAnthropic';
const EXECUTE = 'n8n-nodes-base.executeWorkflow';
/** Template 2's Chat model and Approve steps parameters: no credential, the approval workflow left for the user to pick. */
const CHAT_PARAMETERS = { model: { __rl: true, mode: 'id', value: 'claude-sonnet-5-5' }, options: {} };
const APPROVE_PARAMETERS = {
  source: 'database', workflowId: { __rl: true, mode: 'list', value: '', cachedResultName: 'RPA: 3 Approve steps' }, mode: 'once', options: { waitForSubWorkflow: false },
};
const TEMPLATE_2 = JSON.parse(readFileSync(new URL('../templates/2-data-feed.json', import.meta.url), 'utf8')) as WorkflowJson;
/** The only n8n expressions a generated workflow holds: the signed row read by Run steps. UiPath text never becomes one. */
const OWN_EXPRESSIONS = ["={{ $json.steps ?? '' }}", '={{ $json.signature }}', '={{ $json.approvedBy }}', '={{ $json.version }}'];
/** S3's Input Binary Field: the name Run steps gave its last file, with the imported draft's name as the fallback. */
const FILE_EXPRESSION = /^=\{\{ \$json\.files\?\.at\(-1\)\?\.binaryProperty \?\? 'file_\d+' \}\}$/;
const own = (v: string) => OWN_EXPRESSIONS.includes(v) || FILE_EXPRESSION.test(v);

// ---- the UiPath fixture project, imported through the engine ----
const DIR = fileURLToPath(new URL('../../engine/test/fixtures/import/uipath-sap-report/', import.meta.url));
const SECRETS = { username: 'summit-ops', password: 'demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
const OPTS: ImportOptions = {
  name: 'sap-report', hasSiteLogin: true, secrets: SECRETS, vars: { company: '1000', from: '2026-09-01', to: '2026-09-30' },
  download: { mime: ['text/csv'], check: { name: '^LINEITEMS_1000_', columns: ['Document', 'Amount'], minRows: 1 } },
};
function projectZip(): Buffer {
  const entries: { name: string; raw: Buffer; usize: number }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const data = readFileSync(path);
        entries.push({ name: `SAP Line Item Report/${relative(DIR, path).split('\\').join('/')}`, raw: deflateRawSync(data), usize: data.length });
      }
    }
  };
  walk(DIR);
  return zip(entries);
}
function imported(data: Buffer | string = projectZip(), opts: ImportOptions = OPTS): { flow: UiPathFlow; drafts: Draft[]; json: WorkflowJson } {
  const r = importSource('uipath', data, opts);
  expect(r.report.items.filter((i) => i.kind === 'error')).toEqual([]);
  if (!r.flow) throw new Error('the import gave no flow');
  return { flow: r.flow, drafts: r.drafts, json: buildWorkflow(r.flow, r.drafts, { name: opts.name }) };
}

// ---- hand-built flows ----
const draft = (name: string, steps: object[] = [{ intent: 'Open', goto: 'https://portal.example.com/' }]): Draft =>
  ({ name, script: { name, version: 1, startUrl: 'https://portal.example.com/', steps } }) as unknown as Draft;
const flowOf = (nodes: FlowNode[], name = 'Hand built'): UiPathFlow => ({ name, nodes });

// ---- the templates linter's rules (test/templates.test.ts), for generated workflows ----
const byName = (w: WorkflowJson, name: string): WorkflowNode => {
  const n = w.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" (have: ${w.nodes.map((x) => x.name).join(', ')})`);
  return n;
};
const targets = (w: WorkflowJson, from: string) => (w.connections[from]?.main ?? []).map((out) => out.map((c) => c.node));
/** The nodes whose ai_languageModel output goes to `to`. */
const models = (w: WorkflowJson, to: string) =>
  Object.entries(w.connections).filter(([, byType]) => (byType.ai_languageModel ?? []).some((out) => out.some((c) => c.node === to))).map(([from]) => from);
const working = (w: WorkflowJson) => w.nodes.filter((n) => n.type !== STICKY);
const stickies = (w: WorkflowJson) => w.nodes.filter((n) => n.type === STICKY);
const content = (n: WorkflowNode) => (n.parameters as { content: string }).content;
const columnsOf: Record<string, string[]> = { [STEPS_TABLE]: STEPS_TABLE_COLUMNS.map((c) => c.name), [RUN_TABLE]: RUN_TABLE_COLUMNS.map((c) => c.name) };
/** Every string parameter value, with its path. */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

function lint(w: WorkflowJson): void {
  expect(new Set(w.nodes.map((n) => n.name)).size).toBe(w.nodes.length);
  expect(new Set(w.nodes.map((n) => n.id)).size).toBe(w.nodes.length);
  for (const n of w.nodes) {
    expect(TYPES[n.type], `${n.name}: ${n.type}`).toBe(n.typeVersion);
    expect(n.position).toHaveLength(2);
    expect(n.position.every((p) => Number.isFinite(p))).toBe(true);
    expect(typeof n.parameters).toBe('object');
    expect(n.name.trim()).toBe(n.name);
    expect(n.name).not.toMatch(/[\n\r\t]/);
  }
  for (const [from, byType] of Object.entries(w.connections)) {
    expect(byName(w, from).type).not.toBe(STICKY);
    for (const [type, outputs] of Object.entries(byType)) for (const out of outputs) for (const c of out) {
      expect(byName(w, c.node).type).not.toBe(STICKY);
      expect(c.type).toBe(type);
      expect(c.index).toBe(0);
    }
  }
  const text = JSON.stringify(w);
  expect(text).not.toMatch(/"credentials"|"secretKey"|"password"|"token"/);
  // No expression names a node ($('…')): Run steps reads its own input item, so project text never meets a node reference.
  for (const n of w.nodes) for (const [, v] of strings(n.parameters)) if (v.startsWith('=')) expect(v).not.toMatch(/\$\(/);
  // Naming: only stored identifiers say Playwright.
  expect(text.replaceAll(NODE_TYPE, '').replaceAll(STEPS_TABLE, '').replaceAll(RUN_TABLE, '').match(/playwright/gi) ?? []).toEqual([]);
  // RPA nodes: only parameters the node defines, and always the operation.
  const properties = new Playwright().description.properties;
  const names = new Set(properties.map((p) => p.name));
  const optionNames = new Set(((properties.find((p) => p.name === 'options')?.options ?? []) as INodeProperties[]).map((o) => o.name));
  for (const n of w.nodes.filter((x) => x.type === NODE_TYPE)) {
    expect(n.parameters.operation).toBe('runSteps');
    for (const [key, value] of Object.entries(n.parameters)) {
      expect(names).toContain(key);
      if (key === 'options') for (const o of Object.keys(value as Record<string, unknown>)) expect(optionNames).toContain(o);
    }
  }
  // Each Run steps repairs with its own Chat model and sends Repaired Steps (output 1) to its own Approve steps.
  const runs = w.nodes.filter((x) => x.type === NODE_TYPE);
  for (const n of runs) {
    expect(n.parameters.aiRepair, n.name).toBe(true);
    expect(typeof n.parameters.goal, n.name).toBe('string');
    const chat = models(w, n.name);
    expect(chat, n.name).toHaveLength(1);
    expect(byName(w, chat[0]).type).toBe(CHAT);
    const outs = targets(w, n.name);
    expect(outs.length, n.name).toBeLessThanOrEqual(2);
    expect(outs[1], n.name).toHaveLength(1);
    expect(byName(w, outs[1][0]).type).toBe(EXECUTE);
    expect(outs[0] ?? [], n.name).not.toContain(outs[1][0]);
  }
  for (const n of w.nodes.filter((x) => x.type === CHAT)) {
    expect(n.parameters).toEqual(CHAT_PARAMETERS);
    // A sub-node: one ai_languageModel connection to one Run steps, no main connection, nothing comes in.
    expect(Object.keys(w.connections[n.name] ?? {})).toEqual(['ai_languageModel']);
    expect(w.connections[n.name].ai_languageModel?.flat()).toHaveLength(1);
  }
  for (const n of w.nodes.filter((x) => x.type === EXECUTE)) {
    expect(n.parameters).toEqual(APPROVE_PARAMETERS);
    expect(w.connections[n.name], n.name).toBeUndefined();
  }
  expect(w.nodes.filter((x) => x.type === CHAT)).toHaveLength(runs.length);
  expect(w.nodes.filter((x) => x.type === EXECUTE)).toHaveLength(runs.length);
  // Data Tables: only known tables and columns.
  for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.dataTable')) {
    const p = n.parameters as { dataTableId: { value: string }; filters?: { conditions: { keyName: string }[] } };
    expect(columnsOf[p.dataTableId.value], n.name).toBeDefined();
    for (const c of p.filters?.conditions ?? []) expect(columnsOf[p.dataTableId.value]).toContain(c.keyName);
  }
  expect(w.settings).toEqual({ executionOrder: 'v1' });
  for (const s of stickies(w)) expect(Object.values(COLOUR)).toContain((s.parameters as { color: number }).color);
  // The only expressions are the generator's own.
  for (const n of w.nodes) for (const [path, v] of strings(n.parameters)) if (v.startsWith('=')) expect(own(v), `${n.name}.${path}: ${v}`).toBe(true);
}

describe('buildWorkflow', () => {
  it('the SAP project becomes a workflow with Get active steps → Run steps → S3 upload', () => {
    const { json: w, drafts } = imported();
    lint(w);
    expect(drafts.map((d) => d.name)).toEqual(['sap-report-1']);
    expect(w.name).toBe('SAP Line Item Report (imported from UiPath)');
    expect(w.description).toMatch(/^Imported from the UiPath project SAP Line Item Report: /);

    // Grey "About this import" and green "Set once" come first, under names no project node can take.
    expect(w.nodes.slice(0, 2).map((n) => n.name)).toEqual(['About this import', 'Set once']);
    expect((w.nodes[0].parameters as { color: number }).color).toBe(COLOUR.grey);
    expect((w.nodes[1].parameters as { color: number }).color).toBe(COLOUR.green);
    expect(content(w.nodes[0])).toContain('Imported from the UiPath project `SAP Line Item Report`');
    expect(content(w.nodes[1])).toMatch(/RPA Browser/);
    expect(content(w.nodes[1])).toMatch(/RPA Site Login/);
    expect(content(w.nodes[1])).toMatch(/RPA Step Signing/);
    expect(content(w.nodes[1])).toMatch(/AWS/);
    expect(content(w.nodes[1])).toMatch(/SMTP/);

    // The working nodes, in flow order, with their types.
    expect(working(w).map((n) => [n.name, n.type])).toEqual([
      ['Run the bot', 'n8n-nodes-base.manualTrigger'],
      ['Get active steps (sap-report-1)', 'n8n-nodes-base.dataTable'],
      ['Use Browser Chrome: SAP Logon', NODE_TYPE],
      ['Chat model (sap-report-1)', CHAT],
      ['Approve steps (sap-report-1)', EXECUTE],
      ['Upload line items to S3', 'n8n-nodes-base.awsS3'],
      ['If many line items', 'n8n-nodes-base.if'],
      ['Send SMTP Mail Message', 'n8n-nodes-base.emailSend'],
      ['Delay', 'n8n-nodes-base.wait'],
      ['Notify the region', 'n8n-nodes-base.httpRequest'],
      ['Read Range', 'n8n-nodes-base.extractFromFile'],
    ]);
    expect(targets(w, 'Run the bot')).toEqual([['Get active steps (sap-report-1)']]);
    expect(targets(w, 'Get active steps (sap-report-1)')).toEqual([['Use Browser Chrome: SAP Logon']]);
    // Data (0) still feeds the next node; Repaired Steps (1) goes to Approve steps; the Chat model is the Model input.
    expect(targets(w, 'Use Browser Chrome: SAP Logon')).toEqual([['Upload line items to S3'], ['Approve steps (sap-report-1)']]);
    expect(w.connections['Chat model (sap-report-1)']).toEqual({ ai_languageModel: [[{ node: 'Use Browser Chrome: SAP Logon', type: 'ai_languageModel', index: 0 }]] });
    expect(targets(w, 'Upload line items to S3')).toEqual([['If many line items']]);
    expect(targets(w, 'If many line items')).toEqual([['Send SMTP Mail Message'], ['Delay']]);
    expect(targets(w, 'Send SMTP Mail Message')).toEqual([['Notify the region']]);
    expect(targets(w, 'Delay')).toEqual([['Notify the region']]);
    expect(targets(w, 'Notify the region')).toEqual([['Read Range']]);
    expect(targets(w, 'Read Range')).toEqual([]);

    // Get active steps: the newest active row of the draft's name, as in template 2, one item even before approval.
    const get = byName(w, 'Get active steps (sap-report-1)');
    expect(get).toMatchObject({ alwaysOutputData: true, executeOnce: true });
    expect(get.parameters).toEqual({
      resource: 'row', operation: 'get',
      dataTableId: { __rl: true, mode: 'name', value: 'playwright_steps' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'name', condition: 'eq', keyValue: 'sap-report-1' }, { keyName: 'status', condition: 'eq', keyValue: 'active' }] },
      returnAll: false, limit: 1, orderBy: true, orderByColumn: 'version', orderByDirection: 'DESC',
    });
    // Run steps: signed steps from that row, Name and Expected Version, AI Repair on with a Goal.
    expect(byName(w, 'Use Browser Chrome: SAP Logon').parameters).toEqual({
      operation: 'runSteps',
      steps: "={{ $json.steps ?? '' }}",
      requireSignedSteps: true,
      signature: '={{ $json.signature }}',
      approvedBy: '={{ $json.approvedBy }}',
      aiRepair: true,
      goal: 'Do what the imported steps do: sap-report-1',
      options: { name: 'sap-report-1', expectedVersion: '={{ $json.version }}' },
    });
    expect(byName(w, 'Use Browser Chrome: SAP Logon').notes).toMatch(/sap-report-1/);

    // S3: the literal bucket and key, the file Run steps downloaded (the draft's download is top-level step 7).
    expect(byName(w, 'Upload line items to S3').parameters).toEqual({
      resource: 'file', operation: 'upload', bucketName: 'acme-finance-reports', fileName: 'sap/line-items.xlsx',
      binaryData: true, binaryPropertyName: "={{ $json.files?.at(-1)?.binaryProperty ?? 'file_7' }}", additionalFields: {},
    });
    expect(byName(w, 'Upload line items to S3').notes).toMatch(/Run steps/);
    expect(drafts[0].script.steps[7]).toHaveProperty('download');
    expect(byName(w, 'Send SMTP Mail Message').parameters).toMatchObject({
      resource: 'email', operation: 'send', toEmail: 'finance@acme.example', subject: 'Large SAP line item report', emailFormat: 'text',
    });
    expect(byName(w, 'Delay').parameters).toEqual({ resume: 'timeInterval', amount: 5, unit: 'seconds' });
    expect(byName(w, 'Notify the region').parameters).toEqual({ method: 'POST', url: 'https://hooks.acme.example/sap-report', options: {} });
    expect(byName(w, 'Read Range').parameters).toEqual({ operation: 'xlsx', binaryPropertyName: 'data', options: { sheetName: 'Line Items' } });
    expect(byName(w, 'Read Range').notes).toContain('C:\\Reports\\line-items.xlsx');

    // The credential lookup is a green sticky naming the asset and the Site Login slot, in its place in the flow.
    const cred = byName(w, 'Credential: SAP_Login');
    expect(cred.type).toBe(STICKY);
    expect((cred.parameters as { color: number }).color).toBe(COLOUR.green);
    expect(content(cred)).toContain('UiPath credential `SAP_Login`: pick an RPA Site Login on the Run steps node(s)');
    expect(cred.position[0]).toBeGreaterThan(byName(w, 'Run the bot').position[0]);
    expect(cred.position[0]).toBeLessThan(get.position[0]);

    // The loop is inline, with a sticky naming the original loop around its body.
    const loop = byName(w, 'Loop: For Each region');
    expect(content(loop)).toContain('`{"EMEA", "AMER"}`');
    expect(loop.position[0]).toBeLessThan(byName(w, 'Notify the region').position[0]);

    // Left to right: each working node in the main line sits right of the one before it.
    const line = ['Run the bot', 'Get active steps (sap-report-1)', 'Use Browser Chrome: SAP Logon', 'Upload line items to S3', 'If many line items', 'Notify the region', 'Read Range'];
    const xs = line.map((n) => byName(w, n).position[0]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('untranslated and desktop activities become stickies in order', () => {
    const { json: w } = imported();
    const notTranslated = stickies(w).filter((s) => s.name.startsWith('Not translated'));
    expect(notTranslated.map((s) => s.name)).toEqual(["Not translated: SAP Logon", "Not translated: Click 'Execute' in SAP GUI"]);
    for (const s of notTranslated) expect((s.parameters as { color: number }).color).toBe(COLOUR.grey);
    expect(content(notTranslated[0])).toContain("Not translated: SAP Logon (NSAPLogon): rebuild in SAP's web GUI");
    // In order, after the node before them.
    const last = byName(w, 'Read Range').position[0];
    expect(notTranslated[0].position[0]).toBeGreaterThan(last);
    expect(notTranslated[1].position[0]).toBeGreaterThan(notTranslated[0].position[0]);

    // Between two working nodes the connection skips the sticky, which sits between them.
    const h = buildWorkflow(flowOf([
      { kind: 'wait', seconds: 2, displayName: 'Pause' },
      { kind: 'untranslated', activity: 'NGetText', displayName: 'Get Text *total*', note: 'map the value with an ID Pattern' },
      { kind: 'untranslated', activity: 'NSAPLogon', displayName: 'SAP Logon', note: "rebuild in SAP's web GUI" },
      { kind: 'http', method: 'GET', url: 'https://api.example.com/x', displayName: 'Call' },
    ]), [], { name: 'h' });
    lint(h);
    expect(targets(h, 'Pause')).toEqual([['Call']]);
    const [a, b] = [byName(h, 'Not translated: Get Text *total*'), byName(h, 'Not translated: SAP Logon')];
    expect(a.position[0]).toBeGreaterThan(byName(h, 'Pause').position[0]);
    expect(b.position[0]).toBeGreaterThan(a.position[0]);
    expect(byName(h, 'Call').position[0]).toBeGreaterThan(b.position[0]);
    // UiPath text cannot restyle the sticky: markdown characters are escaped.
    expect(content(a)).toContain('Get Text \\*total\\*');
  });

  it('If keeps both branches and the original condition in notes', () => {
    const h = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Use Browser Chrome: Portal' },
      {
        kind: 'if', expression: 'intTotal > 1000 AndAlso Not strMode = "dry"', displayName: 'If big',
        then: [
          { kind: 'email', to: 'ops@example.com', displayName: 'Mail ops' },
          { kind: 'if', expression: 'blnUrgent', displayName: 'If urgent', then: [], else: [{ kind: 'wait', displayName: 'Hold' }] },
        ],
        else: [],
      },
      { kind: 'http', url: 'https://api.example.com/done', displayName: 'Done' },
    ]), [draft('portal-1')], { name: 'portal' });
    lint(h);
    const big = byName(h, 'If big');
    expect(big.notes).toContain('UiPath condition: intTotal > 1000 AndAlso Not strMode = "dry"');
    expect(big.parameters).toEqual({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: expect.any(String), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    });
    // Both outputs: true → the Then branch, false (empty) → the next node.
    expect(targets(h, 'If big')).toEqual([['Mail ops'], ['Done']]);
    expect(targets(h, 'Mail ops')).toEqual([['If urgent']]);
    // The nested If: an empty Then goes straight on, the Else runs Hold first.
    expect(targets(h, 'If urgent')).toEqual([['Done'], ['Hold']]);
    expect(targets(h, 'Hold')).toEqual([['Done']]);
    // The true branch sits above the false branch; the next node sits right of both.
    expect(byName(h, 'Mail ops').position[1]).toBeLessThan(big.position[1]);
    expect(byName(h, 'Done').position[0]).toBeGreaterThan(byName(h, 'Hold').position[0]);
    // A gold sticky asks for the condition, quoting the original as text.
    const fill = byName(h, 'Fill in the condition: If big');
    expect((fill.parameters as { color: number }).color).toBe(COLOUR.gold);
    expect(content(fill)).toContain('`intTotal > 1000 AndAlso Not strMode = "dry"`');
    // Both branches empty: both outputs go on.
    const both = buildWorkflow(flowOf([{ kind: 'if', expression: 'x', then: [], else: [], displayName: 'If' }, { kind: 'wait', seconds: 1, displayName: 'Next' }]), [], { name: 'b' });
    expect(targets(both, 'If')).toEqual([['Next'], ['Next']]);
  });

  it('the workflow loads in n8n-workflow', () => {
    const { json: w } = imported();
    const playwright = new Playwright();
    // The RPA node with its real description; nodes-base types are not installed here, so n8n skips them (as it does
    // for an unknown type) and the structural checks below cover them.
    const nodeTypes = {
      getByName: (t: string) => (t === NODE_TYPE ? playwright : undefined),
      getByNameAndVersion: (t: string) => (t === NODE_TYPE ? playwright : undefined),
      getKnownTypes: () => ({}),
    } as unknown as INodeTypes;
    const workflow = new Workflow({ nodes: structuredClone(w.nodes) as unknown as INode[], connections: w.connections as unknown as IConnections, nodeTypes, active: false });
    const run = workflow.getNode('Use Browser Chrome: SAP Logon');
    expect(run?.parameters).toMatchObject({
      operation: 'runSteps', steps: "={{ $json.steps ?? '' }}", requireSignedSteps: true, signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}', aiRepair: true,
      options: { name: 'sap-report-1', expectedVersion: '={{ $json.version }}' },
    });
    for (const [from, byType] of Object.entries(w.connections)) {
      expect(workflow.getNode(from)).not.toBeNull();
      for (const outs of Object.values(byType)) for (const out of outs ?? []) for (const c of out) expect(workflow.getNode(c.node)).not.toBeNull();
    }
    // n8n sees the Chat model as Run steps' Model input, and Approve steps after Run steps.
    expect(workflow.getParentNodes('Use Browser Chrome: SAP Logon', 'ai_languageModel')).toEqual(['Chat model (sap-report-1)']);
    expect(workflow.getChildNodes('Use Browser Chrome: SAP Logon')).toContain('Approve steps (sap-report-1)');
    // Every working node is reachable from the trigger, the Chat model through the Run steps it serves; no sticky is connected.
    const reached = new Set(workflow.getChildNodes('Run the bot'));
    for (const n of working(w).filter((x) => x.name !== 'Run the bot' && x.type !== CHAT)) expect(reached, n.name).toContain(n.name);
    for (const n of working(w).filter((x) => x.type === CHAT)) expect(reached).toContain(workflow.getChildNodes(n.name, 'ai_languageModel')[0]);
    for (const s of stickies(w)) expect(reached.has(s.name)).toBe(false);
    expect(workflow.getParentNodes('Run the bot')).toEqual([]);
  });

  it('no secret or credential value appears in the workflow JSON', () => {
    const { json: w } = imported();
    const text = JSON.stringify(w);
    for (const v of [SECRETS.username, SECRETS.password, SECRETS.totpSecret, 'in_Password', 'in_User']) expect(text).not.toContain(v);
    expect(text).not.toMatch(/"credentials"/);
    // The asset name appears only in the credential sticky.
    const withoutSticky = JSON.stringify({ ...w, nodes: w.nodes.filter((n) => n.name !== 'Credential: SAP_Login') });
    expect(withoutSticky).not.toContain('SAP_Login');

    // Site Login values written into the bot (a typed field labelled Key, an address, a condition, a mail, an S3 key
    // and a credential asset) never reach the workflow.
    const p = SECRETS.password;
    const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const target = (sel: string) => `<uix:TargetAnchorable FullSelectorArgument="${esc(sel)}" />`;
    const leaky = `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:uaws="clr-namespace:UiPath.Amazon.Scope.Activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence DisplayName="Main">
<ui:GetCredential AssetName="${p}" DisplayName="Get Credential" />
<uix:NApplicationCard DisplayName="Use Browser ${SECRETS.username}"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">
<uix:NTypeInto DisplayName="Type Into 'Key'" Text="${p}"><uix:NTypeInto.Target>${target("<webctrl tag='INPUT' aaname='Key' />")}</uix:NTypeInto.Target></uix:NTypeInto>
<ui:TypeSecureText DisplayName="Type Secure Text 'PIN'" SecureText="[secPin]"><ui:TypeSecureText.Target>${target("<webctrl tag='INPUT' aaname='PIN' />")}</ui:TypeSecureText.Target></ui:TypeSecureText>
<uix:NClick DisplayName="Click 'Go'"><uix:NClick.Target>${target("<webctrl tag='BUTTON' aaname='Go' />")}</uix:NClick.Target></uix:NClick>
</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp BrowserType="Chrome" Url="https://portal.example.com/app?u=${SECRETS.username}" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>
<If Condition="[strPwd = &quot;${p}&quot;]" DisplayName="If ${p}"><If.Then><ui:SendSMTPMailMessage To="${SECRETS.username}@acme.example" Subject="pw ${p}" DisplayName="Mail" /></If.Then></If>
<uaws:AmazonScope DisplayName="AWS"><uaws:AmazonScope.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do"><uaws:UploadFile BucketName="b-${p}" KeyName="k/${p}.csv" DisplayName="Upload ${p}" /></Sequence></ActivityAction></uaws:AmazonScope.Body></uaws:AmazonScope>
<ui:HttpClient EndPoint="https://api.example.com/?key=${p}" Method="GET" DisplayName="Call" />
</Sequence></Activity>`;
    const r = importSource('uipath', leaky, { ...OPTS, name: 'leaky', download: undefined });
    expect(r.flow).toBeDefined();
    const lw = buildWorkflow(r.flow!, r.drafts, { name: 'leaky' });
    lint(lw);
    const ltext = JSON.stringify(lw);
    for (const v of [p, SECRETS.username, 'secPin']) expect(ltext).not.toContain(v);
    expect(ltext).not.toMatch(/"credentials"/);
  });

  it('UiPath text never becomes an n8n expression or reaches a parameter as code', () => {
    const hostile = '={{ $env.AWS_SECRET_ACCESS_KEY }}';
    const h = buildWorkflow(flowOf([
      { kind: 's3Upload', bucket: hostile, key: hostile, displayName: hostile },
      { kind: 'email', to: hostile, subject: hostile, displayName: 'Mail' },
      { kind: 'http', method: 'GET', url: hostile, displayName: 'Call' },
      { kind: 'writeSpreadsheet', path: `C:\\out\\${hostile}`, sheet: hostile, displayName: 'Write' },
      { kind: 'readSpreadsheet', path: hostile, sheet: hostile, displayName: 'Read' },
      { kind: 'if', expression: `{{ $('x').item }} ${hostile}`, then: [], else: [], displayName: 'If' },
      { kind: 'forEach', expression: hostile, body: [], displayName: 'Loop' },
      { kind: 'credential', asset: hostile, displayName: 'Cred' },
      { kind: 'untranslated', activity: hostile, displayName: hostile, note: hostile },
    ], hostile), [], { name: 'safe' });
    lint(h);
    // No parameter starts with "=" (n8n's expression marker) except the generator's own, and lint checked those.
    for (const n of h.nodes) for (const [, v] of strings(n.parameters)) if (v.startsWith('=')) expect(own(v), v).toBe(true);
    // A literal that would be an expression is left empty and kept as text in the notes.
    expect(byName(h, 'S3 upload').parameters).toMatchObject({ bucketName: '', fileName: '' });
    expect(byName(h, 'S3 upload').notes).toContain(hostile);
    expect(byName(h, 'Mail').parameters).toMatchObject({ toEmail: '', subject: '' });
    expect(byName(h, 'Call').parameters).toMatchObject({ url: '' });
    // Node names never start with "=" either, and names in sticky markdown are escaped.
    for (const n of h.nodes) expect(n.name.startsWith('=')).toBe(false);
    expect(h.name.startsWith('=')).toBe(false);
    // The import name must be usable as a literal: one that n8n would read as an expression is refused.
    expect(() => buildWorkflow(flowOf([]), [], { name: '={{ 1 }}' })).toThrow(/Name/);
    expect(() => buildWorkflow(flowOf([]), [], { name: '  ' })).toThrow(/Name/);
  });

  it('a browser node without its draft, an empty flow, long and duplicate names', () => {
    const long = 'x'.repeat(500);
    const h = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 2, displayName: 'Browser' },
      { kind: 'wait', seconds: 1, displayName: 'Wait' },
      { kind: 'wait', seconds: 1, displayName: 'Wait' },
      { kind: 'wait', seconds: 1, displayName: ` ${long}\n` },
      { kind: 'wait', seconds: 1, displayName: '' },
    ]), [draft('n-1')], { name: 'n' });
    lint(h);
    expect(byName(h, 'Not translated: Browser').parameters).toMatchObject({ color: COLOUR.grey });
    expect(content(byName(h, 'Not translated: Browser'))).toContain('no draft named n-2');
    expect(working(h).map((n) => n.name).slice(1, 3)).toEqual(['Wait', 'Wait 2']);
    for (const n of h.nodes) expect(n.name.length).toBeLessThanOrEqual(100);
    expect(targets(h, 'Run the bot')).toEqual([['Wait']]);

    const empty = buildWorkflow(flowOf([]), [], { name: 'e' });
    lint(empty);
    expect(working(empty).map((n) => n.name)).toEqual(['Run the bot']);
  });

  it('workflowFile gives the binary for the Data output: <name>.workflow.json, application/json', () => {
    const { flow, drafts, json } = imported();
    const f = workflowFile(flow, drafts, { name: 'sap-report' });
    expect(f.fileName).toBe('sap-report.workflow.json');
    expect(f.mimeType).toBe('application/json');
    expect(JSON.parse(f.data.toString('utf8'))).toEqual(JSON.parse(JSON.stringify(json)));
    expect(workflowFile(flow, drafts, { name: 'a/b\\c' }).fileName).toBe('a_b_c.workflow.json');
  });

  it('the RPA node type comes from one constant: the package name plus .playwright', () => {
    // A rename of the package (the public release) fails here until the constant follows it.
    expect(RPA_NODE_TYPE).toBe(`${PACKAGE.name}.playwright`);
    const codex = JSON.parse(readFileSync(new URL('../nodes/Playwright/Playwright.node.json', import.meta.url), 'utf8')) as { node: string };
    expect(codex.node).toBe(RPA_NODE_TYPE);
    const { json: w } = imported();
    expect(w.nodes.filter((n) => n.type === RPA_NODE_TYPE).map((n) => n.name)).toEqual(['Use Browser Chrome: SAP Logon']);
  });

  it("S3 reads Run steps' own file name, and only from the Run steps right before it", () => {
    const dl = (name: string) => draft(name, [{ intent: 'Open', goto: 'https://portal.example.com/' }, { intent: 'Export', download: { trigger: { role: 'button', name: 'Export' } } }]);
    const drafts = [dl('f-1'), draft('f-2'), dl('f-3')];
    const s3 = (displayName: string): FlowNode => ({ kind: 's3Upload', bucket: 'b', key: 'k', displayName });
    const fileOf = (w: WorkflowJson, name: string) => byName(w, name).parameters.binaryPropertyName;
    const FROM_RUN = "={{ $json.files?.at(-1)?.binaryProperty ?? 'file_1' }}";
    const w = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Download' },
      s3('Right after'),
      s3('Second upload'),
      { kind: 'browser', sequence: 3, displayName: 'Download again' },
      { kind: 'wait', seconds: 1, displayName: 'Pause' },
      { kind: 'if', expression: 'x', then: [], else: [], displayName: 'If' },
      s3('After a wait and an If'),
      { kind: 'browser', sequence: 1, displayName: 'Download once more' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'Call' },
      s3('After a call'),
      { kind: 'browser', sequence: 1, displayName: 'And again' },
      { kind: 'browser', sequence: 2, displayName: 'No download' },
      s3('After a browser without a download'),
      { kind: 'browser', sequence: 1, displayName: 'One more' },
      { kind: 'browser', sequence: 9, displayName: 'Missing' },
      s3('After a missing draft'),
      { kind: 'if', expression: 'y', then: [{ kind: 'browser', sequence: 1, displayName: 'Only on true' }], else: [], displayName: 'If 2' },
      s3('After branches that differ'),
    ]), drafts, { name: 'f' });
    lint(w);
    expect(fileOf(w, 'Right after')).toBe(FROM_RUN);
    expect(byName(w, 'Right after').notes).toContain('file_1');
    for (const name of ['Second upload', 'After a call', 'After a browser without a download', 'After a missing draft', 'After branches that differ']) {
      expect(fileOf(w, name), name).toBe('data');
      expect(byName(w, name).notes, name).toMatch(/No Run steps download reaches this node/);
    }
    expect(fileOf(w, 'After a wait and an If')).toBe(FROM_RUN);
  });

  it('"About this import" and "Set once" are reserved: a project node with that name is renamed', () => {
    const w = buildWorkflow(flowOf([
      { kind: 'wait', seconds: 1, displayName: 'Set once' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'About this import' },
    ]), [], { name: 'r' });
    lint(w);
    expect(w.nodes.slice(0, 2).map((n) => [n.name, n.type])).toEqual([['About this import', STICKY], ['Set once', STICKY]]);
    expect(working(w).map((n) => n.name)).toEqual(['Run the bot', 'Set once 2', 'About this import 2']);
    expect(targets(w, 'Set once 2')).toEqual([['About this import 2']]);
  });

  it('a literal holding {{ is not used: it goes to the notes, like one starting with =', () => {
    const w = buildWorkflow(flowOf([
      { kind: 'email', to: 'ops+{{ $json.team }}@example.com', subject: 'Report {{ $now }}', displayName: 'Mail' },
      { kind: 'http', url: 'https://api.example.com/{{ $json.id }}', displayName: 'Call' },
      { kind: 's3Upload', bucket: 'b{{x}}', key: 'k', displayName: 'Upload' },
      { kind: 'writeSpreadsheet', path: 'C:\\out\\{{ name }}.xlsx', sheet: '{{s}}', displayName: 'Write' },
    ]), [], { name: 'l' });
    lint(w);
    expect(byName(w, 'Mail').parameters).toMatchObject({ toEmail: '', subject: '' });
    expect(byName(w, 'Mail').notes).toContain('ops+{{ $json.team }}@example.com');
    expect(byName(w, 'Call').parameters).toMatchObject({ url: '' });
    expect(byName(w, 'Upload').parameters).toMatchObject({ bucketName: '', fileName: 'k' });
    expect(byName(w, 'Write').parameters).toMatchObject({ options: {} });
    for (const n of w.nodes) for (const [, v] of strings(n.parameters)) if (!own(v)) expect(v).not.toContain('{{');
  });

  it('Loop and If stickies say Run steps runs once when a browser pair is inside', () => {
    const w = buildWorkflow(flowOf([
      { kind: 'forEach', expression: 'rows', body: [{ kind: 'browser', sequence: 1, displayName: 'Per row' }], displayName: 'For Each row' },
      { kind: 'forEach', expression: 'ids', body: [{ kind: 'http', url: 'https://api.example.com/', displayName: 'Call' }], displayName: 'For Each id' },
      { kind: 'if', expression: 'a', then: [], else: [{ kind: 'browser', sequence: 1, displayName: 'On false' }], displayName: 'If a' },
      { kind: 'if', expression: 'b', then: [{ kind: 'wait', seconds: 1, displayName: 'Hold' }], else: [], displayName: 'If b' },
    ]), [draft('o-1')], { name: 'o' });
    lint(w);
    const ONCE = /Run steps runs once.*Execute Once/;
    expect(content(byName(w, 'Loop: For Each row'))).toMatch(ONCE);
    expect(content(byName(w, 'Loop: For Each id'))).not.toMatch(ONCE);
    expect(content(byName(w, 'Fill in the condition: If a'))).toMatch(ONCE);
    expect(content(byName(w, 'Fill in the condition: If b'))).not.toMatch(ONCE);
  });

  it('a flow of 130,000 activities draws about 500 nodes and one grey sticky for the rest, quickly and without a stack overflow', () => {
    expect(MAX_WORKFLOW_NODES).toBe(500);
    const total = 130_000;
    const flow = flowOf(Array.from({ length: total }, (_, i): FlowNode => ({ kind: 'untranslated', activity: 'MysteryActivity', displayName: `Mystery ${i}`, note: 'no step equivalent' })));
    const started = performance.now();
    const w = buildWorkflow(flow, [], { name: 'big' });
    const bytes = workflowFile(flow, [], { name: 'big' }).data.length;
    const ms = performance.now() - started;
    lint(w);
    expect(ms).toBeLessThan(2000);
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 4);
    // The trigger counts as a node, so 499 activities are drawn; the sticky counts the rest.
    const drawn = stickies(w).filter((n) => n.name.startsWith('Not translated: ')).length;
    expect(drawn).toBe(MAX_WORKFLOW_NODES - 1);
    const rest = (total - drawn).toLocaleString('en-US');
    const more = byName(w, `${rest} more activities`);
    expect(more.parameters).toMatchObject({ color: COLOUR.grey });
    expect(content(more)).toContain(`${rest} more activities: see the report.`);
    expect(content(byName(w, 'About this import'))).toContain(`${rest} more not drawn (see the report)`);
    expect(w.description).toContain(`${rest} more not drawn`);
  });

  it('the cap holds inside a branch: what follows the If is counted too, and the If still connects to what was drawn', () => {
    const waits = (n: number, tag: string): FlowNode[] => Array.from({ length: n }, (_, i) => ({ kind: 'wait', seconds: 1, displayName: `${tag} ${i}` }));
    // Nested Ifs, each holding a large branch: depth and browsers are worked out once per If, not once per If above it.
    let inner: FlowNode[] = waits(2_000, 'Deep');
    for (let d = 0; d < 300; d++) inner = [{ kind: 'if', expression: `x${d}`, displayName: `If ${d}`, then: inner, else: [] }];
    const flow = flowOf([...inner, ...waits(1_000, 'After')]);
    const started = performance.now();
    const w = buildWorkflow(flow, [], { name: 'nested' });
    expect(performance.now() - started).toBeLessThan(2000);
    lint(w);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 4);
    expect(targets(w, 'Run the bot')).toEqual([['If 299']]);
    const drawn = working(w).length - 1;
    const rest = (300 + 2_000 + 1_000 - drawn).toLocaleString('en-US');
    expect(content(byName(w, `${rest} more activities`))).toContain('see the report');
    expect(w.nodes.map((n) => n.name)).not.toContain('After 0');
  });
  it('layout: the gold Pick sticky and each node (box and label) of a browser pair do not overlap anything else', () => {
    type Box = { name: string; x1: number; y1: number; x2: number; y2: number };
    // An n8n node is about 100 x 100, its label sits under it, centred, about 40 high and at most about 200 wide.
    const boxes = (w: WorkflowJson): { node: Box[]; sticky: Box[] } => {
      const node: Box[] = [];
      const sticky: Box[] = [];
      for (const n of w.nodes) {
        const [x, y] = n.position;
        if (n.type === STICKY) {
          const { width, height } = n.parameters as { width: number; height: number };
          sticky.push({ name: n.name, x1: x, y1: y, x2: x + width, y2: y + height });
        } else {
          const lw = Math.min(200, 7 * n.name.length + 10);
          node.push({ name: n.name, x1: x, y1: y, x2: x + 100, y2: y + 100 });
          node.push({ name: `${n.name} (label)`, x1: x + 50 - lw / 2, y1: y + 100, x2: x + 50 + lw / 2, y2: y + 140 });
        }
      }
      return { node, sticky };
    };
    const hit = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
    const w = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Log in' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'Call' },
      { kind: 'if', expression: 'x', then: [{ kind: 'browser', sequence: 2, displayName: 'Export' }], else: [], displayName: 'If x' },
    ]), [draft('m-1'), draft('m-2')], { name: 'm' });
    for (const workflow of [w, imported().json]) {
      const { node, sticky } = boxes(workflow);
      const picks = sticky.filter((b) => b.name.startsWith('Pick RPA: 3 Approve steps'));
      expect(picks.length).toBeGreaterThan(0);
      for (const pick of picks) for (const n of node) expect(hit(pick, n), `${pick.name} overlaps ${n.name}`).toBe(false);
      for (const [i, a] of node.entries()) for (const b of node.slice(i + 1)) {
        if (/^(Chat model|Approve steps) \(/.test(a.name) || /^(Chat model|Approve steps) \(/.test(b.name)) expect(hit(a, b), `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });
  it('each Run steps heals with its own Chat model and sends Repaired Steps to its own Approve steps', () => {
    const w = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Log in' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'Call' },
      { kind: 'if', expression: 'x', then: [{ kind: 'browser', sequence: 2, displayName: 'Export' }], else: [], displayName: 'If x' },
      { kind: 'wait', seconds: 1, displayName: 'Approve steps' },
    ]), [draft('m-1'), draft('m-2')], { name: 'm' });
    lint(w);
    // One Chat model, one Approve steps and one gold sticky per Run steps: an n8n sub-node connects to one parent.
    for (const [run, d] of [['Log in', 'm-1'], ['Export', 'm-2']]) {
      expect(models(w, run)).toEqual([`Chat model (${d})`]);
      expect(w.connections[`Chat model (${d})`]).toEqual({ ai_languageModel: [[{ node: run, type: 'ai_languageModel', index: 0 }]] });
      expect(byName(w, run).parameters).toMatchObject({ aiRepair: true, goal: `Do what the imported steps do: ${d}` });
      expect(byName(w, run).notes).toMatch(/Goal/);
      expect(byName(w, run).notes).toMatch(/Chat model/);
      const approve = byName(w, `Approve steps (${d})`);
      expect(targets(w, run)[1]).toEqual([approve.name]);
      expect(approve).toMatchObject({ type: EXECUTE, typeVersion: 1.2, parameters: APPROVE_PARAMETERS });
      expect(approve.notes).toMatch(/RPA: 3 Approve steps/);
      const pick = byName(w, `Pick RPA: 3 Approve steps (${d})`);
      expect(pick.type).toBe(STICKY);
      expect((pick.parameters as { color: number }).color).toBe(COLOUR.gold);
      expect(content(pick)).toContain(`**Approve steps (${d})**`);
      expect(content(pick)).toContain('**RPA: 3 Approve steps**');
      // Near its Run steps: below it, left of the next column.
      for (const n of [byName(w, `Chat model (${d})`), approve, pick]) {
        expect(n.position[1]).toBeGreaterThan(byName(w, run).position[1]);
        expect(n.position[0]).toBeGreaterThanOrEqual(byName(w, run).position[0] - 100);
        expect(n.position[0]).toBeLessThan(byName(w, run).position[0] + 200);
      }
    }
    // Data still goes on: Log in → Call; the If's true branch → Export → the wait after the If.
    expect(targets(w, 'Log in')[0]).toEqual(['Call']);
    expect(targets(w, 'If x')).toEqual([['Get active steps (m-2)'], ['Approve steps']]);
    expect(targets(w, 'Export')[0]).toEqual(['Approve steps']);
    // A project node already called Approve steps keeps that name; the generator's are labelled with their draft.
    expect(byName(w, 'Approve steps').type).toBe('n8n-nodes-base.wait');
    // The Chat model and Approve steps match template 2's node shapes (template 2 picks its approval workflow by name only).
    const t2 = (type: string) => TEMPLATE_2.nodes.find((n) => n.type === type)!;
    expect([t2(CHAT).typeVersion, t2(CHAT).parameters]).toEqual([1.5, CHAT_PARAMETERS]);
    expect([t2(EXECUTE).typeVersion, t2(EXECUTE).parameters]).toEqual([1.2, APPROVE_PARAMETERS]);
    expect(TEMPLATE_2.connections['Chat model']).toEqual({ ai_languageModel: [[{ node: 'Run steps', type: 'ai_languageModel', index: 0 }]] });
    // No credential anywhere: Set once names the Chat models and the Approve steps to finish.
    expect(JSON.stringify(w)).not.toMatch(/"credentials"|anthropicApi/);
    const setOnce = content(byName(w, 'Set once'));
    expect(setOnce).toContain('**Chat model** (your model provider): **Chat model (m-1)**, **Chat model (m-2)**');
    expect(setOnce).toContain('**Approve steps (m-1)**, **Approve steps (m-2)**: choose **RPA: 3 Approve steps**');
    expect(content(byName(w, 'About this import'))).toMatch(/AI Repair is on/);
  });

  it('the Goal is never project text that could be an expression', () => {
    for (const name of ['a{{ $env.X }}', 'b}}{{', 'c']) {
      const w = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: '={{ $env.AWS_SECRET_ACCESS_KEY }}' }]), [draft(`${name}-1`)], { name });
      lint(w);
      const run = w.nodes.find((n) => n.type === NODE_TYPE)!;
      const goal = run.parameters.goal as string;
      expect(goal.startsWith('=')).toBe(false);
      expect(goal).not.toContain('{{');
      expect(goal).not.toContain('$env');
      expect(goal).toBe(name === 'c' ? 'Do what the imported steps do: c-1' : 'Do what the imported steps do.');
    }
  });

  it('the cap counts a browser pair with its Chat model, Approve steps and sticky, and never draws half of one', () => {
    const total = 200;
    const flow = flowOf(Array.from({ length: total }, (_, i): FlowNode => ({ kind: 'browser', sequence: i + 1, displayName: `Browser ${i + 1}` })));
    const w = buildWorkflow(flow, Array.from({ length: total }, (_, i) => draft(`cap-${i + 1}`)), { name: 'cap' });
    lint(w);
    // The trigger and 99 pairs of five nodes: a 100th would take the workflow past MAX_WORKFLOW_NODES.
    const runs = w.nodes.filter((n) => n.type === NODE_TYPE);
    expect(runs).toHaveLength(99);
    expect(w.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable')).toHaveLength(99);
    expect(w.nodes.filter((n) => n.name.startsWith('Pick RPA: 3 Approve steps'))).toHaveLength(99);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 3);
    expect(content(byName(w, '101 more activities'))).toContain('see the report');
    // After a pair that did not fit, nothing smaller is drawn out of order.
    const mixed = buildWorkflow(flowOf([
      ...Array.from({ length: 497 }, (_, i): FlowNode => ({ kind: 'wait', seconds: 1, displayName: `W ${i}` })),
      { kind: 'browser', sequence: 1, displayName: 'Too big' },
      { kind: 'wait', seconds: 1, displayName: 'Small' },
    ]), [draft('mx-1')], { name: 'mx' });
    lint(mixed);
    expect(mixed.nodes.map((n) => n.name)).not.toContain('Small');
    expect(mixed.nodes.map((n) => n.name)).not.toContain('Get active steps (mx-1)');
    expect(content(byName(mixed, '2 more activities'))).toContain('see the report');
  });
});
