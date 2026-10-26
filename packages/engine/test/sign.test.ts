import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize, MAC_DOMAIN, scriptHash, signScript, startHostOf, verifyScript } from '../src/sign.js';
import type { Script } from '../src/types.js';
import { FIRST_STEP_GOTO } from '../src/messages.js';

const script: Script = {
  name: 'demo-sandbox',
  version: 2,
  startUrl: 'http://127.0.0.1:8080/acme/login',
  steps: [{ intent: 'Open Service', click: { role: 'link', name: 'Service' } }],
};
const KEY = 'k-123';
const WHO = 'jay@example.com';
const by = (approvedBy = WHO, siteLoginId?: string) => ({ approvedBy, ...(siteLoginId !== undefined ? { siteLoginId } : {}) });
const check = (doc: unknown, signature: string, approvedBy = WHO, siteLoginId?: string, key = KEY) =>
  verifyScript(doc, key, { ...by(approvedBy, siteLoginId), signature });

describe('canonicalize', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalize({ b: 1, a: [1, { d: 2, c: 3 }], u: undefined })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/non-finite/);
  });
});

describe('pw-steps/2 MAC', () => {
  const hmac = (s: string) => createHmac('sha256', KEY).update(s).digest('hex');
  it('is HMAC-SHA-256 hex over domain, hash, name, version, start host, Site Login id and approver', () => {
    const hash = scriptHash(script);
    expect(MAC_DOMAIN).toBe('pw-steps/2');
    expect(signScript(script, KEY, by(WHO, 'cred-7'))).toEqual({
      hash, signature: hmac(`pw-steps/2\n${hash}\ndemo-sandbox\n2\n127.0.0.1:8080\ncred-7\n${WHO}`),
    });
    expect(signScript(script, KEY, by(WHO)).signature).toBe(hmac(`pw-steps/2\n${hash}\ndemo-sandbox\n2\n127.0.0.1:8080\n\n${WHO}`));
  });
  it('startHostOf reads the host of the parsed start URL, or nothing', () => {
    expect(startHostOf(script)).toBe('127.0.0.1:8080');
    expect(startHostOf({ ...script, startUrl: 'https://Example.COM:443/x' })).toBe('example.com');
    expect(startHostOf({})).toBe('');
    expect(startHostOf(null)).toBe('');
  });
  it('a v1 script MAC never verifies, and neither does a v1-shaped document', () => {
    const v1 = hmac(`${scriptHash(script)}\ndemo-sandbox\n2\n${WHO}`);
    expect(check(script, v1)).toBe(false);
    const { name: _name, ...rest } = script;
    expect(check({ ...rest, portal: 'demo-sandbox' }, signScript(script, KEY, by()).signature)).toBe(false);
  });
});

describe('sign / verify', () => {
  it('verifies an untouched script', () => {
    const { hash, signature } = signScript(script, KEY, by());
    expect(hash).toBe(scriptHash(script));
    expect(check(structuredClone(script), signature)).toBe(true);
  });
  it('rejects any change to steps, name, version, start site, approver or key', () => {
    const { signature } = signScript(script, KEY, by());
    const edited = structuredClone(script);
    (edited.steps[0] as { click: { name: string } }).click.name = 'Parts';
    expect(check(edited, signature)).toBe(false);
    expect(check({ ...script, name: 'other' }, signature)).toBe(false);
    expect(check({ ...script, version: 3 }, signature)).toBe(false);
    expect(check({ ...script, startUrl: 'http://127.0.0.1:9090/acme/login' }, signature)).toBe(false);
    expect(check(script, signature, 'someone@else')).toBe(false);
    expect(check(script, signature, WHO, undefined, 'other-key')).toBe(false);
  });
  it('binds the Site Login id: signed with one id, verified with another or none, fails', () => {
    const { signature } = signScript(script, KEY, by(WHO, 'cred-a'));
    expect(check(script, signature, WHO, 'cred-a')).toBe(true);
    expect(check(script, signature, WHO, 'cred-b')).toBe(false);
    expect(check(script, signature, WHO)).toBe(false);
    const none = signScript(script, KEY, by()).signature;
    expect(check(script, none, WHO, 'cred-a')).toBe(false);
    expect(check(script, none, WHO, '')).toBe(true); // an empty id is no id
  });
  it('rejects a valid signature with trailing junk or in upper case', () => {
    const { signature } = signScript(script, KEY, by());
    expect(check(script, `${signature}zz`)).toBe(false);
    expect(check(script, `${signature}z`)).toBe(false);
    expect(check(script, ` ${signature}`)).toBe(false);
    expect(check(script, signature.toUpperCase())).toBe(false);
  });
  it('returns false for garbage instead of throwing', () => {
    expect(check(script, 'not-hex')).toBe(false);
    expect(check(script, '')).toBe(false);
    expect(check(null, 'aa')).toBe(false);
    expect(check({ steps: [] }, 'aa')).toBe(false);
    expect(check(script, 'aa', WHO, undefined, '')).toBe(false);
    expect(check(script, signScript(script, KEY, by()).signature, `${WHO}\n`)).toBe(false);
  });
  it('refuses to sign with an empty key or approver, a multi-line binding, or a document without name and version', () => {
    expect(() => signScript(script, '', by())).toThrow(/key/);
    expect(() => signScript(script, '   ', by())).toThrow(/key/);
    expect(() => signScript(script, KEY, by(''))).toThrow(/approver/);
    expect(() => signScript(script, KEY, by(WHO, 'a\nb'))).toThrow('approver id and Site Login id must be single-line');
    const { name: _n, ...noName } = script;
    const { version: _v, ...noVersion } = script;
    expect(() => signScript(noName, KEY, by())).toThrow('signing needs a name and a version');
    expect(() => signScript(noVersion, KEY, by())).toThrow('signing needs a name and a version');
  });
});

describe('the start host of steps without startUrl', () => {
  it('is the host of the first absolute goto, normalised, and it is bound', () => {
    const doc = { name: 'prices', version: 1, steps: [{ intent: 'Open', goto: 'https://Example.com/pricing' }] };
    expect(startHostOf(doc)).toBe('example.com');
    const { signature } = signScript(doc, KEY, { approvedBy: WHO });
    expect(verifyScript(doc, KEY, { approvedBy: WHO, signature })).toBe(true);
    expect(startHostOf([{ intent: 'Open', goto: '/relative' }])).toBe('');
  });
});

describe('signing needs a start host', () => {
  it('refuses steps whose start host cannot be told from the document', () => {
    const relative = { name: 'prices', version: 1, steps: [{ intent: 'Open', goto: '/pricing' }] };
    expect(() => signScript(relative, KEY, { approvedBy: WHO })).toThrow(FIRST_STEP_GOTO);
    expect(() => signScript({ ...relative, startUrl: 'https://example.com/' }, KEY, { approvedBy: WHO })).not.toThrow();
  });
});
