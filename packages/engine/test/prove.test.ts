import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { openReusedSession } from '../src/prove/entry.js';
import { proveScript, type ProveInput } from '../src/prove/prove.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps } from '../src/steps/run.js';
import type { Locator, Script, Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, publicPolicy, SECRETS, SIGN_IN_STEPS } from './helpers.js';
const TOTAL_PATTERN = 'Showing \\d+[-–]\\d+ of (\\d+)';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const masker = createMasker([SECRETS.username, SECRETS.password, SECRETS.totpSecret]);
const ids = (n = 7) => SANDBOX.bulletins.slice(0, n).map((id) => ({ id }));
const sorted = (a: string[]) => [...a].sort();

/** Signs in like the healing session would and returns its post-login state. */
async function healingState(): Promise<{ storageState: NonNullable<ProveInput['storageState']>; postLoginUrl: string }> {
  const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker });
  try {
    await s.page.goto(`${portal.url}/acme/login`);
    const r = await runSteps({
      page: s.page, script: baselineScript(portal.url), policy: policyFor(portal), secrets: SECRETS, vars: {}, masker,
      defaultTimeoutMs: 3000, violations: s.violations, interrupts: await installInterrupts(s.page, []),
    }, SIGN_IN_STEPS);
    if (!r.ok) throw new Error(r.failure.message);
    return { storageState: await s.context.storageState(), postLoginUrl: s.page.url() };
  } finally { await s.close(); }
}
const prove = (script: Script, over: Partial<ProveInput> = {}) => proveScript({
  script, policy: policyFor(portal), secrets: SECRETS, output: { idPattern: 'N26-\\d{4}', totalPattern: TOTAL_PATTERN }, endpoint: LOCAL, masker,
  defaultStepTimeoutMs: 3000, budgetMs: 60_000, agentRows: ids(), ...over,
});

describe('prove reasons never show a URL query string', () => {
  it('a goto that fails mid-proof gives a reason with origin and path only', async () => {
    const dead = '127.0.0.1:1';
    const script: Script = {
      name: 'p', version: 2, startUrl: `${portal.url}/public/table`,
      steps: [{ intent: 'Open the report', goto: `http://${dead}/report?token=abc#frag` }, { intent: 'Read', extract: { scope: { css: 'body' }, idPattern: 'SKU-\\d+' } }],
    };
    const policy = { ...policyFor(portal), navHosts: [portal.host, dead] };
    const r = await prove(script, { policy, secrets: undefined, output: { idPattern: 'SKU-\\d+' } });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons[0]).toContain(`http://${dead}/report`);
    for (const reason of r.reasons) expect(reason).not.toMatch(/\?|token=abc|#frag/);
  });
});

describe('proveScript', () => {
  it('replays after the login block with the healing session state, without a new sign-in', async () => {
    const state = await healingState();
    const logins = portal.state().logins;
    const r = await prove(baselineScript(portal.url, 2), { ...state, agentRows: ids(6), checkFallbacksFrom: 3 });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(sorted(r.rows.map((x) => x.id))).toEqual(sorted(SANDBOX.bulletins));
    expect(r.total).toBe(7);
    expect(r.diff).toEqual({ missing: [], extra: [SANDBOX.bulletins[6]] });
    expect(r.screenshot?.length).toBeGreaterThan(1000);
    expect(portal.state().logins).toBe(logins);
  });
  it('replays the whole script, sign-in included, when there is no stored state', async () => {
    portal.setState({ mfa: 'totp' });
    const logins = portal.state().logins;
    const r = await prove(baselineScript(portal.url, 2));
    expect(r.ok).toBe(true);
    expect(portal.state().logins).toBe(logins + 1);
  });
  it('fails clearly when the healing session expired, and never signs in again', async () => {
    const state = await healingState();
    portal.reset(); // a portal release signs everyone out
    const logins = portal.state().logins;
    const r = await prove(baselineScript(portal.url, 2), state);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['the healing session expired before prove could reuse it: the post-login page redirected to the login page']);
    expect(r.rows).toEqual([]);
    expect(portal.state().logins).toBe(logins);
  });
  it('a zero-row proof never confirms, even when the empty pattern matches', async () => {
    portal.setState({ content: 'removed' });
    const state = await healingState();
    const r = await prove(baselineScript(portal.url, 2), { ...state, agentRows: [], output: { idPattern: 'N26-\\d{4}', emptyPattern: 'No active notices' } });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['a zero-row proof cannot confirm a recorded script']);
    expect(r.policyViolation).toBe(false);
  });
  it('fails when the count does not match the stated total', async () => {
    portal.setState({ paginate: true });
    const state = await healingState();
    const firstPageOnly = { ...baselineScript(portal.url, 2), steps: baselineScript(portal.url).steps.map((st) => ('paginate' in st ? st.paginate.each[0] : st)) };
    const r = await prove(firstPageOnly, state);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('Expected 7 rows (the page says "Showing 1-4 of 7") but found 4. Nothing was marked successful.');
    expect(r.diff.missing).toHaveLength(3);
  });
  it('fails when an agent-built step only matched by a fallback', async () => {
    const state = await healingState();
    const script = baselineScript(portal.url, 2);
    const unstable: Step = {
      intent: 'Open the notices', checkpoint: true,
      click: { text: 'Notices that moved', exact: true, fallbacks: [{ css: 'a[href="/acme/service/recalls-and-stop-sales"]' }] },
    };
    script.steps[4] = unstable;
    const strict = await prove(script, { ...state, checkFallbacksFrom: 4 });
    expect(strict.ok).toBe(false);
    expect(strict.reasons).toEqual(['step "Open the notices" matched only by fallback 1 during prove']);
    expect(strict.rows).toHaveLength(7);
    const lenient = await prove(script, state);
    expect(lenient.ok).toBe(true);
  });
  it('fails on a blocked request and masks every reason', async () => {
    const state = await healingState();
    const script = baselineScript(portal.url, 2);
    script.steps.push({ intent: 'Go to redirect page', goto: '/acme/p/redirect-out' });
    const blocked = await prove(script, state);
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons).toEqual(['prove attempted a blocked request']);
    expect(blocked.policyViolation).toBe(true);
    expect(blocked.violations?.length).toBeGreaterThan(0);
    expect(blocked.violations?.every((v) => v.fatal)).toBe(true);
    const leaky = baselineScript(portal.url, 2);
    leaky.steps.push({ intent: `Find ${SECRETS.username}`, timeoutMs: 300, click: { css: '#never' } });
    const r = await prove(leaky, state);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.reasons)).not.toContain(SECRETS.username);
    expect(r.reasons[0]).toMatch(/^Find \[secret\]: No element found for CSS Selector "#never"/);
    expect(r.policyViolation).toBe(false);
    expect(r.violations).toBeUndefined();
  });
  it('never throws: an unexpected internal error comes back as ok:false with a masked reason', async () => {
    const boom = await prove(baselineScript(portal.url, 2), { agentRows: undefined as never, endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/never', token: SECRETS.password } });
    expect(boom.ok).toBe(false);
    expect(boom.rows).toEqual([]);
    expect(boom.reasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(boom.reasons)).not.toContain(SECRETS.password);
    const cant = await prove(baselineScript(portal.url, 2), { endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/never' } });
    expect(cant.ok).toBe(false);
    expect(cant.reasons[0]).toMatch(/^could not open a browser to prove the script/);
  });
  it('proves a full replay that starts on a login page served with 401', async () => {
    const script = { ...baselineScript(portal.url, 2), startUrl: `${portal.url}/acme/login?status=401` };
    const r = await prove(script);
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('reports the expired-session reason when the post-login page is a 401 login page', async () => {
    const state = await healingState();
    const logins = portal.state().logins;
    const r = await prove(baselineScript(portal.url, 2), { ...state, postLoginUrl: `${portal.url}/acme/login?status=401` });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['the healing session expired before prove could reuse it: the post-login page redirected to the login page']);
    expect(portal.state().logins).toBe(logins);
  });
  it('does not open a browser when the signal is already aborted or no time is left', async () => {
    const ac = new AbortController();
    ac.abort();
    const bad = { mode: 'playwright' as const, wsUrl: 'ws://127.0.0.1:1/never' };
    const a = await prove(baselineScript(portal.url, 2), { signal: ac.signal, endpoint: bad });
    expect(a.ok).toBe(false);
    expect(a.reasons).toEqual(['prove cancelled']);
    const b = await prove(baselineScript(portal.url, 2), { deadlineMs: Date.now() - 1, endpoint: bad });
    expect(b.ok).toBe(false);
    expect(b.reasons).toEqual(['no time left for prove']);
    const c = await prove(baselineScript(portal.url, 2), { budgetMs: 0, endpoint: bad });
    expect(c.reasons).toEqual(['no time left for prove']);
  });
  it('closes and reports cancellation when aborted mid-run', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const script = baselineScript(portal.url, 2);
    script.steps.push({ intent: 'Wait for nothing', timeoutMs: 20_000, click: { css: '#never' } });
    const r = await prove(script, { signal: ac.signal, defaultStepTimeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['prove cancelled']);
  });
  it('refuses storageState without postLoginUrl (and the reverse) and never signs in', async () => {
    const state = await healingState();
    const logins = portal.state().logins;
    const a = await prove(baselineScript(portal.url, 2), { storageState: state.storageState });
    const b = await prove(baselineScript(portal.url, 2), { postLoginUrl: state.postLoginUrl });
    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      expect(r.reasons).toEqual(['storageState and postLoginUrl must be given together']);
    }
    expect(portal.state().logins).toBe(logins);
  });
  it('refuses to reuse the session when the agent changed the login block', async () => {
    const state = await healingState();
    const r = await prove(baselineScript(portal.url, 2), { ...state, checkFallbacksFrom: 1 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['the agent changed the login block; prove cannot reuse the session']);
  });
  describe('resuming right before a re-anchored detect', () => {
    /** The baseline with its detect (index 2) re-anchored on another landmark, as compile does when the base detect failed. */
    const reanchored = (loggedIn: Locator): Script => {
      const s = structuredClone(baselineScript(portal.url, 2));
      const d = s.steps[2];
      if (!('detect' in d)) throw new Error('fixture changed');
      d.intent = 'Check sign-in worked (new page after sign-in)';
      d.detect.checks = { ...d.detect.checks, logged_in: loggedIn };
      return s;
    };
    const SERVICE = { role: 'link', name: 'Service', exact: true, within: { role: 'navigation' } } as const;

    it('runs the changed detect and everything after it on the healing session, without a new sign-in', async () => {
      const state = await healingState();
      const logins = portal.state().logins;
      const r = await prove(reanchored(SERVICE), { ...state, resumeAt: 2, checkFallbacksFrom: 2, agentRows: ids(6) });
      expect(r.reasons).toEqual([]);
      expect(r.ok).toBe(true);
      expect(portal.state().logins).toBe(logins);
    });
    it('opens the captured URL, not the work\'s entry page (the re-anchored-detect path keeps its old start)', async () => {
      const state = await healingState();
      // A start URL that is no login page and has no navigation: had prove opened it, the re-anchored detect would fail.
      const script = { ...reanchored(SERVICE), startUrl: `${portal.url}/public/table` };
      const r = await prove(script, { ...state, resumeAt: 2, checkFallbacksFrom: 2, agentRows: ids(6) });
      expect(r.reasons).toEqual([]);
      expect(r.ok).toBe(true);
    });
    it('fails the proof when the re-anchored detect does not match (the detect really runs)', async () => {
      const state = await healingState();
      const r = await prove(reanchored({ css: '#no-such-landmark' }), { ...state, resumeAt: 2, checkFallbacksFrom: 2, defaultStepTimeoutMs: 1500 });
      expect(r.ok).toBe(false);
      expect(r.reasons.join(' ')).toMatch(/Check sign-in worked/);
    });
    it('still refuses when the agent changed a step the resumed session skips', async () => {
      const state = await healingState();
      const r = await prove(reanchored(SERVICE), { ...state, resumeAt: 2, checkFallbacksFrom: 1 });
      expect(r.ok).toBe(false);
      expect(r.reasons).toEqual(['the agent changed the login block; prove cannot reuse the session']);
    });
    it('refuses a resume point at or before the sign-in, or past the login block', async () => {
      const state = await healingState();
      for (const resumeAt of [0, 4, 1.5]) {
        const r = await prove(reanchored(SERVICE), { ...state, resumeAt, checkFallbacksFrom: 2 });
        expect(r.ok).toBe(false);
        expect(r.reasons).toEqual(['prove can resume the healing session only inside the login block, after the sign-in']);
      }
    });
  });
  it('a reused session never opens a declared login page as the work\'s entry', async () => {
    const state = await healingState();
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker, storageState: state.storageState });
    try {
      const requested: string[] = [];
      s.page.on('request', (req) => { if (req.isNavigationRequest()) requested.push(new URL(req.url()).pathname); });
      // The baseline's start URL is the login page and its work starts with a click: no entry, the captured URL directly.
      const opened = await openReusedSession(s.page, {
        script: baselineScript(portal.url, 2), from: 3, policy: policyFor(portal), masker, capturedUrl: state.postLoginUrl, stopped: () => false,
      });
      expect(opened.entry).toBeUndefined();
      expect(opened.atEntry).toBe(false);
      expect(requested).not.toContain('/acme/login');
      expect(s.page.url()).toBe(state.postLoginUrl);
    } finally { await s.close(); }
  });
  it('classifies a failed full replay: a wrong password is login_failed', async () => {
    const r = await prove(baselineScript(portal.url, 2), { secrets: { ...SECRETS, password: 'wrong-pass-123' } });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('login_failed');
    expect(JSON.stringify(r.reasons)).not.toContain('wrong-pass-123');
  });
  it('fails when a paginate only matched its next control by a fallback', async () => {
    portal.setState({ paginate: true });
    const state = await healingState();
    const script = baselineScript(portal.url, 2);
    const pg = script.steps[5];
    if (!('paginate' in pg)) throw new Error('fixture changed');
    pg.paginate.next = { text: 'Gone', fallbacks: [{ text: 'Next page' }] };
    const r = await prove(script, { ...state, checkFallbacksFrom: 5 });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['step "Read every page of notices" matched only by fallback 1 during prove']);
  });
  it('proves a public-page script without a Site Login', async () => {
    const script: Script = {
      name: 'public-table', version: 1, startUrl: `${portal.url}/public/table`,
      steps: [{ intent: 'Read the table', extract: { scope: { css: 'table.results' }, idPattern: 'SKU-\\d{4}' } }],
    };
    const r = await proveScript({
      script, policy: { ...policyFor(portal), startUrl: script.startUrl, login: [], allowedSubmits: [] },
      output: { idPattern: 'SKU-\\d{4}' }, endpoint: LOCAL, masker, budgetMs: 30_000, agentRows: [],
    });
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.id)).toEqual(['SKU-1001', 'SKU-1002', 'SKU-1003']);
  });
});

describe('file proofs', () => {
  const filesScript = (download: Partial<Extract<Step, { download: unknown }>['download']> | null): Script => ({
    name: 'files', version: 2, startUrl: `${portal.url}/public/files`,
    steps: download
      ? [{ intent: 'Download the report', download: { trigger: { css: '#csv' }, mime: ['text/csv'], ...download } }]
      : [{ intent: 'Open the files page', goto: `${portal.url}/public/files` }],
  });
  const proveFile = (script: Script) => proveScript({
    script, policy: publicPolicy(portal, { startUrl: script.startUrl }), output: {}, endpoint: LOCAL, masker,
    defaultStepTimeoutMs: 3000, budgetMs: 30_000, agentRows: [], expectFile: true, checkFallbacksFrom: 0,
  });
  it('a file proof passes with one checked file and reports its evidence', async () => {
    const r = await proveFile(filesScript({ check: { name: '^report', columns: ['code', 'name'], minRows: 1 } }));
    expect(r.reasons).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.total).toBeNull();
    expect(r.file).toEqual({ fileName: 'report.csv', mimeType: 'text/csv', bytes: 'code,name\nSKU-1,Widget\n'.length, columns: ['code', 'name'], rows: 1 });
  });
  it('a file proof with no download fails with "the proof downloaded no file"', async () => {
    const r = await proveFile(filesScript(null));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['the proof downloaded no file']);
    expect(r).not.toHaveProperty('file');
  });
  it('a file proof with two downloads says how many it saw', async () => {
    const one = { intent: 'Download the report', download: { trigger: { css: '#csv' }, mime: ['text/csv'], check: { name: '^report' } } } as Step;
    const r = await proveFile({ ...filesScript(null), steps: [one, { ...one, intent: 'Download the report again' } as Step] });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['the proof downloaded 2 files; expected one']);
    expect(r).not.toHaveProperty('file');
  });
  it('a file proof with a failing check fails with the check reason', async () => {
    const r = await proveFile(filesScript({ check: { columns: ['No Such Column'] } }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['Download the report: download check failed: the file has no column "No Such Column"']);
    expect(r).not.toHaveProperty('file');
  });
});
