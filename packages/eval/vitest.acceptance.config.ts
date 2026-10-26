import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ENGINE_SRC = fileURLToPath(new URL('../engine/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^n8n-rpa-engine$/, replacement: ENGINE_SRC },
      // The node's sources load the bundled engine by path (n8n-nodes-rpa/nodes/Playwright/engine.ts); map it to the sources.
      { find: /^(?:\.\.\/\.\.|.*\/n8n-nodes-rpa)?\/engine\/index\.js$/, replacement: ENGINE_SRC },
    ],
  },
  test: { include: ['acceptance/**/*.test.ts'], testTimeout: 600_000, hookTimeout: 120_000, pool: 'forks', fileParallelism: false },
});
