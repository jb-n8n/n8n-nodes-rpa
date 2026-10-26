import { describe, expect, it } from 'vitest';
import type { IDataObject, INodeProperties, INodePropertyCollection } from 'n8n-workflow';
import { parseScript, validateScript } from 'n8n-rpa-engine';
import { policyFor } from '../nodes/Playwright/config.js';
import { fillFormProperties, PASSWORD_WARNING, SUBMIT_SCOPE } from '../nodes/Playwright/description/fillForm.js';
import { OPERATIONS, properties } from '../nodes/Playwright/description/index.js';
import { locatorGroupValues } from '../nodes/Playwright/description/locator.js';
import { COMPILERS, compileQuickOp, executeQuickOp, OUTPUTS, quickFieldNames, type QuickParams } from '../nodes/Playwright/operations/quick.js';
import { compileFillForm, fillFormOutput } from '../nodes/Playwright/operations/quick/fillForm.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, BROWSER, failResult, okResult, optionsFor, PAGE_URL, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
const FIELDS = { field: [{ findBy: 'label', label: 'Name', value: 'Ada Lovelace' }, { findBy: 'label', label: 'Message', value: 'Hello there' }] };
const SEND = { locator: { findBy: 'role', role: 'button', roleName: 'Send' } };
const q = (over: IDataObject = {}, options: IDataObject = {}): QuickParams =>
  ({ url: PAGE_URL, waitUntil: 'load', formFields: FIELDS, submitButton: SEND, ...over, options }) as QuickParams;
const THANKS = { url: 'https://example.com/pricing/thanks', title: 'Thanks', status: 200 };
const WRITE = { method: 'POST', host: 'example.com', path: '/pricing/submit' };

describe('compileQuickOp: fillForm', () => {
  it('values travel only as vars; the submit click is at writeStep; the page text is read after it', () => {
    const c = compileQuickOp('fillForm', q());
    expect(c.script.steps).toEqual([
      { intent: 'Open the page', goto: PAGE_URL, waitUntil: 'load' },
      { intent: 'Fill field 1', fill: { field: { label: 'Name' }, value: '{{var.f0}}' } },
      { intent: 'Fill field 2', fill: { field: { label: 'Message' }, value: '{{var.f1}}' } },
      { intent: 'Submit the form', click: { role: 'button', name: 'Send' } },
      { intent: 'Read the page after submit', read: { what: 'text' } },
    ]);
    expect(c.vars).toEqual({ f0: 'Ada Lovelace', f1: 'Hello there' });
    expect(c.writeStep).toBe(3);
    expect(JSON.stringify(c.script)).not.toContain('Ada Lovelace');
    expect(c.output).toBeUndefined();
    assertRunnable(c, 'fillForm');
  });
  it('writeStep still points at the click after a Wait for Element step (compileQuickOp shifts it)', () => {
    const c = compileQuickOp('fillForm', { ...q(), waitFor: { findBy: 'css', css: 'form#contact' } } as QuickParams);
    expect(c.script.steps[1]).toHaveProperty('waitFor');
    expect(c.script.steps[c.writeStep ?? -1]).toEqual({ intent: 'Submit the form', click: { role: 'button', name: 'Send' } });
  });
  it('passes validateScript (load) with the write window on the click, even with a 2,000-character value', () => {
    const long = 'x'.repeat(2000);
    const c = compileQuickOp('fillForm', q({ formFields: { field: [{ findBy: 'label', label: 'Message', value: long }] } }));
    expect(c.vars.f0).toBe(long);
    const base = policyFor({ url: PAGE_URL, allowedHosts: [], allowPrivateNetwork: false, operation: 'fillForm' });
    const policy = { ...base, writeWindow: { step: c.writeStep ?? -1, maxPosts: 3 as const, hosts: [...base.navHosts] } };
    expect(validateScript(parseScript(c.script), { policy, mode: 'load' }).violations).toEqual([]);
  });
  it('a value that looks like a template is still only a var value', () => {
    const c = compileFillForm(q({ formFields: { field: [{ findBy: 'label', label: 'Name', value: '{{var.f1}}' }] } }));
    expect(c.vars).toEqual({ f0: '{{var.f1}}' });
    expect(c.script.steps[0]).toEqual({ intent: 'Fill field 1', fill: { field: { label: 'Name' }, value: '{{var.f0}}' } });
  });
  it('no fields: only the submit click and the read', () => {
    const c = compileFillForm(q({ formFields: {} }));
    expect(c.script.steps.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['click', 'read']);
    expect(c.writeStep).toBe(0);
    expect(c.vars).toEqual({});
  });
  it('configuration errors', () => {
    expect(() => compileFillForm(q({ submitButton: null }))).toThrow('Submit Button needs a value');
    expect(() => compileFillForm(q({ formFields: { field: [{ findBy: 'label', label: '', value: 'x' }] } }))).toThrow('Field 1 needs a value');
  });
  it('a fill found by Test ID or by Visible Text compiles to that locator, the value still a var', () => {
    const c = compileFillForm(q({ formFields: { field: [{ findBy: 'testId', testId: 'name-input', value: 'Ada' }, { findBy: 'text', text: 'Your message', exact: true, value: 'Hi' }] } }));
    expect(c.script.steps.slice(0, 2)).toEqual([
      { intent: 'Fill field 1', fill: { field: { testId: 'name-input' }, value: '{{var.f0}}' } },
      { intent: 'Fill field 2', fill: { field: { text: 'Your message', exact: true }, value: '{{var.f1}}' } },
    ]);
    expect(c.vars).toEqual({ f0: 'Ada', f1: 'Hi' });
  });
  it('a value from an expression: numbers and booleans become text, empty becomes "", an object or array is a configuration error', () => {
    const one = (value: unknown) => compileFillForm(q({ formFields: { field: [{ findBy: 'label', label: 'Name', value }] } }));
    expect(one(42).vars).toEqual({ f0: '42' });
    expect(one(true).vars).toEqual({ f0: 'true' });
    expect(one(null).vars).toEqual({ f0: '' });
    expect(one(undefined).vars).toEqual({ f0: '' });
    expect(() => one({ first: 'Ada' })).toThrow('Field 1 value must be text');
    expect(() => one(['Ada'])).toThrow('Field 1 value must be text');
    const two = { field: [{ findBy: 'label', label: 'Name', value: 'Ada' }, { findBy: 'label', label: 'Message', value: { x: 1 } }] };
    expect(() => compileFillForm(q({ formFields: two }))).toThrow('Field 2 value must be text');
  });
  it('is registered in COMPILERS and OUTPUTS', () => {
    expect(COMPILERS.fillForm).toBe(compileFillForm);
    expect(OUTPUTS.fillForm).toBe(fillFormOutput);
  });
});

describe('executeQuickOp: fillForm (fake engine)', () => {
  const params = quickParams('fillForm', { formFields: FIELDS, submitButton: SEND });
  it('runs with the write window on the submit click, sub-resources from the URL host only, and the values as vars', async () => {
    const engine = fakeEngine(() => okResult());
    await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'fillForm');
    const input = engine.calls[0];
    expect(input.policy).toMatchObject({ navHosts: ['example.com'], subresourceHosts: [], writeMode: 'block', allowedSubmits: [] });
    expect(input.policy.writeWindow).toEqual({ step: 3, maxPosts: 3, hosts: ['example.com'] });
    expect(input.vars).toEqual({ f0: 'Ada Lovelace', f1: 'Hello there' });
    expect(input).toMatchObject({ trust: { required: false }, startStatus: 'report' });
    expect(input.secrets).toBeUndefined();
  });
  it('Also Allow These Sites widen the write hosts', async () => {
    const engine = fakeEngine(() => okResult());
    await executeQuickOp(harness({ params: quickParams('fillForm', { formFields: FIELDS, submitButton: SEND }, { allowedHosts: 'forms.example.net' }), credentials: BROWSER }), engine, 'fillForm');
    expect(engine.calls[0].policy.writeWindow).toEqual({ step: 3, maxPosts: 3, hosts: ['example.com', 'forms.example.net'] });
  });
  it('outputs the envelope plus the page text after submit, submitted and writes, in the documented key order', async () => {
    const engine = fakeEngine(() => okResult({
      page: THANKS, submitted: true, writes: [WRITE], outputs: [{ index: 4, verb: 'read', text: 'Thanks\nReceived from Ada Lovelace: 11 characters' }],
    }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'fillForm');
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0].json)).toEqual(['url', 'title', 'status', 'text', 'submitted', 'writes', 'steps']);
    expect(data[0].json).toMatchObject({ ...THANKS, text: 'Thanks\nReceived from Ada Lovelace: 11 characters', submitted: true, writes: [WRITE] });
    expect(data[0].pairedItem).toEqual([{ item: 0 }]);
  });
  it('a submit that sent no POST (the page handled it) succeeds with submitted: false and writes: []', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [{ index: 4, verb: 'read', text: 'Pricing' }] }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'fillForm');
    expect(data[0].json).toMatchObject({ text: 'Pricing', submitted: false, writes: [] });
    expect(data[0].json).not.toHaveProperty('error');
  });
  it('the write window opens only for Fill and Submit Form, even if another compiler returned a writeStep (defence in depth)', async () => {
    const original = COMPILERS.screenshot;
    COMPILERS.screenshot = (p) => ({ ...(original as NonNullable<typeof original>)(p), writeStep: 0 });
    try {
      const engine = fakeEngine(() => okResult());
      await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot');
      expect(engine.calls).toHaveLength(1);
      expect(engine.calls[0].policy.writeWindow).toBeUndefined();
    } finally {
      COMPILERS.screenshot = original;
    }
  });
  it('a capped page text is marked truncated', async () => {
    const engine = fakeEngine(() => okResult({ submitted: true, writes: [WRITE], outputs: [{ index: 4, verb: 'read', text: 'lorem', truncated: true }] }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER }), engine, 'fillForm');
    expect(data[0].json).toMatchObject({ text: 'lorem', truncated: true });
  });
  it('a URL carrying {{var.f0}} is a configuration error and nothing runs (a URL cannot leak a field value)', async () => {
    const engine = fakeEngine(() => okResult());
    const p = quickParams('fillForm', { url: 'https://example.com/log?v={{var.f0}}', formFields: FIELDS, submitButton: SEND });
    const [data] = await executeQuickOp(harness({ params: p, credentials: BROWSER, continueOnFail: true }), engine, 'fillForm');
    expect(data[0].json).toMatchObject({ message: 'URL must not contain {{ }} templates', details: { configError: true } });
    expect(engine.calls).toHaveLength(0);
  });
  it('a failure after the POST carries details.submitted: true', async () => {
    const engine = fakeEngine(() => failResult('incomplete', 'run cancelled', { submitted: true }));
    const [data] = await executeQuickOp(harness({ params, credentials: BROWSER, continueOnFail: true }), engine, 'fillForm');
    expect(String(data[0].json.error)).toBe('incomplete: run cancelled');
    expect((data[0].json.details as IDataObject).submitted).toBe(true);
  });
});

describe('Fill and Submit Form description', () => {
  const byName = (name: string) => properties.find((p) => p.name === name);
  it('the operation list is in menu order with Fill and Submit Form in its place', () => {
    // The filter is the identity: the list is all nine operations (Import Steps included).
    const SPEC_ORDER = ['screenshot', 'getPage', 'pdf', 'extract', 'fillForm', 'download', 'runSteps', 'signSteps', 'importSteps'];
    const values = (OPERATIONS.options ?? []).map((o) => (o as { value: string }).value);
    expect(values).toEqual(SPEC_ORDER.filter((v) => values.includes(v)));
    expect(values).toContain('fillForm');
    expect(OPERATIONS.options).toContainEqual(expect.objectContaining({ name: 'Fill and Submit Form', value: 'fillForm', action: 'Fill in and submit a form' }));
  });
  it('shows the two notices verbatim, then Fields and Submit Button, only for Fill and Submit Form', () => {
    expect(fillFormProperties.map((p) => p.name)).toEqual(['submitScope', 'passwordWarning', 'formFields', 'submitButton']);
    expect(quickFieldNames('fillForm')).toEqual(['formFields', 'submitButton']);
    expect(SUBMIT_SCOPE).toBe("Submits a form on the URL's site. Posts to other sites are blocked.");
    expect(PASSWORD_WARNING).toBe('Do not type passwords here.');
    expect(byName('submitScope')).toMatchObject({ type: 'notice', displayName: "Submits a form on the URL's site. Posts to other sites are blocked." });
    expect(byName('passwordWarning')).toMatchObject({ type: 'notice', displayName: 'Do not type passwords here.' });
    for (const p of fillFormProperties) {
      expect(byName(p.name)).toBe(p);
      expect(p.displayOptions?.show?.operation).toEqual(['fillForm']);
    }
    expect(byName('submitButton')).toMatchObject({ displayName: 'Submit Button', type: 'fixedCollection', required: true });
  });
  it('each Field is the locator inputs plus a value that is not a password field', () => {
    const group = ((byName('formFields')?.options ?? []) as INodePropertyCollection[])[0];
    expect(group.name).toBe('field');
    expect(group.values.map((v) => v.name)).toEqual([...locatorGroupValues().map((v) => v.name), 'value']);
    expect(group.values.find((v) => v.name === 'value')?.typeOptions?.password).toBeUndefined();
  });
  it('Value says the debug trace records typed values', () => {
    const group = ((byName('formFields')?.options ?? []) as INodePropertyCollection[])[0];
    expect(group.values.find((v) => v.name === 'value')?.description).toBe(
      'What to type into the field, at most 10,000 characters. It is passed to the page as a value, never written into the steps. The debug trace records typed values.',
    );
  });
  it('Fields says it fills text fields and points selects and checkboxes to Run Steps', () => {
    expect(byName('formFields')?.description).toBe('Text fields to fill in, in order (use Run Steps for selects and checkboxes). Each locator must match exactly one field.');
  });
  it('the options are exactly the quick options', () => {
    expect(optionsFor('fillForm').sort()).toEqual([...QUICK_COMMON_OPTIONS].sort());
  });
  it('has no use-case words', () => {
    const texts = fillFormProperties
      .flatMap((p) => [p.displayName, p.description, p.hint, p.placeholder, ...((p.options ?? []) as INodePropertyCollection[]).flatMap((o) => (o.values ?? []).map((v: INodeProperties) => v.description))])
      .filter((t): t is string => typeof t === 'string');
    for (const t of texts) expect(t).not.toMatch(USE_CASE_WORDS);
  });
});
