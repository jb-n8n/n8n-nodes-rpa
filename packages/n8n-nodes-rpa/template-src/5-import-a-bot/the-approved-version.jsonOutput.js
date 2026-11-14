// Template: 5-import-a-bot.json
// Node: The approved version
// Parameter: jsonOutput
//
// The version that runs now: after Change or sign again the row The bot to change found; for an upload the running
// version of the name typed (What it replaces); otherwise an empty object.

={{
  (
    (b) => (
      b
        ? {
          name: b.name, version: b.version, steps: b.steps, signature: b.signature, approvedBy: b.approvedBy
        }
        : {}
    )
  )(
    $('The bot to change').isExecuted
      ? ($('The bot to change').first().json.found === true ? $('The bot to change').first().json : null)
      : ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
        (r) => r.name === String($('Settings').first().json.name ?? '').trim()
      )
        ?? null
  )
}}
