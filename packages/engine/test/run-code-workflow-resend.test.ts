// signIn with totp.source 'workflow' and totp.via: after a rejected code, the one retry clicks the last via button
// ("Send me the code") again when the code page shows it, so an email-code workflow gets a new requestedAt and the
// new code; without that button on the code page the retry waits for the next code window with the same requestedAt.
// Run against the sandbox's identity provider (sso2 with IDP_FACTOR=send; IDP_RESEND=on adds the button to the code page).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { classifyFailure } from '../src/classify/classify.js';
import { createMasker } from '../src/secrets/mask.js';
import { msUntilNextWindow, totp } from '../src/secrets/totp.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { CodeProvider, Locator, PortalPolicy, PortalSecrets, Step } from '../src/types.js';
import { LOCAL } from './helpers.js';

// The retry without a send button waits for the next 30-second window: shortened here so the tests do not wait for it.
vi.mock('../src/secrets/totp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/secrets/totp.js')>();
  return { ...real, msUntilNextWindow: vi.fn(() => 50) };
});

const SEED = 'JBSWY3DPEHPK3PXP';
const NO_SEED: PortalSecrets = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password' };
const SEND_CODE: Locator = { role: 'button', name: 'Send me the code' };

/** A six-digit code the sandbox rejects: not the code of the current window or either neighbour. */
function wrongCode(): string {
  const now = Date.now();
  const valid = new Set([-1, 0, 1].map((w) => totp(SEED, now + w * 30_000)));
  for (let n = 100000; ; n++) if (!valid.has(String(n))) return String(n);
}

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session | undefined;
beforeAll(async () => { portal = await startPortal({ sap: 'realistic', sapLogin: 'sso2' }); });
afterAll(async () => { await portal.close(); });
beforeEach(() => {
  portal.reset();
  process.env.IDP_KMSI = 'off';
  process.env.IDP_FACTOR = 'send';
  vi.mocked(msUntilNextWindow).mockClear();
});
afterEach(async () => {
  for (const k of ['IDP_KMSI', 'IDP_FACTOR', 'IDP_RESEND']) delete process.env[k];
  await session?.close();
  session = undefined;
});

const policy = (): PortalPolicy => ({
  startUrl: `${portal.url}${SANDBOX.erp.webguiPath}`,
  navHosts: [portal.host],
  subresourceHosts: [],
  login: ['/idp/login', '/idp/password', '/idp/sendcode', '/idp/mfa', '/sap/saml2/acs'].map((path) => ({ host: portal.host, path })),
  allowedSubmits: [],
  allowPrivateNetwork: true,
});

const SIGN_IN: Step = {
  intent: 'Sign in with a code from the mail',
  signIn: {
    username: { label: 'Email' },
    next: { role: 'button', name: 'Next' },
    password: { label: 'Password' },
    submit: { role: 'button', name: 'Sign in' },
    totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' }, source: 'workflow', via: [SEND_CODE] },
  },
};
const LANDED: Step = { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: { role: 'button', name: 'Line Item Report' } } } };

/** The run at the sign-in, with the POST paths it makes and the page-clock times of each "Send me the code" click. */
async function atLogin(provider: CodeProvider): Promise<{ ctx: StepContext; posts: string[]; sends: number[] }> {
  session = await openSession({ endpoint: LOCAL, policy: policy(), masker: createMasker([]) });
  const posts: string[] = [];
  const sends: number[] = [];
  session.page.on('request', (rq) => { if (rq.method() === 'POST') posts.push(new URL(rq.url()).pathname); });
  await session.page.exposeFunction('__sent', (when: number) => { sends.push(when); });
  await session.page.addInitScript(() => {
    document.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button')?.textContent?.includes('Send me the code')) void (window as unknown as { __sent: (w: number) => void }).__sent(Date.now());
    }, true);
  });
  await session.page.goto(`${portal.url}${SANDBOX.erp.webguiPath}`);
  const ctx: StepContext = {
    page: session.page, script: { startUrl: policy().startUrl, steps: [], interrupts: [] }, policy: policy(), secrets: NO_SEED, vars: {},
    masker: createMasker([NO_SEED.username, NO_SEED.password]), defaultTimeoutMs: 5000, violations: session.violations, codeProvider: provider,
  };
  return { ctx, posts, sends };
}

describe('the retry after a rejected workflow code, with totp.via', () => {
  it('email style: clicks "Send me the code" again on the code page, re-stamps requestedAt right before it and asks again', async () => {
    process.env.IDP_RESEND = 'on';
    const wrong = wrongCode();
    let calls = 0;
    const provider = vi.fn<CodeProvider>(async () => (++calls === 1 ? wrong : totp(SEED)));
    const { ctx, posts, sends } = await atLogin(provider);
    const r = await runSteps(ctx, [SIGN_IN, LANDED]);
    if (!r.ok) throw new Error(r.failure.message);
    expect(r.state.detected.afterLogin).toBe('logged_in');
    expect(provider).toHaveBeenCalledTimes(2);
    const [first, second] = provider.mock.calls.map(([req]) => Date.parse(req.requestedAt));
    // Each ask's requestedAt is no later than the click that sent its code, and the second is after the first send.
    expect(sends).toHaveLength(2);
    expect(first).toBeLessThanOrEqual(sends[0]);
    expect(second).toBeGreaterThan(sends[0]);
    expect(second).toBeLessThanOrEqual(sends[1]);
    expect(posts).toEqual(['/idp/login', '/idp/password', '/idp/sendcode', '/idp/mfa', '/idp/sendcode', '/idp/mfa', '/sap/saml2/acs']);
    // A new code was sent: no wait for the next code window.
    expect(msUntilNextWindow).not.toHaveBeenCalled();
    expect(ctx.violations).toEqual([]);
    expect(ctx.masker.mask(wrong)).toBe('[secret]');
  });

  it('email style: a second rejection still stops as auth_blocked after two asks and two sends', async () => {
    process.env.IDP_RESEND = 'on';
    const provider = vi.fn<CodeProvider>(async () => wrongCode());
    const { ctx, posts, sends } = await atLogin(provider);
    const r = await runSteps(ctx, [SIGN_IN, LANDED]);
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe('detected:mfa_code: the site rejected the one-time code from the workflow twice');
    expect(classifyFailure({ violations: [], failure: r.failure })).toBe('auth_blocked');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(sends).toHaveLength(2);
    expect(posts).toEqual(['/idp/login', '/idp/password', '/idp/sendcode', '/idp/mfa', '/idp/sendcode', '/idp/mfa']);
  });

  it('no send button on the code page (a TOTP from an app): waits for the next code window, same requestedAt, nothing clicked', async () => {
    const wrong = wrongCode();
    let calls = 0;
    const provider = vi.fn<CodeProvider>(async () => (++calls === 1 ? wrong : totp(SEED)));
    const { ctx, posts, sends } = await atLogin(provider);
    const r = await runSteps(ctx, [SIGN_IN, LANDED]);
    if (!r.ok) throw new Error(r.failure.message);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1][0].requestedAt).toBe(provider.mock.calls[0][0].requestedAt);
    expect(msUntilNextWindow).toHaveBeenCalled();
    expect(sends).toHaveLength(1);
    expect(posts).toEqual(['/idp/login', '/idp/password', '/idp/sendcode', '/idp/mfa', '/idp/mfa', '/sap/saml2/acs']);
  });
});
