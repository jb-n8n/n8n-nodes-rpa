// signIn.changePassword.via and signInAgain: a site whose expired password sends the password page back with a "Modify
// password" link, whose change form says "changed" and offers "Continue" to its sign-in page, where the run signs in
// once more with the new password and its code. Run against a small site served by this file.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { Ajv } from 'ajv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { changePasswordFormMissing } from '../src/messages.js';
import { describeStep } from '../src/proposal/describe.js';
import { totp } from '../src/secrets/totp.js';
import { signScript, verifyScript } from '../src/sign.js';
import { parseScript } from '../src/steps/parse.js';
import type { ChangePasswordSpec, Locator, PortalPolicy, PortalSecrets, Script, SignInSpec, Step } from '../src/types.js';
import { LOCAL, signedLaneInput } from './helpers.js';

const OLD_PW = 'Old-Pass-2025';
const NEW_PW = 'Fresh-Pass-4471';
const SEED = 'JBSWY3DPEHPK3PXP';
const SECRETS: PortalSecrets = { username: 'dealer-07', password: OLD_PW, totpSecret: SEED };

interface SiteState {
  password: string; expired: boolean; mfa: boolean;
  /** After the change: 'continue' shows a confirmation with a Continue link to the sign-in page; 'home' lets the run in. */
  afterChange: 'continue' | 'home';
  /** Test hook: the sign-in page refuses every password once the change went through. */
  refuseAfterChange: boolean;
  logins: number; changes: number; codes: number; usedWindows: Set<number>;
}
const fresh = (): SiteState => ({
  password: OLD_PW, expired: false, mfa: true, afterChange: 'continue', refuseAfterChange: false, logins: 0, changes: 0, codes: 0, usedWindows: new Set(),
});
let site = fresh();
const sessions = new Map<string, { stage: 'user' | 'password' | 'mfa' | 'in'; user?: string }>();

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let data = '';
  for await (const chunk of req) data += chunk;
  return new URLSearchParams(data);
}
function serve(req: IncomingMessage, res: ServerResponse, body: string, cookie?: string) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(cookie ? { 'Set-Cookie': `sid=${cookie}; Path=/` } : {}) });
  res.end(body);
}
function redirect(res: ServerResponse, to: string) { res.writeHead(302, { Location: to }); res.end(); }
const passwordPage = (error = '') => html('Sign in', `<h1>Welcome</h1>${error ? `<p role="alert">${error}</p>` : ''}
  <form method="post" action="/p/login/password"><label for="pw">Password</label><input id="pw" name="password" type="password"><button type="submit">Log on</button></form>
  <p><a href="/p/modify-password">Modify password</a> <a href="/p/forgot">Forgot password?</a></p>`);
const changePage = (error = '') => html('Modify password', `<h1>Modify password</h1>${error ? `<p role="alert">${error}</p>` : ''}
  <form method="post" action="/p/modify-password"><label for="n1">New password</label><input id="n1" name="n1" type="password">
  <label for="n2">Repeat the new password</label><input id="n2" name="n2" type="password"><button type="submit">Next</button></form>`);

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const sid = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
  const s = sid ? sessions.get(sid) : undefined;
  const path = url.pathname;
  if (path === '/p/login' && req.method === 'GET') {
    const id = Math.random().toString(36).slice(2);
    sessions.set(id, { stage: 'user' });
    return serve(req, res, html('Sign in', `<h1>Welcome</h1><form method="post" action="/p/login/user"><label for="user">User ID</label><input id="user" name="user"><button type="submit">Next</button></form>`), id);
  }
  if (path === '/p/login/user' && req.method === 'POST' && s) {
    s.user = (await form(req)).get('user') ?? '';
    s.stage = 'password';
    return redirect(res, '/p/login/password');
  }
  if (path === '/p/login/password' && s?.stage === 'password') {
    if (req.method === 'GET') return serve(req, res, passwordPage());
    site.logins++;
    const pw = (await form(req)).get('password');
    if (pw !== site.password || (site.refuseAfterChange && site.changes > 0)) return serve(req, res, passwordPage('The User ID or password is incorrect.'));
    if (site.expired) return serve(req, res, passwordPage('Your password has expired. Please modify your password.'));
    s.stage = site.mfa ? 'mfa' : 'in';
    return redirect(res, site.mfa ? '/p/mfa' : '/p/home');
  }
  if (path === '/p/modify-password' && s?.stage === 'password') {
    if (req.method === 'GET') return serve(req, res, changePage());
    const f = await form(req);
    const next = f.get('n1') ?? '';
    if (next.length < 10 || !/[0-9]/.test(next) || next !== f.get('n2')) return serve(req, res, changePage('The new password does not meet the rules.'));
    site.password = next;
    site.expired = false;
    site.changes++;
    if (site.afterChange === 'home') { s.stage = 'in'; return redirect(res, '/p/home'); }
    if (sid) sessions.delete(sid);
    return serve(req, res, html('Modify password', `<h1>Modify password</h1><p>Your password was changed.</p><a href="/p/login">Continue</a>`));
  }
  if (path === '/p/mfa' && s?.stage === 'mfa') {
    if (req.method === 'GET') return serve(req, res, html('Code', `<h1>Code</h1><form method="post" action="/p/mfa"><label for="otp">Passcode</label><input id="otp" name="otp"><button type="submit">Sign On</button></form>`));
    const code = (await form(req)).get('otp');
    const window = [-1, 0, 1].map((d) => Math.floor(Date.now() / 30_000) + d).find((w) => totp(SEED, w * 30_000) === code);
    if (window === undefined || site.usedWindows.has(window)) return redirect(res, '/p/mfa');
    site.usedWindows.add(window);
    site.codes++;
    s.stage = 'in';
    return redirect(res, '/p/home');
  }
  if (path === '/p/home' && s?.stage === 'in') return serve(req, res, html('Home', `<h1>Dealer home</h1><button type="button">Sign out</button>`));
  return redirect(res, '/p/login');
}

let server: Server;
let base = '';
let host = '';
beforeAll(async () => {
  server = createServer((req, res) => { route(req, res).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => { site = fresh(); sessions.clear(); });

const policy = (pages = ['/p/login', '/p/login/user', '/p/login/password', '/p/modify-password', '/p/mfa']): PortalPolicy => ({
  startUrl: `${base}/p/login`, navHosts: [host], subresourceHosts: [], login: pages.map((path) => ({ host, path })), allowedSubmits: [], allowPrivateNetwork: true,
});

const MODIFY: Locator = { role: 'link', name: 'Modify password' };
const CONTINUE: Locator = { role: 'link', name: 'Continue' };
const CHANGE: ChangePasswordSpec = {
  detect: { text: 'Your password has expired' },
  via: [MODIFY],
  new: [{ label: 'New password', exact: true }, { label: 'Repeat the new password' }],
  submit: { role: 'button', name: 'Next' },
  value: '{{var.newPassword}}',
  signInAgain: { via: [CONTINUE] },
};
const signIn = (change: Partial<ChangePasswordSpec> | undefined = {}): Step => ({
  intent: 'Sign in',
  signIn: {
    username: { label: 'User ID' }, next: { role: 'button', name: 'Next' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Log on' },
    totp: { field: { label: 'Passcode' }, submit: { role: 'button', name: 'Sign On' } },
    ...(change ? { changePassword: { ...CHANGE, ...change } } : {}),
  },
} as Step);
const LANDED: Step = { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: { role: 'heading', name: 'Dealer home' } }, require: 'logged_in' } };
const script = (step: Step = signIn(), ...more: Step[]): Script => ({ name: 'dealer-sign-in', version: 1, startUrl: `${base}/p/login`, steps: [step, LANDED, ...more] });
const input = (s: Script, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput =>
  signedLaneInput(s, { policy: policy(), secrets: SECRETS, vars: { newPassword: NEW_PW }, endpoint: LOCAL, defaultStepTimeoutMs: 4000, ...over });

const traceTexts = (trace: Buffer | undefined): string[] =>
  trace ? Object.values(unzipSync(new Uint8Array(trace))).map((bytes) => Buffer.from(bytes).toString('latin1')) : [];
const jsonOf = (r: unknown) => JSON.stringify(r, (k, v) => (['trace', 'screenshot'].includes(k) ? undefined : v));
const without = <K extends keyof ChangePasswordSpec>(...keys: K[]): Partial<ChangePasswordSpec> => Object.fromEntries(keys.map((k) => [k, undefined]));

describe('signIn.changePassword.via and signInAgain: the step format', () => {
  const doc = (change: object) => ({ name: 'd', version: 1, startUrl: 'https://portal.example/login', steps: [{ intent: 'Sign in', signIn: { ...(signIn() as { signIn: SignInSpec }).signIn, changePassword: { ...CHANGE, ...change } } }] });

  it('parses via and signInAgain and keeps them', () => {
    const s = parseScript(doc({})).steps[0];
    if (!('signIn' in s)) throw new Error('expected signIn');
    expect(s.signIn.changePassword).toEqual(CHANGE);
    expect(() => parseScript(doc({ signInAgain: {} }))).not.toThrow();
  });

  it('refuses a bad list, an unknown key, a frame and a variable in their locators', () => {
    expect(() => parseScript(doc({ via: [] }))).toThrow(/changePassword\.via must be an array of 1 to 5 locators/);
    expect(() => parseScript(doc({ via: MODIFY }))).toThrow(/changePassword\.via must be an array of 1 to 5 locators/);
    expect(() => parseScript(doc({ via: Array.from({ length: 6 }, () => MODIFY) }))).toThrow(/changePassword\.via must be an array of 1 to 5 locators/);
    expect(() => parseScript(doc({ signInAgain: true }))).toThrow(/changePassword\.signInAgain must be an object/);
    expect(() => parseScript(doc({ signInAgain: { via: [] } }))).toThrow(/changePassword\.signInAgain\.via must be an array of 1 to 5 locators/);
    expect(() => parseScript(doc({ signInAgain: { click: [CONTINUE] } }))).toThrow(/changePassword\.signInAgain has unknown key "click"/);
    expect(() => parseScript(doc({ via: [{ css: 'a', frame: 'iframe' }] }))).toThrow(/changePassword\.via\[0\] cannot use frame/);
    expect(() => parseScript(doc({ signInAgain: { via: [{ css: 'a', frame: 'iframe' }] } }))).toThrow(/changePassword\.signInAgain\.via\[0\] cannot use frame/);
    expect(() => parseScript(doc({ via: [{ text: '{{var.link}}' }] }))).toThrow(/changePassword\.via\[0\]/);
    expect(() => parseScript(doc({ signInAgain: { via: [{ text: '{{var.link}}' }] } }))).toThrow(/changePassword\.signInAgain\.via\[0\]/);
  });

  it('the JSON schema takes the same document and refuses the same unknown key', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/steps.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(doc({})), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(doc({ signInAgain: { click: [CONTINUE] } }))).toBe(false);
  });

  it('the review text names the via clicks and the sign-in again', () => {
    expect(describeStep(signIn())).toBe('Sign in (sign in with label "User ID", next role "button" name "Next", label "Password", submit role "button" name "Log on", '
      + 'code in label "Passcode", submit role "button" name "Sign On"; if the site asks for a new password, click role "link" name "Modify password" if shown, '
      + 'set it from variable newPassword, then sign in again with it after role "link" name "Continue" if shown)');
  });

  it('the new keys enter the signature only when a step uses them: an existing signed bot still verifies', () => {
    // A document with changePassword as signed before via and signInAgain existed: its MAC, computed on the code before this change.
    const { via: _via, signInAgain: _again, ...plain } = CHANGE;
    const existing = { ...doc({}), steps: [{ intent: 'Sign in', signIn: { ...(signIn() as { signIn: SignInSpec }).signIn, changePassword: plain } }] };
    expect(JSON.stringify(existing)).not.toMatch(/via"|signInAgain/);
    const binding = { approvedBy: 'approver@example.com', siteLoginId: 'login-1' };
    const before = 'b0cadd8ac75bdfd1a5c77778801bc38ae5201db404ac032f540c4bc28a4673b7';
    const { signature } = signScript(existing, 'k', binding);
    expect(signature).toBe(before);
    expect(verifyScript(existing, 'k', { ...binding, signature: before })).toBe(true);
    // Adding via (or signInAgain) to a signed document breaks its signature.
    expect(verifyScript(doc({ signInAgain: undefined }), 'k', { ...binding, signature })).toBe(false);
    expect(verifyScript(doc({ via: undefined }), 'k', { ...binding, signature })).toBe(false);
  });
});

describe('signIn.changePassword behind a link, then a sign-in again', () => {
  it('clicks the link, sets the new password, clicks Continue, signs in with the new password and its code', async () => {
    site.expired = true;
    const r = await runScriptLane(input(script(), { saveTrace: 'always' }));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.passwordChanged).toBe(true);
    expect(r.log.map((e) => [e.intent, e.status])).toEqual([['Sign in', 'ok'], ['Check sign-in worked', 'ok']]);
    expect({ password: site.password, changes: site.changes, logins: site.logins, codes: site.codes }).toEqual({ password: NEW_PW, changes: 1, logins: 2, codes: 1 });
    for (const text of [jsonOf(r), ...traceTexts(r.trace)]) {
      expect(text).not.toContain(NEW_PW);
      expect(text).not.toContain(OLD_PW);
    }
  });

  it('the next run signs in with the new password, and the step changes nothing when the site does not ask', async () => {
    site.expired = true;
    expect(await runScriptLane(input(script()))).toMatchObject({ ok: true, passwordChanged: true });
    // The next run comes later: its code is in a window the site has not seen.
    site.usedWindows.clear();
    const next = await runScriptLane(input(script(), { secrets: { ...SECRETS, password: NEW_PW } }));
    if (!next.ok) throw new Error(`${next.code}: ${next.message}`);
    expect(next).not.toHaveProperty('passwordChanged');
    expect({ changes: site.changes, logins: site.logins }).toEqual({ changes: 1, logins: 3 });
  });

  it('without signInAgain, the step ends on the confirmation page with passwordChanged, as a plain change does', async () => {
    site.expired = true;
    const confirmed: Step = { intent: 'Confirmed', waitFor: { target: { text: 'Your password was changed.' } } };
    const r = await runScriptLane(input({ ...script(), steps: [signIn(without('signInAgain')), confirmed] }));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.passwordChanged).toBe(true);
    expect({ password: site.password, logins: site.logins }).toEqual({ password: NEW_PW, logins: 1 });
  });

  it('a site that lets the run in after the change: nothing more is typed', async () => {
    site.expired = true;
    site.afterChange = 'home';
    const r = await runScriptLane(input(script()));
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    expect(r.passwordChanged).toBe(true);
    expect({ logins: site.logins, codes: site.codes }).toEqual({ logins: 1, codes: 0 });
  });

  it('a via link that never shows is drift before anything is typed, and nothing is reported changed', async () => {
    site.expired = true;
    const r = await runScriptLane(input(script(signIn({ via: [{ role: 'link', name: 'Change your password' }] }))));
    expect(r).toMatchObject({ ok: false, code: 'drift_detected' });
    if (r.ok) return;
    expect(r.message).toBe(`Sign in: ${changePasswordFormMissing(4, 0, 1)}`);
    expect(r).not.toHaveProperty('passwordChanged');
    expect({ password: site.password, changes: site.changes }).toEqual({ password: OLD_PW, changes: 0 });
  });

  it('a new password the site sends back is password_change_failed: the form field marks the change page, not detect', async () => {
    site.expired = true;
    const r = await runScriptLane(input(script(), { vars: { newPassword: 'no-digits-here' } }));
    expect(r).toMatchObject({ ok: false, code: 'password_change_failed' });
    if (r.ok) return;
    expect(r.message).toBe('Sign in: detected:password_change_failed: the site sent its change-password page back, so it did not take the new password');
    expect(r).not.toHaveProperty('passwordChanged');
    expect(jsonOf(r)).not.toContain('no-digits-here');
  });

  it('a sign-in again the site refuses fails login_failed with passwordChanged, saying the new password is in force', async () => {
    site.expired = true;
    site.refuseAfterChange = true;
    const r = await runScriptLane(input(script()));
    expect(r).toMatchObject({ ok: false, code: 'login_failed', passwordChanged: true });
    if (r.ok) return;
    expect(r.message).toBe('Sign in: detected:login_failed: the site took the new password, then sent the sign-in page back when the run signed in with it');
    expect(site.password).toBe(NEW_PW);
  });

  it('a change page that is not a declared login page is refused before anything is typed there', async () => {
    site.expired = true;
    const r = await runScriptLane(input(script(), { policy: policy(['/p/login', '/p/login/user', '/p/login/password', '/p/mfa']) }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
    expect({ password: site.password, changes: site.changes }).toEqual({ password: OLD_PW, changes: 0 });
  });

  it('a new password from the RPA Secret Variables credential is typed on the sign-in page only on a host its May Be Typed Into lists', async () => {
    site.expired = true;
    const listed = await runScriptLane(input(script(), { secretVars: ['newPassword'], secretTargets: { apps: [], hosts: [host] } }));
    if (!listed.ok) throw new Error(`${listed.code}: ${listed.message}`);
    expect(listed.passwordChanged).toBe(true);
    expect(site.logins).toBe(2);
  });
});
