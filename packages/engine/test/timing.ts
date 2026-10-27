/**
 * Wall-clock ceilings for timing assertions, in the engine and the node tests.
 *
 * Locally a ceiling is the number written in the test: those numbers catch a quadratic path or a missed cancellation, so
 * they stay tight. A shared CI runner (a few vCPUs, Chromium and other test files alongside) is several times slower in
 * bursts, so with `CI` set every ceiling gets TIMING_SCALE times the room.
 *
 * `below` is for an assertion that tells two durations apart (a cancellation against the step timeout it cuts short, a
 * reserve against the budget): the scaled ceiling never reaches the slower one, so the test still tells them apart on CI.
 */
export const TIMING_SCALE = /^(1|true)$/i.test(process.env.CI ?? '') ? 4 : 1;

export const bound = (ms: number, below = Number.POSITIVE_INFINITY): number => Math.min(ms * TIMING_SCALE, below);
