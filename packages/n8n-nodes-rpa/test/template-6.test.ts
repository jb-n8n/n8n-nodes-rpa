// Template 6, RPA: 6 One-time code: the workflow a person picks in Options → One-Time Code Workflow. It meets the code
// workflow's contract (codeWorkflow.ts): an Execute Workflow Trigger that gets { requestedAt, account }, exactly one
// item with code at the end, no node that pauses the execution (n8n would pause the bot's run with it), and successful
// executions not saved. Its Code nodes are run here as n8n runs them, on mail in the shapes n8n's mail nodes give.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STEPS_TABLE, STEPS_TABLE_COLUMNS } from '../nodes/Playwright/rows.js';
import { NODE_TYPE, STICKY, TYPED_CODES_COLUMNS, TYPED_CODES_TABLE, byName, evaluate, expectChecklist, load, sticky, table, targets, type Template } from './template-harness.js';

const t: Template = load('6-one-time-code.json');
const REQUESTED = '2026-11-16T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(REQUESTED) + seconds * 1000).toISOString();

type Assignment = { name: string; value: unknown; type: string };
const assignments = (name: string) => (byName(t, name).parameters.assignments as { assignments: Assignment[] }).assignments;
/** Settings as n8n sets them for one trigger item. */
function settings(trigger: Record<string, unknown>, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = { toISO: () => REQUESTED };
  const out = Object.fromEntries(assignments('Settings').map((a) => [a.name, typeof a.value === 'string' && a.value.startsWith('=') ? evaluate(a.value, { $json: trigger, $now: now }) : a.value]));
  return { ...out, ...over };
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<{ json: Record<string, unknown> }[]>;
/** Runs a Code node's JavaScript as n8n's Code node does (Run Once for All Items), with Settings as given. */
async function runCode(name: string, items: Record<string, unknown>[], s: Record<string, unknown>, sleeps: number[] = []) {
  const code = String(byName(t, name).parameters.jsCode);
  const $ = (node: string) => {
    if (node !== 'Settings') throw new Error(`the code reads ${node}`);
    return { first: () => ({ json: s }) };
  };
  const setTimeoutFake = (resolve: () => void, ms: number) => { sleeps.push(ms); resolve(); };
  return await new AsyncFunction('$input', '$', 'setTimeout', code)({ all: () => items.map((json) => ({ json })), first: () => ({ json: items[0] }) }, $, setTimeoutFake);
}

const outlook = (o: { subject: string; body: string; from?: string; seconds: number }) => ({
  subject: o.subject, bodyPreview: o.body, from: { emailAddress: { address: o.from ?? 'no-reply@example.com', name: 'Example' } }, receivedDateTime: at(o.seconds),
});

describe('6-one-time-code.json: the contract of a One-Time Code Workflow', () => {
  it('starts with an Execute Workflow Trigger that takes the item as it comes, then Settings', () => {
    const trigger = byName(t, 'Code requested');
    expect(trigger).toMatchObject({ type: 'n8n-nodes-base.executeWorkflowTrigger', parameters: { inputSource: 'passthrough' } });
    expect(targets(t, 'Code requested')).toEqual([['Settings']]);
  });

  it('saves no successful execution (the code is in its output) and no manual one; only workflows of the same owner may call it', () => {
    expect(t.settings).toMatchObject({ executionOrder: 'v1', saveDataSuccessExecution: 'none', saveManualExecutions: false, callerPolicy: 'workflowsFromSameOwner' });
  });

  it('has no node that pauses an execution: n8n would pause the bot\'s run with it and hand the RPA node no code', () => {
    for (const n of t.nodes) {
      expect(n.type, n.name).not.toBe('n8n-nodes-base.wait');
      expect(n.type, n.name).not.toBe('n8n-nodes-base.form');
      expect(n.parameters.operation, n.name).not.toBe('sendAndWait');
    }
  });

  it('one setting picks the source: email, app or typed, and any other value stops with a message', () => {
    expect(settings({}).source).toBe('email');
    const sw = byName(t, 'Which source?');
    const rules = (sw.parameters.rules as { values: { outputKey: string; conditions: { conditions: { leftValue: string; rightValue: string; operator: { operation: string } }[] } }[] }).values;
    expect(rules.map((r) => [r.outputKey, r.conditions.conditions[0].leftValue, r.conditions.conditions[0].operator.operation, r.conditions.conditions[0].rightValue])).toEqual([
      ['email', '={{ $json.source }}', 'equals', 'email'], ['app', '={{ $json.source }}', 'equals', 'app'], ['typed', '={{ $json.source }}', 'equals', 'typed'],
    ]);
    expect(sw.parameters.options).toMatchObject({ fallbackOutput: 'extra' });
    expect(targets(t, 'Which source?')).toEqual([['Read new mail'], ['Create steps table'], ['Create typed codes table'], ['Unknown source']]);
    expect(byName(t, 'Unknown source').parameters.errorMessage).toBe('In Settings, source must be email, app or typed.');
  });

  it('every source ends at its own Set node that returns code and nothing else', () => {
    for (const name of ['Return the mail code', 'Return the app code', 'Return the typed code']) {
      expect(assignments(name).map((a) => a.name), name).toEqual(['code']);
      expect(byName(t, name).parameters).not.toHaveProperty('includeOtherFields');
      expect(t.connections[name], name).toBeUndefined();
    }
    expect(byName(t, 'Return the typed code').executeOnce).toBe(true);
  });

  it('Settings takes requestedAt and account from the request, and the app entry is the account until changed', () => {
    const s = settings({ requestedAt: REQUESTED, account: 'user-a' });
    expect(s).toMatchObject({ requestedAt: REQUESTED, account: 'user-a', appEntry: 'user-a', appSteps: 'authenticator-code', lookBackSeconds: 30, giveUpSeconds: 100 });
    // Executed by hand in the editor, the trigger has no item: the request is now, and there is no account.
    expect(settings({})).toMatchObject({ requestedAt: REQUESTED, account: '', appEntry: '' });
  });

  it('gives up before the RPA node\'s Code Timeout (120 seconds by default)', () => {
    expect(Number(settings({}).giveUpSeconds)).toBeLessThan(120);
  });
});

describe('6-one-time-code.json: a code from an email', () => {
  const s = settings({ requestedAt: REQUESTED, account: 'user-a' }, { sender: 'no-reply@example.com' });

  it('Read new mail is n8n\'s Microsoft Outlook Get Many, off until a person picks a mail account, and lists mail since the request', () => {
    const n = byName(t, 'Read new mail');
    expect(n).toMatchObject({ type: 'n8n-nodes-base.microsoftOutlook', typeVersion: 2, disabled: true, alwaysOutputData: true });
    expect(n).not.toHaveProperty('credentials');
    expect(n.parameters).toMatchObject({ resource: 'message', operation: 'getAll', returnAll: false, limit: 10, output: 'fields' });
    expect(n.parameters.fields).toEqual(expect.arrayContaining(['subject', 'bodyPreview', 'from', 'receivedDateTime']));
    const f = (n.parameters.filtersUI as { values: { filterBy: string; filters: { receivedAfter: string; sender: string } } }).values;
    expect(f.filterBy).toBe('filters');
    const $ = () => ({ first: () => ({ json: s }) });
    expect(evaluate(f.filters.receivedAfter, { $ })).toBe(at(-30));
    // No sender filter there: Outlook matches it against the display name too. The address is checked whole after it.
    expect(Object.keys(f.filters)).toEqual(['receivedAfter']);
    expect(targets(t, 'Read new mail')).toEqual([['Find the code in the mail']]);
  });

  it('takes the code from the newest mail since the request whose subject has subjectHas', async () => {
    const mails = [
      outlook({ subject: 'Your sign-in code', body: 'Your code is 111111.', seconds: -120 }),
      outlook({ subject: 'Your sign-in code', body: 'Your code is 222222. It expires in 10 minutes.', seconds: 3 }),
      outlook({ subject: 'Your sign-in code', body: 'Your code is 333333.', seconds: -20 }),
      outlook({ subject: 'Newsletter', body: 'Order 444444 shipped', seconds: 5 }),
    ];
    expect(await runCode('Find the code in the mail', mails, s)).toEqual([{ json: { code: '222222', notFromSender: 0 } }]);
  });

  it('the sender is required: with sender empty the email source stops with one sentence', async () => {
    const mail = outlook({ subject: 'Your code', body: '666666', seconds: 2 });
    for (const sender of ['', '  ', ' , ']) {
      await expect(runCode('Find the code in the mail', [mail], { ...s, sender })).rejects.toThrow('In Settings, set sender to the address the site sends its code mail from.');
    }
    expect(settings({}).sender).toBe('');
  });

  it('takes a mail only from an address in sender, compared whole and without case; a list of a few addresses works', async () => {
    const mails = [
      outlook({ subject: 'Your code', body: '555555', from: 'other@example.net', seconds: 4 }),
      outlook({ subject: 'Your code', body: '666666', from: 'No-Reply@Example.com', seconds: 2 }),
    ];
    expect(await runCode('Find the code in the mail', mails, { ...s, sender: 'NO-REPLY@example.com' })).toEqual([{ json: { code: '666666', notFromSender: 1 } }]);
    expect(await runCode('Find the code in the mail', mails, { ...s, sender: 'alerts@example.com, other@example.net' })).toEqual([{ json: { code: '555555', notFromSender: 1 } }]);
  });

  it('refuses a lookalike: a display name or a From text that holds the address, an address that only contains it', async () => {
    const lookalikes: Record<string, unknown>[] = [
      // Outlook: the name says the site, the address is another.
      { subject: 'Your code', bodyPreview: '999999', receivedDateTime: at(3), from: { emailAddress: { name: 'no-reply@example.com', address: 'someone@attacker.example' } } },
      // A From header whose display name holds the address, in quotes and in angle brackets.
      { Subject: 'Your code', snippet: '999999', internalDate: String(Date.parse(at(3))), From: '"no-reply@example.com via x" <someone@attacker.example>' },
      { Subject: 'Your code', snippet: '999999', internalDate: String(Date.parse(at(3))), From: '"<no-reply@example.com>" <someone@attacker.example>' },
      { Subject: 'Your code', snippet: '999999', internalDate: String(Date.parse(at(3))), From: 'no-reply@example.com <someone@attacker.example>' },
      // Addresses that contain the address, and a From text with no address of its own.
      { Subject: 'Your code', Snippet: '999999', Created: at(3), From: { Address: 'no-reply@example.com.attacker.example' } },
      { Subject: 'Your code', Snippet: '999999', Created: at(3), From: { Address: 'x.no-reply@example.com' } },
      { Subject: 'Your code', snippet: '999999', internalDate: String(Date.parse(at(3))), From: 'no-reply@example.com via attacker' },
      // Gmail's full shape with two addresses in From: none is taken.
      { subject: 'Your code', text: '999999', date: at(3), from: { value: [{ address: 'no-reply@example.com' }, { address: 'someone@attacker.example' }] } },
    ];
    for (const mail of lookalikes) expect(await runCode('Find the code in the mail', [mail], s), JSON.stringify(mail)).toEqual([{ json: { code: '', notFromSender: 1 } }]);
    // The same shapes from the address itself are taken.
    for (const from of ['Example <no-reply@example.com>', 'no-reply@example.com', '"Example, Inc." <NO-REPLY@example.com>']) {
      expect(await runCode('Find the code in the mail', [{ Subject: 'Your code', snippet: '424242', internalDate: String(Date.parse(at(3))), From: from }], s), from)
        .toEqual([{ json: { code: '424242', notFromSender: 0 } }]);
    }
    expect(await runCode('Find the code in the mail', [{ subject: 'Your code', text: '434343', date: at(3), from: { value: [{ address: 'no-reply@example.com' }] } }], s))
      .toEqual([{ json: { code: '434343', notFromSender: 0 } }]);
  });

  it('ignores a mail from the sender received before the request, less lookBackSeconds', async () => {
    const old = outlook({ subject: 'Your code', body: '313131', seconds: -31 });
    expect(await runCode('Find the code in the mail', [old], s)).toEqual([{ json: { code: '', notFromSender: 0 } }]);
    expect(await runCode('Find the code in the mail', [old, outlook({ subject: 'Your code', body: '323232', seconds: -29 })], s)).toEqual([{ json: { code: '323232', notFromSender: 0 } }]);
  });

  it('reads the shapes of Gmail\'s Get Many and of a mail API\'s list too', async () => {
    const gmail = { Subject: 'Your code', snippet: 'Use 777777 to sign in', From: 'Example <no-reply@example.com>', internalDate: String(Date.parse(at(1))) };
    expect(await runCode('Find the code in the mail', [gmail], s)).toEqual([{ json: { code: '777777', notFromSender: 0 } }]);
    const plain = { Subject: 'Your code', Snippet: 'Use 888888 to sign in', From: { Address: 'no-reply@example.com' }, Created: at(1) };
    expect(await runCode('Find the code in the mail', [plain], s)).toEqual([{ json: { code: '888888', notFromSender: 0 } }]);
    // A mail API's answer through an HTTP Request: one item that lists the mails under messages, or under value (Graph).
    expect(await runCode('Find the code in the mail', [{ total: 2, messages: [{ ...plain, Created: at(-200) }, plain] }], s)).toEqual([{ json: { code: '888888', notFromSender: 0 } }]);
    expect(await runCode('Find the code in the mail', [{ value: [outlook({ subject: 'Your code', body: '135790', seconds: 2 })] }], s)).toEqual([{ json: { code: '135790', notFromSender: 0 } }]);
  });

  it('a code in an HTML body, and a pattern with a group: the group is the code', async () => {
    const mail = { ...outlook({ subject: 'Your code', body: '', seconds: 1 }), body: { content: '<p>Code:</p><b>123456</b>' } };
    expect(await runCode('Find the code in the mail', [mail], s)).toEqual([{ json: { code: '123456', notFromSender: 0 } }]);
    const both = outlook({ subject: 'Your code', body: 'Ref 000001 code: 24681357', seconds: 1 });
    expect(await runCode('Find the code in the mail', [both], { ...s, codePattern: 'code: (\\d{8})' })).toEqual([{ json: { code: '24681357', notFromSender: 0 } }]);
  });

  it('no fitting mail yet: code is empty, and Mail code found? sends the loop round again', async () => {
    expect(await runCode('Find the code in the mail', [{}], s)).toEqual([{ json: { code: '', notFromSender: 0 } }]);
    expect(targets(t, 'Mail code found?')).toEqual([['Return the mail code'], ['Wait, then read again']]);
    expect(targets(t, 'Wait, then read again')).toEqual([['Read new mail']]);
  });

  it('with Read new mail still off, the request item comes through: the message says to turn it on', async () => {
    await expect(runCode('Find the code in the mail', [s], s)).rejects.toThrow('Read new mail is off. Open it, pick your mail account and turn it on, or change source in Settings.');
  });

  it('Wait, then read again waits 5 seconds, and after giveUpSeconds stops with a message', async () => {
    const sleeps: number[] = [];
    expect(await runCode('Wait, then read again', [{ code: '' }], { ...s, startedAt: new Date().toISOString() }, sleeps)).toEqual([{ json: { tryAgain: true } }]);
    expect(sleeps).toEqual([5000]);
    const late = { ...s, startedAt: new Date(Date.now() - 101_000).toISOString() };
    await expect(runCode('Wait, then read again', [{ code: '', notFromSender: 0 }], late)).rejects.toThrow(
      'No code mail came from no-reply@example.com in 100 seconds. Check sender and subjectHas in Settings.',
    );
    await expect(runCode('Wait, then read again', [{ code: '', notFromSender: 2 }], late)).rejects.toThrow(
      'No code mail came from no-reply@example.com in 100 seconds. Mails from other addresses were left alone. Check sender and subjectHas in Settings.',
    );
  });
});

describe('6-one-time-code.json: a code from an authenticator app on the Windows machine', () => {
  it('runs the approved desktop steps named appSteps, signed steps required, with the entry for this account', () => {
    expect(table(byName(t, 'Create steps table'))).toMatchObject({ resource: 'table', operation: 'create' });
    expect(byName(t, 'Create steps table').parameters).toMatchObject({ tableName: STEPS_TABLE, options: { createIfNotExists: true } });
    expect((byName(t, 'Create steps table').parameters.columns as { column: { name: string }[] }).column.map((c) => c.name)).toEqual(STEPS_TABLE_COLUMNS.map((c) => c.name));
    const get = table(byName(t, 'Get app steps'));
    expect(get.dataTableId.value).toBe(STEPS_TABLE);
    expect(get.filters?.conditions).toEqual([
      { keyName: 'name', condition: 'eq', keyValue: "={{ $('Settings').first().json.appSteps }}" }, { keyName: 'status', condition: 'eq', keyValue: 'active' },
    ]);
    const run = byName(t, 'Read the code from the app');
    expect(run).toMatchObject({ type: NODE_TYPE, typeVersion: 2 });
    expect(run).not.toHaveProperty('credentials');
    expect(run.parameters).toMatchObject({
      operation: 'runSteps', runsOn: 'desktop', requireSignedSteps: true, aiRepair: false,
      options: { name: "={{ $('Settings').first().json.appSteps }}", expectedVersion: '={{ $json.version }}', variables: { values: [{ name: 'entryName', value: "={{ $('Settings').first().json.appEntry }}" }] } },
    });
    expect(assignments('Return the app code')[0].value).toBe("={{ $json.values?.code ?? '' }}");
  });

  it('the sample steps it names open the app, find the entry, copy its code and read the clipboard as code', () => {
    const doc = JSON.parse(readFileSync(new URL('../../../docs/samples/authenticator-code.steps.json', import.meta.url), 'utf8')) as { surface: string; name: string; steps: Record<string, unknown>[] };
    expect(doc.surface).toBe('desktop');
    expect(doc.name).toBe(settings({}).appSteps);
    expect(JSON.stringify(doc)).toContain('{{var.entryName}}');
    expect(doc.steps.at(-1)).toMatchObject({ read: { clipboard: true, as: 'code' } });
  });
});

describe('6-one-time-code.json: a code typed by a person', () => {
  const s = settings({ requestedAt: REQUESTED, account: 'user-a' });
  const row = (id: number, code: string, seconds: number, account = '') => ({ id, code, account, createdAt: at(seconds), updatedAt: at(seconds) });

  it('the Type a code form opens with n8n sign-in, for people who may run this workflow, and keeps the code in its own table', () => {
    const form = byName(t, 'Type a code');
    // n8n 2.45's Form Trigger takes its address from options.path (a path at the top is ignored: the form would sit at its webhook id).
    expect(form).toMatchObject({ type: 'n8n-nodes-base.formTrigger', typeVersion: 2.6, parameters: { authentication: 'n8nUserAuth', requireExecuteAccess: true, options: { path: 'rpa-one-time-code' } } });
    expect(form.parameters).not.toHaveProperty('path');
    const fields = (form.parameters.formFields as { values: { fieldName: string; requiredField: boolean }[] }).values;
    expect(fields.map((f) => [f.fieldName, f.requiredField])).toEqual([['code', true], ['account', false]]);
    expect(targets(t, 'Type a code')).toEqual([['Create typed codes table for the form']]);
    expect(targets(t, 'Create typed codes table for the form')).toEqual([['Keep the typed code']]);
    for (const name of ['Create typed codes table', 'Create typed codes table for the form']) {
      expect(byName(t, name).parameters).toMatchObject({ resource: 'table', operation: 'create', tableName: TYPED_CODES_TABLE, options: { createIfNotExists: true } });
      expect((byName(t, name).parameters.columns as { column: { name: string }[] }).column.map((c) => c.name)).toEqual(TYPED_CODES_COLUMNS);
    }
    const keep = table(byName(t, 'Keep the typed code'));
    expect(keep).toMatchObject({ resource: 'row', operation: 'insert', dataTableId: { value: TYPED_CODES_TABLE } });
    const $ = () => ({ first: () => ({ json: { code: ' 123 456 ', account: ' user-a ' } }) });
    expect(evaluate(String(keep.columns!.value.code), { $ })).toBe('123456');
    expect(evaluate(String(keep.columns!.value.account), { $ })).toBe('user-a');
  });

  it('takes the newest code typed since the request, for this account or for none', async () => {
    const rows = [row(1, '111111', -120), row(2, '222222', 2, 'user-b'), row(3, '333 333', 3), row(4, '444444', 1, 'USER-A ')];
    expect(await runCode('Find the typed code', rows, s)).toEqual([{ json: { code: '333333', id: 3 } }]);
    expect(await runCode('Find the typed code', [row(4, '444444', 1, 'user-a'), row(2, '222222', 2, 'user-b')], s)).toEqual([{ json: { code: '444444', id: 4 } }]);
    expect(await runCode('Find the typed code', [row(1, '111111', -120)], s)).toEqual([{ json: { code: '' } }]);
    expect(await runCode('Find the typed code', [{}], s)).toEqual([{ json: { code: '' } }]);
  });

  it('a code is used once: it is removed before it is returned; none yet: the loop looks again every 5 seconds', () => {
    expect(targets(t, 'Typed code found?')).toEqual([['Remove the typed code'], ['Wait, then look again']]);
    const remove = byName(t, 'Remove the typed code');
    expect(table(remove)).toMatchObject({ resource: 'row', operation: 'deleteRows', dataTableId: { value: TYPED_CODES_TABLE }, filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: '={{ $json.id }}' }] } });
    expect(remove.alwaysOutputData).toBe(true);
    expect(targets(t, 'Remove the typed code')).toEqual([['Return the typed code']]);
    expect(assignments('Return the typed code')[0].value).toBe("={{ $('Find the typed code').last().json.code }}");
    expect(targets(t, 'Wait, then look again')).toEqual([['Get typed codes']]);
    expect(String(byName(t, 'Wait, then look again').parameters.jsCode)).toContain('No code was typed within ${s.giveUpSeconds} seconds. Open the Type a code form while the bot waits.');
  });
});

describe('6-one-time-code.json: what a person reads', () => {
  it('a Set once checklist, in the order a person acts', () => {
    const set = sticky(t, 'Set once').content;
    expectChecklist(set);
    for (const text of ['`source`', '**Read new mail**', 'docs/samples/authenticator-code.steps.json', '**Type a code**', 'Publish this workflow', '**Options → One-Time Code Workflow**']) expect(set).toContain(text);
    // n8n's Import from File drops a workflow's own settings (n8n 2.45, seen live): the note asks for the one that matters.
    expect(set).toContain('set **Save successful production executions** to **Do not save**');
    expect(set.indexOf('Publish this workflow')).toBeLessThan(set.indexOf('One-Time Code Workflow'));
  });

  it('promises nothing', () => {
    const text = t.nodes.map((n) => `${n.notes ?? ''} ${n.type === STICKY ? (n.parameters as { content: string }).content : ''}`).join(' ');
    expect(text).not.toMatch(/\b(secure|safe|guarantee)/i);
  });
});
