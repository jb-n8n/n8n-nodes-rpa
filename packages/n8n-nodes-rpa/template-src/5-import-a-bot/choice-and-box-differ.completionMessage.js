// Template: 5-import-a-bot.json
// Node: Choice and box differ
// Parameter: completionMessage
//
// Says which of the choice and the box to correct, or that the page was not answered in time. Nothing was signed.

={{
  (
    (choice, e) => (
      choice === ''
        ? 'This page was not answered in time.'
        : choice === 'Sign the approved steps again, unchanged'
        ? 'You chose to sign the approved steps again, unchanged, and pasted steps in the box. To use the pasted steps, choose Change the steps as JSON. To sign them again unchanged, leave the box empty.'
        : 'You chose to change the steps, but the box is empty. Paste the changed steps in the box, or choose one of the other two.'
    )
      + '\nNothing was imported or signed: '
      + e($('The bot to change').first().json.name)
      + ' version '
      + e($('The bot to change').first().json.version)
      + ' keeps running. Open the form again, leave Bot file empty and type the bot\'s name.'
  )(String($('Change or sign again').first().json.choice ?? ''), ESCAPE_HTML_QUOTED)
}}
