import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import type { ChatModel } from '../src/agent/model.js';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { runTask, type TaskInput, type TaskResult } from '../src/lane/task.js';
import { signSteps, type SignedStepsRow } from '../src/proposal/proposal.js';
import type { Script } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, type FakeTurn } from './fake-model.js';
import { APPROVER, ERP_CHECK, erpScript, LOCAL, SAP_VARS, sapPolicy, SECRETS, signedLaneInput, TEST_KEY } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const GOAL = 'Download the line-item report for the period.';
const DECEMBER = { ...SAP_VARS, from: SANDBOX.erp.emptyFrom, to: SANDBOX.erp.emptyTo };
const OCTOBER = { ...SAP_VARS, from: '2026-10-01', to: '2026-10-31' };

/** Signed steps under sapPolicy; `model` turns AI repair on (Deliver Unconfirmed Rows on: files are still withheld). */
function signed(steps: Script, over: Partial<TaskInput> & { model?: ChatModel } = {}): TaskInput {
  const { model, ...rest } = over;
  return signedLaneInput(steps, {
    policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS,
    ...(model ? { repair: { model, goal: GOAL, deliverUnconfirmed: true } } : {}),
    ...rest,
  });
}
/** A signed row as the steps table holds it, ready for the script lane. */
const laneInput = (row: SignedStepsRow, vars: Record<string, string> = SAP_VARS): ScriptLaneInput => ({
  script: row.steps, trust: { required: true, signature: row.signature, approvedBy: row.approvedBy, key: TEST_KEY },
  policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars,
});
const approve = (r: TaskResult): SignedStepsRow => {
  if (!r.ok || r.lane !== 'agent' || !r.proposal) throw new Error(JSON.stringify(r).slice(0, 800));
  const signedRow = signSteps({ proposal: r.proposal, key: TEST_KEY, approverId: APPROVER, policy: sapPolicy(portal), secrets: SECRETS, reviewedDigest: r.digest ?? '' });
  if (!signedRow.ok) throw new Error(signedRow.reasons.join('; '));
  return signedRow.row;
};
const noModel: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error('the model must not be called'); } }) };
const leakFree = (r: unknown) => {
  const text = JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after'].includes(k) ? undefined : v));
  for (const s of [SECRETS.username, SECRETS.password, SECRETS.totpSecret as string]) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
};

const download = (name: string): FakeTurn => clickNamed(name, 'download');
const typed = (tool: 'fill' | 'select', field: string, value: string): FakeTurn => (t) => ({ name: tool, args: { ref: refByName(t, field), value } });
/**
 * The renamed release breaks the script at its tile ("G/L Line Items"), so the agent starts on SAP Easy Access: open the
 * report, set the run's selection, run it. The typed values equal the run variables, so compile records the variables.
 */
const renamedSelection = (vars: Record<string, string> = SAP_VARS): FakeTurn[] => [
  clickNamed('G/L Line Items'),
  typed('select', 'Company Code', vars.company),
  typed('fill', 'From', vars.from),
  typed('fill', 'To', vars.to),
  clickNamed('Run'),
];
const septemberFile = `LINEITEMS_1000_${SANDBOX.erp.from}_${SANDBOX.erp.to}.csv`;
const json = (x: unknown) => JSON.stringify(x);

describe('download healing on the report screen (fake model)', () => {
  it('baseline runs on the script lane with a checked file and 0 LLM calls', async () => {
    const model = fakeModel([]);
    const r = await runTask(signed(erpScript(portal.url), { model }));
    if (!r.ok || r.lane !== 'script') throw new Error(json(r).slice(0, 800));
    expect(r.files).toHaveLength(1);
    expect(r.files[0].fileName).toMatch(new RegExp(ERP_CHECK.name!));
    expect(r.files[0].facts).toEqual({ columns: SANDBOX.erp.header.split(','), rows: SANDBOX.erp.rowsInSeptember1000 });
    expect((r as { llmCalls?: number }).llmCalls ?? 0).toBe(0);
    expect(model.invocations).toHaveLength(0);
    leakFree(r);
  });

  it('a renamed export heals, proves, signs, and the next run needs no model', async () => {
    portal.setState({ erp: 'renamed' });
    const model = fakeModel([...renamedSelection(), download('Download spreadsheet'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    expect(healed.confirmed).toBe(true);
    expect(healed.proposal.evidence.file?.rows).toBe(SANDBOX.erp.rowsInSeptember1000);
    expect(healed.proposal.evidence.file?.fileName).toBe(septemberFile);
    expect(json(healed.proposal.changes)).toContain('checks: type text/csv; name /^LINEITEMS_1000_/');
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    leakFree(healed);
    const v2 = approve(healed);
    expect(v2).toMatchObject({ version: 2, status: 'active' });
    const lane = await runScriptLane(laneInput(v2));
    if (!lane.ok) throw new Error(json(lane).slice(0, 800));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
    // The healed file is delivered under the binary name the approved steps' normal run gives it, with the same bytes.
    expect(healed.files[0].binaryName).toBe(lane.files[0].binaryName);
    expect(healed.files[0].data.equals(lane.files[0].data)).toBe(true);
    leakFree(lane);
    const next = await runTask({ ...laneInput(v2), repair: { model: noModel, goal: GOAL, deliverUnconfirmed: true } });
    expect(next).toMatchObject({ ok: true, lane: 'script', version: 2 });
    leakFree(next);
  }, 120_000);

  it("the agent's restart opens the goto that starts the work, which stays in the proven steps", async () => {
    portal.setState({ erp: 'renamed' });
    const model = fakeModel([
      done('not_found', 'not on this page'), ...renamedSelection(), download('Download spreadsheet'), done('found', 'the line-item CSV'),
    ]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    // The restart opened the base's goto to the web GUI (SAP Easy Access), not the portal page reached after sign-in.
    expect(model.texts[1]).toContain('G/L Line Items');
    expect(model.texts[1]).toContain('reopened the start of the work');
    expect(healed.confirmed).toBe(true);
    const steps = healed.proposal.steps.steps;
    expect(steps.slice(0, 4)).toEqual(erpScript(portal.url).steps.slice(0, 4));
    expect(steps[4]?.intent).toBe('Click G/L Line Items');
    leakFree(healed);
  }, 120_000);

  it('a menu-hidden export heals', async () => {
    portal.setState({ erp: 'menu' });
    const model = fakeModel([clickNamed('More'), download('Export'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    expect(healed.confirmed).toBe(true);
    expect(healed.proposal.evidence.file?.rows).toBe(SANDBOX.erp.rowsInSeptember1000);
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    leakFree(healed);
    const lane = await runScriptLane(laneInput(approve(healed)));
    expect(lane).toMatchObject({ ok: true, lane: 'script', version: 2 });
  }, 120_000);

  it('a dialog export heals through the dialog', async () => {
    portal.setState({ erp: 'dialog' });
    const model = fakeModel([clickNamed('Export'), clickNamed('Comma-separated (CSV)'), download('Continue'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    expect(healed.confirmed).toBe(true);
    expect(healed.proposal.evidence.file?.rows).toBe(SANDBOX.erp.rowsInSeptember1000);
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    // Pinned on purpose: the script lane's kept Export click and the agent's own Export click are both replayed, as they
    // happened in healing (merging them would change behaviour on a control that toggles).
    const at = erpScript(portal.url).steps.length - 1;
    const export_ = { role: 'button', name: 'Export' };
    expect(healed.proposal.steps.steps.slice(at).map((s) => s.intent)).toEqual(['Open Export', 'Click Export', 'Click Comma-separated (CSV)', 'Download with Continue']);
    expect(healed.proposal.steps.steps[at]).toEqual({ intent: 'Open Export', click: export_ });
    expect(healed.proposal.steps.steps[at + 1]).toMatchObject({ intent: 'Click Export', click: { role: 'button', name: 'Export' } });
    const nows = healed.proposal.changes.map((c) => c.now);
    expect(nows).toContain('Open Export (click role "button" name "Export")');
    expect(nows.some((n) => n?.startsWith('Click Export (click role "button" name "Export"'))).toBe(true);
    leakFree(healed);
    const lane = await runScriptLane(laneInput(approve(healed)));
    expect(lane).toMatchObject({ ok: true, lane: 'script', version: 2 });
  }, 120_000);

  it('a dialog export heals when the agent starts in the dialog the script lane opened (no second Export click)', async () => {
    portal.setState({ erp: 'dialog' });
    // The script lane's download clicked Export, which opened the dialog: the agent goes on from there, as a real model does.
    const model = fakeModel([clickNamed('Comma-separated (CSV)'), download('Continue'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    expect(healed.confirmed).toBe(true);
    expect(healed.llmCalls).toBe(3);
    expect(healed.proposal.evidence.file?.rows).toBe(SANDBOX.erp.rowsInSeptember1000);
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    // The script lane's Export click is replayed (it opened the dialog), then the agent's radio and Continue.
    const steps = healed.proposal.steps.steps;
    const at = erpScript(portal.url).steps.length - 1;
    expect(steps.slice(at).map((s) => s.intent)).toEqual(['Open Export', 'Click Comma-separated (CSV)', 'Download with Continue']);
    expect(steps[at]).toEqual({ intent: 'Open Export', click: { role: 'button', name: 'Export' } });
    expect(json(healed.proposal.changes)).toContain('Open Export (click role \\"button\\" name \\"Export\\")');
    leakFree(healed);
    const v2 = approve(healed);
    const lane = await runScriptLane(laneInput(v2));
    if (!lane.ok) throw new Error(json(lane).slice(0, 800));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
    expect(healed.files[0].binaryName).toBe(lane.files[0].binaryName);
    const next = await runTask({ ...laneInput(v2), repair: { model: noModel, goal: GOAL, deliverUnconfirmed: true } });
    expect(next).toMatchObject({ ok: true, lane: 'script', version: 2 });
    leakFree(next);
  }, 120_000);

  it('a dialog export heals when the agent first tries download on Export (the click opened the dialog, no file)', async () => {
    // With the decoy the signed trigger {button "Export"} also matches "Export layout", so the script lane never clicks:
    // the agent starts on the result screen and, as a real model does, tries download on Export, which opens the dialog.
    portal.setState({ erp: 'dialog', erpDecoy: true });
    const model = fakeModel([download('Export'), clickNamed('Comma-separated (CSV)'), download('Continue'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    expect(healed.log.find((e) => e.intent === 'Export the line items')?.note).toContain('button "Export" matches 2 elements');
    expect(model.texts[1]).toMatch(/OK: clicked e\d+, but no file arrived within 3 s; the page may have changed \(a dialog or menu may have opened\), or the file may be slow/);
    expect(model.texts[1]).toContain('Comma-separated (CSV)');
    expect(healed.confirmed).toBe(true);
    expect(healed.llmCalls).toBe(4);
    expect(healed.proposal.evidence.file?.rows).toBe(SANDBOX.erp.rowsInSeptember1000);
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    // The agent's Export click is compiled before the radio; the base download is not kept (its click never happened).
    const steps = healed.proposal.steps.steps;
    const at = erpScript(portal.url).steps.length - 1;
    expect(steps.slice(at).map((s) => s.intent)).toEqual(['Click Export', 'Click Comma-separated (CSV)', 'Download with Continue']);
    // The agent's locator is exact, so it resolves despite "Export layout" (the signed trigger is not).
    expect(steps[at]).toMatchObject({ click: { role: 'button', name: 'Export', exact: true } });
    expect(steps[at + 1]).toMatchObject({ checkpoint: true });
    expect(json(steps)).not.toContain('Export layout');
    expect(healed.agentLog.filter((a) => a.tool !== 'look').map((a) => [a.tool, a.ok])).toEqual([['click', true], ['click', true], ['download', true], ['done', true]]);
    leakFree(healed);
    const v2 = approve(healed);
    const lane = await runScriptLane(laneInput(v2));
    if (!lane.ok) throw new Error(json(lane).slice(0, 800));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
    expect(healed.files[0].binaryName).toBe(lane.files[0].binaryName);
    const next = await runTask({ ...laneInput(v2), repair: { model: noModel, goal: GOAL, deliverUnconfirmed: true } });
    expect(next).toMatchObject({ ok: true, lane: 'script', version: 2 });
    leakFree(next);
  }, 120_000);

  it('a decoy file never passes and is never compiled', async () => {
    portal.setState({ erp: 'renamed', erpDecoy: true });
    const model = fakeModel([...renamedSelection(), download('Export layout'), download('Download spreadsheet'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    const decoyResult = model.texts[renamedSelection().length + 1];
    expect(decoyResult).toContain('did not pass the checks');
    expect(decoyResult).toContain('layout-settings.csv');
    expect(healed.agentLog.find((a) => a.intent === 'Download with Export layout')).toMatchObject({ tool: 'download', ok: false });
    expect(json(healed.proposal.steps)).not.toContain('Export layout');
    expect(json(healed.proposal.changes)).not.toContain('Export layout');
    expect(healed.files.map((f) => f.fileName)).toEqual([septemberFile]);
    leakFree(healed);
  }, 120_000);

  it('a wrong file only ends without a proposal', async () => {
    portal.setState({ erp: 'renamed', erpDecoy: true });
    const model = fakeModel([
      ...renamedSelection(), download('Export layout'), done('found', 'got it'), done('not_found', 'no passing export'),
      // The escalated second attempt (reopened post-login page) gives up straight away.
      done('not_found', 'no passing export'),
    ]);
    const r = await runTask(signed(erpScript(portal.url), { model }));
    expect(r).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    expect(model.texts[renamedSelection().length + 2]).toContain('refused: no file has passed the checks yet; use download');
    expect(r).not.toHaveProperty('proposal');
    expect(r).not.toHaveProperty('files');
    leakFree(r);
  }, 120_000);

  it('empty period ends without a proposal', async () => {
    const lane = await runScriptLane(signed(erpScript(portal.url), { vars: DECEMBER }));
    expect(lane).toMatchObject({ ok: false, code: 'drift_detected' });
    expect(lane.ok ? '' : lane.message).toContain('download check failed: the file has 0 rows');
    leakFree(lane);
    const model = fakeModel([download('Export'), done('not_found', 'the period has no line items'), done('not_found', 'the period has no line items')]);
    const r = await runTask(signed(erpScript(portal.url), { model, vars: DECEMBER }));
    expect(r).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    expect(model.texts[1]).toContain('did not pass the checks');
    expect(model.texts[1]).toContain('the file has 0 rows');
    expect(r).not.toHaveProperty('proposal');
    expect(r).not.toHaveProperty('files');
    leakFree(r);
  }, 120_000);

  it("the healed steps follow the run's variables", async () => {
    portal.setState({ erp: 'renamed' });
    const model = fakeModel([...renamedSelection(), download('Download spreadsheet'), done('found', 'the line-item CSV')]);
    const healed = await runTask(signed(erpScript(portal.url), { model }));
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(json(healed).slice(0, 1500));
    const steps = json(healed.proposal.steps);
    expect(steps).toContain('{{var.from}}');
    expect(steps).toContain('{{var.to}}');
    expect(steps).toContain('{{var.company}}');
    expect(steps).not.toContain(SANDBOX.erp.from);
    leakFree(healed);
    const v2 = approve(healed);
    const october = await runScriptLane(laneInput(v2, OCTOBER));
    if (!october.ok) throw new Error(json(october).slice(0, 800));
    expect(october.files.map((f) => f.fileName)).toEqual(['LINEITEMS_1000_2026-10-01_2026-10-31.csv']);
    leakFree(october);
  }, 120_000);

  it('a normal run that downloads the wrong report is drift', async () => {
    portal.setState({ erpDecoy: true });
    const edited = structuredClone(erpScript(portal.url));
    const last = edited.steps.at(-1)!;
    if (!('download' in last)) throw new Error('fixture changed');
    last.download.trigger = { role: 'button', name: 'Export layout' };
    const r = await runScriptLane(signed(edited));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected' });
    expect(r.ok ? '' : r.message).toContain('download check failed: file name "layout-settings.csv" does not match /^LINEITEMS_1000_/');
    expect(r).not.toHaveProperty('files');
    leakFree(r);
  });
});
