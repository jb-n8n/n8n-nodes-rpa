// Template: 5-import-a-bot.json
// Node: Approved meanwhile
// Parameter: completionMessage
//
// Another version of a reviewed step list was approved or rejected while the review page was open: the page names
// those lists with their newest version. Nothing was signed or rejected.

={{
  (
    (rows, lists, e) => 'Nothing was signed or rejected. While this page was open, another version of '
      + lists.filter((l) => rows.some((r) => r.name === l.name && Number(r.version) >= Number(l.version))).map(
        (l) => e(l.name)
          + ' (version '
          + e(Math.max(...rows.filter((r) => r.name === l.name).map((r) => Number(r.version))))
          + ')'
      ).join(', ')
      + ' was approved or rejected.\nOpen the form again and start again: it shows the version that runs now.'
  )(
    $('Versions now').all().map((i) => i.json).filter((r) => typeof r.name === 'string'),
    $('Import steps').all(1).map((i) => i.json),
    ESCAPE_HTML
  )
}}
