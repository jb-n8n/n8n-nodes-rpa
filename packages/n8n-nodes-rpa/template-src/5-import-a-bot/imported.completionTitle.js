// Template: 5-import-a-bot.json
// Node: Imported
// Parameter: completionTitle
//
// The last page's title: Imported; after Change or sign again, Signed again, Changed, Nothing changed, or Change or sign
// again when the review page did not run.

={{
  $('Change or sign again').isExecuted
    ? (
      $('Review and approve').isExecuted
        ? (
          (
            $('Sign steps').isExecuted
              ? $('Sign steps').all(0).map((i) => i.json).filter(
                (j) => j.checkOnly !== true && j.status === 'active'
              )
              : []
          ).length
            ? (
              $('Compared with the approved version').isExecuted
                && $('Compared with the approved version').first().json.unchanged === true
                ? 'Signed again'
                : 'Changed'
            )
            : 'Nothing changed'
        )
        : 'Change or sign again'
    )
    : 'Imported'
}}
