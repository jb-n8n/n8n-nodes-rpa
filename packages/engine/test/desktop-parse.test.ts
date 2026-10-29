import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkDesktopTrust } from '../src/desktop/task.js';
import { checkTrust } from '../src/lane/trust.js';
import { BROWSER_STEPS_NEED_BROWSER, DESKTOP_STEPS_NEED_RUNNER, DESKTOP_UNSIGNED_WRITES, UNSIGNED_REQUIRED } from '../src/messages.js';
import { desktopBinding, scriptHash, signScript, startHostOf, verifyScript } from '../src/sign.js';
import { isDesktopDocument, parseDesktopScript, parseScript, ScriptShapeError } from '../src/steps/parse.js';
import type { PortalPolicy } from '../src/types.js';

const uia = (automationId: string, controlType = 'Edit') => ({ uia: { path: [{ controlType, automationId }] } });
const desktop = (steps: unknown[], more: Record<string, unknown> = {}) => ({
  surface: 'desktop', name: 'erp-orders', version: 1, app: { exe: 'ErpDemo.exe' }, steps, ...more,
});
const issuesOf = (f: () => unknown): string[] => {
  try {
    f();
  } catch (err) {
    if (err instanceof ScriptShapeError) return err.issues;
    throw err;
  }
  return [];
};
const desktopIssues = (doc: unknown) => issuesOf(() => parseDesktopScript(doc));
const browserIssues = (doc: unknown) => issuesOf(() => parseScript(doc));

describe('desktop step sets: parsing', () => {
  it('accepts the desktop verbs with { uia } locators and returns a clone', () => {
    const doc = desktop([
      { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
      { intent: 'Sign in', click: { uia: { window: { exe: 'ErpDemo.exe', title: 'ERP Demo - Sign in' }, path: [{ controlType: 'Button', name: 'Sign in' }] }, fallbacks: [uia('btnSignIn', 'Button')] } },
      { intent: 'Pick a status', select: { field: uia('cmbStatus', 'ComboBox'), option: 'Open' } },
      { intent: 'Open orders only', check: { field: uia('chkOpenOnly', 'CheckBox'), checked: true }, optional: true },
      { intent: 'Search', key: { key: 'Enter', target: uia('txtSearch') }, when: { visible: uia('txtSearch') } },
      { intent: 'Wait for results', waitFor: { target: uia('gridResults', 'DataGrid'), state: 'visible' }, timeoutMs: 5000 },
      { intent: 'Read the count', read: { target: uia('lblCount', 'Text'), as: 'count' }, expect: { visible: uia('gridResults', 'DataGrid') } },
      { intent: 'Save as', fill: { field: uia('1001'), value: '{{$exportDir}}\\orders.csv' } },
      { intent: 'Post', click: uia('btnPost', 'Button'), write: true },
      { intent: 'Save shortcut', key: { key: 'Ctrl+S' }, write: true },
      { intent: 'Get the CSV', expectFile: { pattern: '^orders\\.csv$', check: { columns: ['Order'], minRows: 1 } } },
    ]);
    const parsed = parseDesktopScript(doc);
    expect(parsed).toEqual(doc);
    expect(parsed).not.toBe(doc);
    expect(isDesktopDocument(doc)).toBe(true);
    expect(isDesktopDocument({ steps: [] })).toBe(false);
  });

  it('needs surface "desktop" and an app; refuses startUrl, unknown keys and interrupts', () => {
    expect(desktopIssues({ name: 'x', steps: [] })).toEqual([BROWSER_STEPS_NEED_BROWSER]);
    expect(desktopIssues({ surface: 'mainframe', steps: [] })).toEqual(['surface must be "browser" or "desktop"']);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { app: undefined }))).toContain('app must be an object with exe');
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { app: { exe: 'a\nb.exe' } }))[0]).toMatch(/^app\.exe must be/);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { app: { exe: '{{var.app}}' } }))[0]).toMatch(/^app\.exe must be/);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { app: { exe: 'a.exe', args: ['{{var.x}}'] } }))[0]).toMatch(/^app\.args/);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { startUrl: 'https://example.com/' }))).toEqual([
      'script has unknown key "startUrl"', 'startUrl is a browser setting, not allowed in a desktop step set: set app instead',
    ]);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { interrupts: [{ target: uia('a'), click: uia('b') }] }))).toEqual(['interrupts are not supported in a desktop step set yet']);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a') }], { interrupts: [] }))).toEqual([]);
    expect(desktopIssues(desktop([]))).toEqual(['steps must be a non-empty array']);
  });

  it('refuses every browser-only verb in a desktop step set', () => {
    for (const verb of ['goto', 'signIn', 'submit', 'download', 'popup', 'pdf', 'screenshot', 'extractTable', 'paginate', 'clickAll', 'detect', 'extract']) {
      expect(desktopIssues(desktop([{ intent: 'x', [verb]: {} }])), verb).toEqual([`steps[0]: "${verb}" is a browser step, not allowed in a desktop step set`]);
    }
  });

  it('refuses browser locators in every locator slot of a desktop step set', () => {
    for (const kind of ['role', 'label', 'text', 'testId', 'css']) {
      const loc = { [kind]: 'Sign in' };
      expect(desktopIssues(desktop([{ intent: 'x', click: loc }])), kind).toEqual([`steps[0].click uses the browser locator "${kind}": desktop step sets find elements with { uia }`]);
      expect(desktopIssues(desktop([{ intent: 'x', fill: { field: loc, value: 'v' } }]))[0]).toMatch(/^steps\[0\]\.fill\.field uses the browser locator/);
      expect(desktopIssues(desktop([{ intent: 'x', click: uia('a'), when: { visible: loc } }]))[0]).toMatch(/^steps\[0\]\.when\.visible uses the browser locator/);
      expect(desktopIssues(desktop([{ intent: 'x', click: uia('a'), expect: { visible: loc } }]))[0]).toMatch(/^steps\[0\]\.expect\.visible uses the browser locator/);
      expect(desktopIssues(desktop([{ intent: 'x', click: { ...uia('a'), fallbacks: [loc] } }]))[0]).toMatch(/^steps\[0\]\.click\.fallbacks\[0\] uses the browser locator/);
    }
  });

  it('refuses expect.url and expect.heading in a desktop step set', () => {
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a'), expect: { url: '/orders' } }]))).toEqual(['steps[0].expect.url is a browser check, not allowed in a desktop step set']);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a'), expect: { heading: 'Orders' } }]))).toEqual(['steps[0].expect.heading is a browser check, not allowed in a desktop step set']);
  });

  it('checks uia targets, write flags, key chords and read names', () => {
    expect(desktopIssues(desktop([{ intent: 'x', click: { uia: { path: [] } } }]))).toEqual(['steps[0].click.uia.path must be an array of 1 to 20 conditions']);
    expect(desktopIssues(desktop([{ intent: 'x', click: { uia: { path: [{ index: 1 }] } } }]))).toEqual(['steps[0].click.uia.path[0] needs at least one of controlType, automationId, name, className']);
    expect(desktopIssues(desktop([{ intent: 'x', click: { uia: { path: [{ name: 'a' }], window: {} } } }]))).toEqual(['steps[0].click.uia.window needs at least one of exe, title, titlePattern, automationId, className']);
    expect(desktopIssues(desktop([{ intent: 'x', click: { uia: { path: [{ name: 'a' }], window: { titlePattern: '(' } } } }]))).toEqual(['steps[0].click.uia.window.titlePattern is not a valid regex']);
    expect(desktopIssues(desktop([{ intent: 'x', click: { ...uia('a'), fallbacks: [{ ...uia('b'), fallbacks: [] }] } }]))).toEqual(['steps[0].click.fallbacks[0] has nested fallbacks']);
    expect(desktopIssues(desktop([{ intent: 'x', read: { target: uia('a'), as: 'count' }, write: true }]))).toEqual(['steps[0].write is only allowed on click, fill, select, check and key steps']);
    expect(desktopIssues(desktop([{ intent: 'x', key: { key: 'Ctrl+Alt+Delete+X' } }]))).toEqual(['steps[0].key.key must be a key chord such as Enter, Tab, Ctrl+S or F5 (modifiers in the order Ctrl, Alt, Shift; letters uppercase)']);
    expect(desktopIssues(desktop([{ intent: 'x', read: { target: uia('a'), as: 'not a name' } }]))[0]).toMatch(/^steps\[0\]\.read\.as must be a name/);
    expect(desktopIssues(desktop([{ intent: 'x', click: uia('a'), extra: 1 }]))).toEqual(['steps[0] has unknown key "extra"']);
    expect(desktopIssues(desktop([{ intent: 'x', select: { field: uia('a'), value: 'Open' } }]))).toEqual(['steps[0].select has unknown key "value"', 'steps[0].select.option must be a non-empty string']);
    expect(desktopIssues(desktop([{ intent: 'x', expectFile: { pattern: '(' } }]))).toEqual(['steps[0].expectFile.pattern is not a valid regex']);
  });

  it('key chords have one spelling (Ctrl, Alt, Shift in that order, uppercase letters, no Win); read names are unique; expectFile is capped', () => {
    for (const ok of ['Enter', 'Ctrl+S', 'Ctrl+Alt+Shift+F5', 'Alt+F4', 'Shift+Tab', 'Escape', '7']) expect(desktopIssues(desktop([{ intent: 'x', key: { key: ok } }])), ok).toEqual([]);
    for (const bad of ['Ctrl+s', 'Shift+Ctrl+S', 'Ctrl+Ctrl+S', 'Esc', 'ctrl+S', 'Enter ']) {
      const issues = desktopIssues(desktop([{ intent: 'x', key: { key: bad } }]));
      expect(issues, bad).toHaveLength(1);
      expect(issues[0], bad).toMatch(/^steps\[0\]\.key\.key must be a key chord/);
    }
    expect(desktopIssues(desktop([
      { intent: 'a', read: { target: uia('a'), as: 'total' } }, { intent: 'b', read: { target: uia('b'), as: 'total' } },
    ]))).toEqual(['steps[1].read.as "total" is already used by an earlier read step']);
    expect(desktopIssues(desktop([{ intent: 'x', expectFile: { pattern: 'a', maxBytes: 36 * 1024 * 1024 + 1 } }]))).toEqual([
      'steps[0].expectFile.maxBytes must be at most 37748736 (the most the desktop runner sends; its policy maxFileBytes, 20 MiB by default, is the effective limit)',
    ]);
    expect(desktopIssues(desktop([{ intent: 'x', expectFile: { pattern: 'a', maxBytes: 36 * 1024 * 1024 } }]))).toEqual([]);
  });

  it('refuses the chords the Windows shell takes at parse time, as the runner and the importer do', () => {
    for (const shell of ['Ctrl+Escape', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Escape', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+Escape', 'Ctrl+Alt+Tab']) {
      expect(desktopIssues(desktop([{ intent: 'x', key: { key: shell } }])), shell).toEqual([
        `steps[0].key.key is ${shell}, which drives the Windows shell, not the app: desktop steps never send it`,
      ]);
    }
    for (const win of ['Win+R', 'Win+Tab', 'Ctrl+Win+D', 'Meta+L']) {
      expect(desktopIssues(desktop([{ intent: 'x', key: { key: win } }])), win).toEqual([
        'steps[0].key.key is a Windows-key shortcut, which drives the Windows shell, not the app: desktop steps never send one',
      ]);
    }
    // Escape, Tab and Shift+Tab alone stay plain navigation keys.
    for (const ok of ['Escape', 'Tab', 'Shift+Tab', 'Ctrl+Tab', 'Shift+Escape']) expect(desktopIssues(desktop([{ intent: 'x', key: { key: ok } }])), ok).toEqual([]);
  });

  it('reads surface as an own property only, as the hash does', () => {
    const inherited = Object.assign(Object.create({ surface: 'desktop' }) as object, { startUrl: 'https://example.com/', steps: [{ intent: 'x', click: { role: 'button', name: 'Go' } }] });
    expect(isDesktopDocument(inherited)).toBe(false);
    expect(browserIssues(inherited)).toEqual([]);
    expect(desktopIssues(Object.assign(Object.create({ surface: 'desktop' }) as object, { app: { exe: 'a.exe' }, steps: [] }))).toEqual([BROWSER_STEPS_NEED_BROWSER]);
  });

  it('accepts {{$exportDir}} only in a desktop fill value, and no other {{$...}} name anywhere', () => {
    expect(desktopIssues(desktop([{ intent: 'x', fill: { field: uia('1001'), value: '{{ $exportDir }}\\a.csv' } }]))).toEqual([]);
    expect(desktopIssues(desktop([{ intent: 'x', select: { field: uia('a', 'ComboBox'), option: '{{$exportDir}}' } }]))).toEqual([
      'steps[0].select.option uses {{$exportDir}}, which is allowed only in the value of a desktop fill step',
    ]);
    expect(desktopIssues(desktop([{ intent: 'Save to {{$exportDir}}', click: uia('a') }]))).toEqual([
      'steps[0].intent uses {{$exportDir}}, which is allowed only in the value of a desktop fill step',
    ]);
    expect(desktopIssues(desktop([{ intent: 'x', fill: { field: uia('a'), value: '{{$tempDir}}\\a.csv' } }]))).toEqual([
      'steps[0].fill.value uses {{$tempDir}}: names that start with $ are reserved',
    ]);
    expect(desktopIssues(desktop([{ intent: 'x', click: { uia: { path: [{ name: '{{$json.x}}' }] } } }]))).toEqual([
      'steps[0].click.uia.path[0].name uses {{$json.x}}: names that start with $ are reserved',
    ]);
    expect(desktopIssues(desktop([{ intent: 'x', fill: { field: uia('a'), value: '{{{ $tempDir }}}' } }]))).toEqual([
      'steps[0].fill.value uses {{$tempDir}}: names that start with $ are reserved',
    ]);
  });
});

describe('browser step sets next to desktop ones', () => {
  const loc = { role: 'button', name: 'Go' };
  const browser = (steps: unknown[], more: Record<string, unknown> = {}) => ({ startUrl: 'https://example.com/', steps, ...more });

  it('parseScript refuses a desktop step set and an unknown surface; surface "browser" is a browser step set', () => {
    expect(browserIssues(desktop([{ intent: 'x', click: uia('a') }]))).toEqual([DESKTOP_STEPS_NEED_RUNNER]);
    expect(browserIssues(browser([{ intent: 'x', click: loc }], { surface: 'Desktop' }))).toEqual(['surface must be "browser" or "desktop"']);
    expect(parseScript(browser([{ intent: 'x', click: loc }], { surface: 'browser' })).surface).toBe('browser');
    expect(parseScript(browser([{ intent: 'x', click: loc }]))).toEqual({ startUrl: 'https://example.com/', steps: [{ intent: 'x', click: loc }] });
  });

  it('refuses { uia } in a browser step set, in any locator slot', () => {
    expect(browserIssues(browser([{ intent: 'x', click: uia('a') }]))).toEqual(['steps[0].click uses { uia }, which is allowed only in a desktop step set (surface "desktop")']);
    expect(browserIssues(browser([{ intent: 'x', click: { ...loc, fallbacks: [uia('a')] } }]))).toEqual(['steps[0].click.fallbacks[0] uses { uia }, which is allowed only in a desktop step set (surface "desktop")']);
    expect(browserIssues(browser([{ intent: 'x', click: loc, when: { visible: uia('a') } }]))[0]).toMatch(/^steps\[0\]\.when\.visible uses \{ uia \}/);
  });

  it('refuses the desktop-only verbs and write flags in a browser step set', () => {
    expect(browserIssues(browser([{ intent: 'x', key: { key: 'Enter' } }]))[0]).toMatch(/^steps\[0\] must have exactly one action/);
    expect(browserIssues(browser([{ intent: 'x', expectFile: { pattern: 'a' } }]))[0]).toMatch(/^steps\[0\] must have exactly one action/);
    expect(browserIssues(browser([{ intent: 'x', click: loc, write: true }]))).toEqual(['steps[0] has unknown key "write"']);
  });

  it('the {{$...}} refusal covers only the values a browser run renders; intents, locator texts and regexes stay as they were', () => {
    expect(browserIssues(browser([{ intent: 'Read {{ $ctrl.total }}', click: { text: '{{ $ctrl.total }}' }, expect: { heading: '{{$x}}' } }]))).toEqual([]);
    expect(browserIssues(browser([{ intent: 'x', select: { field: loc, value: '{{$y}}' } }]))).toEqual(['steps[0].select.value uses {{$y}}: names that start with $ are reserved']);
    expect(browserIssues(browser([{ intent: 'x', paginate: { next: loc, until: 'absent', max: 2, each: [{ intent: 'y', fill: { field: loc, value: '{{{$z}}}' } }] } }]))).toEqual([
      'steps[0].paginate.each[0].fill.value uses {{$z}}: names that start with $ are reserved',
    ]);
  });

  it('refuses every {{$...}} template in a browser step set, {{$exportDir}} included; {{var.x}} stays as it is', () => {
    expect(browserIssues(browser([{ intent: 'x', fill: { field: loc, value: '{{$exportDir}}/a.csv' } }]))).toEqual([
      'steps[0].fill.value uses {{$exportDir}}, which is allowed only in the value of a desktop fill step',
    ]);
    expect(browserIssues(browser([{ intent: 'x', goto: 'https://example.com/{{ $json.page }}' }]))).toEqual([
      'steps[0].goto uses {{$json.page}}: names that start with $ are reserved',
    ]);
    expect(browserIssues([{ intent: 'x', goto: 'https://example.com/' }, { intent: 'y', fill: { field: loc, value: '{{$now}}' } }])).toEqual([
      'steps[1].fill.value uses {{$now}}: names that start with $ are reserved',
    ]);
    expect(browserIssues(browser([{ intent: 'x', fill: { field: loc, value: '{{var.user}}' } }]))).toEqual([]);
  });
});

describe('desktop step sets: signing', () => {
  const KEY = 'desktop-signing-key-0123456789abcdef';
  const WHO = 'ops@example.com';
  const doc = desktop([{ intent: 'Sign in', click: uia('btnSignIn', 'Button') }]);

  it('signs without a startUrl, binding the app where a browser step set binds its start host', () => {
    const { hash, signature } = signScript(doc, KEY, { approvedBy: WHO });
    expect(hash).toBe(scriptHash(doc));
    expect(startHostOf(doc)).toBe('desktop app ErpDemo.exe');
    expect(desktopBinding('ErpDemo.exe')).toBe('desktop app ErpDemo.exe');
    const mac = createHmac('sha256', KEY).update(`pw-steps/2\n${hash}\nerp-orders\n1\ndesktop app ErpDemo.exe\n\n${WHO}`).digest('hex');
    expect(signature).toBe(mac);
    expect(verifyScript(doc, KEY, { approvedBy: WHO, signature })).toBe(true);
  });

  it('signing refuses a desktop step set that does not parse', () => {
    expect(() => signScript(desktop([{ intent: 'x', goto: 'https://example.com/' }]), KEY, { approvedBy: WHO })).toThrow(
      'invalid script: steps[0]: "goto" is a browser step, not allowed in a desktop step set',
    );
  });

  it('a desktop signature never verifies another app, a browser document or a changed surface', () => {
    const { signature } = signScript(doc, KEY, { approvedBy: WHO });
    expect(verifyScript({ ...doc, app: { exe: 'Other.exe' } }, KEY, { approvedBy: WHO, signature })).toBe(false);
    expect(verifyScript({ ...doc, app: { exe: 'ErpDemo.exe', args: ['/admin'] } }, KEY, { approvedBy: WHO, signature })).toBe(false);
    const { surface: _s, app: _a, ...asBrowser } = doc;
    expect(verifyScript({ ...asBrowser, startUrl: 'https://example.com/' }, KEY, { approvedBy: WHO, signature })).toBe(false);
    expect(verifyScript({ ...doc, surface: 'browser' }, KEY, { approvedBy: WHO, signature })).toBe(false);
    expect(verifyScript(doc, KEY, { approvedBy: 'other@example.com', signature })).toBe(false);
  });

  it('a signed desktop step set passes the desktop gate and never the browser lane', () => {
    const { signature } = signScript(doc, KEY, { approvedBy: WHO });
    const trust = { required: true, signature, approvedBy: WHO, key: KEY };
    expect(checkDesktopTrust(doc, trust)).toEqual({ ok: true, signed: true });
    expect(checkDesktopTrust(doc, { ...trust, expect: { name: 'other' } })).toMatchObject({ ok: false, code: 'script_untrusted' });
    expect(checkDesktopTrust(doc, { ...trust, expect: { version: 2 } })).toMatchObject({ ok: false, code: 'script_untrusted' });
    // The browser gate verifies the same signature (it binds the app the same way), but the browser lane's parseScript
    // refuses the document before anything runs.
    const policy: PortalPolicy = { startUrl: 'https://example.com/', navHosts: ['example.com'], subresourceHosts: [], login: [], allowedSubmits: [] };
    expect(checkTrust(doc, trust, { policy, firstRun: false })).toEqual({ ok: true, signed: true });
    expect(() => parseScript(doc, { defaultStartUrl: policy.startUrl })).toThrow(DESKTOP_STEPS_NEED_RUNNER);
  });

  it('a browser signature never passes the desktop gate', () => {
    const browserDoc = { name: 'erp-orders', version: 1, startUrl: 'https://example.com/', steps: [{ intent: 'x', click: { role: 'button', name: 'Go' } }] };
    const { signature } = signScript(browserDoc, KEY, { approvedBy: WHO });
    expect(checkDesktopTrust(doc, { required: true, signature, approvedBy: WHO, key: KEY })).toEqual({ ok: false, code: 'script_untrusted', message: UNSIGNED_REQUIRED });
  });

  it('unsigned desktop steps with a write step need Allow Unsigned Writes', () => {
    const writes = desktop([{ intent: 'Post', click: uia('btnPost', 'Button'), write: true }]);
    expect(checkDesktopTrust(writes, { required: false })).toEqual({ ok: false, code: 'script_untrusted', message: DESKTOP_UNSIGNED_WRITES });
    expect(checkDesktopTrust(writes, { required: false, allowUnsignedWrites: true })).toEqual({ ok: true, signed: false });
    expect(checkDesktopTrust(doc, { required: true })).toEqual({ ok: false, code: 'script_untrusted', message: UNSIGNED_REQUIRED });
  });
});
