import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { textLeaks, traceLeaks, valueLeaks } from '../src/leaks.js';

const secrets = { password: 'demo-password', username: 'ops@example.com' };

describe('leak scanner', () => {
  it('finds every common encoding of a secret, in any letter case for text forms', () => {
    expect(textLeaks('typed DEMO-PASSWORD here', secrets)).toEqual(['password']);
    expect(textLeaks(`q=${encodeURIComponent('ops@example.com')}`, secrets)).toEqual(['username']);
    expect(textLeaks(Buffer.from('demo-password').toString('base64'), secrets)).toEqual(['password']);
    expect(textLeaks('nothing to see', secrets)).toEqual([]);
  });
  it('scans values but skips binary fields, and scans trace zips entry by entry', () => {
    expect(valueLeaks({ rows: [{ id: 'x', note: 'ops@example.com' }], screenshot: Buffer.from('demo-password') }, secrets)).toEqual(['username']);
    expect(valueLeaks({ trace: Buffer.from('demo-password') }, secrets)).toEqual([]);
    const zip = Buffer.from(zipSync({ 'trace.trace': strToU8('{"value":"demo-password"}'), 'trace.network': strToU8('clean') }));
    expect(traceLeaks(zip, secrets)).toEqual(['password']);
    expect(traceLeaks(undefined, secrets)).toEqual([]);
  });
  it('reports secrets in encodings only the engine masker knows, such as JSON with escaped slashes', () => {
    const tricky = { password: 'p/ss<w"rd>' };
    expect(textLeaks('{"v":"p\\/ss<w\\"rd>"}', tricky)).toEqual(['password:encoded']);
    // An encoding with a named form is reported under the bare label, never twice.
    expect(textLeaks('<td>p/ss&lt;w&quot;rd&gt;</td>', tricky)).toEqual(['password']);
  });
  it('reports an encoded leak even when another secret leaked in a literal form', () => {
    const two = { password: 'p/ss<w"rd>', username: 'ops@example.com' };
    expect(textLeaks('ops@example.com {"v":"p\\/ss<w\\"rd>"}', two)).toEqual(['password:encoded', 'username']);
  });
});

describe('leak scanner encodings', () => {
  const secrets = { password: 'demo-password', accent: 'pässwörd-42' };
  const hex4 = (c: number) => c.toString(16).padStart(4, '0');
  it.each([
    ['HTML decimal entities', Array.from('demo-password', (c) => `&#${c.codePointAt(0)};`).join('')],
    ['HTML hex entities, upper case', Array.from('demo-password', (c) => `&#X${(c.codePointAt(0) as number).toString(16).toUpperCase()};`).join('')],
    ['\\u escapes for every character', Array.from('demo-password', (c) => `\\u${hex4(c.charCodeAt(0))}`).join('')],
    ['base64url', Buffer.from('demo-password').toString('base64url')],
  ])('finds %s', (_name, text) => {
    expect(textLeaks(`x ${text} y`, secrets)).toEqual(['password']);
  });
  it('finds a non-ASCII secret written with \\u escapes only for non-ASCII characters', () => {
    const json = JSON.stringify('pässwörd-42').slice(1, -1).replace(/[\u007f-\uffff]/g, (c) => `\\u${hex4(c.charCodeAt(0))}`);
    expect(textLeaks(`{"v":"${json}"}`, secrets)).toEqual(['accent']);
  });
  it('finds a secret inside a base64 blob at every byte alignment (for example a Basic auth header)', () => {
    for (const prefix of ['', 'u', 'us', 'user:']) {
      const blob = Buffer.from(`${prefix}demo-password~tail`).toString('base64');
      expect(textLeaks(`Authorization: Basic ${blob}`, secrets)).toEqual(['password']);
      expect(textLeaks(blob.replace(/\+/g, '-').replace(/\//g, '_'), secrets)).toEqual(['password']);
    }
  });
  it('keeps the masker check for forms without a named form, reported once under the :encoded label', () => {
    const minimal = 'demo-password'.replace(/[^A-Za-z0-9]/g, (c) => `&#${c.charCodeAt(0)};`);
    expect(textLeaks(`x ${minimal} y`, secrets)).toEqual(['password:encoded']);
  });
});
