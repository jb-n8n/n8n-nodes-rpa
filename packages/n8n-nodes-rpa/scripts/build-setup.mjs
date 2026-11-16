// Bundles `npx n8n-nodes-rpa setup` (setup/setup.mts, with the setup/*.mts modules it imports, setup/n8n-api.mjs and
// the node's Connection Line parser) into one file, dist/setup.mjs: the package's bin. Node built-ins stay imports;
// nothing else is left outside. Every npm package the bundle takes in must be named, with its version and its licence
// text, in the package's THIRD-PARTY-NOTICES.md, which npm ships beside dist/: otherwise the build stops.
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const result = await build({
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

// The npm packages in the bundle: the folder of each module under node_modules (a scoped name has two parts).
const bundled = new Map();
for (const output of Array.isArray(result) ? result : [result]) {
  for (const chunk of output.output) {
    for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
      const at = id.lastIndexOf('/node_modules/');
      if (at < 0) continue;
      const parts = id.slice(at + '/node_modules/'.length).split('/');
      const folder = id.slice(0, at + '/node_modules/'.length) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
      bundled.set(folder, true);
    }
  }
}
const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
const missing = [];
for (const folder of bundled.keys()) {
  const { name, version } = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  const file = readdirSync(folder).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  const text = file && existsSync(join(folder, file)) ? readFileSync(join(folder, file), 'utf8').trim() : undefined;
  if (!text) missing.push(`${name} ${version} has no licence file to copy`);
  else if (!notices.includes(`\n## ${name} ${version}\n`) || !notices.includes(text)) missing.push(`${name} ${version} and its licence text`);
}
if (missing.length) throw new Error(`dist/setup.mjs bundles code that THIRD-PARTY-NOTICES.md does not cover: ${missing.join('; ')}. Add it there.`);
