import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { runScriptLane, screenshotMasks, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { checkTrust } from '../src/lane/trust.js';
import { runTask } from '../src/lane/task.js';
import { fakeModel } from './fake-model.js';
import { REPAIR_PASSWORD_CHANGE_HALF_DONE, secretHostNotListed, UNSIGNED_CHANGE_PASSWORD } from '../src/messages.js';
import { describeStep } from '../src/proposal/describe.js';
import { createMasker } from '../src/secrets/mask.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, PortalSecrets, Script, Step } from '../src/types.js';
import { LOCAL, policyFor, SECRETS, signedLaneInput } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

/** Accepted by the sandbox: 12 characters or more, with a digit. */
const NEW_PW = 'Fresh-Pass-4471';
/** Refused by the change page itself, before it posts: shorter than 12 characters. The typed values stay in the fields. */
const SHORT_PW = 'Short-71';
/** Refused by the site after the post: long enough, but without a digit. */
const NO_DIGIT_PW = 'Fresh-Pass-Only';

/** The sandbox's login pages plus its change-password page, unless `listed` is false. */
const policy = (listed = true): PortalPolicy => {
  const p = policyFor(portal);
  return listed ? { ...p, login: [...p.login, { host: portal.host, path: '/acme/change-password' }] } : p;
};

/**
 * The sign-in, with a password locator ("Password", not exact) that also matches every field of the change page: the
 * change page must not read as a rejected password.
 */
const SIGN_IN: Step = {
  intent: 'Sign in',
  signIn: {
    username: { label: 'Dealer user ID' },
    password: { label: 'Password' },
    submit: { role: 'button', name: 'Sign in' },
    totp: { field: { label: 'Authentication code' }, submit: { role: 'button', name: 'Verify' } },
    changePassword: {
      detect: { role: 'heading', name: 'Change your password' },
      current: { label: 'Current password' },
      new: [{ label: 'New password', exact: true }, { label: 'Confirm new password' }],
      submit: { role: 'button', name: 'Change password' },
      value: '{{var.newPassword}}',
    },
  },
};
const SIGNED_IN: Step = { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: { css: 'body[data-page=home]' } }, require: 'logged_in' } };
const script = (...more: Step[]): Script => ({ name: 'change-password', version: 1, startUrl: `${portal.url}/acme/login`, steps: [SIGN_IN, SIGNED_IN, ...more] });

function input(s: Script, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput {
  return signedLaneInput(s, { policy: policy(), secrets: SECRETS, vars: { newPassword: NEW_PW }, endpoint: LOCAL, defaultStepTimeoutMs: 3000, ...over });
}

/** Runs the steps on the login page with a live page kept open afterwards (the caller closes the session). */
async function direct(steps: Step[], opts: { vars: Record<string, string>; policy?: PortalPolicy; signed?: boolean; secrets?: PortalSecrets }) {
  const pol = opts.policy ?? policy();
  const masker = createMasker([SECRETS.username, SECRETS.password, SECRETS.totpSecret]);
  const session = await openSession({ endpoint: LOCAL, policy: pol, masker });
  await session.page.goto(`${portal.url}/acme/login`);
  const ctx: StepContext = {
    page: session.page, script: { name: 't', version: 1, startUrl: `${portal.url}/acme/login`, steps }, policy: pol, secrets: opts.secrets ?? SECRETS,
    vars: opts.vars, masker, defaultTimeoutMs: 3000, violations: session.violations, ...(opts.signed === false ? {} : { signed: true }),
  };
  return { session, masker, r: await runSteps(ctx, steps) };
}

/** Every entry of the trace zip under a result's `trace`, as text. */
const traceTexts = (trace: Buffer | undefined): string[] =>
  trace ? Object.values(unzipSync(new Uint8Array(trace))).map((bytes) => Buffer.from(bytes).toString('latin1')) : [];
/** A result's JSON without its binaries. */
const jsonOf = (r: unknown) => JSON.stringify(r, (k, v) => (['trace', 'screenshot'].includes(k) ? undefined : v));

describe('signIn.changePassword', () => {
  it('the approval text says the sign-in may set a new password and from which variable', () => {
    expect(describeStep(SIGN_IN)).toBe('Sign in (sign in with label "Dealer user ID", label "Password", submit role "button" name "Sign in", code in label "Authentication code", '
      + 'submit role "button" name "Verify"; if the site asks for a new password, set it from variable newPassword)');
  });

  it('a sign-in that lands on the change page types the current and the new password and reports passwordChanged', async () => {
    for (const mfa of ['none', 'totp'] as const) {
      portal.reset();
      portal.setState({ forcePasswordChange: true, mfa });
      const r = await runScriptLane(input(script()));
      if (!r.ok) throw new Error(`${mfa}: ${r.code}: ${r.message}`);
      expect(r.passwordChanged, mfa).toBe(true);
      expect(r.log.map((e) => [e.intent, e.status])).toEqual([['Sign in', 'ok'], ['Check sign-in worked', 'ok']]);
      // The site took the current password and the new one: it signs in with the new one from now on.
      expect(portal.state()).toMatchObject({ password: NEW_PW, forcePasswordChange: false, logins: 1 });
    }
  });

  it('the new password is masked in logs, the trace and a screenshot taken on the change page', async () => {
    portal.setState({ forcePasswordChange: true });
    // A later step whose selector holds the new password: its log note and the run's message must show [secret].
    const probe: Step = { intent: 'Find the link', optional: true, timeoutMs: 300, click: { css: `a[title="${NEW_PW}"]` } };
    const r = await runScriptLane(input(script(probe), { saveTrace: 'always' }));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.passwordChanged).toBe(true);
    expect(r.log[2].note).toContain('[secret]');
    const traces = traceTexts(r.trace);
    expect(traces.length).toBeGreaterThan(0);
    for (const text of [jsonOf(r), ...traces]) {
      expect(text).not.toContain(NEW_PW);
      expect(text).not.toContain(SECRETS.password);
    }

    // On the change page, with the new password still in its fields (the page refused it without posting): the
    // screenshot the run takes there masks every field, so it does not change with what the fields hold.
    portal.reset();
    portal.setState({ forcePasswordChange: true });
    const { session, r: refused } = await direct([SIGN_IN], { vars: { newPassword: SHORT_PW } });
    try {
      expect(refused.ok).toBe(false);
      const page = session.page;
      expect(await page.inputValue('#new-password')).toBe(SHORT_PW);
      const masked = await page.screenshot({ mask: screenshotMasks(page, SECRETS) });
      const unmasked = await page.screenshot();
      for (const id of ['#current-password', '#new-password', '#confirm-password']) await page.fill(id, 'x');
      expect((await page.screenshot({ mask: screenshotMasks(page, SECRETS) })).equals(masked)).toBe(true);
      expect((await page.screenshot()).equals(unmasked)).toBe(false);
    } finally { await session.close(); }
  });

  it('a change form without a current-password field: only the new password is typed, and the change goes through', async () => {
    portal.setState({ forcePasswordChange: true, changeWithoutCurrent: true });
    const signIn = SIGN_IN as Extract<Step, { signIn: unknown }>;
    const { current: _current, ...noCurrent } = signIn.signIn.changePassword!;
    const s = { ...script(), steps: [{ ...signIn, signIn: { ...signIn.signIn, changePassword: noCurrent } }, SIGNED_IN] };
    const r = await runScriptLane(input(s));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.passwordChanged).toBe(true);
    expect(portal.state()).toMatchObject({ password: NEW_PW, forcePasswordChange: false });
  });

  it('a sign-in that does not land on the change page runs as before and reports nothing', async () => {
    const r = await runScriptLane(input(script()));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r).not.toHaveProperty('passwordChanged');
    expect(r.log.map((e) => [e.intent, e.status])).toEqual([['Sign in', 'ok'], ['Check sign-in worked', 'ok']]);
    expect(portal.state()).toMatchObject({ password: null, logins: 1 });
  });

  it('a rejected new password fails as password_change_failed and the breaker is not tripped', async () => {
    // The site sends its change page back (no digit), or the page refuses without posting and the wait runs out (too short).
    const said: [string, string][] = [
      [NO_DIGIT_PW, 'Sign in: detected:password_change_failed: the site sent its change-password page back, so it did not take the new password'],
      [SHORT_PW, 'Sign in: detected:password_change_failed: the site did not confirm the new password within 3 s, so it may or may not be in force'],
    ];
    for (const [value, message] of said) {
      portal.reset();
      portal.setState({ forcePasswordChange: true });
      const r = await runScriptLane(input(script(), { vars: { newPassword: value } }));
      if (r.ok) throw new Error('expected failure');
      // Not login_failed or account_locked, the two codes that open the login breaker; no value in the message.
      expect({ code: r.code, message: r.message }, value).toEqual({ code: 'password_change_failed', message });
      expect(r).not.toHaveProperty('passwordChanged');
      expect(jsonOf(r)).not.toContain(value);
      expect(portal.state()).toMatchObject({ password: null, forcePasswordChange: true });
    }
  });

  it('passwordChanged is reported when a later step fails', async () => {
    portal.setState({ forcePasswordChange: true });
    const missing: Step = { intent: 'Open a page that is not there', timeoutMs: 300, click: { css: '#no-such-link' } };
    const r = await runScriptLane(input(script(missing)));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'drift_detected', passwordChanged: true });
    expect(portal.state().password).toBe(NEW_PW);
  });

  it('a change page that is not a declared login page is refused before anything is typed', async () => {
    portal.setState({ forcePasswordChange: true });
    const { session, r } = await direct([SIGN_IN], { vars: { newPassword: NEW_PW }, policy: policy(false) });
    try {
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(`signIn refused: ${new URL(portal.url).host}/acme/change-password is not listed in the Site Login under Pages Where the Password May Be Typed`);
      expect(r.state.passwordChanged).toBeUndefined();
      for (const id of ['#current-password', '#new-password', '#confirm-password']) expect(await session.page.inputValue(id), id).toBe('');
      expect(session.violations).toEqual([expect.objectContaining({ kind: 'signin', fatal: true })]);
    } finally { await session.close(); }
    const lane = await runScriptLane(input(script(), { policy: policy(false) }));
    expect(lane).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(portal.state()).toMatchObject({ password: null, forcePasswordChange: true });
  });

  it('unsigned steps with changePassword are refused before anything is typed', async () => {
    portal.setState({ forcePasswordChange: true });
    const { session, r } = await direct([SIGN_IN], { vars: { newPassword: NEW_PW }, signed: false });
    try {
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(UNSIGNED_CHANGE_PASSWORD);
      expect(r.state.credentialsSubmitted).toBe(false);
      expect(await session.page.inputValue('#username')).toBe('');
    } finally { await session.close(); }
    expect(portal.state().logins).toBe(0);
  });

  it('the trust gate refuses unsigned steps with changePassword before the browser opens, as it refuses a secret fill, whatever Allow Unsigned Writes says', async () => {
    const unsigned = script();
    for (const allowUnsignedWrites of [false, true]) {
      expect(checkTrust(unsigned, { required: false, allowUnsignedWrites }, { policy: policy(), firstRun: false }))
        .toEqual({ ok: false, code: 'script_untrusted', message: UNSIGNED_CHANGE_PASSWORD });
    }
    // The same sign-in without changePassword passes the gate with Allow Unsigned Writes on.
    const { changePassword: _change, ...plain } = (SIGN_IN as Extract<Step, { signIn: unknown }>).signIn;
    const plainDoc: Script = { ...unsigned, steps: [{ intent: 'Sign in', signIn: plain }, SIGNED_IN] };
    expect(checkTrust(plainDoc, { required: false, allowUnsignedWrites: true }, { policy: policy(), firstRun: false })).toEqual({ ok: true, signed: false });
    // At the lane, with Require Signed Steps off and Allow Unsigned Writes on: refused before the browser opens.
    const lane = await runScriptLane(input(unsigned, { endpoint: { mode: 'playwright', wsUrl: 'ws://browser.invalid:1/' }, trust: { required: false, allowUnsignedWrites: true } }));
    expect(lane).toMatchObject({ ok: false, code: 'script_untrusted', message: UNSIGNED_CHANGE_PASSWORD });
    expect(portal.state().logins).toBe(0);
  });

  it('a password change that stopped after its fields were typed is not handed to AI repair', async () => {
    portal.setState({ forcePasswordChange: true });
    // The change form's button never becomes clickable (a disabled button): the click times out after the fields were typed.
    const signIn = SIGN_IN as Extract<Step, { signIn: unknown }>;
    const stuck = { ...signIn, signIn: { ...signIn.signIn, changePassword: { ...signIn.signIn.changePassword!, submit: { role: 'button', name: 'Suggest a password' } } } };
    const read: Step = { intent: 'Read the notices', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } };
    const model = fakeModel([() => null]);
    const r = await runTask(signedLaneInput({ ...script(), steps: [stuck, SIGNED_IN, read] }, {
      policy: policy(), secrets: SECRETS, vars: { newPassword: NEW_PW }, output: { idPattern: 'N26-\\d{4}' }, endpoint: LOCAL, defaultStepTimeoutMs: 3000,
      repair: { model, goal: 'Read the notices.' },
    }));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script' });
    if (r.ok) return;
    expect(r.message).toContain(`(${REPAIR_PASSWORD_CHANGE_HALF_DONE})`);
    expect(REPAIR_PASSWORD_CHANGE_HALF_DONE).toBe('AI repair cannot finish a password change whose fields were already typed: fix the signIn step by hand');
    expect(r).not.toHaveProperty('passwordChanged');
    expect(model.invocations).toHaveLength(0);
    expect(portal.state()).toMatchObject({ password: null, forcePasswordChange: true });
  });

  it('the next run signs in with the new password', async () => {
    portal.setState({ forcePasswordChange: true });
    const first = await runScriptLane(input(script()));
    expect(first).toMatchObject({ ok: true, passwordChanged: true });
    // The workflow stored the new password and the credential now holds it.
    const second = await runScriptLane(input(script(), { secrets: { ...SECRETS, password: NEW_PW } }));
    if (!second.ok) throw new Error(`${second.code}: ${second.message}`);
    expect(second).not.toHaveProperty('passwordChanged');
    // The old password no longer works.
    const old = await runScriptLane(input(script()));
    expect(old).toMatchObject({ ok: false, code: 'login_failed' });
    expect(portal.state().logins).toBe(3);
  });

  it('a new password from the RPA Secret Variables credential is typed only on a host its May Be Typed Into lists', async () => {
    // Not listed: refused on the change page before anything is typed there, the current password included.
    portal.setState({ forcePasswordChange: true });
    const secret = { secretVars: ['newPassword'] };
    const refused = await runScriptLane(input(script(), { ...secret, secretTargets: { apps: ['ErpDemo.exe'], hosts: ['erp.example.com'] }, saveTrace: 'always' }));
    expect(refused).toMatchObject({ ok: false, code: 'policy_violation' });
    if (refused.ok) return;
    expect(refused.message).toBe(`Sign in: ${secretHostNotListed(portal.host)}`);
    expect(refused).not.toHaveProperty('passwordChanged');
    for (const text of [jsonOf(refused), ...traceTexts(refused.trace)]) expect(text).not.toContain(NEW_PW);
    expect(portal.state()).toMatchObject({ password: null, forcePasswordChange: true });
    // Listed: the change goes through as without the field.
    portal.reset();
    portal.setState({ forcePasswordChange: true });
    const listed = await runScriptLane(input(script(), { ...secret, secretTargets: { apps: [], hosts: [portal.host] } }));
    if (!listed.ok) throw new Error(`${listed.code}: ${listed.message}`);
    expect(listed.passwordChanged).toBe(true);
    expect(portal.state()).toMatchObject({ password: NEW_PW, forcePasswordChange: false });
  });
});
