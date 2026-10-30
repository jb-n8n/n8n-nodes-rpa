// The desktop surface's view for the repair agent: a pruned UI Automation tree with automation ids, classes and parents
// per ref, masked as snapshot() masks; and the runner's windows, with the fallback for a runner older than the method.
import { afterEach, describe, expect, it } from 'vitest';
import { connectRunner, type RunnerClient } from '../src/desktop/client.js';
// The desktop step handlers register themselves on import (as the desktop task imports them).
import '../src/desktop/handlers.js';
import { createDesktopSurface, type DesktopSurface, type DesktopView, type DesktopViewItem } from '../src/desktop/surface.js';
import { createMasker } from '../src/secrets/mask.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { DesktopLocator } from '../src/types.js';
import { ERP_EXE, ERP_PASSWORD, ERP_POLICY, ERP_USER, FakeRunner, type FakeRunnerOptions } from './fake-runner.js';

const RUN = 'view';
const MAIN = { title: 'ERP Demo - Line items' };
const uia = (automationId: string, controlType = 'Edit'): DesktopLocator => ({ uia: { path: [{ controlType, automationId }] } });
const FILL = [
  { intent: 'Type the user name', fill: { field: uia('txtUser'), value: '{{var.user}}' } },
  { intent: 'Type the password', fill: { field: uia('txtPassword'), value: '{{var.password}}' } },
];
const SIGN_IN = [...FILL, { intent: 'Sign in', click: uia('btnSignIn', 'Button') }];

let runner: FakeRunner | undefined;
let client: RunnerClient | undefined;
afterEach(async () => {
  await client?.close();
  await runner?.close();
  client = undefined;
  runner = undefined;
});

/** The ERP Demo on a run of its own, with a desktop surface and a step context as runDesktopTask builds them. */
async function onErp(opts: FakeRunnerOptions = {}): Promise<{ surface: DesktopSurface; run: (steps: unknown[]) => Promise<void> }> {
  runner = await FakeRunner.start({ app: 'erp', policy: ERP_POLICY, ...opts });
  client = await connectRunner(runner.endpoint);
  await client.call('run.begin', { runId: RUN, leaseMs: 60_000 });
  await client.call('app.launch', { runId: RUN, app: { exe: ERP_EXE } });
  const surface = createDesktopSurface(client, RUN, { exe: ERP_EXE });
  const ctx: StepContext = {
    page: undefined as never, surface,
    script: { surface: 'desktop', name: 'erp-view', version: 1, app: { exe: ERP_EXE }, steps: [] } as never,
    policy: { startUrl: 'about:blank', navHosts: [], subresourceHosts: [], login: [], allowedSubmits: [] },
    vars: { user: ERP_USER, password: ERP_PASSWORD }, masker: createMasker([]), defaultTimeoutMs: 1000, violations: [],
  };
  surface.trackStep(() => ctx.stepIndex);
  const run = async (steps: unknown[]) => {
    const res = await runSteps(ctx, steps as never, newRunState());
    if (!res.ok) throw new Error(res.failure.message);
  };
  return { surface, run };
}

const item = (view: DesktopView, controlType: string, name: string): DesktopViewItem => {
  const found = view.items.find((i) => i.controlType === controlType && i.name === name);
  if (!found) throw new Error(`no ${controlType} "${name}" in the view`);
  return found;
};
/** The item's ancestors, nearest first, as `ControlType "name"`. */
const ancestors = (view: DesktopView, of: DesktopViewItem): string[] => {
  const byRef = new Map(view.items.map((i) => [i.ref, i]));
  const out: string[] = [];
  for (let p = of.parent ? byRef.get(of.parent) : undefined; p; p = p.parent ? byRef.get(p.parent) : undefined) out.push(`${p.controlType} "${p.name}"`);
  return out;
};

describe('desktop view', () => {
  it('view keeps automation ids, classes and parents per ref', async () => {
    const { surface, run } = await onErp();
    await run(SIGN_IN);
    const view = await surface.view(createMasker([]));
    expect(view.window).toEqual({ title: 'ERP Demo - Line items', exe: ERP_EXE });
    expect(view.truncated).toBe(false);
    const search = item(view, 'Button', 'Search');
    const group = item(view, 'Group', 'Line items');
    expect(search).toMatchObject({ automationId: 'btnSearch', parent: group.ref, depth: group.depth + 1, enabled: true });
    expect(group).toMatchObject({ automationId: 'grpSearch', parent: view.items[0].ref });
    expect(view.items[0]).toMatchObject({ controlType: 'Window', automationId: 'MainForm', depth: 0 });
    expect(view.items[0]).not.toHaveProperty('parent');
    expect(search.className).toBe('');
    // The raw node behind each ref, with its parent and window.
    expect(surface.nodeOf(search.ref)).toMatchObject({
      node: { controlType: 'Button', automationId: 'btnSearch', name: 'Search' }, parent: group.ref,
      window: { title: 'ERP Demo - Line items', exe: ERP_EXE }, truncated: false,
    });
    // maxNodes cuts the view short and says so.
    const cut = await surface.view(createMasker([]), { maxNodes: 3 });
    expect(cut.items).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });

  it('view never shows a password value and masks typed values', async () => {
    const { surface, run } = await onErp();
    await run(FILL);
    // A masker as the desktop task builds it: secrets and the typed variable values of 4 characters or more.
    const masker = createMasker(surface.typed.filter((t) => t.length >= 4));
    const view = await surface.view(masker);
    expect(view.window.title).toBe('ERP Demo - Sign in');
    const password = item(view, 'Edit', 'Password');
    expect(password.valueHidden).toBe(true);
    expect(password).not.toHaveProperty('value');
    expect(item(view, 'Edit', 'User name')).toMatchObject({ value: '[secret]', automationId: 'txtUser', className: 'WindowsForms10.EDIT.app.0.2bf8098_r6_ad1' });
    const text = JSON.stringify(view);
    expect(text).not.toContain(ERP_PASSWORD);
    expect(text).not.toContain(ERP_USER);
    // The surface masks its typed values itself too, whatever masker it is given.
    const bare = JSON.stringify(await surface.view(createMasker([])));
    expect(bare).not.toContain(ERP_USER);
    expect(bare).not.toContain(ERP_PASSWORD);
  });

  it('view with a window selector snapshots that window', async () => {
    const { surface, run } = await onErp({ erpUi: 'v2' });
    await run([...SIGN_IN, { intent: 'Open Reports', click: { uia: { window: MAIN, path: [{ controlType: 'MenuItem', name: 'Reports' }] } } }]);
    expect((await surface.windows()).map((w) => w.title)).toEqual(['ERP Demo - Line items', 'Reports']);
    // The drop-down sits in front of the main form; the selector picks the main form, whose tree nests the drop-down.
    const main = await surface.view(createMasker([]), { window: MAIN });
    expect(main.window).toEqual({ title: 'ERP Demo - Line items', exe: ERP_EXE });
    const exportItem = item(main, 'MenuItem', 'Export line items...');
    expect(ancestors(main, exportItem)).toEqual(['Menu "Reports"', 'MenuItem "Reports"', 'MenuBar ""', 'Window "ERP Demo - Line items"']);
    expect(surface.nodeOf(exportItem.ref)?.window.title).toBe('ERP Demo - Line items');
    // The drop-down's own window.
    const dropDown = await surface.view(createMasker([]), { window: { title: 'Reports' } });
    expect(dropDown.window).toEqual({ title: 'Reports', exe: ERP_EXE });
    expect(dropDown.items.map((i) => [i.depth, i.controlType, i.name, i.automationId])).toEqual([[0, 'Menu', 'Reports', ''], [1, 'MenuItem', 'Export line items...', '']]);
    expect(dropDown.items[1].parent).toBe(dropDown.items[0].ref);
  });

  it('windows falls back to [] on a runner without the method', async () => {
    const { surface } = await onErp({ noWindowsMethod: true });
    expect(await surface.windows()).toEqual([]);
    // An older runner is no step failure.
    expect(surface.errors.size).toBe(0);
    await client!.close();
    await runner!.close();

    // Other errors are thrown (and recorded, as every runner call's are).
    const { surface: current } = await onErp();
    expect((await current.windows()).map((w) => w.title)).toEqual(['ERP Demo - Sign in']);
    await client!.call('run.end', { runId: RUN });
    await expect(current.windows()).rejects.toMatchObject({ code: -32008 });
    expect(current.errors.size).toBe(1);
  });

  it('refs from an earlier view are gone', async () => {
    const { surface, run } = await onErp();
    await run(SIGN_IN);
    const first = await surface.view(createMasker([]));
    const old = first.items[0].ref;
    expect(surface.nodeOf(old)).toBeDefined();
    const second = await surface.view(createMasker([]));
    expect(surface.nodeOf(old)).toBeUndefined();
    // Refs never repeat across views on one surface.
    const firstRefs = new Set(first.items.map((i) => i.ref));
    expect(second.items.some((i) => firstRefs.has(i.ref))).toBe(false);
    expect(second.items.every((i) => /^e\d+$/.test(i.ref))).toBe(true);
    expect(surface.nodeOf(second.items[0].ref)).toBeDefined();
    // A snapshot clears them too.
    await surface.snapshot(createMasker([]));
    expect(surface.nodeOf(second.items[0].ref)).toBeUndefined();
  });
});
