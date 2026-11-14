// Template: 5-import-a-bot.json
// Node: The bot to change
// Parameter: jsonOutput
//
// The newest active row named exactly as typed, how many active rows have that name, the next version number, the
// names of every approved bot, and the values its steps type, choose or open (values), each with the reason when the
// values page cannot offer it as a field.

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
      return doc.steps.flatMap(
        (raw, i) => {
          const s = obj(raw);
          const n = i + 1;
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
          if (at === null) return [];
          const v = at[0] === 'goto' ? s.goto : obj(s[at[0]])[at[1]];
          const several = Array.isArray(v);
          if (!several && typeof v !== 'string') return [];
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
          return [{
            step: n,
            name: 'value_' + n,
            at: at[0],
            key: at[1],
            label: n + '. ' + at[2] + (at[2].endsWith(':') ? ' ' : ': ') + at[3],
            value,
            offered: why === '',
            why
          }];
        }
      );
    }
  )
}}
