import type { Locator } from '../types.js';

/** An error whose (masked) message is safe and useful to keep when a fatal violation stops the run. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * resolveUnique found no element for a step's locator ("No element found …"): the control is not on the page. The run
 * looks once at what the page shows instead (steps/page-offers.ts). `locator` is the one the step used, rendered.
 */
export class ControlNotFound extends Error {
  constructor(message: string, readonly locator: Locator) {
    super(message);
    this.name = 'ControlNotFound';
  }
}
