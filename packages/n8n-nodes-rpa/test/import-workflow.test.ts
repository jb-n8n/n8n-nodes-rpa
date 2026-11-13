import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Workflow, type IConnections, type INode, type INodeProperties, type INodeTypes } from 'n8n-workflow';
import { importSource, type Draft, type FlowNode, type ImportOptions, type UiPathFlow } from 'n8n-rpa-engine';
import { bound } from '../../engine/test/timing.js';
import { zip } from '../../engine/test/zip-fixtures.js';
import { buildWorkflow, fromRow, jsName, LOG_FAILED_ROW, LOGGED_MESSAGE_CHARS, LOG_RUN_ROW, MAX_WORKFLOW_NODES, STOP_MESSAGE, workflowFile, type WorkflowJson, type WorkflowNode } from '../nodes/Playwright/import/workflow.js';
import { RPA_NODE_TYPE } from '../nodes/Playwright/node-type.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, RUN_TABLE_FIRST_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { CONFIG_GUIDANCE, GUIDANCE } from '../nodes/Playwright/errors.js';
import { WORKFLOW_NODE_TYPES } from './fixtures.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string };
const NODE_TYPE = `${PACKAGE.name}.playwright`;
const STICKY = 'n8n-nodes-base.stickyNote';
const COLOUR = { green: 4, gold: 2, grey: 7 } as const;
/**
 * The only n8n expressions a generated workflow holds: the signed row Run steps reads from its own Get active steps, by
 * that node's name (escaped by jsName). UiPath text never becomes one.
 */
const OWN_EXPRESSION = /^=\{\{ \$\('(?:[A-Za-z0-9 _.,:()-]|\\u[0-9a-f]{4})*'\)\.first\(\)\.json\.(?:steps \?\? ''|signature|approvedBy|version) \}\}$/;
/** Run steps' four values, read from the Get active steps named `get`. */
const rowRead = (get: string) => ({ steps: fromRow(get, 'steps'), signature: fromRow(get, 'signature'), approvedBy: fromRow(get, 'approvedBy'), expectedVersion: fromRow(get, 'version') });
/** S3's Input Binary Field: the name Run steps gave its last file, with the imported draft's name as the fallback. */
const FILE_EXPRESSION = /^=\{\{ \$json\.files\?\.at\(-1\)\?\.binaryProperty \?\? 'file_\d+' \}\}$/;
/**
 * The run log's expressions: the two rows (each reads the item it gets, the execution's id and Create run log table's
 * columns) and Stop and Error's message (the row Log failed run shaped).
 */
const LOG_EXPRESSIONS = [LOG_RUN_ROW, LOG_FAILED_ROW, STOP_MESSAGE];
const own = (v: string) => OWN_EXPRESSION.test(v) || LOG_EXPRESSIONS.includes(v) || FILE_EXPRESSION.test(v);
const LOG_NODES = ['Create run log table', 'Log run', 'Write run row', 'Log failed run', 'Write failed run row', 'Stop and Error'];
const REPAIR_NOTE = 'To let it repair itself when the site changes:\n1. Connect a chat model to its Model input (after step 2).\n2. Turn on AI Repair here and write the Goal in plain words. The outputs become Data, Repaired Steps and error.\n3. Connect its Repaired Steps output to an Execute Workflow node that calls RPA: 3 Approve steps, and its error output to Log failed run again.';

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
    expect(WORKFLOW_NODE_TYPES[n.type], `${n.name}: ${n.type}`).toBe(n.typeVersion);
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
  expect(text).not.toMatch(/"secretKey"|"password"|"token"|"connectionLine"/);
  // Credentials only on RPA nodes, in n8n's own form: an id (or null) and a name, never a value.
  for (const n of w.nodes) {
    if (!n.credentials) continue;
    expect(n.type, n.name).toBe(NODE_TYPE);
    for (const c of Object.values(n.credentials)) expect(Object.keys(c).sort(), n.name).toEqual(['id', 'name']);
  }
  // The only node an expression names ($('…')) is the Get active steps that feeds a Run steps, its name escaped (jsName).
  // The run log's own expressions name two nodes of the generator's: Create run log table and Log failed run.
  for (const n of w.nodes) for (const [, v] of strings(n.parameters)) if (v.startsWith('=') && /\$\(/.test(v) && !LOG_EXPRESSIONS.includes(v)) expect(v).toMatch(OWN_EXPRESSION);
  for (const n of w.nodes.filter((x) => x.type === NODE_TYPE)) {
    const feeds = Object.entries(w.connections).filter(([, c]) => c.main?.some((out) => out.some((t) => t.node === n.name))).map(([from]) => from);
    expect(feeds, n.name).toHaveLength(1);
    expect(byName(w, feeds[0]).name, n.name).toMatch(/^Get active steps \(/);
    const p = n.parameters as { steps: string; signature: string; approvedBy: string; options: { expectedVersion: string } };
    expect({ steps: p.steps, signature: p.signature, approvedBy: p.approvedBy, expectedVersion: p.options.expectedVersion }, n.name).toEqual(rowRead(feeds[0]));
  }
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
  // browser Run steps' note says how to add it. Data feeds the flow and Log run; the error output feeds Log failed run.
  const runs = w.nodes.filter((x) => x.type === NODE_TYPE);
  for (const n of runs) {
    expect(n.parameters.aiRepair, n.name).toBe(false);
    expect(n.parameters, n.name).not.toHaveProperty('goal');
    expect(n.onError, n.name).toBe('continueErrorOutput');
    const [data, error] = targets(w, n.name);
    expect(data.at(-1), n.name).toBe('Log run');
    expect(data.length, n.name).toBeLessThanOrEqual(2);
    expect(error, n.name).toEqual(['Log failed run']);
    if (!n.credentials?.rpaDesktopRunnerApi) expect(n.notes, n.name).toContain(REPAIR_NOTE);
  }
  // The run log is there exactly when a Run steps is.
  for (const name of LOG_NODES) expect(w.nodes.some((x) => x.name === name), name).toBe(runs.length > 0);
  // Main connections only: no node feeds a Model input.
  for (const byType of Object.values(w.connections)) expect(Object.keys(byType)).toEqual(['main']);
  // Data Tables: only known tables and columns.
  for (const n of w.nodes.filter((x) => x.type === 'n8n-nodes-base.dataTable')) {
    const p = n.parameters as { tableName?: string; dataTableId?: { value: string }; filters?: { conditions: { keyName: string }[] }; columns?: { value?: Record<string, string> } };
    const table = p.tableName ?? p.dataTableId?.value ?? '';
    expect(columnsOf[table], n.name).toBeDefined();
    for (const c of p.filters?.conditions ?? []) expect(columnsOf[table]).toContain(c.keyName);
    for (const c of Object.keys(p.columns?.value ?? {})) expect(columnsOf[table]).toContain(c);
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
    expect(content(w.nodes[0])).toContain('- Runs the approved steps `sap-report-1`, imported from the UiPath project `SAP Line Item Report`.');
    expect(content(w.nodes[1])).toMatch(/RPA Browser/);
    expect(content(w.nodes[1])).toMatch(/RPA Site Login/);
    expect(content(w.nodes[1])).toMatch(/RPA Step Signing/);
    expect(content(w.nodes[1])).toMatch(/AWS/);
    expect(content(w.nodes[1])).toMatch(/SMTP/);

    // The working nodes, in flow order, with their types.
    expect(working(w).map((n) => [n.name, n.type])).toEqual([
      ['Run the bot', 'n8n-nodes-base.manualTrigger'],
      ['On a schedule', 'n8n-nodes-base.scheduleTrigger'],
      ['Create run log table', 'n8n-nodes-base.dataTable'],
      ['Get active steps (sap-report-1)', 'n8n-nodes-base.dataTable'],
      ['sap-report-1', NODE_TYPE],
      ['Upload line items to S3', 'n8n-nodes-base.awsS3'],
      ['If many line items', 'n8n-nodes-base.if'],
      ['Send SMTP Mail Message', 'n8n-nodes-base.emailSend'],
      ['Delay', 'n8n-nodes-base.wait'],
      ['Notify the region', 'n8n-nodes-base.httpRequest'],
      ['Read Range', 'n8n-nodes-base.extractFromFile'],
      ['Log run', 'n8n-nodes-base.set'],
      ['Write run row', 'n8n-nodes-base.dataTable'],
      ['Log failed run', 'n8n-nodes-base.set'],
      ['Write failed run row', 'n8n-nodes-base.dataTable'],
      ['Stop and Error', 'n8n-nodes-base.stopAndError'],
    ]);
    expect(targets(w, 'Run the bot')).toEqual([['Create run log table']]);
    expect(targets(w, 'Create run log table')).toEqual([['Get active steps (sap-report-1)']]);
    // The Schedule Trigger starts the same nodes, and is off until a person sets the time.
    expect(targets(w, 'On a schedule')).toEqual([['Create run log table']]);
    expect(byName(w, 'On a schedule')).toMatchObject({ disabled: true, parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 6 }] } } });
    expect(byName(w, 'On a schedule').notes).toBe('Set the time, then turn this node on and publish the workflow. Until then the bot runs only when you click Execute.');
    expect(content(byName(w, 'About this import'))).toContain('- **Run the bot** runs it now. **On a schedule** is off: set the time, turn it on, publish.');
    expect(targets(w, 'Get active steps (sap-report-1)')).toEqual([['sap-report-1']]);
    // Data (0) feeds the next node and the run log; there is no repair branch; the error output feeds the failure log.
    expect(targets(w, 'sap-report-1')).toEqual([['Upload line items to S3', 'Log run'], ['Log failed run']]);
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
    expect(byName(w, 'sap-report-1').parameters).toEqual({
      operation: 'runSteps',
      runsOn: 'browser',
      // Read from Get active steps by its name, so a node put between the two (one item per account) changes nothing.
      steps: "={{ $('Get active steps (sap-report-1)').first().json.steps ?? '' }}",
      requireSignedSteps: true,
      signature: "={{ $('Get active steps (sap-report-1)').first().json.signature }}",
      approvedBy: "={{ $('Get active steps (sap-report-1)').first().json.approvedBy }}",
      aiRepair: false,
      // The run variables the steps type, empty for the person to fill in (none is secret here).
      options: { name: 'sap-report-1', expectedVersion: "={{ $('Get active steps (sap-report-1)').first().json.version }}", variables: { values: [{ name: 'company', value: '' }, { name: 'from', value: '' }, { name: 'to', value: '' }] } },
    });
    expect(byName(w, 'sap-report-1').notes).toMatch(/sap-report-1/);
    // Allow Private Network is not set (this import had it off): the note says when a person may need it.
    expect(byName(w, 'sap-report-1').notes).toContain('For a site on your own network, turn on Options → Allow Private Network here.');
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
    expect(content(cred)).toContain('UiPath credential `SAP_Login`: the RPA Site Login on the Run steps node(s) holds that login. n8n never copies a UiPath credential. Pick one there.');
    expect(cred.position[0]).toBeGreaterThan(byName(w, 'Run the bot').position[0]);
    expect(cred.position[0]).toBeLessThan(get.position[0]);

    // The loop is inline, with a sticky naming the original loop around its body.
    const loop = byName(w, 'Loop: For Each region');
    expect(content(loop)).toContain('`{"EMEA", "AMER"}`');
    expect(loop.position[0]).toBeLessThan(byName(w, 'Notify the region').position[0]);

    // Left to right: each working node in the main line sits right of the one before it.
    const line = ['Run the bot', 'Create run log table', 'Get active steps (sap-report-1)', 'sap-report-1', 'Upload line items to S3', 'If many line items', 'Notify the region', 'Read Range'];
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
    const run = workflow.getNode('sap-report-1');
    expect(run?.parameters).toMatchObject({
      operation: 'runSteps', runsOn: 'browser', requireSignedSteps: true, aiRepair: false,
      steps: fromRow('Get active steps (sap-report-1)', 'steps'), signature: fromRow('Get active steps (sap-report-1)', 'signature'), approvedBy: fromRow('Get active steps (sap-report-1)', 'approvedBy'),
      options: { name: 'sap-report-1', expectedVersion: fromRow('Get active steps (sap-report-1)', 'version') },
    });
    for (const [from, byType] of Object.entries(w.connections)) {
      expect(workflow.getNode(from)).not.toBeNull();
      for (const outs of Object.values(byType)) for (const out of outs ?? []) for (const c of out) expect(workflow.getNode(c.node)).not.toBeNull();
    }
    // No Model input and no repair branch: the workflow runs as generated.
    expect(workflow.getParentNodes('sap-report-1', 'ai_languageModel')).toEqual([]);
    // Every working node is reachable from the trigger; no sticky is connected.
    const reached = new Set(workflow.getChildNodes('Run the bot'));
    for (const n of working(w).filter((x) => !['Run the bot', 'On a schedule'].includes(x.name))) expect(reached, n.name).toContain(n.name);
    expect(workflow.getChildNodes('On a schedule')).toEqual(workflow.getChildNodes('Run the bot'));
    for (const s of stickies(w)) expect(reached.has(s.name)).toBe(false);
    expect(workflow.getParentNodes('Run the bot')).toEqual([]);
  });

  it('no secret or credential value appears in the workflow JSON, and without passed-on credentials none is attached', () => {
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
    // A step list's own name and its variables' names are written into parameters as they are: the same rule, checked here too.
    const hostileName = '={{ $env.SECRET }}';
    expect(() => buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'B', draft: hostileName }]), [draft(hostileName)], { name: 'ok' })).toThrow(/Name of a step list/);
    const desk = (name: string, variables: string[]) => ({
      name, writeCandidates: [], variables, secretVariables: [],
      script: { surface: 'desktop' as const, name, version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
    });
    const deskFlow = (name: string) => ({ name: 'ok', nodes: [{ kind: 'desktop' as const, sequence: 1, displayName: 'Desk', draft: name }] });
    expect(() => buildWorkflow(deskFlow(hostileName), [], { name: 'ok', desktopDrafts: [desk(hostileName, [])], source: 'recording' })).toThrow(/Name of a step list/);
    expect(() => buildWorkflow(deskFlow('ok'), [], { name: 'ok', desktopDrafts: [desk('ok', ['={{ $env.SECRET }}'])], source: 'recording' })).toThrow(/variable's name/);
    expect(() => buildWorkflow(deskFlow('ok'), [], { name: 'ok', desktopDrafts: [desk('ok', ['a b'])], source: 'recording' })).toThrow(/variable's name/);
    const fine = buildWorkflow(deskFlow('ok'), [], { name: 'ok', desktopDrafts: [desk('ok', ['invoice_no'])], source: 'recording' });
    expect((byName(fine, 'Desk').parameters as { options: { variables: { values: Array<{ name: string }> } } }).options.variables.values).toEqual([{ name: 'invoice_no', value: '' }]);
  });

  it('Run steps reads the signed row from its Get active steps by name: a node put between them changes nothing, and a name cannot break out', () => {
    /** Evaluates one of Run steps' values as n8n does, with `$` giving each node's first item and `$json` the node's own input. */
    const read = (expression: string, nodes: Record<string, object>, input: object): unknown =>
      new Function('$', '$json', `return (${expression.slice(4, -3)});`)((name: string) => {
        if (!(name in nodes)) throw new Error(`no node named ${name}`);
        return { first: () => ({ json: nodes[name] }) };
      }, input);
    const row = { name: 'bot', version: 3, steps: '{"steps":[]}', signature: 'sig', approvedBy: 'owner@example.com' };
    for (const source of ['steps', 'chrome', 'recording', 'uipath'] as const) {
      const w = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'bot', draft: 'bot' }]), [draft('bot')], { name: 'bot', source });
      const p = byName(w, 'bot').parameters as { steps: string; signature: string; approvedBy: string; options: { expectedVersion: string } };
      // Each account's item (the many-accounts shape) is Run steps' input: the four values still come from the row.
      for (const account of [{ username: 'summit-ops', password: 'x' }, { username: 'lakeside-ops', password: 'y' }]) {
        const nodes = { 'Get active steps (bot)': row };
        expect([p.steps, p.signature, p.approvedBy, p.options.expectedVersion].map((e) => read(e, nodes, account)), source).toEqual([row.steps, 'sig', 'owner@example.com', 3]);
      }
      // Before a version is approved, Get active steps gives one empty item: Steps is empty, as before.
      expect(read(p.steps, { 'Get active steps (bot)': {} }, {})).toBe('');
    }
    // A name with quotes, a backslash, "$", "{{" and "}}" stays one string: the expression names exactly that node.
    const odd = `it's a \\ $bot }} {{ $env.X }} 'x'`;
    const w = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'Run', draft: odd }]), [draft(odd)], { name: 'odd', source: 'steps' });
    lint(w);
    const get = `Get active steps (${odd})`;
    expect(byName(w, get).type).toBe('n8n-nodes-base.dataTable');
    const p = byName(w, 'Run').parameters as { signature: string };
    expect(p.signature).not.toContain('}} {{');
    expect(p.signature).not.toContain("'x'");
    expect(read(p.signature, { [get]: row }, {})).toBe('sig');
    expect(jsName('Get active steps (sap-report-1)')).toBe("'Get active steps (sap-report-1)'");
    // A desktop Run steps reads the same way.
    const desktop = {
      name: 'd', writeCandidates: [], variables: [], secretVariables: [],
      script: { surface: 'desktop' as const, name: 'd', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
    };
    const d = buildWorkflow({ name: 'd', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'Desk', draft: 'd' }] }, [], { name: 'd', desktopDrafts: [desktop], source: 'recording' });
    const dp = byName(d, 'Desk').parameters as { signature: string; options: { expectedVersion: string } };
    expect(read(dp.options.expectedVersion, { 'Get active steps (d)': row }, { username: 'a' })).toBe(3);
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
    expect(content(byName(h, 'Not translated: Browser'))).toContain('no step list named n-2');
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
    expect(w.nodes.filter((n) => n.type === RPA_NODE_TYPE).map((n) => n.name)).toEqual(['sap-report-1']);
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
    expect(content(byName(w, 'About this import'))).toContain(`and ${rest} more not drawn (see the report): rebuild that by hand.`);
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
    for (const run of ['m-1', 'm-2']) {
      expect(byName(w, run).parameters).toMatchObject({ aiRepair: false });
      expect(targets(w, run)).toEqual([run === 'm-1' ? ['Call', 'Log run'] : ['Log run'], ['Log failed run']]);
      expect(String(byName(w, run).notes).split('\n').slice(1)).toEqual(REPAIR_NOTE.split('\n'));
    }
    // Nothing in the file asks for a credential or a workflow beyond what Set once names.
    const set = content(byName(w, 'Set once'));
    expect(set).toContain('- **RPA Browser**, **RPA Site Login** and **RPA Step Signing**');
    expect(set).not.toMatch(/Chat model|choose \*\*RPA: 3/);
    expect(content(byName(w, 'About this import'))).toContain('- For self-repair when the site changes, see the browser guide, Part 2.');
  });
  it('an import that took its code from a workflow gives each Run steps the same One-Time Code Workflow, and Code Timeout when it was not the default', () => {
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }, { kind: 'browser', sequence: 2, displayName: 'Export' }]);
    const runOptions = (w: WorkflowJson, run: string) => (byName(w, run).parameters as { options: Record<string, unknown> }).options;
    const set = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id: 'wf-code-1', timeoutSeconds: 45 } });
    lint(set);
    // The option is n8n's workflow picker: written in the picker's own form, by ID.
    for (const run of ['m-1', 'm-2']) expect(runOptions(set, run)).toMatchObject({ codeWorkflowId: { __rl: true, mode: 'id', value: 'wf-code-1' }, codeTimeout: 45 });
    const plainTimeout = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id: 'wf-code-1', timeoutSeconds: 120 } });
    expect(runOptions(plainTimeout, 'm-1')).toMatchObject({ codeWorkflowId: { __rl: true, mode: 'id', value: 'wf-code-1' } });
    expect(runOptions(plainTimeout, 'm-1')).not.toHaveProperty('codeTimeout');
    const none = buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm' });
    expect(runOptions(none, 'm-1')).not.toHaveProperty('codeWorkflowId');
    // An ID that would read as an n8n expression is left out, never written as one.
    for (const id of ['={{ $json.id }}', 'a{{ b }}']) {
      expect(runOptions(buildWorkflow(flow, [draft('m-1'), draft('m-2')], { name: 'm', codeWorkflow: { id, timeoutSeconds: 120 } }), 'm-1')).not.toHaveProperty('codeWorkflowId');
    }
  });

  it('the run options the import was proven with go to every Run steps: Max Seconds when not the default, Also Allow These Sites on browser steps', () => {
    const runOptions = (w: WorkflowJson, run: string) => (byName(w, run).parameters as { options: Record<string, unknown> }).options;
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]);
    const w = buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { maxSeconds: 240, allowedHosts: ['cdn.example.com', 'static.example.com'] } });
    expect(runOptions(w, 'o-1')).toMatchObject({ maxSeconds: 240, allowedHosts: 'cdn.example.com, static.example.com' });
    const plain = buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { maxSeconds: 180, allowedHosts: [] } });
    expect(runOptions(plain, 'o-1')).not.toHaveProperty('maxSeconds');
    expect(runOptions(plain, 'o-1')).not.toHaveProperty('allowedHosts');
    // A host that n8n would read as an expression is not written.
    expect(runOptions(buildWorkflow(flow, [draft('o-1')], { name: 'o', run: { allowedHosts: ['={{ 1 }}'] } }), 'o-1')).not.toHaveProperty('allowedHosts');
  });

  it('Allow Private Network is on in the browser Run steps exactly when the import had it on, as a plain true, and the note says why', () => {
    const runOptions = (w: WorkflowJson, run: string) => (byName(w, run).parameters as { options: Record<string, unknown> }).options;
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]);
    const on = buildWorkflow(flow, [draft('p-1')], { name: 'p', run: { allowPrivateNetwork: true } });
    expect(runOptions(on, 'p-1').allowPrivateNetwork).toBe(true);
    expect(byName(on, 'p-1').notes).toContain('Options → Allow Private Network is on because the import had it on: the steps may open addresses on your own network.');
    expect(byName(on, 'p-1').notes).not.toContain('turn on Options → Allow Private Network');
    // Off, not given, or anything but a plain true: never written, and the note says when to turn it on.
    for (const run of [{ allowPrivateNetwork: false }, {}, { allowPrivateNetwork: 'true' as unknown as boolean }, { allowPrivateNetwork: '={{ true }}' as unknown as boolean }]) {
      const off = buildWorkflow(flow, [draft('p-1')], { name: 'p', run });
      expect(JSON.stringify(off), JSON.stringify(run)).not.toContain('allowPrivateNetwork');
      expect(byName(off, 'p-1').notes).toContain('For a site on your own network, turn on Options → Allow Private Network here.');
    }
    const none = buildWorkflow(flow, [draft('p-1')], { name: 'p' });
    expect(JSON.stringify(none)).not.toContain('allowPrivateNetwork');
    // Desktop steps open no web address: their Run steps never gets it.
    const desktop = {
      name: 'q', writeCandidates: [], variables: [], secretVariables: [],
      script: { surface: 'desktop' as const, name: 'q', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
    };
    const d = buildWorkflow({ name: 'q', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'Desk', draft: 'q' }] }, [], { name: 'q', desktopDrafts: [desktop as never], source: 'recording', run: { allowPrivateNetwork: true } });
    expect(byName(d, 'Desk').parameters).toMatchObject({ operation: 'runSteps' });
    expect(JSON.stringify(d)).not.toContain('allowPrivateNetwork');
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
    expect(byName(none, 'Desk').notes).toBe('Runs the signed desktop steps d on the desktop runner. Pick RPA Desktop Runner and RPA Step Signing here.');
    const about = content(byName(none, 'About this import'));
    // Two colours (the two notes): no legend. A desktop bot has no repair line.
    expect(about).not.toMatch(/Gold|Green:|repair/);
    const secretOnly = build(desktop(['password'], ['password']));
    expect(byName(secretOnly, 'Desk').notes).not.toContain('Fill in the Variables');
    expect(content(byName(secretOnly, 'Fill in the variables (d)'))).toBe(
      '### Fill in the variables (gold)\nSecret: `password`: in an **RPA Secret Variables** credential selected on **Desk**, never typed here. To keep these values to this app, put `App.exe` in that credential\'s May Be Typed Into. Desktop steps run only once approved: import the recording with **RPA: 5 Import a bot** and approve `d` on its review page.',
    );
    // A gold note: three colours, so the legend.
    expect(content(byName(secretOnly, 'About this import'))).toContain('- Gold: fill in. Green: set once. Grey: leave as is.');
    // A UiPath project with nothing left untranslated has no grey notes to explain.
    const uipath = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]), [draft('m-1')], { name: 'm' });
    expect(content(byName(uipath, 'About this import'))).toContain('- 0 other activities became n8n nodes. Each one says what to check.');
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
    // The two triggers, the six run log nodes and 246 pairs of two nodes: a 247th would take the workflow past MAX_WORKFLOW_NODES.
    const runs = w.nodes.filter((n) => n.type === NODE_TYPE);
    expect(runs).toHaveLength(246);
    expect(w.nodes.filter((n) => n.type === 'n8n-nodes-base.dataTable')).toHaveLength(246 + 3);
    expect(working(w)).toHaveLength(MAX_WORKFLOW_NODES);
    expect(w.nodes.length).toBeLessThanOrEqual(MAX_WORKFLOW_NODES + 3);
    expect(content(byName(w, '54 more activities'))).toContain('see the report');
    // After a pair that did not fit, nothing smaller is drawn out of order.
    const mixed = buildWorkflow(flowOf([
      ...Array.from({ length: 491 }, (_, i): FlowNode => ({ kind: 'wait', seconds: 1, displayName: `W ${i}` })),
      { kind: 'browser', sequence: 1, displayName: 'Too big' },
      { kind: 'wait', seconds: 1, displayName: 'Small' },
    ]), [draft('mx-1')], { name: 'mx' });
    lint(mixed);
    expect(mixed.nodes.map((n) => n.name)).not.toContain('Small');
    expect(mixed.nodes.map((n) => n.name)).not.toContain('Get active steps (mx-1)');
    expect(content(byName(mixed, '2 more activities'))).toContain('see the report');
  });

  it('credentials passed on are attached in n8n\'s own form, so an id this n8n does not have still names the credential for n8n\'s fallback', () => {
    const passed = {
      browser: { id: 'b1', name: 'RPA Browser' }, siteLogin: { id: 's1', name: 'Portal login' },
      signing: { id: 'k1', name: 'RPA Step Signing' }, desktopRunner: { id: 'r1', name: 'RPA Desktop Runner' },
    };
    const desktop = {
      name: 'm-2', writeCandidates: [], variables: [], secretVariables: [],
      script: { surface: 'desktop' as const, name: 'm-2', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
    };
    const flow = flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }, { kind: 'desktop', sequence: 2, displayName: 'Desk' }, { kind: 'credential', asset: 'Portal', displayName: 'Get' }]);
    const w = buildWorkflow(flow, [draft('m-1')], { name: 'm', desktopDrafts: [desktop], credentials: passed });
    expect(byName(w, 'm-1').credentials).toEqual({ playwrightBrowserApi: passed.browser, playwrightSiteLoginApi: passed.siteLogin, playwrightScriptSigningApi: passed.signing });
    expect(byName(w, 'm-2').credentials).toEqual({ rpaDesktopRunnerApi: passed.desktopRunner, playwrightScriptSigningApi: passed.signing });
    // Each type is one the RPA node shows on Run Steps, so n8n puts it in that slot; INodeCredentialsDetails is { id, name }.
    const d = new Playwright().description;
    const runStepsTypes = (d.credentials ?? []).filter((c) => c.displayOptions?.show?.operation?.includes('runSteps') || c.displayOptions?.hide).map((c) => c.name);
    for (const run of ['m-1', 'm-2']) for (const type of Object.keys(byName(w, run).credentials ?? {})) expect(runStepsTypes, type).toContain(type);
    // Loaded by n8n-workflow as it is: the id is kept with the name. In another n8n, where id b1 does not exist, n8n's
    // editor (useNodeHelpers matchCredentials) takes the only credential of that type with the same name, else asks.
    const playwright = new Playwright();
    const nodeTypes = { getByName: (t: string) => (t === NODE_TYPE ? playwright : undefined), getByNameAndVersion: (t: string) => (t === NODE_TYPE ? playwright : undefined), getKnownTypes: () => ({}) } as unknown as INodeTypes;
    const loaded = new Workflow({ nodes: structuredClone(w.nodes) as unknown as INode[], connections: w.connections as unknown as IConnections, nodeTypes, active: false });
    expect(loaded.getNode('m-1')?.credentials?.playwrightSiteLoginApi).toEqual({ id: 's1', name: 'Portal login' });
    // The notes and stickies say what was picked and what happens elsewhere.
    expect(byName(w, 'm-1').notes).toContain('RPA Browser, RPA Site Login and RPA Step Signing are picked for you: check them.');
    expect(byName(w, 'm-2').notes).toContain('RPA Desktop Runner and RPA Step Signing are picked for you: check them.');
    const set = content(byName(w, 'Set once'));
    // Every RPA credential picked: one line, and the UiPath credential lookup (a green note in the flow) to read.
    expect(set).toBe('### Set once\nNo secret is in this file. Pick these on the nodes:\n- UiPath credential lookups (green notes in the flow): desktop steps type the sign-in from their Run steps\' Variables (a password from **RPA Secret Variables**); browser steps use the RPA Site Login on their Run steps\n'
      + '- Already set on the RPA nodes: **RPA Browser**, **RPA Site Login**, **RPA Step Signing** and **RPA Desktop Runner**');
    // Another n8n, or a deleted credential: said in docs/reference/templates.md, not on the canvas.
    expect(set).not.toContain('another n8n');
    expect(content(byName(w, 'Credential: Portal'))).not.toContain('Pick one there');
    // Only well-formed references are passed on: anything else is left for the person to pick.
    const odd = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'Log in' }]), [draft('m-1')], {
      name: 'm', credentials: { browser: { id: '', name: 'x' }, siteLogin: { id: 7 as unknown as string, name: 'y' }, signing: { id: 'k'.repeat(65), name: 'z' } },
    });
    expect(byName(odd, 'm-1').credentials).toBeUndefined();
    expect(byName(odd, 'm-1').notes).toContain('Pick RPA Browser, RPA Site Login and RPA Step Signing here.');
    expect(content(byName(odd, 'Set once'))).toContain('No secret is in this file. Pick these on the nodes:\n- **RPA Browser**, **RPA Site Login** and **RPA Step Signing**: **m-1**');
  });

  it('every run writes the run log, and a failed run still ends as failed: Create run log table → … → Run steps → Log run, error → Log failed run → Stop and Error', () => {
    const w = buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'bot', draft: 'bot' }]), [draft('bot')], { name: 'bot', source: 'chrome' });
    lint(w);
    // Small: 6 nodes before the run log (two stickies, two triggers, Get active steps, Run steps), 12 with it.
    expect(w.nodes.map((n) => n.name)).toEqual([
      'About this import', 'Set once', 'Run the bot', 'On a schedule', 'Create run log table', 'Get active steps (bot)', 'bot',
      'Log run', 'Write run row', 'Log failed run', 'Write failed run row', 'Stop and Error',
    ]);
    expect(targets(w, 'Run the bot')).toEqual([['Create run log table']]);
    expect(targets(w, 'On a schedule')).toEqual([['Create run log table']]);
    expect(targets(w, 'Create run log table')).toEqual([['Get active steps (bot)']]);
    expect(targets(w, 'bot')).toEqual([['Log run'], ['Log failed run']]);
    expect(targets(w, 'Log run')).toEqual([['Write run row']]);
    expect(targets(w, 'Log failed run')).toEqual([['Write failed run row']]);
    expect(targets(w, 'Write failed run row')).toEqual([['Stop and Error']]);
    expect(targets(w, 'Write run row')).toEqual([]);
    expect(targets(w, 'Stop and Error')).toEqual([]);
    // The table is made when missing, with the templates' columns.
    expect(byName(w, 'Create run log table').parameters).toEqual({
      resource: 'table', operation: 'create', tableName: 'playwright_runs', columns: { column: RUN_TABLE_COLUMNS.map((c) => ({ name: c.name, type: c.type })) }, options: { createIfNotExists: true },
    });
    // Log run shapes a row per run (not Execute Once: a Run steps that runs once per account logs each run); Write run
    // row writes the item it gets, column by column.
    const log = byName(w, 'Log run');
    expect(log.executeOnce).toBeUndefined();
    expect(log.parameters).toEqual({ mode: 'raw', jsonOutput: LOG_RUN_ROW, options: {} });
    const write = byName(w, 'Write run row');
    expect(write.parameters).toMatchObject({ resource: 'row', operation: 'insert', dataTableId: { __rl: true, mode: 'name', value: 'playwright_runs' }, columns: { mappingMode: 'autoMapInputData' } });
    // Write failed run row passes the item on when its write fails, so Stop and Error still runs.
    const failed = byName(w, 'Log failed run');
    expect(failed.parameters).toEqual({ mode: 'raw', jsonOutput: LOG_FAILED_ROW, options: {} });
    expect(byName(w, 'Write failed run row').onError).toBe('continueRegularOutput');
    const stop = byName(w, 'Stop and Error');
    expect(stop.type).toBe('n8n-nodes-base.stopAndError');
    expect(stop.parameters).toEqual({ errorType: 'errorMessage', errorMessage: STOP_MESSAGE });

    // The rows, evaluated as n8n does: every column for a table made now, only the table's columns for an older one.
    const columns = (names: string[]) => ({ 'Create run log table': { name: 'playwright_runs', columns: names.map((name) => ({ name })) } });
    const all = columns(RUN_TABLE_COLUMNS.map((c) => c.name));
    const first = columns(RUN_TABLE_FIRST_COLUMNS.map((c) => c.name));
    const shape = (expression: string, $json: object, nodes: Record<string, object>) =>
      new Function('$json', '$execution', '$', `return (${expression.slice(4, -3)});`)($json, { id: '22' }, (name: string) => {
        if (!(name in nodes)) throw new Error(`no node named ${name}`);
        return { first: () => ({ json: nodes[name] }) };
      }) as Record<string, unknown>;
    const lockedOut = {
      error: 'locked_out: A previous login for sandbox:8080 failed, so no login was tried.', message: 'A previous login for sandbox:8080 failed, so no login was tried.',
      details: { code: 'locked_out', name: 'bot', version: 1, hash: 'h', lane: null, durationMs: 0, llmTokens: 0, guidance: GUIDANCE.locked_out },
    };
    const failedRow = shape(LOG_FAILED_ROW, lockedOut, all);
    expect(Object.keys(failedRow)).toEqual(RUN_TABLE_COLUMNS.map((c) => c.name));
    expect(failedRow).toMatchObject({ code: 'locked_out', name: 'bot', executionId: '22', message: lockedOut.message, guidance: GUIDANCE.locked_out });
    // A long message is cut to 300 characters (a character outside the BMP counts once), so the owner's view of the
    // table stays readable; the whole message is on Run steps' error item.
    const long = 'é'.repeat(250) + '😀'.repeat(100);
    const cut = String(shape(LOG_FAILED_ROW, { ...lockedOut, message: long }, all).message);
    expect(Array.from(cut)).toHaveLength(LOGGED_MESSAGE_CHARS);
    expect(cut).toBe(`${'é'.repeat(250)}${'😀'.repeat(49)}…`);
    expect(shape(LOG_FAILED_ROW, { ...lockedOut, message: 'x'.repeat(300) }, all).message).toBe('x'.repeat(300));
    // A table made by an earlier version: the row has only its ten columns, so n8n's insert never refuses it.
    expect(Object.keys(shape(LOG_FAILED_ROW, lockedOut, first))).toEqual(RUN_TABLE_FIRST_COLUMNS.map((c) => c.name));
    expect(Object.keys(shape(LOG_RUN_ROW, { name: 'bot', lane: 'script', version: 1, hash: 'h', durationMs: 900 }, first))).toEqual(RUN_TABLE_FIRST_COLUMNS.map((c) => c.name));
    // Create run log table gives no columns (never seen in n8n): every column is written, as for a table made now.
    expect(Object.keys(shape(LOG_RUN_ROW, { name: 'bot' }, { 'Create run log table': {} }))).toEqual(RUN_TABLE_COLUMNS.map((c) => c.name));

    // A refusal before the run (locked_out: no lane) leaves lane, duration and tokens empty, and nothing was counted.
    expect(failedRow).toMatchObject({ lane: null, durationMs: null, llmTokens: null, confirmed: null, rowCount: null, version: 1, file: '', account: '' });
    // A failed run that ran keeps its lane and duration.
    expect(shape(LOG_FAILED_ROW, { ...lockedOut, details: { ...lockedOut.details, code: 'drift_detected', lane: 'script', durationMs: 1200 } }, all))
      .toMatchObject({ lane: 'script', durationMs: 1200, llmTokens: 0 });
    // A successful download: the file's name, and no row count or check (the steps read no rows).
    const download = {
      name: 'bot', lane: 'script', version: 2, hash: 'h2', confirmed: false, durationMs: 986, llmTokens: 0,
      files: [{ fileName: 'LINEITEMS_1000_2026-09-01_2026-09-30.csv', mimeType: 'text/csv', bytes: 357, binaryProperty: 'file_7' }],
    };
    expect(shape(LOG_RUN_ROW, download, all)).toEqual({
      name: 'bot', lane: 'script', version: 2, hash: 'h2', confirmed: null, rowCount: null, durationMs: 986, llmTokens: 0, code: '', executionId: '22',
      message: '', guidance: '', file: 'LINEITEMS_1000_2026-09-01_2026-09-30.csv', account: '',
    });
    // With many accounts each row names its account (Run Steps' account, the Site Login's user name).
    expect(shape(LOG_RUN_ROW, { ...download, account: 'summit-ops' }, all)).toMatchObject({ account: 'summit-ops' });
    expect(shape(LOG_FAILED_ROW, { ...lockedOut, details: { ...lockedOut.details, account: 'harbor-ops' } }, all)).toMatchObject({ account: 'harbor-ops' });
    // Rows: their count and whether it matched the stated total; no file.
    expect(shape(LOG_RUN_ROW, { ...download, files: undefined, rows: [{ id: 'N1' }, { id: 'N2' }], confirmed: false }, all)).toMatchObject({ confirmed: false, rowCount: 2, file: '' });
    expect(shape(LOG_RUN_ROW, { ...download, files: undefined, rows: [], confirmed: true }, all)).toMatchObject({ confirmed: true, rowCount: 0 });

    // Stop and Error: the code, the steps, the message and what to do, from the row Log failed run shaped.
    const message = (row: object) => shape(STOP_MESSAGE, {}, { 'Log failed run': row }) as unknown as string;
    expect(message(failedRow)).toBe(`The run failed: locked_out on bot. ${lockedOut.message} ${GUIDANCE.locked_out}`);
    expect(message(shape(LOG_FAILED_ROW, lockedOut, first))).toBe('The run failed: locked_out on bot. Run steps in this execution has the message.');
    expect(message(shape(LOG_FAILED_ROW, { error: 'Steps is empty', message: 'Steps is empty', details: { code: null, name: 'bot', guidance: CONFIG_GUIDANCE } }, all)))
      .toBe(`The run failed: config_error on bot. Steps is empty ${CONFIG_GUIDANCE}`);
    // Layout: a lone Run steps has Log run right of it and the failure row below.
    const [rx, ry] = byName(w, 'bot').position;
    expect(log.position).toEqual([rx + 240, ry]);
    expect(write.position).toEqual([rx + 480, ry]);
    expect(failed.position[1]).toBeGreaterThan(ry);
    expect(stop.position[0]).toBeGreaterThan(byName(w, 'Write failed run row').position[0]);
    // One line says where a notification goes; no email or chat node is built.
    expect(content(byName(w, 'About this import'))).toContain('- Each run writes a row to playwright_runs. Failed runs show as failed in Executions.\n- To hear of a failed run, set an Error Workflow in the workflow settings.');
    expect(w.nodes.filter((n) => n.type === 'n8n-nodes-base.emailSend')).toEqual([]);
  });

  it('the run log is shared: a UiPath flow with several Run steps has one Log run and one Log failed run, below the flow', () => {
    const desktop = {
      name: 'u-2', writeCandidates: [], variables: [], secretVariables: [],
      script: { surface: 'desktop' as const, name: 'u-2', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Click', click: { uia: { path: [{ name: 'x' }] } } }] },
    };
    const w = buildWorkflow(flowOf([
      { kind: 'browser', sequence: 1, displayName: 'Web part' },
      { kind: 'desktop', sequence: 2, displayName: 'Desk part' },
      { kind: 'http', url: 'https://api.example.com/', displayName: 'Call' },
    ]), [draft('u-1')], { name: 'u', desktopDrafts: [desktop] });
    expect(w.nodes.filter((n) => LOG_NODES.includes(n.name)).map((n) => n.name)).toEqual(LOG_NODES);
    expect(targets(w, 'u-1')).toEqual([['Get active steps (u-2)', 'Log run'], ['Log failed run']]);
    expect(targets(w, 'u-2')).toEqual([['Call', 'Log run'], ['Log failed run']]);
    expect(byName(w, 'u-2').onError).toBe('continueErrorOutput');
    const lowest = Math.max(...w.nodes.filter((n) => !LOG_NODES.includes(n.name) && n.type !== STICKY).map((n) => n.position[1]));
    expect(byName(w, 'Log run').position[1]).toBeGreaterThan(lowest);
    // A flow without a Run steps keeps no run log.
    const none = buildWorkflow(flowOf([{ kind: 'http', url: 'https://api.example.com/', displayName: 'Call' }]), [], { name: 'n' });
    lint(none);
    expect(targets(none, 'Run the bot')).toEqual([['Call']]);
    expect(content(byName(none, 'About this import'))).not.toContain('playwright_runs');
  });

  it('"About this import" stays short for every kind of generated workflow, and both notes are tall enough for their text', () => {
    const desktopDraft = (name: string, secretVariables: string[] = []) => ({
      name, writeCandidates: [], variables: secretVariables, secretVariables,
      script: { surface: 'desktop' as const, name, version: 1, app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { uia: { path: [{ name: 'Save' }] } } }] },
    });
    const PASSED = { browser: { id: 'b1', name: 'RPA Browser' }, siteLogin: { id: 's1', name: 'RPA Site Login account' }, signing: { id: 'k1', name: 'RPA Step Signing' }, desktopRunner: { id: 'r1', name: 'RPA Desktop Runner' } };
    const kinds: [string, WorkflowJson, number][] = [
      ['a recording', buildWorkflow({ name: 'ERP Demo line items', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'ERP', draft: 'erp' }] }, [], { name: 'erp', desktopDrafts: [desktopDraft('erp', ['password'])], source: 'recording', credentials: PASSED }), 6],
      ['a desktop step document', buildWorkflow({ name: 'erp', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'erp', draft: 'erp' }] }, [], { name: 'erp', desktopDrafts: [desktopDraft('erp')], source: 'steps' }), 6],
      ['a Chrome export', buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'bot', draft: 'bot' }], 'Line items'), [draft('bot')], { name: 'bot', source: 'chrome', credentials: PASSED }), 6],
      ['a browser step document', buildWorkflow(flowOf([{ kind: 'browser', sequence: 1, displayName: 'sandbox-line-items', draft: 'sandbox-line-items' }], 'sandbox-line-items'), [draft('sandbox-line-items')], { name: 'sandbox-line-items', source: 'steps', credentials: PASSED }), 6],
      // A UiPath project with both kinds, something not translated and a gold note: one line more for what was left out
      // and one for the colours.
      ['a UiPath project with both kinds', buildWorkflow(flowOf([
        { kind: 'browser', sequence: 1, displayName: 'Web' }, { kind: 'desktop', sequence: 2, displayName: 'Desk' },
        { kind: 'untranslated', activity: 'NSAPLogon', displayName: 'SAP Logon', note: 'rebuild it' },
        { kind: 'if', expression: 'x > 1', then: [], else: [], displayName: 'If' },
      ], 'SAP Line Item Report'), [draft('u-1')], { name: 'u', desktopDrafts: [desktopDraft('u-2')] }), 8],
    ];
    for (const [kind, w, most] of kinds) {
      const about = content(byName(w, 'About this import'));
      const lines = about.split('\n').slice(1);
      expect(lines.length, `${kind}:\n${about}`).toBeLessThanOrEqual(most);
      expect(lines.map((l) => l.replace(/^- /, '')).join(' ').split(/\s+/).filter(Boolean).length, `${kind}: words`).toBeLessThanOrEqual(most === 6 ? 90 : 120);
      for (const l of lines) expect(l, kind).toMatch(/^- /);
      // Plain words: no em dash, no semicolon joining sentences, and nothing about wiring.
      expect(about, kind).not.toMatch(/\u2014|; |Stop and Error|Get active steps|→/);
      // Each note is tall enough for its text, about 7 px a character at its width and 22 px a line.
      for (const name of ['About this import', 'Set once']) {
        const n = byName(w, name).parameters as { content: string; width: number; height: number };
        const perLine = Math.floor((n.width - 40) / 7);
        // As shown: the markdown's ** and ` are not drawn.
        const textLines = n.content.split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(l.replace(/[*`\\]/g, '').length / perLine)), 0);
        expect(n.height, `${kind}: ${name}`).toBeGreaterThanOrEqual(40 + textLines * 22);
      }
    }
    // Every RPA credential arrived picked: one line, and the secret variables line only where there are some.
    const set = (i: number) => content(byName(kinds[i][1], 'Set once'));
    expect(set(3)).toBe('### Set once\nNothing to pick: **RPA Browser**, **RPA Site Login** and **RPA Step Signing** are set on the RPA node.');
    expect(set(0)).toBe('### Set once\nNothing to pick: **RPA Desktop Runner** and **RPA Step Signing** are set on the RPA node.\n'
      + '- **RPA Secret Variables**, holding `password`: pick it on the Run steps that name them, and list where its values may be typed (the app or the site) in its May Be Typed Into.');
  });

  it('a start value is never shown for a variable that is secret under another casing', () => {
    const desktop = {
      name: 'c', writeCandidates: [], variables: ['Password', 'password', 'company'], secretVariables: ['password'],
      startValues: { Password: 'Hunter-2026', company: '1000' },
      script: { surface: 'desktop' as const, name: 'c', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'Type', fill: { field: { uia: { path: [{ name: 'x' }] } }, value: '{{var.company}}' } }] },
    };
    const w = buildWorkflow({ name: 'c', nodes: [{ kind: 'desktop', sequence: 1, displayName: 'Desk', draft: 'c' }] }, [], { name: 'c', desktopDrafts: [desktop], source: 'uipath' });
    expect(JSON.stringify(w)).not.toContain('Hunter-2026');
    expect((byName(w, 'Desk').parameters as { options: { variables: unknown } }).options.variables).toEqual({ values: [{ name: 'Password', value: '' }, { name: 'company', value: '1000' }] });
  });
});
