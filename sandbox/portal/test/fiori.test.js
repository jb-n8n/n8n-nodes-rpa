import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { startPortal, SANDBOX } from '../testing.js';
import { exportFileName, lineItems, lineItemsCsv } from '../erp.js';

let portal;
before(async () => { portal = await startPortal(); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const SERVICE = '/sap/opu/odata/sap/ZLINEITEMS_SRV/';

async function login() {
  const res = await fetch(`${portal.url}/acme/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password }),
  });
  assert.equal(res.status, 302);
  return res.headers.get('set-cookie').split(';')[0];
}

const fetchToken = async (cookie) =>
  (await fetch(`${portal.url}${SERVICE}`, { method: 'HEAD', headers: { cookie, 'x-csrf-token': 'Fetch' } })).headers.get('x-csrf-token');

const batchBody = (inner, boundary = 'batch_test') =>
  `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${inner} HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n--${boundary}--`;
const readRequest = (company = '1000', from = SANDBOX.erp.from, to = SANDBOX.erp.to) =>
  `GET LineItems?$filter=CompanyCode eq '${company}' and PostingDate ge datetime'${from}T00:00:00' and PostingDate le datetime'${to}T00:00:00'&$format=json`;
const postBatch = (cookie, token, body) => fetch(`${portal.url}${SERVICE}$batch`, {
  method: 'POST', body,
  headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}), 'content-type': 'multipart/mixed; boundary=batch_test' },
});

test('the token fetch returns a token', async () => {
  const cookie = await login();
  const res = await fetch(`${portal.url}${SERVICE}`, { method: 'HEAD', headers: { cookie, 'x-csrf-token': 'Fetch' } });
  assert.equal(res.status, 200);
  const token = res.headers.get('x-csrf-token');
  assert.ok(token && token !== 'Required');
  assert.equal(await fetchToken(cookie), token);
  assert.notEqual(await fetchToken(await login()), token);
});

test('a batch read without the token is refused', async () => {
  const cookie = await login();
  const res = await postBatch(cookie, null, batchBody(readRequest()));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-csrf-token'), 'Required');
});

test('a batch read returns the September rows for 1000', async () => {
  const cookie = await login();
  const res = await postBatch(cookie, await fetchToken(cookie), batchBody(readRequest()));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^multipart\/mixed/);
  const text = await res.text();
  assert.match(text, /HTTP\/1\.1 200 OK/);
  const results = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).d.results;
  assert.equal(results.length, SANDBOX.erp.rowsInSeptember1000);
  assert.match(results[0].Document, /^19\d{8}$/);
  assert.deepEqual(Object.keys(results[0]), ['Document', 'PostingDate', 'CompanyCode', 'Amount', 'Currency']);
});

test('a batch with another request shape is refused', async () => {
  const cookie = await login();
  const token = await fetchToken(cookie);
  assert.equal((await postBatch(cookie, token, batchBody("DELETE LineItems('1')"))).status, 400);
  assert.equal((await postBatch(cookie, token, 'not multipart')).status, 400);
  assert.equal((await postBatch(cookie, token, batchBody(readRequest("1000' or '1'='1")))).status, 400);
});

test('the metadata names the LineItems entity set', async () => {
  const res = await fetch(`${portal.url}${SERVICE}$metadata`, { headers: { cookie: await login() } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /EntitySet Name="LineItems"/);
});

test('the launchpad lists the tile per variant', async () => {
  const flp = async () => (await fetch(`${portal.url}${SANDBOX.erp.fioriPath}`, { headers: { cookie: await login() } })).text();
  let html = await flp();
  assert.ok(html.includes('#LineItem-manage') && html.includes('Manage Line Items'));
  portal.setState({ erp: 'renamed' });
  html = await flp();
  assert.ok(html.includes('#LineItem-manage') && html.includes('G/L Line Items') && !html.includes('Manage Line Items'));
});

test('the Fiori routes need the portal session', async () => {
  const res = await fetch(`${portal.url}${SANDBOX.erp.fioriPath}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('the session cookie is sent to the SAP routes without any injection', async () => {
  const res = await fetch(`${portal.url}/acme/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: SANDBOX.username, password: SANDBOX.password }),
  });
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /;\s*Path=\/(;|$)/);
  const sap = await fetch(`${portal.url}${SANDBOX.erp.webguiPath}`, { headers: { cookie: setCookie.split(';')[0] }, redirect: 'manual' });
  assert.notEqual(sap.headers.get('location'), '/acme/login');
  assert.equal(sap.status, 302);
  assert.match(sap.headers.get('location'), /^\/sap\(/);
});

test('the Fiori client builds its CSV and file name with the erp.js code the web GUI export uses (byte-identical files)', async () => {
  const cookie = await login();
  const html = await (await fetch(`${portal.url}${SANDBOX.erp.fioriPath}`, { headers: { cookie } })).text();
  const src = /<script id="erp-files">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(src, 'the page carries the erp.js file builders');
  const window = {};
  runInNewContext(src, { window });
  const res = await postBatch(cookie, await fetchToken(cookie), batchBody(readRequest()));
  const text = await res.text();
  const results = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).d.results;
  const { company, from, to } = SANDBOX.erp;
  assert.equal(window.erpFiles.csv(results), lineItemsCsv(lineItems(company, from, to)));
  assert.equal(window.erpFiles.fileName(company, from, to), exportFileName(company, from, to));
  // The app itself keeps no copy of the header or the file name.
  assert.ok(!html.includes("'LINEITEMS_'") && !html.includes("'Posting Date'"));
});
