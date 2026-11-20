// Template: 5-import-a-bot.json
// Node: No approved bot
// Parameter: completionMessage
//
// No active row has the name typed: the page names the approved bots (or says none is approved yet) and how to import
// a bot or change one.

={{
  (
    (b, e) => (
      b.names.length
        ? 'No approved bot is named ' + e(b.name) + '. The approved bots: ' + b.names.map(e).join(', ') + '.'
        : 'No bot has been approved yet.'
    )
      + '\nTo import a bot, open the form again and upload its file. To change an approved bot or sign it again, open the form again, leave Bot file empty and type its name.'
  )($('The bot to change').first().json, ESCAPE_HTML)
}}
