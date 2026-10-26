import { describe, expect, it } from 'vitest';
import type { AgentAction } from '../src/agent/tools.js';
import { CompileError, compileProposal, EXTRACT_FIELDS_DROPPED, extractsFields, type CompileInput } from '../src/compile/compile.js';
import { COMPILE_CHANGES_FILE_CHECK, COMPILE_EMITS_SUBMIT, COMPILE_TOUCHES_SUBMIT } from '../src/messages.js';
import { flattenSteps } from '../src/policy/validate.js';
import { describeStep, stepChanges } from '../src/proposal/proposal.js';
import type { Locator, Script, Step } from '../src/types.js';
import { baselineScript, policyFor, SECRETS } from './helpers.js';

const portal = { url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' };
const U = (p: string) => `${portal.url}${p}`;
const link = (name: string, landmark: string): Locator => ({ role: 'link', name, exact: true, within: { role: landmark }, fallbacks: [{ role: 'link', name, exact: true }] });
const click = (name: string, at: string, landmark = 'main'): AgentAction => ({ tool: 'click', ok: true, url: U(at), step: { intent: `Open ${name}`, click: link(name, landmark) } });
const READ: Step = { intent: 'Read the rows on this page', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } };
const extract = (at: string): AgentAction => ({ tool: 'extract', ok: true, url: U(at), step: READ });
const NEXT: Locator = { role: 'link', name: 'Next page »', exact: true, within: { role: 'main' } };
const next = (at: string): AgentAction => ({ tool: 'next_page', ok: true, url: U(at), step: { intent: 'Go to the next page', click: NEXT } });
const look = (at: string): AgentAction => ({ tool: 'look', ok: true, url: U(at) });
const back = (at: string): AgentAction => ({ tool: 'back', ok: true, url: U(at) });
const doneA = (at: string): AgentAction => ({ tool: 'done', ok: true, url: U(at), note: 'found' });
const PASSWORD: Locator = { label: 'Password', exact: true, fallbacks: [{ css: '#password' }] };
const SIGN_IN: AgentAction = {
  tool: 'sign_in', ok: true, url: U('/acme/login'),
  step: { intent: 'Sign in', signIn: { username: { role: 'textbox', name: 'Dealer user ID', exact: true }, password: PASSWORD, submit: { role: 'button', name: 'Sign in', exact: true } } },
};
const TOTP = { field: { role: 'textbox', name: 'Authentication code', exact: true }, submit: { role: 'button', name: 'Verify', exact: true } };
const LATER: Locator = { role: 'link', name: 'Remind me later', exact: true };
const COOKIE = { target: { css: '#cookie-overlay' }, click: { role: 'button', name: 'Accept all', exact: true } };

const repair = (actions: AgentAction[], over: Partial<CompileInput> = {}): CompileInput => ({
  base: baselineScript(portal.url), resumeFrom: 3, actions, name: 'demo-sandbox', startUrl: U('/acme/login'), version: 2,
  policy: policyFor(portal), secrets: SECRETS, observedNavigations: [], ...over,
});

describe('compileProposal', () => {
  it('checkpoints on the stable part of a path with a SAP session segment, never the session id', () => {
    const r = compileProposal(repair([
      look('/acme/service'), click('Field Actions', '/acme/service'),
      extract('/sap(cz1TSUQ6QU5PTjpiZGUy)/bc/gui/sap/its/webgui'), doneA('/sap(cz1TSUQ6QU5PTjpiZGUy)/bc/gui/sap/its/webgui'),
    ]));
    expect(r.script.steps[4]).toMatchObject({ checkpoint: true, expect: { url: '/bc/gui/sap/its/webgui' } });
    expect(JSON.stringify(r.script)).not.toContain('sap(');
    const stable = (at: string) => compileProposal(repair([look('/acme/service'), click('Field Actions', '/acme/service'), extract(at), doneA(at)])).script.steps[4];
    expect(stable('/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui')).toMatchObject({ expect: { url: '/bc/gui/sap/its/webgui' } });
    expect(stable('/sap(bD1lbiZjPTAwMQ%3d%3d)/bc/gui/sap/its/webgui')).toMatchObject({ expect: { url: '/bc/gui/sap/its/webgui' } });
    // Only session-shaped segments count: other parentheses stay in the path.
    expect(stable('/wiki/Foo_(bar)')).toMatchObject({ expect: { url: '/wiki/Foo_(bar)' } });
    expect(stable('/odata/Products(1)/Details')).toMatchObject({ expect: { url: '/odata/Products(1)/Details' } });
  });
  it('keeps the passed prefix and checkpoints the step that reaches the rows', () => {
    const base = baselineScript(portal.url);
    const r = compileProposal(repair([look('/acme/service'), click('Field Actions', '/acme/service'), extract('/acme/service/field-actions'), doneA('/acme/service/field-actions')]));
    expect(r.suffixFrom).toBe(4);
    expect(r.script.steps.slice(0, 4)).toEqual(base.steps.slice(0, 4));
    expect(r.script.steps.slice(4)).toEqual([
      { intent: 'Open Field Actions', click: link('Field Actions', 'main'), checkpoint: true, expect: { url: '/acme/service/field-actions' } },
      READ,
    ]);
    expect(r.script).toMatchObject({ name: 'demo-sandbox', version: 2, startUrl: U('/acme/login'), interrupts: base.interrupts });
    expect(r.safetyFlags).toEqual([]);
  });
  it('folds extract and next_page into paginate with the first extract as the body', () => {
    const at = '/acme/service/field-actions';
    const full = compileProposal(repair([click('Field Actions', '/acme/service'), extract(at), next(at), extract(at), next(at), extract(at)]));
    expect(full.script.steps.slice(5)).toEqual([{ intent: 'Read every page', paginate: { next: NEXT, until: 'absent', max: 20, nextWaitMs: 1500, each: [READ] } }]);
    expect(full.script.steps[4].checkpoint).toBe(true);
    const trailing = compileProposal(repair([click('Field Actions', '/acme/service'), extract(at), next(at)]));
    expect(trailing.script.steps).toHaveLength(6);
    expect('paginate' in trailing.script.steps[5]).toBe(true);
  });
  it('drops a dead end undone by back, collapses repeated clicks, and ignores failed actions', () => {
    const failed: AgentAction = { tool: 'click', ok: false, url: U('/acme/service'), note: 'refused' };
    const r = compileProposal(repair([
      click('Technical Service Bulletins', '/acme/service'), back('/acme/service/tsb'),
      click('Field Actions', '/acme/service'), click('Field Actions', '/acme/service'), failed, extract('/acme/service/field-actions'),
    ]));
    expect(r.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open Field Actions', 'Read the rows on this page']);
    expect(() => compileProposal(repair([back('/acme/service'), click('Field Actions', '/acme/service'), extract('/acme/x')]))).toThrow(/does not undo a click/);
  });
  it('builds a first-run script: signIn with TOTP, interstitial, detect from the first click, overlay interrupts', () => {
    const actions: AgentAction[] = [
      SIGN_IN,
      { tool: 'enter_code', ok: true, url: U('/acme/mfa'), totp: TOTP },
      { tool: 'dismiss', ok: true, url: U('/acme/survey'), step: { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER } },
      { tool: 'dismiss', ok: true, url: U('/acme/home'), interrupt: COOKIE },
      { tool: 'dismiss', ok: true, url: U('/acme/service'), interrupt: COOKIE },
      click('Service', '/acme/home', 'navigation'),
      click('Recalls & Stop-Sales', '/acme/service'),
      extract('/acme/service/recalls-and-stop-sales'),
      doneA('/acme/service/recalls-and-stop-sales'),
    ];
    const r = compileProposal(repair(actions, { base: undefined, resumeFrom: -1, version: 1 }));
    expect(r.suffixFrom).toBe(0);
    expect(r.script.interrupts).toEqual([COOKIE]);
    expect(r.script.steps).toEqual([
      { intent: 'Sign in', signIn: { ...(SIGN_IN.step as Extract<Step, { signIn: unknown }>).signIn, totp: TOTP } },
      { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER },
      { intent: 'Check sign-in worked', detect: { name: 'afterLogin', checks: { logged_in: link('Service', 'navigation'), login_failed: PASSWORD }, require: 'logged_in' } },
      { intent: 'Open Service', click: link('Service', 'navigation') },
      { intent: 'Open Recalls & Stop-Sales', click: link('Recalls & Stop-Sales', 'main'), checkpoint: true, expect: { url: '/acme/service/recalls-and-stop-sales' } },
      READ,
    ]);
    expect(r.safetyFlags).toEqual([`new host: ${portal.host}`, 'new interrupt: when css "#cookie-overlay" shows, click role "button" name "Accept all" exact']);
  });
  it('refuses what parse or the policy validator rejects, and scripts it cannot judge', () => {
    const issues = (input: CompileInput): string[] => {
      try { compileProposal(input); return []; } catch (e) { expect(e).toBeInstanceOf(CompileError); return (e as CompileError).issues; }
    };
    const secretFill: AgentAction = { tool: 'fill', ok: true, url: U('/acme/home'), step: { intent: 'Fill Search', fill: { field: { css: '#q' }, value: SECRETS.password } } };
    expect(issues(repair([secretFill, extract('/acme/home')]))[0]).toMatch(/contains a credential secret/);
    const badLocator: AgentAction = { tool: 'click', ok: true, url: U('/acme/home'), step: { intent: 'Open X', click: { role: 'link', name: 'X', exact: 'yes' } as unknown as Locator } };
    expect(issues(repair([badLocator]))[0]).toMatch(/exact must be a boolean/);
    expect(issues(repair([look('/acme/home'), doneA('/acme/home')]))[0]).toMatch(/recorded no steps/);
    expect(issues(repair([SIGN_IN, extract('/acme/home')], { base: undefined, resumeFrom: -1, version: 1 }))[0]).toMatch(/successful sign-in looks like/);
    expect(issues(repair([SIGN_IN, click('Service', '/acme/home', 'navigation')])).join('\n')).toMatch(/more than one signIn/);
    expect(issues(repair([click('Service', '/acme/home')], { base: undefined }))[0]).toMatch(/resumeFrom needs a base script/);
  });
  it('never puts a credential secret in a compile error', () => {
    const leaky: AgentAction = { tool: 'click', ok: true, url: U('/acme/home'), step: { intent: 'Open X', click: { role: 'link', name: 'X', [SECRETS.password]: true } as unknown as Locator } };
    try {
      compileProposal(repair([leaky]));
      expect.unreachable('compile should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      const err = e as CompileError;
      expect(err.issues.join('\n')).toMatch(/unknown key/);
      expect(`${err.message}\n${err.issues.join('\n')}`).not.toContain(SECRETS.password);
    }
  });

  describe('login block edge cases', () => {
    const FIRST_RUN = { base: undefined, resumeFrom: -1, version: 1 } as const;
    const signInStep = (totp?: typeof TOTP): Step => ({ intent: 'Sign in', signIn: { ...(SIGN_IN.step as Extract<Step, { signIn: unknown }>).signIn, ...(totp ? { totp } : {}) } });
    const LATER_STEP: Step = { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER };

    it('keeps grouping a sign-in across overlay dismisses', () => {
      const withCode = compileProposal(repair([
        SIGN_IN,
        { tool: 'dismiss', ok: true, url: U('/acme/mfa'), interrupt: COOKIE },
        { tool: 'enter_code', ok: true, url: U('/acme/mfa'), totp: TOTP },
        click('Service', '/acme/home', 'navigation'),
        extract('/acme/service'),
      ], FIRST_RUN));
      expect(withCode.script.steps[0]).toEqual(signInStep(TOTP));
      expect(withCode.script.interrupts).toEqual([COOKIE]);

      const withSurvey = compileProposal(repair([
        SIGN_IN,
        { tool: 'dismiss', ok: true, url: U('/acme/home'), interrupt: COOKIE },
        { tool: 'dismiss', ok: true, url: U('/acme/survey'), step: LATER_STEP },
        click('Service', '/acme/home', 'navigation'),
        extract('/acme/service'),
      ], FIRST_RUN));
      expect(withSurvey.script.steps.map((st) => st.intent)).toEqual(['Sign in', 'Dismiss Remind me later', 'Check sign-in worked', 'Open Service', 'Read the rows on this page']);
      expect(withSurvey.script.interrupts).toEqual([COOKIE]);
    });

    it('keeps the base login block when the agent restarts from the start URL without signing in', () => {
      const base = baselineScript(portal.url);
      const r = compileProposal(repair([click('Service', '/acme/home', 'navigation'), extract('/acme/service')], { resumeFrom: -1 }));
      expect(r.script.steps.slice(0, 3)).toEqual(base.steps.slice(0, 3));
      expect(r.suffixFrom).toBe(3);
      expect(r.script.steps.slice(3).map((st) => st.intent)).toEqual(['Open Service', 'Read the rows on this page']);
      const partial = compileProposal(repair([click('Service', '/acme/home', 'navigation'), extract('/acme/service')], { resumeFrom: 0 }));
      expect(partial.script.steps.slice(0, 3)).toEqual(base.steps.slice(0, 3));
    });

    it('folds pagination only on a stable next locator, and sizes max from the pages seen', () => {
      const at = '/acme/service/field-actions';
      const numbered = (n: string): AgentAction => ({ tool: 'next_page', ok: true, url: U(at), step: { intent: `Go to page ${n}`, click: { role: 'link', name: n, exact: true } } });
      const r = compileProposal(repair([click('Field Actions', '/acme/service'), extract(at), numbered('2'), extract(at), numbered('3'), extract(at)]));
      expect(r.script.steps.slice(4).map((st) => st.intent)).toEqual(['Open Field Actions', 'Read the rows on this page', 'Go to page 2', 'Read the rows on this page', 'Go to page 3', 'Read the rows on this page']);
      expect(r.script.steps.some((st) => 'paginate' in st)).toBe(false);

      const many: AgentAction[] = [click('Field Actions', '/acme/service'), extract(at)];
      for (let i = 0; i < 24; i++) many.push(next(at), extract(at));
      const big = compileProposal(repair(many));
      const pg = big.script.steps[5];
      expect('paginate' in pg && pg.paginate.max).toBe(30);
      const capped: AgentAction[] = [click('Field Actions', '/acme/service'), extract(at)];
      for (let i = 0; i < 99; i++) capped.push(next(at), extract(at));
      const top = compileProposal(repair(capped)).script.steps[5];
      expect('paginate' in top && top.paginate.max).toBe(100);
    });

    it('rejects a resumeFrom outside the base script', () => {
      const issues = (over: Partial<CompileInput>): string[] => {
        try { compileProposal(repair([click('Service', '/acme/home')], over)); return []; } catch (e) { return (e as CompileError).issues; }
      };
      expect(issues({ resumeFrom: 6 })[0]).toMatch(/resumeFrom/);
      expect(issues({ resumeFrom: -2 })[0]).toMatch(/resumeFrom/);
      expect(issues({ resumeFrom: 1.5 })[0]).toMatch(/resumeFrom/);
      expect(issues({ base: undefined, resumeFrom: 0 })[0]).toMatch(/resumeFrom needs a base script/);
      expect(issues({ resumeFrom: 4 })).toEqual([]);
    });

    it('lets back undo the reads on a dead-end page along with the click that opened it', () => {
      const r = compileProposal(repair([
        click('Field Actions', '/acme/service'), extract('/acme/service/field-actions'), back('/acme/service/field-actions'),
        click('Field Bulletins', '/acme/service'), extract('/acme/service/field-bulletins'),
      ]));
      expect(r.script.steps.slice(4)).toEqual([
        { intent: 'Open Field Bulletins', click: link('Field Bulletins', 'main'), checkpoint: true, expect: { url: '/acme/service/field-bulletins' } },
        READ,
      ]);
      // back from page 2 lands on page 1 of the same list: only the next-page click is undone.
      const fa = '/acme/service/field-actions';
      const paged = compileProposal(repair([
        click('Field Actions', '/acme/service'), extract(fa), next(fa), back(fa), click('Details', fa), extract('/acme/service/details'),
      ]));
      expect(paged.script.steps.slice(4).map((st) => st.intent)).toEqual(['Open Field Actions', 'Read the rows on this page', 'Open Details', 'Read the rows on this page']);
      expect(() => compileProposal(repair([SIGN_IN, back('/acme/home'), click('Service', '/acme/home')], { base: undefined, resumeFrom: -1 }))).toThrow(/cannot undo a sign-in/);
    });

    it('undoes one navigation level per back when backs are chained', () => {
      const r = compileProposal(repair([
        click('Service', '/acme/home', 'navigation'), click('Field Actions', '/acme/service'), click('Details', '/acme/service/field-actions'),
        back('/acme/service/details'), back('/acme/service/field-actions'),
        click('Field Bulletins', '/acme/service'), extract('/acme/service/field-bulletins'),
      ]));
      expect(r.script.steps.slice(4).map((st) => st.intent)).toEqual(['Open Service', 'Open Field Bulletins', 'Read the rows on this page']);
      const fa = '/acme/service/field-actions';
      const single = compileProposal(repair([click('Field Actions', '/acme/service'), extract(fa), next(fa), back(fa), extract(fa)]));
      expect(single.script.steps.slice(4).map((st) => st.intent)).toEqual(['Open Field Actions', 'Read the rows on this page', 'Read the rows on this page']);
    });
  });
  describe('a release that adds TOTP after the base sign-in', () => {
    /** The baseline as a first run compiles it on a site without MFA: a signIn with no totp, then the detect. */
    const noTotpBase = (): Script => {
      const base = structuredClone(baselineScript(portal.url));
      const si = base.steps[0];
      if (!('signIn' in si)) throw new Error('fixture changed');
      delete si.signIn.totp;
      return base;
    };
    const CODE: AgentAction = { tool: 'enter_code', ok: true, url: U('/acme/mfa'), totp: TOTP };
    const SURVEY: AgentAction = { tool: 'dismiss', ok: true, url: U('/acme/survey'), step: { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER } };

    it('folds the code into the base signIn, inserts the interstitial after it and re-anchors the detect', () => {
      const base = noTotpBase();
      // The script lane failed at the detect (index 2): the MFA page showed instead of the home page.
      const r = compileProposal(repair([
        CODE, SURVEY, click('Service', '/acme/home', 'navigation'), click('Recalls & Stop-Sales', '/acme/service'), extract('/acme/service/recalls'),
      ], { base, resumeFrom: 1 }));
      const baseSignIn = base.steps[0] as Extract<Step, { signIn: unknown }>;
      const baseDetect = base.steps[2] as Extract<Step, { detect: unknown }>;
      expect(r.script.steps).toEqual([
        { intent: 'Sign in with an authentication code', signIn: { ...baseSignIn.signIn, totp: TOTP } },
        base.steps[1],
        { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER },
        {
          ...baseDetect, intent: 'Check sign-in worked (after the code)',
          detect: { ...baseDetect.detect, checks: { ...baseDetect.detect.checks, logged_in: link('Service', 'navigation') } },
        },
        { intent: 'Open Service', click: link('Service', 'navigation') },
        { intent: 'Open Recalls & Stop-Sales', click: link('Recalls & Stop-Sales', 'main'), checkpoint: true, expect: { url: '/acme/service/recalls' } },
        READ,
      ]);
      // The agent changed the login block: prove replays it in full (it cannot reuse the healing session's state).
      expect(r.suffixFrom).toBe(0);
      // ...and the approver sees it: the change list names every changed login step.
      const changes = stepChanges(base, r.script);
      const shown = (s: Script, intent: string) => describeStep(flattenSteps(s.steps).find((x) => x.intent === intent) as Step);
      expect(changes).toContainEqual({ was: shown(base, 'Sign in'), now: shown(r.script, 'Sign in with an authentication code') });
      // stepChanges pairs removals and additions in order, so the detect and the new dismiss are paired as they fall.
      expect(changes.map((c) => c.was)).toContain(shown(base, 'Check sign-in worked'));
      expect(changes.map((c) => c.now)).toEqual(expect.arrayContaining([shown(r.script, 'Check sign-in worked (after the code)'), shown(r.script, 'Dismiss Remind me later')]));
      // The intents the release wrote (those the base does not have) name no portal words.
      const baseIntents = new Set(flattenSteps(base.steps).map((x) => x.intent));
      for (const { intent } of flattenSteps(r.script.steps)) if (!baseIntents.has(intent)) expect(intent).not.toMatch(/\b(portal|recall|notice|dealer)s?\b/i);
      // The code stays a generated value: no secret, no literal code anywhere in the script.
      const text = JSON.stringify(r.script);
      expect(text).not.toContain(SECRETS.totpSecret as string);
      expect(text).not.toContain(SECRETS.password);
    });
    it('also folds when the agent restarted before the login block, and keeps leading overlay interrupts', () => {
      const r = compileProposal(repair([
        { tool: 'dismiss', ok: true, url: U('/acme/mfa'), interrupt: COOKIE }, CODE, click('Service', '/acme/home', 'navigation'), extract('/acme/service'),
      ], { base: noTotpBase(), resumeFrom: -1 }));
      expect(r.script.steps[0]).toMatchObject({ signIn: { totp: TOTP } });
      expect(r.script.steps.map((st) => st.intent)).toEqual(['Sign in with an authentication code', 'Skip the survey', 'Check sign-in worked (after the code)', 'Open Service', 'Read the rows on this page']);
      expect(r.script.interrupts).toContainEqual(COOKIE);
    });
    // Regression: an interstitial dismissed before the code sent the repair down the re-anchored-detect branch, which
    // dropped the code: the signed steps signed in without it, and prove failed on the code page.
    it('also folds when the agent dismissed an interstitial before entering the code', () => {
      const base = noTotpBase();
      const r = compileProposal(repair([SURVEY, CODE, click('Service', '/acme/home', 'navigation'), extract('/acme/service')], { base, resumeFrom: 1 }));
      expect(r.script.steps.map((st) => st.intent)).toEqual([
        'Sign in with an authentication code', 'Skip the survey', 'Dismiss Remind me later', 'Check sign-in worked (after the code)', 'Open Service', 'Read the rows on this page',
      ]);
      expect(r.script.steps[0]).toMatchObject({ signIn: { totp: TOTP } });
      // A changed login block: prove replays it in full, not from the healing session's pre-detect state.
      expect(r.suffixFrom).toBe(0);
      expect(r.resumeAt).toBeUndefined();
    });
    it('still refuses a code entered anywhere else', () => {
      // After a navigation, a code has no sign-in to attach to.
      expect(() => compileProposal(repair([click('Service', '/acme/home', 'navigation'), CODE, extract('/acme/service')], { base: noTotpBase(), resumeFrom: 1 })))
        .toThrow(/without a sign-in step/);
      // Past the login block (the prefix holds later steps), a code cannot be folded into the base sign-in.
      expect(() => compileProposal(repair([CODE, extract('/acme/service')], { base: noTotpBase(), resumeFrom: 3 }))).toThrow(/without a sign-in step/);
    });
    it('does not fold when the prefix already holds the whole login block (resumeFrom === loginEnd, or an escalation)', () => {
      // The detect passed, so the script lane did not restart inside the login block: a code here is not the base's.
      expect(() => compileProposal(repair([CODE, click('Service', '/acme/home', 'navigation'), extract('/acme/service')], { base: noTotpBase(), resumeFrom: 2 })))
        .toThrow(/without a sign-in step/);
    });
  });
  describe('a release that hides the base detect\'s logged-in landmark', () => {
    const MENU: AgentAction = { tool: 'click', ok: true, url: U('/acme/home'), step: { intent: 'Click ☰ Menu', click: { role: 'button', name: '☰ Menu', exact: true } } };
    const GOT_IT: Locator = { role: 'button', name: 'Got it', exact: true };
    const MODAL: AgentAction = { tool: 'dismiss', ok: true, url: U('/acme/home'), step: { intent: 'Dismiss Got it', when: { visible: GOT_IT }, click: GOT_IT } };

    it('re-anchors the detect on the first click after sign-in and inserts the interstitial before it', () => {
      const base = baselineScript(portal.url);
      // The script lane failed at the detect (index 2): the sign-in went through, but the nav link the detect waits for
      // now sits behind a menu button. The agent went on from the healing session without signing in again.
      const r = compileProposal(repair([MODAL, MENU, click('Compliance', '/acme/home', 'navigation'), extract('/acme/compliance')], { base, resumeFrom: 1 }));
      const baseDetect = base.steps[2] as Extract<Step, { detect: unknown }>;
      expect(r.script.steps.slice(0, 4)).toEqual([
        base.steps[0],
        base.steps[1],
        { intent: 'Dismiss Got it', when: { visible: GOT_IT }, click: GOT_IT },
        {
          ...baseDetect, intent: 'Check sign-in worked (new page after sign-in)',
          detect: { ...baseDetect.detect, checks: { ...baseDetect.detect.checks, logged_in: { role: 'button', name: '☰ Menu', exact: true } } },
        },
      ]);
      expect(r.script.steps.slice(4).map((st) => st.intent)).toEqual(['Click ☰ Menu', 'Open Compliance', 'Read the rows on this page']);
      // The base sign-in and its own conditional steps are unchanged; the first changed step is where the detect stood.
      expect(r.suffixFrom).toBe(2);
      // The approver sees the changed detect in the change list.
      const changes = stepChanges(base, r.script);
      expect(changes.map((c) => c.now)).toContain(describeStep(r.script.steps[3]));
    });
    it('refuses when the agent clicked nothing after sign-in (no landmark to anchor the detect on)', () => {
      expect(() => compileProposal(repair([MODAL, extract('/acme/home')], { base: baselineScript(portal.url), resumeFrom: 1 })))
        .toThrow(/successful sign-in looks like/);
    });
  });
  describe('exploration loops', () => {
    /** A navigation click that started on `at`, seen there in page state `state` (default: the path). */
    const nav = (name: string, at: string, landmark = 'navigation', state = at): AgentAction => ({ ...click(name, at, landmark), pageState: state });
    const FIRST_RUN = { base: undefined, resumeFrom: -1, version: 1 } as const;
    const signedIn: AgentAction = { ...SIGN_IN, pageState: '/acme/login' };

    it('cuts the 15-step bootstrap shape (Vehicles, Sales, Reports three times) down to the path that reaches the rows', () => {
      const loop = [nav('Vehicles', '/acme/home')];
      for (let n = 0; n < 3; n++) loop.push(nav('Sales', '/acme/vehicles'), nav('Reports', '/acme/sales'), nav('Vehicles', '/acme/reports'));
      const actions = [signedIn, ...loop, nav('Service', '/acme/vehicles'), nav('Recalls & Stop-Sales', '/acme/service', 'main'), { ...extract('/acme/service/recalls'), pageState: '/acme/service/recalls' }];
      const r = compileProposal(repair(actions, FIRST_RUN));
      expect(r.script.steps.map((s) => s.intent)).toEqual([
        'Sign in', 'Check sign-in worked', 'Open Vehicles', 'Open Service', 'Open Recalls & Stop-Sales', 'Read the rows on this page',
      ]);
      expect(r.script.steps[1]).toMatchObject({ detect: { checks: { logged_in: link('Vehicles', 'navigation') } } });
      expect(r.script.steps[4]).toMatchObject({ checkpoint: true, expect: { url: '/acme/service/recalls' } });
    });
    it('never cuts across a fill, select, dismiss or code, nor when the page state differs on return', () => {
      const fill: AgentAction = { tool: 'fill', ok: true, url: U('/acme/sales'), pageState: '/acme/sales', step: { intent: 'Fill Search', fill: { field: { css: '#q' }, value: 'x' } } };
      const withFill = compileProposal(repair([
        nav('Sales', '/acme/vehicles'), fill, nav('Reports', '/acme/sales'), nav('Vehicles', '/acme/reports'), nav('Service', '/acme/vehicles'), extract('/acme/service'),
      ]));
      expect(withFill.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open Sales', 'Fill Search', 'Open Reports', 'Open Vehicles', 'Open Service', 'Read the rows on this page']);
      const survey: AgentAction = { tool: 'dismiss', ok: true, url: U('/acme/sales'), pageState: '/acme/sales#survey', step: { intent: 'Dismiss Remind me later', when: { visible: LATER }, click: LATER } };
      const withDismiss = compileProposal(repair([
        nav('Sales', '/acme/vehicles'), survey, nav('Reports', '/acme/sales'), nav('Vehicles', '/acme/reports'), nav('Service', '/acme/vehicles'), extract('/acme/service'),
      ]));
      expect(withDismiss.script.steps.slice(4).map((s) => s.intent)).toContain('Dismiss Remind me later');
      expect(withDismiss.script.steps.slice(4).map((s) => s.intent)).toContain('Open Sales');
      // Same URL, different page state (a tab opened, a menu expanded): the return is not the same page.
      const changed = compileProposal(repair([
        nav('Sales', '/acme/vehicles'), nav('Vehicles', '/acme/sales'), nav('Service', '/acme/vehicles', 'navigation', '/acme/vehicles#menu-open'), extract('/acme/service'),
      ]));
      expect(changed.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open Sales', 'Open Vehicles', 'Open Service', 'Read the rows on this page']);
      // A single click whose start and end states match is never cut (its effect may not show in the fingerprint).
      const single = compileProposal(repair([nav('Closed', '/acme/service', 'main', 'S'), { ...extract('/acme/service'), pageState: 'S' }]));
      expect(single.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open Closed', 'Read the rows on this page']);
      // Nor a run that never passes through a different state.
      const flat = compileProposal(repair([nav('A', '/acme/service', 'main', 'S'), nav('B', '/acme/service', 'main', 'S'), { ...extract('/acme/service'), pageState: 'S' }]));
      expect(flat.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open A', 'Open B', 'Read the rows on this page']);
      // Without a recorded page state nothing is cut.
      const unknown = compileProposal(repair([
        click('Sales', '/acme/vehicles'), click('Vehicles', '/acme/sales'), click('Service', '/acme/vehicles'), extract('/acme/service'),
      ]));
      expect(unknown.script.steps.slice(4)).toHaveLength(4);
    });
    it('keeps the extract and its pagination, and keeps the path when the loop is the last thing before the read', () => {
      const at = '/acme/service/field-actions';
      const r = compileProposal(repair([
        nav('Field Actions', '/acme/service', 'main'), nav('Service', at), nav('Field Actions', '/acme/service', 'main'),
        { ...extract(at), pageState: at }, { ...next(at), pageState: `${at}?p=1` }, { ...extract(at), pageState: `${at}?p=2` },
      ]));
      expect(r.script.steps.slice(4).map((s) => s.intent)).toEqual(['Open Field Actions', 'Read every page']);
    });
  });
  describe('field extraction', () => {
    /** The baseline with its paginated extract reading per-item fields. */
    const withFields = (): Script => {
      const base = structuredClone(baselineScript(portal.url));
      const read = base.steps[5];
      if (!('paginate' in read) || !('extract' in read.paginate.each[0])) throw new Error('fixture changed');
      read.paginate.each[0].extract.item = { css: 'tr' };
      read.paginate.each[0].extract.fields = { title: { pattern: 'Title: (.+)' } };
      return base;
    };
    it('finds item/field reads anywhere, including inside paginate', () => {
      expect(extractsFields(baselineScript(portal.url).steps)).toBe(false);
      expect(extractsFields(withFields().steps)).toBe(true);
      const itemOnly = structuredClone(baselineScript(portal.url));
      itemOnly.steps.push({ intent: 'Read rows', extract: { scope: { css: 'main' }, item: { css: 'tr' }, idPattern: 'N26-\\d{4}' } });
      expect(extractsFields(itemOnly.steps)).toBe(true);
    });
    it('flags extract-fields-dropped when the base read fields and the compiled script does not', () => {
      const actions = [click('Field Actions', '/acme/service'), extract('/acme/service/field-actions')];
      expect(EXTRACT_FIELDS_DROPPED).toBe('extract-fields-dropped');
      expect(compileProposal(repair(actions, { base: withFields() })).safetyFlags).toContain(EXTRACT_FIELDS_DROPPED);
      expect(compileProposal(repair(actions)).safetyFlags).not.toContain(EXTRACT_FIELDS_DROPPED);
      // A first run has no base to drop fields from.
      const first = compileProposal(repair([SIGN_IN, click('Service', '/acme/home', 'navigation'), extract('/acme/service')], { base: undefined, resumeFrom: -1, version: 1 }));
      expect(first.safetyFlags).not.toContain(EXTRACT_FIELDS_DROPPED);
    });
  });
});

describe('compile never drops, changes or adds a form submission (defence in depth)', () => {
  const SUBMIT: Step = { intent: 'Export the report', submit: { button: { role: 'button', name: 'Export', exact: true }, path: '/acme/reports/export' } };
  const VIA: Step = { intent: 'Export CSV', download: { trigger: { role: 'button', name: 'Export CSV', exact: true }, via: { path: '/acme/reports/export' } } };
  const withStepAt = (index: number, step: Step): Script => {
    const base = baselineScript(portal.url);
    const steps = [...base.steps];
    steps.splice(index, 0, step);
    return { ...base, steps };
  };
  const HEALED = [click('Field Actions', '/acme/service'), extract('/acme/service/field-actions')];
  const issuesOf = (fn: () => unknown): string[] => {
    try { fn(); } catch (err) { if (err instanceof CompileError) return err.issues; throw err; }
    throw new Error('expected a CompileError');
  };

  it('refuses a repair that resumes before a base submit (the submit would be dropped or rebuilt)', () => {
    // baseline: 0 signIn, 1 survey, 2 detect, 3 Service, 4 Recalls, 5 paginate; the submit lands at 6; resumeFrom 3 keeps 0-3.
    expect(issuesOf(() => compileProposal(repair(HEALED, { base: withStepAt(6, SUBMIT) })))).toEqual([COMPILE_TOUCHES_SUBMIT]);
  });
  it('treats a submit nested in paginate and a download through a form the same way', () => {
    const nested = baselineScript(portal.url);
    const pages = nested.steps[5];
    if (!('paginate' in pages)) throw new Error('fixture changed');
    pages.paginate.each.push(SUBMIT);
    expect(issuesOf(() => compileProposal(repair(HEALED, { base: nested })))).toEqual([COMPILE_TOUCHES_SUBMIT]);
    expect(issuesOf(() => compileProposal(repair(HEALED, { base: withStepAt(6, VIA) })))).toEqual([COMPILE_TOUCHES_SUBMIT]);
  });
  it('keeps a base submit inside the proven prefix, unchanged', () => {
    const base = withStepAt(3, SUBMIT); // 0 signIn, 1 survey, 2 detect, 3 submit, 4 Service, …
    const r = compileProposal(repair(HEALED, { base }));
    expect(r.script.steps[3]).toEqual(SUBMIT);
    expect(r.suffixFrom).toBe(4);
  });
  it('refuses an agent action whose step submits a form, even to an allowed target', () => {
    const sneaky: AgentAction = { tool: 'click', ok: true, url: U('/acme/service'), step: SUBMIT };
    expect(issuesOf(() => compileProposal(repair([sneaky, ...HEALED])))).toEqual([COMPILE_EMITS_SUBMIT]);
    const viaAction: AgentAction = { tool: 'click', ok: true, url: U('/acme/service'), step: VIA };
    expect(issuesOf(() => compileProposal(repair([viaAction, ...HEALED])))).toEqual([COMPILE_EMITS_SUBMIT]);
  });
});

describe('download tasks', () => {
  const TEMPLATE = { mime: ['text/csv'], maxBytes: 1000000, check: { name: 'report-*.csv', columns: ['Id'] } };
  const TRIGGER: Locator = { role: 'button', name: 'Export CSV', exact: true };
  const dl = (at: string, check = TEMPLATE.check): AgentAction => ({
    tool: 'download', ok: true, url: U(at), step: { intent: 'Download with Export CSV', download: { trigger: TRIGGER, ...TEMPLATE, check } },
  });
  const typed = (tool: 'fill' | 'select', value: string, at = '/acme/service'): AgentAction => ({
    tool, ok: true, url: U(at), step: { intent: 'Type', [tool]: { field: { label: 'From', exact: true }, value } } as unknown as Step,
  });
  const VARS = { from: '2026-09-01', to: '2026-09-30' };
  it('a download action compiles to a download step with a checkpointed click before it', () => {
    const r = compileProposal(repair([look('/acme/service'), click('Reports', '/acme/service'), dl('/acme/reports'), doneA('/acme/reports')], { download: TEMPLATE }));
    expect(r.script.steps.slice(4)).toEqual([
      { intent: 'Open Reports', click: link('Reports', 'main'), checkpoint: true, expect: { url: '/acme/reports' } },
      { intent: 'Download with Export CSV', download: { trigger: TRIGGER, ...TEMPLATE } },
    ]);
  });
  it('a changed check is refused', () => {
    const run = () => compileProposal(repair([click('Reports', '/acme/service'), dl('/acme/reports', { name: 'other-*.csv', columns: ['Id'] })], { download: TEMPLATE }));
    expect(run).toThrow(CompileError);
    expect(run).toThrow(COMPILE_CHANGES_FILE_CHECK);
  });
  it('typed values equal to one variable compile to the variable', () => {
    const r = compileProposal(repair([click('Reports', '/acme/service'), typed('fill', '2026-09-01', '/acme/reports'), typed('select', '2026-09-30', '/acme/reports'), dl('/acme/reports')], { download: TEMPLATE, vars: VARS }));
    const s = r.script.steps.slice(4);
    expect(s[1]).toMatchObject({ fill: { value: '{{var.from}}' } });
    expect(s[2]).toMatchObject({ select: { value: '{{var.to}}' } });
  });
  it('two variables with the same value leave the literal', () => {
    const r = compileProposal(repair([click('Reports', '/acme/service'), typed('fill', '2026-09-01', '/acme/reports'), dl('/acme/reports')], { download: TEMPLATE, vars: { from: '2026-09-01', to: '2026-09-01' } }));
    expect(r.script.steps[5]).toMatchObject({ fill: { value: '2026-09-01' } });
  });
  it('base steps before suffixFrom are never rewritten', () => {
    const base: Script = baselineScript(portal.url);
    const withFill: Script = { ...base, steps: [...base.steps.slice(0, 4), { intent: 'Type', fill: { field: { label: 'From', exact: true }, value: '2026-09-01' } }, ...base.steps.slice(4)] };
    const r = compileProposal(repair([click('Reports', '/acme/service'), dl('/acme/reports')], { base: withFill, resumeFrom: 4, download: TEMPLATE, vars: VARS }));
    expect(r.script.steps[4]).toMatchObject({ fill: { value: '2026-09-01' } });
  });

  describe('a base download whose trigger click opened a dialog (keepTriggerClick)', () => {
    // Base: sign-in, Service, Reports (index 4), then the signed download (index 5) whose "Export" now opens a dialog.
    const EXPORT: Locator = { role: 'button', name: 'Export', fallbacks: [{ css: '#export' }] };
    const BASE_DL: Step = { intent: 'Export the report', download: { trigger: EXPORT, ...TEMPLATE } };
    const dialogBase = (): Script => {
      const b = baselineScript(portal.url);
      return { ...b, steps: [...b.steps.slice(0, 4), { intent: 'Open Reports', click: link('Reports', 'main') }, BASE_DL] };
    };
    const RADIO: Locator = { role: 'radio', name: 'Comma-separated (CSV)' };
    const radio: AgentAction = { tool: 'click', ok: true, url: U('/acme/reports'), step: { intent: 'Click Comma-separated (CSV)', click: RADIO } };
    const cont = (check = TEMPLATE.check): AgentAction => ({
      tool: 'download', ok: true, url: U('/acme/reports'), step: { intent: 'Download with Continue', download: { trigger: { role: 'button', name: 'Continue' }, ...TEMPLATE, check } },
    });
    const keep = (actions: AgentAction[], over: Partial<CompileInput> = {}) =>
      compileProposal(repair(actions, { base: dialogBase(), resumeFrom: 4, download: TEMPLATE, keepTriggerClick: { index: 5 }, ...over }));

    it('replays the base trigger click at the failure position, then the agent steps', () => {
      const r = keep([radio, cont(), doneA('/acme/reports')]);
      expect(r.suffixFrom).toBe(6);
      expect(r.script.steps.slice(0, 5)).toEqual(dialogBase().steps.slice(0, 5));
      expect(r.script.steps.slice(5)).toEqual([
        { intent: 'Open Export', click: EXPORT },
        { intent: 'Click Comma-separated (CSV)', click: RADIO, checkpoint: true, expect: { url: '/acme/reports' } },
        { intent: 'Download with Continue', download: { trigger: { role: 'button', name: 'Continue' }, ...TEMPLATE } },
      ]);
      // The approver sees the click where the download was.
      const changes = stepChanges(dialogBase(), r.script);
      expect(changes).toContainEqual({ was: describeStep(BASE_DL), now: describeStep({ intent: 'Open Export', click: EXPORT }) });
    });
    it('without it, the output is unchanged', () => {
      const r = compileProposal(repair([radio, cont(), doneA('/acme/reports')], { base: dialogBase(), resumeFrom: 4, download: TEMPLATE }));
      expect(r.suffixFrom).toBe(5);
      expect(r.script.steps.slice(5).map((s) => s.intent)).toEqual(['Click Comma-separated (CSV)', 'Download with Continue']);
    });
    it('the kept click carries the checkpoint when the agent only downloaded', () => {
      const r = keep([cont(), doneA('/acme/reports')]);
      expect(r.script.steps.slice(5)).toEqual([
        { intent: 'Open Export', click: EXPORT, checkpoint: true, expect: { url: '/acme/reports' } },
        { intent: 'Download with Continue', download: { trigger: { role: 'button', name: 'Continue' }, ...TEMPLATE } },
      ]);
      expect(r.suffixFrom).toBe(6);
    });
    it('variables never rewrite it, and the file-check guard still sees one download', () => {
      const typedFrom: AgentAction = { tool: 'fill', ok: true, url: U('/acme/reports'), step: { intent: 'Type', fill: { field: { label: 'From', exact: true }, value: 'Export' } } };
      const r = keep([typedFrom, radio, cont()], { vars: { what: 'Export' } });
      expect(r.script.steps[5]).toEqual({ intent: 'Open Export', click: EXPORT });
      expect(r.script.steps[6]).toMatchObject({ fill: { value: '{{var.what}}' } });
      expect(flattenSteps(r.script.steps).filter((s) => 'download' in s)).toHaveLength(1);
      expect(() => keep([radio, cont({ name: 'other-*.csv', columns: ['Id'] })])).toThrow(COMPILE_CHANGES_FILE_CHECK);
    });
    it('refuses a keepTriggerClick that is not the base download right after the kept prefix', () => {
      expect(() => keep([radio, cont()], { keepTriggerClick: { index: 4 } })).toThrow(CompileError);
      expect(() => keep([radio, cont()], { resumeFrom: 3 })).toThrow(CompileError);
      const noDownload = dialogBase();
      noDownload.steps[5] = { intent: 'Open Export', click: EXPORT };
      expect(() => keep([radio, cont()], { base: noDownload })).toThrow(CompileError);
    });
  });
});

describe('repeated fills collapse', () => {
  const F = (name: string): Locator => ({ label: name, exact: true });
  const typedAt = (tool: 'fill' | 'select', name: string, value: string): AgentAction => ({
    tool, ok: true, url: U('/acme/reports'), step: { intent: `Set ${name}`, [tool]: { field: F(name), value } } as unknown as Step,
  });
  const run = (actions: AgentAction[], over: Partial<CompileInput> = {}) =>
    compileProposal(repair([click('Reports', '/acme/service'), ...actions, doneA('/acme/reports')], over)).script.steps.slice(5);
  const values = (steps: Step[]) => steps.map((s) => ('fill' in s ? `fill ${(s.fill.field as { label: string }).label}=${s.fill.value}` : 'select' in s ? `select ${(s.select.field as { label: string }).label}=${s.select.value}` : 'other'));
  it('drops an earlier fill only when every field filled before the next fill of it is filled again after; never reorders', () => {
    expect(values(run([typedAt('fill', 'A', '1'), typedAt('fill', 'A', '2'), typedAt('fill', 'A', '3')]))).toEqual(['fill A=3']);
    const steps = run([typedAt('fill', 'A', '1'), typedAt('fill', 'B', '2'), typedAt('fill', 'A', '3'), typedAt('fill', 'B', '4'), typedAt('fill', 'A', '5')]);
    expect(values(steps)).toEqual(['fill A=3', 'fill B=4', 'fill A=5']);
  });
  it('keeps the order when a field between two fills of another is not filled again (Region, Country, Region)', () => {
    // Choosing a country may reset or reload the region: the first region is kept, and nothing moves.
    const steps = run([typedAt('select', 'Region', 'EU'), typedAt('select', 'Country', 'DE'), typedAt('select', 'Region', 'Bavaria')]);
    expect(values(steps)).toEqual(['select Region=EU', 'select Country=DE', 'select Region=Bavaria']);
  });
  it('a fill gated with when ends the run', () => {
    const gated: AgentAction = { tool: 'fill', ok: true, url: U('/acme/reports'), step: { intent: 'Set A', when: { visible: F('A') }, fill: { field: F('A'), value: 'g' } } as unknown as Step };
    const steps = run([typedAt('fill', 'A', '1'), gated, typedAt('fill', 'A', '2')]);
    expect(steps.map((s) => 'when' in s)).toEqual([false, true, false]);
    expect(values(steps)).toEqual(['fill A=1', 'fill A=g', 'fill A=2']);
  });
  it('keeps different fields', () => {
    expect(values(run([typedAt('fill', 'A', '1'), typedAt('fill', 'B', '2')]))).toEqual(['fill A=1', 'fill B=2']);
  });
  it('does not collapse across a click', () => {
    const steps = run([typedAt('fill', 'A', '1'), click('Apply', '/acme/reports'), typedAt('fill', 'A', '2')]);
    expect(values(steps)).toEqual(['fill A=1', 'other', 'fill A=2']);
  });
  it('keeps a select and a fill on the same field', () => {
    expect(values(run([typedAt('select', 'A', '1'), typedAt('fill', 'A', '2')]))).toEqual(['select A=1', 'fill A=2']);
  });
  it('still substitutes variables into the kept fill', () => {
    const steps = run([typedAt('fill', 'A', 'x'), typedAt('fill', 'A', '2026-09-01')], { vars: { from: '2026-09-01' } });
    expect(values(steps)).toEqual(['fill A={{var.from}}']);
  });
  it('never touches the kept base steps', () => {
    const base = baselineScript(portal.url);
    const dup: Step = { intent: 'Set A', fill: { field: F('A'), value: 'old' } };
    const withDup: Script = { ...base, steps: [...base.steps.slice(0, 4), dup, ...base.steps.slice(4)] };
    const r = compileProposal(repair([typedAt('fill', 'A', 'new'), doneA('/acme/reports')], { base: withDup, resumeFrom: 4 }));
    expect(r.script.steps[4]).toEqual(dup);
    expect(values(r.script.steps.slice(5))).toEqual(['fill A=new']);
  });
});
