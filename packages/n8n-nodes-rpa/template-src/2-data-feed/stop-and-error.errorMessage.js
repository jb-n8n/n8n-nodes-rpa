// Template: 2-data-feed.json
// Node: Stop and Error
// Parameter: errorMessage
//
// Ends a failed run as failed, in the words of the workflow the import form hands over (STOP_SENTENCE): the code and
// the name, the message (with, when steps wait for approval, which version and how to approve it: REPAIR_WAITING) and
// what to do. From Run steps' error item, so the message is whole whatever columns the run log has.

={{
  (STOP_SENTENCE)(
    (
      (j, w) => ({
        code: j.details?.code || 'config_error',
        name: $('Settings').first().json.name,
        message: (
          (m) => (
            w === ''
              ? m
              : m === ''
              ? w
              : m + (/[.!?…]$/.test(m) ? '' : '.') + ' ' + w
          )
        )(String(j.message ?? '')),
        guidance: j.details?.guidance ?? ''
      })
    )($('Run steps').first(2).json, REPAIR_WAITING)
  )
}}
