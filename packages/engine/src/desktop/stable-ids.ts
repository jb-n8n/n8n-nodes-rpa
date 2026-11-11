/**
 * Whether a UI Automation id is stable enough to go into a locator. Unlike the browser's rule, short numeric ids (up to 5
 * digits) are standard Win32 dialog control ids and are stable; GUIDs, hex salts, long digit runs and dotted runtime-id
 * shapes are generated per run. The recorder's own rule is held to this one by the samples in
 * test/fixtures/desktop/stable-id-samples.json.
 */
export function stableDesktopId(id: string): boolean {
  if (id === '' || /\s/.test(id)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
  if (/\d{6,}/.test(id)) return false;
  if (/^\d+(\.\d+)+$/.test(id)) return false;
  // WinForms names a list view's rows by their position: an index, not an id.
  if (/^ListViewItem-\d+$/.test(id)) return false;
  const hex = id.match(/[0-9a-f]{8,}/gi) ?? [];
  return !hex.some((run) => /\d/.test(run) && /[a-f]/i.test(run));
}
