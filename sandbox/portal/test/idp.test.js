import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startPortal, SANDBOX } from '../testing.js';
import { IDP, issueAssertion } from '../idp.js';
import { SAP_LOGON, safeRelayState } from '../sap-logon.js';
import { totp } from '../totp.js';

let portal;
before(async () => { portal = await startPortal({ sap: 'realistic', sapLogin: 'sso' }); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const FLP = SANDBOX.erp.fioriPath;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const get = (path, headers = {}) => fetch(`${portal.url}${path}`, { redirect: 'manual', headers });
const post = (path, fields, headers = {}) => fetch(`${portal.url}${path}`, {
  method: 'POST', redirect: 'manual', headers: { ...FORM, ...headers }, body: new URLSearchParams(fields),
});
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hidden = (html, name) => {
  const m = html.match(new RegExp(`<input type="hidden" name="${name}" value="([^"]*)">`));
  return m ? unesc(m[1]) : undefined;
};
const setCookies = (res) => res.headers.getSetCookie();
const sapCookie = (res) => setCookies(res).find((c) => c.startsWith(`${SAP_LOGON.cookie}=`));

/** Signs in at the IdP (password, then code) and returns the auto-submit page's fields for the ACS. */
async function assertionFor(relayState) {
  const signIn = await post('/idp/login', { loginfmt: IDP.user, passwd: IDP.password, ...(relayState === undefined ? {} : { RelayState: relayState }) });
  assert.equal(signIn.status, 302);
  const mfa = signIn.headers.get('location');
  assert.match(mfa, /^\/idp\/mfa\?tx=[0-9a-f]{36}$/);
  const page = await (await get(mfa)).text();
  assert.match(page, /<label for="otc">Code<\/label>/);
  const tx = hidden(page, 'tx');
  const verified = await post('/idp/mfa', { tx, otc: totp(IDP.totpSecret) });
  assert.equal(verified.status, 200);
  const html = await verified.text();
  assert.match(html, /<form id="saml" method="post" action="\/sap\/saml2\/acs">/);
  assert.match(html, /<noscript>[^]*<button type="submit">Continue<\/button>[^]*<\/noscript>/);
  assert.match(html, /<script>document\.getElementById\('saml'\)\.submit\(\);<\/script>/);
  return { SAMLResponse: hidden(html, 'SAMLResponse'), RelayState: hidden(html, 'RelayState') };
}

test('a sessionless SAP page redirects to the IdP with a RelayState', async () => {
  for (const path of [SANDBOX.erp.webguiPath, FLP, `${SANDBOX.erp.webguiPath}?sap-client=100&~transaction=SE16`]) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), `/idp/login?RelayState=${encodeURIComponent(path)}`);
    assert.equal(sapCookie(res), undefined);
  }
  const login = await get(`/idp/login?RelayState=${encodeURIComponent(SANDBOX.erp.webguiPath)}`);
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /<title>Sign in<\/title>/);
  assert.match(html, /<h1>RPA Corp sign-in<\/h1>/);
  assert.match(html, /<label for="loginfmt">Email<\/label><input id="loginfmt" name="loginfmt" type="email"/);
  assert.match(html, /<label for="passwd">Password<\/label><input id="passwd" name="passwd" type="password"/);
  assert.match(html, /<button type="submit" id="idSIButton9">Sign in<\/button>/);
  assert.equal(hidden(html, 'RelayState'), SANDBOX.erp.webguiPath);
  assert.doesNotMatch(html, /sap-password/);
  // OData keeps its 401, and the public paths stay open.
  assert.equal((await get('/sap/opu/odata/sap/ZLINEITEMS_SRV/$metadata')).status, 401);
  assert.notEqual((await get('/sap/public/bc/icf/logoff')).status, 302);
});

test('wrong password shows the IdP message', async () => {
  for (const fields of [
    { loginfmt: IDP.user, passwd: 'nope' },
    { loginfmt: '<b>x</b>@evil.example', passwd: IDP.password },
    { loginfmt: '', passwd: '' },
  ]) {
    const res = await post('/idp/login', { ...fields, RelayState: '"><script>alert(1)</script>' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('location'), null);
    const html = await res.text();
    assert.match(html, /Your account or password is incorrect\./);
    assert.doesNotMatch(html, /<script>alert|<b>x<\/b>/);
    assert.ok(html.includes(`value="${fields.loginfmt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`));
  }
  const reflected = await (await get('/idp/login?RelayState=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E')).text();
  assert.doesNotMatch(reflected, /<script>alert/);
  // The email is not case-sensitive.
  assert.equal((await post('/idp/login', { loginfmt: IDP.user.toUpperCase(), passwd: IDP.password })).status, 302);
});

test('a correct password then a valid code posts an assertion that gives an SAP session', async () => {
  const signIn = await post('/idp/login', { loginfmt: IDP.user, passwd: IDP.password, RelayState: SANDBOX.erp.webguiPath });
  assert.equal(signIn.status, 302);
  const tx = new URL(signIn.headers.get('location'), portal.url).searchParams.get('tx');
  const code = totp(IDP.totpSecret);
  const wrong = await post('/idp/mfa', { tx, otc: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 200);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /You didn&#39;t enter the expected verification code\. Please try again\./);
  assert.doesNotMatch(wrongHtml, /saml2\/acs/);
  assert.equal(hidden(wrongHtml, 'tx'), tx);

  const verified = await post('/idp/mfa', { tx, otc: code });
  assert.equal(verified.status, 200);
  const html = await verified.text();
  assert.match(html, /<form id="saml" method="post" action="\/sap\/saml2\/acs">/);
  const fields = { SAMLResponse: hidden(html, 'SAMLResponse'), RelayState: hidden(html, 'RelayState') };
  assert.equal(fields.RelayState, SANDBOX.erp.webguiPath);
  assert.match(fields.SAMLResponse, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const claims = JSON.parse(Buffer.from(fields.SAMLResponse.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(claims).sort(), ['exp', 'nonce', 'user']);
  assert.equal(claims.user, IDP.user);
  assert.ok(claims.exp > Date.now() && claims.exp <= Date.now() + 60_000);

  // The transaction is used up: its code page sends the browser back to sign in, and a second code is refused.
  const used = await get(`/idp/mfa?tx=${tx}`);
  assert.equal(used.status, 302);
  assert.equal(used.headers.get('location'), '/idp/login');
  const twice = await post('/idp/mfa', { tx, otc: code });
  assert.equal(twice.status, 302);
  assert.equal(twice.headers.get('location'), '/idp/login');

  const acs = await post('/sap/saml2/acs', fields);
  assert.equal(acs.status, 302);
  assert.equal(acs.headers.get('location'), SANDBOX.erp.webguiPath);
  assert.match(sapCookie(acs), /Path=\/; HttpOnly/);
  assert.ok(setCookies(acs).some((c) => c === 'sap-usercontext=sap-client=100; Path=/'));
  const cookie = setCookies(acs).map((c) => c.split(';')[0]).join('; ');
  const gui = await get(SANDBOX.erp.webguiPath, { cookie });
  assert.equal(gui.status, 302);
  assert.match(gui.headers.get('location'), /^\/sap\(.+\)\/bc\/gui\/sap\/its\/webgui/);
});

test('an oversized form body is refused with the 403 page and no cookie', async () => {
  const res = await fetch(`${portal.url}/sap/saml2/acs`, { method: 'POST', redirect: 'manual', headers: FORM, body: `SAMLResponse=${'a'.repeat(200 * 1024)}` });
  assert.equal(res.status, 403);
  assert.deepEqual(setCookies(res), []);
  assert.match(await res.text(), /SAML 2\.0 logon failed/);
  const idp = await fetch(`${portal.url}/idp/login`, { method: 'POST', redirect: 'manual', headers: FORM, body: `passwd=${'a'.repeat(200 * 1024)}` });
  assert.equal(idp.status, 403);
});

test('the ACS refuses forged, expired and replayed assertions', async () => {
  const good = await assertionFor(SANDBOX.erp.webguiPath);
  const [payload, mac] = good.SAMLResponse.split('.');
  const otherUser = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), user: 'admin@rpa.example' })).toString('base64url');
  const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
  const wrongKey = createHmac('sha256', 'not-the-key').update(payload).digest('base64url');
  const refused = async (SAMLResponse, why) => {
    const res = await post('/sap/saml2/acs', { SAMLResponse, RelayState: SANDBOX.erp.webguiPath });
    assert.equal(res.status, 403, why);
    assert.equal(res.headers.get('location'), null, why);
    assert.equal(sapCookie(res), undefined, why);
    assert.deepEqual(setCookies(res), [], why);
    assert.match(await res.text(), /SAML 2\.0 logon failed/);
  };
  await refused(`${otherUser}.${mac}`, 'changed user');
  await refused(`${payload}.${flipped}`, 'changed MAC');
  await refused(`${payload}.${wrongKey}`, 'another key');
  await refused(payload, 'no MAC');
  await refused('', 'empty');
  await refused(`${payload}.${mac}.x`, 'extra part');
  await refused('<script>.x', 'garbage');
  await refused(`${Buffer.from('not json').toString('base64url')}.${mac}`, 'not json');
  await refused(issueAssertion(IDP.user, Date.now() - 61_000), 'expired');

  assert.equal((await post('/sap/saml2/acs', good)).status, 302);
  await refused(good.SAMLResponse, 'replayed');
  // A validly signed assertion the IdP never handed out (its nonce is unknown) is refused too.
  portal.reset();
  const issued = issueAssertion(IDP.user);
  portal.reset();
  await refused(issued, 'issued before a reset');
  // Only POST.
  assert.equal((await get('/sap/saml2/acs')).status, 405);
});

test('an off-site RelayState falls back to the launchpad', async () => {
  const offSite = [
    '//evil.example/x', '/\\evil.example', 'https://evil.example/sap/', '/%2F%2Fevil.example', '/%5Cevil.example',
    '/sap/..%2F..%2F%2Fevil.example', '/sap/%2e%2e/%2e%2e//evil.example', '/sap/../evil', '/sap//evil.example',
    '/sap/%252F%252Fevil.example', '/sap/%5C%5Cevil.example', '/other/path', '/sap', '/sap/bc/<script>', '/sap/bc/ x',
    `/sap/${'a'.repeat(3000)}`, '/sap/%ZZ', '/sap/%00', 'javascript:alert(1)',
  ];
  for (const v of offSite) assert.equal(safeRelayState(v), FLP, v);
  for (const v of [undefined, null, 42, ['/sap/bc']]) assert.equal(safeRelayState(v), FLP, String(v));
  for (const v of [SANDBOX.erp.webguiPath, FLP, '/sap/bc/gui/sap/its/webgui?sap-client=100&~transaction=SE16']) {
    assert.equal(safeRelayState(v), v, v);
  }
  // Through the whole flow: the IdP carries a bad one as the launchpad, and the ACS checks what it is posted.
  for (const v of ['//evil.example/x', '/\\evil.example', '/sap/..%2F..%2F%2Fevil.example']) {
    const fields = await assertionFor(v);
    assert.equal(fields.RelayState, FLP);
    const res = await post('/sap/saml2/acs', { ...fields, RelayState: v });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), FLP, v);
  }
  const noRelay = await post('/sap/saml2/acs', { SAMLResponse: (await assertionFor(undefined)).SAMLResponse });
  assert.equal(noRelay.headers.get('location'), FLP);
});

test('the IdP keeps at most 200 transactions, dropping the oldest, and resetState clears them', async () => {
  const start = async () => new URL((await post('/idp/login', { loginfmt: IDP.user, passwd: IDP.password })).headers.get('location'), portal.url).searchParams.get('tx');
  const first = await start();
  const second = await start();
  const live = async (tx) => /name="otc"/.test(await (await get(`/idp/mfa?tx=${tx}`)).text());
  assert.equal(await live(first), true);
  for (let i = 0; i < 199; i++) await start();
  assert.equal(await live(first), false);
  assert.equal(await live(second), true);
  portal.reset();
  assert.equal(await live(second), false);
  const unknown = await get('/idp/mfa?tx=nope');
  assert.equal(unknown.status, 302);
  assert.equal(unknown.headers.get('location'), '/idp/login');
});

test('default realistic mode keeps the SAP logon', async () => {
  const prev = process.env.SANDBOX_SAP_LOGIN;
  delete process.env.SANDBOX_SAP_LOGIN;
  try {
    for (const path of [SANDBOX.erp.webguiPath, FLP]) {
      const res = await get(path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('location'), null);
      const html = await res.text();
      assert.match(html, /id="sap-password"/);
      assert.match(html, /<title>Logon<\/title>/);
    }
    assert.equal((await get('/idp/login')).status, 404);
    assert.equal((await post('/idp/login', { loginfmt: IDP.user, passwd: IDP.password })).status, 404);
    const acs = await post('/sap/saml2/acs', { SAMLResponse: issueAssertion(IDP.user), RelayState: SANDBOX.erp.webguiPath });
    assert.equal(acs.status, 200);
    assert.deepEqual(setCookies(acs), []);
    assert.match(await acs.text(), /id="sap-password"/);
    const logon = await post(SANDBOX.erp.webguiPath, { 'sap-client': SAP_LOGON.client, 'sap-user': SAP_LOGON.user, 'sap-password': SAP_LOGON.password, 'sap-language': 'EN' });
    assert.equal(logon.status, 302);
    assert.equal(logon.headers.get('location'), SANDBOX.erp.webguiPath);
    assert.ok(sapCookie(logon));
  } finally { if (prev === undefined) delete process.env.SANDBOX_SAP_LOGIN; else process.env.SANDBOX_SAP_LOGIN = prev; }
});

test('in SSO mode the SAP password logon is off', async () => {
  const res = await post(SANDBOX.erp.webguiPath, { 'sap-client': SAP_LOGON.client, 'sap-user': SAP_LOGON.user, 'sap-password': SAP_LOGON.password, 'sap-language': 'EN' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/idp/login?RelayState=${encodeURIComponent(SANDBOX.erp.webguiPath)}`);
  assert.equal(sapCookie(res), undefined);
});

test('light mode untouched', async () => {
  const prev = process.env.SANDBOX_SAP;
  delete process.env.SANDBOX_SAP;
  try {
    const res = await get(SANDBOX.erp.webguiPath);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/acme/login?next=${encodeURIComponent(SANDBOX.erp.webguiPath)}`);
    assert.equal((await get('/idp/login')).status, 404);
    assert.equal((await get('/idp/mfa?tx=x')).status, 404);
    const acs = await post('/sap/saml2/acs', { SAMLResponse: issueAssertion(IDP.user), RelayState: SANDBOX.erp.webguiPath });
    assert.equal(acs.status, 302);
    assert.equal(acs.headers.get('location'), `/acme/login?next=${encodeURIComponent('/sap/saml2/acs')}`);
    assert.deepEqual(setCookies(acs), []);
  } finally { if (prev === undefined) delete process.env.SANDBOX_SAP; else process.env.SANDBOX_SAP = prev; }
});

// Identity-first sign-in: SANDBOX_SAP_LOGIN=sso2. The server reads it per request, so these tests switch it on the running portal.
async function withSso2(fn, { kmsi } = {}) {
  const prev = process.env.SANDBOX_SAP_LOGIN, prevKmsi = process.env.IDP_KMSI;
  process.env.SANDBOX_SAP_LOGIN = 'sso2';
  if (kmsi === undefined) delete process.env.IDP_KMSI; else process.env.IDP_KMSI = kmsi;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.SANDBOX_SAP_LOGIN; else process.env.SANDBOX_SAP_LOGIN = prev;
    if (prevKmsi === undefined) delete process.env.IDP_KMSI; else process.env.IDP_KMSI = prevKmsi;
  }
}
const txOf = (res) => new URL(res.headers.get('location'), portal.url).searchParams.get('tx');
async function toMfa(relay = SANDBOX.erp.webguiPath) {
  const next = await post('/idp/login', { loginfmt: IDP.user, RelayState: relay });
  const pw = await post('/idp/password', { tx: txOf(next), passwd: IDP.password });
  assert.equal(pw.status, 302);
  assert.match(pw.headers.get('location'), /^\/idp\/mfa\?tx=[0-9a-f]{36}$/);
  return txOf(pw);
}

test('sso2 asks for the email first', async () => {
  await withSso2(async () => {
    const redirect = await get(FLP);
    assert.equal(redirect.headers.get('location'), `/idp/login?RelayState=${encodeURIComponent(FLP)}`);
    const html = await (await get('/idp/login')).text();
    assert.match(html, /<title>Sign in<\/title>/);
    assert.match(html, /<h1>RPA Corp sign-in<\/h1>/);
    assert.match(html, /<label for="loginfmt">Email<\/label><input id="loginfmt" name="loginfmt" type="email"/);
    assert.match(html, />Next<\/button>/);
    assert.doesNotMatch(html, /passwd/);
    const res = await post('/idp/login', { loginfmt: ` ${IDP.user.toUpperCase()}`, RelayState: FLP });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/idp\/password\?tx=[0-9a-f]{36}$/);
    const page = await (await get(res.headers.get('location'))).text();
    assert.match(page, new RegExp(`${IDP.user}`));
    assert.match(page, /<label for="passwd">Password<\/label><input id="passwd" name="passwd" type="password"/);
    assert.match(page, />Sign in<\/button>/);
    assert.match(page, /readonly/);
  });
});

test('an unknown email stays on the email page with the message', async () => {
  await withSso2(async () => {
    const res = await post('/idp/login', { loginfmt: '<b>nobody@x</b>' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(unesc(html), /We couldn't find an account with that username\./);
    assert.match(html, /name="loginfmt"/);
    assert.doesNotMatch(html, /<b>nobody/);
    assert.match(html, /&lt;b&gt;nobody@x/);
  });
});

test('the password page carries the transaction and refuses a forged one', async () => {
  await withSso2(async () => {
    const tx = txOf(await post('/idp/login', { loginfmt: IDP.user }));
    const page = await (await get(`/idp/password?tx=${tx}`)).text();
    assert.equal(hidden(page, 'tx'), tx);
    const wrong = await post('/idp/password', { tx, passwd: 'nope' });
    assert.equal(wrong.status, 200);
    assert.match(await wrong.text(), /Your account or password is incorrect\./);
    // the transaction from the password page cannot skip to the code page
    assert.equal((await get(`/idp/mfa?tx=${tx}`)).status, 302);
    assert.equal((await get(`/idp/mfa?tx=${tx}`)).headers.get('location'), '/idp/login');
    assert.equal((await post('/idp/mfa', { tx, otc: totp(IDP.totpSecret) })).headers.get('location'), '/idp/login');
    for (const forged of ['nope', '']) {
      const g = await get(`/idp/password?tx=${forged}`);
      assert.equal(g.status, 302);
      assert.equal(g.headers.get('location'), '/idp/login');
      const p = await post('/idp/password', { tx: forged, passwd: IDP.password });
      assert.equal(p.headers.get('location'), '/idp/login');
    }
  });
});

test('the code and stay-signed-in pages lead to the assertion', async () => {
  await withSso2(async () => {
    const tx = await toMfa(FLP);
    const code = await post('/idp/mfa', { tx, otc: totp(IDP.totpSecret) });
    assert.equal(code.status, 200);
    const html = await code.text();
    assert.match(html, /<h1>Stay signed in\?<\/h1>/);
    assert.match(html, /name="choice" value="no"[^>]*>No<\/button>/);
    assert.match(html, /name="choice" value="yes"[^>]*>Yes<\/button>/);
    assert.doesNotMatch(html, /SAMLResponse/);
    const ktx = hidden(html, 'tx');
    const done = await post('/idp/kmsi', { tx: ktx, choice: 'yes' });
    assert.equal(done.status, 200);
    const acsHtml = await done.text();
    assert.match(acsHtml, /<form id="saml" method="post" action="\/sap\/saml2\/acs">/);
    const acs = await post('/sap/saml2/acs', { SAMLResponse: hidden(acsHtml, 'SAMLResponse'), RelayState: hidden(acsHtml, 'RelayState') });
    assert.equal(acs.status, 302);
    assert.equal(acs.headers.get('location'), FLP);
    assert.ok(sapCookie(acs));
    // the transaction is used up
    assert.equal((await post('/idp/kmsi', { tx: ktx, choice: 'no' })).headers.get('location'), '/idp/login');
    // "No" also continues
    const tx2 = await toMfa(FLP);
    const k2 = hidden(await (await post('/idp/mfa', { tx: tx2, otc: totp(IDP.totpSecret) })).text(), 'tx');
    assert.match(await (await post('/idp/kmsi', { tx: k2, choice: 'no' })).text(), /action="\/sap\/saml2\/acs"/);
  });
});

test('KMSI with a forged transaction goes back to the sign-in', async () => {
  await withSso2(async () => {
    const tx = await toMfa();
    for (const t of ['nope', tx]) {
      const res = await post('/idp/kmsi', { tx: t, choice: 'yes' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/idp/login');
    }
    // The page only ever comes back inline as the code's response: /idp/kmsi takes POSTs only.
    const g = await get('/idp/kmsi?tx=nope');
    assert.equal(g.status, 405);
    assert.equal(g.headers.get('allow'), 'POST');
  });
});

test('IDP_KMSI=off skips the stay-signed-in page', async () => {
  await withSso2(async () => {
    const tx = await toMfa(FLP);
    const html = await (await post('/idp/mfa', { tx, otc: totp(IDP.totpSecret) })).text();
    assert.match(html, /<form id="saml" method="post" action="\/sap\/saml2\/acs">/);
    assert.doesNotMatch(html, /Stay signed in/);
  }, { kmsi: 'off' });
});

test('sso2 refuses oversized bodies with 403', async () => {
  await withSso2(async () => {
    for (const path of ['/idp/login', '/idp/password', '/idp/kmsi']) {
      const res = await fetch(`${portal.url}${path}`, { method: 'POST', redirect: 'manual', headers: FORM, body: `tx=${'a'.repeat(200 * 1024)}` });
      assert.equal(res.status, 403, path);
    }
    assert.equal((await fetch(`${portal.url}/idp/password`, { method: 'PUT' })).status, 405);
  });
});

test('sso and sap modes are unchanged by sso2', async () => {
  // sso: one page with email and password; the sso2 pages do not exist
  const login = await (await get('/idp/login')).text();
  assert.match(login, /name="passwd"/);
  assert.match(login, />Sign in<\/button>/);
  assert.equal((await get('/idp/password?tx=x')).status, 404);
  assert.equal((await post('/idp/kmsi', { tx: 'x' })).status, 404);
  const { SANDBOX_SAP_LOGIN: prev } = process.env;
  delete process.env.SANDBOX_SAP_LOGIN;
  try {
    assert.equal((await get('/idp/password?tx=x')).status, 404);
    assert.match(await (await get(FLP)).text(), /id="sap-password"/);
  } finally { if (prev === undefined) delete process.env.SANDBOX_SAP_LOGIN; else process.env.SANDBOX_SAP_LOGIN = prev; }
  // sso still goes straight from the code to the assertion
  const fields = await assertionFor(FLP);
  assert.ok(fields.SAMLResponse);
});

test('the stay-signed-in step gets its own transaction; the code-page one is no bearer token', async () => {
  await withSso2(async () => {
    const tx = await toMfa(FLP);
    const html = await (await post('/idp/mfa', { tx, otc: totp(IDP.totpSecret) })).text();
    const ktx = hidden(html, 'tx');
    assert.ok(ktx);
    assert.notEqual(ktx, tx);
    const old = await post('/idp/kmsi', { tx, choice: 'yes' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/idp/login');
    assert.equal((await get(`/idp/mfa?tx=${tx}`)).headers.get('location'), '/idp/login');
    assert.equal((await post('/idp/kmsi', { tx: ktx, choice: 'yes' })).status, 200);
  });
});

test('sso2 sanitises the RelayState end to end', async () => {
  await withSso2(async () => {
    const next = await post('/idp/login', { loginfmt: IDP.user, RelayState: 'https://evil.example/x' });
    const pw = await post('/idp/password', { tx: txOf(next), passwd: IDP.password });
    const kmsi = await (await post('/idp/mfa', { tx: txOf(pw), otc: totp(IDP.totpSecret) })).text();
    const done = await (await post('/idp/kmsi', { tx: hidden(kmsi, 'tx'), choice: 'yes' })).text();
    const acs = await post('/sap/saml2/acs', { SAMLResponse: hidden(done, 'SAMLResponse'), RelayState: hidden(done, 'RelayState') });
    assert.equal(acs.status, 302);
    assert.equal(acs.headers.get('location'), FLP);
  });
});

test('a consumed password transaction is refused and a wrong password leaves it usable', async () => {
  await withSso2(async () => {
    const tx = txOf(await post('/idp/login', { loginfmt: IDP.user }));
    assert.equal((await post('/idp/password', { tx, passwd: 'wrong' })).status, 200);
    const ok = await post('/idp/password', { tx, passwd: IDP.password });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get('location'), /^\/idp\/mfa\?tx=/);
    const again = await post('/idp/password', { tx, passwd: IDP.password });
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), '/idp/login');
  });
});
