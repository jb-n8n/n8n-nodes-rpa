// Template: 3-approve-steps.json
// Node: Email signed steps
// Parameter: text
//
// The email that confirms what was signed: version, name and approver; for desktop steps the steps signed as writes and
// why the hash changed; then the hash and the review digest.

=Steps version {{ $('Sign steps').item.json.version }} for {{ $('Sign steps').item.json.name }} are signed and active, approved by {{ $('Sign steps').item.json.approvedBy }} at {{ $('Sign steps').item.json.approvedAt }}.
{{
  (
    (s, r) => (
      s.writeLine
        ? s.writeLine
          + '.'
          + (
            (n) => (
              s.hash !== r.hash && n.length
                ? ' The hash changed because '
                  + (
                    n.length === 1
                      ? 'step ' + n[0] + ' was marked as a write.'
                      : 'steps '
                        + n.slice(0, -1).join(', ')
                        + ' and '
                        + n[n.length - 1]
                        + ' were marked as writes.'
                  )
                : ''
            )
          )((s.writeSteps ?? []).map((x) => x.step))
          + '\n'
        : ''
    )
  )($('Sign steps').item.json, $('Repaired steps received').item.json)
}}
Reference: hash {{ $('Sign steps').item.json.hash }}, review digest {{ $('Repaired steps received').item.json.digest }}.
