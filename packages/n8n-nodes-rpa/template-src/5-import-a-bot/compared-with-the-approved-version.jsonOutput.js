// Template: 5-import-a-bot.json
// Node: Compared with the approved version
// Parameter: jsonOutput
//
// The steps to review compared with the approved version (COMPARE_STEPS in snippets.js): none for Sign again unchanged,
// Values to steps for Change values, the box for Change the steps as JSON. With Change values and no value changed, the
// line adds that approving signs the steps again as they are.

={{
  (
    (r, values) => (
      values && r.changed === false
        ? Object.assign(
          r,
          {
            compared: r.compared
              + ' No value was changed on the values page: approving signs these steps again as they are.'
          }
        )
        : r
    )
  )(
    (COMPARE_STEPS)(
      $('The bot to change').first().json,
      $('Change or sign again').first().json.choice === 'Sign the approved steps again, unchanged'
        ? ''
        : $('Change or sign again').first().json.choice === 'Change values'
        ? String($('Values to steps').first().json.steps ?? '')
        : String($('Change or sign again').first().json.changedSteps ?? '')
    ),
    $('Change or sign again').first().json.choice === 'Change values'
  )
}}
