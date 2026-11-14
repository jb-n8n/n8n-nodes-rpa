// Template: 5-import-a-bot.json
// Node: Asks about a download?
// Parameter: conditions.conditions[0].leftValue
//
// True when the upload gets the optional question about the file the bot downloads: not for an RPA recording (by
// source, file name or content) and not for a step document (desktop steps, or a list of steps with intents).

={{
  (
    (s, f, d) => s !== 'RPA recording'
      && !/\.rpa-recording\.json$/i.test(f)
      && !(
        d !== null
          && typeof d === 'object'
          && (
            d.format === 'rpa-recording/1'
              || d.surface === 'desktop'
              || (
                (l) => Array.isArray(l)
                  && l.length > 0
                  && l.every((x) => x !== null && typeof x === 'object' && typeof x.intent === 'string')
              )(Array.isArray(d) ? d : d.steps)
          )
      )
  )(
    String($('Settings').first().json.source ?? ''),
    String($('Settings').first().json.bot?.filename ?? ''),
    // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
    ((text) => { try { return JSON.parse(text); } catch (e) { return null; } })(
      typeof $json.text === 'string' ? $json.text : ''
    )
  )
}}
