// The hand-written step-document JSON Schema mirrors parseScript. Every document the project ships or builds
// validates, and invalid documents parseScript rejects fail the schema too. The rules the schema cannot express are
// pinned at the end, so a change to either side shows up here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importSource } from '../src/import/index.js';
import type { ImportOptions, ImportSource } from '../src/import/types.js';
import { parseScript } from '../src/steps/parse.js';
import { STEP_VERBS } from '../src/types.js';
import { baselineScript, erpScript, ERP_CHECK, fioriScript, reportScript, SAP_VARS, SECRETS, SIGN_IN_STEPS, webguiScript } from './helpers.js';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const SCHEMA_ID = 'steps.schema.json';
const schema = JSON.parse(read('packages/engine/schema/steps.schema.json')) as Record<string, unknown>;
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema, SCHEMA_ID);
const validateDocument = ajv.getSchema(SCHEMA_ID)!;
const validateStep = ajv.getSchema(`${SCHEMA_ID}#/definitions/step`)!;

const errorsOf = (v: typeof validateDocument) => ajv.errorsText(v.errors);
const parses = (doc: unknown) => {
  try {
    parseScript(doc);
    return true;
  } catch {
    return false;
  }
};

/** Fenced ```json blocks of a Markdown file: whole step documents, or single steps (an object with an intent). */
function jsonBlocks(path: string): unknown[] {
  return [...read(path).matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]) as unknown);
}
const isStep = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) && 'intent' in v;

/** Literal step documents in the templates (an RPA node's Steps that is not an expression). */
function templateDocuments(): { at: string; doc: unknown }[] {
  const dir = new URL('packages/n8n-nodes-rpa/templates/', ROOT);
  const out: { at: string; doc: unknown }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const t = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as { nodes: { name: string; type: string; parameters: Record<string, unknown> }[] };
    for (const n of t.nodes) {
      const steps = n.parameters.steps;
      if (!n.type.endsWith('.playwright') || steps === undefined || steps === '') continue;
      if (typeof steps === 'string' && steps.startsWith('=')) continue; // mapped from a Data Table row at run time
      out.push({ at: `${file} ${n.name}`, doc: typeof steps === 'string' ? JSON.parse(steps) : steps });
    }
  }
  return out;
}

/** The UiPath fixture project, zipped as Studio exports it. */
function uipathZip(): Buffer {
  const dir = fileURLToPath(new URL('./fixtures/import/uipath-sap-report/', import.meta.url));
  const entries: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else entries[`SAP Line Item Report/${relative(dir, path).split('\\').join('/')}`] = strToU8(readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return Buffer.from(zipSync(entries));
}

/** Every draft the import fixtures give, with and without a Site Login, with and without an Expected File. */
function fixtureDrafts(): { at: string; doc: unknown }[] {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url));
  const sources: [ImportSource, Buffer][] = [
    ['chrome', fixture('chrome-sap-export.json')],
    ['playwright', fixture('playwright-sap-export.ts.txt')],
    ['uipath', uipathZip()],
  ];
  const variants: [string, ImportOptions][] = [
    ['site login + expected file', { name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: { mime: ['text/csv'], check: ERP_CHECK } }],
    ['site login', { name: 'sap-export', hasSiteLogin: true, secrets: SECRETS }],
    ['no site login', { name: 'sap-export', hasSiteLogin: false }],
  ];
  const out: { at: string; doc: unknown }[] = [];
  for (const [source, data] of sources) for (const [label, opts] of variants) {
    for (const d of importSource(source, data, opts).drafts) out.push({ at: `${source} (${label}) ${d.name}`, doc: d.script });
  }
  return out;
}

const URL_BASE = 'http://localhost:8080';
const loc = { css: '#x' };
/** One document with every verb and every optional field parseScript knows, so the schema is checked for breadth. */
const EVERY_FIELD = {
  name: 'every-field',
  version: 3,
  startUrl: `${URL_BASE}/start`,
  interrupts: [{ target: { css: '#cookie', within: { role: 'dialog' } }, click: { role: 'button', name: 'OK', exact: true } }],
  steps: [
    { intent: 'Open', goto: `${URL_BASE}/start`, waitUntil: 'networkidle', timeoutMs: 100, checkpoint: false, optional: false },
    { intent: 'Sign in', signIn: { username: { label: 'User' }, next: { role: 'button', name: 'Next' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Go' }, totp: { field: { label: 'Code' }, submit: { text: 'Verify' } } } },
    { intent: 'Click', click: { role: 'link', name: '', exact: false, frame: 'iframe#a', within: { testId: 'nav', within: { css: 'body' } }, fallbacks: [{ css: '#a' }, { text: 'A', exact: true }, { label: 'L' }, { testId: 't' }, { role: 'tab', within: { css: 'nav' } }] }, when: { visible: { css: '#c', fallbacks: [{ css: '#d' }] } }, expect: { url: '/next', heading: 'Next', visible: { text: 'Done' } } },
    { intent: 'Fill', fill: { field: { label: 'Name' }, value: '' } },
    { intent: 'Select', select: { field: { label: 'Kind' }, value: '{{var.kind}}' } },
    { intent: 'Select many', select: { field: { label: 'Kinds' }, value: ['a', '{{var.kind}}'] } },
    { intent: 'Open one by variable', click: { role: 'link', name: '{{var.item}}' } },
    { intent: 'Check', check: { field: { label: 'Agree' }, checked: false } },
    { intent: 'Check default', check: { field: { label: 'Agree' } } },
    { intent: 'Click all', clickAll: { target: loc, max: 100 } },
    { intent: 'Wait', waitFor: { target: loc, state: 'attached', hasText: 'ok', minCount: 10000 } },
    { intent: 'Wait for a response', waitFor: { response: { urlContains: '/api' } } },
    {
      intent: 'Pages',
      paginate: {
        next: { text: 'Next' }, until: 'disabled', max: 1, nextWaitMs: 0,
        each: [
          { intent: 'Rows', extract: { scope: { css: 'main' }, item: { css: 'li' }, textMode: 'text', fields: { a: { locator: { css: 'a' }, attribute: 'href' }, b: { pattern: 'B-\\d+' }, c: { locator: { css: 'c' } } } } },
          { intent: 'Inner click', click: loc },
        ],
      },
    },
    { intent: 'Extract by id', extract: { scope: { css: 'main' }, idPattern: 'N-\\d+' } },
    { intent: 'Submit', submit: { button: loc, path: '/save', host: 'localhost:8080', method: 'post' } },
    { intent: 'Download', download: { trigger: loc, via: { path: '/export', host: 'localhost', method: 'GET' }, maxBytes: 209715200, mime: ['text/csv'], check: { name: '^a', minBytes: 1, columns: ['A'], minRows: 0 } } },
    { intent: 'Popup', popup: { trigger: loc } },
    { intent: 'Detect', detect: { name: 'after', checks: { ok: loc, failed: { text: 'Error' } }, require: 'ok' } },
    { intent: 'Shot', screenshot: { capture: 'element', element: loc } },
    { intent: 'Full shot', screenshot: { capture: 'full' } },
    { intent: 'PDF', pdf: { paper: 'Letter', background: true } },
    { intent: 'PDF default', pdf: {} },
    { intent: 'Read', read: { what: 'url' } },
    { intent: 'Table', extractTable: { table: loc, idPattern: 'T\\d' } },
    { intent: 'Table without id', extractTable: { table: loc } },
  ],
};

describe('the step-document JSON Schema', () => {
  it('is draft-07 (what ajv supports by default) and compiles in the default strict mode of ajv', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(validateDocument).toBeTypeOf('function');
    expect(validateStep).toBeTypeOf('function');
  });

  it('names every step verb', () => {
    const verbs = ((schema.definitions as Record<string, { oneOf: { $ref: string }[] }>).step.oneOf).map((r) => r.$ref.replace('#/definitions/verb-', ''));
    expect(verbs).toEqual([...STEP_VERBS]);
  });

  it('every template, README example and import fixture draft validates against the step schema', () => {
    const helpers = [baselineScript(URL_BASE), reportScript(URL_BASE), webguiScript(URL_BASE), fioriScript(URL_BASE), erpScript(URL_BASE), { startUrl: URL_BASE, steps: SIGN_IN_STEPS }];
    const docs: { at: string; doc: unknown }[] = [
      ...templateDocuments(),
      ...jsonBlocks('README.md').map((doc, i) => ({ at: `README block ${i}`, doc })),
      ...jsonBlocks('docs/onboarding/sap-lookalike.md').map((doc, i) => ({ at: `sap-lookalike block ${i}`, doc })),
      ...fixtureDrafts(),
      ...helpers.map((doc, i) => ({ at: `test helper ${i}`, doc })),
      { at: 'every field', doc: EVERY_FIELD },
    ];
    // Templates map their steps from the playwright_steps Data Table, so none carries a literal document today.
    expect(templateDocuments()).toEqual([]);
    expect(jsonBlocks('README.md').length).toBeGreaterThanOrEqual(1);
    // chrome and playwright: one draft each per variant; uipath: one per browser sequence per variant.
    expect(fixtureDrafts().length).toBeGreaterThanOrEqual(6);
    for (const { at, doc } of docs) {
      if (isStep(doc)) {
        expect(validateStep(doc), `${at}: ${errorsOf(validateStep)}`).toBe(true);
        expect(parses({ startUrl: URL_BASE, steps: [doc] }), at).toBe(true);
      } else {
        expect(validateDocument(doc), `${at}: ${errorsOf(validateDocument)}`).toBe(true);
        expect(parses(doc), at).toBe(true);
      }
    }
  });

  it('the schema rejects what parseScript rejects for a sample of invalid documents', () => {
    const doc = (...steps: unknown[]) => ({ startUrl: URL_BASE, steps });
    const step = (extra: Record<string, unknown>) => ({ intent: 'x', ...extra });
    const invalid: [string, unknown][] = [
      ['not an object', 'steps'],
      ['an unknown top-level key', { ...doc(step({ click: loc })), $schema: './steps.schema.json' }],
      ['empty steps', doc()],
      ['more than 200 steps', doc(...Array.from({ length: 201 }, () => step({ click: loc })))],
      ['a startUrl that is not http(s)', { startUrl: 'ftp://example.com/', steps: [step({ click: loc })] }],
      ['a version of 0', { ...doc(step({ click: loc })), version: 0 }],
      ['two verbs in one step', doc(step({ click: loc, popup: { trigger: loc } }))],
      ['no verb', doc(step({}))],
      ['no intent', doc({ click: loc })],
      ['an intent over 200 characters', doc({ intent: 'x'.repeat(201), click: loc })],
      ['waitUntil on a click', doc(step({ click: loc, waitUntil: 'load' }))],
      ['a bad waitUntil', doc(step({ goto: `${URL_BASE}/a`, waitUntil: 'idle' }))],
      ['timeoutMs below 100', doc(step({ click: loc, timeoutMs: 50 }))],
      ['a locator with two kinds', doc(step({ click: { role: 'button', css: '#b' } }))],
      ['a locator with no kind', doc(step({ click: { name: 'Go' } }))],
      ['an empty locator value', doc(step({ click: { text: '' } }))],
      ['an unknown locator key', doc(step({ click: { css: '#a', nth: 1 } }))],
      ['nested fallbacks', doc(step({ click: { css: '#a', fallbacks: [{ css: '#b', fallbacks: [{ css: '#c' }] }] } }))],
      ['fallbacks inside within', doc(step({ click: { css: '#a', within: { css: '#w', fallbacks: [{ css: '#v' }] } } }))],
      ['six fallbacks', doc(step({ click: { css: '#a', fallbacks: Array.from({ length: 6 }, (_, i) => ({ css: `#f${i}` })) } }))],
      ['fallbacks on an interrupt', { ...doc(step({ click: loc })), interrupts: [{ target: { css: '#a', fallbacks: [{ css: '#b' }] }, click: loc }] }],
      ['signIn inside paginate', doc(step({ paginate: { next: loc, until: 'absent', max: 2, each: [step({ signIn: { username: loc, password: loc, submit: loc } })] } }))],
      ['nested paginate', doc(step({ paginate: { next: loc, until: 'absent', max: 2, each: [step({ paginate: { next: loc, until: 'absent', max: 2, each: [step({ click: loc })] } })] } }))],
      ['a signIn locator in a frame', doc(step({ signIn: { username: { label: 'U', frame: 'iframe' }, password: loc, submit: loc } }))],
      ['a signIn next in a frame', doc(step({ signIn: { username: loc, next: { text: 'Next', frame: 'iframe' }, password: loc, submit: loc } }))],
      ['a signIn next that is not a locator', doc(step({ signIn: { username: loc, next: 'Next', password: loc, submit: loc } }))],
      ['a signIn without submit', doc(step({ signIn: { username: loc, password: loc } }))],
      ['a fill without a value', doc(step({ fill: { field: loc } }))],
      ['clickAll max 101', doc(step({ clickAll: { target: loc, max: 101 } }))],
      ['a waitFor with neither target nor response', doc(step({ waitFor: { state: 'visible' } }))],
      ['an extract without idPattern or item', doc(step({ extract: { scope: loc } }))],
      ['a field with both locator and pattern', doc(step({ extract: { scope: loc, idPattern: 'a', fields: { f: { locator: loc, pattern: 'p' } } } }))],
      ['a field attribute without a locator', doc(step({ extract: { scope: loc, idPattern: 'a', fields: { f: { pattern: 'p', attribute: 'href' } } } }))],
      ['a submit path without a leading slash', doc(step({ submit: { button: loc, path: 'save' } }))],
      ['a submit method outside the list', doc(step({ submit: { button: loc, path: '/save', method: 'HEAD' } }))],
      ['a download check with minRows -1', doc(step({ download: { trigger: loc, check: { minRows: -1 } } }))],
      ['a download with 51 required columns', doc(step({ download: { trigger: loc, check: { columns: Array.from({ length: 51 }, (_, i) => `c${i}`) } } }))],
      ['an empty mime list', doc(step({ download: { trigger: loc, mime: [] } }))],
      ['a detect with no checks', doc(step({ detect: { name: 'd', checks: {} } }))],
      ['an element screenshot without its element', doc(step({ screenshot: { capture: 'element' } }))],
      ['an element on a full screenshot', doc(step({ screenshot: { capture: 'full', element: loc } }))],
      ['a pdf on A3', doc(step({ pdf: { paper: 'A3' } }))],
      ['a read of cookies', doc(step({ read: { what: 'cookies' } }))],
      ['optional as a string', doc(step({ click: loc, optional: 'yes' }))],
      ['a when without visible', doc(step({ click: loc, when: {} }))],
      ['an unknown expect key', doc(step({ click: loc, expect: { title: 'T' } }))],
      ['a secret fill with text around the template', doc(step({ fill: { field: loc, value: 'x{{var.p}}', secret: true } }))],
      ['a secret fill with a literal', doc(step({ fill: { field: loc, value: 'literal', secret: true } }))],
      ['a secret that is not a boolean', doc(step({ fill: { field: loc, value: '{{var.p}}', secret: 'yes' } }))],
      ['secret on select', doc(step({ select: { field: loc, value: '{{var.p}}', secret: true } }))],
    ];
    expect(invalid.length).toBeGreaterThanOrEqual(10);
    for (const [what, d] of invalid) {
      expect(parses(d), `parseScript accepts ${what}`).toBe(false);
      expect(validateDocument(d), `the schema accepts ${what}`).toBe(false);
    }
  });

  it('the schema accepts a secret fill with one var template, spaces included, and secret: false with any value', () => {
    const doc = (value: string, secret: boolean) => ({ startUrl: URL_BASE, steps: [{ intent: 'x', fill: { field: loc, value, secret } }] });
    for (const d of [doc('{{var.pw}}', true), doc('{{ var.pw }}', true), doc('literal', false)]) {
      expect(parses(d)).toBe(true);
      expect(validateDocument(d), errorsOf(validateDocument)).toBe(true);
    }
  });

  it('the rules the schema cannot express are the known gaps (the README lists them)', () => {
    const doc = (...steps: unknown[]) => ({ startUrl: URL_BASE, steps });
    const gaps: [string, unknown][] = [
      // 1. regular expressions are only checked to be non-empty strings
      ['an idPattern that is not a valid regex', doc({ intent: 'x', extractTable: { table: loc, idPattern: '(' } })],
      // 2. detect.require must name one of the checks
      ['a detect require naming no check', doc({ intent: 'x', detect: { name: 'd', checks: { ok: loc }, require: 'missing' } })],
      // 3. without a startUrl the first step must be an absolute goto, unless the node's Start URL supplies one
      ['no startUrl and no first goto', { steps: [{ intent: 'x', click: loc }] }],
      // 4. the schema checks the scheme of startUrl, not that the URL parses (and refuses `http:host`, see below)
      ['a startUrl that does not parse', { startUrl: 'http://exa mple.com', steps: [{ intent: 'x', click: loc }] }],
      // 5. lengths: parseScript counts UTF-16 code units, JSON Schema counts characters
      ['an intent of 101 emoji (202 code units)', doc({ intent: '😀'.repeat(101), click: loc })],
      // 6. names that start with $ are reserved in templates ({{$exportDir}} belongs to desktop step sets)
      ['a {{$...}} template', doc({ intent: 'x', fill: { field: loc, value: '{{$now}}' } })],
    ];
    for (const [what, d] of gaps) {
      expect(parses(d), `parseScript accepts ${what}`).toBe(false);
      expect(validateDocument(d), `the schema now rejects ${what}: move it to the invalid sample`).toBe(true);
    }
    // 4, the other way round: the schema is stricter. WHATWG URL parsing reads `http:host` as http://host/, which
    // parseScript accepts; the schema's pattern wants the two slashes (the README says so).
    for (const startUrl of ['http:erp.example.com/start', 'HTTPS:erp.example.com']) {
      const d = { startUrl, steps: [{ intent: 'x', click: loc }] };
      expect(parses(d), `parseScript refuses ${startUrl}`).toBe(true);
      expect(validateDocument(d), `the schema now accepts ${startUrl}: drop the "stricter" sentence from the README`).toBe(false);
    }
  });
});
