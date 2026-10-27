import { describe, expect, it } from 'vitest';
import { msUntilNextWindow, totp } from '../src/secrets/totp.js';
import { createMasker, maskWithOneAlternation } from '../src/secrets/mask.js';
import { MAX_RENDERED, renderVars } from '../src/secrets/render.js';
import { inputTooLong, renderedTooLong } from '../src/messages.js';
import { runScriptLane } from '../src/lane/script-lane.js';
import type { PortalPolicy } from '../src/types.js';
import { bound } from './timing.js';

describe('totp', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" in base32.
  const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches RFC 6238 vectors', () => {
    expect(totp(RFC, 59_000, 30, 8)).toBe('94287082');
    expect(totp(RFC, 1_111_111_109_000, 30, 8)).toBe('07081804');
  });
  it('defaults to 6 digits and pads', () => {
    expect(totp(RFC, 59_000)).toBe('287082');
  });
  it('reports time left in the window', () => {
    expect(msUntilNextWindow(59_000)).toBe(1_000);
    expect(msUntilNextWindow(60_000)).toBe(30_000);
  });
  it('rejects invalid base32', () => {
    expect(() => totp('not base32!', 0)).toThrow(/base32/);
  });
});

describe('masker', () => {
  const pw = 'p@ss.w(rd)+ "x"';
  const m = createMasker(['summit-ops', pw, undefined, '', null]);
  it('masks raw, URL, form, JSON, HTML and base64 encodings', () => {
    const forms = [
      pw,
      encodeURIComponent(pw),
      encodeURIComponent(pw).replace(/%20/g, '+'),
      JSON.stringify(pw).slice(1, -1),
      pw.replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
      Buffer.from(pw).toString('base64'),
    ];
    for (const f of forms) {
      const out = m.mask(`before ${f} after`);
      expect(out).toBe('before [secret] after');
    }
  });
  it('masks escaped-slash JSON and minimal HTML entity encodings', () => {
    const secret = 'Pa55/wörd+?';
    const mk = createMasker([secret]);
    const forms = [
      'Pa55\\/wörd+?',
      'Pa55\\/w\\u00f6rd+?',
      'Pa55&#47;w&#246;rd&#43;&#63;',
      'Pa55&#x2f;w&#xf6;rd&#x2b;&#x3f;',
    ];
    for (const f of forms) {
      expect(mk.mask(`a ${f} b`)).toBe('a [secret] b');
      expect(mk.containsSecret(f)).toBe(true);
    }
  });
  it('masks case-insensitively and every occurrence', () => {
    expect(m.mask('SUMMIT-OPS logged in as summit-ops')).toBe('[secret] logged in as [secret]');
  });
  it('masks the longer secret first when secrets overlap', () => {
    const o = createMasker(['admin', 'admin123']);
    expect(o.mask('pw=admin123 user=admin')).toBe('pw=[secret] user=[secret]');
  });
  it('detects secrets and ignores empty entries', () => {
    expect(m.containsSecret('x Summit-Ops y')).toBe(true);
    expect(m.containsSecret('nothing here')).toBe(false);
    expect(m.secrets).toEqual(['summit-ops', pw]);
  });
  it('detects URL-encoded secrets', () => {
    const secret = 'p@ss word';
    const masked = createMasker([secret]);
    expect(masked.containsSecret(encodeURIComponent(secret))).toBe(true);
  });
  it('detects base64-encoded secrets', () => {
    const secret = 'p@ss word';
    const masked = createMasker([secret]);
    const b64 = Buffer.from(secret).toString('base64');
    expect(masked.containsSecret(b64)).toBe(true);
  });
  it('masks case-insensitively with Unicode characters like İ', () => {
    const m2 = createMasker(['summit-ops']);
    expect(m2.mask('İ SUMMIT-OPS')).toBe('İ [secret]');
  });
});

describe('renderVars', () => {
  const m = createMasker(['hunter2-secret']);
  it('caps a rendered value at 10,000 characters with a limit message', () => {
    expect(renderVars('{{var.q}}', { q: 'x'.repeat(10_000) }, m)).toHaveLength(10_000);
    expect(() => renderVars('{{var.q}}!', { q: 'x'.repeat(10_000) }, m)).toThrow(renderedTooLong(10_000));
    expect(renderedTooLong(10_000)).toBe('limit: a rendered value is longer than 10000 characters');
    expect(MAX_RENDERED).toBe(10_000);
  });
  it('replaces inputs', () => {
    expect(renderVars('/r?from={{var.from}}&to={{ var.to }}', { from: '2026-01-01', to: '2026-02-01' }, m))
      .toBe('/r?from=2026-01-01&to=2026-02-01');
  });
  it('throws on a missing input instead of rendering undefined', () => {
    expect(() => renderVars('{{var.dealer}}', {}, m)).toThrow('missing input "dealer"');
  });
  it('refuses secret templates and unknown templates', () => {
    expect(() => renderVars('{{secret.password}}', {}, m)).toThrow(/only be used by signIn/);
    expect(() => renderVars('{{env.HOME}}', {}, m)).toThrow(/unknown template/);
  });
  it('refuses an input whose value contains a secret', () => {
    expect(() => renderVars('{{var.q}}', { q: 'x HUNTER2-SECRET y' }, m)).toThrow(/contains a credential secret/);
  });
  it('rejects prototype member access like constructor', () => {
    expect(() => renderVars('{{var.constructor}}', {}, m)).toThrow('missing input "constructor"');
  });
  it('rejects URL-encoded secret in input', () => {
    const secret = 'p@ss word';
    const m2 = createMasker([secret]);
    expect(() => renderVars('{{var.x}}', { x: encodeURIComponent(secret) }, m2)).toThrow(/contains a credential secret/);
  });
  it('rejects base64-encoded secret in input', () => {
    const secret = 'p@ss word';
    const m2 = createMasker([secret]);
    const b64 = Buffer.from(secret).toString('base64');
    expect(() => renderVars('{{var.x}}', { x: b64 }, m2)).toThrow(/contains a credential secret/);
  });
});

describe('masker encoding gaps found before the leak scanner', () => {
  const secret = 'Pa55/wörd+?';
  const m = createMasker([secret]);
  const hex4 = (c: number) => c.toString(16).padStart(4, '0');
  const forms: Record<string, string> = {
    htmlDecimal: Array.from(secret, (c) => `&#${c.codePointAt(0)};`).join(''),
    htmlHexUpper: Array.from(secret, (c) => `&#X${(c.codePointAt(0) as number).toString(16).toUpperCase()};`).join(''),
    unicodeEscapes: Array.from(secret, (c) => `\\u${hex4(c.charCodeAt(0))}`).join(''),
    unicodeEscapesUpper: Array.from(secret, (c) => `\\u${hex4(c.charCodeAt(0)).toUpperCase()}`).join(''),
    jsonAsciiOnly: JSON.stringify(secret).slice(1, -1).replace(/[\u007f-\uffff]/g, (c) => `\\u${hex4(c.charCodeAt(0))}`),
    base64url: Buffer.from(secret, 'utf8').toString('base64url'),
    base64urlPadded: Buffer.from(secret, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  };
  for (const [name, text] of Object.entries(forms)) {
    it(`masks the ${name} form`, () => {
      expect(m.containsSecret(`before ${text} after`)).toBe(true);
      expect(m.mask(`before ${text} after`)).toBe('before [secret] after');
    });
  }
});

describe('masker encoding gaps', () => {
  const b64 = (t: string) => Buffer.from(t, 'utf8').toString('base64');
  const b64url = (t: string) => Buffer.from(t, 'utf8').toString('base64url');
  const formEncode = (t: string) => new URLSearchParams({ x: t }).toString().slice(2);
  const pathEncode = (t: string) => new URL(`https://h.example/${t}`).pathname.slice(1);
  const hex2 = (c: number) => c.toString(16).padStart(2, '0');
  const fullWidth = (t: string) => Array.from(t, (c) => (c === ' ' ? '　' : c > ' ' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join('');
  // [case, secret, the text a page, URL or trace could hold]
  const cases: [string, string, string][] = [
    ['form encoding of !', 'Passw0rd!', formEncode('Passw0rd!')],
    ["form encoding of '", "Pa'ssw0rd", formEncode("Pa'ssw0rd")],
    ['form encoding of ( )', 'Pa(ss)w0rd', formEncode('Pa(ss)w0rd')],
    ['form encoding of ~', 'Pa~ssw0rd', formEncode('Pa~ssw0rd')],
    ['form encoding of a space as +', 'pa ss w0rd!', formEncode('pa ss w0rd!')],
    ['path encoding', 'p@ss w0rd', pathEncode('p@ss w0rd')],
    ['path encoding with a quote and braces', 'p"s{s}w0rd', pathEncode('p"s{s}w0rd')],
    ['double percent-encoding', 'p@ss w0rd!', encodeURIComponent(encodeURIComponent('p@ss w0rd!'))],
    ['double form encoding', 'Passw0rd!', formEncode(formEncode('Passw0rd!'))],
    ['lowercase percent hex', 'Passw0rd!', 'Passw0rd%21'.toLowerCase()],
    ['base64 at byte offset 0 inside a blob', 'hunter2-secret', b64('hunter2-secret:extra')],
    ['base64 at byte offset 1', 'hunter2-secret', b64('x' + 'hunter2-secret')],
    ['base64 at byte offset 2 (basic auth u:pw)', 'hunter2-secret', b64('u:hunter2-secret')],
    ['base64 at byte offset 3', 'hunter2-secret', b64('ab:hunter2-secret')],
    ['base64 at byte offset 4', 'hunter2-secret', b64('abc:hunter2-secret')],
    ['base64url at byte offset 6 in JSON', 'hunter2-secret', b64url('{"p":"hunter2-secret"}')],
    ['base64url at byte offset 7 in JSON', 'hunter2-secret', b64url('{"pw":"hunter2-secret"}')],
    ['base64url at byte offset 9 in JSON', 'hunter2-secret?>>', b64url('{"pass":"hunter2-secret?>>"}')],
    ['HTML decimal entities with leading zeros', 'P&ss!w0rd', 'P&#0038;ss&#00033;w0rd'],
    ['HTML decimal entities without semicolons', 'P&ss!w0rd', 'P&#38ss&#33w0rd'],
    ['HTML hex entities with leading zeros', 'P&ss!w0rd', 'P&#x0026;ss&#X00021;w0rd'],
    ['HTML escaping only & < > " (the Chromium serializer)', `P&ss'w0rd<"x">`, 'P&amp;ss\'w0rd&lt;&quot;x&quot;&gt;'],
    ['&#x27; for an apostrophe', "Pa'ss w0rd", 'Pa&#x27;ss w0rd'],
    ['&#39; for an apostrophe', "Pa'ss w0rd", 'Pa&#39;ss w0rd'],
    ['&apos; for an apostrophe', "Pa'ss w0rd", 'Pa&apos;ss w0rd'],
    ['legacy &amp without semicolon', 'P&ss w0rd', 'P&ampss w0rd'],
    ['\\xNN escapes', 'Pa$$:w0rd', 'Pa\\x24\\x24\\x3aw0rd'],
    ['\\xNN escapes for every character', 'Pa$$w0rd', Array.from('Pa$$w0rd', (c) => `\\x${hex2(c.charCodeAt(0))}`).join('')],
    ['\\u{...} escapes', 'Pa$$w0rd', Array.from('Pa$$w0rd', (c) => `\\u{${c.charCodeAt(0).toString(16)}}`).join('')],
    ['full-width characters (NFKC)', 'Passw0rd!', fullWidth('Passw0rd!')],
    ['full-width with an ideographic space', 'pa ss w0rd', fullWidth('pa ss w0rd')],
    ['collapsed whitespace: a newline for a space', 'pa ss w0rd', 'pa\nss w0rd'],
    ['collapsed whitespace: a non-breaking space entity', 'pa ss w0rd', 'pa&nbsp;ss w0rd'],
    ['mixed: part HTML entity, part percent', 'P&ss!w0rd', 'P&amp;ss%21w0rd'],
  ];
  for (const [name, secret, text] of cases) {
    it(`masks and detects ${name}`, () => {
      const m = createMasker([secret]);
      const framed = `before ${text} after`;
      expect(m.containsSecret(framed), framed).toBe(true);
      const masked = m.mask(framed);
      expect(masked, framed).toContain('[secret]');
      expect(masked.startsWith('before '), masked).toBe(true);
      expect(masked.endsWith(' after'), masked).toBe(true);
      expect(m.containsSecret(masked), masked).toBe(false);
      // Nothing of the encoded secret is left. Base64 keeps the blob's own bytes around it (`{"p":"`), and up to 3
      // characters each side that mix the secret's bits with its neighbours'.
      if (!name.includes('base64')) expect(masked, framed).toBe('before [secret] after');
      expect(m.maxLength).toBeGreaterThanOrEqual(text.length - 6);
    });
  }

  const decodeOnly: [string, string, string][] = [
    ['an HTML entity of a percent-encoded character', 'Passw0rd!', 'Passw0rd&#37;21'],
    ['percent-encoded HTML entities', 'P&ss!w0rd', encodeURIComponent('P&amp;ss&#33;w0rd')],
    ['triple whitespace and tabs', 'pa ss w0rd', 'pa \t\n ss w0rd'],
  ];
  for (const [name, secret, text] of decodeOnly) {
    it(`containsSecret decode-normalizes: ${name}`, () => {
      expect(createMasker([secret]).containsSecret(`x ${text} y`)).toBe(true);
    });
  }

  it('does not flag unrelated text, and does not turn every + into a match', () => {
    const m = createMasker(['Passw0rd!', 'hunter2-secret']);
    for (const t of ['nothing here', 'Passw0rd', 'a+b=c', '%2B%2B', '&#33;&amp;', 'aHVudGVy', 'Pass w0rd!']) expect(m.containsSecret(t), t).toBe(false);
    expect(m.mask('Passw0rd? hunter2 secret')).toBe('Passw0rd? hunter2 secret');
  });

  it('add() extends the run masker with one-time codes, matched as whole numbers', () => {
    const m = createMasker(['hunter2-secret']);
    const before = m.maxLength;
    m.add(['287082', '', '094287'], { wholeNumber: true });
    expect(m.mask('code 287082 sent; %32%38%37%30%38%32; MDk0Mjg3')).toBe('code [secret] sent; [secret]; [secret]');
    expect(m.containsSecret('entered: 287082')).toBe(true);
    expect(m.containsSecret('&#50;&#56;&#55;&#48;&#56;&#50;')).toBe(true);
    // Inside a longer number it is not the code: row values such as 12870829 stay as they are.
    expect(m.mask('order 12870829, id 2870821')).toBe('order 12870829, id 2870821');
    expect(m.containsSecret('order 12870829')).toBe(false);
    expect(m.mask('hunter2-secret')).toBe('[secret]');
    expect(m.secrets).toEqual(['hunter2-secret', '287082', '094287']);
    expect(m.maxLength).toBeGreaterThanOrEqual(before);
  });

  it('a whole-number code right after an escaped non-digit is still masked', () => {
    const m = createMasker([]);
    m.add(['287082'], { wholeNumber: true });
    for (const [t, want] of [
      ['%22287082%22', '%22[secret]%22'],
      ['q=%20287082', 'q=%20[secret]'],
      ['\\u0022287082\\u0022', '\\u0022[secret]\\u0022'],
      ['\\x22287082', '\\x22[secret]'],
      ['\\"287082\\"', '\\"[secret]\\"'],
    ] as const) expect(m.mask(t), t).toBe(want);
    // An escaped digit before it makes a longer number, which is not the code.
    for (const t of ['%31287082', '\\u0031287082', '\\x31287082']) expect(m.mask(t), t).toBe(t);
  });

  it('a blank secret is matched exactly, never as any whitespace', () => {
    const m = createMasker(['  ']);
    expect(m.mask('a b  c')).toBe('a b[secret]c');
    expect(m.containsSecret('a b')).toBe(false);
  });

  it('stays fast on 5 MB of text (linear-ish), also once a TOTP step added its codes', () => {
    const m = createMasker(['summit-ops', 'P&ss\'w0rd! x', 'JBSWY3DPEHPK3PXP', 'tok-5d8e3a71', 'test-signing-key']);
    const chunk = '<p class="x">Lorem ipsum &amp; dolor %20 sit &#39;amet&#39; \\u0041 P&amp;ss   +++ %%% &&& </p>\n';
    const text = chunk.repeat(Math.ceil((5 * 1024 * 1024) / chunk.length));
    const t0 = performance.now();
    m.mask(text);
    m.containsSecret(text);
    expect(performance.now() - t0).toBeLessThan(bound(5000));
    // A run that typed a TOTP code adds three whole-number codes. In one alternation with the secrets
    // their lookbehinds took V8 off its fast path: 5 MB of trace text went from 10 ms to 380 ms per TOTP step.
    const piece = (k: number) => `{"type":"after","callId":"call@${k}","endTime":${1700000000 + k}.123,"url":"https://portal.example.com/a%20b?x=${k}&amp;y=\\u0041","snapshot":"<div id=\\"r${k}\\">Order 1234${k % 10} 482910 &#160; 111111x</div>"}\n`;
    let trace = '';
    for (let k = 0; trace.length < 5 * 1024 * 1024; k++) trace += piece(k);
    // Two maskers measured in turn, fastest of five each: load on a busy machine (the suite runs files in parallel)
    // slows both sides alike instead of deciding the result.
    const coded = createMasker(['summit-ops', 'P&ss\'w0rd! x', 'JBSWY3DPEHPK3PXP', 'tok-5d8e3a71', 'test-signing-key']);
    coded.add(['287082', '094287', '551203'], { wholeNumber: true });
    const time = (mk: typeof m) => { const t = performance.now(); mk.mask(trace); return performance.now() - t; };
    let plain = Infinity;
    let withCodes = Infinity;
    for (let i = 0; i < 5; i++) { plain = Math.min(plain, time(m)); withCodes = Math.min(withCodes, time(coded)); }
    // Loose on purpose: the regression was 38× (10 ms → 380 ms); a tighter bound flaked when other suites ran alongside.
    expect(withCodes).toBeLessThan(5 * plain + 50);
  });

  it('masks exactly as one alternation of every secret would (random texts, overlapping secrets, whole numbers)', () => {
    let seed = 0x2f6e2b1;
    const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
    const pool = ['abc', 'abcdef', 'bcd', 'a b', 'P&ss\'w0rd', '123456', 'x\\y', 'Ünï', '  ', 'q-q'];
    const codes = ['123456', '234567', '345678'];
    const frags = [
      'abc', 'ABCdef', 'bcde', 'a%20b', 'a&nbsp;b', 'a+b', 'P&amp;ss&#39;w0rd', 'P%26ss', '123456', '1234567', '0123456', '%31', '%22',
      '\\u0031', '\\x22', 'x\\\\y', 'x\\y', 'YWJj', 'YWJjZGVm', ' ', '  ', 'q', '&', '\\u0061bc', 'a  b', 'ａｂｃ', 'Ünï', '%C3%9Cn', 'q-q', '234567', '\n',
    ];
    let compared = 0;
    for (let n = 0; n < 300; n++) {
      const m = createMasker(pool.filter(() => rand(2) === 0));
      if (rand(2) === 0) m.add(codes.slice(0, 1 + rand(3)), { wholeNumber: true });
      for (let k = 0; k < 10; k++) {
        let text = '';
        for (let j = 1 + rand(14); j > 0; j--) text += frags[rand(frags.length)];
        expect(m.mask(text), JSON.stringify({ secrets: m.secrets, text })).toBe(maskWithOneAlternation(m, text));
        compared++;
      }
    }
    expect(compared).toBe(3000);
  });

  it('masks exactly as one alternation where secrets overlap: the longer secret wins at a shared position', () => {
    const m = createMasker(['abc', 'abcdef', 'cde']);
    m.add(['123456'], { wholeNumber: true });
    for (const [text, want] of [
      ['abcdef', '[secret]'], ['abcde', '[secret]de'], ['xcdef', 'x[secret]f'], ['ab cde', 'ab [secret]'],
      ['1234567 123456 a123456', '1234567 [secret] a[secret]'], ['abc123456', '[secret][secret]'],
    ] as const) {
      expect(m.mask(text), text).toBe(want);
      expect(maskWithOneAlternation(m, text), text).toBe(want);
    }
  });

  it('maxLength bounds the longest form mask() can match', () => {
    const secret = 'P&ss w0rd!';
    const m = createMasker([secret]);
    expect(m.maxLength).toBeGreaterThanOrEqual(new URLSearchParams({ x: new URLSearchParams({ x: secret }).toString().slice(2) }).toString().slice(2).length);
    expect(m.maxLength).toBeGreaterThanOrEqual(b64(secret).length);
  });
});

describe('source hygiene', () => {
  it('no TypeScript source in the repo holds a raw U+FFFF (write the \\uffff escape instead)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../..', import.meta.url).pathname;
    const skip = new Set(['node_modules', 'dist', '.git', '.claude', '.superpowers']);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (skip.has(e.name)) return [];
      const path = join(dir, e.name);
      return e.isDirectory() ? walk(path) : e.name.endsWith('.ts') ? [path] : [];
    });
    const files = walk(root);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('\uffff')).map((f) => f.slice(root.length))).toEqual([]);
  });
});

describe('Variables cap in the lane', () => {
  it('refuses a value over 10,000 characters before any browser opens', async () => {
    const policy: PortalPolicy = {
      startUrl: 'http://127.0.0.1:9/public/form', navHosts: ['127.0.0.1:9'], subresourceHosts: [], login: [], allowedSubmits: [], allowPrivateNetwork: true,
    };
    // Opening this endpoint would fail browser_unavailable: an incomplete result proves no browser was tried.
    const r = await runScriptLane({
      script: { steps: [{ intent: 'Open the form', goto: 'http://127.0.0.1:9/public/form' }] }, trust: { required: false }, policy,
      endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:1/' }, vars: { small: 'ok', big: 'x'.repeat(10_001) },
    });
    expect(r).toMatchObject({ ok: false, code: 'incomplete', message: 'input "big" is longer than 10000 characters' });
    expect(inputTooLong('big', 10_000)).toBe('limit: input "big" is longer than 10000 characters');
  });
});
