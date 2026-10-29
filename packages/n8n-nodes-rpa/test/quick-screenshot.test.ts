import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { IDataObject, INodePropertyCollection, INodePropertyOptions } from 'n8n-workflow';
import { properties } from '../nodes/Playwright/description/index.js';
import { locatorGroupValues, locatorProperty, ROLES } from '../nodes/Playwright/description/locator.js';
import {
  compileQuickOp, executeQuickOp, locatorValue, outputProperty, quickFieldNames, readQuickParams, toLocator, type LocatorParam, type QuickOp, type QuickParams,
} from '../nodes/Playwright/operations/quick.js';
import { quickEnvelope } from '../nodes/Playwright/output.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';
import { assertRunnable, binaryOf, BROWSER, failResult, okResult, optionsFor, PAGE_URL, PNG, QUICK_COMMON_OPTIONS, quickParams } from './quick-fixtures.js';

const base: QuickParams = { url: PAGE_URL, waitUntil: 'load', options: {} };
const OPEN = { intent: 'Open the page', goto: PAGE_URL, waitUntil: 'load' };
const shot = (index: number) => ({
  index, verb: 'screenshot' as const, binary: { name: `screenshot_${index}`, fileName: `screenshot_${index}.png`, mimeType: 'image/png', data: PNG },
});
const prop = (name: string) => {
  const p = properties.find((x) => x.name === name);
  if (!p) throw new Error(`no property ${name}`);
  return p;
};

describe('compileQuickOp: screenshot', () => {
  it('Full Page (default) opens the page and takes one full-page screenshot', () => {
    const c = compileQuickOp('screenshot', { ...base, capture: null });
    expect(c).toEqual({ script: { steps: [OPEN, { intent: 'Take a screenshot', screenshot: { capture: 'full' } }] }, vars: {} });
    assertRunnable(c);
  });
  it('Viewport', () => {
    const c = compileQuickOp('screenshot', { ...base, capture: 'viewport' });
    expect(c.script.steps[1]).toEqual({ intent: 'Take a screenshot', screenshot: { capture: 'viewport' } });
    assertRunnable(c);
  });
  it('One Element carries the element locator', () => {
    const c = compileQuickOp('screenshot', { ...base, capture: 'element', element: { locator: { findBy: 'css', css: 'table.results' } } });
    expect(c.script.steps[1]).toEqual({ intent: 'Take a screenshot', screenshot: { capture: 'element', element: { css: 'table.results' } } });
    assertRunnable(c);
  });
  it('One Element without a locator is a configuration error', () => {
    expect(() => compileQuickOp('screenshot', { ...base, capture: 'element' })).toThrow('Element needs a value');
    expect(() => compileQuickOp('screenshot', { ...base, capture: 'element', element: {} })).toThrow('Element needs a value');
  });
  it('an unknown Capture is a configuration error', () => {
    expect(() => compileQuickOp('screenshot', { ...base, capture: 'everything' })).toThrow('Capture must be Full Page, Viewport or One Element');
  });
  it('Wait Until goes on the goto and Wait for Element becomes step 1', () => {
    const c = compileQuickOp('screenshot', {
      ...base, waitUntil: 'networkidle', waitFor: { findBy: 'role', role: 'button', roleName: 'Accept', exact: true },
    });
    expect(c.script.steps).toEqual([
      { intent: 'Open the page', goto: PAGE_URL, waitUntil: 'networkidle' },
      { intent: 'Wait for the element', waitFor: { target: { role: 'button', name: 'Accept', exact: true } } },
      { intent: 'Take a screenshot', screenshot: { capture: 'full' } },
    ]);
    assertRunnable(c);
  });
  it('an operation without a compiler is refused', () => {
    expect(() => compileQuickOp('nope' as QuickOp, base)).toThrow('The nope operation is not available in this version of the node');
  });
});

describe('toLocator: every Find By', () => {
  const cases: [LocatorParam, object][] = [
    [{ findBy: 'text', text: ' Sign in ' }, { text: 'Sign in' }],
    [{ findBy: 'text', text: 'Sign in', exact: true }, { text: 'Sign in', exact: true }],
    [{ findBy: 'label', label: 'Email address' }, { label: 'Email address' }],
    [{ findBy: 'label', label: 'Email address', exact: true }, { label: 'Email address', exact: true }],
    [{ findBy: 'role', role: 'button', roleName: 'Submit' }, { role: 'button', name: 'Submit' }],
    [{ findBy: 'role', role: 'button', roleName: 'Submit', exact: true }, { role: 'button', name: 'Submit', exact: true }],
    [{ findBy: 'role', role: 'heading', exact: true }, { role: 'heading' }],
    [{ findBy: 'testId', testId: 'submit-button', exact: true }, { testId: 'submit-button' }],
    [{ findBy: 'css', css: 'table.results', exact: true }, { css: 'table.results' }],
  ];
  it.each(cases)('%j → %j (Exact Match only on text, label and role name)', (p, loc) => {
    expect(toLocator(p, 'Element')).toEqual(loc);
    assertRunnable(compileQuickOp('screenshot', { ...base, capture: 'element', element: { locator: p } }));
  });
  it('an empty value names the field', () => {
    for (const findBy of ['text', 'label', 'testId', 'css'] as const) expect(() => toLocator({ findBy }, 'Submit Button')).toThrow('Submit Button needs a value');
    expect(() => toLocator({ findBy: 'role', role: ' ' }, 'Submit Button')).toThrow('Submit Button needs a value');
    expect(() => toLocator(undefined, 'Element')).toThrow('Element needs a value');
  });
  it('an unknown Find By is refused', () => {
    expect(() => toLocator({ findBy: 'xpath' as LocatorParam['findBy'], text: 'x' }, 'Element')).toThrow(
      'Element: Find By must be Visible Text, Form Label, Role and Name, Test ID or CSS Selector',
    );
  });
});

describe('readQuickParams', () => {
  it('reads URL, Wait Until, Wait for Element, Options and exactly the fields shown for the operation', () => {
    const h = harness({
      params: quickParams(
        'screenshot',
        { capture: 'element', element: { locator: { findBy: 'css', css: 'table.results' } }, goal: 'a Run Steps field' },
        { waitUntil: 'domcontentloaded', waitFor: { locator: { findBy: 'text', text: 'Loaded' } }, screenshotProperty: 'shot' },
      ),
      credentials: BROWSER,
    });
    const p = readQuickParams(h, 0, 'screenshot');
    expect(p).toMatchObject({
      url: PAGE_URL, waitUntil: 'domcontentloaded', waitFor: { findBy: 'text', text: 'Loaded' },
      capture: 'element', element: { locator: { findBy: 'css', css: 'table.results' } }, options: { screenshotProperty: 'shot' },
    });
    expect(p).not.toHaveProperty('goal');
  });
  it('trims the URL and refuses an empty one', () => {
    expect(readQuickParams(harness({ params: quickParams('screenshot', { url: `  ${PAGE_URL} ` }) }), 0, 'screenshot').url).toBe(PAGE_URL);
    expect(() => readQuickParams(harness({ params: quickParams('screenshot', { url: '  ' }) }), 0, 'screenshot')).toThrow('URL is required');
  });
  it('defaults Wait Until to Load and refuses an unknown value', () => {
    expect(readQuickParams(harness({ params: quickParams('screenshot') }), 0, 'screenshot').waitUntil).toBe('load');
    expect(() => readQuickParams(harness({ params: quickParams('screenshot', {}, { waitUntil: 'eventually' }) }), 0, 'screenshot')).toThrow(
      'Wait Until must be Load, DOM Content Loaded or Network Idle',
    );
  });
  it('the fields of Screenshot are Capture and Element', () => {
    expect(quickFieldNames('screenshot')).toEqual(['capture', 'element']);
  });
});

describe('quickEnvelope', () => {
  const compiled = compileQuickOp('screenshot', base);
  it('is { url, title, status, steps } with no blockedRequests key when nothing was blocked', () => {
    const env = quickEnvelope(okResult(), compiled);
    expect(env).toEqual({ url: PAGE_URL, title: 'Pricing', status: 200, steps: compiled.script });
    expect(Object.keys(env)).toEqual(['url', 'title', 'status', 'steps']);
  });
  it('puts operation fields between status and steps, and lists blocked writes last', () => {
    const env = quickEnvelope(okResult({ blockedRequests: [{ method: 'POST', host: 'cdn.other.com', path: '/collect' }] }), compiled, { text: 'hello' });
    expect(Object.keys(env)).toEqual(['url', 'title', 'status', 'text', 'steps', 'blockedRequests']);
    expect(env.blockedRequests).toEqual([{ method: 'POST', host: 'cdn.other.com', path: '/collect' }]);
  });
  it('steps is a JSON copy ready for Run Steps, with no startUrl key', () => {
    const env = quickEnvelope(okResult(), compiled);
    expect(env.steps).not.toBe(compiled.script);
    expect(env.steps).not.toHaveProperty('startUrl');
  });
  it('reports a null status as null', () => {
    expect(quickEnvelope(okResult({ page: { url: PAGE_URL, title: '', status: null } }), compiled).status).toBeNull();
  });
});

describe('executeQuickOp: screenshot (fake engine)', () => {
  it('builds an unsigned, read-only TaskInput from the URL alone; a Site Login on the node is ignored', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(1)] }));
    const credentials = { ...BROWSER, playwrightSiteLoginApi: { loginUrl: 'https://example.com/login', username: 'someone', password: 'secret-pw' } };
    await executeQuickOp(harness({ params: quickParams('screenshot'), credentials }), engine, 'screenshot');
    expect(engine.calls).toHaveLength(1);
    const input = engine.calls[0];
    expect(input).toMatchObject({
      script: compileQuickOp('screenshot', base).script, trust: { required: false }, startStatus: 'report', vars: {},
      viewport: { width: 1280, height: 800 }, budgetMs: 180_000, defaultStepTimeoutMs: 30_000, saveTrace: 'never', endpoint: { mode: 'local' },
    });
    expect(input.policy).toMatchObject({
      startUrl: PAGE_URL, navHosts: ['example.com'], subresourceHosts: '*', login: [], allowedSubmits: [], writeMode: 'block', allowPrivateNetwork: false,
    });
    expect(input.policy.writeWindow).toBeUndefined();
    expect(input.secrets).toBeUndefined();
    expect(input.repair).toBeUndefined();
    expect(input.output).toBeUndefined();
  });
  it('puts the PNG under binary "screenshot" with the envelope as json', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(1)] }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER }), engine, 'screenshot');
    expect(Object.keys(item.binary ?? {})).toEqual(['screenshot']);
    expect(item.binary?.screenshot.mimeType).toBe('image/png');
    expect(binaryOf(item, 'screenshot').equals(PNG)).toBe(true);
    expect(item.json).toEqual(quickEnvelope(okResult(), compileQuickOp('screenshot', base)));
    expect(item.pairedItem).toEqual([{ item: 0 }]);
  });
  it('Options → Put Output in Field renames the binary', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(1)] }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot', {}, { screenshotProperty: 'pageShot' }), credentials: BROWSER }), engine, 'screenshot');
    expect(Object.keys(item.binary ?? {})).toEqual(['pageShot']);
  });
  it('the file is named after the binary field with the capture extension, never the step index', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(3)] }));
    const [[plain]] = await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER }), engine, 'screenshot');
    expect(plain.binary?.screenshot.fileName).toBe('screenshot.png');
    const [[renamed]] = await executeQuickOp(harness({ params: quickParams('screenshot', {}, { screenshotProperty: 'pageShot' }), credentials: BROWSER }), engine, 'screenshot');
    expect(renamed.binary?.pageShot.fileName).toBe('pageShot.png');
  });
  it('Put Output in Field "trace" is a configuration error before any run (the debug trace uses that field)', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(1)] }));
    const h = harness({ params: quickParams('screenshot', {}, { screenshotProperty: ' trace ' }), credentials: BROWSER, continueOnFail: true });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json.message).toBe('Put Output in Field must not be "trace": the debug trace uses that field.');
    expect(JSON.stringify(item.json)).toContain('"configError":true');
    expect(engine.calls).toHaveLength(0);
  });
  it('Put Output in Field "__proto__", "constructor" or "prototype" is a configuration error before any run', async () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const engine = fakeEngine(() => okResult({ outputs: [shot(1)] }));
      const h = harness({ params: quickParams('screenshot', {}, { screenshotProperty: name }), credentials: BROWSER, continueOnFail: true });
      const [[item]] = await executeQuickOp(h, engine, 'screenshot');
      expect(item.json.message).toBe(`Put Output in Field must not be "${name}": that name is reserved.`);
      expect(engine.calls).toHaveLength(0);
      for (const key of ['pdfProperty', 'fileProperty']) expect(() => outputProperty({ [key]: name }, key, 'x')).toThrow(`must not be "${name}"`);
    }
    expect(outputProperty({ screenshotProperty: 'proto' }, 'screenshotProperty', 'screenshot')).toBe('proto');
  });
  it('attaches the trace when the engine kept one', async () => {
    const engine = fakeEngine(() => okResult({ outputs: [shot(1)], trace: Buffer.from('PK') }));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot', {}, { saveTrace: 'always' }), credentials: BROWSER }), engine, 'screenshot');
    expect(Object.keys(item.binary ?? {}).sort()).toEqual(['screenshot', 'trace']);
    expect(item.binary?.trace.mimeType).toBe('application/zip');
  });
  it('runs each input item once, in order, each paired to its item', async () => {
    const engine = fakeEngine((input) => okResult({ outputs: [shot(1)], page: { url: input.policy.startUrl, title: 't', status: 200 } }));
    const h = harness({ params: (i) => quickParams('screenshot', { url: `https://example.com/p${i}` }), items: [{ json: {} }, { json: {} }], credentials: BROWSER });
    const [data] = await executeQuickOp(h, engine, 'screenshot');
    expect(engine.calls.map((c) => c.policy.startUrl)).toEqual(['https://example.com/p0', 'https://example.com/p1']);
    expect(data.map((d) => d.pairedItem)).toEqual([[{ item: 0 }], [{ item: 1 }]]);
  });
  it('a missing screenshot output is an incomplete failure item (Run Steps shape), never a silent success', async () => {
    const log = [{ index: 0, intent: 'Open the page', status: 'ok' as const, ms: 5 }];
    const engine = fakeEngine(() => okResult({ outputs: [], log, trace: Buffer.from('PK') }));
    const h = harness({ params: quickParams('screenshot', {}, { saveTrace: 'always' }), credentials: BROWSER, continueOnFail: true });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json).toMatchObject({
      error: 'incomplete: the run finished without a screenshot output', message: 'the run finished without a screenshot output',
      details: { code: 'incomplete', name: null, lane: 'script', log, submitted: false, traceRef: 'trace' },
    });
    expect(item.binary?.trace.mimeType).toBe('application/zip');
    expect(item.pairedItem).toEqual([{ item: 0 }]);
    await expect(executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER }), engine, 'screenshot')).rejects.toThrow(
      /^incomplete: the run finished without a screenshot output$/,
    );
  });
  it('an engine that throws gives a configuration error item (Run Steps shape)', async () => {
    const engine = fakeEngine(() => {
      throw new Error('engine exploded');
    });
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot');
    expect(item.json).toMatchObject({ error: 'engine exploded', message: 'engine exploded', details: { configError: true, code: null, log: [], submitted: false } });
    expect(item.pairedItem).toEqual([{ item: 0 }]);
  });
});

describe('executeQuickOp: failures', () => {
  it('an engine failure becomes an error item under continue-on-fail', async () => {
    const engine = fakeEngine(() => failResult('not_found', 'the page was not found (HTTP 404)'));
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot');
    expect(item.json).toMatchObject({ error: 'not_found: the page was not found (HTTP 404)', message: 'the page was not found (HTTP 404)', details: { name: null } });
    expect(item.pairedItem).toEqual([{ item: 0 }]);
  });
  it('without continue-on-fail the failure is thrown with its code first', async () => {
    const engine = fakeEngine(() => failResult('not_found', 'the page was not found (HTTP 404)'));
    await expect(executeQuickOp(harness({ params: quickParams('screenshot'), credentials: BROWSER }), engine, 'screenshot')).rejects.toThrow(
      /^not_found: the page was not found \(HTTP 404\)$/,
    );
  });
  it('a file: URL is a policy_violation with the golden message, before any browser opens', async () => {
    const engine = fakeEngine(() => okResult());
    const [[item]] = await executeQuickOp(
      harness({ params: quickParams('screenshot', { url: 'file:///etc/passwd' }), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot',
    );
    expect(item.json.error).toBe('policy_violation: URL must start with http:// or https:// (got "file:").');
    expect(engine.calls).toHaveLength(0);
  });
  it('a URL with {{ }} is a configuration error before any run (n8n expressions resolve first; the steps take no templates there)', async () => {
    const engine = fakeEngine(() => okResult());
    expect(() => readQuickParams(harness({ params: quickParams('screenshot', { url: 'https://example.com/{{ $json.page }}' }) }), 0, 'screenshot')).toThrow(
      'URL must not contain {{ }} templates',
    );
    const h = harness({ params: quickParams('screenshot', { url: 'https://example.com/p?q={{var.x}}' }), credentials: BROWSER, continueOnFail: true });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json.message).toBe('URL must not contain {{ }} templates');
    expect(JSON.stringify(item.json)).toContain('"configError":true');
    expect(engine.calls).toHaveLength(0);
  });
  it('a URL with a username and password is a policy_violation that names neither, before any run', async () => {
    const engine = fakeEngine(() => okResult());
    const h = harness({ params: quickParams('screenshot', { url: 'https://alice:s3cretpw@example.com/' }), credentials: BROWSER, continueOnFail: true });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json.error).toBe('policy_violation: URL must not contain a username or password');
    const text = JSON.stringify(item.json);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('s3cretpw');
    expect(engine.calls).toHaveLength(0);
    await expect(executeQuickOp(harness({ params: quickParams('screenshot', { url: 'https://alice:s3cretpw@example.com/' }), credentials: BROWSER }), engine, 'screenshot'))
      .rejects.toThrow(/^policy_violation: URL must not contain a username or password$/);
  });
  it('an empty URL is a configuration error', async () => {
    const engine = fakeEngine(() => okResult());
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot', { url: '' }), credentials: BROWSER, continueOnFail: true }), engine, 'screenshot');
    expect(item.json.message).toBe('URL is required');
    expect(JSON.stringify(item.json)).toContain('"configError":true');
    expect(engine.calls).toHaveLength(0);
    await expect(executeQuickOp(harness({ params: quickParams('screenshot', { url: '' }), credentials: BROWSER }), engine, 'screenshot')).rejects.toThrow('URL is required');
  });
  it('Allow Private Network set by an expression is a configuration error (literal only)', async () => {
    const engine = fakeEngine(() => okResult());
    const h = harness({
      params: quickParams('screenshot', {}, { allowPrivateNetwork: true }),
      rawParameters: { operation: 'screenshot', url: PAGE_URL, options: { allowPrivateNetwork: '={{ $json.private }}' } },
      credentials: BROWSER, continueOnFail: true,
    });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json.message).toBe('Allow Private Network must be set directly, not with an expression.');
    expect(engine.calls).toHaveLength(0);
  });
  it('Allow Private Network under an expression-valued Options collection is a configuration error', async () => {
    const engine = fakeEngine(() => okResult());
    const h = harness({
      params: quickParams('screenshot', {}, { allowPrivateNetwork: true }),
      rawParameters: { operation: 'screenshot', url: PAGE_URL, options: '={{ { allowPrivateNetwork: true } }}' },
      credentials: BROWSER, continueOnFail: true,
    });
    const [[item]] = await executeQuickOp(h, engine, 'screenshot');
    expect(item.json.message).toBe('Allow Private Network must be set directly, not with an expression.');
    expect(engine.calls).toHaveLength(0);
  });
  it('Max Items is checked before any run', async () => {
    const engine = fakeEngine(() => okResult());
    const h = harness({ params: quickParams('screenshot', {}, { maxItems: 1 }), items: [{ json: {} }, { json: {} }], credentials: BROWSER, continueOnFail: true });
    const [data] = await executeQuickOp(h, engine, 'screenshot');
    expect(data.map((d) => d.json.message)).toEqual([
      'This node received 2 items, more than Options → Max Items (1). Nothing ran.',
      'This node received 2 items, more than Options → Max Items (1). Nothing ran.',
    ]);
    expect(engine.calls).toHaveLength(0);
  });
  it('a missing RPA Browser credential is a configuration error', async () => {
    const engine = fakeEngine(() => okResult());
    const [[item]] = await executeQuickOp(harness({ params: quickParams('screenshot'), credentials: {}, continueOnFail: true }), engine, 'screenshot');
    expect(item.json.message).toBe('This operation runs in a browser: attach an RPA Browser credential.');
    expect(engine.calls).toHaveLength(0);
  });
});

describe('Screenshot description', () => {
  it('Capture: Full Page (default), Viewport, One Element', () => {
    const c = prop('capture');
    expect(c.default).toBe('fullPage');
    expect((c.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([['Full Page', 'fullPage'], ['Viewport', 'viewport'], ['One Element', 'element']]);
    expect(c.displayOptions).toEqual({ show: { operation: ['screenshot'] } });
  });
  it('Element is a required locator shown only for One Element', () => {
    expect(prop('element')).toMatchObject({ type: 'fixedCollection', required: true, displayOptions: { show: { operation: ['screenshot'], capture: ['element'] } } });
  });
  it('the options are the quick options plus Put Output in Field (default "screenshot")', () => {
    expect(optionsFor('screenshot').sort()).toEqual([...QUICK_COMMON_OPTIONS, 'screenshotProperty'].sort());
    const collection = prop('options');
    const field = (collection.options as { name: string; default?: unknown; displayName?: string }[]).find((o) => o.name === 'screenshotProperty');
    expect(field).toMatchObject({ displayName: 'Put Output in Field', default: 'screenshot' });
  });
});

describe('locatorProperty (description/locator.ts)', () => {
  const loc = locatorProperty({ name: 'target', displayName: 'Target', description: 'Where to click', required: true, show: { operation: ['screenshot'] } });
  const group = (loc.options as INodePropertyCollection[])[0];
  const field = (n: string) => {
    const f = group.values.find((v) => v.name === n);
    if (!f) throw new Error(`no locator field ${n}`);
    return f;
  };
  it('is a fixedCollection with one "locator" group', () => {
    expect(loc).toMatchObject({ name: 'target', displayName: 'Target', type: 'fixedCollection', required: true, description: 'Where to click', displayOptions: { show: { operation: ['screenshot'] } } });
    expect(loc.options).toHaveLength(1);
    expect(group.name).toBe('locator');
    expect(group.values.map((v) => v.name)).toEqual(['findBy', 'text', 'label', 'role', 'roleName', 'testId', 'css', 'exact']);
  });
  it('Find By: Visible Text (default), Form Label, Role and Name, Test ID, CSS Selector last', () => {
    const findBy = field('findBy');
    expect(findBy.default).toBe('text');
    expect((findBy.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([
      ['Visible Text', 'text'], ['Form Label', 'label'], ['Role and Name', 'role'], ['Test ID', 'testId'], ['CSS Selector', 'css'],
    ]);
  });
  it('placeholders and the role list', () => {
    expect([field('text').placeholder, field('label').placeholder, field('roleName').placeholder, field('testId').placeholder, field('css').placeholder]).toEqual([
      'Sign in', 'Email address', 'Submit', 'submit-button', 'table.results',
    ]);
    expect(field('role').default).toBe('button');
    expect((field('role').options as INodePropertyOptions[]).map((o) => o.value)).toEqual([...ROLES]);
    expect(ROLES).toEqual(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'row', 'cell', 'tab', 'menuitem']);
  });
  it('each input shows only for its Find By; Exact Match only for text, label and role', () => {
    expect(field('text').displayOptions).toEqual({ show: { findBy: ['text'] } });
    expect(field('label').displayOptions).toEqual({ show: { findBy: ['label'] } });
    expect(field('role').displayOptions).toEqual({ show: { findBy: ['role'] } });
    expect(field('roleName').displayOptions).toEqual({ show: { findBy: ['role'] } });
    expect(field('testId').displayOptions).toEqual({ show: { findBy: ['testId'] } });
    expect(field('css').displayOptions).toEqual({ show: { findBy: ['css'] } });
    expect(field('exact').displayOptions).toEqual({ show: { findBy: ['text', 'label', 'role'] } });
  });
  it('is optional unless asked', () => {
    expect(locatorProperty({ name: 'x', displayName: 'X', description: 'd', show: { operation: ['screenshot'] } }).required).toBeUndefined();
  });
  it('locatorGroupValues: the same inputs for use inside another entry, with an optional Find By description, as fresh copies', () => {
    expect(locatorGroupValues().map((v) => v.name)).toEqual(group.values.map((v) => v.name));
    const inside = locatorGroupValues('Where to find this value inside each item');
    expect(inside.find((v) => v.name === 'findBy')?.description).toBe('Where to find this value inside each item');
    expect(field('findBy').description).toBe('How to find the element. It must match exactly one element.');
    expect(locatorGroupValues()[0]).not.toBe(locatorGroupValues()[0]);
  });
  it('locatorValue reads a flat Fields entry and keeps only the locator keys', () => {
    expect(locatorValue({ name: 'price', findBy: 'css', css: 'span.price', attribute: 'href', value: 'x', exact: false })).toEqual({ findBy: 'css', css: 'span.price' });
    expect(locatorValue({ locator: { findBy: 'role', role: 'button', roleName: 'Send' } })).toEqual({ findBy: 'role', role: 'button', roleName: 'Send' });
    expect(locatorValue({})).toBeUndefined();
    expect(locatorValue(undefined)).toBeUndefined();
  });
});

describe('Screenshot becomes the default operation', () => {
  it('every RPA node in the templates names its operation, so the new default never changes a saved node', () => {
    const dir = new URL('../templates/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const wf = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { nodes: { type: string; name: string; parameters: IDataObject }[] };
      for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-rpa.playwright')) {
        expect(n.parameters.operation, `${file}: "${n.name}" must set operation`).toMatch(/^(screenshot|getPage|pdf|extract|fillForm|download|runSteps|signSteps|importSteps)$/);
      }
    }
  });
});
