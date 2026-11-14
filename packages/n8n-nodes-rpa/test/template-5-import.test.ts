// Template 5, the import form: the import, the download page, the review page and signing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { changeList, reviewSteps } from '../nodes/Playwright/format.js';
import { shownUrl } from 'n8n-rpa-engine';
import { APPROVER } from './fixtures.js';
import { type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import { adoptDraft as realAdoptDraft, buildProposal, createMasker, IMPORT_NOT_ADOPTABLE, IMPORT_ROWS_NEED_ID, notReplayedProposal, parseScript, proposalDigest, validateScript, type AdoptInput, type AdoptResult, type Script } from 'n8n-rpa-engine';
import { nodeOutputs } from '../nodes/Playwright/description/io.js';
import { STEPS_TABLE } from '../nodes/Playwright/rows.js';
import { template5 as t, CHROME, COMPARED, COMPLETION, type FormField, LEFT_OUT_HEADING, NODE_TYPE, NOT_ADOPTABLE, NOT_REPLAYED_LINE, REVIEW, SITE, STICKY, byName, changePath, changedUpload, compared, completion, escapeHtml, evaluate, failure, fields, form, formItem, imp, importedRecording, jsonFormFields, line, load, loadInN8n, nodesRan, render, resolved, review, reviewFields, runImport, settingsJson, signAfterReview, signedIn, sticky, table, targets, uipathZip } from './template-harness.js';

describe('5-import-a-bot.json (the first-day import)', () => {
  const SOURCES = { 'Work it out from the file': 'auto', 'Chrome Recorder': 'chrome', 'Playwright code': 'playwright', 'UiPath project': 'uipath', 'Step document': 'steps', 'RPA recording': 'recording' };

  it('the import template wires the form, Settings, Import steps, the review page and Sign steps; approval by email is a switched-off hand-off', () => {
    expect(form).toMatchObject({ type: 'n8n-nodes-base.formTrigger', typeVersion: 2.6 });
    expect(imp).toMatchObject({ type: NODE_TYPE, typeVersion: 2, onError: 'continueErrorOutput' });
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
    // An approved bot found: Sign steps checks it before the change page. One that does not fit this form asks the
    // person why before any step is shown (IB-4).
    expect(targets(t, 'Approved bot found?')).toEqual([['The approved version'], ['No approved bot']]);
    expect(targets(t, 'Change page next?')).toEqual([['Fits this form?'], [REVIEW]]);
    expect(targets(t, 'Fits this form?')).toEqual([['Change or sign again'], ['Approved on another form?']]);
    expect(targets(t, 'Approved on another form?')).toEqual([['Sign it again here?']]);
    expect(targets(t, 'Sign it again here?')).toEqual([['Change or sign again'], ['Change it on its own form']]);
    expect(targets(t, 'Change it on its own form')).toEqual([]);
    expect(targets(t, 'Change or sign again')).toEqual([['Choice fits the box?']]);
    expect(targets(t, 'Choice fits the box?')).toEqual([['Change values?'], ['Page answered?']]);
    expect(targets(t, 'Page answered?')).toEqual([['Change or sign again'], ['Choice and box differ']]);
    expect(targets(t, 'Choice and box differ')).toEqual([]);
    // Change values: the values page, then the approved steps with those values put in, to the same comparison; a value
    // refused, or the page not answered, ends on a page of its own.
    expect(targets(t, 'Change values?')).toEqual([['Change values'], ['Compared with the approved version']]);
    expect(targets(t, 'Change values')).toEqual([['Values to steps']]);
    expect(targets(t, 'Values to steps')).toEqual([['Values taken?']]);
    expect(targets(t, 'Values taken?')).toEqual([['Compared with the approved version'], ['Value not taken']]);
    expect(targets(t, 'Value not taken')).toEqual([]);
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
    expect(targets(t, 'Checked?')).toEqual([['Change page next?'], ['Signed?']]);
    // v1 order runs the topmost child's branch to its end first: every step list is signed and saved before the last page.
    // Once the review page is answered, the steps table is read again, and only if no other approval or rejection of a
    // name on the page came first do Step lists (to sign) and the last pages follow (IB-5).
    expect(targets(t, REVIEW)).toEqual([['Versions now']]);
    expect(targets(t, 'Versions now')).toEqual([['Still the next version?']]);
    expect(targets(t, 'Still the next version?')).toEqual([['Step lists', 'Workflow file?'], ['Approved meanwhile']]);
    expect(targets(t, 'Approved meanwhile')).toEqual([]);
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
      'Add the login page', 'Address with values', 'Approval by email?', 'Approve on this form?', 'Approve steps', 'Approved bot found?', 'Approved bots', 'Approved meanwhile', 'Approved on another form?', 'Asks about a download?', 'Change an approved bot?',
      'Change it on its own form', 'Change or sign again', 'Change page next?', 'Change values', 'Change values?', 'Checked?', 'Choice and box differ', 'Choice fits the box?', 'Compared with the approved version', 'Compared with the running version', 'Create run log table', 'Create steps table', 'Fits this form?', 'Import a bot', 'Import failed', 'Import steps', 'Imported', 'Imported, with the workflow file', 'Missing login page?',
      'No approved bot', 'Page answered?', 'Plain address?', 'Read the upload', 'Record rejection', REVIEW, 'Running versions', 'Save signed steps', 'Settings', 'Sign it again here?', 'Sign steps', 'Signed?', 'Step lists', 'Step lists to sign', 'Still the next version?', 'Supersede older versions',
      'The approved version', 'The bot to change', 'The file it downloads', 'The steps as a file', 'The upload', 'Value not taken', 'Values taken?', 'Values to steps', 'Versions now', 'What it replaces', 'Workflow file?',
    ]);
    expect(t.nodes.filter((n) => n.type === COMPLETION).map((n) => n.typeVersion)).toEqual(Array(15).fill(2.5));
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
    // The review page only after Import steps: the check before the change page goes to Fits this form? instead.
    expect(into(REVIEW)).toEqual([['Change page next?', 1]]);
    expect(into('Change page next?')).toEqual([['Checked?', 0]]);
    const reviewNext = (byName(t, 'Change page next?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect([true, false].map((imported) => evaluate(reviewNext, { $: (n: string) => ({ isExecuted: n === 'Import steps' ? imported : true }) }))).toEqual([false, true]);
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
      // Older: saved before this row. Of two approvals saved at the same moment, the one saved last stays active (IB-5).
      { keyName: 'id', condition: 'lt', keyValue: '={{ $json.id }}' },
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
        // The recorder's bar marks Vendor Row 1 (found by its row); the page says so in the same quiet style (IW-6).
        'Click Search', 'Click Vendor Row 1 <em>· found by its row: at each run it acts on whatever is in that row</em>', 'Click File', added('Wait for the next window of erpdemo.exe'), 'Click Export...', added('Wait for the window Export line items'),
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
    expect(fields[2].html).toBe('<p><em>Ticked steps are allowed to save or send. Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.</em></p>');
    // No candidate to tick: the box for numbers, and the same rule in its own words.
    const noTicks = reviewFields({ $: nodesRan({ ...ran, 'Import steps': [[{ json: data[0].json }], [{ json: { ...item, writeCandidates: [] } }]] }) });
    expect(noTicks.find((x) => String(x.html ?? '').startsWith('<p><em>'))?.html).toBe('<p><em>The steps you list here are allowed to save or send. Any other step is stopped when it uses a button or key your administrator protected on the bot machine. While none is protected, nothing is stopped.</em></p>');
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
    const BLOCK = `\n\n${name} types a secret. In n8n, make an RPA Secret Variables credential (+ → New credential), or add these to the one you have for this app or site; select it on the bot's RPA node, and copy these into it:`
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

  it('a description that states another value than the step holds is a warning: a quoted text, an ISO date, a number of three or more digits (IB-6)', () => {
    const one = (step: IDataObject, startUrl?: string) => reviewSteps([step], { desktop: false, shownUrl, ...(startUrl ? { startUrl } : {}) })[0];
    const to = (value: string) => ({ fill: { field: { label: 'To' }, value } });
    // The live case: the value changed, the description kept the old one. It was quiet; now it is a warning.
    expect(one({ intent: 'Type into To: "2026-09-30"', ...to('2026-09-15') })).toEqual({ text: 'Type into To: "2026-09-15"', describedAs: 'Type into To: "2026-09-30"', marks: [] });
    for (const [intent, step, quiet] of [
      // Quoted text: held by a field (case aside, a part of a value counts), or not.
      ['Type into To: "2026-09-15" (the month end)', to('2026-09-15'), true],
      ['Click "line item report" for the month', { click: { role: 'button', name: 'Line Item Report' } }, true],
      ['Click “Execute”', { click: { role: 'button', name: 'Run' } }, false],
      ['Click "Line Item Report"', { click: { role: 'button', name: 'G/L Line Items' } }, false],
      // An ISO date or a number of three or more digits, outside quotes.
      ['Set the end date to 2026-09-30', to('2026-09-15'), false],
      ['Set the end date to 2026-09-15', to('2026-09-15'), true],
      ['Enter company 2000', { fill: { field: { label: 'Company' }, value: '3000' } }, false],
      ['Enter company 2000', { fill: { field: { label: 'Company' }, value: '2000' } }, true],
      ['Open page 100', { goto: 'https://a.example/list?page=100' }, true],
      // Fewer than three digits, a host's port and an address are not values: hosts are checked on their own.
      ['Enter 12 rows', { fill: { field: { label: 'Rows' }, value: '50' } }, true],
      ['Open http://sandbox:8080/acme/login', { goto: '/acme/login' }, true],
      ['Open the list on sandbox:8080', { goto: '/acme/list' }, true],
      // Nothing quoted or stated: quiet, as before.
      ['Type the end date', to('2026-09-15'), true],
    ] as const) {
      const r = one({ intent, ...step }, 'http://sandbox:8080/');
      expect(r.describedAs, intent).toBe(intent);
      expect(r.quiet === true, intent).toBe(quiet);
    }
    // Desktop steps alike: the control's name and the value are the step's own fields.
    const save = (intent: string) => ({ intent, click: { uia: { path: [{ name: 'Save' }] } } });
    expect(reviewSteps([save('Click "Save" to keep it'), save('Click "Save all"'), save('Post it for 2026-09-30')], { desktop: true }).map((r) => r.quiet === true)).toEqual([true, false, false]);
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

  it('a description that quotes the old value is red on the review page, and Sign steps rebuilds it the same and signs (IB-6)', async () => {
    const save = (company: string) => ({ intent: 'Click "Save" for company 2000', click: { uia: { path: [{ name: `Save ${company}` }] } } });
    const doc = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [save('2000')] };
    const fixed = { ...doc, steps: [save('3000')] };
    const { ran } = changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: JSON.stringify(doc), status: 'active' }]);
    const [data, repaired] = await runImport(changedUpload(ran, JSON.stringify(fixed)), () => {
      throw new Error('desktop steps are never replayed');
    }, ran);
    expect(data[0].json.error).toBeUndefined();
    expect(repaired[0].json.reviewSteps).toEqual([{ text: 'Click Save 3000', describedAs: 'Click "Save" for company 2000', marks: [] }]);
    const after = { ...ran, 'Change or sign again': [[{ json: { changedSteps: JSON.stringify(fixed) } }]], [COMPARED]: [[{ json: compared(ran, JSON.stringify(fixed)) }]], 'Import steps': [data, repaired] };
    expect(String(reviewFields({ $: nodesRan(after) })[0].html)).toContain('<strong>(described differently as: Click &quot;Save&quot; for company 2000)</strong>');
    const signed = await signAfterReview(after, { decision_0: 'Approve and sign' });
    expect(signed.errors).toEqual([]);
    expect(signed.signed[0]).toMatchObject({ status: 'active', version: 2 });
    // An item whose page showed that description quietly (made by an earlier version) is refused: it was shown as less.
    const quiet = { ...repaired[0], json: { ...repaired[0].json, reviewSteps: [{ text: 'Click Save 3000', describedAs: 'Click "Save" for company 2000', quiet: true, marks: [] }] } };
    const refused = await signAfterReview({ ...after, 'Import steps': [data, [quiet]] }, { decision_0: 'Approve and sign' });
    expect(refused.signed).toEqual([]);
    expect(String(refused.errors[0].error)).toContain('the steps shown for approval are not the steps to sign');
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
});
