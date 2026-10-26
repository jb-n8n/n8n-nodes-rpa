// The realistic Fiori shell, offline: its markup, the shipped XLSX writer and the realistic dispatch. The app itself runs on real
// OpenUI5 in packages/engine/test/e2e-sap-ui5.test.ts (SANDBOX_UI5=1).
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { startPortal, SANDBOX } from '../testing.js';
import { SAP_LOGON } from '../sap-logon.js';
import { xlsxBytes, XLSX_MIME } from '../xlsx.js';

let portal;
before(async () => { portal = await startPortal({ sap: 'realistic' }); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

async function logon() {
  const res = await fetch(`${portal.url}${SANDBOX.erp.fioriPath}`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'sap-client': SAP_LOGON.client, 'sap-user': SAP_LOGON.user, 'sap-password': SAP_LOGON.password, 'sap-language': 'EN' }),
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), SANDBOX.erp.fioriPath);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const shell = async (cookie) => {
  const res = await fetch(`${portal.url}${SANDBOX.erp.fioriPath}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return res.text();
};
const config = (html) => JSON.parse(/var C = (\{.*?\}), L = C\.L;/s.exec(html)[1]);

test('the shell bootstraps OpenUI5 from SAP\'s own path', async () => {
  const html = await shell(await logon());
  const boot = /<script id="sap-ui-bootstrap"([^>]*)><\/script>/.exec(html)[1];
  assert.match(boot, /src="\/sap\/public\/bc\/ui5_ui5\/resources\/sap-ui-core\.js"/);
  assert.match(boot, /data-sap-ui-theme="sap_horizon"/);
  assert.match(boot, /data-sap-ui-libs="sap\.m,sap\.f"/);
  assert.match(boot, /data-sap-ui-compat-version="edge"/);
  assert.match(boot, /data-sap-ui-async="true"/);
  assert.doesNotMatch(html, /src="https?:/); // nothing is loaded from another host
  assert.match(html, /GenericTile/);
  const C = config(html);
  assert.equal(C.viewId, 'application-LineItem-manage-component---worklist');
  assert.equal(C.service, '/sap/opu/odata/sap/ZLINEITEMS_SRV/');
  assert.match(C.view, /<DateRangeSelection id="postingDate"/);
  assert.match(C.view, /<Table id="table" growing="true" growingThreshold="20"/);
  assert.match(C.view, /<Button id="go" text="Go"/);
  assert.match(C.view, /id="export" icon="sap-icon:\/\/excel-attachment" text="Export to Spreadsheet"/);
  assert.doesNotMatch(C.view, /AlwaysOverflow|exportLayout/);
});

test('the shipped XLSX writer is xlsx.js', async () => {
  const html = await shell(await logon());
  const source = /<script id="rpa-xlsx">([\s\S]*?)<\/script>/.exec(html)[1];
  const window = {};
  runInNewContext(source, { window, TextEncoder, Uint8Array, DataView });
  const rows = [['Document', 'Posting Date', 'Company Code', 'Amount', 'Currency'], ['1900000201', '2026-09-01', '1000', '1234.56', 'USD']];
  assert.deepEqual(Buffer.from(window.rpaXlsx.xlsxBytes(rows, 'Sheet1')), Buffer.from(xlsxBytes(rows, 'Sheet1')));
  assert.equal(window.rpaXlsx.mime, XLSX_MIME);
});

test('variants and the decoy follow the release state', async () => {
  const cookie = await logon();
  portal.setState({ erp: 'renamed' });
  let C = config(await shell(cookie));
  assert.deepEqual(C.L, { tile: 'G/L Line Items', go: 'Apply', xls: 'Download spreadsheet' });
  assert.match(C.view, /<Title id="title" text="G\/L Line Items"/);
  assert.match(C.view, /<Button id="go" text="Apply"/);
  portal.setState({ erp: 'menu' });
  C = config(await shell(cookie));
  assert.match(C.view, /id="export"[^>]*><layoutData><OverflowToolbarLayoutData priority="AlwaysOverflow"\/><\/layoutData>/);
  portal.setState({ erp: 'dialog', erpDecoy: true });
  C = config(await shell(cookie));
  assert.equal(C.variant, 'dialog');
  assert.match(C.view, /id="exportLayout"[^>]*text="Export layout"/);
});

test('the realistic dispatch answers the OData service, not the light one', async () => {
  const sessionless = await fetch(`${portal.url}/sap/opu/odata/sap/ZLINEITEMS_SRV/$metadata`);
  assert.equal(sessionless.status, 401);
  const cookie = await logon();
  const xml = await (await fetch(`${portal.url}/sap/opu/odata/sap/ZLINEITEMS_SRV/$metadata`, { headers: { cookie } })).text();
  assert.match(xml, /Name="PostingDate" Type="Edm.DateTime"/); // the light service types it Edm.String
  assert.equal((await fetch(`${portal.url}/sap/bc/ui2/nothing`, { headers: { cookie } })).status, 404);
});
