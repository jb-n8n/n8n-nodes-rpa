// Template 3, approve steps, and its emails.
import { describe, expect, it } from 'vitest';
import { changeList, reviewChanges, reviewSteps } from '../nodes/Playwright/format.js';
import { describeStep, stepChanges } from 'n8n-rpa-engine';
import { APPROVER } from './fixtures.js';
import { type IDataObject } from 'n8n-workflow';
import { parseScript, scriptHash, type Proposal, type Script } from 'n8n-rpa-engine';
import { nodeOutputs } from '../nodes/Playwright/description/io.js';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { repairedStepsJson } from '../nodes/Playwright/output.js';
import { RUN_TABLE, RUN_TABLE_COLUMNS, STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { COLOUR, LEFT_OUT_HEADING, NODE_TYPE, NOT_REPLAYED_LINE, SETTINGS_NAME, STICKY, byName, evaluate, expectChecklist, jsonFormFields, load, loadInN8n, render, sticky, table, targets } from './template-harness.js';

/** Template 3's Supersede filter: up to the approved version, or every version for a first version (no base). */
const SUPERSEDE_UP_TO = "={{ $('Repaired steps received').item.json.baseVersion === null ? 2147483647 : $('Repaired steps received').item.json.version }}";
const EXPIRES_AT = "={{ $now.plus({ hours: $('Settings').item.json.approvalTimeoutHours }).toISO() }}";
/** Template 3 takes the approver from its Settings everywhere except the Approver Allowlist, which must be typed. */
const SETTINGS_APPROVER = "={{ $('Settings').item.json.approver }}";

/**
 * What template 3's approval emails make of an address in text from the steps, so that mail programs do not make a
 * link of it: a zero-width space (U+200B) inside "://" and after each ".".
 */
const unlinked = (address: string) => address.split('://').join(':\u200b//').split('.').join('.\u200b');

describe('3-approve-steps.json', () => {
  const t = load('3-approve-steps.json');
  const conditions = (name: string) => table(byName(t, name)).filters?.conditions ?? [];
  it('says "version N" in its note, subjects and texts, never "vN", and an import is not always version 1 (IB-8)', () => {
    const t = load('3-approve-steps.json');
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/[Ss]teps v\{\{/);
    expect(text).not.toContain('An import is always version 1');
    expect(sticky(t, t.nodes.find((n) => n.type === STICKY && String(n.parameters.content).includes('Supersede older versions'))!.name).content).toContain('An import gets the next version of its name.');
  });

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
    expect(render(p.subject, scope(signed))).toBe('Signed: steps version 1 for erp are active');
    // A step marked as a write changes the hash: one sentence says so.
    expect(render(p.text, scope(signed))).toBe(
      `Steps version 1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\nSigned as writes: step 16 (Click Save). The hash changed because step 16 was marked as a write.\n\nReference: hash h1, review digest d0.`,
    );
    const two = { ...signed, writeSteps: [{ step: 4, intent: 'Press Enter' }, { step: 16, intent: 'Click Save' }], writeLine: 'Signed as writes: step 4 (Press Enter), step 16 (Click Save)' };
    expect(render(p.text, scope(two)).split('\n')[1]).toBe('Signed as writes: step 4 (Press Enter), step 16 (Click Save). The hash changed because steps 4 and 16 were marked as writes.');
    const none = { ...signed, hash: 'h0', writeSteps: [], writeLine: 'Signed as writes: none' };
    expect(render(p.text, scope(none))).toBe(`Steps version 1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\nSigned as writes: none.\n\nReference: hash h0, review digest d0.`);
    // Browser steps: no write line.
    const { writeLine: _w, writeSteps: _s, ...browser } = { ...signed, hash: 'h0' };
    expect(render(p.text, scope(browser))).toBe(`Steps version 1 for erp are signed and active, approved by ${APPROVER} at 2026-10-29T12:00:00.000Z.\n\nReference: hash h0, review digest d0.`);
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
    expect(String(ask.subject)).toMatch(/^=Approve desktop steps version \{\{/);
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
    expect(message.split('\n\nClick Review and decide')[0]).toBe('Desktop steps version 1 for erp-1, for your approval.\nOpens ErpDemo.exe on the desktop runner.\nReturns a file to n8n: step 6.\n'
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
    // A step found by its row says so, as on the review page (IW-6).
    const byRow = [{ intent: 'Click Vendor Row 1', click: { uia: { path: [{ controlType: 'DataItem', name: 'Vendor Row 1' }] } } }, misleading[0]];
    expect(shownSteps({ ...fromNode, steps: { ...received.steps, steps: byRow }, reviewSteps: reviewSteps(byRow, { desktop: true }) }))
      .toBe('1. Click Vendor Row 1 (found by its row: at each run it acts on whatever is in that row)\n2. Click Post ⚠ (described differently as: Read the total)');
    expect(message).toContain('tick the steps that save, send or submit (none is ticked for you), then approve or reject.');
    expect(message).toContain('Ticked steps are allowed to save or send. Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.');
    // The full detail below: the item's own change list, evidence and flags.
    expect(message).toContain('Details of every step (how each one finds its control):\nEvidence: Not replayed\nSafety flags: desktop app: "ErpDemo.exe"\nStep 1: Wait for the window\nStep 2: Click Save \u2039b\u203a\n');
    expect(message).not.toContain('Write steps');
    const description = render(String((ask.options as IDataObject).responseFormDescription), { $ });
    expect(description).toBe('Steps version 1 for erp-1. Tick the steps that save, send or submit, from the numbered list in the email; none is ticked for you. Ticked steps are allowed to save or send. Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.');
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
    expect(out).toContain('Steps version 4‹i› for feed‹b›x‹/b›');
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
    expect(String(byName(t, 'Email repaired steps').parameters.subject)).toMatch(/^=1 of 2, review: steps version \{\{ \$json\.version \}\} for /);
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
