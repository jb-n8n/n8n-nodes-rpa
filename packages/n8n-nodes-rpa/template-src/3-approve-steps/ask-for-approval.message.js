// Template: 3-approve-steps.json
// Node: Ask for approval
// Parameter: message
//
// The approval email (send and wait): the version and name, what the import left out, the numbered steps (the whole
// bot; "the AI describes it as" on a description the chat model wrote), what changed (for a repair, compared with the
// approved version it repairs when its signature fits: COMPARED_WITH_BASE; otherwise a sentence that it could not be
// compared, then what the repair reports), the evidence and safety flags, what Approve and Reject do, the hash and the
// review digest. Every value from the run goes through LOOKALIKE (snippets.js), so a mail program shows it as text and
// makes no link of it.

=Steps version {{ (LOOKALIKE)($('Repaired steps received').item.json.version) }} for {{ (LOOKALIKE)($('Repaired steps received').item.json.name) }}{{
  String($('Repaired steps received').item.json.leftOutList ?? '')
    ? '\nLeft out by the import (the source does these, the steps do not):\n'
      + (LOOKALIKE)($('Repaired steps received').item.json.leftOutList, true)
    : ''
}}{{
  (
    (r, n, e) => (
      Array.isArray(r) && r.length > 0 && r.length === n
        ? '\nThe steps (what each one does, built from the step):\n'
          + r.map(
            (x, k) => (k + 1)
              + '. '
              + e(x.text)
              + (
                typeof x.describedAs === 'string'
                  ? (
                    x.quiet === true
                      ? ' (' + (x.byAi === true ? 'the AI describes it as: ' : 'the author calls it: ') + e(x.describedAs) + ')'
                      : ' ⚠ (described differently as: ' + e(x.describedAs) + ')'
                  )
                  : ''
              )
              + (
                Array.isArray(x.marks) && x.marks.length
                  ? ' ('
                    + e(x.marks.map((m) => String(m).replace(/, starts as [\s\S]*$/, '')).join('; '))
                    + ')'
                  : ''
              )
              + (
                Array.isArray(x.each) && x.each.length
                  ? x.each.map(
                    (y) => '\n   On each page: '
                      + e(y.text)
                      + (
                        typeof y.describedAs === 'string'
                          ? (
                            y.quiet === true
                              ? ' (' + (y.byAi === true ? 'the AI describes it as: ' : 'the author calls it: ') + e(y.describedAs) + ')'
                              : ' ⚠ (described differently as: ' + e(y.describedAs) + ')'
                          )
                          : ''
                      )
                      + (Array.isArray(y.marks) && y.marks.length ? ' (' + e(y.marks.join('; ')) + ')' : '')
                  ).join('')
                  : ''
              )
          ).join('\n')
        : ''
    )
  )(
    $('Repaired steps received').item.json.reviewSteps,
    Array.isArray($('Repaired steps received').item.json.steps?.steps)
      ? $('Repaired steps received').item.json.steps.steps.length
      : -1,
    (LOOKALIKE)
  )
}}
Evidence{{
  String($('Repaired steps received').item.json.evidenceLine ?? '').startsWith('Not replayed:')
    ? ''
    : ' (as reported by the run)'
}}: {{ (LOOKALIKE)($('Repaired steps received').item.json.evidenceLine) }}
Safety flags: {{ (LOOKALIKE)($('Repaired steps received').item.json.safetyLine) }}{{
  (
    (j, e, el, fits, c) => (
      fits
        && Array.isArray(j.changes)
        && j.changes.length > 0
        && j.changes.every((c) => c && c.was === null)
        ? ''
        : fits && c !== ''
        ? '\nWhat changed: ' + e(c)
        : (
          fits && typeof j.baseVersion === 'number'
            ? '\nNot compared: no approved version '
              + e(j.baseVersion)
              + ' of '
              + e(j.name)
              + ' was found whose signature fits, so these steps could not be compared with an approved version. Read every step.'
              + '\nWhat the repair reports it changed:\n'
            : '\nWhat changed'
              + (
                String(j.evidenceLine ?? '').startsWith('Not replayed:')
                  ? ' (as written; these steps were never run)'
                  : ' (as reported by the run)'
              )
              + ':\n'
        )
          + (
            Array.isArray(j.reviewChanges)
              && Array.isArray(j.changes)
              && j.reviewChanges.length === j.changes.length
              ? j.reviewChanges.map(
                (x) => e(x.change)
                  + ': '
                  + (
                    x.change === 'Removed'
                      ? e(x.was)
                      : (x.step ? 'step ' + e(x.step) + (x.onEachPage ? ', on each page' : '') + ', ' : '')
                        + e(x.text)
                        + (
                          typeof x.describedAs === 'string'
                            ? (
                              x.quiet === true
                                ? ' ('
                                  + ((CHANGE_BY_AI)(j, x) ? 'the AI describes it as: ' : 'the author calls it: ')
                                  + e(x.describedAs)
                                  + ')'
                                : ' ⚠ (described differently as: ' + e(x.describedAs) + ')'
                            )
                            : ''
                        )
                        + (typeof x.was === 'string' ? ' (was: ' + e(x.was) + ')' : '')
                  )
              ).join('\n')
              : el(j.changeList)
          )
    )
  )(
    $('Repaired steps received').item.json,
    (LOOKALIKE),
    ((s) => (LOOKALIKE)(s, true)),
    Array.isArray($('Repaired steps received').item.json.reviewSteps)
      && $('Repaired steps received').item.json.reviewSteps.length > 0
      && Array.isArray($('Repaired steps received').item.json.steps?.steps)
      && $('Repaired steps received').item.json.reviewSteps.length === $('Repaired steps received').item.json.steps.steps.length,
    (COMPARED_WITH_BASE)($('Repaired steps received').item.json)
  )
}}

Approve: these exact steps are signed and n8n runs them with the stored login, without asking again, until the site changes. Reject: nothing is signed; the version in use, if any, stays in use. The two values below identify what you are approving; you do not need to compare them by hand. This request expires after {{ $('Settings').item.json.approvalTimeoutHours }} hours.
Hash: {{ (LOOKALIKE)($('Repaired steps received').item.json.hash) }}
Review digest: {{ (LOOKALIKE)($('Repaired steps received').item.json.digest) }}
