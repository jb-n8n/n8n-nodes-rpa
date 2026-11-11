import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readPathMatches, readPathTooBroad, readPostLabel } from 'n8n-rpa-engine';
import {
  browserConfig, ConfigError, CREDENTIALS, DEFAULT_ENDPOINT_URL, desktopRunnerConfig, normalizeHost, parseAllowedSubmits, parseHosts, parseLoginPages, parseReadPosts, signingKey,
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
  /** A SHA-256 fingerprint as the engine prints one: 32 uppercase hex pairs joined by colons. */
  const FINGERPRINT = Array.from({ length: 32 }, () => 'AA').join(':');
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
  it('the fingerprint reaches the endpoint in Browser Server mode', () => {
    const endpoint = browserConfig({ mode: 'playwright', wsUrl: 'wss://browser.example.net/', token: 't0k', fingerprint: FINGERPRINT });
    expect(endpoint.fingerprint).toBe(FINGERPRINT);
    expect(endpoint).toEqual({ mode: 'playwright', wsUrl: 'wss://browser.example.net/', token: 't0k', fingerprint: FINGERPRINT });
    // A pasted value often ends with a space or a line break.
    expect(browserConfig({ wsUrl: 'wss://browser.example.net/', fingerprint: `  ${FINGERPRINT} \r\n` }).fingerprint).toBe(FINGERPRINT);
    // The engine checks the format (BROWSER_FINGERPRINT_INVALID) and the wss:// rule (BROWSER_FINGERPRINT_NEEDS_WSS).
    expect(browserConfig({ wsUrl: 'ws://browser:3000/', fingerprint: 'not a fingerprint' }).fingerprint).toBe('not a fingerprint');
  });
  it('an empty fingerprint is left out', () => {
    for (const empty of ['', '   ', ' \r\n\t', undefined, null]) {
      const endpoint = browserConfig({ mode: 'playwright', wsUrl: 'wss://browser.example.net/', fingerprint: empty });
      expect('fingerprint' in endpoint, JSON.stringify(empty)).toBe(false);
    }
  });
  it('a fingerprint value that is not text is passed on as text, never read as no fingerprint', () => {
    // Such a value can only come from an expression or the API. The engine checks the text like a typed value.
    const passed = (value: unknown) => browserConfig({ mode: 'playwright', wsUrl: 'wss://browser.example.net/', fingerprint: value }).fingerprint;
    expect(passed(42)).toBe('42');
    expect(passed(0)).toBe('0');
    expect(passed(false)).toBe('false');
    expect(passed({ sha256: FINGERPRINT })).toBe('[object Object]');
    // An empty array's text is empty, which would read as no fingerprint: its type name is passed instead.
    expect(passed([])).toBe('(object)');
    expect(passed([' '])).toBe('(object)');
  });
  it('the fingerprint is ignored in CDP and Local modes', () => {
    expect(browserConfig({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/', fingerprint: FINGERPRINT })).toEqual({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/' });
    expect(browserConfig({ mode: 'local', fingerprint: FINGERPRINT })).toEqual({ mode: 'local', headless: true });
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

/** The lines the Windows installer prints (Task I prints them; this file is shared with its Pester tests). */
interface LineSample { line: string; address: string; port: number; url: string; token: string; fingerprint: string }
const LINES = JSON.parse(readFileSync(new URL('./fixtures/connection-lines.json', import.meta.url), 'utf8')) as {
  about: string; runner: LineSample; browser: LineSample | null;
}[];

describe('Connection Line (RPA Desktop Runner and RPA Browser credentials)', () => {
  const RUNNER = LINES[0].runner;
  const BROWSER = LINES[0].browser as LineSample;
  /** The message a credential gives for a line, checked never to carry the line's token. */
  const refusal = (run: () => unknown, token = RUNNER.token): string => {
    let message = '';
    try { run(); } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(token);
    expect(message).not.toContain('SampleBrowserToken');
    return message;
  };
  const runnerLine = (connectionLine: string) => () => desktopRunnerConfig({ connectionLine });
  const browserLine = (connectionLine: string) => () => browserConfig({ connectionLine });

  it('the shared samples have six lines or more: with and without a browser, IPv6 in brackets, a name, a port that is not the default', () => {
    expect(LINES.length).toBeGreaterThanOrEqual(6);
    expect(LINES.some((s) => s.browser === null)).toBe(true);
    expect(LINES.some((s) => s.browser !== null)).toBe(true);
    expect(LINES.some((s) => s.runner.address.startsWith('['))).toBe(true);
    expect(LINES.some((s) => /[a-z]/i.test(s.runner.address) && !s.runner.address.startsWith('['))).toBe(true);
    expect(LINES.some((s) => s.runner.port !== 8765 || (s.browser !== null && s.browser.port !== 3000))).toBe(true);
  });
  it.each(LINES.map((s) => [s.about, s] as const))('runner line, %s: the address, the token and the fingerprint come from it', (_about, s) => {
    expect(desktopRunnerConfig({ connectionLine: s.runner.line })).toEqual({ url: s.runner.url, token: s.runner.token, fingerprint: s.runner.fingerprint });
  });
  it.each(LINES.filter((s) => s.browser !== null).map((s) => [s.about, s] as const))('browser line, %s: Browser Server mode with its address, token and fingerprint', (_about, s) => {
    const b = s.browser as LineSample;
    expect(browserConfig({ connectionLine: b.line })).toEqual({ mode: 'playwright', wsUrl: b.url, token: b.token, fingerprint: b.fingerprint });
  });
  it('a filled line wins over the three separate fields; an empty one leaves everything as it was', () => {
    const fields = { url: 'wss://other.example.net:8765', token: 'field-token', fingerprint: 'AB'.repeat(32) };
    expect(desktopRunnerConfig({ ...fields, connectionLine: `  ${RUNNER.line} \n` })).toEqual({ url: RUNNER.url, token: RUNNER.token, fingerprint: RUNNER.fingerprint });
    expect(desktopRunnerConfig({ ...fields, connectionLine: '   ' })).toEqual(fields);
    expect(browserConfig({ mode: 'playwright', wsUrl: 'ws://browser:3000/', token: 't', fingerprint: 'x', connectionLine: BROWSER.line, privateNetwork: true, slowMo: 250 }))
      .toEqual({ mode: 'playwright', wsUrl: BROWSER.url, token: BROWSER.token, fingerprint: BROWSER.fingerprint, privateNetwork: true, slowMo: 250 });
    expect(browserConfig({ wsUrl: 'wss://b.example.net/', token: 't', connectionLine: '' })).toEqual({ mode: 'playwright', wsUrl: 'wss://b.example.net/', token: 't' });
  });
  it('the browser line is read in Browser Server mode only, where its field shows', () => {
    expect(browserConfig({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/', connectionLine: BROWSER.line })).toEqual({ mode: 'cdp', wsUrl: 'wss://cdp.example.net/' });
    expect(browserConfig({ mode: 'local', connectionLine: BROWSER.line })).toEqual({ mode: 'local', headless: true });
  });
  it('a fingerprint written as colon-separated pairs, in lower case, is passed on as written (the engine checks it, as for the separate field)', () => {
    const pairs = RUNNER.fingerprint.toLowerCase().match(/../g)!.join(':');
    const line = RUNNER.line.replace(RUNNER.fingerprint, pairs);
    expect(desktopRunnerConfig({ connectionLine: line }).fingerprint).toBe(pairs);
  });
  it('a line of the other kind is refused, naming the credential it belongs to', () => {
    expect(refusal(runnerLine(BROWSER.line), BROWSER.token)).toBe(
      'The Connection Line in the RPA Desktop Runner credential is the browser\'s line (rpa-browser://). Paste it into an RPA Browser credential, and here the line that starts with rpa-runner://.',
    );
    expect(refusal(browserLine(RUNNER.line))).toBe(
      'The Connection Line in the RPA Browser credential is the desktop runner\'s line (rpa-runner://). Paste it into an RPA Desktop Runner credential, and here the line that starts with rpa-browser://.',
    );
  });
  it('the installer\'s hidden token is refused with what to run instead', () => {
    const hidden = RUNNER.line.replace(RUNNER.token, '<hidden: run with -ShowTokens>');
    expect(refusal(runnerLine(hidden))).toBe(
      'The Connection Line in the RPA Desktop Runner credential has no token: the installer hides it. Run Show-RpaConnection.ps1 -ShowTokens on that machine and paste the line it prints.',
    );
  });
  it.each([
    ['not a line at all', 'wss://rpa-bot-01:8765/rpa/v1', 'must be the whole line that starts with rpa-runner://, as the installer prints it'],
    ['no port', RUNNER.line.replace(':8765', ''), 'has no address and port (rpa-runner://<address>:<port>/rpa/v1)'],
    ['no address', RUNNER.line.replace('rpa-bot-01', ''), 'has no address and port (rpa-runner://<address>:<port>/rpa/v1)'],
    ['credentials in the address', RUNNER.line.replace('rpa-bot-01', 'user:pw@rpa-bot-01'), 'has no address and port (rpa-runner://<address>:<port>/rpa/v1)'],
    ['port 0', RUNNER.line.replace(':8765', ':0'), 'The port in the Connection Line of the RPA Desktop Runner credential must be a number from 1 to 65535.'],
    ['port 70000', RUNNER.line.replace(':8765', ':70000'), 'The port in the Connection Line of the RPA Desktop Runner credential must be a number from 1 to 65535.'],
    ['another path', RUNNER.line.replace('/rpa/v1', '/rpa/v2'), 'must continue with /rpa/v1 after the port'],
    ['no path', RUNNER.line.replace('/rpa/v1', ''), 'must continue with /rpa/v1 after the port'],
    ['a query', RUNNER.line.replace('/rpa/v1', '/rpa/v1?x=1'), 'must continue with /rpa/v1 after the port'],
    ['nothing after #', RUNNER.line.slice(0, RUNNER.line.indexOf('#')), 'has no token (token=…)'],
    ['an empty token', RUNNER.line.replace(RUNNER.token, ''), 'has no token (token=…)'],
    ['no fingerprint', RUNNER.line.slice(0, RUNNER.line.indexOf('&')), 'has no fingerprint (fingerprint=…)'],
    ['63 hex digits', RUNNER.line.replace(RUNNER.fingerprint, RUNNER.fingerprint.slice(1)), 'The fingerprint in the Connection Line of the RPA Desktop Runner credential is not 64 hex digits.'],
    ['a letter that is not hex', RUNNER.line.replace(RUNNER.fingerprint, `G${RUNNER.fingerprint.slice(1)}`), 'is not 64 hex digits'],
    ['an unknown part', `${RUNNER.line}&mode=x`, 'may hold only token= and fingerprint=, once each, after the #'],
    ['a part twice', `${RUNNER.line}&token=again`, 'may hold only token= and fingerprint=, once each, after the #'],
    ['a part without =', RUNNER.line.replace('token=', 'token'), 'may hold only token= and fingerprint=, once each, after the #'],
  ])('a runner line with %s is refused, without the line in the message', (_what, line, expected) => {
    expect(refusal(runnerLine(line))).toContain(expected);
  });
  it('browser lines are checked the same way, with the browser\'s path', () => {
    expect(refusal(browserLine(BROWSER.line.replace(':3000/#', ':3000/rpa/v1#')), BROWSER.token)).toBe(
      'The Connection Line in the RPA Browser credential must continue with / after the port.',
    );
    expect(refusal(browserLine(BROWSER.line.replace(':3000/#', ':3000#')), BROWSER.token)).toContain('must continue with / after the port');
    expect(refusal(browserLine(BROWSER.line.replace(BROWSER.fingerprint, 'AB')), BROWSER.token)).toBe(
      'The fingerprint in the Connection Line of the RPA Browser credential is not 64 hex digits.',
    );
    expect(refusal(browserLine('ws://browser:3000/'), BROWSER.token)).toBe(
      'The Connection Line in the RPA Browser credential must be the whole line that starts with rpa-browser://, as the installer prints it.',
    );
  });
});
