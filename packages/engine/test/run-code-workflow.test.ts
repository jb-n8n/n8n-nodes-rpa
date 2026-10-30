// signIn with totp.source 'workflow': the one-time code comes from the run's codeProvider (an n8n sub-workflow in the
// node), not from a TOTP secret. Run against the sandbox's authenticator-app sign-in.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { classifyFailure } from '../src/classify/classify.js';
import { runTask } from '../src/lane/task.js';
import { CODE_WORKFLOW_NOT_SET } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { msUntilNextWindow, totp } from '../src/secrets/totp.js';
import { parseScript } from '../src/steps/parse.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { CodeProvider, PortalSecrets, Script, Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS, SIGN_IN_STEPS, signedLaneInput } from './helpers.js';
import { bound } from './timing.js';

// The retry after a rejected code waits for the next 30-second window: shortened here so the tests do not wait for it.
vi.mock('../src/secrets/totp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/secrets/totp.js')>();
  return { ...real, msUntilNextWindow: vi.fn(() => 50) };
});

const SEED = SECRETS.totpSecret!;
/** The Site Login without a TOTP secret: the code can only come from the provider. */
const NO_SEED: PortalSecrets = { username: SECRETS.username, password: SECRETS.password };

const withSource = (steps: Step[], source: 'seed' | 'workflow'): Step[] => {
  const out = structuredClone(steps);
  const first = out[0];
  if ('signIn' in first && first.signIn.totp) first.signIn.totp.source = source;
  return out;
};
const WORKFLOW_STEPS = withSource(SIGN_IN_STEPS, 'workflow');

/** A six-digit code the sandbox rejects: not the code of the current window or either neighbour. */
function wrongCode(): string {
  const now = Date.now();
  const valid = new Set([-1, 0, 1].map((w) => totp(SEED, now + w * 30_000)));
  for (let n = 100000; ; n++) if (!valid.has(String(n))) return String(n);
}

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); portal.setState({ mfa: 'totp' }); vi.mocked(msUntilNextWindow).mockClear(); });

async function atLogin(over: Partial<StepContext> = {}): Promise<StepContext> {
  const script = baselineScript(portal.url);
  session = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker: createMasker([]) });
  await session.page.goto(`${portal.url}/acme/login`);
  return {
    page: session.page, script: { ...script, interrupts: [] }, policy: policyFor(portal), secrets: NO_SEED, vars: {},
    masker: createMasker([NO_SEED.username, NO_SEED.password]), defaultTimeoutMs: 3000, violations: session.violations, ...over,
  };
}

describe('parse: signIn totp.source', () => {
  const doc = (source: unknown): unknown => ({ startUrl: 'https://example.com/login', steps: [{ ...WORKFLOW_STEPS[0], signIn: { ...(WORKFLOW_STEPS[0] as { signIn: object }).signIn, totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' }, source } } }] });
  it('accepts "seed" and "workflow" and keeps the value', () => {
    for (const source of ['seed', 'workflow'] as const) {
      const s = parseScript(doc(source)).steps[0];
      expect('signIn' in s && s.signIn.totp?.source).toBe(source);
    }
  });
  it('refuses any other value', () => {
    expect(() => parseScript(doc('sms'))).toThrow(/totp\.source must be "seed" or "workflow"/);
  });
});

describe('signIn with a code from the workflow', () => {
  it('calls the provider once, when the code field shows, and signs in with its code', async () => {
    const seen: { requestedAt: string; fieldVisible: boolean }[] = [];
    const ctx = await atLogin();
    ctx.codeProvider = async (req) => {
      seen.push({ requestedAt: req.requestedAt, fieldVisible: await ctx.page.locator('#otp').isVisible() });
      return totp(SEED);
    };
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      expect(r.ok).toBe(true);
      expect(r.state.detected.afterLogin).toBe('logged_in');
      expect(seen).toHaveLength(1);
      expect(seen[0].fieldVisible).toBe(true);
      expect(new Date(seen[0].requestedAt).toISOString()).toBe(seen[0].requestedAt);
    } finally { await session.close(); }
  });

  it('never calls the provider when the site asks for no code', async () => {
    portal.setState({ mfa: 'none' });
    const provider = vi.fn<CodeProvider>(async () => totp(SEED));
    const ctx = await atLogin({ codeProvider: provider });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      expect(r.ok).toBe(true);
      expect(provider).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });

  it('strips spaces from the code', async () => {
    const ctx = await atLogin({ codeProvider: async () => totp(SEED).replace(/^(\d{3})/, '$1 ') });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      expect(r.ok).toBe(true);
    } finally { await session.close(); }
  });

  it('adds the code to the run masker before it is typed and submitted', async () => {
    let code = '';
    const order: string[] = [];
    const ctx = await atLogin({ codeProvider: async () => { code = totp(SEED); return code; } });
    const add = ctx.masker.add.bind(ctx.masker);
    ctx.masker.add = (values, opts) => { if (values.includes(code)) order.push('masked'); add(values, opts); };
    ctx.page.on('request', (rq) => { if (rq.method() === 'POST' && rq.url().endsWith('/acme/mfa')) order.push('submitted'); });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      expect(r.ok).toBe(true);
      expect(order).toEqual(['masked', 'submitted']);
      expect(ctx.masker.mask(`code ${code} typed`)).toBe('code [secret] typed');
      expect(JSON.stringify(r.state.log)).not.toContain(code);
    } finally { await session.close(); }
  });

  it('a provider that does not answer in time stops the sign-in as auth_blocked, nothing typed', async () => {
    const ctx = await atLogin({ codeProvider: () => new Promise<string>(() => undefined), codeTimeoutMs: 300 });
    try {
      const t0 = Date.now();
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('detected:mfa_code: the one-time code workflow did not return a code within 0.3 s');
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('auth_blocked');
      expect(Date.now() - t0).toBeLessThan(bound(5000));
      expect(await ctx.page.locator('#otp').inputValue()).toBe('');
    } finally { await session.close(); }
  });

  it('a value that is not 6 to 10 digits is refused and never typed', async () => {
    for (const bad of ['abc123', '12345', '12345678901', '', '12-34-56']) {
      portal.reset();
      portal.setState({ mfa: 'totp' });
      const ctx = await atLogin({ codeProvider: async () => bad });
      try {
        const r = await runSteps(ctx, WORKFLOW_STEPS);
        if (r.ok) throw new Error(`expected failure for "${bad}"`);
        expect(r.failure.message).toBe('detected:mfa_code: the one-time code workflow did not return a code of 6 to 10 digits');
        expect(await ctx.page.locator('#otp').inputValue()).toBe('');
      } finally { await session.close(); }
    }
  });

  it('a provider that throws stops the sign-in as auth_blocked with its message', async () => {
    const ctx = await atLogin({ codeProvider: async () => { throw new Error('the workflow returned 2 items'); } });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('detected:mfa_code: the one-time code workflow failed: the workflow returned 2 items');
    } finally { await session.close(); }
  });

  it('a rejected code: waits for the next code window and asks the provider once more', async () => {
    const wrong = wrongCode();
    let calls = 0;
    const provider = vi.fn<CodeProvider>(async () => (++calls === 1 ? wrong : totp(SEED)));
    const ctx = await atLogin({ codeProvider: provider });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      expect(r.ok).toBe(true);
      expect(provider).toHaveBeenCalledTimes(2);
      // The retry requests no new code (nothing is clicked to send one): the second call gets the first call's requestedAt.
      expect(provider.mock.calls[1][0].requestedAt).toBe(provider.mock.calls[0][0].requestedAt);
      expect(msUntilNextWindow).toHaveBeenCalled();
      expect(ctx.masker.mask(wrong)).toBe('[secret]');
    } finally { await session.close(); }
  });

  it('a code rejected twice stops as auth_blocked after exactly two provider calls', async () => {
    const provider = vi.fn<CodeProvider>(async () => wrongCode());
    const ctx = await atLogin({ codeProvider: provider });
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(provider).toHaveBeenCalledTimes(2);
      expect(r.failure.message).toBe('detected:mfa_code: the site rejected the one-time code from the workflow twice');
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('auth_blocked');
    } finally { await session.close(); }
  });

  it('no provider at the code field is auth_blocked naming the missing option, not drift', async () => {
    const ctx = await atLogin();
    try {
      const r = await runSteps(ctx, WORKFLOW_STEPS);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(`detected:mfa_code: ${CODE_WORKFLOW_NOT_SET}`);
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('auth_blocked');
    } finally { await session.close(); }
  });

  it('source "seed" (and no source) keeps the TOTP secret path and never calls the provider', async () => {
    const provider = vi.fn<CodeProvider>(async () => wrongCode());
    for (const steps of [withSource(SIGN_IN_STEPS, 'seed'), SIGN_IN_STEPS]) {
      portal.reset();
      portal.setState({ mfa: 'totp' });
      const ctx = await atLogin({ secrets: SECRETS, codeProvider: provider });
      try {
        const r = await runSteps(ctx, steps);
        expect(r.ok).toBe(true);
      } finally { await session.close(); }
    }
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('runTask with a code from the workflow', () => {
  const script = (): Script => ({ ...baselineScript(portal.url), steps: [...WORKFLOW_STEPS, ...baselineScript(portal.url).steps.slice(SIGN_IN_STEPS.length)] });
  const input = (over: object = {}) => signedLaneInput(script(), {
    policy: policyFor(portal), secrets: NO_SEED, endpoint: LOCAL, defaultStepTimeoutMs: 3000,
    output: { idPattern: 'N26-\\d{4}' }, ...over,
  });

  it('passes the codeProvider through to the sign-in; the code never shows in the result', async () => {
    let code = '';
    const r = await runTask(input({ codeProvider: async () => { code = totp(SEED); return code; } }));
    expect(r.ok).toBe(true);
    expect(code).toMatch(/^\d{6}$/);
    const { trace: _trace, ...rest } = r as { trace?: Buffer };
    expect(JSON.stringify(rest)).not.toContain(code);
  });

  it('steps that take the code from a workflow, without a provider: a configuration error before any browser opens', async () => {
    const t0 = Date.now();
    const r = await runTask(input({ endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/never' } }));
    if (r.ok) throw new Error('expected failure');
    expect(r).toMatchObject({ code: 'policy_violation', configError: true, message: CODE_WORKFLOW_NOT_SET, lane: 'script' });
    expect(Date.now() - t0).toBeLessThan(bound(1000));
  });
});
