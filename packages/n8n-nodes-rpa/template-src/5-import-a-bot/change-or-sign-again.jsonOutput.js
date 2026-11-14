// Template: 5-import-a-bot.json
// Node: Change or sign again
// Parameter: jsonOutput
//
// The change page's fields, as JSON for the form: on a second visit what to correct, then the approved steps to read,
// the choice (Change values only for 1 to 40 values a field can hold) and the box for changed steps.

={{
  JSON.stringify(
    (
      (b, e, signedIn, prev, count) => [
        {
          fieldType: 'html',
          html: (
            prev
              ? '<p><strong>'
                + (
                  prev.choice === 'Sign the approved steps again, unchanged'
                    ? 'You chose to sign the approved steps again, unchanged, and pasted steps that differ from them. To use the pasted steps, choose Change the steps as JSON. To sign them again unchanged, empty the box. Your choice and the pasted steps are kept below.'
                    : prev.choice === 'Change values'
                    ? (
                      String(prev.changedSteps ?? '').trim() !== ''
                        ? 'You chose to change values, and pasted steps that differ from the approved ones. To use the pasted steps, choose Change the steps as JSON. To change values, empty the box. Your choice and the pasted steps are kept below.'
                        : 'Change values is not offered for this bot (the page says why): choose one of the other two.'
                    )
                    : 'You chose to change the steps as JSON, but the box was empty. Paste the changed steps in the box, or choose one of the other two.'
                )
                + '</strong></p>'
              : ''
          )
            + '<p>These are the steps that run now as <b>'
            + e(b.name)
            + '</b> (version '
            + e(b.version)
            + ').</p><pre>'
            + e(
              // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
              ((s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (x) { return s; } })(
                String(b.steps ?? '')
              )
            )
            + '</pre>'
            + (
              Number(b.active) > 1
                ? '<p><em>The steps table holds '
                  + e(b.active)
                  + ' active rows of this name, as when two approvals are saved at the same moment. Runs use version '
                  + e(b.version)
                  + ', shown here. An approval on this form marks the other'
                  + (Number(b.active) > 2 ? 's' : '')
                  + ' superseded.</em></p>'
                : ''
            )
            + '<p>'
            + (
              count > 0 && count <= 40
                ? 'Choose what to do below. To change a date, a text the bot types, an option it chooses or an address it opens, choose Change values: the next page offers each value as a field. To add or remove steps, choose Change the steps as JSON and paste the changed steps in the box.'
                : 'Choose what to do below. To change the steps, choose Change the steps as JSON and paste the changed steps in the box. '
                  + (
                    count === 0
                      ? 'This bot has no value that a page of fields can offer, so Change values is not offered.'
                      : 'This bot has '
                        + count
                        + ' values, more than one page of fields shows well, so Change values is not offered.'
                  )
            )
            + '</p><p><em>This form cannot tell steps signed with an older key from steps changed in the table, so read every step on the next page.</em></p><p><em>'
            + (
              signedIn
                ? 'Any signed-in n8n user who has the address of this page can read these steps, so do not share it.'
                : 'Anyone who has the address of this page can read these steps, so do not share it.'
            )
            + '</em></p>'
        },
        Object.assign(
          {
            fieldLabel: 'What to do',
            fieldName: 'choice',
            fieldType: 'radio',
            fieldOptions: {
              values: [{ option: 'Sign the approved steps again, unchanged' }].concat(
                count > 0 && count <= 40 ? [{ option: 'Change values' }] : [],
                [{ option: 'Change the steps as JSON' }]
              )
            },
            requiredField: true
          },
          prev ? { defaultValue: String(prev.choice ?? '') } : {}
        ),
        Object.assign(
          {
            fieldLabel: 'Changed steps (JSON). Only when you change the steps as JSON.',
            fieldName: 'changedSteps',
            fieldType: 'textarea',
            requiredField: false
          },
          prev ? { defaultValue: String(prev.changedSteps ?? '') } : {}
        )
      ]
    )(
      $('The bot to change').first().json,
      ESCAPE_HTML,
      $('Import a bot').params.authentication === 'n8nUserAuth',
      $('Page answered?').isExecuted ? $('Page answered?').first().json : null,
      (
        Array.isArray($('The bot to change').first().json.values)
          ? $('The bot to change').first().json.values
          : []
      ).filter((v) => v.offered === true).length
    )
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
}}
