import type { StepVerb } from '../../types.js';
import type { SurfaceKind } from '../../surface/surface.js';
import type { Handler } from '../run.js';

/** Step handlers per surface kind: the browser's are registered by the handler modules; the desktop's come with the desktop runner. */
export const HANDLERS: Record<SurfaceKind, Partial<Record<StepVerb, Handler>>> = { browser: {}, desktop: {} };

/** Registers handlers for one surface kind. The returned function restores that kind's previous entries for these verbs. */
export function registerHandlers(kind: SurfaceKind, map: Partial<Record<StepVerb, Handler>>): () => void {
  const table = HANDLERS[kind];
  const previous = new Map((Object.keys(map) as StepVerb[]).map((verb) => [verb, table[verb]] as const));
  Object.assign(table, map);
  return () => {
    for (const [verb, handler] of previous) {
      if (handler) table[verb] = handler;
      else delete table[verb];
    }
  };
}
