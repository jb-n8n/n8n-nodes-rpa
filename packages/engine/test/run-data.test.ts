import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal, SANDBOX } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { Step } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS } from './helpers.js';
import { classifyFailure, toErrorCode } from '../src/classify/classify.js';
import { locatorNotUnique, tooManyRows } from '../src/messages.js';
import type { ExtractSpec } from '../src/types.js';
import { publicPolicy } from './helpers.js';
import { MAX_REGEX_SUBJECT, regexMatches, regexSubject } from '../src/steps/limits.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

async function loggedIn(): Promise<StepContext> {
  session = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker: createMasker([]) });
  const ctx: StepContext = {
    page: session.page, script: baselineScript(portal.url), policy: policyFor(portal), secrets: SECRETS,
    vars: {}, masker: createMasker([]), defaultTimeoutMs: 3000, violations: session.violations,
  };
  await session.page.goto(`${portal.url}/acme/login`);
  await session.page.fill('#username', SANDBOX.username);
  await session.page.fill('#password', SANDBOX.password);
  await session.page.click('#sign-in');
  await session.page.waitForSelector('body[data-page=home]');
  return ctx;
}

const NOTICES = '/acme/service/recalls-and-stop-sales';
const readAll = (textMode: 'text' | 'textContent'): Step => ({
  intent: 'Read all pages',
  paginate: { next: { text: 'Next page' }, until: 'absent', max: 5, each: [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode } }] },
});
const sorted = (a: string[]) => [...a].sort();

describe('data steps', () => {
  it('reads all seven notices across two pages', async () => {
    portal.setState({ paginate: true });
    const ctx = await loggedIn();
    try {
      const r = await runSteps(ctx, [{ intent: 'Open', goto: NOTICES }, readAll('text')]);
      expect(r.ok).toBe(true);
      expect(sorted(r.state.rows.map((x) => x.id))).toEqual(sorted(SANDBOX.bulletins));
      expect(r.state.evidence).toHaveLength(2);
      expect(r.state.evidence[1].text).toContain('of 7');
    } finally { await session.close(); }
  });
  it('textContent keeps inline tags joined but separates table cells', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><table><tr><td>N26-<mark>0417</mark></td><td>2026-10-<b>02</b></td></tr></table></main>');
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}', textMode: 'textContent' } }]);
      expect(r.ok).toBe(true);
      expect(r.state.rows.map((x) => x.id)).toEqual(['N26-0417']);
      expect(r.state.evidence[0].text).toContain('N26-0417 2026-10-02');
    } finally { await session.close(); }
  });
  it('accordion: innerText misses closed details, textContent and clickAll do not', async () => {
    portal.setState({ render: 'accordion' });
    const ctx = await loggedIn();
    try {
      const closed = await runSteps(ctx, [{ intent: 'Open', goto: NOTICES }, readAll('text')]);
      expect(closed.state.rows).toHaveLength(0);
      const viaContent = await runSteps(ctx, [readAll('textContent')]);
      expect(viaContent.state.rows).toHaveLength(7);
      const viaClick = await runSteps(ctx, [
        { intent: 'Open all', clickAll: { target: { css: 'details > summary' }, max: 20 } },
        readAll('text'),
      ]);
      expect(viaClick.state.rows).toHaveLength(7);
    } finally { await session.close(); }
  });
  it('extracts fields per item and skips items without an ID', async () => {
    portal.setState({ render: 'cards' });
    const ctx = await loggedIn();
    try {
      const r = await runSteps(ctx, [
        { intent: 'Open', goto: NOTICES },
        { intent: 'Read cards', extract: { scope: { css: 'main' }, item: { css: '.card' }, idPattern: 'N26-\\d{4}', fields: { title: { locator: { css: 'h3' } }, type: { pattern: '(Recall|Stop-Sale)' } } } },
      ]);
      expect(r.ok).toBe(true);
      expect(r.state.rows).toHaveLength(7);
      expect(r.state.rows.find((x) => x.id === 'N26-0417')).toEqual({ id: 'N26-0417', title: 'Rear seat belt buckle may not latch', type: 'Stop-Sale' });
    } finally { await session.close(); }
  });
  it('fails at max instead of looping forever on a Next control that never disappears', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p id="c">page 0 N26-0001</p><button onclick="const c=document.getElementById(\'c\');const n=Number(c.textContent.split(\' \')[1])+1;c.textContent=\'page \'+n+\' N26-000\'+(n%10)">Next page</button></main>');
      const r = await runSteps(ctx, [readAll('text')]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('paginate: still a next page after 5 pages');
    } finally { await session.close(); }
  });
  it('fails when clicking next changes nothing', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p>N26-0001</p><button>Next page</button></main>');
      const r = await runSteps(ctx, [{ ...readAll('text'), timeoutMs: 500 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('paginate: page did not change after clicking next');
    } finally { await session.close(); }
  });
  it('masks secrets in evidence and rows', async () => {
    const ctx = await loggedIn();
    try {
      ctx.masker = createMasker(['SEKRET-123']);
      await ctx.page.setContent('<main><p>N26-0001 token SEKRET-123 here</p></main>');
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'main' }, item: { css: 'p' }, idPattern: 'N26-\\d{4}', fields: { note: { pattern: '(token \\S+)' } } } }]);
      expect(r.ok).toBe(true);
      const dump = JSON.stringify(r.state.evidence) + JSON.stringify(r.state.rows);
      expect(dump).not.toContain('SEKRET-123');
      expect(dump).toContain('[secret]');
    } finally { await session.close(); }
  });
  it('clickAll fails when there are more matches than max', async () => {
    portal.setState({ render: 'accordion' });
    const ctx = await loggedIn();
    try {
      const r = await runSteps(ctx, [{ intent: 'Open', goto: NOTICES }, { intent: 'Open all', clickAll: { target: { css: 'details > summary' }, max: 3 } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('clickAll: 7 matches is more than max 3');
    } finally { await session.close(); }
  });
  it('clickAll fails when nothing matches', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p>nothing</p></main>');
      const r = await runSteps(ctx, [{ intent: 'Open all', timeoutMs: 300, clickAll: { target: { css: 'details > summary' }, max: 3 } }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toBe('clickAll: no matching elements');
    } finally { await session.close(); }
  });
  it('paginate until disabled reads both pages', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p id="c">N26-0001</p><button onclick="document.getElementById(\'c\').textContent=\'N26-0002\';this.disabled=true">Next page</button></main>');
      const step: Step = { intent: 'Read all', paginate: { next: { text: 'Next page' }, until: 'disabled', max: 5, each: [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }] } };
      const r = await runSteps(ctx, [step]);
      expect(r.ok).toBe(true);
      expect(sorted(r.state.rows.map((x) => x.id))).toEqual(['N26-0001', 'N26-0002']);
    } finally { await session.close(); }
  });
  it('reports the fallback candidate a paginate needed for its next control', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p id="c">N26-0001</p><button onclick="document.getElementById(\'c\').textContent=\'N26-0002\';this.remove()">Next page</button></main>');
      const step: Step = { intent: 'Read all', paginate: { next: { text: 'Gone', fallbacks: [{ text: 'Next page' }] }, until: 'absent', max: 5, nextWaitMs: 300, each: [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }] } };
      const r = await runSteps(ctx, [step]);
      expect(r.ok).toBe(true);
      expect(sorted(r.state.rows.map((x) => x.id))).toEqual(['N26-0001', 'N26-0002']);
      expect(r.state.log.find((e) => e.intent === 'Read all')?.candidate).toBe(1);
    } finally { await session.close(); }
  });
  it('dedupes rows that repeat across pages', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p id="c">N26-0001 N26-0002</p><button onclick="document.getElementById(\'c\').textContent=\'N26-0002 N26-0003\';this.remove()">Next page</button></main>');
      const r = await runSteps(ctx, [readAll('text')]);
      expect(r.ok).toBe(true);
      expect(sorted(r.state.rows.map((x) => x.id))).toEqual(['N26-0001', 'N26-0002', 'N26-0003']);
    } finally { await session.close(); }
  });
  it('waits 1500 ms by default for a next control that renders late', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent(`<main><p id="c">N26-0001</p></main><script>
        setTimeout(() => {
          const b = document.createElement('button');
          b.textContent = 'Next page';
          b.onclick = () => { document.getElementById('c').textContent = 'N26-0002'; b.remove(); };
          document.querySelector('main').append(b);
        }, 1250);
      </script>`);
      const step: Step = { intent: 'Read all', paginate: { next: { text: 'Next page' }, until: 'absent', max: 5, each: [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }] } };
      const r = await runSteps(ctx, [step]);
      expect(r.ok).toBe(true);
      expect(sorted(r.state.rows.map((x) => x.id))).toEqual(['N26-0001', 'N26-0002']);
    } finally { await session.close(); }
  });
  it('keeps the prefix of nested detect failures so classification still sees it', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main><p>N26-0001</p><p id="expired">Session expired</p></main>');
      const step: Step = {
        intent: 'Read all',
        paginate: {
          next: { text: 'Next page' }, until: 'absent', max: 5, nextWaitMs: 0,
          each: [{ intent: 'Still signed in?', detect: { name: 'session', checks: { expired: { css: '#expired' }, ok: { css: 'main' } }, require: 'ok' } }],
        },
      };
      const r = await runSteps(ctx, [step]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('detected:expired');
    } finally { await session.close(); }
  });
  it('extract waits for script-rendered rows instead of reading an empty list', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main id="m">Loading…</main><script>setTimeout(() => { document.getElementById("m").textContent = "N26-0001 N26-0002"; }, 700)</script>');
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }]);
      expect(r.ok).toBe(true);
      expect(r.state.rows.map((x) => x.id)).toEqual(['N26-0001', 'N26-0002']);
    } finally { await session.close(); }
  });
  it('surfaces a failed scope read instead of reporting no rows', async () => {
    const ctx = await loggedIn();
    try {
      await ctx.page.setContent('<main>Loading…</main>');
      setTimeout(() => { void ctx.page.close(); }, 300);
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toMatch(/closed|Target|destroyed/i);
    } finally { await session.close().catch(() => undefined); }
  });
  it('a transient read error followed by success does not fail extract', async () => {
    const ctx = await loggedIn();
    try {
      // A second <main> appears right after the scope resolves (strict-mode error on read) and goes away again.
      await ctx.page.setContent('<main>Loading</main><script>setTimeout(() => { const m = document.createElement("main"); document.body.append(m); setTimeout(() => m.remove(), 400); }, 100); setTimeout(() => { document.querySelector("main").textContent = "N26-0001"; }, 700)</script>');
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'main' }, idPattern: 'N26-\\d{4}' } }]);
      expect(r.ok).toBe(true);
      expect(r.state.rows.map((x) => x.id)).toEqual(['N26-0001']);
    } finally { await session.close(); }
  });
});

describe('lists without an ID Pattern, attributes, per-item uniqueness and the row cap', () => {
  async function onPublic(path: string): Promise<StepContext> {
    const policy = publicPolicy(portal);
    session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    await session.page.goto(`${portal.url}${path}`);
    return {
      page: session.page, script: { startUrl: `${portal.url}${path}`, steps: [] }, policy, vars: {},
      masker: createMasker([]), defaultTimeoutMs: 3000, violations: session.violations,
    };
  }
  it('ID Pattern regexes see at most 1 MiB at a time; IDs-only extraction still scans all text in windows', async () => {
    expect(MAX_REGEX_SUBJECT).toBe(1024 * 1024);
    expect(regexSubject('a'.repeat(MAX_REGEX_SUBJECT + 5))).toHaveLength(MAX_REGEX_SUBJECT);
    // With small windows (20 characters, 8 of overlap): every match is delivered once, whole.
    const small = { size: 20, overlap: 8 };
    // Starts at 15, past the window's own part (20 - 8 = 12): window 0 sees "ID-12" cut off and drops it; window 1 sees it whole.
    expect([...regexMatches(`${'x'.repeat(15)}ID-12345${'y'.repeat(30)}`, 'ID-\\d+', small)]).toEqual(['ID-12345']);
    // Starts at 5: whole in window 0, never seen again.
    expect([...regexMatches(`${'x'.repeat(5)}ID-12345${'y'.repeat(30)}`, 'ID-\\d+', small)]).toEqual(['ID-12345']);
    const many = Array.from({ length: 30 }, (_, i) => `A${String(i).padStart(2, '0')}`);
    expect([...regexMatches(many.join('...'), 'A\\d\\d', small)]).toEqual(many);
    expect([...regexMatches('short ID-1 text', 'ID-\\d+')]).toEqual(['ID-1']);
    expect(() => [...regexMatches('x', 'x', { size: 10, overlap: 10 })]).toThrow();
    // Matches are produced one at a time, so a consumer that stops early never materialises the rest.
    const lazy = regexMatches('a'.repeat(3 * MAX_REGEX_SUBJECT), 'a');
    expect(Array.isArray(lazy)).toBe(false);
    let taken = 0;
    for (const _m of lazy) if (++taken === 5) break;
    expect(taken).toBe(5);
    const ctx = await onPublic('/public/table');
    try {
      // IDs at the start, straddling the first window edge and past 2 MiB; per item, an ID past the first MiB is not seen.
      await ctx.page.evaluate((mib) => {
        const scope = document.createElement('main');
        scope.id = 'ids';
        scope.textContent = `ID-0001 ${'x'.repeat(mib - 6)} ID-0002 ${'y'.repeat(mib)} ID-0003`;
        const ul = document.createElement('ul');
        ul.id = 'items';
        ul.innerHTML = `<li>ID-0101</li><li>${'z'.repeat(mib)} ID-0102</li>`;
        document.body.replaceChildren(scope, ul);
      }, 1024 * 1024);
      const r = await runSteps(ctx, [
        { intent: 'IDs', timeoutMs: 10_000, extract: { scope: { css: '#ids' }, idPattern: 'ID-\\d{4}', textMode: 'textContent' } },
        { intent: 'Items', timeoutMs: 10_000, extract: { scope: { css: '#items' }, item: { css: 'li' }, idPattern: 'ID-\\d{4}', textMode: 'textContent' } },
      ]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows.map((x) => x.id)).toEqual(['ID-0001', 'ID-0002', 'ID-0003', 'ID-0101']);
    } finally { await session.close(); }
  }, 60_000);
  it('a 2 MiB scope with far more IDs than the row cap stops at the cap with the limit failure', async () => {
    const ctx = await onPublic('/public/table');
    try {
      await ctx.page.evaluate((mib) => {
        const scope = document.createElement('main');
        scope.id = 'ids';
        scope.textContent = Array.from({ length: Math.ceil((2 * mib) / 7) }, (_, i) => `I${String(i % 100000).padStart(5, '0')}`).join(' ');
        document.body.replaceChildren(scope);
      }, 1024 * 1024);
      const r = await runSteps(ctx, [{ intent: 'IDs', timeoutMs: 10_000, extract: { scope: { css: '#ids' }, idPattern: 'I\\d{5}', textMode: 'textContent' } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(tooManyRows(10_000));
      expect(r.state.rows).toHaveLength(0);
    } finally { await session.close(); }
  }, 60_000);
  const FIELDS: ExtractSpec['fields'] = {
    title: { locator: { css: 'a.title' } },
    link: { locator: { css: 'a.title' }, attribute: 'href' },
    tooltip: { locator: { css: 'a.title' }, attribute: 'title' },
    image: { locator: { css: 'img.thumb' }, attribute: 'src' },
    alt: { locator: { css: 'img.thumb' }, attribute: 'alt' },
    price: { locator: { css: '.price' } },
  };
  const readList = (extra: Partial<ExtractSpec> = {}): Step => ({
    intent: 'Read the list', extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' }, fields: FIELDS, ...extra },
  });

  it('reads fields inside each item; href and src become absolute; rows have no id key', async () => {
    const ctx = await onPublic('/public/list?page=1');
    try {
      const r = await runSteps(ctx, [readList()]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows).toHaveLength(3);
      expect(r.state.rows[0]).toEqual({
        title: 'Blue mug', link: `${portal.url}/public/items/SKU-2001`, tooltip: 'Item SKU-2001',
        image: `${portal.url}/public/img/SKU-2001.png`, alt: 'Blue mug photo', price: '$4.00',
      });
      expect(r.state.rows.some((row) => 'id' in row)).toBe(false);
      expect(r.state.extractRan).toBe(true);
    } finally { await session.close(); }
  });
  it('with an ID Pattern each row also carries its id', async () => {
    const ctx = await onPublic('/public/list?page=1');
    try {
      const r = await runSteps(ctx, [readList({ idPattern: 'SKU-\\d{4}' })]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows.map((x) => x.id)).toEqual(['SKU-2001', 'SKU-2002', 'SKU-2003']);
      expect(r.state.rows[1]).toMatchObject({ id: 'SKU-2002', title: 'Red mug', price: '$4.50' });
    } finally { await session.close(); }
  });
  it('a field locator that matches twice inside one item is drift, naming the locator and the count', async () => {
    const ctx = await onPublic('/public/list-dup');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read', extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' }, fields: { price: { locator: { css: 'span.price' } } } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(locatorNotUnique('CSS Selector "span.price"', 2));
      expect(r.failure.message).toBe('CSS Selector "span.price" matches 2 elements. Use a more specific locator; it must match exactly one.');
      expect(toErrorCode(classifyFailure({ violations: [], failure: r.failure }))).toBe('drift_detected');
    } finally { await session.close(); }
  });
  it('paginates over two pages to five rows; a field with no match inside an item is empty', async () => {
    const ctx = await onPublic('/public/list?page=1');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read every page', paginate: { next: { css: 'a.next' }, until: 'absent', max: 5, nextWaitMs: 300, each: [readList()] } }]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows.map((x) => x.title)).toEqual(['Blue mug', 'Red mug', 'Green mug', 'Tea pot', 'Saucer']);
      expect(r.state.rows[4]).toMatchObject({ title: 'Saucer', price: '' });
      expect(r.state.evidence).toHaveLength(2);
    } finally { await session.close(); }
  });
  it('more than 10000 rows fails with the limit message; 10000 rows do not', async () => {
    const items: Step = { intent: 'Read the rows', extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' } } };
    let ctx = await onPublic('/public/many?n=10001');
    try {
      const r = await runSteps(ctx, [items]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(tooManyRows(10_000));
      expect(r.failure.message).toBe('limit: more than 10000 rows');
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('incomplete');
    } finally { await session.close(); }
    ctx = await onPublic('/public/many?n=10000');
    try {
      const r = await runSteps(ctx, [items]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows).toHaveLength(10_000);
      expect(r.state.rows[0].text).toMatch(/^ROW-\d+$/);
    } finally { await session.close(); }
  });
  it('a 5xx from goto names the page without its query string', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const r = await runSteps(ctx, [{ intent: 'Open', goto: `${portal.url}/public/error?token=abc` }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(`HTTP 500 at ${portal.url}/public/error`);
    } finally { await session.close(); }
  });
  it('an optional step never swallows a limit: failure', async () => {
    const ctx = await onPublic('/public/many?n=10001');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read the rows', optional: true, extract: { scope: { css: 'ul.items' }, item: { css: 'li.item' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(tooManyRows(10_000));
      expect(r.state.rows).toEqual([]);
      expect(r.state.log[0]).toMatchObject({ status: 'failed', note: tooManyRows(10_000) });
    } finally { await session.close(); }
  });
  it('without an ID Pattern, extract stops waiting as soon as the empty-page text shows', async () => {
    const ctx = await onPublic('/public/list-empty');
    try {
      ctx.emptyPattern = 'No results found';
      const t0 = Date.now();
      const r = await runSteps(ctx, [{ intent: 'Read', timeoutMs: 5000, extract: { scope: { css: 'body' }, item: { css: 'li.item' } } }]);
      expect(r.ok).toBe(true);
      expect(r.state.rows).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally { await session.close(); }
  });
});
