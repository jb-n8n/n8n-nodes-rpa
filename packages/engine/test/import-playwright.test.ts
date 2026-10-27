import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importSource } from '../src/import/index.js';
import { MAX_PLAYWRIGHT_BYTES, playwrightEvents } from '../src/import/playwright.js';
import type { ImportEvent, ImportItem, ImportOptions, ImportReport, ImportResult } from '../src/import/types.js';
import { IMPORT_UNSUPPORTED_TARGET } from '../src/messages.js';
import { parseScript } from '../src/steps/parse.js';
import type { Step } from '../src/types.js';
import { ERP_CHECK, SAP_VARS, SECRETS } from './helpers.js';
import { bound } from './timing.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/import/${name}`, import.meta.url));
const CODE = fixture('playwright-sap-export.ts.txt');
const CHROME = fixture('chrome-sap-export.json');
const TOTP_CODE = '482913';
const OPTS: ImportOptions = {
  name: 'sap-export', hasSiteLogin: true, secrets: SECRETS, vars: SAP_VARS, download: { mime: ['text/csv'], check: ERP_CHECK },
};
const PLAIN: ImportOptions = { name: 'plain', hasSiteLogin: false };

const newReport = (): ImportReport => ({ source: 'playwright', steps: 0, items: [] });
const verbOf = (s: Step) => Object.keys(s).find((k) => !['intent', 'expect', 'optional', 'when', 'checkpoint', 'timeoutMs'].includes(k));
const stepsOf = (r: ImportResult): Step[] => {
  expect(r.report.items.filter((i) => i.kind === 'error')).toEqual([]);
  expect(r.drafts).toHaveLength(1);
  return r.drafts[0].script.steps;
};
/** Events and every report item (pushed to the report or carried by a report event). */
const parse = (code: string) => {
  const report = newReport();
  const events = playwrightEvents(code, report);
  const items: ImportItem[] = [...report.items, ...events.flatMap((e) => (e.kind === 'report' ? [e.item] : []))];
  return { events: events.filter((e) => e.kind !== 'report'), items, report };
};
const test = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('t', async ({ page }) => {\n${body}\n});\n`;
/** A step without its intent and with each locator replaced by a marker: what the chrome and codegen drafts must share. */
const shape = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v !== 'object' || v === null) return v;
  if (['role', 'label', 'text', 'testId', 'css'].some((k) => k in v)) return 'LOCATOR';
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'intent').map(([k, x]) => [k, shape(x)]));
};

describe('Playwright code', () => {
  it('the codegen SAP export imports like the Chrome recording', () => {
    const r = importSource('playwright', CODE, OPTS);
    const steps = stepsOf(r);
    const chrome = stepsOf(importSource('chrome', CHROME, OPTS));
    // The expect(...).toBeVisible() line is the one extra step: a waitFor after Execute.
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'goto', 'click', 'select', 'fill', 'fill', 'click', 'waitFor', 'download']);
    expect(steps[8]).toEqual({ intent: 'Wait for the element', waitFor: { target: { role: 'grid' } } });
    const withoutWait = steps.filter((s) => !('waitFor' in s));
    expect(withoutWait.map(shape)).toEqual(chrome.map(shape));
    expect(withoutWait.map(verbOf)).toEqual(chrome.map(verbOf));
    // What codegen itself writes has no toHaveURL line: the only difference is the goto's missing URL check.
    const faithful = CODE.toString('utf8').split('\n').filter((l) => !l.includes('toHaveURL')).join('\n');
    expect(faithful).not.toBe(CODE.toString('utf8'));
    const plainSteps = stepsOf(importSource('playwright', faithful, OPTS));
    expect(plainSteps[2]).toEqual({ intent: 'Open localhost:8080/sap/bc/gui/sap/its/webgui', goto: 'http://localhost:8080/sap/bc/gui/sap/its/webgui' });
    expect(plainSteps.filter((_, i) => i !== 2)).toEqual(steps.filter((_, i) => i !== 2));
    expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);
    expect(r.drafts[0].script).toMatchObject({ name: 'sap-export', version: 1 });

    expect(steps.map((s) => s.intent)).toEqual([
      'Open localhost:8080/acme/login',
      'Sign in with an authentication code',
      'Open localhost:8080/sap/bc/gui/sap/its/webgui',
      'Click Line Item Report',
      'Choose {{var.company}} in Company Code',
      'Type into From',
      'Type into To',
      'Click Execute',
      'Wait for the element',
      'Download with Export',
    ]);
    expect((steps[1] as S<'signIn'>).signIn).toEqual({
      username: { label: 'Dealer user ID' },
      password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Authentication code' }, submit: { role: 'button', name: 'Verify' } },
    });
    expect((steps[1] as S<'signIn'>).signIn).toEqual(expect.objectContaining({ totp: expect.anything() }));
    expect(steps[2]).toEqual({ intent: 'Open localhost:8080/sap/bc/gui/sap/its/webgui', goto: 'http://localhost:8080/sap/bc/gui/sap/its/webgui', expect: { url: '/bc/gui/sap/its/webgui' } });
    expect((steps[4] as S<'select'>).select).toEqual({ field: { label: 'Company Code' }, value: '{{var.company}}' });
    expect((steps[6] as S<'fill'>).fill).toEqual({ field: { label: 'To', exact: true }, value: '{{var.to}}' });
    const download = (steps[9] as S<'download'>).download;
    expect(download).toEqual({ trigger: { role: 'button', name: 'Export', exact: true }, mime: ['text/csv'], check: ERP_CHECK });
    expect(download.check).toEqual((chrome[8] as S<'download'>).download.check);

    const items = r.report.items;
    expect(items).toContainEqual({ at: 'line 21', kind: 'untranslated', what: 'Click #x', reason: expect.stringContaining('.nth()') });
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 23', kind: 'converted', what: 'Click Export' }));
    expect(items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Clicks into a field before typing (3)' }));
    expect(items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Dealer user ID', 'Password', 'Authentication code']);
    expect(r.report.source).toBe('playwright');
    expect(r.report.steps).toBe(10);
  });

  it('typed sign-in values never appear in the draft or report, whatever field they went into', () => {
    const typed = [SECRETS.username, SECRETS.password, TOTP_CODE];
    for (const opts of [OPTS, { ...OPTS, hasSiteLogin: false, secrets: undefined }, { name: 'x', hasSiteLogin: true, secrets: SECRETS }]) {
      const r = importSource('playwright', CODE, opts);
      const all = JSON.stringify(r);
      for (const v of typed) expect(all).not.toContain(v);
      expect(r.report.items.length).toBeGreaterThan(0);
    }
    // The parser hands values to fill and select events only, never to a report item, also for statements it cannot translate.
    const odd = test([
      "  await page.goto('https://portal.example.com/');",
      "  await page.getByLabel('Key').fill('demo-password');",
      "  await page.locator('#pw').first().fill('demo-password');",
      "  await page.getByLabel('Notes').pressSequentially('summit-ops');",
      "  await page.fill('input[type=\"password\"]', 'oops-pass-1');",
      "  await page.getByLabel('Pin').fill(`demo-password`);",
      "  await page.getByLabel('Pin').fill(`demo-${'password'}`);",
      "  await page.getByLabel('Search').press('demo-password');",
      "  await page.getByRole('button', { name: 'Save' }).click();",
    ].join('\n'));
    const { events, report, items } = parse(odd);
    for (const v of [...typed, 'oops-pass-1']) expect(JSON.stringify(report) + JSON.stringify(items)).not.toContain(v);
    for (const e of events) if (e.kind !== 'fill' && e.kind !== 'select') expect(JSON.stringify(e)).not.toContain('demo-password');
    const r = importSource('playwright', odd, OPTS);
    for (const v of [...typed, 'oops-pass-1']) expect(JSON.stringify(r)).not.toContain(v);
  });

  it('exact options carry over', () => {
    const { events } = parse(test([
      "  await page.goto('https://portal.example.com/');",
      "  await page.getByRole('link', { name: 'Orders', exact: true }).click();",
      "  await page.getByRole('link', { name: 'Orders' }).click();",
      "  await page.getByRole('link', { exact: false, name: 'Open orders' }).click();",
      "  await page.getByLabel('Plant', { exact: true }).fill('B');",
      "  await page.getByText('Reports', { exact: true }).click();",
      "  await page.getByText('All reports').click();",
      "  await page.getByRole('navigation').click();",
    ].join('\n')));
    expect(events.map((e) => ('target' in e ? e.target : undefined))).toEqual([
      undefined,
      [{ role: 'link', name: 'Orders', exact: true }],
      [{ role: 'link', name: 'Orders' }],
      [{ role: 'link', name: 'Open orders' }],
      [{ label: 'Plant', exact: true }],
      [{ text: 'Reports', exact: true }],
      [{ text: 'All reports' }],
      [{ role: 'navigation' }],
    ]);
    expect(events.map((e) => ('label' in e ? e.label : undefined))).toEqual([undefined, 'Orders', 'Orders', 'Open orders', 'Plant', 'Reports', 'All reports', '']);
  });

  it('the download promise idiom becomes a download step', () => {
    const code = test([
      "  await page.goto('https://portal.example.com/reports');",
      "  await page.getByRole('button', { name: 'Run' }).click();",
      '  const downloadPromise = page.waitForEvent(\'download\');',
      "  await page.getByRole('link', { name: 'Get the file' }).click();",
      '  const download = await downloadPromise;',
      "  await download.saveAs('/tmp/out.csv');",
    ].join('\n'));
    const { events, items } = parse(code);
    expect(events.filter((e) => e.kind === 'click')).toEqual([
      { at: 'line 5', kind: 'click', target: [{ role: 'button', name: 'Run' }], label: 'Run' },
      { at: 'line 7', kind: 'click', target: [{ role: 'link', name: 'Get the file' }], label: 'Get the file', download: true },
    ]);
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 9', kind: 'dropped' }));
    // The explicit click wins over the last export-like name.
    const steps = stepsOf(importSource('playwright', code, { name: 'r', hasSiteLogin: false, download: { check: ERP_CHECK } }));
    expect(steps.map(verbOf)).toEqual(['goto', 'click', 'download']);
    expect((steps[2] as S<'download'>).download.trigger).toEqual({ role: 'link', name: 'Get the file' });
    // Without an Expected File it stays a click, and the report says so.
    const plain = importSource('playwright', code, PLAIN);
    expect(stepsOf(plain).map(verbOf)).toEqual(['goto', 'click', 'click']);
    expect(plain.report.items).toContainEqual(expect.objectContaining({ at: 'line 7', kind: 'untranslated', reason: expect.stringContaining('Expected File') }));

    // Older codegen: Promise.all with the event and the click.
    const old = parse(test([
      "  await page.goto('https://portal.example.com/reports');",
      '  const [download] = await Promise.all([',
      "    page.waitForEvent('download'),",
      "    page.getByText('Export').click()",
      '  ]);',
    ].join('\n')));
    expect(old.events[1]).toEqual({ at: 'line 7', kind: 'click', target: [{ text: 'Export' }], label: 'Export', download: true });
    // An event awaited with no click in between is reported.
    const lonely = parse(test("  const p = page.waitForEvent('download');\n  const d = await p;"));
    expect(lonely.items).toContainEqual(expect.objectContaining({ at: 'line 5', kind: 'untranslated', reason: expect.stringContaining('no click') }));
  });

  it('the popup idiom becomes popup and later statements follow the new page', () => {
    const code = test([
      "  await page.goto('https://portal.example.com/');",
      "  const page1Promise = page.waitForEvent('popup');",
      "  await page.getByRole('link', { name: 'Open reports' }).click();",
      '  const page1 = await page1Promise;',
      "  await page1.getByRole('button', { name: 'Export CSV' }).click();",
      "  await page.getByRole('button', { name: 'Home' }).click();",
      '  await page1.close();',
    ].join('\n'));
    const { events, items } = parse(code);
    expect(events).toEqual([
      { at: 'line 4', kind: 'goto', url: 'https://portal.example.com/' },
      { at: 'line 6', kind: 'click', target: [{ role: 'link', name: 'Open reports' }], label: 'Open reports', popup: true },
      { at: 'line 8', kind: 'click', target: [{ role: 'button', name: 'Export CSV' }], label: 'Export CSV' },
    ]);
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 7', kind: 'converted', reason: expect.stringContaining('new tab') }));
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 9', kind: 'untranslated', what: 'Click Home', reason: expect.stringContaining('first tab') }));
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 10', kind: 'untranslated' }));
    const steps = stepsOf(importSource('playwright', code, PLAIN));
    expect(steps.map(verbOf)).toEqual(['goto', 'popup', 'click']);
    expect((steps[1] as S<'popup'>).popup).toEqual({ trigger: { role: 'link', name: 'Open reports' } });

    // Older codegen: Promise.all binds the new page.
    const old = parse(test([
      '  const [page2] = await Promise.all([',
      "    page.waitForEvent('popup'),",
      "    page.getByText('Help').click(),",
      '  ]);',
      "  await page2.getByLabel('Search').fill('x');",
    ].join('\n')));
    expect(old.events.map((e) => [e.kind, 'popup' in e ? e.popup : undefined])).toEqual([['click', true], ['fill', undefined]]);
  });

  it('the javascript target, chains, frames and the other locators', () => {
    const code = [
      "const { chromium } = require('playwright');",
      '',
      '(async () => {',
      '  const browser = await chromium.launch({',
      '    headless: false',
      '  });',
      '  const context = await browser.newContext();',
      '  const page = await context.newPage();',
      "  await page.goto(`https://portal.example.com/`); // a template without ${} is text",
      '  /* a block',
      '     comment */',
      "  await page.getByRole('navigation').getByRole('link', { name: 'Orders' }).click();",
      "  await page.locator('#main').getByText('Open').locator('button.go').click();",
      "  await page.frameLocator('iframe[name=\"app\"]').getByRole('button', { name: 'Go' }).click();",
      "  await page.locator('#app-frame').contentFrame().getByLabel('Plant').fill('B');",
      "  await page.getByPlaceholder('Search \"orders\"').fill('acme');",
      "  await page.getByTestId('submit').click();",
      "  await page.locator('text=Next').click();",
      '  await page.locator(\'text="Done"\').click();',
      "  await page.getByLabel('Remember me').check();",
      "  await page.getByLabel('Newsletter').uncheck();",
      "  await page.getByLabel('Region').selectOption({ label: 'North' });",
      "  await page.getByLabel('Search').press('Enter');",
      '  await page',
      "    .getByRole('button', { name: 'Apply' })",
      '    .click();',
      "  const save = page.getByRole('button', { name: 'Save' });",
      '  await save.click();',
      "  await page.click('#legacy');",
      "  await page.fill('[name=\"q\"]', 'v');",
      "  await page.getByRole('button', { name: 'Twice' }).dblclick();",
      "  await page.waitForURL('https://portal.example.com/done?x=1');",
      '',
      '  // ---------------------',
      '  await context.close();',
      '  await browser.close();',
      '})();',
    ].join('\n');
    const { events, items } = parse(code);
    const targets = events.map((e) => ('target' in e ? e.target[0] : e.kind === 'goto' ? e.url : e.kind === 'expectUrl' ? e.path : e.kind));
    expect(targets).toEqual([
      'https://portal.example.com/',
      { role: 'link', name: 'Orders', within: { role: 'navigation' } },
      { css: 'button.go', within: { text: 'Open', within: { css: '#main' } } },
      { role: 'button', name: 'Go', frame: 'iframe[name="app"]' },
      { label: 'Plant', frame: '#app-frame' },
      { css: '[placeholder="Search \\"orders\\""]' },
      { testId: 'submit' },
      { text: 'Next' },
      { text: 'Done', exact: true },
      { label: 'Remember me' },
      { label: 'Newsletter' },
      { label: 'Region' },
      'enter',
      { role: 'button', name: 'Apply' },
      { role: 'button', name: 'Save' },
      { css: '#legacy' },
      { css: '[name="q"]' },
      { role: 'button', name: 'Twice' },
      '/done',
    ]);
    expect(events[5]).toMatchObject({ kind: 'fill', label: 'Search "orders"', value: 'acme' });
    expect(events[9]).toMatchObject({ kind: 'check', checked: true });
    expect(events[10]).toMatchObject({ kind: 'check', checked: false });
    expect(events[11]).toMatchObject({ kind: 'select', value: 'North' });
    expect(events[12]).toEqual({ at: 'line 23', kind: 'enter', label: 'Search' });
    expect(events[13]).toMatchObject({ at: 'line 24' });
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 31', kind: 'converted', what: 'Click Twice' }));
    // The scaffolding is ignored, not reported.
    expect(items.filter((i) => i.kind !== 'converted')).toEqual([]);

    // The older page-level actions take a selector first.
    const legacy = parse([
      "await page.goto('https://a.example/');",
      "await page.press('#q', 'Enter');",
      "await page.waitForSelector('#grid');",
      "await page.check('text=Remember me');",
      "await page.selectOption('#co', '1000');",
      "await page.click('xpath=//button');",
    ].join('\n'));
    expect(legacy.events.slice(1)).toEqual([
      { at: 'line 2', kind: 'enter', label: '' },
      { at: 'line 3', kind: 'waitFor', target: [{ css: '#grid' }], label: '' },
      { at: 'line 4', kind: 'check', target: [{ text: 'Remember me' }], label: 'Remember me', checked: true },
      { at: 'line 5', kind: 'select', target: [{ css: '#co' }], label: '', value: '1000', hints: ['#co'] },
    ]);
    expect(legacy.items).toEqual([expect.objectContaining({ at: 'line 6', kind: 'untranslated', what: 'Click xpath=//button', reason: expect.stringContaining('XPath') })]);
  });

  it('unsupported statements are reported with their line', () => {
    const { events, items } = parse(test([
      "  await page.goto('https://portal.example.com/');", // 4
      "  await page.getByRole('row').first().click();", // 5
      "  await page.getByRole('row').filter({ hasText: 'Acme' }).click();", // 6
      "  await page.getByRole('menu').hover();", // 7
      "  await page.evaluate(() => window.scrollTo(0, 0));", // 8
      "  await page.getByLabel('File').setInputFiles('a.pdf');", // 9
      '  for (const n of [1, 2]) {', // 10
      "    await page.getByText('Next').click();",
      '  }',
      "  await page.getByText(`Row ${n}`).click();", // 13
      '  await expect(page).toHaveURL(/orders/);', // 14
      "  await page.getByLabel('Name').press('Tab');", // 15
      "  await expect(page.getByText('Saved')).toHaveText('Saved');", // 16
      "  await page.getByRole('button', { name: /save/i }).click();", // 17
      "  await page.getByRole('button', { name: 'Go' }).click({ button: 'right' });", // 18
      '  await page.waitForTimeout(500);', // 19
      "  test.use({ storageState: 'auth.json' });", // 20
      "  page.once('dialog', dialog => {", // 21
      '    dialog.dismiss().catch(() => {});',
      '  });',
      "  await page.getByText('Done').click();", // 24
    ].join('\n')));
    expect(events.map((e) => e.at)).toEqual(['line 4', 'line 24']);
    const at = (line: number) => items.find((i) => i.at === `line ${line}`);
    expect(at(5)).toMatchObject({ kind: 'untranslated', what: 'Click the element', reason: expect.stringContaining('.first()') });
    expect(at(6)).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('.filter()') });
    expect(at(7)).toMatchObject({ kind: 'untranslated', what: 'Hover the element', reason: expect.stringContaining('hover') });
    expect(at(8)).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('JavaScript') });
    expect(at(9)).toMatchObject({ kind: 'untranslated' });
    expect(at(10)).toMatchObject({ kind: 'untranslated' });
    expect(at(13)).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('${') });
    expect(at(14)).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('pattern') });
    expect(at(15)).toMatchObject({ kind: 'untranslated', what: 'Press Tab' });
    expect(at(16)).toMatchObject({ kind: 'untranslated' });
    expect(at(17)).toMatchObject({ kind: 'untranslated', reason: expect.stringContaining('pattern') });
    expect(at(18)).toMatchObject({ kind: 'untranslated' });
    expect(at(19)).toMatchObject({ kind: 'dropped' });
    expect(at(20)).toMatchObject({ kind: 'untranslated' });
    expect(at(21)).toMatchObject({ kind: 'untranslated' });
    // A report item never quotes the statement's strings.
    expect(JSON.stringify(items)).not.toContain('a.pdf');
    expect(JSON.stringify(items)).not.toContain('auth.json');
    // Past 200 items, the rest are counted in one.
    const many = parse(`await page.goto('https://a.example/');\n${"await page.getByRole('row').first().click();\n".repeat(300)}`);
    expect(many.items).toHaveLength(201);
    expect(many.items[200]).toMatchObject({ at: 'line 202', what: '100 more statements' });
    // Whatever is not a statement of the grammar is reported, never thrown.
    for (const junk of ['}}}', ')))(((', 'await', 'const', 'const x =', '{ a: [1, 2', '=> => =>', 'page.', 'page..click()', '#!', '@@@', '\\u0041']) {
      let r: ImportResult | undefined;
      expect(() => { r = importSource('playwright', junk, PLAIN); }).not.toThrow();
      expect(r?.drafts).toEqual([]);
    }
  });

  it('unterminated literals end the parse with a report item', () => {
    const cases = [
      `await page.goto('https://a.example/');\nawait page.getByLabel('Password').fill('${SECRETS.password}`,
      "await page.goto('https://a.example/);\nawait page.click('#b');",
      'await page.goto(`https://a.example/',
      'await page.goto(`https://a.example/${x',
      "await page.goto('https://a.example/'); /* never closed",
      'await expect(page).toHaveURL(/abc',
    ];
    for (const code of cases) {
      let r: ImportResult | undefined;
      expect(() => { r = importSource('playwright', code, OPTS); }).not.toThrow();
      expect(r?.drafts).toEqual([]);
      expect(r?.report.items).toContainEqual(expect.objectContaining({ kind: 'error', what: 'Playwright code', at: expect.stringMatching(/^line \d+$/) }));
      expect(JSON.stringify(r)).not.toContain(SECRETS.password);
    }
    // 2 MiB inputs finish quickly: an unclosed string, template or comment after a long prefix, and other hostile shapes.
    const near = MAX_PLAYWRIGHT_BYTES - 64;
    const hostile = [
      `await page.goto('${'a'.repeat(near)}`,
      `await page.goto(\`${'${'.repeat(near / 2)}`,
      `/*${'*'.repeat(near)}`,
      `${"await page.getByText('x').click();\n".repeat(Math.floor(near / 36))}'`,
      '('.repeat(near),
      '{'.repeat(near),
      '['.repeat(near),
      '`${`${`${'.repeat(Math.floor(near / 9)),
      '\n'.repeat(near),
      'x;'.repeat(near / 2),
      `await page.getByText(${"'a'+".repeat(Math.floor(near / 4))}'a').click();`,
      `const a = ${'/'.repeat(near)}`,
    ];
    hostile.forEach((code, i) => {
      expect(code.length).toBeLessThanOrEqual(MAX_PLAYWRIGHT_BYTES);
      const t0 = performance.now();
      let r: ImportResult | undefined;
      expect(() => { r = importSource('playwright', code, OPTS); }).not.toThrow();
      // The target bound for the unclosed string, template and comment; a looser one for the other shapes.
      expect(performance.now() - t0).toBeLessThan(bound(i < 3 ? 200 : 1000));
      expect(r?.drafts).toEqual([]);
      expect(r?.report.items.length).toBeGreaterThan(0);
      expect(r?.report.items.length).toBeLessThan(300);
    });
    // Over the size cap: refused before it is read.
    for (const data of ['a'.repeat(MAX_PLAYWRIGHT_BYTES + 1), Buffer.alloc(MAX_PLAYWRIGHT_BYTES + 1, 0x61), 'é'.repeat(MAX_PLAYWRIGHT_BYTES / 2 + 1)]) {
      const r = importSource('playwright', data, OPTS);
      expect(r.report.items).toEqual([expect.objectContaining({ kind: 'error', reason: expect.stringContaining('2 MiB') })]);
    }
  });

  it('a reassigned locator variable is reported, never resolved to its first target', () => {
    const { events, items } = parse(test([
      "  await page.goto('https://a.example/');", // 4
      "  let btn = page.getByRole('button', { name: 'Save' });", // 5
      "  btn = page.getByRole('button', { name: 'Delete' });", // 6
      '  await btn.click();', // 7
      "  await expect(btn).toBeVisible();", // 8
      "  let field = page.getByLabel('Name');", // 9
      "  await field.fill('x');", // 10
    ].join('\n')));
    expect(events.map((e) => e.at)).toEqual(['line 4', 'line 10']);
    expect(JSON.stringify(events)).not.toContain('Save');
    for (const line of [6, 7, 8]) {
      expect(items).toContainEqual(expect.objectContaining({ at: `line ${line}`, kind: 'untranslated', reason: expect.stringContaining('assigned again') }));
    }
  });

  it('Promise.all with more than one event marks no click', () => {
    const { events, items } = parse(test([
      "  await page.goto('https://a.example/');", // 4
      '  const [a, b] = await Promise.all([', // 5
      "    page.waitForEvent('popup'),",
      "    page.waitForEvent('download'),",
      "    page.getByText('Both').click(),",
      '  ]);',
      "  await page.getByText('Later').click();", // 10
    ].join('\n')));
    expect(events).toEqual([
      { at: 'line 4', kind: 'goto', url: 'https://a.example/' },
      { at: 'line 10', kind: 'click', target: [{ text: 'Later' }], label: 'Later' },
    ]);
    expect(items).toContainEqual(expect.objectContaining({ at: 'line 5', kind: 'untranslated' }));
  });

  it('a locator scoped too deeply is reported, not imported', () => {
    const deep = `await page.goto('https://a.example/');\nawait page${".locator('div')".repeat(3000)}.click();`;
    let r: ImportResult | undefined;
    expect(() => { r = importSource('playwright', deep, PLAIN); }).not.toThrow();
    expect(r?.report.items).toContainEqual(expect.objectContaining({ at: 'line 2', kind: 'untranslated', reason: expect.stringContaining('scoped more than 8 times') }));
    expect(r?.report.items.filter((i) => i.kind === 'error')).toEqual([]);
    expect(r?.drafts).toHaveLength(1);
    // Eight scopes are fine; a variable counts the scopes it already has.
    const eight = parse(`await page${".locator('div')".repeat(9)}.click();`);
    expect(eight.events).toHaveLength(1);
    const viaVar = parse(`const v = page${".locator('div')".repeat(8)};\nawait v.locator('span').locator('b').click();`);
    expect(viaVar.events).toEqual([]);
    expect(viaVar.items).toContainEqual(expect.objectContaining({ at: 'line 2', reason: expect.stringContaining('scoped more than 8 times') }));
  });

  it('hooks, line counts, regexes after interpolation, control characters, line-start division, reasons', () => {
    // Test hooks are reported, not imported as steps.
    const hooks = parse([
      "import { test } from '@playwright/test';",
      "test.beforeEach(async ({ page }) => {",
      "  await page.goto('https://a.example/login');",
      '});',
      "test('t', async ({ page }) => {",
      "  await page.goto('https://a.example/');",
      '});',
    ].join('\n'));
    expect(hooks.events).toEqual([{ at: 'line 6', kind: 'goto', url: 'https://a.example/' }]);
    expect(hooks.items).toContainEqual(expect.objectContaining({ at: 'line 2', kind: 'untranslated', reason: expect.stringContaining('hooks') }));
    // A CRLF line continuation inside a string counts its line.
    const crlf = parse("await page.goto('https://a.example/');\r\nawait page.getByText('a\\\r\nb').click();\r\nawait page.getByText('c').click();");
    expect(crlf.events.map((e) => e.at)).toEqual(['line 1', 'line 2', 'line 4']);
    // A regex right after a template's ${ is a regex, not a division.
    const tmpl = parse("await page.goto(`${/'/.test(a)}`);\nawait page.getByText('ok').click();");
    expect(tmpl.items).toContainEqual(expect.objectContaining({ at: 'line 1', reason: expect.stringContaining('${') }));
    expect(tmpl.events).toHaveLength(1);
    // Control characters in an attribute value are CSS-escaped.
    const ctl = parse("await page.getByPlaceholder('a\\fb\\u0001c\\nd').fill('v');");
    expect(ctl.events[0]).toMatchObject({ target: [{ css: '[placeholder="a\\c b\\1 c\\a d"]' }] });
    // A division at the start of a line reports the statement and goes on.
    const div = parse("const x = 4\n  / 2;\nawait page.goto('https://a.example/');");
    expect(div.report.items.filter((i) => i.kind === 'error')).toEqual([]);
    expect(div.events).toEqual([{ at: 'line 3', kind: 'goto', url: 'https://a.example/' }]);
    // Reasons: a bare waitForEvent, and a check on the first tab after a popup.
    const reasons = parse(test([
      "  await page.waitForEvent('download');", // 4
      "  const p1 = page.waitForEvent('popup');", // 5
      "  await page.getByText('Open').click();", // 6
      '  const tab = await p1;', // 7
      "  await expect(page.getByText('Home')).toBeVisible();", // 8
      "  await expect(page).toHaveURL('https://a.example/');", // 9
    ].join('\n')));
    expect(reasons.items).toContainEqual(expect.objectContaining({ at: 'line 4', reason: expect.stringContaining('const') }));
    for (const line of [8, 9]) expect(reasons.items).toContainEqual(expect.objectContaining({ at: `line ${line}`, reason: expect.stringContaining('first tab') }));
  });

  it('the codegen identity-first sign-in imports like the Chrome recording: signIn with next', () => {
    const SSO2 = { username: 'rpa-bot@rpa.example', password: 'idp-demo-password', totpSecret: 'JBSWY3DPEHPK3PXP' };
    const opts: ImportOptions = { name: 'sap-sso2-export', hasSiteLogin: true, secrets: SSO2, download: { check: { name: '\\.XLSX$' } } };
    const code = fixture('playwright-idp-two-step.ts.txt');
    const r = importSource('playwright', code, opts);
    const steps = stepsOf(r);
    const chrome = stepsOf(importSource('chrome', fixture('chrome-idp-two-step.json'), opts));
    expect(steps.map(verbOf)).toEqual(['goto', 'signIn', 'click', 'click', 'fill', 'fill', 'fill', 'click', 'click', 'download']);
    // The same shape as the Chrome recording, apart from the URL checks codegen does not write.
    const noUrl = (s: Step) => { const { expect: _e, ...rest } = s as Step & { expect?: unknown }; return rest; };
    expect(steps.map(shape)).toEqual(chrome.map(noUrl).map(shape));
    expect((steps[1] as S<'signIn'>).signIn).toEqual({
      username: { label: 'Email' },
      next: { role: 'button', name: 'Next' },
      password: { label: 'Password' },
      submit: { role: 'button', name: 'Sign in' },
      totp: { field: { label: 'Code' }, submit: { role: 'button', name: 'Verify' } },
    });
    expect(steps[2]).toEqual({ intent: 'Click No', when: { visible: { role: 'button', name: 'No', exact: true } }, click: { role: 'button', name: 'No', exact: true } });
    expect((steps[9] as S<'download'>).download.trigger).toEqual({ role: 'button', name: 'Continue (Enter)' });
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(r.report.items.filter((i) => i.kind === 'untranslated' || i.kind === 'error')).toEqual([]);
    for (const v of [SSO2.username, SSO2.password, TOTP_CODE]) expect(JSON.stringify(r)).not.toContain(v);

    // press('Enter') in the email field instead of the Next click: converted and reported.
    const entered = importSource('playwright', code.toString('utf8').replace(
      "await page.getByRole('button', { name: 'Next' }).click();", "await page.getByLabel('Email').press('Enter');"), opts);
    expect((stepsOf(entered)[1] as S<'signIn'>).signIn.next).toEqual({ css: 'form [type="submit"]', fallbacks: [{ css: 'form button:not([type])' }] });
    expect(entered.report.items).toContainEqual(expect.objectContaining({ at: 'line 7', kind: 'converted', what: 'Press Enter in Email' }));
    // With a click on another page between, it is reported as before.
    const detour = importSource('playwright', code.toString('utf8').replace(
      "await page.getByLabel('Password').click();", "await page.getByRole('link', { name: 'Use your password' }).click();"), opts);
    expect(stepsOf(detour).some((s) => 'signIn' in s)).toBe(false);
    expect(detour.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in', reason: expect.stringContaining('different pages') }));
    for (const v of [SSO2.username, SSO2.password, TOTP_CODE]) expect(JSON.stringify([entered, detour])).not.toContain(v);

    // A Next that opens the password page in a popup (waitForEvent('popup')) is never `next`: reported as before.
    const [head, tail] = code.toString('utf8').split("  await page.getByRole('button', { name: 'Next' }).click();\n");
    const popup = importSource('playwright', [
      head,
      "  const page1Promise = page.waitForEvent('popup');\n",
      "  await page.getByRole('button', { name: 'Next' }).click();\n",
      '  const page1 = await page1Promise;\n',
      tail.replaceAll('page.getBy', 'page1.getBy').replace("page.waitForEvent('download')", "page1.waitForEvent('download')"),
    ].join(''), opts);
    const popupSteps = stepsOf(popup);
    expect(popupSteps.some((s) => 'signIn' in s)).toBe(false);
    expect(popupSteps.find((s) => 'popup' in s)).toEqual({ intent: 'Open Next in a new tab', popup: { trigger: { role: 'button', name: 'Next' } } });
    expect(popup.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in', reason: expect.stringContaining('different pages') }));
    for (const v of [SSO2.username, SSO2.password, TOTP_CODE]) expect(JSON.stringify(popup)).not.toContain(v);
  });

  it('Python code is refused with IMPORT_UNSUPPORTED_TARGET', () => {
    const others = [
      fixture('playwright-python.py.txt'),
      'import com.microsoft.playwright.*;\n\npublic class Example {}',
      'using Microsoft.Playwright;\nusing System.Threading.Tasks;',
      'import asyncio\n\nfrom playwright.async_api import async_playwright\n',
    ];
    for (const code of others) {
      const r = importSource('playwright', code, OPTS);
      expect(r.drafts).toEqual([]);
      expect(r.report.items).toEqual([expect.objectContaining({ kind: 'error', reason: IMPORT_UNSUPPORTED_TARGET })]);
    }
    // Python without its import line is still recognised by get_by_.
    const bare = importSource('playwright', 'page.goto("https://a.example/")\npage.get_by_role("button", name="Go").click()\n', OPTS);
    expect(bare.report.items).toEqual([expect.objectContaining({ kind: 'error', reason: IMPORT_UNSUPPORTED_TARGET })]);
    // A comment that mentions Python is still JavaScript, and so are markers inside comments, templates and a default import.
    for (const code of [
      `// ported from playwright python\nawait page.goto('https://a.example/');`,
      `import playwright from 'playwright';\nawait page.goto('https://a.example/');`,
      `/*\nfrom playwright.sync_api import Page\npage.get_by_role('x')\n*/\nawait page.goto('https://a.example/');`,
      `const doc = \`\nusing Microsoft.Playwright;\n\`;\nawait page.goto('https://a.example/');`,
      `// page.get_by_role("x")\nawait page.goto('https://a.example/');`,
    ]) {
      const js = parse(code);
      expect(js.report.items.filter((i) => i.kind === 'error')).toEqual([]);
      expect(js.events.map((e: ImportEvent) => e.kind)).toEqual(['goto']);
    }
  });
});
