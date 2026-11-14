// Template: 5-import-a-bot.json
// Node: Review and approve
// Parameter: jsonOutput
//
// The review page's fields, as JSON for the form: the comparison line at the top, the Site Login the steps are signed
// for, and a warning when the approved version's signature does not fit; then for each step list its flags, what the
// import left out, the numbered steps, the write steps to tick (desktop) and the decision.
// SIGN_STEPS_JSON and APPROVED_OF_LIST are in snippets.js.

={{
  JSON.stringify(
    (
      (fit, told) => (
        (c, k, lists, e) => [{
          fieldType: 'html',
          html: (
            c
              ? '<p><b>'
                + e(
                  lists.some((l) => l.steps?.surface === 'desktop')
                    && $('Compared with the approved version').first().json.unchanged === true
                    ? told(c).split(': unchanged from the approved version ').join(': the steps are unchanged from the approved version ')
                      + ' Which of them save, send or submit is what you tick below.'
                    : told(c)
                      + (
                        lists.some((l) => l.steps?.surface === 'desktop')
                          && /"write"\s*:\s*true/.test(
                            String($('The bot to change').first().json.steps ?? '')
                              + JSON.stringify(lists.map((l) => l.steps ?? null))
                          )
                          ? ' Which steps are writes is not compared: it is chosen again on this page.'
                          : ''
                      )
                )
                + '</b></p>'
              : ''
          )
            + (
              (browser, desktop, signsIn) => '<p>'
                + (
                  browser
                    ? (
                      k.siteLogin
                        ? (
                          signsIn
                            ? 'Signs for the Site Login named "<b>' + e(k.siteLogin) + '</b>".'
                            : 'These steps do not sign in, and are signed for the Site Login named "<b>'
                              + e(k.siteLogin)
                              + '</b>" all the same.'
                        )
                          + ' The workflow that runs the bot must use this Site Login.'
                        : 'Signs for no RPA Site Login. The workflow that runs the bot must have none.'
                    )
                      + (
                        desktop
                          ? ' Desktop steps are signed for the app they start, without a Site Login.'
                          : ''
                      )
                    : 'Desktop steps are signed for the app they start, without a Site Login.'
                )
                + '</p>'
            )(
              lists.some((l) => l.steps?.surface !== 'desktop'),
              lists.some((l) => l.steps?.surface === 'desktop'),
              lists.some(
                (l) => l.steps?.surface !== 'desktop'
                  && Array.isArray(l.steps?.steps)
                  && l.steps.steps.some((s) => s && s.signIn)
              )
            )
            + (
              fit
                ? '<p><strong>'
                  + fit
                  + ' This page cannot tell which. '
                  + (
                    k.approvedVersion.desktop
                      ? 'Read'
                      : 'If the bot was approved on the import form of '
                        + (k.siteLogin ? 'another' : 'a')
                        + ' Site Login, change it on that form: approved here, it would run only '
                        + (
                          k.siteLogin
                            ? 'with the Site Login "' + e(k.siteLogin) + '"'
                            : 'without a Site Login'
                        )
                        + '. Otherwise read'
                  )
                  + ' every step before you approve: approving signs the steps shown here with this form\'s key, which is the way back after a new signing key.</strong></p>'
                : ''
            )
        }]
      )(
        $('Compared with the approved version').isExecuted
          ? $('Compared with the approved version').first().json.compared
          : '',
        SIGN_STEPS_JSON,
        $('Import steps').all(1).map((i) => i.json),
        ESCAPE_HTML_CH
      ).concat(
        (
          (lists, e, list, detail, label, details, approvedOf, markNote, same) =>
            lists.flatMap(
              (l, k) => (
                (desktop, writes, who) => [{
                  fieldType: 'html',
                  html: (
                    lists.length > 1
                      ? '<h3>'
                        + (k + 1)
                        + ' of '
                        + lists.length
                        + ': '
                        + e(l.name)
                        + ', version '
                        + e(l.version)
                        + ((r) => (r ? ', replacing version ' + e(r.version) : ''))(
                          ($('What it replaces').isExecuted ? $('What it replaces').first().json.running : []).find(
                            (r) => r.name === l.name
                          )
                        )
                        + '</h3>'
                      : ''
                  )
                    + ((x) => (x ? '<p><b>' + e(told(x.compared)) + '</b></p>' : ''))(
                      (
                        $('Compared with the running version').isExecuted
                          ? $('Compared with the running version').first().json.lists ?? []
                          : []
                      ).find((x) => x.name === l.name)
                    )
                    + list(l, e)
                    + (
                      details
                        ? '<h4>Details of every step (how each one finds its control)</h4>' + detail(l, 1, e)
                        : '<p><em>How each step finds its control is in this run\'s execution in n8n (the Import steps node\'s output), and in the approval email when approval is by email.</em></p>'
                    )
                }].concat(
                  writes.length
                    ? [{
                      fieldLabel: who + 'Which of these steps save, send or submit?',
                      fieldName: 'writes_' + k,
                      fieldType: 'checkbox',
                      fieldOptions: { values: writes.map((c) => ({ option: label(c) })) },
                      defaultValue: (
                        (was, now) =>
                          writes.filter(
                            (c) => (
                              was
                                && was[c.step - 1]
                                && now[c.step - 1]
                                && same(was[c.step - 1], now[c.step - 1])
                                ? was[c.step - 1].write === true
                                : !c.signsIn
                            )
                          ).map(label).join(',')
                      )(approvedOf(l), (Array.isArray(l.steps?.steps) ? l.steps.steps : []))
                    }]
                    : [],
                  desktop
                    ? [
                      {
                        fieldType: 'html',
                        html: '<p><em>'
                          + e(
                            markNote(l)
                              + (
                                (moved) => (
                                  moved.length === 0
                                    ? ''
                                    : moved.length === 1
                                    ? 'Step '
                                      + moved[0]
                                      + ' changed since the approved version, so whether it may save or send starts from the rule: check it. '
                                    : 'Steps '
                                      + moved.slice(0, -1).join(', ')
                                      + ' and '
                                      + moved[moved.length - 1]
                                      + ' changed since the approved version, so whether they may save or send starts from the rule: check them. '
                                )
                              )(
                                (
                                  (was, now) => (
                                    was
                                      ? was.map(
                                        (x, i) => (
                                          x
                                            && now[i]
                                            && !same(x, now[i])
                                            && ((c) => (c ? !c.signsIn : false))(
                                              writes.find((c) => c.step === i + 1)
                                            ) !== (x.write === true)
                                            ? i + 1
                                            : 0
                                        )
                                      ).filter((i) => i)
                                      : []
                                  )
                                )(approvedOf(l), (Array.isArray(l.steps?.steps) ? l.steps.steps : []))
                              )
                          )
                          + (writes.length ? 'Ticked steps are' : 'The steps you list here are')
                          + ' allowed to save or send. '
                          + (
                            writes.length
                              ? 'Allow this app… in the recorder protects the ticked buttons it recorded that have an id of their own, not the standard buttons of Windows dialogs (such as Save in a Save As dialog, OK or Yes), so leave such a step ticked: an unticked step is stopped when it presses a protected button, or a key other than Tab, arrows, Home, End, PageUp, PageDown or Escape in a window that holds one. While the policy of the app protects no button, nothing is stopped.'
                              : 'Any other step is stopped when it uses a button or key your administrator protected on the bot machine. While none is protected, nothing is stopped.'
                          )
                          + '</em></p>'
                      },
                      Object.assign(
                        {
                          fieldLabel: who
                            + (
                              writes.length
                                ? 'Any other step that saves, sends or submits (its number, optional)'
                                : 'Steps that save, send or submit (their numbers, optional)'
                            ),
                          fieldName: 'moreWrites_' + k,
                          fieldType: 'text',
                          placeholder: '7, 9'
                        },
                        (
                          (was, now) => ((n) => (n ? { defaultValue: n } : {}))(
                            was
                              ? was.map(
                                (s, i) => (
                                  s
                                    && s.write === true
                                    && !writes.some((c) => c.step === i + 1)
                                    && now[i]
                                    && same(s, now[i])
                                    ? i + 1
                                    : 0
                                )
                              ).filter((x) => x).join(', ')
                              : ''
                          )
                        )(approvedOf(l), (Array.isArray(l.steps?.steps) ? l.steps.steps : []))
                      )
                    ]
                    : [],
                  (
                    fit
                      ? [{
                        fieldType: 'html',
                        html: '<p><strong>' + fit + ' The warning at the top says what to do.</strong></p>'
                      }]
                      : []
                  ).concat([
                    {
                      fieldLabel: who + 'Decision',
                      fieldName: 'decision_' + k,
                      fieldType: 'radio',
                      fieldOptions: { values: [{ option: 'Approve and sign' }, { option: 'Reject' }] },
                      requiredField: true
                    }
                  ])
                )
              )(
                l.steps?.surface === 'desktop',
                l.steps?.surface === 'desktop' ? l.writeCandidates ?? [] : [],
                lists.length > 1 ? String(l.name ?? '') + ': ' : ''
              )
            )
        )(
          $('Import steps').all(1).map((i) => i.json),
          ESCAPE_HTML,
          (l, e) => (
            (desktop, notRun, steps, flags) => '<p>'
              + [
                desktop
                  ? 'Opens ' + String(l.steps.app?.exe ?? '') + ' on the desktop runner.'
                  : (
                    flags.filter((f) => f.startsWith('host: ')).length
                      ? 'Opens '
                        + flags.filter((f) => f.startsWith('host: ')).map((f) => f.slice(6)).join(', ')
                        + '.'
                      : ''
                  )
              ].concat(
                steps.some((s) => s.signIn) ? ['Signs in with the RPA Site Login.'] : [],
                flags.filter((f) => f.startsWith('form submission: ')).map(
                  (f) => 'Submits a form: ' + f.slice(17) + '.'
                ),
                steps.map((s, i) => (s.expectFile || s.download ? i + 1 : 0)).filter((i) => i).map(
                  (i) => 'Returns a file to n8n: step ' + i + '.'
                ),
                flags.filter(
                  (f) =>
                    !/^(host|form submission|desktop app|file returned to n8n|candidate write|write): /.test(f)
                    && f !== 'download step'
                ).map(
                  (f) => (
                    (f) => ((w) => (w ? f.replace(w[0], w[1]) : f.charAt(0).toUpperCase() + f.slice(1) + '.'))(
                      [
                        [
                          /^count unverified: [\s\S]*$/,
                          'The page states no total, so the number of rows read is not checked against one.'
                        ],
                        [
                          /^extract-fields-dropped$/,
                          'Reads fewer fields than the version before: check that each row still has what you need.'
                        ],
                        [
                          /^interrupt: when ([\s\S]*) shows, click ([\s\S]*)$/,
                          'Closes a pop-up: when $1 shows, it clicks $2.'
                        ],
                        [
                          /^secret fill: a step types the run variable ([\s\S]*)$/,
                          'Types a secret: the run variable $1.'
                        ],
                        [
                          /^password change: a step sets a new password from the run variable ([\s\S]*)$/,
                          'Sets a new password from the run variable $1 when the site asks for one.'
                        ],
                        [
                          /^clipboard read: (step \d+) \(([\s\S]*?)\) returns the clipboard's text to n8n as ([\s\S]*?) \(the desktop runner[\s\S]*$/,
                          'Gives the clipboard\'s text to n8n: $1 ($2), as $3. The desktop runner allows this only when its policy allows clipboard reads.'
                        ]
                      ].find((p) => p[0].test(f))
                    )
                  )(f)
                ),
                [
                  desktop
                    ? 'Not tried by the import: read every step before you approve.'
                    : notRun
                    ? 'Not run by the import: check every step, each form\'s target and each download before you approve.'
                    : String(l.evidenceLine ?? '').split('; ')[0].replace(' (the page states no total)', '')
                      + '.'
                ]
              ).filter((x) => x).map(e).join('<br>')
              + '</p>'
              + (
                String(l.leftOutList ?? '')
                  ? '<p><b>⚠ Left out by the import:</b><br>'
                    + e(l.leftOutList).split('\n').join('<br>')
                    + '</p>'
                  : ''
              )
              + '<p><b>The steps</b></p>'
              + (
                (a) => (
                  a.length
                    ? '<p><em>'
                      + (steps.length - a.length)
                      + (steps.length - a.length === 1 ? ' recorded step' : ' recorded steps')
                      + ', plus '
                      + a.length
                      + ' the import added (waits for each window'
                      + (a.some((r) => r.marks.includes('returns a file')) ? ', the returned file' : '')
                      + ')</em></p>'
                    : ''
                )
              )((l.reviewSteps ?? []).filter((r) => r.added))
              + '<ol>'
              + (l.reviewSteps ?? []).map(
                (r) => '<li>'
                  + ((t) => (r.added ? '<i>' + t + '</i>' : t))(
                    e(r.text)
                      + (
                        typeof r.describedAs === 'string'
                          ? (
                            r.quiet === true
                              ? ' <em>(the author calls it: ' + e(r.describedAs) + ')</em>'
                              : ' <strong>(described differently as: ' + e(r.describedAs) + ')</strong>'
                          )
                          : ''
                      )
                      + (r.marks.length ? ' <em>· ' + e(r.marks.join('; ')) + '</em>' : '')
                  )
                  + (
                    Array.isArray(r.each) && r.each.length
                      ? '<ul>'
                        + r.each.map(
                          (x) => '<li>On each page: '
                            + e(x.text)
                            + (
                              typeof x.describedAs === 'string'
                                ? (
                                  x.quiet === true
                                    ? ' <em>(the author calls it: ' + e(x.describedAs) + ')</em>'
                                    : ' <strong>(described differently as: ' + e(x.describedAs) + ')</strong>'
                                )
                                : ''
                            )
                            + (x.marks.length ? ' <em>· ' + e(x.marks.join('; ')) + '</em>' : '')
                            + '</li>'
                        ).join('')
                        + '</ul>'
                      : ''
                  )
                  + '</li>'
              ).join('')
              + '</ol>'
          )(
            l.steps?.surface === 'desktop',
            String(l.evidenceLine ?? '').startsWith('Not replayed:'),
            Array.isArray(l.steps?.steps) ? l.steps.steps : [],
            (l.safetyFlags ?? []).map(String)
          ),
          (l, n, e) => (
            (desktop, notRun) => (n > 1 ? '<p><b>' + e(l.name) + '</b></p>' : '')
              + '<p><em><b>Safety flags:</b> '
              + e(l.safetyLine)
              + '</em></p>'
              + (
                String(l.leftOutList ?? '')
                  ? '<p><em><b>Left out by the import (the source does these, the steps do not):</b><br>'
                    + e(l.leftOutList).split('\n').join('<br>')
                    + '</em></p>'
                  : ''
              )
              + '<p><em><b>Evidence'
              + (notRun ? '' : ' (as reported by the run)')
              + ':</b> '
              + e(l.evidenceLine)
              + '</em></p>'
              + '<p><em><b>'
              + (
                desktop
                  ? 'The steps'
                  : notRun
                  ? 'What changed (as written; these steps were never run)'
                  : 'What changed (as reported by the run)'
              )
              + ':</b><br>'
              + e(l.changeList).split('\n').join('<br>')
              + '</em></p>'
              + (
                String(l.attachmentNames ?? '')
                  ? '<p><em>Screenshots of the replay are in this execution in n8n, on the Repaired Steps output of Import steps.</em></p>'
                  : ''
              )
          )(
            l.steps?.surface === 'desktop',
            l.steps?.surface === 'desktop' || String(l.evidenceLine ?? '').startsWith('Not replayed:')
          ),
          (c) => 'Step '
            + c.step
            + ': '
            + String(c.intent).split(',').join(';').split('<').join('‹').split('>').join('›'),
          $('Settings').first().json.showDetails === true,
          (l) => (
            (r) => {
              if (!r) return null;
              try {
                const d = JSON.parse(String(r.steps));
                return Array.isArray(d) ? d : d && Array.isArray(d.steps) ? d.steps : null;
              } catch (x) { return null; }
            }
          )(
            (
              (r, k) => r !== null
                && Boolean(k.approvedVersion)
                && k.approvedVersion.signatureFits === true
                && String(k.approvedVersion.version) === String(r.version)
            )((APPROVED_OF_LIST), SIGN_STEPS_JSON)
              ? (APPROVED_OF_LIST)
              : null
          ),
          (l) => (
            (APPROVED_OF_LIST) === null
              ? ''
              : (
                (r, k) => r !== null
                  && Boolean(k.approvedVersion)
                  && k.approvedVersion.signatureFits === true
                  && String(k.approvedVersion.version) === String(r.version)
              )((APPROVED_OF_LIST), SIGN_STEPS_JSON)
              ? 'The ticks start as the approved version had them. '
              : 'The ticks start from the rule: the marks of the stored version are not shown, because its signature '
                + (
                  (SIGN_STEPS_JSON).approvedVersion?.signatureFits === false
                    ? 'does not fit this form'
                    : 'could not be checked'
                )
                + '. '
          ),
          (a, b) => ((k) => k(a) === k(b))(
            (v) => {
              const c = (x) => (
                Array.isArray(x)
                  ? '[' + x.map(c).join(',') + ']'
                  : x !== null && typeof x === 'object'
                  ? '{'
                    + Object.keys(x).filter((y) => y !== 'write').sort().map(
                      (y) => JSON.stringify(y) + ':' + c(x[y])
                    ).join(',')
                    + '}'
                  : JSON.stringify(x === undefined ? null : x)
              );
              return c(v);
            }
          )
        )
      )
    )(
      (
        (k, e) => (
          k.approvedVersion && k.approvedVersion.signatureFits === false
            ? '⚠ Version '
              + e(k.approvedVersion.version)
              + ' does not fit this form: it was signed '
              + (
                k.approvedVersion.desktop
                  ? ''
                  : (
                    k.siteLogin
                      ? 'for another Site Login than "' + e(k.siteLogin) + '"'
                      : 'for a Site Login, which this form does not have'
                  )
                    + ', or '
              )
              + 'with another signing key, or its row was changed after it was approved.'
            : ''
        )
      )(SIGN_STEPS_JSON, ESCAPE_HTML_CH),
      (
        (k, name) =>
          (line) => (
            (n) => (
              k.approvedVersion
                && k.approvedVersion.signatureFits === false
                && name !== ''
                && String(line).startsWith(name + ': ')
                ? String(line).split(name + ': unchanged from the approved version ' + n + '.').join(
                  name
                    + ': these are the steps of the stored version '
                    + n
                    + ', whose signature does not fit this form (the warning says what that can mean).'
                ).split('the approved version ' + n + ':').join(
                  'the stored version ' + n + ', whose signature does not fit this form:'
                ).split('the approved version').join('the stored version')
                : String(line)
            )
          )(String(k.approvedVersion ? k.approvedVersion.version : ''))
      )(
        SIGN_STEPS_JSON,
        $('The approved version').isExecuted ? String($('The approved version').first().json.name ?? '') : ''
      )
    )
  // "$" goes out as \u0024: n8n puts this text in with String.replace, where "$&" or "$$" would change it.
  ).split('$').join('\\u0024')
}}
