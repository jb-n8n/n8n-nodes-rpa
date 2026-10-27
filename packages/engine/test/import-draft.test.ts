import { describe, expect, it } from 'vitest';
import { buildDraft, pickLocator } from '../src/import/draft.js';
import { stripSecrets } from '../src/import/secrets.js';
import type { Candidate, ImportEvent, ImportOptions, ImportReport, ImportResult } from '../src/import/types.js';
import {
  IMPORT_EMPTY, IMPORT_NEEDS_SITE_LOGIN, IMPORT_NOT_ADOPTABLE, IMPORT_REFUSES_WRITES, IMPORT_UNSUPPORTED_TARGET,
} from '../src/messages.js';
import { loginBlockEnd } from '../src/policy/validate.js';
import { describeStep } from '../src/proposal/describe.js';
import { createMasker } from '../src/secrets/mask.js';
import { parseScript } from '../src/steps/parse.js';
import type { Step } from '../src/types.js';
import { bound } from './timing.js';

type S<K extends string> = Extract<Step, Record<K, unknown>>;

const SECRETS = { username: 'u-sec', password: 'p-sec' };
const OPTS: ImportOptions = { name: 'erp-export', hasSiteLogin: true, secrets: SECRETS };
const LOGIN = 'https://erp.example.com/acme/login';

let n = 0;
const at = () => `step ${++n}`;
const goto = (url: string): ImportEvent => ({ at: at(), kind: 'goto', url });
const click = (label: string, target: Candidate[] = [{ role: 'button', name: label }], extra: { download?: true; popup?: true } = {}): ImportEvent =>
  ({ at: at(), kind: 'click', target, label, ...extra });
const fill = (label: string, value: string, target: Candidate[] = [{ label, exact: true }], extra: { secure?: true; hints?: string[] } = {}): ImportEvent =>
  ({ at: at(), kind: 'fill', target, label, value, hints: extra.hints ?? [], ...(extra.secure ? { secure: true } : {}) });
const select = (label: string, value: string, target: Candidate[] = [{ label, exact: true }]): ImportEvent =>
  ({ at: at(), kind: 'select', target, label, value, hints: [] });
const expectUrl = (path: string): ImportEvent => ({ at: at(), kind: 'expectUrl', path });

/** What importSource will do with a parser's events: strip secrets, then build one draft. */
function importEvents(events: ImportEvent[], opts: ImportOptions = OPTS): ImportResult {
  const report: ImportReport = { source: 'chrome', steps: 0, items: [] };
  const draft = buildDraft(stripSecrets(events, opts, report), opts, report, opts.name);
  return { drafts: draft ? [draft] : [], report };
}
const stepsOf = (r: ImportResult): Step[] => {
  expect(r.drafts).toHaveLength(1);
  return r.drafts[0].script.steps;
};

/** The recorded sign-in: user ID, password (with a focus click), Sign in. */
const signInEvents = (user = 'u-sec', pass = 'p-sec'): ImportEvent[] => [
  goto(LOGIN),
  fill('User ID', user),
  click('Password', [{ label: 'Password', exact: true }]),
  fill('Password', pass, [{ label: 'Password', exact: true }, { css: '#pw' }], { hints: ['type=password'] }),
  click('Sign in'),
];

describe('buildDraft: locators', () => {
  it('primary locator plus at most three fallbacks', () => {
    const target: Candidate[] = [
      { role: 'button', name: 'Execute', exact: true },
      { text: 'Execute', exact: true },
      { role: 'button', name: 'Execute', exact: true }, // duplicate: dropped
      { css: '#execBtn' },
      { css: 'button.tb' },
      { css: 'form button' },
    ];
    const steps = stepsOf(importEvents([goto(LOGIN), click('Execute', target)]));
    expect(steps[1]).toEqual({
      intent: 'Click Execute',
      click: { role: 'button', name: 'Execute', exact: true, fallbacks: [{ text: 'Execute', exact: true }, { css: '#execBtn' }, { css: 'button.tb' }] },
    });
  });

  it('short role names are exact', () => {
    const steps = stepsOf(importEvents([
      goto(LOGIN),
      click('Run', [{ role: 'button', name: 'Run' }]),
      click('Export', [{ role: 'button', name: 'Export' }, { text: 'Export' }]),
      fill('From', '2026-09-01', [{ label: 'From', exact: true }]),
      click('Go', [{ role: 'link', name: 'Go', exact: false }]),
    ]));
    expect((steps[1] as S<'click'>).click).toEqual({ role: 'button', name: 'Run', exact: true });
    // Longer names keep what the parser said: no exact unless it marked one.
    expect((steps[2] as S<'click'>).click).toEqual({ role: 'button', name: 'Export', fallbacks: [{ text: 'Export' }] });
    expect((steps[3] as S<'fill'>).fill.field).toEqual({ label: 'From', exact: true });
    expect((steps[4] as S<'click'>).click).toEqual({ role: 'link', name: 'Go', exact: true });
  });

  it('ids that look generated never become a locator, primary or fallback', () => {
    const r = importEvents([
      goto(LOGIN),
      click('Execute', [{ css: '#__button12' }, { role: 'button', name: 'Execute' }, { css: 'div#ember123 > button' }, { css: '#execBtn' }, { css: '[id="M0:46:1::0:0"]' }]),
      click('Save', [{ css: '#M0\\:46\\:\\:btn\\[3\\]' }]),
    ]);
    const steps = stepsOf(r);
    expect(steps).toHaveLength(2);
    expect((steps[1] as S<'click'>).click).toEqual({ role: 'button', name: 'Execute', fallbacks: [{ css: '#execBtn' }] });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Click Save' }));
  });
});

describe('buildDraft: downloads', () => {
  const flow = (): ImportEvent[] => [
    goto(LOGIN),
    click('Line Item Report', [{ role: 'link', name: 'Line Item Report' }]),
    click('Execute'),
    click('Export'),
    click('Close'),
  ];
  const DL = { check: { name: '^LINEITEMS_' } };

  it('with Expected File the export click becomes a checked download', () => {
    const r = importEvents(flow(), { ...OPTS, download: DL });
    const steps = stepsOf(r);
    expect(steps[3]).toEqual({ intent: 'Download with Export', download: { trigger: { role: 'button', name: 'Export' }, check: { name: '^LINEITEMS_' } } });
    expect(steps[4]).toEqual({ intent: 'Click Close', click: { role: 'button', name: 'Close' } });
    expect(r.report.items.filter((i) => i.kind === 'converted')).toEqual([expect.objectContaining({ what: 'Click Export' })]);

    // mime and maxBytes come from the template too; with no export-like name the last click is the trigger.
    const last = stepsOf(importEvents([goto(LOGIN), click('Execute'), click('Go on')], { ...OPTS, download: { mime: ['text/csv'], maxBytes: 1000, check: DL.check } }));
    expect(last[2]).toEqual({ intent: 'Download with Go on', download: { trigger: { role: 'button', name: 'Go on' }, mime: ['text/csv'], maxBytes: 1000, check: DL.check } });

    // An explicit download click (Playwright's waitForEvent, UiPath's WaitForDownload) wins over a name match.
    const explicit = stepsOf(importEvents([goto(LOGIN), click('Get it', undefined, { download: true }), click('Export')], { ...OPTS, download: DL }));
    expect(explicit.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['goto', 'download', 'click']);
  });

  it('an export click that opens a dialog: the dialog\'s confirmation downloads', () => {
    // SAP's Spreadsheet... opens "Select Spreadsheet"; its Continue (Enter) sends the file.
    const sap = [goto(LOGIN), click('Execute (F8)'), click('Spreadsheet... (Ctrl+Shift+F7)'), click('Excel (XLSX)', [{ role: 'radio', name: 'Excel (XLSX)' }]), click('Continue (Enter)')];
    const steps = stepsOf(importEvents(sap, { ...OPTS, download: DL }));
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Click "Execute (F8)"', 'Click "Spreadsheet... (Ctrl+Shift+F7)"', 'Click "Excel (XLSX)"', 'Download with "Continue (Enter)"']);
    // Only the recording's last click, and only one that reads like a confirmation: Close after Export stays a click (above).
    const later = stepsOf(importEvents([...sap.slice(0, 3), click('OK'), click('Log off')], { ...OPTS, download: DL }));
    expect(later.map((s) => Object.keys(s).find((k) => k !== 'intent'))).toEqual(['goto', 'click', 'download', 'click', 'click']);
  });

  it('a confirmation after a goto or a URL check is no dialog\'s confirmation: the export click downloads', () => {
    const verbs = (r: ImportResult) => stepsOf(r).map((s) => Object.keys(s).find((k) => k !== 'intent' && k !== 'expect'));
    for (const away of [goto('https://erp.example.com/acme/done'), expectUrl('/acme/done')]) {
      const r = importEvents([goto(LOGIN), click('Execute (F8)'), click('Spreadsheet... (Ctrl+Shift+F7)'), away, click('Continue')], { ...OPTS, download: DL });
      const steps = stepsOf(r);
      expect(steps.find((s) => 'download' in s)?.intent).toBe('Download with "Spreadsheet... (Ctrl+Shift+F7)"');
      expect(steps.at(-1)).toMatchObject({ intent: 'Click Continue', click: { role: 'button', name: 'Continue' } });
      expect(verbs(r).filter((v) => v === 'download')).toHaveLength(1);
    }
  });

  it('without Expected File a click stays a click', () => {
    const r = importEvents([...flow().slice(0, 3), click('Export', undefined, { download: true })]);
    const steps = stepsOf(r);
    expect(steps.some((s) => 'download' in s)).toBe(false);
    expect(steps[3]).toEqual({ intent: 'Click Export', click: { role: 'button', name: 'Export' } });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Click Export', reason: expect.stringContaining('Expected File') }));
    expect(r.report.items.some((i) => i.kind === 'converted')).toBe(false);
  });

  it('a popup click opens a new tab', () => {
    const steps = stepsOf(importEvents([goto(LOGIN), click('Help', [{ role: 'link', name: 'Help' }], { popup: true })]));
    expect(steps[1]).toEqual({ intent: 'Open Help in a new tab', popup: { trigger: { role: 'link', name: 'Help' } } });
  });
});

describe('buildDraft: variables, navigation, rows', () => {
  it('typed values equal to one variable become {{var.x}}', () => {
    const vars = { company: '1000', from: '2026-09-01', to: '2026-09-30', a: 'same', b: 'same' };
    const steps = stepsOf(importEvents([
      goto(LOGIN),
      select('Company Code', '1000'),
      fill('From', '2026-09-01'),
      fill('To', '2026-09-30'),
      fill('Note', 'same'),
      fill('Other', 'literal'),
    ], { ...OPTS, vars }));
    expect(steps[1]).toEqual({ intent: 'Choose {{var.company}} in Company Code', select: { field: { label: 'Company Code', exact: true }, value: '{{var.company}}' } });
    expect((steps[2] as S<'fill'>).fill.value).toBe('{{var.from}}');
    expect((steps[3] as S<'fill'>).fill.value).toBe('{{var.to}}');
    expect((steps[4] as S<'fill'>).fill.value).toBe('same');
    expect((steps[5] as S<'fill'>).fill.value).toBe('literal');
    expect(steps[2].intent).toBe('Type into From');
  });

  it('navigation checks go on the step before, and session segments never reach the steps', () => {
    const r = importEvents([
      expectUrl('/nowhere'),
      goto('https://erp.example.com/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui?sap-client=100'),
      click('Line Item Report', [{ role: 'link', name: 'Line Item Report' }]),
      expectUrl('/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui/report'),
      { at: at(), kind: 'waitFor', target: [{ role: 'grid' }], label: 'the report' },
      { at: at(), kind: 'check', target: [{ label: 'Totals only' }], label: 'Totals only', checked: false },
    ]);
    const steps = stepsOf(r);
    expect(steps[0]).toEqual({ intent: 'Open erp.example.com/sap/bc/gui/sap/its/webgui', goto: 'https://erp.example.com/sap/bc/gui/sap/its/webgui?sap-client=100' });
    expect(steps[1]).toEqual({ intent: 'Click Line Item Report', click: { role: 'link', name: 'Line Item Report' }, expect: { url: '/bc/gui/sap/its/webgui/report' } });
    expect(steps[2]).toEqual({ intent: 'Wait for the report', waitFor: { target: { role: 'grid' } } });
    expect(steps[3]).toEqual({ intent: 'Uncheck Totals only', check: { field: { label: 'Totals only' }, checked: false } });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'URL check /nowhere' }));
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', reason: expect.stringContaining('session') }));
    expect(JSON.stringify(r)).not.toContain('cz1TSUQ6QU5PTjo');
  });

  it('an ID Pattern never invents an extract step', () => {
    const r = importEvents([goto(LOGIN), click('Search')], { ...OPTS, idPattern: 'A-\\d+' });
    expect(stepsOf(r).some((s) => 'extract' in s || 'extractTable' in s)).toBe(false);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'ID Pattern' }));
  });

  it('Enter outside a sign-in is reported, not a step', () => {
    const r = importEvents([goto(LOGIN), fill('Search', 'abc'), { at: at(), kind: 'enter', label: 'Search' }]);
    expect(stepsOf(r)).toHaveLength(2);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Press Enter in Search' }));
  });

  it('report events from the parser go to the report', () => {
    const item = { at: 'step 9', kind: 'untranslated' as const, what: 'waitForExpression', reason: 'not a step' };
    const r = importEvents([goto(LOGIN), { at: 'step 9', kind: 'report', item }]);
    expect(r.report.items).toContainEqual(item);
    expect(r.report.steps).toBe(1);
  });
});

describe('stripSecrets: sign-in', () => {
  it('a password group becomes signIn', () => {
    const r = importEvents([...signInEvents(), click('Line Item Report', [{ role: 'link', name: 'Line Item Report' }]), expectUrl('/report')]);
    const steps = stepsOf(r);
    expect(steps[0]).toEqual({ intent: 'Open erp.example.com/acme/login', goto: LOGIN });
    expect(steps[1]).toEqual({
      intent: 'Sign in',
      signIn: {
        username: { label: 'User ID', exact: true },
        password: { label: 'Password', exact: true, fallbacks: [{ css: '#pw' }] },
        submit: { role: 'button', name: 'Sign in' },
      },
    });
    expect(steps[2]).toMatchObject({ click: { role: 'link', name: 'Line Item Report' }, expect: { url: '/report' } });
    expect(steps).toHaveLength(3);
    const secrets = r.report.items.filter((i) => i.kind === 'secret');
    expect(secrets.map((i) => i.what)).toEqual(['User ID', 'Password']);
    expect(JSON.stringify(r)).not.toMatch(/[up]-sec/);
  });

  it('a password field is found by its name, its type or a secure flag, and Enter can submit', () => {
    for (const pw of [
      fill('Kennwort', 'x-1', [{ css: 'input[name="pwd"]' }]),
      fill('Field 2', 'x-1', [{ css: '#f2' }], { hints: ['type=password'] }),
      fill('Field 2', 'x-1', [{ css: '#f2' }], { secure: true }),
      fill('PIN', 'x-1', [{ label: 'PIN' }]),
    ]) {
      const r = importEvents([goto(LOGIN), fill('User', 'someone'), pw, { at: at(), kind: 'enter', label: 'Field 2' }, click('Home')], { ...OPTS, secrets: { username: 'nobody', password: 'nothing' } });
      const steps = stepsOf(r);
      expect(Object.keys(steps[1])).toContain('signIn');
      expect((steps[1] as S<'signIn'>).signIn.submit).toEqual({ css: 'form:has(input[type="password"]) [type="submit"]', fallbacks: [{ css: 'form:has(input[type="password"]) button:not([type])' }] });
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Press Enter in Field 2' }));
      expect(JSON.stringify(r)).not.toContain('x-1');
      expect(JSON.stringify(r)).not.toContain('someone');
    }
  });

  it('a TOTP code field becomes signIn.totp', () => {
    const r = importEvents([
      ...signInEvents(),
      expectUrl('/acme/mfa'),
      click('Authentication code', [{ label: 'Authentication code', exact: true }]),
      fill('Authentication code', '492039'),
      click('Verify'),
      expectUrl('/acme/home'),
    ]);
    const steps = stepsOf(r);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({
      intent: 'Sign in with an authentication code',
      signIn: {
        username: { label: 'User ID', exact: true },
        password: { label: 'Password', exact: true, fallbacks: [{ css: '#pw' }] },
        submit: { role: 'button', name: 'Sign in' },
        totp: { field: { label: 'Authentication code', exact: true }, submit: { role: 'button', name: 'Verify' } },
      },
      expect: { url: '/acme/home' },
    });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Authentication code' }));
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'URL check /acme/mfa' }));
    expect(JSON.stringify(r)).not.toContain('492039');
  });

  it('a value equal to the Site Login password in an oddly named field is stripped', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('Login', 'u-sec', [{ css: '#a' }]),
      fill('Key', 'p-sec', [{ css: '#b' }]),
      click('Go'),
      fill('Notes', 'p-sec', [{ label: 'Notes' }]),
      fill('Reference', ' p-sec ', [{ label: 'Reference' }]),
    ]);
    const steps = stepsOf(r);
    expect(steps[1]).toEqual({ intent: 'Sign in', signIn: { username: { css: '#a' }, password: { css: '#b' }, submit: { role: 'button', name: 'Go', exact: true } } });
    expect(steps).toHaveLength(2);
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Login', 'Key', 'Notes', 'Reference']);
    expect(JSON.stringify(r)).not.toContain('p-sec');
  });

  it('without a Site Login the sign-in steps are removed and reported', () => {
    const r = importEvents([
      ...signInEvents('ops-user', 'hunter22'),
      click('Users', [{ role: 'link', name: 'Users' }]),
      fill('Search', 'ops-user', [{ role: 'searchbox' }]),
      fill('Confirm', 'hunter22', [{ label: 'Confirm' }]),
    ], { name: 'erp-export', hasSiteLogin: false });
    const steps = stepsOf(r);
    expect(steps).toEqual([
      { intent: 'Open erp.example.com/acme/login', goto: LOGIN },
      { intent: 'Click Users', click: { role: 'link', name: 'Users' } },
    ]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', reason: IMPORT_NEEDS_SITE_LOGIN }));
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['User ID', 'Password', 'Search', 'Confirm']);
    const json = JSON.stringify(r);
    expect(json).not.toContain('hunter22');
    expect(json).not.toContain('ops-user');
  });

  it('only the first sign-in is kept', () => {
    const r = importEvents([...signInEvents(), click('Account'), fill('Current password', 'p-sec', [{ label: 'Current password' }]), fill('Name', 'u-sec', [{ label: 'Name' }]), click('Save')]);
    const steps = stepsOf(r);
    expect(steps.filter((s) => 'signIn' in s)).toHaveLength(1);
    // A later password field is stripped like any credential field; the clicks around it stay (no write passes adoption's no-write policy).
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in', 'Click Account', 'Click Save']);
    expect(JSON.stringify(r)).not.toMatch(/[up]-sec/);
  });
});

describe('stripSecrets: nothing secret survives', () => {
  it('no Site Login secret survives anywhere in the result', () => {
    const events: ImportEvent[] = [
      goto('https://erp.example.com/acme/login?user=u-sec'),
      ...signInEvents().slice(1), // 1, 2: the username and password fields
      goto('https://erp.example.com/home?user=u-sec&tab=1#p-sec'),
      fill('Search', 'u-sec', [{ role: 'searchbox' }]), // 3: the username typed again
      fill('Key', 'p-sec', [{ css: '#key' }]), // 4: the password in an oddly named field
      fill('Comment', 'see p-sec here', [{ label: 'Comment' }]), // 5: inside a longer value
      click('u-sec', [{ role: 'button', name: 'u-sec' }, { css: '#user-menu' }]), // a label that is the username
      click('Profile of u-sec', [{ text: 'Profile of u-sec' }]), // a label that names it, no other locator
      { at: at(), kind: 'waitFor', target: [{ css: 'input[value="p-sec"]' }, { css: '#ok' }], label: 'field p-sec' },
      expectUrl('/users/u-sec'),
      goto('https://erp.example.com/u-sec/home'),
      goto('https://u-sec:p-sec@erp.example.com/report'),
      select('Owner', 'u-sec'),
      { at: at(), kind: 'report', item: { at: 'line 4', kind: 'untranslated', what: "page.keyboard.type('p-sec')", reason: 'not a step for u-sec' } },
      { at: at(), kind: 'enter', label: 'p-sec' },
      click('Export (CSV)'),
    ];
    const opts: ImportOptions = { ...OPTS, name: 'erp-export', download: { check: { name: '^LINEITEMS_' } } };
    const result = importEvents(events, opts);
    expect(result.drafts).toHaveLength(1);
    const json = JSON.stringify(result);
    for (const secret of [SECRETS.username, SECRETS.password]) expect(json).not.toContain(secret);
    expect(createMasker([SECRETS.username, SECRETS.password]).containsSecret(json)).toBe(false);

    const steps = result.drafts[0].script.steps;
    expect(steps[0]).toEqual({ intent: 'Open erp.example.com/acme/login', goto: LOGIN });
    expect(steps[1]).toMatchObject({ intent: 'Sign in' });
    expect(steps[2]).toEqual({ intent: 'Open erp.example.com/home', goto: 'https://erp.example.com/home' });
    expect(steps[3]).toEqual({ intent: 'Click [secret]', click: { css: '#user-menu' } });
    expect(steps[4]).toEqual({ intent: 'Wait for field [secret]', waitFor: { target: { css: '#ok' } } });
    expect(steps[5]).toEqual({ intent: 'Open erp.example.com/report', goto: 'https://erp.example.com/report' });
    expect(steps[6]).toMatchObject({ intent: 'Download with "Export (CSV)"', download: { trigger: { role: 'button', name: 'Export (CSV)' } } });
    expect(steps).toHaveLength(7);
    // Each stripped value is reported by its field, never by its value.
    const secrets = result.report.items.filter((i) => i.kind === 'secret').map((i) => i.what);
    expect(secrets).toEqual(expect.arrayContaining(['User ID', 'Password', 'Search', 'Key', 'Comment', 'Owner']));
  });
});

describe('stripSecrets: a secret in a label', () => {
  it('a username typed into a field labelled with it is reported without it', () => {
    for (const opts of [OPTS, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const user = opts.hasSiteLogin ? 'u-sec' : 'ops-user';
      const r = importEvents([
        goto(LOGIN),
        fill(user, user, [{ label: user, exact: true }, { css: '#login' }]),
        fill('Password', 'p-sec-typed', [{ css: 'input[type=password]' }]),
        click('Sign in'),
        click(`Hello ${user}`, [{ text: `Hello ${user}` }, { css: '#greeting' }]),
        goto(`https://erp.example.com/start?who=${user}`),
      ], opts);
      const json = JSON.stringify(r);
      expect(json).not.toContain(user);
      expect(json).not.toContain('p-sec-typed');
      const steps = stepsOf(r);
      expect(steps.map((s) => s.intent)).toEqual([
        'Open erp.example.com/acme/login', ...(opts.hasSiteLogin ? ['Sign in'] : []), 'Click Hello [secret]', 'Open erp.example.com/start',
      ]);
      if (opts.hasSiteLogin) expect((steps[1] as S<'signIn'>).signIn.username).toEqual({ css: '#login' });
      expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(expect.arrayContaining(['[secret]', 'Password']));
    }
  });
});

describe('sign-in grouping and masking', () => {
  const PW: Candidate[] = [{ css: 'input[type=password]' }];

  it('a two-page sign-in becomes signIn with next (it used to be reported)', () => {
    for (const [opts, user] of [[OPTS, 'u-sec'], [{ name: 'erp-export', hasSiteLogin: false }, 'ops@corp.example']] as [ImportOptions, string][]) {
      const r = importEvents([
        goto(LOGIN),
        fill('Email', user, [{ label: 'Email', exact: true }]),
        click('Next'),
        expectUrl('/login/password'),
        fill('Password', 'p-sec', PW),
        click('Sign in'),
        click('Reports', [{ role: 'link', name: 'Reports' }]),
      ], opts);
      const steps = stepsOf(r);
      expect(steps.some((s) => 'fill' in s)).toBe(false);
      expect(steps.map((s) => s.intent)).toEqual(opts.hasSiteLogin
        ? ['Open erp.example.com/acme/login', 'Sign in', 'Click Reports']
        : ['Open erp.example.com/acme/login', 'Click Reports']);
      expect(r.report.items.some((i) => i.reason.includes('different pages'))).toBe(false);
      expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password']);
      expect(r.report.items.some((i) => i.reason === IMPORT_NEEDS_SITE_LOGIN)).toBe(!opts.hasSiteLogin);
      const json = JSON.stringify(r);
      expect(json).not.toContain(user);
      expect(json).not.toContain('p-sec');
    }
  });

  it('a field between the username and the password is filled before signIn', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('User ID', 'u-sec'),
      fill('Client', '100', [{ label: 'Client', exact: true }]),
      fill('Password', 'p-sec', PW),
      click('Sign in'),
    ]);
    const steps = stepsOf(r);
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Type into Client', 'Sign in']);
    expect((steps[1] as S<'fill'>).fill.value).toBe('100');
    expect((steps[2] as S<'signIn'>).signIn).toEqual({ username: { label: 'User ID', exact: true }, password: { css: 'input[type=password]' }, submit: { role: 'button', name: 'Sign in' } });
    expect(JSON.stringify(r)).not.toContain('u-sec');
  });

  it('without a username the Site Login confirms, every field it could be is stripped (fail closed)', () => {
    // The label picks User ID for signIn, but Client is the nearest fill: either could hold the username.
    const r = importEvents([
      goto(LOGIN),
      fill('User ID', 'someone'),
      fill('Client', '100', [{ label: 'Client', exact: true }]),
      fill('Password', 'p-sec', PW),
      click('Sign in'),
    ], { ...OPTS, secrets: { username: 'nobody', password: 'nothing' } });
    const steps = stepsOf(r);
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in']);
    expect((steps[1] as S<'signIn'>).signIn.username).toEqual({ label: 'User ID', exact: true });
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['User ID', 'Client', 'Password']);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Client', reason: expect.stringContaining('username') }));
    expect(JSON.stringify(r)).not.toContain('someone');
  });

  it('no Site Login, two candidate fills before the password: neither value survives', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('Account', 'acct-7731', [{ label: 'Account' }]),
      fill('Name', 'jdoe-name', [{ css: '#n' }]),
      fill('Password', 'hunter22', PW),
      click('Sign in'),
      click('Home'),
    ], { name: 'erp-export', hasSiteLogin: false });
    expect(stepsOf(r).map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Click Home']);
    const json = JSON.stringify(r);
    for (const v of ['acct-7731', 'jdoe-name', 'hunter22']) expect(json).not.toContain(v);
  });

  it('a two-page sign-in with an unlabeled username field strips its value', () => {
    for (const opts of [OPTS, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const r = importEvents([
        goto(LOGIN),
        fill('Search', 'abc', [{ role: 'searchbox' }]),
        click('Go'),
        fill('', 'ops-person', [{ css: '#f1' }]),
        click('Next'),
        expectUrl('/login/password'),
        fill('Password', 'p-sec', PW),
        click('Sign in'),
      ], opts);
      const steps = stepsOf(r);
      // Every page back to the previous goto may hold the username, so Search (the nearest fill on its page) goes too.
      expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Click Go', 'Click Next', 'Click Sign in']);
      expect(JSON.stringify(r)).not.toContain('ops-person');
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('different pages') }));
    }
  });

  it('a code step that cannot be joined is reported', () => {
    const r = importEvents([...signInEvents(), goto('https://erp.example.com/acme/mfa'), fill('Authentication code', '492 039'), click('Verify')]);
    const steps = stepsOf(r);
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in', 'Open erp.example.com/acme/mfa', 'Click Verify']);
    expect((steps[1] as S<'signIn'>).signIn.totp).toBeUndefined();
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('could not be joined to the sign-in') }));
    expect(JSON.stringify(r)).not.toMatch(/492.?039/);
  });

  it('a code with a separator is the TOTP field', () => {
    const r = importEvents([...signInEvents(), fill('Verification code', '492-039'), click('Verify')]);
    expect((stepsOf(r)[1] as S<'signIn'>).signIn.totp).toEqual({ field: { label: 'Verification code', exact: true }, submit: { role: 'button', name: 'Verify' } });
    expect(JSON.stringify(r)).not.toMatch(/492.?039/);
  });

  it('every event location is masked', () => {
    const events: ImportEvent[] = [{ at: 'step for u-sec', kind: 'goto', url: LOGIN }, { at: 'line p-sec', kind: 'click', target: [{ css: '#go' }], label: 'Go' }];
    const out = stripSecrets(events, OPTS, { source: 'chrome', steps: 0, items: [] });
    expect(JSON.stringify(out)).not.toMatch(/[up]-sec/);
    expect(out.map((e) => e.at)).toEqual(['step for [secret]', 'line [secret]']);
  });

  it('short Site Login secrets are compared whole and case-insensitively', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('Name', 'AL', [{ label: 'Name' }]),
      click('al', [{ role: 'button', name: 'Al' }, { css: '#me' }]),
      fill('Note', 'Alpha', [{ label: 'Note' }]),
    ], { ...OPTS, secrets: { username: 'Al', password: 'xyz' } });
    const steps = stepsOf(r);
    expect(steps.slice(1)).toEqual([
      { intent: 'Click [secret]', click: { css: '#me' } },
      { intent: 'Type into Note', fill: { field: { label: 'Note' }, value: 'Alpha' } },
    ]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Name' }));
  });

  it('exact: false does not make a second candidate, and a # in a quoted value is not an id', () => {
    const steps = stepsOf(importEvents([
      goto(LOGIN),
      click('Execute', [{ text: 'Execute', exact: false }, { text: 'Execute' }]),
      click('Jump', [{ css: 'a[href="#section-2024-01-01"]' }]),
    ]));
    expect((steps[1] as S<'click'>).click).toEqual({ text: 'Execute' });
    expect((steps[2] as S<'click'>).click).toEqual({ css: 'a[href="#section-2024-01-01"]' });
  });

  it('a credential-looking field that is no password field is stripped but is no sign-in', () => {
    for (const opts of [OPTS, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const r = importEvents([goto(LOGIN), fill('Name', 'Smith'), fill('Passenger', 'Smythe', [{ label: 'Passenger' }]), click('Search')], opts);
      expect(stepsOf(r).map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Type into Name', 'Click Search']);
      expect(r.report.items.some((i) => i.reason === IMPORT_NEEDS_SITE_LOGIN || i.what === 'Sign in')).toBe(false);
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Passenger' }));
    }
  });
});

describe('capped candidates and multi-page sign-ins', () => {
  const pad = `:not(${'.x'.repeat(3000)})`; // pushes a candidate past the 4096-character cap

  it('a password field identified only by an oversized candidate is still a password field', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('User', 'ops-user', [{ css: '#u' }]),
      fill('Field', 'hunter-xx', [{ css: `input[type=password]${pad}` }, { css: '#f2' }]),
      click('Sign in'),
    ], { ...OPTS, secrets: { username: 'nobody', password: 'nothing' } });
    const steps = stepsOf(r);
    expect(steps[1]).toEqual({ intent: 'Sign in', signIn: { username: { css: '#u' }, password: { css: '#f2' }, submit: { role: 'button', name: 'Sign in' } } });
    const json = JSON.stringify(r);
    expect(json).not.toContain('hunter-xx');
    expect(json).not.toContain('ops-user');
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', reason: expect.stringContaining('longer than') }));
  });

  it('a fill or select that lost a candidate to the cap loses its value too (fail closed)', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('Notes', 'typed-value-1', [{ css: `div${pad}[type=password]` }, { css: '#notes' }]),
      select('Owner', 'chosen-2', [{ css: `select${pad}` }]),
      fill('Comment', 'see typed-value-1', [{ label: 'Comment' }]),
      click('Save'),
    ], { name: 'erp-export', hasSiteLogin: false });
    expect(stepsOf(r).map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Click Save']);
    const json = JSON.stringify(r);
    for (const v of ['typed-value-1', 'chosen-2']) expect(json).not.toContain(v);
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Notes', 'Owner', 'Comment']);
  });

  it('a three-page sign-in strips the username two pages back, and nothing before the previous goto', () => {
    for (const opts of [OPTS, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const r = importEvents([
        goto('https://erp.example.com/home'),
        fill('Search', 'abc-term', [{ role: 'searchbox' }]),
        click('Go'),
        goto(LOGIN),
        fill('', 'ops-person', [{ css: '#f1' }]),
        click('Next'),
        expectUrl('/login/method'),
        click('Use a password', [{ role: 'link', name: 'Use a password' }]),
        click('Continue'),
        expectUrl('/login/password'),
        fill('Password', 'p-sec', [{ css: 'input[type=password]' }]),
        click('Sign in'),
      ], opts);
      const steps = stepsOf(r);
      expect(steps.map((s) => s.intent)).toEqual([
        'Open erp.example.com/home', 'Type into Search', 'Click Go', 'Open erp.example.com/acme/login',
        'Click Next', 'Click Use a password', 'Click Continue', 'Click Sign in',
      ]);
      expect((steps[1] as S<'fill'>).fill.value).toBe('abc-term');
      const json = JSON.stringify(r);
      expect(json).not.toContain('ops-person');
      expect(json).not.toContain('p-sec');
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'a field', reason: expect.stringContaining('username') }));
    }
  });
});

describe('identity-first sign-ins', () => {
  const PW: Candidate[] = [{ css: 'input[type=password]' }];
  const EMAIL: Candidate[] = [{ label: 'Email', exact: true }, { css: '#loginfmt' }];
  const identityFirst = (user = 'u-sec', leave: ImportEvent = click('Next')): ImportEvent[] => [
    goto(LOGIN),
    click('Email', EMAIL),
    fill('Email', user, EMAIL),
    leave,
    expectUrl('/login/password'),
    click('Password', PW),
    fill('Password', 'p-sec', PW),
    click('Sign in'),
  ];

  it('an identity-first recording becomes signIn with next', () => {
    const r = importEvents([
      ...identityFirst(),
      expectUrl('/login/mfa'),
      fill('Code', '492039', [{ label: 'Code', exact: true }]),
      click('Verify'),
      click('No', [{ role: 'button', name: 'No', exact: true }]),
      click('Reports', [{ role: 'link', name: 'Reports' }]),
    ]);
    const steps = stepsOf(r);
    expect(steps).toEqual([
      { intent: 'Open erp.example.com/acme/login', goto: LOGIN },
      {
        intent: 'Sign in with an authentication code',
        signIn: {
          username: { label: 'Email', exact: true, fallbacks: [{ css: '#loginfmt' }] },
          next: { role: 'button', name: 'Next' },
          password: { css: 'input[type=password]' },
          submit: { role: 'button', name: 'Sign in' },
          totp: { field: { label: 'Code', exact: true }, submit: { role: 'button', name: 'Verify' } },
        },
      },
      // "Stay signed in?" No right after the sign-in runs only when it shows, so it joins the login block.
      { intent: 'Click No', when: { visible: { role: 'button', name: 'No', exact: true } }, click: { role: 'button', name: 'No', exact: true } },
      { intent: 'Click Reports', click: { role: 'link', name: 'Reports' } },
    ]);
    expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);
    // The URL check between the pages cannot sit on a step any more: signIn passes both pages in one step.
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'URL check /login/password' }));
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'URL check /login/mfa' }));
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password', 'Code']);
    expect(r.report.items.filter((i) => i.kind === 'untranslated')).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/[up]-sec|492039/);
    // The change list names the next click.
    expect(describeStep(steps[1])).toContain('next');
  });

  it('without a username the Site Login confirms, the username-like field on the first page is the username', () => {
    const r = importEvents([
      goto(LOGIN),
      fill('Email', 'someone', EMAIL),
      fill('Tenant', 'acme-tenant', [{ label: 'Tenant', exact: true }]),
      click('Next'),
      fill('Password', 'p-sec', PW),
      click('Sign in'),
    ], { ...OPTS, secrets: { username: 'nobody', password: 'nothing' } });
    const steps = stepsOf(r);
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in']);
    expect((steps[1] as S<'signIn'>).signIn).toMatchObject({ username: { label: 'Email', exact: true }, next: { role: 'button', name: 'Next' } });
    // Fail closed, as on one page: the nearest fill on the username page loses its value too.
    expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Tenant', 'Password']);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: 'Tenant', reason: expect.stringContaining('username') }));
    expect(JSON.stringify(r)).not.toMatch(/someone|acme-tenant|p-sec/);
  });

  it('Enter as next is converted and reported', () => {
    const r = importEvents(identityFirst('u-sec', { at: at(), kind: 'enter', label: 'Email' }));
    const signIn = (stepsOf(r)[1] as S<'signIn'>).signIn;
    expect(signIn.next).toEqual({ css: 'form [type="submit"]', fallbacks: [{ css: 'form button:not([type])' }] });
    expect(signIn.submit).toEqual({ role: 'button', name: 'Sign in' });
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Press Enter in Email', reason: expect.stringContaining('submit button') }));
    expect(JSON.stringify(r)).not.toMatch(/[up]-sec/);
  });

  it('three pages are still reported', () => {
    // The username two pages back (a page with a field and a click between), and a method page with only clicks.
    for (const middle of [
      [fill('Organisation', 'acme-org', [{ label: 'Organisation', exact: true }]), click('Continue')],
      [click('Use a password', [{ role: 'link', name: 'Use a password' }]), click('Continue')],
    ]) {
      const r = importEvents([goto(LOGIN), fill('Email', 'u-sec', EMAIL), click('Next'), ...middle, fill('Password', 'p-sec', PW), click('Sign in')]);
      const steps = stepsOf(r);
      expect(steps.some((s) => 'signIn' in s)).toBe(false);
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in', reason: expect.stringContaining('different pages') }));
      expect(r.report.items.filter((i) => i.kind === 'secret').map((i) => i.what)).toEqual(['Email', 'Password']);
      expect(JSON.stringify(r)).not.toMatch(/[up]-sec/);
    }
    // Without a Site Login match every page back to the previous goto may hold the username: a field on an earlier page
    // means the username page is not proven, so nothing is built.
    const r = importEvents([
      goto(LOGIN), fill('Search', 'abc-term', [{ role: 'searchbox' }]), click('Go'),
      fill('Email', 'ops-person', EMAIL), click('Next'), fill('Password', 'p-sec', PW), click('Sign in'),
    ], { ...OPTS, secrets: { username: 'nobody', password: 'nothing' } });
    expect(stepsOf(r).some((s) => 'signIn' in s)).toBe(false);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('different pages') }));
    expect(JSON.stringify(r)).not.toMatch(/abc-term|ops-person|p-sec/);
  });

  it('a field between the pages is still reported', () => {
    for (const between of [
      select('Domain', 'corp', [{ label: 'Domain', exact: true }]),
      { at: at(), kind: 'check', target: [{ label: 'Keep me signed in', exact: true }], label: 'Keep me signed in', checked: true } as ImportEvent,
      // A fill on the password page while the username was typed on the page before: never the username.
      fill('Tenant', 'contoso', [{ label: 'Tenant', exact: true }]),
    ]) {
      const r = importEvents([goto(LOGIN), fill('Email', 'u-sec', EMAIL), click('Next'), between, fill('Password', 'p-sec', PW), click('Sign in')]);
      const steps = stepsOf(r);
      expect(steps.some((s) => 'signIn' in s)).toBe(false);
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in', reason: expect.stringContaining('different pages') }));
      expect(JSON.stringify(r)).not.toMatch(/[up]-sec|contoso/);
    }
    // Another click between the pages, or a goto, is no single Next either.
    const other = importEvents([goto(LOGIN), fill('Email', 'u-sec', EMAIL), click('Next'), click('Help'), fill('Password', 'p-sec', PW), click('Sign in')]);
    expect(stepsOf(other).some((s) => 'signIn' in s)).toBe(false);
    expect(other.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', reason: expect.stringContaining('different pages') }));
    const gone = importEvents([goto(LOGIN), fill('Email', 'u-sec', EMAIL), click('Next'), goto(`${LOGIN}/password`), fill('Password', 'p-sec', PW), click('Sign in')]);
    expect(stepsOf(gone).some((s) => 'signIn' in s)).toBe(false);
    expect(gone.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in' }));
    expect(JSON.stringify([other, gone])).not.toMatch(/[up]-sec/);
  });

  it('no Site Login secret survives (deep scan)', () => {
    const SL = { username: 'ops.bot@corp.example', password: 'Hunter-22-pw', totpSecret: 'JBSWY3DPEHPK3PXP' };
    const all = [SL.username, SL.password, SL.totpSecret, '481516'];
    for (const leave of [click('Next'), { at: at(), kind: 'enter', label: SL.username } as ImportEvent]) {
      const events: ImportEvent[] = [
        goto(`https://login.example.com/authorize?login_hint=${encodeURIComponent(SL.username)}`),
        { at: `step for ${SL.username}`, kind: 'click', target: EMAIL, label: 'Email' },
        fill('Email', SL.username, [{ label: 'Email', exact: true }, { css: `input[value="${SL.username}"]` }, { css: '#loginfmt' }]),
        leave,
        expectUrl('/login/password'),
        { at: at(), kind: 'waitFor', target: [{ text: `Enter password for ${SL.username}` }, { css: '#passwd' }], label: `password for ${SL.username}` },
        fill('Password', SL.password, PW),
        click('Sign in'),
        fill('Code', '481516', [{ label: 'Code', exact: true }]),
        click('Verify'),
        click(`Signed in as ${SL.username}`, [{ text: `Signed in as ${SL.username}` }, { css: '#me' }]),
        fill('Search', SL.username, [{ role: 'searchbox' }]),
        { at: at(), kind: 'report', item: { at: 'line 9', kind: 'untranslated', what: `type ${SL.password}`, reason: `for ${SL.username}` } },
        click('Export (CSV)'),
      ];
      const opts: ImportOptions = { name: 'erp-export', hasSiteLogin: true, secrets: SL, download: { check: { name: '^LINEITEMS_' } } };
      const r = importEvents(events, opts);
      const steps = stepsOf(r);
      expect(steps.filter((s) => 'signIn' in s)).toHaveLength(1);
      expect((steps.find((s) => 'signIn' in s) as S<'signIn'>).signIn.next).toBeDefined();
      const json = JSON.stringify(r);
      for (const v of all) expect(json.toLowerCase()).not.toContain(v.toLowerCase());
      expect(json).not.toContain(encodeURIComponent(SL.username));
      expect(createMasker(all).containsSecret(json)).toBe(false);
    }
  });
});

describe('fail-closed usernames across pages, popup Next', () => {
  const PW: Candidate[] = [{ css: 'input[type=password]' }];
  const EMAIL: Candidate[] = [{ label: 'Email', exact: true }, { css: '#loginfmt' }];

  it('no confident username across pages: every plausible fill on the earlier pages is stripped, even with a field on the password page (deep scan)', () => {
    // Earlier gap: the password page's own field became the username and the page-1 email, not the Site Login value, survived as a fill.
    for (const opts of [{ ...OPTS, secrets: { username: 'nobody', password: 'p-sec' } }, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const r = importEvents([
        goto(LOGIN),
        fill('Search', 'abc-term', [{ role: 'searchbox' }]),
        click('Go'),
        click('Email', EMAIL),
        fill('Email', 'ops-person@corp.example', EMAIL),
        click('Next'),
        expectUrl('/login/password'),
        fill('Tenant', 'contoso-tenant', [{ label: 'Tenant', exact: true }]),
        fill('Password', 'p-sec', PW),
        click('Sign in'),
        click('Signed in as ops-person@corp.example', [{ text: 'Signed in as ops-person@corp.example' }, { css: '#me' }]),
        fill('Find', 'ops-person@corp.example', [{ role: 'searchbox', name: 'Find' }]),
        click('Home'),
      ], opts);
      const steps = stepsOf(r);
      const json = JSON.stringify(r);
      for (const v of ['ops-person', 'abc-term', 'contoso-tenant', 'p-sec']) expect(json, v).not.toContain(v);
      for (const what of ['Search', 'Email']) {
        expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what, reason: expect.stringContaining('may hold the username') }));
      }
      expect(steps.some((s) => 'fill' in s && /Email|Search/.test(s.intent))).toBe(false);
      expect(steps.at(-1)).toEqual({ intent: 'Click Home', click: { role: 'button', name: 'Home' } });
    }
  });

  it('a confident username on the password page leaves the earlier pages alone', () => {
    const r = importEvents([
      goto(LOGIN), fill('Search', 'abc-term', [{ role: 'searchbox' }]), click('Go'),
      fill('User ID', 'u-sec'), fill('Password', 'p-sec', PW), click('Sign in'),
    ]);
    const steps = stepsOf(r);
    expect((steps.find((s) => 'fill' in s) as S<'fill'>).fill.value).toBe('abc-term');
    expect((steps.find((s) => 'signIn' in s) as S<'signIn'>).signIn.username).toEqual({ label: 'User ID', exact: true });
  });

  it('a Next that opens a popup never becomes next: the sign-in is reported as before', () => {
    for (const opts of [OPTS, { name: 'erp-export', hasSiteLogin: false }] as ImportOptions[]) {
      const r = importEvents([
        goto(LOGIN),
        fill('Email', 'u-sec', EMAIL),
        click('Next', undefined, { popup: true }),
        fill('Password', 'p-sec', PW),
        click('Sign in'),
      ], opts);
      const steps = stepsOf(r);
      expect(steps.some((s) => 'signIn' in s)).toBe(false);
      expect(steps.some((s) => 'popup' in s)).toBe(true);
      expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'untranslated', what: 'Sign in', reason: expect.stringContaining('different pages') }));
      expect(JSON.stringify(r)).not.toMatch(/[up]-sec/);
    }
  });
});

describe('the "Stay signed in?" answer joins the login block', () => {
  const PW: Candidate[] = [{ css: 'input[type=password]' }];
  const EMAIL: Candidate[] = [{ label: 'Email', exact: true }, { css: '#loginfmt' }];
  /** Email, Next, password, Sign in, code, Verify: the identity-first sign-in with a code. */
  const sso = (): ImportEvent[] => [
    goto(LOGIN), fill('Email', 'u-sec', EMAIL), click('Next'), fill('Password', 'p-sec', PW), click('Sign in'),
    fill('Code', '492039', [{ label: 'Code', exact: true }]), click('Verify'),
  ];
  const NO: Candidate[] = [{ role: 'button', name: 'No', exact: true }, { text: 'No' }, { css: '#idBtn_Back' }];
  const gate = (loc: Record<string, unknown>) => ({ when: { visible: loc } });

  it('a No right after the sign-in is gated on its own locator and reported converted', () => {
    const r = importEvents([...sso(), click('No', NO), expectUrl('/sap/bc/gui/sap/its/webgui'), click('Reports', [{ role: 'link', name: 'Reports' }])]);
    const steps = stepsOf(r);
    expect(steps[2]).toEqual({
      intent: 'Click No',
      // The primary locator only: the when check and the click find the same button.
      ...gate({ role: 'button', name: 'No', exact: true }),
      click: { role: 'button', name: 'No', exact: true, fallbacks: [{ text: 'No' }, { css: '#idBtn_Back' }] },
      // The URL check after the answer stays on it: it runs only when the answer did.
      expect: { url: '/sap/bc/gui/sap/its/webgui' },
    });
    expect(steps[3]).toEqual({ intent: 'Click Reports', click: { role: 'link', name: 'Reports' } });
    expect(loginBlockEnd(r.drafts[0].script)).toBe(2);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'converted', what: 'Click No', reason: expect.stringContaining('Stay signed in?') }));
    expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);
    expect(describeStep(steps[2])).toMatch(/^Click No \(if role "button" name "No" exact shows, click /);
    expect(JSON.stringify(r)).not.toMatch(/[up]-sec|492039/);
  });

  it('Yes and "Don\'t show this again" in any case, and a password-only sign-in, are gated too; consecutive answers each are', () => {
    for (const name of ['Yes', 'YES', 'no', "Don't show this again", 'don’t SHOW this again']) {
      const r = importEvents([...signInEvents(), click(name, [{ role: 'button', name }]), click('Reports', [{ role: 'link', name: 'Reports' }])]);
      const steps = stepsOf(r);
      expect(steps[2], name).toMatchObject({ when: { visible: { role: 'button', name } }, click: { role: 'button', name } });
      expect(loginBlockEnd(r.drafts[0].script), name).toBe(2);
    }
    const both = importEvents([...sso(), click("Don't show this again", [{ role: 'button', name: "Don't show this again" }]), click('No', NO), click('Reports')]);
    const steps = stepsOf(both);
    expect(steps.map((s) => 'when' in s)).toEqual([false, false, true, true, false]);
    expect(loginBlockEnd(both.drafts[0].script)).toBe(3);
  });

  it('a "Don\'t show this again" checkbox between the sign-in and the answer is gated too', () => {
    const BOX: Candidate[] = [{ role: 'checkbox', name: "Don't show this again" }, { css: '#KmsiCheckboxField' }];
    for (const box of [
      { at: at(), kind: 'check', target: BOX, label: "Don't show this again", checked: true },
      { at: at(), kind: 'check', target: [{ label: 'DON’T SHOW THIS AGAIN' }], label: 'DON’T SHOW THIS AGAIN', checked: true },
      click("Don't show this again", [{ role: 'checkbox', name: "don't show this again" }]),
    ] as ImportEvent[]) {
      const r = importEvents([...sso(), box, click('No', NO), click('Reports', [{ role: 'link', name: 'Reports' }])]);
      const steps = stepsOf(r);
      expect(steps.map((s) => 'when' in s)).toEqual([false, false, true, true, false]);
      const primary = pickLocator(box.kind === 'check' || box.kind === 'click' ? box.target : []);
      delete (primary as { fallbacks?: unknown }).fallbacks;
      expect(steps[2]).toMatchObject({ when: { visible: primary } });
      expect(loginBlockEnd(r.drafts[0].script)).toBe(3);
      expect(parseScript(r.drafts[0].script)).toEqual(r.drafts[0].script);
      expect(r.report.items.filter((i) => i.kind === 'converted' && /Stay signed in/.test(i.reason))).toHaveLength(2);
    }
  });

  it('URL checks and waits between the sign-in and the answer are dropped and reported (the prompt shows only sometimes)', () => {
    const r = importEvents([
      ...sso(),
      expectUrl('/idp/kmsi'),
      { at: at(), kind: 'waitFor', target: [{ role: 'heading', name: 'Stay signed in?' }], label: 'Stay signed in?' },
      click('No', NO),
      click('Reports'),
    ]);
    const steps = stepsOf(r);
    expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in with an authentication code', 'Click No', 'Click Reports']);
    expect(steps[1]).not.toHaveProperty('expect');
    expect(loginBlockEnd(r.drafts[0].script)).toBe(2);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'URL check /idp/kmsi', reason: expect.stringContaining('Stay signed in?') }));
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Wait for Stay signed in?' }));
  });

  it('never gates any other click', () => {
    const plain = (events: ImportEvent[], opts: ImportOptions = OPTS) => {
      const r = importEvents(events, opts);
      const steps = stepsOf(r);
      expect(steps.some((s) => 'when' in s)).toBe(false);
      expect(r.report.items.some((i) => i.kind === 'converted' && /Stay signed in/.test(i.reason))).toBe(false);
      return steps;
    };
    // A required Yes on a consent page later on, not right after the sign-in.
    plain([...signInEvents(), click('Reports', [{ role: 'link', name: 'Reports' }]), click('Yes')]);
    plain([...signInEvents(), fill('Search', 'term', [{ role: 'searchbox' }]), click('Yes')]);
    plain([...signInEvents(), goto('https://erp.example.com/consent'), click('Yes')]);
    // Not a button named exactly No, Yes or "Don't show this again".
    for (const target of [
      [{ role: 'link', name: 'No' }], [{ text: 'Yes' }], [{ css: '#idBtn_Back' }], [{ role: 'button', name: 'No thanks' }],
      [{ role: 'button', name: 'Not now' }], [{ role: 'button', name: 'Continue' }], [{ role: 'checkbox', name: "Don't show this again" }],
    ] as Candidate[][]) plain([...signInEvents(), click('No', target)]);
    // A "Don't show this again" box with no answer after it stays plain, as does a box named otherwise before an answer.
    plain([...signInEvents(), { at: at(), kind: 'check', target: [{ role: 'checkbox', name: "Don't show this again" }], label: "Don't show this again", checked: true }, click('Reports')]);
    plain([...signInEvents(), { at: at(), kind: 'check', target: [{ role: 'checkbox', name: 'Remember me' }], label: 'Remember me', checked: true }, click('No', NO)]);
    // A popup, and the click that downloads.
    plain([...signInEvents(), click('Yes', undefined, { popup: true })]);
    const dl = plain([...signInEvents(), click('Yes', undefined, { download: true })], { ...OPTS, download: { check: { name: '\\.csv$' } } });
    expect(dl.at(-1)).toHaveProperty('download');
    // No sign-in was built: without a Site Login, or when the recorded sign-in is incomplete.
    plain([...signInEvents(), click('No', NO)], { name: 'erp-export', hasSiteLogin: false });
    plain([goto(LOGIN), fill('Password', 'p-sec', PW), click('Sign in'), click('No', NO)]);
    // No sign-in at all.
    plain([goto(LOGIN), click('Start'), click('No', NO)]);
  });
});

describe('a code from an expression or a TOTP activity', () => {
  const PW: Candidate[] = [{ css: 'input[type=password]' }];
  const EMAIL: Candidate[] = [{ label: 'Email', exact: true }, { css: '#loginfmt' }];
  const CODE: Candidate[] = [{ label: 'Code', exact: true }, { css: '#otc' }];
  const SL = { username: 'ops.bot@corp.example', password: 'Hunter-22-pw', totpSecret: 'JBSWY3DPEHPK3PXP' };
  const opts: ImportOptions = { name: 'erp-export', hasSiteLogin: true, secrets: SL };
  const sso = (code: ImportEvent, between: ImportEvent[] = []): ImportEvent[] => [
    goto(LOGIN), fill('Email', SL.username, EMAIL), click('Next'), fill('Password', SL.password, PW), click('Sign in'),
    ...between, code, click('Verify'), click('Reports', [{ role: 'link', name: 'Reports' }]),
  ];

  it('a fill right after the submit into a code field becomes signIn.totp when its value is an expression or a variable', () => {
    for (const code of [
      // UiPath: Text="[strOtp]" (an expression the import does not evaluate: no value), or a mapped variable.
      fill('Code', '', CODE, { hints: ['strOtp'] }),
      fill('Code', '{{var.otp}}', CODE),
      fill('Verification code', '{{ $json.code }}', [{ label: 'Verification code' }]),
    ]) {
      for (const between of [[], [expectUrl('/idp/mfa')], [click('Code', code.kind === 'fill' ? code.target : [])]]) {
        const r = importEvents(sso(code, between), opts);
        const steps = stepsOf(r);
        expect(steps.map((s) => s.intent)).toEqual(['Open erp.example.com/acme/login', 'Sign in with an authentication code', 'Click Reports']);
        const signIn = (steps[1] as S<'signIn'>).signIn;
        expect(signIn.totp).toEqual({ field: pickLocator(code.kind === 'fill' ? code.target : []), submit: { role: 'button', name: 'Verify' } });
        expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'secret', what: code.kind === 'fill' ? code.label : '' }));
        expect(r.report.items.filter((i) => i.kind === 'untranslated')).toEqual([]);
        // Deep scan: no Site Login secret, and nothing of the code's expression, anywhere.
        const json = JSON.stringify(r);
        for (const v of [SL.username, SL.password, SL.totpSecret, '{{var.otp}}', '$json.code']) expect(json).not.toContain(v);
        expect(createMasker([SL.username, SL.password, SL.totpSecret]).containsSecret(json)).toBe(false);
      }
    }
  });

  it('only when a sign-in group was built, right after its submit, into a code field, with a value that is not typed text', () => {
    const notTotp = (events: ImportEvent[], o: ImportOptions = opts) => {
      const r = importEvents(events, o);
      expect(r.drafts.flatMap((d) => d.script.steps).some((s) => 'signIn' in s && s.signIn.totp)).toBe(false);
      return r;
    };
    // No sign-in at all: the code-like fill stays a fill.
    const none = notTotp([goto(LOGIN), click('Start'), fill('Code', '{{var.otp}}', CODE), click('Verify')]);
    expect(stepsOf(none).some((s) => 'fill' in s && s.fill.value === '{{var.otp}}')).toBe(true);
    // An incomplete sign-in (no username): no group, so no code.
    notTotp([goto(LOGIN), fill('Password', SL.password, PW), click('Sign in'), fill('Code', '{{var.otp}}', CODE), click('Verify')]);
    // Not right after the submit: a click on another element between.
    const later = notTotp(sso(fill('Code', '{{var.otp}}', CODE), [click('Help')]));
    expect(stepsOf(later).some((s) => 'fill' in s && s.fill.value === '{{var.otp}}')).toBe(true);
    // A literal value that is no 6 to 8 digit code: a field on the next page ("Company Code" 1000) stays a fill.
    const literal = notTotp(sso(fill('Company Code', '1000', [{ label: 'Company Code' }])));
    expect(stepsOf(literal).find((s) => 'fill' in s)).toMatchObject({ fill: { field: { label: 'Company Code' }, value: '1000' } });
    // Not a code field.
    const other = notTotp(sso(fill('Reference', '{{var.ref}}', [{ label: 'Reference' }])));
    expect(stepsOf(other).some((s) => 'fill' in s && s.fill.value === '{{var.ref}}')).toBe(true);
    // No submit after it: not joined, and as before not a code (a 6 to 8 digit one would be reported).
    const unjoined = notTotp([goto(LOGIN), fill('Email', SL.username, EMAIL), click('Next'), fill('Password', SL.password, PW), click('Sign in'), fill('Code', '{{var.otp}}', CODE)]);
    expect(JSON.stringify(unjoined)).not.toMatch(/Hunter-22-pw|ops\.bot/);
  });
});

describe('bounded work on hostile selectors', () => {
  const hostile = '"' + '\\"'.repeat(512 * 1024); // 1 MiB: a quote, then escaped quotes, never closed

  it('the generated-id scan is linear on an unterminated quoted selector', () => {
    const t0 = performance.now();
    expect(pickLocator([{ css: `a[href=${hostile}` }, { css: `#x${"'\\'".repeat(300_000)}` }])).toBeDefined();
    expect(pickLocator([{ css: `[id=${hostile}` }, { css: '[id="__button12"]' }, { css: "[id='ok-1'] > #ember12" }, { css: 'b' }])).toEqual({ css: `[id=${hostile}`, fallbacks: [{ css: 'b' }] });
    expect(performance.now() - t0).toBeLessThan(bound(1000));
  });

  it('an oversized candidate is dropped and reported before any other work', () => {
    const t0 = performance.now();
    const r = importEvents([goto(LOGIN), click('Export', [{ css: hostile }, { role: 'button', name: 'Export' }]), click('Huge', [{ css: hostile }])]);
    expect(performance.now() - t0).toBeLessThan(bound(1000));
    expect(stepsOf(r).slice(1)).toEqual([{ intent: 'Click Export', click: { role: 'button', name: 'Export' } }]);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Click Huge' }));
    expect(r.report.items.filter((i) => i.reason.includes('longer than'))).toHaveLength(2);
    expect(JSON.stringify(r.report).length).toBeLessThan(10_000);
  });
});

describe('buildDraft: intents and the result', () => {
  it('the draft parses and its intents carry no control characters', () => {
    const long = 'Report '.repeat(30);
    const r = importEvents([
      goto(LOGIN),
      click('\u200bExport\nnow\t\u202e', [{ role: 'button', name: 'Export now' }]),
      click(long, [{ text: 'Report' }]),
      fill('', 'abc', [{ label: 'Customer', exact: true }]),
      click('', [{ css: '#go' }]),
    ]);
    const draft = r.drafts[0];
    expect(draft.name).toBe('erp-export');
    expect(draft.script).toMatchObject({ name: 'erp-export', version: 1, startUrl: LOGIN });
    expect(parseScript(draft.script)).toEqual(draft.script);
    expect(r.report.steps).toBe(5);
    const intents = draft.script.steps.map((s) => s.intent);
    for (const intent of intents) expect(intent).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(intents[1]).toBe('Click Export now');
    expect(intents[2]).toBe(`Click ${long.slice(0, 80).trimEnd()}`);
    expect(intents[3]).toBe('Type into Customer');
    expect(intents[4]).toBe('Click the element');
  });

  it('a label with brackets cannot pass for the action in the change list', () => {
    const steps = stepsOf(importEvents([
      goto(LOGIN),
      click('Export (CSV)'),
      click('Save (download with css "#x")', [{ css: '#save' }]),
      select('Format', 'CSV (comma)', [{ label: 'Format' }]),
    ]));
    expect(steps.map((s) => s.intent)).toEqual([
      'Open erp.example.com/acme/login',
      'Click "Export (CSV)"',
      `Click "Save (download with css '#x')"`,
      'Choose "CSV (comma)" in Format',
    ]);
    expect(describeStep(steps[1])).toBe('Click "Export (CSV)" (click role "button" name "Export (CSV)")');
    expect(describeStep(steps[2])).toBe(`Click "Save (download with css '#x')" (click css "#save")`);
    for (const s of steps) {
      // Outside its quoted parts an intent has no bracket, so the last bracketed group of the line is always the action.
      expect(s.intent.replace(/"[^"]*"/g, '')).not.toMatch(/[()]/);
      expect(describeStep(s).startsWith(`${s.intent} (`)).toBe(true);
    }
  });

  it('a draft that does not parse is a report error and no draft', () => {
    const many = Array.from({ length: 201 }, (_, i) => click(`Item ${i}`));
    const r = importEvents([goto(LOGIN), ...many]);
    expect(r.drafts).toEqual([]);
    expect(r.report.steps).toBe(0);
    expect(r.report.items).toContainEqual(expect.objectContaining({ kind: 'error', what: 'erp-export', reason: expect.stringContaining('more than 200 steps') }));
  });

  it('nothing to build is IMPORT_EMPTY', () => {
    const r = importEvents([{ at: 'step 1', kind: 'enter', label: 'x' }]);
    expect(r.drafts).toEqual([]);
    expect(r.report.items).toContainEqual({ at: '', kind: 'error', what: 'erp-export', reason: IMPORT_EMPTY });
  });

  it('stripSecrets does not change the events it is given', () => {
    const events = signInEvents();
    const before = structuredClone(events);
    stripSecrets(events, OPTS, { source: 'chrome', steps: 0, items: [] });
    expect(events).toEqual(before);
  });
});

describe('import messages', () => {
  it('are verbatim', () => {
    expect(IMPORT_NEEDS_SITE_LOGIN).toBe('The recording signs in: attach an RPA Site Login so the import can sign in without the typed password.');
    expect(IMPORT_REFUSES_WRITES).toBe('Imported steps that submit a form or post to download cannot be adopted: repair and import never write.');
    expect(IMPORT_NOT_ADOPTABLE).toBe('These steps read no rows and download no file, so there is nothing to prove: the draft is returned for review but cannot be signed.');
    expect(IMPORT_UNSUPPORTED_TARGET).toBe('Only JavaScript or TypeScript Playwright code can be imported; record with --target javascript.');
    expect(IMPORT_EMPTY).toBe('Nothing in this file could be turned into steps.');
  });
});
