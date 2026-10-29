import type { DesktopVerb, StepVerb } from '../../types.js';
import type { SurfaceKind } from '../../surface/surface.js';
import type { Handler } from '../run.js';

/** A verb of either surface kind: the browser's, or the desktop's (which adds key and expectFile). */
export type AnyVerb = StepVerb | DesktopVerb;

/** Step handlers per surface kind: the browser's are registered by the handler modules; the desktop's by desktop/handlers.ts. */
export const HANDLERS: Record<SurfaceKind, Partial<Record<AnyVerb, Handler>>> = { browser: {}, desktop: {} };

/** Registers handlers for one surface kind. The returned function restores that kind's previous entries for these verbs. */
export function registerHandlers(kind: SurfaceKind, map: Partial<Record<AnyVerb, Handler>>): () => void {
  const table = HANDLERS[kind];
  const previous = new Map((Object.keys(map) as AnyVerb[]).map((verb) => [verb, table[verb]] as const));
  Object.assign(table, map);
  return () => {
    for (const [verb, handler] of previous) {
      if (handler) table[verb] = handler;
      else delete table[verb];
    }
  };
}
