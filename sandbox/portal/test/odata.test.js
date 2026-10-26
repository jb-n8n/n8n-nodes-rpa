import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { odataRoute, parseBatchRequests, parseFilter, lineItemsQuery, SERVICE_ROOT } from '../odata.js';
import { SAP_LOGON } from '../sap-logon.js';

// These tests serve odataRoute from a small server of their own (no SAP logon in front of it; fiori-real.test.js covers the dispatch).
let server, base;
before(async () => {
  server = createServer(async (req, res) => {
    const send = (r, status, body, headers = {}) => { r.writeHead(status, { 'Content-Type': 'text/html', ...headers }); r.end(body); };
    if (!(await odataRoute(req, res, new URL(req.url, 'http://x'), send))) send(res, 404, 'nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const cookie = `${SAP_LOGON.cookie}=session-one`;
const tokenOf = async (path = '', method = 'HEAD', c = cookie) =>
  (await fetch(`${base}${SERVICE_ROOT}${path}`, { method, headers: { cookie: c, 'x-csrf-token': 'Fetch' } })).headers.get('x-csrf-token');
const FIXTURE = readFileSync(new URL('./fixtures/ui5-batch-documented.txt', import.meta.url), 'utf8');
// Written by packages/engine/test/e2e-sap-ui5.test.ts with SANDBOX_UI5_RECORD=1: every $batch body real UI5 1.148.10 sent, joined.
const RECORDED = new URL('./fixtures/ui5-batch-recorded.txt', import.meta.url);
const post = (body, token, boundary = /^--(\S+)/.exec(body)[1]) => fetch(`${base}${SERVICE_ROOT}/$batch`, {
  method: 'POST', body, headers: { cookie, ...(token ? { 'x-csrf-token': token } : {}), 'content-type': `multipart/mixed; boundary=${boundary}` },
});
const part = (line, boundary = 'b1') => `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${line} HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n`;
const batchOf = (...lines) => lines.map((l) => part(l)).join('') + '--b1--';
const SEP = "(CompanyCode%20eq%20%271000%27%20and%20(PostingDate%20ge%20datetime%272026-09-01T00%3A00%3A00%27%20and%20PostingDate%20le%20datetime%272026-09-30T00%3A00%3A00%27))";
// Splits a $batch answer into [{ status, headers text, body }].
const answers = async (res) => {
  const boundary = /boundary=(.+)$/.exec(res.headers.get('content-type'))[1];
  return (await res.text()).split(`--${boundary}`).slice(1, -1).map((p) => {
    const [, head, ...body] = p.split('\r\n\r\n');
    return { head, body: body.join('\r\n\r\n').replace(/\r\n$/, '') };
  });
};

test('the token fetch works with HEAD and GET, with and without the trailing slash', async () => {
  const tokens = new Set();
  for (const method of ['HEAD', 'GET']) for (const path of ['', '/']) {
    const res = await fetch(`${base}${SERVICE_ROOT}${path}`, { method, headers: { cookie, 'x-csrf-token': 'Fetch' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('dataserviceversion'), '2.0');
    tokens.add(res.headers.get('x-csrf-token'));
  }
  assert.equal(tokens.size, 1);
  const [token] = tokens;
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.notEqual(await tokenOf('', 'HEAD', `${SAP_LOGON.cookie}=session-two`), token);
  const plain = await fetch(`${base}${SERVICE_ROOT}`, { headers: { cookie } });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('x-csrf-token'), null);
});

test('metadata types PostingDate as Edm.DateTime', async () => {
  const xml = await (await fetch(`${base}${SERVICE_ROOT}/$metadata`, { headers: { cookie } })).text();
  assert.match(xml, /Name="PostingDate" Type="Edm.DateTime"[^>]*sap:display-format="Date"/);
  assert.match(xml, /Name="Amount" Type="Edm.Decimal"/);
  assert.match(xml, /sap:label="Company Code"/);
});

test('accepts the request shapes UI5 1.148 sends', async () => {
  const token = await tokenOf();
  const res = await post(FIXTURE, token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('dataserviceversion'), '2.0');
  const [count, data] = await answers(res);
  assert.match(count.head, /Content-Type: text\/plain/);
  assert.match(count.head, /dataserviceversion: 2\.0/);
  assert.equal(count.body, '8');
  assert.match(data.head, /Content-Type: application\/json/);
  const d = JSON.parse(data.body).d;
  assert.equal(d.results.length, 8);
  assert.equal(d.__count, '8');
  for (const r of d.results) {
    assert.match(r.PostingDate, /^\/Date\(\d+\)\/$/);
    // UI5's list binding keys each row by __metadata.uri; Edm.Decimal travels as a string, as in real OData V2
    assert.deepEqual(r.__metadata, { uri: `${SERVICE_ROOT}/LineItems('${r.Document}')`, type: 'ZLINEITEMS_SRV.LineItem' });
    assert.equal(typeof r.Amount, 'string');
    assert.match(r.Amount, /^\d+\.\d{2}$/);
  }
  assert.equal(d.results[0].PostingDate, `/Date(${Date.UTC(2026, 8, 30)})/`); // $orderby=PostingDate desc
  assert.equal(d.results[0].Document, '1900000208');
  // LF line endings and lower-case headers work too
  const lf = FIXTURE.replace(/\r\n/g, '\n').replace(/^Content-Type:/gm, 'content-type:');
  assert.equal((await answers(await post(lf, token)))[0].body, '8');
});

test('options: $inlinecount, $orderby, $skip/$top, $select, sap-client', async () => {
  const token = await tokenOf();
  const read = async (q) => JSON.parse((await answers(await post(batchOf(`GET LineItems?${q}`), token)))[0].body).d;
  const asc = await read(`$filter=${SEP}`);
  assert.equal(asc.__count, undefined);
  assert.equal(asc.results[0].Document, '1900000201');
  const desc = await read(`$orderby=PostingDate%20desc&$filter=${SEP}`);
  assert.deepEqual(desc.results.map((r) => r.Document), asc.results.map((r) => r.Document).reverse());
  const paged = await read(`$skip=2&$top=3&$inlinecount=allpages&$filter=${SEP}&sap-client=100`);
  assert.deepEqual(paged.results.map((r) => r.Document), asc.results.slice(2, 5).map((r) => r.Document));
  assert.equal(paged.__count, '8');
  const sel = await read(`$select=Document,Amount&$top=1`);
  assert.deepEqual(Object.keys(sel.results[0]), ['__metadata', 'Document', 'Amount']);
  assert.equal(sel.results[0].__metadata.uri, `${SERVICE_ROOT}/LineItems('${sel.results[0].Document}')`);
  assert.equal(sel.results[0].Amount, '845.10');
  const byDoc = await read(`$orderby=Document%20desc&$top=1`);
  assert.equal(byDoc.results[0].Document, '1900000501');
});

test('refuses anything but reads', async () => {
  const token = await tokenOf();
  const refuse = async (body, re) => {
    const res = await post(body, token);
    assert.equal(res.status, 400);
    const e = (await res.json()).error;
    assert.equal(e.code, 'RPA/400');
    assert.equal(e.message.lang, 'en');
    assert.match(e.message.value, re);
  };
  await refuse(batchOf('POST LineItems'), /POST is not supported/);
  await refuse(batchOf('MERGE LineItems'), /MERGE is not supported/);
  await refuse(batchOf("PUT LineItems('1')"), /PUT is not supported/);
  await refuse(batchOf("DELETE LineItems('1')"), /DELETE is not supported/);
  await refuse(`--b1\r\nContent-Type: multipart/mixed; boundary=changeset_x\r\n\r\n--changeset_x\r\nContent-Type: application/http\r\n\r\nPOST LineItems HTTP/1.1\r\n\r\n--changeset_x--\r\n--b1--`, /Changesets are not supported/);
  await refuse(batchOf('GET Users'), /Unsupported resource "Users"/);
  await refuse(batchOf('GET LineItems?$expand=Foo'), /Unsupported query option \$expand/);
  await refuse(batchOf("GET LineItems?$filter=Amount gt '5'"), /Unsupported \$filter/);
  await refuse(batchOf("GET LineItems?$filter=CompanyCode eq '1000' or CompanyCode eq '2000'"), /Unsupported \$filter/);
  await refuse(batchOf('GET LineItems?$orderby=Amount'), /Unsupported \$orderby/);
  await refuse(batchOf('GET LineItems/$count?$top=1'), /Unsupported query option \$top/);
  await refuse(batchOf('GET LineItems?$top=-1'), /\$top must be/);
  await refuse(batchOf('GET LineItems?$filter=%E0%A4%A'), /percent-encoding/);
  // direct (non-batch) writes and reads are refused as well
  for (const method of ['POST', 'PUT', 'MERGE', 'DELETE']) {
    const r = await fetch(`${base}${SERVICE_ROOT}/LineItems`, { method, headers: { cookie, 'x-csrf-token': token } });
    assert.ok(r.status === 404 || r.status === 405);
  }
  assert.equal((await fetch(`${base}${SERVICE_ROOT}/`, { method: 'DELETE', headers: { cookie } })).status, 405);
});

test('$top is capped at 500 and $count ignores sap-client', async () => {
  assert.equal(lineItemsQuery(new URLSearchParams('$top=100000')).rows.length, 16);
  const token = await tokenOf();
  const [c] = await answers(await post(batchOf(`GET LineItems/$count?sap-client=100&$filter=${SEP}`), token));
  assert.equal(c.body, '8');
});

test('a batch without the token is 403 with x-csrf-token: Required', async () => {
  for (const token of [null, 'wrong', await tokenOf('', 'HEAD', `${SAP_LOGON.cookie}=session-two`)]) {
    const res = await post(batchOf('GET LineItems?$top=1'), token);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('x-csrf-token'), 'Required');
  }
});

test('other paths are not answered', async () => {
  const res = await fetch(`${base}/sap/opu/odata/sap/OTHER_SRV/`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'nope');
});

test('parseFilter: forms, operators, nesting and refusals', () => {
  assert.deepEqual(parseFilter("CompanyCode eq '1000'"), { company: '1000' });
  assert.deepEqual(parseFilter("((PostingDate gt datetime'2026-09-01T00:00:00')) and PostingDate lt datetime'2026-10-01T00:00:00.000'"),
    { from: '2026-09-01', fromOp: 'gt', to: '2026-10-01', toOp: 'lt' });
  assert.deepEqual(parseFilter("PostingDate eq datetime'2026-09-04T00:00:00'"), { from: '2026-09-04', to: '2026-09-04', fromOp: 'eq', toOp: 'eq' });
  for (const bad of ['', 'and', "CompanyCode eq '1000' and", "CompanyCode eq '1000'))", '((CompanyCode eq \'1000\'',
    "CompanyCode eq '1000' and CompanyCode eq '2000'", "PostingDate ge datetime'2026-09-01T00:00:00' and PostingDate gt datetime'2026-09-02T00:00:00'",
    "PostingDate ge datetime'2026-02-31T00:00:00'", "PostingDate ge datetime'2026-09-01T10:00:00'", "CompanyCode eq '10 00'", "CompanyCode ne '1000'", 'x'.repeat(5000)]) {
    assert.ok(parseFilter(bad).error, `should refuse ${bad.slice(0, 40)}`);
  }
});

test('parseFilter stays fast on adversarial input', () => {
  const t = Date.now();
  for (const s of ['('.repeat(100000), `${'('.repeat(1000)}CompanyCode eq '1000'${')'.repeat(1000)}`, 'and '.repeat(50000), ' '.repeat(100000), "CompanyCode eq '".repeat(5000)]) {
    assert.ok(parseFilter(s).error);
  }
  assert.ok(Date.now() - t < 1000);
});

test('parseBatchRequests: the documented fixture, bare parts and bad input', () => {
  const r = parseBatchRequests('multipart/mixed; boundary=batch_0123', FIXTURE);
  assert.deepEqual(r.map((x) => x.path), ['LineItems/$count', 'LineItems']);
  assert.equal(r[1].query.get('$orderby'), 'PostingDate desc');
  assert.ok(parseBatchRequests('multipart/mixed', FIXTURE).error);
  assert.ok(parseBatchRequests('application/json; boundary=x', FIXTURE).error);
  assert.ok(parseBatchRequests('multipart/mixed; boundary="zzz"', FIXTURE).error);
  const quoted = parseBatchRequests('multipart/mixed; boundary="b1"', batchOf('GET LineItems/$count'));
  assert.deepEqual(quoted.map((x) => x.path), ['LineItems/$count']);
  const prefixed = parseBatchRequests('multipart/mixed; boundary=b1', batchOf(`GET ${SERVICE_ROOT}/LineItems?$top=1`));
  assert.equal(prefixed[0].path, 'LineItems');
  assert.ok(parseBatchRequests('multipart/mixed; boundary=b1', Array(60).fill(part('GET LineItems')).join('') + '--b1--').error);
});

// Splits the recorded file into its $batch bodies: each runs from its first delimiter line to its close delimiter.
function recordedBodies(text) {
  const out = [];
  let rest = text;
  for (let m; (m = /^--(\S+)\r?$/m.exec(rest));) {
    const close = `--${m[1]}--`;
    const end = rest.indexOf(close, m.index);
    if (end < 0) break;
    out.push({ boundary: m[1], body: rest.slice(0, end + close.length) });
    rest = rest.slice(end + close.length);
  }
  return out;
}

test('replays the $batch bodies real UI5 1.148.10 sent', { skip: !existsSync(RECORDED) && 'no recorded fixture' }, async () => {
  const bodies = recordedBodies(readFileSync(RECORDED, 'utf8'));
  assert.ok(bodies.length >= 1);
  const token = await tokenOf('/');
  for (const { boundary, body } of bodies) {
    // UI5 writes "multipart/mixed;boundary=batch_xxxx-xxxx-xxxx" (no space, hyphens in the boundary) and starts the body with CRLF
    const res = await fetch(`${base}${SERVICE_ROOT}/$batch`, {
      method: 'POST', body, headers: { cookie, 'x-csrf-token': token, 'content-type': `multipart/mixed;boundary=${boundary}` },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const parts = await answers(res);
    const requests = parseBatchRequests(`multipart/mixed;boundary=${boundary}`, body);
    assert.equal(parts.length, requests.length);
    requests.forEach((r, k) => {
      if (r.path === 'LineItems/$count') { assert.equal(parts[k].body, String(8)); return; }
      const d = JSON.parse(parts[k].body).d;
      assert.equal(d.results.length, 8);
      assert.deepEqual(d.results.map((x) => x.Document), ['1900000201', '1900000202', '1900000203', '1900000204', '1900000205', '1900000206', '1900000207', '1900000208']);
      for (const x of d.results) assert.equal(x.__metadata.uri, `${SERVICE_ROOT}/LineItems('${x.Document}')`);
    });
  }
});
