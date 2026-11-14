// Template: 3-approve-steps.json
// Node: Email repaired steps
// Parameter: html
//
// The HTML email that says a step list is ready for review: its safety flags, what the import left out, the numbered
// steps, what changed, the evidence, the hash and which screenshots are attached. Every value from the run is shown as
// text (LOOKALIKE in snippets.js).

=<!-- Every value below comes from the run (page text, model output): each is shown as text, with look-alikes for <, > and & and a zero-width space in each address, so it cannot restyle or hide parts of this email and mail programs do not make a link of it. -->
<h2>Steps version {{ (LOOKALIKE)($json.version) }} for {{ (LOOKALIKE)($json.name) }} are ready for review</h2>
<p style="color:#b00020"><b>Safety flags (what these steps do besides reading pages):</b> {{ (LOOKALIKE)($json.safetyLine) }}</p>
{{
  String($json.leftOutList ?? '')
    ? '<p style="color:#b00020"><b>Left out by the import (the source does these, the steps do not):</b><br>'
      + (LOOKALIKE)($json.leftOutList, true).split('\n').join('<br>')
      + '</p>'
    : ''
}}
{{
  (
    (r, n, e) => (
      Array.isArray(r) && r.length > 0 && r.length === n
        ? '<p><b>The steps</b> (what each one does, built from the step; a description that names another action or site is in red):</p><ol>'
          + r.map(
            (x) => '<li>'
              + e(x.text)
              + (
                typeof x.describedAs === 'string'
                  ? (
                    x.quiet === true
                      ? ' <i style="color:#7e8186">(the author calls it: ' + e(x.describedAs) + ')</i>'
                      : ' <b style="color:#b00020">(described differently as: ' + e(x.describedAs) + ')</b>'
                  )
                  : ''
              )
              + (
                Array.isArray(x.marks) && x.marks.length
                  ? ' <i>· '
                    + e(x.marks.map((m) => String(m).replace(/, starts as [\s\S]*$/, '')).join('; '))
                    + '</i>'
                  : ''
              )
              + (
                Array.isArray(x.each) && x.each.length
                  ? '<ul>'
                    + x.each.map(
                      (y) => '<li>On each page: '
                        + e(y.text)
                        + (
                          typeof y.describedAs === 'string'
                            ? (
                              y.quiet === true
                                ? ' <i style="color:#7e8186">(the author calls it: '
                                  + e(y.describedAs)
                                  + ')</i>'
                                : ' <b style="color:#b00020">(described differently as: '
                                  + e(y.describedAs)
                                  + ')</b>'
                            )
                            : ''
                        )
                        + (
                          Array.isArray(y.marks) && y.marks.length
                            ? ' <i>· ' + e(y.marks.join('; ')) + '</i>'
                            : ''
                        )
                        + '</li>'
                    ).join('')
                    + '</ul>'
                  : ''
              )
              + '</li>'
          ).join('')
          + '</ol>'
        : ''
    )
  )($json.reviewSteps, Array.isArray($json.steps?.steps) ? $json.steps.steps.length : -1, (LOOKALIKE))
}}
<p><b>Evidence{{
  String($json.evidenceLine ?? '').startsWith('Not replayed:') ? '' : ' (as reported by the run)'
}}:</b> {{ (LOOKALIKE)($json.evidenceLine) }}</p>
{{
  (
    (j, e) => (
      Array.isArray(j.reviewSteps)
        && j.reviewSteps.length > 0
        && Array.isArray(j.steps?.steps)
        && j.reviewSteps.length === j.steps.steps.length
        && Array.isArray(j.changes)
        && j.changes.length > 0
        && j.changes.every((c) => c && c.was === null)
        ? ''
        : '<p><b>What changed'
          + (
            String(j.evidenceLine ?? '').startsWith('Not replayed:')
              ? ' (as written; these steps were never run)'
              : ' (as reported by the run)'
          )
          + ':</b><br>'
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
                                ? ' <i style="color:#7e8186">(the author calls it: '
                                  + e(x.describedAs)
                                  + ')</i>'
                                : ' <b style="color:#b00020">(described differently as: '
                                  + e(x.describedAs)
                                  + ')</b>'
                            )
                            : ''
                        )
                        + (
                          typeof x.was === 'string'
                            ? ' <i style="color:#7e8186">(was: ' + e(x.was) + ')</i>'
                            : ''
                        )
                  )
              ).join('<br>')
              : e(j.changeList, true).split('\n').join('<br>')
          )
          + '</p>'
    )
  )($json, (LOOKALIKE))
}}
<p>Steps hash: <code>{{ (LOOKALIKE)($json.hash) }}</code>. {{
  ({
    'before,after': 'Screenshots before and after the change are attached.',
    'after': 'A screenshot after the change is attached (a first run has no before).',
    'before': 'A screenshot before the change is attached.'
  })[String($json.attachmentNames ?? '')]
    ?? 'No screenshots are attached.'
}} The next email has the Approve and Reject buttons.</p>
