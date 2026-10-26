import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { formPostsElsewhere, PASSWORD_FILL_REFUSED, PASSWORD_FILL_REFUSED_STEPS, REPAIR_REFUSED_WRITES } from '../src/messages.js';
import { noWritePolicy } from '../src/policy/derive.js';
import { createMasker } from '../src/secrets/mask.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, Script, Step } from '../src/types.js';
import { done, fakeModel } from './fake-model.js';
import { baselineScript, LOCAL, policyFor, reportScript, SECRETS, signedLaneInput } from './helpers.js';

type SessionT = import('../src/browser/session.js').Session;
// Every session the lane opens is recorded; `onOpen.next` runs once, on the next session, before any step.
const { sessions, onOpen } = vi.hoisted(() => ({
  sessions: [] as SessionT[],
  onOpen: { next: undefined as ((s: SessionT) => Promise<void>) | undefined },
}));
vi.mock('../src/browser/session.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/browser/session.js')>();
  return {
    ...mod,
    openSession: async (...args: Parameters<typeof mod.openSession>) => {
      const s = await mod.openSession(...args);
      sessions.push(s);
      const hook = onOpen.next;
      onOpen.next = undefined;
      await hook?.(s);
      return s;
    },
  };
});
// When on, the next pageInfo() throws, so executeScript fails after the steps ran (the lane's catch path).
const { failPageInfo } = vi.hoisted(() => ({ failPageInfo: { on: false } }));
vi.mock('../src/lane/start-page.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/lane/start-page.js')>();
  return {
    ...mod,
    pageInfo: async (...args: Parameters<typeof mod.pageInfo>) => {
      if (failPageInfo.on) {
        failPageInfo.on = false;
        throw new Error('the page could not be read');
      }
      return mod.pageInfo(...args);
    },
  };
});

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); sessions.length = 0; onOpen.next = undefined; });

type Counters = { hits: Record<string, number>; posts: { path: string; name?: string }[]; collect: number; css: number };
const counters = async (): Promise<Counters> => (await fetch(`${portal.url}/public/api/counters`)).json() as Promise<Counters>;

const pub = (over: Partial<PortalPolicy> = {}): PortalPolicy => ({
  startUrl: `${portal.url}/public/form`, navHosts: [portal.host], subresourceHosts: [], login: [], allowedSubmits: [],
  writeMode: 'block', allowPrivateNetwork: true, ...over,
});
const open = (path: string): Step => ({ intent: 'Open the page', goto: `${portal.url}${path}` });
const FILL_NAME: Step = { intent: 'Type the name', fill: { field: { label: 'Name' }, value: '{{var.f0}}' } };
const FILL_MESSAGE: Step = { intent: 'Type the message', fill: { field: { label: 'Message' }, value: '{{var.f1}}' } };
const SEND: Step = { intent: 'Send', click: { role: 'button', name: 'Send' } };
/** The fixture form pages other than /public/form each have exactly one button inside their form. */
const SEND_ANY: Step = { intent: 'Send', click: { css: 'form button' } };
const READ: Step = { intent: 'Read the result', read: { what: 'text' } };
const VARS = { f0: 'Ada Lovelace', f1: 'Kept out of traces' };

/** Unsigned steps, block-and-log writes, and the write window on the step whose intent is "Send" (when there is one). */
function input(steps: Step[], over: Partial<ScriptLaneInput> = {}, policy: Partial<PortalPolicy> = {}): ScriptLaneInput {
  const send = steps.findIndex((s) => s.intent === 'Send');
  return {
    script: { steps }, trust: { required: false }, endpoint: LOCAL, defaultStepTimeoutMs: 5000, vars: VARS,
    policy: pub({ ...(send >= 0 ? { writeWindow: { step: send, maxPosts: 3, hosts: [portal.host] } } : {}), ...policy }),
    ...over,
  };
}

/** Network snapshots in a trace zip whose method is a write, and the request bodies they still carry. */
function writeSnapshots(zip: Buffer): { writes: number; bodies: unknown[] } {
  let writes = 0;
  const bodies: unknown[] = [];
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(zip)))) {
    if (!name.endsWith('.network')) continue;
    for (const line of strFromU8(bytes).split('\n')) {
      let event: { snapshot?: { request?: { method?: string; postData?: unknown } } } | undefined;
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      const req = event?.snapshot?.request;
      if (!req || ['GET', 'HEAD', 'OPTIONS'].includes((req.method ?? '').toUpperCase())) continue;
      writes++;
      if (req.postData !== undefined) bodies.push(req.postData);
    }
  }
  return { writes, bodies };
}

describe('Fill and Submit write window', () => {
  it('/public/form: one POST inside the window is allowed, listed in writes, and the run is submitted', async () => {
    const r = await runScriptLane(input([open('/public/form'), FILL_NAME, FILL_MESSAGE, SEND, READ]));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.writes).toEqual([{ method: 'POST', host: portal.host, path: '/public/form/submit' }]);
    expect(r.submitted).toBe(true);
    expect(r.blockedRequests).toEqual([]);
    expect(r.outputs[0]?.text).toContain('Received from Ada Lovelace');
    expect((await counters()).posts).toEqual([{ path: '/public/form/submit', name: 'Ada Lovelace' }]);
  });

  it('a form action or button formaction on another host fails the step before the click, and nothing is posted', async () => {
    for (const path of ['/public/form-cross', '/public/form-formaction']) {
      portal.reset();
      const r = await runScriptLane(input([open(path), SEND_ANY]));
      expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
      if (!r.ok) {
        expect(r.message).toContain(formPostsElsewhere(`localhost:${portal.port}`, [portal.host]));
        expect(r.submitted).toBeUndefined();
      }
      expect((await counters()).posts).toEqual([]);
    }
  });

  it('a script-submitted form: the fetch POST inside the window is allowed and recorded', async () => {
    const r = await runScriptLane(input([open('/public/form-script'), SEND_ANY, { intent: 'Saved', waitFor: { target: { css: '#saved' } } }]));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.writes).toEqual([{ method: 'POST', host: portal.host, path: '/public/api/submit' }]);
    expect(r.submitted).toBe(true);
    expect((await counters()).posts).toHaveLength(1);
  });

  it('/public/form-many: three POSTs pass, the fourth is blocked and logged, and the run still succeeds', async () => {
    const r = await runScriptLane(input([open('/public/form-many'), SEND_ANY]));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.writes).toEqual(Array.from({ length: 3 }, () => ({ method: 'POST', host: portal.host, path: '/public/api/submit' })));
    expect(r.blockedRequests).toContainEqual({ method: 'POST', host: portal.host, path: '/public/api/submit' });
    expect((await counters()).posts).toHaveLength(3);
  });

  it('/public/form-late: a POST fired 1.5 s after the result page loaded is outside the window: blocked, logged, run ok', async () => {
    const linger: Step = { intent: 'Give the page time', optional: true, timeoutMs: 2500, waitFor: { target: { css: '#not-on-this-page' } } };
    const r = await runScriptLane(input([open('/public/form-late'), SEND_ANY, linger]));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.writes).toHaveLength(1);
    expect(r.blockedRequests).toContainEqual(expect.objectContaining({ method: 'POST', host: portal.host }));
    expect((await counters()).posts).toHaveLength(1);
  });

  it('cancel with the window open: the window closes, no later POST reaches the server, incomplete / run cancelled with submitted, no write body in the trace', async () => {
    const ac = new AbortController();
    let posts = 0;
    // Registered after the session's own route, so it runs first. On the second POST it cancels the run, then lets the
    // session decide (which now refuses everything, because the session is closing).
    onOpen.next = async (s) => {
      await s.context.route('**/public/api/submit', async (route) => {
        if (route.request().method() === 'POST' && ++posts === 2) ac.abort();
        await route.fallback().catch(() => undefined);
      });
    };
    const r = await runScriptLane(input([open('/public/form-many'), SEND_ANY], { signal: ac.signal }));
    expect(r).toMatchObject({ ok: false, code: 'incomplete', message: 'run cancelled', submitted: true });
    expect((await counters()).posts).toHaveLength(1);
    const session = sessions.at(-1) as SessionT;
    expect(session.writeWindow?.isOpen).toBe(false);
    expect(session.writeWindow?.posts).toEqual([{ method: 'POST', host: portal.host, path: '/public/api/submit' }]);
    expect(r.trace).toBeDefined();
    const { writes, bodies } = writeSnapshots(r.trace as Buffer);
    expect(writes).toBeGreaterThan(0);
    expect(bodies).toEqual([]);
  });

  it('refuses to fill a password field (Fill and Submit wording with a window, Run Steps wording without)', async () => {
    const password: Step = { intent: 'Type the password', fill: { field: { label: 'Password' }, value: '{{var.f0}}' } };
    const withWindow = await runScriptLane(input([open('/public/form'), password, SEND]));
    expect(withWindow).toMatchObject({ ok: false, code: 'policy_violation' });
    if (!withWindow.ok) {
      expect(withWindow.message).toContain(PASSWORD_FILL_REFUSED);
      expect(withWindow.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
    }
    const steps = await runScriptLane(input([open('/public/form'), password]));
    expect(steps).toMatchObject({ ok: false, code: 'policy_violation' });
    if (!steps.ok) expect(steps.message).toContain(PASSWORD_FILL_REFUSED_STEPS);
    expect((await counters()).posts).toEqual([]);
  });

  it('the session admits POSTs to the window hosts only while open, at most three, never other methods, once', async () => {
    const other = `localhost:${portal.port}`;
    const policy = pub({ navHosts: [portal.host, other], writeWindow: { step: 0, maxPosts: 3, hosts: [portal.host] } });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      const send = (url: string, method = 'POST', mode: RequestMode = 'same-origin') => s.page.evaluate(
        async ([u, m, md]) => { try { return (await fetch(u, { method: m, mode: md })).type; } catch { return 'blocked'; } },
        [url, method, mode] as const,
      );
      const here = `${portal.url}/public/api/submit`;
      const win = s.writeWindow;
      if (!win) throw new Error('expected a write window');
      expect(await send(here)).toBe('blocked');                                       // not open yet
      win.open();
      expect(win.isOpen).toBe(true);
      expect(await send(here, 'PUT')).toBe('blocked');                                // POST only
      expect(await send(`http://${other}/public/api/submit`, 'POST', 'no-cors')).toBe('blocked'); // a nav host, not a window host
      for (let i = 0; i < 3; i++) expect(await send(here)).not.toBe('blocked');
      expect(await send(here)).toBe('blocked');                                       // the fourth
      win.close();
      win.open();                                                                     // single use
      expect(win.isOpen).toBe(false);
      expect(await send(here)).toBe('blocked');
      expect(win.posts).toEqual(Array.from({ length: 3 }, () => ({ method: 'POST', host: portal.host, path: '/public/api/submit' })));
      expect(s.blockedRequests).toContainEqual({ method: 'PUT', host: portal.host, path: '/public/api/submit' });
      // Five writes were refused (before open, PUT, other host, the fourth, after close); the log is deduped by
      // method, host and path (violations too), so the three refused POSTs to the window host are one entry.
      expect(s.blockedRequests.filter((b) => b.method !== 'GET')).toEqual([
        { method: 'POST', host: portal.host, path: '/public/api/submit' },
        { method: 'PUT', host: portal.host, path: '/public/api/submit' },
        { method: 'POST', host: other, path: '/public/api/submit' },
      ]);
      expect(s.violations.filter((v) => v.kind === 'write')).toHaveLength(3);
      expect(s.violations.every((v) => !v.fatal)).toBe(true);
      expect((await counters()).posts).toHaveLength(3);
    } finally { await s.close(); }
  });

  it('a POST from a sub-frame never uses the window (main-frame writes only)', async () => {
    const policy = pub({ writeWindow: { step: 0, maxPosts: 3, hosts: [portal.host] } });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      await s.page.evaluate(() => new Promise<void>((resolve) => {
        const f = document.createElement('iframe');
        f.srcdoc = '<p>frame</p>';
        f.onload = () => resolve();
        document.body.append(f);
      }));
      const frame = s.page.frames().find((f) => f !== s.page.mainFrame());
      if (!frame) throw new Error('expected a sub-frame');
      s.writeWindow?.open();
      const outcome = await frame.evaluate(async (u) => { try { await fetch(u, { method: 'POST' }); return 'sent'; } catch { return 'blocked'; } }, `${portal.url}/public/api/submit`);
      expect(outcome).toBe('blocked');
      expect(s.writeWindow?.posts).toEqual([]);
      expect((await counters()).posts).toEqual([]);
    } finally { await s.close(); }
  });

  it('a POST with no known frame (a popup navigation issued before its frame exists) never uses the window', async () => {
    const policy = pub({ writeWindow: { step: 0, maxPosts: 3, hosts: [portal.host] } });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    const frameless: boolean[] = [];
    s.context.on('request', (r) => {
      if (r.method() !== 'POST') return;
      try { r.frame(); frameless.push(false); } catch { frameless.push(true); }
    });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      s.writeWindow?.open();
      await s.page.evaluate(() => {
        const f = document.createElement('form');
        f.method = 'post';
        f.action = '/public/form/submit';
        f.target = '_blank';
        document.body.append(f);
        f.submit();
      });
      await expect.poll(() => frameless.length, { timeout: 5000 }).toBeGreaterThan(0);
      expect(frameless[0]).toBe(true);
      await s.idle();
      expect(s.writeWindow?.posts).toEqual([]);
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST' }));
      expect((await counters()).posts).toEqual([]);
    } finally { await s.close(); }
  });

  it('restrict() to a no-write policy closes the window and nothing passes afterwards (agent and prove sessions)', async () => {
    const policy = pub({ writeWindow: { step: 0, maxPosts: 3, hosts: [portal.host] } });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      s.writeWindow?.open();
      s.restrict(noWritePolicy(policy));
      expect(s.writeWindow?.isOpen).toBe(false);
      // noWritePolicy makes every refused write fatal, so the session may close while the page is still evaluating.
      const outcome = await s.page.evaluate(async () => { try { await fetch('/public/api/submit', { method: 'POST' }); return 'sent'; } catch { return 'blocked'; } })
        .catch(() => 'blocked');
      expect(outcome).toBe('blocked');
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true }));
      expect(s.writeWindow?.posts).toEqual([]);
      expect((await counters()).posts).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('a write before an AI repair', () => {
  it('a drift after the window POST refuses repair: a runtime refusal, submitted, the model is never called', async () => {
    const drift: Step = { intent: 'Find the receipt', timeoutMs: 500, click: { css: '#receipt' } };
    const read: Step = { intent: 'Read the receipt', extract: { scope: { css: 'main' }, idPattern: 'R-\\d+' } };
    const steps = [open('/public/form'), FILL_NAME, FILL_MESSAGE, SEND, drift, read];
    const model = fakeModel([done('not_found', 'no receipt'), done('not_found', 'no receipt')]);
    const r = await runTask({ ...input(steps), output: { idPattern: 'R-\\d+' }, repair: { model, goal: 'Read the receipt', deliverUnconfirmed: true } });
    expect(r).toMatchObject({
      ok: false, code: 'policy_violation', lane: 'script', message: REPAIR_REFUSED_WRITES, submitted: true,
      failure: { intent: 'Find the receipt' },
    });
    // A runtime event, not a configuration error.
    expect(r).not.toHaveProperty('configError');
    expect(model.invocations).toHaveLength(0);
    expect((await counters()).posts).toEqual([{ path: '/public/form/submit', name: 'Ada Lovelace' }]);
    if (!r.ok) expect(r.trace?.length).toBeGreaterThan(1000); // the refused run keeps its failure trace
    // Without repair the same drift is reported as drift, still submitted.
    portal.reset();
    const bare = await runTask({ ...input(steps), output: { idPattern: 'R-\\d+' } });
    expect(bare).toMatchObject({ ok: false, code: 'drift_detected', lane: 'script', submitted: true });
  });
  it('with no write before the drift, the same form steps still get AI repair', async () => {
    // No Send step: nothing was posted before the drift, so repair runs (and gives up here) under the no-write policy.
    const drift: Step = { intent: 'Find the receipt', timeoutMs: 500, click: { css: '#receipt' } };
    const read: Step = { intent: 'Read the receipt', extract: { scope: { css: 'main' }, idPattern: 'R-\\d+' } };
    const model = fakeModel([done('not_found', 'no receipt'), done('not_found', 'no receipt')]);
    const r = await runTask({
      ...input([open('/public/form'), FILL_NAME, drift, read]), output: { idPattern: 'R-\\d+' }, repair: { model, goal: 'Read the receipt' },
    });
    expect(r).toMatchObject({ ok: false, code: 'not_found', lane: 'agent' });
    expect(r).not.toHaveProperty('submitted');
    expect(model.invocations.length).toBeGreaterThan(0);
  });
});

describe('every write that leaves the browser counts', () => {
  const SUBMIT_TARGET = () => [{ host: portal.host, path: '/public/form/submit', method: 'POST' }];
  /** A plain click on the form's button: not the write window (no "Send" intent), not a declared submit. */
  const CLICK_SEND: Step = { intent: 'Click the button', click: { role: 'button', name: 'Send' } };

  it('session.writesSent counts continued non-safe requests, never safe methods or declared login POSTs', async () => {
    const policy = pub({
      allowedSubmits: [{ host: portal.host, path: '/public/api/submit', method: 'POST' }], login: [{ host: portal.host, path: '/public/login' }],
    });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      expect(s.writesSent).toBe(0);
      await s.page.evaluate(() => fetch('/public/table').then(() => undefined));
      await s.page.evaluate(() => fetch('/public/login', { method: 'POST' }).then(() => undefined, () => undefined));
      expect(s.writesSent).toBe(0);
      s.armSubmit({ host: portal.host, path: '/public/api/submit', method: 'POST' });
      await s.page.evaluate(() => fetch('/public/api/submit', { method: 'POST' }).then(() => undefined));
      expect(s.writesSent).toBe(1);
      // A blocked write (block mode) never left the browser: not counted.
      await s.page.evaluate(() => fetch('/public/collect', { method: 'POST' }).then(() => undefined, () => undefined));
      expect(s.writesSent).toBe(1);
    } finally { await s.close(); }
  });

  it('a plain click on a form that posts to an allowed submission no declared step names is a policy violation; nothing is sent', async () => {
    const r = await runScriptLane(input([open('/public/form'), FILL_NAME, CLICK_SEND, { intent: 'Thanks shown', waitFor: { target: { css: '#echo' } } }], {}, {
      allowedSubmits: SUBMIT_TARGET(),
    }));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', failure: { intent: 'Click the button' } });
    if (!r.ok) expect(r.submitted).toBeUndefined();
    expect((await counters()).posts).toEqual([]);
  });

  it('with AI repair on, that click is refused with zero model calls', async () => {
    const drift: Step = { intent: 'Find the receipt', timeoutMs: 500, click: { css: '#receipt' } };
    const read: Step = { intent: 'Read the receipt', extract: { scope: { css: 'main' }, idPattern: 'R-\\d+' } };
    const model = fakeModel([done('not_found', 'no receipt'), done('not_found', 'no receipt')]);
    const r = await runTask({
      ...input([open('/public/form'), FILL_NAME, CLICK_SEND, drift, read], {}, { allowedSubmits: SUBMIT_TARGET() }),
      output: { idPattern: 'R-\\d+' }, repair: { model, goal: 'Read the receipt' },
    });
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', lane: 'script' });
    expect(model.invocations).toHaveLength(0);
    expect((await counters()).posts).toEqual([]);
  });
});

describe('declared submits without a Site Login', () => {
  const declared = (host?: string): Step => ({
    intent: 'Submit the form', submit: { button: { role: 'button', name: 'Send' }, path: '/public/form/submit', ...(host ? { host } : {}) },
  });
  const unsignedWrites = { trust: { required: false, allowUnsignedWrites: true } };

  it('an unsigned, allowed declared submit on the start host passes when the policy takes submits from the steps', async () => {
    const r = await runScriptLane(input([open('/public/form'), FILL_NAME, declared()], unsignedWrites, { submitsFromSteps: true }));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.submitted).toBe(true);
    expect(r.writes).toEqual([]);
    expect((await counters()).posts).toEqual([{ path: '/public/form/submit', name: 'Ada Lovelace' }]);
  });

  it('a declared submit to a host that is not a navigation host, or without submitsFromSteps, is refused before the browser opens', async () => {
    const off = await runScriptLane(input([open('/public/form'), FILL_NAME, declared(`localhost:${portal.port}`)], unsignedWrites, { submitsFromSteps: true }));
    expect(off).toMatchObject({ ok: false, code: 'policy_violation' });
    if (!off.ok) expect(off.message).toContain(`POST localhost:${portal.port}/public/form/submit is not an allowed submission`);
    const notDerived = await runScriptLane(input([open('/public/form'), FILL_NAME, declared()], unsignedWrites));
    expect(notDerived).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(sessions).toHaveLength(0);
    expect((await counters()).posts).toEqual([]);
  });

  it('a download through a form marks the run submitted once its click went out', async () => {
    const exportViaPost: Step = { intent: 'Export', download: { trigger: { role: 'button', name: 'Export via POST' }, via: { path: '/public/files/export' } } };
    const r = await runScriptLane(input([open('/public/files'), exportViaPost], unsignedWrites, { startUrl: `${portal.url}/public/files`, submitsFromSteps: true }));
    expect(r.submitted).toBe(true);
  });
});

describe('write window edge cases', () => {
  /** Runs steps directly on a live session at `path`, after `prepare` changed the page; the caller closes the session. */
  async function direct(path: string, steps: Step[], policy: PortalPolicy, prepare?: (s: SessionT) => Promise<void>, masker = createMasker([])) {
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    await s.page.goto(`${portal.url}${path}`);
    await prepare?.(s);
    const ctx: StepContext = {
      page: s.page, script: { name: 't', version: 1, startUrl: `${portal.url}${path}`, steps }, policy, vars: VARS,
      masker, defaultTimeoutMs: 3000, violations: s.violations, ...(s.writeWindow ? { writeWindow: s.writeWindow } : {}),
    };
    return { s, ctx, r: await runSteps(ctx, steps) };
  }
  const windowOn = (step: number) => pub({ writeWindow: { step, maxPosts: 3, hosts: [portal.host] } });

  describe('the password refusal follows labels the way Playwright does, and re-checks after typing', () => {
    const cases: [string, Step][] = [
      ['a text locator on the label', { intent: 'Type', fill: { field: { text: 'Password' }, value: 'typed-by-steps' } }],
      ['a css locator on the label', { intent: 'Type', fill: { field: { css: 'label:has(input[type=password])' }, value: 'typed-by-steps' } }],
    ];
    for (const [name, step] of cases) {
      it(`refuses ${name} and types nothing`, async () => {
        const { s, ctx, r } = await direct('/public/form', [step], pub());
        try {
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.failure.message).toBe(PASSWORD_FILL_REFUSED_STEPS);
          expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
          expect(await s.page.inputValue('input[name=password]')).toBe('');
        } finally { await s.close(); }
      });
    }
    it('refuses a field that turns into a password field on focus, and clears what was typed', async () => {
      const step: Step = { intent: 'Type', fill: { field: { label: 'Name' }, value: 'typed-by-steps' } };
      const { s, ctx, r } = await direct('/public/form', [step], windowOn(1), async (session) => {
        await session.page.evaluate(() => {
          const el = document.querySelector('input[name=name]') as HTMLInputElement;
          el.addEventListener('focus', () => { el.type = 'password'; });
        });
      });
      try {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.failure.message).toBe(PASSWORD_FILL_REFUSED);
        expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'signin', fatal: true }));
        expect(await s.page.inputValue('input[name=name]')).toBe('');
      } finally { await s.close(); }
    });
  });

  describe('violation URLs are masked before they are capped', () => {
    const secret = 'demo-password';
    const masker = createMasker([secret]);
    /** Neither the secret nor a prefix of it cut off by the 300-character cap. */
    const clean = (x: string) => {
      expect(x).not.toContain(secret);
      for (let k = 3; k < secret.length; k++) expect(x.endsWith(secret.slice(0, k))).toBe(false);
      expect(x.length).toBeLessThanOrEqual(300);
    };
    it('a form that posts elsewhere', async () => {
      const { s, ctx, r } = await direct('/public/form-cross', [SEND_ANY], windowOn(0), async (session) => {
        await session.page.evaluate(([pad, sec]) => {
          const f = document.querySelector('#contact') as HTMLFormElement;
          f.action = `${f.action.replace(/\/public\/form\/submit$/, '')}/${pad}${sec}`;
        }, ['a'.repeat(280 - portal.url.length), secret]);
      }, masker);
      try {
        expect(r.ok).toBe(false);
        const v = ctx.violations.find((x) => x.kind === 'write');
        if (!v) throw new Error('no write violation');
        clean(v.url);
      } finally { await s.close(); }
    });
    it('a password fill refusal on a page whose path carries a secret', async () => {
      const step: Step = { intent: 'Type', fill: { field: { label: 'Password' }, value: 'typed-by-steps' } };
      const { s, ctx, r } = await direct('/public/form', [step], pub(), async (session) => {
        await session.page.evaluate(([pad, sec]) => { history.pushState({}, '', `/${pad}${sec}`); }, ['b'.repeat(290 - portal.url.length), secret]);
      }, masker);
      try {
        expect(r.ok).toBe(false);
        const v = ctx.violations.find((x) => x.kind === 'signin');
        if (!v) throw new Error('no signin violation');
        clean(v.url);
      } finally { await s.close(); }
    });
  });

  it('a malformed maxPosts still caps the window at three POSTs', async () => {
    const policy = pub({ writeWindow: { step: 0, maxPosts: undefined as unknown as 3, hosts: [portal.host] } });
    const s = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      s.writeWindow?.open();
      const outcomes: string[] = [];
      for (let i = 0; i < 4; i++) {
        outcomes.push(await s.page.evaluate(async () => { try { await fetch('/public/api/submit', { method: 'POST' }); return 'sent'; } catch { return 'blocked'; } }));
      }
      expect(outcomes).toEqual(['sent', 'sent', 'sent', 'blocked']);
      expect((await counters()).posts).toHaveLength(3);
    } finally { await s.close(); }
  });

  it('the window opens only after the button is actionable: a POST while it is still disabled is not admitted', async () => {
    const { s, r } = await direct('/public/form', [SEND], windowOn(0), async (session) => {
      await session.page.evaluate(() => {
        const button = document.querySelector('#contact button') as HTMLButtonElement;
        button.disabled = true;
        setTimeout(() => { void fetch('/public/api/submit', { method: 'POST' }).catch(() => undefined); }, 300);
        setTimeout(() => { button.disabled = false; }, 1000);
      });
    });
    try {
      if (!r.ok) throw new Error(JSON.stringify(r.failure));
      expect(s.writeWindow?.posts).toEqual([{ method: 'POST', host: portal.host, path: '/public/form/submit' }]);
      expect(s.blockedRequests).toContainEqual({ method: 'POST', host: portal.host, path: '/public/api/submit' });
      expect((await counters()).posts.map((p) => p.path)).toEqual(['/public/form/submit']);
    } finally { await s.close(); }
  });

  it('when the lane fails after the steps ran, a declared submit still reports submitted', async () => {
    const declared: Step = { intent: 'Submit the form', submit: { button: { role: 'button', name: 'Send' }, path: '/public/form/submit' } };
    failPageInfo.on = true;
    const r = await runScriptLane(input([open('/public/form'), FILL_NAME, declared], { trust: { required: false, allowUnsignedWrites: true } }, { submitsFromSteps: true }));
    expect(failPageInfo.on).toBe(false);
    expect(r).toMatchObject({ ok: false, code: 'incomplete', submitted: true });
    expect((await counters()).posts).toHaveLength(1);
  });

  it('a link inside a form that posts elsewhere is not a form submission: no pre-check refusal', async () => {
    const link: Step = { intent: 'Send', click: { css: '#more' } };
    const { s, ctx, r } = await direct('/public/form-cross', [link], windowOn(0), async (session) => {
      await session.page.evaluate(() => {
        const a = document.createElement('a');
        a.id = 'more';
        a.href = '#more';
        a.textContent = 'More';
        document.querySelector('#contact')?.append(a);
      });
    });
    try {
      if (!r.ok) throw new Error(JSON.stringify(r.failure));
      expect(ctx.violations).toEqual([]);
      expect(s.writeWindow?.posts).toEqual([]);
    } finally { await s.close(); }
  });
});

describe('Site Login forms: each is posted only by its own declared step', () => {
  const ACK = () => ({ host: portal.host, path: '/acme/notices/acknowledge', method: 'POST' });
  /** The credential lists both sandbox forms: the report export and the notices acknowledgement. */
  const siteLogin = () => ({ ...policyFor(portal), allowedSubmits: [...policyFor(portal).allowedSubmits, ACK()] });
  /** Sign in, open Service, open Recalls (the page with the "Acknowledge all notices" form). */
  const toRecalls = () => baselineScript(portal.url).steps.slice(0, 5);
  const CLICK_ACK: Step = { intent: 'Click acknowledge', click: { css: '#acknowledge' } };
  const SUBMIT_ACK: Step = {
    intent: 'Acknowledge', submit: { button: { css: '#acknowledge' }, path: '/acme/notices/acknowledge' }, expect: { heading: 'Notices acknowledged' },
  };
  const lane = (script: Script, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput =>
    signedLaneInput(script, { policy: siteLogin(), secrets: SECRETS, endpoint: LOCAL, defaultStepTimeoutMs: 5000, ...over });
  const signed = (steps: Step[], name = 'a3-steps') => lane({ name, version: 1, startUrl: `${portal.url}/acme/login`, steps });
  const acks = () => portal.state().acknowledgements ?? 0;

  it('signed steps with only clicks: a button that posts a credential-listed form fails policy_violation and nothing is received', async () => {
    const r = await runScriptLane(signed([...toRecalls(), CLICK_ACK]));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', failure: { intent: 'Click acknowledge' } });
    if (!r.ok) {
      expect(r.submitted).toBeUndefined();
      expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true, url: `${portal.url}/acme/notices/acknowledge` }));
    }
    expect(acks()).toBe(0);
  });

  it('signed steps with only clicks: the report export button (credential-listed) fails policy_violation and no file comes back', async () => {
    const steps: Step[] = [
      ...toRecalls().slice(0, 3),
      { intent: 'Open Reports', click: { role: 'link', name: 'Reports', exact: true, within: { role: 'navigation' } } },
      { intent: 'Click export', click: { role: 'button', name: 'Export CSV' } },
      { intent: 'Wait', waitFor: { target: { css: '#never-there' } }, timeoutMs: 1500, optional: true },
    ];
    const r = await runScriptLane(signed(steps));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation', failure: { intent: 'Click export' } });
    if (!r.ok) {
      expect(r.submitted).toBeUndefined();
      expect(r.violations).toContainEqual(expect.objectContaining({ kind: 'write', method: 'POST', fatal: true, url: `${portal.url}/acme/reports/export` }));
    }
  });

  it('the declared submit step still posts its form exactly once', async () => {
    const r = await runScriptLane(signed([...toRecalls(), SUBMIT_ACK]));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.submitted).toBe(true);
    expect(acks()).toBe(1);
  });

  it('the declared download.via step still exports the report', async () => {
    const r = await runScriptLane(lane(reportScript(portal.url), { vars: { from: '2000-01-01' } }));
    if (!r.ok) throw new Error(JSON.stringify(r).slice(0, 600));
    expect(r.files).toHaveLength(1);
    expect(r.files[0].mimeType).toBe('text/csv');
    expect(r.submitted).toBe(true);
  });

  it('a declared form posted at a different step than its submit step fails policy_violation; nothing is received', async () => {
    // A plain click before the declared submit step.
    const early = await runScriptLane(signed([...toRecalls(), CLICK_ACK, SUBMIT_ACK]));
    expect(early).toMatchObject({ ok: false, code: 'policy_violation', failure: { intent: 'Click acknowledge' } });
    expect(acks()).toBe(0);
    // Another declared submit step whose button posts this form: its window is for its own target only.
    portal.reset();
    const wrongButton: Step = { intent: 'Export', submit: { button: { css: '#acknowledge' }, path: '/acme/reports/export' } };
    const crossed = await runScriptLane(signed([...toRecalls(), wrongButton, SUBMIT_ACK]));
    expect(crossed).toMatchObject({ ok: false, code: 'policy_violation', failure: { intent: 'Export' } });
    if (!crossed.ok) expect(crossed.violations).toContainEqual(expect.objectContaining({ kind: 'write', fatal: true, url: `${portal.url}/acme/notices/acknowledge` }));
    expect(acks()).toBe(0);
  });

  it('a form the credential lists but no step declares is not allowed, even by a submit step for another form', async () => {
    // Only the export is declared: the acknowledgement stays closed although the credential lists it.
    const r = await runScriptLane(signed([...toRecalls(), { intent: 'Export', submit: { button: { css: '#acknowledge' }, path: '/acme/reports/export' } }]));
    expect(r).toMatchObject({ ok: false, code: 'policy_violation' });
    expect(acks()).toBe(0);
  });
});
