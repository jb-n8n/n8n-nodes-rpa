// Bundles `npx n8n-nodes-rpa setup` (setup/setup.mts, with setup/n8n-api.mjs and the node's Connection Line parser)
// into one file, dist/setup.mjs: the package's bin. Node built-ins stay imports; nothing else is left outside.
import { chmodSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: join(root, 'setup', 'setup.mts'),
    outDir: join(root, 'dist'),
    emptyOutDir: false,
    minify: false,
    target: 'node22',
    rollupOptions: {
      external: (id) => builtins.has(id),
      output: { format: 'es', entryFileNames: 'setup.mjs', banner: '#!/usr/bin/env node' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
chmodSync(join(root, 'dist', 'setup.mjs'), 0o755);
