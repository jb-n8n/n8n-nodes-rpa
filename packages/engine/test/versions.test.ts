import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Versions that have to move together across parts of the repository that share no build. The Windows package
 * (desktop/installer/build/Stage.ps1) installs the browser server from images/browser/server, and a Playwright client
 * only talks to a browser server of its own version.
 */
const text = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const dependencies = (path: string): Record<string, string> => (JSON.parse(text(path)) as { dependencies: Record<string, string> }).dependencies;

describe('versions', () => {
  it("the browser host's playwright equals the engine's playwright-core", () => {
    const host = dependencies('images/browser/server/package.json').playwright;
    expect(host).toMatch(/^\d+\.\d+\.\d+$/);
    expect(host).toBe(dependencies('packages/engine/package.json')['playwright-core']);
  });

  it('Stage.ps1 names Node 22.23.4', () => {
    const stage = text('desktop/installer/build/Stage.ps1');
    expect(stage).toContain("$NodeVersion = '22.23.4'");
    // The download is checked against a SHA-256 written in the script.
    expect(stage).toMatch(/\$NodeSha256 = '[0-9a-f]{64}'/);
  });
});
