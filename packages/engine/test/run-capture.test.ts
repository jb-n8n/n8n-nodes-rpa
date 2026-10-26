import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { classifyFailure, shownFailure, toErrorCode } from '../src/classify/classify.js';
import { runScriptLane, type ScriptLaneInput } from '../src/lane/script-lane.js';
import {
  captureTooLarge, elementTooTall, FRAME_NOT_CHECKED, locatorNotUnique, NOT_A_TABLE, PAGE_SHOWS_CREDENTIAL, PDF_NEEDS_HEADLESS, PDF_TIMED_OUT,
  runBinaryTooLarge, screenshotTooTall,
} from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import { MAX_CAPTURE_BYTES, MAX_SCREENSHOT_HEIGHT, MAX_TEXT_BYTES, tableHeaders, truncateUtf8 } from '../src/steps/handlers/capture.js';
import { MAX_ROW_TEXT_BYTES, MAX_RUN_BINARY_BYTES, runBinaryBytes, runBinaryProblem } from '../src/steps/limits.js';
import { MIME } from '../src/steps/handlers/files.js';
import { newRunState, runSteps, type StepContext } from '../src/steps/run.js';
import type { RunState, Step } from '../src/types.js';
import { LOCAL, publicPolicy, SECRETS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

async function onPublic(path: string, over: Partial<StepContext> = {}): Promise<StepContext> {
  const policy = publicPolicy(portal);
  session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
  await session.page.goto(`${portal.url}${path}`);
  return {
    page: session.page, script: { startUrl: `${portal.url}${path}`, steps: [] }, policy, vars: {},
    masker: createMasker([]), defaultTimeoutMs: 3000, violations: session.violations, ...over,
  };
}
const publicRun = (script: unknown, over: Partial<ScriptLaneInput> = {}): ScriptLaneInput => ({
  script, trust: { required: false }, policy: publicPolicy(portal), endpoint: LOCAL, defaultStepTimeoutMs: 3000, saveTrace: 'never', ...over,
});
const open = (path: string): Step => ({ intent: 'Open the page', goto: `${portal.url}${path}` });
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
function mediaBox(pdf: Buffer): { w: number; h: number } {
  const m = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('the PDF has no MediaBox');
  return { w: Number(m[1]), h: Number(m[2]) };
}

describe('screenshot', () => {
  it('captures the full page, the viewport or one element as PNG, named by step index', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const r = await runSteps(ctx, [
        { intent: 'Whole page', screenshot: { capture: 'full' } },
        { intent: 'What is visible', screenshot: { capture: 'viewport' } },
        { intent: 'The table', screenshot: { capture: 'element', element: { css: 'table.results' } } },
      ]);
      if (!r.ok) throw new Error(r.failure.message);
      const [full, view, el] = r.state.outputs;
      for (const o of [full, view, el]) {
        expect(o.verb).toBe('screenshot');
        expect(o.binary?.data.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
        expect(o.binary?.mimeType).toBe(MIME.png);
      }
      expect([full, view, el].map((o) => [o.index, o.binary?.name, o.binary?.fileName])).toEqual([
        [0, 'screenshot_0', 'screenshot_0.png'], [1, 'screenshot_1', 'screenshot_1.png'], [2, 'screenshot_2', 'screenshot_2.png'],
      ]);
      const viewport = ctx.page.viewportSize() as { width: number; height: number };
      expect(pngSize(view.binary!.data)).toEqual(viewport);
      expect(pngSize(el.binary!.data).width).toBeLessThan(viewport.width);
      expect(r.state.log.map((e) => e.output)).toEqual([{ binary: 'screenshot_0' }, { binary: 'screenshot_1' }, { binary: 'screenshot_2' }]);
    } finally { await session.close(); }
  });
  it('a page taller than 16384 px fails incomplete with the limit named and its prefix not shown', async () => {
    const r = await runScriptLane(publicRun([open('/public/tall'), { intent: 'Whole page', screenshot: { capture: 'full' } }]));
    if (r.ok) throw new Error('expected failure');
    expect(r.code).toBe('incomplete');
    const m = /^the page is (\d+) px tall; screenshots are limited to 16384 px$/.exec(r.message);
    expect(m).not.toBeNull();
    const h = Number((m as RegExpExecArray)[1]);
    expect(h).toBeGreaterThanOrEqual(20_000);
    expect(r.message).toBe(screenshotTooTall(h).slice('limit: '.length));
    expect(r.failure?.message).toBe(screenshotTooTall(h));
    expect(MAX_SCREENSHOT_HEIGHT).toBe(16_384);
  });
  it('the size limits are named exactly', () => {
    expect(MAX_CAPTURE_BYTES).toBe(52_428_800);
    expect(captureTooLarge('screenshot', 52_428_801)).toBe('limit: the screenshot is 52428801 bytes; the limit is 52428800 bytes');
    expect(captureTooLarge('PDF', 60_000_000)).toBe('limit: the PDF is 60000000 bytes; the limit is 52428800 bytes');
  });
  it('with a Site Login, a screenshot or PDF of a page that shows a secret is a policy violation', async () => {
    for (const step of [{ intent: 'Shot', screenshot: { capture: 'viewport' } }, { intent: 'Print', pdf: {} }] as Step[]) {
      const ctx = await onPublic(`/public/echo?text=${SECRETS.username}`, { secrets: SECRETS, masker: createMasker([SECRETS.username, SECRETS.password]) });
      try {
        const r = await runSteps(ctx, [step]);
        if (r.ok) throw new Error('expected failure');
        expect(r.failure.message).toBe(PAGE_SHOWS_CREDENTIAL);
        expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'secret', fatal: true, url: `${portal.url}/public/echo` }));
        expect(toErrorCode(classifyFailure({ violations: ctx.violations, failure: r.failure }))).toBe('policy_violation');
        expect(r.state.outputs).toEqual([]);
      } finally { await session.close(); }
    }
  });
  it('without a Site Login there is no secret check', async () => {
    const ctx = await onPublic(`/public/echo?text=${SECRETS.username}`);
    try {
      const r = await runSteps(ctx, [{ intent: 'Shot', screenshot: { capture: 'viewport' } }]);
      expect(r.ok).toBe(true);
      expect(r.state.outputs).toHaveLength(1);
    } finally { await session.close(); }
  });
});

describe('pdf', () => {
  it('prints A4 by default and Letter when asked, and passes Print Background through', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const calls: unknown[] = [];
      const original = ctx.page.pdf.bind(ctx.page);
      Object.assign(ctx.page, { pdf: async (o: Parameters<typeof original>[0]) => { calls.push(o); return original(o); } });
      const r = await runSteps(ctx, [{ intent: 'A4', pdf: {} }, { intent: 'Letter', pdf: { paper: 'Letter', background: true } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [a4, letter] = r.state.outputs;
      expect(a4.binary?.data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(a4.binary).toMatchObject({ name: 'pdf_0', fileName: 'pdf_0.pdf', mimeType: MIME.pdf });
      expect(letter.binary?.name).toBe('pdf_1');
      const a = mediaBox(a4.binary!.data);
      expect(Math.abs(a.w - 595.92)).toBeLessThan(2);
      expect(Math.abs(a.h - 842.88)).toBeLessThan(2);
      expect(mediaBox(letter.binary!.data)).toEqual({ w: 612, h: 792 });
      expect(calls).toEqual([{ format: 'A4', printBackground: false }, { format: 'Letter', printBackground: true }]);
    } finally { await session.close(); }
  });
  it('a browser that cannot print fails incomplete: Save as PDF needs headless Chromium', async () => {
    const ctx = await onPublic('/public/table');
    try {
      Object.assign(ctx.page, { pdf: async () => { throw new Error('page.pdf: Protocol error (Page.printToPDF): Printing is not available'); } });
      const r = await runSteps(ctx, [{ intent: 'Save as PDF', pdf: { paper: 'Letter' } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(PDF_NEEDS_HEADLESS);
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('incomplete');
      expect(shownFailure(r.failure.intent, r.failure.message)).toBe('Save as PDF needs headless Chromium');
    } finally { await session.close(); }
  });
});

describe('read', () => {
  it('reads text, html, title and url, masked; the url keeps its own query string', async () => {
    const ctx = await onPublic('/public/table?sort=price');
    try {
      const r = await runSteps(ctx, (['text', 'html', 'title', 'url'] as const).map((what): Step => ({ intent: `Read ${what}`, read: { what } })));
      if (!r.ok) throw new Error(r.failure.message);
      const [text, html, title, url] = r.state.outputs;
      expect(text.text).toContain('SKU-1001');
      expect(text.text).not.toContain('<table');
      expect(html.html).toContain('<table class="results">');
      expect(title.title).toBe(await ctx.page.title());
      expect(url.url).toBe(`${portal.url}/public/table?sort=price`);
      expect(r.state.outputs.every((o) => o.verb === 'read' && !o.truncated && !o.binary)).toBe(true);
      expect(r.state.log.map((e) => Object.keys(e.output ?? {}))).toEqual([['text'], ['html'], ['title'], ['url']]);
    } finally { await session.close(); }
  });
  it('html and text mask a secret written as text, as an attribute, as entities and inside a JSON script blob', async () => {
    const u = SECRETS.username;
    const ctx = await onPublic('/public/table', { masker: createMasker([u]) });
    try {
      const entities = Array.from(u, (c) => `&#${c.codePointAt(0)};`).join('');
      const escaped = Array.from(u, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
      await ctx.page.setContent(`<main><p>signed in as ${u}</p><span data-user="${u}">x</span><p>${entities}</p>`
        + `<script type="application/json" id="blob">{"user":"${u}","escaped":"${escaped}"}</script></main>`);
      const r = await runSteps(ctx, [{ intent: 'Read html', read: { what: 'html' } }, { intent: 'Read text', read: { what: 'text' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [html, text] = r.state.outputs;
      for (const out of [html.html ?? '', text.text ?? '']) {
        expect(out).not.toContain(u);
        expect(out).toContain('[secret]');
      }
      expect(html.html).not.toContain(entities);
      expect(html.html).not.toContain(escaped);
      expect(JSON.stringify(r.state.log)).not.toContain(u);
    } finally { await session.close(); }
  });
  it("a password like P&ss'w0rd echoed by the page is masked in html, text and url (Chromium escapes only & < > \")", async () => {
    const pw = "P&ss'w0rd! x";
    // The site sends the browser there (a step's goto holding the secret is refused before it runs).
    const ctx = await onPublic(`/public/echo?text=${encodeURIComponent(pw)}`, { masker: createMasker([pw]) });
    try {
      const r = await runSteps(ctx, [
        { intent: 'Read html', read: { what: 'html' } }, { intent: 'Read text', read: { what: 'text' } }, { intent: 'Where', read: { what: 'url' } },
      ]);
      if (!r.ok) throw new Error(r.failure.message);
      const [html, text, url] = r.state.outputs;
      // What Chromium itself shows: the serializer writes & as &amp; and leaves ' alone; the URL form-encodes the query.
      const raw = await ctx.page.content();
      expect(raw).toContain("P&amp;ss'w0rd! x");
      expect(ctx.page.url()).toContain('P%26ss%27w0rd!%20x'); // Chromium escapes ' as %27 in a query
      expect(html.html).toContain('<p id="echo">[secret]</p>');
      expect(text.text).toContain('[secret]');
      expect(url.url).toBe(`${portal.url}/public/echo?text=[secret]`);
      const all = JSON.stringify(r.state);
      for (const leak of ["P&amp;ss'w0rd", "P&ss'w0rd", 'P%26ss', 'w0rd']) expect(all, leak).not.toContain(leak);
    } finally { await session.close(); }
  });
  it('text over 5 MiB is truncated on a character boundary and flagged', async () => {
    const ctx = await onPublic('/public/big?mb=6');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read', timeoutMs: 30_000, read: { what: 'text' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [o] = r.state.outputs;
      const bytes = Buffer.byteLength(o.text ?? '', 'utf8');
      expect(bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(bytes).toBeGreaterThan(MAX_TEXT_BYTES - 8);
      expect(o.truncated).toBe(true);
      expect(r.state.log[0].output?.truncated).toBe(true);
    } finally { await session.close(); }
  });
  it('text and html are cut in the page to twice the cap before they cross to Node', async () => {
    const ctx = await onPublic('/public/big?mb=8');
    try {
      // 16 MiB of text: more than twice the cap.
      await ctx.page.evaluate(() => { const p = document.getElementById('big') as HTMLElement; p.textContent = `${p.textContent}${p.textContent}`; });
      const sizes: number[] = [];
      const real = ctx.page;
      // Records the size of every value the page hands back to Node for this step.
      ctx.page = new Proxy(real, {
        get(target, prop) {
          const v = Reflect.get(target, prop) as unknown;
          if (prop === 'evaluate' || prop === 'content') {
            return async (...args: unknown[]) => {
              const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
              sizes.push(JSON.stringify(out ?? '').length);
              return out;
            };
          }
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const r = await runSteps(ctx, [
        { intent: 'Read text', timeoutMs: 30_000, read: { what: 'text' } }, { intent: 'Read html', timeoutMs: 30_000, read: { what: 'html' } },
      ]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(sizes.length).toBeGreaterThanOrEqual(2);
      for (const n of sizes) expect(n).toBeLessThanOrEqual(2 * MAX_TEXT_BYTES + 100);
      for (const o of r.state.outputs) {
        expect(o.truncated).toBe(true);
        expect(Buffer.byteLength(o.text ?? o.html ?? '', 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      }
      expect(r.state.outputs[1].html?.startsWith('<!DOCTYPE html>') || r.state.outputs[1].html?.startsWith('<!doctype html>')).toBe(true);
    } finally { await session.close(); }
  });
  it('a secret cut by the in-page slice never survives, even when masking shrinks the text below the cap', async () => {
    const secret = 'Zq9-long-secret-value-0123456789-abcdefg'; // 40 characters: masked to 8, the text shrinks to a fifth
    expect(secret).toHaveLength(40);
    const masker = createMasker([secret]);
    expect(masker.maxLength).toBeGreaterThanOrEqual(secret.length);
    const ctx = await onPublic('/public/table', { masker });
    try {
      // 20 characters of padding, then secrets: the slice end (2 × MAX_TEXT_BYTES) falls in the middle of one.
      await ctx.page.evaluate(([s, n]) => {
        const p = document.createElement('p');
        p.textContent = `${'p'.repeat(20)}${s.repeat(n)}`;
        document.body.replaceChildren(p);
      }, [secret, Math.ceil((2 * MAX_TEXT_BYTES) / secret.length) + 2] as const);
      const r = await runSteps(ctx, [{ intent: 'Read text', timeoutMs: 30_000, read: { what: 'text' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const out = r.state.outputs[0].text ?? '';
      expect(r.state.outputs[0].truncated).toBe(true);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_TEXT_BYTES); // masking shrank it: the cap did not cut
      expect(out).not.toContain(secret.slice(0, 10));
      for (let k = 3; k < secret.length; k++) expect(out.endsWith(secret.slice(0, k))).toBe(false);
      expect(out).toContain('[secret][secret]'); // whole secrets were masked; a cut placeholder at the very end is harmless
    } finally { await session.close(); }
  }, 60_000);
  it('rows across the run hold at most 20 MiB of text: more is incomplete with the limit named', async () => {
    const ctx = await onPublic('/public/table');
    try {
      expect(MAX_ROW_TEXT_BYTES).toBe(20 * 1024 * 1024);
      // 21 items of 1 MiB each: every item is one row (no ID Pattern, no fields).
      await ctx.page.evaluate((n) => {
        const ul = document.createElement('ul');
        ul.className = 'big';
        for (let i = 0; i < 21; i++) { const li = document.createElement('li'); li.textContent = `${i}`.padEnd(n, 'x'); ul.append(li); }
        document.body.replaceChildren(ul);
      }, 1024 * 1024);
      const r = await runSteps(ctx, [{ intent: 'Read the rows', timeoutMs: 30_000, extract: { scope: { css: 'ul.big' }, item: { css: 'li' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toMatch(/^limit: the rows hold \d+ bytes of text; the limit is 20971520 bytes$/);
      expect(r.state.rows.length).toBe(0);
    } finally { await session.close(); }
  }, 60_000);
  it('the url output goes through outputUrl: no userinfo or fragment, credential-named query values redacted', async () => {
    const ctx = await onPublic('/public/table?sort=price&access_token=abc123&page=2#state=xyz');
    try {
      const r = await runSteps(ctx, [{ intent: 'Where', read: { what: 'url' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.outputs[0].url).toBe(`${portal.url}/public/table?sort=price&access_token=[redacted]&page=2`);
      expect(r.state.log[0].output).toEqual({ url: `${portal.url}/public/table?sort=price&access_token=[redacted]&page=2` });
    } finally { await session.close(); }
  });
  it('text is masked before it is capped: a secret cut by the cap never leaks a prefix', async () => {
    const u = SECRETS.username;
    const ctx = await onPublic('/public/table', { masker: createMasker([u]) });
    try {
      await ctx.page.setContent(`<p>${'a'.repeat(MAX_TEXT_BYTES - 4)}${u}</p>`);
      const r = await runSteps(ctx, [{ intent: 'Read', timeoutMs: 30_000, read: { what: 'text' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [o] = r.state.outputs;
      expect(o.truncated).toBe(true);
      expect(o.text?.endsWith(u.slice(0, 4))).toBe(false);
      expect(o.text?.endsWith('[sec')).toBe(true);
    } finally { await session.close(); }
  });
  it('truncateUtf8 never splits a character', () => {
    expect(MAX_TEXT_BYTES).toBe(5 * 1024 * 1024);
    expect(truncateUtf8('a😀b', 3)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('a😀b', 5)).toEqual({ text: 'a😀', truncated: true });
    expect(truncateUtf8('héllo', 100)).toEqual({ text: 'héllo', truncated: false });
  });
});

describe('extractTable', () => {
  it('keys rows by the thead headers and marks that an extract ran', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read the table', extractTable: { table: { css: 'table.results' } } }]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows).toEqual([
        { Code: 'SKU-1001', Product: 'Widget', Price: '$10.00', Stock: '12' },
        { Code: 'SKU-1002', Product: 'Gadget', Price: '$12.50', Stock: '0' },
        { Code: 'SKU-1003', Product: 'Gizmo', Price: '$7.25', Stock: '5' },
      ]);
      expect(r.state.extractRan).toBe(true);
      expect(r.state.evidence[0].text).toContain('Showing 3 results');
    } finally { await session.close(); }
  });
  it('header rules: first row without thead, empty → column_N, duplicate → name_2, colspan not expanded, missing cells empty', async () => {
    expect(tableHeaders(['Name', '', 'Name', 'Notes', 'Name'])).toEqual(['Name', 'column_2', 'Name_2', 'Notes', 'Name_3']);
    const ctx = await onPublic('/public/table-edge');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read the table', extractTable: { table: { css: 'table.edge' } } }]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows).toEqual([
        { Name: 'Alpha', column_2: 'wide', Name_2: 'n1', Notes: '' },
        { Name: 'Beta', column_2: 'b2', Name_2: 'b3', Notes: 'b4' },
      ]);
    } finally { await session.close(); }
  });
  it('two matching tables are drift (not unique); a locator on something else is drift (not a table)', async () => {
    let ctx = await onPublic('/public/tables-two');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read', timeoutMs: 500, extractTable: { table: { css: 'table.results' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(locatorNotUnique('CSS Selector "table.results"', 2));
      expect(toErrorCode(classifyFailure({ violations: [], failure: r.failure }))).toBe('drift_detected');
    } finally { await session.close(); }
    ctx = await onPublic('/public/table');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read', extractTable: { table: { css: 'p#total' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(NOT_A_TABLE('CSS Selector "p#total"'));
      expect(r.failure.message).toBe('CSS Selector "p#total" is not a table');
      expect(toErrorCode(classifyFailure({ violations: [], failure: r.failure }))).toBe('drift_detected');
    } finally { await session.close(); }
  });
  it('with an ID Pattern each row carries the id from the first matching cell', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const r = await runSteps(ctx, [{ intent: 'Read', extractTable: { table: { css: 'table.results' }, idPattern: 'SKU-\\d{4}' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.rows.map((x) => x.id)).toEqual(['SKU-1001', 'SKU-1002', 'SKU-1003']);
      expect(r.state.rows[0]).toEqual({ Code: 'SKU-1001', Product: 'Widget', Price: '$10.00', Stock: '12', id: 'SKU-1001' });
    } finally { await session.close(); }
  });
  it('a lane run verifies extractTable rows and confirms them against a stated total', async () => {
    const steps = [open('/public/table'), { intent: 'Read the table', extractTable: { table: { css: 'table.results' } } } as Step];
    expect(await runScriptLane(publicRun(steps))).toMatchObject({ ok: true, verified: true, confirmed: false });
    const r = await runScriptLane(publicRun(steps, { output: { totalPattern: 'Showing (\\d+) results' } }));
    expect(r).toMatchObject({ ok: true, verified: true, confirmed: true });
    if (r.ok) expect(r.rows).toHaveLength(3);
  });
});

describe('outputs in the lane and binary names', () => {
  it('a lane run returns its outputs, and the step log carries each output', async () => {
    const r = await runScriptLane(publicRun([
      open('/public/table?view=all'),
      { intent: 'Whole page', screenshot: { capture: 'full' } },
      { intent: 'Title', read: { what: 'title' } },
      { intent: 'Where', read: { what: 'url' } },
    ]));
    if (!r.ok) throw new Error(r.message);
    expect(r.outputs.map((o) => [o.index, o.verb, o.binary?.name])).toEqual([[1, 'screenshot', 'screenshot_1'], [2, 'read', undefined], [3, 'read', undefined]]);
    expect(r.outputs[2].url).toBe(`${portal.url}/public/table?view=all`);
    expect(r.log.map((e) => e.output)).toEqual([undefined, { binary: 'screenshot_1' }, { title: r.outputs[1].title }, { url: `${portal.url}/public/table?view=all` }]);
  });
  it('names binaries by top-level step index with _2 for repeats, and the per-run cap counts every byte', async () => {
    const ctx = await onPublic('/public/table');
    try {
      const file = (name: string) => `${portal.url}/public/files/${name}`;
      await ctx.page.setContent(`<main><p id="c">page one</p><a id="dl" href="${file('report.csv')}">Get the file</a>`
        + `<button onclick="document.getElementById('c').textContent='page two';document.getElementById('dl').href='${file('data.json')}';this.remove()">Next page</button></main>`);
      const steps: Step[] = [
        { intent: 'Read the title', read: { what: 'title' } },
        { intent: 'Screenshot the viewport', screenshot: { capture: 'viewport' } },
        { intent: 'Read the text', read: { what: 'text' } },
        { intent: 'Screenshot the page', screenshot: { capture: 'full' } },
        { intent: 'Save as PDF', pdf: {} },
        {
          intent: 'Download on every page',
          paginate: { next: { text: 'Next page' }, until: 'absent', max: 3, nextWaitMs: 300, each: [{ intent: 'Download the file', download: { trigger: { css: '#dl' }, mime: [MIME.csv, MIME.json] } }] },
        },
      ];
      const r = await runSteps(ctx, steps);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.outputs.flatMap((o) => (o.binary ? [o.binary.name] : []))).toEqual(['screenshot_1', 'screenshot_3', 'pdf_4']);
      expect(r.state.downloads.map((d) => d.binaryName)).toEqual(['file_5', 'file_5_2']);
      expect(r.state.downloads.map((d) => d.mimeType)).toEqual([MIME.csv, MIME.json]);
      expect(r.state.log.flatMap((e) => (e.output?.binary ? [e.output.binary] : []))).toEqual(['screenshot_1', 'screenshot_3', 'pdf_4', 'file_5', 'file_5_2']);
      const sizes = [...r.state.outputs.flatMap((o) => (o.binary ? [o.binary.data.length] : [])), ...r.state.downloads.map((d) => d.data.length)];
      const total = sizes.reduce((a, b) => a + b, 0);
      expect(sizes).toHaveLength(5);
      expect(runBinaryBytes(r.state)).toBe(total);
      expect(runBinaryProblem(r.state)).toBeUndefined();
      expect(runBinaryProblem(r.state, total)).toBeUndefined();
      expect(runBinaryProblem(r.state, total - 1)).toBe(runBinaryTooLarge(total));
      expect(MAX_RUN_BINARY_BYTES).toBe(262_144_000);
      expect(runBinaryTooLarge(300_000_000)).toBe('limit: the run produced 300000000 bytes of files; the limit is 262144000 bytes');
    } finally { await session.close(); }
  });
});

describe('form values, frames and per-capture caps', () => {
  const withSecrets = { secrets: SECRETS, masker: createMasker([SECRETS.username, SECRETS.password]) };
  const captures: Step[] = [{ intent: 'Print', pdf: {} }, { intent: 'Shot', screenshot: { capture: 'viewport' } }];
  it('with a Site Login, a secret typed into a text input refuses pdf and screenshot', async () => {
    for (const step of captures) {
      const ctx = await onPublic('/public/table', withSecrets);
      try {
        await ctx.page.setContent('<main><label>User <input id="u" type="text"></label><textarea id="t"></textarea></main>');
        await ctx.page.fill('#u', SECRETS.username);
        const r = await runSteps(ctx, [step]);
        if (r.ok) throw new Error('expected failure');
        expect(r.failure.message).toBe(PAGE_SHOWS_CREDENTIAL);
        expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'secret', fatal: true }));
        expect(r.state.outputs).toEqual([]);
      } finally { await session.close(); }
    }
  });
  it('with a Site Login, a secret in a textarea, a select or a frame refuses pdf', async () => {
    const u = SECRETS.username;
    for (const html of [
      `<textarea>${u}</textarea>`,
      `<select><option value="${u}" selected>me</option></select>`,
      `<iframe srcdoc="<p>${u}</p>"></iframe>`,
    ]) {
      const ctx = await onPublic('/public/table', withSecrets);
      try {
        await ctx.page.setContent(`<main>${html}</main>`);
        const r = await runSteps(ctx, [{ intent: 'Print', pdf: {} }]);
        if (r.ok) throw new Error(`expected failure for ${html}`);
        expect(r.failure.message).toBe(PAGE_SHOWS_CREDENTIAL);
      } finally { await session.close(); }
    }
  });
  it('without a Site Login, the same input does not refuse pdf', async () => {
    const ctx = await onPublic('/public/table');
    try {
      await ctx.page.setContent('<main><input id="u" type="text"></main>');
      await ctx.page.fill('#u', SECRETS.username);
      const r = await runSteps(ctx, [{ intent: 'Print', pdf: {} }]);
      expect(r.ok).toBe(true);
      expect(r.state.outputs).toHaveLength(1);
    } finally { await session.close(); }
  });

  /** A run state that already holds MAX_RUN_BINARY_BYTES - 1 bytes of binaries (the seed's length is faked; nothing is allocated). */
  function nearlyFull(): RunState {
    const state = newRunState();
    const data = { length: MAX_RUN_BINARY_BYTES - 1 } as unknown as Buffer;
    state.outputs.push({ index: 99, verb: 'screenshot', binary: { name: 'seed', fileName: 'seed.png', mimeType: MIME.png, data } });
    return state;
  }
  const RUN_CAP = /^limit: the run produced (\d+) bytes of files; the limit is 262144000 bytes$/;
  for (const [label, step, path] of [
    ['screenshot', { intent: 'Shot', screenshot: { capture: 'viewport' } }, '/public/table'],
    ['pdf', { intent: 'Print', pdf: {} }, '/public/table'],
    ['download', { intent: 'Get', download: { trigger: { css: '#json' }, mime: [MIME.json] } }, '/public/files'],
  ] as [string, Step, string][]) {
    it(`a ${label} that would take the run over 262144000 bytes fails incomplete before its data is kept`, async () => {
      const ctx = await onPublic(path);
      try {
        const state = nearlyFull();
        const r = await runSteps(ctx, [step], state);
        if (r.ok) throw new Error('expected failure');
        const m = RUN_CAP.exec(r.failure.message);
        expect(m).not.toBeNull();
        expect(Number((m as RegExpExecArray)[1])).toBeGreaterThan(MAX_RUN_BINARY_BYTES);
        expect(classifyFailure({ violations: [], failure: r.failure })).toBe('incomplete');
        expect(state.outputs).toHaveLength(1);
        expect(state.downloads).toHaveLength(0);
      } finally { await session.close(); }
    });
  }
  it('an element taller than 16384 px refuses the screenshot', async () => {
    const ctx = await onPublic('/public/table');
    try {
      await ctx.page.setContent('<main><div id="tall" style="height: 20000px">tall</div></main>');
      const r = await runSteps(ctx, [{ intent: 'Shot', screenshot: { capture: 'element', element: { css: '#tall' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(elementTooTall(20_000));
      expect(elementTooTall(20_000)).toBe('limit: the element is 20000 px tall; screenshots are limited to 16384 px');
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('incomplete');
      expect(r.state.outputs).toEqual([]);
    } finally { await session.close(); }
  });
});

describe('capture edge cases', () => {
  const withSecrets = { secrets: SECRETS, masker: createMasker([SECRETS.username, SECRETS.password]) };
  const u = SECRETS.username;
  const PRINT: Step = { intent: 'Print', pdf: {} };
  async function refusal(html: string, prepare?: (ctx: StepContext) => Promise<void>, over: Partial<StepContext> = {}) {
    const ctx = await onPublic('/public/table', { ...withSecrets, ...over });
    try {
      await ctx.page.setContent(html);
      await prepare?.(ctx);
      const r = await runSteps(ctx, [PRINT]);
      return { r, violations: [...ctx.violations] };
    } finally { await session.close(); }
  }
  const DEFINE = (body: string) => `<script>customElements.define('x-card', class extends HTMLElement { constructor() { super(); `
    + `this.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(body)}; } });</script>`;

  it('S1: a username typed into an input inside an open shadow root refuses pdf', async () => {
    const { r } = await refusal(`<main><x-card></x-card></main>${DEFINE('<label>User <input id="u" type="text"></label>')}`, async (ctx) => {
      await ctx.page.locator('x-card input').fill(u);
    });
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(PAGE_SHOWS_CREDENTIAL);
  });
  it('S1: text inside an open shadow root (nested twice) refuses pdf', async () => {
    const inner = `<script>customElements.define('x-inner', class extends HTMLElement { constructor() { super(); `
      + `this.attachShadow({ mode: 'open' }).innerHTML = '<p>${u}</p>'; } });</script>`;
    const { r } = await refusal(`<main><x-card></x-card></main>${inner}${DEFINE('<x-inner></x-inner>')}`);
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(PAGE_SHOWS_CREDENTIAL);
  });

  it('S2: an attached child frame that cannot be read refuses the capture as incomplete, not as a secret violation', async () => {
    const { r, violations } = await refusal('<main><iframe srcdoc="<p>hello</p>"></iframe></main>', async (ctx) => {
      const child = ctx.page.frames().find((f) => f !== ctx.page.mainFrame());
      if (!child) throw new Error('no child frame');
      Object.assign(child, { evaluate: async () => { throw new Error('Execution context was destroyed'); } });
    });
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(FRAME_NOT_CHECKED);
    expect(FRAME_NOT_CHECKED).toBe('capture: a frame on the page could not be checked for credentials');
    expect(classifyFailure({ violations, failure: r.failure })).toBe('incomplete');
    expect(violations.filter((v) => v.kind === 'secret')).toEqual([]);
  });
  it('S2: a child frame whose check never answers refuses at the step timeout', async () => {
    const { r } = await refusal('<main><iframe srcdoc="<p>hello</p>"></iframe></main>', async (ctx) => {
      const child = ctx.page.frames().find((f) => f !== ctx.page.mainFrame());
      Object.assign(child as object, { evaluate: () => new Promise(() => {}) });
    }, { defaultTimeoutMs: 300 });
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(FRAME_NOT_CHECKED);
  });
  it('S2: a detached child frame is skipped', async () => {
    const { r } = await refusal('<main><iframe srcdoc="<p>hello</p>"></iframe></main>', async (ctx) => {
      const child = ctx.page.frames().find((f) => f !== ctx.page.mainFrame());
      Object.assign(child as object, { evaluate: async () => { throw new Error('Frame was detached'); }, isDetached: () => true });
    });
    expect(r.ok).toBe(true);
  });
  it('S2: a main frame that cannot be read refuses with the capture: message', async () => {
    const { r } = await refusal('<main><p>hello</p></main>', async (ctx) => {
      Object.assign(ctx.page.mainFrame(), { evaluate: async () => { throw new Error('Execution context was destroyed'); } });
    });
    if (r.ok) throw new Error('expected failure');
    expect(r.failure.message).toBe(FRAME_NOT_CHECKED);
  });

  it('capture and file handlers import no lane module, and the run limits live in a leaf module', () => {
    for (const f of ['capture.ts', 'files.ts']) {
      const src = readFileSync(new URL(`../src/steps/handlers/${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/from '\.\.\/\.\.\/lane\//);
    }
    expect(readFileSync(new URL('../src/steps/handlers/files.ts', import.meta.url), 'utf8')).not.toMatch(/from '\.\/capture\.js'/);
    for (const leaf of ['limits.ts', 'masks.ts']) {
      const src = readFileSync(new URL(`../src/steps/${leaf}`, import.meta.url), 'utf8');
      expect(src.match(/^import (?!type ).*from '([^']+)'/gm) ?? []).toEqual(leaf === 'limits.ts' ? ["import { rowTextTooLarge, runBinaryTooLarge } from '../messages.js'"] : []);
    }
  });

  it('a title over 5 MiB is masked, then capped and flagged', async () => {
    const ctx = await onPublic('/public/table', { masker: createMasker([u]) });
    try {
      await ctx.page.evaluate(([name, n]) => { document.title = 'x'.repeat(n) + name; }, [u, MAX_TEXT_BYTES - 4] as const);
      const r = await runSteps(ctx, [{ intent: 'Title', read: { what: 'title' } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [o] = r.state.outputs;
      expect(Buffer.byteLength(o.title ?? '', 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(o.title?.endsWith('[sec')).toBe(true);
      expect(o.truncated).toBe(true);
      expect(r.state.log[0].output?.truncated).toBe(true);
    } finally { await session.close(); }
  });

  it('the full-page height comes from CDP layout metrics, and the CDP session is closed', async () => {
    const ctx = await onPublic('/public/tall');
    try {
      const context = ctx.page.context();
      const original = context.newCDPSession.bind(context);
      const sessions: { detached: boolean }[] = [];
      Object.assign(context, {
        newCDPSession: async (p: Parameters<typeof original>[0]) => {
          const cdp = await original(p);
          const rec = { detached: false };
          sessions.push(rec);
          const detach = cdp.detach.bind(cdp);
          Object.assign(cdp, { detach: async () => { rec.detached = true; await detach(); } });
          return cdp;
        },
      });
      const r = await runSteps(ctx, [{ intent: 'Whole page', screenshot: { capture: 'full' } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toMatch(/^limit: the page is \d+ px tall; screenshots are limited to 16384 px$/);
      expect(sessions).toEqual([{ detached: true }]);
    } finally { await session.close(); }
  });
  it('without CDP the height falls back to scrollHeight', async () => {
    const ctx = await onPublic('/public/tall');
    try {
      Object.assign(ctx.page.context(), { newCDPSession: async () => { throw new Error('CDP session is only available in Chromium'); } });
      const r = await runSteps(ctx, [{ intent: 'Whole page', screenshot: { capture: 'full' } }]);
      if (r.ok) throw new Error('expected failure');
      const h = await ctx.page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      expect(r.failure.message).toBe(screenshotTooTall(h));
    } finally { await session.close(); }
  });

  it('a header named id, __proto__, constructor or prototype is renamed, never dropped or used as a key', async () => {
    expect(tableHeaders(['id', '__proto__', 'constructor', 'prototype', 'Name'])).toEqual(['id_2', '__proto___2', 'constructor_2', 'prototype_2', 'Name']);
    expect(tableHeaders(['Name', 'Name', 'Name_2'])).toEqual(['Name', 'Name_2', 'Name_2_2']);
    const ctx = await onPublic('/public/table');
    try {
      await ctx.page.setContent('<table class="t"><thead><tr><th>id</th><th>__proto__</th><th>constructor</th><th>Name</th></tr></thead>'
        + '<tbody><tr><td>7</td><td>{"polluted":true}</td><td>c</td><td>Alpha</td></tr></tbody></table>');
      const r = await runSteps(ctx, [{ intent: 'Read', extractTable: { table: { css: 'table.t' } } }]);
      if (!r.ok) throw new Error(r.failure.message);
      const [row] = r.state.rows;
      expect(Object.keys(row)).toEqual(['id_2', '__proto___2', 'constructor_2', 'Name']);
      expect(row).toEqual({ id_2: '7', __proto___2: '{"polluted":true}', constructor_2: 'c', Name: 'Alpha' });
      expect(Object.hasOwn(row, 'id')).toBe(false);
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    } finally { await session.close(); }
  });

  it('a PDF that never finishes fails at the step timeout with the capture: message', async () => {
    const ctx = await onPublic('/public/table');
    try {
      Object.assign(ctx.page, { pdf: () => new Promise(() => {}) });
      const r = await runSteps(ctx, [{ intent: 'Print', timeoutMs: 300, pdf: {} }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe(PDF_TIMED_OUT);
      expect(PDF_TIMED_OUT).toBe('capture: the PDF could not be made: timed out');
      expect(classifyFailure({ violations: [], failure: r.failure })).toBe('incomplete');
    } finally { await session.close(); }
  });
});
