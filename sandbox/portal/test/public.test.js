import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startPortal } from '../testing.js';

let portal;
before(async () => { portal = await startPortal(); });
after(async () => { await portal.close(); });
beforeEach(() => { portal.reset(); });

const get = (path, init) => fetch(`${portal.url}${path}`, init);
const html = async (path) => {
  const res = await get(path);
  return { status: res.status, body: await res.text(), res };
};
const counters = async () => (await get('/public/api/counters')).json();
const count = (text, needle) => text.split(needle).length - 1;
/** GET with an explicit Host header (fetch cannot set one): the server sees `localhost:<port>` while we connect to 127.0.0.1. */
const getWithHost = (path, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: portal.port, path, headers: { host } }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});
const postForm = (path, fields) => get(path, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields),
});

test('counters start empty, count hits by pathname (not their own API) and reset', async () => {
  assert.deepEqual(await counters(), { hits: {}, posts: [], collect: 0, css: 0 });
  await get('/public/table');
  await get('/public/table');
  await get('/public/list?page=2');
  const c = await counters();
  assert.deepEqual(c.hits, { '/public/table': 2, '/public/list': 1 });
  const reset = await get('/public/api/counters/reset', { method: 'POST' });
  assert.equal(reset.status, 204);
  assert.deepEqual(await counters(), { hits: {}, posts: [], collect: 0, css: 0 });
});

test('resetState() clears the public counters', async () => {
  await get('/public/table');
  await postForm('/public/form/submit', { name: 'Ada', message: 'Hi' });
  await get('/public/collect', { method: 'POST', body: 'z' });
  assert.notDeepEqual(await counters(), { hits: {}, posts: [], collect: 0, css: 0 });
  portal.reset();
  assert.deepEqual(await counters(), { hits: {}, posts: [], collect: 0, css: 0 });
});

test('/public/table: one results table with a header row and three products', async () => {
  const { status, body } = await html('/public/table');
  assert.equal(status, 200);
  assert.ok(body.includes('<p id="total">Showing 3 results</p>'));
  assert.equal(count(body, '<table class="results">'), 1);
  assert.ok(body.includes('<thead><tr><th>Code</th><th>Product</th><th>Price</th><th>Stock</th></tr></thead>'));
  for (const row of ['<td>SKU-1001</td><td>Widget</td><td>$10.00</td><td>12</td>', '<td>SKU-1002</td><td>Gadget</td><td>$12.50</td><td>0</td>', '<td>SKU-1003</td><td>Gizmo</td><td>$7.25</td><td>5</td>']) {
    assert.ok(body.includes(row), row);
  }
});

test('/public/table-edge and /public/tables-two', async () => {
  const edge = (await html('/public/table-edge')).body;
  assert.ok(edge.includes('<table class="edge"><tr><td>Name</td><td></td><td>Name</td><td>Notes</td></tr>'));
  assert.ok(edge.includes('<tr><td>Alpha</td><td colspan="2">wide</td><td>n1</td></tr>'));
  assert.ok(edge.includes('<tr><td>Beta</td><td>b2</td><td>b3</td><td>b4</td></tr>'));
  assert.ok(!edge.includes('<thead>'));
  assert.equal(count((await html('/public/tables-two')).body, '<table class="results">'), 2);
});

test('/public/list pages 1 and 2: items with title, link, code, price and image', async () => {
  const one = (await html('/public/list?page=1')).body;
  assert.ok(one.includes('<p class="count">Showing 1–3 of 5</p>'));
  assert.equal(count(one, '<li class="item">'), 3);
  assert.ok(one.includes('<li class="item"><a class="title" href="/public/items/SKU-2001" title="Item SKU-2001">Blue mug</a> <span class="code">SKU-2001</span> <span class="price">$4.00</span> <img class="thumb" src="/public/img/SKU-2001.png" alt="Blue mug photo"></li>'));
  assert.ok(one.includes('Red mug') && one.includes('$4.50') && one.includes('Green mug') && one.includes('$5.00'));
  assert.ok(one.includes('<a class="next" href="/public/list?page=2">Next page</a>'));
  assert.equal((await html('/public/list')).body, one);
  const two = (await html('/public/list?page=2')).body;
  assert.ok(two.includes('<p class="count">Showing 4–5 of 5</p>'));
  assert.equal(count(two, '<li class="item">'), 2);
  assert.ok(two.includes('Tea pot') && two.includes('$20.00'));
  assert.ok(two.includes('<span class="code">SKU-2005</span> <img class="thumb" src="/public/img/SKU-2005.png" alt="Saucer photo">'));
  assert.equal(count(two, 'class="price"'), 1);
  assert.ok(!two.includes('class="next"'));
});

test('/public/list-dup has one item with two prices; /public/list-empty says there are none', async () => {
  const dup = (await html('/public/list-dup')).body;
  assert.equal(count(dup, '<li class="item">'), 1);
  assert.equal(count(dup, '<span class="price">'), 2);
  const empty = (await html('/public/list-empty')).body;
  assert.ok(empty.includes('<p>No results found</p><ul class="items"></ul>'));
});

test('/public/list-hidden has one item with a hidden note', async () => {
  const body = (await html('/public/list-hidden')).body;
  assert.match(body, /<span class="note" style="display:none">internal note<\/span>/);
});

test('/public/img/<x>.png is a valid 1x1 PNG', async () => {
  const res = await get('/public/img/SKU-2001.png');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
});

test('/public/form posts back to /public/form/submit, which records the post and echoes HTML-escaped', async () => {
  const page = (await html('/public/form')).body;
  assert.ok(page.includes('<form id="contact" method="post" action="/public/form/submit">'));
  for (const f of ['<label>Name <input name="name"></label>', '<label>Message <textarea name="message"></textarea></label>', '<label>Password <input type="password" name="password"></label>', '<button type="submit">Send</button>']) {
    assert.ok(page.includes(f), f);
  }
  const res = await postForm('/public/form/submit', { name: 'Ada <b>', message: 'Hello', password: 'never-stored' });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('<h1>Thanks</h1><p id="echo">Received from Ada &lt;b&gt;: 5 characters</p>'));
  assert.ok(!body.includes('setTimeout'));
  assert.deepEqual((await counters()).posts, [{ path: '/public/form/submit', name: 'Ada <b>' }]);
});

test('{other} swaps 127.0.0.1 and localhost on the same port, and ?other= overrides it', async () => {
  const viaIp = await getWithHost('/public/form-cross', `127.0.0.1:${portal.port}`);
  assert.ok(viaIp.body.includes(`action="http://localhost:${portal.port}/public/form/submit"`));
  const viaName = await getWithHost('/public/form-cross', `localhost:${portal.port}`);
  assert.ok(viaName.body.includes(`action="http://127.0.0.1:${portal.port}/public/form/submit"`));
  const forced = (await html('/public/form-cross?other=files.example.test:81')).body;
  assert.ok(forced.includes('action="http://files.example.test:81/public/form/submit"'));
});

test('form variants: cross-host formaction, script-submitted, four posts, late post', async () => {
  const formaction = (await html('/public/form-formaction')).body;
  assert.ok(formaction.includes('<form id="contact" method="post" action="/public/form/submit">'));
  assert.ok(formaction.includes(`<button type="submit" formaction="http://localhost:${portal.port}/public/form/submit">Send</button>`));
  const script = (await html('/public/form-script')).body;
  assert.ok(script.includes('<form id="contact">'));
  assert.ok(script.includes("fetch('/public/api/submit', { method: 'POST' })"));
  assert.ok(script.includes("s.id = 'saved'; s.textContent = 'Saved'"));
  const many = (await html('/public/form-many')).body;
  assert.ok(many.includes('for (let i = 0; i < 4; i++)'));
  assert.ok(many.includes("d.textContent = 'Done'"));
  const late = (await html('/public/form-late')).body;
  assert.ok(late.includes('action="/public/form/submit?late=1"'));
  const result = await (await postForm('/public/form/submit?late=1', { name: 'Late', message: 'x' })).text();
  assert.ok(result.includes("setTimeout(() => { fetch('/public/api/submit', { method: 'POST' }); }, 1500);"));
});

test('POST /public/api/submit records the post and answers { ok: true }', async () => {
  const res = await get('/public/api/submit', { method: 'POST', body: 'x' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual((await counters()).posts, [{ path: '/public/api/submit', name: '' }]);
});

test('/public/files links six attachments with real magic bytes, and a POST export', async () => {
  const page = (await html('/public/files')).body;
  for (const [id, file] of [['csv', 'report.csv'], ['zip', 'archive.zip'], ['pdf', 'doc.pdf'], ['json', 'data.json'], ['jpeg', 'photo.jpg'], ['docx', 'letter.docx']]) {
    assert.ok(page.includes(`<a id="${id}" href="/public/files/${file}">`), id);
  }
  assert.ok(page.includes('<form method="post" action="/public/files/export"><button>Export via POST</button></form>'));
  const download = async (file, type) => {
    const res = await get(`/public/files/${file}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${file}"`);
    return Buffer.from(await res.arrayBuffer());
  };
  assert.equal((await download('report.csv', 'text/csv')).toString(), 'code,name\nSKU-1,Widget\n');
  const zip = await download('archive.zip', 'application/zip');
  assert.equal(zip.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.equal(zip.subarray(zip.length - 22, zip.length - 18).toString('latin1'), 'PK\x05\x06');
  assert.equal((await download('doc.pdf', 'application/pdf')).subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal((await download('data.json', 'application/json')).toString(), '{"ok":true}');
  assert.deepEqual([...(await download('photo.jpg', 'image/jpeg')).subarray(0, 3)], [0xff, 0xd8, 0xff]);
  const docx = await download('letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.subarray(0, 4).toString('latin1'), 'PK\x03\x04');
  assert.ok(docx.includes('[Content_Types].xml') && docx.includes('word/'));
  const exported = await get('/public/files/export', { method: 'POST' });
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="export.csv"');
  assert.equal(await exported.text(), 'code,name\nSKU-1,Widget\n');
  assert.equal((await get('/public/files/nope.bin')).status, 404);
});

test('/public/beacon sends to the other host and its own; /public/collect counts every request', async () => {
  const page = (await html('/public/beacon')).body;
  assert.ok(page.includes('<h1>Beacon page</h1>'));
  assert.ok(page.includes(`navigator.sendBeacon('http://localhost:${portal.port}/public/collect', 'x')`));
  assert.ok(page.includes(`fetch('http://localhost:${portal.port}/public/collect', { method: 'POST', body: 'y', keepalive: true, mode: 'no-cors' })`));
  assert.ok(page.includes("fetch('/public/collect', { method: 'POST', body: 'z' })"));
  assert.equal((await get('/public/collect', { method: 'POST', body: 'x' })).status, 204);
  await get('/public/collect');
  assert.equal((await counters()).collect, 2);
});

test('/public/url-text shows a URL with a query string as text', async () => {
  const page = (await html('/public/url-text')).body;
  assert.ok(page.includes('<p>Report: https://reports.example/r/77?token=abc</p>'));
});

test('/public/beacon-third-party sends only a beacon to the other host, then shows #sent', async () => {
  const page = (await html('/public/beacon-third-party')).body;
  assert.ok(page.includes('<h1>Third-party beacon page</h1>'));
  assert.ok(page.includes(`navigator.sendBeacon('http://localhost:${portal.port}/public/collect', 'x')`));
  assert.ok(!page.includes('fetch('));
  assert.ok(page.includes("s.id = 'sent'"));
});

test('/public/styled loads its stylesheet from the other host; /public/style.css counts loads', async () => {
  const page = (await html('/public/styled')).body;
  assert.ok(page.includes(`<link rel="stylesheet" href="http://localhost:${portal.port}/public/style.css">`));
  assert.ok(page.includes('<h1 class="styled">Styled page</h1>'));
  const css = await get('/public/style.css');
  assert.equal(css.headers.get('content-type'), 'text/css');
  assert.equal((await counters()).css, 1);
});

test('status pages answer with their status', async () => {
  for (const [path, status] of [['/public/missing', 404], ['/public/gone', 410], ['/public/error', 500], ['/public/forbidden', 403], ['/public/limited', 429]]) {
    assert.equal((await get(path)).status, status, path);
  }
  assert.ok((await html('/public/forbidden')).body.includes('<h1>Forbidden page</h1>'));
  assert.equal((await get('/public/no-such-page')).status, 404);
});

test('/public/redirect sends a 302 to an absolute URL and refuses anything else', async () => {
  const to = `http://localhost:${portal.port}/public/table`;
  const res = await get(`/public/redirect?to=${encodeURIComponent(to)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), to);
  assert.equal((await get('/public/redirect?to=/public/table', { redirect: 'manual' })).status, 400);
});

test('/public/tall, /public/poll, /public/ping, /public/echo and /public/slow', async () => {
  const tall = (await html('/public/tall')).body;
  assert.ok(tall.includes('html, body { margin: 0; padding: 0; }') && tall.includes('style="height: 20000px"'));
  const poll = (await html('/public/poll')).body;
  assert.ok(poll.includes("setInterval(() => { fetch('/public/ping').catch(() => {}); }, 200);"));
  assert.equal((await get('/public/ping')).status, 204);
  assert.ok((await html('/public/echo?text=%3Cscript%3Ex%3C%2Fscript%3E')).body.includes('<p id="echo">&lt;script&gt;x&lt;/script&gt;</p>'));
  const t0 = Date.now();
  assert.ok((await html('/public/slow?ms=300')).body.includes('<p id="slow">Answered after 300 ms</p>'));
  assert.ok(Date.now() - t0 >= 290);
  assert.ok((await html('/public/slow?ms=abc')).body.includes('Answered after 0 ms'));
});

test('/public/many lists n rows (capped at 20,000); /public/big holds m MiB of text (capped at 8)', async () => {
  const five = (await html('/public/many?n=5')).body;
  assert.equal(count(five, '<li class="item">'), 5);
  assert.ok(five.includes('<li class="item"><span class="code">ROW-1</span></li>') && five.includes('<span class="code">ROW-5</span>'));
  assert.equal(count((await html('/public/many?n=99999')).body, '<li class="item">'), 20_000);
  const one = (await html('/public/big?mb=1')).body;
  const text = one.slice(one.indexOf('<p id="big">') + '<p id="big">'.length, one.indexOf('</p>'));
  assert.equal(text.length, 1024 * 1024);
  assert.ok(text.startsWith('lorem lorem '));
  const capped = (await html('/public/big?mb=99')).body;
  assert.ok(capped.length >= 8 * 1024 * 1024 && capped.length < 8 * 1024 * 1024 + 1000);
});

test('/public/ never sets a cookie, and /acme/ still works', async () => {
  for (const res of [await get('/public/table'), await postForm('/public/form/submit', { name: 'x' }), await get('/public/files/report.csv')]) {
    assert.equal(res.headers.get('set-cookie'), null);
  }
  const login = await get('/acme/login');
  assert.equal(login.status, 200);
});

test('/public/multi is a multi-select with one option preselected', async () => {
  const { status, body } = await html('/public/multi');
  assert.equal(status, 200);
  assert.match(body, /<select id="regions" multiple>/);
  assert.equal(count(body, ' selected>'), 1);
});
