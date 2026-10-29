import type * as EngineModule from 'n8n-rpa-engine';

export type Engine = Pick<
  typeof EngineModule,
  'runTask' | 'signSteps' | 'proposalDigest' | 'openSession' | 'createMasker' | 'scriptHash' | 'PLAYWRIGHT_VERSION' | 'parseScript' | 'repairPrecondition'
  | 'validateScript' | 'UNVERIFIED_COUNT_FLAG' | 'EXTRACT_FIELDS_DROPPED' | 'changeListMatches' | 'describeCheck' | 'MIME'
  | 'DOWNLOAD_NEEDS_BROWSER_SERVER' | 'importSource' | 'adoptDraft' | 'scrubTrace'
  | 'runDesktopTask' | 'probeRunner' | 'isDesktopDocument' | 'runnerConnected'
>;

let cached: Promise<Engine> | undefined;

// The engine ships inside this package: scripts/copy-assets.mjs copies its build to dist/engine, next to dist/nodes. A
// constant, not a literal, so TypeScript does not resolve it against the sources (the tests map it to the engine sources).
const ENGINE = '../../engine/index.js';

/** Loads the engine on first use, so n8n can list the node without loading playwright-core. */
export function loadEngine(): Promise<Engine> {
  cached ??= (import(ENGINE) as Promise<Engine>).catch((error: unknown) => {
    cached = undefined; // a failed import is not kept: the next call retries
    throw error;
  });
  return cached;
}
