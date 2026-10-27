import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // expect.poll waits on a browser (a route handler, a watchdog closing the session). 1 s, the default, is too short on
    // a shared CI runner with Chromium in several workers.
    expect: { poll: { timeout: 10_000 } },
  },
});
