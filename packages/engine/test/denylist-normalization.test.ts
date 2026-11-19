// The denylist's normalization, pinned by fixtures the desktop runner's parity test reads too (DestructiveWords).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDestructive, looksDestructive, normalizeForDenylist } from '../src/policy/destructive.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/denylist-normalization.json', import.meta.url), 'utf8')) as {
  normalized: [string, string][]; destructive: string[]; notDestructive: string[]; discard: string[];
};

describe('denylist normalization fixtures (shared with the desktop runner)', () => {
  it('normalizes each input to the pinned text', () => {
    for (const [input, want] of fixtures.normalized) expect(normalizeForDenylist(input), JSON.stringify(input)).toBe(want);
  });
  it('reads the destructive ones as destructive, as a name and as an automation id', () => {
    for (const s of fixtures.destructive) {
      expect(isDestructive(s), s).toBe(true);
      expect(looksDestructive(s, ''), s).toBe(true);
      expect(looksDestructive('', s), s).toBe(true);
    }
  });
  it('leaves the others alone', () => {
    for (const s of fixtures.notDestructive) {
      expect(isDestructive(s), s).toBe(false);
      expect(looksDestructive(s, s), s).toBe(false);
    }
  });
  it('desktop controls: discard counts, normalized first (a zero-width space or a homoglyph does not hide it)', () => {
    for (const s of fixtures.discard) expect(looksDestructive(s, ''), s).toBe(true);
    expect(isDestructive('Discard')).toBe(false);
  });
});
