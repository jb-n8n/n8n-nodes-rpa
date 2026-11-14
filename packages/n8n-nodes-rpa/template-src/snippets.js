// The pieces the templates' long expressions share, each written once (scripts/build-templates.mjs reads them).
// Inside {{ … }} in a source file, or in another piece, NAME as a whole word stands for the piece's text. The
// templates hold no Code node, and each {{ … }} block is a scope of its own: that is why a piece is copied into every
// expression that uses it. Spellings that differ (the three HTML escapes) are kept apart, so the bytes of the
// templates stay as they are.

// HTML escape for text on a form page: & < > " and ' become entities. Template 5.
const ESCAPE_HTML =
  (s) =>
    String(s ?? '').replace(
      /[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

// The same escape, with the double quote written \" (JavaScript reads it the same). Template 5.
const ESCAPE_HTML_QUOTED =
  (s) =>
    String(s ?? '').replace(
      /[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[c]
    );

// The same escape, with its parameter named ch. Template 5, Review and approve.
const ESCAPE_HTML_CH =
  (s) =>
    String(s ?? '').replace(
      /[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );

// Compares the approved steps (bot: found, name, version, steps) with the steps typed (text, '' for none). Returns
// { steps, changed, unchanged, compared }: compared is the line the review page shows (unchanged, cannot be compared,
// or which steps and which other signed fields changed, step by step, spacing and key order aside). Template 5,
// Compared with the approved version and Compared with the running version.
const COMPARE_STEPS =
  (bot, typed) => {
    const n = String(bot.version);
    const who = String(bot.name ?? '') + ': ';
    if (typed.trim() === '') return {
      steps: String(bot.steps ?? ''),
      changed: false,
      unchanged: true,
      compared: who + 'unchanged from the approved version ' + n + '.'
    };
    // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
    const parse = (s) => { try { return JSON.parse(String(s)); } catch (e) { return undefined; } };
    const asDoc = (v) => (Array.isArray(v) ? { steps: v } : v);
    const canon = (v) => (
      Array.isArray(v)
        ? '[' + v.map(canon).join(',') + ']'
        : v !== null && typeof v === 'object'
        ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
        : JSON.stringify(v === undefined ? null : v)
    );
    const was = asDoc(parse(bot.steps));
    const now = asDoc(parse(typed));
    const out = (compared, unchanged) => ({ steps: typed, changed: true, unchanged, compared });
    const usable = (d) => d !== null && typeof d === 'object' && Array.isArray(d.steps);
    if (bot.found !== true || !usable(was) || !usable(now)) return out(
      who
        + 'could not be compared with the approved version'
        + (bot.found === true ? ' ' + n : '')
        + ': read every step.',
      false
    );
    const a = was.steps.map(canon);
    const b = now.steps.map(canon);
    const steps = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (
      i >= a.length || i >= b.length || a[i] !== b[i]
    ) steps.push(i + 1);
    const labels = [
      ['startUrl', 'the start site'],
      ['app', 'the app'],
      ['interrupts', 'the pop-up handlers'],
      ['surface', 'browser or desktop']
    ];
    const others = [...new Set(Object.keys(was).concat(Object.keys(now)))].filter(
      (k) => !['name', 'version', 'steps', 'signature', 'approvedBy'].includes(k)
        && canon(was[k]) !== canon(now[k])
    ).sort().map((k) => (labels.find((p) => p[0] === k) || [k, 'the field ' + k])[1]);
    if (steps.length === 0 && others.length === 0) return out(
      who + 'unchanged from the approved version ' + n + '.', true
    );
    const leaves = (v, path, acc) => {
      if (Array.isArray(v) && v.length) v.forEach((x, i) => leaves(x, path.concat([i]), acc));
      else if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) Object.keys(v).forEach(
        (k) => leaves(v[k], path.concat([k]), acc)
      );
      else acc[JSON.stringify(path)] = v;
      return acc;
    };
    const cut = (s) => ((c) => (c.length > 60 ? c.slice(0, 59).join('') + '…' : s))(Array.from(s));
    const show = (v) => (
      v === undefined
        ? '(none)'
        : typeof v === 'string'
        ? '"' + cut(v.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')) + '"'
        : cut(JSON.stringify(v))
    );
    const word = (path) => (
      (keys) => (
        (k, p) => (
          k === 'intent'
            ? 'description'
            : k === 'goto'
            ? 'address'
            : k === 'value' && p === 'fill'
            ? 'typed value'
            : (k === 'value' || k === 'option') && p === 'select'
            ? 'chosen option'
            : k === 'name'
            ? 'control name'
            : k === 'label'
            ? 'field label'
            : k === 'text'
            ? 'visible text'
            : k === 'css'
            ? 'selector'
            : k ?? 'value'
        )
      )(keys[keys.length - 1], keys[keys.length - 2])
    )(path.filter((x) => typeof x === 'string'));
    const fields = (x, y) => (
      (p, q) => (
        (keys) => (
          keys.length > 3
            ? 'several fields'
            : keys.length === 0
            ? 'changed'
            : keys.map((k) => word(JSON.parse(k)) + ' ' + show(p[k]) + ' → ' + show(q[k])).join(', ')
        )
      )(
        [...new Set(Object.keys(p).concat(Object.keys(q)))].filter(
          (k) => !(k in p) || !(k in q) || canon(p[k]) !== canon(q[k])
        )
      )
    )(leaves(x, [], { }), leaves(y, [], { }));
    const numbers = (list) => (list.length === 1 ? 'step ' : 'steps ') + list.join(', ');
    const counts = b.length === a.length
      ? ''
      : ' ' + b.length + ' steps now, ' + a.length + ' in the approved version.';
    const tail = (parts) =>
      out(
        who
          + 'changed from the approved version '
          + n
          + ': '
          + parts.concat(others.length ? [others.join(', ')] : []).join('; ')
          + '.'
          + counts,
        false
      );
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let end = 0;
    while (end < a.length - head && end < b.length - head && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const ra = a.length - head - end;
    const rb = b.length - head - end;
    if (ra * rb > 250000 || ra > 2000 || rb > 2000) return tail(
      (
        steps.length
          ? [
            steps.slice(0, 3).map(
              (s) => 'step '
                + s
                + ': '
                + (
                  s > a.length
                    ? 'added'
                    : s > b.length
                    ? 'removed'
                    : fields(was.steps[s - 1], now.steps[s - 1])
                )
            ).join('; ')
              + (steps.length > 3 ? '; and more: ' + numbers(steps.slice(3)) : '')
          ]
          : []
      ).concat(
        ['compared step by step in place, because there are too many steps to line up: after a step added or taken out, every later step reads as changed']
      )
    );
    const L = [];
    for (let i = ra; i >= 0; i--) {
      L[i] = [];
      for (let j = rb; j >= 0; j--) L[i][j] = i === ra || j === rb
        ? 0
        : a[head + i] === b[head + j]
        ? L[i + 1][j + 1] + 1
        : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const gaps = [];
    const common = [];
    let gapWas = [];
    let gapNow = [];
    const flush = () => {
      if (gapWas.length || gapNow.length) gaps.push([gapWas, gapNow]); gapWas = []; gapNow = [];
    };
    let i = 0;
    let j = 0;
    while (i < ra || j < rb) {
      if (i < ra && j < rb && a[head + i] === b[head + j]) {
        flush(); common.push([head + i, head + j]); i++; j++;
      } else if (j >= rb || (i < ra && L[i + 1][j] >= L[i][j + 1])) { gapWas.push(head + i); i++; } else {
        gapNow.push(head + j); j++;
      }
    }
    flush();
    const intentOf = (s) => (
      s !== null && typeof s === 'object' && typeof s.intent === 'string' ? s.intent.trim() : ''
    );
    const gapOfWas = [];
    const gapOfNow = [];
    gaps.forEach(
      (g, x) => { g[0].forEach((r) => { gapOfWas[r] = x; }); g[1].forEach((s) => { gapOfNow[s] = x; }); }
    );
    const pairs = [];
    const usedWas = new Set();
    const usedNow = new Set();
    const pair = (r, s) => { pairs.push([r, s]); usedWas.add(r); usedNow.add(s); };
    const byCanon = new Map();
    gaps.forEach(
      (g) =>
        g[1].forEach(
          (s) => {
            if (!byCanon.has(b[s])) byCanon.set(b[s], { list: [], at: 0 }); byCanon.get(b[s]).list.push(s);
          }
        )
    );
    gaps.forEach(
      (g) =>
        g[0].forEach(
          (r) => {
            const hit = byCanon.get(a[r]); if (hit && hit.at < hit.list.length) pair(r, hit.list[hit.at++]);
          }
        )
    );
    const restWas = gaps.flatMap((g) => g[0]).filter((r) => !usedWas.has(r));
    const restNow = gaps.flatMap((g) => g[1]).filter((s) => !usedNow.has(s));
    const tally = (list, steps) =>
      list.reduce(
        (m, q) => ((t) => (t === '' ? m : m.set(t, (m.get(t) || 0) + 1)))(intentOf(steps[q])), new Map()
      );
    const countWas = tally(restWas, was.steps);
    const countNow = tally(restNow, now.steps);
    const nowOf = new Map();
    restNow.forEach(
      (s) => { if (countNow.get(intentOf(now.steps[s])) === 1) nowOf.set(intentOf(now.steps[s]), s); }
    );
    restWas.forEach(
      (r) => {
        const s = countWas.get(intentOf(was.steps[r])) === 1 ? nowOf.get(intentOf(was.steps[r])) : undefined;
        if (s !== undefined && gapOfNow[s] !== gapOfWas[r]) pair(r, s);
      }
    );
    const changed = [];
    const gone = [];
    const added = [];
    gaps.forEach(
      (g) => {
        const w = g[0].filter((r) => !usedWas.has(r));
        const v = g[1].filter((s) => !usedNow.has(s));
        const k = Math.min(w.length, v.length);
        for (let x = 0; x < k; x++) changed.push([w[x], v[x]]);
        w.slice(k).forEach((r) => gone.push(r));
        v.slice(k).forEach((s) => added.push(s));
      }
    );
    const moved = [];
    const movedAt = new Set();
    const move = (p) => { if (!movedAt.has(p[0])) { moved.push(p); movedAt.add(p[0]); } };
    pairs.forEach(
      (p) => {
        if (a[p[0]] !== b[p[1]]) changed.push(p);
        else if (p[0] !== p[1]) move(p);
        if (p[0] === p[1]) common.filter((c) => (c[0] < p[0] && c[1] > p[1]) || (c[0] > p[0] && c[1] < p[1])).forEach(move);
      }
    );
    moved.sort((m, q) => m[0] - q[0]);
    changed.sort((m, q) => m[0] - q[0]);
    added.sort((m, q) => m - q);
    gone.sort((m, q) => m - q);
    const words = (s) => (
      s !== null && typeof s === 'object' && typeof s.intent === 'string' && s.intent.trim() !== ''
        ? ' (' + show(s.intent) + ')'
        : ''
    );
    return tail(
      [].concat(
        gone.length
          ? [
            'removed: '
              + gone.slice(0, 3).map((r) => 'step ' + (r + 1) + words(was.steps[r])).join(', ')
              + (gone.length > 3 ? ', and ' + numbers(gone.slice(3).map((r) => r + 1)) : '')
          ]
          : [],
        added.length ? ['added: ' + numbers(added.map((s) => s + 1))] : [],
        moved.length
          ? [
            'moved: '
              + moved.slice(0, 3).map(
                (m) => 'step ' + (m[0] + 1) + words(was.steps[m[0]]) + ' is now step ' + (m[1] + 1)
              ).join(', ')
              + (moved.length > 3 ? ', and ' + (moved.length - 3) + ' more' : '')
          ]
          : [],
        changed.length
          ? [
            changed.slice(0, 3).map(
              (p) => 'step '
                + (p[0] + 1)
                + (p[0] === p[1] ? '' : ' (now step ' + (p[1] + 1) + ')')
                + ': '
                + fields(was.steps[p[0]], now.steps[p[1]])
            ).join('; ')
              + (
                changed.length > 3
                  ? '; and more changed: '
                    + (changed.length === 4 ? 'step ' : 'steps ')
                    + changed.slice(3).map(
                      (p) => (p[0] + 1) + (p[0] === p[1] ? '' : ' (now ' + (p[1] + 1) + ')')
                    ).join(', ')
                  : ''
              )
          ]
          : []
      )
    );
  };

// Sign steps' check before the review page (its first item), or {} when Sign steps did not run. Template 5, Review and
// approve.
const SIGN_STEPS_JSON =
  $('Sign steps').isExecuted ? $('Sign steps').first().json : {};

// The approved version (The approved version) when it is a version of the step list l, the parameter of the function
// it is written in; otherwise null. Template 5, Review and approve.
const APPROVED_OF_LIST =
  $('The approved version').isExecuted
    && $('The approved version').first().json.name === l.name
    && typeof $('The approved version').first().json.steps === 'string'
    ? $('The approved version').first().json
    : null;

// Imported: how many steps, how many were not translated and how many were removed as secrets. Template 5, the two
// last pages (Imported and Imported, with the workflow file).
const IMPORTED_COUNTS =
  (
    (r) => (
      (u, k) => r.steps
        + (r.steps === 1 ? ' step' : ' steps')
        + (
          u || k
            ? '; '
              + [u ? u + ' not translated' : '', k ? k + ' removed as secrets' : ''].filter((x) => x).join(', ')
            : ''
        )
        + '.'
    )(
      r.items.filter((i) => i.kind === 'untranslated').length,
      r.items.filter((i) => i.kind === 'secret').length
    )
  )($('Import steps').first(0).json.report);

// The outcome, a line each: after Review and approve, what was signed, signed again, changed, rejected or refused and
// why; without it, how many step lists passed the replay and wait for approval in RPA: 3 Approve steps, or that Approve
// steps names no workflow. /not on the Approver Allowlist/ matches the refusal of Sign steps. Template 5, the two last
// pages.
const IMPORTED_RESULT =
  $('Review and approve').isExecuted
    ? (
      (drafts, signed, refused, b, same, e, approved) => [
        ((r, a) => r ? a + ' of ' + r + (r === 1 ? ' step list' : ' step lists') + ' passed the replay.' : '')(
          drafts.filter((d) => d.surface !== 'desktop' && !d.forApproval).length,
          drafts.filter((d) => d.adopted).length
        )
      ].concat(
        signed.map(
          (s) => (
            (r) => s.status === 'active'
              ? (
                !b
                  ? (
                    r
                      ? 'Approved and signed: '
                        + e(s.name)
                        + ' version '
                        + e(s.version)
                        + ' is now the version that runs, replacing version '
                        + e(r.version)
                        + '.'
                      : 'Approved and signed: '
                        + e(s.name)
                        + ' version '
                        + e(s.version)
                        + ' is now the version that runs under that name.'
                  )
                  : same
                  ? 'Signed again: '
                    + e(s.name)
                    + ' version '
                    + e(s.version)
                    + (
                      !Array.isArray(s.writeSteps)
                        ? ', unchanged'
                        : approved === null
                        ? ', steps unchanged'
                        : (
                          (add, drop, say) => (
                            add.length + drop.length === 0
                              ? ', unchanged'
                              : ', steps unchanged; write marks changed from version '
                                + e(b.version)
                                + ': '
                                + [
                                  add.length ? 'added ' + say(add) : '',
                                  drop.length ? 'removed ' + say(drop) : ''
                                ].filter((x) => x).join('; ')
                          )
                        )(
                          s.writeSteps.filter((w) => !approved.some((x) => x.step === w.step)),
                          approved.filter((x) => !s.writeSteps.some((w) => w.step === x.step)),
                          (list) =>
                            list.map(
                              (w) => 'step '
                                + e(w.step)
                                + ' ('
                                + e(String(w.intent ?? '').replace(/\s+/g, ' ').trim())
                                + ')'
                            ).join(', ')
                        )
                    )
                    + '.'
                  : 'Changed: '
                    + e(s.name)
                    + ' version '
                    + e(s.version)
                    + ' is now the version that runs, replacing version '
                    + e(b.version)
                    + '.'
              )
                + (s.writeLine ? ' ' + e(s.writeLine) + '.' : '')
              : !b
              ? 'Rejected: '
                + e(s.name)
                + ' version '
                + e(s.version)
                + '. Nothing was signed.'
                + (r ? ' Version ' + e(r.version) + ' keeps running.' : '')
              : 'Nothing changed: ' + e(b.name) + ' version ' + e(b.version) + ' keeps running.'
          )(
            b
              ? null
              : ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
                (x) => x.name === s.name
              )
          )
        ),
        refused.map(
          (f) => 'Not signed'
            + (
              f.details && f.details.name ? ': ' + e(f.details.name) + ' version ' + e(f.details.version) : ''
            )
            + '. '
            + e(f.error)
            + (/[.!?]$/.test(String(f.error ?? '')) ? '' : '.')
            + (
              /not on the Approver Allowlist/.test(String(f.error))
                ? ' Ask the person who set up this form to approve it, or to put you on its Approver Allowlist.'
                : ''
            )
            + (
              (r) => (
                r ? '\nNothing changed: ' + e(r.name) + ' version ' + e(r.version) + ' keeps running.' : ''
              )
            )(
              b || !f.details
                ? null
                : ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
                  (x) => x.name === f.details.name
                )
            )
        ),
        signed.length + refused.length
          ? []
          : ['Nothing was signed: the review page was not answered in time.'],
        b && !signed.length
          ? ['Nothing changed: ' + e(b.name) + ' version ' + e(b.version) + ' keeps running.']
          : []
      ).filter((x) => x).join('\n')
    )(
      $('Import steps').first(0).json.drafts,
      $('Sign steps').isExecuted
        ? $('Sign steps').all(0).map((i) => i.json).filter((j) => j.checkOnly !== true)
        : [],
      $('Sign steps').isExecuted ? $('Sign steps').all(1).map((i) => i.json) : [],
      $('Change or sign again').isExecuted ? $('The bot to change').first().json : null,
      $('Compared with the approved version').isExecuted
        && $('Compared with the approved version').first().json.unchanged === true,
      ESCAPE_HTML,
      (
        (r, k) => (
          r !== null
            && Boolean(k.approvedVersion)
            && k.approvedVersion.signatureFits === true
            && String(k.approvedVersion.version) === String(r.version)
            ? (
              (d) => (
                Array.isArray(d)
                  ? d.map(
                    (x, i) => (
                      x !== null && typeof x === 'object' && x.write === true
                        ? { step: i + 1, intent: x.intent }
                        : null
                    )
                  ).filter((x) => x)
                  : null
              )
            )(
              (
                (t) => {
                  try {
                    const d = JSON.parse(String(t));
                    return Array.isArray(d) ? d : d && Array.isArray(d.steps) ? d.steps : null;
                  } catch (x) { return null; }
                }
              )(r.steps)
            )
            : null
        )
      )(
        $('The approved version').isExecuted
          && typeof $('The approved version').first().json.steps === 'string'
          ? $('The approved version').first().json
          : null,
        $('Sign steps').isExecuted
          // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
          ? ($('Sign steps').all(0, 0).map((i) => i.json).find((j) => j.checkOnly === true) ?? { })
          : { }
      )
    )
    : $('Settings').first().json.approval === 'by email' && !$('Approve steps').params.workflowId?.value
    ? 'Nothing was sent for approval: Settings say approval by email, but Approve steps names no workflow. Follow the sticky Approval by email, or set approval to on this form.'
    : (
      (r, a, d, n, why) => [
        r
          ? a
            + ' of '
            + r
            + (r === 1 ? ' step list' : ' step lists')
            + ' passed the replay'
            + (
              a === 0
                ? '.'
                : (a === 1 ? ' and is' : ' and are') + ' waiting for approval in RPA: 3 Approve steps.'
            )
          : ''
      ].concat(
        why,
        [
          d
            ? d
              + (d === 1 ? ' desktop step list is' : ' desktop step lists are')
              + ' waiting '
              + (a ? 'there too' : 'for approval in RPA: 3 Approve steps')
              + ', not replayed: review every step and tick the steps that save, send or submit.'
            : '',
          n
            ? n
              + (n === 1 ? ' browser step list is' : ' browser step lists are')
              + ' waiting '
              + (a || d ? 'there too' : 'for approval in RPA: 3 Approve steps')
              + ', not replayed because the steps submit a form, download through a form, type a secret or change a password: check every step, the target of each form and each download.'
            : ''
        ]
      ).filter(part => part).join(' ')
    )(
      $('Import steps').first(0).json.drafts.filter(d => d.surface !== 'desktop' && !d.forApproval).length,
      $('Import steps').first(0).json.drafts.filter(d => d.adopted).length,
      $('Import steps').first(0).json.drafts.filter(d => d.forApproval && d.surface === 'desktop').length,
      $('Import steps').first(0).json.drafts.filter(d => d.forApproval && d.surface !== 'desktop').length,
      $('Import steps').first(0).json.drafts.filter(
        d => d.surface !== 'desktop' && !d.forApproval && !d.adopted && d.reason
      ).map((d) => [d.name, d.reason].map(ESCAPE_HTML).join(': '))
    );

// For each step list signed and active that types a secret: the RPA Secret Variables credential to make or add to, and
// the names to copy into it. Template 5, the two last pages.
const IMPORTED_SECRETS =
  $('Review and approve').isExecuted && $('Sign steps').isExecuted && !$('Change or sign again').isExecuted
    ? (
      (drafts, signed, e) =>
        signed.filter((s) => s.status === 'active').map((s) => drafts.find((d) => d.name === s.name)).filter(
          (d) => d && [].concat(d.secretVariables ?? []).length
        ).map(
          (d) => '\n\n'
            + e(d.name)
            + ' types a secret. In n8n, make an RPA Secret Variables credential (+ → New credential), or add these to the one you have for this app or site; select it on the bot\'s RPA node, and copy these into it:\nCredential: <code>RPA Secret Variables</code>'
            + [].concat(d.secretVariables).map((v) => '\nName: <code>' + e(v) + '</code>').join('')
            + (d.mayBeTypedInto ? '\nMay Be Typed Into: <code>' + e(d.mayBeTypedInto) + '</code>' : '')
            + '\nType the value there only: this form never asks for it.'
        ).join('')
    )(
      [].concat($('Import steps').first(0).json.drafts ?? []),
      $('Sign steps').all(0).map((i) => i.json).filter((j) => j.checkOnly !== true),
      ESCAPE_HTML_QUOTED
    )
    : '';

// Text from a run, for an email: &, < and > become look-alike characters, a backslash before n a full-width one, a line
// break a space (unless lines), and each address gets a zero-width space after :// and each dot, so mail programs do
// not make a link of it (file names such as report.pdf are left alone). Template 3.
const LOOKALIKE =
  (s, lines) =>
    String(s ?? '').replace(
      lines ? /[&<>]|\\(?=n)/g : /[&<>\r\n\u2028\u2029]|\\(?=n)/g,
      (c) => ({ '&': '\uff06', '<': '\u2039', '>': '\u203a', '\\': '\uff3c' })[c] ?? ' '
    ).replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s\u2039\u203a]*|\b(?:[a-z0-9-]+\.)+(?!(?:csv|tsv|xlsx?|pdf|txt|json|xml|zip|docx?|pptx?|png|jpe?g|gif|html?|js|ts|exe|dll|msi)\b)[a-z]{2,}\b[^\s\u2039\u203a]*/gi,
      (u) => u.split('://').join(':\u200b//').split('.').join('.\u200b')
    );
