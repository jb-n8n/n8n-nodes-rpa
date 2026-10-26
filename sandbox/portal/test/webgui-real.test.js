import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, SANDBOX } from '../testing.js';
import { SAP_LOGON } from './../sap-logon.js';
import { XLSX_MIME } from '../xlsx.js';

let portal;
before(async () => { portal = await startPortal({ sap: 'realistic' }); });
after(async () => { process.env.SANDBOX_SAP = 'realistic'; await portal.close(); });
beforeEach(() => { portal.reset(); });

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function logon() {
  const res = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, {
    method: 'POST', redirect: 'manual', headers: FORM,
    body: new URLSearchParams({ 'sap-client': SAP_LOGON.client, 'sap-user': SAP_LOGON.user, 'sap-password': SAP_LOGON.password, 'sap-language': 'EN' }),
  });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function startGui(query = '') {
  const cookie = await logon();
  const start = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}${query}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(start.status, 302);
  const path = start.headers.get('location');
  const gui = { path, html: '', res: null };
  gui.get = async () => { gui.res = await fetch(`${portal.url}${path}`, { headers: { cookie } }); gui.html = await gui.res.text(); return gui.html; };
  gui.post = async (okcode, fields = {}) => {
    const token = /name="~sec_sesstoken" value="([^"]+)"/.exec(gui.html)[1];
    gui.res = await fetch(`${portal.url}${path}`, { method: 'POST', headers: { cookie, ...FORM }, body: new URLSearchParams({ '~sec_sesstoken': token, '~okcode': okcode, ...fields }) });
    gui.html = gui.res.headers.get('content-disposition') ? '' : await gui.res.text();
    return gui.html;
  };
  await gui.get();
  return gui;
}
const SEPT = { 'S_BUKRS-LOW': '1000', 'S_BUDAT-LOW': '01.09.2026', 'S_BUDAT-HIGH': '30.09.2026' };
const toResult = async (gui, period = SEPT) => { await gui.post('ZLINEITEMS'); return gui.post('ONLI', period); };
const gridRows = (html) => (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g) || []).length;
const ids = (html) => [...html.matchAll(/ id="(M0:[^"]+)"/g)].map((m) => m[1]);

test('the selection screen uses SAP dates and SIDs', async () => {
  const gui = await startGui('?~transaction=ZLINEITEMS');
  assert.match(gui.path, /^\/sap\([A-Za-z0-9_-]+\)\/bc\/gui\/sap\/its\/webgui$/);
  assert.match(gui.html, /<h1[^>]*>Line Item Report<\/h1>/);
  for (const sid of ['wnd[0]/usr/ctxtS_BUKRS-LOW', 'wnd[0]/usr/ctxtS_BUDAT-LOW', 'wnd[0]/usr/ctxtS_BUDAT-HIGH', 'wnd[0]/tbar[1]/btn[8]', 'wnd[0]/tbar[0]/okcd']) {
    assert.ok(gui.html.includes(`lsdata="${sid}"`), sid);
  }
  assert.ok(!gui.html.includes('type="date"'));
  assert.match(gui.html, /role="menubar"/);
  assert.match(gui.html, /role="status"/);
  assert.match(gui.html, /title="Enter transaction code"/);
  const first = ids(gui.html);
  assert.ok(first.length > 10);
  for (const id of first) assert.match(id, /^M0:46:[0-9a-f]+::\d+:\d+$/);
  assert.equal(new Set(first).size, first.length);
  const second = ids(await gui.get());
  assert.ok(!second.some((id) => first.includes(id)), 'two renders share no id');
});

test('Easy Access takes the transaction code and rejects others', async () => {
  const gui = await startGui();
  assert.ok(gui.html.includes('SAP Easy Access'));
  await gui.post('ENTER', { '~command': 'SE16<x>' });
  assert.match(gui.html, /class="ico E"[^>]*>E<\/span><span>Transaction SE16&lt;x&gt; does not exist/);
  await gui.post('ENTER', { '~command': '/nZLINEITEMS' });
  assert.match(gui.html, /<h1[^>]*>Line Item Report<\/h1>/);
  await gui.post('ENTER', { '~command': '/n' });
  assert.ok(gui.html.includes('SAP Easy Access'));
});

test('a DD.MM.YYYY range lists the September rows', async () => {
  const gui = await startGui();
  const html = await toResult(gui);
  assert.equal(gridRows(html), SANDBOX.erp.rowsInSeptember1000);
  assert.ok(html.includes('Line Item Report: Company Code 1000, 01.09.2026 - 30.09.2026'));
  assert.ok(html.includes('>01.09.2026<') && html.includes('>1900000201<'));
  for (const h of ['Document No.', 'Posting Date', 'Company Code', 'Amount', 'Currency']) assert.ok(html.includes(`>${h}<`), h);
  assert.match(html, /<table role="grid"[^>]*lsdata="wnd\[0\]\/usr\/cntlGRID1\/shellcont\/shell"/);
  const empty = await toResult(await startGui(), { ...SEPT, 'S_BUDAT-LOW': '01.12.2026', 'S_BUDAT-HIGH': '31.12.2026' });
  assert.equal(gridRows(empty), 0);
  assert.match(empty, /class="ico S"[^>]*>S<\/span><span>No data found/);
});

test('a bad date shows the SAP message', async () => {
  const gui = await startGui();
  const html = await toResult(gui, { ...SEPT, 'S_BUDAT-LOW': '2026-09-01' });
  assert.match(html, /class="ico E"[^>]*>E<\/span><span>Invalid date format\. Please enter the date in the format __\.__\.____/);
  assert.ok(html.includes('value="2026-09-01"'));
  assert.match(await gui.post('ONLI', { ...SEPT, 'S_BUKRS-LOW': '' }), /Fill in all required entry fields/);
  assert.match(await gui.post('ONLI', { ...SEPT, 'S_BUDAT-LOW': '31.02.2026' }), /Invalid date format/);
});

test('the spreadsheet popup downloads XLSX', async () => {
  const gui = await startGui();
  const html = await toResult(gui);
  assert.match(html, /title="Spreadsheet\.\.\. \(Ctrl\+Shift\+F7\)"/);
  const popup = await gui.post('&XXL', SEPT);
  assert.match(popup, /<div role="dialog"[^>]*lsdata="wnd\[1\]"/);
  assert.match(popup, /value="XLSX" title="[^"]*" checked/);
  assert.ok(popup.includes('Continue (Enter)') && popup.includes('Cancel (F12)'));
  await gui.post('ENTER', { FORMAT: 'XLSX' });
  assert.equal(gui.res.headers.get('content-type'), XLSX_MIME);
  assert.match(gui.res.headers.get('content-disposition'), /filename="export\.XLSX"/);
  const bytes = Buffer.from(await gui.res.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
});

test('the dialog variant preselects Unconverted and downloads text', async () => {
  portal.setState({ erp: 'dialog' });
  const gui = await startGui();
  await toResult(gui);
  const popup = await gui.post('&XXL');
  assert.match(popup, /value="TXT" title="[^"]*" checked/);
  await gui.post('ENTER', { FORMAT: 'TXT' });
  assert.match(gui.res.headers.get('content-disposition'), /filename="export\.txt"/);
  const text = await gui.res.text();
  assert.equal(text.split('\n').length, SANDBOX.erp.rowsInSeptember1000 + 1);
  assert.ok(text.split('\n')[0].includes('\t'));
});

test('the menu and renamed variants', async () => {
  portal.setState({ erp: 'menu' });
  let gui = await startGui();
  let html = await toResult(gui);
  assert.ok(!html.includes('Ctrl+Shift+F7'));
  assert.match(html, /role="menuitem"[^>]*>List<\/button>/);
  assert.match(html, /name="~okcode" value="&amp;XXL"[^>]*>Spreadsheet\.\.\.<\/button>/);
  portal.setState({ erp: 'renamed' });
  gui = await startGui();
  assert.ok(gui.html.includes('G/L Line Items'));
  await gui.post('ZLINEITEMS');
  assert.ok(gui.html.includes('Run (F8)'));
  html = await gui.post('ONLI', SEPT);
  assert.ok(html.includes('Export to Spreadsheet'));
});

test('the decoy downloads layout.XLSX', async () => {
  portal.setState({ erpDecoy: true });
  const gui = await startGui();
  const html = await toResult(gui);
  assert.ok(html.includes('>Layout...</button>'));
  await gui.post('LAYO');
  assert.match(gui.res.headers.get('content-disposition'), /filename="layout\.XLSX"/);
  assert.equal(Buffer.from(await gui.res.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('an unknown context says the session has ended and a bad token is refused', async () => {
  const cookie = await logon();
  const res = await fetch(`${portal.url}/sap(zzzz)/bc/gui/sap/its/webgui`, { headers: { cookie } });
  assert.ok((await res.text()).includes('Your session has ended'));
  const gui = await startGui();
  await gui.post('ZLINEITEMS', {});
  const bad = await fetch(`${portal.url}${gui.path}`, { method: 'POST', headers: { cookie, ...FORM }, body: new URLSearchParams({ '~sec_sesstoken': 'nope', '~okcode': 'ENTER' }) });
  assert.equal(bad.status, 403);
});

test('light mode is untouched', async () => {
  process.env.SANDBOX_SAP = 'light';
  try {
    const login = await fetch(`${portal.url}/acme/login`, {
      method: 'POST', redirect: 'manual', headers: FORM,
      body: new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const start = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}?~transaction=ZLINEITEMS`, { headers: { cookie }, redirect: 'manual' });
    const html = await (await fetch(`${portal.url}${start.headers.get('location')}`, { headers: { cookie } })).text();
    assert.match(html, /<input type="date"[^>]*name="S_BUDAT-LOW"/);
    assert.ok(html.includes('Classic GUI for HTML'));
    assert.ok(!html.includes('role="menubar"'));
  } finally { process.env.SANDBOX_SAP = 'realistic'; }
});
