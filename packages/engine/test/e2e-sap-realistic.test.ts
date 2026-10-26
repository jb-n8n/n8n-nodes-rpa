import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import type { ChatModel } from '../src/agent/model.js';
import { openSession } from '../src/browser/session.js';
import { classifyFailure, toErrorCode } from '../src/classify/classify.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { runTask, type TaskResult } from '../src/lane/task.js';
import { noWritePolicy } from '../src/policy/derive.js';
import { signSteps } from '../src/proposal/proposal.js';
import { proveScript } from '../src/prove/prove.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps } from '../src/steps/run.js';
import type { FileCheck, PortalPolicy, PortalSecrets, Script } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, type FakeTurn } from './fake-model.js';
import { APPROVER, LOCAL, signedLaneInput, TEST_KEY } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal({ sap: 'realistic' }); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const SECRETS: PortalSecrets = { username: 'RPA_BOT', password: 'sap-demo-password' };

const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: [{ host: portal.host, path: SANDBOX.erp.webguiPath }],
  allowedSubmits: [],
  readPosts: [{ host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }],
  allowPrivateNetwork: true,
});

/** Sign in at the SAP logon, open Line Item Report, run the September selection, then `tail`. */
const script = (tail: Script['steps']): Script => ({
  name: 'sap-realistic-export',
  version: 1,
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  steps: [
    {
      intent: 'Log on',
      signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Log On' } },
    },
    { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
    { intent: 'Company code', fill: { field: { label: 'Company Code' }, value: '1000' } },
    { intent: 'From', fill: { field: { label: 'From' }, value: '01.09.2026' } },
    { intent: 'To', fill: { field: { label: 'To' }, value: '30.09.2026' } },
    { intent: 'Execute', click: { role: 'button', name: 'Execute (F8)' } },
    ...tail,
  ],
});

async function run(s: Script) {
  const r = await runScriptLane(signedLaneInput(s, { policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 5000 }));
  if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 1000));
  return r;
}

function expectSeptember(file: { fileName: string; data: Buffer }) {
  expect(file.fileName).toBe('export.XLSX');
  const parts = unzipSync(new Uint8Array(file.data));
  const strings = strFromU8(parts['xl/sharedStrings.xml']!);
  expect(strings).toContain('Document No.');
  const documents = [...strings.matchAll(/>(19\d{8})</g)].map((m) => m[1]);
  expect(documents).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
  expect(documents).toContain('1900000201');
  expect(documents).not.toContain('1900000102');
}

describe('the realistic classic GUI', () => {
  it('logs on and exports XLSX through the realistic GUI', async () => {
    const r = await run(script([
      { intent: 'Spreadsheet', click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } },
      { intent: 'Continue', download: { trigger: { role: 'button', name: 'Continue (Enter)' } } },
    ]));
    expect(r.files).toHaveLength(1);
    expectSeptember(r.files[0]!);
    expect(r.blockedRequests).toHaveLength(0);
    expect((r as { submitted?: boolean }).submitted).toBeFalsy();
  }, 120_000);

  it('the menu variant needs the List menu', async () => {
    portal.setState({ erp: 'menu' });
    const r = await run(script([
      { intent: 'List menu', click: { role: 'menuitem', name: 'List' } },
      { intent: 'Export menu', click: { role: 'menuitem', name: 'Export' } },
      { intent: 'Spreadsheet', click: { role: 'menuitem', name: 'Spreadsheet...' } },
      { intent: 'Continue', download: { trigger: { role: 'button', name: 'Continue (Enter)' } } },
    ]));
    expectSeptember(r.files[0]!);
    const missing = await runScriptLane(signedLaneInput(script([
      { intent: 'Spreadsheet', click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } },
    ]), { policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 1500 }));
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('the baseline click should not match the menu variant');
    expect(toErrorCode(classifyFailure({ violations: [], failure: missing.failure }))).toBe('drift_detected');
  }, 120_000);
});

// The classic GUI keeps each window's state on the server (/sap(<context>)/...). A repair moves the healing
// session's window; prove and the agent's restart must open the work's entry page (a fresh window), not that window's URL.
describe('a reused session opens the work entry page, not the moved window', () => {
  const XLSX_CHECK: FileCheck = { name: '^export\\.XLSX$', columns: ['Document No.', 'Posting Date', 'Company Code', 'Amount', 'Currency'], minRows: 1 };
  const masker = createMasker([SECRETS.username, SECRETS.password]);
  const fileScript = (): Script => script([
    { intent: 'Spreadsheet', click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } },
    { intent: 'Continue', download: { trigger: { role: 'button', name: 'Continue (Enter)' }, check: XLSX_CHECK } },
  ]);
  const GOAL = 'Download the September line items of company code 1000 as a spreadsheet.';
  const noModel: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error('the model must not be called'); } }) };
  const typed = (field: string, value: string): FakeTurn => (t) => ({ name: 'fill', args: { ref: refByName(t, field), value } });
  const selection = (tile: string, run: string): FakeTurn[] => [
    clickNamed(tile), typed('Company Code', '1000'), typed('From', '01.09.2026'), typed('To', '30.09.2026'), clickNamed(run),
  ];
  const task = (s: Script, model: ChatModel) => signedLaneInput(s, {
    policy: policy(), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, repair: { model, goal: GOAL, deliverUnconfirmed: true },
  });
  const nextRunNeedsNoModel = async (healed: TaskResult) => {
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(JSON.stringify(healed).slice(0, 1500));
    const signed = signSteps({ proposal: healed.proposal, key: TEST_KEY, approverId: APPROVER, policy: policy(), secrets: SECRETS, reviewedDigest: healed.digest ?? '' });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    const next = await runTask({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: signed.row.approvedBy, key: TEST_KEY },
      policy: policy(), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, repair: { model: noModel, goal: GOAL, deliverUnconfirmed: true },
    });
    expect(next).toMatchObject({ ok: true, lane: 'script', version: 2 });
  };

  it('prove reuses the cookies but opens the start page: a fresh window, not the one the repair moved', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policy(), masker });
    let state: Awaited<ReturnType<typeof s.context.storageState>>;
    let windowUrl: string;
    try {
      await s.page.goto(policy().startUrl);
      const ctx = {
        page: s.page, script: fileScript(), policy: policy(), secrets: SECRETS, vars: {}, masker,
        defaultTimeoutMs: 5000, violations: s.violations, interrupts: await installInterrupts(s.page, []),
      };
      const signedIn = await runSteps(ctx, fileScript().steps.slice(0, 1));
      if (!signedIn.ok) throw new Error(signedIn.failure.message);
      state = await s.context.storageState();
      windowUrl = s.page.url();
      expect(windowUrl).toMatch(/\/sap\([^)]+\)\/bc\/gui\/sap\/its\/webgui$/);
      // The repair moves that same server-side window on to the selection screen.
      const moved = await runSteps(ctx, fileScript().steps.slice(1, 2));
      if (!moved.ok) throw new Error(moved.failure.message);
    } finally { await s.close(); }
    const r = await proveScript({
      script: fileScript(), policy: noWritePolicy(policy()), secrets: SECRETS, output: {}, endpoint: LOCAL, masker, defaultStepTimeoutMs: 5000,
      budgetMs: 60_000, agentRows: [], storageState: state, postLoginUrl: windowUrl, expectFile: true, checkFallbacksFrom: 1,
    });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.file?.fileName).toBe('export.XLSX');
  }, 120_000);

  it('a renamed release heals, proves on a fresh window, signs, and the next run needs no model', async () => {
    portal.setState({ erp: 'renamed' });
    const model = fakeModel([
      ...selection('G/L Line Items', 'Run (F8)'), clickNamed('Export to Spreadsheet'), clickNamed('Continue (Enter)', 'download'), done('found', 'the spreadsheet'),
    ]);
    const healed = await runTask(task(fileScript(), model));
    if (!healed.ok || healed.lane !== 'agent') throw new Error(JSON.stringify(healed).slice(0, 1500));
    expect(healed.prove?.reasons).toEqual([]);
    expect(healed.confirmed).toBe(true);
    expect(healed.files.map((f) => f.fileName)).toEqual(['export.XLSX']);
    await nextRunNeedsNoModel(healed);
  }, 120_000);

  it("the agent's restart after sign-in opens a fresh window too, and its steps prove", async () => {
    // The menu release breaks the script on the result screen; the first attempt gives up there, the restart begins on
    // SAP Easy Access (a fresh window), not on the result screen the script lane left its window on.
    portal.setState({ erp: 'menu' });
    const model = fakeModel([
      done('not_found', 'no spreadsheet button here'),
      ...selection('Line Item Report', 'Execute (F8)'),
      clickNamed('List'), clickNamed('Export'), clickNamed('Spreadsheet...'), clickNamed('Continue (Enter)', 'download'), done('found', 'the spreadsheet'),
    ]);
    const healed = await runTask(task(fileScript(), model));
    if (!healed.ok || healed.lane !== 'agent') throw new Error(JSON.stringify(healed).slice(0, 1500));
    expect(model.texts[1]).toContain('Line Item Report');
    expect(healed.prove?.reasons).toEqual([]);
    expect(healed.confirmed).toBe(true);
    expect(healed.proposal?.steps.steps.map((st) => st.intent).slice(0, 2)).toEqual(['Log on', 'Click Line Item Report']);
    await nextRunNeedsNoModel(healed);
  }, 120_000);
});
