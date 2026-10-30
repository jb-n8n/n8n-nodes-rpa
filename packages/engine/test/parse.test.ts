import { describe, expect, it } from 'vitest';
import { parseScript, ScriptShapeError, verbOf } from '../src/steps/parse.js';
import { baselineScript, reportScript } from './helpers.js';
import { FIRST_STEP_GOTO } from '../src/messages.js';

const URL0 = 'http://127.0.0.1:9999';
const withStep = (step: unknown) => ({ ...baselineScript(URL0), steps: [step] });
const issuesOf = (input: unknown): string[] => {
  try { parseScript(input); return []; } catch (e) { return (e as ScriptShapeError).issues; }
};

describe('parseScript', () => {
  it('accepts the baseline and report scripts and returns a clone', () => {
    const s = baselineScript(URL0);
    const parsed = parseScript(s);
    expect(parsed).toEqual(s);
    expect(parsed).not.toBe(s);
    expect(() => parseScript(reportScript(URL0))).not.toThrow();
  });
  it('identifies the verb of a step', () => {
    expect(verbOf({ intent: 'x', click: { css: 'a' } })).toBe('click');
  });
  it('rejects bad top-level fields', () => {
    expect(issuesOf({ name: '', version: 0, startUrl: '/acme/login', steps: [] })).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/name/), expect.stringMatching(/version/),
        expect.stringMatching(/startUrl/), expect.stringMatching(/steps/),
      ]),
    );
  });
  it('rejects unknown verbs, two verbs, missing intent and unknown keys', () => {
    expect(issuesOf(withStep({ intent: 'x', hover: { css: 'a' } }))[0]).toMatch(/exactly one action/);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, goto: '/x' }))[0]).toMatch(/exactly one action/);
    expect(issuesOf(withStep({ click: { css: 'a' } }))[0]).toMatch(/intent/);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, eval: 'alert(1)' }))[0]).toMatch(/unknown key "eval"/);
  });
  it('rejects malformed locators', () => {
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a', text: 'b' } }))[0]).toMatch(/exactly one of/);
    expect(issuesOf(withStep({ intent: 'x', click: {} }))[0]).toMatch(/exactly one of/);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a', fallbacks: [{ css: 'b', fallbacks: [{ css: 'c' }] }] } }))[0]).toMatch(/nested fallbacks/);
  });
  it('validates regexes, loops and detect', () => {
    expect(issuesOf(withStep({ intent: 'x', extract: { scope: { css: 'main' }, idPattern: '(' } }))[0]).toMatch(/idPattern/);
    expect(issuesOf(withStep({ intent: 'x', paginate: { next: { text: 'Next' }, until: 'absent', each: [{ intent: 'y', click: { css: 'a' } }] } }))[0]).toMatch(/max/);
    expect(issuesOf(withStep({ intent: 'x', clickAll: { target: { css: 'a' }, max: 500 } }))[0]).toMatch(/max/);
    const nested = { intent: 'x', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'y', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'z', click: { css: 'a' } }] } }] } };
    expect(issuesOf(withStep(nested))[0]).toMatch(/nested paginate/);
    expect(issuesOf(withStep({ intent: 'x', detect: { name: 'd', checks: { a: { css: 'a' } }, require: 'b' } }))[0]).toMatch(/require/);
  });
  it('restricts signIn placement and frames', () => {
    const si = { username: { css: '#u' }, password: { css: '#p' }, submit: { css: '#s' } };
    const inLoop = { intent: 'x', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'y', signIn: si }] } };
    expect(issuesOf(withStep(inLoop)).join('\n')).toMatch(/signIn is not allowed inside paginate/);
    expect(issuesOf(withStep({ intent: 'x', signIn: { ...si, password: { css: '#p', frame: 'iframe' } } }))[0]).toMatch(/password cannot use frame/);
  });
  it('validates submit, download and timeouts', () => {
    expect(issuesOf(withStep({ intent: 'x', submit: { button: { css: 'b' }, path: 'reports' } }))[0]).toMatch(/path/);
    expect(issuesOf(withStep({ intent: 'x', submit: { button: { css: 'b' }, path: '/r', method: 'TRACE' } }))[0]).toMatch(/method/);
    expect(issuesOf(withStep({ intent: 'x', download: { trigger: { css: 'b' }, maxBytes: -1 } }))[0]).toMatch(/maxBytes/);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, timeoutMs: 5 }))[0]).toMatch(/timeoutMs/);
  });
  it('download.check validates', () => {
    const dl = (check: unknown) => withStep({ intent: 'x', download: { trigger: { css: 'b' }, check } });
    expect(issuesOf(dl({ name: '^A', minBytes: 1, columns: ['A'], minRows: 0 }))).toEqual([]);
    expect(issuesOf(dl({ x: 1 }))[0]).toMatch(/download\.check has unknown key "x"/);
    expect(issuesOf(dl({ name: '(' }))[0]).toMatch(/check\.name is not a valid regex/);
    expect(issuesOf(dl({ columns: [] }))[0]).toMatch(/check\.columns/);
    expect(issuesOf(dl({ columns: Array.from({ length: 51 }, () => 'a') }))[0]).toMatch(/check\.columns/);
    expect(issuesOf(dl({ columns: ['a'.repeat(201)] }))[0]).toMatch(/check\.columns/);
    expect(issuesOf(dl({ minRows: -1 }))[0]).toMatch(/check\.minRows/);
    expect(issuesOf(dl({ minBytes: 0 }))[0]).toMatch(/check\.minBytes/);
  });
  it('rejects unknown keys in verb bodies and related objects', () => {
    expect(issuesOf(withStep({ intent: 'x', extract: { scope: { css: 'main' }, idPattern: 'a', eval: 'x' } }))[0]).toMatch(/steps\[0\]\.extract has unknown key "eval"/);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, when: { visible: { css: 'a' }, script: 'x' } }))[0]).toMatch(/when has unknown key "script"/);
    expect(issuesOf(withStep({ intent: 'x', detect: { name: 'd', checks: { a: { css: 'a' } }, require: 'constructor' } }))[0]).toMatch(/require/);
  });
  it('rejects unknown keys in interrupts', () => {
    const script = { ...baselineScript(URL0), interrupts: [{ target: { css: 'a' }, click: { css: 'b' }, extra: 'key' }] };
    expect(issuesOf(script)[0]).toMatch(/interrupts\[0\] has unknown key "extra"/);
  });
  it('validates paginate nextWaitMs', () => {
    const pg = (nextWaitMs: unknown) => withStep({ intent: 'x', paginate: { next: { text: 'N' }, until: 'absent', max: 2, nextWaitMs, each: [{ intent: 'y', click: { css: 'a' } }] } });
    expect(issuesOf(pg(0))).toEqual([]);
    expect(issuesOf(pg(10_000))).toEqual([]);
    expect(issuesOf(pg(10_001))[0]).toMatch(/nextWaitMs must be an integer between 0 and 10000/);
    expect(issuesOf(pg(1.5))[0]).toMatch(/nextWaitMs/);
  });
});

describe('download mime', () => {
  it('rejects an empty MIME list instead of silently refusing every file', () => {
    const s = reportScript(URL0);
    const steps = s.steps.map((st) => ('download' in st ? { ...st, download: { ...st.download, mime: [] } } : st));
    expect(() => parseScript({ ...s, steps })).toThrow(/steps\[5\]\.download\.mime must be a non-empty array of strings/);
  });
});

describe('name replaces portal', () => {
  it('refuses a portal key', () => {
    const { name, ...rest } = baselineScript(URL0);
    expect(issuesOf({ ...rest, portal: name })).toEqual(['script has unknown key "portal"']);
    expect(parseScript(baselineScript(URL0)).name).toBe('demo-sandbox');
  });
});

describe('shape relaxations', () => {
  const open = { intent: 'Open', goto: 'https://Example.com/pricing?x=1' };
  it('accepts a document without name and version, and fills startUrl from the first absolute goto', () => {
    const s = parseScript({ steps: [open] });
    expect(s).toEqual({ steps: [open], startUrl: 'https://example.com/pricing?x=1' });
    expect(s.name).toBeUndefined();
    expect(s.version).toBeUndefined();
  });
  it('accepts a bare array of steps', () => {
    expect(parseScript([open])).toEqual({ steps: [open], startUrl: 'https://example.com/pricing?x=1' });
  });
  it('keeps a given startUrl as written and never changes the raw input', () => {
    const doc = { name: 'prices', startUrl: 'https://example.com/start', steps: [open] };
    const before = JSON.stringify(doc);
    expect(parseScript(doc).startUrl).toBe('https://example.com/start');
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('without startUrl or an absolute first goto it uses defaultStartUrl, else fails with the golden message', () => {
    const rel = [{ intent: 'Open', goto: '/pricing' }];
    expect(parseScript(rel, { defaultStartUrl: 'https://example.com/' }).startUrl).toBe('https://example.com/');
    expect(parseScript([open], { defaultStartUrl: 'https://other.example/' }).startUrl).toBe('https://example.com/pricing?x=1');
    expect(issuesOf(rel)).toEqual([FIRST_STEP_GOTO]);
    expect(issuesOf([{ intent: 'Click', click: { css: 'a' } }])).toEqual([FIRST_STEP_GOTO]);
    expect(issuesOf([{ intent: 'Open', goto: 'https://example.com/?q={{var.q}}' }])).toEqual([FIRST_STEP_GOTO]);
    expect(issuesOf([{ intent: 'Open', goto: 'ftp://example.com/' }])).toEqual([FIRST_STEP_GOTO]);
    expect(FIRST_STEP_GOTO).toBe('the first step must be goto to an absolute URL, or set startUrl');
  });
  it('a present name or version must still be valid', () => {
    expect(issuesOf({ name: '', steps: [open] })).toEqual(['name must be a non-empty string']);
    expect(issuesOf({ version: 0, steps: [open] })).toEqual(['version must be a positive integer']);
  });
  it('waitUntil is allowed only on goto, with one of three values', () => {
    expect(parseScript([{ ...open, waitUntil: 'networkidle' }]).steps[0]).toMatchObject({ waitUntil: 'networkidle' });
    expect(issuesOf([{ ...open, waitUntil: 'idle' }])).toEqual(['steps[0].waitUntil must be "load", "domcontentloaded" or "networkidle"']);
    expect(issuesOf([open, { intent: 'Click', click: { css: 'a' }, waitUntil: 'load' }])).toEqual(['steps[1] has unknown key "waitUntil"']);
  });
  it('extract: idPattern is optional when there is an item locator; attribute is allowlisted and needs a locator', () => {
    const ex = (extract: unknown) => issuesOf([open, { intent: 'Read', extract }]);
    expect(ex({ scope: { css: 'ul' }, item: { css: 'li' } })).toEqual([]);
    expect(ex({ scope: { css: 'ul' } })).toEqual(['steps[1].extract needs an item locator when it has no idPattern']);
    for (const attribute of ['text', 'href', 'src', 'title', 'alt', 'aria-label']) {
      expect(ex({ scope: { css: 'ul' }, item: { css: 'li' }, fields: { f: { locator: { css: 'a' }, attribute } } })).toEqual([]);
    }
    expect(ex({ scope: { css: 'ul' }, item: { css: 'li' }, fields: { v: { locator: { css: 'input' }, attribute: 'value' } } }))
      .toEqual(['steps[1].extract.fields.v.attribute must be one of text, href, src, title, alt, aria-label']);
    expect(ex({ scope: { css: 'ul' }, item: { css: 'li' }, fields: { v: { pattern: '\\d+', attribute: 'href' } } }))
      .toEqual(['steps[1].extract.fields.v.attribute needs a locator']);
  });
  it('locators accept exact on text, label and role', () => {
    for (const loc of [{ text: 'Sign in', exact: true }, { label: 'Email address', exact: true }, { role: 'button', name: 'Submit', exact: true }]) {
      expect(issuesOf([open, { intent: 'Click', click: loc }])).toEqual([]);
    }
  });
});

describe('capture verbs', () => {
  const open = { intent: 'Open', goto: 'https://example.com/' };
  const one = (step: unknown) => issuesOf([open, step]);
  it('accepts the four verbs', () => {
    for (const step of [
      { intent: 's', screenshot: { capture: 'full' } }, { intent: 's', screenshot: { capture: 'viewport' } },
      { intent: 's', screenshot: { capture: 'element', element: { css: 'table' } } },
      { intent: 'p', pdf: {} }, { intent: 'p', pdf: { paper: 'Letter', background: true } },
      { intent: 'r', read: { what: 'text' } }, { intent: 'r', read: { what: 'html' } }, { intent: 'r', read: { what: 'title' } }, { intent: 'r', read: { what: 'url' } },
      { intent: 't', extractTable: { table: { css: 'table' } } }, { intent: 't', extractTable: { table: { css: 'table' }, idPattern: 'SKU-\\d+' } },
    ]) expect(one(step)).toEqual([]);
  });
  it('rejects bad values with a precise issue', () => {
    expect(one({ intent: 's', screenshot: { capture: 'page' } })).toEqual(['steps[1].screenshot.capture must be "full", "viewport" or "element"']);
    expect(one({ intent: 's', screenshot: { capture: 'element' } })).toEqual(['steps[1].screenshot.element must be a locator object']);
    expect(one({ intent: 's', screenshot: { capture: 'full', element: { css: 'a' } } })).toEqual(['steps[1].screenshot.element is only used with capture "element"']);
    expect(one({ intent: 'p', pdf: { paper: 'A3' } })).toEqual(['steps[1].pdf.paper must be "A4" or "Letter"']);
    expect(one({ intent: 'p', pdf: { background: 'yes' } })).toEqual(['steps[1].pdf.background must be a boolean']);
    expect(one({ intent: 'r', read: { what: 'cookies' } })).toEqual(['steps[1].read.what must be "text", "html", "title" or "url"']);
    expect(one({ intent: 't', extractTable: { table: { css: 'table' }, idPattern: '(' } })).toEqual(['steps[1].extractTable.idPattern is not a valid regex']);
    expect(one({ intent: 't', extractTable: { table: { css: 'table' }, columns: 3 } })).toEqual(['steps[1].extractTable has unknown key "columns"']);
  });
});

describe('locator variables and multi-select', () => {
  const doc = (steps: unknown[]) => ({ name: 'x', version: 1, startUrl: `${URL0}/acme/login`, steps: [{ intent: 'Open', goto: '/acme/login' }, ...steps] });
  it('accepts {{var.x}} in a role name and a text locator, and a select value that is a string array', () => {
    expect(() => parseScript(doc([
      { intent: 'Open one', click: { role: 'link', name: '{{var.item}}' } },
      { intent: 'Open text', click: { text: '{{var.item}} details', within: { role: 'navigation' } } },
      { intent: 'Pick', select: { field: { css: '#regions' }, value: ['north', '{{var.region}}'] } },
      { intent: 'Pick one', select: { field: { css: '#regions' }, value: 'north' } },
    ]))).not.toThrow();
  });
  it('refuses a select value that is an empty array, a non-string array, or holds {{$...}}', () => {
    const issues = (value: unknown) => { try { parseScript(doc([{ intent: 'Pick', select: { field: { css: '#r' }, value } }])); return []; } catch (e) { return (e as ScriptShapeError).issues; } };
    expect(issues([]).join('\n')).toMatch(/select\.value/);
    expect(issues([1]).join('\n')).toMatch(/select\.value/);
    expect(issues(['{{$exportDir}}']).join('\n')).toMatch(/\{\{\$/);
  });
});

describe('run variables in locators of write steps', () => {
  const V = { role: 'button', name: '{{var.who}}' };
  const si = (over: Record<string, unknown> = {}) => ({
    intent: 'In', signIn: { username: { label: 'U' }, password: { label: 'P' }, submit: { role: 'button', name: 'Go' }, ...over },
  });
  const refused = (step: unknown, at: RegExp) => expect(issuesOf(withStep(step)).join('\n')).toMatch(at);
  it('refuses {{var.*}} in every signIn locator', () => {
    for (const k of ['username', 'next', 'password', 'submit']) refused(si({ [k]: V }), new RegExp(`steps\\[0\\]\\.signIn\\.${k}`));
    refused(si({ username: { role: 'textbox', name: 'a', within: { text: '{{ var.x }}' }, } }), /var/);
    refused(si({ username: { text: '{{var.x}}' } }), /signIn\.username/);
    for (const k of ['field', 'submit']) refused(si({ totp: { field: { label: 'C' }, submit: { text: 'ok' }, [k]: V } }), new RegExp(`signIn\\.totp\\.${k}`));
    refused(si({ submit: { role: 'button', name: 'Go', fallbacks: [{ text: '{{var.x}}' }] } }), /signIn\.submit\.fallbacks/);
    for (const k of ['via', 'check']) refused(si({ totp: { field: { label: 'C' }, submit: { text: 'ok' }, [k]: [{ text: 'fine' }, V] } }), new RegExp(`signIn\\.totp\\.${k}\\[1\\]`));
  });
  it('refuses {{var.*}} in submit and download locators, also in when and expect and nested in paginate', () => {
    refused({ intent: 'S', submit: { path: '/x', button: V } }, /steps\[0\]\.submit\.button/);
    refused({ intent: 'D', download: { trigger: V } }, /steps\[0\]\.download\.trigger/);
    refused({ intent: 'D', download: { trigger: { text: 'x' }, via: { path: '/d' } }, when: { visible: V } }, /steps\[0\]\.when/);
    refused({ intent: 'D', download: { trigger: { text: 'x' } }, expect: { visible: V } }, /steps\[0\]\.expect/);
    const nested = { intent: 'P', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'D', download: { trigger: V } }] } };
    refused(nested, /each\[0\]\.download\.trigger/);
  });
  it('still allows a variable in a non-write click, waitFor, extract and fill value', () => {
    for (const step of [
      { intent: 'C', click: V },
      { intent: 'W', waitFor: { target: { text: '{{var.t}}' } } },
      { intent: 'E', extract: { scope: { css: 'table' }, item: V } },
      { intent: 'F', fill: { field: { label: 'Q' }, value: '{{var.q}}' } },
      { intent: 'D', download: { trigger: { text: 'x' }, via: { path: '/d/{{var.id}}' } } },
    ]) expect(issuesOf(withStep(step))).toEqual([]);
  });
});
