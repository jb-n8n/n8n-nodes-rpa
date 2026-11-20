import type { UiaCond } from '../../types.js';
import type { DesktopViewItem } from '../surface.js';

/** One node of a desktop view as a tree. */
export interface TreeNode { ref: string; item: DesktopViewItem; parent?: TreeNode; children: TreeNode[] }

/** The roots of a view's items (depth-first order, each with its parent's ref), children in view order. */
export function buildTree(items: DesktopViewItem[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const item of items) {
    const parent = item.parent ? nodes.get(item.parent) : undefined;
    const node: TreeNode = { ref: item.ref, item, ...(parent ? { parent } : {}), children: [] };
    nodes.set(item.ref, node);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/** The runner's condition match (TargetResolver.Matches): controlType ignores case, the rest is exact; `index` is not applied. */
function matches(item: DesktopViewItem, c: UiaCond): boolean {
  return (c.controlType === undefined || item.controlType.toLowerCase() === c.controlType.toLowerCase())
    && (c.automationId === undefined || item.automationId === c.automationId)
    && (c.name === undefined || item.name === c.name)
    && (c.className === undefined || item.className === c.className);
}

function descendants(node: TreeNode, out: TreeNode[]): void {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
}

/**
 * The nodes a condition path picks out, like the runner's: each condition is matched among the descendants (never the
 * node itself) of the previous matches, depth-first, without duplicates. `index` is ignored.
 */
export function matchLocal(roots: TreeNode[], path: UiaCond[]): TreeNode[] {
  let current = roots;
  for (const cond of path) {
    const next = new Set<TreeNode>();
    for (const node of current) {
      const all: TreeNode[] = [];
      descendants(node, all);
      for (const d of all) if (matches(d.item, cond)) next.add(d);
    }
    current = [...next];
    if (current.length === 0) break;
  }
  return current;
}
