// The agent signs in on a two-page (identity-first) site. sign_in takes two calls there: first the
// username field and the button that leads to the password page, then the password field and the submit button. The
// engine types both secrets with the checks of the signIn step's `next` path, and records one signIn with `next`.
// Against the sandbox's identity-first identity provider (SANDBOX_SAP_LOGIN=sso2).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { AGENT_TOOLS, AgentTools } from '../src/agent/tools.js';
import { openSession, type Session } from '../src/browser/session.js';
import { compileProposal } from '../src/compile/compile.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { runTask, type TaskInput, type TaskResult } from '../src/lane/task.js';
import { AGENT_SIGN_IN_UNFINISHED, REPAIR_SIGN_IN_HALF_DONE, SIGNIN_NEXT_NO_PASSWORD } from '../src/messages.js';
import { signSteps } from '../src/proposal/proposal.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { newRunState, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, PortalSecrets, RunState, Step } from '../src/types.js';
import { clickNamed, done, fakeModel, refByName, type FakeTurn } from './fake-model.js';
import { APPROVER, LOCAL, signedLaneInput, TEST_KEY } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
let portalServer: import('node:http').Server;
beforeAll(async () => {
  portal = await startPortal({ sap: 'realistic', sapLogin: 'sso2' });
  // Imported only after startPortal set STATE_FILE: the server module reads it when it loads.
  ({ server: portalServer } = await import('n8n-rpa-sandbox/server.js'));
});
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const SECRETS: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
const start = () => `${portal.url}${SANDBOX.erp.webguiPath}`;
const policy = (): PortalPolicy => ({
  startUrl: start(),
  navHosts: [portal.host],
  subresourceHosts: [],
  login: ['/idp/login', '/idp/password', '/idp/mfa', '/idp/kmsi', '/sap/saml2/acs'].map((path) => ({ host: portal.host, path })),
  allowedSubmits: [],
  readPosts: [{ host: portal.host, path: '/sap*/bc/gui/sap/its/webgui' }],
  allowPrivateNetwork: true,
});

interface Rig { tools: AgentTools; ctx: StepContext; state: RunState }
async function rig(secrets: PortalSecrets = SECRETS): Promise<Rig> {
  session = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  const ctx: StepContext = {
    page: session.page, script: { startUrl: start(), steps: [] }, policy: policy(), secrets, vars: {},
    masker: createMasker([secrets.username, secrets.password, secrets.totpSecret]), defaultTimeoutMs: 3000,
    violations: session.violations, interrupts: await installInterrupts(session.page, []),
  };
  await session.page.goto(start());
  await session.page.waitForURL((u) => u.pathname === '/idp/login');
  const state = newRunState();
  return { tools: new AgentTools({ ctx, state, output: {} }), ctx, state };
}
const call = (r: Rig, name: string, args: Record<string, unknown> = {}) => r.tools.run({ id: `c${r.tools.actions.length}`, name, args });
const secretFree = (text: string) => { for (const s of [SECRETS.username, SECRETS.password, SECRETS.totpSecret as string]) expect(text.toLowerCase()).not.toContain(s.toLowerCase()); };

/** Both sign_in calls; returns the second result. */
async function signInTwoCalls(r: Rig) {
  const t = await r.tools.look();
  const one = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
  expect(one.error, one.text).toBe(false);
  const two = await call(r, 'sign_in', { password_ref: refByName(one.text, 'Password'), submit_ref: refByName(one.text, 'Sign in') });
  expect(two.error, two.text).toBe(false);
  return two;
}

describe('the agent signs in on a two-page site', () => {
  it('the sign_in tool says how to sign in on two pages, and requires no single form', () => {
    const def = AGENT_TOOLS.find((t) => t.function.name === 'sign_in')!.function;
    expect(def.description).toMatch(/next_ref/);
    expect(Object.keys(def.parameters.properties as object)).toEqual(['username_ref', 'next_ref', 'password_ref', 'submit_ref']);
    expect(def.parameters.required).toEqual([]);
  });

  it('the agent signs in on a two-page site in two calls', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const one = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      expect(one.error, one.text).toBe(false);
      // The result is the password page; nothing secret was typed there yet.
      expect(r.ctx.page.url()).toContain('/idp/password');
      expect(one.text).toMatch(/password_ref/);
      expect(refByName(one.text, 'Password')).toMatch(/^e\d+$/);
      expect(await r.ctx.page.locator('#passwd').inputValue()).toBe('');
      expect(r.state.credentialsSubmitted).toBe(true);
      expect(r.state.submitClicked).toBe(false);
      expect(r.tools.signInStage).toBe('pending');
      // While the password page is pending, only the password call is accepted.
      const again = await call(r, 'sign_in', { username_ref: refByName(one.text, 'Password'), next_ref: refByName(one.text, 'Sign in') });
      expect(again.text).toMatch(/^ERROR: refused: the username was already typed/);
      const two = await call(r, 'sign_in', { password_ref: refByName(again.text, 'Password'), submit_ref: refByName(again.text, 'Sign in') });
      expect(two.error, two.text).toBe(false);
      expect(r.ctx.page.url()).toContain('/idp/mfa');
      expect(r.state.submitClicked).toBe(true);
      expect(r.tools.signInStage).toBeUndefined();
      const code = await call(r, 'enter_code', { field_ref: refByName(two.text, 'Code'), submit_ref: refByName(two.text, 'Verify') });
      expect(code.error, code.text).toBe(false);
      // The code page answers with "Stay signed in?" (rendered by the code POST itself).
      expect(code.text).toContain('Stay signed in?');
      // One sign-in action, recorded where it started (the username page), carrying both pages' locators.
      const signIns = r.tools.actions.filter((a) => a.tool === 'sign_in' && a.ok);
      expect(signIns).toHaveLength(1);
      expect(signIns[0]).toMatchObject({
        url: `${portal.url}/idp/login`,
        step: {
          intent: 'Sign in',
          signIn: {
            username: { role: 'textbox', name: 'Email', exact: true },
            next: { role: 'button', name: 'Next', exact: true },
            password: { label: 'Password', exact: true },
            submit: { role: 'button', name: 'Sign in', exact: true },
          },
        },
      });
      expect(r.ctx.violations).toEqual([]);
      secretFree(JSON.stringify(r.tools.actions));
    } finally { await session.close(); }
  });

  it('a second phase-2 call is refused', async () => {
    const r = await rig();
    try {
      const two = await signInTwoCalls(r);
      const again = await call(r, 'sign_in', { password_ref: refByName(two.text, 'Code'), submit_ref: refByName(two.text, 'Verify') });
      expect(again.text).toMatch(/^ERROR: refused: credentials were already submitted in this run/);
      expect(r.ctx.page.url()).toContain('/idp/mfa');
    } finally { await session.close(); }
  });

  it('phase 2 without phase 1 is refused', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const out = await call(r, 'sign_in', { password_ref: refByName(t, 'Email'), submit_ref: refByName(t, 'Next') });
      expect(out.text).toMatch(/^ERROR: refused: no username was typed yet; call sign_in with username_ref and next_ref first/);
      expect(r.state.credentialsSubmitted).toBe(false);
      expect(await r.ctx.page.locator('#loginfmt').inputValue()).toBe('');
      expect(r.ctx.page.url()).toContain('/idp/login');
    } finally { await session.close(); }
  });

  it('while the password page is pending, nothing else runs: enter_code, click and back are refused, with no request sent', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const one = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      expect(one.error, one.text).toBe(false);
      const at = r.ctx.page.url();
      const posts: string[] = [];
      r.ctx.page.on('request', (rq) => { if (rq.method() !== 'GET') posts.push(rq.url()); });
      const refused = /^ERROR: refused: finish signing in first; call sign_in with password_ref and submit_ref on the password page/;
      let last = one.text;
      for (const [name, args] of [
        ['enter_code', (x: string) => ({ field_ref: refByName(x, 'Password'), submit_ref: refByName(x, 'Sign in') })],
        ['click', (x: string) => ({ ref: refByName(x, 'Sign in') })],
        ['dismiss', (x: string) => ({ ref: refByName(x, 'Sign in') })],
        ['back', () => ({})],
      ] as const) {
        const out = await call(r, name, args(last));
        expect(out.text, name).toMatch(refused);
        last = out.text;
      }
      expect(posts).toEqual([]);
      expect(r.ctx.page.url()).toBe(at);
      expect(await r.ctx.page.locator('#passwd').inputValue()).toBe('');
      expect(r.tools.signInStage).toBe('pending');
      // look still works, and the sign-in can still be finished.
      const looked = await call(r, 'look');
      expect(looked.error).toBe(false);
      const two = await call(r, 'sign_in', { password_ref: refByName(looked.text, 'Password'), submit_ref: refByName(looked.text, 'Sign in') });
      expect(two.error, two.text).toBe(false);
      expect(r.ctx.page.url()).toContain('/idp/mfa');
    } finally { await session.close(); }
  });

  it('enter_code is refused until the password was submitted', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const out = await call(r, 'enter_code', { field_ref: refByName(t, 'Email'), submit_ref: refByName(t, 'Next') });
      expect(out.text).toMatch(/^ERROR: refused: sign in first/);
      expect(await r.ctx.page.locator('#loginfmt').inputValue()).toBe('');
    } finally { await session.close(); }
  });

  it('once the username was typed but the sign-in did not finish (nothing pending), only look and done run', async () => {
    const r = await rig();
    try {
      r.state.credentialsSubmitted = true; // as after a phase 1 whose pending state is gone (a failed phase 2): no password was submitted
      const posts: string[] = [];
      r.ctx.page.on('request', (rq) => { if (rq.method() !== 'GET') posts.push(rq.url()); });
      const refused = /^ERROR: refused: the username was typed but the sign-in didn't finish; call done/;
      let last = await r.tools.look();
      for (const [name, args] of [
        ['click', (x: string) => ({ ref: refByName(x, 'Next') })],
        ['fill', (x: string) => ({ ref: refByName(x, 'Email'), value: 'someone' })],
        ['enter_code', (x: string) => ({ field_ref: refByName(x, 'Email'), submit_ref: refByName(x, 'Next') })],
        ['sign_in', (x: string) => ({ username_ref: refByName(x, 'Email'), next_ref: refByName(x, 'Next') })],
        ['dismiss', (x: string) => ({ ref: refByName(x, 'Next') })],
        ['expand_all', () => ({})],
        ['back', () => ({})],
      ] as const) {
        const out = await call(r, name, args(last));
        expect(out.text, name).toMatch(refused);
        last = out.text;
      }
      expect(posts).toEqual([]);
      expect(await r.ctx.page.locator('#loginfmt').inputValue()).toBe('');
      expect((await call(r, 'look')).error).toBe(false);
      expect((await call(r, 'done', { outcome: 'blocked', note: 'the sign-in did not finish' })).error).toBe(false);
    } finally { await session.close(); }
  });

  it('after a failed phase 2, clicking Sign in (an empty password) is refused, with no request sent', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const one = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      expect(one.error, one.text).toBe(false);
      // The password field can't take the password: phase 2 fails before anything is submitted.
      await r.ctx.page.locator('#passwd').evaluate((el) => { (el as HTMLInputElement).disabled = true; });
      const two = await call(r, 'sign_in', { password_ref: refByName(one.text, 'Password'), submit_ref: refByName(one.text, 'Sign in') });
      expect(two.text).toMatch(/^ERROR: sign-in failed/);
      expect(r.state.credentialsSubmitted).toBe(true);
      expect(r.state.submitClicked).toBe(false);
      const posts: string[] = [];
      r.ctx.page.on('request', (rq) => { if (rq.method() !== 'GET') posts.push(rq.url()); });
      const looked = await call(r, 'look');
      const click = await call(r, 'click', { ref: refByName(looked.text, 'Sign in') });
      expect(click.text).toMatch(/^ERROR: refused: the username was typed but the sign-in didn't finish; call done/);
      expect(posts).toEqual([]);
      expect(r.ctx.page.url()).toContain('/idp/password');
    } finally { await session.close(); }
  });

  it('phase 1 is refused on a page that already shows a password field', async () => {
    const r = await rig();
    try {
      await r.ctx.page.locator('form').evaluate((f) => f.insertAdjacentHTML('beforeend', '<label for="pw">Password</label><input id="pw" type="password">'));
      const t = await r.tools.look();
      const out = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      expect(out.text).toMatch(/^ERROR: refused: this page has a password field: call sign_in with username_ref, password_ref and submit_ref/);
      expect(r.state.credentialsSubmitted).toBe(false);
      expect(r.tools.signInStage).toBeUndefined();
      expect(await r.ctx.page.locator('#loginfmt').inputValue()).toBe('');
      expect(r.ctx.page.url()).toContain('/idp/login');
    } finally { await session.close(); }
  });

  it('a phase-2 call whose password_ref is not a password field does not use up the sign-in', async () => {
    const r = await rig();
    try {
      const t = await r.tools.look();
      const one = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      const wrong = await call(r, 'sign_in', { password_ref: refByName(one.text, 'Sign in'), submit_ref: refByName(one.text, 'Sign in') });
      expect(wrong.text).toMatch(/^ERROR: refused: password_ref must be a password field/);
      expect(r.tools.signInStage).toBe('pending');
      expect(r.state.submitClicked).toBe(false);
      const two = await call(r, 'sign_in', { password_ref: refByName(wrong.text, 'Password'), submit_ref: refByName(wrong.text, 'Sign in') });
      expect(two.error, two.text).toBe(false);
      expect(r.ctx.page.url()).toContain('/idp/mfa');
    } finally { await session.close(); }
  });

  it('the run log shows both sign-in calls', async () => {
    const r = await rig();
    try {
      await signInTwoCalls(r);
      expect(r.state.log.map((e) => [e.intent, e.status])).toEqual([['Sign in', 'ok'], ['Sign in', 'ok']]);
      expect(r.state.log[0].note).toBe('typed the username and moved to the password page');
    } finally { await session.close(); }
  });

  it('a username the site rejects stops before the password', async () => {
    const r = await rig({ ...SECRETS, username: 'nobody@rpa.example' });
    try {
      const t = await r.tools.look();
      const out = await call(r, 'sign_in', { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') });
      expect(out.text).toMatch(/^ERROR: the site rejected the username/);
      expect(r.tools.signInStage).toBe('username_rejected');
      expect(r.state.log.map((e) => [e.intent, e.status])).toEqual([['Sign in', 'failed']]);
      expect(r.ctx.page.url()).toContain('/idp/login');
      expect(r.state.submitClicked).toBe(false);
      expect(JSON.stringify(r.tools.actions)).not.toContain('nobody@rpa.example');
    } finally { await session.close(); }
  });

  it('the compiled steps carry signIn.next', async () => {
    const r = await rig();
    try {
      const two = await signInTwoCalls(r);
      const kmsi = await call(r, 'enter_code', { field_ref: refByName(two.text, 'Code'), submit_ref: refByName(two.text, 'Verify') });
      const no = await call(r, 'dismiss', { ref: refByName(kmsi.text, 'No') });
      expect(no.error, no.text).toBe(false);
      const report = await call(r, 'click', { ref: refByName(no.text, 'Line Item Report') });
      expect(report.error, report.text).toBe(false);
      const compiled = compileProposal({
        resumeFrom: -1, actions: r.tools.actions, name: 'sap-sso2', startUrl: start(), version: 1,
        policy: policy(), secrets: SECRETS, observedNavigations: [...session.navigations],
      });
      const steps = compiled.script.steps;
      const signIn = steps[0] as Extract<Step, { signIn: unknown }>;
      expect(signIn.signIn).toMatchObject({
        username: { name: 'Email' }, next: { role: 'button', name: 'Next' }, password: { label: 'Password' }, submit: { name: 'Sign in' },
        totp: { field: { name: 'Code' }, submit: { name: 'Verify' } },
      });
      expect(steps[1]).toMatchObject({ when: { visible: { name: 'No' } }, click: { name: 'No' } });
      // The detect's failure check is the second page's password field.
      expect(steps[2]).toMatchObject({ detect: { checks: { login_failed: signIn.signIn.password, logged_in: { name: 'Line Item Report' } } } });
    } finally { await session.close(); }
  });
});

const noTurn: FakeTurn = () => null;
/** A first run (no steps yet): the trust envelope is signed over a placeholder, as the node does before any steps exist. */
const firstRun = (rest: Omit<TaskInput, 'script' | 'trust'>): TaskInput =>
  ({ ...signedLaneInput({ name: 'placeholder', version: 1, startUrl: start(), steps: [{ intent: 'Open', goto: start() }] }, rest), script: undefined });
const first = (secrets: PortalSecrets, turns: FakeTurn[]): Promise<TaskResult> => runTask(firstRun({
  policy: policy(), secrets, output: { idPattern: '19\\d{8}' }, endpoint: LOCAL, defaultStepTimeoutMs: 3000,
  repair: { model: fakeModel(turns), goal: 'Read the September line items.', name: 'sap-sso2' },
}));
const PHASE_1: FakeTurn = (t) => ({ name: 'sign_in', args: { username_ref: refByName(t, 'Email'), next_ref: refByName(t, 'Next') } });
const PHASE_2: FakeTurn = (t) => ({ name: 'sign_in', args: { password_ref: refByName(t, 'Password'), submit_ref: refByName(t, 'Sign in') } });

describe('two-call sign-ins in the agent lane', () => {
  it('a username the site rejects ends the run login_failed', async () => {
    const r = await first({ ...SECRETS, username: 'nobody@rpa.example' }, [PHASE_1, done('blocked', 'the sign-in did not go through'), noTurn]);
    expect(r).toMatchObject({ ok: false, code: 'login_failed', lane: 'agent' });
    expect(JSON.stringify(r)).not.toContain('nobody@rpa.example');
  });

  it('a wrong password on the password page ends the run login_failed', async () => {
    const r = await first({ ...SECRETS, password: 'wrong-idp-password' }, [PHASE_1, PHASE_2, done('blocked', 'the password was not accepted'), noTurn]);
    expect(r).toMatchObject({ ok: false, code: 'login_failed', lane: 'agent' });
    expect(JSON.stringify(r)).not.toContain('wrong-idp-password');
  });

  it('a sign-in left on the password page ends the run auth_blocked', async () => {
    const r = await first(SECRETS, [PHASE_1, done('not_found', 'no data here'), noTurn]);
    expect(r).toMatchObject({ ok: false, code: 'auth_blocked', lane: 'agent' });
    if (!r.ok) expect(r.message).toContain(AGENT_SIGN_IN_UNFINISHED);
    expect(AGENT_SIGN_IN_UNFINISHED).toBe('the agent typed the username but did not finish signing in on the password page');
  });

  it('a first run signs in on two pages, answers "Stay signed in?", exports the XLSX, and the signed v1 replays it', async () => {
    const model = fakeModel([
      PHASE_1, PHASE_2,
      (t) => ({ name: 'enter_code', args: { field_ref: refByName(t, 'Code'), submit_ref: refByName(t, 'Verify') } }),
      clickNamed('No', 'dismiss'),
      clickNamed('Line Item Report'),
      (t) => ({ name: 'fill', args: { ref: refByName(t, 'Company Code'), value: '1000' } }),
      (t) => ({ name: 'fill', args: { ref: refByName(t, 'From'), value: '01.09.2026' } }),
      (t) => ({ name: 'fill', args: { ref: refByName(t, 'To'), value: '30.09.2026' } }),
      clickNamed('Execute (F8)'),
      clickNamed('Spreadsheet... (Ctrl+Shift+F7)'),
      clickNamed('Continue (Enter)', 'download'),
      done('found', 'the line-item spreadsheet'),
    ]);
    const input = firstRun({
      policy: policy(), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 5000,
      repair: { model, goal: 'Download the September line items.', name: 'sap-sso2-export', download: { check: { name: '^export\\.XLSX$' } } },
    });
    const r = await runTask(input);
    if (!r.ok || r.lane !== 'agent' || !r.proposal) throw new Error(JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after', 'data', 'transcript'].includes(k) ? undefined : v)).slice(0, 2000));
    expect(r.confirmed).toBe(true);
    expect(r.files.map((f) => f.fileName)).toEqual(['export.XLSX']);
    const steps = r.proposal.steps.steps;
    expect(steps[0]).toMatchObject({ signIn: { next: { role: 'button', name: 'Next' }, totp: { field: { name: 'Code' } } } });
    expect(r.proposal.changes.map((c) => c.now).join('\n')).toContain('next role "button" name "Next"');
    expect(r.violations).toEqual([]);
    secretFree(JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after', 'data'].includes(k) ? undefined : v)));
    const signed = signSteps({ proposal: r.proposal, key: TEST_KEY, approverId: APPROVER, policy: policy(), secrets: SECRETS, reviewedDigest: r.digest ?? '' });
    if (!signed.ok) throw new Error(signed.reasons.join('; '));
    const lane = await runScriptLane({
      script: signed.row.steps, trust: { required: true, signature: signed.row.signature, approvedBy: signed.row.approvedBy, key: TEST_KEY },
      policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 5000,
    });
    if (!lane.ok) throw new Error(JSON.stringify(lane).slice(0, 1500));
    expect(lane.files.map((f) => f.fileName)).toEqual(['export.XLSX']);
  }, 180_000); // the proof and the replay each wait for a fresh TOTP window (up to 30 s)
});

describe('repair after a half-done two-page sign-in', () => {
  it('a signed two-page signIn whose password locator drifted is not repaired: drift, no model call, no password POST', async () => {
    const steps = {
      name: 'sap-sso2-export', version: 1, startUrl: start(),
      steps: [
        {
          intent: 'Sign in at the identity provider',
          signIn: {
            username: { label: 'Email' }, next: { role: 'button', name: 'Next' },
            password: { label: 'Passcode' }, // drifted: the page says "Password"
            submit: { role: 'button', name: 'Sign in' },
            totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } },
          },
        },
        { intent: 'Open Line Item Report', click: { role: 'button', name: 'Line Item Report' } },
        { intent: 'Execute', click: { role: 'button', name: 'Execute (F8)' } },
        { intent: 'Spreadsheet', click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } },
        { intent: 'Continue', download: { trigger: { role: 'button', name: 'Continue (Enter)' }, check: { name: '^export\\.XLSX$' } } },
      ],
    };
    const model = fakeModel([PHASE_2, done('found', 'signed in'), noTurn]);
    const posts: string[] = [];
    const onRequest = (rq: { method?: string; url?: string }) => { if (rq.method === 'POST' && rq.url) posts.push(new URL(rq.url, 'http://x').pathname); };
    portalServer.on('request', onRequest);
    try {
      const r = await runTask(signedLaneInput(steps, {
        policy: policy(), secrets: SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 3000,
        repair: { model, goal: 'Download the September line items.' },
      }));
      expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
      if (r.ok) return;
      expect(r.message).toContain(SIGNIN_NEXT_NO_PASSWORD);
      expect(r.message).toContain(`(${REPAIR_SIGN_IN_HALF_DONE})`);
      expect(REPAIR_SIGN_IN_HALF_DONE).toBe('AI repair cannot finish a sign-in whose username was already typed: fix the signIn step by hand');
      expect(r.llmCalls ?? 0).toBe(0);
      expect(model.invocations).toHaveLength(0);
      // The username page was posted once (the listener sees the portal's requests); the password page never was.
      expect(posts.filter((p) => p === '/idp/login')).toHaveLength(1);
      expect(posts).not.toContain('/idp/password');
      secretFree(JSON.stringify(r, (k, v) => (['trace', 'screenshot', 'before', 'after', 'data'].includes(k) ? undefined : v)));
    } finally { portalServer.off('request', onRequest); }
  }, 60_000);
});
