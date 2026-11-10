import { describe, expect, it } from 'vitest';
import { parseDesktopScript, parseScript, ScriptShapeError, verbOf } from '../src/steps/parse.js';
import { baselineScript, reportScript } from './helpers.js';
import { FIRST_STEP_GOTO, varInWriteLocator } from '../src/messages.js';
import { browserKeyProblem } from '../src/steps/browser-keys.js';

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
    expect(issuesOf(withStep({ intent: 'x', drag: { css: 'a' } }))[0]).toMatch(/exactly one action/);
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
  it("a browser step's timeoutMs may be up to 300000", () => {
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, timeoutMs: 300_000 }))).toEqual([]);
    expect(issuesOf(withStep({ intent: 'x', click: { css: 'a' }, timeoutMs: 300_001 }))[0]).toMatch(/timeoutMs must be an integer between 100 and 300000/);
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

describe('run variables in locator keys that are never rendered', () => {
  const at = (step: unknown) => issuesOf(withStep(step)).join('\n');
  it('refuses {{var.*}} in label, testId, css, frame and role, and in a name or text of another kind', () => {
    const cases: [unknown, RegExp][] = [
      [{ label: '{{var.x}}' }, /steps\[0\]\.click\.label: \{\{var\.\*\}\} is never rendered here/],
      [{ testId: 'row-{{ var.x }}' }, /steps\[0\]\.click\.testId: .*never rendered/],
      [{ css: '#{{var.x}}' }, /steps\[0\]\.click\.css: .*never rendered/],
      [{ css: '#a', frame: 'iframe[name="{{var.x}}"]' }, /steps\[0\]\.click\.frame: .*never rendered/],
      [{ role: '{{var.x}}' }, /steps\[0\]\.click\.role: .*never rendered/],
      [{ label: 'Q', name: '{{var.x}}' }, /steps\[0\]\.click\.name: .*never rendered/],
      [{ css: '#a', within: { label: '{{var.x}}' } }, /steps\[0\]\.click\.within\.label: .*never rendered/],
      [{ css: '#a', fallbacks: [{ testId: '{{var.x}}' }] }, /steps\[0\]\.click\.fallbacks\[0\]\.testId: .*never rendered/],
    ];
    for (const [loc, want] of cases) expect(at({ intent: 'C', click: loc }), JSON.stringify(loc)).toMatch(want);
    expect(at({ intent: 'F', fill: { field: { label: '{{var.f}}' }, value: 'x' } })).toMatch(/steps\[0\]\.fill\.field\.label: .*never rendered/);
    expect(at({ intent: 'C', click: { css: '#x' }, when: { visible: { css: '.{{var.c}}' } } })).toMatch(/steps\[0\]\.when\.visible\.css: .*never rendered/);
    expect(at({ intent: 'E', extract: { scope: { css: 'main' }, idPattern: 'N', fields: { a: { locator: { testId: '{{var.t}}' } } } } })).toMatch(/extract\.fields\.a\.locator\.testId: .*never rendered/);
    const nested = { intent: 'P', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'C', click: { css: '#{{var.x}}' } }] } };
    expect(at(nested)).toMatch(/each\[0\]\.click\.css: .*never rendered/);
  });
  it('refuses {{var.*}} anywhere in an interrupt locator: pop-up handlers are never rendered', () => {
    const doc = { ...baselineScript(URL0), interrupts: [{ target: { text: '{{var.x}}' }, click: { role: 'button', name: '{{var.y}}' } }] };
    const issues = issuesOf(doc).join('\n');
    expect(issues).toMatch(/interrupts\[0\]\.target\.text: .*never rendered/);
    expect(issues).toMatch(/interrupts\[0\]\.click\.name: .*never rendered/);
  });
  it('still accepts the rendered keys: a role name and a visible text, in within and fallbacks too', () => {
    for (const loc of [
      { role: 'link', name: '{{var.item}}' },
      { text: 'Row {{var.item}}' },
      { css: '#list', within: { role: 'region', name: '{{var.region}}' } },
      { css: '#a', fallbacks: [{ text: '{{var.item}}' }, { role: 'link', name: '{{ var.item }}' }] },
    ]) expect(issuesOf(withStep({ intent: 'C', click: loc })), JSON.stringify(loc)).toEqual([]);
    // Text that is not a run variable stays literal anywhere.
    expect(issuesOf(withStep({ intent: 'C', click: { css: '[data-x="{{ $ctrl.x }}"]' } }))).toEqual([]);
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
  describe('a paginate whose body writes', () => {
    const T = { text: 'Row {{var.who}}' };
    const pg = (each: unknown[], own: { when?: unknown; expect?: unknown; next?: unknown }) => ({
      intent: 'P', ...(own.when ? { when: own.when } : {}), ...(own.expect ? { expect: own.expect } : {}),
      paginate: { next: own.next ?? { text: 'N' }, until: 'absent', max: 5, each },
    });
    const own: [string, { when?: unknown; expect?: unknown; next?: unknown }, string][] = [
      ['when.visible text', { when: { visible: T } }, 'steps[0].when.visible.text'],
      ['when.visible role', { when: { visible: V } }, 'steps[0].when.visible.name'],
      ['when.visible within', { when: { visible: { css: '#t', within: V } } }, 'steps[0].when.visible.within.name'],
      ['when.visible fallbacks', { when: { visible: { css: '#t', fallbacks: [T] } } }, 'steps[0].when.visible.fallbacks[0].text'],
      ['expect.visible', { expect: { visible: V } }, 'steps[0].expect.visible.name'],
      ['next', { next: { role: 'link', name: 'Page {{var.n}}' } }, 'steps[0].paginate.next.name'],
      ['next within', { next: { text: 'Next', within: T } }, 'steps[0].paginate.next.within.text'],
      ['next fallbacks', { next: { text: 'Next', fallbacks: [V] } }, 'steps[0].paginate.next.fallbacks[0].name'],
    ];
    const bodies: [string, unknown][] = [
      ['submit', { intent: 'S', submit: { path: '/x', button: { role: 'button', name: 'Save' } } }],
      ['download', { intent: 'D', download: { trigger: { text: 'Export' } } }],
    ];
    it('refuses {{var.*}} in its own when, expect and next, within and fallbacks included', () => {
      for (const [where, o, path] of own) for (const [verb, body] of bodies) {
        expect(issuesOf(withStep(pg([{ intent: 'C', click: { css: '#a' } }, body], o))), `${where} over ${verb}`).toEqual([varInWriteLocator(path)]);
      }
    });
    it('keeps accepting them over a read-only body', () => {
      const read = [{ intent: 'C', click: V }, { intent: 'E', extract: { scope: { css: 'table' }, item: { css: 'tr' }, fields: { a: { locator: { css: 'td' } } } } }];
      for (const [where, o] of own) expect(issuesOf(withStep(pg(read, o))), where).toEqual([]);
    });
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

describe('step conditions (when)', () => {
  const click = (when: unknown) => ({ intent: 'Maybe', click: { css: '#a' }, when });
  const at = (step: unknown) => issuesOf(withStep(step));
  it('each of the four forms parses', () => {
    for (const when of [
      { visible: { css: '#a' } },
      { hidden: { role: 'dialog', name: '{{var.who}}' } },
      { var: 'mode', equals: 'full' },
      { var: '_mode_2', notEquals: '' },
    ]) expect(at(click(when)), JSON.stringify(when)).toEqual([]);
  });
  it('refuses two forms at once, an unknown key, a bad variable name and a value that is not literal text', () => {
    expect(at(click({ visible: { css: '#a' }, hidden: { css: '#b' } }))).toEqual(['steps[0].when must have exactly one of visible, hidden, or var with equals or notEquals']);
    expect(at(click({ visible: { css: '#a' }, var: 'mode', equals: 'x' }))).toEqual(['steps[0].when must have exactly one of visible, hidden, or var with equals or notEquals']);
    expect(at(click({ var: 'mode', equals: 'a', notEquals: 'b' }))).toEqual(['steps[0].when with var needs exactly one of equals or notEquals']);
    expect(at(click({ var: 'mode' }))).toEqual(['steps[0].when with var needs exactly one of equals or notEquals']);
    expect(at(click({ hidden: { css: '#a' }, equals: 'x' }))).toEqual(['steps[0].when.equals is used only with var']);
    expect(at(click({ var: 'mode', equals: 'x', script: 'y' }))).toEqual(['steps[0].when has unknown key "script"']);
    expect(at(click({}))).toEqual(['steps[0].when must have exactly one of visible, hidden, or var with equals or notEquals']);
    for (const name of ['1st', 'a-b', 'var.mode', '{{var.mode}}', '', 7]) {
      expect(at(click({ var: name, equals: 'x' })), String(name)).toEqual(['steps[0].when.var must be a variable name: letters, digits and _, not starting with a digit']);
    }
    expect(at(click({ var: 'mode', equals: 3 }))).toEqual(['steps[0].when.equals must be a string']);
    expect(at(click({ var: 'mode', equals: '{{var.other}}' }))).toEqual(['steps[0].when.equals is compared as literal text and may not hold {{']);
    expect(at(click({ var: 'mode', notEquals: 'a {{ b' }))).toEqual(['steps[0].when.notEquals is compared as literal text and may not hold {{']);
  });
  it('refuses a variable condition on a step that signs in or writes, nested in paginate too', () => {
    const W = { var: 'mode', equals: 'full' };
    const si = { username: { label: 'U' }, password: { label: 'P' }, submit: { role: 'button', name: 'Go' } };
    for (const step of [
      { intent: 'In', signIn: si, when: W },
      { intent: 'S', submit: { path: '/x', button: { css: '#b' } }, when: W },
      { intent: 'D', download: { trigger: { text: 'x' } }, when: W },
    ]) expect(at(step), Object.keys(step)[1]).toEqual(['steps[0].when may not use a variable on a step that signs in or writes']);
    const nested = { intent: 'P', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [{ intent: 'D', download: { trigger: { text: 'x' } }, when: W }] } };
    expect(at(nested)).toEqual(['steps[0].paginate.each[0].when may not use a variable on a step that signs in or writes']);
    // A paginate holding a write writes too: a variable condition on it would decide whether its body's write runs.
    const pg = (when: unknown, ...each: unknown[]) => ({ intent: 'P', when, paginate: { next: { text: 'N' }, until: 'absent', max: 1, each } });
    const sub = { intent: 'S', submit: { path: '/x', button: { css: '#b' } } };
    const dl = { intent: 'D', download: { trigger: { text: 'x' } } };
    const read = { intent: 'R', extract: { scope: { css: 'main' }, idPattern: 'N' } };
    expect(at(pg(W, read, sub))).toEqual(['steps[0].when may not use a variable on a step that signs in or writes']);
    expect(at(pg(W, dl))).toEqual(['steps[0].when may not use a variable on a step that signs in or writes']);
    expect(at(pg(W, read, { intent: 'C', click: { css: '#c' } }))).toEqual([]);
    for (const when of [{ visible: { css: '#more' } }, { hidden: { css: '#busy' } }]) expect(at(pg(when, sub, dl)), JSON.stringify(when)).toEqual([]);
    // The element forms stay allowed there, with a fixed locator.
    expect(at({ intent: 'In', signIn: si, when: { hidden: { css: '#signed-in' } } })).toEqual([]);
    expect(at({ intent: 'S', submit: { path: '/x', button: { css: '#b' } }, when: { hidden: { text: '{{var.who}}' } } })).toEqual([varInWriteLocator('steps[0].when.hidden.text')]);
  });
  it('refuses a variable condition on a variable that a secret fill types, anywhere in the list', () => {
    const doc = (...steps: unknown[]) => ({ ...baselineScript(URL0), steps: [{ intent: 'Open', goto: `${URL0}/a` }, ...steps] });
    const secret = { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{ var.exportPw }}', secret: true } };
    expect(issuesOf(doc(click({ var: 'exportPw', equals: 'x' }), secret))).toEqual(['steps[1].when may not test a variable that a secret fill types']);
    const nested = { intent: 'P', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [secret] } };
    expect(issuesOf(doc(nested, click({ var: 'exportPw', notEquals: '' })))).toEqual(['steps[2].when may not test a variable that a secret fill types']);
    const inLoop = { intent: 'P', paginate: { next: { text: 'N' }, until: 'absent', max: 2, each: [click({ var: 'exportPw', equals: 'x' })] } };
    expect(issuesOf(doc(secret, inLoop))).toEqual(['steps[2].paginate.each[0].when may not test a variable that a secret fill types']);
    // A plain fill of the same variable is no secret, and another variable is fine.
    expect(issuesOf(doc({ intent: 'F', fill: { field: { label: 'Q' }, value: '{{var.exportPw}}' } }, click({ var: 'exportPw', equals: 'x' })))).toEqual([]);
    expect(issuesOf(doc(secret, click({ var: 'mode', equals: 'x' })))).toEqual([]);
  });
  it('a desktop step with when.hidden or a variable condition is refused as before', () => {
    const uia = { uia: { path: [{ controlType: 'Button', automationId: 'ok' }] } };
    const desk = (when: unknown) => {
      try { parseDesktopScript({ surface: 'desktop', name: 'd', version: 1, app: { exe: 'App.exe' }, steps: [{ intent: 'x', click: uia, when }] }); return []; } catch (e) { return (e as ScriptShapeError).issues; }
    };
    expect(desk({ visible: uia })).toEqual([]);
    expect(desk({ hidden: uia })).toEqual(['steps[0].when has unknown key "hidden"', 'steps[0].when.visible must be a locator object']);
    expect(desk({ var: 'mode', equals: 'x' })).toEqual(['steps[0].when has unknown key "var"', 'steps[0].when has unknown key "equals"', 'steps[0].when.visible must be a locator object']);
  });
});

describe('press, hover and modifier clicks', () => {
  const at = (step: unknown) => issuesOf(withStep(step));
  const KEY_PROBLEM = browserKeyProblem('a') as string;
  it('press parses with and without a target, hover takes a locator, and click takes modifiers', () => {
    for (const step of [
      { intent: 'Search', press: { key: 'Enter', target: { label: 'Search' } } },
      { intent: 'Next field', press: { key: 'Shift+Tab' } },
      { intent: 'Select all', press: { key: 'Ctrl+A', target: { role: 'textbox', name: '{{var.field}}' } } },
      { intent: 'Open the menu', hover: { role: 'button', name: 'Reports' } },
      { intent: 'Open by name', hover: { text: '{{var.menu}}' } },
      { intent: 'Pick another', click: { text: 'Beta' }, modifiers: ['Ctrl'] },
      { intent: 'Pick a range', click: { text: 'Gamma' }, modifiers: ['Shift', 'Ctrl', 'Alt'] },
    ]) expect(at(step), JSON.stringify(step)).toEqual([]);
    expect(verbOf({ intent: 'x', press: { key: 'Tab' } })).toBe('press');
    expect(verbOf({ intent: 'x', hover: { css: 'a' } })).toBe('hover');
  });
  it('refuses an unknown key, a key with a variable, a bad target and unknown keys in press', () => {
    for (const key of ['a', 'Ctrl+V', 'Win+R', '', '{{var.key}}', 7, undefined]) {
      expect(at({ intent: 'x', press: { key } }), String(key)).toEqual([`steps[0].press.key ${KEY_PROBLEM}`]);
    }
    expect(at({ intent: 'x', press: { key: 'Tab', target: 'Search' } })).toEqual(['steps[0].press.target must be a locator object']);
    expect(at({ intent: 'x', press: { key: 'Tab', target: { label: '{{var.f}}' } } })).toEqual([expect.stringContaining('steps[0].press.target.label')]);
    expect(at({ intent: 'x', press: { key: 'Tab', text: 'x' } })).toEqual(['steps[0].press has unknown key "text"']);
    expect(at({ intent: 'x', press: 'Enter' })).toEqual(['steps[0].press must be an object']);
    expect(at({ intent: 'x', hover: 'Reports' })).toEqual(['steps[0].hover must be a locator object']);
  });
  it('refuses empty, repeated or unknown modifiers, and modifiers beside another verb', () => {
    const MODS = 'steps[0].modifiers must be a non-empty list of Ctrl, Shift and Alt, each at most once';
    for (const modifiers of [[], ['Ctrl', 'Ctrl'], ['Control'], ['Meta'], ['ctrl'], 'Ctrl', [1], null]) {
      expect(at({ intent: 'x', click: { css: '#a' }, modifiers }), JSON.stringify(modifiers)).toEqual([MODS]);
    }
    for (const step of [
      { intent: 'x', hover: { css: '#a' }, modifiers: ['Ctrl'] },
      { intent: 'x', press: { key: 'Enter' }, modifiers: ['Ctrl'] },
      { intent: 'x', clickAll: { target: { css: '#a' }, max: 2 }, modifiers: ['Shift'] },
      { intent: 'x', goto: `${URL0}/a`, modifiers: ['Ctrl'] },
    ]) expect(at(step), Object.keys(step)[1]).toEqual(['steps[0] has unknown key "modifiers"']);
    expect(at({ intent: 'x', click: { css: '#a' }, waitUntil: 'load', modifiers: ['Ctrl'] })).toEqual(['steps[0] has unknown key "waitUntil"']);
  });
  it('press is not a write: a variable condition and a variable in its target are allowed', () => {
    expect(at({ intent: 'x', press: { key: 'Enter', target: { text: '{{var.f}}' } }, when: { var: 'mode', equals: 'full' } })).toEqual([]);
  });
  it('the new verbs are browser steps: a desktop step set refuses them', () => {
    const desk = (step: unknown) => {
      try { parseDesktopScript({ surface: 'desktop', name: 'd', version: 1, app: { exe: 'App.exe' }, steps: [step] }); return []; } catch (e) { return (e as ScriptShapeError).issues; }
    };
    expect(desk({ intent: 'x', press: { key: 'Enter' } })).toEqual([expect.stringContaining('press')]);
    expect(desk({ intent: 'x', hover: { css: '#a' } })).toEqual([expect.stringContaining('hover')]);
  });
});

describe('signIn.changePassword', () => {
  const at = (step: unknown) => issuesOf(withStep(step));
  const CP = {
    detect: { role: 'heading', name: 'Change your password' },
    current: { label: 'Current password' },
    new: [{ label: 'New password' }, { label: 'Confirm new password' }],
    submit: { role: 'button', name: 'Change password' },
    value: '{{var.newPassword}}',
  };
  const si = (changePassword: unknown) => ({
    intent: 'Sign in',
    signIn: { username: { label: 'U' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Go' }, changePassword },
  });
  const VALUE = 'steps[0].signIn.changePassword.value must be exactly one {{var.name}} template (nothing before or after it)';
  it('parses with one or two new-password fields, spaces inside the template included', () => {
    expect(at(si(CP))).toEqual([]);
    expect(at(si({ ...CP, new: [{ label: 'New password' }], value: '{{ var.pw }}' }))).toEqual([]);
    expect(parseScript(withStep(si(CP))).steps[0]).toEqual(si(CP));
  });
  it('parses without current, for a change form that asks only for the new password', () => {
    const { current: _current, ...noCurrent } = CP;
    expect(at(si(noCurrent))).toEqual([]);
    expect(at(si({ ...noCurrent, new: [{ label: 'New password', exact: true }] }))).toEqual([]);
    expect(at(si({ ...CP, current: 'Current password' }))).toEqual(['steps[0].signIn.changePassword.current must be a locator object']);
  });
  it('refuses a missing value, a literal, text around the template and two variables', () => {
    const { value: _value, ...noValue } = CP;
    expect(at(si(noValue))).toEqual([VALUE]);
    for (const value of ['Literal-Pass-2026', 'x{{var.pw}}', '{{var.pw}}{{var.other}}', '{{secret.password}}', '{{$exportDir}}', 7]) {
      expect(at(si({ ...CP, value })), String(value)).toEqual([VALUE]);
    }
  });
  it('refuses no, three or no-locator new fields, a missing locator, a frame, and an unknown key', () => {
    for (const fields of [[], [CP.current, CP.current, CP.current], CP.current, undefined]) {
      expect(at(si({ ...CP, new: fields })), JSON.stringify(fields)).toEqual(['steps[0].signIn.changePassword.new must be an array of 1 or 2 locators']);
    }
    const { detect: _detect, ...noDetect } = CP;
    expect(at(si(noDetect))).toEqual(['steps[0].signIn.changePassword.detect must be a locator object']);
    expect(at(si({ ...CP, current: { label: 'Current password', frame: 'iframe' } }))).toEqual(['steps[0].signIn.changePassword.current cannot use frame']);
    expect(at(si({ ...CP, confirm: { label: 'Confirm' } }))).toEqual(['steps[0].signIn.changePassword has unknown key "confirm"']);
    expect(at(si('yes'))).toEqual(['steps[0].signIn.changePassword must be an object']);
  });
  it('refuses a run variable in any of its locators', () => {
    const V = { role: 'button', name: '{{var.who}}' };
    for (const [k, over] of [['detect', { detect: V }], ['current', { current: V }], ['new[1]', { new: [CP.new[0], V] }], ['submit', { submit: V }]] as const) {
      expect(at(si({ ...CP, ...over })), k).toEqual([varInWriteLocator(`steps[0].signIn.changePassword.${k}.name`)]);
    }
  });
  it('is refused outside signIn', () => {
    expect(at({ intent: 'x', changePassword: CP })).toEqual([expect.stringMatching(/^steps\[0\] must have exactly one action/)]);
    expect(at({ intent: 'x', click: { css: '#a' }, changePassword: CP })).toEqual(['steps[0] has unknown key "changePassword"']);
    expect(at({ intent: 'x', fill: { field: { label: 'P' }, value: '{{var.pw}}', secret: true, changePassword: CP } })).toEqual(['steps[0].fill has unknown key "changePassword"']);
    expect(at({ ...si(undefined), signIn: { ...si(undefined).signIn, totp: { field: { label: 'C' }, submit: { text: 'ok' }, changePassword: CP } } }))
      .toEqual(['steps[0].signIn.totp has unknown key "changePassword"']);
  });
  it('a variable condition on the new-password variable is refused', () => {
    const doc = (...steps: unknown[]) => ({ ...baselineScript(URL0), steps });
    const when = (w: unknown) => ({ intent: 'Maybe', click: { css: '#a' }, when: w });
    expect(issuesOf(doc(si(CP), when({ var: 'newPassword', equals: 'x' })))).toEqual(['steps[1].when may not test a variable that a secret fill types']);
    expect(issuesOf(doc(si({ ...CP, value: '{{ var.pw }}' }), when({ var: 'pw', notEquals: '' })))).toEqual(['steps[1].when may not test a variable that a secret fill types']);
    expect(issuesOf(doc(si(CP), when({ var: 'mode', equals: 'x' })))).toEqual([]);
  });
});
