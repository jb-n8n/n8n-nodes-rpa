import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  NodeHelpers, Workflow, type INodeCredentialDescription, type INodeParameters, type INodeProperties, type INodePropertyOptions, type INodeType, type INodeTypes,
} from 'n8n-workflow';
import { parseScript } from 'n8n-rpa-engine';
import { INPUTS_EXPRESSION, nodeInputs, nodeOutputs, OUTPUTS_EXPRESSION } from '../nodes/Playwright/description/io.js';
import { OPERATIONS, properties, SUBTITLE, URL_HINT } from '../nodes/Playwright/description/index.js';
import { ALL_OPERATIONS, ID_PATTERN_OPTION, QUICK_OPERATIONS } from '../nodes/Playwright/description/options.js';
import { STEPS_PLACEHOLDER, UNSIGNED_NOTICE } from '../nodes/Playwright/description/runSteps.js';
import { GUIDANCE } from '../nodes/Playwright/errors.js';
import { COMPILERS, quickFieldNames, type QuickOp } from '../nodes/Playwright/operations/quick.js';
import { executeRunSteps, readRunStepsParams } from '../nodes/Playwright/operations/runSteps.js';
import { DISPATCH, Playwright } from '../nodes/Playwright/Playwright.node.js';
import { fakeEngine } from './fake-engine.js';
import { harness } from './harness.js';

const node = new Playwright();
const d = node.description;
const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
const AI_REPAIR_EXPRESSION = "={{ $('Get pending').all().filter(i => i.json.hash && DateTime.fromISO(i.json.expiresAt) > $now).length === 0 }}";
const MAIN = { type: 'main', displayName: '' };
const MODEL = { type: 'ai_languageModel', displayName: 'Model', maxConnections: 1, required: false };
const DATA = { type: 'main', displayName: 'Data' };
const REPAIRED = { type: 'main', displayName: 'Repaired Steps' };
/** [operation, raw AI Repair value, has the Model input and the Repaired Steps output] */
const CASES: [unknown, unknown, boolean][] = [
  ['runSteps', true, true], ['runSteps', AI_REPAIR_EXPRESSION, true], ['runSteps', '={{ false }}', true],
  ['runSteps', false, false], ['runSteps', undefined, false], ['signSteps', true, false], [undefined, true, false],
];
/** The expert operations, after the quick ones: Run Steps, Sign Steps, then Import Steps. */
const EXPERT = ['runSteps', 'signSteps', 'importSteps'];
const SPEC_OPERATIONS = [
  { value: 'screenshot', action: 'Take a screenshot of a page' },
  { value: 'getPage', action: 'Get the text, HTML or title of a page' },
  { value: 'pdf', action: 'Save a page as PDF' },
  { value: 'extract', action: 'Extract a table or list from a page' },
  { value: 'fillForm', action: 'Fill in and submit a form' },
  { value: 'download', action: 'Download a file from a page' },
  { value: 'runSteps', action: 'Run a list of browser steps' },
  { value: 'signSteps', action: 'Sign a repaired step list' },
  { value: 'importSteps', action: 'Import steps from a recording, code or a UiPath bot' },
];
const operationValues = (OPERATIONS.options as INodePropertyOptions[]).map((o) => String(o.value));
const optionEntries = (d.properties.find((p) => p.name === 'options')?.options ?? []) as INodeProperties[];
const option = (name: string): INodeProperties => {
  const o = optionEntries.find((x) => x.name === name);
  if (!o) throw new Error(`no option "${name}"`);
  return o;
};
const body = (expression: string): string => {
  expect(expression.startsWith('={{') && expression.endsWith('}}')).toBe(true);
  return expression.slice(3, -2);
};

/** Every UI string of a property tree: names, labels, descriptions, hints, placeholders, actions, option names. */
function uiTexts(items: readonly unknown[]): string[] {
  const out: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item !== 'object' || item === null) return;
    const o = item as Record<string, unknown>;
    for (const key of ['displayName', 'name', 'description', 'hint', 'placeholder', 'action']) if (typeof o[key] === 'string') out.push(o[key] as string);
    for (const key of ['options', 'values']) if (Array.isArray(o[key])) (o[key] as unknown[]).forEach(visit);
  };
  items.forEach(visit);
  return out;
}

/** n8n's own connection logic: a Workflow holding one RPA node, as the editor and the executor build it. */
function n8nConnections(parameters: INodeParameters, type: INodeType = node): { inputs: string[]; outputs: string[] } {
  const d = type.description;
  const nodeTypes = { getByName: () => type, getByNameAndVersion: () => type, getKnownTypes: () => ({}) } as unknown as INodeTypes;
  const workflow = new Workflow({
    nodes: [{ id: 'n1', name: 'Run steps', type: 'n8n-nodes-rpa.playwright', typeVersion: 1, position: [0, 0], parameters, onError: 'continueErrorOutput' }],
    connections: {}, active: false, nodeTypes,
  });
  const loaded = workflow.getNode('Run steps');
  if (!loaded) throw new Error('n8n did not load the node');
  return {
    inputs: NodeHelpers.getNodeInputs(workflow, loaded, d).map((c) => (typeof c === 'string' ? c : c.type)),
    outputs: NodeHelpers.getNodeOutputs(workflow, loaded, d).map((c) => (typeof c === 'string' ? c : String(c.displayName))),
  };
}

describe('operations', () => {
  it('lists the operations in menu order with their action texts; Run Steps, Sign Steps and Import Steps start with "Advanced:"', () => {
    expect(d.properties[0]).toBe(OPERATIONS);
    expect(OPERATIONS).toMatchObject({ displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true });
    expect(operationValues).toEqual(SPEC_OPERATIONS.map((s) => s.value).filter((v) => operationValues.includes(v)));
    expect(operationValues.slice(-3)).toEqual(EXPERT);
    for (const o of OPERATIONS.options as INodePropertyOptions[]) {
      expect(o.action).toBe(SPEC_OPERATIONS.find((s) => s.value === o.value)?.action);
      if (EXPERT.includes(String(o.value))) expect(o.description).toMatch(/^Advanced: /);
    }
  });
  it('names the operation in the subtitle', () => {
    const subtitle = (operation: string) => new Function('$parameter', `return (${body(SUBTITLE)});`)({ operation }) as unknown;
    expect(subtitle('runSteps')).toBe('Run Steps');
    expect(subtitle('signSteps')).toBe('Sign Steps');
    expect(subtitle('importSteps')).toBe('Import Steps');
  });
  it('shows every property and every option only for the operations it names', () => {
    for (const p of d.properties.filter((x) => x.name !== 'operation')) {
      const ops = p.displayOptions?.show?.operation;
      expect(Array.isArray(ops) && ops.length > 0, p.name).toBe(true);
      for (const op of ops ?? []) expect(operationValues).toContain(op);
    }
    for (const o of optionEntries) {
      const ops = o.displayOptions?.show?.['/operation'];
      expect(Array.isArray(ops) && ops.length > 0, o.name).toBe(true);
      for (const op of ops ?? []) expect(operationValues).toContain(op);
    }
  });
});

describe('Run Steps and Sign Steps fields', () => {
  const field = (name: string) => {
    const p = d.properties.find((x) => x.name === name);
    if (!p) throw new Error(`no property "${name}"`);
    return p;
  };
  it('Run Steps shows Steps, Start URL, Require Signed Steps, Signature, Approved By and AI Repair; Goal only with AI Repair on', () => {
    const always = d.properties
      .filter((p) => p.displayOptions?.show?.operation?.includes('runSteps'))
      .filter((p) => Object.keys(p.displayOptions?.show ?? {}).every((k) => k === 'operation'))
      .map((p) => p.name);
    expect(always).toEqual(['steps', 'startUrl', 'requireSignedSteps', 'signature', 'approvedBy', 'aiRepair', 'options']);
    expect(field('requireSignedSteps')).toMatchObject({ displayName: 'Require Signed Steps', type: 'boolean', default: true, noDataExpression: true });
    expect(field('aiRepair')).toMatchObject({ displayName: 'AI Repair', type: 'boolean', default: false });
    expect(field('goal').displayOptions?.show).toEqual({ operation: ['runSteps'], aiRepair: [true] });
    expect(field('unsignedNotice')).toMatchObject({ type: 'notice', displayName: UNSIGNED_NOTICE, displayOptions: { show: { operation: ['runSteps'], requireSignedSteps: [false] } } });
    expect(UNSIGNED_NOTICE).toBe('Unsigned steps run as written. Only turn this off for steps you typed here.');
    expect(field('steps')).toMatchObject({ displayName: 'Steps (JSON)', type: 'json', default: '' });
  });
  it('Expected File shows only with AI Repair and lists the six file types', () => {
    const f = field('expectedFile');
    expect(f).toMatchObject({ displayName: 'Expected File (First Version)', type: 'fixedCollection', displayOptions: { show: { operation: ['runSteps'], aiRepair: [true] } } });
    const values = (f.options as { name: string; values: INodeProperties[] }[])[0].values;
    expect(values.map((v) => v.displayName)).toEqual(['File Type', 'File Name Pattern (Regex)', 'Minimum Size (Bytes)', 'Required Columns', 'Minimum Rows']);
    expect((values[0].options as INodePropertyOptions[]).map((o) => o.name)).toEqual(['CSV', 'Excel (XLSX)', 'PDF', 'Text', 'JSON', 'ZIP']);
    expect(f.description).toBe('Used when AI repair builds the first version of steps that download a file. Steps that already exist carry their own checks on the download step (check).');
  });
  it('the Steps placeholder is a valid 3-step document', () => {
    expect(field('steps').placeholder).toBe(STEPS_PLACEHOLDER);
    expect(parseScript(JSON.parse(STEPS_PLACEHOLDER)).steps).toHaveLength(3);
  });
  it('Sign Steps shows Approved (hint "Off records a rejection"), Approved By and Approver Allowlist', () => {
    const sign = d.properties.filter((p) => p.displayOptions?.show?.operation?.includes('signSteps') && p.name !== 'options').map((p) => p.name);
    expect(sign).toEqual(['signInputNotice', 'approved', 'approverId', 'approverAllowlist']);
    expect(field('approved')).toMatchObject({ displayName: 'Approved', type: 'boolean', default: false, hint: 'Off records a rejection' });
    expect(field('approverId').displayName).toBe('Approved By');
    expect(field('approverAllowlist').displayName).toBe('Approver Allowlist');
  });
  it('declares the Run Steps and Sign Steps options with their names, operations and limits', () => {
    // Filtered to the entries shown for Run Steps or Sign Steps, so the quick-operation options do not change this list.
    const forRunOrSign = optionEntries.filter((o) => (o.displayOptions?.show?.['/operation'] ?? []).some((op) => op === 'runSteps' || op === 'signSteps'));
    expect(forRunOrSign.map((o) => o.name)).toEqual([
      'timeout', 'maxSeconds', 'viewport', 'allowedHosts', 'allowPrivateNetwork', 'idPattern', 'totalPattern', 'requiredFields', 'emptyPattern',
      'variables', 'name', 'expectedVersion', 'allowUnsignedWrites', 'deliverUnconfirmed', 'maxActions', 'maxTokens', 'breakerResetKey', 'saveTrace', 'maxItems',
    ]);
    for (const name of ['deliverUnconfirmed', 'maxActions', 'maxTokens']) expect(option(name).displayOptions?.show).toEqual({ '/operation': ['runSteps'], '/aiRepair': [true] });
    expect(option('maxItems').displayOptions?.show).toEqual({ '/operation': ALL_OPERATIONS }); // every operation, quick ones included
    expect(option('timeout')).toMatchObject({ displayName: 'Timeout (Seconds)', default: 30 });
    expect(option('maxSeconds')).toMatchObject({ default: 180, typeOptions: { minValue: 10, maxValue: 300 } });
    expect(option('viewport')).toMatchObject({ type: 'fixedCollection', default: { size: { width: 1280, height: 800 } } });
    expect(option('allowedHosts').displayName).toBe('Also Allow These Sites');
    expect(option('totalPattern').displayName).toBe('Stated Total Pattern (Regex)');
    expect(option('emptyPattern').displayName).toBe('Text That Means No Results (Regex)');
    expect(option('variables').hint).toBe('Not n8n expressions; {{var.name}} is replaced inside steps.');
    expect(option('maxActions')).toMatchObject({ default: 40, typeOptions: { minValue: 1, maxValue: 200 } });
    expect(option('maxTokens')).toMatchObject({ default: 200000, typeOptions: { minValue: 1000, maxValue: 1000000 } });
    expect(option('saveTrace')).toMatchObject({ displayName: 'Debug Trace', default: 'onFailure' });
    expect(option('maxItems')).toMatchObject({ default: 100, typeOptions: { minValue: 1 } });
  });
  it('ID Pattern carries its description text verbatim', () => {
    expect(option('idPattern')).toBe(ID_PATTERN_OPTION);
    expect(ID_PATTERN_OPTION).toMatchObject({
      displayName: 'ID Pattern (Regex)', name: 'idPattern', type: 'string', default: '', placeholder: 'INV-\\d{4}',
      description: 'Optional. A regular expression that matches the ID every record has, such as INV-\\d{4} for INV-0417. When set, the node keeps only rows whose ID matches, and removes duplicates by ID. To check the count against a total the page states, set Stated Total Pattern. Leave empty to return everything found. Required for AI repair.',
      hint: 'Not sure? Paste one real ID into regex101.com and describe its shape: digits \\d, letters [A-Z], repeats {4}.',
    });
  });
  it('marks every literal-only parameter noDataExpression (Require Signed Steps, Approver Allowlist, Allow Private Network, Allow Unsigned Writes, Deliver Unconfirmed Rows, Login Breaker Reset Key)', () => {
    expect(field('requireSignedSteps').noDataExpression).toBe(true);
    expect(field('approverAllowlist').noDataExpression).toBe(true); // literal-only at run time too (signSteps.ts literalRaw)
    for (const name of ['allowPrivateNetwork', 'allowUnsignedWrites', 'deliverUnconfirmed', 'breakerResetKey']) expect(option(name).noDataExpression, name).toBe(true);
    expect(option('breakerResetKey').description).toMatch(/not an expression/);
  });
  it('the option shapes are the ones readRunStepsParams reads (if this fails, align operations/runSteps.ts with the description)', () => {
    const params = {
      operation: 'runSteps', steps: '[{"intent":"Open the page","goto":"https://example.com/"}]', startUrl: 'https://example.com/', requireSignedSteps: false,
      signature: '', approvedBy: '', aiRepair: true, goal: 'Read the table',
      options: {
        timeout: 20, maxSeconds: 120, viewport: { size: { width: 1024, height: 700 } }, allowedHosts: 'cdn.example.com, img.example.com', allowPrivateNetwork: true,
        idPattern: 'INV-\\d{4}', totalPattern: '(\\d+) results', requiredFields: 'title, date', emptyPattern: 'No results found',
        variables: { values: [{ name: 'from', value: '2026-01-01' }] }, name: 'invoices', expectedVersion: '3', allowUnsignedWrites: true, deliverUnconfirmed: true,
        maxActions: 50, maxTokens: 300000, breakerResetKey: '2026-10-06', saveTrace: 'always', maxItems: 5,
      },
    };
    const p = readRunStepsParams(harness({ params, rawParameters: params }), 0);
    expect(p.steps).toEqual({ kind: 'steps', raw: [{ intent: 'Open the page', goto: 'https://example.com/' }] });
    expect(p).toMatchObject({
      startUrl: 'https://example.com/', requireSignedSteps: false, aiRepair: true, goal: 'Read the table', vars: { from: '2026-01-01' }, name: 'invoices',
      expectedVersion: 3, allowUnsignedWrites: true, deliverUnconfirmed: true, maxActions: 50, maxTokens: 300000, breakerResetKey: '2026-10-06',
      output: { idPattern: 'INV-\\d{4}', totalPattern: '(\\d+) results', requiredFields: ['title', 'date'], emptyPattern: 'No results found' },
      common: {
        timeoutMs: 20000, maxSeconds: 120, viewport: { width: 1024, height: 700 }, allowedHosts: ['cdn.example.com', 'img.example.com'],
        allowPrivateNetwork: true, saveTrace: 'always',
      },
    });
  });
});

describe('dynamic inputs and outputs', () => {
  it.each(CASES)('operation %s, AI Repair %s → Model input and Repaired Steps output: %s', (operation, aiRepair, extra) => {
    expect(nodeInputs(operation, aiRepair)).toEqual(extra ? [MAIN, MODEL] : [MAIN]);
    expect(nodeOutputs(operation, aiRepair)).toEqual(extra ? [DATA, REPAIRED] : [DATA]);
  });
  it('the inputs and outputs expressions evaluate to exactly what the pure functions return', () => {
    const evaluate = (expression: string, raw: Record<string, unknown>) => new Function('$rawParameter', `return (${body(expression)});`)(raw) as unknown;
    for (const [operation, aiRepair] of CASES) {
      expect(evaluate(INPUTS_EXPRESSION, { operation, aiRepair })).toEqual(nodeInputs(operation, aiRepair));
      expect(evaluate(OUTPUTS_EXPRESSION, { operation, aiRepair })).toEqual(nodeOutputs(operation, aiRepair));
    }
  });
  it('reads the raw parameters, so an expression-valued AI Repair is never resolved to decide the connections', () => {
    for (const e of [INPUTS_EXPRESSION, OUTPUTS_EXPRESSION]) {
      expect(e).toContain('$rawParameter.operation, $rawParameter.aiRepair');
      expect(e).not.toContain('$parameter');
      expect(body(e)).not.toContain('}}'); // n8n's expression splitter must see one {{ … }}
    }
    expect(d.inputs).toBe(INPUTS_EXPRESSION);
    expect(d.outputs).toBe(OUTPUTS_EXPRESSION);
  });
  it("n8n computes the data feed's connections: Model input, then Data, Repaired Steps and the error output at index 2", () => {
    expect(n8nConnections({ operation: 'runSteps', aiRepair: AI_REPAIR_EXPRESSION })).toEqual({ inputs: ['main', 'ai_languageModel'], outputs: ['Data', 'Repaired Steps', 'Error'] });
    expect(n8nConnections({ operation: 'runSteps', aiRepair: true })).toEqual({ inputs: ['main', 'ai_languageModel'], outputs: ['Data', 'Repaired Steps', 'Error'] });
    expect(n8nConnections({ operation: 'runSteps', aiRepair: false })).toEqual({ inputs: ['main'], outputs: ['Success', 'Error'] });
    expect(n8nConnections({ operation: 'signSteps' })).toEqual({ inputs: ['main'], outputs: ['Success', 'Error'] });
  });
  it('n8n computes Import Steps\' connections: the Model input with AI Repair at its default (on), and always Data and Repaired Steps', () => {
    expect(n8nConnections({ operation: 'importSteps' })).toEqual({ inputs: ['main', 'ai_languageModel'], outputs: ['Data', 'Repaired Steps', 'Error'] });
    expect(n8nConnections({ operation: 'importSteps', aiRepair: false })).toEqual({ inputs: ['main'], outputs: ['Data', 'Repaired Steps', 'Error'] });
  });
  // n8n evaluates Function.prototype.toString() of the compiled functions, so the dist build (CommonJS, what n8n loads) is
  // checked too. `pnpm test` compiles dist first.
  const DIST_NODE = new URL('../dist/nodes/Playwright/Playwright.node.js', import.meta.url);
  it.skipIf(!existsSync(DIST_NODE))('the compiled node n8n loads gives the same connections', () => {
    const compiled = createRequire(import.meta.url)(DIST_NODE.pathname) as { Playwright: new () => INodeType };
    const built = new compiled.Playwright();
    expect(n8nConnections({ operation: 'runSteps', aiRepair: AI_REPAIR_EXPRESSION }, built)).toEqual({ inputs: ['main', 'ai_languageModel'], outputs: ['Data', 'Repaired Steps', 'Error'] });
    expect(n8nConnections({ operation: 'runSteps', aiRepair: false }, built)).toEqual({ inputs: ['main'], outputs: ['Success', 'Error'] });
  });
  it('at run time an expression-valued AI Repair always yields two output arrays, even when it resolves to false', async () => {
    const engine = fakeEngine(() => {
      throw new Error('no run may start: the steps are empty');
    });
    const params = (aiRepair: unknown) => ({
      operation: 'runSteps', steps: '', startUrl: 'https://example.com/', requireSignedSteps: false, aiRepair, goal: 'Read the table',
      options: { name: 'feed', idPattern: 'INV-\\d{4}' },
    });
    const credentials = { playwrightBrowserApi: { mode: 'local', headless: true } };
    const run = (resolved: unknown, raw: unknown) =>
      executeRunSteps(harness({ params: params(resolved), rawParameters: params(raw), credentials, continueOnFail: true }), engine);

    const resolvedFalse = await run(false, AI_REPAIR_EXPRESSION);
    expect(resolvedFalse).toHaveLength(2);
    expect(resolvedFalse[1]).toEqual([]);
    expect(JSON.stringify(resolvedFalse[0])).toContain('Steps is empty. Add steps, or turn on AI Repair to build them from the Goal.');

    const resolvedTrue = await run(true, AI_REPAIR_EXPRESSION); // no chat model connected
    expect(resolvedTrue).toHaveLength(2);
    expect(JSON.stringify(resolvedTrue[0])).toContain('AI repair is on but no chat model is connected. Connect one to the Model input.');

    expect(await run(false, false)).toHaveLength(1);
    expect(engine.calls).toEqual([]);
  });
});

describe('credentials', () => {
  const shown = (operation: string) => (d.credentials ?? []).filter((c) => NodeHelpers.displayParameter({ operation }, c, null, d)).map((c) => c.name);
  it('Browser on every operation except Sign Steps; Site Login on Run, Sign and Import Steps; Step Signing only on Run and Sign Steps; Redis on Run and Import Steps', () => {
    expect(shown('runSteps')).toEqual(['playwrightBrowserApi', 'playwrightSiteLoginApi', 'playwrightScriptSigningApi', 'playwrightRedisApi']);
    expect(shown('signSteps')).toEqual(['playwrightSiteLoginApi', 'playwrightScriptSigningApi']);
    expect(shown('importSteps')).toEqual(['playwrightBrowserApi', 'playwrightSiteLoginApi', 'playwrightRedisApi']); // no signing key: Sign Steps signs
    expect(shown('screenshot')).toEqual(['playwrightBrowserApi']); // quick operations take no Site Login
  });
  it('Step Signing is not marked required (runtime check per operation); Browser is', () => {
    expect((d.credentials ?? []).map((c) => [c.name, c.required])).toEqual([
      ['playwrightBrowserApi', true], ['playwrightSiteLoginApi', false], ['playwrightScriptSigningApi', false], ['playwrightRedisApi', false],
    ]);
  });
});

describe('wording and guidance', () => {
  it('no UI text contains a use-case word', () => {
    const texts = [
      d.displayName, d.description, String(d.subtitle), ...(d.credentials ?? []).map((c) => String(c.displayName)), ...uiTexts(d.properties), ...Object.values(GUIDANCE),
    ];
    for (const t of texts) expect(t, t).not.toMatch(USE_CASE_WORDS);
  });
  it('GUIDANCE is the guidance table, verbatim', () => {
    expect(GUIDANCE).toEqual({
      login_failed: 'The site rejected the username or password. The login breaker is now open: fix the RPA Site Login credential, then change Options → Login Breaker Reset Key.',
      account_locked: 'The site says the account is locked. Unlock it with the site owner, then change Options → Login Breaker Reset Key.',
      auth_blocked: 'The site asked for a second factor the node cannot answer. A person has to sign in.',
      site_down: 'The site did not answer, returned a server error, or the first page did not finish loading in time. Try again later.',
      browser_unavailable: 'The browser server could not be reached or was rejected. Check the RPA Browser credential (README: Where the browser runs).',
      drift_detected: 'The page no longer matches the steps: an element was not found or matched more than one. Fix the locator, or use Run Steps with AI repair.',
      not_found: 'The page or the data was not found.',
      incomplete: 'Not every row the page states was read, a capture failed, a limit was hit, the run timed out, or it was cancelled.',
      script_untrusted: 'The steps are not signed by the Step Signing key, or the signature does not match their name, version, start site, Site Login, approver or the expected version. Nothing ran.',
      policy_violation: 'The steps or the page tried something not allowed: an unlisted or private site, a write, a password field, or a secret outside sign-in. The run stopped.',
      locked_out: 'An earlier login failed and the breaker is open. Check the account, then change Options → Login Breaker Reset Key.',
      busy: 'Another run using this Site Login is in progress. This run was skipped.',
    });
  });
});

describe('quick operations', () => {
  const ops = OPERATIONS.options as INodePropertyOptions[];
  const values = ops.map((o) => String(o.value));
  const quick = values.filter((v) => !EXPERT.includes(v));
  const SPEC: [string, string][] = [
    ['screenshot', 'Take a screenshot of a page'], ['getPage', 'Get the text, HTML or title of a page'], ['pdf', 'Save a page as PDF'],
    ['extract', 'Extract a table or list from a page'], ['fillForm', 'Fill in and submit a form'], ['download', 'Download a file from a page'],
    ['runSteps', 'Run a list of browser steps'], ['signSteps', 'Sign a repaired step list'],
    ['importSteps', 'Import steps from a recording, code or a UiPath bot'],
  ];

  it('lists the operations in menu order with their actions; Screenshot is first and the default', () => {
    expect(ops.map((o) => [o.value, o.action])).toEqual(SPEC.filter(([v]) => values.includes(v)));
    expect(values[0]).toBe('screenshot');
    expect(values.slice(-3)).toEqual(EXPERT);
    expect(OPERATIONS.default).toBe('screenshot');
  });
  it('QUICK_OPERATIONS, COMPILERS and DISPATCH cover exactly the operations in the list', () => {
    expect(QUICK_OPERATIONS).toEqual(quick);
    expect(Object.keys(COMPILERS).sort()).toEqual([...quick].sort());
    expect(Object.keys(DISPATCH).sort()).toEqual([...values].sort());
  });
  it('every quick operation has at least one field of its own (description/<op>.ts, read by quickFieldNames)', () => {
    // Exceptions: none. An operation with only URL and Options would list itself here with the reason.
    const NO_FIELDS = new Set<string>();
    for (const op of QUICK_OPERATIONS.filter((o) => !NO_FIELDS.has(o))) expect(quickFieldNames(op as QuickOp).length, op).toBeGreaterThan(0);
  });
  it('the URL field: required, every quick operation, placeholder and hint', () => {
    const url = properties.find((p) => p.name === 'url');
    expect(url).toMatchObject({ type: 'string', required: true, placeholder: 'https://example.com/pricing', displayOptions: { show: { operation: quick } } });
    expect(url?.hint).toBe('Only this site is visited. Other sites are blocked. Add more under Options → Also Allow These Sites.');
    expect(URL_HINT).toBe(url?.hint);
  });
  it('quick operations offer only the RPA Browser credential: no Site Login, no Step Signing', () => {
    const creds = new Playwright().description.credentials ?? [];
    const shownFor = (c: INodeCredentialDescription, op: string) => {
      const show = c.displayOptions?.show?.operation;
      const hide = c.displayOptions?.hide?.operation;
      return (show === undefined || show.includes(op)) && !(hide?.includes(op) ?? false);
    };
    for (const op of quick) {
      expect(creds.filter((c) => shownFor(c, op)).map((c) => c.name), op).toEqual(['playwrightBrowserApi']);
    }
  });
  it('Wait Until: Load (default), DOM Content Loaded, Network Idle (warns that it can hang)', () => {
    const collection = properties.find((p) => p.name === 'options');
    const waitUntil = (collection?.options as INodeProperties[]).find((o) => o.name === 'waitUntil');
    expect(waitUntil?.default).toBe('load');
    expect((waitUntil?.options as INodePropertyOptions[]).map((o) => [o.name, o.value])).toEqual([
      ['Load', 'load'], ['DOM Content Loaded', 'domcontentloaded'], ['Network Idle', 'networkidle'],
    ]);
    expect((waitUntil?.options as INodePropertyOptions[])[2].description).toMatch(/can hang on pages that poll/i);
  });
  it('the Options collection is shown for every operation, and each entry names only operations that exist', () => {
    const collection = properties.find((p) => p.name === 'options');
    expect(collection?.displayOptions?.show?.operation).toEqual(expect.arrayContaining(values));
    for (const entry of collection?.options as INodeProperties[]) {
      for (const op of entry.displayOptions?.show?.['/operation'] ?? []) expect(values, `${entry.name} → ${String(op)}`).toContain(op);
    }
  });
  it('the subtitle names the selected operation', () => {
    const subtitle = String(new Playwright().description.subtitle);
    const body = subtitle.replace(/^=\{\{/, '').replace(/\}\}$/, '');
    const evaluate = new Function('$parameter', `return (${body});`) as ($parameter: Record<string, unknown>) => unknown;
    expect(evaluate({ operation: 'screenshot' })).toBe('Screenshot');
    expect(evaluate({ operation: 'runSteps' })).toBe('Run Steps');
    expect(evaluate({ operation: 'signSteps' })).toBe('Sign Steps');
  });
});
