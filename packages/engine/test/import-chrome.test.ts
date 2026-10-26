import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chromeEvents, MAX_CHROME_BYTES, MAX_CHROME_STEPS } from '../src/import/chrome.js';
import { importSource } from '../src/import/index.js';
import { loginBlockEnd } from '../src/policy/validate.js';
import type { ImportOptions, ImportReport, ImportResult } from '../src/import/types.js';
import { parseScript } from '../src/steps/parse.js';
import type { Step } from '../src/types.js';
import { ERP_CHECK, SAP_VARS, SECRETS } from './helpers.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

const FIXTURE = readFileSync(new URL('./fixtures/import/chrome-sap-export.json', import.meta.url));
const IDP_FIXTURE = readFileSync(new URL('./fixtures/import/chrome-idp-two-step.json', import.meta.url));
const ORIGIN = 'http://localhost:8080';
const TOTP_CODE = '482913';
const OPTS: ImportOptions = {
  name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: { mime: ['text/csv'], check: ERP_CHECK },
};

const newReport = (): ImportReport => ({ source: 'chrome', steps: 0, items: [] });
const verbOf = (s: Step) => Object.keys(s).find((k) => !['intent', 'expect', 'optional', 'when', 'checkpoint', 'timeoutMs'].includes(k));
const stepsOf = (r: ImportResult): Step[] => {
  expect(r.report.items.filter((i) => i.kind === 'error')).toEqual([]);
  expect(r.drafts).toHaveLength(1);
  return r.drafts[0].script.steps;
};
const recording = (steps: unknown[]) => JSON.stringify({ title: 't', steps });
const nav = (url = `${ORIGIN}/acme/home`) => ({ type: 'navigate', url });

describe('Chrome Recorder JSON', () => {
  it('the SAP export recording imports to a draft with signIn and a checked download', () => {
    const r = importSource('chrome', FIXTURE, OPTS);
    const steps = stepsOf(r);
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'goto', 'click', 'select', 'fill', 'fill', 'click', 'download']);
    expect(steps.map((s) => s.intent)).toEqual([
      'Open localhost:8080/acme/login',
      'Sign in with an authentication code',
      'Open localhost:8080/sap/bc/gui/sap/its/webgui',
      'Click Line Item Report',
      'Choose {{var.company}} in Company Code',
      'Type into From',
      'Type into To',
      'Click Execute',
      'Download with Export',
    ]);
    expect(r.drafts[0].script).toMatchObject({ name: 'sap-export', version: 1 });
    expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);

    const signIn = (steps[1] as S<'signIn'>).signIn;
    expect(signIn.username).toEqual({ label: 'Dealer user ID', exact: true, fallbacks: [{ text: 'Dealer user ID', exact: true }, { css: '#username' }] });
    expect(signIn.password).toEqual({ label: 'Password', exact: true, fallbacks: [{ text: 'Password', exact: true }, { css: '#password' }] });
    expect(signIn.submit).toEqual({ text: 'Sign in', exact: true, fallbacks: [{ label: 'Sign in', exact: true }, { text: 'Sign in' }, { css: '#sign-in' }] });
    expect(signIn.totp).toEqual({
      field: { label: 'Authentication code', exact: true, fallbacks: [{ text: 'Authentication code', exact: true }, { css: '#otp' }] },
      submit: { text: 'Verify', exact: true, fallbacks: [{ label: 'Verify', exact: true }, { text: 'Verify' }, { css: '#verify' }] },
    });

    // The asserted navigation became a path check on the goto, without the session segment.
    expect(steps[2]).toEqual({ intent: 'Open localhost:8080/sap/bc/gui/sap/its/webgui', goto: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, expect: { url: '/bc/gui/sap/its/webgui' } });
    // aria without a role on a click: text first, then label; generated ids never survive.
    expect((steps[3] as S<'click'>).click).toEqual({ text: 'Line Item Report', exact: true, fallbacks: [{ label: 'Line Item Report', exact: true }, { text: 'Line Item Report' }] });
    expect((steps[4] as S<'select'>).select).toEqual({ field: { role: 'combobox', name: 'Company Code', exact: true }, value: '{{var.company}}' });
    expect((steps[5] as S<'fill'>).fill).toEqual({ field: { label: 'From', exact: true, fallbacks: [{ text: 'From', exact: true }] }, value: '{{var.from}}' });
    expect((steps[6] as S<'fill'>).fill).toEqual({ field: { label: 'To', exact: true, fallbacks: [{ text: 'To', exact: true }] }, value: '{{var.to}}' });
    expect((steps[7] as S<'click'>).click).toEqual({ role: 'button', name: 'Execute', exact: true, fallbacks: [{ text: 'Execute' }] });
    expect((steps[8] as S<'download'>).download).toEqual({
      trigger: { text: 'Export', exact: true, fallbacks: [{ label: 'Export', exact: true }, { text: 'Export' }] }, mime: ['text/csv'], check: ERP_CHECK,
    });
    expect(JSON.stringify(steps)).not.toContain('M0:');

    const items = r.report.items;
    expect(items).toContainEqual(expect.objectContaining({ at: 'step 11', kind: 'untranslated', what: 'Wait for a JavaScript condition' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Viewport changes (1)' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Scrolls (1)' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'XPath selectors (11)' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Pierce selectors (11)' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Clicks into a field before typing (6)' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Click Export' }));
    expect(items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Dealer user ID', 'Password', 'Authentication code']);
    expect(r.report.steps).toBe(9);
  });

  it('typed password values never appear in the draft or report', () => {
    const typed = [SECRETS.username, SECRETS.password, TOTP_CODE];
    for (const opts of [OPTS, { ...OPTS, hasSiteLogin: false, secrets: undefined }, { name: 'x', hasSiteLogin: true, secrets: SECRETS }]) {
      const r = importSource('chrome', FIXTURE, opts);
      const all = JSON.stringify(r);
      for (const v of typed) expect(all).not.toContain(v);
      expect(r.report.items.length).toBeGreaterThan(0);
    }
    // The parser alone hands the values to stripSecrets in fill events only: never in a report item.
    const report = newReport();
    const events = chromeEvents(JSON.parse(FIXTURE.toString('utf8')), report);
    for (const v of typed) expect(JSON.stringify(report)).not.toContain(v);
    for (const e of events) if (e.kind !== 'fill' && e.kind !== 'select') for (const v of typed) expect(JSON.stringify(e)).not.toContain(v);
    // A password typed into a field with an unhelpful name, outside any sign-in, is still stripped.
    const odd = importSource('chrome', recording([
      nav(),
      { type: 'change', value: SECRETS.password, selectors: [['aria/Key'], ['#k']] },
      { type: 'change', value: 'oops-pass-1', selectors: [['aria/Notes'], ['input[type="password"]']] },
      { type: 'click', selectors: [['aria/Save[role="button"]']] },
    ]), OPTS);
    expect(JSON.stringify(odd)).not.toContain(SECRETS.password);
    expect(JSON.stringify(odd)).not.toContain('oops-pass-1');
  });

  it('aria with a role becomes a role locator', () => {
    const report = newReport();
    const events = chromeEvents({
      title: 't',
      steps: [
        nav(),
        { type: 'click', selectors: [['aria/Execute[role="button"]'], ["aria/Open (all)[role='link']"], ['aria/Menu[name="x"][role="menuitem"]']] },
        { type: 'change', value: 'B', selectors: [['aria/Plant[role="listbox"]']] },
        { type: 'change', value: 'C', selectors: [['form > div:nth-of-type(2) > select.sel'], ['aria/Region']] },
        { type: 'change', value: 'D', selectors: [['select[name="a b"] + input'], ['text/Region']] },
        { type: 'doubleClick', selectors: [['aria/[role="button"]'], ['text/Open']] },
      ],
    }, report);
    expect(events[1]).toMatchObject({
      kind: 'click', label: 'Execute',
      target: [{ role: 'button', name: 'Execute', exact: true }, { role: 'link', name: 'Open (all)', exact: true }, { role: 'menuitem', name: 'x', exact: true }],
    });
    expect(events[2]).toMatchObject({ kind: 'select', label: 'Plant', target: [{ role: 'listbox', name: 'Plant', exact: true }] });
    // A CSS selector ending in a select element makes the change a select; aria without a role on a field: label first.
    expect(events[3]).toMatchObject({ kind: 'select', label: 'Region', target: [{ css: 'form > div:nth-of-type(2) > select.sel' }, { label: 'Region', exact: true }, { text: 'Region', exact: true }] });
    // `select` earlier in the selector does not name the target element.
    expect(events[4]).toMatchObject({ kind: 'fill', target: [{ css: 'select[name="a b"] + input' }, { text: 'Region' }] });
    // A role without a name finds nothing in particular and is not a candidate; a double click is imported as a click and reported.
    expect(events[5]).toMatchObject({ kind: 'click', target: [{ text: 'Open' }] });
    expect(report.items).toContainEqual(expect.objectContaining({ at: 'step 6', kind: 'converted', what: 'Click Open' }));
  });

  it('steps outside the main page, shadow chains, keys and waits', () => {
    const report = newReport();
    const events = chromeEvents({
      title: 't',
      steps: [
        nav(),
        { type: 'click', target: 'https://popup.example.com/', selectors: [['#a']] },
        { type: 'click', frame: [0], selectors: [['#b']] },
        { type: 'click', selectors: [['my-app', '#shadow-button'], ['xpath///button'], ['pierce/#shadow-button']] },
        { type: 'change', value: 'hello', selectors: [['aria/Search']] },
        { type: 'keyDown', key: 'Enter' },
        { type: 'keyUp', key: 'Enter' },
        { type: 'keyDown', key: 'Tab' },
        { type: 'keyUp', key: 'Tab' },
        { type: 'hover', selectors: [['#menu']] },
        { type: 'waitForElement', selectors: [['aria/Results[role="grid"]']] },
        { type: 'waitForElement', selectors: [['#spinner']], visible: false },
        { type: 'close' },
        { type: 'customStep', name: 'x', parameters: {} },
        { type: 'emulateNetworkConditions', download: 1, upload: 1, latency: 1 },
        { type: 'teleport' },
        'not a step',
        { type: 'click', selectors: [['::-p-aria(Go)'], ['div >>> button']] },
      ],
    }, report);
    expect(events.filter((e) => e.kind !== 'report').map((e) => e.kind)).toEqual(['goto', 'fill', 'enter', 'waitFor']);
    expect(events.find((e) => e.kind === 'enter')).toEqual({ at: 'step 6', kind: 'enter', label: 'Search' });
    expect(events.find((e) => e.kind === 'waitFor')).toMatchObject({ target: [{ role: 'grid', name: 'Results', exact: true }] });
    const all = [...report.items, ...events.flatMap((e) => (e.kind === 'report' ? [e.item] : []))];
    const find = (at: string) => all.find((i) => i.at === at);
    expect(find('step 2')).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('another tab') });
    expect(find('step 3')).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('frame') });
    expect(find('step 4')).toMatchObject({ kind: 'dropped', reason: expect.stringContaining('no selector') });
    expect(find('step 8')).toMatchObject({ kind: 'untranslated', what: 'Press Tab' });
    expect(find('step 12')).toMatchObject({ kind: 'untranslated', what: 'Wait for #spinner' });
    expect(find('step 13')).toMatchObject({ kind: 'untranslated', what: 'Close the page' });
    expect(find('step 14')).toMatchObject({ kind: 'untranslated', what: 'Custom step' });
    expect(find('step 15')).toMatchObject({ kind: 'untranslated', what: 'Step type "emulateNetworkConditions"' });
    expect(find('step 16')).toMatchObject({ kind: 'untranslated', what: 'Step type "teleport"' });
    expect(find('step 17')).toMatchObject({ kind: 'untranslated', what: 'An unreadable step' });
    expect(find('step 18')).toMatchObject({ kind: 'dropped' });
    expect(all).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Shadow DOM or frame selector chains (1)' }));
    expect(all).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Key releases (2)' }));
    expect(all).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Hovers (1)' }));
    expect(all).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Puppeteer selectors (2)' }));
  });

  it('step types named like object properties are untranslated, and a typed space is named', () => {
    const report = newReport();
    const events = chromeEvents(JSON.parse(recording([
      nav(), { type: 'constructor' }, { type: '__proto__' }, { type: 'toString' }, { type: 'hasOwnProperty' },
      { type: 'keyDown', key: ' ' }, { type: 'keyDown', key: 'p' }, { type: 'keyDown', key: 'KeyP' },
    ])), report);
    expect(events.map((e) => e.kind)).toEqual(['goto']);
    expect(report.items.map((i) => [i.at, i.kind, i.what])).toEqual([
      ['step 2', 'untranslated', 'Step type "constructor"'],
      ['step 3', 'untranslated', 'Step type "__proto__"'],
      ['step 4', 'untranslated', 'Step type "toString"'],
      ['step 5', 'untranslated', 'Step type "hasOwnProperty"'],
      ['step 6', 'untranslated', 'Press Space'],
      ['step 7', 'untranslated', 'Press a key'],
      ['step 8', 'untranslated', 'Press a key'],
    ]);
  });

  it('a click is dropped as a focus click only when the change after it is imported', () => {
    const sel = [['aria/Customer'], ['#customer']];
    const focus = (change: Record<string, unknown>, click: Record<string, unknown> = {}) => {
      const report = newReport();
      const events = chromeEvents({ title: 't', steps: [nav(), { type: 'click', selectors: sel, ...click }, { type: 'change', value: 'Acme', selectors: sel, ...change }] }, report);
      return { kinds: events.map((e) => e.kind), focused: report.items.some((i) => i.what.startsWith('Clicks into a field')) };
    };
    // `target: "main"` and no target, `frame: []` and no frame, are the same page.
    expect(focus({}, { target: 'main', frame: [] })).toEqual({ kinds: ['goto', 'fill'], focused: true });
    expect(focus({ target: 'main', frame: [] })).toEqual({ kinds: ['goto', 'fill'], focused: true });
    // The change is not imported, so the click stays.
    expect(focus({ value: 7 })).toEqual({ kinds: ['goto', 'click'], focused: false });
    expect(focus({ target: 'https://popup.example.com/' })).toEqual({ kinds: ['goto', 'click'], focused: false });
    expect(focus({ frame: [1] })).toEqual({ kinds: ['goto', 'click'], focused: false });
    expect(focus({ selectors: [['#other']] })).toEqual({ kinds: ['goto', 'click', 'fill'], focused: false });
    // Selectors that give no candidate: the click is reported as having none, not counted as a focus click.
    const report = newReport();
    const none = [['xpath///input'], ['pierce/#c']];
    chromeEvents({ title: 't', steps: [nav(), { type: 'click', selectors: none }, { type: 'change', value: 'Acme', selectors: none }] }, report);
    expect(report.items.filter((i) => i.kind === 'dropped' && i.reason.startsWith('no selector')).map((i) => i.at)).toEqual(['step 2', 'step 3']);
    expect(report.items.some((i) => i.what.startsWith('Clicks into a field'))).toBe(false);
  });

  it('oversized recordings are refused', () => {
    const step = { type: 'scroll', x: 0, y: 1 };
    // A million steps: refused on size before it is parsed.
    const huge = JSON.stringify({ title: 'big', steps: Array.from({ length: 1_000_000 }, () => step) });
    expect(huge.length).toBeGreaterThan(MAX_CHROME_BYTES);
    // Just over the step cap but well under the size cap: refused on the count.
    const many = recording([nav(), ...Array.from({ length: MAX_CHROME_STEPS }, () => step)]);
    expect(many.length).toBeLessThan(MAX_CHROME_BYTES);
    for (const [data, reason] of [[huge, 'larger than 5 MiB'], [Buffer.from(huge), 'larger than 5 MiB'], [many, 'more than 5,000 steps']] as const) {
      const t0 = performance.now();
      const r = importSource('chrome', data, OPTS);
      expect(performance.now() - t0).toBeLessThan(200);
      expect(r.drafts).toEqual([]);
      expect(r.report.items).toEqual([expect.objectContaining({ kind: 'error', reason: expect.stringContaining(reason) })]);
    }
    // Within the caps, hostile selectors stay linear: a 400,000-part chain, bracket runs in an aria name, quotes in CSS.
    const hostile = recording([
      nav(),
      { type: 'click', selectors: [new Array(400_000).fill('a')] },
      { type: 'click', selectors: [[`aria/${'[role="x"]'.repeat(100_000)}`], [`aria/x${'['.repeat(500_000)}]`], [`${'"['.repeat(300_000)} select`]] },
    ]);
    expect(hostile.length).toBeLessThan(MAX_CHROME_BYTES);
    const t1 = performance.now();
    const h = importSource('chrome', hostile, OPTS);
    expect(performance.now() - t1).toBeLessThan(500);
    expect(h.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Shadow DOM or frame selector chains (1)' }));
    // Runs of escaped quotes in CSS reach the draft builder's id checks (draft.ts) through this path and stay linear there too.
    const quotes = recording([
      nav(),
      { type: 'click', selectors: [['\\"'.repeat(500_000)]] },
      { type: 'click', selectors: [["'\\".repeat(500_000)]] },
    ]);
    expect(quotes.length).toBeLessThan(MAX_CHROME_BYTES);
    const t2 = performance.now();
    expect(() => importSource('chrome', quotes, OPTS)).not.toThrow();
    expect(performance.now() - t2).toBeLessThan(1000);
    // An object already parsed is held to the step cap too.
    const report = newReport();
    expect(chromeEvents({ title: 'big', steps: new Array(MAX_CHROME_STEPS + 1).fill(step) }, report)).toEqual([]);
    expect(report.items).toEqual([expect.objectContaining({ kind: 'error' })]);
  });

  it('malformed JSON is a report error, not a throw', () => {
    const cases: unknown[] = [
      `{"title": "x", "steps": [{"type": "change", "value": "${SECRETS.password}"`,
      '',
      'null',
      '[1, 2]',
      '{"title": "x"}',
      '{"title": "x", "steps": {}}',
      Buffer.from([0xff, 0xfe, 0x00, 0x7b]),
    ];
    for (const data of cases) {
      let r: ImportResult | undefined;
      expect(() => { r = importSource('chrome', data as string, OPTS); }).not.toThrow();
      expect(r?.drafts).toEqual([]);
      expect(r?.report.items).toContainEqual(expect.objectContaining({ kind: 'error' }));
      // The JSON error text quotes the input, so it is never copied into the report.
      expect(JSON.stringify(r)).not.toContain(SECRETS.password);
    }
    const report = newReport();
    expect(chromeEvents(undefined, report)).toEqual([]);
    expect(report.items).toEqual([expect.objectContaining({ kind: 'error' })]);
  });

  it('a recording with no steps it can translate is IMPORT_EMPTY, and a byte-order mark is fine', () => {
    const r = importSource('chrome', `﻿${recording([{ type: 'setViewport', width: 1, height: 1 }])}`, OPTS);
    expect(r.drafts).toEqual([]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'error', reason: 'Nothing in this file could be turned into steps.' }));
  });

  it('an identity-first recording becomes signIn with next: email, Next, password, code, then "Stay signed in?" No', () => {
    const SSO2 = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
    const XLSX = { check: { name: '\\.XLSX$' } };
    const r = importSource('chrome', IDP_FIXTURE, { name: 'sap-sso2-export', hasSiteLogin: true, secrets: SSO2, download: XLSX });
    const steps = stepsOf(r);
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'click', 'click', 'fill', 'fill', 'fill', 'click', 'click', 'download']);
    expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);
    // The asserted redirect to the identity provider stays a check on the goto.
    expect(steps[0]).toEqual({ intent: 'Open localhost:8080/sap/bc/gui/sap/its/webgui', goto: `${ORIGIN}/sap/bc/gui/sap/its/webgui`, expect: { url: '/idp/login' } });
    expect(steps[1]).toEqual({
      intent: 'Sign in with an authentication code',
      signIn: {
        username: { label: 'Email', exact: true, fallbacks: [{ text: 'Email', exact: true }, { css: '#loginfmt' }] },
        next: { role: 'button', name: 'Next', exact: true, fallbacks: [{ text: 'Next' }, { css: '#idSIButton9' }] },
        password: { label: 'Password', exact: true, fallbacks: [{ text: 'Password', exact: true }, { css: '#passwd' }] },
        submit: { role: 'button', name: 'Sign in', exact: true, fallbacks: [{ text: 'Sign in' }, { css: '#idSIButton9' }] },
        totp: {
          field: { label: 'Code', exact: true, fallbacks: [{ text: 'Code', exact: true }, { css: '#otc' }] },
          submit: { role: 'button', name: 'Verify', exact: true, fallbacks: [{ text: 'Verify' }, { css: '#idSubmit_SAOTCC_Continue' }] },
        },
      },
    });
    // "Stay signed in?" No, right after the sign-in, runs only when the button shows, so it joins the login
    // block; the redirect to SAP checks it.
    expect(steps[2]).toEqual({
      intent: 'Click No',
      when: { visible: { role: 'button', name: 'No', exact: true } },
      click: { role: 'button', name: 'No', exact: true, fallbacks: [{ text: 'No' }, { css: '#idBtn_Back' }] },
      expect: { url: '/bc/gui/sap/its/webgui' },
    });
    expect(loginBlockEnd(r.drafts[0].script)).toBe(2);
    expect(r.report.items).toContainEqual(expect.objectContaining({ at: 'step 12', kind: 'converted', what: 'Click No' }));
    // Only the answer is gated: every later click stays a plain click.
    expect(steps.slice(3).some((s) => 'when' in s)).toBe(false);
    // The dialog's Continue (Enter) downloads, not the Spreadsheet... button that opens the dialog.
    expect(steps[8]).toMatchObject({ click: { role: 'button', name: 'Spreadsheet... (Ctrl+Shift+F7)' } });
    expect(steps[9]).toEqual({ intent: 'Download with "Continue (Enter)"', download: { trigger: { role: 'button', name: 'Continue (Enter)', exact: true, fallbacks: [{ text: 'Continue (Enter)' }] }, ...XLSX } });

    const items = r.report.items;
    expect(items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(items).toContainEqual(expect.objectContaining({ at: 'step 5', kind: 'dropped', what: 'URL check /idp/password', reason: expect.stringContaining('username and the password') }));
    expect(items).toContainEqual(expect.objectContaining({ at: 'step 8', kind: 'dropped', what: 'URL check /idp/mfa' }));
    expect(items.filter((i) => i.kind === 'untranslated' || i.kind === 'error')).toEqual([]);
    const json = JSON.stringify(r);
    for (const v of [SSO2.username, SSO2.password, TOTP_CODE]) expect(json).not.toContain(v);

    // Enter in the email field instead of Next: the form's submit button, reported.
    const steps2 = JSON.parse(IDP_FIXTURE.toString('utf8')) as { steps: Record<string, unknown>[] };
    const at = steps2.steps.findIndex((s) => JSON.stringify(s.selectors ?? '').includes('aria/Next'));
    steps2.steps.splice(at, 1, { type: 'keyDown', target: 'main', key: 'Enter' }, { type: 'keyUp', target: 'main', key: 'Enter' });
    const entered = importSource('chrome', JSON.stringify(steps2), { name: 'sap-sso2-export', hasSiteLogin: true, secrets: SSO2, download: XLSX });
    expect((stepsOf(entered)[1] as S<'signIn'>).signIn.next).toEqual({ css: 'form [type="submit"]', fallbacks: [{ css: 'form button:not([type])' }] });
    expect(entered.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Press Enter in Email' }));
    expect(JSON.stringify(entered)).not.toContain(SSO2.username);

    // The code typed from a variable instead of the recorded digits: still the sign-in's code, value dropped.
    const variable = JSON.parse(IDP_FIXTURE.toString('utf8')) as { steps: Record<string, unknown>[] };
    for (const s of variable.steps) if (s.value === TOTP_CODE) s.value = '{{var.otp}}';
    const fromVar = importSource('chrome', JSON.stringify(variable), { name: 'sap-sso2-export', hasSiteLogin: true, secrets: SSO2, download: XLSX });
    expect(stepsOf(fromVar)[1]).toEqual(steps[1]);
    expect(fromVar.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Code', reason: expect.stringContaining('fresh code') }));
    for (const v of [SSO2.username, SSO2.password, '{{var.otp}}']) expect(JSON.stringify(fromVar)).not.toContain(v);
  });

  it('the other sources are not wired yet and say so', () => {
    for (const source of ['uipath', 'selenium'] as const) {
      const r = importSource(source as 'uipath', 'x', OPTS);
      expect(r.drafts).toEqual([]);
      expect(r.report.items).toEqual([expect.objectContaining({ kind: 'error' })]);
    }
  });
});
