import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, SANDBOX } from '../testing.js';
import { SAP_LOGON } from '../sap-logon.js';

let portal;
before(async () => { portal = await startPortal({ sap: 'realistic' }); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const logon = (path, over = {}) => fetch(`${portal.url}${path}`, {
  method: 'POST', redirect: 'manual', headers: FORM,
  body: new URLSearchParams({ 'sap-client': SAP_LOGON.client, 'sap-user': SAP_LOGON.user, 'sap-password': SAP_LOGON.password, 'sap-language': 'EN', ...over }),
});

test('realistic /sap pages show the logon without a session', async () => {
  for (const path of [SANDBOX.erp.webguiPath, SANDBOX.erp.fioriPath]) {
    const res = await fetch(`${portal.url}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('location'), null);
    const html = await res.text();
    assert.match(html, /id="sap-password"/);
    assert.match(html, /<title>Logon<\/title>/);
    assert.match(html, /System RPA, Client 100/);
  }
});

test('a correct logon sets the SAP cookies and returns to the page', async () => {
  const res = await logon(SANDBOX.erp.webguiPath);
  assert.equal(res.status, 302);
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  const session = cookies.find((c) => c.startsWith(`${SAP_LOGON.cookie}=`));
  assert.match(session, /Path=\//);
  assert.match(session, /HttpOnly/);
  assert.ok(cookies.some((c) => c === 'sap-usercontext=sap-client=100; Path=/'));
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  const gui = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(gui.status, 302);
  assert.match(gui.headers.get('location'), /^\/sap\(.+\)\/bc\/gui\/sap\/its\/webgui/);
});

test('a wrong password shows the SAP message and five lock the user', async () => {
  const bad = await logon(SANDBOX.erp.webguiPath, { 'sap-password': '<x>' });
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /Name or password is incorrect \(repeat logon\)/);
  const client = await logon(SANDBOX.erp.webguiPath, { 'sap-client': '200' });
  assert.match(await client.text(), /Client 100 is the only client/);
  for (let i = 0; i < 3; i++) await logon(SANDBOX.erp.webguiPath, { 'sap-password': 'nope' });
  const fifth = await logon(SANDBOX.erp.webguiPath, { 'sap-password': 'nope' });
  assert.match(await fifth.text(), /User is locked\. Please notify the person responsible/);
  const good = await logon(SANDBOX.erp.webguiPath);
  assert.equal(good.status, 200);
  assert.match(await good.text(), /User is locked/);
  portal.reset();
  assert.equal((await logon(SANDBOX.erp.webguiPath)).status, 302);
});

test('logoff clears the session', async () => {
  const res = await logon(SANDBOX.erp.webguiPath);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const out = await fetch(`${portal.url}/sap/public/bc/icf/logoff`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(out.status, 200);
  const after = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(after.status, 200);
  assert.match(await after.text(), /id="sap-password"/);
});

test('light mode still uses the portal login', async () => {
  const prev = process.env.SANDBOX_SAP;
  delete process.env.SANDBOX_SAP;
  try {
    const res = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/acme/login?next=${encodeURIComponent(SANDBOX.erp.webguiPath)}`);
  } finally { if (prev === undefined) delete process.env.SANDBOX_SAP; else process.env.SANDBOX_SAP = prev; }
});

test('/sap/public/ needs no session and is not the logon page', async () => {
  const res = await fetch(`${portal.url}/sap/public/bc/ui5_ui5/resources/x.js`, { redirect: 'manual' });
  assert.ok(!/id="sap-password"/.test(await res.text()));
});

test('a sessionless OData request gets 401 with a Basic challenge', async () => {
  const res = await fetch(`${portal.url}/sap/opu/odata/sap/ZLINEITEMS_SRV/$metadata`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Basic realm="SAP NetWeaver Application Server [RPA/100]"');
  assert.doesNotMatch(await res.text(), /<html/);
});

test('only failures for the configured user (any case) count toward its lock', async () => {
  for (let i = 0; i < 8; i++) await logon(SANDBOX.erp.webguiPath, { 'sap-user': `OTHER${i}`, 'sap-password': 'nope' });
  assert.equal((await logon(SANDBOX.erp.webguiPath)).status, 302);
  for (let i = 0; i < 4; i++) await logon(SANDBOX.erp.webguiPath, { 'sap-user': 'rpa_bot', 'sap-password': 'nope' });
  const fifth = await logon(SANDBOX.erp.webguiPath, { 'sap-user': 'rpa_bot', 'sap-password': 'nope' });
  assert.match(await fifth.text(), /User is locked/);
});

test('the session map is capped, dropping the oldest', async () => {
  const first = await logon(SANDBOX.erp.webguiPath);
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const ok = () => fetch(`${portal.url}/sap/opu/odata/sap/ZLINEITEMS_SRV/`, { headers: { cookie }, redirect: 'manual' });
  assert.notEqual((await ok()).status, 401);
  for (let i = 0; i < 205; i++) await logon(SANDBOX.erp.webguiPath);
  assert.equal((await ok()).status, 401);
});
