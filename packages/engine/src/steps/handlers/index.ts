import type { StepVerb } from '../../types.js';
import type { Handler } from '../run.js';

export const HANDLERS: Partial<Record<StepVerb, Handler>> = {};

export function registerHandlers(map: Partial<Record<StepVerb, Handler>>): void {
  Object.assign(HANDLERS, map);
}
