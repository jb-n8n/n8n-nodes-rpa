// Template 2, the data feed.
import { describe, expect, it } from 'vitest';
import { type IDataObject } from 'n8n-workflow';
import { type TaskResult } from 'n8n-rpa-engine';
import { nodeOutputs } from '../nodes/Playwright/description/io.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { RUN_TABLE, RUN_TABLE_FIRST_COLUMNS, STEPS_TABLE } from '../nodes/Playwright/rows.js';
import { agentOk, fakeEngine, scriptOk, taskFail } from './fake-engine.js';
import { harness } from './harness.js';
import { COLOUR, DATA_TABLE, FILES, NODE_TYPE, SETTINGS_NAME, STICKY, byName, evaluate, load, loadInN8n, render, sticky, table, targets } from './template-harness.js';

const AI_REPAIR = "={{ $('Get pending').all().filter(i => i.json.hash && DateTime.fromISO(i.json.expiresAt) > $now).length === 0 }}";

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
    expect(run).toMatchObject({ type: NODE_TYPE, typeVersion: 2, onError: 'continueErrorOutput' });
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
