import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { SANDBOX, startPortal } from 'n8n-rpa-sandbox/testing.js';
import { openSession } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import { installInterrupts } from '../src/steps/interrupts.js';
import { runSteps } from '../src/steps/run.js';
import { scrubTrace, stopTrace, wantTrace } from '../src/trace/trace.js';
import { totp } from '../src/secrets/totp.js';
import type { PortalPolicy } from '../src/types.js';
import { baselineScript, LOCAL, policyFor, SECRETS, SIGN_IN_STEPS } from './helpers.js';

let portal: Awaited<ReturnType<typeof startPortal>>;
beforeAll(async () => { portal = await startPortal(); });
afterAll(async () => { await portal.close(); });

const masker = createMasker([SECRETS.username, SECRETS.password, SECRETS.totpSecret]);
const textOf = (zip: Uint8Array) => Object.values(unzipSync(zip)).map((b) => strFromU8(b)).join('\n');

describe('scrubTrace', () => {
  it('drops login bodies and binary entries, blanks cookies and auth headers, removes stored state, masks secrets', () => {
    const policy = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
    const network = [
      { type: 'resource-snapshot', snapshot: {
        request: { url: 'http://127.0.0.1:9999/acme/login', method: 'POST', cookies: [{ name: 'sid_acme', value: 'SID-123' }], headers: [{ name: 'Cookie', value: 'sid_acme=SID-123' }],
          postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'password', value: SECRETS.password }], _file: 'resources/login.dat' } },
        response: { headers: [{ name: 'Set-Cookie', value: 'sid_acme=SID-456; HttpOnly' }], cookies: [{ name: 'sid_acme', value: 'SID-456' }], content: { _file: 'resources/login-response.html' } } } },
      { type: 'resource-snapshot', snapshot: {
        request: { url: 'http://127.0.0.1:9999/acme/home', method: 'GET', headers: [{ name: 'authorization', value: 'Bearer TOKEN-1' }] },
        response: { headers: [], content: { _file: 'resources/home.html' } } } },
    ].map((x) => JSON.stringify(x)).join('\n');
    const trace = [
      JSON.stringify({ type: 'context-options', options: { storageState: { cookies: [{ name: 'sid_acme', value: 'SID-789' }] } } }),
      JSON.stringify({ type: 'before', params: { selector: '#password', value: SECRETS.password } }),
    ].join('\n');
    const raw = zipSync({
      'trace.network': strToU8(network),
      'trace.trace': strToU8(trace),
      'resources/login.dat': strToU8(`username=${SECRETS.username}&password=${SECRETS.password}`),
      'resources/login-response.html': strToU8('<p>welcome</p>'),
      'resources/home.html': strToU8(`<p>Signed in as ${SECRETS.username}</p><pre>Cookie: sid_acme=SID-123\nAuthorization: Bearer TOKEN-1</pre>`),
      'resources/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      'resources/blob.dat': new Uint8Array([0xff, 0xfe, 0x00, 0x81]),
    });
    const out = scrubTrace(Buffer.from(raw), { masker, policy });
    expect(Object.keys(unzipSync(out)).sort()).toEqual(['resources/home.html', 'trace.network', 'trace.trace']);
    const all = textOf(out);
    for (const needle of [SECRETS.password, SECRETS.username, 'SID-123', 'SID-456', 'SID-789', 'TOKEN-1']) expect(all).not.toContain(needle);
    expect(all).toContain('[secret]');
    expect(all).toContain('[removed]');
  });
  it('drops the request body and its resource file for every write, not only login posts', () => {
    const policy = policyFor({ url: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' });
    const snap = (method: string, path: string, postData?: Record<string, unknown>) => JSON.stringify({ type: 'resource-snapshot', snapshot: {
      request: { url: `http://127.0.0.1:9999${path}`, method, headers: [], ...(postData ? { postData } : {}) },
      response: { headers: [], content: {} } } });
    const network = [
      snap('POST', '/public/form/submit', { mimeType: 'application/x-www-form-urlencoded', text: 'name=Ada&message=Kept+out+of+traces' }),
      snap('PUT', '/public/api/item', { mimeType: 'application/json', _sha1: 'put-body.dat' }),
      snap('DELETE', '/public/api/item', { mimeType: 'text/plain', _file: 'resources/delete-body.dat' }),
      snap('GET', '/public/table'),
    ].join('\n');
    const raw = zipSync({
      'trace.network': strToU8(network),
      'resources/put-body.dat': strToU8('{"note":"body-of-put"}'),
      'resources/delete-body.dat': strToU8('body-of-delete'),
    });
    const out = scrubTrace(Buffer.from(raw), { masker, policy });
    expect(Object.keys(unzipSync(out))).toEqual(['trace.network']);
    const all = textOf(out);
    for (const needle of ['Kept+out+of+traces', 'body-of-put', 'body-of-delete', 'postData']) expect(all).not.toContain(needle);
    expect(all).toContain('/public/table');
  });
  it('wantTrace follows the saveTrace mode', () => {
    expect([wantTrace(undefined, false), wantTrace(undefined, true)]).toEqual([true, false]);
    expect([wantTrace('always', true), wantTrace('never', false), wantTrace('onFailure', false)]).toEqual([true, false, true]);
  });
});

describe('stopTrace (live)', () => {
  it('a real form POST keeps no request body in the scrubbed trace', async () => {
    const policy: PortalPolicy = {
      startUrl: `${portal.url}/public/form`, navHosts: [portal.host], subresourceHosts: [], login: [],
      allowedSubmits: [{ host: portal.host, path: '/public/form/submit', method: 'POST' }], allowPrivateNetwork: true,
    };
    const s = await openSession({ endpoint: LOCAL, policy, masker, trace: true });
    try {
      await s.page.goto(`${portal.url}/public/form`);
      await s.page.getByLabel('Name').fill('Ada Lovelace');
      await s.page.getByLabel('Message').fill('Kept out of traces');
      s.armSubmit(policy.allowedSubmits[0]);
      await s.page.getByRole('button', { name: 'Send' }).click();
      await s.page.waitForSelector('#echo');
      const zip = await stopTrace(s, { masker, policy });
      const all = textOf(zip as Buffer);
      expect(all).toContain('/public/form/submit'); // the POST itself is in the trace...
      expect(all).not.toContain('Kept+out+of+traces'); // ...but not its urlencoded body
      expect(all).not.toContain('Kept%20out%20of%20traces');
    } finally { await s.close(); }
  });
  it('a read-only POST keeps no body in the trace', async () => {
    portal.reset();
    const policy = { ...policyFor(portal), readPosts: SANDBOX.erp.readPosts(portal.host) };
    const s = await openSession({ endpoint: LOCAL, policy, masker, trace: true });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const r = await runSteps({
        page: s.page, script: baselineScript(portal.url), policy, secrets: SECRETS, vars: {}, masker, defaultTimeoutMs: 3000,
        violations: s.violations, interrupts: await installInterrupts(s.page, []),
      }, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
      await s.page.goto(`${portal.url}${SANDBOX.erp.webguiPath}`);
      const token = await s.page.locator('input[name="~sec_sesstoken"]').inputValue();
      await s.page.getByRole('button', { name: 'Line Item Report' }).click();
      await s.page.getByLabel('Company Code').selectOption('1000');
      await s.page.getByLabel('From').fill(SANDBOX.erp.from);
      await s.page.getByLabel('To').fill(SANDBOX.erp.to);
      await s.page.getByRole('button', { name: 'Execute' }).click();
      await s.page.getByRole('grid').waitFor();
      expect(s.writesSent).toBe(0);
      const zip = await stopTrace(s, { masker, policy });
      const all = textOf(zip as Buffer);
      expect(all).toContain('/bc/gui/sap/its/webgui');
      // The request side (trace.network) keeps neither the body nor the token. DOM snapshots in trace.trace still carry the
      // page's hidden-input value: that is page content, which scrubTrace has never stripped.
      const network = strFromU8(unzipSync(zip as Buffer)['trace.network']);
      const posts = network.split('\n').filter((l) => l.includes('"type":"resource-snapshot"')).map((l) => JSON.parse(l).snapshot.request)
        .filter((r: { url: string; method: string }) => r.method === 'POST' && r.url.includes('/bc/gui/sap/its/webgui'));
      expect(posts.length).toBeGreaterThanOrEqual(2);
      for (const r of posts) expect(r.postData).toBeUndefined();
      expect(network).not.toContain(token);
      expect(all).not.toContain('S_BUKRS=');
    } finally { await s.close(); }
  });
  it('returns a scrubbed trace of a real sign-in with no secret or session cookie in it', async () => {
    const policy = policyFor(portal);
    const s = await openSession({ endpoint: LOCAL, policy, masker, trace: true });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const r = await runSteps({
        page: s.page, script: baselineScript(portal.url), policy, secrets: SECRETS, vars: {}, masker, defaultTimeoutMs: 3000,
        violations: s.violations, interrupts: await installInterrupts(s.page, []),
      }, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
      const sid = (await s.context.cookies()).find((c) => c.name === 'sid_acme')?.value as string;
      const zip = await stopTrace(s, { masker, policy });
      expect(zip).toBeDefined();
      expect(unzipSync(zip as Buffer)['trace.trace']).toBeDefined();
      const all = textOf(zip as Buffer);
      for (const needle of [SECRETS.password, SECRETS.username, sid]) expect(all).not.toContain(needle);
    } finally { await s.close(); }
  });
  it('the typed TOTP code (and the adjacent windows) is masked in the scrubbed trace', async () => {
    portal.setState({ mfa: 'totp' });
    const policy = policyFor(portal);
    // The run's masker: the same object the steps, the session and the trace scrubbing share.
    const runMasker = createMasker([SECRETS.username, SECRETS.password, SECRETS.totpSecret]);
    const s = await openSession({ endpoint: LOCAL, policy, masker: runMasker, trace: true });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      const r = await runSteps({
        page: s.page, script: baselineScript(portal.url), policy, secrets: SECRETS, vars: {}, masker: runMasker, defaultTimeoutMs: 3000,
        violations: s.violations, interrupts: await installInterrupts(s.page, []),
      }, SIGN_IN_STEPS);
      expect(r.ok).toBe(true);
      const now = Date.now();
      const codes = [...new Set([-60_000, -30_000, 0, 30_000].map((d) => totp(SECRETS.totpSecret as string, now + d)))];
      const zip = await stopTrace(s, { masker: runMasker, policy });
      const all = textOf(zip as Buffer);
      // The fill call's recorded value, and the code field's value in DOM snapshots.
      for (const code of codes) {
        expect(all, code).not.toContain(`"value":"${code}"`);
        expect(all, code).not.toMatch(new RegExp(`value="${code}"|"${code}"`));
      }
      expect(all).toContain('"value":"[secret]"');
      expect(runMasker.mask(`code ${codes[2]} typed`)).toBe('code [secret] typed');
    } finally { await s.close(); }
  });
  it('keeps the trace of a session that a policy violation closed', async () => {
    const s = await openSession({ endpoint: LOCAL, policy: policyFor(portal), masker, trace: true });
    try {
      await s.page.goto(`${portal.url}/acme/login`);
      await s.page.goto(`http://localhost:${portal.port}/acme/login`).catch(() => undefined);
      await expect.poll(() => s.closed).toBe(true);
      expect(s.closeReason).toBe('violation');
      const zip = await stopTrace(s, { masker, policy: policyFor(portal) });
      expect(zip?.length).toBeGreaterThan(100);
    } finally { await s.close(); }
  });
});
