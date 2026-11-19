import { describe, expect, it } from 'vitest';
import type { DesktopViewItem } from '../src/desktop/surface.js';
import { buildTree, matchLocal } from '../src/desktop/repair/tree.js';
import { stableDesktopId } from '../src/desktop/stable-ids.js';

const item = (ref: string, depth: number, controlType: string, name: string, automationId = '', parent?: string, className = ''): DesktopViewItem => ({
  ref, depth, controlType, name, fullName: name, automationId, className, enabled: true, ...(parent ? { parent } : {}),
});

describe('desktop repair helpers', () => {
  it('stableDesktopId accepts WinForms names and Win32 control ids', () => {
    for (const id of ['btnFind', 'txtDateFrom', 'MainForm', '1', '1001']) expect(stableDesktopId(id), id).toBe(true);
  });

  it('stableDesktopId refuses generated ids', () => {
    for (const id of ['', ' ', 'a b', '3f2a9c1e-77b0-4c1d-9a55-0123456789ab', 'a1b2c3d4e5', '1234567', '42.1.7']) expect(stableDesktopId(id), id).toBe(false);
  });

  it('matchLocal follows descendants in order like the runner', () => {
    const roots = buildTree([
      item('v1', 0, 'Window', 'Orders'),
      item('v2', 1, 'Group', 'Search', 'grpSearch', 'v1'),
      item('v3', 2, 'Button', 'Find', 'btnFind', 'v2'),
      item('v4', 1, 'Button', 'Find', 'btnOther', 'v1'),
      item('v5', 1, 'Button', 'Close', '', 'v1', 'Btn'),
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children.map((c) => c.ref)).toEqual(['v2', 'v4', 'v5']);
    expect(matchLocal(roots, [{ automationId: 'grpSearch' }, { controlType: 'Button', name: 'Find' }]).map((n) => n.ref)).toEqual(['v3']);
    expect(matchLocal(roots, [{ controlType: 'Button' }]).map((n) => n.ref)).toEqual(['v3', 'v4', 'v5']);
    // case-insensitive controlType, exact name and className, the node itself never matches
    expect(matchLocal(roots, [{ controlType: 'button', className: 'Btn' }]).map((n) => n.ref)).toEqual(['v5']);
    expect(matchLocal(roots, [{ name: 'find' }])).toEqual([]);
    expect(matchLocal(roots, [{ controlType: 'Window' }])).toEqual([]);
    expect(matchLocal(roots, [{ controlType: 'Button' }, { controlType: 'Button' }])).toEqual([]);
  });
});
