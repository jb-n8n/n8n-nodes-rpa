// The desktop step format's shared vocabulary: which verbs may declare a write, what a read may be named, and the one
// canonical spelling of a key chord. The parser, the UiPath importer and the desktop proposal all use these, so the
// three cannot drift apart. A leaf module: no imports.

/** Verbs that act on the app: only these may be declared writes (`write: true`). */
export const DESKTOP_WRITE_VERBS: ReadonlySet<string> = new Set(['click', 'fill', 'select', 'check', 'key']);

/** A read step's `as`: the name its text goes by in the run outputs (Data `values`). */
export const READ_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Key names (lower case, with common aliases) to their canonical spelling. Letters, digits and F1 to F24 aside. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', space: 'Space', back: 'Backspace', backspace: 'Backspace',
  del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert', home: 'Home', end: 'End', pgup: 'PageUp', pageup: 'PageUp', prior: 'PageUp',
  pgdn: 'PageDown', pagedown: 'PageDown', next: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;

/**
 * Whether a canonical chord reaches the Windows shell rather than the app, as the runner judges it (it never sends
 * one): Ctrl with Escape (Ctrl+Esc, Ctrl+Shift+Esc), Alt with Tab or Escape (Alt+Tab, Alt+Shift+Tab, Alt+Esc). Win
 * chords are not in the step format at all.
 */
export function isShellChord(chord: string): boolean {
  const parts = chord.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return (mods.has('Ctrl') && key === 'Escape') || (mods.has('Alt') && (key === 'Tab' || key === 'Escape'));
}

/**
 * A key and its modifiers as the step format's canonical chord: modifiers Ctrl, Alt, Shift in that order, then the key
 * (`Ctrl+Shift+S`, `Enter`, `F5`). `modifiers` is a list such as `"Ctrl, Shift"` or `"Ctrl+Shift"` (`None` is
 * ignored). Win chords and the shell chords (isShellChord) are refused.
 */
export function canonicalChord(key: string, modifiers: string): { chord: string } | { error: string } {
  const k = key.trim().toLowerCase();
  let name = KEY_NAMES[k];
  if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(k)) name = k.toUpperCase();
  if (!name && /^[a-z0-9]$/.test(k)) name = k.toUpperCase();
  if (!name) return { error: `the key ${key.slice(0, 40) || '(none)'} is not one desktop steps can press (Enter, Tab, Escape, arrows, F1 to F24, letters and digits)` };
  const mods = new Set<string>();
  for (const m of modifiers.split(/[\s,+|]+/).map((x) => x.toLowerCase()).filter(Boolean)) {
    if (m === 'none') continue;
    if (m === 'ctrl' || m === 'control') mods.add('Ctrl');
    else if (m === 'alt') mods.add('Alt');
    else if (m === 'shift') mods.add('Shift');
    else if (m === 'win' || m === 'windows' || m === 'lwin' || m === 'rwin' || m === 'meta') return { error: 'a Windows-key shortcut drives the Windows shell, not the app: desktop steps never send one' };
    else return { error: `the modifier ${m.slice(0, 20)} is not one desktop steps know (Ctrl, Alt, Shift)` };
  }
  const chord = [...MODIFIER_ORDER.filter((m) => mods.has(m)), name].join('+');
  if (isShellChord(chord)) return { error: `${chord} drives the Windows shell, not the app: desktop steps never send it` };
  return { chord };
}

/**
 * Why a step's `key` value is not a chord desktop steps may send, or undefined when it is. A step must use the
 * canonical spelling exactly (so the runner's gated keys cannot be passed with another spelling): each modifier at most
 * once, in the order Ctrl, Alt, Shift, then one key, letters uppercase. Win chords and shell chords are refused.
 */
export function stepChordProblem(value: unknown): string | undefined {
  const shape = 'must be a key chord such as Enter, Tab, Ctrl+S or F5 (modifiers in the order Ctrl, Alt, Shift; letters uppercase)';
  if (typeof value !== 'string' || value === '' || value.length > 40) return shape;
  const parts = value.split('+');
  const mods = parts.slice(0, -1);
  if (mods.some((m) => /^(win|windows|meta)$/i.test(m))) return 'is a Windows-key shortcut, which drives the Windows shell, not the app: desktop steps never send one';
  if (mods.some((m) => !(MODIFIER_ORDER as readonly string[]).includes(m)) || new Set(mods).size !== mods.length) return shape;
  const c = canonicalChord(parts[parts.length - 1], mods.join(','));
  if ('error' in c) return /Windows shell/.test(c.error) ? `is ${value}, which drives the Windows shell, not the app: desktop steps never send it` : shape;
  return c.chord === value ? undefined : shape;
}
