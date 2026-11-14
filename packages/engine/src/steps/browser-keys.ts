// The keys a browser `press` step may send, in the desktop steps' spelling (desktop-vocabulary.ts: modifiers Ctrl, Alt,
// Shift in that order, then the key, `Up` rather than `ArrowUp`), and their Playwright names. Nothing that types a
// character and no paste: a step that typed text would bypass fill's password check and the limits on typed values.
// The desktop's canonicalChord is not reused: it also accepts letters, digits and Space, and refuses Alt+Tab and
// Ctrl+Escape for the Windows shell, which a browser page never reaches. A leaf module: no imports.

const KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;
const PLAYWRIGHT_NAMES: Readonly<Record<string, string>> = { Ctrl: 'Control', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
/** The one chord with a letter: select all. */
const SELECT_ALL = 'Ctrl+A';

const ALLOWED = 'must be a key browser steps can press: Enter, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, PageUp, PageDown, Home, End '
  + 'or F1 to F12, alone or after Ctrl, Alt and Shift in that order (Shift+Tab, Ctrl+Enter), or Ctrl+A; never a key that types a character';

/**
 * Why `key` is not a chord a browser `press` step may send, or null when it is. The spelling must be exact: each
 * modifier at most once, in the order Ctrl, Alt, Shift, then one allowed key. A key is never rendered, so `{{var.x}}`
 * is refused like any other unknown key.
 */
export function browserKeyProblem(key: string): string | null {
  if (key === SELECT_ALL) return null;
  const parts = key.split('+');
  const mods = parts.slice(0, -1);
  if (!KEYS.has(parts[parts.length - 1])) return ALLOWED;
  // In order and each once: the modifiers' positions in MODIFIER_ORDER strictly increase.
  const at = mods.map((m) => (MODIFIER_ORDER as readonly string[]).indexOf(m));
  if (at.some((i, n) => i < 0 || (n > 0 && i <= at[n - 1]))) return ALLOWED;
  return null;
}

/** The Playwright name of a chord browserKeyProblem accepts (`Up` is `ArrowUp`, `Ctrl+Enter` is `Control+Enter`). */
export function toPlaywrightKey(key: string): string {
  return key.split('+').map((part) => PLAYWRIGHT_NAMES[part] ?? part).join('+');
}
