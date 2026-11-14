// Template: 3-approve-steps.json
// Node: Ask for approval (desktop steps)
// Parameter: jsonOutput
//
// The desktop approval form's fields, as JSON: Decision, the candidate writes from the safety flags as tick boxes (none
// ticked), and a field for the numbers of other steps that save, send or submit.

={{
  JSON.stringify(
    [{
      fieldLabel: 'Decision',
      fieldType: 'dropdown',
      fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] },
      requiredField: true
    }].concat(
      (
        (c) => c.length
          ? [{
            fieldLabel: 'Steps that save, send or submit',
            fieldType: 'checkbox',
            fieldOptions: { values: c.map((o) => ({ option: o })) }
          }]
          : []
      )(
        ($('Repaired steps received').item.json.safetyFlags ?? []).map(
          (f) => /^candidate write: step (\d+) \((.*)\) may save, post or submit/.exec(String(f))
        ).filter((m) => m).map(
          (m) => 'Step '
            + m[1]
            + ': '
            + m[2].split(',').join(';').split('<').join('\u2039').split('>').join('\u203a')
        )
      ),
      [{
        fieldLabel: 'Any other step that saves, sends or submits (its number)',
        fieldType: 'text',
        placeholder: '7, 9'
      }]
    )
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
}}
