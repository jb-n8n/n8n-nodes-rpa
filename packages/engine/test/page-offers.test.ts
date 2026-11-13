// What the page shows at a control that is not there (steps/page-offers.ts): one look after the step's own wait, names as
// text, never a value, never on a site the policy does not allow; with `every` (the import's replay), the later steps
// on the same page checked without acting. Fake pages are served by a route on a made-up host, so nothing leaves the test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createMasker } from '../src/secrets/mask.js';
import { controlKind, editDistance, lookAtPage, nearestFirst, pageAllowed, shownName, withPageLook } from '../src/steps/page-offers.js';
import type { Locator, Step } from '../src/types.js';

const HOST = 'offers.test';
const POLICY = { navHosts: [HOST] };
let browser: Browser;
let page: Page;
let html = '';
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.route(`http://${HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
});
afterAll(async () => { await browser.close(); });

async function show(body: string): Promise<void> {
  html = `<!doctype html><html><body>${body}</body></html>`;
  await page.goto(`http://${HOST}/report`);
}

const masker = createMasker(['s3cret-pw']);
const look = (steps: Step[], failed: number, missing: Locator, every = false, p: Page = page) =>
  lookAtPage({ page: p, policy: POLICY, masker, vars: {}, steps, failed, missing, every });

const REPORT_SCREEN = `
  <form>
    <label for="cc">Company Code</label><select id="cc"><option>1000</option><option>2000</option></select>
    <label for="f">Date from</label><input id="f" value="2026-09-01">
    <label for="t">Date to</label><input id="t" value="TYPED-VALUE-77">
    <label>Note <input id="n" value="NOTE-VALUE-88"></label>
    <label for="pw">Password</label><input id="pw" type="password" value="s3cret-pw">
    <textarea aria-label="Comment">TEXTAREA-VALUE-99</textarea>
    <input type="checkbox" id="x"><label for="x">Only open items</label>
    <input type="hidden" name="h" value="HIDDEN-1">
    <button type="button" id="run" onclick="window.clicks = (window.clicks || 0) + 1">Run</button>
    <button type="button">Back</button>
    <a href="/line-items">G/L Line Items</a>
    <button type="button" style="display:none">Hidden button</button>
    <input type="submit" value="Download spreadsheet">
  </form>`;

describe('the names a page shows', () => {
  it('are one line, without control characters, quotes or angle brackets, masked, and cut to 60 characters', () => {
    expect(shownName('Line\nItem\t Report', masker)).toBe('Line Item Report');
    expect(shownName(`A${String.fromCodePoint(0x202e)}B${String.fromCodePoint(0x200b)}C${String.fromCodePoint(0x7)}`, masker)).toBe('A B C');
    expect(shownName('Say "hi" <b>now</b>', masker)).toBe("Say 'hi' ‹b›now‹/b›");
    expect(shownName('Signed in with s3cret-pw', masker)).toBe('Signed in with [secret]');
    expect(shownName('Open https://site.test/a?token=abc', masker)).toBe('Open https://site.test/a');
    const long = shownName('x'.repeat(100), masker);
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
  it('come nearest in name first: shared words, then edit distance, then the page order', () => {
    expect(nearestFirst('Line Item Report', ['Enter', 'Back', 'G/L Line Items', 'Reports'])).toEqual(['G/L Line Items', 'Reports', 'Enter', 'Back']);
    expect(nearestFirst('Execute', ['Back', 'Run', 'Export'])[0]).toBe('Export');
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
  it('a click gets links and buttons, a typed or chosen value fields and lists; a table or a wait gets none', () => {
    expect(controlKind({ intent: 'x', click: { text: 'Go' } }, { text: 'Go' })).toBe('buttons');
    expect(controlKind({ intent: 'x', fill: { field: { css: '#a' }, value: '1' } }, { css: '#a' })).toBe('fields');
    expect(controlKind({ intent: 'x', click: { role: 'checkbox', name: 'A' } }, { role: 'checkbox', name: 'A' })).toBe('fields');
    expect(controlKind({ intent: 'x', signIn: { username: { label: 'User' }, password: { label: 'Password' }, submit: { role: 'button', name: 'Go' } } }, { role: 'button', name: 'Go' })).toBe('buttons');
    expect(controlKind({ intent: 'x', extractTable: { table: { role: 'grid' } } }, { role: 'grid' })).toBeUndefined();
  });
  it('only a page on a site the policy allows is looked at', () => {
    expect(pageAllowed(`http://${HOST}/x`, POLICY)).toBe(true);
    expect(pageAllowed('http://other.test/x', POLICY)).toBe(false);
    expect(pageAllowed('about:blank', POLICY)).toBe(false);
  });
});

describe('one look at the page', () => {
  it('for a click: the visible links and buttons, nearest first, never a hidden one', async () => {
    await show(REPORT_SCREEN);
    const step: Step = { intent: 'Click Line Item Report', click: { role: 'button', name: 'Line Item Report' } };
    const r = await look([step], 0, step.click as Locator);
    expect(r?.first).toBe('The page shows these links and buttons: "G/L Line Items", "Run", "Back", "Download spreadsheet".');
    expect(r?.later).toBe('');
    expect(r?.controls).toEqual([{
      step: 1, intent: 'Click Line Item Report', lookedFor: 'Role and Name button "Line Item Report"', kind: 'buttons',
      offered: ['G/L Line Items', 'Run', 'Back', 'Download spreadsheet'], more: 0,
    }]);
  });
  it('for a typed value: the fields and lists by their labels, never a value', async () => {
    await show(REPORT_SCREEN);
    const step: Step = { intent: 'Type into To', fill: { field: { label: 'To', exact: true }, value: '2026-09-30' } };
    const r = await look([step], 0, step.fill.field);
    expect(r?.controls[0].offered).toEqual(['Date to', 'Note', 'Comment', 'Date from', 'Password', 'Company Code', 'Only open items']);
    const text = JSON.stringify(r);
    for (const value of ['TYPED-VALUE-77', 'NOTE-VALUE-88', 'TEXTAREA-VALUE-99', 's3cret-pw', 'HIDDEN-1', '2026-09-01', '1000', '2000']) expect(text).not.toContain(value);
  });
  it('a secret in a name is masked, markup is text, and more than 12 are counted', async () => {
    const many = Array.from({ length: 15 }, (_, i) => `<button>Option ${i + 1}</button>`).join('');
    await show(`<button>Hello s3cret-pw</button><a href="/x">Next <b>page</b> &gt;</a>${many}`);
    const step: Step = { intent: 'Click Hello next', click: { text: 'Hello next' } };
    const r = await look([step], 0, step.click as Locator);
    expect(r?.controls[0].offered).toHaveLength(12);
    expect(r?.controls[0].more).toBe(5);
    expect(r?.first).toContain('"Hello [secret]"');
    expect(r?.first).toContain('"Next page ›"');
    expect(r?.first).toMatch(/, and 5 more\.$/);
    expect(r?.first).not.toMatch(/[<>]|s3cret/);
  });
  it('an empty page says so', async () => {
    await show('<p>Nothing here</p>');
    const step: Step = { intent: 'Click Go', click: { text: 'Go' } };
    expect((await look([step], 0, step.click as Locator))?.first).toBe('The page shows no links or buttons.');
    const fill: Step = { intent: 'Type', fill: { field: { label: 'A' }, value: '1' } };
    expect((await look([fill], 0, fill.fill.field))?.first).toBe('The page shows no fields or lists.');
  });
  it('is not taken on a site the policy does not allow, for a control in a frame, or for a step that neither clicks nor types', async () => {
    await show(REPORT_SCREEN);
    const step: Step = { intent: 'Click Go', click: { text: 'Go' } };
    expect(await lookAtPage({ page, policy: { navHosts: ['elsewhere.test'] }, masker, vars: {}, steps: [step], failed: 0, missing: { text: 'Go' }, every: false })).toBeUndefined();
    expect(await look([step], 0, { text: 'Go', frame: 'iframe' })).toBeUndefined();
    const table: Step = { intent: 'Read', extractTable: { table: { role: 'grid' } } };
    expect(await look([table], 0, { role: 'grid' })).toBeUndefined();
  });
  it('the list goes right after "after N s." and before the advice', () => {
    const at = withPageLook('Click X: No element found for Visible Text "X" on http://a.test/ after 30 s. Check the spelling or try Find by: Role and Name.', { controls: [], first: 'The page shows these links and buttons: "Y".', later: '' });
    expect(at).toBe('Click X: No element found for Visible Text "X" on http://a.test/ after 30 s. The page shows these links and buttons: "Y". Check the spelling or try Find by: Role and Name.');
    expect(withPageLook('A: B', { controls: [], first: 'C.', later: 'D.' })).toBe('A: B C. D.');
  });
});

describe('every missing control on the same page (the import\'s replay)', () => {
  const steps: Step[] = [
    { intent: 'Choose 1000 in Company', select: { field: { label: 'Company', exact: true }, value: '1000' } },
    { intent: 'Type into From', fill: { field: { label: 'Date from', exact: true }, value: '2026-09-01' } },
    { intent: 'Read the title', read: { what: 'title' } },
    { intent: 'Type into To', fill: { field: { label: 'To', exact: true }, value: '2026-09-30' } },
    { intent: 'Click Execute', click: { role: 'button', name: 'Execute' } },
    { intent: 'Click Export', click: { role: 'button', name: 'Export' } },
    { intent: 'Read the rows', extractTable: { table: { role: 'grid' } } },
  ];
  it('checks the later steps up to the first that can change the page, names each missing one with its list, and acts on nothing', async () => {
    await show(REPORT_SCREEN);
    const r = await look(steps, 0, (steps[0] as Extract<Step, { select: unknown }>).select.field, true);
    expect(r?.first).toBe('The page shows these fields and lists: "Company Code", "Comment", "Note", "Date to", "Password", "Date from", "Only open items".');
    expect(r?.later).toBe(
      'Steps 2, 4 and 5 were checked on this page too, without acting. '
      + 'Step 4 (Type into To) cannot find Form Label "To" here either. '
      + 'The page shows these fields and lists: "Date to", "Note", "Comment", "Date from", "Password", "Company Code", "Only open items". '
      + 'Step 5 (Click Execute) cannot find Role and Name button "Execute" here either. '
      + 'The page shows these links and buttons: "Run", "Back", "G/L Line Items", "Download spreadsheet". '
      + 'Steps 6 and 7 were not checked: they come after a step that can change the page.',
    );
    expect(r?.controls.map((c) => [c.step, c.kind])).toEqual([[1, 'fields'], [4, 'fields'], [5, 'buttons']]);
    // Nothing was pressed or typed: the fields hold what the page gave them, and the Run button was never clicked.
    expect(await page.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)).toBe(0);
    expect(await page.inputValue('#t')).toBe('TYPED-VALUE-77');
    expect(page.url()).toBe(`http://${HOST}/report`);
  });
  it('says so when every later control is there', async () => {
    await show(REPORT_SCREEN);
    const ok: Step[] = [steps[0], { intent: 'Type into From', fill: { field: { label: 'Date from' }, value: '1' } }, { intent: 'Click Run', click: { role: 'button', name: 'Run' } }];
    const r = await look(ok, 0, { label: 'Company', exact: true }, true);
    expect(r?.later).toBe('Steps 2 and 3 were checked on this page too, without acting: their controls are there.');
  });
  it('after a missing click nothing later is checked: the click may have led to another page', async () => {
    await show(REPORT_SCREEN);
    const r = await look(steps, 4, { role: 'button', name: 'Execute' }, true);
    expect(r?.later).toBe('Steps 6 and 7 were not checked: they come after a step that can change the page.');
    expect(r?.controls).toHaveLength(1);
  });
  it('a later step with a condition, an optional one, or one that opens an address stops the check without looking', async () => {
    await show(REPORT_SCREEN);
    for (const stop of [
      { intent: 'Maybe', when: { visible: { css: '#x' } }, fill: { field: { label: 'Nope' }, value: '1' } },
      { intent: 'Optional', optional: true, fill: { field: { label: 'Nope' }, value: '1' } },
      { intent: 'Open', goto: 'http://offers.test/other' },
    ] as Step[]) {
      const r = await look([steps[0], stop, steps[4]], 0, { label: 'Company', exact: true }, true);
      expect(r?.later).toBe('Steps 2 and 3 were not checked: they come after a step that can change the page.');
    }
  });
  it('without `every`, only the failed step is looked at', async () => {
    await show(REPORT_SCREEN);
    const r = await look(steps, 0, { label: 'Company', exact: true });
    expect(r?.later).toBe('');
    expect(r?.controls).toHaveLength(1);
  });
});
