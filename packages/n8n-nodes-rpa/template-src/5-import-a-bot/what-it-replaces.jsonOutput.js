// Template: 5-import-a-bot.json
// Node: What it replaces
// Parameter: jsonOutput
//
// For the name typed and the step lists an import names after it (name-1, name-2, …): the newest active row of each
// (running), and the next version number, one more than the highest any row of those names has.

={{
  (
    (name, rows) => (
      (mine) => ({
        running: Object.values(
          mine.filter((r) => r.status === 'active' && typeof r.steps === 'string' && r.steps !== '').reduce(
            (by, r) => (
              by[r.name] && Number(by[r.name].version) >= Number(r.version)
                ? by
                : Object.assign(
                  by,
                  {
                    [r.name]: {
                      name: r.name,
                      version: Number(r.version),
                      steps: r.steps,
                      signature: String(r.signature ?? ''),
                      approvedBy: String(r.approvedBy ?? '')
                    }
                  }
                )
            ),
            {}
          )
        ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        next: Math.max(0, ...mine.map((r) => Number(r.version))) + 1
      })
    )(
      rows.filter(
        (r) => r.name === name
          || (r.name.startsWith(name + '-') && /^\d+$/.test(r.name.slice(name.length + 1)))
      )
    )
  )(
    String($('Settings').first().json.name ?? '').trim(),
    $('Running versions').all().map((i) => i.json).filter(
      (r) => typeof r.name === 'string' && Number.isInteger(Number(r.version))
    )
  )
}}
