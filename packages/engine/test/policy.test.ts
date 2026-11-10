import { describe, expect, it } from 'vitest';
import { SIGNIN_NEEDS_SITE_LOGIN, varInWriteLocator, WINDOW_STEP_NOT_CLICK } from '../src/messages.js';
import { loginBlockEnd, MAX_LITERAL_LOAD, MAX_LITERAL_PROPOSAL, MAX_SELECT_VALUES, MAX_SELECT_TOTAL, validateScript } from '../src/policy/validate.js';
import { parseScript } from '../src/steps/parse.js';
import type { Script, Step } from '../src/types.js';
import { baselineScript, policyFor, reportScript, SECRETS } from './helpers.js';

const portal = { url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' };
const policy = policyFor(portal);
const ctx = { policy, secrets: SECRETS, mode: 'load' as const };
const add = (s: Script, ...steps: Step[]): Script => ({ ...s, steps: [...s.steps, ...steps] });

describe('validateScript', () => {
  it('accepts the baseline and report scripts', () => {
    expect(validateScript(baselineScript(portal.url), ctx)).toEqual({ ok: true, violations: [], safetyFlags: [] });
    expect(validateScript(reportScript(portal.url), ctx).ok).toBe(true);
  });
  it('rejects a start URL or goto on an unlisted host (port-sensitive)', () => {
    const s = { ...baselineScript(portal.url), startUrl: 'http://127.0.0.1:1/acme/login' };
    expect(validateScript(s, ctx).violations[0]).toMatch(/startUrl host 127\.0\.0\.1:1/);
    const g = add(baselineScript(portal.url), { intent: 'Leave', goto: 'https://evil.example/x' });
    expect(validateScript(g, ctx).violations[0]).toMatch(/evil\.example/);
    const t = add(baselineScript(portal.url), { intent: 'Leave', goto: '{{var.url}}' });
    expect(validateScript(t, ctx).violations[0]).toMatch(/literal http\(s\) URL or path/);
  });
  it('rejects secret templates outside signIn and literal secrets anywhere', () => {
    const a = add(baselineScript(portal.url), { intent: 'Search', fill: { field: { css: '#q' }, value: '{{secret.password}}' } });
    expect(validateScript(a, ctx).violations[0]).toMatch(/secret template outside signIn/);
    const b = add(baselineScript(portal.url), { intent: 'Search', fill: { field: { css: '#q' }, value: 'DEMO-PASSWORD' } });
    expect(validateScript(b, ctx).violations[0]).toMatch(/contains a credential secret/);
    const c = add(baselineScript(portal.url), { intent: 'Click', click: { css: 'a[href*="demo-password"]' } });
    expect(validateScript(c, ctx).violations[0]).toMatch(/contains a credential secret/);
  });
  it('rejects long literal values and a second signIn', () => {
    const a = add(baselineScript(portal.url), { intent: 'Type', fill: { field: { css: '#q' }, value: 'x'.repeat(1025) } });
    expect(validateScript(a, ctx).violations[0]).toMatch(/longer than 1024/);
    const signIn = baselineScript(portal.url).steps[0];
    expect(validateScript(add(baselineScript(portal.url), signIn), ctx).violations[0]).toMatch(/more than one signIn/);
  });
  it('caps literal fill and select values at 1,024 characters when loading and 64 in repaired steps', () => {
    const type = (n: number) => add(baselineScript(portal.url), { intent: 'Type', fill: { field: { css: '#q' }, value: 'x'.repeat(n) } });
    expect(validateScript(type(65), ctx).ok).toBe(true);
    expect(validateScript(type(65), { ...ctx, mode: 'proposal' }).violations).toContain('limit: step "Type": value is longer than 64 characters');
    expect(validateScript(type(1024), ctx).ok).toBe(true);
    expect(validateScript(type(1025), ctx).violations).toEqual(['limit: step "Type": value is longer than 1024 characters']);
    const pick = add(baselineScript(portal.url), { intent: 'Pick', select: { field: { css: '#s' }, value: 'y'.repeat(1025) } });
    expect(validateScript(pick, ctx).violations).toEqual(['limit: step "Pick": value is longer than 1024 characters']);
    expect([MAX_LITERAL_PROPOSAL, MAX_LITERAL_LOAD]).toEqual([64, 1024]);
  });
  it('caps each element, the element count and the total length of a multi-select value', () => {
    const pick = (value: string[], intent = 'Pick') => add(baselineScript(portal.url), { intent, select: { field: { css: '#s' }, value } });
    expect(validateScript(pick(['a', 'b']), ctx).ok).toBe(true);
    expect(validateScript(pick(['y'.repeat(1024)]), ctx).ok).toBe(true);
    expect(validateScript(pick(['a', 'y'.repeat(1025)]), ctx).violations).toEqual(['limit: step "Pick": value is longer than 1024 characters']);
    expect(validateScript(pick(['a', 'y'.repeat(65)]), { ...ctx, mode: 'proposal' }).violations).toContain('limit: step "Pick": value is longer than 64 characters');
    expect(validateScript(pick(Array(MAX_SELECT_VALUES).fill('a')), ctx).ok).toBe(true);
    expect(validateScript(pick(Array(MAX_SELECT_VALUES + 1).fill('a')), ctx).violations).toEqual([`limit: step "Pick": more than ${MAX_SELECT_VALUES} values`]);
    const long = Array(MAX_SELECT_VALUES).fill('z'.repeat(MAX_SELECT_TOTAL / MAX_SELECT_VALUES + 1));
    expect(validateScript(pick(long), ctx).violations).toEqual([`limit: step "Pick": values are together longer than ${MAX_SELECT_TOTAL} characters`]);
    expect([MAX_SELECT_VALUES, MAX_SELECT_TOTAL]).toEqual([50, 4096]);
  });
  it('refuses {{var.*}} in the locators of the write window step, allows it elsewhere', () => {
    const base = baselineScript(portal.url);
    const win = (step: number, s: Script) => validateScript(s, { ...ctx, policy: { ...policy, writeWindow: { step, maxPosts: 3, hosts: [portal.host] } } });
    const clickAt = (i: number, click: { role: string; name: string }) => ({ ...base, steps: base.steps.map((st, j) => (j === i ? ({ ...st, click } as Step) : st)) });
    const s3 = clickAt(3, { role: 'button', name: '{{var.who}}' });
    expect(win(3, s3).violations).toEqual([varInWriteLocator('step "' + s3.steps[3].intent + '"')]);
    expect(win(1, s3).ok).toBe(true); // not the window step: the variable is a plain locator
  });
  it('refuses a variable condition on the write window click, allows an element condition there', () => {
    const base = baselineScript(portal.url);
    const win = (s: Script) => validateScript(s, { ...ctx, policy: { ...policy, writeWindow: { step: 3, maxPosts: 3, hosts: [portal.host] } } });
    const gated = (when: Step['when']): Script => ({ ...base, steps: base.steps.map((st, j) => (j === 3 ? ({ ...st, when } as Step) : st)) });
    expect(win(gated({ var: 'mode', equals: 'save' })).violations).toEqual(['steps[3].when may not use a variable on a step that signs in or writes']);
    expect(win(gated({ var: 'mode', notEquals: 'read' })).violations).toEqual(['steps[3].when may not use a variable on a step that signs in or writes']);
    expect(win(gated({ hidden: { css: '#busy' } })).ok).toBe(true);
    expect(validateScript(gated({ var: 'mode', equals: 'save' }), ctx).ok).toBe(true); // no write window: a plain click
  });
  it('the write window must sit on a top-level click step', () => {
    const at = (step: number) => validateScript(baselineScript(portal.url), { ...ctx, policy: { ...policy, writeWindow: { step, maxPosts: 3, hosts: [portal.host] } } });
    expect(at(3)).toMatchObject({ ok: true });
    expect(at(1).ok).toBe(true); // a when-gated click is still a click
    for (const step of [0, 2, 5, 6, 99, -1]) expect(at(step).violations).toEqual([WINDOW_STEP_NOT_CLICK]);
  });
  it('rejects submits and download vias that are not allowed', () => {
    const a = add(baselineScript(portal.url), { intent: 'Ack', submit: { button: { css: '#acknowledge' }, path: '/acme/notices/acknowledge' } });
    expect(validateScript(a, ctx).violations[0]).toMatch(/POST 127\.0\.0\.1:9999\/acme\/notices\/acknowledge is not an allowed submission/);
    const r = reportScript(portal.url);
    const bad = structuredClone(r);
    (bad.steps[bad.steps.length - 1] as { download: { via: { path: string } } }).download.via.path = '/acme/other';
    expect(validateScript(bad, ctx).violations[0]).toMatch(/not an allowed submission/);
  });
  it('in proposal mode, rejects gotos that were never observed', () => {
    const s = add(baselineScript(portal.url), { intent: 'Jump', goto: '/acme/service/tsb' });
    const p = { ...ctx, mode: 'proposal' as const };
    expect(validateScript(s, p).violations[0]).toMatch(/unobserved URL/);
    expect(validateScript(s, { ...p, observedNavigations: [`${portal.url}/acme/service/tsb?x=1`] }).ok).toBe(true);
    expect(validateScript(s, { ...p, previous: s }).ok).toBe(true);
    expect(validateScript(s, ctx).ok).toBe(true);
  });
  it('in proposal mode, refuses a fill with secret that is new, and accepts it when loading signed steps', () => {
    const s = add(baselineScript(portal.url), { intent: 'Type', fill: { field: { label: 'Export password' }, value: '{{var.pw}}', secret: true } });
    // No signed base (a first approval, an import): every secret fill is new.
    expect(validateScript(s, { ...ctx, mode: 'proposal' as const }).violations.join()).toMatch(/cannot type a secret/);
    // Added to a base that had none.
    expect(validateScript(s, { ...ctx, mode: 'proposal' as const, previous: baselineScript(portal.url) }).violations.join()).toMatch(/cannot type a secret/);
    expect(validateScript(s, ctx).ok).toBe(true);
  });
  describe('in proposal mode, a signed fill with secret the repair kept', () => {
    const FILL: Step = { intent: 'Type the export password', fill: { field: { label: 'Export password' }, value: '{{var.pw}}', secret: true } };
    const OPEN: Step = { intent: 'Open the export', click: { role: 'button', name: 'Export' } };
    const base = add(baselineScript(portal.url), FILL, OPEN);
    const p = (script: Script) => validateScript(script, { ...ctx, mode: 'proposal' as const, previous: base });
    const secretViolations = (script: Script) => p(script).violations.filter((v) => /cannot type a secret/.test(v));
    it('is allowed when it is the same step at the same index, before the first changed step', () => {
      // Nothing changed at all.
      expect(p(base)).toMatchObject({ ok: true });
      // A step after it changed.
      const repaired = add(baselineScript(portal.url), FILL, { intent: 'Open the export', click: { role: 'link', name: 'Export' } });
      expect(p(repaired)).toMatchObject({ ok: true, violations: [] });
      // A step added after it.
      expect(secretViolations(add(base, { intent: 'Read', read: { what: 'url' } }))).toEqual([]);
      // The same step in a paginate body that did not change.
      const nested = add(baselineScript(portal.url), { intent: 'Pages', paginate: { next: { text: 'Next' }, until: 'absent', max: 2, each: [FILL] } }, OPEN);
      const nestedRepair = structuredClone(nested);
      (nestedRepair.steps[nestedRepair.steps.length - 1] as { click: object }).click = { text: 'Export' };
      expect(validateScript(nestedRepair, { ...ctx, mode: 'proposal' as const, previous: nested }).violations.filter((v) => /cannot type a secret/.test(v))).toEqual([]);
    });
    it('is refused when it changed, moved, or sits at or after the first changed step', () => {
      // Changed: another field, another variable, or no longer exactly the signed step.
      expect(secretViolations(add(baselineScript(portal.url), { ...FILL, fill: { ...FILL.fill, field: { label: 'Password' } } } as Step, OPEN))).toHaveLength(1);
      expect(secretViolations(add(baselineScript(portal.url), { ...FILL, fill: { ...FILL.fill, value: '{{var.other}}' } } as Step, OPEN))).toHaveLength(1);
      expect(secretViolations(add(baselineScript(portal.url), { ...FILL, intent: 'Type it' }, OPEN))).toHaveLength(1);
      // Moved: one index later behind a new step, or after the step that followed it.
      expect(secretViolations(add(baselineScript(portal.url), { intent: 'Wait', waitFor: { target: { label: 'Export password' } } }, FILL, OPEN))).toHaveLength(1);
      expect(secretViolations(add(baselineScript(portal.url), OPEN, FILL))).toHaveLength(1);
      // The same step at the same index, after a changed step.
      const earlier = structuredClone(base);
      (earlier.steps[0] as { intent: string }).intent = 'Open the sign-in page again';
      expect(secretViolations(earlier)).toHaveLength(1);
      // A second, added copy after the kept one.
      expect(secretViolations(add(base, FILL))).toHaveLength(1);
    });
  });
  it('raises safety flags for new submits, downloads and hosts compared with the previous version', () => {
    const prev = baselineScript(portal.url);
    const next = reportScript(portal.url, 2);
    const res = validateScript(next, { ...ctx, previous: prev });
    expect(res.ok).toBe(true);
    expect(res.safetyFlags).toEqual(expect.arrayContaining(['new form submission: POST 127.0.0.1:9999/acme/reports/export', 'new download step']));
    const twoHosts = { ...policy, navHosts: [portal.host, 'sso.example'] };
    const sso = add(baselineScript(portal.url), { intent: 'SSO', goto: 'https://sso.example/start' });
    expect(validateScript(sso, { ...ctx, policy: twoHosts, previous: prev }).safetyFlags).toContain('new host: sso.example');
  });

  it('rejects templated gotos that can navigate off-host', () => {
    // Template in userinfo
    const userinfo = add(baselineScript(portal.url), { intent: 'BadGoto', goto: 'http://{{var.a}}@127.0.0.1:9999/acme/dashboard' });
    expect(validateScript(userinfo, ctx).violations[0]).toMatch(/literal http\(s\) URL or path/);
    // Template at start of path
    const pathStart = add(baselineScript(portal.url), { intent: 'BadGoto', goto: '/{{var.p}}' });
    expect(validateScript(pathStart, ctx).violations[0]).toMatch(/literal http\(s\) URL or path/);
    // Template at start of scheme
    const schemeStart = add(baselineScript(portal.url), { intent: 'BadGoto', goto: 'https{{var.p}}' });
    expect(validateScript(schemeStart, ctx).violations[0]).toMatch(/literal http\(s\) URL or path/);
    // Control character
    const controlChar = add(baselineScript(portal.url), { intent: 'BadGoto', goto: '\u0001{{var.url}}' });
    expect(validateScript(controlChar, ctx).violations[0]).toMatch(/literal http\(s\) URL or path/);
    // Template in query is allowed
    const queryTemplate = add(baselineScript(portal.url), { intent: 'GoodGoto', goto: '/acme/reports?from={{var.from}}' });
    expect(validateScript(queryTemplate, ctx).ok).toBe(true);
  });

  it('rejects literal secrets in script-level fields and interrupts', () => {
    // Password literal in fill value
    const withSecret = add(baselineScript(portal.url), { intent: 'Search', fill: { field: { css: '#q' }, value: 'demo-password' } });
    expect(validateScript(withSecret, ctx).violations[0]).toMatch(/contains a credential secret/);
    // startUrl with secret in query
    const s = { ...baselineScript(portal.url), startUrl: `${portal.url}?p=demo-password` };
    expect(validateScript(s, ctx).violations.some((v) => v.match(/script field startUrl.*contains a credential secret/))).toBe(true);
    // Interrupt css containing secret
    const withInterrupt = { ...baselineScript(portal.url), interrupts: [{ target: { css: 'a[href*="demo-password"]' }, click: { css: '#close' } }] };
    expect(validateScript(withInterrupt, ctx).violations.some((v) => v.match(/script field interrupts.*contains a credential secret/))).toBe(true);
    // Goto with encoded username in query
    const encoded = add(baselineScript(portal.url), { intent: 'Encoded', goto: '/acme/reports?user=' + encodeURIComponent('summit-ops') });
    expect(validateScript(encoded, ctx).violations.some((v) => v.match(/contains a credential secret/))).toBe(true);
  });

  it('rejects secret templates with whitespace', () => {
    const a = add(baselineScript(portal.url), { intent: 'Search', fill: { field: { css: '#q' }, value: '{{ secret.password }}' } });
    expect(validateScript(a, ctx).violations[0]).toMatch(/secret template outside signIn/);
  });

  it('does not leak secrets in violation and safety flag messages', () => {
    const step = add(baselineScript(portal.url), { intent: 'Type demo-password', fill: { field: { css: '#q' }, value: 'demo-password' } });
    const res = validateScript(step, ctx);
    const allMessages = [...res.violations, ...res.safetyFlags].join('\n');
    expect(allMessages).not.toContain('demo-password');
    expect(allMessages).toContain('[secret]');
  });

  it('in proposal mode, rejects startUrl that does not match policy.startUrl', () => {
    // Different path should fail in proposal mode
    const differentPath = { ...baselineScript(portal.url), startUrl: 'http://127.0.0.1:9999/acme/other' };
    const proposalCtx = { ...ctx, mode: 'proposal' as const };
    expect(validateScript(differentPath, proposalCtx).violations.some((v) => v.match(/startUrl must match/))).toBe(true);
    // Same path should pass
    expect(validateScript(baselineScript(portal.url), proposalCtx).violations.some((v) => v.match(/startUrl must match/))).toBe(false);
    // Query string difference should be ok (query is not part of the check)
    const differentQuery = { ...baselineScript(portal.url), startUrl: 'http://127.0.0.1:9999/acme/login?x=1' };
    expect(validateScript(differentQuery, proposalCtx).violations.some((v) => v.match(/startUrl must match/))).toBe(false);
    // In load mode, only host check applies
    expect(validateScript(differentPath, ctx).violations.some((v) => v.match(/startUrl must match/))).toBe(false);
  });

  it('detects literals secrets in locator CSS and frame values', () => {
    // Secret in signIn.username css
    const script = structuredClone(baselineScript(portal.url));
    (script.steps[0] as any).signIn.username = { css: 'input[data-x="demo-password"]' };
    expect(validateScript(script, ctx).violations.some((v) => v.match(/contains a credential secret/))).toBe(true);
    // Secret in locator frame attribute
    const withFrame = add(baselineScript(portal.url), { intent: 'Click', click: { css: '#btn', frame: 'iframe[src*="demo-password"]' } });
    expect(validateScript(withFrame, ctx).violations.some((v) => v.match(/contains a credential secret/))).toBe(true);
  });

  it('detects secret templates with real whitespace characters (tab/newline)', () => {
    // Real tab character before secret template (not \t escape sequence)
    // Use a custom context with a secret that won't match literal substrings in template syntax
    const tabCtx = { ...ctx, secrets: { ...SECRETS, totpSecret: 'MYSECRETCODE123' } };
    const tabStep = add(baselineScript(portal.url), { intent: 'Search', fill: { field: { css: '#q' }, value: '{{\tsecret.totpSecret}}' } });
    expect(validateScript(tabStep, tabCtx).violations[0]).toMatch(/secret template outside signIn/);
  });

  it('reports literal secrets in paginate.each children exactly once per parent step', () => {
    const script = structuredClone(baselineScript(portal.url));
    // Modify the existing paginate step to include secret in child step
    const paginateStep = script.steps.find((s) => 'paginate' in s);
    if (paginateStep && 'paginate' in paginateStep) {
      paginateStep.paginate.each.push({
        intent: 'Search in page',
        fill: { field: { css: '#search' }, value: 'demo-password' },
      });
    }
    const res = validateScript(script, ctx);
    const secretViolations = res.violations.filter((v) => v.match(/contains a credential secret/));
    // Should report once for the parent step (Read every page of notices), not per child
    const readEveryPageViolations = secretViolations.filter((v) => v.match(/Read every page/));
    expect(readEveryPageViolations.length).toBe(1);
  });

  it('detects URL-encoded and encodeURIComponent-different secrets', () => {
    // Use email as secret to ensure encodeURIComponent differs from raw
    const customCtx = { ...ctx, secrets: { ...SECRETS, username: 'ops@example.com' } };
    // @ becomes %40 in encodeURIComponent
    const encoded = add(baselineScript(portal.url), { intent: 'Encoded', goto: '/acme/reports?user=' + encodeURIComponent('ops@example.com') });
    expect(validateScript(encoded, customCtx).violations.some((v) => v.match(/contains a credential secret/))).toBe(true);
  });
  it('a first approval (no previous version) flags every submit, download and host', () => {
    const p = { ...ctx, mode: 'proposal' as const };
    const handlers = ['new interrupt: when css "#cookie-overlay" shows, click role "button" name "Accept all"', 'new interrupt: when css "#whats-new" shows, click css "#whats-new-dismiss"'];
    expect(validateScript(baselineScript(portal.url), p).safetyFlags).toEqual([`new host: ${portal.host}`, ...handlers]);
    expect(validateScript(reportScript(portal.url), p).safetyFlags).toEqual([
      `new form submission: POST ${portal.host}/acme/reports/export`, 'new download step', `new host: ${portal.host}`, ...handlers,
    ]);
    expect(validateScript(reportScript(portal.url), ctx).safetyFlags).toEqual([]);
  });

  it('flags a pop-up handler (interrupt) that the previous version did not have', () => {
    const prev = baselineScript(portal.url);
    const next = { ...prev, version: 2, interrupts: [...(prev.interrupts ?? []), { target: { css: '#promo' }, click: { role: 'link', name: 'Orders', fallbacks: [{ css: '#cancel' }] } }] };
    const p = { ...ctx, mode: 'proposal' as const, previous: prev };
    // The target and every locator the handler may click.
    expect(validateScript(next, p).safetyFlags).toEqual(['new interrupt: when css "#promo" shows, click role "link" name "Orders" or css "#cancel"']);
    expect(validateScript({ ...prev, version: 2 }, p).safetyFlags).toEqual([]);
    // A handler whose target changed is new.
    const moved = { ...prev, version: 2, interrupts: [{ ...prev.interrupts![0], target: { css: '#cookie-overlay-2' } }, prev.interrupts![1]] };
    expect(validateScript(moved, p).safetyFlags).toEqual(['new interrupt: when css "#cookie-overlay-2" shows, click role "button" name "Accept all"']);
  });

  it('never accepts a frame host as a goto target', () => {
    const withFrames = { ...policy, frameHosts: ['widget.example'] };
    const s = add(baselineScript(portal.url), { intent: 'Widget', goto: 'https://widget.example/w' });
    expect(validateScript(s, { ...ctx, policy: withFrames }).violations[0]).toMatch(/goto host widget\.example is not in the allowed hosts/);
  });
});

describe('loginBlockEnd', () => {
  it('covers signIn, its gated steps and the detect right after them', () => {
    expect(loginBlockEnd(baselineScript(portal.url))).toBe(2);
  });
  it('does not stretch to a later detect', () => {
    const base = baselineScript(portal.url);
    const click = (n: string): Step => ({ intent: n, click: { css: '#x' } });
    const detect = base.steps[2];
    const s: Script = { ...base, steps: [base.steps[0], click('a'), click('b'), detect, { intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }] };
    expect(loginBlockEnd(s)).toBe(0);
    expect(loginBlockEnd({ ...base, steps: [click('a')] })).toBe(-1);
  });
  it('only element conditions extend it: a hidden-gated step does, a variable-gated step does not', () => {
    const base = baselineScript(portal.url);
    const [signIn, survey, detect] = base.steps;
    const gated = (when: Step['when']): Step => ({ intent: 'Gated', when, click: { css: '#x' } });
    expect(loginBlockEnd({ ...base, steps: [signIn, gated({ hidden: { css: '#busy' } }), survey, detect] })).toBe(3);
    expect(loginBlockEnd({ ...base, steps: [signIn, gated({ var: 'mode', equals: 'x' }), survey, detect] })).toBe(0);
    expect(loginBlockEnd({ ...base, steps: [signIn, survey, gated({ var: 'mode', notEquals: 'x' }), detect] })).toBe(1);
  });
});

describe('steps without a Site Login', () => {
  const noLogin = { policy, mode: 'load' as const };
  const typed: Script = {
    name: 'public', version: 1, startUrl: `${portal.url}/acme/login`,
    steps: [{ intent: 'Type', fill: { field: { css: '#q' }, value: 'demo-password' } }],
  };
  it('a signIn step is refused at load', () => {
    expect(SIGNIN_NEEDS_SITE_LOGIN).toBe('signIn needs a Site Login credential');
    const r = validateScript(baselineScript(portal.url), noLogin);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain(SIGNIN_NEEDS_SITE_LOGIN);
    expect(validateScript(baselineScript(portal.url), ctx).violations).not.toContain(SIGNIN_NEEDS_SITE_LOGIN);
  });
  it('the literal-secret checks are skipped without secrets', () => {
    expect(validateScript(typed, noLogin)).toEqual({ ok: true, violations: [], safetyFlags: [] });
    expect(validateScript(typed, ctx).violations[0]).toMatch(/contains a credential secret/);
  });
  it('secret templates are still refused without secrets', () => {
    const s = add(typed, { intent: 'Search', fill: { field: { css: '#q' }, value: '{{secret.password}}' } });
    expect(validateScript(s, noLogin).violations[0]).toMatch(/secret template outside signIn/);
  });
});

describe('the start host taken from the first goto', () => {
  it('validates the start host parseScript took from the first absolute goto', () => {
    const onList = parseScript([{ intent: 'Open', goto: `${portal.url}/public/table` }]);
    expect(validateScript(onList, { policy, mode: 'load' }).ok).toBe(true);
    const offList = parseScript([{ intent: 'Open', goto: 'https://elsewhere.example/table' }]);
    expect(validateScript(offList, { policy, mode: 'load' }).violations).toContain('startUrl host elsewhere.example is not in the allowed hosts');
  });
});
