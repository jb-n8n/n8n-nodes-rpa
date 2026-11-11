import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Workflow, type IConnections, type INode, type INodeProperties, type INodeTypes } from 'n8n-workflow';
import { importSource, type Draft, type FlowNode, type ImportOptions, type UiPathFlow } from 'n8n-rpa-engine';
import { bound } from '../../engine/test/timing.js';
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
  // Off until a person sets the time (ScheduleTrigger.node.ts at tag n8n@2.41.0 has versions 1 to 1.2 and later).
  'n8n-nodes-base.scheduleTrigger': 1.2,
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
  // Runs as generated: no repair branch, so no Chat model (a credential) and no Approve steps (a workflow to pick); each
  // browser Run steps' note says how to add it. Only the Data output is connected.
  const runs = w.nodes.filter((x) => x.type === NODE_TYPE);
  for (const n of runs) {
    expect(n.parameters.aiRepair, n.name).toBe(false);
    expect(n.parameters, n.name).not.toHaveProperty('goal');
    expect(models(w, n.name), n.name).toEqual([]);
    expect(targets(w, n.name).length, n.name).toBeLessThanOrEqual(1);
    if (!n.credentials) expect(n.notes, n.name).toContain('To let it repair itself when the site changes:\n1. Connect a chat model to its Model input (after step 2).\n2. Turn on AI Repair here and write the Goal in plain words.\n3. Connect its Repaired Steps output to an Execute Workflow node that calls RPA: 3 Approve steps.');
  }
  expect(w.nodes.filter((x) => x.type === CHAT || x.type === EXECUTE)).toEqual([]);
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
      ['On a schedule', 'n8n-nodes-base.scheduleTrigger'],
      ['Get active steps (sap-report-1)', 'n8n-nodes-base.dataTable'],
      ['Use Browser Chrome: SAP Logon', NODE_TYPE],
      ['Upload line items to S3', 'n8n-nodes-base.awsS3'],
      ['If many line items', 'n8n-nodes-base.if'],
      ['Send SMTP Mail Message', 'n8n-nodes-base.emailSend'],
      ['Delay', 'n8n-nodes-base.wait'],
      ['Notify the region', 'n8n-nodes-base.httpRequest'],
      ['Read Range', 'n8n-nodes-base.extractFromFile'],
    ]);
    expect(targets(w, 'Run the bot')).toEqual([['Get active steps (sap-report-1)']]);
    // The Schedule Trigger starts the same nodes, and is off until a person sets the time.
    expect(targets(w, 'On a schedule')).toEqual([['Get active steps (sap-report-1)']]);
    expect(byName(w, 'On a schedule')).toMatchObject({ disabled: true, parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 6 }] } } });
    expect(byName(w, 'On a schedule').notes).toBe('Set the time, then turn this node on and publish the workflow. Until then the bot runs only when you click Execute.');
    expect(content(byName(w, 'About this import'))).toContain('**On a schedule** is off: set the time, turn it on and publish the workflow.');
    expect(targets(w, 'Get active steps (sap-report-1)')).toEqual([['Use Browser Chrome: SAP Logon']]);
    // Data (0) feeds the next node; there is no repair branch.
    expect(targets(w, 'Use Browser Chrome: SAP Logon')).toEqual([['Upload line items to S3']]);
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
    // Run steps: signed steps from that row, Name and Expected Version, AI Repair off (it runs as generated).
    expect(byName(w, 'Use Browser Chrome: SAP Logon').parameters).toEqual({
      operation: 'runSteps',
      steps: "={{ $json.steps ?? '' }}",
      requireSignedSteps: true,
      signature: '={{ $json.signature }}',
      approvedBy: '={{ $json.approvedBy }}',
      aiRepair: false,
      // The run variables the steps type, empty for the person to fill in (none is secret here).
      options: { name: 'sap-report-1', expectedVersion: '={{ $json.version }}', variables: { values: [{ name: 'company', value: '' }, { name: 'from', value: '' }, { name: 'to', value: '' }] } },
    });
    expect(byName(w, 'Use Browser Chrome: SAP Logon').notes).toMatch(/sap-report-1/);
    // Allow Private Network is never set: the note says when a person may need it.
    expect(byName(w, 'Use Browser Chrome: SAP Logon').notes).toContain('For a site on your own network, turn on Options → Allow Private Network here.');
    expect(JSON.stringify(w)).not.toContain('allowPrivateNetwork');

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
      operation: 'runSteps', steps: "={{ $json.steps ?? '' }}", requireSignedSteps: true, signature: '={{ $json.signature }}', approvedBy: '={{ $json.approvedBy }}', aiRepair: false,
      options: { name: 'sap-report-1', expectedVersion: '={{ $json.version }}' },
    });
    for (const [from, byType] of Object.entries(w.connections)) {
      expect(workflow.getNode(from)).not.toBeNull();
      for (const outs of Object.values(byType)) for (const out of outs ?? []) for (const c of out) expect(workflow.getNode(c.node)).not.toBeNull();
    }
    // No Model input and no repair branch: the workflow runs as generated.
    expect(workflow.getParentNodes('Use Browser Chrome: SAP Logon', 'ai_languageModel')).toEqual([]);
    // Every working node is reachable from the trigger, the Chat model through the Run steps it serves; no sticky is connected.
    const reached = new Set(workflow.getChildNodes('Run the bot'));
    for (const n of working(w).filter((x) => !['Run the bot', 'On a schedule'].includes(x.name) && x.type !== CHAT)) expect(reached, n.name).toContain(n.name);
    expect(workflow.getChildNodes('On a schedule')).toEqual(workflow.getChildNodes('Run the bot'));
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
    expect(working(h).map((n) => n.name).slice(2, 4)).toEqual(['Wait', 'Wait 2']);
    for (const n of h.nodes) expect(n.name.length).toBeLessThanOrEqual(100);
    expect(targets(h, 'Run the bot')).toEqual([['Wait']]);

    const empty = buildWorkflow(flowOf([]), [], { name: 'e' });
    lint(empty);
    expect(working(empty).map((n) => n.name)).toEqual(['Run the bot', 'On a schedule']);
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
    expect(working(w).map((n) => n.name)).toEqual(['Run the bot', 'On a schedule', 'Set once 2', 'About this import 2']);
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
    expect(ms).toBeLessThan(bound(2000));
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 4);
    // The two triggers count as nodes, so 498 activities are drawn; the sticky counts the rest.
    const drawn = stickies(w).filter((n) => n.name.startsWith('Not translated: ')).length;
    expect(drawn).toBe(MAX_WORKFLOW_NODES - 2);
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
    expect(performance.now() - started).toBeLessThan(bound(2000));
    lint(w);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 4);
    expect(targets(w, 'Run the bot')).toEqual([['If 299']]);
    const drawn = working(w).length - 2;
    const rest = (300 + 2_000 + 1_000 - drawn).toLocaleString('en-US');
    expect(content(byName(w, `${rest} more activities`))).toContain('see the report');
    expect(w.nodes.map((n) => n.name)).not.toContain('After 0');
  });
  it('each browser Run steps runs as generated: no Chat model, no Approve steps, AI Repair off, and a note that says how to add self-repair', () => {
    const w = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Log in' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'Call' },
      { kind: 'if', expression: 'x', then: [{ kind: 'browser', sequence: 2, displayName: 'Export' }], else: [], displayName: 'If x' },
    ]), [draft('m-1'), draft('m-2')], { name: 'm' });
    lint(w);
    for (const run of ['Log in', 'Export']) {
      expect(byName(w, run).parameters).toMatchObject({ aiRepair: false });
      expect(targets(w, run)).toHaveLength(run === 'Log in' ? 1 : 0);
      expect(String(byName(w, run).notes).split('\n').slice(1)).toEqual([
        'To let it repair itself when the site changes:', '1. Connect a chat model to its Model input (after step 2).',
        '2. Turn on AI Repair here and write the Goal in plain words.', '3. Connect its Repaired Steps output to an Execute Workflow node that calls RPA: 3 Approve steps.',
      ]);
    }
    // Nothing in the file asks for a credential or a workflow beyond what Set once names.
    const set = content(byName(w, 'Set once'));
    expect(set).toContain('- **RPA Browser**, **RPA Site Login** and **RPA Step Signing**');
    expect(set).not.toMatch(/Chat model|choose \*\*RPA: 3/);
    expect(content(byName(w, 'About this import'))).toContain('AI Repair is off: each Run steps\' note says how to let it repair itself when the site changes');
  });
  it('an import that took its code from a workflow gives each Run steps the same One-Time Code Workflow, and Code Timeout when it was not the default', () => {
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }, { kind: 'browser', sequence: 2, displayName: 'Export' }]);
    const runOptions = (w: WorkflowJson, run: string) => (byName(w, run).parameters as { options: Record<string, unknown> }).options;
    const set = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id: 'wf-code-1', timeoutSeconds: 45 } });
    lint(set);
    // The option is n8n's workflow picker: written in the picker's own form, by ID.
    for (const run of ['Log in', 'Export']) expect(runOptions(set, run)).toMatchObject({ codeWorkflowId: { __rl: true, mode: 'id', value: 'wf-code-1' }, codeTimeout: 45 });
    const plainTimeout = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id: 'wf-code-1', timeoutSeconds: 120 } });
    expect(runOptions(plainTimeout, 'Log in')).toMatchObject({ codeWorkflowId: { __rl: true, mode: 'id', value: 'wf-code-1' } });
    expect(runOptions(plainTimeout, 'Log in')).not.toHaveProperty('codeTimeout');
    const none = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm' });
    expect(runOptions(none, 'Log in')).not.toHaveProperty('codeWorkflowId');
    // An ID that would read as an n8n expression is left out, never written as one.
    for (const id of ['={{ $json.id }}', 'a{{ b }}']) {
      expect(runOptions(buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id, timeoutSeconds: 120 } }), 'Log in')).not.toHaveProperty('codeWorkflowId');
    }
  });

  it('the run options the import was proven with go to every Run steps: Max Seconds when not the default, Also Allow These Sites on browser steps', () => {
    const runOptions = (w: WorkflowJson, run: string) => (byName(w, run).parameters as { options: Record<string, unknown> }).options;
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]);
    const w = buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { maxSeconds: 240, allowedHosts: ['cdn.example.com', 'static.example.com'] } });
    expect(runOptions(w, 'Log in')).toMatchObject({ maxSeconds: 240, allowedHosts: 'cdn.example.com, static.example.com' });
    const plain = buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { maxSeconds: 180, allowedHosts: [] } });
    expect(runOptions(plain, 'Log in')).not.toHaveProperty('maxSeconds');
    expect(runOptions(plain, 'Log in')).not.toHaveProperty('allowedHosts');
    // A host that n8n would read as an expression is not written.
    expect(runOptions(buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { allowedHosts: ['={{ 1 }}'] } }), 'Log in')).not.toHaveProperty('allowedHosts');
  });

  it('a desktop step list starts its variables with their recorded values; a value n8n would read as an expression starts empty; a secret is never listed', () => {
    const desktop = {
      name: 'd', writeCandidates: [], variables: ['company', 'odd', 'password'], secretVariables: ['password'],
      startValues: { company: '2000', odd: '={{ $env.HOME }}' },
      script: { surface: 'desktop' as const, name: 'd', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Type', fill: { field: { uia: { path: [{ name: 'x' }] } }, value: '{{var.company}}' } }] },
    };
    const w = buildWorkflow({ name: 'd', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'Desk', draft: 'd' }] }, [], { name: 'd', desktopDrafts: [desktop], source: 'recording' });
    const run = byName(w, 'Desk');
    expect((run.parameters as { options: Record<string, unknown> }).options.variables).toEqual({ values: [{ name: 'company', value: '2000' }, { name: 'odd', value: '' }] });
    expect(JSON.stringify(w)).not.toContain('$env');
    expect(content(byName(w, 'Fill in the variables (d)'))).toContain('Options → Variables: `company` (starts as `2000`), `odd`. Secret: `password`');
  });

  it('the notes say only what applies: no variables, no gold note; only secret ones, no Variables to fill in; the legend names the colours there are', () => {
    const desktop = (variables: string[], secretVariables: string[]) => ({
      name: 'd', writeCandidates: [], variables, secretVariables,
      script: { surface: 'desktop' as const, name: 'd', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click OK', click: { uia: { path: [{ name: 'OK' }] } } }] },
    });
    const build = (d: ReturnType<typeof desktop>) => buildWorkflow({ name: 'd', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'Desk', draft: 'd' }] }, [], { name: 'd', desktopDrafts: [d], source: 'recording' });
    const none = build(desktop([], []));
    expect(none.nodes.some((n) => n.name.startsWith('Fill in the variables'))).toBe(false);
    expect(byName(none, 'Desk').notes).toBe('Runs the signed desktop steps d (1 step imported from the recording "Desk") on the desktop runner. Pick the RPA Desktop Runner and RPA Step Signing credentials.');
    const about = content(byName(none, 'About this import'));
    expect(about).toContain('Green: set once. Text from the recording is kept as text');
    expect(about).not.toContain('Gold');
    const secretOnly = build(desktop(['password'], ['password']));
    expect(byName(secretOnly, 'Desk').notes).not.toContain('Fill in the Variables');
    expect(content(byName(secretOnly, 'Fill in the variables (d)'))).toBe(
      '### Fill in the variables (gold)\nSecret: `password`: in an **RPA Secret Variables** credential selected on **Desk**, never typed here. Desktop steps run only once approved: import the recording with **RPA: 5 Import a bot** and approve `d` on its review page.',
    );
    expect(content(byName(secretOnly, 'About this import'))).toContain('Gold: fill in. Green: set once.');
    // A UiPath project with nothing left untranslated has no grey notes to explain.
    const uipath = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]), [draft('m-1')], { name: 'm' });
    expect(content(byName(uipath, 'About this import'))).toContain('Green: set once. UiPath expressions are kept as text in notes');
    expect(content(byName(uipath, 'About this import'))).not.toContain('Grey notes');
  });

  it('no project text reaches a Run steps parameter: no Goal is written, and a name that holds {{ stays text', () => {
    for (const name of ['a{{ $env.X }}', 'b}}{{', 'c']) {
      const w = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: '={{ $env.AWS_SECRET_ACCESS_KEY }}' }]), [draft(`${name}-1`)], { name });
      lint(w);
      const run = w.nodes.find((n) => n.type === NODE_TYPE)!;
      expect(run.parameters).not.toHaveProperty('goal');
      // The Name is a literal (it never starts with "="), so n8n reads it as text.
      expect((run.parameters.options as { name: string }).name).toBe(`${name}-1`);
    }
  });

  it('the cap counts a browser pair as its two nodes and never draws half of one', () => {
    const total = 300;
    const flow = flowOf(Array.from({ length: total }, (_, i): FlowNode => ({ kind: 'browser', sequence: i + 1, displayName: `Browser ${i + 1}` })));
    const w = buildWorkflow(flow, Array.from({ length: total }, (_, i) => draft(`cap-${i + 1}`)), { name: 'cap' });
    lint(w);
    // The two triggers and 249 pairs of two nodes: a 250th would take the workflow past MAX_WORKFLOW_NODES.
    const runs = w.nodes.filter((n) => n.type === NODE_TYPE);
    expect(runs).toHaveLength(249);
    expect(w.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable')).toHaveLength(249);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 3);
    expect(content(byName(w, '51 more activities'))).toContain('see the report');
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
