// Run Steps → Options → One-Time Code Workflow: the engine's codeProvider runs that n8n workflow and takes the code from
// its single output item. The code never reaches the node's output, logs or errors.
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecuteWorkflowData, IExecuteWorkflowInfo, INodeExecutionData } from 'n8n-workflow';
import { WORKFLOW_CODE, type Script } from 'n8n-rpa-engine';
import { resetGuardsForTests } from '../nodes/Playwright/guard.js';
import { codeProviderFor, ONE_TIME_CODE } from '../nodes/Playwright/operations/codeWorkflow.js';
import { executeRunSteps } from '../nodes/Playwright/operations/runSteps.js';
import { readRunStepsParams } from '../nodes/Playwright/operations/runStepsParams.js';
import { optionsProperty } from '../nodes/Playwright/description/options.js';
import { fakeEngine, scriptOk, taskFail } from './fake-engine.js';
import { harness, type HarnessOptions } from './harness.js';

afterEach(() => resetGuardsForTests());

const CODE = '482913';
const BROWSER = { mode: 'playwright', wsUrl: 'wss://browser.example.net/pw', token: 'tok-1' };
const CREDS = {
  playwrightBrowserApi: BROWSER,
  playwrightSiteLoginApi: { loginUrl: 'https://example.com/login', username: 'user-1', password: 'pass-1' },
};
const STEPS: Script = {
  name: 'items', version: 1, startUrl: 'https://example.com/login',
  steps: [{
    intent: 'Sign in',
    signIn: {
      username: { label: 'User' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' }, source: 'workflow' },
    },
  }],
};
const params = (options: Record<string, unknown> = {}) => ({
  operation: 'runSteps', steps: STEPS, startUrl: '', requireSignedSteps: false, signature: '', approvedBy: '', aiRepair: false, goal: '',
  options: { saveTrace: 'never', allowUnsignedWrites: true, ...options },
});

type Sub = (info: IExecuteWorkflowInfo, items: INodeExecutionData[] | undefined) => Promise<ExecuteWorkflowData>;
const returning = (items: INodeExecutionData[]): Sub => async () => ({ executionId: 'sub-1', data: [items] });
function ctx(sub: Sub, over: Partial<HarnessOptions> = {}) {
  const calls: { info: IExecuteWorkflowInfo; items: INodeExecutionData[] | undefined }[] = [];
  const h = harness({
    params: params({ codeWorkflowId: 'wf-code-1' }), credentials: CREDS, credentialIds: { playwrightBrowserApi: 'b-1', playwrightSiteLoginApi: 's-1' },
    executeWorkflow: async (info, items) => { calls.push({ info, items }); return sub(info, items); },
    ...over,
  });
  return { h, calls };
}

describe('One-Time Code Workflow options', () => {
  it('are Run Steps and Import Steps options with the documented names and defaults', () => {
    const opts = optionsProperty.options as { name: string; displayName: string; default: unknown; type: string; displayOptions?: unknown }[];
    const wf = opts.find((o) => o.name === 'codeWorkflowId');
    const timeout = opts.find((o) => o.name === 'codeTimeout');
    // n8n's workflow selector, as its Execute Workflow node uses: by list or by ID, never an expression.
    expect(wf).toMatchObject({
      displayName: 'One-Time Code Workflow', type: 'workflowSelector', default: '', noDataExpression: true, displayOptions: { show: { '/operation': ['runSteps', 'importSteps'] } },
    });
    expect(wf).not.toHaveProperty('placeholder');
    expect(wf).toMatchObject({
      description: 'The workflow that returns the sign-in\'s one-time code when the sign-in takes it from a workflow ("source": "workflow"). It starts with an Execute Workflow Trigger, gets requestedAt and returns one item whose code field holds 6 to 10 digits; publish it first. In Import Steps, a recorded sign-in then takes its code from it (a step document sets "source" itself); give Run Steps the same workflow. Must be set directly, not with an expression.',
    });
    expect(timeout).toMatchObject({ displayName: 'Code Timeout (Seconds)', type: 'number', default: 120, displayOptions: { show: { '/operation': ['runSteps', 'importSteps'] } } });
  });

  it('are read with their defaults: no workflow, 120 s', () => {
    const p = readRunStepsParams(harness({ params: params(), credentials: CREDS }), 0);
    expect(p).toMatchObject({ codeWorkflowId: '', codeTimeoutMs: 120_000 });
    const set = readRunStepsParams(harness({ params: params({ codeWorkflowId: '  wf-9 ', codeTimeout: 30 }), credentials: CREDS }), 0);
    expect(set).toMatchObject({ codeWorkflowId: 'wf-9', codeTimeoutMs: 30_000 });
  });

  it('a workflow picked from the list or by ID, and a plain ID saved before the picker, all give the same workflow ID', () => {
    const read = (codeWorkflowId: unknown) => readRunStepsParams(harness({ params: params({ codeWorkflowId }), credentials: CREDS }), 0).codeWorkflowId;
    expect(read({ __rl: true, mode: 'list', value: 'wf-code-1', cachedResultName: 'Read the code' })).toBe('wf-code-1');
    expect(read({ __rl: true, mode: 'id', value: ' wf-code-1 ' })).toBe('wf-code-1');
    expect(read('wf-code-1')).toBe('wf-code-1');
    expect(read({ __rl: true, mode: 'list', value: '' })).toBe('');
  });

  it('an expression is refused, in the picker\'s value or as a plain value, before anything runs', async () => {
    for (const codeWorkflowId of [{ __rl: true, mode: 'id', value: '={{ $json.workflow }}' }, '={{ $json.workflow }}', { value: 'wf-code-1' }]) {
      const engine = fakeEngine(() => scriptOk());
      const [data] = await executeRunSteps(harness({
        params: params({ codeWorkflowId }), credentials: CREDS, credentialIds: { playwrightBrowserApi: 'b-1', playwrightSiteLoginApi: 's-1' }, continueOnFail: true,
      }), engine);
      expect(data[0].json.error, JSON.stringify(codeWorkflowId)).toBe('One-Time Code Workflow must be set directly, not with an expression.');
      expect(engine.calls).toHaveLength(0);
    }
  });

  it('a workflow picked from the list is the one the code provider runs', async () => {
    const { h, calls } = ctx(returning([{ json: { code: CODE } }]), { params: params({ codeWorkflowId: { __rl: true, mode: 'list', value: 'wf-code-7', cachedResultName: 'Code' } }) });
    const engine = fakeEngine(async (input) => { await input.codeProvider!({ requestedAt: '2026-10-30T10:00:00.000Z' }); return scriptOk(); });
    await executeRunSteps(h, engine);
    expect(calls.map((c) => c.info)).toEqual([{ id: 'wf-code-7' }]);
  });

  it('without a workflow the engine gets no codeProvider (it refuses steps that need one)', async () => {
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(harness({ params: params(), credentials: CREDS, credentialIds: { playwrightBrowserApi: 'b-1', playwrightSiteLoginApi: 's-1' } }), engine);
    expect(engine.calls[0].codeProvider).toBeUndefined();
    expect(engine.calls[0].codeTimeoutMs).toBeUndefined();
  });

  it('the engine refusing steps that need a code workflow is a configuration error item', async () => {
    const message = 'the sign-in takes its one-time code from a workflow, but no One-Time Code Workflow is set (Options → One-Time Code Workflow)';
    const engine = fakeEngine(() => taskFail('policy_violation', message, { configError: true }));
    const [data] = await executeRunSteps(harness({
      params: params(), credentials: CREDS, credentialIds: { playwrightBrowserApi: 'b-1', playwrightSiteLoginApi: 's-1' }, continueOnFail: true,
    }), engine);
    expect(data[0].json).toMatchObject({ error: message, details: { configError: true, code: null } });
  });

  it('with a workflow the engine gets a codeProvider that runs it with { requestedAt } and returns its code', async () => {
    const { h, calls } = ctx(returning([{ json: { code: CODE, extra: 'dropped' } }]));
    let got = '';
    const engine = fakeEngine(async (input) => {
      got = await input.codeProvider!({ requestedAt: '2026-10-30T10:00:00.000Z' });
      return scriptOk();
    });
    await executeRunSteps(h, engine);
    expect(engine.calls[0].codeTimeoutMs).toBe(120_000);
    expect(got).toBe(CODE);
    expect(calls).toEqual([{ info: { id: 'wf-code-1' }, items: [{ json: { requestedAt: '2026-10-30T10:00:00.000Z' } }] }]);
  });

  it('Code Timeout (Seconds) reaches the engine in ms', async () => {
    const { h } = ctx(returning([{ json: { code: CODE } }]), { params: params({ codeWorkflowId: 'wf-code-1', codeTimeout: 45 }) });
    const engine = fakeEngine(() => scriptOk());
    await executeRunSteps(h, engine);
    expect(engine.calls[0].codeTimeoutMs).toBe(45_000);
  });

  it('the code never reaches the node output', async () => {
    const { h } = ctx(returning([{ json: { code: CODE } }]));
    const engine = fakeEngine(async (input) => {
      await input.codeProvider!({ requestedAt: new Date().toISOString() });
      return scriptOk();
    });
    const [data] = await executeRunSteps(h, engine);
    expect(data).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(CODE);
  });
});

describe('codeProviderFor', () => {
  const ask = (sub: Sub) => codeProviderFor(ctx(sub).h, 'wf-code-1')({ requestedAt: '2026-10-30T10:00:00.000Z' });

  it('checks the code with the engine\'s pattern', () => {
    expect(ONE_TIME_CODE.source).toBe(WORKFLOW_CODE.source);
  });

  it('accepts a code with spaces, and a number', async () => {
    await expect(ask(returning([{ json: { code: '482 913' } }]))).resolves.toBe('482 913');
    await expect(ask(returning([{ json: { code: 48291377 } }]))).resolves.toBe('48291377');
  });

  it('requires exactly one item', async () => {
    await expect(ask(returning([]))).rejects.toThrow('it returned 0 items; it must return exactly one item with a code field');
    await expect(ask(returning([{ json: { code: CODE } }, { json: { code: CODE } }]))).rejects.toThrow(
      'it returned 2 items; it must return exactly one item with a code field',
    );
    await expect(ask(async () => ({ executionId: 'sub-1', data: [] }))).rejects.toThrow('it returned 0 items');
    await expect(ask(async () => ({ executionId: 'sub-1', data: [null] }))).rejects.toThrow('it returned 0 items');
  });

  it('requires a code field of 6 to 10 digits, and never repeats the value it got', async () => {
    for (const code of [undefined, '', 'abc123', '12345', '12345678901', { v: CODE }, `${CODE}x`, '      ', '12 34 5', '1 2 3 4 5']) {
      const err = await ask(returning([{ json: { code } as never }])).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('its item has no code field of 6 to 10 digits');
    }
  });

  it('a failing workflow: its first line, with every long number removed', async () => {
    const err = await ask(async () => { throw new Error(`Node "Parse" failed on ${CODE} and 1234\nstack line 5678901`); }).catch((e: Error) => e);
    expect((err as Error).message).toBe('it stopped with an error: Node "Parse" failed on [number] and [number]');
  });

  it('a workflow n8n will not run because it is not published says so, with n8n\'s words in brackets', async () => {
    const err = await ask(async () => { throw new Error('Workflow is not active and cannot be executed.'); }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'it is not published: open the workflow set in Options → One-Time Code Workflow and click Publish (Workflow is not active and cannot be executed.)',
    );
  });

  it('another "not active" error is not taken for an unpublished workflow', async () => {
    const err = await ask(async () => { throw new Error('Account is not active'); }).catch((e: Error) => e);
    expect((err as Error).message).toBe('it stopped with an error: Account is not active');
  });

  it('a failing workflow: digit groups with spaces in them are removed too', async () => {
    const err = await ask(async () => { throw new Error('Node "Parse" failed on 482 913 and 12 34 56, item 7'); }).catch((e: Error) => e);
    expect((err as Error).message).toBe('it stopped with an error: Node "Parse" failed on [number] and [number], item 7');
    const short = await ask(async () => { throw new Error('code 123 456 was refused'); }).catch((e: Error) => e);
    expect((short as Error).message).toBe('it stopped with an error: code [number] was refused');
  });
});
