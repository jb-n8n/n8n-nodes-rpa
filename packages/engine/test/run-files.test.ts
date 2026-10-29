import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { MIME, sanitizeFileName, sniffMime, withTimeout } from '../src/steps/handlers/files.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps, type StepContext } from '../src/steps/run.js';
import type { PortalPolicy, Step } from '../src/types.js';
import { LOCAL, policyFor, publicPolicy, reportScript, SECRETS, SIGN_IN_STEPS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
let session: Session;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

async function signedIn(policy: PortalPolicy = policyFor(portal)): Promise<StepContext> {
  const script = reportScript(portal.url);
  session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
  await installInterrupts(session.page, script.interrupts);
  await session.page.goto(`${portal.url}/acme/login`);
  const ctx: StepContext = {
    page: session.page, script, policy, secrets: SECRETS, vars: { from: '2000-01-01' },
    masker: createMasker([SECRETS.password]), defaultTimeoutMs: 3000, violations: session.violations,
    armSubmit: (target) => session.armSubmit(target),
  };
  const r = await runSteps(ctx, SIGN_IN_STEPS);
  if (!r.ok) throw new Error(r.failure.message);
  return ctx;
}
const REPORT_STEPS = (over: Partial<Extract<Step, { download: unknown }>['download']> = {}): Step[] => [
  { intent: 'Open Reports', goto: '/acme/reports' },
  { intent: 'From', fill: { field: { label: 'From' }, value: '{{var.from}}' } },
  { intent: 'Export', download: { trigger: { role: 'button', name: 'Export CSV' }, via: { path: '/acme/reports/export' }, mime: ['text/csv'], ...over } },
];

describe('file helpers', () => {
  it('sanitizes file names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a/b\\c:d?.csv')).toBe('c_d_.csv');
    expect(sanitizeFileName('...')).toBe('download');
    const long = sanitizeFileName('x'.repeat(300) + '.csv');
    expect(long).toHaveLength(120);
    expect(long.endsWith('.csv')).toBe(true);
  });
  it('sniffs types from bytes, not names', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7 ...'), 'r.csv')).toBe('application/pdf');
    expect(sniffMime(zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' }), 'r.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'r.xlsx')).toBe('application/zip');
    expect(sniffMime(Buffer.from('<html><body>Session expired</body></html>'), 'export.csv')).toBe('text/html');
    expect(sniffMime(Buffer.from('  <!DOCTYPE html>'), 'export.csv')).toBe('text/html');
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'r.csv')).toBe('application/zip');
    expect(sniffMime(Buffer.from('a,b\n1,2\n'), 'r.csv')).toBe('text/csv');
    expect(sniffMime(Buffer.from('hello'), 'r.txt')).toBe('text/plain');
    expect(sniffMime(Buffer.from([0, 1, 2, 0]), 'r.csv')).toBe('application/octet-stream');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), 'photo.jpg')).toBe(MIME.jpeg);
    expect(sniffMime(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' }), 'letter.docx')).toBe(MIME.docx);
    expect(sniffMime(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' }), 'letter.zip')).toBe(MIME.zip);
    // Entry names, not substrings of the raw bytes.
    expect(sniffMime(zip({ 'password/x': 'word/document.xml [Content_Types].xml' }), 'letter.docx')).toBe(MIME.zip);
    expect(sniffMime(zip({ 'word/document.xml': '<w:document/>' }), 'letter.docx')).toBe(MIME.zip);
    expect(sniffMime(zip({ '[Content_Types].xml': '<Types/>', 'xl/styles.xml': '<styles/>' }), 'r.xlsx')).toBe(MIME.zip);
    expect(sniffMime(Buffer.from('PK\x03\x04[Content_Types].xml word/document.xml', 'latin1'), 'letter.docx')).toBe(MIME.zip);
    expect(sniffMime(Buffer.from('not json at all'), 'data.json')).toBe(MIME.text);
    expect(sniffMime(Buffer.from('{"cut": '), 'data.json')).toBe(MIME.text);
    expect(sniffMime(Buffer.from('{"ok":true}'), 'data.json')).toBe(MIME.json);
    expect(sniffMime(Buffer.from(' [1, 2]'), 'numbers.txt')).toBe(MIME.json);
    expect(sniffMime(Buffer.from('[x],y\n1,2\n'), 'odd.csv')).toBe(MIME.csv);
    expect(sniffMime(Buffer.from('<html>expired</html>'), 'data.json')).toBe('text/html');
  });
});

function zip(entries: Record<string, string>): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))));
}

describe('withTimeout', () => {
  it('rejects with the message and runs the cleanup when the promise hangs', async () => {
    let cleaned = false;
    await expect(withTimeout(new Promise<never>(() => undefined), 20, async () => { cleaned = true; }, 'did not finish')).rejects.toThrow('did not finish');
    expect(cleaned).toBe(true);
    await expect(withTimeout(Promise.resolve(5), 20, async () => undefined, 'x')).resolves.toBe(5);
  });
});

describe('download / submit / popup', () => {
  it('exports the report CSV through an allowed submit', async () => {
    const ctx = await signedIn();
    try {
      const r = await runSteps(ctx, REPORT_STEPS());
      expect(r.ok).toBe(true);
      const [f] = r.state.downloads;
      expect(f.fileName).toBe('notices-2000-01-01_all.csv');
      expect(f.mimeType).toBe('text/csv');
      expect(f.data.toString('utf8').trim().split('\n')).toHaveLength(8);
    } finally { await session.close(); }
  });
  it('a download that fails its check is not kept and the step fails', async () => {
    const ctx = await signedIn();
    try {
      const r = await runSteps(ctx, REPORT_STEPS({ check: { columns: ['No Such Column'] } }));
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('download check failed: the file has no column "No Such Column"');
      expect(r.state.downloads).toEqual([]);
    } finally { await session.close(); }
  });
  it('a passing check keeps facts', async () => {
    const ctx = await signedIn();
    try {
      const r = await runSteps(ctx, REPORT_STEPS({ check: { minRows: 1, minBytes: 1 } }));
      if (!r.ok) throw new Error(r.failure.message);
      const [f] = r.state.downloads;
      const lines = f.data.toString('utf8').trim().split('\n');
      expect(f.facts).toEqual({ columns: lines[0].split(',').map((c) => c.replace(/^"|"$/g, '').trim()), rows: lines.length - 1 });
      expect(f.facts?.rows).toBeGreaterThan(0);
    } finally { await session.close(); }
  });
  it('enforces the size cap and the type allowlist', async () => {
    let ctx = await signedIn();
    try {
      const r = await runSteps(ctx, REPORT_STEPS({ maxBytes: 10 }));
      if (!r.ok) expect(r.failure.message).toBe('download exceeds 10 bytes'); else throw new Error('expected failure');
    } finally { await session.close(); }
    ctx = await signedIn();
    try {
      const r = await runSteps(ctx, REPORT_STEPS({ mime: ['application/pdf'] }));
      if (!r.ok) expect(r.failure.message).toBe('download type text/csv is not allowed'); else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('refuses a download via an undeclared submission', async () => {
    const policy = { ...policyFor(portal), allowedSubmits: [] };
    const ctx = await signedIn(policy);
    try {
      const r = await runSteps(ctx, REPORT_STEPS());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.message).toMatch(/is not an allowed submission/);
      expect(ctx.violations).toContainEqual(expect.objectContaining({ kind: 'write', fatal: true }));
    } finally { await session.close(); }
  });
  it('submits only declared forms', async () => {
    const allowAck = { ...policyFor(portal), allowedSubmits: [{ host: portal.host, path: '/acme/notices/acknowledge', method: 'POST' }] };
    let ctx = await signedIn(allowAck);
    const steps: Step[] = [
      { intent: 'Open notices', goto: '/acme/service/recalls-and-stop-sales' },
      { intent: 'Acknowledge', submit: { button: { css: '#acknowledge' }, path: '/acme/notices/acknowledge' }, expect: { heading: 'Notices acknowledged' } },
    ];
    try { expect((await runSteps(ctx, steps)).ok).toBe(true); } finally { await session.close(); }
    ctx = await signedIn();
    try {
      const r = await runSteps(ctx, steps);
      if (!r.ok) expect(r.failure.message).toMatch(/is not an allowed submission/); else throw new Error('expected failure');
    } finally { await session.close(); }
  });
  it('follows a popup into a new tab', async () => {
    const ctx = await signedIn();
    try {
      await ctx.page.setContent(`<a href="${portal.url}/acme/service" target="_blank">Open service in new tab</a>`);
      const r = await runSteps(ctx, [
        { intent: 'Open tab', popup: { trigger: { role: 'link', name: 'Open service in new tab' } } },
        { intent: 'Check', waitFor: { target: { css: 'body[data-page=service]' } } },
      ]);
      expect(r.ok).toBe(true);
      expect(ctx.page.url()).toContain('/acme/service');
    } finally { await session.close(); }
  });
  it('checks when and expect on the page a popup opened', async () => {
    const ctx = await signedIn();
    try {
      await ctx.page.setContent(`<a href="${portal.url}/acme/service" target="_blank">Open service in new tab</a>`);
      const r = await runSteps(ctx, [
        { intent: 'Open tab', popup: { trigger: { role: 'link', name: 'Open service in new tab' } }, expect: { visible: { css: 'body[data-page=service]' } } },
        { intent: 'Check', when: { visible: { css: 'body[data-page=service]' } }, waitFor: { target: { css: 'body[data-page=service]' } }, expect: { url: '/acme/service' } },
      ]);
      expect(r.ok).toBe(true);
      expect(r.state.log.map((l) => l.status)).toEqual(['ok', 'ok']);
    } finally { await session.close(); }
  });
});

describe('public downloads', () => {
  async function onFiles(): Promise<StepContext> {
    const policy = publicPolicy(portal);
    session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    await session.page.goto(`${portal.url}/public/files`);
    return {
      page: session.page, script: { startUrl: `${portal.url}/public/files`, steps: [] }, policy, vars: {},
      masker: createMasker([]), defaultTimeoutMs: 5000, violations: session.violations,
    };
  }
  const get = (css: string, mime?: string[]): Step => ({ intent: `Download ${css}`, download: { trigger: { css }, ...(mime ? { mime } : {}) } });
  it('sniffs JSON, ZIP, JPEG and DOCX from the bytes and names each file by its step', async () => {
    const ctx = await onFiles();
    try {
      const r = await runSteps(ctx, [get('#json', [MIME.json]), get('#zip', [MIME.zip]), get('#jpeg', [MIME.jpeg]), get('#docx', [MIME.docx])]);
      if (!r.ok) throw new Error(r.failure.message);
      expect(r.state.downloads.map((d) => d.mimeType)).toEqual([MIME.json, MIME.zip, MIME.jpeg, MIME.docx]);
      expect(r.state.downloads.map((d) => d.binaryName)).toEqual(['file_0', 'file_1', 'file_2', 'file_3']);
      expect(r.state.log.map((e) => e.output?.binary)).toEqual(['file_0', 'file_1', 'file_2', 'file_3']);
    } finally { await session.close(); }
  });
  it('the default MIME list still refuses a ZIP', async () => {
    const ctx = await onFiles();
    try {
      const r = await runSteps(ctx, [get('#zip')]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('download type application/zip is not allowed');
    } finally { await session.close(); }
  });
});

describe('a download trigger that was clicked but gave no file (the click is kept for repair)', () => {
  async function onPage(html: string): Promise<StepContext> {
    const policy = publicPolicy(portal);
    session = await openSession({ endpoint: LOCAL, policy, masker: createMasker([]) });
    await session.page.goto(`${portal.url}/public/files`);
    await session.page.setContent(html);
    return {
      page: session.page, script: { startUrl: `${portal.url}/public/files`, steps: [] }, policy, vars: {},
      masker: createMasker([]), defaultTimeoutMs: 1500, violations: session.violations,
    };
  }
  const DIALOG = `<button onclick="document.getElementById('d').hidden = false">Export</button><div id="d" role="dialog" aria-label="Format" hidden>Choose a format</div>`;
  const WAIT: Step = { intent: 'Wait for the page', waitFor: { target: { css: 'body' } } };
  const EXPORT = (over: Partial<Step> = {}): Step => ({ intent: 'Export', download: { trigger: { role: 'button', name: 'Export' } }, ...over } as Step);
  it('records the top-level index when the click opened a dialog instead of a download', async () => {
    const ctx = await onPage(DIALOG);
    try {
      const r = await runSteps(ctx, [WAIT, EXPORT()]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.index).toBe(1);
      expect(r.state.clickedTrigger).toEqual({ index: 1 });
      expect(await ctx.page.getByRole('dialog').isVisible()).toBe(true);
    } finally { await session.close(); }
  });
  it('records it for a link that only re-renders the page', async () => {
    const ctx = await onPage('<a href="/public/files">Export</a>');
    try {
      const r = await runSteps(ctx, [{ intent: 'Export', download: { trigger: { role: 'link', name: 'Export' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.state.clickedTrigger).toEqual({ index: 0 });
    } finally { await session.close(); }
  });
  it('records nothing when the trigger is missing, when a file arrived, or for a download nested in paginate', async () => {
    let ctx = await onPage(DIALOG);
    try {
      const r = await runSteps(ctx, [WAIT, { intent: 'Export', download: { trigger: { role: 'button', name: 'Download spreadsheet' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.state.clickedTrigger).toBeUndefined();
      const nested = await runSteps(ctx, [{ intent: 'Every page', paginate: { next: { css: '#no-next' }, until: 'absent', max: 2, nextWaitMs: 100, each: [EXPORT()] } }]);
      if (nested.ok) throw new Error('expected failure');
      expect(nested.state.clickedTrigger).toBeUndefined();
    } finally { await session.close(); }
    ctx = await onPage('<a id="zip" href="/public/files/archive.zip">Export</a>');
    try {
      // The file arrived (the click did what a download trigger does), then failed the type allowlist.
      const r = await runSteps(ctx, [{ intent: 'Export', download: { trigger: { css: '#zip' } } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.message).toBe('download type application/zip is not allowed');
      expect(r.state.clickedTrigger).toBeUndefined();
    } finally { await session.close(); }
  });
  it('a later step clears the marker of an optional download that gave no file', async () => {
    const ctx = await onPage(DIALOG);
    try {
      const r = await runSteps(ctx, [EXPORT({ optional: true }), WAIT, { intent: 'Missing', click: { role: 'button', name: 'Nope' } }]);
      if (r.ok) throw new Error('expected failure');
      expect(r.failure.index).toBe(2);
      expect(r.state.clickedTrigger).toBeUndefined();
    } finally { await session.close(); }
  });
});

describe('JSON sniffing is bounded', () => {
  const MB16 = 16 * 1024 * 1024;
  it('parses only up to 16 MiB; above that, .json with a leading { or [ is JSON without parsing', () => {
    const small = Buffer.from('[1,2,3]');
    expect(sniffMime(small, 'x.txt')).toBe(MIME.json);
    const big = Buffer.concat([Buffer.from('  ['), Buffer.alloc(MB16, 0x20), Buffer.from('1]')]);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(sniffMime(big, 'data.json')).toBe(MIME.json);
      expect(sniffMime(big, 'data.txt')).toBe(MIME.text);
      expect(sniffMime(Buffer.concat([Buffer.alloc(MB16, 0x20), Buffer.from('x,y')]), 'data.json')).toBe(MIME.text);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
    // At exactly 16 MiB the bytes are still parsed.
    const edge = Buffer.concat([Buffer.from('['), Buffer.alloc(MB16 - 2, 0x20), Buffer.from(']')]);
    expect(edge.length).toBe(MB16);
    expect(sniffMime(edge, 'data.txt')).toBe(MIME.json);
  });
});
