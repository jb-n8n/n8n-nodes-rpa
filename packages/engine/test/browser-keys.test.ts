import { describe, expect, it } from 'vitest';
import { browserKeyProblem, toPlaywrightKey } from '../src/steps/browser-keys.js';

const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const ARROWS: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
/** Every modifier set in the desktop steps' order (Ctrl, Alt, Shift), with its Playwright spelling. */
const MODIFIERS: [string, string][] = [
  ['', ''], ['Ctrl+', 'Control+'], ['Alt+', 'Alt+'], ['Shift+', 'Shift+'], ['Ctrl+Alt+', 'Control+Alt+'], ['Ctrl+Shift+', 'Control+Shift+'],
  ['Alt+Shift+', 'Alt+Shift+'], ['Ctrl+Alt+Shift+', 'Control+Alt+Shift+'],
];

describe('browser key chords', () => {
  it('every allowed key, alone and with each set of modifiers, maps to its Playwright name', () => {
    for (const key of KEYS) for (const [mods, pwMods] of MODIFIERS) {
      const chord = `${mods}${key}`;
      expect(browserKeyProblem(chord), chord).toBeNull();
      expect(toPlaywrightKey(chord), chord).toBe(`${pwMods}${ARROWS[key] ?? key}`);
    }
    expect(browserKeyProblem('Ctrl+A')).toBeNull();
    expect(toPlaywrightKey('Up')).toBe('ArrowUp');
    expect(toPlaywrightKey('Ctrl+Enter')).toBe('Control+Enter');
    expect(toPlaywrightKey('Shift+Tab')).toBe('Shift+Tab');
    expect(toPlaywrightKey('Ctrl+A')).toBe('Control+A');
  });

  it('refuses a key that types a character, a paste, a Windows key, an empty string and a variable, listing what is allowed', () => {
    const refused = [
      'a', 'A', '1', ' ', 'Space', 'Ctrl+V', 'Ctrl+C', 'Shift+A', 'Ctrl+Shift+A', 'Alt+A', 'Win+R', 'Meta+Enter', 'Command+Enter', '',
      '{{var.key}}', 'Ctrl+{{var.key}}', 'F13', 'F0', 'Insert', 'ArrowUp', 'Control+Enter',
      // The desktop steps' spelling only: modifiers in the order Ctrl, Alt, Shift, each once, and exact case.
      'enter', 'ctrl+Enter', 'Shift+Ctrl+Tab', 'Ctrl+Ctrl+Enter', 'Ctrl+', '+Enter', 'Ctrl++Enter', 'Ctrl + Enter', ' Enter',
    ];
    for (const key of refused) {
      const problem = browserKeyProblem(key);
      expect(problem, JSON.stringify(key)).not.toBeNull();
      for (const named of ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'PageDown', 'Home', 'End', 'F1 to F12', 'Ctrl', 'Alt', 'Shift', 'Ctrl+A']) {
        expect(problem, named).toContain(named);
      }
    }
  });
});
