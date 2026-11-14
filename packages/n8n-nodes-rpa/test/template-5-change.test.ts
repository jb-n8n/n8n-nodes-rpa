// Template 5, the change path: the approved version compared with the changed or running one, the values page, signing again.
import { describe, expect, it } from 'vitest';
import { reviewSteps } from '../nodes/Playwright/format.js';
import { signScript } from 'n8n-rpa-engine';
import { APPROVER } from './fixtures.js';
import { type IDataObject, type INodeExecutionData } from 'n8n-workflow';
import { checkDesktopTrust } from 'n8n-rpa-engine';
import { executeSignSteps } from '../nodes/Playwright/operations/signSteps.js';
import { STEPS_TABLE } from '../nodes/Playwright/rows.js';
import { siteLoginData } from './feed-fixtures.js';
import { harness } from './harness.js';
import { template5 as t, CHROME, COLOUR, COMPARED, COMPLETION, DATA_TABLE, NOT_ADOPTABLE, REVIEW, SITE, type TemplateNode, byName, changePath, changedUpload, changedUploadOf, compared, completion, escapeHtml, evaluate, expectChecklist, form, formItem, imp, importEngine, importedRecording, jsonFormFields, load, nodesRan, render, resolved, review, reviewFields, reviewHead, runImport, settingsJson, signAfterReview, signedIn, sticky, table, targets } from './template-harness.js';

describe('5-import-a-bot.json (the first-day import)', () => {
  const SIGN_AGAIN = 'Sign the approved steps again, unchanged';
  const CHANGE = 'Change the steps as JSON';
  const VALUES = 'Change values';
  /**
   * Sign steps' first run, before the review page: The approved version (from `ran`), then Sign steps with the parameters
   * it reads then resolved as n8n resolves them (Check Only on: the review page has not run; the parameters that read the
   * review page are never read), the key `key` and the Site Login `siteLogin` (none when not given). Returns `ran` with both.
   */
  async function checkBeforeReview(ran_: Record<string, INodeExecutionData[][]>, key: string, siteLogin?: { id: string; name: string }) {
    // Compared with the running version runs first on every path to the review page (its line only for an upload).
    const ran = { ...ran_, [RUNNING]: [[{ json: evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan(ran_) }) as IDataObject }]] };
    const $ = nodesRan(ran);
    const item = evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $ }) as IDataObject;
    const sign = byName(t, 'Sign steps').parameters;
    const params = Object.fromEntries(Object.entries(sign).flatMap(([k, v]) => {
      if (typeof v !== 'string' || !v.startsWith('=')) return [[k, v]];
      try {
        return [[k, evaluate(v, { $, $itemIndex: 0 })]];
      } catch {
        return [];
      }
    }));
    expect(params.checkOnly).toBe(true);
    const out = await executeSignSteps(harness({
      params, rawParameters: sign, items: [{ json: item }], continueOnFail: true,
      credentials: { playwrightScriptSigningApi: { secretKey: key }, ...(siteLogin ? { playwrightSiteLoginApi: siteLoginData(SITE) } : {}) },
      ...(siteLogin ? { credentialIds: { playwrightSiteLoginApi: siteLogin.id }, credentialNames: { playwrightSiteLoginApi: siteLogin.name } } : {}),
    }), importEngine(() => NOT_ADOPTABLE));
    expect(out[0]).toHaveLength(1);
    expect(out[0][0].json.checkOnly).toBe(true);
    return { ...ran, 'The approved version': [[{ json: item }]], 'Sign steps': [out[0], []] } as Record<string, INodeExecutionData[][]>;
  }
  const RUNNING = 'Compared with the running version';
  /** The line Compared with the approved version gives the review page for the box submitted as `text`. */
  const compare = (ran: Record<string, INodeExecutionData[][]>, text: string | null): string => compared(ran, text).compared;

  it('Compared with the approved version: unchanged, each changed step (at most three) with its values old → new, added and missing steps, the other signed fields, or no comparison', () => {
    const doc = {
      startUrl: `${SITE.url}/a`, name: 'feed', version: 1,
      steps: Array.from({ length: 25 }, (_, i) => ({ intent: `Open page ${i + 1}`, goto: `/p${i + 1}` })) as IDataObject[],
    };
    const { ran, bot } = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(doc), status: 'active' }]);
    const box = String(bot.steps);
    const edit = (f: (d: typeof doc & IDataObject) => void) => {
      const d = JSON.parse(box) as typeof doc & IDataObject;
      f(d);
      return JSON.stringify(d, null, 2);
    };
    expect(compare(ran, box)).toBe('feed: unchanged from the approved version 4.');
    // Spacing, key order and the box's own name and version do not count: the import sets those.
    expect(compare(ran, JSON.stringify({ steps: doc.steps, version: 9, name: 'x', startUrl: doc.startUrl }))).toBe('feed: unchanged from the approved version 4.');
    expect(compare(ran, edit((d) => { d.steps[2] = { goto: '/p3', intent: 'Open page 3' }; }))).toBe('feed: unchanged from the approved version 4.');
    // What changed, not only where: the step's number and its changed values, old → new.
    expect(compare(ran, edit((d) => { d.steps[6].goto = '/other'; }))).toBe('feed: changed from the approved version 4: step 7: address "/p7" → "/other".');
    expect(compare(ran, edit((d) => { d.steps[1].intent = 'x'; d.steps[9].goto = '/y'; }))).toBe('feed: changed from the approved version 4: step 2: description "Open page 2" → "x"; step 10: address "/p10" → "/y".');
    // A field added or taken away shows (none) on its other side; two fields of one step are listed together.
    expect(compare(ran, edit((d) => { (d.steps[0] as IDataObject).waitFor = 3; d.steps[0].goto = '/a'; }))).toBe('feed: changed from the approved version 4: step 1: address "/p1" → "/a", waitFor (none) → 3.');
    // More than three fields of one step: "several fields". More than three steps: three, then the others by number.
    expect(compare(ran, edit((d) => { d.steps[3] = { intent: 'a', goto: '/b', fill: { selector: '#c', value: 'd' } } as typeof d.steps[0]; })))
      .toBe('feed: changed from the approved version 4: step 4: several fields.');
    expect(compare(ran, edit((d) => { for (const i of [2, 4, 6, 8, 10]) d.steps[i].goto = `/n${i}`; })))
      .toBe('feed: changed from the approved version 4: step 3: address "/p3" → "/n2"; step 5: address "/p5" → "/n4"; step 7: address "/p7" → "/n6"; and more changed: steps 9, 11.');
    // The two lists are lined up first (IW-7): a step taken out or put in moves no later step. Removed steps by their old
    // number and description, added ones by their new number, changed ones old → new, a step moved as such.
    expect(compare(ran, edit((d) => { d.steps.push({ intent: 'Open more', goto: '/more' }); }))).toBe('feed: changed from the approved version 4: added: step 26. 26 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(22, 1); })))
      .toBe('feed: changed from the approved version 4: removed: step 23 ("Open page 23"). 24 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(0, 1); })))
      .toBe('feed: changed from the approved version 4: removed: step 1 ("Open page 1"). 24 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(16, 2); })))
      .toBe('feed: changed from the approved version 4: removed: step 17 ("Open page 17"), step 18 ("Open page 18"). 23 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(9, 0, { intent: 'Open more', goto: '/more' }, { intent: 'Open less', goto: '/less' }); })))
      .toBe('feed: changed from the approved version 4: added: steps 10, 11. 27 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(7, 0, ...d.steps.splice(2, 1)); })))
      .toBe('feed: changed from the approved version 4: moved: step 3 ("Open page 3") is now step 8.');
    // B6-3: a step taken out, two swapped and one added. The step lined up as moved keeps its number (5 is now 5), so
    // that move is not printed: the step it crossed is named instead, by its old number, its words and its new number.
    expect(compare(ran, edit((d) => { const [to] = d.steps.splice(5, 1); d.steps.splice(3, 1, to); d.steps.splice(5, 0, { intent: 'Wait for the list', goto: '/wait' }); })))
      .toBe('feed: changed from the approved version 4: removed: step 4 ("Open page 4"); added: step 6; moved: step 6 ("Open page 6") is now step 4.');
    // W6-6: a step moved forward past others, and the last step replaced: the move is named, not read as a change.
    expect(compare(ran, edit((d) => { d.steps.splice(10, 0, ...d.steps.splice(14, 1)); d.steps.splice(24, 1, { intent: 'Read the count', goto: '/count' }); })))
      .toBe('feed: changed from the approved version 4: moved: step 15 ("Open page 15") is now step 11; step 25: description "Open page 25" → "Read the count", address "/p25" → "/count".');
    // A step that moved and changed is a changed step, named with its new number and its values old → new.
    expect(compare(ran, edit((d) => { d.steps.splice(10, 0, { ...d.steps.splice(14, 1)[0], goto: '/p15b' }); })))
      .toBe('feed: changed from the approved version 4: step 15 (now step 11): address "/p15" → "/p15b".');
    // Five moves, the fourth and fifth also changed: only steps that moved unchanged are in the moved part (the one list
    // that may end in "and N more"); a changed step is always in the changed part with its values, never in a count.
    const moving = [1, 3, 5, 7, 9];
    const fiveMoves = (change: boolean) => edit((d) => {
      const taken = moving.map((i) => d.steps[i]).map((x, k) => (change && k >= 3 ? { ...x, goto: `/x${moving[k] + 1}` } : x));
      d.steps = d.steps.filter((_, i) => !moving.includes(i)).concat(taken);
    });
    expect(compare(ran, fiveMoves(true)))
      .toBe('feed: changed from the approved version 4: moved: step 2 ("Open page 2") is now step 21, step 4 ("Open page 4") is now step 22, step 6 ("Open page 6") is now step 23; step 8 (now step 24): address "/p8" → "/x8"; step 10 (now step 25): address "/p10" → "/x10".');
    expect(compare(ran, fiveMoves(false)))
      .toBe('feed: changed from the approved version 4: moved: step 2 ("Open page 2") is now step 21, step 4 ("Open page 4") is now step 22, step 6 ("Open page 6") is now step 23, and 2 more.');
    // A description that repeats never makes a move: the steps read as changed in place and removed.
    const twice = { ...doc, steps: doc.steps.map((s, i) => (i === 2 || i === 12 ? { ...s, intent: 'Click OK' } : s)) };
    const twiceRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(twice), status: 'active' }]).ran;
    expect(compare(twiceRan, JSON.stringify({ ...twice, steps: twice.steps.map((s, i) => (i === 2 ? { ...s, goto: '/ok' } : s)).filter((_, i) => i !== 12) })))
      .toBe('feed: changed from the approved version 4: removed: step 13 ("Click OK"); step 3: address "/p3" → "/ok". 24 steps now, 25 in the approved version.');
    // Changed and removed together: the changed step keeps its number, and a later one is named by both numbers.
    expect(compare(ran, edit((d) => { d.steps[4].goto = '/x'; d.steps.splice(9, 1); d.steps[14].goto = '/y'; })))
      .toBe('feed: changed from the approved version 4: removed: step 10 ("Open page 10"); step 5: address "/p5" → "/x"; step 16 (now step 15): address "/p16" → "/y". 24 steps now, 25 in the approved version.');
    expect(compare(ran, edit((d) => { d.steps.splice(3, 1); d.steps.splice(10, 0, { intent: 'Open more', goto: '/more' }); d.steps[20].intent = 'z'; })))
      .toBe('feed: changed from the approved version 4: removed: step 4 ("Open page 4"); added: step 11; step 21: description "Open page 21" → "z".');
    // Four removed: three with their words, the rest by number.
    expect(compare(ran, edit((d) => { d.steps.splice(5, 4); })))
      .toBe('feed: changed from the approved version 4: removed: step 6 ("Open page 6"), step 7 ("Open page 7"), step 8 ("Open page 8"), and step 9. 21 steps now, 25 in the approved version.');
    // A step without a description is named by its number alone; a removed step's description is shown as text, cut.
    const bare = { ...doc, steps: [{ goto: '/a' }, { intent: `<b>${'w'.repeat(80)}</b>`, goto: '/b' }, { goto: '/c' }] };
    const bareRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(bare), status: 'active' }]).ran;
    expect(compare(bareRan, JSON.stringify({ ...bare, steps: [bare.steps[2]] })))
      .toBe(`feed: changed from the approved version 4: removed: step 1, step 2 ("<b>${'w'.repeat(56)}…"). 1 steps now, 3 in the approved version.`);
    // Over the cap (the part that differs is more than 250,000 pairs of steps): compared in place, as before, and said so.
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ intent: `Open ${prefix} ${i + 1}`, goto: `/${prefix}${i + 1}` }));
    const big = { ...doc, steps: many('p', 501) };
    const bigRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(big), status: 'active' }]).ran;
    const capped = compare(bigRan, JSON.stringify({ ...big, steps: many('q', 501) }));
    expect(capped).toMatch(/^feed: changed from the approved version 4: step 1: description "Open p 1" → "Open q 1", address "\/p1" → "\/q1"; step 2: .*; and more: steps 4, 5, .*, 500, 501; compared step by step in place, because there are too many steps to line up: after a step added or taken out, every later step reads as changed\.$/);
    // Every number is listed, never cut to a count or an ellipsis.
    expect(capped).not.toContain('…');
    for (let k = 4; k <= 501; k++) expect(capped).toContain(` ${k}${k === 501 ? ';' : ','}`);
    // Each side is capped on its own too: 2,001 unmatched steps against one are compared in place, not lined up.
    const lopsided = { ...doc, steps: many('p', 2001) };
    const lopsidedRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(lopsided), status: 'active' }]).ran;
    expect(compare(lopsidedRan, JSON.stringify({ ...lopsided, steps: many('q', 1) }))).toContain('; compared step by step in place, because there are too many steps to line up');
    // Two documents of 5,000 steps each: in place, within 3 seconds.
    const fiveThousand = { ...doc, steps: many('p', 5000) };
    const fiveThousandRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(fiveThousand), status: 'active' }]).ran;
    const bigStarted = Date.now();
    expect(compare(fiveThousandRan, JSON.stringify({ ...fiveThousand, steps: many('q', 5000) }))).toMatch(/, 5000; compared step by step in place, because there are too many steps to line up: after a step added or taken out, every later step reads as changed\.$/);
    expect(Date.now() - bigStarted).toBeLessThan(3000);
    // Forty changed steps: three with their values, then every other number.
    const sixty = { ...doc, steps: many('p', 60) };
    const sixtyRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(sixty), status: 'active' }]).ran;
    const forty = compare(sixtyRan, JSON.stringify({ ...sixty, steps: sixty.steps.map((x, k) => (k < 40 ? { ...x, goto: `/c${k + 1}` } : x)) }));
    expect(forty).toBe(`feed: changed from the approved version 4: step 1: address "/p1" → "/c1"; step 2: address "/p2" → "/c2"; step 3: address "/p3" → "/c3"; and more changed: steps ${Array.from({ length: 37 }, (_, k) => k + 4).join(', ')}.`);
    // The same long bot with one step taken out: the steps around it are the same, so only the middle is lined up.
    expect(compare(bigRan, JSON.stringify({ ...big, steps: big.steps.filter((_, i) => i !== 250) })))
      .toBe('feed: changed from the approved version 4: removed: step 251 ("Open p 251"). 500 steps now, 501 in the approved version.');
    // A bot of 200 steps, every one changed, and one of 500 against 500: lined up, quickly.
    const started = Date.now();
    const twoHundred = { ...doc, steps: many('p', 200) };
    const twoRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(twoHundred), status: 'active' }]).ran;
    expect(compare(twoRan, JSON.stringify({ ...twoHundred, steps: many('q', 200) }))).toMatch(/^feed: changed from the approved version 4: step 1: .*; and more changed: steps 4, .*, 199, 200\.$/);
    const fiveHundred = { ...doc, steps: many('p', 500) };
    const fiveRan = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify(fiveHundred), status: 'active' }]).ran;
    expect(compare(fiveRan, JSON.stringify({ ...fiveHundred, steps: many('q', 500) }))).not.toContain('in place');
    expect(Date.now() - started).toBeLessThan(5000);
    // A value is shown on one line, cut at 60 characters; markup stays text (the page escapes the line, as everything
    // else); a secret variable is shown as written, by its name: no secret is in the steps.
    const long = `${'a'.repeat(70)}\nsecond line`;
    expect(compare(ran, edit((d) => { d.steps[4].intent = long; }))).toBe(`feed: changed from the approved version 4: step 5: description "Open page 5" → "${'a'.repeat(59)}…".`);
    expect(compare(ran, edit((d) => { d.steps[4].intent = 'two\nlines\there'; }))).toBe('feed: changed from the approved version 4: step 5: description "Open page 5" → "two lines here".');
    expect(compare(ran, edit((d) => { d.steps[4].goto = '<b>x</b> & "y"'; }))).toBe('feed: changed from the approved version 4: step 5: address "/p5" → "<b>x</b> & "y"".');
    expect(compare(ran, edit((d) => { (d.steps[4] as IDataObject).fill = { selector: '#pin', value: '{{var.pin}}' }; })))
      .toBe('feed: changed from the approved version 4: step 5: selector (none) → "#pin", typed value (none) → "{{var.pin}}".');
    // The other fields the box can change and the signature covers: the start site, the pop-up handlers, the app.
    expect(compare(ran, edit((d) => { d.startUrl = 'https://elsewhere.example.com/'; }))).toBe('feed: changed from the approved version 4: the start site.');
    expect(compare(ran, edit((d) => { d.interrupts = [{ when: { text: 'Session' }, click: 'OK' }]; d.steps[0].goto = '/z'; }))).toBe('feed: changed from the approved version 4: step 1: address "/p1" → "/z"; the pop-up handlers.');
    const desktop = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { uia: { path: [{ name: 'Save' }] } } }] };
    const d = changePath('erp', [{ id: 2, name: 'erp', version: 2, steps: JSON.stringify(desktop), status: 'active' }]);
    expect(compare(d.ran, JSON.stringify({ ...desktop, app: { exe: 'Other.exe' } }))).toBe('erp: changed from the approved version 2: the app.');
    expect(compare(d.ran, JSON.stringify({ ...desktop, surface: undefined, startUrl: 'https://x.example.com/' }))).toBe('erp: changed from the approved version 2: the start site, browser or desktop.');
    // No comparison: the stored steps do not parse, the box does not parse, or nothing was found.
    // It names the list and never says unchanged.
    expect(compare(changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: '{broken', status: 'active' }]).ran, '{"steps":[]}')).toBe('erp: could not be compared with the approved version 1: read every step.');
    expect(compare(ran, '{ not json')).toBe('feed: could not be compared with the approved version 4: read every step.');
    expect(compare(ran, '{"startUrl":"https://a.example.com"}')).toBe('feed: could not be compared with the approved version 4: read every step.');
    expect(compare(changePath('gone', []).ran, box)).toBe('gone: could not be compared with the approved version: read every step.');
  });

  it('the choice and the box must fit: sign again or change values with an empty box or the approved steps pasted unchanged, change as JSON with text; otherwise the page comes back with both kept (IB-15)', () => {
    const doc = { startUrl: `${SITE.url}/a`, name: 'feed', version: 4, steps: [{ intent: 'Open the report', goto: '/report' }] };
    const { ran } = changePath('feed <b>', [{ id: 1, name: 'feed <b>', version: 4, steps: JSON.stringify(doc), status: 'active' }]);
    const answered = (choice: string | null, changedSteps: string | null) => nodesRan({ ...ran, 'Change or sign again': [[{ json: { choice, changedSteps } }]] });
    const cond = (byName(t, 'Choice fits the box?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(byName(t, 'Choice fits the box?')).toMatchObject({ type: 'n8n-nodes-base.if', typeVersion: 2.2 });
    expect(cond).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    const fits = (choice: string | null, box: string | null) => evaluate(cond[0].leftValue, { $: answered(choice, box) });
    const pasted = JSON.stringify(doc);
    const other = JSON.stringify({ ...doc, steps: [{ intent: 'Open the report', goto: '/other' }] });
    expect(fits(SIGN_AGAIN, '')).toBe(true);
    expect(fits(SIGN_AGAIN, ' \r\n ')).toBe(true);
    expect(fits(SIGN_AGAIN, null)).toBe(true);
    // The approved steps pasted back unchanged (as the page shows them, indented, keys in any order) are sign again.
    expect(fits(SIGN_AGAIN, pasted)).toBe(true);
    expect(fits(SIGN_AGAIN, JSON.stringify({ steps: doc.steps, version: 4, name: 'feed', startUrl: doc.startUrl }, null, 2))).toBe(true);
    expect(fits(CHANGE, pasted)).toBe(true);
    // The wrong combinations, and no choice (a page left unanswered gives its input item on).
    expect(fits(SIGN_AGAIN, other)).toBe(false);
    expect(fits(SIGN_AGAIN, '{ not json')).toBe(false);
    expect(fits(CHANGE, '')).toBe(false);
    expect(fits(CHANGE, '  ')).toBe(false);
    expect(fits(null, '')).toBe(false);
    expect(fits(null, pasted)).toBe(false);
    // Change values: as sign again, the box empty or holding the approved steps unchanged; other steps in it do not fit.
    expect(fits(VALUES, '')).toBe(true);
    expect(fits(VALUES, null)).toBe(true);
    expect(fits(VALUES, pasted)).toBe(true);
    expect(fits(VALUES, other)).toBe(false);
    // A bot whose values no field can hold, or too many for one page: the page does not offer the choice, and an answer
    // that names it anyway (sent by hand) comes back to the page.
    const none = changePath('feed', [{ id: 1, name: 'feed', version: 4, steps: JSON.stringify({ ...doc, steps: [{ intent: 'Open', goto: '{{var.start}}' }] }), status: 'active' }]).ran;
    expect(evaluate(cond[0].leftValue, { $: nodesRan({ ...none, 'Change or sign again': [[{ json: { choice: VALUES, changedSteps: '' } }]] }) })).toBe(false);
    expect(evaluate(cond[0].leftValue, { $: nodesRan({ ...none, 'Change or sign again': [[{ json: { choice: SIGN_AGAIN, changedSteps: '' } }]] }) })).toBe(true);
    // The old name of the JSON choice is no choice.
    expect(fits('Change the steps', pasted)).toBe(false);
    // Sign again takes the row's own steps, whatever was pasted: byte for byte the table's.
    const signAgain = evaluate(String(byName(t, COMPARED).parameters.jsonOutput), { $: answered(SIGN_AGAIN, JSON.stringify(doc, null, 2)) }) as IDataObject;
    expect(signAgain).toEqual({ steps: JSON.stringify(doc), changed: false, unchanged: true, compared: 'feed <b>: unchanged from the approved version 4.' });
    // A choice that does not fit goes back to the change page; only a page not answered ends on Choose again.
    expect(targets(t, 'Choice fits the box?')).toEqual([['Change values?'], ['Page answered?']]);
    expect(targets(t, 'Change values?')).toEqual([['Change values'], [COMPARED]]);
    const valuesCond = (byName(t, 'Change values?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect([VALUES, SIGN_AGAIN, CHANGE, null].map((c) => evaluate(valuesCond, { $: answered(c, '') }))).toEqual([true, false, false, false]);
    expect(targets(t, 'Page answered?')).toEqual([['Change or sign again'], ['Choice and box differ']]);
    const answeredCond = (byName(t, 'Page answered?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect(evaluate(answeredCond, { $: answered(SIGN_AGAIN, other) })).toBe(true);
    expect(evaluate(answeredCond, { $: answered(null, null) })).toBe(false);
    // The change page again: what to correct in red at the top, the choice and the pasted steps kept.
    const again = (choice: string, box: string) => jsonFormFields(String(byName(t, 'Change or sign again').parameters.jsonOutput), {
      // The page shown again: Page answered? has run, and its item is the answer before (the page never reads itself:
      // n8n keeps a waiting form page's own run, so a self-reference would see it on its first showing too).
      $: (name: string) => (name === 'Import a bot' ? { params: form.parameters } : nodesRan({ ...ran, 'Page answered?': [[{ json: { choice, changedSteps: box } }]] })(name)),
    });
    const first = again(SIGN_AGAIN, other);
    expect(String(first[0].html)).toMatch(/^<p><strong>You chose to sign the approved steps again, unchanged, and pasted steps that differ from them\. To use the pasted steps, choose Change the steps as JSON\. To sign them again unchanged, empty the box\. Your choice and the pasted steps are kept below\.<\/strong><\/p><p>These are the steps/);
    expect(first.slice(1).map((f) => [f.fieldName, f.defaultValue])).toEqual([['choice', SIGN_AGAIN], ['changedSteps', other]]);
    expect(String(again(CHANGE, '')[0].html)).toMatch(/^<p><strong>You chose to change the steps as JSON, but the box was empty\. Paste the changed steps in the box, or choose one of the other two\.<\/strong><\/p>/);
    const values = again(VALUES, other);
    expect(String(values[0].html)).toMatch(/^<p><strong>You chose to change values, and pasted steps that differ from the approved ones\. To use the pasted steps, choose Change the steps as JSON\. To change values, empty the box\. Your choice and the pasted steps are kept below\.<\/strong><\/p>/);
    expect(values.slice(1).map((f) => [f.fieldName, f.defaultValue])).toEqual([['choice', VALUES], ['changedSteps', other]]);
    expect(String(again(VALUES, '')[0].html)).toMatch(/^<p><strong>Change values is not offered for this bot \(the page says why\): choose one of the other two\.<\/strong><\/p>/);
    // Pasted text with markup and "$" comes back as typed (n8n puts a field's default value in as text).
    expect(again(CHANGE, '<b>x</b> $1 $&')[2].defaultValue).toBe('<b>x</b> $1 $&');
    // The page not answered in time: nothing after it, so nothing is imported or signed.
    const page = completion('Choice and box differ');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Choose again' });
    const say = (choice: string | null, box: string | null) => String(evaluate(page.completionMessage, { $: answered(choice, box) }));
    expect(say(null, null)).toBe("This page was not answered in time.\nNothing was imported or signed: feed &lt;b&gt; version 4 keeps running. Open the form again, leave Bot file empty and type the bot's name.");
    // The steps shown, the comparison and the review page are as before: Compared with the approved version reads the box only.
    expect(compared(ran, '')).toMatchObject({ unchanged: true });
    // An address that fills the choice is refused on the first page, as any field's value is.
    const plain = (query: unknown) => evaluate((byName(t, 'Plain address?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue, { $json: { formQueryParameters: query } });
    expect(plain({ choice: SIGN_AGAIN })).toBe(false);
    expect(plain({ choice: CHANGE, changedSteps: pasted })).toBe(false);
    expect(plain({ choice: VALUES })).toBe(false);
  });

  /** The values page answered with `answer` (each field under its name, as n8n 2.45 gives a text field: trimmed) after the change page chose Change values. */
  function valuesAnswered(ran: Record<string, INodeExecutionData[][]>, answer: IDataObject | null) {
    const page: IDataObject = answer === null ? { choice: VALUES, changedSteps: '' } : { ...answer, valuesPage: 'answered', submittedAt: '2026-11-13T10:00:00.000Z', formMode: 'production' };
    const after = { ...ran, 'Change or sign again': [[{ json: { choice: VALUES, changedSteps: '' } }]], 'Change values': [[{ json: page }]] } as Record<string, INodeExecutionData[][]>;
    const apply = byName(t, 'Values to steps');
    expect(apply).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const code = String(apply.parameters.jsonOutput);
    expect(code.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
    const applied = evaluate(code, { $: nodesRan(after) }) as { answered: boolean; refused: string; changed: number[]; steps: string };
    after['Values to steps'] = [[{ json: applied as unknown as IDataObject }]];
    const taken = (byName(t, 'Values taken?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const ok = evaluate(taken, { $json: applied }) as boolean;
    const line = ok ? evaluate(String(byName(t, COMPARED).parameters.jsonOutput), { $: nodesRan(after) }) as ReturnType<typeof compared> : null;
    if (line) after[COMPARED] = [[{ json: line as unknown as IDataObject }]];
    return { applied, ok, line, after };
  }
  /** The values page's fields as n8n builds them, for the row read in `ran`, the form's sign-in `auth`. */
  const valuesFields = (rows: IDataObject[], name: string, auth = 'n8nUserAuth') => jsonFormFields(String(byName(t, 'Change values').parameters.jsonOutput), { $: changePath(name, rows, auth).$ });
  /** The approved browser bot of the guide: the report's two dates, typed. */
  const LINE_ITEMS = {
    startUrl: `${SITE.url}/acme/login`, name: 'line-items', version: 1,
    steps: [
      { intent: `Open ${SITE.url}/acme/reports`, goto: `${SITE.url}/acme/reports` },
      { intent: 'Click Line Item Report', click: { role: 'link', name: 'Line Item Report' } },
      { intent: 'Type into From: "2026-09-01"', fill: { field: { label: 'From' }, value: '2026-09-01' } },
      { intent: 'Type into To: "2026-09-15"', fill: { field: { label: 'To' }, value: '2026-09-15' } },
      { intent: 'Choose "Posted" in Status', select: { field: { role: 'combobox', name: 'Status' }, value: 'Posted' } },
      { intent: 'Download with Export', download: { trigger: { role: 'button', name: 'Export' } } },
    ],
  };
  const lineItems = (steps: object = LINE_ITEMS) => changePath('line-items', [{ id: 1, name: 'line-items', version: 1, steps: JSON.stringify(steps), status: 'active' }]);

  it('The bot to change lists the values the values page offers: one per step that types, chooses or opens one, in step order, labelled with the step and the review page\'s words; a value that is not fixed text, or that a field cannot hold, is listed without a field', () => {
    const doc = {
      startUrl: `${SITE.url}/a`, name: 'feed', version: 2,
      steps: [
        { intent: 'Open the list', goto: `${SITE.url}/list?x=1` },
        { intent: 'Type the user', fill: { field: { role: 'textbox', name: 'User name' }, value: 'clerk' } },
        { intent: 'Type the password', fill: { field: { label: 'Password' }, value: '{{var.pin}}', secret: true } },
        { intent: 'Type the note', fill: { field: { css: '#note <b>' }, value: 'Dear {{ var.name }}' } },
        { intent: 'Choose a region', select: { field: { testId: 'region' }, value: 'EMEA' } },
        { intent: 'Choose two', select: { field: { text: 'Tags' }, value: ['a', 'b'] } },
        { intent: 'Type markup', fill: { field: { role: 'textbox' }, value: '<b>bold</b>' } },
        { intent: 'Type two lines', fill: { field: { label: 'Comment' }, value: 'one\ntwo' } },
        { intent: 'Type a space', fill: { field: { label: 'Code' }, value: ' A1' } },
        { intent: 'Click Save', click: { role: 'button', name: 'Save' } },
        { intent: 'Type nothing', fill: { field: { label: 'Empty' }, value: '' } },
        { intent: 'A broken one', fill: { field: { label: 'X' }, value: 5 } },
        { intent: 'Open the next page', goto: '/next' },
        { intent: 'Type a long name', fill: { field: { label: 'L'.repeat(100) }, value: 'x' } },
      ],
    };
    const { bot } = changePath('feed', [{ id: 1, name: 'feed', version: 2, steps: JSON.stringify(doc), status: 'active' }]);
    const v = (step: number, at: string, key: string, label: string, value: string, why = '') => ({ step, name: `value_${step}`, at, key, label, value, offered: why === '', why });
    const FIXED = 'not a fixed value: it is filled in when the bot runs';
    // A run variable says where it IS changed: on the bot's workflow, not on this form (W6-5).
    const VARIABLE = "a run variable, so it is not changed here: change it on the bot's workflow, in the RPA node's Options → Variables (a secret one in the RPA Secret Variables credential that node uses)";
    const CANNOT = 'a field cannot hold it as it is';
    expect(bot.values).toEqual([
      v(1, 'goto', 'goto', '1. Open: address', `${SITE.url}/list?x=1`),
      v(2, 'fill', 'value', '2. Type into User name: typed value', 'clerk'),
      v(3, 'fill', 'value', '3. Type into Password: typed value', '{{var.pin}}', VARIABLE),
      v(4, 'fill', 'value', '4. Type into the element matching #note ‹b›: typed value', 'Dear {{ var.name }}', VARIABLE),
      v(5, 'select', 'value', '5. Choose in region: chosen option', 'EMEA'),
      v(6, 'select', 'value', '6. Choose in Tags: chosen option', 'a, b', 'several options'),
      v(7, 'fill', 'value', '7. Type into the textbox: typed value', '<b>bold</b>', CANNOT),
      v(8, 'fill', 'value', '8. Type into Comment: typed value', 'one\ntwo', CANNOT),
      v(9, 'fill', 'value', '9. Type into Code: typed value', ' A1', CANNOT),
      v(11, 'fill', 'value', '11. Type into Empty: typed value', ''),
      v(13, 'goto', 'goto', '13. Open: address', '/next'),
      v(14, 'fill', 'value', `14. Type into ${'L'.repeat(79)}…: typed value`, 'x'),
    ]);
    // Desktop steps: the control's own name (or automation id) from its UI Automation path, the option a step chooses; a
    // file the runner saves into its export folder is not a fixed value.
    const desk = {
      surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' },
      steps: [
        { intent: 'Type the user', fill: { field: { uia: { path: [{ name: 'Sign in' }, { name: 'User name', automationId: 'txtUser' }] } }, value: 'clerk' } },
        { intent: 'Choose 2000', select: { field: { uia: { path: [{ automationId: 'cmbCompany' }] } }, option: '2000' } },
        { intent: 'Save the file', fill: { field: { uia: { path: [{ name: 'File name' }] } }, value: '{{$exportDir}}\\items.csv' } },
        { intent: 'Type somewhere', fill: { field: { uia: { path: [] } }, value: 'x' } },
        { intent: 'Open', goto: 'https://not.for.desktop/' },
        { intent: 'Type the name', fill: { field: { uia: { path: [{ name: 'Name:' }] } }, value: 'n' } },
      ],
    };
    expect(changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: JSON.stringify(desk), status: 'active' }]).bot.values).toEqual([
      v(1, 'fill', 'value', '1. Type into User name: typed value', 'clerk'),
      v(2, 'select', 'option', '2. Choose in cmbCompany: chosen option', '2000'),
      v(3, 'fill', 'value', '3. Type into File name: typed value', '{{$exportDir}}\\items.csv', FIXED),
      v(4, 'fill', 'value', '4. Type into a field without a name: typed value', 'x'),
      // A control name that ends with a colon (a Save As dialog's "File name:") is not followed by a second one.
      v(6, 'fill', 'value', '6. Type into Name: typed value', 'n'),
    ]);
    // Steps that do not parse, or no steps list: nothing to offer.
    for (const steps of ['{broken', '[]', '{"steps":{}}', 'null']) expect(changePath('x', [{ id: 1, name: 'x', version: 1, steps, status: 'active' }]).bot.values).toEqual([]);
  });

  it('the values page: one field per value, in step order, with the approved value; the rest shown as text; a hidden mark that it was answered; no field can be filled from an address', () => {
    const rows = [{ id: 1, name: 'line-items <b>', version: 3, steps: JSON.stringify({ ...LINE_ITEMS, steps: [...LINE_ITEMS.steps, { intent: 'Type the PIN', fill: { field: { label: 'PIN' }, value: '{{var.pin}}', secret: true } }, { intent: 'Type $& and $1', fill: { field: { label: 'Note' }, value: 'a $& b $1 & "c"' } }] }), status: 'active' }];
    const page = byName(t, 'Change values');
    expect(page).toMatchObject({
      type: COMPLETION, typeVersion: 2.5,
      parameters: { operation: 'page', defineForm: 'json', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours', options: { buttonLabel: 'Review', formDescription: 'Nothing changes until you approve on the next page.' } },
    });
    // jsonFormFields checks that the expression holds no "{{" or "}}" and that no "$" reaches n8n's String.replace.
    const fields = valuesFields(rows, 'line-items <b>');
    expect(fields[0]).toEqual({ fieldType: 'html', html: '<p>Each field holds a value that <b>line-items &lt;b&gt;</b> (version 3) types, chooses or opens, as approved, in step order. Change the ones you need, then click Review: the review page shows each change, old → new. Where a step\'s description quotes the old value, it gets the new one too.</p>'
      + '<p>Everything else (steps to add or remove, how a step finds its control, waits, write marks, file names) is changed with Change the steps as JSON.</p>'
      + '<p><em>Any signed-in n8n user who has the address of this page can read these values, so do not share it.</em></p>' });
    expect(fields.slice(1)).toEqual([
      { fieldLabel: '1. Open: address', fieldName: 'value_1', fieldType: 'text', defaultValue: `${SITE.url}/acme/reports`, requiredField: false },
      { fieldLabel: '3. Type into From: typed value', fieldName: 'value_3', fieldType: 'text', defaultValue: '2026-09-01', requiredField: false },
      { fieldLabel: '4. Type into To: typed value', fieldName: 'value_4', fieldType: 'text', defaultValue: '2026-09-15', requiredField: false },
      { fieldLabel: '5. Choose in Status: chosen option', fieldName: 'value_5', fieldType: 'text', defaultValue: 'Posted', requiredField: false },
      { fieldType: 'html', html: '<p><em>7. Type into PIN: typed value &quot;{{var.pin}}&quot;: a run variable, so it is not changed here: change it on the bot&#39;s workflow, in the RPA node&#39;s Options → Variables (a secret one in the RPA Secret Variables credential that node uses).</em></p>' },
      // "$" comes back as written (the page writes it as $, so n8n's String.replace leaves it alone).
      { fieldLabel: '8. Type into Note: typed value', fieldName: 'value_8', fieldType: 'text', defaultValue: 'a $& b $1 & "c"', requiredField: false },
      { fieldType: 'hiddenField', fieldName: 'valuesPage', fieldValue: 'answered' },
    ]);
    // No default value holds < or >: n8n would escape them (type-validation.ts tryToParseJsonToFormFields) and the field
    // would show and send back &lt; and &gt;. Such a value is shown as text instead (the list above).
    const withMarkup = valuesFields([{ id: 1, name: 'm', version: 1, steps: JSON.stringify({ ...LINE_ITEMS, steps: [{ intent: 'x', fill: { field: { label: 'A<b>' }, value: '<i>x</i>' } }] }), status: 'active' }], 'm');
    expect(withMarkup.slice(1, -1)).toEqual([{ fieldType: 'html', html: '<p><em>1. Type into A‹b›: typed value &quot;&lt;i&gt;x&lt;/i&gt;&quot;: a field cannot hold it as it is.</em></p>' }]);
    // With Basic Auth (or none), anyone who has the page's address.
    expect(String(valuesFields(rows, 'line-items <b>', 'basicAuth')[0].html)).toContain('<p><em>Anyone who has the address of this page can read these values, so do not share it.</em></p>');
    expect(render(String((page.parameters.options as IDataObject).formTitle), { $: changePath('line-items <b>', rows).$ })).toBe('Change values: line-items <b>');
    // n8n fills a later page's fields from the first page's address (Form utils.ts renderForm: the trigger's
    // formQueryParameters, by field name). Every name this page uses is refused there before anything is read.
    const plain = (query: unknown) => evaluate((byName(t, 'Plain address?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue, { $json: { formQueryParameters: query } });
    for (const f of fields.filter((x) => x.fieldName)) expect(plain({ [String(f.fieldName)]: 'https://elsewhere.example.com/' }), f.fieldName).toBe(false);
    expect(plain({ value_4: '2026-12-31', choice: VALUES })).toBe(false);
  });

  it('Values to steps: the approved steps with only the changed values put in, as text, at the place each was found; a description that quotes the old value gets the new one', () => {
    const { ran } = lineItems();
    // All left as they were: no steps, so the row's own steps are signed again, and the review page says so plainly.
    const same = valuesAnswered(ran, { value_1: `${SITE.url}/acme/reports`, value_3: '2026-09-01', value_4: '2026-09-15', value_5: 'Posted' });
    expect(same.applied).toEqual({ answered: true, refused: '', changed: [], steps: '' });
    expect(same.line).toEqual({ steps: JSON.stringify(LINE_ITEMS), changed: false, unchanged: true, compared: 'line-items: unchanged from the approved version 1. No value was changed on the values page: approving signs these steps again as they are.' });
    // A field n8n did not get (null) is left as it was too.
    expect(valuesAnswered(ran, { value_1: null, value_3: null, value_4: null, value_5: null }).applied).toEqual(same.applied);
    // One date: only that value, and the step's own description where it quotes the old value. The review page's line
    // names both, old → new.
    const one = valuesAnswered(ran, { value_1: `${SITE.url}/acme/reports`, value_3: '2026-09-01', value_4: '2026-09-30', value_5: 'Posted' });
    expect(one.applied.changed).toEqual([4]);
    const doc = JSON.parse(one.applied.steps) as typeof LINE_ITEMS;
    expect(doc).toEqual({ ...LINE_ITEMS, steps: LINE_ITEMS.steps.map((s, i) => (i === 3 ? { intent: 'Type into To: "2026-09-30"', fill: { field: { label: 'To' }, value: '2026-09-30' } } : s)) });
    expect(one.line).toEqual({ steps: one.applied.steps, changed: true, unchanged: false, compared: 'line-items: changed from the approved version 1: step 4: description "Type into To: "2026-09-15"" → "Type into To: "2026-09-30"", typed value "2026-09-15" → "2026-09-30".' });
    // The old value in another step's description, or in a locator, stays: only the step's own description changes.
    const shared = { ...LINE_ITEMS, steps: [
      { intent: 'Type "2026-09-15" into From', fill: { field: { label: 'From 2026-09-15' }, value: '2026-09-15' } },
      { intent: 'Type "2026-09-15" into To, then 2026-09-15 again', fill: { field: { label: 'To 2026-09-15' }, value: '2026-09-15' } },
    ] };
    const two = valuesAnswered(lineItems(shared).ran, { value_2: '2026-09-30' });
    expect(JSON.parse(two.applied.steps).steps).toEqual([shared.steps[0], { intent: 'Type "2026-09-30" into To, then 2026-09-30 again', fill: { field: { label: 'To 2026-09-15' }, value: '2026-09-30' } }]);
    // Only where the old value stands on its own: a short value is not replaced inside another number or word.
    const short = { ...LINE_ITEMS, steps: [
      { intent: 'Type 1 into Field 10 of form A1, then 1.', fill: { field: { label: 'Field 10' }, value: '1' } },
      { intent: 'Choose "on" in Options, the second one', select: { field: { role: 'combobox', name: 'Options' }, value: 'on' } },
    ] };
    const three = valuesAnswered(lineItems(short).ran, { value_1: '5', value_2: 'off' });
    expect(JSON.parse(three.applied.steps).steps.map((s: IDataObject) => s.intent)).toEqual(['Type 5 into Field 10 of form A1, then 5.', 'Choose "off" in Options, the second one']);
    // An address and a chosen option.
    const more = valuesAnswered(ran, { value_1: `${SITE.url}/acme/reports?year=2026`, value_5: 'Open' });
    expect(more.applied.changed).toEqual([1, 5]);
    expect(more.line?.compared).toBe(`line-items: changed from the approved version 1: step 1: description "Open ${SITE.url}/acme/reports" → "Open ${SITE.url}/acme/reports?year=2026", address "${SITE.url}/acme/reports" → "${SITE.url}/acme/reports?year=2026"; step 5: description "Choose "Posted" in Status" → "Choose "Open" in Status", chosen option "Posted" → "Open".`);
  });

  it('a value is taken as text: it cannot add a key, leave its string or become a variable; "{{" is refused with a sentence and nothing is imported', () => {
    const { ran } = lineItems();
    const keys = (v: unknown): unknown => (Array.isArray(v) ? v.map(keys) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys(x)])) : typeof v);
    for (const typed of ['<b>2026</b> & "x"', '2026-09-30", "secret": true, "x": "', '\\", "write": true}, {"goto": "https://elsewhere.example.com/', '$& $1 \\u0024', '} }', '__proto__', 'a}}b', '{ {var.x} }']) {
      const r = valuesAnswered(ran, { value_4: typed });
      expect(r.ok, typed).toBe(true);
      const doc = JSON.parse(r.applied.steps) as typeof LINE_ITEMS;
      // The same keys and kinds of value everywhere; the value is exactly the text typed.
      expect(keys(doc), typed).toEqual(keys(LINE_ITEMS));
      expect(doc.steps[3].fill?.value, typed).toBe(typed);
      expect(doc.steps.filter((_, i) => i !== 3), typed).toEqual(LINE_ITEMS.steps.filter((_, i) => i !== 3));
    }
    // Keys that are not fields of this page change nothing: another step's number, a value without a field, the page's
    // own names.
    const odd = valuesAnswered(lineItems({ ...LINE_ITEMS, steps: [...LINE_ITEMS.steps, { intent: 'PIN', fill: { field: { label: 'PIN' }, value: '{{var.pin}}', secret: true } }] }).ran,
      { value_2: 'x', value_6: 'x', value_7: 'typed', value_99: 'x', steps: '[]', choice: SIGN_AGAIN, ...(JSON.parse('{"__proto__": {"polluted": true}}') as IDataObject) });
    expect(odd.applied).toEqual({ answered: true, refused: '', changed: [], steps: '' });
    expect(({} as IDataObject).polluted).toBeUndefined();
    // "{{" would make the value a template the run renders (renderVars: any "{{…}}"); the steps have no way to say "this
    // is literal text", so it is refused, with a sentence, and nothing goes on.
    const refused = valuesAnswered(ran, { value_3: '{{var.from}}', value_4: '2026-09-30' });
    expect(refused).toMatchObject({ ok: false, line: null });
    expect(refused.applied).toEqual({ answered: true, refused: 'The new value of step 3 holds "{{", which steps read as the start of a variable: a value on this page is text only. Type it without "{{", or choose Change the steps as JSON to use a variable.', changed: [], steps: '' });
    expect(valuesAnswered(ran, { value_1: 'x{{', value_4: '{{ $env.HOME }}', value_5: '{{' }).applied.refused).toMatch(/^The new values of steps 1, 4 and 5 hold "\{\{"/);
    // The page after it: the sentence, escaped, and that nothing was imported or signed. The page not answered in time
    // (n8n gives the change page's item on, without the page's hidden mark) ends there too.
    const page = completion('Value not taken');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Nothing changed' });
    const say = (r: ReturnType<typeof valuesAnswered>) => String(evaluate(page.completionMessage, { $: nodesRan(r.after) }));
    expect(say(refused).split('\n')).toEqual([
      'The new value of step 3 holds &quot;{{&quot;, which steps read as the start of a variable: a value on this page is text only. Type it without &quot;{{&quot;, or choose Change the steps as JSON to use a variable.',
      "Nothing was imported or signed: line-items version 1 keeps running. Open the form again, leave Bot file empty and type the bot's name.",
    ]);
    const late = valuesAnswered(ran, null);
    expect(late).toMatchObject({ ok: false, applied: { answered: false, refused: '', changed: [], steps: '' } });
    expect(say(late).split('\n')[0]).toBe('This page was not answered in time.');
    expect(targets(t, 'Value not taken')).toEqual([]);
  });

  it('a description that quotes the old value verbatim gets the new one and reads quietly; one that does not is left as it is and the review page marks it (IB-6)', () => {
    const doc = { ...LINE_ITEMS, steps: [
      { intent: 'Type into To: "2026-09-15"', fill: { field: { label: 'To' }, value: '2026-09-15' } },
      { intent: 'Type "ACME CORP" into Company', fill: { field: { label: 'Company' }, value: 'Acme Corp' } },
    ] };
    const r = valuesAnswered(lineItems(doc).ran, { value_1: '2026-09-30', value_2: 'Other Inc' });
    const steps = (JSON.parse(r.applied.steps) as typeof doc).steps;
    expect(steps.map((s) => s.intent)).toEqual(['Type into To: "2026-09-30"', 'Type "ACME CORP" into Company']);
    // The review page's sentences, as Import steps builds them and Sign steps builds them again.
    const before = reviewSteps(doc.steps, { desktop: false, shownUrl: (u: string) => u });
    const after = reviewSteps(steps, { desktop: false, shownUrl: (u: string) => u });
    expect(before).toEqual([{ text: 'Type into To: "2026-09-15"', marks: [] }, { text: 'Type into Company: "Acme Corp"', describedAs: 'Type "ACME CORP" into Company', quiet: true, marks: [] }]);
    expect(after[0]).toEqual({ text: 'Type into To: "2026-09-30"', marks: [] });
    expect(after[1]).toEqual({ text: 'Type into Company: "Other Inc"', describedAs: 'Type "ACME CORP" into Company', marks: [] });
  });

  it('change values on a desktop bot: imported, reviewed with the changed step\'s write mark from the rule (and said so), signed; nothing new after the values page', async () => {
    const KEY = 'k'.repeat(32);
    const { ran: first } = await importedRecording();
    // Approved with step 6 (choose the company code) typed as a write and Save (16) ticked.
    const approved = await signAfterReview(first, { writes_0: ['Step 16: Click Save'], moreWrites_0: '6', decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, KEY);
    expect(approved.errors).toEqual([]);
    const old = approved.signed[0];
    const row: IDataObject = { id: 7, name: old.name, version: old.version, steps: old.steps, hash: old.hash, signature: old.signature, approvedBy: old.approvedBy, status: 'active' };
    const { ran, bot } = changePath(String(old.name), [row]);
    const values = bot.values as { step: number; name: string; value: string; offered: boolean; label: string }[];
    const company = values.find((v) => v.value === '2000')!;
    expect(company).toMatchObject({ step: 6, offered: true, label: '6. Choose in Company code: chosen option' });
    // The page offers the recording's values; the password is a variable and has no field.
    const fields = valuesFields([row], String(old.name));
    expect(fields.filter((f) => f.fieldType === 'text').map((f) => f.fieldName)).toEqual(values.filter((v) => v.offered).map((v) => v.name));
    expect(fields.some((f) => f.fieldType === 'html' && /typed value &quot;\{\{var\.password\}\}&quot;: a run variable, so it is not changed here/.test(String(f.html)))).toBe(true);
    // Step 6: 2000 → 3000. The same import, comparison, review page and Sign steps as a pasted change.
    const r = valuesAnswered(ran, { [company.name]: '3000' });
    expect(r.line?.compared).toBe(`${String(old.name)}: changed from the approved version 1: step 6: description "Choose 2000 in Company code" → "Choose 3000 in Company code", chosen option "2000" → "3000".`);
    const upload = changedUploadOf(r.after);
    expect(upload.json).toMatchObject({ name: old.name, source: 'Step document' });
    expect(resolved(upload, r.after)).toMatchObject({ source: 'steps', stepsName: old.name, options: { version: 2 } });
    const [data, repaired] = await runImport(upload, () => {
      throw new Error('desktop steps are never replayed');
    }, r.after);
    expect(data[0].json.error).toBeUndefined();
    const after = await checkBeforeReview({ ...r.after, 'Import steps': [data, repaired] }, KEY);
    expect((after['Sign steps'][0][0].json as IDataObject).approvedVersion).toMatchObject({ version: 1, signatureFits: true });
    const all = jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan(after) });
    expect(String(all[0].html)).toContain(`<p><b>${String(old.name)}: changed from the approved version 1: step 6: description &quot;Choose 2000 in Company code&quot; → &quot;Choose 3000 in Company code&quot;, chosen option &quot;2000&quot; → &quot;3000&quot;. Which steps are writes is not compared: it is chosen again on this page.</b></p>`);
    const fieldsAfter = all.slice(1);
    // Save keeps its approved tick; step 6 changed, so its mark starts from the rule (no number), and the page says so.
    expect(fieldsAfter.find((f) => f.fieldName === 'writes_0')?.defaultValue).toBe('Step 16: Click Save');
    expect(fieldsAfter.find((f) => f.fieldName === 'moreWrites_0')).not.toHaveProperty('defaultValue');
    expect(String(fieldsAfter.find((f) => /<p><em>The ticks start/.test(String(f.html)))?.html)).toMatch(/^<p><em>The ticks start as the approved version had them\. Step 6 changed since the approved version, so whether it may save or send starts from the rule: check it\. Ticked steps are/);
    expect(String(fieldsAfter[0].html)).toContain('<li>Choose &quot;3000&quot; in Company code</li>');
    const signed = await signAfterReview(after, { writes_0: ['Step 16: Click Save'], moreWrites_0: '6', decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, KEY);
    expect(signed.errors).toEqual([]);
    expect(signed.signed[0]).toMatchObject({ status: 'active', name: old.name, version: 2 });
    const steps = (JSON.parse(String(signed.signed[0].steps)) as { steps: IDataObject[] }).steps;
    expect((steps[5].select as IDataObject).option).toBe('3000');
    expect(steps.map((s, i) => (s.write === true ? i + 1 : 0)).filter((n) => n)).toEqual([6, 16]);
    expect(checkDesktopTrust(JSON.parse(String(signed.signed[0].steps)), { required: true, signature: String(signed.signed[0].signature), approvedBy: APPROVER, key: KEY })).toEqual({ ok: true, signed: true });
    // All left as they were: the row's own steps byte for byte, signed again; the last page says so.
    const same = valuesAnswered(ran, Object.fromEntries(values.filter((v) => v.offered).map((v) => [v.name, v.value])));
    expect(same.line).toMatchObject({ steps: String(old.steps), unchanged: true });
    const unchanged = changedUploadOf(same.after);
    expect(Buffer.from(String(unchanged.binary?.bot.data), 'base64').toString('utf8')).toBe(String(old.steps));
  });

  it('an address that carries values for the form\'s fields is refused before anything is read, imported, shown or signed; a plain address goes through', () => {
    // n8n 2.45 keeps the first page's query as the trigger's formQueryParameters, only when it has a key (Form
    // utils.ts 574-579), and fills the fields of every later page from it (utils.ts 634-648 and 337): the review page's
    // decision and write ticks, the steps box. A later page's own ?signature= never gets there.
    const cond = (byName(t, 'Plain address?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(cond).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    const plain = (query?: unknown) => evaluate(cond[0].leftValue, { $json: { ...formItem('Chrome Recorder', CHROME).json, ...(query === undefined ? {} : { formQueryParameters: query }) } });
    expect(plain()).toBe(true);
    expect(plain({})).toBe(true);
    expect(plain('')).toBe(true);
    // The two keys n8n adds itself when it shows a form inside its connect-accounts frame.
    expect(plain({ n8nShellInner: '1' })).toBe(true);
    expect(plain({ n8nShellHosted: '1', n8nShellInner: '1' })).toBe(true);
    const doc = { startUrl: `${SITE.url}/a`, name: 'feed', version: 1, steps: [{ intent: 'Open the report', goto: '/report' }] };
    const planted = JSON.stringify({ ...doc, steps: [{ intent: 'Open the report', goto: 'https://elsewhere.example.com/' }] });
    for (const query of [{ decision_0: 'Approve and sign' }, { writes_0: 'Step 16: Click Save' }, { steps: planted }, { name: 'feed' }, { utm_source: 'mail' }, { n8nShellInner: '1', decision_0: 'Approve and sign' }, 'x']) {
      expect(plain(query), JSON.stringify(query)).toBe(false);
    }
    // Refused: one last page, and nothing after it. Settings, and everything that reads, imports or signs, comes after
    // the true output only.
    const after = (from: string): Set<string> => {
      const seen = new Set<string>();
      const walk = (n: string) => targets(t, n).flat().forEach((m) => (seen.has(m) ? undefined : (seen.add(m), walk(m))));
      walk(from);
      return seen;
    };
    expect(targets(t, 'Address with values')).toEqual([]);
    expect([...after('Import a bot')].sort()).toEqual([...new Set(['Plain address?', 'Address with values', 'Settings', ...after('Settings')])].sort());
    for (const n of ['Settings', 'Approved bots', 'Import steps', REVIEW, 'Sign steps']) expect(after('Address with values').has(n), n).toBe(false);
    const page = completion('Address with values');
    expect(page).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Open the form by its plain address' });
    expect(page.completionMessage).toBe("This address carries values for the form's fields. Open the form by its plain address: the address up to the question mark.\nNothing was imported, shown or signed.");
    // Steps that reach the box another way (a slip of the hand) while the person meant to change nothing: the review
    // page says they changed, and where.
    const rows = [{ id: 1, name: 'feed', version: 1, steps: JSON.stringify(doc), status: 'active' }];
    expect(compare(changePath('feed', rows).ran, planted)).toBe('feed: changed from the approved version 1: step 1: address "/report" → "https://elsewhere.example.com/".');
  });

  it('template 3 has no form that n8n fills from an address, and template 2 has no form', () => {
    // Send-and-wait renders its custom form with an empty query (n8n 2.45 utils/sendAndWait/utils.ts 392 and 460), and
    // its Approve and Reject links are signed resume links. Template 2 has no form node at all.
    const t3 = load('3-approve-steps.json');
    expect(t3.nodes.filter((n) => /\.form(Trigger)?$/.test(n.type))).toEqual([]);
    expect(t3.nodes.filter((n) => n.parameters.operation === 'sendAndWait').map((n) => n.type)).toEqual(['n8n-nodes-base.emailSend', 'n8n-nodes-base.emailSend']);
    expect(load('2-data-feed.json').nodes.filter((n) => /form/i.test(n.type) || n.parameters.operation === 'sendAndWait')).toEqual([]);
  });

  it('the first page with no file leads to an approved bot by its name; with a file, the import goes on as before', () => {
    const cond = (byName(t, 'Change an approved bot?').parameters as { conditions: { conditions: { leftValue: string; operator: unknown }[] } }).conditions.conditions;
    expect(cond).toEqual([expect.objectContaining({ operator: { type: 'boolean', operation: 'true', singleValue: true } })]);
    const change = (item: IDataObject) => evaluate(cond[0].leftValue, { $: () => ({ first: () => item }) });
    expect(change({ json: { name: 'erp' } })).toBe(true);
    expect(change({ json: { name: 'erp' }, binary: {} })).toBe(true);
    expect(change({ json: { name: 'erp' }, binary: { bot: { fileName: 'export.json' } } })).toBe(false);
    // A first-time import meets no new field and no new page: with its file it takes the import path, unchanged.
    expect(change(formItem('Chrome Recorder', CHROME) as unknown as IDataObject)).toBe(false);
    expect(byName(t, 'Change an approved bot?').position[1]).toBe(byName(t, 'Asks about a download?').position[1]);
    // Every row this workflow may read (the active ones are the approved bots; every row of a name gives its next version
    // number); no row (an empty item) finds nothing. The table was made first (Create steps table), so the read never
    // gives an error item: n8n 2.45 cannot read one in an expression.
    const get = byName(t, 'Approved bots');
    expect(get).toMatchObject({ type: DATA_TABLE, typeVersion: 1.1, alwaysOutputData: true });
    expect(get).not.toHaveProperty('onError');
    expect(table(get)).toEqual({ resource: 'row', operation: 'get', dataTableId: { __rl: true, mode: 'name', value: STEPS_TABLE }, returnAll: true });
    expect(byName(t, 'The bot to change')).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
  });

  it('The bot to change: the newest active row of exactly that name, its steps as the table holds them; none found names the approved bots', () => {
    const doc = { surface: 'desktop', name: 'erp', version: 1, app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Click Save', click: { name: 'Save' } }] };
    const rows: IDataObject[] = [
      { id: 1, name: 'erp', version: 1, steps: '{"old":true}', status: 'active' },
      { id: 2, name: 'erp', version: 3, steps: JSON.stringify(doc), status: 'active' },
      { id: 4, name: 'other<b>', version: 1, steps: '{}', status: 'active' },
      { id: 5, name: 'erp', version: 9, steps: '', status: 'active' },
      { error: 'The Data Table playwright_steps does not exist' }, {},
    ];
    // next: one more than the highest version any row of the name has (an active row without steps counts too).
    // active: how many active rows with steps the name has (IB-5).
    const found = { name: 'erp', found: true, active: 2, version: 3, steps: JSON.stringify(doc), signature: '', approvedBy: '', names: ['erp', 'other<b>'], next: 10, values: [] };
    expect(changePath('erp', rows).bot).toEqual(found);
    expect(changePath('  erp ', rows).bot).toEqual(found);
    // Exactly the name: another casing is another bot.
    expect(changePath('ERP', rows).bot).toEqual({ name: 'ERP', found: false, active: 0, version: null, steps: '', signature: '', approvedBy: '', names: ['erp', 'other<b>'], next: 1, values: [] });
    // A rejected or superseded row is not a running version, but its number is used: the next attempt takes the one after
    // the highest of them, so the table never holds two rows of one name and version.
    const used: IDataObject[] = [
      { id: 1, name: 'erp', version: 2, steps: '{}', status: 'superseded' }, { id: 2, name: 'erp', version: 3, steps: JSON.stringify(doc), status: 'active' },
      { id: 3, name: 'erp', version: 4, steps: '', status: 'rejected' }, { id: 4, name: 'erp', version: 5, steps: '', status: 'rejected' }, { id: 5, name: 'erp-1', version: 7, steps: '', status: 'rejected' },
    ];
    expect(changePath('erp', used).bot).toMatchObject({ found: true, version: 3, next: 6, names: ['erp'] });
    // A row whose steps are not JSON is shown as it is: Import steps then says what is wrong with it.
    expect(changePath('erp', [{ id: 1, name: 'erp', version: 1, steps: '{broken', status: 'active' }]).bot).toMatchObject({ found: true, steps: '{broken' });
    // No row (the table was made first: there is never an error item to read).
    expect(changePath('erp', []).bot).toEqual({ name: 'erp', found: false, active: 0, version: null, steps: '', signature: '', approvedBy: '', names: [], next: 1, values: [] });
    // The row's signature and approver come along for Sign steps' check, as the table holds them (never shown on a page).
    expect(changePath('erp', [{ id: 2, name: 'erp', version: 3, steps: '{}', signature: 'ab12', approvedBy: 'approver@example.com', status: 'active' }]).bot)
      .toMatchObject({ found: true, signature: 'ab12', approvedBy: 'approver@example.com' });
    expect(changePath('erp', [{}]).bot).toMatchObject({ found: false, names: [] });
    const foundCond = (byName(t, 'Approved bot found?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    expect([found, { found: false }, {}].map(($json) => evaluate(foundCond, { $json }))).toEqual([true, false, false]);

    // None of that name: a last page names the approved bots, escaped, and how to import instead; none at all says so.
    const none = completion('No approved bot');
    expect(none).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'No approved bot of that name' });
    expect(byName(t, 'No approved bot').parameters).toMatchObject({ limitWaitTime: true, resumeAmount: 1, resumeUnit: 'hours' });
    expect(render(none.completionMessage, { $: changePath('ERP', rows).$ })).toBe('No approved bot is named ERP. The approved bots: erp, other&lt;b&gt;.\n'
      + 'To import a bot, open the form again and upload its file. To change an approved bot or sign it again, open the form again, leave Bot file empty and type its name.');
    expect(render(none.completionMessage, { $: changePath('erp', []).$ }).split('\n')[0]).toBe('No bot has been approved yet.');
  });

  it('the workflow file is handed over after approval on this form: Import steps says so, so its notes do not ask to approve again', () => {
    const upload = formItem('RPA recording', Buffer.from('{}'));
    const on = (approval: string) => resolved(upload, { Settings: [[{ json: { ...upload.json, ...settingsJson(), approval } }]] }).options as IDataObject;
    expect(on('on this form').approvedBeforeHandOver).toBe(true);
    // By email the form hands the file over before anyone approved (template 3 approves later).
    expect(on('by email').approvedBeforeHandOver).toBe(false);
    // The notes name the form that made the file (IB-4): this workflow's name, and its address when its form has a path
    // (the setup command sets one). The address is n8n's own base, from the execution's form-waiting address (whose
    // token, if any, is dropped with everything after the base).
    expect(on('on this form')).toMatchObject({ importFormName: 'RPA: 5 Import a bot (Sample accounts)', importFormAddress: '' });
    const address = (path: unknown, resumeFormUrl: string) => evaluate(String((imp.parameters.options as IDataObject).importFormAddress), {
      $: (name: string) => (name === 'Import a bot' ? { params: { ...form.parameters, options: { ...(form.parameters.options as IDataObject), path } } } : nodesRan({})(name)),
      $execution: { resumeFormUrl },
    });
    expect(address('rpa-import-sample-accounts', 'http://localhost:5720/form-waiting/12')).toBe('http://localhost:5720/form/rpa-import-sample-accounts');
    expect(address('rpa-import', 'https://n8n.example.com/sub/form-waiting/7?token=abc')).toBe('https://n8n.example.com/sub/form/rpa-import');
    expect(address(undefined, 'http://localhost:5720/form-waiting/12')).toBe('');
    expect(address('rpa-import', '')).toBe('');
  });

  it('Change or sign again shows the active steps to read in a block of the page, a required choice of three (two when no value fits a field), one empty box, and short sentences', () => {
    const doc = { startUrl: `${SITE.url}/a`, name: 'feed <b>', version: 1, steps: [{ intent: 'Type $& and $$ <b>Tom & Jerry</b> café', goto: '/b?x=$1&y=<2>' }] };
    const page = byName(t, 'Change or sign again');
    expect(page).toMatchObject({ type: COMPLETION, typeVersion: 2.5, parameters: { operation: 'page', defineForm: 'json', limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours', options: { buttonLabel: 'Review', formDescription: 'Nothing changes until you approve on the next page.' } } });
    const rows = [{ id: 3, name: 'feed <b>', version: 1, steps: JSON.stringify(doc), status: 'active' }];
    // With n8n's sign-in, a later page needs a signed-in n8n user; with Basic Auth (or none) it needs only its address.
    const ANYONE = 'Anyone who has the address of this page can read these steps, so do not share it.';
    for (const [auth, who] of [['n8nUserAuth', 'Any signed-in n8n user who has the address of this page can read these steps, so do not share it.'], ['basicAuth', ANYONE], ['none', ANYONE]]) {
      const { $ } = changePath('feed <b>', rows, auth);
      // jsonFormFields also checks that no "$" reaches n8n's String.replace, so "$&" in a step stays as written.
      const fields = jsonFormFields(String(page.parameters.jsonOutput), { $ });
      expect(fields.map((f) => f.fieldType)).toEqual(['html', 'radio', 'textarea']);
      // Explicit choices, one required: an empty box no longer means anything by itself. This bot's one value (an address
      // with < and >) cannot be shown in a field as it is, so Change values is not offered.
      expect(fields[1]).toEqual({ fieldLabel: 'What to do', fieldName: 'choice', fieldType: 'radio', fieldOptions: { values: [{ option: SIGN_AGAIN }, { option: CHANGE }] }, requiredField: true });
      // The box is empty and optional: the approved steps never go to the browser and come back through it. n8n escapes
      // < and > in every field's text but html (n8n-workflow type-validation.ts tryToParseJsonToFormFields), so a
      // default value would come back changed.
      expect(fields[2]).toEqual({ fieldLabel: 'Changed steps (JSON). Only when you change the steps as JSON.', fieldName: 'changedSteps', fieldType: 'textarea', requiredField: false });
      const html = String(fields[0].html);
      // The steps in a <pre> (n8n's sanitizer keeps pre and code, Form utils.ts sanitizeHtml), escaped once: the page
      // shows, and a person copies, the real text.
      const pre = /<pre>([\s\S]*)<\/pre>/.exec(html)?.[1] ?? '';
      expect(pre).toBe(escapeHtml(JSON.stringify(doc, null, 2)));
      const unescaped = pre.replace(/&(amp|lt|gt|quot|#39);/g, (_, x: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[x] ?? '');
      expect(JSON.parse(unescaped)).toEqual(doc);
      // Short sentences: what runs, how to choose (and why Change values is not offered), and two notes.
      expect(html.replace(/<pre>[\s\S]*<\/pre>/, '<pre/>')).toBe('<p>These are the steps that run now as <b>feed &lt;b&gt;</b> (version 1).</p><pre/>'
        + '<p>Choose what to do below. To change the steps, choose Change the steps as JSON and paste the changed steps in the box. This bot has no value that a page of fields can offer, so Change values is not offered.</p>'
        + '<p><em>This form cannot tell steps signed with an older key from steps changed in the table, so read every step on the next page.</em></p>'
        + `<p><em>${who}</em></p>`);
      expect(render(String((page.parameters.options as IDataObject).formTitle), { $ })).toBe('Change or sign again: feed <b>');
    }
    // The block scrolls at a sensible height and one click selects it all.
    expect(String((page.parameters.options as IDataObject).customCss)).toMatch(/div\.html pre \{ max-height: 24em; overflow: auto;[^}]*user-select: all;/);
    // Long lines wrap inside the block (a desktop step's window name is longer than the page is wide): no sideways scroll.
    expect(String((page.parameters.options as IDataObject).customCss)).toMatch(/div\.html pre \{[^}]*white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;/);
    expect(String((page.parameters.options as IDataObject).customCss)).not.toMatch(/white-space: pre;/);
    // A row whose steps are not JSON is shown as it is.
    const broken = jsonFormFields(String(page.parameters.jsonOutput), { $: changePath('x', [{ id: 1, name: 'x', version: 2, steps: '{broken <', status: 'active' }]).$ });
    expect(String(broken[0].html)).toContain('<pre>{broken &lt;</pre>');
    expect(broken[1].fieldOptions).toEqual({ values: [{ option: SIGN_AGAIN }, { option: CHANGE }] });
    // A bot with values a field can hold: three choices, and the sentence says what each is for.
    const dated = (n: number) => ({ startUrl: `${SITE.url}/a`, name: 'feed', version: 1, steps: Array.from({ length: n }, (_, i) => ({ intent: `Type the date ${i + 1}`, fill: { field: { label: `Date ${i + 1}` }, value: '2026-09-15' } })) });
    const offered = (n: number) => jsonFormFields(String(page.parameters.jsonOutput), { $: changePath('feed', [{ id: 1, name: 'feed', version: 1, steps: JSON.stringify(dated(n)), status: 'active' }]).$ });
    const three = offered(1);
    expect(three[1].fieldOptions).toEqual({ values: [{ option: SIGN_AGAIN }, { option: VALUES }, { option: CHANGE }] });
    expect(String(three[0].html)).toContain('<p>Choose what to do below. To change a date, a text the bot types, an option it chooses or an address it opens, choose Change values: the next page offers each value as a field. To add or remove steps, choose Change the steps as JSON and paste the changed steps in the box.</p>');
    // At most 40 fields on one page: more, and the page says so and offers the JSON way only.
    expect(offered(40)[1].fieldOptions).toEqual({ values: [{ option: SIGN_AGAIN }, { option: VALUES }, { option: CHANGE }] });
    const many = offered(41);
    expect(many[1].fieldOptions).toEqual({ values: [{ option: SIGN_AGAIN }, { option: CHANGE }] });
    expect(String(many[0].html)).toContain('This bot has 41 values, more than one page of fields shows well, so Change values is not offered.');
  });

  it('an empty box signs the table\'s own steps byte for byte; a pasted text is the change; text that does not parse changes nothing', async () => {
    const doc = {
      surface: 'desktop', name: 'erp', version: 3, app: { exe: 'ErpDemo.exe' },
      steps: [{ intent: 'Type <b>Tom & Jerry</b> $5 $HOME $& in Note', fill: { field: { uia: { path: [{ name: 'Note' }] } }, value: '<b>Tom & Jerry</b> café $5 $HOME $& \\ "q"' } }],
    };
    // As the table holds it (another spacing than JSON.stringify gives, on purpose).
    const stored = JSON.stringify(doc, null, 1);
    const { ran } = changePath('erp', [{ id: 4, name: 'erp', version: 3, steps: stored, status: 'active' }]);
    // Left empty (or blank): the steps to review are the row's text exactly as read, the box's text never.
    for (const empty of ['', '  \r\n ', null]) {
      expect(compared(ran, empty)).toEqual({ steps: stored, changed: false, unchanged: true, compared: 'erp: unchanged from the approved version 3.' });
    }
    const upload = changedUpload(ran, '');
    expect(Buffer.from(String(upload.binary?.bot.data), 'base64').equals(Buffer.from(stored, 'utf8'))).toBe(true);
    const never = () => {
      throw new Error('desktop steps are never replayed');
    };
    const [data, repaired] = await runImport(upload, never, ran);
    expect(data[0].json.error).toBeUndefined();
    // Imported as the next version, every step as stored: <, >, &, $, a backslash, a quote and é included.
    expect(repaired[0].json).toMatchObject({ name: 'erp', version: 4 });
    expect(repaired[0].json.steps).toEqual({ ...doc, version: 4 });
    // Pasted: the text is the new step document, compared with the row and named on the review page. A browser sends a
    // line break in a box as CR LF (multipart form data); n8n hands on the rest as typed (Form utils.ts
    // addFormResponseDataToReturnItem: a textarea is neither trimmed nor escaped).
    const pasted = JSON.stringify({ ...doc, steps: [{ ...doc.steps[0], fill: { ...doc.steps[0].fill, value: '<i>2000</i> & $1' } }] }, null, 2).replace(/\n/g, '\r\n');
    expect(compared(ran, pasted)).toEqual({ steps: pasted, changed: true, unchanged: false, compared: 'erp: changed from the approved version 3: step 1: typed value "<b>Tom & Jerry</b> café $5 $HOME $& \\ "q"" → "<i>2000</i> & $1".' });
    expect(compared(ran, JSON.stringify(doc))).toMatchObject({ changed: true, unchanged: true, compared: 'erp: unchanged from the approved version 3.' });
    const [changed, changedOut] = await runImport(changedUpload(ran, pasted), never, ran);
    expect(changed[0].json.error).toBeUndefined();
    expect((changedOut[0].json.steps as { steps: { fill: { value: string } }[] }).steps[0].fill.value).toBe('<i>2000</i> & $1');
    // Text that does not parse: Import steps refuses it on its error output, and the page after it says so and that the
    // approved version keeps running. Nothing reaches the review page or Sign steps.
    expect(compare(ran, '{ "steps": [ <oops')).toBe('erp: could not be compared with the approved version 3: read every step.');
    // (n8n moves an item with an error to the error output: onError continueErrorOutput.)
    const [failed, none] = await runImport(changedUpload(ran, '{ "steps": [ <oops'), never, ran);
    expect(none).toEqual([]);
    expect(String(failed[0].json.error)).toContain('the step document is not valid JSON');
    expect(targets(t, 'Missing login page?')[1]).toEqual(['Import failed']);
    const page = render(completion('Import failed').completionMessage, { $json: failed[0].json, $: nodesRan({ ...ran, 'Change or sign again': [[{ json: { changedSteps: '{ "steps": [ <oops' } }]] }) });
    expect(page.split('\n').slice(1)).toEqual(['Nothing changed: erp version 3 keeps running.', 'Details, including the import report when there is one, are in the error output of Import steps in this execution.']);
    // An ordinary import's failure page says nothing about a bot that keeps running.
    expect(render(completion('Import failed').completionMessage, { $json: failed[0].json, $: nodesRan({}) }).split('\n')).toHaveLength(2);
  });

  it('sign again: the same steps are reviewed and become a new row under the current key that supersedes the old one; a change is signed as changed; a rejected change leaves the old version running', async () => {
    const OLD_KEY = 'o'.repeat(32);
    const NEW_KEY = 'n'.repeat(32);
    // The bot as it was approved and saved, under the old key.
    const { ran: first } = await importedRecording();
    const old = (await signAfterReview(first, { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, OLD_KEY)).signed[0];
    const oldRow: IDataObject = { id: 7, name: old.name, version: old.version, steps: old.steps, hash: old.hash, signature: old.signature, approvedBy: old.approvedBy, approvedAt: old.approvedAt, status: 'active' };
    const trust = (steps: unknown, signature: unknown, key: string) => checkDesktopTrust(JSON.parse(String(steps)), { required: true, signature: String(signature), approvedBy: APPROVER, key });
    expect(trust(oldRow.steps, oldRow.signature, OLD_KEY)).toEqual({ ok: true, signed: true });
    // The key changed: the row no longer runs. To the new key it looks exactly like a row changed in the table.
    expect(trust(oldRow.steps, oldRow.signature, NEW_KEY)).toMatchObject({ ok: false });

    const { bot, ran } = changePath(String(old.name), [oldRow, { id: 3, name: 'other', version: 1, steps: '{}', status: 'active' }]);
    expect(bot).toMatchObject({ found: true, version: 1 });
    // What a person copies from the page's block of steps: the text as the page shows it (one escape undone).
    const shownHtml = String(jsonFormFields(String(byName(t, 'Change or sign again').parameters.jsonOutput), { $: changePath(String(old.name), [oldRow]).$ })[0].html);
    const box = (/<pre>([\s\S]*)<\/pre>/.exec(shownHtml)?.[1] ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, x: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[x] ?? '');
    expect(JSON.parse(box)).toEqual(JSON.parse(String(old.steps)));
    const never = () => {
      throw new Error('desktop steps are never replayed');
    };
    /** Submits the box with `text` ('' for left empty): Import steps, the review page, then Sign steps under the new key with `answer`. */
    const review = async (text: string, answer: IDataObject, by: IDataObject = signedIn(APPROVER)) => {
      const upload = changedUpload(ran, text);
      expect(upload.json).toMatchObject({ name: old.name, source: 'Step document', expectedFileName: '', columns: '' });
      // The next version: the approved one plus one, from The bot to change (the active row), never from the box.
      expect(resolved(upload, ran)).toMatchObject({ source: 'steps', inputFrom: 'binary', binaryPropertyName: 'bot', stepsName: old.name, options: { version: 2 } });
      const [data, repaired] = await runImport(upload, never, ran);
      expect(data[0].json.error, JSON.stringify(data[0].json).slice(0, 600)).toBeUndefined();
      expect(repaired).toHaveLength(1);
      const line = compared(ran, text);
      // Sign steps checks the approved version first, with the new key: signed with the old one, it does not fit.
      const after = await checkBeforeReview({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]], [COMPARED]: [[{ json: line }]], 'Import steps': [data, repaired] }, NEW_KEY);
      expect(after['Sign steps'][0][0].json).toEqual({ checkOnly: true, siteLogin: null, approvedVersion: { version: 1, desktop: true, signatureFits: false } });
      // The review page of an import, with its opening lines on top: how these steps relate to the approved version, what
      // a desktop signature binds, and the warning. Desktop steps bind no Site Login, so it names the key, and, as for
      // browser steps, a row changed after approval: the page cannot tell the two apart and says to read every step.
      const all = jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan(after) });
      // The comparison is with the stored row, whose signature does not fit: the line never calls it approved or unchanged.
      const name = String(old.name);
      const told = line.unchanged
        ? `${name}: these are the steps of the stored version 1, whose signature does not fit this form (the warning says what that can mean).`
        : line.compared.replace('the approved version 1:', 'the stored version 1, whose signature does not fit this form:');
      expect(told).not.toMatch(/approved version|unchanged/);
      // Desktop steps whose approved version marks writes: the line says that the marks are not compared (IW-8). The
      // same steps: the marks are what the reviewer ticks below (W6-8).
      const marks = line.unchanged ? ' Which of them save, send or submit is what you tick below.' : ' Which steps are writes is not compared: it is chosen again on this page.';
      expect(all[0]).toEqual({
        fieldType: 'html',
        html: `<p><b>${escapeHtml(told + marks)}</b></p><p>Desktop steps are signed for the app they start, without a Site Login.</p>`
          + "<p><strong>⚠ Version 1 does not fit this form: it was signed with another signing key, or its row was changed after it was approved. This page cannot tell which. Read every step before you approve: approving signs the steps shown here with this form's key, which is the way back after a new signing key.</strong></p>",
      });
      const fields = all.slice(1);
      // Its first sentence stands again directly above the Decision, as for browser steps.
      expect(fields.map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'writes_0', 'html', 'moreWrites_0', 'html', 'decision_0']);
      expect(fields[4].html).toBe('<p><strong>⚠ Version 1 does not fit this form: it was signed with another signing key, or its row was changed after it was approved. The warning at the top says what to do.</strong></p>');
      // Every step list is the same without the line: an ordinary import shows none.
      expect(jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan({ ...after, [COMPARED]: undefined as never }) }).slice(1)).toEqual(fields);
      const signed = await signAfterReview(after, answer, {}, false, by, undefined, NEW_KEY);
      return { after, fields, ...signed };
    };

    // Sign again: the box left empty. The steps are the active row's, as read from the table.
    const again = await review('', { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' });
    expect(compare(ran, '')).toBe(`${String(old.name)}: unchanged from the approved version 1.`);
    // Pasting the copied block back is the same steps: the review page says so too.
    expect(compare(ran, box)).toBe(`${String(old.name)}: unchanged from the approved version 1.`);
    expect(again.fields[1].defaultValue).toBe('Step 16: Click Save');
    expect(again.errors).toEqual([]);
    const fresh = again.signed[0];
    /** The last page after the review page was answered with `answer`, and what Sign steps gave. */
    const lastPage = (r: { after: Record<string, INodeExecutionData[][]>; signed: IDataObject[]; errors: IDataObject[] }, answer: IDataObject = { decision_0: 'Approve and sign' }) => {
      const $ = nodesRan({ ...r.after, [REVIEW]: [[{ json: answer }]], 'Sign steps': [r.signed.map((json) => ({ json })), r.errors.map((json) => ({ json }))] });
      return { title: render(completion('Imported').completionTitle, { $ }), text: render(completion('Imported').completionMessage, { $ }) };
    };
    // It says what happened to the bot, in those words: never "Imported: 17 steps.", never a report to look for.
    // The page is titled by what happened (B6-10). Version 1 does not fit the new key, so its write marks are not read:
    // the steps are unchanged, and the marks are the ones just ticked (W6-8).
    expect(lastPage(again)).toEqual({ title: 'Signed again', text: `Signed again: ${String(old.name)} version 2, steps unchanged. Signed as writes: step 16 (Click Save).` });
    // Signed again with unchanged steps: a new approval, so the next version, and the steps as they were apart from it.
    expect(fresh).toMatchObject({ status: 'active', name: old.name, version: 2, approvedBy: APPROVER, writeLine: 'Signed as writes: step 16 (Click Save)' });
    expect({ ...JSON.parse(String(fresh.steps)), version: 1 }).toEqual(JSON.parse(String(old.steps)));
    expect(JSON.parse(String(fresh.steps)).version).toBe(2);
    // The review page names it, and what it replaces; the item it shows is the item Sign steps signed.
    const title = evaluate(String((byName(t, REVIEW).parameters.options as IDataObject).formTitle), { $: nodesRan(again.after) });
    expect(title).toBe(`${old.name}, version 2, replacing version 1`);
    expect(again.lists[0]).toMatchObject({ version: 2, baseVersion: null });
    expect(fresh.signature).not.toBe(old.signature);
    expect(trust(fresh.steps, fresh.signature, NEW_KEY)).toEqual({ ok: true, signed: true });
    // Saved as a new row, Supersede older versions turns the old row (and only it) superseded.
    const newRow = { ...fresh, id: 8 };
    const supersede = table(byName(t, 'Supersede older versions')).filters!.conditions;
    const lists = again.lists;
    const matches = (row: IDataObject) => supersede.every((c) => {
      const want = typeof c.keyValue === 'string' && c.keyValue.startsWith('=') ? evaluate(c.keyValue, { $json: newRow, $: () => ({ item: { json: lists[0] } }) }) : c.keyValue;
      const have = row[c.keyName];
      return c.condition === 'eq' ? have === want : c.condition === 'neq' ? have !== want : c.condition === 'lt' ? Number(have) < Number(want) : Number(have) <= Number(want);
    });
    expect(matches(oldRow)).toBe(true);
    expect(matches(newRow)).toBe(false);
    expect(matches({ ...oldRow, id: 3, name: 'other' })).toBe(false);
    // Another approval of the same version saved just before this one is superseded by it; one saved just after it is
    // not (its own supersede marks this one): of two approvals at the same moment, the last saved stays active (IB-5).
    expect(matches({ ...newRow, id: 7 })).toBe(true);
    expect(matches({ ...newRow, id: 9 })).toBe(false);
    // The last page gives no workflow file: the bot's workflow exists already.
    const fileCond = (byName(t, 'Workflow file?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const withReview = { ...again.after, [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [[{ json: { status: 'active' } }], []] };
    expect(evaluate(fileCond, { $: nodesRan(withReview) })).toBe(false);
    const importOnly = Object.fromEntries(Object.entries(withReview).filter(([k]) => k !== 'Change or sign again'));
    expect(evaluate(fileCond, { $: nodesRan(importOnly) })).toBe(true);

    // A change: the company code typed in step 6. The review page shows the new value; the signed steps hold it.
    expect(box).toContain('"2000"');
    const changed = await review(box.replace('"2000"', '"3000"'), { writes_0: ['Step 16: Click Save'], decision_0: 'Approve and sign' });
    expect(compare(ran, box.replace('"2000"', '"3000"'))).toBe(`${String(old.name)}: changed from the approved version 1: step 6: chosen option "2000" → "3000".`);
    // On the review page, where version 1 does not fit the new key: changed from the stored version, not the approved one.
    expect(String(jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan(changed.after) })[0].html))
      .toContain(`<p><b>${String(old.name)}: changed from the stored version 1, whose signature does not fit this form: step 6: chosen option &quot;2000&quot; → &quot;3000&quot;. Which steps are writes is not compared: it is chosen again on this page.</b></p>`);
    expect(String(changed.fields[0].html)).toContain('<li>Choose &quot;3000&quot; in Company code</li>');
    expect(changed.signed[0]).toMatchObject({ status: 'active', name: old.name });
    expect(String(changed.signed[0].steps)).toContain('"3000"');
    expect(trust(changed.signed[0].steps, changed.signed[0].signature, NEW_KEY)).toEqual({ ok: true, signed: true });
    // W5: a change approved on the form is version 2 everywhere: the review page's title, Sign steps' record, the steps it
    // signed, the row Save signed steps writes, and the last page.
    expect(evaluate(String((byName(t, REVIEW).parameters.options as IDataObject).formTitle), { $: nodesRan(changed.after) })).toBe(`${String(old.name)}, version 2, replacing version 1`);
    expect(changed.signed[0].version).toBe(2);
    expect(JSON.parse(String(changed.signed[0].steps)).version).toBe(2);
    const saved = table(byName(t, 'Save signed steps')).columns!.value;
    expect(Object.fromEntries(Object.entries(saved).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('=') ? evaluate(v, { $json: changed.signed[0] }) : v]))).toMatchObject({ name: old.name, version: 2, status: 'active' });
    expect(lastPage(changed).text).toBe(`Changed: ${String(old.name)} version 2 is now the version that runs, replacing version 1. Signed as writes: step 16 (Click Save).`);

    // A rejected change: a rejected row, no steps, no signature. Only Save signed steps leads to Supersede older versions,
    // so the old row stays active and keeps running (under the key it was signed with).
    const rejected = await review(box.replace('"2000"', '"3000"'), { writes_0: [], decision_0: 'Reject' });
    expect(rejected.signed).toEqual([expect.objectContaining({ status: 'rejected', steps: '', signature: '' })]);
    // The last page does not say that a version was rejected that keeps running.
    expect(lastPage(rejected, { decision_0: 'Reject' }).text).toBe(`Nothing changed: ${String(old.name)} version 1 keeps running.`);
    // Sign steps refused (an approver not on the list), or the review page not answered: the old version keeps running too.
    const refused = await review('', { writes_0: [], decision_0: 'Approve and sign' }, signedIn('member@example.com'));
    expect(lastPage(refused).text.split('\n')).toEqual([
      `Not signed: ${String(old.name)} version 2. Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist. Ask the person who set up this form to approve it, or to put you on its Approver Allowlist.`,
      `Nothing changed: ${String(old.name)} version 1 keeps running.`,
    ]);
    expect(lastPage({ after: rejected.after, signed: [], errors: [] }, { name: 'steps table' }).text.split('\n')).toEqual([
      'Nothing was signed: the review page was not answered in time.', `Nothing changed: ${String(old.name)} version 1 keeps running.`,
    ]);
    expect(targets(t, 'Signed?')).toEqual([['Save signed steps'], ['Record rejection']]);
    expect(targets(t, 'Record rejection')).toEqual([]);
  });

  it('the review page names the Site Login Sign steps signs for; on a change or sign again, a warning when the approved version does not fit its key and Site Login', async () => {
    const KEY = 'k'.repeat(32);
    const doc = { startUrl: `${SITE.url}/list`, name: 'feed', version: 4, steps: [{ intent: 'Open the list', goto: `${SITE.url}/list` }] };
    /** The active row of `doc` as Sign Steps saved it: signed with `key` for the Site Login id `siteLoginId` (none when not given). */
    const row = (key: string, siteLoginId?: string): IDataObject => ({
      id: 9, name: 'feed', version: 4, steps: JSON.stringify(doc), signature: signScript(doc, key, { approvedBy: APPROVER, ...(siteLoginId ? { siteLoginId } : {}) }).signature,
      approvedBy: APPROVER, status: 'active',
    });
    /** The Repaired steps item of the next version, as the review page lists it. */
    const next = (surface?: string) => ({ json: { name: 'feed', version: 5, baseVersion: null, steps: { ...doc, version: 5, ...(surface ? { surface } : {}) }, reviewSteps: [], safetyFlags: [] } });
    const checked = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => {
      const { ran } = changePath('feed', [r]);
      return checkBeforeReview({ ...ran, 'Change or sign again': [[{ json: { changedSteps: '' } }]], [COMPARED]: [[{ json: compared(ran, '') }]], 'Import steps': [[{ json: {} }], [next()]] }, key, siteLogin);
    };
    const head = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => reviewHead({ $: nodesRan(await checked(r, key, siteLogin)) });
    /** The page's fields after its opening lines. */
    const fieldsOf = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => reviewFields({ $: nodesRan(await checked(r, key, siteLogin)) });
    const SHOP = { id: 'site-a', name: 'Shop <login>' };
    const UNCHANGED = '<p><b>feed: unchanged from the approved version 4.</b></p>';
    // The name in quotes: n8n's default credential name, "RPA Site Login account", does not read doubled. These steps
    // never sign in, and the signature binds the Site Login all the same (B6-6): the line says both.
    const NAMED = '<p>These steps do not sign in, and are signed for the Site Login named "<b>Shop &lt;login&gt;</b>" all the same. The workflow that runs the bot must use this Site Login.</p>';
    // Signed with this key for this Site Login: the line names it, and nothing more is said.
    expect(await head(row(KEY, SHOP.id), KEY, SHOP)).toBe(UNCHANGED + NAMED);
    // Signed for another Site Login (the many-accounts one): the warning leads with what the person can check, this
    // form's Site Login, not with keys; then the two causes' advice, shortest first. Its first sentence stands again
    // directly above the Decision.
    const FIT = '⚠ Version 4 does not fit this form: it was signed for another Site Login than "Shop &lt;login&gt;", or with another signing key, or its row was changed after it was approved.';
    // A bot of another Site Login's form opened here (IB-4): the first advice is to change it on that form; the page does
    // not tell the person to switch this form's Site Login.
    const READ = "every step before you approve: approving signs the steps shown here with this form's key, which is the way back after a new signing key.";
    const WARNING = `<p><strong>${FIT} This page cannot tell which. If the bot was approved on the import form of another Site Login, change it on that form: approved here, it would run only with the Site Login "Shop &lt;login&gt;". Otherwise read ${READ}</strong></p>`;
    expect(WARNING).not.toContain('Import steps and Sign steps');
    // The comparison is with the stored row, whose signature does not fit: it is not called approved, nor unchanged (IB-3).
    const STORED = '<p><b>feed: these are the steps of the stored version 4, whose signature does not fit this form (the warning says what that can mean).</b></p>';
    expect(await head(row(KEY, 'site-b'), KEY, SHOP)).toBe(STORED + NAMED + WARNING);
    expect((await fieldsOf(row(KEY, 'site-b'), KEY, SHOP)).map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'html', 'decision_0']);
    expect((await fieldsOf(row(KEY, 'site-b'), KEY, SHOP))[1].html).toBe(`<p><strong>${FIT} The warning at the top says what to do.</strong></p>`);
    // It fits: no line above the Decision either.
    expect((await fieldsOf(row(KEY, SHOP.id), KEY, SHOP)).map((f) => f.fieldName ?? f.fieldType)).toEqual(['html', 'decision_0']);
    // Signed with another key: the same warning (the row alone cannot tell the two apart), and it does not refuse.
    expect(await head(row('o'.repeat(32), SHOP.id), KEY, SHOP)).toBe(STORED + NAMED + WARNING);
    // The row edited in the Data Table after it was approved (a value changed, the signature kept): the same.
    const edited = { ...row(KEY, SHOP.id), steps: JSON.stringify({ ...doc, steps: [{ intent: 'Open the list', goto: `${SITE.url}/other` }] }) };
    expect(await head(edited, KEY, SHOP)).toBe(STORED + NAMED + WARNING);
    // No Site Login on Sign steps: the line says so, and a version signed for one does not fit.
    const NONE = '<p>Signs for no RPA Site Login. The workflow that runs the bot must have none.</p>';
    expect(await head(row(KEY), KEY)).toBe(UNCHANGED + NONE);
    expect(await head(row(KEY, SHOP.id), KEY)).toBe(STORED + NONE + `<p><strong>⚠ Version 4 does not fit this form: it was signed for a Site Login, which this form does not have, or with another signing key, or its row was changed after it was approved. This page cannot tell which. If the bot was approved on the import form of a Site Login, change it on that form: approved here, it would run only without a Site Login. Otherwise read ${READ}</strong></p>`);
    // No key, signature or Site Login data is shown.
    const shown = await head(row(KEY, 'site-b'), KEY, SHOP);
    for (const secret of [KEY, String(row(KEY, 'site-b').signature), 'site-a', 'site-b']) expect(shown).not.toContain(secret);
    // The upload path: a file uploaded under the name of a running bot. Its step list's line follows the same rule.
    const uploaded = async (r: IDataObject) => {
      const base: Record<string, INodeExecutionData[][]> = { Settings: [[{ json: { name: 'feed', ...settingsJson() } }]], 'Running versions': [[{ json: r }]] };
      base['What it replaces'] = [[{ json: evaluate(String(byName(t, 'What it replaces').parameters.jsonOutput), { $: nodesRan(base) }) as IDataObject }]];
      const fields = reviewFields({ $: nodesRan(await checkBeforeReview({ ...base, 'Import steps': [[{ json: {} }], [next()]] }, KEY, SHOP)) });
      return /<p><b>(.*?)<\/b><\/p>/.exec(String(fields[0].html))?.[1];
    };
    expect(await uploaded(row(KEY, SHOP.id))).toBe('feed: unchanged from the approved version 4.');
    // The file holds the steps as approved; the edited row differs from them, and the line says so without "approved".
    expect(await uploaded(edited)).toBe('feed: changed from the stored version 4, whose signature does not fit this form: step 1: address &quot;https://erp.example.com/other&quot; → &quot;https://erp.example.com/list&quot;.');
    expect(await uploaded(row('o'.repeat(32), SHOP.id))).toBe('feed: these are the steps of the stored version 4, whose signature does not fit this form (the warning says what that can mean).');

    // A new bot: no approved version to check, only the line. Sign steps' check gets an empty item.
    const fresh = await checkBeforeReview({ Settings: [[{ json: { name: 'feed', ...settingsJson() } }]], 'Import steps': [[{ json: {} }], [next()]] }, KEY, SHOP);
    expect(fresh['The approved version'][0][0].json).toEqual({});
    expect(fresh['Sign steps'][0][0].json).toEqual({ checkOnly: true, siteLogin: SHOP.name, approvedVersion: null });
    expect(reviewHead({ $: nodesRan(fresh) })).toBe(NAMED);
    // Desktop steps bind no Site Login: the line says what they bind, whatever Sign steps holds.
    const desktop = { ...fresh, 'Import steps': [[{ json: {} }], [next('desktop')]] };
    expect(reviewHead({ $: nodesRan(desktop) })).toBe('<p>Desktop steps are signed for the app they start, without a Site Login.</p>');
    expect(reviewHead({ $: nodesRan({ ...desktop, 'Import steps': [[{ json: {} }], [next(), next('desktop')]] }) }))
      .toBe('<p>These steps do not sign in, and are signed for the Site Login named "<b>Shop &lt;login&gt;</b>" all the same. The workflow that runs the bot must use this Site Login. Desktop steps are signed for the app they start, without a Site Login.</p>');
    // Steps that sign in: the line says that they sign for it.
    const signing = { json: { ...next().json, steps: { ...doc, version: 5, steps: [{ intent: 'Sign in', signIn: {} }, ...doc.steps] } } };
    expect(reviewHead({ $: nodesRan({ ...fresh, 'Import steps': [[{ json: {} }], [signing]] }) }))
      .toBe('<p>Signs for the Site Login named "<b>Shop &lt;login&gt;</b>". The workflow that runs the bot must use this Site Login.</p>');

    // The page was not answered: Sign steps' last run is its check, which the last page never counts as signed or rejected.
    const last = render(completion('Imported').completionMessage, { $: nodesRan({ ...fresh, 'Import steps': [[{ json: { drafts: [], report: { steps: 1, items: [] } } }], [next()]], [REVIEW]: [[{ json: {} }]] }) });
    expect(last).toContain('Nothing was signed: the review page was not answered in time.');
    expect(last).not.toContain('Rejected');
  });

  it('a bot whose approved version does not fit this form: before any step is shown, the person says why, and only a new key or a changed row goes on (IB-4)', async () => {
    const KEY = 'k'.repeat(32);
    const doc = { startUrl: `${SITE.url}/list`, name: 'feed', version: 4, steps: [{ intent: 'Open the list', goto: `${SITE.url}/list` }] };
    const row = (key: string, siteLoginId?: string): IDataObject => ({
      id: 9, name: 'feed', version: 4, steps: JSON.stringify(doc), signature: signScript(doc, key, { approvedBy: APPROVER, ...(siteLoginId ? { siteLoginId } : {}) }).signature,
      approvedBy: APPROVER, status: 'active',
    });
    const SHOP = { id: 'site-a', name: 'Shop <login>' };
    const BACK = 'This bot was approved on another import form: take me back';
    const AGAIN = 'I changed the signing key or the row was changed: show me the steps to read and sign again';
    const cond = (node: string) => (byName(t, node).parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    /** The change path up to Sign steps' check before the change page: The bot to change, The approved version, Sign steps. */
    const before = async (r: IDataObject, key: string, siteLogin?: { id: string; name: string }) => {
      const { ran } = changePath('feed', [r]);
      const { 'Import steps': _i, [RUNNING]: _r, ...after } = await checkBeforeReview({ ...ran, 'Import steps': [[], []] }, key, siteLogin);
      return after;
    };
    const fitsForm = async (r: IDataObject) => evaluate(cond('Fits this form?'), { $json: (await before(r, KEY, SHOP))['Sign steps'][0][0].json });
    // Sign steps checks the version that runs now before the change page (Import steps has not run), and again before
    // the review page: Change page next? sends the first to Fits this form? and the second to the review page.
    const fits = await before(row(KEY, SHOP.id), KEY, SHOP);
    expect(evaluate(cond('Change page next?'), { $: nodesRan(fits) })).toBe(true);
    expect(evaluate(cond('Change page next?'), { $: nodesRan({ ...fits, 'Import steps': [[], []] }) })).toBe(false);
    expect(await fitsForm(row(KEY, SHOP.id))).toBe(true);
    // Another Site Login, another key, a row changed in the table: the question, not the steps.
    const edited = { ...row(KEY, SHOP.id), steps: JSON.stringify({ ...doc, steps: [{ intent: 'Open the list', goto: `${SITE.url}/other` }] }) };
    for (const r of [row(KEY, 'site-b'), row('o'.repeat(32), SHOP.id), edited]) expect(await fitsForm(r)).toBe(false);
    // A row whose version column was changed (or a signed row copied under a higher version): its steps verify, but a
    // run expects the column's version and refuses it, so it does not fit either (found live).
    expect(await fitsForm({ ...row(KEY, SHOP.id), version: 7 })).toBe(false);
    expect(await fitsForm({ ...row(KEY, SHOP.id), version: '4' })).toBe(true);
    // The same for steps signed under another name, put in a row of this name.
    const other = { ...doc, name: 'other' };
    expect(await fitsForm({ ...row(KEY, SHOP.id), steps: JSON.stringify(other), signature: signScript(other, KEY, { approvedBy: APPROVER, siteLoginId: SHOP.id }).signature })).toBe(false);
    // No signature, or not checked (no key on Sign steps): on to the change page, as before; its review page warns then.
    expect([{ approvedVersion: { version: 4, desktop: false, signatureFits: null } }, { approvedVersion: null }, {}].map(($json) => evaluate(cond('Fits this form?'), { $json }))).toEqual([true, true, true]);
    // The question names what the form cannot tell apart and shows no step: two answers, none chosen, one required.
    const misfit = await before(row(KEY, 'site-b'), KEY, SHOP);
    const page = byName(t, 'Approved on another form?');
    expect(page).toMatchObject({ type: COMPLETION, typeVersion: 2.5, parameters: { operation: 'page', defineForm: 'json', limitWaitTime: true, resumeAmount: 1, resumeUnit: 'hours', options: { buttonLabel: 'Next' } } });
    expect(render(String((page.parameters.options as IDataObject).formTitle), { $: nodesRan(misfit) })).toBe('Before you change feed');
    const asked = jsonFormFields(String(page.parameters.jsonOutput), { $: nodesRan(misfit) });
    expect(asked).toEqual([
      {
        fieldType: 'html',
        html: '<p><strong>⚠ feed version 4 does not fit this form: it was signed for another Site Login than "Shop &lt;login&gt;", or with another signing key, or its row was changed after it was approved. This form cannot tell which.</strong></p>'
          + '<p>A bot is changed and signed again on the import form that approved it. Signed here, a bot of another Site Login runs only with the Site Login "Shop &lt;login&gt;", and its workflow stops working. Its steps are shown only after you answer.</p>',
      },
      { fieldLabel: 'Which is it?', fieldName: 'answer', fieldType: 'radio', fieldOptions: { values: [{ option: BACK }, { option: AGAIN }] }, requiredField: true },
    ]);
    expect(JSON.stringify(asked)).not.toContain('/list');
    for (const secret of [KEY, String(row(KEY, 'site-b').signature), 'site-a', 'site-b']) expect(JSON.stringify(asked)).not.toContain(secret);
    // Desktop steps bind no Site Login: the question leaves it out.
    const desk = { ...misfit, 'Sign steps': [[{ json: { checkOnly: true, siteLogin: SHOP.name, approvedVersion: { version: 4, desktop: true, signatureFits: false } } }]] };
    expect(String(jsonFormFields(String(page.parameters.jsonOutput), { $: nodesRan(desk) })[0].html))
      .toBe('<p><strong>⚠ feed version 4 does not fit this form: it was signed with another signing key, or its row was changed after it was approved. This form cannot tell which.</strong></p><p>A bot is changed and signed again on the import form that approved it. Its steps are shown only after you answer.</p>');
    // Only that one answer goes on to the change page (and from there to today's review page and its warning).
    const goesOn = (answer?: unknown) => evaluate(cond('Sign it again here?'), { $json: answer === undefined ? {} : { answer } });
    expect([AGAIN, BACK, undefined, '', 'show me the steps to read and sign again', `${AGAIN} `, [AGAIN]].map(goesOn)).toEqual([true, false, false, false, false, false, false]);
    // The other answer, or none in time: nothing is shown, imported or signed, and the page says where to go.
    const end = completion('Change it on its own form');
    expect(end).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Change it on its own form' });
    const say = (answer?: string) => render(end.completionMessage, { $: nodesRan({ ...misfit, 'Approved on another form?': [[{ json: answer === undefined ? {} : { answer } }]] }) });
    expect(say(BACK)).toBe('Nothing was shown, imported or signed: feed version 4 keeps running.\nChange it on the import form that approved it: the About note of the bot\'s workflow in n8n names that form, in the line To change the steps or sign them again. This form cannot list the other import forms.');
    expect(say()).toBe('This page was not answered in time.\nNothing was shown, imported or signed: feed version 4 keeps running. Open the form again, leave Bot file empty and type the bot\'s name.');
    // The question cannot be skipped by an address: the first page refuses any field value in its address, so the
    // question's answer cannot be pre-set either, and nothing reaches the change page but the If on its answer.
    const plain = (query: unknown) => evaluate(cond('Plain address?'), { $json: { formQueryParameters: query } });
    expect([{ answer: AGAIN }, { answer: BACK }].map(plain)).toEqual([false, false]);
    const into = (node: string) => Object.entries(t.connections).flatMap(([from, byType]) => (byType.main ?? []).flatMap((out, index) => out.filter((c) => c.node === node).map(() => [from, index])));
    expect(into('Change or sign again')).toEqual([['Page answered?', 0], ['Fits this form?', 0], ['Sign it again here?', 0]]);
  });

  it('nothing on the form writes to the steps table before an approver signed: the change path, the question, the values page and the review page write nothing (IB-5)', () => {
    // Every way from the form's first page, not going past Signed? (which only an approval and Sign steps' signature
    // reach): no Data Table row write is on it. Making a missing table is not a row write.
    const writes = (n: TemplateNode) => n.type === DATA_TABLE && table(n).resource === 'row' && table(n).operation !== 'get';
    const reached = new Set<string>();
    for (const queue = ['Import a bot']; queue.length; ) {
      const name = queue.shift()!;
      if (reached.has(name)) continue;
      reached.add(name);
      if (name === 'Signed?') continue;
      for (const out of targets(t, name)) queue.push(...out);
    }
    for (const page of ['Change or sign again', 'Approved on another form?', 'Change values', REVIEW, 'Sign steps', 'Signed?']) expect(reached.has(page), page).toBe(true);
    expect(t.nodes.filter((n) => reached.has(n.name) && writes(n)).map((n) => n.name)).toEqual([]);
    // Past Signed?: its true output (an active record) saves and supersedes; its false output records a rejection.
    expect(t.nodes.filter(writes).map((n) => n.name).sort()).toEqual(['Record rejection', 'Save signed steps', 'Supersede older versions']);
    expect(targets(t, 'Signed?')).toEqual([['Save signed steps'], ['Record rejection']]);
    expect(targets(t, 'Save signed steps')).toEqual([['Supersede older versions']]);
  });

  it('two active rows of one name (IB-5): the change page says so and writes nothing; runs use the newest, the first saved of one version; an approval marks every older one superseded', () => {
    const doc = (to: string) => JSON.stringify({ startUrl: `${SITE.url}/a`, name: 'erp', version: 7, steps: [{ intent: 'Type the To date', fill: { field: { label: 'To' }, value: to } }] });
    // As n8n's Data Table gives them (by id): version 6, then two of version 7 saved at the same moment.
    const rows: IDataObject[] = [
      { id: 1, name: 'erp', version: 5, steps: doc('2026-01-01'), status: 'superseded' },
      { id: 2, name: 'erp', version: 6, steps: doc('2026-06-30'), status: 'active' },
      { id: 3, name: 'erp', version: 7, steps: doc('2026-09-15'), status: 'active' },
      { id: 4, name: 'erp', version: 7, steps: doc('2026-09-30'), status: 'active' },
      { id: 5, name: 'other', version: 7, steps: doc('2026-09-30'), status: 'active' },
    ];
    // Get active steps reads the highest version, and of two of one version the first saved (n8n 2.45 orders ties by id,
    // ascending): The bot to change shows the same row, and counts the active rows.
    const get = table(byName(load('2-data-feed.json'), 'Get active steps'));
    expect(get).toMatchObject({ operation: 'get', returnAll: false, limit: 1, orderBy: true, orderByColumn: 'version', orderByDirection: 'DESC' });
    const { bot } = changePath('erp', rows);
    expect(bot).toMatchObject({ found: true, active: 3, version: 7, steps: doc('2026-09-15'), next: 8 });
    // The change page says what it met, quietly, after the steps it shows; with one active row it says nothing.
    const changePage = (scope: ReturnType<typeof changePath>) => String(jsonFormFields(String(byName(t, 'Change or sign again').parameters.jsonOutput), { $: scope.$ })[0].html);
    expect(changePage(changePath('erp', rows))).toContain('</pre><p><em>The steps table holds 3 active rows of this name, as when two approvals are saved at the same moment. Runs use version 7, shown here. An approval on this form marks the others superseded.</em></p>');
    expect(changePage(changePath('erp', rows.filter((r) => r.id !== 2)))).toContain('holds 2 active rows of this name, as when two approvals are saved at the same moment. Runs use version 7, shown here. An approval on this form marks the other superseded.');
    expect(changePage(changePath('erp', rows.filter((r) => r.id !== 2 && r.id !== 4)))).not.toContain('active rows');
    // Approved, the new row (version 8, id 6) is saved and Supersede older versions marks every active row of the name
    // saved before it superseded, whatever its version: both of version 7 and the one of version 6. Not another name.
    const conditions = table(byName(t, 'Supersede older versions')).filters!.conditions;
    const saved = { id: 6, name: 'erp', version: 8, status: 'active' };
    const matches = (r: IDataObject, baseVersion: number | null) => conditions.every((c) => {
      const want = typeof c.keyValue === 'string' && c.keyValue.startsWith('=') ? evaluate(c.keyValue, { $json: saved, $: () => ({ item: { json: { baseVersion, version: 8 } } }) }) : c.keyValue;
      const have = r[c.keyName];
      return c.condition === 'eq' ? have === want : c.condition === 'lt' ? Number(have) < Number(want) : Number(have) <= Number(want);
    });
    expect([...rows, saved].filter((r) => matches(r, null)).map((r) => r.id)).toEqual([2, 3, 4]);
    expect([...rows, saved].filter((r) => matches(r, 7)).map((r) => r.id)).toEqual([2, 3, 4]);
  });

  it('the write ticks start from the approved version\'s marks only when its signature fits; otherwise, and for a changed step, from the rule (IW-8)', async () => {
    const KEY = 'k'.repeat(32);
    const { ran: first } = await importedRecording();
    // Approved with Save (step 16) not ticked, and step 7 typed as a write in the box.
    const firstSigned = await signAfterReview(first, { writes_0: [], moreWrites_0: '7', decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, KEY);
    expect(firstSigned.errors).toEqual([]);
    const old = firstSigned.signed[0];
    const marked = (JSON.parse(String(old.steps)) as { steps: IDataObject[] }).steps.map((x, i) => (x.write === true ? i + 1 : 0)).filter((n) => n);
    expect(marked).toEqual([7]);
    const oldRow: IDataObject = { id: 7, name: old.name, version: old.version, steps: old.steps, hash: old.hash, signature: old.signature, approvedBy: old.approvedBy, status: 'active' };
    /** The review page's write fields on the change path, for the stored `row`, the box `text` and the form's key `key`. */
    const page = async (row: IDataObject, text: string, key = KEY) => {
      const { ran } = changePath(String(old.name), [row]);
      const [data, repaired] = await runImport(changedUpload(ran, text), () => {
        throw new Error('desktop steps are never replayed');
      }, ran);
      const after = await checkBeforeReview({ ...ran, 'Change or sign again': [[{ json: { changedSteps: text } }]], [COMPARED]: [[{ json: compared(ran, text) }]], 'Import steps': [data, repaired] }, key);
      const fields = reviewFields({ $: nodesRan(after) });
      const note = String(fields.find((f) => f.fieldType === 'html' && /<p><em>(The ticks|Ticked steps)/.test(String(f.html)))?.html ?? '');
      return { ticks: fields.find((f) => f.fieldName === 'writes_0'), more: fields.find((f) => f.fieldName === 'moreWrites_0'), note, after };
    };
    const RULE = 'Step 16: Click Save';
    // Fits: the marks a person approved. Save stays unticked, step 7 stays a write, and the page says so.
    const fits = await page(oldRow, '');
    expect(fits.ticks?.defaultValue).toBe('');
    expect(fits.more?.defaultValue).toBe('7');
    expect(fits.note).toMatch(/^<p><em>The ticks start as the approved version had them\. Ticked steps are/);
    // W6-8: signed again with other ticks. The review page says the steps are unchanged and the marks are what is ticked
    // below; the last page (Sign steps' first run is the check, its last the signing) names each mark added or removed
    // against the approved version, by number and words, and never says unchanged then.
    const head = String(jsonFormFields(String(byName(t, REVIEW).parameters.jsonOutput), { $: nodesRan(fits.after) })[0].html);
    expect(head).toMatch(new RegExp(`^<p><b>${String(old.name)}: the steps are unchanged from the approved version 1\\. Which of them save, send or submit is what you tick below\\.</b></p>`));
    const signAgain = async (answer: IDataObject) => {
      const r = await signAfterReview(fits.after, { ...answer, decision_0: 'Approve and sign' }, {}, false, signedIn(APPROVER), undefined, KEY);
      expect(r.errors).toEqual([]);
      const $ = nodesRan({ ...fits.after, [REVIEW]: [[{ json: { ...answer, decision_0: 'Approve and sign' } }]], 'Sign steps#0': fits.after['Sign steps'], 'Sign steps': [r.signed.map((json) => ({ json })), []] });
      return { title: render(completion('Imported').completionTitle, { $ }), text: render(completion('Imported').completionMessage, { $ }) };
    };
    const intentOf = (n: number) => String((JSON.parse(String(old.steps)) as { steps: IDataObject[] }).steps[n - 1].intent);
    expect(await signAgain({ writes_0: [], moreWrites_0: '7' })).toEqual({ title: 'Signed again', text: `Signed again: ${String(old.name)} version 2, unchanged. Signed as writes: step 7 (${intentOf(7)}).` });
    expect((await signAgain({ writes_0: [RULE], moreWrites_0: '7' })).text)
      .toBe(`Signed again: ${String(old.name)} version 2, steps unchanged; write marks changed from version 1: added step 16 (Click Save). Signed as writes: step 7 (${intentOf(7)}), step 16 (Click Save).`);
    expect((await signAgain({ writes_0: [RULE], moreWrites_0: '' })).text)
      .toBe(`Signed again: ${String(old.name)} version 2, steps unchanged; write marks changed from version 1: added step 16 (Click Save); removed step 7 (${intentOf(7)}). Signed as writes: step 16 (Click Save).`);
    // A step the person changed falls back to the rule (ticked); step 7, unchanged, keeps its mark.
    const doc = JSON.parse(String(old.steps)) as { steps: IDataObject[] };
    doc.steps[15] = { ...doc.steps[15], intent: 'Click Save now' };
    const changed = await page(oldRow, JSON.stringify(doc));
    expect(changed.ticks?.defaultValue).toBe('Step 16: Click Save now');
    expect(changed.more?.defaultValue).toBe('7');
    // Its tick moved (approved unticked, ticked by the rule): the page says so. Unchanged steps are not named.
    expect(changed.note).toMatch(/^<p><em>The ticks start as the approved version had them\. Step 16 changed since the approved version, so whether it may save or send starts from the rule: check it\. Ticked steps are/);
    expect(fits.note).not.toContain('changed since');
    // Does not fit (another key): the rule, an empty box, and the sentence.
    const misfit = await page(oldRow, '', 'n'.repeat(32));
    expect(misfit.ticks?.defaultValue).toBe(RULE);
    expect(misfit.more).not.toHaveProperty('defaultValue');
    expect(misfit.note).toMatch(/^<p><em>The ticks start from the rule: the marks of the stored version are not shown, because its signature does not fit this form\. Ticked steps are/);
    // A row edited in the table after approval to mark steps as writes, one the rule never proposes (step 2): not shown.
    const editedDoc = JSON.parse(String(old.steps)) as { steps: IDataObject[] };
    editedDoc.steps[1] = { ...editedDoc.steps[1], write: true };
    editedDoc.steps[15] = { ...editedDoc.steps[15], write: true };
    const edited = await page({ ...oldRow, steps: JSON.stringify(editedDoc) }, '');
    expect((edited.after['Sign steps'][0][0].json as IDataObject).approvedVersion).toMatchObject({ signatureFits: false });
    expect(edited.ticks?.defaultValue).toBe(RULE);
    expect(edited.more).not.toHaveProperty('defaultValue');
    expect(JSON.stringify(reviewFields({ $: nodesRan(edited.after) }).map((f) => f.defaultValue ?? null))).not.toMatch(/\b2\b/);
    // Not checked (no signing key on Sign steps): the rule.
    const unchecked = { ...fits.after, 'Sign steps': [[{ json: { checkOnly: true, siteLogin: null, approvedVersion: { version: old.version, desktop: true, signatureFits: null } } }], []] } as Record<string, INodeExecutionData[][]>;
    const uncheckedFields = reviewFields({ $: nodesRan(unchecked) });
    expect(uncheckedFields.find((f) => f.fieldName === 'writes_0')?.defaultValue).toBe(RULE);
    expect(uncheckedFields.find((f) => f.fieldName === 'moreWrites_0')).not.toHaveProperty('defaultValue');
    expect(String(uncheckedFields.find((f) => /<p><em>The ticks/.test(String(f.html)))?.html)).toContain('because its signature could not be checked.');
    // The same file uploaded again under the running bot's name: the same rule, from the running row Sign steps checked.
    const upload: Record<string, INodeExecutionData[][]> = { ...first, 'Running versions': [[{ json: oldRow }]] };
    upload['What it replaces'] = [[{ json: evaluate(String(byName(t, 'What it replaces').parameters.jsonOutput), { $: nodesRan(upload) }) as IDataObject }]];
    const uploaded = reviewFields({ $: nodesRan(await checkBeforeReview(upload, KEY)) });
    expect(uploaded.find((f) => f.fieldName === 'writes_0')?.defaultValue).toBe('');
    expect(uploaded.find((f) => f.fieldName === 'moreWrites_0')?.defaultValue).toBe('7');
    const uploadedMisfit = reviewFields({ $: nodesRan(await checkBeforeReview(upload, 'n'.repeat(32))) });
    expect(uploadedMisfit.find((f) => f.fieldName === 'writes_0')?.defaultValue).toBe(RULE);
    expect(uploadedMisfit.find((f) => f.fieldName === 'moreWrites_0')).not.toHaveProperty('defaultValue');
    // A new bot (no approved version): the rule, as before, and no sentence about marks.
    const fresh = reviewFields({ $: nodesRan(await checkBeforeReview(first, KEY)) });
    expect(fresh.find((f) => f.fieldName === 'writes_0')?.defaultValue).toBe(RULE);
    expect(fresh.find((f) => f.fieldName === 'moreWrites_0')).not.toHaveProperty('defaultValue');
    expect(fresh.some((f) => /The ticks start/.test(String(f.html ?? '')))).toBe(false);
  });

  it('two review pages of one bot open at once: the first answer signs, the second signs and rejects nothing and says to start again (IB-5)', () => {
    // Nothing on the way to Sign steps, Save signed steps or Record rejection bypasses the check: it is the only way from
    // the review page, and Step lists (the only way to Sign steps after the page) follows it.
    expect(targets(t, REVIEW)).toEqual([['Versions now']]);
    const into = (name: string) => Object.entries(t.connections).filter(([, c]) => (c.main ?? []).some((out) => out.some((x) => x.node === name))).map(([from]) => from).sort();
    expect(into('Step lists')).toEqual(['Still the next version?']);
    expect(into('Sign steps')).toEqual(['Step lists to sign', 'The approved version']);
    expect(into('Versions now')).toEqual([REVIEW]);
    // The read is the steps table's full read, made on every answer (several rows: the check runs once).
    expect(table(byName(t, 'Versions now'))).toEqual(table(byName(t, 'Running versions')));
    expect(byName(t, 'Versions now')).toMatchObject({ alwaysOutputData: true });
    expect(byName(t, 'Still the next version?')).toMatchObject({ executeOnce: true });
    const cond = (byName(t, 'Still the next version?').parameters as { conditions: { conditions: { leftValue: string }[] } }).conditions.conditions[0].leftValue;
    const list = (name: string, version: number) => ({ json: { name, version, baseVersion: null, steps: { steps: [] } } });
    const row = (name: string, version: number, status = 'active') => ({ json: { id: version, name, version, status } });
    /** The check and the page it leads to, for the step lists on the review page and the rows read after it was answered. */
    const after = (lists: { json: IDataObject }[], rows: { json: IDataObject }[]) => {
      const $ = nodesRan({ 'Import steps': [[{ json: {} }], lists], 'Versions now': [rows] });
      return { next: evaluate(cond, { $ }), page: render(completion('Approved meanwhile').completionMessage, { $ }) };
    };
    // Both pages were made when version 6 ran, so both show version 7. The first answer comes back: nothing has 7 yet.
    expect(after([list('feed', 7)], [row('feed', 5, 'superseded'), row('feed', 6)]).next).toBe(true);
    // The second answer, after the first one signed version 7 (or rejected it: a rejected row keeps its number).
    for (const status of ['active', 'rejected']) {
      const second = after([list('feed', 7)], [row('feed', 6, 'superseded'), row('feed', 7, status)]);
      expect(second.next).toBe(false);
      expect(second.page.split('\n')).toEqual([
        'Nothing was signed or rejected. While this page was open, another version of feed (version 7) was approved or rejected.',
        'Open the form again and start again: it shows the version that runs now.',
      ]);
    }
    // A new bot (an empty table, which still gives one empty item) and another name's rows do not stop it.
    expect(after([list('feed', 1)], [{ json: {} }]).next).toBe(true);
    expect(after([list('feed', 1)], [row('other', 9)]).next).toBe(true);
    // Several step lists: any one taken stops them all, and the page names it, escaped.
    const many = after([list('feed-1', 8), list('feed <2>', 8)], [row('feed-1', 7), row('feed <2>', 8)]);
    expect(many.next).toBe(false);
    expect(many.page.split('\n')[0]).toBe('Nothing was signed or rejected. While this page was open, another version of feed &lt;2&gt; (version 8) was approved or rejected.');
    // The completion page ends the run: nothing after it.
    expect(completion('Approved meanwhile')).toMatchObject({ operation: 'completion', respondWith: 'text', completionTitle: 'Approved or rejected meanwhile' });
  });

  it('a file uploaded under the name of an approved bot is its next version, and the review page and the last page say which version it replaces', () => {
    const get = byName(t, 'Running versions');
    expect(get).toMatchObject({ type: DATA_TABLE, typeVersion: 1.1, alwaysOutputData: true });
    expect(get).not.toHaveProperty('onError');
    expect(table(get)).toEqual(table(byName(t, 'Approved bots')));
    expect(byName(t, 'What it replaces')).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const upload = formItem('Step document', Buffer.from('{}'));
    /** The file path as n8n's expressions see it, with Running versions giving `rows`. */
    const filePath = (rows: IDataObject[]) => {
      const ran: Record<string, INodeExecutionData[][]> = { Settings: [[{ json: { ...upload.json, ...settingsJson() } }]], 'Running versions': [rows.map((json) => ({ json }))] };
      const code = String(byName(t, 'What it replaces').parameters.jsonOutput);
      expect(code.replace(/^=\{\{/, '').replace(/\}\}$/, '')).not.toMatch(/\{\{|\}\}/);
      ran['What it replaces'] = [[{ json: evaluate(code, { $: nodesRan(ran) }) as IDataObject }]];
      return ran;
    };
    const row = (name: string, version: number, status = 'active'): IDataObject => ({ id: version, name, version, steps: '{}', signature: 's', approvedBy: APPROVER, status });
    // Version 4 runs: before this change the upload was version 1 and superseded it. Now it is version 5.
    const ran = filePath([row('line-item-export', 3, 'superseded'), row('line-item-export', 4), row('other', 9)]);
    expect(ran['What it replaces'][0][0].json).toEqual({ running: [{ name: 'line-item-export', version: 4, steps: '{}', signature: 's', approvedBy: APPROVER }], next: 5 });
    expect(resolved(upload, ran)).toMatchObject({ stepsName: 'line-item-export', options: { version: 5 } });
    // The step lists an import names after it (a UiPath project's line-item-export-1, -2) count; another name does not.
    const many = filePath([row('line-item-export-1', 3), row('line-item-export-2', 7), row('line-item-exporter', 12), row('line-item-export-x', 11)]);
    expect((many['What it replaces'][0][0].json.running as IDataObject[]).map((r) => r.name)).toEqual(['line-item-export-1', 'line-item-export-2']);
    expect(resolved(upload, many)).toMatchObject({ options: { version: 8 } });
    // Nothing runs under the name (a new n8n: the table was just made, empty): version 1, and no word about replacing.
    for (const rows of [[], [{}]]) {
      const none = filePath(rows);
      expect(none['What it replaces'][0][0].json).toEqual({ running: [], next: 1 });
      expect(resolved(upload, none)).toMatchObject({ options: { version: 1 } });
    }
    // A rejected attempt keeps its number: the next one takes the number after the highest any row of the name has
    // (active, rejected or superseded), and what it replaces is still the version that runs.
    const rejected = filePath([row('line-item-export', 4, 'rejected')]);
    expect(rejected['What it replaces'][0][0].json).toEqual({ running: [], next: 5 });
    expect(resolved(upload, rejected)).toMatchObject({ options: { version: 5 } });
    const again = filePath([row('line-item-export', 3, 'superseded'), row('line-item-export', 4), row('line-item-export', 5, 'rejected'), row('line-item-export', 6, 'rejected')]);
    expect((again['What it replaces'][0][0].json.running as IDataObject[]).map((r) => r.version)).toEqual([4]);
    expect(resolved(upload, again)).toMatchObject({ options: { version: 7 } });
    expect(resolved(upload)).toMatchObject({ options: { version: 1 } });

    // The review page: its title, and each block of several, name the version it replaces.
    const list = (name: string, version: number) => ({ json: { name, version, baseVersion: null, steps: { startUrl: SITE.url, steps: [] }, reviewSteps: [], safetyFlags: [] } });
    const title = (r: Record<string, INodeExecutionData[][]>) => evaluate(String((review.parameters.options as IDataObject).formTitle), { $: nodesRan(r) });
    expect(title({ ...ran, 'Import steps': [[{ json: {} }], [list('line-item-export', 5)]] })).toBe('line-item-export, version 5, replacing version 4');
    expect(title({ ...filePath([]), 'Import steps': [[{ json: {} }], [list('line-item-export', 1)]] })).toBe('line-item-export, version 1');
    // After rejected attempts: the next number, replacing the version that runs (not the number minus one).
    expect(title({ ...again, 'Import steps': [[{ json: {} }], [list('line-item-export', 7)]] })).toBe('line-item-export, version 7, replacing version 4');
    const blocks = reviewFields({ $: nodesRan({ ...many, 'Import steps': [[{ json: {} }], [list('line-item-export-1', 8), list('line-item-export-3', 8)]] }) })
      .filter((f) => f.fieldType === 'html').map((f) => /<h3>(.*?)<\/h3>/.exec(String(f.html))?.[1]);
    expect(blocks).toEqual(['1 of 2: line-item-export-1, version 8, replacing version 3', '2 of 2: line-item-export-3, version 8']);
    // Each step list's part of the review page says how that list differs from its own running version, with the change
    // path's words and its name: the same comparison (one function body, called per list with its running row and the
    // steps the import built). A list without a running version is new and gets no line; nothing goes in the page's top.
    const fn = String(byName(t, COMPARED).parameters.jsonOutput);
    expect(fn.split('((bot, typed) => { ')).toHaveLength(2);
    const body = fn.slice(fn.indexOf('((bot, typed) => { ') + '((bot, typed) => { '.length, fn.lastIndexOf('})('));
    expect(body).toMatch(/^const n = String\(bot\.version\); /);
    expect(String(byName(t, RUNNING).parameters.jsonOutput)).toContain(`(bot, typed) => { ${body}}`);
    expect(String(byName(t, RUNNING).parameters.jsonOutput).split('const n = String(bot.version)')).toHaveLength(2);
    expect(byName(t, RUNNING)).toMatchObject({ type: 'n8n-nodes-base.set', typeVersion: 3.4, executeOnce: true, parameters: { mode: 'raw' } });
    const doc = (to: string, name: string) => ({ startUrl: SITE.url, name, steps: [{ intent: 'Open the report', goto: `${SITE.url}/r` }, { intent: 'Type the To date', fill: { selector: '#to', value: to } }] });
    const stored = (name: string, version: number, to: string) => ({ ...row(name, version), steps: JSON.stringify({ ...doc(to, name), version }) });
    const imported = (name: string, to: string, version = 9) => ({ json: { ...list(name, version).json, steps: { ...doc(to, name), version } } });
    /** The review page after Compared with the running version: its top field, and each list's part. */
    const page = (rows: IDataObject[], lists: { json: IDataObject }[]) => {
      const r = { ...filePath(rows), 'Import steps': [[{ json: {} }], lists] } as Record<string, INodeExecutionData[][]>;
      const after = { ...r, [RUNNING]: [[{ json: evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan(r) }) as IDataObject }]] };
      const fields = jsonFormFields(String(review.parameters.jsonOutput), { $: nodesRan(after) });
      const lines = fields.slice(1).filter((f) => f.fieldType === 'html' && /<ol>/.test(String(f.html))).map((f) => /^(?:<h3>.*?<\/h3>)?(?:<p><b>(.*?)<\/b><\/p>)?/.exec(String(f.html))?.[1] ?? null);
      return { item: after[RUNNING][0][0].json, top: String(fields[0].html), lines };
    };
    // One list (as the pickup found it): the To date taken back from 2026-09-15 to 2026-09-30 is step 2.
    const one = page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-30', 5)]);
    // The page shows the line escaped, as it escapes everything else.
    expect(one.lines).toEqual(['line-item-export: changed from the approved version 4: step 2: typed value &quot;2026-09-15&quot; → &quot;2026-09-30&quot;.']);
    expect(one.top).toMatch(/^<p>Signs for /);
    expect(page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-15', 5)]).lines).toEqual(['line-item-export: unchanged from the approved version 4.']);
    // Two lists (a project's -1 and -2): each compared with its own version, one unchanged and one changed.
    const two = page([stored('line-item-export-1', 3, '2026-09-15'), stored('line-item-export-2', 7, '2026-09-15')], [imported('line-item-export-1', '2026-09-15'), imported('line-item-export-2', '2026-09-30')]);
    expect(two.lines).toEqual(['line-item-export-1: unchanged from the approved version 3.', 'line-item-export-2: changed from the approved version 7: step 2: typed value &quot;2026-09-15&quot; → &quot;2026-09-30&quot;.']);
    expect(two.top).toMatch(/^<p>Signs for /);
    // Only the second has a running version: the first is new and says nothing about a comparison.
    const second = page([stored('line-item-export-2', 7, '2026-09-15')], [imported('line-item-export-1', '2026-09-15'), imported('line-item-export-2', '2026-09-15')]);
    expect(second.lines).toEqual([null, 'line-item-export-2: unchanged from the approved version 7.']);
    expect(second.item).toEqual({ lists: [{ name: 'line-item-export-2', unchanged: true, compared: 'line-item-export-2: unchanged from the approved version 7.' }] });
    // Stored steps that do not parse, or two lists of one name: could not be compared, never unchanged.
    expect(page([{ ...row('line-item-export', 4), steps: '{broken' }], [imported('line-item-export', '2026-09-15', 5)]).lines).toEqual(['line-item-export: could not be compared with the approved version 4: read every step.']);
    expect(page([stored('line-item-export', 4, '2026-09-15')], [imported('line-item-export', '2026-09-15', 5), imported('line-item-export', '2026-09-15', 5)]).lines)
      .toEqual(Array(2).fill('line-item-export: could not be compared with the approved version 4: two step lists have this name. Read every step.'));
    // A new bot: no line anywhere.
    expect(page([], [imported('line-item-export', '2026-09-30', 1)]).item).toEqual({ lists: [] });
    // Desktop steps: the approved version holds which steps are writes (chosen on the review page); a file never does.
    // That mark alone is not a change, the line says that it is not compared, and a real change is still named by its step.
    const desk = (save: string, write: boolean) => ({ surface: 'desktop', name: 'line-item-export', app: { exe: 'ErpDemo.exe' }, steps: [{ intent: 'Type the date', fill: { uia: { path: [{ name: 'To' }] }, value: '2026-09-30' } }, { intent: 'Click Save', click: { uia: { path: [{ name: save }] } }, ...(write ? { write: true } : {}) }] });
    const deskRow = (save: string) => ({ ...row('line-item-export', 3), steps: JSON.stringify({ ...desk(save, true), version: 3 }) });
    const deskFile = (save: string) => ({ json: { ...list('line-item-export', 4).json, steps: { ...desk(save, false), version: 4 } } });
    const NOT_COMPARED = ' Which steps are writes is not compared: it is chosen again on this page.';
    expect(page([deskRow('Save')], [deskFile('Save')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: `line-item-export: unchanged from the approved version 3.${NOT_COMPARED}` }] });
    expect(page([deskRow('Save')], [deskFile('Save all')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: false, compared: `line-item-export: changed from the approved version 3: step 2: control name "Save" → "Save all".${NOT_COMPARED}` }] });
    // A file that carries a mark of its own, where the approved version has none: the same, and the line still says so.
    const marked = { json: { ...list('line-item-export', 4).json, steps: { ...desk('Save', true), version: 4 } } };
    const plainRow = { ...row('line-item-export', 3), steps: JSON.stringify({ ...desk('Save', false), version: 3 }) };
    expect(page([plainRow], [marked]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: `line-item-export: unchanged from the approved version 3.${NOT_COMPARED}` }] });
    expect(page([plainRow], [deskFile('Save')]).item).toEqual({ lists: [{ name: 'line-item-export', unchanged: true, compared: 'line-item-export: unchanged from the approved version 3.' }] });
    // Only a step's own mark is left out: a field named write deeper in a step still counts.
    const deep = { json: { ...list('line-item-export', 4).json, steps: { ...desk('Save', false), version: 4, steps: [desk('Save', false).steps[0], { ...desk('Save', false).steps[1], click: { uia: { path: [{ name: 'Save' }] }, write: true } }] } } };
    expect(page([deskRow('Save')], [deep]).item).toMatchObject({ lists: [{ unchanged: false, compared: `line-item-export: changed from the approved version 3: step 2: write (none) → true.${NOT_COMPARED}` }] });
    // The change path keeps its own line at the top (Compared with the approved version); this node finds no upload there.
    expect(evaluate(String(byName(t, RUNNING).parameters.jsonOutput), { $: nodesRan({ Settings: [[{ json: { name: 'line-item-export' } }]], 'Import steps': [[{ json: {} }], [imported('line-item-export', '2026-09-30')]] }) })).toEqual({ lists: [] });
    // The version that runs is what Sign steps checks before the review page, as on a change.
    expect(evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $: nodesRan(ran) })).toEqual({ name: 'line-item-export', version: 4, steps: '{}', signature: 's', approvedBy: APPROVER });
    expect(evaluate(String(byName(t, 'The approved version').parameters.jsonOutput), { $: nodesRan(filePath([])) })).toEqual({});

    // The last page: approved, it replaces version 4; rejected or refused, version 4 keeps running.
    const last = (signed: IDataObject[], errors: IDataObject[] = []) => render(completion('Imported').completionMessage, { $: nodesRan({
      ...ran, 'Import steps': [[{ json: { drafts: [{ name: 'line-item-export', forApproval: true }], report: { steps: 1, items: [] } } }], [list('line-item-export', 5)]],
      [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [signed.map((json) => ({ json })), errors.map((json) => ({ json }))],
    }) }).split('\n').slice(1);
    expect(last([{ status: 'active', name: 'line-item-export', version: 5 }])[0]).toBe('Approved and signed: line-item-export version 5 is now the version that runs, replacing version 4.');
    expect(last([{ status: 'rejected', name: 'line-item-export', version: 5 }])[0]).toBe('Rejected: line-item-export version 5. Nothing was signed. Version 4 keeps running.');
    expect(last([], [{ error: 'Sign Steps refused: a reason', details: { name: 'line-item-export', version: 5 } }]).slice(0, 2))
      .toEqual(['Not signed: line-item-export version 5. Sign Steps refused: a reason.', 'Nothing changed: line-item-export version 4 keeps running.']);
    // Approved, Supersede older versions turns version 4 superseded (an upload is a first version: every older active row).
    const supersede = table(byName(t, 'Supersede older versions')).filters!.conditions;
    const lte = supersede.find((c) => c.condition === 'lte')!;
    expect(evaluate(String(lte.keyValue), { $: () => ({ item: { json: { baseVersion: null, version: 5 } } }) })).toBe(2147483647);
  });

  it('a member who may not approve: the last page ends its sentence, says whom to ask, and points to no execution', () => {
    const POINTER = 'The full report is on the Data output of Import steps in this execution.';
    const page = (error: string) => render(completion('Imported').completionMessage, { $: nodesRan({
      Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts: [{ name: 'feed', forApproval: true }] } }], []],
      [REVIEW]: [[{ json: { decision_0: 'Approve and sign' } }]], 'Sign steps': [[], [{ json: { error, details: { name: 'feed', version: 1 } } }]],
    }) }).split('\n');
    const member = page('Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist');
    expect(member).toEqual(['Imported: 2 steps.', 'Not signed: feed version 1. Sign Steps refused: The n8n user who submitted the approval form is not on the Approver Allowlist. Ask the person who set up this form to approve it, or to put you on its Approver Allowlist.']);
    expect(page('Sign Steps refused: Approved By is not on the Approver Allowlist').join('\n')).not.toContain(POINTER);
    // Any other refusal: the owner reads the execution, so the page still says where the full report is.
    expect(page('Sign Steps refused: the steps do not match the hash that was reviewed')).toEqual(['Imported: 2 steps.', 'Not signed: feed version 1. Sign Steps refused: the steps do not match the hash that was reviewed.', POINTER]);
    // A reason that ends its own sentence gets no second full stop.
    expect(page('Sign Steps refused: the steps changed.')[1]).toBe('Not signed: feed version 1. Sign Steps refused: the steps changed.');
    // A deliberate Reject, with every step list decided: the page does not point to the reason for a step list that
    // failed. When one did fail its replay, it does.
    const decided = (drafts: IDataObject[]) => render(completion('Imported').completionMessage, { $: nodesRan({
      Settings: [[{ json: settingsJson() }]], 'Import steps': [[{ json: { report: { steps: 2, items: [] }, drafts } }], []],
      [REVIEW]: [[{ json: { decision_0: 'Reject' } }]], 'Sign steps': [[{ json: { status: 'rejected', name: 'feed', version: 1 } }], []],
    }) }).split('\n');
    expect(decided([{ name: 'feed', adopted: true }])).toEqual(['Imported: 2 steps.', '1 of 1 step list passed the replay.', 'Rejected: feed version 1. Nothing was signed.', POINTER]);
    expect(decided([{ name: 'feed', adopted: true }, { name: 'feed-2', reason: 'no download' }]).at(-1))
      .toBe('The full report, and the reason for any step list that could not be proved, is on the Data output of Import steps in this execution.');
  });

  it('has the stickies: About (grey), Set once (green, a checklist), Approval by email (grey, the option), Why approval (grey)', () => {
    expect(sticky(t, 'About this workflow').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Set once').color).toBe(COLOUR.green);
    expect(sticky(t, 'Approval by email').color).toBe(COLOUR.grey);
    expect(sticky(t, 'Why approval').color).toBe(COLOUR.grey);
    // Five sentences. The wait after Submit is said before it, so the spinner is expected. What is replayed, what is
    // not and how step lists are named are on the review page and in move-a-bot.md.
    const form = (byName(t, 'Import a bot').parameters as { formDescription?: string }).formDescription ?? '';
    expect(form).toBe('Upload a bot: an RPA recording, a UiPath project (ZIP or XAML), a Chrome Recorder export (JSON), Playwright code, or steps you wrote (JSON). After Submit, the import takes up to about half a minute: it runs a browser bot\'s steps twice, to prove them. You review every step on the next page. Nothing is signed until you approve it. To change an approved bot, or sign it again after the signing key changed, leave Bot file empty and type its name.');
    const about = sticky(t, 'About this workflow').content;
    for (const s of ['Chrome Recorder', 'Playwright code', 'UiPath', 'RPA: 2 Data feed', 'each step list gets its own approval',
      '**step document**', 'this is how hand-written steps get approved and signed']) expect(about, s).toContain(s);
    const set = sticky(t, 'Set once').content;
    expectChecklist(set);
    for (const s of ['opens with your n8n sign-in', 'set its **Authentication** to Basic Auth and pick or create a Basic Auth credential', '**RPA Browser**', '**RPA Site Login**',
      '**RPA Step Signing**', '**Sign steps → Approver Allowlist**', '**Options → Allow Private Network**', 'Publish']) expect(set, s).toContain(s);
    expect(set).toContain('type the n8n address of each person who may approve');
    expect(set).toContain('With Basic Auth, type your address once: it is recorded as the approver.');
    expect(set).not.toContain('Settings → approver');
    // The default path needs no other template.
    expect(set).not.toContain('RPA: 3');
    const email = sticky(t, 'Approval by email').content;
    for (const s of ['**RPA: 3 Approve steps**', 'publish it', 'In **Approve steps**, choose **RPA: 3 Approve steps**, then turn the node on', 'set `approval` to `by email`']) expect(email, s).toContain(s);
    const why = sticky(t, 'Why approval').content;
    for (const s of ['never', 'Sign Steps', 'password', 'the review page ticks the steps that may save, send or submit']) expect(why, s).toContain(s);
  });
});
