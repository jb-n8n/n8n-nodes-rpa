import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { adoptDraft } from '../src/import/adopt.js';
import { importSource } from '../src/import/index.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { needsApprovalAsWritten, notReplayedFlags, notReplayedProposal } from '../src/proposal/not-replayed.js';
import { signSteps, stepChanges, UNVERIFIED_COUNT_FLAG } from '../src/proposal/proposal.js';
import { scriptHash } from '../src/sign.js';
import { parseDesktopScript } from '../src/steps/parse.js';
import type { Script } from '../src/types.js';
import { APPROVER, erpScript, LOCAL, reportScript, SAP_VARS, sapPolicy, SECRETS, TEST_KEY, webguiScript } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
// A note, not a step left out: the approval shows dropped and untranslated steps as left out.
const SIGNATURE_DROPPED = {
  at: '', kind: 'converted', what: 'Signature',
  reason: 'imported steps are a first version for approval, so the signature and Approved By the document carried were not imported: Sign Steps signs the steps when a person approves them',
};
const septemberFile = `LINEITEMS_1000_${SANDBOX.erp.from}_${SANDBOX.erp.to}.csv`;
const json = (x: unknown) => JSON.stringify(x);
const opts = { name: 'line-item-export', hasSiteLogin: true, secrets: SECRETS };
const uia = (automationId: string, controlType = 'Edit') => ({ uia: { path: [{ controlType, automationId }] } });

describe('a step document as an import source: the import run', () => {
  it('a hand-written browser step document with a signIn imports, replays and comes out for approval', async () => {
    const { name: _name, ...written } = erpScript(portal.url, 3);
    // As Run Steps takes it, with the signature and approver of an earlier approval beside the steps.
    const doc = { name: 'my-own-export', ...written, signature: 'a'.repeat(64), approvedBy: 'someone@example.com' };
    const r = importSource('steps', json(doc), opts);
    expect(r.report).toEqual({
      source: 'steps', steps: 10, items: [
        SIGNATURE_DROPPED,
        { at: '', kind: 'converted', what: 'Name and version', reason: 'the steps are named "line-item-export", version 1: imported steps are a first version under the import\'s Name' },
      ],
    });
    expect(r.desktopDrafts).toBeUndefined();
    expect(r.drafts).toEqual([{ name: 'line-item-export', script: { ...written, name: 'line-item-export', version: 1 } }]);
    // The variables stay templates: the run gets their values from Variables.
    expect(json(r.drafts[0].script)).toContain('{{var.company}}');

    const adopted = await adoptDraft({
      draft: r.drafts[0].script, policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, vars: SAP_VARS, defaultStepTimeoutMs: 3000,
    });
    if (!adopted.ok) throw new Error(json(adopted).slice(0, 1500));
    expect(adopted).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(adopted.proposal).toMatchObject({ name: 'line-item-export', baseVersion: null, version: 1, steps: r.drafts[0].script });
    expect(adopted.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(adopted.proposal.changes.every((c) => c.was === null)).toBe(true);

    // Approved, it is signed, and the signed steps run with signed steps required.
    const signed = signSteps({ proposal: adopted.proposal, key: TEST_KEY, approverId: APPROVER, policy: sapPolicy(portal), secrets: SECRETS, reviewedDigest: adopted.digest });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    expect(signed.row).toMatchObject({ name: 'line-item-export', version: 1, status: 'active', approvedBy: APPROVER });
    expect(signed.row.signature).not.toBe(doc.signature);
    const run = await runScriptLane({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: signed.row.approvedBy, key: TEST_KEY },
      policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS,
    });
    if (!run.ok) throw new Error(json(run).slice(0, 1500));
    expect(run.files.map((f) => f.fileName)).toEqual([septemberFile]);
  }, 120_000);

  it('a variable the document needs and Variables does not give fails the import run with the missing-input message', async () => {
    const r = importSource('steps', json(erpScript(portal.url)), opts);
    const { company: _company, ...rest } = SAP_VARS;
    const adopted = await adoptDraft({ draft: r.drafts[0].script, policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, vars: rest, defaultStepTimeoutMs: 3000 });
    expect(adopted.ok).toBe(false);
    expect(adopted.ok ? '' : adopted.message).toContain('missing input "company"');
  }, 120_000);

  it('a document with a submit or a download through a form, also inside paginate, needs approval as written: it is never run', () => {
    const erp = erpScript(portal.url);
    const submit = {
      ...erp, steps: [...erp.steps.slice(0, 3), { intent: 'Send the form', submit: { path: '/acme/reports/export', button: { role: 'button', name: 'Export CSV' } } }],
    };
    const report = reportScript(portal.url);
    const exportStep = report.steps.at(-1)!;
    const paginated = {
      ...report, steps: [...report.steps.slice(0, -1), { intent: 'Export every page', paginate: { next: { text: 'Next page' }, until: 'absent', max: 3, each: [exportStep] } }],
    };
    for (const doc of [submit, report, paginated]) {
      const r = importSource('steps', json(doc), opts);
      expect(r.drafts).toHaveLength(1);
      const script = r.drafts[0].script;
      expect(needsApprovalAsWritten(script.steps)).toBe(true);
      // The review of steps nobody ran: version 1, no base, empty evidence, every step listed as added.
      const p = notReplayedProposal(script);
      expect(p).toMatchObject({ name: 'line-item-export', baseVersion: null, version: 1, steps: script, hash: scriptHash(script), screenshots: {} });
      expect(p.evidence).toEqual({ count: 0, total: null, diff: { missing: [], extra: [] } });
      expect(p.changes).toEqual(stepChanges(undefined, script));
      expect(p.changes.every((c) => c.was === null)).toBe(true);
      // No page was read, so there is no count to call unverified.
      expect(p.safetyFlags).not.toContain(UNVERIFIED_COUNT_FLAG);
      expect(p.safetyFlags).toContain('new form submission: POST ' + portal.host + '/acme/reports/export');
    }
    // A list without any of the four kinds is run and replayed, as every import is.
    expect(needsApprovalAsWritten(erp.steps)).toBe(false);
    expect(needsApprovalAsWritten(webguiScript(portal.url).steps)).toBe(false);
  });

  it('a secret fill or a changePassword needs approval as written too, and its flags name the variable, never a value', () => {
    const erp = erpScript(portal.url);
    const signIn = erp.steps[0] as Extract<Script['steps'][number], { signIn: unknown }>;
    const changePassword = { ...erp, steps: [{ ...signIn, signIn: { ...signIn.signIn, changePassword: {
      detect: { role: 'heading', name: 'Change your password' }, new: [{ label: 'New password', exact: true }], submit: { role: 'button', name: 'Change password' }, value: '{{ var.newPassword }}',
    } } }, ...erp.steps.slice(1)] };
    const secretFill = { ...erp, steps: [...erp.steps.slice(0, -1), { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{var.exportPassword}}', secret: true } }, erp.steps.at(-1)] };
    const flags: [object, string[]][] = [
      [changePassword, ['password change: a step sets a new password from the run variable {{var.newPassword}}']],
      [secretFill, ['secret fill: a step types the run variable {{var.exportPassword}}']],
    ];
    for (const [doc, expected] of flags) {
      const script = importSource('steps', json(doc), opts).drafts[0].script;
      expect(needsApprovalAsWritten(script.steps)).toBe(true);
      expect(notReplayedFlags(script)).toEqual(expected);
      expect(notReplayedProposal(script).safetyFlags).toEqual(expect.arrayContaining(expected));
    }
    // No step number (the browser change list shows none), also inside paginate; the same variable typed twice is one flag.
    const nested = { ...erp, steps: [...erp.steps.slice(0, 2), { intent: 'Each page', paginate: { next: { text: 'Next page' }, until: 'absent', max: 2, each: [
      { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{var.exportPassword}}', secret: true } },
      { intent: 'Type it again', fill: { field: { label: 'Repeat password' }, value: '{{ var.exportPassword }}', secret: true } },
    ] } }] };
    expect(notReplayedFlags(importSource('steps', json(nested), opts).drafts[0].script)).toEqual(['secret fill: a step types the run variable {{var.exportPassword}}']);
  });
});

describe('a step document as an import source: reading it', () => {
  it('takes the version the import gives (a change of an approved bot): the steps are that version, never the document\'s own', () => {
    const steps = [{ intent: 'Open the report', goto: '/acme/reports' }];
    const at3 = importSource('steps', json({ name: 'line-item-export', version: 7, startUrl: 'https://erp.example.com/', steps }), { ...opts, version: 3 });
    expect(at3.drafts).toEqual([{ name: 'line-item-export', script: { name: 'line-item-export', version: 3, startUrl: 'https://erp.example.com/', steps } }]);
    expect(at3.report.items).toEqual([
      { at: '', kind: 'converted', what: 'Name and version', reason: 'the steps are named "line-item-export", version 3: imported steps are a first version under the import\'s Name' },
    ]);
    // A document that already says that version and name: nothing to report.
    expect(importSource('steps', json({ name: 'line-item-export', version: 3, startUrl: 'https://erp.example.com/', steps }), { ...opts, version: 3 }).report.items).toEqual([]);
    // Desktop documents too, and the default stays 1.
    const desk = { surface: 'desktop', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: uia('btnSave', 'Button') }] };
    expect(importSource('steps', json(desk), { ...opts, version: 2 }).desktopDrafts?.[0].script.version).toBe(2);
    expect(importSource('steps', json(desk), opts).desktopDrafts?.[0].script.version).toBe(1);
    // Not a whole number of 1 or more: nothing is imported.
    for (const version of [0, -1, 1.5, Number.NaN]) {
      const bad = importSource('steps', json(steps), { ...opts, version });
      expect(bad.drafts, String(version)).toEqual([]);
      expect(bad.report.items, String(version)).toEqual([{ at: '', kind: 'error', what: 'Import', reason: 'the version must be a whole number of 1 or more' }]);
    }
  });

  it('is read as data: a bare array of steps, the import\'s Name and version 1, and the Start URL when the document has none', () => {
    const steps = [{ intent: 'Open the report', goto: '/acme/reports' }];
    const r = importSource('steps', Buffer.from(json(steps)), { ...opts, startUrl: 'https://erp.example.com/acme/login' });
    expect(r.report).toEqual({ source: 'steps', steps: 1, items: [] });
    expect(r.drafts).toEqual([{ name: 'line-item-export', script: { name: 'line-item-export', version: 1, startUrl: 'https://erp.example.com/acme/login', steps } }]);
    // Nothing in the document is evaluated: a template stays text.
    const kept = importSource('steps', json({ startUrl: 'https://erp.example.com/', steps: [{ intent: 'Type', fill: { field: { label: 'Note' }, value: '{{var.note}}' } }] }), opts);
    expect(kept.drafts[0].script.steps[0]).toEqual({ intent: 'Type', fill: { field: { label: 'Note' }, value: '{{var.note}}' } });
  });

  it('refuses what is not a step document with the parser\'s message, and a document that names a Site Login value', () => {
    const error = (data: unknown, o: Parameters<typeof importSource>[2] = opts) => {
      const r = importSource('steps', data as string, o);
      expect(r.drafts).toEqual([]);
      expect(r.desktopDrafts).toBeUndefined();
      return r.report.items;
    };
    const item = (reason: string) => [{ at: '', kind: 'error', what: 'Step document', reason }];
    expect(error('{ "steps": [')).toEqual(item('the step document is not valid JSON: give the steps as JSON, as Run Steps takes them'));
    expect(error(42)).toEqual(item('the step document must be text or a file'));
    expect(error('x'.repeat(5 * 1024 * 1024 + 1))).toEqual(item('the step document is larger than 5 MiB, so it was not read'));
    expect(error(json({ startUrl: 'https://erp.example.com/', steps: [{ intent: 'Open', goto: '/a', colour: 'red' }] })))
      .toEqual(item('the step document is not valid steps: steps[0] has unknown key "colour"'));
    expect(error(json({ steps: [{ intent: 'Open', click: { text: 'Go' } }] }))).toEqual(item('the step document is not valid steps: the first step must be goto to an absolute URL, or set startUrl'));
    expect(error(json({ startUrl: 'https://erp.example.com/', steps: [{ intent: 'Type', fill: { field: { label: 'Note' }, value: SECRETS.password } }] })))
      .toEqual(item('the step document names a value of the RPA Site Login, so it was not imported: a signIn step types the Site Login\'s values'));
    // The parser's message names the problem, never a typed value.
    expect(json(error(json({ startUrl: 'https://erp.example.com/', steps: [{ intent: 'Type', fill: { field: { label: 'Note' }, value: 'Zip-9f3k-2xq', secret: true } }] })))).not.toContain('Zip-9f3k-2xq');
  });

  it('a desktop step set becomes a desktop draft; the writes it declared are left for the approver as candidate writes', () => {
    const doc = {
      surface: 'desktop', name: 'erp-orders', version: 2, app: { exe: 'ErpDemo.exe' }, signature: 'b'.repeat(64),
      steps: [
        { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
        { intent: 'Pick a status', select: { field: uia('cmbStatus', 'ComboBox'), option: '{{var.status}}' } },
        { intent: 'Run the batch', click: uia('btnRun', 'Button'), write: true },
        { intent: 'Click Save', click: uia('btnSave', 'Button') },
        { intent: 'Close the dialog', click: uia('btnClose', 'Button'), write: false },
      ],
    };
    const r = importSource('steps', json(doc), { name: 'orders', hasSiteLogin: false, download: { check: { name: '^x' } } });
    expect(r.drafts).toEqual([]);
    const { signature: _s, ...steps } = doc;
    const script = { ...steps, name: 'orders', version: 1, steps: steps.steps.map(({ write: _w, ...s }: Record<string, unknown>) => s) };
    expect(r.desktopDrafts).toEqual([{ name: 'orders', script, writeCandidates: [3, 4], variables: ['user', 'status'], secretVariables: [] }]);
    expect(parseDesktopScript(r.desktopDrafts![0].script)).toEqual(script);
    const candidate = (n: number, intent: string) => ({
      at: '', kind: 'candidateWrite', what: `Step ${n}: ${intent}`,
      reason: 'this step may save, post or submit: if it does, mark it as a write when you approve the steps',
    });
    expect(r.report).toEqual({
      source: 'steps', steps: 5, items: [
        SIGNATURE_DROPPED,
        { at: '', kind: 'converted', what: 'Name and version', reason: 'the steps are named "orders", version 1: imported steps are a first version under the import\'s Name' },
        // A note, not an untranslated step: the import form counts untranslated items as steps it could not take.
        { at: '', kind: 'converted', what: 'Expected File', reason: 'the download steps of a step document carry their own checks: Expected File is not used' },
        // The step the document marked as a write says so; a step that only reads like one gets the general reason.
        { at: '', kind: 'candidateWrite', what: 'Step 3: Run the batch', reason: 'the document marked this step as a write: mark it as a write when you approve the steps' },
        candidate(4, 'Click Save'),
      ],
    });
  });

  it('a desktop step set: a variable typed into a password, PIN or secret field (by its name or automationId) is a secret variable; the steps are unchanged', () => {
    const doc = {
      surface: 'desktop', app: { exe: 'ErpDemo.exe' },
      steps: [
        { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
        { intent: 'Type the password', fill: { field: { uia: { path: [{ controlType: 'Window', name: 'Sign in' }, { controlType: 'Edit', name: 'Password' }] } }, value: '{{ var.password }}' } },
        { intent: 'Press Enter', key: { key: 'Enter', target: { uia: { path: [{ controlType: 'Edit', name: 'Password' }] } } } },
        { intent: 'Type the PIN', fill: { field: uia('PIN'), value: '{{var.pin}}' } },
        { intent: 'Type the code', fill: { field: uia('txtCompanyCode'), value: '{{var.company}}' } },
        // Only the field itself counts: a password window around a plain field does not make its value secret.
        { intent: 'Type a note', fill: { field: { uia: { window: { title: 'Password reset' }, path: [{ controlType: 'Window', name: 'Password' }, { controlType: 'Edit', name: 'Note' }] } }, value: '{{var.note}}' } },
      ],
    };
    const r = importSource('steps', json(doc), { name: 'd', hasSiteLogin: false });
    const [draft] = r.desktopDrafts!;
    expect(draft.variables).toEqual(['user', 'password', 'pin', 'company', 'note']);
    expect(draft.secretVariables).toEqual(['password', 'pin']);
    // The steps are exactly the document's (named d, version 1): nothing that is signed changes.
    expect(draft.script).toEqual(parseDesktopScript({ ...doc, name: 'd', version: 1 }));
    // A document with no such field has none, as before.
    const plain = importSource('steps', json({ ...doc, steps: [doc.steps[0], doc.steps[4]] }), { name: 'd', hasSiteLogin: false });
    expect(plain.desktopDrafts![0].secretVariables).toEqual([]);
  });

  it('a copied row of the steps table (steps as text) is refused with a hint to paste its steps column first', () => {
    const steps = [{ intent: 'Open the report', goto: 'https://erp.example.com/acme/reports' }];
    const row = { name: 'line-item-export', version: 3, steps: json(steps), hash: 'c'.repeat(64), signature: 'd'.repeat(64), approvedBy: 'someone@example.com', status: 'active' };
    const r = importSource('steps', json(row), opts);
    expect(r.drafts).toEqual([]);
    const error = r.report.items.find((i) => i.kind === 'error');
    expect(error?.reason).toMatch(/^the step document is not valid steps: this looks like a row of the steps table: paste the value of its steps column; /);
    // A document whose steps are a list is not given the hint.
    const plain = importSource('steps', json({ startUrl: 'https://erp.example.com/', steps: [{ intent: 'Open', goto: '/a', colour: 'red' }] }), opts);
    expect(plain.report.items.find((i) => i.kind === 'error')?.reason).not.toContain('row of the steps table');
  });

  it('a desktop step set that does not parse is refused with the desktop parser\'s message', () => {
    const r = importSource('steps', json({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, startUrl: 'https://erp.example.com/', steps: [{ intent: 'Post', click: uia('btnPost', 'Button') }] }), opts);
    expect(r).toEqual({
      drafts: [], report: { source: 'steps', steps: 0, items: [{ at: '', kind: 'error', what: 'Step document', reason: 'the step document is not valid steps: the steps have the unknown key "startUrl"; startUrl is a browser setting, not allowed in a desktop step set: set app instead' }] },
    });
  });
});
