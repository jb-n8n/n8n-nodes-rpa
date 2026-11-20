// Template: 3-approve-steps.json
// Node: Desktop answer
// Parameter: jsonOutput
//
// The desktop form's answer in the shape Ask for approval gives: data.approved, and data.writeSteps, the numbers of the
// ticked steps and of the typed ones. No answer: an empty object.

={{
  $json.data === undefined
    ? {}
    : {
      data: {
        approved: $json.data['Decision'] === 'Approve and sign',
        writeSteps: [].concat($json.data['Steps that save, send or submit'] ?? []).map(
          (l) => (/^Step (\d+):/.exec(String(l)) ?? [])[1]
        ).filter((n) => n).concat(
          String($json.data['Any other step that saves, sends or submits (its number)'] ?? '')
        ).join(' ').trim()
      }
    }
}}
