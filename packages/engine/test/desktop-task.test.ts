import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRunner } from '../src/desktop/client.js';
import { createDesktopSurface } from '../src/desktop/surface.js';
import { runDesktopTask, type DesktopTaskInput, type DesktopTaskResult } from '../src/desktop/task.js';
import { CANCELLED } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { DESKTOP_STEPS_NEED_RUNNER, RUNNER_BUSY, UNSIGNED_REQUIRED, desktopNotInteractive } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { signScript } from '../src/sign.js';
import type { DesktopLocator } from '../src/types.js';
import { DEMO_PASSWORD, DEMO_USER, FakeRunner } from './fake-runner.js';
import { selfSignedCert } from './fake-runner-cert.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const WHO = 'ops@example.com';
const uia = (automationId: string, controlType = 'Edit'): DesktopLocator => ({ uia: { path: [{ controlType, automationId }] } });
const inSaveAs = (automationId: string, controlType: string): DesktopLocator => ({ uia: { window: { title: 'Save As' }, path: [{ controlType, automationId }] } });
const VARS = { user: DEMO_USER, password: DEMO_PASSWORD, customer: 'ACME' };

const SIGN_IN = [
  { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
  { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
  { intent: 'Sign in', click: uia('btnSignIn', 'Button'), expect: { visible: uia('txtSearch') } },
];
const doc = (steps: unknown[], more: Record<string, unknown> = {}) => ({ surface: 'desktop', name: 'erp-orders', version: 1, app: { exe: 'ErpDemo.exe' }, steps, ...more });

/** The end-to-end step set: launch, sign in, search, read, export into {{$exportDir}}, return the CSV. */
const E2E = doc([
  ...SIGN_IN,
  { intent: 'Search for the customer', fill: { field: uia('txtSearch'), value: '{{var.customer}}' } },
  { intent: 'Run the search', key: { key: 'Enter', target: uia('txtSearch') } },
  { intent: 'Wait for the first row', waitFor: { target: { uia: { path: [{ controlType: 'DataGrid', automationId: 'gridResults' }, { controlType: 'DataItem', index: 0 }] } } } },
  { intent: 'Read the count', read: { target: uia('lblCount', 'Text'), as: 'count' } },
  { intent: 'Read the grid', read: { target: uia('gridResults', 'DataGrid'), as: 'orders' } },
  { intent: 'Open Export', click: uia('btnExport', 'Button') },
  { intent: 'Type the file name', fill: { field: inSaveAs('1001', 'Edit'), value: '{{$exportDir}}\\orders.csv' } },
  { intent: 'Save', click: inSaveAs('1', 'Button') },
  { intent: 'Return the CSV', expectFile: { pattern: '^orders\\.csv$', check: { columns: ['Order', 'Customer'], minRows: 2 } } },
]);

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const signed = (d: unknown) => ({ required: true, signature: signScript(d, KEY, { approvedBy: WHO }).signature, approvedBy: WHO, key: KEY });
async function run(d: unknown, more: Partial<DesktopTaskInput> = {}, opts: ConstructorParameters<typeof FakeRunner>[0] = {}): Promise<DesktopTaskResult> {
  runner ??= await FakeRunner.start(opts);
  return runDesktopTask({ script: d, trust: signed(d), runner: runner.endpoint, vars: VARS, defaultStepTimeoutMs: 2000, ...more });
}
const failed = (r: DesktopTaskResult) => {
  if (r.ok) throw new Error('expected a failure');
  return r;
};
const succeeded = (r: DesktopTaskResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r;
};

describe('desktop task: end to end on the fake runner', () => {
  it('launches, signs in, searches, reads, exports into {{$exportDir}} and returns the CSV as the step\'s file', async () => {
    const r = succeeded(await run(E2E));
    expect(r.lane).toBe('script');
    expect(r).toMatchObject({ name: 'erp-orders', version: 1, rows: [], verified: false, confirmed: false, submitted: false, violations: [], blockedRequests: [] });
    expect(r.page).toEqual({ url: 'desktop://ErpDemo.exe/ERP Demo - Orders', title: 'ERP Demo - Orders', status: null });
    expect(r.log.map((e) => e.status)).toEqual(Array(12).fill('ok'));
    expect(r.outputs.map((o) => [o.index, o.verb, o.as, o.text])).toEqual([
      [6, 'read', 'count', '2 results'],
      [7, 'read', 'orders', 'ORD-1001\tACME\tOpen\t120.00\nORD-1002\tACME\tClosed\t75.50'],
    ]);
    expect(r.files).toHaveLength(1);
    const [file] = r.files;
    expect({ fileName: file.fileName, mimeType: file.mimeType, binaryName: file.binaryName, facts: file.facts }).toEqual({
      fileName: 'orders.csv', mimeType: 'text/csv', binaryName: 'file_11', facts: { columns: ['Order', 'Customer', 'Status', 'Amount'], rows: 2 },
    });
    expect(file.data.toString()).toBe('Order,Customer,Status,Amount\nORD-1001,ACME,Open,120.00\nORD-1002,ACME,Closed,75.50\n');
    expect(r.log[11].output).toEqual({ binary: 'file_11' });

    // The protocol, in order: hello, run.begin, app.launch, the steps, run.end.
    const methods = runner!.methods();
    expect(methods.slice(0, 3)).toEqual(['hello', 'run.begin', 'app.launch']);
    expect(methods.at(-1)).toBe('run.end');
    const runId = runner!.requests[1].params.runId;
    expect(runner!.requests.slice(2).every((q) => q.params.runId === runId)).toBe(true);
    // The export path goes as segments: the runner fills the marker; the text stays text.
    const saveAs = runner!.requests.find((q) => q.method === 'act' && (q.params.target as { path: { automationId?: string }[] }).path[0].automationId === '1001');
    expect(saveAs?.params).toMatchObject({ action: 'type', segments: [{ exportDir: true }, { text: '\\orders.csv' }], mode: 'step' });
    expect(saveAs?.params).not.toHaveProperty('write');
    // run.end released the runner and deleted the export directory.
    expect(runner!.run).toBeUndefined();
    expect(existsSync(runner!.lastExportDir!)).toBe(false);
    // No typed secret in the result (the file aside, which is the app's data).
    const { files: _files, ...rest } = r;
    expect(JSON.stringify(rest)).not.toContain(DEMO_PASSWORD);
  });

  it('a variable whose value reads {{$exportDir}} stays literal text', async () => {
    const d = doc([{ intent: 'Type', fill: { field: uia('txtUser'), value: 'x{{var.user}}{{$exportDir}}' } }]);
    succeeded(await run(d, { vars: { user: '{{$exportDir}}' } }));
    const act = runner!.requests.find((q) => q.method === 'act');
    expect(act?.params.segments).toEqual([{ text: 'x{{$exportDir}}' }, { exportDir: true }]);
  });
});

describe('desktop task: each handler', () => {
  it('select, check (on and off), key, read and waitFor drive the app', async () => {
    const search = (n: number) => ({ intent: `Search ${n}`, click: uia('btnSearch', 'Button') });
    const count = (as: string) => ({ intent: `Read ${as}`, read: { target: uia('lblCount', 'Text'), as } });
    const d = doc([
      ...SIGN_IN,
      { intent: 'Status Closed', select: { field: uia('cmbStatus', 'ComboBox'), option: 'Closed' } },
      search(1), count('closed'),
      { intent: 'Open only', check: { field: uia('chkOpenOnly', 'CheckBox') } },
      search(2), count('closedOpen'),
      { intent: 'Not open only', check: { field: uia('chkOpenOnly', 'CheckBox'), checked: false } },
      { intent: 'Search by key', key: { key: 'Enter', target: uia('txtSearch') } },
      count('again'),
      { intent: 'Sign-in button gone', waitFor: { target: uia('btnSignIn', 'Button'), state: 'hidden' } },
    ]);
    const r = succeeded(await run(d));
    expect(Object.fromEntries(r.outputs.map((o) => [o.as, o.text]))).toEqual({ closed: '1 results', closedOpen: '0 results', again: '1 results' });
    const acts = runner!.requests.filter((q) => q.method === 'act').map((q) => [q.params.action, q.params.value ?? null]);
    expect(acts).toContainEqual(['select', 'Closed']);
    expect(acts).toContainEqual(['check', null]);
    expect(acts).toContainEqual(['uncheck', null]);
    expect(acts).toContainEqual(['key', 'Enter']);
    // Each acting step resolves first (the log keeps the candidate), then acts.
    expect(r.log.find((e) => e.intent === 'Status Closed')?.candidate).toBe(0);
  });

  it('a fallback that matches is used and logged as its candidate number; when and optional skip', async () => {
    const d = doc([
      { intent: 'Type via fallback', fill: { field: { ...uia('txtUserOld'), fallbacks: [uia('txtUser')] }, value: 'someone' } },
      { intent: 'Only on the main window', click: uia('btnSearch', 'Button'), when: { visible: uia('txtSearch') } },
      { intent: 'Optional and missing', click: uia('btnHelp', 'Button'), optional: true, timeoutMs: 300 },
    ]);
    const r = succeeded(await run(d));
    expect(r.log.map((e) => [e.status, e.candidate ?? null, e.note ?? null])).toEqual([
      ['ok', 1, null],
      ['skipped', null, 'condition not met'],
      ['skipped', null, 'no element matched Button #btnHelp in window "ERP Demo - Sign in"'],
    ]);
  });

  it('expectFile fails as incomplete when the app saved outside the export directory', async () => {
    const d = doc([
      ...SIGN_IN,
      { intent: 'Open Export', click: uia('btnExport', 'Button') },
      { intent: 'Type the file name', fill: { field: inSaveAs('1001', 'Edit'), value: 'C:\\Users\\bot\\orders.csv' } },
      { intent: 'Save', click: inSaveAs('1', 'Button') },
      { intent: 'Return the CSV', expectFile: { pattern: '^orders\\.csv$' }, timeoutMs: 300 },
    ]);
    const r = failed(await run(d));
    expect({ code: r.code, message: r.message, index: r.failure?.index }).toEqual({
      code: 'incomplete', message: 'Return the CSV: no file matching the pattern in the export directory', index: 6,
    });
  });

  it('the surface snapshot maps runner nodes to refs and never shows a password value', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await client.call('run.begin', { runId: 'snap', leaseMs: 5000 });
    await client.call('app.launch', { runId: 'snap', app: { exe: 'ErpDemo.exe' } });
    const surface = createDesktopSurface(client, 'snap', { exe: 'ErpDemo.exe' });
    await surface.rpc('act', { target: { path: [{ automationId: 'txtUser' }] }, action: 'type', segments: [{ text: 'someone' }], timeoutMs: 1000 });
    await surface.rpc('act', { target: { path: [{ automationId: 'txtPassword' }] }, action: 'type', segments: [{ text: DEMO_PASSWORD }], timeoutMs: 1000 });
    const snap = await surface.snapshot(createMasker([]), { refStart: 5 });
    expect(snap.url).toBe('desktop://ErpDemo.exe/ERP Demo - Sign in');
    expect(snap.elements.map((e) => [e.ref, e.role, e.name, e.value ?? null, e.valueHidden ?? null])).toEqual([
      ['e5', 'Window', 'ERP Demo - Sign in', null, null],
      ['e6', 'Edit', 'User name', 'someone', null],
      ['e7', 'Edit', 'Password', null, true],
      ['e8', 'Button', 'Sign in', null, null],
    ]);
    expect(snap.nextRef).toBe(9);
    expect(surface.refs.get('e7')).toBe('r2');
    expect(JSON.stringify(snap)).not.toContain(DEMO_PASSWORD);
    expect(snap.text).toBe('Window "ERP Demo - Sign in"\n  Edit "User name"\n  Edit "Password"\n  Button "Sign in"');
    expect(await surface.isVisible({ uia: { path: [{ automationId: 'btnSignIn' }] } } as never)).toBe(true);
    await client.call('run.end', { runId: 'snap' });
    await client.close();
  });
});

describe('desktop task: refusals and runner errors', () => {
  it('runner_busy: fails as busy at once with busyWaitMs 0, and waits for the lock otherwise', async () => {
    runner = await FakeRunner.start();
    runner.holdLock();
    const r = failed(await run(doc(SIGN_IN), { busyWaitMs: 0 }));
    expect({ code: r.code, message: r.message }).toEqual({ code: 'busy', message: RUNNER_BUSY });
    expect(runner.methods().filter((m) => m === 'app.launch')).toEqual([]);
    setTimeout(() => { clearTimeout(runner!.run!.timer); runner!.run = undefined; }, 1200);
    succeeded(await run(doc(SIGN_IN), { busyWaitMs: 5000 }));
  });

  it('not_found names the target and the window title; not_unique gives the count', async () => {
    const missing = failed(await run(doc([{ intent: 'Click Help', click: uia('btnHelp', 'Button'), timeoutMs: 300 }])));
    expect({ code: missing.code, message: missing.message }).toEqual({
      code: 'drift_detected', message: 'Click Help: no element matched Button #btnHelp in window "ERP Demo - Sign in"',
    });
    const twice = failed(await run(doc([{ intent: 'Type somewhere', fill: { field: { uia: { path: [{ controlType: 'Edit' }] } }, value: 'x' }, timeoutMs: 300 }])));
    expect({ code: twice.code, message: twice.message }).toEqual({ code: 'drift_detected', message: 'Type somewhere: Edit matches 2 elements' });
    const expectFails = failed(await run(doc([{ intent: 'Sign in', click: uia('btnSignIn', 'Button'), expect: { visible: uia('txtSearch') }, timeoutMs: 300 }])));
    expect({ code: expectFails.code, message: expectFails.message }).toEqual({ code: 'drift_detected', message: 'Sign in: expected UI Automation Edit #txtSearch to be visible within 0.3 s' });
  });

  it('policy_refused: a declared write control or a gated key without the write flag; with a signed write: true it runs', async () => {
    const post = (write: boolean) => doc([...SIGN_IN, { intent: 'Post', click: uia('btnPost', 'Button'), ...(write ? { write: true } : {}) }]);
    const refused = failed(await run(post(false)));
    expect({ code: refused.code, message: refused.message, submitted: refused.submitted }).toEqual({
      code: 'policy_violation', message: 'Post: Button #btnPost is a declared write control: the step must be a declared write', submitted: undefined,
    });
    expect(runner!.lastApp?.posted).toBe(0);
    const ok = succeeded(await run(post(true)));
    expect(ok.submitted).toBe(true);
    expect(runner!.lastApp?.posted).toBe(1);
    expect(runner!.requests.filter((q) => q.method === 'act' && q.params.write === true)).toHaveLength(1);
    const key = failed(await run(doc([...SIGN_IN, { intent: 'Save shortcut', key: { key: 'Ctrl+S' } }])));
    expect({ code: key.code, message: key.message }).toEqual({ code: 'policy_violation', message: 'Save shortcut: the key Ctrl+S needs a declared write step' });
    succeeded(await run(doc([...SIGN_IN, { intent: 'Save shortcut', key: { key: 'Ctrl+S' }, write: true }])));
  });

  it('an app outside the runner policy is refused at launch', async () => {
    const r = failed(await run(doc(SIGN_IN, { app: { exe: 'C:\\Windows\\notepad.exe' } })));
    expect({ code: r.code, message: r.message }).toEqual({ code: 'policy_violation', message: 'app not allowed: notepad.exe' });
    expect(runner!.run).toBeUndefined();
  });

  it('typed values never appear in errors or logs, even from a runner that echoes them', async () => {
    const d = doc([
      { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
      { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
      { intent: 'Sign in', click: uia('btnSignIn', 'Button') },
      { intent: 'Open search', click: uia('txtSearch'), timeoutMs: 300 },
    ]);
    const r = failed(await run(d, { vars: { ...VARS, password: 'Wrong-pw-77' } }, { echoTypedInErrors: true }));
    expect(r.code).toBe('drift_detected');
    expect(r.message).toBe('Open search: no element matched Edit #txtSearch in window "ERP Demo - Sign in" (last typed: [secret])');
    const json = JSON.stringify(r);
    expect(json).not.toContain('Wrong-pw-77');
    expect(json).not.toContain(DEMO_USER);
    expect(runner!.lastApp?.signInFailures).toBe(1);
  });

  it('a locked or non-interactive desktop is runner_unavailable before any run begins', async () => {
    const locked = failed(await run(doc(SIGN_IN), {}, { session: { interactive: true, locked: true } }));
    expect({ code: locked.code, message: locked.message }).toEqual({ code: 'runner_unavailable', message: desktopNotInteractive(true) });
    expect(runner!.methods()).toEqual(['hello']);
  });

  it('a wrong fingerprint is runner_unavailable and the runner sees nothing', async () => {
    runner = await FakeRunner.start();
    const r = failed(await run(doc(SIGN_IN), { runner: { ...runner.endpoint, fingerprint: selfSignedCert().fingerprint } }));
    expect(r.code).toBe('runner_unavailable');
    expect(r.message).toMatch(/presented a certificate with fingerprint .* Nothing was sent\.$/);
    expect(r.configError).toBeUndefined();
    expect(runner.requests).toEqual([]);
    const bad = failed(await run(doc(SIGN_IN), { runner: { ...runner.endpoint, url: 'ws://127.0.0.1:1' } }));
    expect({ code: bad.code, configError: bad.configError }).toEqual({ code: 'runner_unavailable', configError: true });
  });

  it('the trust gate runs before anything connects', async () => {
    runner = await FakeRunner.start();
    const unsigned = failed(await runDesktopTask({ script: E2E, trust: { required: true }, runner: runner.endpoint }));
    expect({ code: unsigned.code, message: unsigned.message }).toEqual({ code: 'script_untrusted', message: UNSIGNED_REQUIRED });
    const tampered = failed(await runDesktopTask({ script: { ...E2E, app: { exe: 'Other.exe' } }, trust: signed(E2E), runner: runner.endpoint }));
    expect(tampered.code).toBe('script_untrusted');
    const browserDoc = { name: 'x', version: 1, startUrl: 'https://example.com/', steps: [{ intent: 'x', click: { role: 'button', name: 'Go' } }] };
    const browser = failed(await runDesktopTask({ script: browserDoc, trust: { required: false }, runner: runner.endpoint }));
    expect(browser.code).toBe('policy_violation');
    expect(runner.tcpConnections).toBe(0);
  });

  it('the run budget and cancellation end the run and free the runner', async () => {
    const slow = doc([{ intent: 'Wait forever', waitFor: { target: uia('neverThere') }, timeoutMs: 60_000 }]);
    const r = failed(await run(slow, { budgetMs: 1000 }));
    expect({ code: r.code, message: r.message }).toEqual({ code: 'incomplete', message: 'run budget of 1000 ms ran out at "Wait forever"' });
    await new Promise((res) => setTimeout(res, 200));
    expect(runner!.run).toBeUndefined();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const c = failed(await run(slow, { signal: abort.signal }));
    expect({ code: c.code, message: c.message }).toEqual({ code: 'incomplete', message: CANCELLED });
  });
});

describe('the browser lane next to desktop step sets', () => {
  it('runTask refuses a desktop step set before any browser opens', async () => {
    const r = await runTask({
      script: E2E, trust: { required: false },
      policy: { startUrl: 'https://example.com/', navHosts: ['example.com'], subresourceHosts: [], login: [], allowedSubmits: [] },
      endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/' },
    });
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', message: `invalid script: ${DESKTOP_STEPS_NEED_RUNNER}` });
  });
});
