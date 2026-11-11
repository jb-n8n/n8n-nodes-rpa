import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { laneMasker, runScriptLane, screenshotMasks } from '../src/lane/script-lane.js';
import { checkTrust } from '../src/lane/trust.js';
import { INPUT_CONTAINS_SECRET, PASSWORD_FILL_REFUSED_STEPS, UNSIGNED_SECRET_FILL } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { registerSecretVars, secretFillValues } from '../src/secrets/secret-fills.js';
import { parseScript, ScriptShapeError } from '../src/steps/parse.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, Step } from '../src/types.js';
import { LOCAL, SECRETS, signedLaneInput } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const pub = (): PortalPolicy => ({
  startUrl: `${portal.url}/public/form`, navHosts: [portal.host], subresourceHosts: [], login: [], allowedSubmits: [],
  writeMode: 'block', allowPrivateNetwork: true,
});
const EXPORT_PW = 'Zip-9f3k-2xq';
const secretFill = (value: string, over: Record<string, unknown> = {}): Step =>
  ({ intent: 'Type the export password', fill: { field: { label: 'Password' }, value, secret: true, ...over } }) as Step;

/** Runs steps on /public/form with a live masker, as a signed run does unless `signed` is false. */
async function direct(steps: Step[], vars: Record<string, string>, opts: { signed?: boolean; masker?: ReturnType<typeof createMasker> } = {}) {
  const masker = opts.masker ?? createMasker([]);
  const s = await openSession({ endpoint: LOCAL, policy: pub(), masker });
  await s.page.goto(`${portal.url}/public/form`);
  const ctx: StepContext = {
    page: s.page, script: { name: 't', version: 1, startUrl: `${portal.url}/public/form`, steps }, policy: pub(), vars,
    masker, defaultTimeoutMs: 2000, violations: s.violations, ...(opts.signed === false ? {} : { signed: true }),
  };
  return { s, ctx, masker, r: await runSteps(ctx, steps) };
}

describe('fill.secret: parse', () => {
  const issues = (step: unknown): string[] => {
    try { parseScript({ startUrl: portal.url, steps: [step] }); return []; } catch (e) { return (e as ScriptShapeError).issues; }
  };
  it('accepts secret: true with exactly one {{var.name}} template, spaces inside the braces included', () => {
    expect(issues(secretFill('{{var.exportPassword}}'))).toEqual([]);
    expect(issues(secretFill('{{ var.exportPassword }}'))).toEqual([]);
  });
  it('refuses a template with text around it, two templates, a literal, a secret template and a reserved one', () => {
    for (const value of ['pre-{{var.p}}', '{{var.p}} ', '{{var.p}}{{var.q}}', 'literal', '{{secret.password}}', '{{$exportDir}}', '{{var.p-x}}']) {
      expect(issues(secretFill(value)).join(), value).toMatch(/exactly one \{\{var\./);
    }
  });
  it('refuses a secret that is not a boolean, and secret on select or check', () => {
    expect(issues(secretFill('{{var.p}}', { secret: 'yes' })).join()).toMatch(/secret must be a boolean/);
    expect(issues({ intent: 's', select: { field: { label: 'A' }, value: '{{var.p}}', secret: true } }).join()).toMatch(/unknown key "secret"/);
  });
  it('secret: false keeps the ordinary rules, so any value stays allowed', () => {
    expect(issues(secretFill('literal', { secret: false }))).toEqual([]);
  });
});

describe('fill.secret: running', () => {
  it('without secret a password input is still refused, with a var template too', async () => {
    const { s, r } = await direct([{ intent: 'Type', fill: { field: { label: 'Password' }, value: '{{var.pw}}' } }], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(PASSWORD_FILL_REFUSED_STEPS);
      expect(await s.page.inputValue('input[name=password]')).toBe('');
    } finally { await s.close(); }
  });
  it('with secret and a var template the password input gets the value', async () => {
    const { s, r } = await direct([secretFill('{{var.pw}}')], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(true);
      expect(await s.page.inputValue('input[name=password]')).toBe(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('secret also works on an ordinary input', async () => {
    const { s, r } = await direct([secretFill('{{var.pw}}', { field: { label: 'Name' } })], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(true);
      expect(await s.page.inputValue('input[name=name]')).toBe(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('adds the value to the masker before typing: a later error message and the step log show [secret]', async () => {
    const steps: Step[] = [
      secretFill('{{var.pw}}'),
      { intent: "Find the link", timeoutMs: 300, click: { css: `a[title="${EXPORT_PW}"]` } },
    ];
    const { s, masker, r } = await direct(steps, { pw: EXPORT_PW });
    try {
      expect(masker.containsSecret(EXPORT_PW)).toBe(true);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure.message).toContain('[secret]');
      expect(r.failure.message).not.toContain(EXPORT_PW);
      expect(JSON.stringify(r.state.log)).not.toContain(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('masks the value from the run start: an earlier step\'s error and log show [secret], and an earlier template use is refused', async () => {
    const steps: Step[] = [
      { intent: 'Find the link', optional: true, timeoutMs: 300, click: { css: `a[title="${EXPORT_PW}"]` } },
      { intent: 'Find the link by input', optional: true, timeoutMs: 300, click: { text: 'Open {{var.pw}}' } },
      { intent: 'Type the name', fill: { field: { label: 'Name' }, value: '{{var.pw}}' } },
      secretFill('{{var.pw}}'),
    ];
    const { s, masker, r } = await direct(steps, { pw: EXPORT_PW });
    try {
      expect(masker.containsSecret(EXPORT_PW)).toBe(true);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.failure.index).toBe(2);
      expect(r.failure.message).toBe(INPUT_CONTAINS_SECRET);
      expect(r.state.log[0].note).toContain('[secret]');
      expect(r.state.log[1].note).toBe(INPUT_CONTAINS_SECRET);
      expect(JSON.stringify(r)).not.toContain(EXPORT_PW);
      expect(await s.page.inputValue('input[name=name]')).toBe('');
    } finally { await s.close(); }
  });
  it('a secret fill after the run-start masking still types the value, also as a second use', async () => {
    const { s, r } = await direct([secretFill('{{var.pw}}', { field: { label: 'Name' } }), secretFill('{{var.pw}}')], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(true);
      expect(await s.page.inputValue('input[name=password]')).toBe(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('the same variable can be typed by a second secret fill', async () => {
    const { s, r } = await direct([secretFill('{{var.pw}}'), secretFill('{{var.pw}}', { field: { label: 'Name' } })], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(true);
      expect(await s.page.inputValue('input[name=name]')).toBe(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('a value with text around the template is refused at run time too, and types nothing', async () => {
    const { s, r } = await direct([secretFill('x{{var.pw}}')], { pw: EXPORT_PW });
    try {
      expect(r.ok).toBe(false);
      expect(await s.page.inputValue('input[name=password]')).toBe('');
    } finally { await s.close(); }
  });
  it('an unsigned run refuses secret fills, before typing', async () => {
    const { s, r, ctx } = await direct([secretFill('{{var.pw}}')], { pw: EXPORT_PW }, { signed: false });
    try {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(UNSIGNED_SECRET_FILL);
      expect(ctx.violations.some((v) => v.fatal)).toBe(true);
      expect(await s.page.inputValue('input[name=password]')).toBe('');
    } finally { await s.close(); }
  });
  it.each([['password', SECRETS.password], ['username', SECRETS.username], ['TOTP seed', SECRETS.totpSecret as string]])(
    'refuses a variable that holds the Site Login %s', async (_n, value) => {
      const { s, r } = await direct([secretFill('{{var.pw}}')], { pw: value }, { masker: createMasker([SECRETS.username, SECRETS.password, SECRETS.totpSecret]) });
      try {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failure.message).toBe(INPUT_CONTAINS_SECRET);
        expect(await s.page.inputValue('input[name=password]')).toBe('');
      } finally { await s.close(); }
    });
});

describe('fill.secret: trust and the lane', () => {
  const FILL = secretFill('{{var.pw}}');
  const doc = () => ({ name: 'export', version: 1, startUrl: `${portal.url}/public/form`, steps: [FILL] });
  it('the trust gate refuses unsigned steps with a secret fill, also with Allow Unsigned Writes', () => {
    const unsigned = { name: 'export', version: 1, startUrl: `http://127.0.0.1:9/public/form`, steps: [FILL] };
    for (const trust of [{ required: false }, { required: false, allowUnsignedWrites: true }]) {
      expect(checkTrust(unsigned, trust, { policy: pub(), firstRun: false })).toEqual({ ok: false, code: 'script_untrusted', message: UNSIGNED_SECRET_FILL });
    }
  });
  it('a signed run types the value; the result, log and trace-bound strings never show it', async () => {
    const steps: Step[] = [secretFill('{{var.pw}}'), { intent: 'Done', waitFor: { target: { css: 'form#contact' } } }];
    const r = await runScriptLane(signedLaneInput({ ...doc(), steps }, {
      policy: pub(), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: { pw: EXPORT_PW }, saveTrace: 'never' as const,
    }));
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(EXPORT_PW);
  });
  it('an unsigned lane run fails script_untrusted before any browser opens', async () => {
    const r = await runScriptLane({
      script: doc(), trust: { required: false, allowUnsignedWrites: true }, policy: pub(), endpoint: LOCAL, vars: { pw: EXPORT_PW },
    });
    expect(r).toMatchObject({ ok: false, code: 'script_untrusted' });
  });
});

describe('secret variables (TaskInput.secretVars, the RPA Secret Variables credential in n8n)', () => {
  const VARS = { pw: EXPORT_PW, plain: 'Widget-77' };
  const masker = (secrets?: typeof SECRETS) => laneMasker({ endpoint: LOCAL, ...(secrets ? { secrets } : {}), vars: VARS, secretVars: ['pw'] });
  it('the run masker holds a secret variable from the start, whether or not a step uses it, and nothing else', () => {
    const m = masker();
    expect(m.mask(`a ${EXPORT_PW} b Widget-77`)).toBe('a [secret] b Widget-77');
    expect(secretFillValues(m).has(EXPORT_PW)).toBe(true);
    // Names that are not given, empty values and repeated calls change nothing.
    registerSecretVars(['pw', 'missing'], { ...VARS, missing: '' }, m);
    expect(m.secrets.filter((s) => s === EXPORT_PW)).toHaveLength(1);
    expect(laneMasker({ endpoint: LOCAL, vars: VARS }).mask(EXPORT_PW)).toBe(EXPORT_PW);
  });
  it('a secret variable that holds a Site Login secret is masked but never made typable', () => {
    const m = laneMasker({ endpoint: LOCAL, secrets: SECRETS, vars: { pw: SECRETS.password }, secretVars: ['pw'] });
    expect(m.mask(SECRETS.password)).toBe('[secret]');
    expect(secretFillValues(m).has(SECRETS.password)).toBe(false);
  });
  it('a secret fill types it; a plain fill, a locator and a condition that render it are refused, and nothing shows it', async () => {
    const typed = await direct([secretFill('{{var.pw}}')], VARS, { masker: masker() });
    try {
      expect(typed.r.ok).toBe(true);
      expect(await typed.s.page.inputValue('input[name=password]')).toBe(EXPORT_PW);
    } finally { await typed.s.close(); }
    const uses: Step[][] = [
      [{ intent: 'Type the name', fill: { field: { label: 'Name' }, value: '{{var.pw}}' } }],
      [{ intent: 'Find the link', timeoutMs: 300, click: { text: 'Open {{var.pw}}' } }],
      [{ intent: 'Only when', when: { var: 'pw', equals: 'guess' }, click: { label: 'Name' } }],
    ];
    for (const steps of uses) {
      const { s, r } = await direct(steps, VARS, { masker: masker() });
      try {
        expect(r.ok, JSON.stringify(steps)).toBe(false);
        if (!r.ok) expect(r.failure.message).toBe(INPUT_CONTAINS_SECRET);
        expect(JSON.stringify(r)).not.toContain(EXPORT_PW);
        expect(await s.page.inputValue('input[name=name]')).toBe('');
      } finally { await s.close(); }
    }
  });
  it('an error that quotes the value shows [secret], from the first step on', async () => {
    const steps: Step[] = [{ intent: 'Find the link', timeoutMs: 300, click: { css: `a[title="${EXPORT_PW}"]` } }];
    const { s, r } = await direct(steps, VARS, { masker: masker() });
    try {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toContain('[secret]');
      expect(JSON.stringify(r)).not.toContain(EXPORT_PW);
    } finally { await s.close(); }
  });
  it('screenshots mask the text of a secret variable as they mask the Site Login password', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: pub(), masker: createMasker([]) });
    try {
      expect(screenshotMasks(s.page, undefined, secretFillValues(masker()))).toHaveLength(2);
      expect(screenshotMasks(s.page, undefined, secretFillValues(createMasker([])))).toHaveLength(1);
    } finally { await s.close(); }
  });
  it('a signed lane run with secretVars types the value and its result never shows it; unsigned steps cannot render it', async () => {
    const steps: Step[] = [secretFill('{{var.pw}}'), { intent: 'Done', waitFor: { target: { css: 'form#contact' } } }];
    const doc = { name: 'export', version: 1, startUrl: `${portal.url}/public/form`, steps };
    const ok = await runScriptLane(signedLaneInput(doc, {
      policy: pub(), endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: VARS, secretVars: ['pw'], saveTrace: 'never' as const,
    }));
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok)).not.toContain(EXPORT_PW);
    const plain = { ...doc, steps: [{ intent: 'Type the name', fill: { field: { label: 'Name' }, value: '{{var.pw}}' } }] };
    const refused = await runScriptLane({
      script: plain, trust: { required: false }, policy: pub(), endpoint: LOCAL, defaultStepTimeoutMs: 3000, vars: VARS, secretVars: ['pw'], saveTrace: 'never',
    });
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.message).toContain(INPUT_CONTAINS_SECRET);
    expect(JSON.stringify(refused)).not.toContain(EXPORT_PW);
  });
});
