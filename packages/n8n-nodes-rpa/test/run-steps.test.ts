import { afterEach, describe, expect, it } from 'vitest';
import { NodeHelpers, NodeOperationError, type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import { isEmptySteps, proposalDigest, scriptHash, type Proposal, type Script } from 'n8n-rpa-engine';
import { ConfigError } from '../nodes/Playwright/config.js';
import { memoryGuardStore, type GuardStore } from '../nodes/Playwright/guard-store.js';
import { BREAKER_KEY, resetGuardsForTests, siteLoginKey } from '../nodes/Playwright/guard.js';
import { executeRunSteps, parseStepsParam, readRunStepsParams } from '../nodes/Playwright/operations/runSteps.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { agentOk, fakeEngine, scriptOk, taskFail } from './fake-engine.js';
import { harness, type HarnessOptions } from './harness.js';

afterEach(() => resetGuardsForTests());

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
const KEY = 'run-steps-signing-key-0123456789abcdef';
const TOKEN = 'tok-5d8e3a71';
const USER = 'site-user-7c1';
const PASS = 'site-pass-9f2';
const APPROVER = 'approver@example.com';
const SIGNATURE = 'ab'.repeat(32);
const GOAL = 'Read every item; IDs look like SKU-1001.';
const BROWSER = { mode: 'playwright', wsUrl: 'wss://browser.example.net/pw', token: TOKEN };
const SITE_LOGIN = { loginUrl: 'https://example.com/login', username: USER, password: PASS };
const BROWSER_ONLY = { playwrightBrowserApi: BROWSER };
const ALL = { playwrightBrowserApi: BROWSER, playwrightSiteLoginApi: SITE_LOGIN, playwrightScriptSigningApi: { secretKey: KEY } };
const IDS = { playwrightBrowserApi: 'browser-1', playwrightSiteLoginApi: 'site-a', playwrightScriptSigningApi: 'sign-1' };
const STEPS: Script = {
  name: 'items', version: 3, startUrl: 'https://example.com/list',
  steps: [
    { intent: 'Open the list', goto: 'https://example.com/list' },
    { intent: 'Read the items', extract: { scope: { css: 'main' }, idPattern: 'SKU-\\d{4}' } },
  ],
};
const PROPOSAL: Proposal = {
  name: 'items', baseVersion: 3, version: 4, steps: { ...STEPS, version: 4 }, hash: 'd4'.repeat(32),
  evidence: { count: 3, total: 3, diff: { missing: [], extra: [] } }, changes: [{ was: 'Read the items', now: 'Read the product list' }],
  // The engine flags only what is new compared with the base: nothing, on an unchanged host. Run Steps lists every host.
  safetyFlags: [], screenshots: { before: Buffer.from('before'), after: Buffer.from('after') }, trace: Buffer.from('trace'),
};
const STUB_MODEL = { bindTools: () => ({ invoke: async () => ({ content: 'done', tool_calls: [] }) }) };
const NO_MODEL = 'AI repair is on but no chat model is connected. Connect one to the Model input.';

function params(over: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'runSteps', steps: STEPS, startUrl: '', requireSignedSteps: true, signature: SIGNATURE, approvedBy: APPROVER, aiRepair: false, goal: '',
    options: { saveTrace: 'never', ...options }, ...over,
  };
}
const unsigned = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  params({ requireSignedSteps: false, signature: '', approvedBy: '', startUrl: 'https://example.com/list', ...over }, options);
const repairParams = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  params({ aiRepair: true, goal: GOAL, ...over }, { name: 'items', idPattern: 'SKU-\\d{4}', ...options });
const ctx = (over: Partial<HarnessOptions> = {}) => harness({ params: params(), credentials: ALL, credentialIds: IDS, ...over });
const errorOf = (item: INodeExecutionData) => item.json.error as string | undefined;
const details = (item: INodeExecutionData) => item.json.details as IDataObject;
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ json: { i } }));

const REDIS_CRED = { host: 'redis.internal', port: 6380, password: 'redis-pass-1' };
const QUEUE_NEEDS_REDIS =
  "n8n runs in queue mode, so Run Steps and Import Steps with an RPA Site Login need an RPA Redis credential: without it the login breaker and run lock would not be shared between workers. Attach an RPA Redis credential (the Redis that n8n's queue uses works).";

describe('Run Steps: the guard store (Redis, queue mode)', () => {
  it('queue mode without Redis is a configuration error, before the browser', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true }), engine, { executionsMode: 'queue' });
    expect(errorOf(data[0])).toBe(QUEUE_NEEDS_REDIS);
    expect(details(data[0])).toMatchObject({ configError: true });
    expect(engine.calls).toHaveLength(0);
  });
  it('queue mode without a Site Login needs no Redis', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: unsigned(), credentials: BROWSER_ONLY }), engine, { executionsMode: 'queue' });
    expect(engine.calls).toHaveLength(1);
  });
  it("without queue mode and without Redis, the memory store is used (a held lock still turns the run away)", async () => {
    await memoryGuardStore().acquireLock(siteLoginKey('site-a'), 60_000);
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true }), engine, { executionsMode: 'regular' });
    expect(errorOf(data[0])).toBe('busy: another run using this Site Login is in progress');
    expect(engine.calls).toHaveLength(0);
  });
  it('with a Redis credential, each item opens its own store from the credential and closes it', async () => {
    const opened: unknown[] = [];
    const closed: number[] = [];
    const redis = async (credentials: unknown): Promise<GuardStore> => {
      opened.push(credentials);
      const n = opened.length;
      return { ...memoryGuardStore(), close: async () => { closed.push(n); } };
    };
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(
      ctx({ items: many(2), credentials: { ...ALL, playwrightRedisApi: REDIS_CRED }, credentialIds: { ...IDS, playwrightRedisApi: 'redis-1' } }), engine, { redis, executionsMode: 'queue' },
    );
    expect(opened).toEqual([REDIS_CRED, REDIS_CRED]);
    expect(closed).toEqual([1, 2]);
    expect(engine.calls).toHaveLength(2);
  });
  it('an unreachable Redis is a configuration error and no login is tried', async () => {
    const redis = async (): Promise<GuardStore> => { throw new ConfigError('The Redis server could not be reached (ECONNREFUSED), so no login was tried.'); };
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(
      ctx({ credentials: { ...ALL, playwrightRedisApi: REDIS_CRED }, credentialIds: { ...IDS, playwrightRedisApi: 'redis-1' }, continueOnFail: true }), engine, { redis },
    );
    expect(errorOf(data[0])).toBe('The Redis server could not be reached (ECONNREFUSED), so no login was tried.');
    expect(engine.calls).toHaveLength(0);
  });
  it('a Redis command that fails mid-run is the item error, not an unhandled rejection', async () => {
    const store: GuardStore = { ...memoryGuardStore(), acquireLock: () => Promise.reject(new Error('The client is closed')) };
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(
      ctx({ credentials: { ...ALL, playwrightRedisApi: REDIS_CRED }, credentialIds: { ...IDS, playwrightRedisApi: 'redis-1' }, continueOnFail: true }), engine, { redis: async () => store },
    );
    expect(errorOf(data[0])).toContain('The client is closed');
    expect(engine.calls).toHaveLength(0);
  });
});

describe('Run Steps: trust and engine input', () => {
  it('a signed run requires the signature and binds name, version and the Site Login id', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: params({}, { name: 'items', expectedVersion: 3 }) }), engine);
    const input = engine.calls[0];
    expect(input.trust).toEqual({
      required: true, signature: SIGNATURE, approvedBy: APPROVER, key: KEY, allowUnsignedWrites: false,
      expect: { name: 'items', version: 3, siteLoginId: 'site-a' },
    });
    expect(input.script).toEqual(STEPS);
    expect(input.secrets).toEqual({ username: USER, password: PASS });
    expect(input.policy).toMatchObject({ startUrl: 'https://example.com/login', navHosts: ['example.com'], writeMode: 'fatal', allowPrivateNetwork: false });
    expect(input.endpoint).toEqual(BROWSER);
    expect(input.repair).toBeUndefined();
    expect(input).toMatchObject({ budgetMs: 180_000, defaultStepTimeoutMs: 30_000, viewport: { width: 1280, height: 800 }, saveTrace: 'never', vars: {} });
  });
  it('an unsigned run without a Site Login uses the Start URL allowlist, no secrets and no output checks', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: unsigned(), credentials: BROWSER_ONLY }), engine);
    const input = engine.calls[0];
    expect(input.trust).toEqual({ required: false, signature: '', approvedBy: '', allowUnsignedWrites: false, expect: {} });
    expect(input.secrets).toBeUndefined();
    expect(input.output).toBeUndefined();
    expect(input.policy).toMatchObject({ startUrl: 'https://example.com/list', navHosts: ['example.com'], subresourceHosts: '*', writeMode: 'block', allowPrivateNetwork: false });
  });
  it('passes Allow Unsigned Writes, Variables, the output checks and the limits', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({
      credentials: BROWSER_ONLY,
      params: unsigned({}, {
        allowUnsignedWrites: true, variables: { values: [{ name: 'from', value: '2026-01-01' }] }, idPattern: 'SKU-\\d{4}',
        totalPattern: 'Showing (\\d+) results', requiredFields: 'title, price', emptyPattern: 'No results found',
        timeout: 5, maxSeconds: 999, viewport: { size: { width: 1024, height: 700 } }, saveTrace: 'always',
      }),
    }), engine);
    expect(engine.calls[0]).toMatchObject({
      trust: { allowUnsignedWrites: true }, vars: { from: '2026-01-01' },
      output: { idPattern: 'SKU-\\d{4}', totalPattern: 'Showing (\\d+) results', requiredFields: ['title', 'price'], emptyPattern: 'No results found' },
      defaultStepTimeoutMs: 5000, budgetMs: 300_000, viewport: { width: 1024, height: 700 }, saveTrace: 'always',
    });
  });
  it('clamps the viewport to the bounds the UI allows: width 320–3840, height 240–2160', () => {
    const viewport = (size: Record<string, unknown>) => readRunStepsParams(ctx({ params: params({}, { viewport: { size } }) }), 0).common.viewport;
    expect(viewport({ width: 200, height: 200 })).toEqual({ width: 320, height: 240 });
    expect(viewport({ width: 4000, height: 4000 })).toEqual({ width: 3840, height: 2160 });
    expect(viewport({ width: 320, height: 2160 })).toEqual({ width: 320, height: 2160 });
    expect(viewport({ width: 'wide', height: null })).toEqual({ width: 1280, height: 800 });
  });
  it('reads the documented defaults', () => {
    const p = readRunStepsParams(ctx(), 0);
    expect(p).toMatchObject({
      requireSignedSteps: true, aiRepair: false, allowUnsignedWrites: false, deliverUnconfirmed: false, maxActions: 40, maxTokens: 200_000,
      breakerResetKey: '', name: '', vars: {},
      common: { timeoutMs: 30_000, maxSeconds: 180, viewport: { width: 1280, height: 800 }, allowedHosts: [], allowPrivateNetwork: false, saveTrace: 'never' },
    });
    expect(p.output).toBeUndefined();
    expect(p.expectedVersion).toBeUndefined();
  });
  it('Steps as JSON text or as an object reach the engine as the same document; text is parsed once', async () => {
    const engine = fakeEngine(() => scriptOk());
    for (const steps of [STEPS, JSON.stringify(STEPS), JSON.stringify(JSON.stringify(STEPS))]) await executeRunSteps(ctx({ params: params({ steps }) }), engine);
    expect(engine.calls[0].script).toEqual(STEPS);
    expect(engine.calls[1].script).toEqual(STEPS);
    expect(engine.calls[2].script).toBe(JSON.stringify(STEPS));
  });
  it('invalid JSON in Steps is a configuration error and nothing runs', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ params: params({ steps: '{ "steps": [' }), continueOnFail: true }), engine);
    expect(errorOf(data[0])).toMatch(/^Steps is not valid JSON: /);
    expect(details(data[0])).toMatchObject({ configError: true, code: null });
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
    await expect(executeRunSteps(ctx({ params: params({ steps: '{ "steps": [' }) }), engine)).rejects.toThrow(/^Steps is not valid JSON: /);
    expect(engine.calls).toHaveLength(0);
  });
  it('an invalid or overlong ID Pattern is a configuration error', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [bad] = await executeRunSteps(ctx({ continueOnFail: true, params: params({}, { idPattern: 'SKU-(' }) }), engine);
    expect(errorOf(bad[0])).toMatch(/^ID Pattern is not a valid regular expression: .+\. Example: INV-\\d\{4\}\.$/);
    const [long] = await executeRunSteps(ctx({ continueOnFail: true, params: params({}, { idPattern: 'a'.repeat(501) }) }), engine);
    expect(errorOf(long[0])).toBe('ID Pattern is longer than 500 characters.');
    expect(engine.calls).toHaveLength(0);
  });
  it('a Signature without a Step Signing credential reaches the engine with no key, and the engine refuses it', async () => {
    const engine = fakeEngine(() => taskFail('script_untrusted', 'a signature is present but no Step Signing credential is attached'));
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, credentials: { playwrightBrowserApi: BROWSER, playwrightSiteLoginApi: SITE_LOGIN } }), engine);
    expect('key' in engine.calls[0].trust).toBe(false);
    expect(engine.calls[0].trust.signature).toBe(SIGNATURE);
    expect(errorOf(data[0])).toBe('script_untrusted: a signature is present but no Step Signing credential is attached');
    expect(details(data[0])).toMatchObject({ code: 'script_untrusted', name: 'items', version: 3, hash: scriptHash(STEPS) });
  });
});

describe('Run Steps: where the allowlist comes from', () => {
  it('no Start URL and no Site Login is a configuration error', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, credentials: BROWSER_ONLY, params: unsigned({ startUrl: '' }) }), engine);
    expect(errorOf(data[0])).toBe('Run Steps needs a Start URL or a Site Login');
    expect(details(data[0]).configError).toBe(true);
    expect(engine.calls).toHaveLength(0);
  });
  it('a file: Start URL fails policy_violation with the golden message', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, credentials: BROWSER_ONLY, params: unsigned({ startUrl: 'file:///etc/passwd' }) }), engine);
    expect(errorOf(data[0])).toBe('policy_violation: URL must start with http:// or https:// (got "file:").');
    expect(details(data[0]).configError).toBeUndefined();
    expect(details(data[0]).code).toBe('policy_violation');
    expect(engine.calls).toHaveLength(0);
  });
  it('Also Allow These Sites with a Site Login is a configuration error', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, params: params({}, { allowedHosts: 'cdn.example.com' }) }), engine);
    expect(errorOf(data[0])).toBe('Also Allow These Sites must be empty when a Site Login is attached: the Site Login credential sets the allowed sites.');
    expect(engine.calls).toHaveLength(0);
  });
});

describe('Data Table values with the wrong types', () => {
  it('Expected Version "3" is 3; "3.5", "abc" and 3.5 are configuration errors; empty is unset', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: params({}, { expectedVersion: '3' }) }), engine);
    expect(engine.calls[0].trust.expect?.version).toBe(3);
    await executeRunSteps(ctx({ params: params({}, { expectedVersion: '' }) }), engine);
    expect(engine.calls[1].trust.expect?.version).toBeUndefined();
    for (const bad of ['3.5', 'abc', 3.5]) {
      const [data] = await executeRunSteps(ctx({ params: params({}, { expectedVersion: bad }), continueOnFail: true }), engine);
      expect(errorOf(data[0])).toBe('Expected Version must be a whole number');
    }
    expect(engine.calls).toHaveLength(2);
  });
  it('Expected Version accepts digits only: " 7 " and 0 are whole numbers; "0x3", "1e0", "-1", -1 and true are not', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: params({}, { expectedVersion: ' 7 ' }) }), engine);
    await executeRunSteps(ctx({ params: params({}, { expectedVersion: 0 }) }), engine);
    expect(engine.calls.map((c) => c.trust.expect?.version)).toEqual([7, 0]);
    for (const bad of ['0x3', '1e0', '-1', -1, true]) {
      const [data] = await executeRunSteps(ctx({ params: params({}, { expectedVersion: bad }), continueOnFail: true }), engine);
      expect({ bad, error: errorOf(data[0]) }).toEqual({ bad, error: 'Expected Version must be a whole number' });
    }
    expect(engine.calls).toHaveLength(2);
  });
  it('a null or undefined Signature is absent', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: params({ signature: null, approvedBy: null }) }), engine);
    await executeRunSteps(ctx({ params: params({ signature: undefined }) }), engine);
    expect(engine.calls.map((c) => c.trust.signature)).toEqual(['', '']);
    expect(engine.calls[0].trust.approvedBy).toBe('');
  });
  it('a numeric Signature reaches the engine as text', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ params: params({ signature: 12345 }) }), engine);
    expect(engine.calls[0].trust.signature).toBe('12345');
  });
  it('the bootstrap item {} resolves Steps to "": a first run with AI Repair, a configuration error without', async () => {
    // Steps = {{ $('Get active steps').item.json.steps ?? '' }} on the {} item that alwaysOutputData produces.
    const engine = fakeEngine(() => agentOk());
    const first = { steps: '', signature: '', approvedBy: '' };
    await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams(first) }), engine);
    expect(engine.calls[0].script).toBeNull();
    expect(engine.calls[0].repair).toMatchObject({ goal: GOAL, name: 'items', alreadyRan: false, deliverUnconfirmed: false, agentBudget: { maxActions: 40, maxTokens: 200_000 } });
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, params: params(first) }), engine);
    expect(errorOf(data[0])).toBe('Steps is empty. Add steps, or turn on AI Repair to build them from the Goal.');
    expect(engine.calls).toHaveLength(1);
  });
  it('agrees with the engine on what counts as empty steps', () => {
    const step = { intent: 'Open the list', goto: 'https://example.com/list' };
    for (const v of [undefined, null, '', '   ', [], { steps: [] }, { name: 'x', steps: [] }, {}, { steps: [step] }, [step]]) {
      expect({ v, empty: parseStepsParam(v).kind === 'empty' }).toEqual({ v, empty: isEmptySteps(v) });
    }
    expect(parseStepsParam('[]').kind).toBe('empty');
    expect(parseStepsParam('{"steps":[]}').kind).toBe('empty');
    expect(parseStepsParam('{}')).toEqual({ kind: 'steps', raw: {} });
  });
});

describe('literal-only switches set by expressions', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['Require Signed Steps', { requireSignedSteps: '={{ $json.signed }}' }],
    ['Allow Private Network', { options: { allowPrivateNetwork: '={{ $json.private }}' } }],
    ['Allow Unsigned Writes', { options: { allowUnsignedWrites: '={{ true }}' } }],
    ['Deliver Unconfirmed Rows', { options: { deliverUnconfirmed: '={{ true }}' } }],
  ];
  for (const [label, raw] of cases) {
    it(`${label} set with an expression is a configuration error before any run`, async () => {
      const engine = fakeEngine(() => scriptOk());
      const resolved = params();
      const rawParameters = { ...resolved, ...raw, options: { ...(resolved.options as IDataObject), ...((raw.options as IDataObject | undefined) ?? {}) } };
      const [data] = await executeRunSteps(ctx({ rawParameters, continueOnFail: true }), engine);
      expect(errorOf(data[0])).toBe(`${label} must be set directly, not with an expression.`);
      expect(details(data[0]).configError).toBe(true);
      expect(engine.calls).toHaveLength(0);
    });
  }
});

describe('literal-only switches as real n8n saves them: noDataExpression strips the "="', () => {
  // n8n 2.41 (node-helpers getNodeParameters) slices the leading "=" off an expression in a noDataExpression parameter,
  // so "={{ true }}" reaches the node raw as "{{ true }}". A literal switch is a boolean: any string is refused.
  const cases: [string, Record<string, unknown>][] = [
    ['Require Signed Steps', { requireSignedSteps: '{{ false }}' }],
    ['Allow Private Network', { options: { allowPrivateNetwork: '{{ true }}' } }],
    ['Allow Unsigned Writes', { options: { allowUnsignedWrites: '{{ true }}' } }],
    ['Deliver Unconfirmed Rows', { options: { deliverUnconfirmed: '{{ true }}' } }],
  ];
  for (const [label, raw] of cases) {
    it(`${label} saved as the stripped form "{{ … }}" is a configuration error before any run`, async () => {
      const engine = fakeEngine(() => scriptOk());
      const resolved = params();
      const rawParameters = { ...resolved, ...raw, options: { ...(resolved.options as IDataObject), ...((raw.options as IDataObject | undefined) ?? {}) } };
      const [data] = await executeRunSteps(ctx({ params: rawParameters, rawParameters, continueOnFail: true }), engine);
      expect(errorOf(data[0])).toBe(`${label} must be set directly, not with an expression.`);
      expect(details(data[0]).configError).toBe(true);
      expect(engine.calls).toHaveLength(0);
    });
  }
  it('a literal boolean, or the switch left unset, still runs', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ params: params({}, { allowPrivateNetwork: false, allowUnsignedWrites: true }), continueOnFail: true }), engine);
    expect(errorOf(data[0])).toBeUndefined();
    expect(engine.calls).toHaveLength(1);
  });
});

describe('literal-only switches under an expression-valued Options collection', () => {
  it('Options set by one expression is refused: n8n would read each switch under it as its default and silently ignore the expression', async () => {
    const engine = fakeEngine(() => scriptOk());
    const resolved = params({}, { allowUnsignedWrites: true });
    const rawParameters = { ...resolved, options: '={{ { allowUnsignedWrites: true, saveTrace: "never" } }}' };
    const h = ctx({ params: resolved, rawParameters, continueOnFail: true });
    // The harness reads paths as n8n 2.41 does (lodash get on the raw parameters): nothing under an expression string.
    expect(h.getNodeParameter('options.allowUnsignedWrites', 0, false)).toBe(false);
    expect(h.getNodeParameter('options', 0, {})).toEqual(resolved.options);
    const [data] = await executeRunSteps(h, engine);
    expect(errorOf(data[0])).toBe('Allow Unsigned Writes must be set directly, not with an expression.');
    expect(details(data[0]).configError).toBe(true);
    expect(engine.calls).toHaveLength(0);
  });

  // Regression: a whole-Options expression is dropped by n8n, so every switch under it reads as its default
  it('real n8n (Workflow → getNodeParameters) replaces an expression-valued Options with defaults: the switches fail closed', async () => {
    const raw = { operation: 'runSteps', options: '={{ { allowUnsignedWrites: true, allowPrivateNetwork: true, deliverUnconfirmed: true } }}' };
    const d = new Playwright().description;
    const normalized = NodeHelpers.getNodeParameters(d.properties, raw, true, false, { parameters: raw } as never, d) as IDataObject;
    expect(typeof normalized.options).toBe('object');
    for (const k of ['allowUnsignedWrites', 'allowPrivateNetwork', 'deliverUnconfirmed']) expect((normalized.options as IDataObject)[k]).not.toBe(true);
    // What the node receives runs with every switch at its default (off): nothing the expression asked for is applied.
    const engine = fakeEngine(() => scriptOk());
    const resolved = params();
    const [data] = await executeRunSteps(ctx({ params: { ...resolved, options: normalized.options }, continueOnFail: true }), engine);
    expect(errorOf(data[0])).toBeUndefined();
    expect(engine.calls[0].policy.allowPrivateNetwork).not.toBe(true);
  });
});

describe('breaker and lock: only with a Site Login, keyed by its credential id', () => {
  it('siteLoginKey is site-login:<id>', () => {
    expect(siteLoginKey('abc')).toBe('site-login:abc');
  });
  it('a Site Login credential without an id is a configuration error and never keys "site-login:"', async () => {
    await memoryGuardStore().acquireLock(siteLoginKey(''), 60_000); // were the empty key used, this run would answer busy
    const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
    const h = ctx({ continueOnFail: true, credentialIds: { ...IDS, playwrightSiteLoginApi: '' } });
    const [data] = await executeRunSteps(h, engine);
    expect(errorOf(data[0])).toBe('The RPA Site Login credential has no id. Save the credential, then select it again on this node.');
    expect(details(data[0]).configError).toBe(true);
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
    expect(engine.calls).toHaveLength(0);
    expect(h.staticData[BREAKER_KEY]).toBeUndefined();
  });
  it('without a Site Login there is no lock and no breaker', async () => {
    expect(await memoryGuardStore().acquireLock(siteLoginKey('site-a'), 60_000)).not.toBeNull();
    const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
    const h = ctx({ credentials: BROWSER_ONLY, params: unsigned(), continueOnFail: true });
    await executeRunSteps(h, engine);
    await executeRunSteps(h, engine);
    expect(engine.calls).toHaveLength(2);
    expect(h.staticData[BREAKER_KEY]).toBeUndefined();
  });
  it('a held lock on the Site Login turns the run away as busy, whatever the node name', async () => {
    await memoryGuardStore().acquireLock(siteLoginKey('site-a'), 60_000);
    const engine = fakeEngine(() => scriptOk());
    for (const nodeName of ['Run steps', 'Run steps (copy)']) {
      const [data] = await executeRunSteps(ctx({ nodeName, continueOnFail: true }), engine);
      expect(errorOf(data[0])).toBe('busy: another run using this Site Login is in progress');
    }
    expect(engine.calls).toHaveLength(0);
  });
  it('a login failure on item 1 stops items 2 and 3 with locked_out, and another node on the same credential too', async () => {
    const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
    const h = ctx({ items: many(3), continueOnFail: true });
    const [data] = await executeRunSteps(h, engine);
    expect(engine.calls).toHaveLength(1);
    expect(data.map(errorOf)).toEqual([
      'login_failed: the site rejected the sign-in',
      'locked_out: A previous login for example.com failed, so no login was tried.',
      'locked_out: A previous login for example.com failed, so no login was tried.',
    ]);
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }], [{ item: 2 }]]);
    expect(Object.keys(h.staticData[BREAKER_KEY] as IDataObject)).toEqual(['site-login:site-a']);
    const [other] = await executeRunSteps(ctx({ nodeName: 'Another node', staticData: {}, continueOnFail: true }), engine);
    expect(errorOf(other[0])).toBe('locked_out: A previous login for example.com failed, so no login was tried.');
    expect(engine.calls).toHaveLength(1);
  });
});

describe('Login Breaker Reset Key is literal-only and cannot reset the breaker item by item', () => {
  const LOCKED = 'locked_out: A previous login for example.com failed, so no login was tried.';
  const EXPRESSION = 'Login Breaker Reset Key must be set directly, not with an expression.';
  // Each item resolves its own key, as {{ $json.id }} would: before the fix every new key reset the breaker.
  const perItem = (i: number) => params({}, { breakerResetKey: `id-${i}` });
  const rawCases: [string, unknown][] = [
    ['an expression', '={{ $json.id }}'],
    ['the stripped form n8n saves for noDataExpression', '{{ $json.id }}'],
    ['an expression inside literal text', 'reset-{{ $json.id }}'],
  ];
  for (const [label, rawKey] of rawCases) {
    it(`${label} is a configuration error on every item before any login`, async () => {
      const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
      const rawParameters = params({}, { breakerResetKey: rawKey });
      const h = ctx({ params: perItem, rawParameters, items: many(3), continueOnFail: true });
      const [data] = await executeRunSteps(h, engine);
      expect(data.map(errorOf)).toEqual([EXPRESSION, EXPRESSION, EXPRESSION]);
      expect(data.every((d) => details(d).configError === true)).toBe(true);
      expect(engine.calls).toHaveLength(0);
      expect(h.staticData[BREAKER_KEY]).toBeUndefined();
    });
  }
  it('Options set by one expression is refused for the reset key too', async () => {
    const engine = fakeEngine(() => scriptOk());
    const rawParameters = { ...params(), options: '={{ { breakerResetKey: $json.id } }}' };
    const [data] = await executeRunSteps(ctx({ params: perItem, rawParameters, items: many(2), continueOnFail: true }), engine);
    expect(errorOf(data[0])).toMatch(/must be set directly, not with an expression\.$/);
    expect(engine.calls).toHaveLength(0);
  });
  const literalCases: [string, Partial<HarnessOptions>][] = [
    ['the key is read once per execution (item 0), even if items were to resolve differently', { params: perItem, rawParameters: params({}, { breakerResetKey: 'id-0' }) }],
    ['a literal key: item 1 login_failed, items 2 and 3 locked_out, exactly one login attempt', { params: params({}, { breakerResetKey: '2026-10-07' }) }],
  ];
  for (const [label, keyed] of literalCases) {
    it(label, async () => {
      const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
      // A breaker from an earlier execution under the old key: the new literal key resets it once.
      const staticData: IDataObject = {
        [BREAKER_KEY]: { 'site-login:site-a': { code: 'login_failed', at: '2026-10-01T00:00:00.000Z', resetKey: 'old', message: 'rejected' } },
      };
      const [data] = await executeRunSteps(ctx({ ...keyed, items: many(3), staticData, continueOnFail: true }), engine);
      expect(engine.calls).toHaveLength(1);
      expect(data.map(errorOf)).toEqual(['login_failed: the site rejected the sign-in', LOCKED, LOCKED]);
    });
  }
  it('a breaker tripped in this execution is not reset by another node with a different key in the same execution', async () => {
    const engine = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
    const first = ctx({ params: params({}, { breakerResetKey: 'k1' }), continueOnFail: true });
    await executeRunSteps(first, engine);
    expect(engine.calls).toHaveLength(1);
    // Same execution (shared per-execution context and static data), another node with its own literal key.
    const second = ctx({ nodeName: 'Another node', params: params({}, { breakerResetKey: 'k2' }), staticData: first.staticData, continueOnFail: true });
    const [data] = await executeRunSteps({ ...second, getContext: first.getContext }, engine);
    expect(errorOf(data[0])).toBe(LOCKED);
    expect(engine.calls).toHaveLength(1);
    // The next execution with the new key resets it, as documented.
    const next = ctx({ params: params({}, { breakerResetKey: 'k2' }), staticData: first.staticData, continueOnFail: true });
    await executeRunSteps(next, engine);
    expect(engine.calls).toHaveLength(2);
  });
});

describe('Max Items', () => {
  const message = (n: number, max: number) => `This node received ${n} items, more than Options → Max Items (${max}). Nothing ran.`;
  it('100 items run', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ items: many(100) }), engine);
    expect(engine.calls).toHaveLength(100);
    expect(data).toHaveLength(100);
  });
  it('101 items fail before any run', async () => {
    const engine = fakeEngine(() => scriptOk());
    await expect(executeRunSteps(ctx({ items: many(101) }), engine)).rejects.toThrow(message(101, 100));
    expect(engine.calls).toHaveLength(0);
  });
  it('101 items with continue-on-fail give one configuration error item per input item', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ items: many(101), continueOnFail: true }), engine);
    expect(data).toHaveLength(101);
    expect(new Set(data.map(errorOf))).toEqual(new Set([message(101, 100)]));
    expect(data.every((d) => details(d).configError === true)).toBe(true);
    expect(data.map((d) => d.pairedItem)).toEqual(data.map((_, item) => [{ item }]));
    expect(engine.calls).toHaveLength(0);
  });
  it('honours Options → Max Items', async () => {
    const engine = fakeEngine(() => scriptOk());
    await expect(executeRunSteps(ctx({ items: many(3), params: params({}, { maxItems: 2 }) }), engine)).rejects.toThrow(message(3, 2));
  });
});

describe('AI repair', () => {
  it('passes the model, Goal, Name, clamped budgets and Deliver Unconfirmed Rows', async () => {
    const engine = fakeEngine(() => agentOk());
    await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams({}, { maxActions: 10_000, maxTokens: 5, deliverUnconfirmed: true }) }), engine);
    const repair = engine.calls[0].repair;
    expect(repair).toMatchObject({ goal: GOAL, name: 'items', agentBudget: { maxActions: 200, maxTokens: 1000 }, deliverUnconfirmed: true, alreadyRan: false });
    expect(typeof repair?.model.bindTools).toBe('function');
  });
  const FILE_STEPS: Script = {
    name: 'lineitems', version: 1, startUrl: 'https://example.com/list',
    steps: [
      { intent: 'Open the list', goto: 'https://example.com/list' },
      { intent: 'Export', download: { trigger: { role: 'button', name: 'Export' } } },
    ],
  };
  it('Expected File becomes RepairInput.download', async () => {
    const engine = fakeEngine(() => agentOk());
    const expectedFile = { file: { fileType: ['csv'], namePattern: '^LINEITEMS_', minBytes: '', requiredColumns: 'Document, Amount ,', minRows: 1 } };
    await executeRunSteps(ctx({ model: STUB_MODEL, params: params({ aiRepair: true, goal: GOAL, steps: '', expectedFile }, { name: 'lineitems' }) }), engine);
    expect(engine.calls[0].repair?.download).toEqual({ mime: ['text/csv'], check: { name: '^LINEITEMS_', columns: ['Document', 'Amount'], minRows: 1 } });
  });
  it('no Expected File field set leaves RepairInput.download out', async () => {
    const engine = fakeEngine(() => agentOk());
    await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams({ expectedFile: { file: { fileType: [], namePattern: '', minBytes: 0.5, requiredColumns: ' ', minRows: 0 } } }) }), engine);
    expect(engine.calls[0].repair).not.toHaveProperty('download');
  });
  it('an Expected File the download step rules refuse is a configuration error before the browser', async () => {
    const engine = fakeEngine(() => agentOk());
    const run = async (file: Record<string, unknown>) => {
      const expectedFile = { file: { fileType: ['csv'], namePattern: '', minBytes: 0, requiredColumns: '', minRows: 0, ...file } };
      const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: params({ aiRepair: true, goal: GOAL, steps: '', expectedFile }, { name: 'lineitems' }) }), engine);
      expect(details(data[0])).toMatchObject({ configError: true });
      return errorOf(data[0]);
    };
    expect(await run({ namePattern: '(' })).toBe('Expected File: File Name Pattern (check.name) is not a valid regex');
    expect(await run({ requiredColumns: Array.from({ length: 51 }, (_, i) => `C${i}`).join(',') }))
      .toBe('Expected File: Required Columns (check.columns) must be 1 to 50 strings of at most 200 characters');
    expect(await run({ requiredColumns: 'x'.repeat(201) })).toBe('Expected File: Required Columns (check.columns) must be 1 to 50 strings of at most 200 characters');
    expect(await run({ namePattern: '^A', minBytes: 300_000_000 })).toBe('Expected File: Minimum Size (check.minBytes) must be between 1 and 209715200');
    expect(await run({ namePattern: '^A', minRows: 2_000_000_000 })).toBe('Expected File: Minimum Rows (check.minRows) must be a whole number from 0 to 1000000000');
    expect(engine.calls).toHaveLength(0);
  });
  it('an unrepairable download document is a configuration error before the browser', async () => {
    const engine = fakeEngine(() => agentOk());
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: params({ aiRepair: true, goal: GOAL, steps: FILE_STEPS }, { name: 'lineitems' }) }), engine);
    expect(engine.calls).toHaveLength(0);
    expect(errorOf(data[0])).toBe('AI repair of a download needs a check on the download step that names the file or its columns (check.name or check.columns).');
  });
  it('a file success delivers the file binary under its compiled name', async () => {
    const engine = fakeEngine(() => agentOk({ files: [{ fileName: 'LINEITEMS_1.csv', mimeType: 'text/csv', data: Buffer.from('Document\n1\n'), binaryName: 'file_1' }] }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, params: params({ aiRepair: true, goal: GOAL, steps: { ...FILE_STEPS, steps: [FILE_STEPS.steps[0], { intent: 'Export', download: { trigger: { role: 'button', name: 'Export' }, check: { name: '^LINEITEMS_' } } }] } }, { name: 'lineitems' }) }), engine);
    expect(Object.keys(data[0].binary ?? {})).toEqual(['file_1']);
    expect(data[0].json.files).toEqual([{ fileName: 'LINEITEMS_1.csv', mimeType: 'text/csv', bytes: 11, binaryProperty: 'file_1' }]);
  });
  it('a Goal is required when AI Repair is on', async () => {
    const engine = fakeEngine(() => agentOk());
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams({ goal: '  ' }) }), engine);
    expect(errorOf(data[0])).toBe('Goal is required when AI Repair is on');
    expect(engine.calls).toHaveLength(0);
  });
  it('one repair per execution: a later item is sent with alreadyRan', async () => {
    const engine = fakeEngine((_input, call) =>
      call === 0 ? agentOk({ llmCalls: 3, proposal: PROPOSAL }) : taskFail('drift_detected', 'Read the items: drifted (AI repair already ran in this execution)'));
    const [data, repaired] = await executeRunSteps(ctx({ model: STUB_MODEL, items: many(2), continueOnFail: true, params: repairParams() }), engine);
    expect(engine.calls.map((c) => c.repair?.alreadyRan)).toEqual([false, true]);
    expect(repaired).toHaveLength(1);
    expect(errorOf(data[1])).toBe('drift_detected: Read the items: drifted (AI repair already ran in this execution)');
  });
  it('one repair per execution: a later run of the node in the same execution is sent with alreadyRan; a new execution is not', async () => {
    const engine = fakeEngine(() => agentOk({ proposal: PROPOSAL }));
    const h = ctx({ model: STUB_MODEL, params: repairParams() });
    await executeRunSteps(h, engine);
    await executeRunSteps(h, engine); // e.g. inside Loop Over Items: same execution, the node runs again
    await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), engine);
    expect(engine.calls.map((c) => c.repair?.alreadyRan)).toEqual([false, true, false]);
  });
  it('agent-lane results that spent no model effort do not use up the repair', async () => {
    const before = [
      taskFail('drift_detected', 'repair cannot record field extraction yet: update the script by hand', { lane: 'agent' }),
      taskFail('browser_unavailable', 'Could not connect to the browser server', { lane: 'agent', llmCalls: 0 }),
      taskFail('site_down', 'HTTP 503 at https://example.com/list', { lane: 'agent' }),
      taskFail('incomplete', 'run cancelled', { lane: 'agent', llmCalls: 0, tokens: 0 }),
    ];
    const engine = fakeEngine((_input, call) => before[call] ?? agentOk());
    await executeRunSteps(ctx({ model: STUB_MODEL, items: many(5), continueOnFail: true, params: repairParams({ steps: '', signature: '', approvedBy: '' }) }), engine);
    expect(engine.calls.map((c) => c.repair?.alreadyRan)).toEqual([false, false, false, false, false]);
  });
  it('model effort uses up the repair: a failure after a model call, or a result with repaired steps', async () => {
    for (const first of [taskFail('incomplete', 'the proof did not pass', { lane: 'agent', llmCalls: 1 }), agentOk({ llmCalls: 0, proposal: PROPOSAL })]) {
      const engine = fakeEngine((_input, call) => (call === 0 ? first : agentOk()));
      await executeRunSteps(ctx({ model: STUB_MODEL, items: many(2), continueOnFail: true, params: repairParams() }), engine);
      expect(engine.calls.map((c) => c.repair?.alreadyRan)).toEqual([false, true]);
    }
  });
  it('a script-lane success with AI Repair on never fetches the model', async () => {
    const h = ctx({ model: STUB_MODEL, params: repairParams() });
    await executeRunSteps(h, fakeEngine(() => scriptOk()));
    expect(h.modelRequests).toBe(0);
  });
  it('a script-lane result or an engine configuration error does not use up the repair', async () => {
    const engine = fakeEngine((_input, call) =>
      call === 0 ? scriptOk() : call === 1 ? taskFail('policy_violation', 'AI repair needs an ID Pattern and an extract step.', { configError: true, lane: 'agent' }) : agentOk());
    await executeRunSteps(ctx({ model: STUB_MODEL, items: many(3), continueOnFail: true, params: repairParams() }), engine);
    expect(engine.calls.map((c) => c.repair?.alreadyRan)).toEqual([false, false, false]);
  });
  it('repair preconditions are configuration errors before the lock and before any run', async () => {
    await memoryGuardStore().acquireLock(siteLoginKey('site-a'), 60_000); // a held lock would answer busy: the precondition comes first
    const engine = fakeEngine(() => agentOk());
    const submit = { ...STEPS, steps: [...STEPS.steps, { intent: 'Send the form', submit: { host: 'example.com', path: '/send', button: { css: 'button' } } }] };
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{}, { idPattern: '' }, 'AI repair needs an ID Pattern and an extract step.'],
      [{ steps: { ...STEPS, steps: [STEPS.steps[0]] } }, {}, 'AI repair needs an ID Pattern and an extract step.'],
      [{ steps: submit }, {}, 'AI repair is not available for steps that submit forms or download through a form.'],
      [{ steps: '', signature: '', approvedBy: '' }, { name: '  ' }, 'A first run needs a name: set Options → Name.'],
    ];
    for (const [over, options, message] of cases) {
      const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams(over, options) }), engine);
      expect(errorOf(data[0])).toBe(message);
      expect(details(data[0])).toMatchObject({ configError: true, code: null, submitted: false });
    }
    expect(engine.calls).toHaveLength(0);
  });
  it('repair refused after a write: a policy_violation failure that says the run submitted', async () => {
    const refused = 'AI repair is not available for steps that submit forms or download through a form.';
    const engine = fakeEngine(() => taskFail('policy_violation', refused, { submitted: true, failure: { index: 2, intent: 'Read the items', message: 'drifted' } }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams() }), engine);
    expect(errorOf(data[0])).toBe(`policy_violation: ${refused}`);
    expect(details(data[0])).toMatchObject({ code: 'policy_violation', lane: 'script', stepIntent: 'Read the items', submitted: true });
    expect(details(data[0]).configError).toBeUndefined();
    const err = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), engine).catch((e: unknown) => e);
    expect((err as NodeOperationError).message).toBe(`policy_violation: ${refused}`);
    expect((err as NodeOperationError).context).toMatchObject({ code: 'policy_violation', submitted: true });
  });
  it('an engine configuration error after a write still says the run submitted', async () => {
    const refused = 'AI repair is not available for steps that submit forms or download through a form.';
    const engine = fakeEngine(() => taskFail('policy_violation', refused, { configError: true, submitted: true }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams() }), engine);
    expect(data[0].json).toEqual({
      error: refused, message: refused,
      details: { configError: true, code: null, name: 'items', version: null, hash: '', lane: null, log: [], submitted: true },
    });
    const err = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), engine).catch((e: unknown) => e);
    expect((err as NodeOperationError).message).toBe(refused);
    expect((err as NodeOperationError).context).toMatchObject({ configError: true, code: null, submitted: true });
  });
  it('withheld agent rows: the engine message, with its reason, is the error', async () => {
    const withheld = 'the repaired steps did not pass the proof, so the rows were not delivered (turn on Options → Deliver Unconfirmed Rows to receive them). Reason: 2 rows missing';
    const engine = fakeEngine(() => taskFail('incomplete', withheld, { lane: 'agent', llmCalls: 3 }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams() }), engine);
    expect(errorOf(data[0])).toBe(`incomplete: ${withheld}`);
    expect(details(data[0])).toMatchObject({ lane: 'agent', submitted: false });
  });
  it('AI Repair on without a model: drift says to connect one, and empty steps are a configuration error', async () => {
    const drift = 'Read the items: Visible Text "Next" matches 3 elements. Use a more specific locator; it must match exactly one.';
    const engine = fakeEngine(() => taskFail('drift_detected', drift));
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, params: repairParams() }), engine);
    expect(engine.calls[0].repair).toBeUndefined();
    expect(errorOf(data[0])).toBe(`drift_detected: ${drift} (${NO_MODEL})`);
    const [empty] = await executeRunSteps(ctx({ continueOnFail: true, params: repairParams({ steps: '' }) }), engine);
    expect(errorOf(empty[0])).toBe(NO_MODEL);
    expect(details(empty[0]).configError).toBe(true);
    expect(engine.calls).toHaveLength(1);
  });
  it('an engine configuration error becomes a configuration error item', async () => {
    const engine = fakeEngine(() => taskFail('policy_violation', 'AI repair needs an ID Pattern and an extract step.', { configError: true, lane: 'agent' }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, continueOnFail: true, params: repairParams() }), engine);
    expect(data[0].json).toEqual({
      error: 'AI repair needs an ID Pattern and an extract step.', message: 'AI repair needs an ID Pattern and an extract step.',
      details: { configError: true, code: null, name: 'items', version: null, hash: '', lane: null, log: [], submitted: false },
    });
  });
});

describe('outputs', () => {
  it('one output with AI Repair off; two with it on or set by an expression, even when it resolves to false', async () => {
    const engine = fakeEngine(() => scriptOk());
    expect(await executeRunSteps(ctx(), engine)).toHaveLength(1);
    expect(await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), engine)).toHaveLength(2);
    const resolved = params({ aiRepair: false });
    const out = await executeRunSteps(ctx({ params: resolved, rawParameters: { ...resolved, aiRepair: '={{ $json.repair }}' } }), engine);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual([]);
    expect(engine.calls[2].repair).toBeUndefined();
  });
  it('script lane: page facts, the step log with outputs, verified rows, files, blocked writes and binaries', async () => {
    const log = [
      { index: 0, intent: 'Open the list', status: 'ok' as const, ms: 10 },
      { index: 2, intent: 'Take a screenshot', status: 'ok' as const, ms: 30, output: { binary: 'screenshot_2' } },
    ];
    const engine = fakeEngine(() => scriptOk({
      name: 'items', version: 3, hash: 'c3'.repeat(32), verified: true, confirmed: true, submitted: true, log,
      rows: [{ id: 'SKU-1001', title: 'Widget' }],
      outputs: [{ index: 2, verb: 'screenshot', binary: { name: 'screenshot_2', fileName: 'screenshot_2.png', mimeType: 'image/png', data: Buffer.from('png') } }],
      files: [{ fileName: 'report.csv', mimeType: 'text/csv', data: Buffer.from('a,b\n'), binaryName: 'file_3' }],
      blockedRequests: [{ method: 'POST', host: 'collect.example.net', path: '/b' }],
      trace: Buffer.from('zip'),
    }));
    const [data] = await executeRunSteps(ctx(), engine);
    expect(data[0].json).toEqual({
      url: 'https://example.com/list', title: 'Items', status: 200, name: 'items', version: 3, hash: 'c3'.repeat(32), lane: 'script',
      confirmed: true, llmCalls: 0, durationMs: 1200, llmTokens: 0, log, rows: [{ id: 'SKU-1001', title: 'Widget' }],
      files: [{ fileName: 'report.csv', mimeType: 'text/csv', bytes: 4, binaryProperty: 'file_3' }],
      blockedRequests: [{ method: 'POST', host: 'collect.example.net', path: '/b' }], submitted: true,
    });
    expect(Object.keys(data[0].binary ?? {}).sort()).toEqual(['file_3', 'screenshot_2', 'trace']);
    expect(data[0].binary?.screenshot_2).toMatchObject({ fileName: 'screenshot_2.png', mimeType: 'image/png' });
    expect(data[0].binary?.trace).toMatchObject({ fileName: 'items-trace.zip', mimeType: 'application/zip' });
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
  });
  it('without an extract step there is no rows key, and empty lists are left out', async () => {
    const [data] = await executeRunSteps(ctx(), fakeEngine(() => scriptOk({ rows: [], verified: false })));
    expect(Object.keys(data[0].json)).toEqual(['url', 'title', 'status', 'name', 'version', 'hash', 'lane', 'confirmed', 'llmCalls', 'durationMs', 'llmTokens', 'log']);
    expect(data[0].binary).toBeUndefined();
  });
  it('agent lane: rows go to Data, and the Repaired steps item goes to the second output', async () => {
    const engine = fakeEngine(() => agentOk({ rows: [{ id: 'SKU-1001' }], confirmed: true, llmCalls: 3, proposal: PROPOSAL }));
    const [data, repaired] = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), engine);
    expect(data[0].json).toMatchObject({
      lane: 'agent', name: 'items', version: 3, hash: scriptHash(STEPS), confirmed: true, llmCalls: 3, durationMs: 20_000, llmTokens: 1000, rows: [{ id: 'SKU-1001' }],
    });
    expect(repaired).toHaveLength(1);
    expect(Object.keys(repaired[0].json)).toEqual([
      'name', 'baseVersion', 'version', 'steps', 'hash', 'digest', 'evidence', 'changes', 'safetyFlags', 'evidenceLine', 'changeList', 'safetyLine', 'attachmentNames',
    ]);
    expect(repaired[0].json).toMatchObject({
      name: 'items', baseVersion: 3, version: 4, hash: 'd4'.repeat(32), digest: proposalDigest({ ...PROPOSAL, safetyFlags: ['host: example.com'] }), safetyFlags: ['host: example.com'], evidenceLine: 'Proven in a fresh browser: 3 of 3 rows',
      changeList: 'Changed: Read the items -> Read the product list', safetyLine: 'host: example.com', attachmentNames: 'before,after',
    });
    expect(repaired[0].json.steps).toEqual(JSON.parse(JSON.stringify(PROPOSAL.steps)));
    expect(repaired[0].binary?.before).toMatchObject({ fileName: 'before-v3.png', mimeType: 'image/png' });
    expect(repaired[0].binary?.after).toMatchObject({ fileName: 'after-v4.png', mimeType: 'image/png' });
    // The proof run's trace: the new steps replayed alone, for the reviewer (not in attachmentNames, which names the screenshots).
    expect(repaired[0].binary?.trace).toMatchObject({ fileName: 'items-v4-proof-trace.zip', mimeType: 'application/zip' });
    expect(repaired[0].pairedItem).toEqual([{ item: 0 }]);
    expect(JSON.stringify(repaired[0].json)).not.toMatch(/proposal/i);
  });
  it('a first run (empty steps) sends no Data item: its only output is the Repaired steps item', async () => {
    const engine = fakeEngine(() => agentOk({ rows: [{ id: 'SKU-1001' }, { id: 'SKU-1002' }], confirmed: true, llmCalls: 3, proposal: { ...PROPOSAL, baseVersion: null, version: 1 } }));
    const [data, repaired] = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams({ steps: '', signature: '', approvedBy: '' }) }), engine);
    expect(data).toEqual([]);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].json).toMatchObject({ name: 'items', version: 1 });
    expect(repaired[0].pairedItem).toEqual([{ item: 0 }]);
  });
  it('an agent-lane success that submitted says so', async () => {
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), fakeEngine(() => agentOk({ submitted: true })));
    expect(data[0].json.submitted).toBe(true);
    const [quiet] = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams() }), fakeEngine(() => agentOk()));
    expect('submitted' in quiet[0].json).toBe(false);
  });
  it('a failure is an error item with the code first, the step log, submitted and the binaries', async () => {
    const engine = fakeEngine(() => taskFail('incomplete', 'run cancelled', {
      failure: { index: 2, intent: 'Send the form', message: 'run cancelled' }, log: [{ index: 0, intent: 'Open the form', status: 'ok', ms: 5 }],
      submitted: true, screenshot: Buffer.from('png'), trace: Buffer.from('zip'), version: 3, hash: 'c3'.repeat(32),
    }));
    const [data] = await executeRunSteps(ctx({ continueOnFail: true }), engine);
    expect(data[0].json).toEqual({
      error: 'incomplete: run cancelled', message: 'run cancelled',
      details: {
        code: 'incomplete', message: 'run cancelled', name: 'items', version: 3, hash: 'c3'.repeat(32), lane: 'script', stepIntent: 'Send the form',
        traceRef: 'trace', durationMs: 900, llmTokens: 0, log: [{ index: 0, intent: 'Open the form', status: 'ok', ms: 5 }], submitted: true,
      },
    });
    expect(data[0].error).toBeUndefined();
    expect(data[0].binary?.screenshot?.mimeType).toBe('image/png');
    expect(data[0].binary?.trace?.mimeType).toBe('application/zip');
  });
  it('an agent-lane failure carries its duration and the chat model tokens it used (run log columns)', async () => {
    const engine = fakeEngine(() => taskFail('incomplete', 'the proof did not pass', { lane: 'agent', llmCalls: 4, tokens: 4321, durationMs: 15_000 }));
    const [data] = await executeRunSteps(ctx({ model: STUB_MODEL, params: repairParams(), continueOnFail: true }), engine);
    expect(details(data[0])).toMatchObject({ code: 'incomplete', lane: 'agent', durationMs: 15_000, llmTokens: 4321 });
  });
  it('without continue-on-fail the failure is thrown with the code first and the guidance as description', async () => {
    const err = await executeRunSteps(ctx(), fakeEngine(() => taskFail('site_down', 'HTTP 503 at the start page'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as NodeOperationError).message).toBe('site_down: HTTP 503 at the start page');
    expect((err as NodeOperationError).description).toBe(
      'site_down: The site did not answer, returned a server error, or the first page did not finish loading in time. Try again later.',
    );
  });
  it('every output item is paired with its input item', async () => {
    const engine = fakeEngine((_input, call) => (call === 0 ? scriptOk() : taskFail('not_found', 'the page or the data was not found')));
    const [data] = await executeRunSteps(ctx({ items: many(3), continueOnFail: true, params: (i) => (i === 2 ? params({ steps: '{' }) : params()) }), engine);
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }], [{ item: 2 }]]);
  });
});

describe('unexpected errors under continue-on-fail', () => {
  /** A harness whose prepareBinaryData throws on its first call (a full binary store, for example). */
  const failingBinary = (over: Partial<HarnessOptions> = {}) => {
    const h = ctx({ items: many(2), ...over });
    const prepare = h.helpers.prepareBinaryData.bind(h.helpers);
    let calls = 0;
    h.helpers.prepareBinaryData = async (...args: Parameters<typeof prepare>) => {
      if (calls++ === 0) throw new Error('binary store is full');
      return prepare(...args);
    };
    return h;
  };
  const withTrace = () => scriptOk({ trace: Buffer.from('zip') });
  it('a throw while building the Data item is a paired incomplete failure that keeps what the run did, never a throw or a copied input item', async () => {
    const [data] = await executeRunSteps(failingBinary({ continueOnFail: true }), fakeEngine(withTrace));
    expect(data).toHaveLength(2);
    expect(data[0].json).toMatchObject({
      error: 'incomplete: the run finished but its output could not be built: binary store is full', details: { code: 'incomplete', lane: 'script', submitted: false },
    });
    expect((data[0].json.details as IDataObject).configError).toBeUndefined();
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
    expect(data[1].json).toMatchObject({ lane: 'script' });
    expect(data[1].pairedItem).toEqual([{ item: 1 }]);
  });
  it('a throw while building a failure item or a Repaired steps item is a paired error item too', async () => {
    const failing = () => taskFail('incomplete', 'run cancelled', { screenshot: Buffer.from('png') });
    const [failed] = await executeRunSteps(failingBinary({ continueOnFail: true }), fakeEngine(failing));
    expect(failed.map((d) => d.json.error)).toEqual(['incomplete: run cancelled', 'incomplete: run cancelled']);
    expect((failed[0].json.details as IDataObject).traceRef).toBeNull(); // rebuilt without the binaries that failed to attach
    expect(failed.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }]]);
    const [data, repaired] = await executeRunSteps(
      failingBinary({ continueOnFail: true, model: STUB_MODEL, params: repairParams() }), fakeEngine(() => agentOk({ llmCalls: 1, proposal: PROPOSAL })),
    );
    expect(data[0].json.error).toBe('incomplete: the run finished but its output could not be built: binary store is full');
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
    expect(repaired).toHaveLength(1);
    expect(repaired[0].pairedItem).toEqual([{ item: 1 }]);
  });
  it('without continue-on-fail the same throw is a NodeOperationError', async () => {
    const err = await executeRunSteps(failingBinary(), fakeEngine(withTrace)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeOperationError);
    expect((err as NodeOperationError).message).toBe('incomplete: the run finished but its output could not be built: binary store is full');
  });
  it('a failure after a write keeps submitted: true when its output cannot be built', async () => {
    const wrote = () => scriptOk({ trace: Buffer.from('zip'), submitted: true, writes: [{ method: 'POST', host: 'example.com', path: '/f' }] });
    const [data] = await executeRunSteps(failingBinary({ continueOnFail: true }), fakeEngine(wrote));
    expect(data[0].json.details).toMatchObject({ code: 'incomplete', submitted: true, lane: 'script' });
    const failedAfterWrite = () => taskFail('incomplete', 'run cancelled', { screenshot: Buffer.from('png'), submitted: true });
    const [failed] = await executeRunSteps(failingBinary({ continueOnFail: true }), fakeEngine(failedAfterWrite));
    expect(failed[0].json.details).toMatchObject({ code: 'incomplete', submitted: true });
  });
});

describe('no message carries a token, a query string or a username', () => {
  it('across success, failure, policy and breaker items', async () => {
    const site = new URL('https://example.com/list?token=abc123');
    const at = `${site.origin}${site.pathname}`; // what the engine shows: origin + path, never the query
    const engine = fakeEngine((_input, call) => (call === 0 ? scriptOk({ page: { url: at, title: 'Items', status: 200 } }) : taskFail('site_down', `HTTP 503 at ${at}`)));
    const starts = [site.href, site.href, 'file:///etc/passwd?token=abc123', `https://${USER}:${PASS}@example.com/list?token=abc123`];
    const [unsignedOut] = await executeRunSteps(ctx({
      credentials: BROWSER_ONLY, items: many(starts.length), continueOnFail: true, params: (i) => unsigned({ startUrl: starts[i] }),
    }), engine);
    const login = fakeEngine(() => taskFail('login_failed', 'the site rejected the sign-in'));
    const [siteOut] = await executeRunSteps(ctx({ items: many(2), continueOnFail: true }), login);
    const text = JSON.stringify([unsignedOut, siteOut]);
    for (const leak of [TOKEN, 'abc123', USER, PASS, KEY, '?token=']) expect(text).not.toContain(leak);
    expect(unsignedOut.map(errorOf)).toEqual([
      undefined,
      'site_down: HTTP 503 at https://example.com/list',
      'policy_violation: URL must start with http:// or https:// (got "file:").',
      expect.stringMatching(/^policy_violation: /),
    ]);
    expect(siteOut.map(errorOf)).toEqual(['login_failed: the site rejected the sign-in', 'locked_out: A previous login for example.com failed, so no login was tried.']);
  });
});

describe('Run Steps: downloads refuse a CDP browser connection', () => {
  const MESSAGE =
    'Downloads need the Browser Server or Local Browser mode: a Chrome DevTools Protocol (CDP) connection cannot read downloaded files. Pick an RPA Browser credential in Browser Server mode for this node.';
  const CDP = { playwrightBrowserApi: { mode: 'cdp', wsUrl: 'wss://cdp.example.net/' } };
  const DOWNLOAD = { intent: 'Download the report', download: { trigger: { text: 'Export' }, mime: ['text/csv'], maxBytes: 1000 } };
  const withSteps = (steps: unknown[]) => unsigned({ steps: { ...STEPS, steps } });
  const expectedFile = { file: { fileType: ['csv'], namePattern: '^LINEITEMS_', minBytes: '', requiredColumns: '', minRows: 0 } };

  it('a CDP browser refuses steps with a download', async () => {
    const engine = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, credentials: CDP, params: withSteps([...STEPS.steps, DOWNLOAD]) }), engine);
    expect(errorOf(data[0])).toBe(MESSAGE);
    expect(details(data[0])).toMatchObject({ configError: true });
    expect(engine.calls).toHaveLength(0);
  });
  it('a CDP browser refuses a download inside paginate', async () => {
    const engine = fakeEngine(() => scriptOk());
    const paginate = { intent: 'Page', paginate: { next: { text: 'Next' }, until: 'absent', max: 3, each: [DOWNLOAD] } };
    const [data] = await executeRunSteps(ctx({ continueOnFail: true, credentials: CDP, params: withSteps([paginate]) }), engine);
    expect(errorOf(data[0])).toBe(MESSAGE);
    expect(engine.calls).toHaveLength(0);
  });
  it('a CDP browser refuses a first run with an Expected File', async () => {
    const engine = fakeEngine(() => agentOk());
    const [data] = await executeRunSteps(
      ctx({ model: STUB_MODEL, continueOnFail: true, credentials: CDP, params: params({ aiRepair: true, goal: GOAL, steps: '', expectedFile }, { name: 'lineitems' }) }), engine);
    expect(errorOf(data[0])).toBe(MESSAGE);
    expect(engine.calls).toHaveLength(0);
  });
  it('without continue-on-fail the refusal throws a NodeOperationError', async () => {
    const engine = fakeEngine(() => scriptOk());
    await expect(executeRunSteps(ctx({ credentials: CDP, params: withSteps([DOWNLOAD]) }), engine)).rejects.toThrow(MESSAGE);
  });
  it('a CDP browser still runs steps without a download', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ credentials: CDP, params: unsigned() }), engine);
    expect(engine.calls).toHaveLength(1);
  });
  it('Browser Server mode runs a download as before', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(ctx({ credentials: BROWSER_ONLY, params: withSteps([DOWNLOAD]) }), engine);
    expect(engine.calls).toHaveLength(1);
  });
});
