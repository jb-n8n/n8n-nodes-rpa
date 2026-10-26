// The published package bundles the engine (scripts/copy-assets.mjs), so its runtime dependencies are the engine's, plus
// the few the node itself imports.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestProblems, pack, publishManifest, RUNTIME_DEPENDENCIES } from '../scripts/pack.mjs';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<string, unknown>;
const pkg = read('../package.json');
const engine = read('../../engine/package.json');
const deps = pkg.dependencies as Record<string, string>;
const engineDeps = engine.dependencies as Record<string, string>;
// Dependencies only the node imports (not the engine): redis, for the breaker and lock in queue mode (guard-store.ts).
const NODE_ONLY = ['redis'];

describe('the published package', () => {
  it('depends on exactly what the bundled engine imports, at the same versions, plus the node-only dependencies', () => {
    const { redis, ...shared } = deps;
    expect(shared).toEqual(engineDeps);
    expect(redis).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(deps).sort()).toEqual([...Object.keys(engineDeps), ...NODE_ONLY].sort());
  });
  it('has no workspace or unpublished dependency, and pins exact versions', () => {
    expect(JSON.stringify(deps)).not.toMatch(/workspace:|n8n-rpa-/);
    for (const [name, version] of Object.entries(deps)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('is public, MIT and published with provenance', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe('MIT');
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(pkg.files).toContain('dist');
  });
  it('lists every credential the package builds', () => {
    const creds = (pkg.n8n as { credentials: string[] }).credentials;
    expect(creds).toContain('dist/credentials/PlaywrightRedisApi.credentials.js');
    for (const c of creds) expect(existsSync(new URL(`../${c.replace(/^dist\//, '').replace(/\.js$/, '.ts')}`, import.meta.url)), c).toBe(true);
  });
  it('ships the bundled engine and the step schema in dist (pnpm test builds first)', () => {
    expect(existsSync(new URL('../dist/engine/index.js', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../dist/engine/package.json', import.meta.url))).toBe(true);
    expect(read('../dist/schema/steps.schema.json')).toEqual(read('../../engine/schema/steps.schema.json'));
  });
});

describe('the packed tarball (scripts/pack.mjs, what publish.yml publishes)', () => {
  it('cleans the manifest: no devDependencies or scripts, runtime dependencies untouched', () => {
    const cleaned = publishManifest(pkg);
    expect(cleaned).not.toHaveProperty('devDependencies');
    expect(cleaned).not.toHaveProperty('scripts');
    expect(cleaned.dependencies).toEqual(pkg.dependencies);
    expect(Object.keys(deps).sort()).toEqual(RUNTIME_DEPENDENCIES);
    expect(manifestProblems(cleaned, pkg.version as string)).toEqual([]);
  });
  it('refuses a manifest that names a workspace package, a workspace: version or an extra dependency', () => {
    expect(manifestProblems(pkg)).toEqual(expect.arrayContaining(['has devDependencies', 'has scripts', 'names an unpublished workspace package']));
    const bad = { ...publishManifest(pkg), dependencies: { ...deps, 'n8n-rpa-engine': 'workspace:*' } };
    expect(manifestProblems(bad)).toEqual(expect.arrayContaining(['names a workspace: version', 'names an unpublished workspace package']));
    expect(manifestProblems({ ...publishManifest(pkg), version: '9.9.9' }, '0.1.0')).toEqual(['version is 9.9.9, not 0.1.0']);
  });
  it('packs a tarball whose package.json has no devDependencies and no workspace names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpa-pack-test-'));
    try {
      const tgz = pack(dir);
      const packed = JSON.parse(execFileSync('tar', ['-xOzf', tgz, 'package/package.json'], { encoding: 'utf8' })) as Record<string, unknown>;
      expect(packed).not.toHaveProperty('devDependencies');
      expect(JSON.stringify(packed)).not.toMatch(/workspace:|n8n-rpa-/);
      expect(packed.dependencies).toEqual(pkg.dependencies);
      const files = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
      expect(files).toContain('package/dist/engine/index.js');
      expect(files).toContain('package/dist/schema/steps.schema.json');
      expect(files).not.toMatch(/\.d\.ts$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
