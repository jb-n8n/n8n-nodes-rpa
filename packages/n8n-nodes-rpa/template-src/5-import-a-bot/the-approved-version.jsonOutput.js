// Template: 5-import-a-bot.json
// Node: The approved version
// Parameter: jsonOutput
//
// The version that runs now: after Change or sign again the row The bot to change found; for an upload the running
// version of the name typed (What it replaces); otherwise an empty object. `rows`: that object first, then, for an
// upload, the running version of every other step list it names (name-1, name-2, …): Rows to check gives each to Sign
// steps' check, so each list's line on the review page says whether its stored row was checked and fits.

={{
  (
    (b, running) => (
      (one) => Object.assign(
        { },
        one,
        {
          rows: [one].concat(
            running.filter((r) => !b || r.name !== b.name).map(
              (r) => ({ name: r.name, version: r.version, steps: r.steps, signature: r.signature, approvedBy: r.approvedBy })
            )
          )
        }
      )
    )(
      b
        ? {
          name: b.name, version: b.version, steps: b.steps, signature: b.signature, approvedBy: b.approvedBy
        }
        : { }
    )
  )(
    $('The bot to change').isExecuted
      ? ($('The bot to change').first().json.found === true ? $('The bot to change').first().json : null)
      : ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
        (r) => r.name === String($('Settings').first().json.name ?? '').trim()
      )
        ?? null,
    $('The bot to change').isExecuted || !$('What it replaces').isExecuted ? [] : $('What it replaces').first().json.running
  )
}}
