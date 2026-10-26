import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ICredentialTestFunctions, IExecuteFunctions } from 'n8n-workflow';
import { CREDENTIALS } from '../nodes/Playwright/config.js';
import type { NodeContext } from '../nodes/Playwright/context.js';
import { redisTestResult, scriptSigningResult, siteLoginTestResult } from '../nodes/Playwright/credential-tests.js';
import { loadEngine } from '../nodes/Playwright/engine.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { harness } from './harness.js';

// Compile-time check (tsconfig.test.json): n8n's execute context satisfies the narrow context the operations use.
const asContext = (f: IExecuteFunctions): NodeContext => f;
void asContext;

const node = new Playwright();
const d = node.description;
const testContext = {} as ICredentialTestFunctions;
const exec = (ctx: NodeContext) => node.execute.call(ctx as unknown as IExecuteFunctions);

describe('RPA node', () => {
  it('is the generic RPA node: version 1, RPA icon, self-hosted only, not an AI tool', () => {
    expect(d).toMatchObject({ displayName: 'RPA', name: 'playwright', version: 1, icon: { light: 'file:rpa.svg', dark: 'file:rpa.svg' } });
    expect(d.description).toMatch(/Self-hosted only\.$/);
    expect(d.usableAsTool).toBeUndefined();
  });
  it('names its credentials with literals equal to CREDENTIALS, each tested by a method the node implements', () => {
    expect(d.credentials?.map((c) => c.name)).toEqual([CREDENTIALS.browser, CREDENTIALS.siteLogin, CREDENTIALS.signing, CREDENTIALS.redis]);
    for (const c of d.credentials ?? []) expect(Object.keys(node.methods.credentialTest)).toContain(c.testedBy);
  });
  it('has no secret parameters', () => {
    const walk = (items: readonly unknown[]): void => {
      for (const item of items) {
        const o = item as { typeOptions?: { password?: boolean }; options?: unknown[]; values?: unknown[] };
        expect(o.typeOptions?.password).toBeUndefined();
        walk(o.options ?? []);
        walk(o.values ?? []);
      }
    };
    walk(d.properties);
  });
  it('has no single-process notice on Run Steps, and an optional Redis slot only on Run Steps and Import Steps', () => {
    const run = d.properties.filter((p) => p.displayOptions?.show?.operation?.includes('runSteps'));
    expect(run.some((p) => p.name === 'singleProcessNotice')).toBe(false);
    expect(d.credentials?.find((c) => c.name === 'playwrightRedisApi')).toEqual({
      name: 'playwrightRedisApi', displayName: 'RPA Redis', required: false, testedBy: 'guardRedisTest', displayOptions: { show: { operation: ['runSteps', 'importSteps'] } },
    });
  });
  it('the Redis test reports OK, or an unreachable message without the run wording', async () => {
    expect(await redisTestResult({}, async () => {})).toMatchObject({ status: 'OK' });
    expect(await redisTestResult({}, async () => { throw new Error('boom'); })).toEqual({ status: 'Error', message: 'boom' });
  });
  it('guardRedisTest on a closed port says the server could not be reached, not that no login was tried', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const r = await node.methods.credentialTest.guardRedisTest.call(testContext, { id: 'c3', name: 'Redis', type: 'playwrightRedisApi', data: { host: '127.0.0.1', port } });
    expect(r.status).toBe('Error');
    expect(r.message).toMatch(/^The Redis server could not be reached \(.+\)\.$/);
    expect(r.message).not.toContain('no login');
  });
  it('the Site Login and Step Signing tests return what the credential-test helpers return', async () => {
    const siteLogin = { loginUrl: 'https://example.com/login', username: 'u', password: 'p' };
    expect(await node.methods.credentialTest.siteLoginTest.call(testContext, { id: 'c1', name: 'Site', type: 'playwrightSiteLoginApi', data: siteLogin }))
      .toEqual(siteLoginTestResult(siteLogin));
    const signing = { secretKey: 'k'.repeat(32) };
    expect(await node.methods.credentialTest.scriptSigningTest.call(testContext, { id: 'c2', name: 'Key', type: 'playwrightScriptSigningApi', data: signing }))
      .toEqual(scriptSigningResult(signing));
  });
  it('execute dispatches Run Steps: empty steps with AI Repair off is a configuration error, before any browser', async () => {
    const params = { operation: 'runSteps', steps: '', startUrl: 'https://example.com/', requireSignedSteps: false, aiRepair: false, options: {} };
    const out = await exec(harness({ params, rawParameters: params, credentials: { playwrightBrowserApi: { mode: 'local', headless: true } }, continueOnFail: true }));
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(1);
    expect(JSON.stringify(out[0][0].json)).toContain('Steps is empty. Add steps, or turn on AI Repair to build them from the Goal.');
    expect(out[0][0].json.details).toMatchObject({ configError: true });
  });
  it('execute dispatches Sign Steps: an item that is not a Repaired steps item is refused', async () => {
    const params = { operation: 'signSteps', approved: true, approverId: 'ops@example.com', approverAllowlist: 'ops@example.com' };
    const ctx = harness({
      params, rawParameters: params, items: [{ json: { name: 'feed', version: 2 } }],
      credentials: { playwrightScriptSigningApi: { secretKey: 'k'.repeat(32) } }, continueOnFail: true,
    });
    const out = await exec(ctx);
    expect(out).toHaveLength(1);
    expect(out[0][0].json.error).toBe(
      'Sign Steps refused: The input item is not a Repaired steps item from Run Steps (it has no digest). Only Repaired steps items can be signed.',
    );
  });
  it('execute dispatches Import Steps: an empty Name is a configuration error, before anything is read', async () => {
    const params = { operation: 'importSteps', source: 'chrome', inputFrom: 'text', sourceText: '{}', stepsName: '', options: {} };
    const out = await exec(harness({ params, rawParameters: params, credentials: { playwrightBrowserApi: { mode: 'local', headless: true } }, continueOnFail: true }));
    expect(out).toHaveLength(2);
    expect(out[0][0].json.error).toBe('Name is required: it names the imported steps.');
    expect(out[0][0].json.details).toMatchObject({ configError: true });
    expect(out[1]).toEqual([]);
  });
  it('execute refuses an unknown operation', async () => {
    const params = { operation: 'approve' };
    await expect(exec(harness({ params, rawParameters: params }))).rejects.toThrow('Unknown operation "approve"');
  });
  it('the build empties dist before compiling, so files of deleted sources (the v1 credentials) never ship', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } };
    const steps = pkg.scripts.build.split('&&').map((x) => x.trim());
    const clean = steps.indexOf('node scripts/clean.mjs');
    expect(clean).toBeGreaterThanOrEqual(0);
    expect(clean).toBeLessThan(steps.indexOf('tsc -p tsconfig.json'));
    expect(readFileSync(new URL('../scripts/clean.mjs', import.meta.url), 'utf8')).toMatch(/rmSync\(.*dist.*recursive: true, force: true/s);
  });
  it('loads the engine only when asked', async () => {
    expect(typeof (await loadEngine()).runTask).toBe('function');
  });
});
