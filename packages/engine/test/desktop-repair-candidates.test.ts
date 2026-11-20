// Locator candidates for a node the repair agent chose: validated against the last view and the runner.
import { afterEach, describe, expect, it } from 'vitest';
import { connectRunner, type RunnerClient } from '../src/desktop/client.js';
import '../src/desktop/handlers.js';
import { desktopCandidatesFor, TargetError } from '../src/desktop/repair/candidates.js';
import { NoRunError } from '../src/desktop/protocol.js';
import { createDesktopSurface, type DesktopSurface, type DesktopView } from '../src/desktop/surface.js';
import { createMasker, type Masker } from '../src/secrets/mask.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { DesktopLocator, DesktopScript } from '../src/types.js';
import { ERP_EXE, ERP_PASSWORD, ERP_POLICY, ERP_USER, FakeRunner, type FakeRunnerOptions } from './fake-runner.js';
import { EXPECTED } from './fixtures/erp-steps.js';

const RUN = 'cand';
const MAIN = { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' };
const uia = (automationId: string, controlType = 'Edit'): DesktopLocator => ({ uia: { path: [{ controlType, automationId }] } });
const SIGN_IN = [
  { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
  { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
  { intent: 'Sign in', click: uia('btnSignIn', 'Button') },
];

let runner: FakeRunner | undefined;
let client: RunnerClient | undefined;
afterEach(async () => {
  await client?.close();
  await runner?.close();
  client = undefined;
  runner = undefined;
});

/** The ERP Demo on a run of its own, signed in. */
async function onErp(opts: FakeRunnerOptions = {}): Promise<{ surface: DesktopSurface; run: (steps: unknown[]) => Promise<void> }> {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, erpUi: 'v2', ...opts });
  client = await connectRunner(runner.endpoint);
  await client.call('run.begin', { runId: RUN, leaseMs: 60_000 });
  await client.call('app.launch', { runId: RUN, app: { exe: ERP_EXE } });
  const surface = createDesktopSurface(client, RUN, { exe: ERP_EXE });
  const ctx: StepContext = {
    page: undefined as never, surface,
    script: { surface: 'desktop', name: 'erp-cand', version: 1, app: { exe: ERP_EXE }, steps: [] } as never,
    policy: { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] },
    vars: { user: ERP_USER, password: ERP_PASSWORD }, masker: createMasker([]), defaultTimeoutMs: 1000, violations: [],
  };
  surface.trackStep(() => ctx.stepIndex);
  const run = async (steps: unknown[]) => {
    const res = await runSteps(ctx, steps as never, newRunState());
    if (!res.ok) throw new Error(res.failure.message);
  };
  await run(SIGN_IN);
  return { surface, run };
}

const refOf = (view: DesktopView, controlType: string, name: string, nth = 0): string => {
  const hit = view.items.filter((i) => i.controlType === controlType && i.name === name)[nth];
  if (!hit) throw new Error(`no ${controlType} "${name}" in the view`);
  return hit.ref;
};
const base: DesktopScript = EXPECTED;
const bare = createMasker([]);

describe('desktopCandidatesFor', () => {
  it('a button with id and name gets primary {type,id,name} and fallbacks {type,id},{type,name}', async () => {
    const { surface } = await onErp();
    const view = await surface.view(bare);
    const loc = await desktopCandidatesFor(surface, refOf(view, 'Button', 'Find'), { masker: bare, base });
    expect(loc).toEqual({
      uia: { window: MAIN, path: [{ controlType: 'Button', automationId: 'btnFind', name: 'Find' }] },
      fallbacks: [
        { uia: { window: MAIN, path: [{ controlType: 'Button', automationId: 'btnFind' }] } },
        { uia: { window: MAIN, path: [{ controlType: 'Button', name: 'Find' }] } },
      ],
    });
  });

  it('a WinForms menu item without an id gets {MenuItem,name} in a window of the exe', async () => {
    const { surface, run } = await onErp();
    await run([{ intent: 'Open Reports', click: { uia: { window: MAIN, path: [{ controlType: 'MenuItem', name: 'Reports' }] } } }]);
    const view = await surface.view(bare, { window: { title: 'Reports' } });
    const loc = await desktopCandidatesFor(surface, refOf(view, 'MenuItem', 'Export line items...'), { masker: bare, base });
    // The drop-down is a window of its own, titled by its menu, and no step of the base uses it.
    expect(loc).toEqual({ uia: { window: { exe: ERP_EXE, title: 'Reports' }, path: [{ controlType: 'MenuItem', name: 'Export line items...' }] } });
  });

  it('a shared name is anchored under the nearest stable-id ancestor', async () => {
    const { surface } = await onErp({ erpChanges: ['sharedNote'] });
    const view = await surface.view(bare);
    const first = await desktopCandidatesFor(surface, refOf(view, 'Text', 'Note', 0), { masker: bare, base });
    expect(first.uia.path).toEqual([{ automationId: 'grpSearch' }, { controlType: 'Text', name: 'Note' }]);
    const second = await desktopCandidatesFor(surface, refOf(view, 'Text', 'Note', 1), { masker: bare, base });
    expect(second.uia.path).toEqual([{ automationId: 'pnlDetail' }, { controlType: 'Text', name: 'Note' }]);
    expect(second.fallbacks).toBeUndefined();
  });

  it('a stale ref is refused; an unknown control with neither id nor name is refused', async () => {
    const { surface, run } = await onErp({ erpUi: 'v1' });
    await run([{ intent: 'Open File', click: { uia: { window: MAIN, path: [{ controlType: 'MenuItem', name: 'File' }] } } }]);
    const view = await surface.view(bare, { window: MAIN });
    await expect(desktopCandidatesFor(surface, 'e9999', { masker: bare, base })).rejects.toThrow(
      new TargetError('element e9999 is no longer on the screen; call look for fresh refs'));
    const separator = refOf(view, 'Separator', '');
    await expect(desktopCandidatesFor(surface, separator, { masker: bare, base })).rejects.toThrow(
      `no stable target for element ${separator}: no automation id or name picks it out alone in its window`);
    // A ref of an earlier view is stale after a newer one.
    const exit = refOf(view, 'MenuItem', 'Exit');
    await surface.view(bare);
    await expect(desktopCandidatesFor(surface, exit, { masker: bare, base })).rejects.toBeInstanceOf(TargetError);
  });

  it('a candidate holding a secret is dropped', async () => {
    const { surface } = await onErp();
    const view = await surface.view(bare);
    const ref = refOf(view, 'Button', 'Find');
    // A secret equal to the name: the name is no condition (the masker would change it), the id alone stays.
    const from = refOf(view, 'Edit', 'Date from');
    const byName: Masker = createMasker(['Date from']);
    const named = await desktopCandidatesFor(surface, from, { masker: byName, base });
    expect(named).toEqual({ uia: { window: MAIN, path: [{ controlType: 'Edit', automationId: 'txtDateFrom' }] } });
    // A secret equal to the id: every candidate holding it is dropped, the name-only one stays.
    const byId: Masker = createMasker(['btnFind']);
    const loc = await desktopCandidatesFor(surface, ref, { masker: byId, base });
    expect(loc.uia.path).toEqual([{ controlType: 'Button', name: 'Find' }]);
    expect(loc.fallbacks).toBeUndefined();
    // Nothing left.
    await expect(desktopCandidatesFor(surface, ref, { masker: createMasker(['btnFind', 'Find']), base })).rejects.toBeInstanceOf(TargetError);
  });

  it('every kept candidate resolved alone as primary', async () => {
    const { surface } = await onErp();
    const view = await surface.view(bare);
    const before = runner!.requests.length;
    const loc = await desktopCandidatesFor(surface, refOf(view, 'Button', 'Find'), { masker: bare, base });
    const resolves = runner!.requests.slice(before).filter((r) => r.method === 'resolve');
    expect(resolves.map((r) => r.params)).toEqual([loc.uia, ...(loc.fallbacks ?? []).map((f) => f.uia)].map((t) => ({
      runId: RUN, target: { window: t.window, path: t.path }, timeoutMs: 500,
    })));
    for (const r of resolves) expect((r.params.target as { fallbacks?: unknown }).fallbacks).toBeUndefined();
  });

  it('a candidate the runner no longer finds is dropped', async () => {
    const { surface, run } = await onErp();
    const view = await surface.view(bare);
    const ref = refOf(view, 'Button', 'Find');
    // The app closes its window after the view: every resolve answers not_found.
    await run([{ intent: 'Open File', click: { uia: { window: MAIN, path: [{ controlType: 'MenuItem', name: 'File' }] } } }, { intent: 'Exit', click: { uia: { window: MAIN, path: [{ controlType: 'MenuItem', name: 'Exit' }] } } }]).catch(() => undefined);
    await expect(desktopCandidatesFor(surface, ref, { masker: bare, base })).rejects.toBeInstanceOf(TargetError);
  });

  it('a view cut by maxNodes does not hide a second match: the runner answers not unique and the candidate is dropped', async () => {
    const { surface } = await onErp({ erpChanges: ['sharedNote'] });
    const full = await surface.view(bare);
    const cut = full.items.findIndex((i) => i.automationId === 'pnlDetail');
    const view = await surface.view(bare, { maxNodes: cut });
    expect(view.truncated).toBe(true);
    // The view holds one Note and one local match, but the app has two.
    await expect(desktopCandidatesFor(surface, refOf(view, 'Text', 'Note'), { masker: bare, base })).rejects.toBeInstanceOf(TargetError);
  });

  it('a runner fault other than not found or not unique propagates', async () => {
    const { surface } = await onErp();
    const view = await surface.view(bare);
    await client!.call('run.end', { runId: RUN });
    await expect(desktopCandidatesFor(surface, refOf(view, 'Button', 'Find'), { masker: bare, base })).rejects.toBeInstanceOf(NoRunError);
  });
});
