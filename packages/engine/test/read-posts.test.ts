import { describe, expect, it } from 'vitest';
import { matchingReadPost, readPathMatches, readPathTooBroad, readPostLabel, readPostsProblem } from '../src/policy/read-posts.js';

describe('read-only POST matching', () => {
  it('a star never crosses a slash', () => {
    const p = '/sap*/bc/gui/sap/its/webgui';
    expect(readPathMatches(p, '/sap(cz1TSUQ)/bc/gui/sap/its/webgui')).toBe(true);
    expect(readPathMatches(p, '/sap/bc/gui/sap/its/webgui')).toBe(true);
    expect(readPathMatches(p, '/sapx/evil/bc/gui/sap/its/webgui')).toBe(false);
    expect(readPathMatches(p, '/sap(a)/bc/gui/sap/its/webgui/extra')).toBe(false);
    expect(readPathMatches('/sap/opu/odata/sap/*/$batch', '/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch')).toBe(true);
  });
  it('regex characters are literal', () => {
    expect(readPathMatches('/a.b', '/axb')).toBe(false);
    expect(readPathMatches('/a(b)', '/a(b)')).toBe(true);
  });
  it('too broad', () => {
    for (const p of ['/*', '/*/*', '/sap/**', '*']) expect(readPathTooBroad(p), p).toBe(true);
    expect(readPathTooBroad('/sap*/x')).toBe(false);
  });
  it('labels', () => {
    expect(readPostLabel({ host: 'h:1', path: '/p*' })).toBe('POST h:1/p*');
  });
  it('a star spans only plain characters: no encoded separators, no path parameters, no backslash', () => {
    const gui = '/sap*/bc/gui/sap/its/webgui';
    expect(readPathMatches(gui, '/sap%2F..%2Fx/bc/gui/sap/its/webgui')).toBe(false);
    expect(readPathMatches(gui, '/sap(cz1TSUQ6QU5PTjo=)/bc/gui/sap/its/webgui')).toBe(true);
    const odata = '/sap/opu/odata/sap/*/$batch';
    expect(readPathMatches(odata, '/sap/opu/odata/sap/..;/$batch')).toBe(false);
    expect(readPathMatches(odata, '/sap/opu/odata/sap/a%5Cb/$batch')).toBe(false);
    expect(readPathMatches(odata, '/sap/opu/odata/sap/a\\b/$batch')).toBe(false);
    expect(readPathMatches(odata, '/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch')).toBe(true);
  });
  it('a star also spans the exact %3D / %3d triplet (an encoded =, as in percent-encoded SAP session ids), nothing else after %', () => {
    const gui = '/sap*/bc/gui/sap/its/webgui';
    expect(readPathMatches(gui, '/sap(cz1TSUQ6QU5PTjo%3D)/bc/gui/sap/its/webgui')).toBe(true);
    expect(readPathMatches(gui, '/sap(cz1TSUQ6QU5PTjo%3d%3d)/bc/gui/sap/its/webgui')).toBe(true);
    for (const bad of ['%3', '%3E', '%2F', '%5C', '%25', '%253D', '%%3D', '%', '%3D%', '%3;']) {
      expect(readPathMatches(gui, `/sap(x${bad})/bc/gui/sap/its/webgui`), bad).toBe(false);
    }
    expect(readPathMatches('/a*', '/a%3D')).toBe(true);
    expect(readPathMatches('/a*b', '/a%3Db')).toBe(true);
    expect(readPathMatches('/a*%3Db', '/a%3D%3Db')).toBe(true);
    expect(readPathMatches('/a%3D', '/a%3d')).toBe(false); // literal parts still compare exactly
  });
  it('agrees with an exhaustive reference matcher on small inputs (never admits more, never misses a match)', () => {
    const unit = (s: string): number => (/^[A-Za-z0-9_.()=~-]/.test(s) ? 1 : /^%3[Dd]/.test(s) ? 3 : 0);
    const ref = (p: string, s: string): boolean => {
      if (!p.length) return !s.length;
      if (p[0] === '*') {
        if (ref(p.slice(1), s)) return true;
        const u = unit(s);
        return u > 0 && ref(p, s.slice(u));
      }
      return s.length > 0 && p[0] === s[0] && ref(p.slice(1), s.slice(1));
    };
    let seed = 7;
    const rnd = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; }; // xorshift32
    const word = (alphabet: string, max: number) => Array.from({ length: rnd(max + 1) }, () => alphabet[rnd(alphabet.length)]).join('');
    for (let k = 0; k < 20000; k++) {
      const p = word('ab%3Dd;*', 6);
      const s = word('ab%3Dd;', 8);
      expect(readPathMatches(`/${p}`, `/${s}`), `${p} vs ${s}`).toBe(ref(p, s));
    }
  });
  it('many stars against a long segment finish at once (no regex backtracking)', () => {
    const t = Date.now();
    expect(readPathMatches('/a*b*c*d*e*f*g*h*z', `/a${'b'.repeat(5000)}`)).toBe(false);
    expect(readPathMatches('/*a*a*a*a*a*a*a*a*b', `/${'a'.repeat(5000)}`)).toBe(false);
    expect(Date.now() - t).toBeLessThan(50);
  });
  it('matches only a POST to the same host (port included) and pathname', () => {
    const policy = { readPosts: [{ host: 'h:1', path: '/p*/x' }] };
    expect(matchingReadPost(policy, 'http://h:1/p1/x', 'post')).toEqual(policy.readPosts[0]);
    expect(matchingReadPost(policy, 'http://h:1/p1/x?a=/y', 'POST')).toBeDefined();
    expect(matchingReadPost(policy, 'http://h:2/p1/x', 'POST')).toBeUndefined();
    expect(matchingReadPost(policy, 'http://h:1/p1/x', 'PUT')).toBeUndefined();
    expect(matchingReadPost(policy, 'not a url', 'POST')).toBeUndefined();
    expect(matchingReadPost({}, 'http://h:1/p1/x', 'POST')).toBeUndefined();
  });
  it('readPostsProblem: the engine refuses what the node refuses, with the same wording', () => {
    expect(readPostsProblem(undefined)).toBeUndefined();
    expect(readPostsProblem([])).toBeUndefined();
    expect(readPostsProblem([{ host: 'h', path: '/sap*/bc/gui/sap/its/webgui' }])).toBeUndefined();
    expect(readPostsProblem({})).toBe('Read-only requests must be a list');
    expect(readPostsProblem([{ host: 'h', path: '/*' }])).toBe('Read-only request "POST h/*" must name at least one part of the path besides *');
    expect(readPostsProblem([{ host: 'h', path: '/sap/**' }])).toBe('Read-only request "POST h/sap/**": use a single * (it never matches /)');
    for (const bad of [null, 'h/x', { host: 'h' }, { host: 1, path: '/x' }, { host: '', path: '/x' }, { host: 'h', path: 'x' }, { host: 'h', path: 7 }]) {
      expect(readPostsProblem([{ host: 'h', path: '/ok' }, bad]), JSON.stringify(bad)).toBe('Read-only request 2 must have a host and a path starting with /');
    }
  });
});
