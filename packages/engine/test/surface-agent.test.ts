import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import type { SnapshotElement } from '../src/agent/snapshot.js';
import { AgentTools } from '../src/agent/tools.js';
import { createMasker } from '../src/secrets/mask.js';
import { newRunState, type StepContext } from '../src/steps/run.js';
import type { Surface } from '../src/surface/surface.js';
import { policyFor } from './helpers.js';

/** A page that must never be touched: look() reads only through ctx.surface. */
const untouchablePage = new Proxy({}, { get() { throw new Error('page used'); } }) as Page;

const exportButton = { ref: 'e1', role: 'button', name: 'Export', fullName: 'Export', candidates: [] } as unknown as SnapshotElement;

let at = 'https://portal.test/orders';
const fakeSurface: Surface = {
  kind: 'desktop',
  isClosed: () => false,
  address: () => at,
  isVisible: async () => false,
  checkExpect: async () => undefined,
  snapshot: async () => ({ url: 'https://portal.test/orders', title: 'Orders', text: '', elements: [exportButton], overlays: [], nextRef: 2 }),
};

function tools(): AgentTools {
  const ctx: StepContext = {
    page: untouchablePage, surface: fakeSurface, script: { steps: [] } as unknown as StepContext['script'],
    policy: policyFor({ url: 'https://portal.test', host: 'portal.test' }), vars: {}, masker: createMasker([]),
    defaultTimeoutMs: 200, violations: [],
  };
  return new AgentTools({ ctx, state: newRunState(), output: { fields: ['document'] } as never });
}

describe('the repair agent reads the page through the surface', () => {
  it('look renders the surface snapshot', async () => {
    const out = await tools().look();
    expect(out).toContain('Export');
    expect(out).toContain('Orders');
  });

  it('coming back to the same address is a revisit', async () => {
    const t = tools();
    at = 'https://portal.test/orders';
    await t.look();
    at = 'https://portal.test/invoices';
    await t.look();
    at = 'https://portal.test/orders';
    const back = await t.look();
    expect(back.startsWith('This is visit 2 to this exact page in this run.')).toBe(true);
  });
});
