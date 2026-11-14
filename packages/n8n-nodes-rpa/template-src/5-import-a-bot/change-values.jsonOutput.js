// Template: 5-import-a-bot.json
// Node: Change values
// Parameter: jsonOutput
//
// The values page's fields, as JSON for the form: one text field per value offered (The bot to change), pre-filled with
// the approved value; a value not offered, with the reason; and a hidden field that tells an answer from a timeout.

={{
  JSON.stringify(
    (
      (b, e, signedIn, cut) => [{
        fieldType: 'html',
        html: '<p>Each field holds a value that <b>'
          + e(b.name)
          + '</b> (version '
          + e(b.version)
          + ') types, chooses or opens, as approved, in step order. Change the ones you need, then click Review: the review page shows each change, old → new. Where a step\'s description quotes the old value, it gets the new one too.</p><p>Everything else (steps to add or remove, how a step finds its control, waits, write marks, file names) is changed with Change the steps as JSON.</p><p><em>'
          + (
            signedIn
              ? 'Any signed-in n8n user who has the address of this page can read these values, so do not share it.'
              : 'Anyone who has the address of this page can read these values, so do not share it.'
          )
          + '</em></p>'
      }].concat(
        (Array.isArray(b.values) ? b.values : []).map(
          (v) => (
            v.offered === true
              ? {
                fieldLabel: String(v.label),
                fieldName: String(v.name),
                fieldType: 'text',
                defaultValue: String(v.value),
                requiredField: false
              }
              : {
                fieldType: 'html',
                html: '<p><em>'
                  + e(String(v.label) + ' "' + cut(v.value) + '": ' + String(v.why) + '.')
                  + '</em></p>'
              }
          )
        ),
        [{ fieldType: 'hiddenField', fieldName: 'valuesPage', fieldValue: 'answered' }]
      )
    )(
      $('The bot to change').first().json,
      ESCAPE_HTML_QUOTED,
      $('Import a bot').params.authentication === 'n8nUserAuth',
      (v) => ((a) => (a.length > 80 ? a.slice(0, 79).join('') + '…' : a.join('')))(
        Array.from(String(v ?? '').replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '))
      )
    )
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
}}
