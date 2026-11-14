// The sandbox's renamed report screen (Line Item Report → G/L Line Items, Execute → Run, Export → Download spreadsheet):
// what a run, the import's replay and self-repair are told when a control is not there.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { adoptDraft } from '../src/import/adopt.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { IMPORT_CONTROL_GONE, SIGNED_CONTROL_GONE } from '../src/messages.js';
import type { Script, Step } from '../src/types.js';
import { done, fakeModel } from './fake-model.js';
import { LOCAL, SAP_VARS, sapPolicy, SECRETS, SIGN_IN_STEPS, signedLaneInput, webguiScript } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); portal.setState({ erp: 'renamed' }); });

const OUTPUT = { idPattern: SANDBOX.erp.idPattern };
const PAGE_SHOWS = 'The page shows these links and buttons: "G/L Line Items", "Enter".';

describe('a run that meets a control that is not there', () => {
  it('says what the page shows instead, as data too, and keeps the step\'s own message for self-repair', async () => {
    const r = await runScriptLane(signedLaneInput(webguiScript(portal.url), {
      policy: sapPolicy(portal), secrets: SECRETS, output: OUTPUT, endpoint: LOCAL, defaultStepTimeoutMs: 1000, vars: SAP_VARS,
    }));
    if (r.ok) throw new Error('expected a drift');
    expect(r.code).toBe('drift_detected');
    expect(r.message).toMatch(new RegExp(`^Open Line Item Report: No element found for Role and Name button "Line Item Report" on \\S+ after 1 s\\. ${PAGE_SHOWS.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} The page no longer has that control\\.`));
    expect(r.message.endsWith(SIGNED_CONTROL_GONE)).toBe(true);
    expect(r.message).not.toContain('were not checked');
    expect(r.missingControls).toEqual([{
      step: 5, intent: 'Open Line Item Report', lookedFor: 'Role and Name button "Line Item Report"', kind: 'buttons', offered: ['G/L Line Items', 'Enter'], more: 0,
    }]);
    expect(r.failure?.message).not.toContain('The page shows');
    expect(r.log.at(-1)?.note).not.toContain('The page shows');
  });

  it('self-repair is not given the list: its first message quotes the step\'s own failure', async () => {
    const model = fakeModel([done('not_found', 'stop here')]);
    const script: Script = { ...webguiScript(portal.url), steps: [...webguiScript(portal.url).steps.slice(0, -1), { intent: 'Read the line items', extract: { scope: { role: 'grid' }, idPattern: SANDBOX.erp.idPattern } }] };
    await runTask(signedLaneInput(script, {
      policy: sapPolicy(portal), secrets: SECRETS, output: OUTPUT, endpoint: LOCAL, defaultStepTimeoutMs: 1000, vars: SAP_VARS,
      repair: { model, goal: 'Read the September line items.' },
    }));
    const first = model.invocations[0]?.find((m) => m.role === 'user')?.content ?? '';
    expect(first).toContain('The approved script stopped at the step "Open Line Item Report": No element found');
    expect(first).not.toContain('The page shows');
  });
});

describe('the import\'s replay reports every missing control on the page', () => {
  const selection = (steps: Step[]): Script => ({
    name: 'renamed-fields', startUrl: `${portal.url}/acme/login`,
    steps: [
      ...SIGN_IN_STEPS,
      { intent: 'Open the report', goto: `${portal.url}${SANDBOX.erp.webguiPath}?~transaction=ZLINEITEMS` },
      ...steps,
      { intent: 'Read the line items', extractTable: { table: { role: 'grid' }, idPattern: SANDBOX.erp.idPattern } },
    ],
  });
  it('one replay names the three controls a renamed form lost, each with what the page shows, and stops before the next page', async () => {
    const r = await adoptDraft({
      draft: selection([
        { intent: 'Choose 1000 in Company', select: { field: { label: 'Company', exact: true }, value: '1000' } },
        { intent: 'Type into Date from', fill: { field: { label: 'Date from', exact: true }, value: '2026-09-01' } },
        { intent: 'Type into To', fill: { field: { label: 'To', exact: true }, value: '2026-09-30' } },
        { intent: 'Click Execute', click: { role: 'button', name: 'Execute', exact: true } },
      ]),
      policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 1000,
    });
    if (r.ok) throw new Error('expected a drift');
    expect(r.code).toBe('drift_detected');
    expect(r.message).toContain('Choose 1000 in Company: No element found for Form Label "Company" on ');
    // On the form nobody sets Find by: the replay says to change the step's control name, as JSON or in the file (B6-1).
    expect(r.message).toContain(` after 1 s. The page shows these fields and lists: "Company Code", "From", "To". ${IMPORT_CONTROL_GONE}`);
    expect(r.message).not.toContain('Find by');
    expect(r.failure?.message).toContain('Check the spelling or try Find by');
    expect(r.message).toContain(
      'Steps 6, 7 and 8 were checked on this page too, without acting. '
      + 'Step 6 (Type into Date from) cannot find Form Label "Date from" here either. The page shows these fields and lists: "From", "To", "Company Code". '
      + 'Step 8 (Click Execute) cannot find Role and Name button "Execute" here either. The page shows these links and buttons: "Run", "Back". '
      + 'Step 9 was not checked: it comes after a step that can change the page.',
    );
    expect(r.missingControls?.map((c) => [c.step, c.lookedFor, c.offered[0]])).toEqual([
      [5, 'Form Label "Company"', 'Company Code'], [6, 'Form Label "Date from"', 'From'], [8, 'Role and Name button "Execute"', 'Run'],
    ]);
  });
});
