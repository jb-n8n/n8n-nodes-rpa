// Template: 5-import-a-bot.json
// Node: Values to steps
// Parameter: jsonOutput
//
// The approved steps with the values changed on the values page put in, each where The bot to change found it; a
// step's intent gets the new value where it quotes the old one as a whole word. A value that holds two opening braces
// is refused. No value changed: no steps.

={{
  (
    (bot, answer) => {
      if (String(answer.valuesPage ?? '') !== 'answered') return {
        answered: false, refused: '', changed: [], steps: ''
      };
      // "{ }" and "} }" keep their space: two closing braces side by side would end the expression here.
      const doc = ((s) => { try { return JSON.parse(String(s)); } catch (x) { return null; } })(bot.steps);
      const list = doc !== null && typeof doc === 'object' && Array.isArray(doc.steps) ? doc.steps : [];
      const word = /[A-Za-z0-9]/;
      const swap = (text, old, neu) => {
        let out = '';
        let i = 0;
        for (;;) {
          const at = text.indexOf(old, i);
          if (at < 0) return out + text.slice(i);
          const before = at > 0 ? text[at - 1] : '';
          const after = text[at + old.length] ?? '';
          const whole = !(word.test(before) && word.test(old[0]))
            && !(word.test(after) && word.test(old[old.length - 1]));
          out += text.slice(i, at) + (whole ? neu : old);
          i = at + old.length;
        }
      };
      const changed = [];
      const refused = [];
      for (const v of (Array.isArray(bot.values) ? bot.values : [])) {
        if (v.offered !== true) continue;
        const typed = answer[String(v.name)];
        if (typeof typed !== 'string' || typed === v.value) continue;
        // '{' + '{' is two braces written apart: side by side they would start an expression.
        if (typed.includes('{' + '{')) { refused.push(v.step); continue; }
        const s = list[v.step - 1];
        const holder = s !== null && typeof s === 'object' ? (v.at === 'goto' ? s : s[v.at]) : null;
        if (holder === null || typeof holder !== 'object' || holder[v.key] !== v.value) continue;
        holder[v.key] = typed;
        if (typeof s.intent === 'string' && v.value !== '') s.intent = swap(s.intent, v.value, typed);
        changed.push(v.step);
      }
      if (refused.length) return {
        answered: true,
        refused: (
          refused.length === 1
            ? 'The new value of step ' + refused[0] + ' holds'
            : 'The new values of steps '
              + refused.slice(0, -1).join(', ')
              + ' and '
              + refused[refused.length - 1]
              + ' hold'
        )
          + ' "{'
          + '{", which steps read as the start of a variable: a value on this page is text only. Type it without "{'
          + '{", or choose Change the steps as JSON to use a variable.',
        changed: [],
        steps: ''
      };
      return { answered: true, refused: '', changed, steps: changed.length ? JSON.stringify(doc) : '' };
    }
  )($('The bot to change').first().json, $('Change values').first().json)
}}
