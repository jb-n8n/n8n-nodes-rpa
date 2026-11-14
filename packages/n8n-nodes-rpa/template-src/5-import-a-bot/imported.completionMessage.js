// Template: 5-import-a-bot.json
// Node: Imported
// Parameter: completionMessage
//
// The last page: what was imported (not after Change or sign again), the outcome of the review, where the full report
// is, and the secrets to put in a credential. IMPORTED_COUNTS, IMPORTED_RESULT and IMPORTED_SECRETS are in snippets.js,
// shared with Imported, with the workflow file. /not on the Approver Allowlist/ matches the refusal of Sign steps.

={{
  $('Change or sign again').isExecuted ? '' : 'Imported: ' + IMPORTED_COUNTS + '\n'
}}{{ IMPORTED_RESULT }}{{
  $('Change or sign again').isExecuted
    || (
      $('Sign steps').isExecuted
        && $('Sign steps').all(1).some((i) => /not on the Approver Allowlist/.test(String(i.json.error)))
    )
    ? ''
    : [].concat($('Import steps').first(0).json.drafts ?? []).some(
      (d) => d.surface !== 'desktop' && !d.forApproval && !d.adopted
    )
    ? '\nThe full report, and the reason for any step list that could not be proved, is on the Data output of Import steps in this execution.'
    : '\nThe full report is on the Data output of Import steps in this execution.'
}}{{ IMPORTED_SECRETS }}
