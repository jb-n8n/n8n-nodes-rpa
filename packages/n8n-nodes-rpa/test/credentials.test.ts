import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ICredentialType } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import { bound } from '../../engine/test/timing.js';
import { PlaywrightBrowserApi } from '../credentials/PlaywrightBrowserApi.credentials.js';
import { PlaywrightRedisApi } from '../credentials/PlaywrightRedisApi.credentials.js';
import { PlaywrightScriptSigningApi } from '../credentials/PlaywrightScriptSigningApi.credentials.js';
import { PlaywrightSiteLoginApi } from '../credentials/PlaywrightSiteLoginApi.credentials.js';
import { RpaDesktopRunnerApi } from '../credentials/RpaDesktopRunnerApi.credentials.js';
import { CREDENTIALS } from '../nodes/Playwright/config.js';
import { browserTestResult, CREDENTIAL_TEST_WAIT_MS, scriptSigningResult, siteLoginTestResult } from '../nodes/Playwright/credential-tests.js';

// The Local Browser test needs playwright-core to find no Chromium. vi.hoisted runs before the imports above, so
// playwright-core reads this path when it loads. Vitest runs each test file in its own process (pool: 'forks'), so
// other files still find the installed browser.
vi.hoisted(() => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent-playwright-browsers';
});

const SECRET_FIELDS = ['password', 'totpSecret', 'token', 'secretKey'];

const V2 = [new PlaywrightBrowserApi(), new PlaywrightSiteLoginApi(), new PlaywrightScriptSigningApi(), new PlaywrightRedisApi(), new RpaDesktopRunnerApi()];
const USE_CASE_WORDS = /\b(portal|recall|notice|dealer)s?\b/i;
type OptionLike = { name?: string; value?: unknown; description?: string };
/** Every text a user reads in the credential dialog (never `name` or `type`, which are identifiers). */
function texts(c: ICredentialType): string[] {
  const out = [c.displayName];
  for (const p of c.properties) {
    out.push(p.displayName, p.description ?? '', p.placeholder ?? '', p.hint ?? '');
    for (const o of (p.options ?? []) as OptionLike[]) out.push(o.name ?? '', o.description ?? '');
  }
  return out.filter(Boolean);
}
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('RPA Redis credential', () => {
  it('mirrors the fields the Redis guard store reads, with the TLS verification switch only under SSL', () => {
    const props = new PlaywrightRedisApi().properties;
    expect(props.map((p) => [p.name, p.default])).toEqual([
      ['host', 'localhost'], ['port', 6379], ['database', 0], ['user', ''], ['password', ''], ['ssl', false], ['disableTlsVerification', false],
    ]);
    expect(props.find((p) => p.name === 'disableTlsVerification')?.displayOptions).toEqual({ show: { ssl: [true] } });
    for (const p of props) expect(p.description, p.name).toBeTruthy();
  });
});

describe('v2 credential types', () => {
  it('have the CREDENTIALS names, and package.json registers each compiled file', () => {
    expect(V2.map((c) => c.name)).toEqual([CREDENTIALS.browser, CREDENTIALS.siteLogin, CREDENTIALS.signing, CREDENTIALS.redis, CREDENTIALS.desktopRunner]);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { n8n: { credentials: string[] } };
    for (const c of V2) expect(pkg.n8n.credentials).toContain(`dist/credentials/${c.constructor.name}.credentials.js`);
  });
  it('every credential display name starts with "RPA " (n8n lists credential types globally)', () => {
    expect(V2.map((c) => c.displayName)).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis', 'RPA Desktop Runner']);
    for (const c of V2) expect(c.displayName.startsWith('RPA ')).toBe(true);
  });
  it('names Playwright only where an operator needs it: the Browser Server protocol and the local install command', () => {
    const named = V2.flatMap((c) => texts(c).filter((t) => /playwright/i.test(t)));
    expect(named).toEqual([
      'A browser server container, or a hosted browser endpoint that speaks the Playwright protocol, such as Browserless',
      "Install Chromium next to n8n: npx playwright install chromium. Development only: the browser runs with n8n's network access and files.",
    ]);
  });
  it('mask exactly the secret fields', () => {
    for (const c of V2) {
      for (const p of c.properties) expect({ field: p.name, password: p.typeOptions?.password === true }).toEqual({ field: p.name, password: SECRET_FIELDS.includes(p.name) });
    }
  });
  it('declare a themed icon (the same file for light and dark) that exists, and a documentation URL', () => {
    for (const c of V2) {
      expect(c.icon).toEqual({ light: 'file:rpa.svg', dark: 'file:rpa.svg' }); // one icon: it reads on both themes
      expect(existsSync(new URL('../credentials/rpa.svg', import.meta.url))).toBe(true);
      expect(() => new URL(String(c.documentationUrl))).not.toThrow();
    }
  });
  it('no text in the v2 credential dialogs uses a use-case word', () => {
    for (const c of V2) for (const t of texts(c)) expect({ credential: c.name, text: t, match: USE_CASE_WORDS.test(t) }).toMatchObject({ match: false });
  });
  it('RPA Browser: fields, defaults and a start command per mode', () => {
    const props = new PlaywrightBrowserApi().properties;
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));
    expect(props.filter((p) => p.type !== 'notice').map((p) => p.name)).toEqual(['mode', 'wsUrl', 'token', 'privateNetwork', 'headless', 'slowMo']);
    expect(byName.mode.default).toBe('playwright');
    expect(((byName.mode.options ?? []) as OptionLike[]).map((o) => [o.value, o.name])).toEqual([
      ['playwright', 'Browser Server'], ['cdp', 'Chrome DevTools Protocol (CDP)'], ['local', 'Local Browser (Development Only)'],
    ]);
    expect(byName.wsUrl).toMatchObject({ displayName: 'Endpoint URL', default: 'ws://browser:3000/' });
    expect(byName.token).toMatchObject({ displayName: 'Token', hint: 'Never put the token in the URL' });
    expect(byName.privateNetwork).toMatchObject({ displayName: 'Private Network Endpoint', type: 'boolean', default: false });
    expect(byName.slowMo).toMatchObject({ displayName: 'Slow Motion (ms)', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 2000 } });
    expect(byName.slowMo.displayOptions).toBeUndefined(); // every mode
    const notice = (mode: string) =>
      props.filter((p) => p.type === 'notice' && p.displayOptions?.show?.mode?.includes(mode)).map((p) => p.displayName).join(' ');
    expect(notice('playwright')).toContain('docker compose up -d browser');
    expect(notice('playwright')).toContain('README: Where the browser runs');
    expect(notice('playwright')).toContain('BROWSER_TOKEN');
    expect(notice('local')).toContain('npx playwright install chromium');
    expect(notice('cdp').length).toBeGreaterThan(20);
  });
  it('RPA Site Login: the login page, the secrets and the six allowlist fields, in order', () => {
    const props = new PlaywrightSiteLoginApi().properties.filter((p) => p.type !== 'notice');
    expect(props.map((p) => [p.name, p.displayName])).toEqual([
      ['loginUrl', 'Login Page URL'], ['username', 'Username'], ['password', 'Password'], ['totpSecret', 'TOTP Secret'],
      ['navHosts', 'Sites the Browser May Open'], ['subresourceHosts', 'Sites It May Load Files From'],
      ['frameHosts', 'Sites Allowed in Embedded Frames'], ['login', 'Pages Where the Password May Be Typed'], ['allowedSubmits', 'Forms It May Submit'],
      ['readPosts', 'Requests That Only Read'],
    ]);
    expect(props.find((p) => p.name === 'navHosts')?.description).toContain("Empty means the login page's site only");
    const reads = props.find((p) => p.name === 'readPosts');
    expect(reads?.placeholder).toBe('POST example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch');
    for (const text of ['letters, digits and _ . ( ) = ~ -', '%3D', 'ZSRV;v=0002', 'without any check of what they send', 'On SAP the same endpoints also save data',
      'an SAP user that can only display', 'not *', 'Forms It May Submit']) expect(reads?.description, text).toContain(text);
    expect(reads?.description).not.toMatch(/any text|Playwright/);
  });
  it('RPA Step Signing: Signing Key with the openssl hint', () => {
    const key = new PlaywrightScriptSigningApi().properties.find((p) => p.name === 'secretKey');
    expect(key).toMatchObject({ displayName: 'Signing Key', hint: 'Generate one: openssl rand -hex 32', typeOptions: { password: true } });
  });
  it('RPA Step Signing opens with one notice that says what the key is for', () => {
    const [first, ...rest] = new PlaywrightScriptSigningApi().properties;
    expect(first).toMatchObject({ type: 'notice', default: '' });
    expect(first.displayName).toMatch(/openssl rand -hex 32/);
    expect(rest.filter((p) => p.type === 'notice')).toEqual([]);
  });
  it('package.json registers exactly the v2 credentials', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { n8n: { credentials: string[] }; homepage?: string };
    expect(pkg.n8n.credentials).toEqual([
      'dist/credentials/PlaywrightBrowserApi.credentials.js',
      'dist/credentials/PlaywrightSiteLoginApi.credentials.js',
      'dist/credentials/PlaywrightScriptSigningApi.credentials.js',
      'dist/credentials/PlaywrightRedisApi.credentials.js',
      'dist/credentials/RpaDesktopRunnerApi.credentials.js',
    ]);
    expect(() => new URL(String(pkg.homepage))).not.toThrow();
  });
});

describe('v2 credential tests', () => {
  it('Browser: a closed port fails at once with the golden message, without the token or the query string', async () => {
    const port = await closedPort();
    const r = await browserTestResult({ mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/?token=abc123`, token: 'tok-7f3a9c' }, engine);
    expect(r).toEqual({
      status: 'Error',
      message: `Could not connect to the browser server at ws://127.0.0.1:${port}/. Is it running? Start it with: docker compose up -d browser (README: Where the browser runs).`,
    });
    expect(r.message).not.toContain('tok-7f3a9c');
    expect(r.message).not.toContain('abc123');
  });
  it('Browser: a local browser without Chromium fails with the golden message', async () => {
    expect(await browserTestResult({ mode: 'local' }, engine)).toEqual({ status: 'Error', message: 'Chromium not found. Run: npx playwright install chromium' });
  });
  it('Browser: a connection reports the major.minor browser server version the node needs', async () => {
    const stub = {
      openSession: async () => ({ close: async () => undefined }), createMasker: engine.createMasker, PLAYWRIGHT_VERSION: '1.63.0',
    } as unknown as Parameters<typeof browserTestResult>[1];
    expect(await browserTestResult({}, stub)).toEqual({ status: 'OK', message: 'Connected to the browser server (1.63)' });
    expect(await browserTestResult({ mode: 'playwright', wsUrl: 'wss://browser.example.net/ws?token=abc123' }, stub))
      .toEqual({ status: 'OK', message: 'Connected to the browser server (1.63); move the token from the URL to the Token field' });
    expect(engine.PLAYWRIGHT_VERSION.startsWith('1.63.')).toBe(true);
  });
  it('Browser: Test connection waits at most 10 s for a free session of a busy browser service', async () => {
    let deadline = 0;
    const stub = {
      openSession: async (o: { deadlineMs?: number }) => { deadline = o.deadlineMs ?? 0; return { close: async () => undefined }; },
      createMasker: engine.createMasker, PLAYWRIGHT_VERSION: '1.63.0',
    } as unknown as Parameters<typeof browserTestResult>[1];
    const t0 = Date.now();
    await browserTestResult({}, stub);
    expect(CREDENTIAL_TEST_WAIT_MS).toBe(10_000);
    expect(deadline).toBeGreaterThanOrEqual(t0 + 10_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 10_000);
  });
  it('Browser: a browser service whose sessions are all busy passes (its gate accepted the token first)', async () => {
    // The gate's answer when every session is in use (images/browser/gate): 503 with the body `rpa-browser busy`.
    const srv = createHttpServer((_q, res) => { res.statusCode = 404; res.end(); });
    srv.on('upgrade', (_q, socket) => {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nX-RPA-Browser: busy\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 17\r\n\r\nrpa-browser busy\n');
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    try {
      const t0 = Date.now();
      const r = await browserTestResult({ mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/`, token: 't'.repeat(32) }, engine, 1500);
      expect(r).toEqual({ status: 'OK', message: 'Connected; the browser service accepted the token but every browser session is busy right now' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);
      expect(Date.now() - t0).toBeLessThan(bound(4000, 10_000));
      const hinted = await browserTestResult({ mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/?token=abc123` }, engine, 0);
      expect(hinted).toEqual({
        status: 'OK', message: 'Connected; the browser service accepted the token but every browser session is busy right now; move the token from the URL to the Token field',
      });
    } finally { srv.closeAllConnections(); await new Promise((resolve) => srv.close(resolve)); }
  });
  it('Site Login: counts what the credential allows, or says what is wrong', () => {
    const base = { loginUrl: 'https://example.com/login', username: 'u', password: 'p' };
    expect(siteLoginTestResult(base)).toEqual({ status: 'OK', message: 'Valid: 1 site(s) the browser may open, 1 password page(s), 0 form(s) it may submit' });
    expect(siteLoginTestResult({ ...base, navHosts: 'files.example.com', allowedSubmits: 'POST example.com/a\nexample.com/b' }))
      .toEqual({ status: 'OK', message: 'Valid: 2 site(s) the browser may open, 1 password page(s), 2 form(s) it may submit' });
    expect(siteLoginTestResult({ ...base, navHosts: '*.example.com' })).toEqual({ status: 'Error', message: '"*.example.com": wildcards are not allowed, list each exact host' });
  });
  it('Step Signing: a key of 31 characters is refused, 32 accepted', () => {
    expect(scriptSigningResult({ secretKey: 'k'.repeat(31) })).toEqual({
      status: 'Error', message: 'The Step Signing key must be at least 32 characters (generate one with: openssl rand -hex 32)',
    });
    expect(scriptSigningResult({ secretKey: 'k'.repeat(32) })).toEqual({ status: 'OK', message: 'Signing key accepted' });
  });
});
