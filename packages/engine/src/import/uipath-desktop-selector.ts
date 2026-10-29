// UiPath desktop selectors: `<wnd app='erpdemo.exe' title='…' />` names the top-level window, and the elements after
// it name the target inside it. `<uia>` tags are UI Automation properties already, so they map straight onto the
// desktop step format's conditions (`Cond`); `<ctrl>` tags are Active Accessibility (MSAA) properties, mapped as far as
// they go, with a report issue when something is lost. SAP GUI, Java, image and remote-desktop (Citrix, RDP) targets
// are not UI Automation and are never translated.
import type { UiaCond, WindowSel } from '../types.js';
import { parseXml, type XmlNode } from './xml.js';

/**
 * UiPath `<uia role='…'>` values (UI Automation's English localized control type names, which UiPath writes in lower
 * case) to UI Automation control type names, as the desktop step format writes them. Lookups ignore case, spaces,
 * hyphens and underscores, so `ComboBox` and `combo box` are the same role.
 */
export const UIA_ROLE_TO_CONTROL_TYPE: Readonly<Record<string, string>> = {
  'app bar': 'AppBar',
  button: 'Button',
  calendar: 'Calendar',
  'check box': 'CheckBox',
  'combo box': 'ComboBox',
  custom: 'Custom',
  'data grid': 'DataGrid',
  'data item': 'DataItem',
  // A window that is a dialog: Windows reports its localized type as "dialog", its control type is Window.
  dialog: 'Window',
  document: 'Document',
  edit: 'Edit',
  group: 'Group',
  header: 'Header',
  'header item': 'HeaderItem',
  hyperlink: 'Hyperlink',
  link: 'Hyperlink',
  image: 'Image',
  list: 'List',
  'list item': 'ListItem',
  menu: 'Menu',
  'menu bar': 'MenuBar',
  'menu item': 'MenuItem',
  pane: 'Pane',
  'progress bar': 'ProgressBar',
  'radio button': 'RadioButton',
  'scroll bar': 'ScrollBar',
  'semantic zoom': 'SemanticZoom',
  separator: 'Separator',
  slider: 'Slider',
  spinner: 'Spinner',
  'split button': 'SplitButton',
  'status bar': 'StatusBar',
  tab: 'Tab',
  'tab item': 'TabItem',
  table: 'Table',
  text: 'Text',
  thumb: 'Thumb',
  'title bar': 'TitleBar',
  'tool bar': 'ToolBar',
  toolbar: 'ToolBar',
  'tool tip': 'ToolTip',
  tooltip: 'ToolTip',
  tree: 'Tree',
  'tree item': 'TreeItem',
  window: 'Window',
};

/**
 * UiPath `<ctrl role='…'>` values (Active Accessibility role names) to UI Automation control types. `exact: false`
 * marks a role UI Automation splits differently (a table cell, a client area): the step uses the nearest control type
 * and the report says to check it.
 */
export const CTRL_ROLE_TO_CONTROL_TYPE: Readonly<Record<string, { controlType: string; exact: boolean }>> = {
  'push button': { controlType: 'Button', exact: true },
  button: { controlType: 'Button', exact: true },
  'editable text': { controlType: 'Edit', exact: true },
  'combo box': { controlType: 'ComboBox', exact: true },
  'drop down': { controlType: 'ComboBox', exact: false },
  list: { controlType: 'List', exact: true },
  'list item': { controlType: 'ListItem', exact: true },
  'menu bar': { controlType: 'MenuBar', exact: true },
  'menu item': { controlType: 'MenuItem', exact: true },
  'popup menu': { controlType: 'Menu', exact: true },
  'page tab': { controlType: 'TabItem', exact: true },
  'page tab list': { controlType: 'Tab', exact: true },
  'check box': { controlType: 'CheckBox', exact: true },
  'radio button': { controlType: 'RadioButton', exact: true },
  text: { controlType: 'Text', exact: true },
  'static text': { controlType: 'Text', exact: true },
  table: { controlType: 'Table', exact: true },
  cell: { controlType: 'DataItem', exact: false },
  row: { controlType: 'DataItem', exact: false },
  'column header': { controlType: 'HeaderItem', exact: true },
  outline: { controlType: 'Tree', exact: true },
  'outline item': { controlType: 'TreeItem', exact: true },
  link: { controlType: 'Hyperlink', exact: true },
  'tool bar': { controlType: 'ToolBar', exact: true },
  'status bar': { controlType: 'StatusBar', exact: true },
  'progress bar': { controlType: 'ProgressBar', exact: true },
  slider: { controlType: 'Slider', exact: true },
  'spin button': { controlType: 'Spinner', exact: true },
  'scroll bar': { controlType: 'ScrollBar', exact: true },
  'split button': { controlType: 'SplitButton', exact: true },
  graphic: { controlType: 'Image', exact: true },
  grouping: { controlType: 'Group', exact: false },
  client: { controlType: 'Pane', exact: false },
  pane: { controlType: 'Pane', exact: true },
  window: { controlType: 'Window', exact: false },
  dialog: { controlType: 'Window', exact: false },
  document: { controlType: 'Document', exact: true },
};

/** A role as a lookup key: lower case, without spaces, hyphens and underscores (`ComboBox`, `combo box`, `combo-box`). */
const roleKey = (role: string): string => role.toLowerCase().replace(/[\s_-]+/g, '');
const UIA_ROLES = new Map(Object.entries(UIA_ROLE_TO_CONTROL_TYPE).map(([k, v]) => [roleKey(k), v]));
const CTRL_ROLES = new Map(Object.entries(CTRL_ROLE_TO_CONTROL_TYPE).map(([k, v]) => [roleKey(k), v]));

/** The UI Automation control type of a UiPath `<uia role>`, or undefined when the role is unknown. */
export function uiaControlType(role: string): string | undefined {
  return UIA_ROLES.get(roleKey(role));
}
/** The nearest UI Automation control type of a UiPath `<ctrl role>` (Active Accessibility), or undefined when unknown. */
export function ctrlControlType(role: string): { controlType: string; exact: boolean } | undefined {
  return CTRL_ROLES.get(roleKey(role));
}

/** Executables of remote-desktop clients: their windows show pictures of another machine, which UI Automation cannot read. */
const REMOTE_CLIENTS = /^(wfica32|wfica|cdviewer|mstsc|vmware-view|vmconnect|msrdc)\.exe$/i;
/** SAP GUI for Windows: its own scripting adapter will drive it, never UI Automation. */
const SAP_APPS = /^(saplogon|sapgui|saplgpad|sapfront)\.exe$/i;

export type DesktopSelectorRead =
  /** A UI Automation target: the window it names (absent in a partial selector inside a window scope) and its path. */
  | { kind: 'uia'; window?: WindowSel; path: UiaCond[]; issues: string[]; hints: string[] }
  /** Only a window (a scope's selector, or a target that is the window itself). */
  | { kind: 'window'; window: WindowSel; issues: string[]; hints: string[] }
  /** SAP GUI for Windows: the existing SAP report branch handles it. */
  | { kind: 'sap' }
  /** Not translatable to UI Automation (Java, remote desktop, an unreadable selector): `reason` says why, for the report. */
  | { kind: 'untranslated'; reason: string; hints: string[] }
  /** Not a desktop selector at all (a web selector, or empty). */
  | { kind: 'none' };

const MAX_SELECTOR = 64 * 1024;
const DESKTOP_TAGS = new Set(['wnd', 'ctrl', 'uia', 'java', 'jav', 'sapjava', 'sap', 'acc']);
/** A desktop element's opening text anywhere in a selector. */
const DESKTOP_TAG_TEXT = /<\s*(wnd|ctrl|uia|java|jav|sapjava|sap|acc)[\s/>]/i;

const hasWildcard = (v: string): boolean => v.includes('*') || v.includes('?');
/** A UiPath wildcard value (`*` any run, `?` one character) as an anchored regular expression. */
export function wildcardPattern(v: string): string {
  let out = '^';
  for (const c of v) out += c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `${out}$`;
}

/**
 * An attribute value usable as an exact UI Automation property: not a UiPath variable, not a wildcard and not regex
 * or fuzzy matched. Anything else is left out of the condition, with an issue naming what was lost.
 */
function exact(el: XmlNode, key: string, what: string, issues: string[]): string | undefined {
  const v = el.attrs[key];
  if (v === undefined || v === '') return undefined;
  if (v.includes('{{')) {
    issues.push(`the ${what} is a UiPath variable (${v.slice(0, 80)}), which is not imported: the step matches without it`);
    return undefined;
  }
  const matching = (el.attrs[`matching:${key}`] ?? '').toLowerCase();
  if (matching === 'regex' || matching === 'fuzzy') {
    issues.push(`the ${what} is matched by ${matching === 'regex' ? 'a regular expression' : 'fuzzy matching'}, which UI Automation conditions cannot express: the step matches without it`);
    return undefined;
  }
  if (hasWildcard(v)) {
    issues.push(`the ${what} uses a wildcard (${v.slice(0, 80)}), which UI Automation conditions cannot express: the step matches without it`);
    return undefined;
  }
  return v;
}

/** The top-level window a `<wnd>` names: exe from `app`, title (a wildcard title becomes a pattern), class name. */
function readWindow(el: XmlNode, issues: string[]): WindowSel {
  const win: WindowSel = {};
  const app = el.attrs.app;
  if (app && !app.includes('{{') && !hasWildcard(app)) win.exe = app;
  else if (app) issues.push(`the window's application (${app.slice(0, 80)}) is a variable or a wildcard: the step matches any window of the app it launches`);
  const title = el.attrs.title;
  if (title && !title.includes('{{')) {
    const matching = (el.attrs['matching:title'] ?? '').toLowerCase();
    if (matching === 'regex') win.titlePattern = title;
    else if (hasWildcard(title)) win.titlePattern = wildcardPattern(title);
    else win.title = title;
  } else if (title) issues.push(`the window title is a UiPath variable (${title.slice(0, 80)}), which is not imported: the step matches without it`);
  const cls = exact(el, 'cls', 'window class', issues);
  if (cls) win.className = cls;
  return win;
}

/**
 * Reads a desktop selector (already decoded once from its XAML attribute). The first `<wnd>` with an `app` (or the
 * first element, when it is a `<wnd>`) is the window; every later `<wnd>`, `<uia>` and `<ctrl>` adds one condition to
 * the path, in order (each searched among the descendants of the previous match):
 * - `<uia>`: automationid → automationId, cls → className, name → name, role → controlType (UIA_ROLE_TO_CONTROL_TYPE);
 * - `<ctrl>`: name → name, role → controlType (CTRL_ROLE_TO_CONTROL_TYPE, an approximate role reported), ctrlname or
 *   ctrlid → automationId (WinForms names and Win32 control ids are what UI Automation reports as automation ids), and
 *   an issue for what has no UI Automation equivalent;
 * - a child `<wnd>`: ctrlname or ctrlid → automationId, cls → className, aaname → name.
 * `idx` is never imported (UiPath counts matches across the whole window, the step format counts siblings) and is
 * reported, as are wildcards, regex and fuzzy matching, and variables. Never throws; linear in the selector.
 */
export function readDesktopSelector(selector: string): DesktopSelectorRead {
  // Most selectors are web selectors: a cheap text check skips parsing them (and an unreadable web selector stays theirs).
  if (!selector.trim() || !DESKTOP_TAG_TEXT.test(selector)) return { kind: 'none' };
  if (selector.length > MAX_SELECTOR) return { kind: 'untranslated', reason: 'the selector is longer than 64 KiB, so it was not read', hints: [] };
  const doc = parseXml(`<s>${selector}</s>`, { maxDepth: 4, maxElements: 1_000 });
  if ('error' in doc) return { kind: 'untranslated', reason: `the selector cannot be read (${doc.error}): rebuild this step`, hints: [] };
  const els = doc.children;
  const names = els.map((e) => e.name.toLowerCase());
  if (!names.some((n) => DESKTOP_TAGS.has(n))) return { kind: 'none' };
  const hints: string[] = [];
  for (const e of els) for (const k of ['name', 'aaname', 'automationid', 'ctrlname', 'title']) if (e.attrs[k]) hints.push(e.attrs[k]);
  const firstWnd = els.find((e) => e.name.toLowerCase() === 'wnd');
  const app = firstWnd?.attrs.app ?? '';
  if (names.includes('sap') || SAP_APPS.test(app) || (firstWnd?.attrs.cls ?? '').startsWith('SAP_FRONTEND')) return { kind: 'sap' };
  if (names.some((n) => n === 'java' || n === 'jav' || n === 'sapjava')) {
    return { kind: 'untranslated', reason: 'the target is a Java element (<java>), which UI Automation cannot drive: the desktop runner drives UI Automation apps only, so rebuild this step by hand', hints };
  }
  if (REMOTE_CLIENTS.test(app)) {
    return { kind: 'untranslated', reason: `the target is inside a remote desktop window (${app.slice(0, 80)}, such as Citrix or Remote Desktop), which shows only a picture of another machine: run the desktop runner on that machine instead`, hints };
  }
  if (names.includes('webctrl') || names.includes('html')) {
    return { kind: 'untranslated', reason: 'the selector mixes a desktop window and a web page: rebuild this step as a browser step or a desktop step', hints };
  }

  const issues: string[] = [];
  let window: WindowSel | undefined;
  const path: UiaCond[] = [];
  els.forEach((e, i) => {
    const tag = e.name.toLowerCase();
    if (tag === 'wnd' && window === undefined && (i === 0 || e.attrs.app !== undefined)) {
      window = readWindow(e, issues);
      if (e.attrs.idx !== undefined) issues.push('the window is picked by position (idx), which is not imported');
      return;
    }
    const cond: UiaCond = {};
    if (tag === 'uia') {
      const automationId = exact(e, 'automationid', 'automation id', issues);
      const cls = exact(e, 'cls', 'class name', issues);
      const name = exact(e, 'name', 'name', issues);
      const role = e.attrs.role;
      if (role) {
        const controlType = uiaControlType(role);
        if (controlType) cond.controlType = controlType;
        else issues.push(`the role '${role.slice(0, 40)}' is not a UI Automation control type the import knows: the step matches without it`);
      }
      if (automationId) cond.automationId = automationId;
      if (name) cond.name = name;
      if (cls) cond.className = cls;
    } else if (tag === 'ctrl' || tag === 'acc') {
      const name = exact(e, 'name', 'name', issues);
      const automationId = exact(e, 'ctrlname', 'control name', issues) ?? exact(e, 'automationid', 'automation id', issues) ?? exact(e, 'ctrlid', 'control id', issues);
      const role = e.attrs.role;
      if (role) {
        const mapped = ctrlControlType(role);
        if (!mapped) issues.push(`the Active Accessibility role '${role.slice(0, 40)}' (<${tag}>) has no UI Automation control type: the step matches without it`);
        else {
          cond.controlType = mapped.controlType;
          if (!mapped.exact) issues.push(`the Active Accessibility role '${role.slice(0, 40)}' (<${tag}>) became the UI Automation control type ${mapped.controlType}, the nearest one: check the step against the app`);
        }
      }
      for (const k of ['text', 'ctrlclass', 'cls', 'aastate', 'helptext']) {
        if (e.attrs[k]) issues.push(`the <${tag}> attribute ${k} has no UI Automation equivalent in the step format: the step matches without it`);
      }
      if (automationId) cond.automationId = automationId;
      if (name) cond.name = name;
    } else if (tag === 'wnd') {
      const automationId = exact(e, 'ctrlname', 'control name', issues) ?? exact(e, 'ctrlid', 'control id', issues);
      const cls = exact(e, 'cls', 'class name', issues);
      const name = exact(e, 'aaname', 'name', issues);
      if (automationId) cond.automationId = automationId;
      if (name) cond.name = name;
      if (cls) cond.className = cls;
    } else {
      issues.push(`the selector element <${tag.slice(0, 20)}> is not one the import knows: it was left out`);
      return;
    }
    if (e.attrs.idx !== undefined) issues.push(`the element is picked by position (idx='${e.attrs.idx.slice(0, 10)}'), which is not imported: the step matches without it`);
    if (Object.keys(cond).length) path.push(cond);
    else issues.push(`a <${tag}> element in the selector has nothing UI Automation can match: it was left out`);
  });
  if (path.length === 0) {
    if (window && Object.keys(window).length) return { kind: 'window', window, issues, hints };
    return { kind: 'untranslated', reason: issues[0] ?? 'the selector names nothing UI Automation can find', hints };
  }
  if (path.length > 20) return { kind: 'untranslated', reason: 'the selector is more than 20 elements deep', hints };
  return { kind: 'uia', ...(window && Object.keys(window).length ? { window } : {}), path, issues, hints };
}
