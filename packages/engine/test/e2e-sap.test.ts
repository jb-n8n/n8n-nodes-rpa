import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import type { ChatModel } from '../src/agent/model.js';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { runTask, type TaskInput, type TaskResult } from '../src/lane/task.js';
import { readPostLabel } from '../src/policy/read-posts.js';
import { signSteps, type SignedStepsRow } from '../src/proposal/proposal.js';
import type { PortalPolicy, Script, Step } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, use } from './fake-model.js';
import { APPROVER, fioriScript, LOCAL, policyFor, SAP_VARS, sapPolicy, SECRETS, SIGN_IN_STEPS, signedLaneInput, TEST_KEY, webguiScript } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const OUTPUT = { idPattern: SANDBOX.erp.idPattern };
const BATCH = '/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch';

function laneInput(script: Script, policy: PortalPolicy): ScriptLaneInput {
  return signedLaneInput(script, { policy, secrets: SECRETS, output: OUTPUT, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS });
}
const run = (script: Script, policy: PortalPolicy) => runScriptLane(laneInput(script, policy));
/** The same script with its last step replaced. */
const withLast = (script: Script, last: Step): Script => ({ ...script, steps: [...script.steps.slice(0, -1), last] });
const violationUrls = (r: { ok: boolean; violations?: { url: string }[] }) => (r.violations ?? []).map((v) => v.url).join(' ');

/** The renamed web GUI heals through AI repair, which refuses extractTable (repairPrecondition): the last step is an extract. */
const healScript = (): Script => withLast(webguiScript(portal.url), {
  intent: 'Read the line items', extract: { scope: { role: 'grid' }, idPattern: SANDBOX.erp.idPattern },
});
const noModel: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error('the model must not be called'); } }) };
const leakFree = (r: TaskResult) => {
  const text = JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after'].includes(k) ? undefined : v));
  for (const s of [SECRETS.username, SECRETS.password, SECRETS.totpSecret as string]) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
};

describe('SAP look-alikes: read-only POSTs end to end', () => {
  it('the classic web GUI fails without the list', async () => {
    const r = await run(webguiScript(portal.url), policyFor(portal));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
  });
  it('the classic web GUI runs with the list', async () => {
    const r = await run(webguiScript(portal.url), sapPolicy(portal));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 800));
    expect(r.rows).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
    expect(r.lane).toBe('script'); // the script lane never calls a model
    expect(r.submitted).toBeFalsy();
  });
  it('the Fiori app fails without the list and runs with it', async () => {
    const failed = await run(fioriScript(portal.url), policyFor(portal));
    expect(failed).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(violationUrls(failed as { ok: boolean; violations?: { url: string }[] })).toContain(BATCH);
    const r = await run(fioriScript(portal.url), sapPolicy(portal));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 800));
    expect(r.rows).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
    expect(r.lane).toBe('script'); // the script lane never calls a model
    expect(r.submitted).toBeFalsy();
  });
  it('the classic export downloads through a read-only POST', async () => {
    const script = withLast(webguiScript(portal.url), { intent: 'Export', download: { trigger: { role: 'button', name: 'Export' }, mime: ['text/csv'] } });
    const r = await run(script, sapPolicy(portal));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 800));
    expect(r.files[0]?.fileName).toBe('LINEITEMS_1000_2026-09-01_2026-09-30.csv');
    expect(r.submitted).toBeFalsy();
  });
  it('a POST not on the list is still blocked', async () => {
    const policy = { ...policyFor(portal), readPosts: [{ host: portal.host, path: BATCH }] };
    const r = await run(webguiScript(portal.url), policy);
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
  });
  it('a listed read that redirects to an unlisted path ends the run', async () => {
    const redirectScript = (to: string): Script => ({
      name: 'redirect', version: 1, startUrl: `${portal.url}/acme/login`,
      steps: [
        ...SIGN_IN_STEPS,
        { intent: 'Open the form', goto: `${portal.url}/sap/test/redirect-form?to=${to}` },
        { intent: 'Send', click: { role: 'button', name: 'Send' } },
      ],
    });
    const listed = { ...policyFor(portal), readPosts: [{ host: portal.host, path: '/sap/test/redirect' }] };
    const bad = await run(redirectScript('/acme/notices/acknowledge'), listed);
    expect(bad).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(violationUrls(bad as { ok: boolean; violations?: { url: string }[] })).toContain('/acme/notices/acknowledge');
    // A listed read that redirects to a path the list also covers (the web GUI entry, with a session segment) runs on.
    const to = encodeURIComponent('/sap(zzzzzzzzzz)/bc/gui/sap/its/webgui');
    const both = { ...sapPolicy(portal), readPosts: [...sapPolicy(portal).readPosts!, { host: portal.host, path: '/sap/test/redirect' }] };
    const hop = await run(redirectScript(to), both);
    if (!hop.ok) throw new Error(JSON.stringify(hop).slice(0, 800));
    expect((hop as { submitted?: boolean }).submitted).toBeFalsy();
  });
});

describe('a renamed web GUI heals with the read-only POSTs in the evidence', () => {
  const heal = async () => {
    portal.setState({ erp: 'renamed' });
    const model = fakeModel([
      clickNamed('G/L Line Items'),
      (t) => ({ name: 'select', args: { ref: refByName(t, 'Company Code'), value: '1000' } }),
      (t) => ({ name: 'fill', args: { ref: refByName(t, 'From'), value: SANDBOX.erp.from } }),
      (t) => ({ name: 'fill', args: { ref: refByName(t, 'To'), value: SANDBOX.erp.to } }),
      clickNamed('Run'),
      use('extract'),
      done('found', 'all line items'),
    ]);
    const input: TaskInput = signedLaneInput(healScript(), {
      policy: sapPolicy(portal), secrets: SECRETS, output: OUTPUT, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS,
      repair: { model, goal: 'Read the September line items.', deliverUnconfirmed: true },
    });
    return runTask(input);
  };
  it('carries the entries in the proposal evidence and the next run needs no model', async () => {
    const healed = await heal();
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(JSON.stringify(healed).slice(0, 800));
    expect(healed.proposal.evidence.readPosts).toEqual([readPostLabel(sapPolicy(portal).readPosts![0])]);
    expect(JSON.stringify(healed)).not.toContain('after a write was sent');
    const signedRow = signSteps({ proposal: healed.proposal, key: TEST_KEY, approverId: APPROVER, policy: sapPolicy(portal), secrets: SECRETS, reviewedDigest: healed.digest ?? '' });
    if (!signedRow.ok) throw new Error(signedRow.reasons.join('; '));
    const row: SignedStepsRow = signedRow.row;
    const next = await runTask({
      script: row.steps, trust: { required: true, signature: row.signature, approvedBy: row.approvedBy, key: TEST_KEY },
      policy: sapPolicy(portal), secrets: SECRETS, output: OUTPUT, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS,
      repair: { model: noModel, goal: 'Read the September line items.', deliverUnconfirmed: true },
    });
    expect(next).toMatchObject({ ok: true, lane: 'script' });
  }, 120_000);
  it('evidence names entries, never session paths', async () => {
    const healed = await heal();
    if (!healed.ok || healed.lane !== 'agent' || !healed.proposal) throw new Error(JSON.stringify(healed).slice(0, 800));
    expect(JSON.stringify(healed.proposal.evidence)).not.toContain('sap(');
    leakFree(healed);
    // The session id never reaches a result or log field (only the model transcript and the trace may hold it).
    const shown = JSON.stringify(healed, (k, v) => (['transcript', 'trace', 'screenshot', 'before', 'after'].includes(k) ? undefined : v));
    expect(shown).toContain('sap(');
    expect(shown).not.toMatch(/sap\((?!…)/);
  }, 120_000);
});

describe('the Fiori look-alike in a plain browser', () => {
  it('element ids stay unique on one page load however often Go is clicked', async () => {
    const login = await fetch(`${portal.url}/acme/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password }),
    });
    const [name, value] = (login.headers.get('set-cookie') ?? '').split(';')[0]!.split('=') as [string, string];
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name, value, url: portal.url }]);
      const page = await context.newPage();
      await page.goto(`${portal.url}${SANDBOX.erp.fioriPath}`);
      await page.getByRole('link', { name: 'Manage Line Items' }).click();
      await page.getByLabel('Company Code').fill(SANDBOX.erp.company);
      await page.getByLabel('From').fill(SANDBOX.erp.from);
      await page.getByLabel('To').fill(SANDBOX.erp.to);
      for (let k = 0; k < 30; k++) {
        const read = page.waitForResponse((r) => r.url().endsWith('/$batch'));
        await page.getByRole('button', { name: 'Go' }).click();
        await read;
        await page.getByRole('grid').waitFor();
        const ids = await page.evaluate(() => Array.from(document.querySelectorAll('[id]'), (e) => e.id));
        expect(new Set(ids).size, `after Go click ${k + 1}: ${ids.join(' ')}`).toBe(ids.length);
      }
      await expect(page.getByLabel('Company Code').inputValue()).resolves.toBe(SANDBOX.erp.company);
    } finally { await browser.close(); }
  });
});
