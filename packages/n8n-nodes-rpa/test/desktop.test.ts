import { afterEach, describe, expect, it } from 'vitest';
import type { ICredentialTestFunctions, IDataObject } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import { DEMO_PASSWORD, DEMO_USER, FakeRunner } from '../../engine/test/fake-runner.js';
import { selfSignedCert } from '../../engine/test/fake-runner-cert.js';
import { RpaDesktopRunnerApi } from '../credentials/RpaDesktopRunnerApi.credentials.js';
import { desktopRunnerTestResult } from '../nodes/Playwright/credential-tests.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine, scriptOk } from './fake-engine.js';
import { harness, type HarnessOptions } from './harness.js';

// Golden strings are written out here on purpose (tests assert them verbatim, not through the constants).
const KEY = 'desktop-signing-key-0123456789abcdef';
const APPROVER = 'approver@example.com';
const uia = (automationId: string, controlType = 'Edit') => ({ uia: { path: [{ controlType, automationId }] } });
const DESKTOP_STEPS = {
  surface: 'desktop', name: 'erp-orders', version: 2, app: { exe: 'ErpDemo.exe' },
  steps: [
    { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
    { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
    { intent: 'Sign in', click: uia('btnSignIn', 'Button'), expect: { visible: uia('txtSearch') } },
    { intent: 'Search', fill: { field: uia('txtSearch'), value: 'ACME' } },
    { intent: 'Run the search', click: uia('btnSearch', 'Button') },
    { intent: 'Read the count', read: { target: uia('lblCount', 'Text'), as: 'count' } },
    { intent: 'Open Export', click: uia('btnExport', 'Button') },
    { intent: 'Type the file name', fill: { field: { uia: { window: { title: 'Save As' }, path: [{ controlType: 'Edit', automationId: '1001' }] } }, value: '{{$exportDir}}\\orders.csv' } },
    { intent: 'Save', click: { uia: { window: { title: 'Save As' }, path: [{ controlType: 'Button', automationId: '1' }] } } },
    { intent: 'Return the CSV', expectFile: { pattern: '^orders\\.csv$' } },
  ],
};
const BROWSER_STEPS = { name: 'items', version: 1, startUrl: 'https://example.com/list', steps: [{ intent: 'Open', goto: 'https://example.com/list' }] };
const VARIABLES = { values: [{ name: 'user', value: DEMO_USER }, { name: 'password', value: DEMO_PASSWORD }] };

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

function params(steps: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  const { signature } = engine.signScript(steps, KEY, { approvedBy: APPROVER });
  return {
    operation: 'runSteps', steps, startUrl: '', requireSignedSteps: true, signature, approvedBy: APPROVER, aiRepair: false, goal: '',
    options: { saveTrace: 'never', variables: VARIABLES, timeout: 2000 }, ...over,
  };
}
const ctx = (credentials: HarnessOptions['credentials'], p: Record<string, unknown>) => harness({ params: p, credentials, continueOnFail: true });
const details = (json: IDataObject) => json.details as IDataObject;

describe('RPA Desktop Runner credential', () => {
  it('asks for the runner URL, the token (masked) and the certificate fingerprint, all required', () => {
    const c = new RpaDesktopRunnerApi();
    expect({ name: c.name, displayName: c.displayName }).toEqual({ name: 'rpaDesktopRunnerApi', displayName: 'RPA Desktop Runner' });
    const fields = c.properties.filter((p) => p.type !== 'notice');
    expect(fields.map((p) => [p.name, p.displayName, p.required, p.typeOptions?.password === true])).toEqual([
      ['url', 'Runner URL', true, false], ['token', 'Token', true, true], ['fingerprint', 'Certificate Fingerprint', true, false],
    ]);
    expect(fields[0].placeholder).toBe('wss://runner.example.com:8765');
  });

  it('the credential test connects (pinned), calls hello and reports the session', async () => {
    runner = await FakeRunner.start();
    expect(await desktopRunnerTestResult(runner.endpoint, engine)).toEqual({ status: 'OK', message: 'Connected to the desktop runner (session interactive)' });
    runner.session = { interactive: true, locked: true };
    expect(await desktopRunnerTestResult(runner.endpoint, engine)).toEqual({ status: 'OK', message: 'Connected to the desktop runner (session locked)' });
    const node = new Playwright();
    const viaNode = await node.methods.credentialTest.desktopRunnerTest.call({} as ICredentialTestFunctions, {
      id: 'd1', name: 'Runner', type: 'rpaDesktopRunnerApi', data: { ...runner.endpoint },
    });
    expect(viaNode.status).toBe('OK');
  });

  it('the credential test reports a wrong fingerprint, a refused token and a missing field', async () => {
    runner = await FakeRunner.start();
    const wrong = await desktopRunnerTestResult({ ...runner.endpoint, fingerprint: selfSignedCert().fingerprint }, engine);
    expect(wrong.status).toBe('Error');
    expect(wrong.message).toContain('which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.');
    expect(runner.requests).toEqual([]);
    expect(await desktopRunnerTestResult({ ...runner.endpoint, token: 'nope' }, engine)).toEqual({
      status: 'Error', message: `The desktop runner at ${runner.url}/rpa/v1 refused the token. Check the Token in the RPA Desktop Runner credential.`,
    });
    expect(await desktopRunnerTestResult({ ...runner.endpoint, fingerprint: '' }, engine)).toEqual({
      status: 'Error', message: 'The RPA Desktop Runner credential needs the Certificate Fingerprint the runner prints at start.',
    });
    expect((await desktopRunnerTestResult({ ...runner.endpoint, url: 'ws://127.0.0.1:8765' }, engine)).message).toBe(
      'The desktop runner URL must start with wss://: plain ws:// is refused.',
    );
  });
});

describe('Run Steps routes by the steps\' surface', () => {
  it('signed desktop steps run on the desktop runner: Data carries the read values and the expected file', async () => {
    runner = await FakeRunner.start();
    const eng = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(
      ctx({ rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } }, params(DESKTOP_STEPS)), eng,
    );
    expect(eng.calls).toHaveLength(0); // the browser lane never ran
    expect(data).toHaveLength(1);
    const json = data[0].json;
    expect(json.error).toBeUndefined();
    expect(json).toMatchObject({ url: 'desktop://ErpDemo.exe/ERP Demo - Orders', title: 'ERP Demo - Orders', status: null, name: 'erp-orders', version: 2, lane: 'script', values: { count: '2 results' } });
    expect(json.files).toEqual([{ fileName: 'orders.csv', mimeType: 'text/csv', bytes: 82, binaryProperty: 'file_9' }]);
    expect(data[0].binary?.file_9).toMatchObject({ fileName: 'orders.csv', mimeType: 'text/csv' });
    expect(JSON.stringify(json)).not.toContain(DEMO_PASSWORD);
  });

  it('desktop steps without the RPA Desktop Runner credential are refused, naming it, before anything connects', async () => {
    runner = await FakeRunner.start();
    const eng = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ playwrightBrowserApi: { mode: 'local' }, playwrightScriptSigningApi: { secretKey: KEY } }, params(DESKTOP_STEPS)), eng);
    expect(data[0].json.error).toBe('These are desktop steps (surface "desktop"): they run on a desktop runner. Attach an RPA Desktop Runner credential.');
    expect(details(data[0].json)).toMatchObject({ configError: true });
    expect(eng.calls).toHaveLength(0);
    expect(runner.tcpConnections).toBe(0);
  });

  it('browser steps with only the RPA Desktop Runner credential are refused, naming RPA Browser', async () => {
    runner = await FakeRunner.start();
    const eng = fakeEngine(() => scriptOk());
    const [data] = await executeRunSteps(ctx({ rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } }, params(BROWSER_STEPS)), eng);
    expect(data[0].json.error).toBe('These are browser steps: they run in a browser. Attach an RPA Browser credential.');
    expect(eng.calls).toHaveLength(0);
    expect(runner.tcpConnections).toBe(0);
  });

  it('desktop steps refuse a Site Login and AI repair (not available for desktop steps yet)', async () => {
    runner = await FakeRunner.start();
    const eng = fakeEngine(() => scriptOk());
    const desktopCreds = { rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } };
    const [withLogin] = await executeRunSteps(
      ctx({ ...desktopCreds, playwrightSiteLoginApi: { loginUrl: 'https://example.com/login', username: 'u', password: 'p' } }, params(DESKTOP_STEPS)), eng,
    );
    expect(withLogin[0].json.error).toBe('Desktop steps do not use an RPA Site Login yet: remove it from this node.');
    const [withRepair] = await executeRunSteps(ctx(desktopCreds, params(DESKTOP_STEPS, { aiRepair: true, goal: 'Export the orders' })), eng);
    expect(withRepair[0].json.error).toBe('AI repair is not available for desktop steps yet: turn AI Repair off.');
    expect(runner.tcpConnections).toBe(0);
  });

  it('unsigned or tampered desktop steps are script_untrusted; a runner failure is a run error item', async () => {
    runner = await FakeRunner.start();
    const eng = fakeEngine(() => scriptOk());
    const creds = { rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } };
    const tampered = { ...params(DESKTOP_STEPS), steps: { ...DESKTOP_STEPS, app: { exe: 'Other.exe' } } };
    const [bad] = await executeRunSteps(ctx(creds, tampered), eng);
    expect(details(bad[0].json)).toMatchObject({ code: 'script_untrusted', lane: 'script' });
    expect(runner.tcpConnections).toBe(0);
    const missing = { ...DESKTOP_STEPS, steps: [{ intent: 'Click Help', click: uia('btnHelp', 'Button'), timeoutMs: 300 }] };
    const [drift] = await executeRunSteps(ctx(creds, params(missing)), eng);
    expect(drift[0].json.error).toBe('drift_detected: Click Help: no element matched Button #btnHelp in window "ERP Demo - Sign in"');
    expect(details(drift[0].json)).toMatchObject({ code: 'drift_detected', lane: 'script', stepIntent: 'Click Help', submitted: false });
  });
});

describe('desktop steps elsewhere in the node', () => {
  it('Sign Steps refuses desktop steps that were not reviewed as they are (a crafted digest, a base version)', async () => {
    const { executeSignSteps } = await import('../nodes/Playwright/operations/signSteps.js');
    const item = { name: 'erp-orders', baseVersion: 1, version: 2, steps: DESKTOP_STEPS, hash: engine.scriptHash(DESKTOP_STEPS), digest: 'd'.repeat(64), safetyFlags: [], changes: [], evidence: { count: 0, total: null, diff: { missing: [], extra: [] } } };
    const p = { operation: 'signSteps', approved: true, approverId: APPROVER, approverAllowlist: APPROVER };
    const out = await executeSignSteps(harness({ params: p, items: [{ json: item }], credentials: { playwrightScriptSigningApi: { secretKey: KEY } }, continueOnFail: true }), engine);
    const error = String(out[0][0].json.error);
    expect(error).toContain('the repaired steps changed after they were reviewed');
    expect(error).toContain('a desktop proposal must be a first version');
    expect(error).toContain('the safety flags do not list the app');
  });

  it('Run Steps with desktop steps refuses configured row checks', async () => {
    runner = await FakeRunner.start();
    const p = params(DESKTOP_STEPS);
    const [data] = await executeRunSteps(ctx({ rpaDesktopRunnerApi: { ...runner.endpoint }, playwrightScriptSigningApi: { secretKey: KEY } }, { ...p, options: { ...(p.options as object), idPattern: 'ORD-\\d+' } }), fakeEngine(() => scriptOk()));
    expect(data[0].json.error).toBe('Row checks (ID Pattern, Stated Total Pattern, Required Fields, Text That Means No Results) do not apply to desktop steps: clear them.');
    expect(runner.tcpConnections).toBe(0);
  });
});
