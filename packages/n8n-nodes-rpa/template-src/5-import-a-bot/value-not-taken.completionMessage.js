// Template: 5-import-a-bot.json
// Node: Value not taken
// Parameter: completionMessage
//
// A refused value, or the values page not answered in time: the page says which, and that the running version keeps
// running.

={{
  (
    (e, b, r) => (r.answered === true ? e(r.refused) : 'This page was not answered in time.')
      + '\nNothing was imported or signed: '
      + e(b.name)
      + ' version '
      + e(b.version)
      + ' keeps running. Open the form again, leave Bot file empty and type the bot\'s name.'
  )(ESCAPE_HTML_QUOTED, $('The bot to change').first().json, $('Values to steps').first().json)
}}
