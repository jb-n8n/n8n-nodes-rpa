import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, SANDBOX } from '../testing.js';
import { shuffledErp } from '../erp.js';

let portal;
before(async () => { portal = await startPortal(); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const ADMIN = { authorization: `Basic ${Buffer.from('admin:change-me').toString('base64')}` };

async function login() {
  const res = await fetch(`${portal.url}/acme/login`, {
    method: 'POST', redirect: 'manual', headers: FORM,
    body: new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password }),
  });
  assert.equal(res.status, 302);
  return res.headers.get('set-cookie').split(';')[0];
}

// Starts a web GUI session and returns helpers that read the form and POST okcodes.
async function startGui(cookie, query = '') {
  const start = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}${query}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(start.status, 302);
  const path = start.headers.get('location');
  const gui = { cookie, path, html: '', res: null };
  gui.get = async () => {
    gui.res = await fetch(`${portal.url}${path}`, { headers: { cookie } });
    gui.html = await gui.res.text();
    return gui.html;
  };
  gui.token = () => /name="~sec_sesstoken" value="([^"]+)"/.exec(gui.html)[1];
  gui.post = async (okcode, fields = {}, token = gui.token()) => {
    gui.res = await fetch(`${portal.url}${path}`, {
      method: 'POST', headers: { cookie, ...FORM },
      body: new URLSearchParams({ '~sec_sesstoken': token, '~okcode': okcode, ...fields }),
    });
    gui.html = await gui.res.text();
    return gui.html;
  };
  await gui.get();
  return gui;
}
const gridRows = (html) => (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g) || []).length;
const SEPT = { S_BUKRS: '1000', 'S_BUDAT-LOW': SANDBOX.erp.from, 'S_BUDAT-HIGH': SANDBOX.erp.to };

async function toResult(gui, period = SEPT) {
  await gui.post('ZLINEITEMS');
  return gui.post('ONLI', period);
}

test('every interaction is a POST to the session URL', async () => {
  const gui = await startGui(await login());
  assert.match(gui.path, /^\/sap\([A-Za-z0-9_-]+\)\/bc\/gui\/sap\/its\/webgui$/);
  assert.match(gui.html, /<form id="webguiform" method="post" action="([^"]+)"/);
  assert.equal(/<form id="webguiform" method="post" action="([^"]+)"/.exec(gui.html)[1], gui.path);
  assert.ok(gui.html.includes('SAP Easy Access'));
});

test('the line item report end to end', async () => {
  const gui = await startGui(await login());
  const html = await toResult(gui);
  assert.equal(gridRows(html), SANDBOX.erp.rowsInSeptember1000);
  await gui.post('&XXL');
  assert.match(gui.res.headers.get('content-disposition'), /filename="LINEITEMS_1000_2026-09-01_2026-09-30\.csv"/);
  const lines = gui.html.split('\n');
  assert.equal(lines[0], SANDBOX.erp.header);
  assert.equal(lines.length, SANDBOX.erp.rowsInSeptember1000 + 1);
  assert.match(lines[1], new RegExp(`^${SANDBOX.erp.idPattern},`));
});

test('a wrong token is refused', async () => {
  const gui = await startGui(await login());
  await gui.post('ZLINEITEMS', {}, 'x');
  assert.equal(gui.res.status, 403);
});

test('an unknown session ends', async () => {
  const cookie = await login();
  const res = await fetch(`${portal.url}/sap(AAAA)/bc/gui/sap/its/webgui`, { method: 'POST', headers: { cookie, ...FORM }, body: '~okcode=ENTER' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Your session has ended/);
});

test('element ids change on every response', async () => {
  const gui = await startGui(await login());
  const ids = (h) => new Set(h.match(/id="M0:[^"]+"/g));
  const a = ids(gui.html);
  await gui.get();
  const b = ids(gui.html);
  assert.ok(a.size > 0);
  assert.deepEqual([...a].filter((x) => b.has(x)), []);
});

test('each variant renders its own controls', async () => {
  portal.setState({ erp: 'renamed' });
  let gui = await startGui(await login());
  assert.ok(gui.html.includes('G/L Line Items'));
  await gui.post('ZLINEITEMS');
  assert.match(gui.html, />Run</);
  await gui.post('ONLI', SEPT);
  assert.match(gui.html, />Download spreadsheet</);

  portal.setState({ erp: 'menu' });
  gui = await startGui(await login());
  await toResult(gui);
  assert.match(gui.html, />More</);
  assert.match(gui.html, /<div id="[^"]+" hidden><button[^>]*value="&amp;XXL">Export<\/button><\/div>/);

  portal.setState({ erp: 'dialog' });
  gui = await startGui(await login());
  await toResult(gui);
  assert.ok(!gui.html.includes('role="dialog"'));
  await gui.post('&XXL_DIALOG');
  assert.ok(gui.html.includes('role="dialog"'));
  await gui.post('&XXL');
  assert.ok(gui.html.includes('Choose a format'));
  await gui.post('&XXL', { FORMAT: 'CSV' });
  assert.match(gui.res.headers.get('content-disposition'), /attachment/);
  assert.equal(gui.html.split('\n')[0], SANDBOX.erp.header);
});

test('the decoy is a different file', async () => {
  portal.setState({ erpDecoy: true });
  const gui = await startGui(await login());
  const html = await toResult(gui);
  assert.ok(html.includes('Export layout'));
  await gui.post('LAYO');
  assert.match(gui.res.headers.get('content-disposition'), /filename="layout-settings\.csv"/);
  assert.ok(gui.html.startsWith('Column,Width,Visible'));
});

test('December has no data', async () => {
  const gui = await startGui(await login());
  const html = await toResult(gui, { S_BUKRS: '1000', 'S_BUDAT-LOW': SANDBOX.erp.emptyFrom, 'S_BUDAT-HIGH': SANDBOX.erp.emptyTo });
  assert.ok(html.includes('No data found'));
});

test('the command line and a missing field behave like SAP', async () => {
  const gui = await startGui(await login());
  await gui.post('ENTER', { '~command': 'SE38' });
  assert.ok(gui.html.includes('Transaction does not exist'));
  await gui.post('ENTER', { '~command': '/nZLINEITEMS' });
  assert.ok(gui.html.includes('Line Item Report'));
  await gui.post('ONLI', { S_BUKRS: '1000' });
  assert.ok(gui.html.includes('Fill in all required entry fields'));
  const direct = await startGui(await login(), '?~transaction=ZLINEITEMS');
  assert.ok(direct.html.includes('Company Code'));
});

test('shuffledErp is deterministic and never baseline', () => {
  assert.deepEqual(shuffledErp(7), shuffledErp(7));
  for (let seed = 1; seed <= 50; seed++) assert.notEqual(shuffledErp(seed).erp, 'baseline');
});

test('the ERP shuffle leaves the notices release alone', async () => {
  portal.setState({ label: 'Field Actions' });
  const res = await fetch(`${portal.url}/admin/api/shuffle-erp`, { method: 'POST', headers: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(portal.state().label, 'Field Actions');
  assert.notEqual(portal.state().erp, 'baseline');
});

test('the look-alike needs a session', async () => {
  const res = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/acme/login?next=${encodeURIComponent(SANDBOX.erp.webguiPath)}`);
});

test('signing in returns to the page that asked for it, and only to a same-site path', async () => {
  const signIn = async (next) => {
    const page = await fetch(`${portal.url}/acme/login?next=${encodeURIComponent(next)}`);
    const html = await page.text();
    const hidden = /name="next" value="([^"]*)"/.exec(html)?.[1];
    const body = new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password, ...(hidden !== undefined ? { next: hidden.replace(/&amp;/g, '&') } : {}) });
    const res = await fetch(`${portal.url}/acme/login`, { method: 'POST', body, redirect: 'manual' });
    return res.headers.get('location');
  };
  assert.equal(await signIn(SANDBOX.erp.webguiPath), SANDBOX.erp.webguiPath);
  assert.equal(await signIn('/sap/bc/gui/sap/its/webgui?~transaction=ZLINEITEMS'), '/sap/bc/gui/sap/its/webgui?~transaction=ZLINEITEMS');
  for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/\tx', 'acme/home']) {
    assert.equal(await signIn(bad), '/acme/home', bad);
  }
});

test('the redirect hook refuses any target but a single / and a path character', async () => {
  const cookie = await login();
  for (const to of ['//evil.example/x', '/\\evil.example/x', '\\evil.example', 'https://evil.example/', 'acme/home', '/']) {
    const res = await fetch(`${portal.url}/sap/test/redirect?to=${encodeURIComponent(to)}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 400, to);
  }
  const none = await fetch(`${portal.url}/sap/test/redirect`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(none.status, 400);
});

test('the redirect hook refuses control characters and space', async () => {
  const cookie = await login();
  for (const to of ['/%09/evil.example/x', '/%20x', '/%7fx', '//x', '/acme/home%0d%0aX-Evil:1', '/acme%09/home', '/acme/home%00']) {
    const res = await fetch(`${portal.url}/sap/test/redirect?to=${to}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 400, to);
  }
  const ok = await fetch(`${portal.url}/sap/test/redirect?to=/acme/home`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(ok.status, 307);
});

test('the redirect hook answers 307', async () => {
  const cookie = await login();
  const res = await fetch(`${portal.url}/sap/test/redirect?to=/acme/home`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), '/acme/home');
  const form = await (await fetch(`${portal.url}/sap/test/redirect-form?to=/acme/home`, { headers: { cookie } })).text();
  assert.match(form, /<form method="post" action="\/sap\/test\/redirect\?to=%2Facme%2Fhome"/);
  assert.match(form, />Send</);
});
