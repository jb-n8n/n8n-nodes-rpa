import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { INPUT_CONTAINS_SECRET } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { renderLocators } from '../src/steps/render-locators.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { DesktopStep, Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(async () => { portal.reset(); });

async function withPage<T>(path: string, vars: Record<string, string>, secrets: string[], body: (ctx: StepContext) => Promise<T>): Promise<T> {
  const session = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker: createMasker([]) });
  try {
    await session.page.goto(`${portal.url}${path}`);
    return await body({
      page: session.page, script: baselineScript(portal.url), policy: policyFor(portal), secrets: SECRETS,
      vars, masker: createMasker(secrets), defaultTimeoutMs: 3000, violations: session.violations,
    });
  } finally { await session.close(); }
}

describe('{{var.x}} in browser locators', () => {
  it('clicks the link a variable names, and keeps the template in the step', async () => {
    const steps: Step[] = [{ intent: 'Open the chosen item', click: { role: 'link', name: '{{var.item}}' }, expect: { url: '/public/items/SKU-2002' } }];
    const before = JSON.stringify(steps);
    await withPage('/public/list', { item: 'Red mug' }, [], async (ctx) => {
      const r = await runSteps(ctx, steps);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toContain('/public/items/SKU-2002');
    });
    expect(JSON.stringify(steps)).toBe(before);
  });
  it('renders a text locator, and another variable value gives another link', async () => {
    await withPage('/public/list', { item: 'Blue mug' }, [], async (ctx) => {
      const r = await runSteps(ctx, [{ intent: 'Open', click: { text: '{{var.item}}', exact: true } }]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toContain('/public/items/SKU-2001');
    });
  });
  it('renders a variable value once: a value that looks like a template stays literal', () => {
    const out = renderLocators({ intent: 'x', click: { text: '{{var.a}}' } }, { a: '{{var.b}}', b: 'second' }, createMasker([]));
    expect(out.click).toEqual({ text: '{{var.b}}' });
  });
  it('leaves other {{...}} text in a locator literal and never renders hosts or fill values here', () => {
    const step = { intent: 'x', fill: { field: { text: '{{ $ctrl.x }}' }, value: '{{var.a}}' } };
    expect(renderLocators(step, { a: 'v' }, createMasker([]))).toBe(step);
  });
  it('refuses a variable whose value holds a secret in a locator', async () => {
    await withPage('/public/list', { item: 'demo-password' }, ['demo-password'], async (ctx) => {
      const r = await runSteps(ctx, [{ intent: 'Open', click: { role: 'link', name: '{{var.item}}' } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe(INPUT_CONTAINS_SECRET);
    });
  });
  it('fails on a missing variable like a fill value does', async () => {
    await withPage('/public/list', {}, [], async (ctx) => {
      const r = await runSteps(ctx, [{ intent: 'Open', click: { role: 'link', name: '{{var.item}}' } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toContain('missing input "item"');
    });
  });
});

describe('{{var.x}} in desktop conditions', () => {
  it('renders UiaCond.name only, not the window selector, and keeps the template', () => {
    const step = {
      intent: 'x',
      click: { uia: { window: { title: '{{var.t}}' }, path: [{ controlType: 'ListItem', name: '{{var.row}}' }] }, fallbacks: [{ uia: { path: [{ name: 'Row {{var.row}}' }] } }] },
    } as unknown as DesktopStep;
    const out = renderLocators(step, { row: 'A-17', t: 'T' }, createMasker([])) as unknown as { click: { uia: { window: { title: string }; path: { name: string }[] }; fallbacks: { uia: { path: { name: string }[] } }[] } };
    expect(out.click.uia.path[0].name).toBe('A-17');
    expect(out.click.fallbacks[0].uia.path[0].name).toBe('Row A-17');
    expect(out.click.uia.window.title).toBe('{{var.t}}');
    expect((step as unknown as typeof out).click.uia.path[0].name).toBe('{{var.row}}');
  });
  it('refuses a secret value in a condition name', () => {
    const step = { intent: 'x', click: { uia: { path: [{ name: '{{var.row}}' }] } } };
    expect(() => renderLocators(step, { row: 'demo-password' }, createMasker(['demo-password']))).toThrow(INPUT_CONTAINS_SECRET);
  });
});

describe('multi-select', () => {
  const picked = (ctx: StepContext) => ctx.page.$eval('#regions', (el) => Array.from((el as HTMLSelectElement).options).filter((o) => o.selected).map((o) => o.value));
  it('selects exactly the listed values and clears the others', async () => {
    await withPage('/public/multi', { r: 'south' }, [], async (ctx) => {
      expect(await picked(ctx)).toEqual(['west']);
      const r = await runSteps(ctx, [{ intent: 'Pick regions', select: { field: { css: '#regions' }, value: ['north', '{{var.r}}'] } }]);
      expect(r.ok).toBe(true);
      expect(await picked(ctx)).toEqual(['north', 'south']);
    });
  });
  it('a single string still selects one option', async () => {
    await withPage('/public/multi', {}, [], async (ctx) => {
      const r = await runSteps(ctx, [{ intent: 'Pick', select: { field: { css: '#regions' }, value: 'east' } }]);
      expect(r.ok).toBe(true);
      expect(await picked(ctx)).toEqual(['east']);
    });
  });
});
