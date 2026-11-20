import type { Masker } from '../../secrets/mask.js';
import type { DesktopLocator, DesktopScript, UiaCond, UiaTarget, WindowSel } from '../../types.js';
import { ElementNotFoundError, ElementNotUniqueError } from '../protocol.js';
import { runnerTarget, type DesktopSurface } from '../surface.js';
import { stableDesktopId } from '../stable-ids.js';
import { buildTree, matchLocal, type TreeNode } from './tree.js';

/** The repair agent chose a node that no locator can pick out; the message is engine text for the agent. */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

const MAX_NAME = 80;
const MAX_FALLBACKS = 2;
const RESOLVE_MS = 500;

/** Every window selector the step set uses, in step order (targets, fallbacks, when and expect included). */
function windowsOf(base: DesktopScript): WindowSel[] {
  const out: WindowSel[] = [];
  const add = (loc: DesktopLocator | undefined) => {
    for (const t of loc ? [loc.uia, ...(loc.fallbacks ?? []).map((f) => f.uia)] : []) if (t.window) out.push(t.window);
  };
  for (const step of base.steps) {
    add(step.when?.visible);
    add(step.expect?.visible);
    if ('click' in step) add(step.click);
    else if ('doubleClick' in step) add(step.doubleClick);
    else if ('fill' in step) add(step.fill.field);
    else if ('select' in step) add(step.select.field);
    else if ('check' in step) add(step.check.field);
    else if ('waitFor' in step) add(step.waitFor.target);
    else if ('read' in step) add('target' in step.read ? step.read.target : undefined);
    else if ('key' in step) add(step.key.target);
  }
  return out;
}

/** The step set's selector for this window when it has one (exe ignoring case, title exact), else `{ exe, title }`. */
function windowSelector(base: DesktopScript, win: { exe: string; title: string }): WindowSel {
  const known = windowsOf(base).find((w) => w.exe !== undefined && w.exe.toLowerCase() === win.exe.toLowerCase() && w.title === win.title);
  if (known) return known;
  return win.title === '' ? { exe: win.exe } : { exe: win.exe, title: win.title };
}

/**
 * The locator for a node of the surface's last view: a primary `{ uia }` target and up to two fallbacks, each one only
 * when it picks out this node alone in the view and the runner resolves it alone to itself. Values come from the raw node,
 * never from the masked view. Throws TargetError when the ref is stale or nothing stable picks the node out.
 */
export async function desktopCandidatesFor(s: DesktopSurface, ref: string, opts: { masker: Masker; base: DesktopScript }): Promise<DesktopLocator> {
  const found = s.nodeOf(ref);
  const stale = new TargetError(`element ${ref} is no longer on the screen; call look for fresh refs`);
  if (!found) throw stale;
  const { node, window } = found;
  const roots = buildTree(s.rawItems());
  let self: TreeNode | undefined;
  const stack = [...roots];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (n.ref === ref) { self = n; break; }
    stack.push(...n.children);
  }
  if (!self) throw stale;
  const sel = windowSelector(opts.base, window);
  const type = node.controlType;
  const id = stableDesktopId(node.automationId ?? '') ? node.automationId : undefined;
  const name = node.name && node.name.length <= MAX_NAME && opts.masker.mask(node.name) === node.name ? node.name : undefined;

  const paths: UiaCond[][] = [];
  if (id && name) paths.push([{ controlType: type, automationId: id, name }], [{ controlType: type, automationId: id }], [{ controlType: type, name }]);
  else if (id) paths.push([{ controlType: type, automationId: id }]);
  else if (name) {
    paths.push([{ controlType: type, name }]);
    if (matchLocal(roots, paths[0]).length > 1) {
      let anchor: TreeNode | undefined = self.parent;
      while (anchor && !stableDesktopId(anchor.item.automationId)) anchor = anchor.parent;
      paths[0] = anchor ? [{ automationId: anchor.item.automationId }, { controlType: type, name }] : paths[0];
    }
  }

  const kept: UiaTarget[] = [];
  for (const path of paths) {
    if (kept.length > MAX_FALLBACKS) break;
    const target: UiaTarget = { window: sel, path };
    // Exactly this node in the view; a truncated view that does not show it proves nothing.
    const hits = matchLocal(roots, path);
    if (hits.length !== 1 || hits[0] !== self) continue;
    if (opts.masker.containsSecret(JSON.stringify(target))) continue;
    try {
      const res = await s.client.callWithin('resolve', { runId: s.runId, target: runnerTarget({ uia: target }), timeoutMs: RESOLVE_MS });
      if (res.candidate !== 0) continue;
    } catch (err) {
      // The runner finds none or several: not a target. Any other fault (a dead runner, a timeout, a policy refusal) is the caller's.
      if (err instanceof ElementNotFoundError || err instanceof ElementNotUniqueError) continue;
      throw err;
    }
    kept.push(target);
  }
  if (kept.length === 0) throw new TargetError(`no stable target for element ${ref}: no automation id or name picks it out alone in its window`);
  return { uia: kept[0], ...(kept.length > 1 ? { fallbacks: kept.slice(1).map((uia) => ({ uia })) } : {}) };
}
