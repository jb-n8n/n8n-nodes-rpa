// Template: 3-approve-steps.json
// Node: Ask for approval (desktop steps)
// Parameter: options.responseFormDescription
//
// The text above the desktop approval form: the version and name (HTML-escaped), and what a tick allows.

=Steps version {{
  String($('Repaired steps received').item.json.version ?? '').replace(
    /[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}} for {{
  String($('Repaired steps received').item.json.name ?? '').replace(
    /[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}}. Tick the steps that save, send or submit, from the numbered list in the email; none is ticked for you. Ticked steps are allowed to save or send. Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.
