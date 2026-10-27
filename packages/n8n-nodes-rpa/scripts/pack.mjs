// Packs n8n-nodes-rpa: the tarball publish.yml publishes to npm and attaches to the GitHub Release. `pnpm pack`
// rewrites the workspace: versions, then the manifest is cleaned: devDependencies (they name unpublished workspace
// packages such as n8n-rpa-engine, which anyone could register on npm) and the build scripts are dropped, and the result
// is checked. Run after a build:
//   node packages/n8n-nodes-rpa/scripts/pack.mjs <destination directory>
// It prints the tarball's path. No dependencies; needs pnpm, npm and tar.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The runtime dependencies the published package may have: the bundled engine's, plus redis (the node's own). */
export const RUNTIME_DEPENDENCIES = ['fflate', 'playwright-core', 'redis'];

/** The manifest npm receives: no devDependencies, no scripts, nothing pnpm-only. */
export function publishManifest(pkg) {
  const { devDependencies, scripts, pnpm, packageManager, ...rest } = pkg;
  return rest;
}

/** What is wrong with a manifest about to be published (empty when nothing). */
export function manifestProblems(pkg, version) {
  const problems = [];
  if (pkg.name !== 'n8n-nodes-rpa') problems.push(`name is ${pkg.name}, not n8n-nodes-rpa`);
  if (version !== undefined && pkg.version !== version) problems.push(`version is ${pkg.version}, not ${version}`);
  for (const key of ['devDependencies', 'scripts', 'bundleDependencies', 'bundledDependencies', 'optionalDependencies']) {
    if (key in pkg) problems.push(`has ${key}`);
  }
  const deps = Object.keys(pkg.dependencies ?? {}).sort();
  if (deps.join() !== RUNTIME_DEPENDENCIES.join()) problems.push(`dependencies are ${deps.join(', ')}, not ${RUNTIME_DEPENDENCIES.join(', ')}`);
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+$/.test(range)) problems.push(`dependency ${name} is ${range}, not an exact version`);
  }
  const text = JSON.stringify(pkg);
  if (/workspace:/.test(text)) problems.push('names a workspace: version');
  if (/n8n-rpa-(engine|eval|sandbox|gate)/.test(text)) problems.push('names an unpublished workspace package');
  return problems;
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const only = (dir) => {
  const tgz = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
  if (tgz.length !== 1) throw new Error(`expected one tarball in ${dir}, found ${tgz.length}`);
  return join(dir, tgz[0]);
};
const listing = (tgz) => run('tar', ['-tzf', tgz]).split('\n').filter((l) => l && !l.endsWith('/')).sort();

export function pack(destination) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const work = mkdtempSync(join(tmpdir(), 'n8n-nodes-rpa-pack-'));
  try {
    const raw = join(work, 'raw');
    mkdirSync(raw);
    run('pnpm', ['pack', '--pack-destination', raw], root);
    const rawTgz = only(raw);
    run('tar', ['-xzf', rawTgz, '-C', work]);
    const manifestPath = join(work, 'package', 'package.json');
    const manifest = publishManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(destination, { recursive: true });
    for (const f of readdirSync(destination).filter((x) => x.endsWith('.tgz'))) rmSync(join(destination, f));
    run('npm', ['pack', join(work, 'package'), '--pack-destination', destination, '--ignore-scripts', '--silent'], work);
    const tgz = only(destination);
    const packed = JSON.parse(run('tar', ['-xOzf', tgz, 'package/package.json']));
    const problems = manifestProblems(packed, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    const before = listing(rawTgz);
    const after = listing(tgz);
    if (before.join('\n') !== after.join('\n')) problems.push('the cleaned tarball holds different files than pnpm pack made');
    if (problems.length) throw new Error(`refusing to pack: ${problems.join('; ')}`);
    return tgz;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) {
    console.error('usage: node scripts/pack.mjs <destination directory>');
    process.exit(2);
  }
  console.log(pack(resolve(destination)));
}
