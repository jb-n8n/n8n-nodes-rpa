// Template: 5-import-a-bot.json
// Node: Choice fits the box?
// Parameter: conditions.conditions[0].leftValue
//
// True when the choice fits the box: Sign again unchanged, or Change values (1 to 40 values offered), with the box empty
// or holding the approved steps unchanged (as parsed JSON: spacing and key order do not count); or Change the steps as
// JSON with text in the box.

={{
  (
    (choice, typed, stored, count) => (
      (
        choice === 'Sign the approved steps again, unchanged'
          || (choice === 'Change values' && count > 0 && count <= 40)
      )
        && (
          typed.trim() === ''
            || (
              (parse, canon) => ((a, b) => a !== undefined && b !== undefined && canon(a) === canon(b))(
                parse(typed), parse(stored)
              )
            )(
              // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
              (s) => { try { return JSON.parse(String(s)); } catch (x) { return undefined; } },
              (v) => {
                const c = (x) => (
                  Array.isArray(x)
                    ? '[' + x.map(c).join(',') + ']'
                    : x !== null && typeof x === 'object'
                    ? '{'
                      + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + c(x[k])).join(',')
                      + '}'
                    : JSON.stringify(x === undefined ? null : x)
                );
                return c(v);
              }
            )
        )
    )
      || (choice === 'Change the steps as JSON' && typed.trim() !== '')
  )(
    String($('Change or sign again').first().json.choice ?? ''),
    String($('Change or sign again').first().json.changedSteps ?? ''),
    String($('The bot to change').first().json.steps ?? ''),
    (
      Array.isArray($('The bot to change').first().json.values)
        ? $('The bot to change').first().json.values
        : []
    ).filter((v) => v.offered === true).length
  )
}}
