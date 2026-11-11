import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { adoptDraft } from '../src/import/adopt.js';
import { importSource } from '../src/import/index.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { IMPORT_REFUSES_WRITES, UNSIGNED_CHANGE_PASSWORD, UNSIGNED_SECRET_FILL } from '../src/messages.js';
import { signSteps } from '../src/proposal/proposal.js';
import { parseDesktopScript } from '../src/steps/parse.js';
import type { Script } from '../src/types.js';
import { APPROVER, erpScript, LOCAL, reportScript, SAP_VARS, sapPolicy, SECRETS, TEST_KEY } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
const SIGNATURE_DROPPED = {
  at: '', kind: 'dropped', what: 'Signature',
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

  it("a document with a submit runs no write in the import's own run", async () => {
    const submit = {
      ...erpScript(portal.url),
      steps: [...erpScript(portal.url).steps.slice(0, 3), { intent: 'Send the form', submit: { path: '/acme/reports/export', button: { role: 'button', name: 'Export CSV' } } }],
    };
    // A download through a form post is a write too.
    for (const doc of [submit, reportScript(portal.url)]) {
      const r = importSource('steps', json(doc), opts);
      expect(r.drafts).toHaveLength(1);
      const adopted = await adoptDraft({ draft: r.drafts[0].script, policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, vars: SAP_VARS, defaultStepTimeoutMs: 3000 });
      // Refused before a browser opens: no step ran.
      expect(adopted).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_REFUSES_WRITES, configError: true, log: [] });
    }
  });

  it('a secret fill or a changePassword is refused before the import run opens a browser: the run is unsigned', async () => {
    const erp = erpScript(portal.url);
    const signIn = erp.steps[0] as Extract<Script['steps'][number], { signIn: unknown }>;
    const changePassword = { ...erp, steps: [{ ...signIn, signIn: { ...signIn.signIn, changePassword: {
      detect: { role: 'heading', name: 'Change your password' }, new: [{ label: 'New password', exact: true }], submit: { role: 'button', name: 'Change password' }, value: '{{var.newPassword}}',
    } } }, ...erp.steps.slice(1)] };
    const secretFill = { ...erp, steps: [...erp.steps.slice(0, -1), { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{var.exportPassword}}', secret: true } }, erp.steps.at(-1)] };
    const vars = { ...SAP_VARS, newPassword: 'Next-pw-7731', exportPassword: 'Zip-9f3k-2xq' };
    for (const [doc, message] of [[changePassword, UNSIGNED_CHANGE_PASSWORD], [secretFill, UNSIGNED_SECRET_FILL]] as const) {
      const r = importSource('steps', json(doc), opts);
      expect(r.drafts).toHaveLength(1);
      const adopted = await adoptDraft({ draft: r.drafts[0].script, policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, vars, defaultStepTimeoutMs: 3000 });
      expect(adopted).toMatchObject({ ok: false, code: 'script_untrusted', message, log: [] });
      expect(json(adopted)).not.toContain(vars.newPassword);
      expect(json(adopted)).not.toContain(vars.exportPassword);
    }
  });
});

describe('a step document as an import source: reading it', () => {
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
      reason: `this step may save, post or submit. The import never declares a write: if it writes, list ${n} in Write Steps when you approve these steps (Sign Steps); the desktop runner refuses a declared write control without it`,
    });
    expect(r.report).toEqual({
      source: 'steps', steps: 5, items: [
        SIGNATURE_DROPPED,
        { at: '', kind: 'converted', what: 'Name and version', reason: 'the steps are named "orders", version 1: imported steps are a first version under the import\'s Name' },
        { at: '', kind: 'untranslated', what: 'Expected File', reason: 'the download steps of a step document carry their own checks: Expected File is not used' },
        candidate(3, 'Run the batch'), candidate(4, 'Click Save'),
      ],
    });
  });

  it('a desktop step set that does not parse is refused with the desktop parser\'s message', () => {
    const r = importSource('steps', json({ surface: 'desktop', app: { exe: 'ErpDemo.exe' }, startUrl: 'https://erp.example.com/', steps: [{ intent: 'Post', click: uia('btnPost', 'Button') }] }), opts);
    expect(r).toEqual({
      drafts: [], report: { source: 'steps', steps: 0, items: [{ at: '', kind: 'error', what: 'Step document', reason: 'the step document is not valid steps: script has unknown key "startUrl"; startUrl is a browser setting, not allowed in a desktop step set: set app instead' }] },
    });
  });
});
