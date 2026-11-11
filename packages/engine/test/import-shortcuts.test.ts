import { describe, expect, it } from 'vitest';
import { PRESS_PASSWORD_REFUSED } from '../src/messages.js';
import { importSource } from '../src/import/index.js';
import type { ImportItem, ImportOptions, ImportResult } from '../src/import/types.js';
import { parseDesktopScript, parseScript } from '../src/steps/parse.js';
import type { DesktopStep, Step } from '../src/types.js';
import { SECRETS } from './helpers.js';

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const xaml = (body: string) => `<Activity x:Class="Main" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uix="http://schemas.uipath.com/workflow/activities/uix" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
<Sequence DisplayName="Main sequence">${body}</Sequence></Activity>`;
const card = (body: string) =>
  `<uix:NApplicationCard DisplayName="Use Browser Chrome: Portal"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">${body}</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp BrowserType="Chrome" Url="https://portal.example.com/app" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
const app = (body: string) =>
  `<uix:NApplicationCard DisplayName="Use Application: Ledger Demo"><uix:NApplicationCard.Body><ActivityAction x:TypeArguments="x:Object"><Sequence DisplayName="Do">${body}</Sequence></ActivityAction></uix:NApplicationCard.Body><uix:NApplicationCard.TargetApp><uix:TargetApp FilePath="LedgerDemo.exe" Selector="&lt;wnd app='ledgerdemo.exe' title='Ledger Demo' /&gt;" /></uix:NApplicationCard.TargetApp></uix:NApplicationCard>`;
const target = (selector: string) => `<ui:SendHotkey.Target><ui:Target Selector="${esc(selector)}" /></ui:SendHotkey.Target>`;
const hotkey = (name: string, key: string, modifiers = 'None', selector?: string) =>
  `<ui:SendHotkey DisplayName="Send Hotkey '${name}'" Key="${key}" KeyModifiers="${modifiers}">${selector ? target(selector) : ''}</ui:SendHotkey>`;
/** Studio writes the value as a VB string literal; `raw` writes it bare, as a hand-edited file might. */
const shortcuts = (name: string, keys: string, selector?: string, raw = false) =>
  `<uix:NKeyboardShortcuts DisplayName="Keyboard Shortcuts '${name}'" Shortcuts="${esc(raw ? keys : `["${keys}"]`)}">${selector ? `<uix:NKeyboardShortcuts.Target><uix:TargetAnchorable FullSelectorArgument="${esc(selector)}" /></uix:NKeyboardShortcuts.Target>` : ''}</uix:NKeyboardShortcuts>`;
const click = (name: string, selector: string) => `<uix:NClick DisplayName="Click '${name}'"><uix:NClick.Target><uix:TargetAnchorable FullSelectorArgument="${esc(selector)}" /></uix:NClick.Target></uix:NClick>`;

const OPTS: ImportOptions = { name: 'keys', hasSiteLogin: false };
const steps = (r: ImportResult): Step[] => r.drafts.flatMap((d) => d.script.steps);
const desktopSteps = (r: ImportResult): DesktopStep[] => (r.desktopDrafts ?? []).flatMap((d) => d.script.steps);
const untranslated = (r: ImportResult) => r.report.items.filter((i: ImportItem) => i.kind === 'untranslated').map((i) => [i.what, i.reason]);
const FIELD = "<webctrl tag='INPUT' aaname='Amount' />";
const NOT_A_PRESS = 'a press step\'s key must be a key browser steps can press: Enter, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, PageUp, PageDown, Home, End or F1 to F12, alone or after Ctrl, Alt and Shift in that order (Shift+Tab, Ctrl+Enter), or Ctrl+A; never a key that types a character';

describe('UiPath keyboard shortcuts in a browser become press steps', () => {
  it('Send Hotkey and Keyboard Shortcuts give one press per chord, on the activity\'s target or the focused element', () => {
    const r = importSource('uipath', xaml(card([
      hotkey('Tab', 'tab'),
      hotkey('Shift+Tab', 'tab', 'Shift', FIELD),
      hotkey('F5', 'f5'),
      hotkey('Select all', 'a', 'Ctrl', FIELD),
      hotkey('Ctrl+Enter', 'enter', 'Ctrl'),
      shortcuts('Two tabs', '[d(hk)][k(tab)][k(tab)][u(hk)]'),
      shortcuts('Down', '[d(hk)][k(down)][u(hk)]', FIELD, true),
    ].join(''))), OPTS);
    expect(r.report.items.filter((i) => i.kind === 'error' || i.kind === 'untranslated')).toEqual([]);
    const script = r.drafts[0].script;
    expect(parseScript(script)).toEqual(script);
    const amount = { label: 'Amount', exact: true };
    expect(script.steps.slice(1)).toEqual([
      { intent: 'Press Tab', press: { key: 'Tab' } },
      { intent: 'Press Shift+Tab in Amount', press: { key: 'Shift+Tab', target: amount } },
      { intent: 'Press F5', press: { key: 'F5' } },
      { intent: 'Press Ctrl+A in Amount', press: { key: 'Ctrl+A', target: amount } },
      { intent: 'Press Ctrl+Enter', press: { key: 'Ctrl+Enter' } },
      { intent: 'Press Tab', press: { key: 'Tab' } },
      { intent: 'Press Tab', press: { key: 'Tab' } },
      { intent: 'Press Down in Amount', press: { key: 'Down', target: amount } },
    ]);
  });

  it('a chord the press step refuses is not translated, with the step\'s own reason; Enter keeps doing what it did', () => {
    const r = importSource('uipath', xaml(card([
      hotkey('Save', 's', 'Ctrl'),
      hotkey('Start menu', 'r', 'Win'),
      shortcuts('Copy', '[d(hk)][d(ctrl)]c[u(ctrl)][u(hk)]'),
      shortcuts('Typed', '[d(hk)]abc[u(hk)]'),
      hotkey('Enter', 'enter'),
    ].join(''))), OPTS);
    expect(untranslated(r)).toEqual([
      ["Send Hotkey 'Save'", `SendHotkey: ${NOT_A_PRESS}`],
      ["Send Hotkey 'Start menu'", 'SendHotkey: a Windows-key shortcut drives the Windows shell, not the app: desktop steps never send one'],
      ["Keyboard Shortcuts 'Copy'", `NKeyboardShortcuts: ${NOT_A_PRESS}`],
      ["Keyboard Shortcuts 'Typed'", 'NKeyboardShortcuts: it types text, which a Type Into does: only key chords become steps'],
      // Enter is the event it always was: a sign-in's submit, otherwise not a step (a click on the button it presses is).
      ["Press Enter in Send Hotkey 'Enter'", 'pressing Enter is not a step: add a click on the button it presses'],
    ]);
    // Each one is a gap in the flow, as any other untranslated browser activity is: no press step.
    expect(steps(r).every((s) => 'goto' in s)).toBe(true);
  });

  it('a press on a password field is refused with the step\'s own reason, and Enter after a password still submits the sign-in', () => {
    const pw = "<webctrl tag='INPUT' type='password' aaname='Password' />";
    const refused = importSource('uipath', xaml(card(hotkey('Tab', 'tab', 'None', pw))), OPTS);
    expect(untranslated(refused)).toEqual([['Press Tab in Password', PRESS_PASSWORD_REFUSED]]);
    const typeInto = (name: string, selector: string, text: string) => `<uix:NTypeInto DisplayName="Type Into '${name}'" Text="${esc(text)}"><uix:NTypeInto.Target><uix:TargetAnchorable FullSelectorArgument="${esc(selector)}" /></uix:NTypeInto.Target></uix:NTypeInto>`;
    const signIn = importSource('uipath', xaml(card([
      typeInto('User', "<webctrl tag='INPUT' aaname='User' />", SECRETS.username),
      hotkey('Tab', 'tab'),
      typeInto('Password', pw, SECRETS.password),
      hotkey('Enter', 'enter'),
      click('Reports', "<webctrl tag='A' aaname='Reports' />"),
    ].join(''))), { name: 's', hasSiteLogin: true, secrets: SECRETS });
    // The Tab between the fields is part of the sign-in, which moves between its fields itself.
    expect(steps(signIn).map((s) => s.intent)).toEqual(['Open portal.example.com/app', 'Sign in', 'Click Reports']);
    expect(signIn.report.items).toContainEqual(expect.objectContaining({ kind: 'dropped', what: 'Press Tab', notNeeded: true }));
    for (const v of [SECRETS.username, SECRETS.password]) expect(JSON.stringify(signIn)).not.toContain(v);
  });
});

describe('UiPath keyboard shortcuts in a desktop app become key steps', () => {
  it('Keyboard Shortcuts give one key step per chord; Send Hotkey is as before', () => {
    const field = "<uia automationid='txtAmount' name='Amount' role='edit' />";
    const r = importSource('uipath', xaml(app([
      shortcuts('Save', '[d(hk)][d(ctrl)][k(s)][u(ctrl)][u(hk)]'),
      shortcuts('Next fields', '[d(hk)][k(tab)][d(shift)][k(tab)][u(shift)][u(hk)]', field),
      hotkey('Post', 'p', 'Alt'),
      shortcuts('Typed', '[d(hk)]abc[u(hk)]'),
    ].join(''))), OPTS);
    const script = r.desktopDrafts![0].script;
    expect(parseDesktopScript(script)).toEqual(script);
    expect(desktopSteps(r).map((s) => ('key' in s ? [s.key.key, s.key.target !== undefined] : s.intent))).toEqual([
      ['Ctrl+S', false], 'Wait for the window Ledger Demo', ['Tab', true], ['Shift+Tab', true], ['Alt+P', false],
    ]);
    expect(untranslated(r)).toEqual([["Keyboard Shortcuts 'Typed'", 'NKeyboardShortcuts: it types text, which a Type Into does: only key chords become steps']]);
  });
});

describe('Playwright press becomes a press step', () => {
  const code = (lines: string[]) => `import { test } from '@playwright/test';\n\ntest('t', async ({ page }) => {\n  await page.goto('https://portal.example.com/');\n${lines.map((l) => `  ${l}`).join('\n')}\n});\n`;

  it('a locator\'s press, page.press and keyboard.press, in the press step\'s spelling', () => {
    const r = importSource('playwright', code([
      "await page.getByLabel('Amount').press('Tab');",
      "await page.getByLabel('Amount').press('Shift+Tab');",
      "await page.getByRole('grid').press('ArrowDown');",
      "await page.getByLabel('Notes').press('Control+a');",
      "await page.press('#q', 'ControlOrMeta+Enter');",
      "await page.keyboard.press('Escape');",
      "await page.keyboard.press('Shift+Control+End');",
    ]), { name: 'pw', hasSiteLogin: false });
    expect(r.report.items.filter((i) => i.kind === 'untranslated' || i.kind === 'error')).toEqual([]);
    expect(steps(r).slice(1)).toEqual([
      { intent: 'Press Tab in Amount', press: { key: 'Tab', target: { label: 'Amount' } } },
      { intent: 'Press Shift+Tab in Amount', press: { key: 'Shift+Tab', target: { label: 'Amount' } } },
      { intent: 'Press Down', press: { key: 'Down', target: { role: 'grid' } } },
      { intent: 'Press Ctrl+A in Notes', press: { key: 'Ctrl+A', target: { label: 'Notes' } } },
      { intent: 'Press Ctrl+Enter', press: { key: 'Ctrl+Enter', target: { css: '#q' } } },
      { intent: 'Press Escape', press: { key: 'Escape' } },
      { intent: 'Press Ctrl+Shift+End', press: { key: 'Ctrl+Shift+End' } },
    ]);
  });

  it('a key the press step refuses is not translated, never spelled out; Enter is as before', () => {
    const r = importSource('playwright', code([
      "await page.getByLabel('Search').press('demo-password');",
      "await page.getByLabel('Search').press('a');",
      "await page.getByLabel('Search').press('Meta+A');",
      "await page.getByLabel('Search').press('Space');",
      "await page.getByLabel('Search').press('Tab', { delay: 50 });",
      "await page.getByLabel('Search').press('Enter');",
    ]), { name: 'pw', hasSiteLogin: false });
    expect(untranslated(r)).toEqual([
      ['Press a key', NOT_A_PRESS],
      ['Press a key', NOT_A_PRESS],
      ['Press a key', NOT_A_PRESS],
      ['Press Space', NOT_A_PRESS],
      ['Press Tab', 'press options are not imported: the steps click, type or choose with defaults'],
      ['Press Enter in Search', 'pressing Enter is not a step: add a click on the button it presses'],
    ]);
    expect(JSON.stringify(r)).not.toContain('demo-password');
  });

  it('a Tab between the username and the password stays inside the one sign-in step', () => {
    const r = importSource('playwright', code([
      `await page.getByLabel('User').fill('${SECRETS.username}');`,
      "await page.getByLabel('User').press('Tab');",
      `await page.getByLabel('Password').fill('${SECRETS.password}');`,
      "await page.getByRole('button', { name: 'Sign in' }).click();",
      "await page.getByRole('link', { name: 'Reports' }).click();",
    ]), { name: 'pw', hasSiteLogin: true, secrets: SECRETS });
    expect(steps(r).map((s) => s.intent)).toEqual(['Open portal.example.com', 'Sign in', 'Click Reports']);
    for (const v of [SECRETS.username, SECRETS.password]) expect(JSON.stringify(r)).not.toContain(v);
    // Without a Site Login the values are never imported either.
    const bare = importSource('playwright', code([
      "await page.getByLabel('User').fill('ops-user-7');",
      "await page.getByLabel('User').press('Tab');",
      "await page.getByLabel('Password').fill('Geheim-1-x7!');",
      "await page.getByRole('button', { name: 'Sign in' }).click();",
    ]), { name: 'pw', hasSiteLogin: false });
    for (const v of ['ops-user-7', 'Geheim-1-x7!']) expect(JSON.stringify(bare)).not.toContain(v);
  });
});
