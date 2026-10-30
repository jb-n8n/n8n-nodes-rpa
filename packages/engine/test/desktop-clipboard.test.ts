// Clipboard reads in desktop step sets: `read: { clipboard: true, as }` calls the runner's policy-gated clipboard.read,
// for apps whose value is only available through a Copy button (a desktop authenticator app built on a web view). The
// value goes to the run outputs (Data values) under its name and is masked everywhere else: the log, messages, views.
import { afterEach, describe, expect, it } from 'vitest';
import { checkDesktopTrust, runDesktopTask, type DesktopTaskInput, type DesktopTaskResult } from '../src/desktop/task.js';
import { RUNNER_TOO_OLD_FOR_CLIPBOARD } from '../src/messages.js';
import { describeDesktopStep, desktopSafetyFlags, desktopStepChanges } from '../src/proposal/desktop.js';
import { signScript, verifyScript } from '../src/sign.js';
import { parseDesktopScript, ScriptShapeError } from '../src/steps/parse.js';
import type { DesktopLocator } from '../src/types.js';
import { AUTH_CODES, AUTH_EXE, AUTH_POLICY, AUTH_USER, FakeRunner, MAX_CLIPBOARD_CHARS, type FakeRunnerOptions } from './fake-runner.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const WHO = 'ops@example.com';
const CODE = AUTH_CODES[AUTH_USER];
const byName = (controlType: string, name: string): DesktopLocator => ({ uia: { path: [{ controlType, name }] } });
const doc = (steps: unknown[]) => ({ surface: 'desktop', name: 'authenticator-code', version: 1, app: { exe: AUTH_EXE }, steps });

const SEARCH = { intent: 'Search for the account', fill: { field: byName('Edit', 'Search'), value: '{{var.account}}' } };
const COPY = { intent: 'Copy the code', click: byName('Button', `Copy (${AUTH_USER})`) };
const READ = { intent: 'Read the code', read: { clipboard: true, as: 'code' } };
const CODE_STEPS = doc([SEARCH, COPY, READ]);

const issuesOf = (raw: unknown): string[] => {
  try {
    parseDesktopScript(raw);
  } catch (err) {
    if (err instanceof ScriptShapeError) return err.issues;
    throw err;
  }
  return [];
};

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});

const signed = (d: unknown) => ({ required: true, signature: signScript(d, KEY, { approvedBy: WHO }).signature, approvedBy: WHO, key: KEY });
async function run(d: unknown, opts: FakeRunnerOptions = {}, more: Partial<DesktopTaskInput> = {}): Promise<DesktopTaskResult> {
  runner ??= await FakeRunner.start({ app: 'authenticator', policy: AUTH_POLICY, ...opts });
  return runDesktopTask({ script: d, trust: signed(d), runner: runner.endpoint, vars: { account: AUTH_USER }, defaultStepTimeoutMs: 1000, ...more });
}
const failed = (r: DesktopTaskResult) => {
  if (r.ok) throw new Error('expected a failure');
  return r;
};
const succeeded = (r: DesktopTaskResult) => {
  if (!r.ok) throw new Error(`expected success, got ${r.code}: ${r.message}`);
  return r;
};

describe('desktop clipboard reads: the step format', () => {
  it('parses read { clipboard: true, as } without a target, and signs and verifies it', () => {
    const parsed = parseDesktopScript(CODE_STEPS);
    expect(parsed.steps[2]).toEqual(READ);
    expect(parsed.steps[2]).not.toBe(READ);
    const { signature } = signScript(CODE_STEPS, KEY, { approvedBy: WHO });
    expect(verifyScript(CODE_STEPS, KEY, { approvedBy: WHO, signature })).toBe(true);
    expect(checkDesktopTrust(CODE_STEPS, signed(CODE_STEPS))).toEqual({ ok: true, signed: true });
    // The flag is part of what is signed: a target read in its place does not verify.
    const swapped = doc([SEARCH, COPY, { intent: 'Read the code', read: { target: byName('Button', `Copy (${AUTH_USER})`), as: 'code' } }]);
    expect(verifyScript(swapped, KEY, { approvedBy: WHO, signature })).toBe(false);
  });

  it('refuses a clipboard read that is not exactly { clipboard: true, as }', () => {
    const target = byName('Text', 'Code');
    const read = (v: unknown, more: Record<string, unknown> = {}) => issuesOf(doc([{ intent: 'Read', read: v, ...more }]));
    expect(read({ clipboard: false, as: 'code' })).toEqual(['steps[0].read.clipboard must be true (or leave it out and give a target)']);
    expect(read({ clipboard: 'yes', as: 'code' })).toEqual(['steps[0].read.clipboard must be true (or leave it out and give a target)']);
    expect(read({ clipboard: true, target, as: 'code' })).toEqual(['steps[0].read needs either a target or clipboard: true, not both']);
    expect(read({ as: 'code' })).toEqual(['steps[0].read needs either a target or clipboard: true, not both']);
    expect(read({ clipboard: true })).toEqual(['steps[0].read.as must be a name of letters, digits and underscores (at most 64)']);
    expect(read({ clipboard: true, as: 'code', window: { exe: AUTH_EXE } })).toEqual(['steps[0].read has unknown key "window"']);
    expect(read({ clipboard: true, as: 'code' }, { write: true })).toEqual(['steps[0].write is only allowed on click, fill, select, check and key steps']);
    // Its name shares the read names: one name, one value.
    expect(issuesOf(doc([{ intent: 'Read', read: { target, as: 'code' } }, READ]))).toEqual(['steps[1].read.as "code" is already used by an earlier read step']);
  });

  it('the reviewer sees the clipboard read in the change list and the safety flags', () => {
    const parsed = parseDesktopScript(CODE_STEPS);
    expect(describeDesktopStep(parsed.steps[2])).toBe('Read the code (read the clipboard as "code")');
    expect(desktopStepChanges(parsed).map((c) => c.now)[2]).toBe('Read the code (read the clipboard as "code")');
    expect(desktopSafetyFlags(parsed)).toEqual([
      'desktop app: "Authenticator.exe"',
      'clipboard read: step 3 (Read the code) returns the clipboard\'s text to n8n as "code" (the desktop runner allows it only when its policy sets clipboardRead, and only while the run\'s window is in front)',
    ]);
  });
});

describe('desktop clipboard reads on the fake runner', () => {
  it('reads an authenticator code through a web view helper and the clipboard, into Data values only', async () => {
    const r = succeeded(await run(CODE_STEPS));
    expect(r.outputs.map((o) => [o.index, o.verb, o.as, o.text])).toEqual([[2, 'read', 'code', CODE]]);
    // The log and everything else in the result show it masked.
    expect(r.log.map((e) => e.status)).toEqual(['ok', 'ok', 'ok']);
    expect(r.log[2].output).toEqual({ text: '[secret]' });
    const { outputs: _outputs, ...rest } = r;
    expect(JSON.stringify(rest)).not.toContain(CODE);
    // One clipboard.read with this run's id and nothing else.
    const reads = runner!.requests.filter((q) => q.method === 'clipboard.read');
    expect(reads).toEqual([{ method: 'clipboard.read', params: { runId: runner!.requests[1].params.runId } }]);
    expect(runner!.methods().indexOf('clipboard.read')).toBeGreaterThan(runner!.methods().lastIndexOf('act'));
  });

  it('a later failure never shows the clipboard value, even from a runner that echoes it', async () => {
    const d = doc([SEARCH, COPY, READ, { intent: 'Open settings', click: byName('Button', 'Settings'), timeoutMs: 300 }]);
    const r = failed(await run(d, { echoTypedInErrors: true }));
    expect(r.code).toBe('drift_detected');
    expect(r.message).toContain('clipboard: [secret]');
    expect(JSON.stringify(r)).not.toContain(CODE);
    expect(r.log[2].output).toEqual({ text: '[secret]' });
  });

  it('a value that contains a typed variable value keeps that part masked in Data values', async () => {
    runner = await FakeRunner.start({ app: 'authenticator', policy: AUTH_POLICY });
    const d = doc([SEARCH, READ]);
    runner.clipboard = `${AUTH_USER} 445 120`;
    const r = succeeded(await run(d));
    expect(r.outputs.map((o) => [o.as, o.text])).toEqual([['code', '[secret] 445 120']]);
  });

  it('is policy_violation when the runner policy does not set clipboardRead, and the code never leaves the runner', async () => {
    const r = failed(await run(CODE_STEPS, { policy: { ...AUTH_POLICY, clipboardRead: false } }));
    expect({ code: r.code, message: r.message }).toEqual({
      code: 'policy_violation', message: 'Read the code: policy_refused: reading the clipboard is off in the runner\'s policy (clipboardRead)',
    });
    expect(runner!.clipboard).toBe(CODE);
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it('is policy_violation while another application holds the foreground', async () => {
    runner = await FakeRunner.start({ app: 'authenticator', policy: AUTH_POLICY });
    runner.foregroundElsewhere = true;
    const r = failed(await run(CODE_STEPS));
    expect(r.code).toBe('policy_violation');
    expect(r.message).toBe('Read the code: policy_refused: the clipboard is read only while a window of the run holds the foreground, and a window of "notepad.exe" holds it');
  });

  it('refuses more than the runner\'s 1000 characters', async () => {
    runner = await FakeRunner.start({ app: 'authenticator', policy: AUTH_POLICY });
    runner.clipboard = '7'.repeat(MAX_CLIPBOARD_CHARS + 1);
    const r = failed(await run(doc([READ])));
    expect(r.code).toBe('policy_violation');
    expect(r.message).toContain('more than 1000 characters');
  });

  it('without helperProcesses in the policy, the web view\'s elements are another application\'s: drift', async () => {
    const { helperProcesses: _helpers, ...policy } = AUTH_POLICY;
    const r = failed(await run(CODE_STEPS, { policy }));
    expect(r.code).toBe('drift_detected');
    expect(r.message).toContain('Search for the account: no element matched Edit "Search"');
    expect(runner!.methods()).not.toContain('clipboard.read');
  });

  it('a web view helper some other program started never counts as the run\'s', async () => {
    const r = failed(await run(CODE_STEPS, { helperOutsideRun: true }));
    expect(r.code).toBe('drift_detected');
    expect(runner!.clipboard).toBeUndefined();
  });

  it('a runner older than clipboard.read is runner_unavailable with a clear message', async () => {
    const r = failed(await run(CODE_STEPS, { noClipboardMethod: true }));
    expect({ code: r.code, message: r.message }).toEqual({ code: 'runner_unavailable', message: `Read the code: ${RUNNER_TOO_OLD_FOR_CLIPBOARD}` });
  });
});
