import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hrefHasSession, looksGenerated } from '../src/agent/stable-ids.js';
import { stableDesktopId } from '../src/desktop/stable-ids.js';

describe('looksGenerated table', () => {
  it.each([
    'M0:46:9f3c2a1e::3:0', '__button12', '__component0---__xmlview1--table', ':r5:', 'radix-:r3:', 'ember812', 'ember12',
    'ext-gen1234', 'gwt-uid-7', 'j_id42', 'x9f3c2a', 'a1b2c3d4e5', '123abc', '3f2504e0-4f89-41d3-9a0c-0305e82c3301', '2026-09-01-row',
  ])('generated: %s', (id) => expect(looksGenerated(id)).toBe(true));
  it.each([
    'user-name', 'application-LineItem-manage-component---worklist--table', 'total2', 'deface', 'searchBox', 'S_BUKRS-LOW',
  ])('stable: %s', (id) => expect(looksGenerated(id)).toBe(false));
});

describe('hrefHasSession', () => {
  it('spots a session segment only', () => {
    expect(hrefHasSession('/sap(cz1TSUQ6QU5PTjo=)/bc/gui/x')).toBe(true);
    expect(hrefHasSession('/acme/service')).toBe(false);
  });
});

describe('desktop-stable-ids', () => {
  // The recorder's StableIds (desktop/recorder) reads the same file: keep its path.
  it('stableDesktopId agrees with every sample in stable-id-samples.json', () => {
    const samples = JSON.parse(readFileSync(new URL('./fixtures/desktop/stable-id-samples.json', import.meta.url), 'utf8')) as { id: string; stable: boolean }[];
    expect(samples.length).toBeGreaterThanOrEqual(20);
    for (const s of samples) expect(stableDesktopId(s.id), JSON.stringify(s.id)).toBe(s.stable);
  });
});
