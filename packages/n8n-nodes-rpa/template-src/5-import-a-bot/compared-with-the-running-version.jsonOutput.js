// Template: 5-import-a-bot.json
// Node: Compared with the running version
// Parameter: jsonOutput
//
// Each imported step list that has a running version of its name (What it replaces) compared with that version, by
// COMPARE_STEPS (snippets.js) on the steps without their write marks. Two lists of one name are not compared; a list
// with no running version gets no line.

={{
  (
    (bare, compare, running, lists) => ({
      lists: lists.flatMap(
        (l) => (
          (r) => (
            r
              ? [
                lists.filter((x) => x.name === l.name).length === 1
                  ? (
                    (c) => ({
                      name: l.name,
                      unchanged: c.unchanged === true,
                      compared: c.compared
                        + (
                          /"write"\s*:\s*true/.test(String(r.steps ?? '') + JSON.stringify(l.steps ?? null))
                            ? ' Which steps are writes is not compared: it is chosen again on this page.'
                            : ''
                        )
                    })
                  )(
                    compare(
                      { found: true, name: l.name, version: r.version, steps: bare(r.steps) },
                      bare(l.steps ?? null)
                    )
                  )
                  : {
                    name: l.name,
                    unchanged: false,
                    compared: l.name
                      + ': could not be compared with the approved version '
                      + r.version
                      + ': two step lists have this name. Read every step.'
                  }
              ]
              : []
          )
        )(running.find((r) => r.name === l.name))
      )
    })
  )(
    (v) => {
      let d = v;
      // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return v; } }
      const strip = (x) => (
        x !== null && typeof x === 'object' && !Array.isArray(x)
          ? Object.keys(x).filter((k) => k !== 'write').reduce((o, k) => { o[k] = x[k]; return o; }, { })
          : x
      );
      if (Array.isArray(d)) return JSON.stringify(d.map(strip));
      if (d !== null && typeof d === 'object' && Array.isArray(d.steps)) return JSON.stringify(
        Object.assign({ }, d, { steps: d.steps.map(strip) })
      );
      return typeof v === 'string' ? v : JSON.stringify(v === undefined ? null : v);
    },
    COMPARE_STEPS,
    $('What it replaces').isExecuted ? $('What it replaces').first().json.running : [],
    $('Import steps').all(1).map((i) => i.json)
  )
}}
