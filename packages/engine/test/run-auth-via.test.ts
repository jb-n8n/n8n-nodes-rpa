// signIn totp.via and totp.check: an identity provider that shows pages between the password and the code field (a
// factor choice, "Send me the code") and a checkbox to tick before the code is submitted, all in one browser session.
// Run against the sandbox's identity provider (sso2: email, password, then IDP_FACTOR's pages, then the code).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { signInCodeFieldMissing } from '../src/messages.js';
import { describeStep } from '../src/proposal/describe.js';
import { createMasker } from '../src/secrets/mask.js';
import { totp } from '../src/secrets/totp.js';
import { scriptHash, signScript, startHostOf, verifyScript } from '../src/sign.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import { parseScript } from '../src/steps/parse.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { CodeProvider, Locator, PortalPolicy, PortalSecrets, SignInSpec, Step } from '../src/types.js';
import { LOCAL, signedLaneInput } from './helpers.js';
import { bound } from './timing.js';

const IDP_SECRETS: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
const NO_SEED: PortalSecrets = { username: IDP_SECRETS.username, password: IDP_SECRETS.password };
const SEED = IDP_SECRETS.totpSecret!;

const CHOOSE_CODE: Locator = { role: 'button', name: 'Use a verification code' };
const SEND_CODE: Locator = { role: 'button', name: 'Send me the code' };
const TRUST: Locator = { label: 'Trust this browser' };
const VIA = [CHOOSE_CODE, SEND_CODE];

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session | undefined;
beforeAll(async () => { portal = await startPortal({ sap: 'realistic', sapLogin: 'sso2' }); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); process.env.IDP_KMSI = 'off'; });
afterEach(async () => {
  for (const k of ['IDP_KMSI', 'IDP_FACTOR', 'IDP_TRUST']) delete process.env[k];
  await session?.close();
  session = undefined;
});

// The password pages and the code page are login pages; the factor and send pages are listed too because their
// buttons POST (a form POST anywhere else is a write the session blocks), not because the engine types anything there.
const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: ['/idp/login', '/idp/password', '/idp/factor', '/idp/sendcode', '/idp/mfa', '/sap/saml2/acs'].map((path) => ({ host: portal.host, path })),
  allowedSubmits: [],
  allowPrivateNetwork: true,
});

function signInStep(totpOver: Partial<NonNullable<SignInSpec['totp']>> = {}, over: Partial<Step> = {}): Step {
  return {
    intent: 'Sign in at the identity provider',
    signIn: {
      username: { label: 'Email' },
      next: { role: 'button', name: 'Next' },
      password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' }, ...totpOver },
    },
    ...over,
  } as Step;
}
const LANDED: Step = { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: { role: 'button', name: 'Line Item Report' } } } };

/** The posts the browser made to the identity provider's paths, in order, with their bodies. */
async function atLogin(over: Partial<StepContext> = {}): Promise<{ ctx: StepContext; posts: { path: string; body: string }[] }> {
  session = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  const posts: { path: string; body: string }[] = [];
  session.page.on('request', (rq) => {
    if (rq.method() === 'POST') posts.push({ path: new URL(rq.url()).pathname, body: rq.postData() ?? '' });
  });
  await session.page.goto(`${portal.url}${SANDBOX.erp.webguiPath}`);
  const secrets = over.secrets ?? IDP_SECRETS;
  const ctx: StepContext = {
    page: session.page, script: { startUrl: policy().startUrl, steps: [], interrupts: [] }, policy: policy(), secrets, vars: {},
    masker: createMasker([secrets.username, secrets.password, secrets.totpSecret]), defaultTimeoutMs: 5000, violations: session.violations, ...over,
  };
  return { ctx, posts };
}
const paths = (posts: { path: string }[]) => posts.map((p) => p.path);

describe('parse, schema and signing: totp.via and totp.check', () => {
  const doc = (totpOver: object) => ({ name: 'idp-sign-in', version: 1, startUrl: 'https://idp.example/login', steps: [{ ...signInStep(), signIn: { ...(signInStep() as { signIn: SignInSpec }).signIn, totp: { field: { label: 'Code' }, submit: { text: 'Verify' }, ...totpOver } } }] });

  it('accepts via and check with either source and keeps them', () => {
    for (const source of ['seed', 'workflow'] as const) {
      const s = parseScript(doc({ via: VIA, check: [TRUST], source })).steps[0];
      if (!('signIn' in s)) throw new Error('expected signIn');
      expect(s.signIn.totp).toEqual({ field: { label: 'Code' }, submit: { text: 'Verify' }, via: VIA, check: [TRUST], source });
    }
  });

  it('refuses an empty list, more than 5, a non-locator and a locator in a frame', () => {
    for (const key of ['via', 'check']) {
      expect(() => parseScript(doc({ [key]: [] }))).toThrow(new RegExp(`totp\\.${key} must be an array of 1 to 5 locators`));
      expect(() => parseScript(doc({ [key]: Array.from({ length: 6 }, () => SEND_CODE) }))).toThrow(new RegExp(`totp\\.${key} must be an array of 1 to 5 locators`));
      expect(() => parseScript(doc({ [key]: SEND_CODE }))).toThrow(new RegExp(`totp\\.${key} must be an array of 1 to 5 locators`));
      expect(() => parseScript(doc({ [key]: ['Send'] }))).toThrow(new RegExp(`totp\\.${key}\\[0\\]`));
      expect(() => parseScript(doc({ [key]: [SEND_CODE, { css: '#x', frame: 'iframe' }] }))).toThrow(new RegExp(`totp\\.${key}\\[1\\] cannot use frame`));
    }
  });

  it('the JSON schema accepts and refuses the same documents', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/steps.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const ajv = new Ajv({ allErrors: true });
    ajv.addSchema(schema, 'steps.schema.json');
    const validate = ajv.getSchema('steps.schema.json')!;
    for (const source of ['seed', 'workflow']) {
      const ok = doc({ via: VIA, check: [TRUST], source });
      expect(validate(ok), ajv.errorsText(validate.errors)).toBe(true);
    }
    for (const key of ['via', 'check']) {
      for (const bad of [[], Array.from({ length: 6 }, () => SEND_CODE), SEND_CODE, ['Send'], [{ css: '#x', frame: 'iframe' }]]) {
        expect(validate(doc({ [key]: bad })), `${key} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });

  it('the change list shows the via clicks and the ticked boxes', () => {
    expect(describeStep(signInStep({ via: VIA, check: [TRUST] }))).toBe('Sign in at the identity provider (sign in with label "Email", next role "button" name "Next", label "Password", submit role "button" name "Sign in"'
      + ', then click role "button" name "Use a verification code", then role "button" name "Send me the code" if shown, code in label "Code", tick label "Trust this browser", submit role "button" name "Verify")');
    // Without them it reads as before.
    expect(describeStep(signInStep())).toBe('Sign in at the identity provider (sign in with label "Email", next role "button" name "Next", label "Password", submit role "button" name "Sign in", code in label "Code", submit role "button" name "Verify")');
  });

  it('they are part of the signed step: the signature verifies, and changing or dropping one breaks it', () => {
    const signed = doc({ via: VIA, check: [TRUST] });
    const binding = { approvedBy: 'approver@example.com' };
    const { signature } = signScript(signed, 'k'.repeat(32), binding);
    expect(verifyScript(signed, 'k'.repeat(32), { ...binding, signature })).toBe(true);
    // The start host is bound only when the document parses: an empty one would mean parseScript refused the step.
    expect(startHostOf(signed)).toBe('idp.example');
    for (const changed of [doc({ via: [SEND_CODE], check: [TRUST] }), doc({ via: VIA }), doc({ check: [TRUST] }), doc({ via: VIA, check: [{ label: 'Remember me' }] })]) {
      expect(scriptHash(changed)).not.toBe(scriptHash(signed));
      expect(verifyScript(changed, 'k'.repeat(32), { ...binding, signature })).toBe(false);
    }
  });
});

describe('signIn with pages between the password and the code (totp.via)', () => {
  it('seed: clicks each via button in order, then types the generated code', async () => {
    process.env.IDP_FACTOR = 'choice';
    const { ctx, posts } = await atLogin();
    const r = await runSteps(ctx, [signInStep({ via: VIA }), LANDED]);
    expect(r.ok).toBe(true);
    expect(r.state.detected.afterLogin).toBe('logged_in');
    expect(paths(posts)).toEqual(['/idp/login', '/idp/password', '/idp/factor', '/idp/sendcode', '/idp/mfa', '/sap/saml2/acs']);
    expect(posts.find((p) => p.path === '/idp/factor')?.body).toContain('method=code');
    expect(ctx.violations).toEqual([]);
  });

  it('workflow: asks the code provider only once the code field shows after the via pages, and ticks the checkbox', async () => {
    process.env.IDP_FACTOR = 'choice';
    process.env.IDP_TRUST = 'on';
    const seen: { url: string; fieldVisible: boolean }[] = [];
    const asked: string[] = [];
    const { ctx, posts } = await atLogin({ secrets: NO_SEED });
    // When "Send me the code" was clicked, on the page's own clock.
    let sentAt: number | undefined;
    await ctx.page.exposeFunction('__sent', (when: number) => { sentAt ??= when; });
    await ctx.page.addInitScript(() => {
      document.addEventListener('click', (e) => {
        if ((e.target as Element).closest('button')?.textContent?.includes('Send me the code')) void (window as unknown as { __sent: (w: number) => void }).__sent(Date.now());
      }, true);
    });
    await ctx.page.reload();
    ctx.codeProvider = async (req) => {
      asked.push(req.requestedAt);
      seen.push({ url: new URL(ctx.page.url()).pathname, fieldVisible: await ctx.page.locator('#otc').isVisible() });
      return totp(SEED);
    };
    const r = await runSteps(ctx, [signInStep({ via: VIA, check: [TRUST], source: 'workflow' }), LANDED]);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ url: '/idp/mfa', fieldVisible: true }]);
    // requestedAt is stamped before the via clicks, so a workflow that takes only mail sent after it finds the code.
    expect(sentAt).toBeDefined();
    expect(Date.parse(asked[0])).toBeLessThanOrEqual(sentAt!);
    expect(paths(posts)).toEqual(['/idp/login', '/idp/password', '/idp/factor', '/idp/sendcode', '/idp/mfa', '/sap/saml2/acs']);
    expect(new URLSearchParams(posts.find((p) => p.path === '/idp/mfa')!.body).get('trust')).toBe('yes');
  });

  it('a via button that does not appear is skipped: a later one, or the code field, is used as soon as it shows', async () => {
    for (const factor of ['send', undefined]) {
      portal.reset();
      if (factor) process.env.IDP_FACTOR = factor; else delete process.env.IDP_FACTOR;
      const { ctx, posts } = await atLogin();
      const t0 = Date.now();
      const r = await runSteps(ctx, [signInStep({ via: VIA }, { timeoutMs: 20_000 }), LANDED]);
      expect(r.ok, String(factor)).toBe(true);
      // Not one step timeout per missing button: the page that does show is acted on at once.
      expect(Date.now() - t0).toBeLessThan(bound(15_000));
      expect(paths(posts)).toEqual(['/idp/login', '/idp/password', ...(factor ? ['/idp/sendcode'] : []), '/idp/mfa', '/sap/saml2/acs']);
      await session?.close();
      session = undefined;
    }
  });

  it('a code field that never appears fails clearly after the step timeout, with nothing typed and no code asked for', async () => {
    process.env.IDP_FACTOR = 'choice';
    const provider = vi.fn<CodeProvider>(async () => totp(SEED));
    const { ctx, posts } = await atLogin({ secrets: NO_SEED, codeProvider: provider });
    const t0 = Date.now();
    // The factor page asks for a choice the step does not know: only "Send me the code" is declared.
    const r = await runSteps(ctx, [signInStep({ via: [SEND_CODE], source: 'workflow' }, { timeoutMs: 2000 }), LANDED]);
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(signInCodeFieldMissing(2, 0, 1));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(Date.now() - t0).toBeLessThan(bound(15_000));
    expect(provider).not.toHaveBeenCalled();
    expect(paths(posts)).toEqual(['/idp/login', '/idp/password']);
    expect(new URL(ctx.page.url()).pathname).toBe('/idp/factor');
    expect(await ctx.page.getByRole('heading', { name: 'Verify your identity' }).isVisible()).toBe(true);
  });

  it('a rejected password with via set returns at once instead of waiting for the code field', async () => {
    process.env.IDP_FACTOR = 'choice';
    const { ctx, posts } = await atLogin({ secrets: { ...IDP_SECRETS, password: 'wrong-password' } });
    const t0 = Date.now();
    const r = await runSteps(ctx, [signInStep({ via: VIA }, { timeoutMs: 30_000 })]);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(bound(15_000));
    expect(paths(posts)).toEqual(['/idp/login', '/idp/password']);
  });
});

describe('a signed step set with totp.via and totp.check through the script lane', () => {
  it('verifies the signature, signs in through the via pages, ticks the box and lands', async () => {
    process.env.IDP_FACTOR = 'choice';
    process.env.IDP_TRUST = 'on';
    const script = { name: 'idp-via', version: 1, startUrl: policy().startUrl, steps: [signInStep({ via: VIA, check: [TRUST] }), LANDED] };
    const r = await runScriptLane(signedLaneInput(script, { policy: policy(), secrets: IDP_SECRETS, output: {}, endpoint: LOCAL, defaultStepTimeoutMs: 5000 }));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 1500));
    expect(r.violations).toHaveLength(0);
    expect(r.blockedRequests).toHaveLength(0);
  });
});

describe('signIn ticks totp.check after the code is typed and before the submit', () => {
  it('seed: the checkbox is ticked in the code POST; without check it is not', async () => {
    process.env.IDP_TRUST = 'on';
    let checkedAtSubmit: boolean | undefined;
    let codeAtTick: string | undefined;
    const { ctx, posts } = await atLogin();
    await ctx.page.exposeFunction('__seen', (checked: boolean, code: string) => { checkedAtSubmit = checked; codeAtTick ??= code; });
    await ctx.page.addInitScript(() => {
      document.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement;
        if (t.id === 'trustBrowser') void (window as unknown as { __seen: (c: boolean, v: string) => void }).__seen(t.checked, (document.getElementById('otc') as HTMLInputElement).value);
      }, true);
    });
    const r = await runSteps(ctx, [signInStep({ check: [TRUST] }), LANDED]);
    expect(r.ok).toBe(true);
    expect(checkedAtSubmit).toBe(true);
    // The code was already in its field when the box was ticked.
    expect(codeAtTick).toMatch(/^\d{6}$/);
    expect(new URLSearchParams(posts.find((p) => p.path === '/idp/mfa')!.body).get('trust')).toBe('yes');
    expect((await ctx.page.context().cookies()).some((c) => c.name === 'idp_trusted')).toBe(true);

    portal.reset();
    await session?.close();
    const plain = await atLogin();
    const r2 = await runSteps(plain.ctx, [signInStep(), LANDED]);
    expect(r2.ok).toBe(true);
    expect(new URLSearchParams(plain.posts.find((p) => p.path === '/idp/mfa')!.body).get('trust')).toBeNull();
  });

  it('a check box that is not on the code page fails before the code is submitted', async () => {
    const { ctx, posts } = await atLogin();
    const r = await runSteps(ctx, [signInStep({ check: [TRUST] }, { timeoutMs: 1500 })]);
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toMatch(/Trust this browser/);
    expect(paths(posts)).toEqual(['/idp/login', '/idp/password']);
  });
});
