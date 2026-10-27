import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ENGINE_SRC = fileURLToPath(new URL('../engine/src/index.ts', import.meta.url));

export default defineConfig({
  // Tests run against the engine sources, so they do not need an engine build. The node loads the bundled engine by path
  // (nodes/Playwright/engine.ts); both that path and the package name map to the same sources, so mocks of either apply.
  resolve: {
    alias: [
      { find: /^n8n-rpa-engine$/, replacement: ENGINE_SRC },
      // Vitest may hand the loader's relative path over resolved against the package root (or as a /@fs/ path).
      { find: /^(?:\.\.\/\.\.|.*\/n8n-nodes-rpa)?\/engine\/index\.js$/, replacement: ENGINE_SRC },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // As in the engine, so an expect.poll on a browser does not give up after 1 s (the default) on a shared CI runner.
    expect: { poll: { timeout: 10_000 } },
  },
});
