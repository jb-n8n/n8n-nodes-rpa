import { describe, expect, it } from 'vitest';
import {
  DESKTOP_MAX_INSERTED_PER_FIX, PatchError, SECRET_FILL_NOT_REPAIRED, WRITE_STEP_NOT_REPAIRED, compileFix, desktopIntent, retargetStep, unrepairable, type Recorded,
} from '../src/desktop/repair/patch.js';
import type { DesktopLocator, DesktopScript, DesktopStep } from '../src/types.js';
import { EXPECTED } from './fixtures/erp-steps.js';

const W = { exe: 'erpdemo.exe', title: 'ERP Demo - Line items' };
const loc = (controlType: string, name: string): DesktopLocator => ({ uia: { window: W, path: [{ controlType, name }] } });
const same = (s: string): string => s;
const doc = (): DesktopScript => structuredClone(EXPECTED);
const intents = (d: DesktopScript): string[] => d.steps.map((s) => s.intent);

describe('retargetStep', () => {
  it('keeps the verb, value and intent; only the locator changes', () => {
    const fill = { intent: 'Type into X', fill: { field: loc('Edit', 'X'), value: '{{var.x}}' }, optional: true } as DesktopStep;
    const next = retargetStep(fill, 'target', loc('Edit', 'Y'), () => false);
    expect(next).toEqual({ ...fill, fill: { field: loc('Edit', 'Y'), value: '{{var.x}}' } });
    const dbl = { intent: 'Double-click Row', doubleClick: loc('DataItem', 'Row') } as DesktopStep;
    expect(retargetStep(dbl, 'target', loc('DataItem', 'Line'))).toEqual({ intent: 'Double-click Row', doubleClick: loc('DataItem', 'Line') });
  });

  it('never retargets a declared write step or a secret fill (DR2)', () => {
    const click = { intent: 'Click Save', click: loc('Button', 'Save'), write: true } as DesktopStep;
    expect(() => retargetStep(click, 'target', loc('Button', 'Store'))).toThrow(WRITE_STEP_NOT_REPAIRED);
    const secret = { intent: 'Type the password', fill: { field: loc('Edit', 'Password'), value: '{{var.pw}}' } } as DesktopStep;
    expect(() => retargetStep(secret, 'target', loc('Edit', 'Pass'), (n) => n === 'pw')).toThrow(SECRET_FILL_NOT_REPAIRED);
    // A caller that does not say which variables are secret fails closed: every variable counts as one.
    expect(() => retargetStep(secret, 'target', loc('Edit', 'Pass'))).toThrow(SECRET_FILL_NOT_REPAIRED);
    expect(unrepairable({ intent: 'Type x', fill: { field: loc('Edit', 'X'), value: 'literal' } } as DesktopStep)).toBeUndefined();
    expect(unrepairable({ intent: 'Pick', select: { field: loc('ComboBox', 'C'), option: 'a {{var.pw}}' } } as DesktopStep, (n) => n === 'pw')).toBe(SECRET_FILL_NOT_REPAIRED);
  });

  it('retarget of an expect replaces expect.visible only', () => {
    const step = { intent: 'Click Go', click: loc('Button', 'Go'), expect: { visible: loc('Text', 'Done') } } as DesktopStep;
    expect(retargetStep(step, 'expect', loc('Text', 'Finished'))).toEqual({ intent: 'Click Go', click: loc('Button', 'Go'), expect: { visible: loc('Text', 'Finished') } });
  });

  it('refuses expectFile, a key without a target and a clipboard read', () => {
    expect(() => retargetStep({ intent: 'f', expectFile: { pattern: 'x' } } as DesktopStep, 'target', loc('Text', 'a'))).toThrow(PatchError);
    expect(() => retargetStep({ intent: 'k', key: { key: 'Enter' } } as DesktopStep, 'target', loc('Text', 'a'))).toThrow(PatchError);
    expect(() => retargetStep({ intent: 'r', read: { clipboard: true, as: 'code' } } as DesktopStep, 'target', loc('Text', 'a'))).toThrow(PatchError);
  });
});

describe('desktopIntent', () => {
  it("follows the importer's wording and masks names", () => {
    const l = loc('Button', 'x');
    expect(desktopIntent({ intent: '', click: l }, 'Find', same)).toBe('Click Find');
    expect(desktopIntent({ intent: '', doubleClick: l }, 'Row 1', same)).toBe('Double-click Row 1');
    const mask = (s: string): string => s.replace('hunter2', '[secret]');
    expect(desktopIntent({ intent: '', fill: { field: l, value: 'v' } }, 'hunter2', mask)).toBe('Type into [secret]');
    expect(desktopIntent({ intent: '', select: { field: l, option: 'A' } }, 'Company', same)).toBe('Choose A in Company');
    expect(desktopIntent({ intent: '', check: { field: l, checked: false } }, 'Box', same)).toBe('Uncheck Box');
    expect(desktopIntent({ intent: '', check: { field: l } }, 'Box', same)).toBe('Check Box');
    expect(desktopIntent({ intent: '', waitFor: { target: l } }, 'Grid', same)).toBe('Wait for Grid');
    expect(desktopIntent({ intent: '', read: { target: l, as: 'out_X' } }, 'Count', same)).toBe('Read Count as out_X');
    expect(desktopIntent({ intent: '', key: { key: 'Enter', target: l } }, 'Password', same)).toBe('Press Enter in Password');
    expect(desktopIntent({ intent: '', key: { key: 'Enter' } }, 'Password', same)).toBe('Press Enter');
  });

  it('clips names to 80 characters and keeps the intent on one line', () => {
    const out = desktopIntent({ intent: '', click: loc('Button', 'x') }, `${'a'.repeat(100)}\nb`, same);
    expect(out).toBe(`Click ${'a'.repeat(80)}`);
    expect(desktopIntent({ intent: '', click: loc('Button', 'x') }, 'a\nb', same)).toBe('Click a\\nb');
  });
});

describe('compileFix', () => {
  const fixAt = (failedIndex: number, recorded: Recorded[], extra: object = {}) => ({ failedIndex, part: 'target' as const, recorded, ...extra });

  it('menu stack: expand Help, escape, expand Reports keeps only Click Reports', () => {
    const d = doc();
    const out = compileFix(d, fixAt(8, [
      { kind: 'openMenu', loc: loc('MenuItem', 'Help'), name: 'Help' },
      { kind: 'escape' },
      { kind: 'openMenu', loc: loc('MenuItem', 'Reports'), name: 'Reports' },
    ], { loc: loc('Button', 'Find'), targetName: 'Find' }), same);
    expect(out.from).toBe(8);
    expect(out.retargetedIndex).toBe(9);
    expect(out.doc.steps.length).toBe(EXPECTED.steps.length + 1);
    expect(intents(out.doc).slice(8, 10)).toEqual(['Click Reports', 'Click Find']);
    expect(d).toEqual(EXPECTED);
  });

  it('escape after a menu-opening step folds that step', () => {
    const out = compileFix(doc(), fixAt(12, [
      { kind: 'escape' },
      { kind: 'openMenu', loc: loc('MenuItem', 'Reports'), name: 'Reports' },
    ], { loc: loc('MenuItem', 'Export line items...'), targetName: 'Export line items...' }), same);
    expect(out.from).toBe(11);
    expect(out.retargetedIndex).toBe(12);
    expect(out.doc.steps.length).toBe(EXPECTED.steps.length);
    expect(intents(out.doc).slice(11, 13)).toEqual(['Click Reports', 'Click Export line items...']);
  });

  it('folds at most FOLD_MAX steps', () => {
    const d = doc();
    const menu = (name: string): DesktopStep => ({ intent: `Click ${name}`, click: loc('MenuItem', name) }) as DesktopStep;
    d.steps.splice(11, 0, menu('A'), menu('B'), menu('C'));
    const out = compileFix(d, fixAt(15, [{ kind: 'escape' }, { kind: 'escape' }, { kind: 'escape' }], { loc: loc('MenuItem', 'Z'), targetName: 'Z' }), same);
    expect(out.from).toBe(13);
    expect(intents(out.doc).slice(11, 15)).toEqual(['Click A', 'Click B', 'Press Escape', 'Click Z']);
    expect(out.doc.steps[13]).toMatchObject({ key: { key: 'Escape' } });
  });

  it('a write step before the range is never folded; an escape there stays as Press Escape', () => {
    const d = doc();
    (d.steps[11] as DesktopStep).write = true;
    const out = compileFix(d, fixAt(12, [{ kind: 'escape' }], { loc: loc('MenuItem', 'Export...'), targetName: 'Export...' }), same);
    expect(out.from).toBe(12);
    expect(out.doc.steps[11]?.write).toBe(true);
    expect(out.doc.steps[12]).toEqual({ intent: 'Press Escape', key: { key: 'Escape' } });
    expect(out.doc.steps[13]?.intent).toBe('Click Export...');
  });

  it('a menu click with a condition, check or optional flag is not folded', () => {
    for (const extra of [{ optional: true }, { when: { visible: loc('Text', 'a') } }, { expect: { visible: loc('Text', 'a') } }]) {
      const d = doc();
      Object.assign(d.steps[11] as DesktopStep, extra);
      const out = compileFix(d, fixAt(12, [{ kind: 'escape' }], { loc: loc('MenuItem', 'Export...'), targetName: 'Export...' }), same);
      expect(out.from).toBe(12);
      expect(out.doc.steps[11]).toMatchObject(extra);
      expect(out.doc.steps[12]).toEqual({ intent: 'Press Escape', key: { key: 'Escape' } });
    }
  });

  it('an expect retarget keeps the base intent and changes only expect.visible', () => {
    const d = doc();
    const base = { ...(d.steps[8] as DesktopStep), expect: { visible: loc('Text', 'Done') } } as DesktopStep;
    d.steps[8] = base;
    const out = compileFix(d, { failedIndex: 8, part: 'expect', recorded: [], loc: loc('Text', 'Finished'), targetName: 'Finished' }, same);
    expect(out.doc.steps[8]).toEqual({ ...base, expect: { visible: loc('Text', 'Finished') } });
    expect(out.doc.steps[8]?.intent).toBe('Click Search');
  });

  it('an inserted click lands right before the failed step, which stays unchanged', () => {
    const out = compileFix(doc(), fixAt(13, [{ kind: 'inserted', loc: loc('Button', 'Continue'), name: 'Continue' }]), same);
    expect(out.from).toBe(13);
    expect(out.retargetedIndex).toBe(14);
    expect(out.doc.steps[13]).toEqual({ intent: 'Click Continue', click: loc('Button', 'Continue') });
    expect(out.doc.steps[14]).toEqual(EXPECTED.steps[13]);
    expect(out.doc.steps.length).toBe(EXPECTED.steps.length + 1);
  });

  it('never repairs a failed write step, not even with a step inserted before it (DR2)', () => {
    const d = doc();
    (d.steps[15] as DesktopStep).write = true;
    expect(() => compileFix(d, fixAt(15, [], { loc: loc('Button', 'Store'), targetName: 'Store' }), same)).toThrow(WRITE_STEP_NOT_REPAIRED);
    expect(() => compileFix(d, fixAt(15, [{ kind: 'inserted', loc: loc('Button', 'Continue'), name: 'Continue' }]), same)).toThrow(WRITE_STEP_NOT_REPAIRED);
  });

  it('invariants: a new step never carries write; more than 3 inserted steps is refused', () => {
    const out = compileFix(doc(), fixAt(8, [
      { kind: 'select', loc: loc('TabItem', 'T'), name: 'T' },
      { kind: 'inserted', loc: loc('Button', 'B'), name: 'B' },
    ]), same);
    expect(out.doc.steps.slice(8, 10).every((s) => s.write === undefined)).toBe(true);
    const many: Recorded[] = Array.from({ length: DESKTOP_MAX_INSERTED_PER_FIX + 1 }, (_, i) => ({ kind: 'inserted', loc: loc('Button', `B${i}`), name: `B${i}` }));
    expect(() => compileFix(doc(), fixAt(8, many), same)).toThrow(PatchError);
  });

  it('masks recorded names in the intents', () => {
    const out = compileFix(doc(), fixAt(8, [{ kind: 'inserted', loc: loc('Button', 'hunter2'), name: 'hunter2' }]), (s) => s.replace('hunter2', '[secret]'));
    expect(out.doc.steps[8]?.intent).toBe('Click [secret]');
  });
});
