// Template: 5-import-a-bot.json
// Node: Change it on its own form
// Parameter: completionMessage
//
// After Approved on another form?: change the bot on the form that approved it, or the question was not answered in
// time. Nothing was shown, imported or signed.

={{
  (
    (b, e, answered) => (answered ? '' : 'This page was not answered in time.\n')
      + 'Nothing was shown, imported or signed: '
      + e(b.name)
      + ' version '
      + e(b.version)
      + ' keeps running.'
      + (
        answered
          ? '\nChange it on the import form that approved it: the About note of the bot\'s workflow in n8n names that form, in the line To change the steps or sign them again. This form cannot list the other import forms.'
          : ' Open the form again, leave Bot file empty and type the bot\'s name.'
      )
  )(
    $('The bot to change').first().json,
    ESCAPE_HTML,
    String($('Approved on another form?').first().json.answer ?? '') !== ''
  )
}}
