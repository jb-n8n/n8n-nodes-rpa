// Template: 3-approve-steps.json
// Node: Ask for approval (desktop steps)
// Parameter: message
//
// The approval email for desktop steps (send and wait, with a form): the version and name, the numbered steps, what
// ticking a step and approving do, how each step finds its control, the evidence, safety flags, change list, hash and
// review digest. Every value from the run goes through LOOKALIKE (snippets.js). For a desktop AI repair (DESKTOP_PROOF)
// the opening lines give the proof's evidence line, the comparison with the approved version it started from (only one
// whose signature fits: DESKTOP_REPAIR_BASE) and that version's writes; each step says whether it is as approved,
// retargeted or added, and whether the proof ran it. An import's email reads as before.

=Desktop steps version {{ (LOOKALIKE)($('Repaired steps received').item.json.version) }} for {{ (LOOKALIKE)($('Repaired steps received').item.json.name) }}, for your approval.
{{
  (
    (proof, base) => (
    (steps, e, tag) => [
      'Opens ' + e($('Repaired steps received').item.json.steps?.app?.exe) + ' on the desktop runner.'
    ].concat(
      steps.map((s, i) => (s.expectFile ? i + 1 : 0)).filter((i) => i).map(
        (i) => 'Returns a file to n8n: step ' + i + '.'
      ),
      proof
        ? [
          'Repaired by AI (as reported by the run): ' + e($('Repaired steps received').item.json.evidenceLine),
          (
            (inUse) => (
              inUse !== $('Repaired steps received').item.json.baseVersion
                ? '⚠ Version ' + e($('Repaired steps received').item.json.baseVersion) + ' is no longer the one in use'
                  + (inUse === null ? '' : ' (version ' + e(inUse) + ' is)')
                  + ': the steps are not compared with it and no step starts ticked. Read every step.'
                : ''
            )
          )(DESKTOP_IN_USE),
          base
            && (
              (mine, theirs) => mine.length !== theirs.length || mine.some((k) => !theirs.includes(k))
            )(
              base.at.map((k, i) => (k < 0 ? i + 1 : 0)).filter((k) => k),
              [].concat(proof.changedSteps ?? [], proof.addedSteps ?? [])
            )
            ? '⚠ The steps the repair reports it changed or added are not the steps that differ from version '
              + e(base.version)
              + ': read the steps marked below.'
            : '',
          base
            ? e(
              (COMPARE_STEPS)(
                { found: true, name: $('Repaired steps received').item.json.name, version: base.version, steps: base.bare(base.was) },
                base.bare($('Repaired steps received').item.json.steps)
              ).compared
            )
              + ' (which steps are writes is not compared: you tick them again)'
            : e($('Repaired steps received').item.json.name)
              + ': could not be compared with an approved version '
              + e($('Repaired steps received').item.json.baseVersion)
              + ' whose signature fits: read every step, and tick its writes yourself.',
          base
            ? (
              (n) => (
                n.length
                  ? 'Version ' + e(base.version) + ' marked as writes, on steps the repair did not change: ' + n.map((k) => 'step ' + k).join(', ') + '. They start ticked.'
                  : 'Version ' + e(base.version) + ' marked no write on the steps the repair did not change.'
              )
            )(base.write.map((w, i) => (w ? i + 1 : 0)).filter((k) => k))
            : 'No step starts ticked.'
        ].filter((l) => l !== '')
        : ['Not tried by the import: read every step before you approve.']
    ).join('\n')
      + (
        String($('Repaired steps received').item.json.leftOutList ?? '')
          ? '\n\n⚠ Left out by the import:\n'
            + (LOOKALIKE)($('Repaired steps received').item.json.leftOutList, true)
          : ''
      )
      + '\n\nThe steps:\n'
      + (
        (r) => (
          Array.isArray(r) && r.length === steps.length
            ? r.map(
              (x, i) => (i + 1)
                + '. '
                + e(x.text)
                + (
                  typeof x.describedAs === 'string'
                    ? (
                      x.quiet === true
                        ? ' (the author calls it: ' + e(x.describedAs) + ')'
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
                + tag(i)
            ).join('\n')
            : steps.map(
              (s, i) => (i + 1)
                + '. '
                + e(
                  (
                    (field, isVar, file) => (
                      s.fill
                        ? (
                          file
                            ? 'Save ' + file[1] + ' into the run\'s export folder'
                            : isVar(s.fill.value)
                            ? 'Type into ' + field
                            : 'Type "' + String(s.fill.value) + '" into ' + field
                        )
                        : s.select
                        ? (
                          isVar(s.select.option)
                            ? 'Choose an item in ' + field
                            : 'Choose "' + String(s.select.option) + '" in ' + field
                        )
                        : s.key
                        ? 'Press ' + String(s.key.key) + (field ? ' in ' + field : '')
                        : s.check
                        ? (s.check.checked === false ? 'Uncheck ' : 'Check ') + field
                        : String(s.intent ?? '')
                    )
                  )(
                    (
                      (t) => (
                        t && t.uia && Array.isArray(t.uia.path) && t.uia.path.length
                          ? String(
                            t.uia.path[t.uia.path.length - 1].name
                              ?? t.uia.path[t.uia.path.length - 1].automationId
                              ?? ''
                          )
                          : ''
                      )
                    )(s.fill?.field ?? s.select?.field ?? s.key?.target ?? s.check?.field)
                      || String(s.intent ?? ''),
                    (v) => /\x7b\x7b\s*var\./.test(String(v ?? '')),
                    s.fill ? /^\x7b\x7b\$exportDir\x7d\x7d[\\/](.+)$/.exec(String(s.fill.value ?? '')) : null
                  )
                )
                + ((m) => (m.length ? ' (' + e(m.join('; ')) + ')' : ''))(
                  Array.from(
                    new Set(
                      (
                        JSON.stringify(Object.assign({}, s, { intent: undefined })).match(/\x7b\x7bvar\.([A-Za-z_][A-Za-z0-9_]*)\x7d\x7d/g)
                          ?? []
                      ).map((v) => v.slice(6, -2))
                    )
                  ).map(
                    (v) => (
                      [].concat($('Repaired steps received').item.json.secretVariables ?? []).includes(v)
                        ? 'secret variable '
                        : 'variable '
                    )
                      + v
                  ).concat(
                    s.expectFile ? ['returns a file'] : [],
                    s.read && s.read.as ? ['gives its text to n8n as ' + s.read.as] : []
                  )
                )
                + tag(i)
            ).join('\n')
        )
      )($('Repaired steps received').item.json.reviewSteps)
  )(
    Array.isArray($('Repaired steps received').item.json.steps?.steps)
      ? $('Repaired steps received').item.json.steps.steps
      : [],
    (LOOKALIKE),
    (i) => (
      proof
        ? ' ['
          + (
            base && base.at[i] >= 0
              ? 'as approved in version ' + base.version
              : [].concat(proof.addedSteps ?? []).includes(i + 1)
              ? 'added by AI repair (as reported by the run)'
              : [].concat(proof.changedSteps ?? []).includes(i + 1)
              ? 'retargeted by AI repair (as reported by the run)'
              : base
              ? '⚠ not in the approved version'
              : 'unchanged, as the repair reports it'
          )
          + '; '
          + (
            i + 1 <= proof.replayed
              ? 'ran in the proof'
              : i + 1 === proof.stoppedAt
              ? 'found in the proof, not run'
              : 'not run in the proof'
          )
          + ']'
        : ''
    )
  )
  )(
    (DESKTOP_PROOF)($('Repaired steps received').item.json),
    (DESKTOP_REPAIR_BASE)($('Repaired steps received').item.json)
  )
}}

Click Review and decide, tick the steps that save, send or submit ({{
  (DESKTOP_PROOF)($('Repaired steps received').item.json)
    && (DESKTOP_REPAIR_BASE)($('Repaired steps received').item.json)
    ? 'the ones your approved version marked start ticked on the steps the repair did not change: check them'
    : 'none is ticked for you'
}}), then approve or reject. Ticked steps are allowed to save or send. Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.
Approve and sign: these exact steps are signed, the ticked steps as writes, and n8n runs them on the desktop runner without asking again, until you approve another version. Reject: nothing is signed; the version in use, if any, stays in use. This request expires after {{ $('Settings').item.json.approvalTimeoutHours }} hours.

Details of every step (how each one finds its control):{{
  String($('Repaired steps received').item.json.leftOutList ?? '')
    ? '\nLeft out by the import (the source does these, the steps do not):\n'
      + (LOOKALIKE)($('Repaired steps received').item.json.leftOutList, true)
    : ''
}}
Evidence: {{ (LOOKALIKE)($('Repaired steps received').item.json.evidenceLine) }}
Safety flags: {{ (LOOKALIKE)($('Repaired steps received').item.json.safetyLine) }}
{{ (LOOKALIKE)($('Repaired steps received').item.json.changeList, true) }}
The two values below identify what you are approving; you do not need to compare them by hand.
Hash: {{ (LOOKALIKE)($('Repaired steps received').item.json.hash) }}
Review digest: {{ (LOOKALIKE)($('Repaired steps received').item.json.digest) }}
