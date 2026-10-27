import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { runScriptLane, screenshotMasks, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { ENDPOINT_NOT_SECURE, nameMismatch, offListSite, privateAddress, UNSIGNED_REQUIRED, UNSIGNED_WRITES } from '../src/messages.js';
import type { Script, Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, reportScript, SECRETS, SIGN_IN_STEPS, signedLaneInput, TEST_KEY } from './helpers.js';
import { notReachedNetworkIdle, tooManyRows } from '../src/messages.js';
import { publicPolicy } from './helpers.js';
import { bound } from './timing.js';
const TOTAL_PATTERN = 'Showing \\d+[-–]\\d+ of (\\d+)';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

function input(script: Script, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput {
  return signedLaneInput(script, {
    policy: policyFor(portal), secrets: SECRETS, output: { idPattern: 'N26-\\d{4}', totalPattern: TOTAL_PATTERN },
    endpoint: LOCAL, defaultStepTimeoutMs: 3000, ...over,
  });
}
const sorted = (a: string[]) => [...a].sort();

describe('runScriptLane', () => {
  it('baseline portal: all seven notices, no LLM, signed version reported', async () => {
    const r = await runScriptLane(input(baselineScript(portal.url)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lane).toBe('script');
    expect(r.version).toBe(1);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sorted(r.rows.map((x) => x.id))).toEqual(sorted(SANDBOX.bulletins));
    expect(r.violations).toEqual([]);
    expect(r).toMatchObject({ name: 'demo-sandbox', verified: true, confirmed: true, page: { status: 200 } });
    expect(r.page.url).toContain('/acme/service/recalls-and-stop-sales');
  });
  it('a success keeps the non-fatal violations it blocked', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Open socket page', goto: '/acme/p/ws' } as Step);
    s.steps.push({ intent: 'Socket page shown', waitFor: { target: { css: '#ws-page' } } } as Step);
    const r = await runScriptLane(input(s));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'websocket', fatal: false }));
  });
  it('handles pagination, accordion, cookie banner, modal, survey and TOTP in one release', async () => {
    portal.setState({ paginate: true, render: 'accordion', interrupts: ['cookie-banner', 'whats-new-modal', 'survey'], mfa: 'totp' });
    const r = await runScriptLane(input(baselineScript(portal.url)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toHaveLength(7);
  });
  it('a renamed section is drift, with the failing intent and a screenshot', async () => {
    portal.setState({ label: 'Field Actions' });
    const r = await runScriptLane(input(baselineScript(portal.url)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('drift_detected');
    expect(r.failure?.intent).toBe('Open Recalls & Stop-Sales');
    expect(r.screenshot?.length).toBeGreaterThan(1000);
    expect(r.credentialsSubmitted).toBe(true);
    expect(r.lastCheckpoint).toBe(-1);
  });
  it('a failure after a checkpoint reports it for resume', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Open archive', click: { css: '#never' } } as Step);
    const r = await runScriptLane(input(s));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('drift_detected');
    expect(r.lastCheckpoint).toBe(4);
    expect(r.credentialsSubmitted).toBe(true);
  });
  it('SMS MFA is auth_blocked; a wrong password is login_failed and never leaks', async () => {
    portal.setState({ mfa: 'sms' });
    const sms = await runScriptLane(input(baselineScript(portal.url)));
    expect(sms.ok).toBe(false);
    if (!sms.ok) expect(sms.code).toBe('auth_blocked');
    portal.reset();
    const bad = await runScriptLane(input(baselineScript(portal.url), { secrets: { ...SECRETS, password: 'wrong-pass-123' } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('login_failed');
    const { screenshot: _s, ...rest } = bad as { screenshot?: Buffer };
    expect(JSON.stringify(rest)).not.toContain('wrong-pass-123');
  });
  it('a tampered script is untrusted and never opens a browser', async () => {
    const script = baselineScript(portal.url);
    const inp = input(script);
    const tampered = { ...inp, script: { ...script, version: 2 } };
    const r = await runScriptLane(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r).toMatchObject({ code: 'script_untrusted', message: UNSIGNED_REQUIRED }); expect(r.durationMs).toBeLessThan(bound(500)); }
  });
  it('an undeclared submit is a policy violation before any browser work', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Acknowledge', submit: { button: { css: '#acknowledge' }, path: '/acme/notices/acknowledge' } } as Step);
    const r = await runScriptLane(input(s));
    if (!r.ok) { expect(r.code).toBe('policy_violation'); expect(r.message).toMatch(/not an allowed submission/); } else throw new Error('expected failure');
  });
  it('a download run needs no output spec: the file comes back and no rows are verified', async () => {
    const r = await runScriptLane(input(reportScript(portal.url), { vars: { from: '2000-01-01' }, output: undefined }));
    if (!r.ok) throw new Error(r.message);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].mimeType).toBe('text/csv');
    expect(r).toMatchObject({ verified: false, confirmed: false, rows: [] });
  });
  it('a pre-aborted signal is cancelled without opening a browser', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runScriptLane(input(baselineScript(portal.url), { signal: ac.signal }));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('incomplete');
    expect(r.message).toBe('run cancelled');
    expect(r.durationMs).toBeLessThan(bound(500));
  });
  it('aborting mid-run cancels it', async () => {
    const s = baselineScript(portal.url);
    s.steps.unshift({ intent: 'Maybe wait', optional: true, timeoutMs: 20_000, waitFor: { target: { css: '#never' } } } as Step);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 500);
    const t0 = Date.now();
    const r = await runScriptLane(input(s, { signal: ac.signal }));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('incomplete');
    expect(r.message).toBe('run cancelled');
    expect(Date.now() - t0).toBeLessThan(bound(10_000, 20_000));
  });
  it('aborting while a click waits for a missing element returns at once, not after the step timeout', async () => {
    portal.setState({ label: 'Field Actions' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const t0 = Date.now();
    const r = await runScriptLane(input(baselineScript(portal.url), { signal: ac.signal, defaultStepTimeoutMs: 20_000 }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'incomplete', message: 'run cancelled' });
    expect(Date.now() - t0).toBeLessThan(bound(6000, 20_000));
  });
  it('aborting during a waitFor hasText wait returns at once, not after the step timeout', async () => {
    const s = baselineScript(portal.url);
    s.steps.unshift({ intent: 'Wait for a text that never shows', timeoutMs: 20_000, waitFor: { target: { css: 'body' }, hasText: 'never-shown-text' } } as Step);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const t0 = Date.now();
    const r = await runScriptLane(input(s, { signal: ac.signal, defaultStepTimeoutMs: 20_000 }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'incomplete', message: 'run cancelled' });
    expect(Date.now() - t0).toBeLessThan(bound(6000, 20_000));
  });
  // Regression: per-page reads inside paginate logged index 0 instead of their paginate step's index
  it('steps nested in paginate log under the paginate step index', async () => {
    portal.setState({ paginate: true });
    const s = baselineScript(portal.url);
    const at = s.steps.findIndex((st) => 'paginate' in st);
    const r = await runScriptLane(input(s));
    expect(r.ok).toBe(true);
    const pages = r.log.filter((e) => e.intent === 'Read notices on this page');
    expect(pages).toHaveLength(2);
    expect(pages.every((e) => e.index === at)).toBe(true);
    expect(r.log.map((e) => e.index)).toEqual([...r.log.map((e) => e.index)].sort((a, b) => a - b));
  });
  it('reading only page 1 of 2 is incomplete', async () => {
    portal.setState({ paginate: true });
    const firstPageOnly = { ...baselineScript(portal.url), steps: baselineScript(portal.url).steps.map((st) => ('paginate' in st ? st.paginate.each[0] : st)) };
    const r = await runScriptLane(input(firstPageOnly));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe('incomplete'); expect(r.message).toMatch(/^Expected 7 rows \(the page says "Showing 1-4 of 7"\) but found 4\. Nothing was marked successful\.$/); }
  });
  it('a blown budget is incomplete', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Wait forever', timeoutMs: 20_000, waitFor: { target: { css: '#never' } } } as Step);
    const r = await runScriptLane(input(s, { budgetMs: 4000 }));
    if (!r.ok) expect(r.code).toBe('incomplete'); else throw new Error('expected failure');
  });
  it('an off-list redirect is a policy violation, not a budget overrun', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Go to redirect page', goto: '/acme/p/redirect-out' } as Step);
    const r = await runScriptLane(input(s));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('policy_violation');
    expect(r.message).not.toMatch(/budget/);
    expect(r.message).toBe(`Go to redirect page: ${offListSite(`localhost:${portal.port}`, [portal.host])}`);
    expect(r.violations.some((v) => v.fatal)).toBe(true);
  });
  it('a remote endpoint without wss is browser_unavailable', async () => {
    const r = await runScriptLane(input(baselineScript(portal.url), { endpoint: { mode: 'playwright', wsUrl: 'ws://browser.example:3000/' } }));
    if (!r.ok) expect(r).toMatchObject({ code: 'browser_unavailable', message: ENDPOINT_NOT_SECURE }); else throw new Error('expected failure');
  });
  it('an optional wait that burns the budget cannot yield a partial success', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Maybe wait', optional: true, timeoutMs: 20_000, waitFor: { target: { css: '#never' } } } as Step);
    s.steps.push({ intent: 'Maybe archived', when: { visible: { css: '#never' } }, click: { css: '#never' } } as Step);
    const r = await runScriptLane(input(s, { budgetMs: 4000 }));
    if (!r.ok) expect(r.code).toBe('incomplete'); else throw new Error('expected failure');
  });
  it('screenshotMasks covers inputs and, for secrets of 3+ chars, the username and password text', () => {
    const page = { locator: () => ({}), getByText: () => ({}) } as never;
    expect(screenshotMasks(page, { ...SECRETS, username: 'abc' })).toHaveLength(3);
    expect(screenshotMasks(page, { ...SECRETS, username: 'ab' })).toHaveLength(2);
    expect(screenshotMasks(page, { ...SECRETS, username: 'ab', password: 'xy' })).toHaveLength(1);
    expect(screenshotMasks(page, { ...SECRETS, username: 'ab', password: 'xyz' })).toHaveLength(2);
  });
  it('masks secrets in violation URLs pushed by step handlers', async () => {
    // signIn on a page that is not a declared login page records a violation with that page's URL.
    const s: Script = { name: 'demo-sandbox', version: 1, startUrl: `${portal.url}/acme/p/ws`, steps: [SIGN_IN_STEPS[0]] };
    // The endpoint token is a secret the masker knows but the policy validator does not look for in scripts.
    const r = await runScriptLane(input(s, { endpoint: { ...LOCAL, token: 'acme/p/ws' } }));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('policy_violation');
    const signin = r.violations.find((v) => v.kind === 'signin');
    expect(signin?.url).toContain('[secret]');
    expect(JSON.stringify(r.violations)).not.toContain('acme/p/ws');
  });
  it('a 404 start page is drift; a 403 start page is site_down', async () => {
    const at = (code: number): Script => ({ ...baselineScript(portal.url), startUrl: `${portal.url}/acme/p/status/${code}` });
    const gone = await runScriptLane(input(at(404)));
    if (gone.ok) throw new Error('expected failure');
    expect(gone.code).toBe('drift_detected');
    expect(gone.message).toBe('HTTP 404 at the start page');
    const blocked = await runScriptLane(input(at(403)));
    if (blocked.ok) throw new Error('expected failure');
    expect(blocked.code).toBe('site_down');
    expect(blocked.message).toBe('HTTP 403 at the start page');
  });
  it('a login page served with HTTP 401 still signs in', async () => {
    const script = { ...baselineScript(portal.url), startUrl: `${portal.url}/acme/login?status=401` };
    const r = await runScriptLane(input(script));
    expect(r.ok).toBe(true);
  });
  it('keeps a scrubbed trace on failure by default, always when asked, never when told not to', async () => {
    const textOf = (zip: Buffer) => Object.values(unzipSync(zip)).map((b) => strFromU8(b)).join('\n');
    portal.setState({ label: 'Field Actions' });
    const failed = await runScriptLane(input(baselineScript(portal.url)));
    if (failed.ok) throw new Error('expected failure');
    expect(failed.trace?.length).toBeGreaterThan(1000);
    expect(textOf(failed.trace as Buffer)).not.toContain(SECRETS.password);
    expect(textOf(failed.trace as Buffer)).not.toContain(SECRETS.username);
    const never = await runScriptLane(input(baselineScript(portal.url), { saveTrace: 'never' }));
    expect(never.trace).toBeUndefined();
    portal.reset();
    const ok = await runScriptLane(input(baselineScript(portal.url)));
    expect(ok.ok).toBe(true);
    expect(ok.trace).toBeUndefined();
    const always = await runScriptLane(input(baselineScript(portal.url), { saveTrace: 'always' }));
    expect(always.trace?.length).toBeGreaterThan(1000);
  });
  it('a policy violation keeps its trace', async () => {
    const s = baselineScript(portal.url);
    s.steps.push({ intent: 'Go to redirect page', goto: '/acme/p/redirect-out' } as Step);
    const r = await runScriptLane(input(s));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('policy_violation');
    expect(r.trace?.length).toBeGreaterThan(1000);
  });
  it('a legitimately empty portal passes only with an empty pattern that matches the page', async () => {
    portal.setState({ content: 'removed' });
    const strict = await runScriptLane(input(baselineScript(portal.url)));
    expect(strict.ok).toBe(false);
    if (!strict.ok) { expect(strict.code).toBe('incomplete'); expect(strict.message).toMatch(/no rows were extracted/); }
    const allowed = await runScriptLane(input(baselineScript(portal.url), { output: { idPattern: 'N26-\\d{4}', emptyPattern: 'No active notices' } }));
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.rows).toEqual([]);
  });
});

describe('trust gate at the lane', () => {
  // If anything opened this endpoint the result would be browser_unavailable, never script_untrusted.
  const NEVER_OPENED = { mode: 'playwright' as const, wsUrl: 'ws://browser.invalid:1/' };
  it('a refused trust check opens no browser', async () => {
    const r = await runScriptLane(input(baselineScript(portal.url), { endpoint: NEVER_OPENED, trust: { required: true, key: TEST_KEY } }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'script_untrusted', message: UNSIGNED_REQUIRED });
    expect(r.durationMs).toBeLessThan(bound(500));
  });
  it('unsigned steps that sign in need Allow Unsigned Writes', async () => {
    const unsigned = await runScriptLane(input(baselineScript(portal.url), { endpoint: NEVER_OPENED, trust: { required: false } }));
    expect(unsigned).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_WRITES });
    const allowed = await runScriptLane(input(baselineScript(portal.url), { trust: { required: false, allowUnsignedWrites: true } }));
    expect(allowed).toMatchObject({ ok: true, lane: 'script', version: 1 });
  });
  it('unsigned writes are refused when the start page comes from the default start URL', async () => {
    const { startUrl: _start, ...rest } = baselineScript(portal.url);
    const relative = { ...rest, steps: [{ intent: 'Open the sign-in page', goto: '/acme/login' }, ...rest.steps] };
    const r = await runScriptLane(input(baselineScript(portal.url), { script: relative, endpoint: NEVER_OPENED, trust: { required: false } }));
    expect(r).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_WRITES });
  });
  it('{} passes the gate when unsigned and fails the shape check as policy_violation', async () => {
    const r = await runScriptLane({ ...input(baselineScript(portal.url)), script: {}, endpoint: NEVER_OPENED, trust: { required: false } });
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
  });
  it('a signed document with broken steps is a policy_violation and opens no browser', async () => {
    const doc = { name: 'broken', version: 1, startUrl: portal.url, steps: 'nope' };
    const r = await runScriptLane({ ...input(baselineScript(portal.url)), ...signedLaneInput(doc, { endpoint: NEVER_OPENED }) });
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
  });
  it('Name must equal the signed name', async () => {
    const base = input(baselineScript(portal.url));
    const r = await runScriptLane({ ...base, trust: { ...base.trust, expect: { name: 'other-site' } } });
    expect(r).toMatchObject({ ok: false, code: 'script_untrusted', message: nameMismatch('demo-sandbox', 'other-site') });
  });
});

describe('an invalid read-only list at the lane', () => {
  it('fails policy_violation with the message, before any browser opens', async () => {
    const doc: Script = { name: 'public-table', version: 1, startUrl: `${portal.url}/public/table`, steps: [{ intent: 'Wait', waitFor: { target: { css: 'table' } } }] };
    const r = await runScriptLane(input(doc, { policy: { ...policyFor(portal), readPosts: [{ host: portal.host, path: '/*/*' }] }, endpoint: { mode: 'playwright', wsUrl: 'ws://never.invalid/' } }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', message: `Read-only request "POST ${portal.host}/*/*" must name at least one part of the path besides *` });
  });
});

describe('private network block at the lane', () => {
  const tableDoc = (): Script => ({
    name: 'public-table', version: 1, startUrl: `${portal.url}/public/table`,
    steps: [{ intent: 'Wait for the table', waitFor: { target: { css: 'table.results' } } }],
  });
  const noOptIn = () => {
    const { allowPrivateNetwork: _drop, ...rest } = policyFor(portal);
    return rest;
  };
  it('local: a policy without allowPrivateNetwork fails policy_violation with the golden message', async () => {
    const r = await runScriptLane(input(tableDoc(), { policy: noOptIn() }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'policy_violation', message: privateAddress(portal.host) });
  });
  it('remote: the same policy fails at the start page with the golden message', async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const r = await runScriptLane(input(tableDoc(), { policy: noOptIn(), endpoint: { mode: 'playwright', wsUrl: server.wsEndpoint() } }));
      if (r.ok) throw new Error('expected failure');
      expect(r).toMatchObject({ code: 'policy_violation', message: privateAddress(portal.host) });
      expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'private', fatal: true }));
    } finally { await server.close(); }
  });
});

describe('write modes at the lane', () => {
  const beaconDoc = (): Script => ({
    name: 'beacon', version: 1, startUrl: `${portal.url}/public/beacon`,
    steps: [
      { intent: 'Wait for the page', waitFor: { target: { css: 'h1' }, hasText: 'Beacon page' } },
      { intent: 'Let the page send its beacons', optional: true, timeoutMs: 1500, waitFor: { target: { css: '#never' } } },
    ],
  });
  const block = () => ({ ...policyFor(portal), writeMode: 'block' as const });
  it('signed steps upgrade a requested block mode to fatal writes', async () => {
    const r = await runScriptLane(input(beaconDoc(), { policy: block() }));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('policy_violation');
    expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
  });
  it('a Site Login upgrades block to fatal too', async () => {
    const r = await runScriptLane(input(beaconDoc(), { policy: block(), trust: { required: false } }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
  });
  it('unsigned steps without a Site Login block and log the writes, and the run goes on', async () => {
    const r = await runScriptLane(input(beaconDoc(), { policy: block(), trust: { required: false }, secrets: undefined }));
    if (!r.ok) throw new Error(r.message);
    expect(r.verified).toBe(false);
    expect(r.blockedRequests.length).toBeGreaterThan(0);
    expect(r.blockedRequests.every((b) => b.method === 'POST')).toBe(true);
    expect(r.violations.filter((v) => v.kind === 'write').length).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.fatal)).toBe(false);
  });
  it('a block-mode run that fails still reports what was blocked', async () => {
    const doc = beaconDoc();
    doc.steps.push({ intent: 'A heading that is not there', timeoutMs: 500, waitFor: { target: { css: '#never' } } } as Step);
    const r = await runScriptLane(input(doc, { policy: block(), trust: { required: false }, secrets: undefined }));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('drift_detected');
    expect(r.blockedRequests.length).toBeGreaterThan(0);
    expect(r.blockedRequests.every((b) => b.method === 'POST' && b.path === '/public/collect')).toBe(true);
  });
  it('a successful run reports blockedRequests', async () => {
    const r = await runScriptLane(input(baselineScript(portal.url)));
    if (!r.ok) throw new Error(r.message);
    expect(r.blockedRequests).toEqual([]);
  });
  it("under '*' a signed run (fatal writes) with a third-party sendBeacon completes and lists it in blockedRequests", async () => {
    const server = await chromium.launchServer({ headless: true });
    try {
      const doc: Script = {
        name: 'third-party-beacon', version: 1, startUrl: `${portal.url}/public/beacon-third-party`,
        steps: [{ intent: 'Wait until the beacon went out', waitFor: { target: { css: '#sent' } } }],
      };
      const r = await runScriptLane(input(doc, {
        policy: publicPolicy(portal, { subresourceHosts: '*' }), secrets: undefined, output: undefined,
        endpoint: { mode: 'playwright', wsUrl: server.wsEndpoint() },
      }));
      if (!r.ok) throw new Error(r.message);
      expect(r.blockedRequests).toEqual([{ method: 'POST', host: `localhost:${portal.port}`, path: '/public/collect' }]);
      expect(r.violations).toEqual([expect.objectContaining({ kind: 'host', fatal: false, method: 'POST' })]);
      expect(r.submitted).toBe(false);
      const counters = (await (await fetch(`${portal.url}/public/api/counters`)).json()) as { collect: number };
      expect(counters.collect).toBe(0);
    } finally { await server.close(); }
  });
});

describe('public pages: start page, status handling and verification', () => {
  const at = (path: string) => `${portal.url}${path}`;
  const counters = async () => (await (await fetch(at('/public/api/counters'))).json()) as { hits: Record<string, number> };
  const publicRun = (script: unknown, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput => ({
    script, trust: { required: false }, policy: publicPolicy(portal), endpoint: LOCAL, defaultStepTimeoutMs: 3000, saveTrace: 'never', ...over,
  });
  const open = (path: string, extra: Record<string, unknown> = {}): Step => ({ intent: 'Open the page', goto: at(path), ...extra } as Step);
  const readTable: Step = {
    intent: 'Read the products',
    extract: { scope: { css: 'body' }, item: { css: 'table.results tbody tr' }, fields: { code: { locator: { css: 'td:nth-child(1)' } }, product: { locator: { css: 'td:nth-child(2)' } } } },
  };

  it('loads the start page once when it comes from the first goto, and honours its waitUntil', async () => {
    const r = await runScriptLane(publicRun({ steps: [open('/public/table', { waitUntil: 'load' }), readTable] }));
    if (!r.ok) throw new Error(r.message);
    expect((await counters()).hits['/public/table']).toBe(1);
    expect(r.log[0]).toMatchObject({ index: 0, intent: 'Open the page', status: 'ok', note: 'start page' });
    expect(r.log.map((e) => e.index)).toEqual([0, 1]);
    expect(r.rows).toEqual([{ code: 'SKU-1001', product: 'Widget' }, { code: 'SKU-1002', product: 'Gadget' }, { code: 'SKU-1003', product: 'Gizmo' }]);
    expect(r).toMatchObject({ name: null, version: null, verified: true, confirmed: false, page: { url: at('/public/table'), status: 200 } });
  });
  it('confirmed is true only when the page states a total that matches the rows', async () => {
    const r = await runScriptLane(publicRun({ steps: [open('/public/table'), readTable] }, { output: { totalPattern: 'Showing (\\d+) results' } }));
    expect(r).toMatchObject({ ok: true, verified: true, confirmed: true });
  });
  it('a first page that never reaches network idle is site_down with the golden message, not drift', async () => {
    const r = await runScriptLane(publicRun({ steps: [open('/public/poll', { waitUntil: 'networkidle' })] }, { defaultStepTimeoutMs: 2000 }));
    expect(r).toMatchObject({ ok: false, code: 'site_down', message: notReachedNetworkIdle(2) });
    expect(r.ok ? '' : r.message).toBe('the page did not reach network idle within 2 s');
  });
  it("startStatus 'report': 404/410 are not_found, 5xx is site_down, other statuses succeed and are reported", async () => {
    const report = { startStatus: 'report' as const };
    expect(await runScriptLane(publicRun({ steps: [open('/public/missing')] }, report))).toMatchObject({ ok: false, code: 'not_found', message: 'HTTP 404 at the start page' });
    expect(await runScriptLane(publicRun({ steps: [open('/public/gone')] }, report))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await runScriptLane(publicRun({ steps: [open('/public/error')] }, report))).toMatchObject({ ok: false, code: 'site_down', message: 'HTTP 500 at the start page' });
    expect(await runScriptLane(publicRun({ steps: [open('/public/forbidden')] }, report))).toMatchObject({ ok: true, verified: false, page: { url: at('/public/forbidden'), status: 403 } });
    expect(await runScriptLane(publicRun({ steps: [open('/public/limited')] }, report))).toMatchObject({ ok: true, page: { status: 429 } });
  });
  it("startStatus 'classify' (the default) keeps v1: 404 is drift, any other 4xx is site_down", async () => {
    expect(await runScriptLane(publicRun({ steps: [open('/public/missing')] }))).toMatchObject({ ok: false, code: 'drift_detected', message: 'HTTP 404 at the start page' });
    expect(await runScriptLane(publicRun({ steps: [open('/public/forbidden')] }))).toMatchObject({ ok: false, code: 'site_down', message: 'HTTP 403 at the start page' });
  });
  it('the envelope url keeps the query but drops the fragment and redacts sensitive values', async () => {
    const r = await runScriptLane(publicRun([open('/public/echo?text=hi&code=abc&state=x#access_token=t')]));
    if (!r.ok) throw new Error(r.message);
    expect(r.page).toMatchObject({ url: `${at('/public/echo')}?text=hi&code=[redacted]&state=x`, title: 'Echo', status: 200 });
  });
  it('attribute fields are not grounded: an href list passes verification', async () => {
    const readList: Step = {
      intent: 'Read the list',
      extract: { scope: { css: 'body' }, item: { css: 'li.item' }, fields: { title: { locator: { css: 'a.title' } }, link: { locator: { css: 'a.title' }, attribute: 'href' } } },
    };
    const every: Step = { intent: 'Read every page', paginate: { next: { css: 'a.next' }, until: 'absent', max: 5, nextWaitMs: 300, each: [readList] } };
    const r = await runScriptLane(publicRun([open('/public/list?page=1'), every], { output: { totalPattern: 'Showing \\d+[-–]\\d+ of (\\d+)' } }));
    if (!r.ok) throw new Error(r.message);
    expect(r).toMatchObject({ verified: true, confirmed: true });
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toEqual({ title: 'Blue mug', link: at('/public/items/SKU-2001') });
  });
  it('page 1 of a list that says "Showing 1–3 of 5" succeeds unconfirmed when no totalPattern is set', async () => {
    const readList: Step = { intent: 'Read the list', extract: { scope: { css: 'body' }, item: { css: 'li.item' }, fields: { title: { locator: { css: 'a.title' } } } } };
    const r = await runScriptLane(publicRun([open('/public/list?page=1'), readList]));
    if (!r.ok) throw new Error(r.message);
    expect(r).toMatchObject({ verified: true, confirmed: false });
    expect(r.rows).toHaveLength(3);
  });
  it('the same page 1 read fails incomplete once a totalPattern is set', async () => {
    const readList: Step = { intent: 'Read the list', extract: { scope: { css: 'body' }, item: { css: 'li.item' }, fields: { title: { locator: { css: 'a.title' } } } } };
    const r = await runScriptLane(publicRun([open('/public/list?page=1'), readList], { output: { totalPattern: 'Showing \\d+[-–]\\d+ of (\\d+)' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('incomplete');
  });
  it('a text field that is not in the evidence still fails grounding', async () => {
    const read: Step = {
      intent: 'Read the list',
      extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' }, fields: { title: { locator: { css: 'a.title' } }, note: { locator: { css: 'span.note' } } } },
    };
    const r = await runScriptLane(publicRun([open('/public/list-hidden'), read]));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', message: 'row 1: values were not found together on any page that was read' });
  });
  it('a goto that fails mid-run never shows its query string: message, failure and log note', async () => {
    const dead = '127.0.0.1:1';
    const steps: Step[] = [open('/public/table'), { intent: 'Open the report', goto: `http://${dead}/report?token=abc#frag` } as Step];
    const r = await runScriptLane(publicRun(steps, { policy: publicPolicy(portal, { navHosts: [portal.host, dead] }) }));
    if (r.ok) throw new Error('expected failure');
    expect(r.message).toContain(`http://${dead}/report`);
    const shown = [r.message, r.failure?.message ?? '', ...r.log.map((e) => e.note ?? '')];
    for (const text of shown) expect(text).not.toMatch(/\?|token=abc|#frag/);
    expect(r.log.find((e) => e.status === 'failed')?.note).toContain(`http://${dead}/report`);
  });
  it('verification reasons in the message never show a URL query string', async () => {
    const read: Step = { intent: 'Read the report link', extract: { scope: { css: 'main' }, idPattern: 'https://\\S+' } };
    const r = await runScriptLane(publicRun([open('/public/url-text'), read], { output: { idPattern: 'https://\\S+', requiredFields: ['owner'] } }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'incomplete' });
    expect(r.message).toContain('row https://reports.example/r/77');
    expect(r.message).toContain('field "owner" is empty');
    expect(r.message).not.toMatch(/\?|token=abc/);
  });
  it('a run with no extract step is not verified and returns no rows', async () => {
    expect(await runScriptLane(publicRun([open('/public/table')]))).toMatchObject({ ok: true, rows: [], verified: false, confirmed: false, name: null, version: null });
  });
  it('more than 10000 rows is incomplete with the limit named and its prefix stripped; 10000 rows are fine', async () => {
    const items: Step = { intent: 'Read the rows', extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' } } };
    const over = await runScriptLane(publicRun([open('/public/many?n=10001'), items]));
    if (over.ok) throw new Error('expected failure');
    expect(over).toMatchObject({ code: 'incomplete', message: 'more than 10000 rows' });
    expect(over.failure?.message).toBe(tooManyRows(10_000));
    const fine = await runScriptLane(publicRun([open('/public/many?n=10000'), items]));
    if (!fine.ok) throw new Error(fine.message);
    expect(fine.rows).toHaveLength(10_000);
    expect(fine.verified).toBe(true);
  });
});
