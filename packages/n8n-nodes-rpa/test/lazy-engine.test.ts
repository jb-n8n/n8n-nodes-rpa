// n8n requires every installed node file to list it. Loading the compiled node must not load the engine or playwright-core
// (spec: the engine loads on first use). Runs against dist, which the package "test" script compiles first (the engine dist comes from `pnpm -r build`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const NODE_FILE = fileURLToPath(new URL('../dist/nodes/Playwright/Playwright.node.js', import.meta.url));
const ENGINE_LOADER = fileURLToPath(new URL('../dist/nodes/Playwright/engine.js', import.meta.url));
const ENGINE_DIST = fileURLToPath(new URL('../dist/engine/index.js', import.meta.url));
const built = existsSync(NODE_FILE) && existsSync(ENGINE_DIST);
// The positive control sees the ESM engine only through module.registerHooks (Node 22.15+ / 23.5+).
const hooks = typeof (await import('node:module')).registerHooks === 'function';
if (!built) console.warn(`lazy-engine test skipped: ${NODE_FILE} or ${ENGINE_DIST} is missing; run \`pnpm --filter n8n-nodes-rpa build\` (pnpm test builds first)`);

// A child process records every module it loads: CommonJS via require.cache, ESM and CommonJS via module.registerHooks.
const PROBE = `
const Module = require('node:module');
const seen = new Set();
if (typeof Module.registerHooks === 'function') {
  Module.registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); seen.add(r.url); return r; } });
}
const BAD = /playwright-core|n8n-rpa-engine|packages[\\\\/]engine[\\\\/]|dist[\\\\/]engine[\\\\/]/;
const hits = () => [...seen, ...Object.keys(require.cache)].filter((k) => BAD.test(k));
const { Playwright } = require(process.argv[1]);
const node = new Playwright();
void node.description.properties.length;
void Object.keys(node.methods.credentialTest);
setTimeout(async () => {
  const listed = hits();
  await require(process.argv[2]).loadEngine(); // positive control: first use does load it, and the probe sees that
  console.log(JSON.stringify({ listed, afterUse: hits().length }));
}, 50);
`;

describe('the compiled node', () => {
  it.skipIf(!built)('loads without loading the engine or playwright-core, which load on first use', () => {
    const r = spawnSync(process.execPath, ['-e', PROBE, NODE_FILE, ENGINE_LOADER], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { listed: string[]; afterUse: number };
    expect(out.listed).toEqual([]);
    if (hooks) expect(out.afterUse).toBeGreaterThan(0);
  });
});
