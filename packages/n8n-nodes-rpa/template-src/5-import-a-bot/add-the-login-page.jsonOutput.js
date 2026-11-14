// Template: 5-import-a-bot.json
// Node: Add the login page
// Parameter: jsonOutput
//
// The page shown when the sign-in was refused, as JSON for the form: the error, and how to add the address to the RPA
// Site Login credential before Import again.

={{
  JSON.stringify([
    {
      fieldType: 'html',
      html: (
        (e) => '<p><b>The sign-in was refused:</b> '
          + e($json.error)
          + '</p><ol><li>In n8n, open the <b>RPA Site Login</b> credential that Import steps uses.</li><li>Add the address named above to <b>Pages Where the Password May Be Typed</b> (one address per line) and save.</li><li>Click <b>Import again</b>: the same file is imported again.</li></ol>'
      )(ESCAPE_HTML)
    }
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ]).split('$').join('\\u0024')
}}
