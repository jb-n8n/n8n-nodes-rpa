// Template: 5-import-a-bot.json
// Node: The bot to change
// Parameter: jsonOutput
//
// The newest active row named exactly as typed, how many active rows have that name, the next version number, the
// names of every approved bot, and the values its steps type, choose or open and the names of the controls its browser
// steps use (values), each with the reason when the values page cannot offer it as a field.

={{
  (
    (name, all, offer) => (
      (rows) => (
        (mine) => ({
          name,
          found: mine.length > 0,
          active: mine.length,
          version: mine.length ? mine[0].version : null,
          steps: mine.length ? mine[0].steps : '',
          signature: mine.length ? String(mine[0].signature ?? '') : '',
          approvedBy: mine.length ? String(mine[0].approvedBy ?? '') : '',
          names: [...new Set(rows.map((r) => r.name))].sort(),
          next: Math.max(
            0,
            ...all.filter((r) => r.name === name).map((r) => Number(r.version)).filter(
              (v) => Number.isInteger(v)
            )
          )
            + 1,
          values: mine.length ? offer(mine[0].steps) : []
        })
      )(rows.filter((r) => r.name === name).sort((a, b) => Number(b.version) - Number(a.version)))
    )(all.filter((r) => r.status === 'active' && typeof r.steps === 'string' && r.steps !== ''))
  )(
    String($('Settings').first().json.name ?? '').trim(),
    $('Approved bots').all().map((i) => i.json).filter((r) => typeof r.name === 'string'),
    (steps) => {
      // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
      const doc = ((s) => { try { return JSON.parse(String(s)); } catch (x) { return null; } })(steps);
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.steps)) return [];
      const desktop = doc.surface === 'desktop';
      const obj = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : { });
      const short = (v) => ((a) => (a.length > 80 ? a.slice(0, 79).join('') + '…' : a.join('')))(
        Array.from(
          String(v).replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().split('<').join('‹').split('>').join('›')
        )
      );
      const own = (p) => ((c) => String(c.name ?? c.automationId ?? '').trim())(obj(p[p.length - 1]));
      const target = (l) => (
        (o) => (
          desktop
            ? ((p) => (p.length && own(p) ? own(p) : 'a field without a name'))(
              Array.isArray(obj(o.uia).path) ? obj(o.uia).path : []
            )
            : typeof o.role === 'string'
            ? (typeof o.name === 'string' && o.name.trim() ? o.name : 'the ' + o.role)
            : typeof o.label === 'string'
            ? o.label
            : typeof o.text === 'string'
            ? o.text
            : typeof o.testId === 'string'
            ? o.testId
            : typeof o.css === 'string'
            ? 'the element matching ' + o.css
            : 'an element'
        )
      )(obj(l));
      // The control a browser step uses, by the step's own key and, for a field, the key inside it, with the words of the
      // comparison for what names it (a role's name, a field's label, a visible text). Only a plain name is offered: a
      // selector, a test id, a role without a name or a control found by its position is changed as JSON.
      const control = (s, n) => (
        (at) => at === null ? [] : (
          (l) => (
            (named) => [
              named
                ? ((v, why) => ({
                  step: n,
                  name: 'name_' + n,
                  at: at[0],
                  inner: at[1],
                  key: named[0],
                  label: n + '. ' + at[2] + ': ' + named[1],
                  value: v,
                  offered: why === '',
                  why
                }))(
                  String(l[named[0]]),
                  // '{' + '{' is two braces written apart: side by side they would start an expression.
                  String(l[named[0]]).includes('{' + '{')
                    ? 'not a fixed name: it is filled in when the bot runs'
                    : /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]|^\s|\s$/.test(String(l[named[0]]))
                    ? 'a field cannot hold it as it is'
                    : ''
                )
                : {
                  step: n,
                  name: 'name_' + n,
                  at: at[0],
                  inner: at[1],
                  key: '',
                  label: n + '. ' + at[2] + ': control',
                  value: String(
                    [l.css, l.testId, l.name, l.label, l.text, l.role].find((x) => typeof x === 'string' && x !== '') ?? ''
                  ),
                  offered: false,
                  why: (
                    typeof l.css === 'string'
                      ? 'found by a selector, not by a name'
                      : typeof l.testId === 'string'
                      ? 'found by a test id, not by a name'
                      : typeof l.role === 'string' && (typeof l.name !== 'string' || l.name.trim() === '')
                      ? 'found by its role alone, not by a name'
                      : 'found by its position, not by a name alone'
                  )
                    + ', so it is changed with Change the steps as JSON'
                }
            ].filter((x) => x.value !== '')
          )(
            /nth|first-|last-|\[\s*\d|position\(|last\(\)/i.test(JSON.stringify([l.within ?? null, l.frame ?? null]))
              ? null
              : typeof l.role === 'string' && typeof l.name === 'string' && l.name.trim() !== ''
              ? ['name', 'control name']
              : typeof l.label === 'string'
              ? ['label', 'field label']
              : typeof l.text === 'string'
              ? ['text', 'visible text']
              : null
          )
        )(obj(at[1] === '' ? s[at[0]] : obj(s[at[0]])[at[1]]))
      )(
        desktop
          ? null
          : s.click !== undefined
          ? ['click', '', 'Click']
          : s.hover !== undefined
          ? ['hover', '', 'Hover over']
          : s.fill !== undefined
          ? ['fill', 'field', 'Type into']
          : s.select !== undefined
          ? ['select', 'field', 'Choose in']
          : s.check !== undefined
          ? ['check', 'field', 'Check']
          : s.clickAll !== undefined
          ? ['clickAll', 'target', 'Click every']
          : s.press !== undefined && obj(s.press).target !== undefined
          ? ['press', 'target', 'Press a key in']
          : s.popup !== undefined
          ? ['popup', 'trigger', 'Open in a new tab']
          : s.submit !== undefined
          ? ['submit', 'button', 'Submit with']
          : s.download !== undefined
          ? ['download', 'trigger', 'Download with']
          : s.waitFor !== undefined && obj(s.waitFor).target !== undefined
          ? ['waitFor', 'target', 'Wait for']
          : s.paginate !== undefined
          ? ['paginate', 'next', 'Page through with']
          : null
      );
      return doc.steps.flatMap(
        (raw, i) => {
          const s = obj(raw);
          const n = i + 1;
          const names = control(s, n);
          const at = !desktop && typeof s.goto === 'string'
            ? ['goto', 'goto', 'Open', 'address']
            : s.fill !== undefined
            ? ['fill', 'value', 'Type into ' + short(target(obj(s.fill).field)), 'typed value']
            : s.select !== undefined
            ? [
              'select',
              desktop ? 'option' : 'value',
              'Choose in ' + short(target(obj(s.select).field)),
              'chosen option'
            ]
            : null;
          if (at === null) return names;
          const v = at[0] === 'goto' ? s.goto : obj(s[at[0]])[at[1]];
          const several = Array.isArray(v);
          if (!several && typeof v !== 'string') return names;
          const value = several ? v.map(String).join(', ') : v;
          const why = several
            ? 'several options'
            // '{' + '{' is two braces written apart: side by side they would start an expression.
            : value.includes('{' + '{')
            ? (
              /\{\{\s*var\.[A-Za-z0-9_]+\s*\}\}/.test(value)
                ? 'a run variable, so it is not changed here: change it on the bot\'s workflow, in the RPA node\'s Options → Variables (a secret one in the RPA Secret Variables credential that node uses)'
                : 'not a fixed value: it is filled in when the bot runs'
            )
            : /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]|^\s|\s$/.test(value)
            ? 'a field cannot hold it as it is'
            : '';
          return names.concat([{
            step: n,
            name: 'value_' + n,
            at: at[0],
            key: at[1],
            label: n + '. ' + at[2] + (at[2].endsWith(':') ? ' ' : ': ') + at[3],
            value,
            offered: why === '',
            why
          }]);
        }
      );
    }
  )
}}
