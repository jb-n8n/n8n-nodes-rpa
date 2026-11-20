// Template: 3-approve-steps.json
// Node: Ask for approval (desktop steps)
// Parameter: jsonOutput
//
// The desktop approval form's fields, as JSON: Decision, the candidate writes from the safety flags as tick boxes, and a
// field for the numbers of other steps that save, send or submit. None is ticked, except for a desktop AI repair whose
// approved version's signature fits (DESKTOP_REPAIR_BASE): a step it did not change starts as that version marked it,
// a candidate as a tick, any other write as its number. Never from the item itself.

={{
  (
    (base) => JSON.stringify(
    [{
      fieldLabel: 'Decision',
      fieldType: 'dropdown',
      fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] },
      requiredField: true
    }].concat(
      (
        (c) => c.length
          ? [
            Object.assign(
              {
                fieldLabel: 'Steps that save, send or submit',
                fieldType: 'checkbox',
                fieldOptions: { values: c.map((o) => ({ option: o })) }
              },
              (
                (ticked) => (ticked.length ? { defaultValue: ticked.join(',') } : { })
              )(
                base
                  ? c.filter((o) => base.write[Number((/^Step (\d+):/.exec(o) ?? [])[1]) - 1] === true)
                  : []
              )
            )
          ]
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
      [
        Object.assign(
          {
            fieldLabel: 'Any other step that saves, sends or submits (its number)',
            fieldType: 'text',
            placeholder: '7, 9'
          },
          (
            (more) => (more.length ? { defaultValue: more.join(', ') } : { })
          )(
            base
              ? base.write.map((w, i) => (w ? i + 1 : 0)).filter(
                (k) => k && !($('Repaired steps received').item.json.safetyFlags ?? []).some(
                  (f) => String(f).startsWith('candidate write: step ' + k + ' (')
                )
              )
              : []
          )
        )
      ]
    )
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
  )(
    (DESKTOP_PROOF)($('Repaired steps received').item.json)
      ? (DESKTOP_REPAIR_BASE)($('Repaired steps received').item.json)
      : null
  )
}}
