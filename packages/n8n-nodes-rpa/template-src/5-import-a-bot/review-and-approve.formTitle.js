// Template: 5-import-a-bot.json
// Node: Review and approve
// Parameter: options.formTitle
//
// The review page's title: the step list's name and version and the version it replaces; for several lists, how many.

={{
  (
    (lists) => (
      lists.length === 1
        ? String(lists[0].json.name ?? '')
          + ', version '
          + String(lists[0].json.version ?? '')
          + ((r) => (r ? ', replacing version ' + String(r.version ?? '') : ''))(
            $('The bot to change').isExecuted
              ? $('The bot to change').first().json
              : ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
                (r) => r.name === lists[0].json.name
              )
          )
        : 'Review ' + lists.length + ' step lists'
    )
  )($('Import steps').all(1))
}}
