import { describe, expect, it } from 'vitest';
import { readPathMatches, readPathTooBroad, readPostLabel } from 'n8n-rpa-engine';
import {
  browserConfig, ConfigError, CREDENTIALS, DEFAULT_ENDPOINT_URL, normalizeHost, parseAllowedSubmits, parseHosts, parseLoginPages, parseReadPosts, signingKey,
  siteLoginConfig, readPathMatchesLocal as nodeMatches, readPathTooBroadLocal as nodeTooBroad, readPostLabelLocal as nodeLabel,
} from '../nodes/Playwright/config.js';

describe('normalizeHost', () => {
  it.each([
    ['App.Example.com', 'app.example.com'],
    ['  app.example.com.  ', 'app.example.com'],
    ['app.example.com:443', 'app.example.com'],
    ['app.example.com:80', 'app.example.com'],
    ['app.example.com:8443', 'app.example.com:8443'],
    ['https://App.Example.com:443', 'app.example.com'],
    ['http://app.example.com:80', 'app.example.com'],
    ['http://127.0.0.1:8080', '127.0.0.1:8080'],
    ['[::1]:3000', '[::1]:3000'],
    ['app.example.com/', 'app.example.com'],
  ])('%s → %s', (raw, host) => {
    expect(normalizeHost(raw)).toBe(host);
  });
  it.each([
    ['*.example.com', /wildcards are not allowed/],
    ['app.example.com/login', /without a path/],
    ['', /empty/],
    ['http://', /not a valid host/],
    ['/login', /without a path/],
    ['//evil.com', /without a path/],
    ['https://app.example.com/login', /without a path/],
    ['https://evil.com@app.example.com', /without a path/],
    ['ftp://app.example.com', /only http, https, ws and wss/],
    ['.', /not a valid host/],
    ['.:8080', /not a valid host/],
    ['app.example.com..', /not a valid host/],
  ])('rejects %j', (raw, message) => {
    expect(() => normalizeHost(raw)).toThrow(ConfigError);
    expect(() => normalizeHost(raw)).toThrow(message);
  });
});

describe('lists', () => {
  it('hosts: one per line or comma, normalised and de-duplicated', () => {
    expect(parseHosts('cdn.example.com, CDN.example.com:443\nstatic.example.com\n\n')).toEqual(['cdn.example.com', 'static.example.com']);
  });
  it('login pages: host/path or a URL; query and fragment dropped', () => {
    expect(parseLoginPages('App.example.com/login?next=1\nhttps://app.example.com:443/mfa#x')).toEqual([
      { host: 'app.example.com', path: '/login' },
      { host: 'app.example.com', path: '/mfa' },
    ]);
    expect(parseLoginPages('app.example.com/über\napp.example.com/a/../login')).toEqual([
      { host: 'app.example.com', path: '/%C3%BCber' },
      { host: 'app.example.com', path: '/login' },
    ]);
    expect(() => parseHosts('app.example.com /login')).toThrow(/without a path/);
    expect(() => parseLoginPages('app.example.com')).toThrow(/must look like example.com\/path/);
  });
  it('allowed submissions: optional method (default POST), host/path or URL', () => {
    expect(parseAllowedSubmits('post app.example.com/reports/export\nhttps://app.example.com/filter\nPUT app.example.com/x')).toEqual([
      { host: 'app.example.com', path: '/reports/export', method: 'POST' },
      { host: 'app.example.com', path: '/filter', method: 'POST' },
      { host: 'app.example.com', path: '/x', method: 'PUT' },
    ]);
    expect(() => parseAllowedSubmits('FETCH app.example.com/x')).toThrow(/method FETCH is not allowed/);
  });
});

describe('signingKey', () => {
  it('requires a signing key of at least 32 characters', () => {
    expect(signingKey({ secretKey: 'k'.repeat(32) })).toBe('k'.repeat(32));
    expect(() => signingKey({ secretKey: 'short' })).toThrow(/at least 32 characters/);
    expect(() => signingKey({})).toThrow(/at least 32 characters/);
  });
});

describe('config errors never echo credentials in an entry', () => {
  it.each([
    () => normalizeHost('https://user:secret@app.example.com/x'),
    () => normalizeHost('user:secret@app.example.com'),
    () => parseLoginPages('https://user:secret@app.example.com/login'),
    () => parseAllowedSubmits('POST https://user:secret@app.example.com/submit'),
    () => parseHosts('user:secret@*.example.com'),
  ])('redacts userinfo (%#)', (run) => {
    let message = '';
    try {
      run();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('<entry with credentials>');
    expect(message).not.toMatch(/secret|user:/);
  });
});

describe('config errors never echo a query string or a fragment', () => {
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };
  it.each([
    [() => normalizeHost('https://app.example.com/x?token=tok-123#frag-9'), '"https://app.example.com/x" must be a host such as example.com, without a path'],
    [() => normalizeHost('app.example.com/?token=tok-123'), '"app.example.com/" must be a host such as example.com, without a path'],
    [() => parseAllowedSubmits('FETCH app.example.com/x?token=tok-123'), 'Allowed submission "FETCH app.example.com/x": method FETCH is not allowed'],
  ])('strips ?query and #fragment from the echoed entry (%#)', (run, expected) => {
    const message = messageOf(run);
    expect(message).toContain(expected);
    expect(message).not.toMatch(/tok-123|frag-9|\?|#/);
  });
});

describe('v2 credential names', () => {
  it('names the v2 credential types and the Redis credential', () => {
    expect(CREDENTIALS).toEqual({
      browser: 'playwrightBrowserApi', siteLogin: 'playwrightSiteLoginApi', signing: 'playwrightScriptSigningApi', redis: 'playwrightRedisApi', desktopRunner: 'rpaDesktopRunnerApi',
    });
    expect(DEFAULT_ENDPOINT_URL).toBe('ws://browser:3000/');
  });
  it('host errors use a neutral example host', () => {
    expect(() => normalizeHost('example.com/login')).toThrow('"example.com/login" must be a host such as example.com, without a path');
  });
});

describe('browserConfig (RPA Browser credential)', () => {
  it('defaults to the reference browser server of the compose stack', () => {
    expect(browserConfig({})).toEqual({ mode: 'playwright', wsUrl: 'ws://browser:3000/' });
    expect(browserConfig({ mode: '', wsUrl: '   ' })).toEqual({ mode: 'playwright', wsUrl: 'ws://browser:3000/' });
  });
  it('passes the token and Private Network Endpoint through, and trims the URL', () => {
    expect(browserConfig({ mode: 'playwright', wsUrl: ' ws://browser:3000/ ', token: 't0k', privateNetwork: true }))
      .toEqual({ mode: 'playwright', wsUrl: 'ws://browser:3000/', token: 't0k', privateNetwork: true });
    expect(browserConfig({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/', privateNetwork: false })).toEqual({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/' });
  });
  it('maps the local browser, headless unless turned off', () => {
    expect(browserConfig({ mode: 'local' })).toEqual({ mode: 'local', headless: true });
    expect(browserConfig({ mode: 'local', headless: false, privateNetwork: true, wsUrl: 'ws://x/' })).toEqual({ mode: 'local', headless: false });
  });
  it('passes Slow Motion through only when it is above 0, clamped to 2000 ms (for watching a run)', () => {
    expect(browserConfig({ slowMo: 400 })).toEqual({ mode: 'playwright', wsUrl: 'ws://browser:3000/', slowMo: 400 });
    expect(browserConfig({ mode: 'cdp', wsUrl: 'http://cdp:9223', slowMo: 9999 })).toMatchObject({ slowMo: 2000 });
    expect(browserConfig({ mode: 'local', slowMo: 250.7 })).toEqual({ mode: 'local', headless: true, slowMo: 250 });
    for (const off of [0, -5, '300', undefined, Number.NaN]) expect(browserConfig({ slowMo: off as never })).not.toHaveProperty('slowMo');
  });
  it('refuses an unknown mode', () => {
    expect(() => browserConfig({ mode: 'ftp' })).toThrow(ConfigError);
    expect(() => browserConfig({ mode: 'ftp' })).toThrow('Mode must be Browser Server, Chrome DevTools Protocol (CDP) or Local Browser');
  });
});

describe('siteLoginConfig (RPA Site Login credential)', () => {
  const base = { loginUrl: 'https://Example.com/login', username: ' site-user ', password: ' pass word ' };
  it('empty host lists mean the login page site only, and the password may be typed on the login page', () => {
    expect(siteLoginConfig(base)).toEqual({
      policy: {
        startUrl: 'https://example.com/login', navHosts: ['example.com'], subresourceHosts: [],
        login: [{ host: 'example.com', path: '/login' }], allowedSubmits: [],
      },
      secrets: { username: 'site-user', password: ' pass word ' },
    });
  });
  it('reads every list with the shared host normalisation', () => {
    const s = siteLoginConfig({
      ...base, navHosts: 'files.example.com, Example.com', subresourceHosts: 'cdn.example.com:443', frameHosts: 'www.recaptcha.net',
      login: 'example.com/login\nexample.com/mfa', allowedSubmits: 'POST example.com/reports/export', totpSecret: 'JBSW Y3DP EHPK 3PXP',
    });
    expect(s.policy).toEqual({
      startUrl: 'https://example.com/login',
      navHosts: ['example.com', 'files.example.com'],
      subresourceHosts: ['cdn.example.com'],
      frameHosts: ['www.recaptcha.net'],
      login: [{ host: 'example.com', path: '/login' }, { host: 'example.com', path: '/mfa' }],
      allowedSubmits: [{ host: 'example.com', path: '/reports/export', method: 'POST' }],
    });
    expect(s.secrets).toEqual({ username: 'site-user', password: ' pass word ', totpSecret: 'JBSWY3DPEHPK3PXP' });
  });
  it('names the v2 fields in its errors', () => {
    expect(() => siteLoginConfig({ ...base, loginUrl: 'example.com' })).toThrow('Login Page URL must be a full URL such as https://example.com/login');
    expect(() => siteLoginConfig({ ...base, loginUrl: 'ftp://example.com/' })).toThrow('Login Page URL must use http or https');
    expect(() => siteLoginConfig({ ...base, loginUrl: 'https://example.com./' })).toThrow('Login Page URL host must not end with a dot');
    expect(() => siteLoginConfig({ ...base, loginUrl: 'https://u:secret@example.com/' }))
      .toThrow('Login Page URL must not contain a username or password: use the Username and Password fields');
    expect(() => siteLoginConfig({ ...base, password: '' })).toThrow('Username and Password are required');
    expect(() => siteLoginConfig({ ...base, login: 'sso.example.com/login' })).toThrow('Password page host sso.example.com is not in Sites the Browser May Open');
    expect(() => siteLoginConfig({ ...base, login: 'example.com' })).toThrow('Password page "example.com" must look like example.com/path');
    expect(() => siteLoginConfig({ ...base, allowedSubmits: 'reports.example.com/x' }))
      .toThrow('Form host reports.example.com is not in Sites the Browser May Open or Sites It May Load Files From');
    expect(() => siteLoginConfig({ ...base, allowedSubmits: 'FETCH example.com/x' })).toThrow('Form "FETCH example.com/x": method FETCH is not allowed');
  });
  it('never echoes credentials from the login URL or an entry', () => {
    const messages: string[] = [];
    for (const data of [
      { ...base, loginUrl: 'https://user:secret@example.com/login' },
      { ...base, navHosts: 'user:secret@example.com' },
      { ...base, allowedSubmits: 'POST https://user:secret@example.com/submit' },
      { ...base, readPosts: 'POST https://user:secret@example.com/sap/*/x' },
    ]) {
      try {
        siteLoginConfig(data);
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(4);
    for (const m of messages) expect(m).not.toMatch(/secret|user:/);
  });
});

describe('read-only requests (Requests That Only Read)', () => {
  const base = { loginUrl: 'https://example.com/login', username: 'site-user', password: 'site-pass' };
  const messageOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };
  it('reads read-only requests', () => {
    expect(parseReadPosts('POST example.com/sap*/bc/gui/sap/its/webgui\nexample.com/sap/opu/odata/sap/*/$batch')).toEqual([
      { host: 'example.com', path: '/sap*/bc/gui/sap/its/webgui' },
      { host: 'example.com', path: '/sap/opu/odata/sap/*/$batch' },
    ]);
    expect(siteLoginConfig({ ...base, readPosts: 'POST example.com/sap*/bc/gui/sap/its/webgui' }).policy.readPosts).toEqual([
      { host: 'example.com', path: '/sap*/bc/gui/sap/its/webgui' },
    ]);
  });
  it('refuses read-only requests that are too broad', () => {
    expect(messageOf(() => parseReadPosts('example.com/*'))).toBe('Read-only request "example.com/*" must name at least one part of the path besides *');
    expect(messageOf(() => parseReadPosts('example.com/sap/**'))).toBe('Read-only request "example.com/sap/**": use a single * (it never matches /)');
    expect(messageOf(() => parseReadPosts('PUT example.com/x'))).toBe('Read-only request "PUT example.com/x": only POST can be listed');
  });
  it('refuses a read-only request on an unlisted host', () => {
    expect(messageOf(() => siteLoginConfig({ ...base, readPosts: 'POST other.example.net/sap/x' })))
      .toBe('Read-only request host other.example.net is not in Sites the Browser May Open or Sites It May Load Files From');
  });
  it('refuses a read-only request that is also a form', () => {
    expect(messageOf(() => siteLoginConfig({ ...base, allowedSubmits: 'POST example.com/reports/export', readPosts: 'example.com/reports/*' })))
      .toBe('Read-only request "POST example.com/reports/*" also matches Form "POST example.com/reports/export": list a request in one field only');
  });
  it('no read-only requests means no readPosts key', () => {
    expect('readPosts' in siteLoginConfig(base).policy).toBe(false);
  });
  it('the node copies of the matcher and the label agree with the engine', () => {
    const patterns = ['/sap*/bc/x', '/a/*/b', '/a/b*', '/*', '/**', '/', '/a/*', '/x/*/*'];
    const paths = ['/sap/bc/x', '/sapabc/x', '/a/q/b', '/a/b', '/a/bz', '/a/b;x', '/a/b%41', '/a//b', '/x/y/z', '/'];
    for (const pat of patterns) {
      expect(readPathTooBroad(pat)).toBe(nodeTooBroad(pat));
      for (const path of paths) expect(nodeMatches(pat, path)).toBe(readPathMatches(pat, path));
    }
    expect(nodeLabel({ host: 'h', path: '/p' })).toBe(readPostLabel({ host: 'h', path: '/p' }));
  });
  it('the node copy lets a star span the exact %3D / %3d triplet, like the engine', () => {
    expect(nodeMatches('/sap*/bc/gui/sap/its/webgui', '/sap(cz1TSUQ6QU5PTjo%3D%3d)/bc/gui/sap/its/webgui')).toBe(true);
    for (const bad of ['%3', '%3E', '%25', '%253D', '%%3D']) expect(nodeMatches('/a*', `/a${bad}`), bad).toBe(false);
  });
  it('parity sweep: every printable ASCII character after a star, the %3D triplets, and multi-star backtracking', () => {
    const cases: [string, string][] = [];
    for (let code = 0x20; code <= 0x7e; code++) {
      const c = String.fromCharCode(code);
      cases.push(['/a*', `/a${c}`], ['/a*', `/a${c}b`], ['/a*b', `/a${c}b`]);
    }
    for (const t of ['%3D', '%3d', '%3', '%3E', '%25', '%253D', '%%3D', '%3D%']) cases.push(['/a*', `/a${t}`], ['/a*b', `/a${t}b`]);
    for (const path of ['/aXbYc', '/abc', '/aXbY', '/abbbc', '/aXcbYc', '/a;bYc', '/a%3Db%3dc']) cases.push(['/a*b*c', path]);
    for (const [pat, path] of cases) expect(nodeMatches(pat, path), `${pat} vs ${path}`).toBe(readPathMatches(pat, path));
    expect(nodeMatches('/a*b*c', '/aXbYc')).toBe(true);
    expect(nodeMatches('/a*b*c', '/aXbY')).toBe(false);
  });
});
