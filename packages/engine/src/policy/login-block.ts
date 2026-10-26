import type { Script } from '../types.js';

// Engine-internal positions in a script's login block (not part of the package's exports). policy/validate.ts:loginBlockEnd
// defines the block: the signIn, its consecutive `when` steps, then an immediately following detect.

/** Index of the script's signIn step, or -1. */
export function signInIndex(script: Script): number {
  return script.steps.findIndex((s) => 'signIn' in s);
}

/** Index of the detect that ends the login block, or -1 when the block has none (capture, re-anchor and resume at it). */
export function loginDetectIndex(script: Script, loginEnd: number): number {
  return loginEnd >= 0 && 'detect' in script.steps[loginEnd] ? loginEnd : -1;
}
