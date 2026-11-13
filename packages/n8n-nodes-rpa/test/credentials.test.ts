import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { USE_CASE_WORDS } from 'n8n-rpa-engine';
import { NodeHelpers, type ICredentialType, type INodeParameters, type INodeProperties } from 'n8n-workflow';
import * as engine from 'n8n-rpa-engine';
import { bound } from '../../engine/test/timing.js';
import { PlaywrightBrowserApi } from '../credentials/PlaywrightBrowserApi.credentials.js';
import { PlaywrightRedisApi } from '../credentials/PlaywrightRedisApi.credentials.js';
import { PlaywrightScriptSigningApi } from '../credentials/PlaywrightScriptSigningApi.credentials.js';
import { PlaywrightSiteLoginApi } from '../credentials/PlaywrightSiteLoginApi.credentials.js';
import { RpaDesktopRunnerApi } from '../credentials/RpaDesktopRunnerApi.credentials.js';
import { RpaSecretVariablesApi } from '../credentials/RpaSecretVariablesApi.credentials.js';
import { CREDENTIALS, desktopRunnerConfig, siteLoginConfig } from '../nodes/Playwright/config.js';
import { browserTestResult, CREDENTIAL_TEST_WAIT_MS, scriptSigningResult, secretVariablesTestResult, siteLoginTestResult } from '../nodes/Playwright/credential-tests.js';

// The Local Browser test needs playwright-core to find no Chromium. vi.hoisted runs before the imports above, so
// playwright-core reads this path when it loads. Vitest runs each test file in its own process (pool: 'forks'), so
// other files still find the installed browser.
vi.hoisted(() => {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent-playwright-browsers';
});

const SECRET_FIELDS = ['password', 'totpSecret', 'token', 'secretKey', 'connectionLine'];

const V2 = [new PlaywrightBrowserApi(), new PlaywrightSiteLoginApi(), new PlaywrightScriptSigningApi(), new PlaywrightRedisApi(), new RpaDesktopRunnerApi(), new RpaSecretVariablesApi()];
type OptionLike = { name?: string; value?: unknown; description?: string };
/** Every text a user reads in the credential dialog (never `name` or `type`, which are identifiers). */
function texts(c: ICredentialType): string[] {
  const out = [c.displayName];
  const add = (p: INodeProperties) => {
    out.push(p.displayName, p.description ?? '', p.placeholder ?? '', p.hint ?? '');
    for (const o of (p.options ?? []) as (OptionLike & { displayName?: string; values?: INodeProperties[] })[]) {
      out.push(o.name ?? '', o.description ?? '', o.displayName ?? '');
      for (const v of o.values ?? []) add(v);
    }
  };
  for (const p of c.properties) add(p);
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
    expect(V2.map((c) => c.name)).toEqual([CREDENTIALS.browser, CREDENTIALS.siteLogin, CREDENTIALS.signing, CREDENTIALS.redis, CREDENTIALS.desktopRunner, CREDENTIALS.secretVariables]);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { n8n: { credentials: string[] } };
    for (const c of V2) expect(pkg.n8n.credentials).toContain(`dist/credentials/${c.constructor.name}.credentials.js`);
  });
  it('every credential display name starts with "RPA " (n8n lists credential types globally)', () => {
    expect(V2.map((c) => c.displayName)).toEqual(['RPA Browser', 'RPA Site Login', 'RPA Step Signing', 'RPA Redis', 'RPA Desktop Runner', 'RPA Secret Variables']);
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
  it('the Connection Line is a password-type field that takes no expression, in both credentials', () => {
    for (const c of [new RpaDesktopRunnerApi(), new PlaywrightBrowserApi()]) {
      expect(c.properties.find((p) => p.name === 'connectionLine'), c.name).toMatchObject({
        displayName: 'Connection Line', type: 'string', default: '', noDataExpression: true, typeOptions: { password: true },
      });
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
    expect(props.filter((p) => p.type !== 'notice').map((p) => p.name)).toEqual(['mode', 'connectionLine', 'wsUrl', 'token', 'fingerprint', 'privateNetwork', 'headless', 'slowMo']);
    expect(byName.connectionLine).toMatchObject({ placeholder: 'rpa-browser://<address>:3000/#token=…&fingerprint=…', displayOptions: { show: { mode: ['playwright'] } } });
    expect(byName.connectionLine.description).toBe(
      'The one line the Windows installer prints for the browser. It holds the address, the token and the certificate fingerprint: keep it as secret as the token. When it is filled, Endpoint URL, Token and Certificate Fingerprint are not used.',
    );
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
    expect(notice('playwright')).toContain('which the installer prints when it finishes and, on that machine as an administrator, & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens prints again');
    expect(notice('playwright')).toContain('paste the browser\'s Connection Line');
    expect(notice('playwright')).toContain('Private Network Endpoint stays off');
    expect(notice('local')).toContain('npx playwright install chromium');
    expect(notice('cdp').length).toBeGreaterThan(20);
  });
  it('RPA Browser: Certificate Fingerprint (SHA-256) comes after Token and shows in Browser Server mode only', () => {
    const props = new PlaywrightBrowserApi().properties;
    const at = props.findIndex((p) => p.name === 'fingerprint');
    expect(props[at - 1]?.name).toBe('token');
    expect(props[at]).toEqual({
      displayName: 'Certificate Fingerprint (SHA-256)',
      name: 'fingerprint',
      type: 'string',
      default: '',
      noDataExpression: true,
      description:
        "Only for a browser server with its own certificate, such as the one the Windows installer sets up: paste the fingerprint it shows. Leave empty when n8n already trusts the server's certificate.",
      displayOptions: { show: { mode: ['playwright'] } },
    });
  });
  it('RPA Desktop Runner: says where its Connection Line and its three values come from', () => {
    const props = new RpaDesktopRunnerApi().properties;
    expect(props[0].displayName).toBe(
      'Paste the Connection Line the installer printed on the Windows machine. To print it again there, as an administrator: & "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens',
    );
    expect(props.find((p) => p.name === 'fingerprint')?.description).toContain('as rpa connection prints it');
    // The installer and its closing lines name the rpa command; the credentials name it too, not the script behind it.
    expect(JSON.stringify(props)).not.toContain('Show-RpaConnection');
    const line = props.find((p) => p.name === 'connectionLine');
    expect(line).toMatchObject({ placeholder: 'rpa-runner://<address>:8765/rpa/v1#token=…&fingerprint=…' });
    expect(line?.description).toBe(
      'The one line the Windows installer prints for the runner. It holds the address, the token and the certificate fingerprint: keep it as secret as the token. When it is filled, the three fields below are not used.',
    );
  });
  it('RPA Desktop Runner: a saved credential keeps working through what n8n does to it on save and on read', () => {
    const props = new RpaDesktopRunnerApi().properties;
    // n8n drops the values of fields displayOptions hide: the dialog saves getNodeParameters(…, false, false) and a run
    // reads getNodeParameters(…, true, false). No field of this credential may be hidden, or old credentials would empty.
    for (const p of props) expect(p.displayOptions, p.name).toBeUndefined();
    const separate: INodeProperties = { displayName: 'Switch', name: 'separate', type: 'boolean', default: false };
    const switched = [...props, separate].map((p): INodeProperties => (p.name === 'url' ? { ...p, displayOptions: { show: { separate: [true] } } } : p));
    expect(NodeHelpers.getNodeParameters(switched, { url: 'wss://x' }, true, false, null, null)?.url).toBeUndefined(); // the drop itself
    const saved = (data: INodeParameters) => NodeHelpers.getNodeParameters(props, data, false, false, null, null) ?? {};
    const read = (data: INodeParameters) => desktopRunnerConfig(NodeHelpers.getNodeParameters(props, saved(data), true, false, null, null) ?? {});
    const fields = { url: 'wss://runner.example.net:8765/rpa/v1', token: 'saved-token', fingerprint: 'ab'.repeat(32) };
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/connection-lines.json', import.meta.url), 'utf8')) as { samples: { kind: string; line: string; url: string; token: string; fingerprint: string }[] };
    const runners = fixture.samples.filter((s) => s.kind === 'runner');
    expect(runners.length).toBeGreaterThan(0);
    // As saved before the Connection Line existed: the three fields only.
    expect(read(fields)).toEqual(fields);
    for (const s of runners) {
      expect(read({ connectionLine: s.line })).toEqual({ url: s.url, token: s.token, fingerprint: s.fingerprint });
      // Both filled: the Connection Line wins, as it always has.
      expect(read({ ...fields, connectionLine: s.line })).toEqual({ url: s.url, token: s.token, fingerprint: s.fingerprint });
    }
  });
  it('RPA Secret Variables: name and value pairs, the value a password-type field, and what the node does with them', () => {
    const c = new RpaSecretVariablesApi();
    expect({ name: c.name, displayName: c.displayName }).toEqual({ name: 'rpaSecretVariablesApi', displayName: 'RPA Secret Variables' });
    const [about, variables, typedInto, ...rest] = c.properties;
    expect(rest).toEqual([]);
    expect(about.type).toBe('notice');
    for (const text of ['{{var.name}}', 'Run Steps', 'masks', 'Only signed steps type one', 'at least 4 characters', 'Options → Variables']) expect(about.displayName, text).toContain(text);
    expect(variables).toMatchObject({ displayName: 'Variables', name: 'variables', type: 'fixedCollection', typeOptions: { multipleValues: true }, default: {} });
    const [pair] = (variables.options ?? []) as { name: string; values: INodeProperties[] }[];
    expect(pair.name).toBe('values');
    expect(pair.values.map((v) => [v.name, v.type, v.typeOptions?.password === true])).toEqual([['name', 'string', false], ['value', 'string', true]]);
    // Optional, typed in (never an expression), one app or host per line; the description says what an empty field allows.
    expect(typedInto).toMatchObject({ displayName: 'May Be Typed Into', name: 'mayBeTypedInto', type: 'string', default: '', noDataExpression: true, typeOptions: { rows: 3 } });
    expect(typedInto.required).toBeUndefined();
    expect(typedInto.placeholder).toBe('ErpDemo.exe\nerp.example.com');
    expect(typedInto.description).toBe(
      "Where these values may be typed, one per line: an app's program file name for desktop steps (ErpDemo.exe), or a site's exact host for browser steps (erp.example.com). A desktop run of an app not listed is refused before the app starts, and a browser step is refused before it types a value on a site not listed. Empty means the values may be typed into any app or site the signed steps use.",
    );
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
    expect(props.find((p) => p.name === 'login')?.description).toBe(
      "Every address of the sign-in, as host/path, one per line: each page the address bar shows (user name, password, code) and each address a sign-in form posts to, which the address bar does not show (the run's error names it). Empty means the login page.",
    );
    const reads = props.find((p) => p.name === 'readPosts');
    expect(reads?.placeholder).toBe('POST example.com/sap/opu/odata/sap/ZLINEITEMS_SRV/$batch');
    for (const text of ['letters, digits and _ . ( ) = ~ -', '%3D', 'ZSRV;v=0002', 'without any check of what they send', 'On SAP the same endpoints also save data',
      'an SAP user that can only display', 'not *', 'Forms It May Submit']) expect(reads?.description, text).toContain(text);
    expect(reads?.description).not.toMatch(/any text|Playwright/);
  });
  it('RPA Site Login: the fields that decide where steps may go and what they may post take no expression', () => {
    const props = new PlaywrightSiteLoginApi().properties;
    const fixed = ['loginUrl', 'navHosts', 'subresourceHosts', 'frameHosts', 'login', 'allowedSubmits', 'readPosts'];
    for (const name of fixed) expect(props.find((p) => p.name === name)?.noDataExpression, name).toBe(true);
    // The account's values may come from items (one Site Login, many accounts).
    for (const name of ['username', 'password', 'totpSecret']) expect(props.find((p) => p.name === name)?.noDataExpression, name).toBeUndefined();
    // A credential saved before, with an expression in one of these fields: n8n keeps the "=" on save, and on a run
    // (getNodeParameters with defaults, as CredentialsHelper.applyDefaultsAndOverwrites calls it) drops the "=" of a
    // noDataExpression field before expressions are resolved. The text is never evaluated: the run stops on a
    // configuration error that names the field, and nothing is allowed.
    const base = { loginUrl: 'https://example.com/login', username: 'u', password: 'p' };
    for (const [field, label] of [['allowedSubmits', 'Form'], ['readPosts', 'Read-only request']]) {
      const saved = NodeHelpers.getNodeParameters(props, { ...base, [field]: '={{ $json.forms }}' }, false, false, null, null) ?? {};
      expect(saved[field]).toBe('={{ $json.forms }}');
      const read = NodeHelpers.getNodeParameters(props, saved, true, false, null, null) ?? {};
      expect(read[field]).toBe('{{ $json.forms }}');
      expect(() => siteLoginConfig(read as never), field).toThrow(new RegExp(`^${label} `));
    }
  });
  it('RPA Step Signing: Signing Key with a hint that needs no terminal', () => {
    const key = new PlaywrightScriptSigningApi().properties.find((p) => p.name === 'secretKey');
    expect(key).toMatchObject({
      displayName: 'Signing Key', hint: 'Let your password manager generate a password of 32 or more characters, and paste it here', typeOptions: { password: true }, required: true,
    });
    // n8n has no way to generate a credential value (n8n-workflow ICredentialType and INodePropertyTypeOptions): no terminal command either.
    expect(JSON.stringify(new PlaywrightScriptSigningApi().properties)).not.toMatch(/openssl|terminal/);
  });
  it('RPA Step Signing opens with one notice that says what the key is for', () => {
    const [first, ...rest] = new PlaywrightScriptSigningApi().properties;
    expect(first).toMatchObject({ type: 'notice', default: '' });
    expect(first.displayName).toBe(
      'Sign Steps signs Repaired steps with this key, and Run Steps refuses steps whose signature does not match it. Use 32 or more random characters, for example a password your password manager generates.',
    );
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
      'dist/credentials/RpaSecretVariablesApi.credentials.js',
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
      message: `Could not connect to the browser server at ws://127.0.0.1:${port}/. Is it running? With the compose stack: docker compose up -d browser; on a Windows machine, run rpa status there (README: Where the browser runs).`,
    });
    expect(r.message).not.toContain('tok-7f3a9c');
    expect(r.message).not.toContain('abc123');
  });
  it('Browser: a local browser without Chromium fails with the golden message', async () => {
    expect(await browserTestResult({ mode: 'local' }, engine)).toEqual({ status: 'Error', message: 'Chromium not found. Run: npx playwright install chromium' });
  });
  it('Browser: the fingerprint reaches the engine, which refuses one beside a ws:// address and a malformed one before it connects', async () => {
    const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');
    expect(await browserTestResult({ mode: 'playwright', wsUrl: 'ws://127.0.0.1:3000/', fingerprint }, engine))
      .toEqual({ status: 'Error', message: 'A certificate fingerprint needs a wss:// Endpoint URL in Browser Server mode.' });
    expect(await browserTestResult({ mode: 'playwright', wsUrl: 'wss://browser.example.net/', fingerprint: 'AA:BB' }, engine))
      .toEqual({ status: 'Error', message: 'The certificate fingerprint must be 64 hexadecimal characters (SHA-256), with or without colons.' });
  });
  it('Browser: a number, a boolean, an object and an empty array as the fingerprint are refused by the engine, not read as no fingerprint', async () => {
    const wsUrl = `wss://127.0.0.1:${await closedPort()}/`;
    for (const fingerprint of [42, false, {}, []]) {
      expect(await browserTestResult({ mode: 'playwright', wsUrl, fingerprint }, engine), JSON.stringify(fingerprint))
        .toEqual({ status: 'Error', message: 'The certificate fingerprint must be 64 hexadecimal characters (SHA-256), with or without colons.' });
    }
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
  it('Secret Variables: counts and names the variables, or says what is wrong without a value', () => {
    const pairs = (...values: { name: string; value: string }[]) => ({ variables: { values } });
    expect(secretVariablesTestResult(pairs({ name: 'password', value: 'Pw-5513-xyz' }, { name: 'pin', value: '4711' })))
      .toEqual({ status: 'OK', message: 'Valid: 2 secret variable(s): password, pin' });
    expect(secretVariablesTestResult({})).toEqual({ status: 'OK', message: 'Valid: 0 secret variable(s)' });
    const short = secretVariablesTestResult(pairs({ name: 'pin', value: '471' }));
    expect(short).toEqual({
      status: 'Error',
      message: 'The secret variable "pin" in the RPA Secret Variables credential is shorter than 4 characters: a value that short cannot be masked without also hiding ordinary text. Put a value that is not secret in Options → Variables.',
    });
    const badName = secretVariablesTestResult(pairs({ name: 'Pw-5513-xyz', value: 'Pw-5513-xyz' }));
    expect(badName).toEqual({
      status: 'Error', message: 'The name of secret variable 1 in the RPA Secret Variables credential may only use letters, digits and _, and may not start with a digit.',
    });
    expect(secretVariablesTestResult(pairs({ name: '', value: 'Pw-5513-xyz' }))).toEqual({
      status: 'Error', message: 'Secret variable 1 in the RPA Secret Variables credential has a value but no name.',
    });
    expect(secretVariablesTestResult(pairs({ name: 'pw', value: 'Pw-5513-xyz' }, { name: 'pw', value: 'Other-5513' }))).toEqual({
      status: 'Error', message: 'The secret variable "pw" is listed twice in the RPA Secret Variables credential.',
    });
    // A row left empty is not a variable.
    expect(secretVariablesTestResult(pairs({ name: '', value: '' }, { name: ' pw ', value: 'Pw-5513-xyz' }))).toEqual({ status: 'OK', message: 'Valid: 1 secret variable(s): pw' });
  });
  it('Secret Variables: May Be Typed Into counts the apps and sites, or names the line that is neither, never a value', () => {
    const withTargets = (mayBeTypedInto: unknown) => ({ variables: { values: [{ name: 'pw', value: 'Pw-5513-xyz' }] }, mayBeTypedInto });
    expect(secretVariablesTestResult(withTargets('ErpDemo.exe\n\nerp.example.com\nhttps://Login.Example.com:8443\nerpdemo.EXE'))).toEqual({
      status: 'OK', message: 'Valid: 1 secret variable(s): pw. May be typed into 1 app(s) and 2 site(s) only',
    });
    expect(secretVariablesTestResult(withTargets('  \n'))).toEqual({ status: 'OK', message: 'Valid: 1 secret variable(s): pw' });
    const line = (n: number, rest: string) => `Line ${n} of May Be Typed Into in the RPA Secret Variables credential${rest}`;
    const refused = (mayBeTypedInto: unknown) => secretVariablesTestResult(withTargets(mayBeTypedInto));
    expect(refused('ErpDemo.exe\nC:\\Apps\\ErpDemo.exe')).toEqual({
      status: 'Error', message: line(2, ' ("C:\\Apps\\ErpDemo.exe"): it is neither a program file name such as ErpDemo.exe nor a site host such as erp.example.com.'),
    });
    expect(refused('erp.example.com/login?token=abc')).toEqual({
      status: 'Error', message: line(1, ' ("erp.example.com/login"): it is neither a program file name such as ErpDemo.exe nor a site host such as erp.example.com.'),
    });
    expect(refused('*.example.com')).toEqual({ status: 'Error', message: line(1, ' ("*.example.com"): wildcards are not allowed, list each exact host.') });
    expect(refused(`${'a'.repeat(50)}/x`).message).toBe(line(1, ` ("${'a'.repeat(40)}…"): it is neither a program file name such as ErpDemo.exe nor a site host such as erp.example.com.`));
    // A line that holds a value, or a user:password@ part, is never shown.
    expect(refused('ftp://Pw-5513-xyz')).toEqual({ status: 'Error', message: line(1, ": it holds one of this credential's values: list where they may be typed, not the values.") });
    expect(refused('erp.example.com\nhttps://me:Hunter-22@erp.example.com/')).toEqual({
      status: 'Error', message: line(2, ': it is neither a program file name such as ErpDemo.exe nor a site host such as erp.example.com.'),
    });
    // Typed in, never an expression.
    for (const v of ['={{ $json.hosts }}', '{{ $json.hosts }}', ['erp.example.com'], 42]) {
      expect(refused(v), String(v)).toEqual({ status: 'Error', message: 'May Be Typed Into in the RPA Secret Variables credential must be typed in, not set with an expression.' });
    }
  });
  it('Step Signing: a key of 31 characters is refused, 32 accepted', () => {
    expect(scriptSigningResult({ secretKey: 'k'.repeat(31) })).toEqual({
      status: 'Error', message: 'The Step Signing key must be at least 32 characters (let your password manager generate a password of 32 or more characters)',
    });
    expect(scriptSigningResult({ secretKey: 'k'.repeat(32) })).toEqual({ status: 'OK', message: 'Signing key accepted' });
  });
});
