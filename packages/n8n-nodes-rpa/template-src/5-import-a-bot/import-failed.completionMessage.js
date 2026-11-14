// Template: 5-import-a-bot.json
// Node: Import failed
// Parameter: completionMessage
//
// The import's error; after Change or sign again, that the running version keeps running.

={{ (ESCAPE_HTML)($json.error) }}{{
  $('Change or sign again').isExecuted
    ? ((e, b) => '\nNothing changed: ' + e(b.name) + ' version ' + e(b.version) + ' keeps running.')(
      ESCAPE_HTML, $('The bot to change').first().json
    )
    : ''
}}
Details, including the import report when there is one, are in the error output of Import steps in this execution.
