// Template: 2-data-feed.json
// Node: Log failed run
// Parameter: jsonOutput
//
// The run row of a failure, from Run steps' error item: its code (config_error for a configuration error), the message
// cut to 1,000 characters, what to do, the account and the run facts. Only the columns playwright_runs has, as the
// workflow the import form hands over writes them (import/workflow.ts rowExpression): a table made by an earlier version
// lacks message, guidance, file and account. Without the list of columns, only the ten every table has.

={{
  (
    (row, have) => Object.fromEntries(Object.entries(row).filter(([k]) => have.includes(k)))
  )(
    (
      (j) => ({
        name: $('Settings').item.json.name,
        code: j.details?.code || 'config_error',
        message: ((m) => (m.length > 1000 ? m.slice(0, 999).join('') + '…' : m.join('')))(Array.from(String(j.message ?? ''))),
        guidance: j.details?.guidance ?? '',
        file: '',
        account: j.details?.account ?? '',
        lane: j.details?.lane ?? '',
        version: j.details?.version ?? 0,
        hash: j.details?.hash ?? '',
        confirmed: false,
        rowCount: 0,
        durationMs: j.details?.durationMs ?? 0,
        llmTokens: j.details?.llmTokens ?? 0,
        executionId: $execution.id
      })
    )($('Run steps').item.json),
    (
      (have) => (
        have.length
          ? have
          : ['name', 'lane', 'version', 'hash', 'confirmed', 'rowCount', 'durationMs', 'llmTokens', 'code', 'executionId']
      )
    )([].concat($('Create run log table').first().json.columns ?? []).map((c) => c?.name))
  )
}}
