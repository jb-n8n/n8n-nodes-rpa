// The ERP Demo v2 repair as a fake chat model plays it (the turns the live model took), shared by the engine's e2e test
// and the node's desktop repair test.
import type { FakeTurn } from './fake-model.js';

/** The ref of the element `ControlType "name"` in the latest view of a tool result (the view's lines are indented). */
export function ref(text: string, controlType: string, name: string): string {
  const view = text.slice(text.lastIndexOf('<page_content>'));
  const m = [...view.matchAll(/^\s*\[(e\d+)\] (\S+) "([^"]*)"/gm)].find((x) => x[2] === controlType && x[3] === name);
  if (!m) throw new Error(`no ${controlType} "${name}" in the view:\n${view}`);
  return m[1]!;
}
/** The latest view the model saw (a refused tool call carries none: the view before it still holds). */
export const latestView = (messages: { content: string }[]): string => [...messages].reverse().find((m) => m.content.includes('<page_content>'))?.content ?? '';
export const on = (tool: string, controlType: string, name: string): FakeTurn => (_t, messages) => ({ name: tool, args: { ref: ref(latestView(messages), controlType, name) } });
export const call = (tool: string, args: Record<string, unknown> = {}): FakeTurn => () => ({ name: tool, args });

/**
 * The ERP Demo v2 repair as the live model did it: Find for Search, Reports opened without closing File first (the
 * stale "Click File" folds, B7), Export line items..., Continue added.
 */
export const V2_TURNS: FakeTurn[] = [
  on('use_target', 'Button', 'Find'),
  on('expand', 'MenuItem', 'Reports'),
  on('use_target', 'MenuItem', 'Export line items...'),
  on('add_step', 'Button', 'Continue'),
];

