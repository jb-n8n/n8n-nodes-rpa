// Template: 5-import-a-bot.json
// Node: Approved on another form?
// Parameter: jsonOutput
//
// The question shown when the version that runs does not fit this form, as JSON for the form: why it may not fit, what
// signing it here would do, and the two answers.

={{
  JSON.stringify(
    (
      (b, k, e) => [
        {
          fieldType: 'html',
          html: '<p><strong>⚠ '
            + e(b.name)
            + ' version '
            + e(b.version)
            + ' does not fit this form: it was signed '
            + (
              k.approvedVersion && k.approvedVersion.desktop
                ? ''
                : (
                  k.siteLogin
                    ? 'for another Site Login than "' + e(k.siteLogin) + '"'
                    : 'for a Site Login, which this form does not have'
                )
                  + ', or '
            )
            + 'with another signing key, or its row was changed after it was approved. This form cannot tell which.</strong></p><p>A bot is changed and signed again on the import form that approved it. '
            + (
              k.approvedVersion && k.approvedVersion.desktop
                ? ''
                : 'Signed here, a bot of another Site Login runs only '
                  + (k.siteLogin ? 'with the Site Login "' + e(k.siteLogin) + '"' : 'without a Site Login')
                  + ', and its workflow stops working. '
            )
            + 'Its steps are shown only after you answer.</p>'
        },
        {
          fieldLabel: 'Which is it?',
          fieldName: 'answer',
          fieldType: 'radio',
          fieldOptions: {
            values: [
              { option: 'This bot was approved on another import form: take me back' },
              {
                option: 'I changed the signing key or the row was changed: show me the steps to read and sign again'
              }
            ]
          },
          requiredField: true
        }
      ]
    )($('The bot to change').first().json, $('Sign steps').first().json, ESCAPE_HTML)
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
}}
