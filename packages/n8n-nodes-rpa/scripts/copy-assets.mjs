// Copies icons and codex files next to the compiled node and credentials (what `n8n-node build` does), and bundles the
// engine: its compiled JavaScript goes to dist/engine, which the node loads by path (nodes/Playwright/engine.ts), and its
// step schema to dist/schema. The engine is not published on its own; its runtime dependencies (playwright-core, fflate)
// are this package's.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
for (const top of ['nodes', 'credentials']) {
  for (const file of walk(join(root, top)).filter((f) => /\.(svg|png|json)$/.test(f))) {
    const target = join(root, 'dist', relative(root, file));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
}
const engineDist = join(root, '..', 'engine', 'dist');
if (!existsSync(join(engineDist, 'index.js'))) throw new Error(`no engine build at ${engineDist}: run \`pnpm --filter n8n-rpa-engine build\` first`);
for (const file of walk(engineDist).filter((f) => f.endsWith('.js'))) {
  const target = join(root, 'dist', 'engine', relative(engineDist, file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
}
// The engine is an ES module; the node package itself is CommonJS.
writeFileSync(join(root, 'dist', 'engine', 'package.json'), '{ "type": "module" }\n');
// The step document's JSON Schema, for editors (README: Step schema).
mkdirSync(join(root, 'dist', 'schema'), { recursive: true });
cpSync(join(root, '..', 'engine', 'schema', 'steps.schema.json'), join(root, 'dist', 'schema', 'steps.schema.json'));
