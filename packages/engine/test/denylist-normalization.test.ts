// The denylist's normalization, pinned by fixtures the desktop runner's parity test reads too (DestructiveWords).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDestructive, looksDestructive, normalizeForDenylist } from '../src/policy/destructive.js';
import { hasWriteWord, isNavigationKey, looksLikeWrite } from '../src/proposal/desktop.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/denylist-normalization.json', import.meta.url), 'utf8')) as {
  normalized: [string, string][]; destructive: string[]; notDestructive: string[]; discard: string[]; writeWords: { writes: string[]; notWrites: string[] };
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
  it('write words are folded the same way (WriteWords.Has in the runner reads these fixtures too)', () => {
    for (const w of fixtures.writeWords.writes) expect(hasWriteWord(w), w).toBe(true);
    for (const w of fixtures.writeWords.notWrites) expect(hasWriteWord(w), w).toBe(false);
  });
});

describe('desktop keys: anything but plain navigation is a candidate write', () => {
  it('reads chords as the runner\'s IsNavigationKey does', () => {
    for (const k of ['Tab', 'Shift+Tab', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape']) expect(isNavigationKey(k), k).toBe(true);
    for (const k of ['Enter', 'Space', 'Alt+S', 'Shift+F10', 'Apps', 'Alt+Enter', 'Shift+Enter', 'Delete', 'Ctrl+S', 'F11', 'Shift+Up', 'Ctrl+Tab', 'A', 'Backspace']) {
      expect(isNavigationKey(k), k).toBe(false);
      expect(looksLikeWrite({ intent: `Press ${k}`, key: { key: k } }), k).toBe(true);
    }
    expect(looksLikeWrite({ intent: 'Press Tab', key: { key: 'Tab' } })).toBe(false);
  });
});
