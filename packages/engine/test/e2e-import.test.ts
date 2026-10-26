import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import type { ChatModel } from '../src/agent/model.js';
import { adoptDraft, type AdoptInput, type AdoptResult } from '../src/import/adopt.js';
import { importSource } from '../src/import/index.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { IMPORT_REFUSES_WRITES } from '../src/messages.js';
import { loginBlockEnd } from '../src/policy/validate.js';
import { signSteps, type SignedStepsRow } from '../src/proposal/proposal.js';
import type { PortalPolicy, PortalSecrets, Script } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, type FakeTurn } from './fake-model.js';
import { APPROVER, baselineScript, ERP_CHECK, LOCAL, policyFor, SAP_VARS, sapPolicy, SECRETS, TEST_KEY } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const FIXTURE = readFileSync(new URL('./fixtures/import/chrome-sap-export.json', import.meta.url), 'utf8');
const PLAYWRIGHT = readFileSync(new URL('./fixtures/import/playwright-sap-export.ts.txt', import.meta.url), 'utf8');
const IDP_TWO_STEP = readFileSync(new URL('./fixtures/import/chrome-idp-two-step.json', import.meta.url), 'utf8');
const UIPATH_LIGHT = fileURLToPath(new URL('./fixtures/import/uipath-sap-light/', import.meta.url));
const UIPATH_SSO2 = fileURLToPath(new URL('./fixtures/import/uipath-sap-sso2/', import.meta.url));
const ORIGIN = 'http://localhost:8080';
const ERP_DOWNLOAD = { mime: ['text/csv'], check: ERP_CHECK };
const septemberFile = `LINEITEMS_1000_${SANDBOX.erp.from}_${SANDBOX.erp.to}.csv`;
const json = (x: unknown) => JSON.stringify(x);

/** An SAP export recording, pointed at the sandbox, imported with the Expected File and the run variables. */
function importedDraft(source: 'chrome' | 'playwright' = 'chrome'): Script {
  const r = importSource(source, (source === 'chrome' ? FIXTURE : PLAYWRIGHT).split(ORIGIN).join(portal.url), {
    name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: ERP_DOWNLOAD,
  });
  expect(r.report.items.filter((i) => i.kind === 'error')).toEqual([]);
  expect(r.drafts).toHaveLength(1);
  return r.drafts[0].script;
}
/**
 * A UiPath project folder (by default the one recorded against the light sandbox: portal sign-in with an authentication
 * code, then the web GUI's Line Item Report), zipped under its project folder as a user uploads it, every address
 * pointed at the sandbox.
 */
function uipathZip(root = UIPATH_LIGHT): Buffer {
  const entries: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries[`SAP Line Item Export/${relative(root, path).split('\\').join('/')}`] = strToU8(readFileSync(path, 'utf8').split(ORIGIN).join(portal.url));
    }
  };
  walk(root);
  return Buffer.from(zipSync(entries));
}
const adopt = (draft: Script, over: Partial<AdoptInput> = {}): Promise<AdoptResult> => adoptDraft({
  draft, policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, vars: SAP_VARS, defaultStepTimeoutMs: 3000, ...over,
});
const approve = (r: AdoptResult): SignedStepsRow => {
  if (!r.ok) throw new Error(json(r).slice(0, 1500));
  const signed = signSteps({ proposal: r.proposal, key: TEST_KEY, approverId: APPROVER, policy: sapPolicy(portal), secrets: SECRETS, reviewedDigest: r.digest });
  if (!signed.ok) throw new Error(signed.reasons.join('; '));
  return signed.row;
};
const runSigned = (row: SignedStepsRow) => runScriptLane({
  script: row.steps, trust: { required: true, signature: row.signature, approvedBy: row.approvedBy, key: TEST_KEY },
  policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS,
});
/** Every Buffer under a `trace` key (the run's or the proof's scrubbed trace zip), unzipped: one text per entry. */
function traceTexts(r: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (Buffer.isBuffer(v)) {
      if (key === 'trace') for (const bytes of Object.values(unzipSync(v))) out.push(Buffer.from(bytes).toString('latin1'));
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(r);
  return out;
}
/**
 * No Site Login secret in the result's JSON or in any trace it carries (unzipped). Screenshots are images and are not
 * scanned here: the run masks the credential fields in them (screenshotMasks). Returns how many trace entries were read.
 */
const leakFree = (r: unknown, secrets: PortalSecrets = SECRETS): number => {
  const text = JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after'].includes(k) ? undefined : v));
  const traces = traceTexts(r);
  for (const s of [secrets.username, secrets.password, secrets.totpSecret as string]) {
    expect(text.toLowerCase()).not.toContain(s.toLowerCase());
    for (const t of traces) expect(t.toLowerCase().includes(s.toLowerCase())).toBe(false);
  }
  return traces.length;
};
const noModel: ChatModel = { bindTools: () => ({ invoke: async () => { throw new Error('the model must not be called'); } }) };
const typed = (tool: 'fill' | 'select', field: string, value: string): FakeTurn => (t) => ({ name: tool, args: { ref: refByName(t, field), value } });

describe('adopting imported steps against the sandbox portal', () => {
  it('a clean import proves and becomes version 1: the Chrome SAP export import adopts, signs and runs', async () => {
    const draft = importedDraft();
    const r = await adopt(draft, { repair: { model: noModel, goal: 'Download the line-item report' } });
    if (!r.ok) throw new Error(json(r).slice(0, 1500));
    expect(r).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(r.proposal).toMatchObject({ name: 'sap-export', baseVersion: null, version: 1 });
    expect(r.proposal.steps).toEqual(draft);
    expect(r.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(r).not.toHaveProperty('files');
    expect(r).not.toHaveProperty('rows');
    // The proof's trace rides on the proposal for the reviewer: it is scanned too.
    expect(r.proposal.trace).toBeInstanceOf(Buffer);
    expect(leakFree(r)).toBeGreaterThan(0);
    const row = approve(r);
    expect(row).toMatchObject({ name: 'sap-export', version: 1, status: 'active' });
    const lane = await runSigned(row);
    if (!lane.ok) throw new Error(json(lane).slice(0, 1500));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
    leakFree(lane);
  }, 120_000);

  it('with an authenticator code on the sign-in, the run and the proof each sign in with their own code', async () => {
    portal.setState({ mfa: 'totp' });
    const r = await adopt(importedDraft());
    if (!r.ok) throw new Error(json(r).slice(0, 1500));
    expect(r.lane).toBe('script');
    expect(r.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    leakFree(r);
  }, 120_000);

  it('a drifted import heals through repair', async () => {
    portal.setState({ erp: 'renamed' });
    // Without a model the adoption fails on the step that drifted.
    const plain = await adopt(importedDraft());
    expect(plain).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
    expect(plain.ok ? '' : plain.message).toContain('Line Item Report');
    expect(plain).not.toHaveProperty('proposal');
    leakFree(plain);
    // With one, the existing agent lane heals from the draft, proves, and its proposal signs.
    const model = fakeModel([
      clickNamed('G/L Line Items'),
      typed('select', 'Company Code', SAP_VARS.company),
      typed('fill', 'From', SAP_VARS.from),
      typed('fill', 'To', SAP_VARS.to),
      clickNamed('Run'),
      clickNamed('Download spreadsheet', 'download'),
      done('found', 'the line-item CSV'),
    ]);
    const healed = await adopt(importedDraft(), { repair: { model, goal: 'Download the line-item report' } });
    if (!healed.ok) throw new Error(json(healed).slice(0, 1500));
    expect(healed.lane).toBe('agent');
    expect(healed.llmCalls).toBeGreaterThan(0);
    // The draft was never signed: the healed steps are its first version, reviewed as a whole.
    expect(healed.proposal).toMatchObject({ name: 'sap-export', baseVersion: null, version: 1 });
    expect(healed.proposal.changes.every((c) => c.was === null)).toBe(true);
    expect(healed.proposal.safetyFlags).toContain('new download step');
    expect(healed.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(healed).not.toHaveProperty('files');
    leakFree(healed);
    const row = approve(healed);
    expect(row.version).toBe(1);
    const lane = await runSigned(row);
    if (!lane.ok) throw new Error(json(lane).slice(0, 1500));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
    leakFree(lane);
  }, 180_000);

  it('the Playwright SAP export import adopts, signs and runs', async () => {
    const draft = importedDraft('playwright');
    const r = await adopt(draft);
    if (!r.ok) throw new Error(json(r).slice(0, 1500));
    expect(r).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(r.proposal).toMatchObject({ baseVersion: null, version: 1, steps: draft });
    expect(r.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    leakFree(r);
    const lane = await runSigned(approve(r));
    if (!lane.ok) throw new Error(json(lane).slice(0, 1500));
    expect(lane.files.map((f) => f.fileName)).toEqual([septemberFile]);
  }, 120_000);

  it('the UiPath project recorded against the light web GUI adopts as version 1, signs, and a follow-up run delivers the file with no model', async () => {
    const r = importSource('uipath', uipathZip(), { name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: ERP_DOWNLOAD });
    expect(r.report.items.filter((i) => i.kind === 'error' || i.kind === 'untranslated')).toEqual([]);
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Dealer user ID', 'Password', 'Authentication code']);
    expect(r.flow?.nodes.filter((n) => n.kind === 'browser')).toHaveLength(1);
    expect(r.drafts).toHaveLength(1);
    const draft = r.drafts[0].script;
    expect(draft.name).toBe('sap-export-1');
    // The same flow as the Chrome recording: sign-in with a code, the web GUI, the report's selection, the checked export.
    expect(draft.steps.map((s) => Object.keys(s).find((k) => k !== 'intent' && k !== 'expect'))).toEqual(
      ['goto', 'signIn', 'goto', 'click', 'select', 'fill', 'fill', 'click', 'download'],
    );
    expect(json(draft)).not.toContain(ORIGIN);

    const adopted = await adopt(draft, { repair: { model: noModel, goal: 'Download the line-item report' }, saveTrace: 'always' });
    if (!adopted.ok) throw new Error(json(adopted).slice(0, 1500));
    expect(adopted).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(adopted.proposal).toMatchObject({ name: 'sap-export-1', baseVersion: null, version: 1 });
    expect(adopted.proposal.steps).toEqual({ ...draft, version: 1 });
    expect(adopted.proposal.evidence.file).toMatchObject({ fileName: septemberFile, rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(adopted.proposal.trace).toBeInstanceOf(Buffer);
    expect(leakFree(adopted)).toBeGreaterThan(0);

    const row = approve(adopted);
    expect(row).toMatchObject({ name: 'sap-export-1', version: 1, status: 'active' });
    // The follow-up run: signed steps, AI Repair connected to a model that must never be called.
    const run = await runTask({
      script: row.steps, trust: { required: true, signature: row.signature, approvedBy: row.approvedBy, key: TEST_KEY },
      policy: sapPolicy(portal), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: SAP_VARS, saveTrace: 'always',
      repair: { model: noModel, goal: 'Download the line-item report' },
    });
    if (!run.ok) throw new Error(json(run).slice(0, 1500));
    expect(run.lane).toBe('script');
    expect(run.files.map((f) => f.fileName)).toEqual([septemberFile]);
    expect(leakFree(run)).toBeGreaterThan(0);
  }, 120_000);

  it('a rows draft (notices, with an ID Pattern) adopts, signs and reads the same rows', async () => {
    const policy = policyFor(portal);
    const output = { idPattern: 'N26-\\d{4}' };
    const draft: Script = { ...baselineScript(portal.url), name: 'imported-notices' };
    const r = await adopt(draft, { policy, output, vars: {} });
    if (!r.ok) throw new Error(json(r).slice(0, 1500));
    expect(r).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(r.proposal).toMatchObject({ name: 'imported-notices', baseVersion: null, version: 1 });
    expect(r.proposal.evidence.count).toBeGreaterThan(0);
    expect(r.proposal.evidence.diff).toEqual({ missing: [], extra: [] });
    expect(r.proposal.evidence.file).toBeUndefined();
    leakFree(r);
    const signed = signSteps({ proposal: r.proposal, key: TEST_KEY, approverId: APPROVER, policy, secrets: SECRETS, reviewedDigest: r.digest });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    const lane = await runScriptLane({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: APPROVER, key: TEST_KEY },
      policy, secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, output,
    });
    if (!lane.ok) throw new Error(json(lane).slice(0, 1500));
    expect(lane.rows).toHaveLength(r.proposal.evidence.count);
  }, 120_000);

  it('adoption never writes: a declared form post is refused before the browser, a click that posts is blocked', async () => {
    const policy = policyFor(portal);
    const reportDraft = (download: Record<string, unknown>): Script => ({
      name: 'report-export', version: 1, startUrl: `${portal.url}/acme/login`,
      steps: [
        { intent: 'Sign in', signIn: { username: { label: 'Dealer user ID' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Sign in' } } },
        { intent: 'Open Reports', click: { role: 'link', name: 'Reports', exact: true, within: { role: 'navigation' } } },
        { intent: 'Export the report', download: { trigger: { role: 'button', name: 'Export CSV' }, check: { name: '\\.csv$' }, ...download } as never },
      ],
    });
    const declared = await adopt(reportDraft({ via: { path: '/acme/reports/export' } }), { policy });
    expect(declared).toMatchObject({ ok: false, code: 'policy_violation', message: IMPORT_REFUSES_WRITES });
    leakFree(declared);
    // The same export as a plain download: its button posts the report form, which the no-write policy blocks, even
    // though the portal policy lists that submission.
    const posted = await adopt(reportDraft({}), { policy });
    expect(posted).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(posted).not.toHaveProperty('proposal');
    expect(posted.ok ? [] : posted.violations.map((v) => v.url)).toContainEqual(expect.stringContaining('/acme/reports/export'));
    leakFree(posted);
  }, 120_000);
});

// The realistic SAP look-alike behind the identity-first identity provider (sso2), recorded in Chrome:
// email, Next, password, Sign in, code, Verify, "Stay signed in?" No, then the classic GUI's spreadsheet export. The
// same portal, switched per test (the server reads the mode per request).
describe('adopting an imported identity-first sign-in (sso2)', () => {
  const SSO2: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
  const XLSX_CHECK = { name: '\\.XLSX$', columns: ['Document No.', 'Posting Date', 'Company Code', 'Amount', 'Currency'], minRows: 1 };
  const saved = { sap: process.env.SANDBOX_SAP, login: process.env.SANDBOX_SAP_LOGIN };
  beforeEach(() => { process.env.SANDBOX_SAP = 'realistic'; process.env.SANDBOX_SAP_LOGIN = 'sso2'; });
  afterEach(() => {
    for (const [key, value] of [['SANDBOX_SAP', saved.sap], ['SANDBOX_SAP_LOGIN', saved.login]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Every page of the sign-in is a login page: the email page and the password page (the username is a secret too), the
  // code page, the "Stay signed in?" answer the recorded No click posts (adoption's no-write policy allows no other
  // post), and SAP's assertion consumer service.
  const policy = (): PortalPolicy => ({
    startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
    navHosts: [portal.host],
    subresourceHosts: [],
    login: ['/idp/login', '/idp/password', '/idp/mfa', '/idp/kmsi', '/sap/saml2/acs'].map((path) => ({ host: portal.host, path })),
    allowedSubmits: [],
    readPosts: [{ host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }],
    allowPrivateNetwork: true,
  });

  it('the Chrome recording imports to signIn with next, adopts as version 1 with no model, signs, and a follow-up run delivers the XLSX with no model', async () => {
    const r = importSource('chrome', IDP_TWO_STEP.split(ORIGIN).join(portal.url), {
      name: 'sap-sso2-export', hasSiteLogin: true, secrets: SSO2, download: { check: XLSX_CHECK },
    });
    expect(r.report.items.filter((i) => i.kind === 'error' || i.kind === 'untranslated')).toEqual([]);
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(r.drafts).toHaveLength(1);
    const draft = r.drafts[0].script;
    expect(draft.steps.map((s) => Object.keys(s).find((k) => k !== 'intent' && k !== 'expect' && k !== 'when'))).toEqual(
      ['goto', 'signIn', 'click', 'click', 'fill', 'fill', 'fill', 'click', 'click', 'download'],
    );
    expect(draft.steps[1]).toMatchObject({ signIn: { next: { role: 'button', name: 'Next' }, totp: expect.anything() } });
    // "Stay signed in?" No is gated: the login block ends after it.
    expect(draft.steps[2]).toMatchObject({ when: { visible: { role: 'button', name: 'No', exact: true } }, click: { role: 'button', name: 'No' } });
    expect(loginBlockEnd(draft)).toBe(2);
    expect(json(draft)).not.toContain(ORIGIN);
    leakFree(r, SSO2);

    const adopted = await adoptDraft({
      draft, policy: policy(), secrets: SSO2, endpoint: LOCAL, defaultStepTimeoutMs: 5000, saveTrace: 'always',
      repair: { model: noModel, goal: 'Download the line-item spreadsheet' },
    });
    if (!adopted.ok) throw new Error(json(adopted).slice(0, 1500));
    expect(adopted).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(adopted.proposal).toMatchObject({ name: 'sap-sso2-export', baseVersion: null, version: 1 });
    expect(adopted.proposal.steps).toEqual({ ...draft, version: 1 });
    expect(adopted.proposal.evidence.file).toMatchObject({ fileName: 'export.XLSX', rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(adopted.proposal.trace).toBeInstanceOf(Buffer);
    expect(leakFree(adopted, SSO2)).toBeGreaterThan(0);

    const signed = signSteps({ proposal: adopted.proposal, key: TEST_KEY, approverId: APPROVER, policy: policy(), secrets: SSO2, reviewedDigest: adopted.digest });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    expect(signed.row).toMatchObject({ name: 'sap-sso2-export', version: 1, status: 'active' });
    const run = await runTask({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: signed.row.approvedBy, key: TEST_KEY },
      policy: policy(), secrets: SSO2, endpoint: LOCAL, defaultStepTimeoutMs: 5000, saveTrace: 'always',
      repair: { model: noModel, goal: 'Download the line-item spreadsheet' },
    });
    if (!run.ok) throw new Error(json(run).slice(0, 1500));
    expect(run.lane).toBe('script');
    expect((run as { llmCalls?: number }).llmCalls ?? 0).toBe(0);
    expect(run.files.map((f) => f.fileName)).toEqual(['export.XLSX']);
    const strings = strFromU8(unzipSync(new Uint8Array(run.files[0].data))['xl/sharedStrings.xml']!);
    expect([...strings.matchAll(/>(19\d{8})</g)]).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
    expect(run.violations).toHaveLength(0);
    expect(run.log.find((e) => e.intent === 'Click No')?.status).toBe('ok');
    expect(leakFree(run, SSO2)).toBeGreaterThan(0);
  }, 180_000);
  // The UiPath project of a realistic migration: the code typed from a TOTP activity's output and
  // "Stay signed in?" answered No, with the prompt on (IDP_KMSI default). Before this was supported, the code step was reported and
  // the plain No ended the login block at signIn, so a proof's reused session sat on the identity provider.
  const SSO2_VARS = { strFromDate: '01.09.2026', strToDate: '30.09.2026' };
  const importSso2UiPath = (): Script => {
    const r = importSource('uipath', uipathZip(UIPATH_SSO2), { name: 'sap-sso2', hasSiteLogin: true, secrets: SSO2, vars: SSO2_VARS, download: { check: XLSX_CHECK } });
    expect(r.report.items.filter((i) => i.kind === 'error' || i.kind === 'untranslated')).toEqual([]);
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(r.drafts).toHaveLength(1);
    const draft = r.drafts[0].script;
    expect(draft.steps[1]).toMatchObject({ signIn: { next: expect.anything(), totp: { field: { label: 'Code' } } } });
    expect(draft.steps[2]).toMatchObject({ intent: 'Click No', when: expect.anything() });
    expect(loginBlockEnd(draft)).toBe(2);
    expect(json(draft)).not.toContain(ORIGIN);
    leakFree(r, SSO2);
    return draft;
  };
  const signAndRunWithNoModel = async (proposal: Extract<AdoptResult, { ok: true }>, version: number) => {
    const signed = signSteps({ proposal: proposal.proposal, key: TEST_KEY, approverId: APPROVER, policy: policy(), secrets: SSO2, reviewedDigest: proposal.digest });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    expect(signed.row).toMatchObject({ name: 'sap-sso2-1', version, status: 'active' });
    const run = await runTask({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: signed.row.approvedBy, key: TEST_KEY },
      policy: policy(), secrets: SSO2, endpoint: LOCAL, defaultStepTimeoutMs: 5000, vars: SSO2_VARS, saveTrace: 'always',
      repair: { model: noModel, goal: 'Download the line-item spreadsheet' },
    });
    if (!run.ok) throw new Error(json(run).slice(0, 1500));
    expect(run.lane).toBe('script');
    expect(run.files.map((f) => f.fileName)).toEqual(['export.XLSX']);
    const strings = strFromU8(unzipSync(new Uint8Array(run.files[0].data))['xl/sharedStrings.xml']!);
    expect([...strings.matchAll(/>(19\d{8})</g)]).toHaveLength(SANDBOX.erp.rowsInSeptember1000);
    expect(run.violations).toHaveLength(0);
    expect(run.log.find((e) => e.intent === 'Click No')?.status).toBe('ok');
    expect(leakFree(run, SSO2)).toBeGreaterThan(0);
  };

  it('the UiPath project with a TOTP activity and "Stay signed in?" imports, adopts as version 1 with no model, signs, and a follow-up run delivers', async () => {
    const draft = importSso2UiPath();
    const adopted = await adoptDraft({
      draft, policy: policy(), secrets: SSO2, endpoint: LOCAL, defaultStepTimeoutMs: 5000, vars: SSO2_VARS, saveTrace: 'always',
      repair: { model: noModel, goal: 'Download the line-item spreadsheet' },
    });
    if (!adopted.ok) throw new Error(json(adopted).slice(0, 1500));
    expect(adopted).toMatchObject({ lane: 'script', llmCalls: 0 });
    expect(adopted.proposal).toMatchObject({ name: 'sap-sso2-1', baseVersion: null, version: 1 });
    expect(adopted.proposal.steps).toEqual({ ...draft, version: 1 });
    expect(adopted.proposal.evidence.file).toMatchObject({ fileName: 'export.XLSX', rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(leakFree(adopted, SSO2)).toBeGreaterThan(0);
    await signAndRunWithNoModel(adopted, 1);
  }, 180_000);

  it('the same import heals when the report screen drifted: the repair proves past the "Stay signed in?" prompt, signs, and the next run needs no model', async () => {
    portal.setState({ erp: 'renamed' });
    const typedIn = (field: string, value: string): FakeTurn => (t) => ({ name: 'fill', args: { ref: refByName(t, field), value } });
    const model = fakeModel([
      clickNamed('G/L Line Items'), typedIn('Company Code', '1000'), typedIn('From', '01.09.2026'), typedIn('To', '30.09.2026'), clickNamed('Run (F8)'),
      clickNamed('Export to Spreadsheet'), clickNamed('Continue (Enter)', 'download'), done('found', 'the line-item spreadsheet'),
    ]);
    const healed = await adoptDraft({
      draft: importSso2UiPath(), policy: policy(), secrets: SSO2, endpoint: LOCAL, defaultStepTimeoutMs: 5000, vars: SSO2_VARS, saveTrace: 'always',
      repair: { model, goal: 'Download the line-item spreadsheet' },
    });
    if (!healed.ok) throw new Error(json(healed).slice(0, 1500));
    expect(healed.lane).toBe('agent');
    expect(healed.llmCalls).toBeGreaterThan(0);
    expect(healed.proposal).toMatchObject({ name: 'sap-sso2-1', baseVersion: null, version: 1 });
    // The login block is kept as imported: the sign-in and the gated answer.
    expect(healed.proposal.steps.steps.slice(1, 3)).toEqual(importSso2UiPath().steps.slice(1, 3));
    expect(healed.proposal.evidence.file).toMatchObject({ fileName: 'export.XLSX', rows: SANDBOX.erp.rowsInSeptember1000 });
    expect(leakFree(healed, SSO2)).toBeGreaterThan(0);
    await signAndRunWithNoModel(healed, 1);
  }, 240_000);
});
