import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { createMasker } from '../src/secrets/mask.js';
import { HANDLERS, registerHandlers } from '../src/steps/handlers/index.js';
import { runSteps, type Handler, type StepContext } from '../src/steps/run.js';
import { surfaceOf } from '../src/surface/browser.js';
import type { Surface } from '../src/surface/surface.js';
import type { Expect, Locator, Step } from '../src/types.js';
import { policyFor } from './helpers.js';

/** A page that must never be touched: the runner reaches a non-browser surface only through ctx.surface. */
const untouchablePage = new Proxy({}, { get() { throw new Error('page used'); } }) as Page;

class FakeSurface implements Surface {
  readonly kind = 'desktop' as const;
  visible = new Map<string, boolean>();
  failExpect = false;
  isClosed() { return false; }
  address() { return 'desktop://erp/orders'; }
  async isVisible(target: Locator) { return this.visible.get(JSON.stringify(target)) ?? false; }
  async checkExpect(_expect: Expect, _timeoutMs: number) { if (this.failExpect) throw new Error('expectation failed: fake'); }
  async snapshot() { return { url: 'desktop://erp/orders', title: 'Orders', text: '', elements: [], overlays: [], nextRef: 1 }; }
}

function ctxWith(surface: Surface): StepContext {
  return {
    page: untouchablePage, surface, script: { steps: [] } as unknown as StepContext['script'],
    policy: policyFor({ url: 'https://portal.test', host: 'portal.test' }), vars: {}, masker: createMasker([]),
    defaultTimeoutMs: 200, violations: [],
  };
}

let calls = 0;
const click: Handler = async () => { calls++; };
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; calls = 0; });

describe('the step runner on a non-browser surface', () => {
  it('runs a step on a non-browser surface', async () => {
    dispose = registerHandlers('desktop', { click });
    const r = await runSteps(ctxWith(new FakeSurface()), [{ intent: 'Press', click: { css: '#go' } } as Step]);
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(r.state.log[0].status).toBe('ok');
  });

  it('when uses the surface', async () => {
    dispose = registerHandlers('desktop', { click });
    const r = await runSteps(ctxWith(new FakeSurface()), [{ intent: 'Press', click: { css: '#go' }, when: { visible: { css: '#banner' } } } as Step]);
    expect(r.ok).toBe(true);
    expect(r.state.log[0]).toMatchObject({ status: 'skipped', note: 'condition not met' });
    expect(calls).toBe(0);
  });

  it('expect uses the surface', async () => {
    dispose = registerHandlers('desktop', { click });
    const surface = new FakeSurface();
    surface.failExpect = true;
    const r = await runSteps(ctxWith(surface), [{ intent: 'Press', click: { css: '#go' }, expect: { heading: 'Done' } } as Step]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.message).toBe('expectation failed: fake');
  });

  it('missing desktop handler names the surface', async () => {
    const r = await runSteps(ctxWith(new FakeSurface()), [{ intent: 'Type', fill: { field: { css: '#q' }, value: 'x' } } as Step]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.failure.message).toBe('step type "fill" has no handler for the desktop surface');
  });
});

describe('handler tables', () => {
  it('browser table is complete', () => {
    expect(Object.keys(HANDLERS.browser).sort()).toEqual(['check', 'click', 'clickAll', 'detect', 'download', 'extract', 'extractTable', 'fill', 'goto', 'paginate', 'pdf', 'popup', 'read', 'screenshot', 'select', 'signIn', 'submit', 'waitFor']);
  });

  it('a copied context follows its own page', () => {
    const pageAt = (url: string) => ({ url: () => url, isClosed: () => false }) as unknown as Page;
    const base = ctxWith(new FakeSurface());
    expect(surfaceOf({ ...base, surface: undefined, page: pageAt('https://a.test/') }).address()).toBe('https://a.test/');
    expect(surfaceOf({ ...base, surface: undefined, page: pageAt('https://b.test/') }).address()).toBe('https://b.test/');
  });
});
