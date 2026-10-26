import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run against the engine sources, so they do not need an engine build.
  resolve: { alias: { 'n8n-rpa-engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 60_000, pool: 'forks' },
});
