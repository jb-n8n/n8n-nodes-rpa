// Template 3's desktop approval for an AI repair (DR11): the whole list with "as approved / retargeted / added" and the
// proof status per step, the comparison and the write ticks only from an approved version whose signature fits.
import { describe, expect, it } from 'vitest';
import * as engine from 'n8n-rpa-engine';
import type { IDataObject } from 'n8n-workflow';
import { EXPECTED } from '../../engine/test/fixtures/erp-steps.js';
import { desktopRepairedStepsJson } from '../nodes/Playwright/output.js';
import { byName, evaluate, jsonFormFields, load, render } from './template-harness.js';

const KEY = 'desktop-signing-key-0123456789abcdef';
const t = load('3-approve-steps.json');
const ask = byName(t, 'Ask for approval (desktop steps)').parameters as Record<string, unknown>;

/** Version 1 as approved (Save, step 16, a write) and its row as the steps table holds it. */
const v1Row = (() => {
  const p = engine.desktopProposal(EXPECTED);
  const s = engine.signDesktopSteps({ proposal: p, key: KEY, approverId: 'owner@example.com', reviewedDigest: engine.proposalDigest(p), writeSteps: [16] });
  if (!s.ok) throw new Error(s.reasons.join('; '));
  return { name: 'erp-1', version: 1, status: 'active', steps: JSON.stringify(s.row.steps), signature: s.row.signature, approvedBy: 'owner@example.com', hash: s.row.hash };
})();

/** Version 2 as a repair proposes it: step 9 retargeted to Find, no write marks, the proof's numbers. */
function repairItem(proof: IDataObject = { replayed: 15, stoppedAt: 16, stoppedBecause: 'declared write', changedSteps: [9], addedSteps: [] }): IDataObject {
  const doc = structuredClone(EXPECTED);
  doc.version = 2;
  doc.steps[8] = { intent: 'Click Find', click: { uia: { window: { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' }, path: [{ controlType: 'Button', automationId: 'btnFind', name: 'Find' }] } } };
  const steps = engine.parseDesktopScript(doc);
  const proposal = {
    name: 'erp-1', baseVersion: 1, version: 2, steps, hash: engine.scriptHash(steps), changes: engine.desktopProposal(steps).changes, safetyFlags: engine.desktopSafetyFlags(steps),
    evidence: { count: 0, total: null, diff: { missing: [], extra: [] }, proof }, screenshots: {},
  };
  return desktopRepairedStepsJson(engine, proposal as never, undefined, ['password']);
}

const scope = (item: IDataObject, fits: boolean | 'none', inUse: number[] = [1], baseStatus = 'active') => ({
  $: (name: string) => {
    if (name === 'The active version') return { isExecuted: true, all: () => (inUse.length ? inUse.map((version) => ({ json: { ...v1Row, version, status: 'active' } })) : [{ json: {} }]) };
    if (name === 'Settings') return { item: { json: { approvalTimeoutHours: 72 } } };
    if (name === 'The approved version') return { isExecuted: true, all: () => (fits === 'none' ? [] : [{ json: { ...v1Row, status: baseStatus } }]) };
    if (name === 'Check the approved version') return { isExecuted: true, all: () => (fits === 'none' ? [] : [{ json: { checkOnly: true, approvedVersion: { version: 1, desktop: true, signatureFits: fits } } }]) };
    return { item: { json: item } };
  },
});
const stepLine = (message: string, n: number) => message.split('\n').find((l) => l.startsWith(`${n}. `)) ?? '';

describe('template 3: a desktop AI repair', () => {
  it('lists every step with its change mark and proof status, compares with the verified version 1 and starts its write ticked', () => {
    const item = repairItem();
    const message = render(String(ask.message), scope(item, true));
    expect(message).toContain('Repaired by AI (as reported by the run): Proven in a fresh start of ErpDemo.exe (as reported by the run): steps 1 to 15 ran; step 16 was found and not run (a write step).');
    expect(message).not.toContain('⚠ Version');
    expect(message).not.toContain('⚠ The steps the repair reports');
    expect(message).toContain('erp-1: changed from the approved version 1: step 9: ');
    expect(message).toContain('(which steps are writes is not compared: you tick them again)');
    expect(message).toContain('Version 1 marked as writes, on steps the repair did not change: step 16. They start ticked.');
    expect(stepLine(message, 1)).toMatch(/\[as approved in version 1; ran in the proof\]$/);
    expect(stepLine(message, 9)).toMatch(/\[retargeted by AI repair \(as reported by the run\); ran in the proof\]$/);
    expect(stepLine(message, 16)).toMatch(/\[as approved in version 1; found in the proof, not run\]$/);
    expect(stepLine(message, 17)).toMatch(/\[as approved in version 1; not run in the proof\]$/);
    expect(message).toContain('tick the steps that save, send or submit (the ones your approved version marked start ticked on the steps the repair did not change: check them)');
    const fields = jsonFormFields(String(ask.jsonOutput), scope(item, true));
    const boxes = fields.find((f) => f.fieldType === 'checkbox')!;
    expect(boxes.fieldOptions!.values.map((v) => v.option)).toEqual(['Step 4: Press Enter in Password', 'Step 16: Click Save']);
    expect(boxes.defaultValue).toBe('Step 16: Click Save');
    expect(fields.find((f) => f.fieldType === 'text')!.defaultValue).toBeUndefined();
    expect(render(String((ask.options as IDataObject).responseFormDescription), scope(item, true))).toContain('the ones your approved version marked start ticked');
  });

  it('a version whose signature does not fit (or none) is not compared, nothing starts ticked, and the item\'s own claims only label steps', () => {
    for (const fits of [false, 'none'] as const) {
      const item = repairItem();
      const message = render(String(ask.message), scope(item, fits));
      expect(message).toContain('erp-1: could not be compared with an approved version 1 whose signature fits: read every step, and tick its writes yourself.');
      expect(message).toContain('No step starts ticked.');
      expect(stepLine(message, 9)).toMatch(/\[retargeted by AI repair \(as reported by the run\); ran in the proof\]$/);
      expect(stepLine(message, 16)).toMatch(/\[unchanged, as the repair reports it; found in the proof, not run\]$/);
      expect(message).toContain('(none is ticked for you)');
      const fields = jsonFormFields(String(ask.jsonOutput), scope(item, fits));
      expect(fields.some((f) => f.defaultValue !== undefined)).toBe(false);
    }
    // An item that hides its change: step 9 differs from the verified version, whatever the proof claims.
    const hiding = repairItem({ replayed: 15, stoppedAt: 16, stoppedBecause: 'declared write', changedSteps: [], addedSteps: [] });
    expect(stepLine(render(String(ask.message), scope(hiding, true)), 9)).toMatch(/\[⚠ not in the approved version; ran in the proof\]$/);
  });

  it('a base that is no longer the version in use: a warning, no comparison, no ticks; claims that differ from the comparison: a warning', () => {
    for (const [inUse, status] of [[[3], 'superseded'], [[], 'superseded']] as [number[], string][]) {
      const item = repairItem();
      const message = render(String(ask.message), scope(item, true, inUse, status));
      expect(message).toContain(`⚠ Version 1 is no longer the one in use${inUse.length ? ' (version 3 is)' : ''}: the steps are not compared with it and no step starts ticked. Read every step.`);
      expect(message).toContain('could not be compared with an approved version 1');
      expect(message).toContain('(none is ticked for you)');
      expect(jsonFormFields(String(ask.jsonOutput), scope(item, true, inUse, status)).some((f) => f.defaultValue !== undefined)).toBe(false);
    }
    const hiding = repairItem({ replayed: 15, stoppedAt: 16, stoppedBecause: 'declared write', changedSteps: [], addedSteps: [] });
    expect(render(String(ask.message), scope(hiding, true))).toContain('⚠ The steps the repair reports it changed or added are not the steps that differ from version 1: read the steps marked below.');
  });

  it('template 3 sends a desktop repair for approval only as a higher version than the one in use; otherwise it records a refusal and stops with why', () => {
    const higher = String((byName(t, 'Higher than the version in use?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0]!.leftValue);
    const check = (version: number, active: (number | undefined)[], repair = true) => evaluate(higher, { $: (name: string) => (name === 'The active version'
      ? { all: () => active.map((v) => ({ json: v === undefined ? {} : { version: v } })) } : { item: { json: { version, ...(repair ? { evidence: { proof: {} } } : {}) } } }) });
    expect(check(2, [1])).toBe(true);
    expect(check(1, [undefined])).toBe(true);
    expect(check(2, [2])).toBe(false);
    expect(check(2, [3])).toBe(false);
    // An import is approved as before (template 5 gives it the next version; an approved import may replace a higher one).
    expect(check(1, [2], false)).toBe(true);
    expect(byName(t, 'Record refusal').parameters).toMatchObject({ operation: 'update', columns: { value: { status: 'rejected' } } });
    expect(String((byName(t, 'Not a higher version').parameters as { errorMessage: string }).errorMessage)).toContain('Not sent for approval: repaired desktop steps version');
  });

  it('an import\'s desktop email reads as before: no repair line, no step labels, none ticked', () => {
    const p = engine.desktopProposal(EXPECTED);
    const item = desktopRepairedStepsJson(engine, p);
    const message = render(String(ask.message), scope(item, 'none'));
    expect(message).toContain('Not tried by the import: read every step before you approve.');
    expect(message).not.toContain('Repaired by AI');
    expect(message).not.toMatch(/\]\n/);
    expect(message).toContain('(none is ticked for you)');
  });
});
