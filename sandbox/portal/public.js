// Public fixture pages for the generic RPA node: tables, lists, forms, files, beacons, styled
// pages, status pages and size fixtures under /public/. Session-free: nothing here reads or sets a cookie, and
// nothing here touches the /acme/ portal or its state. publicCounters records what reached the server, so a test can
// check that a blocked request never left the browser. No dependencies.

import { crc32 } from 'node:zlib';

export const publicCounters = { hits: {}, posts: [], collect: 0, css: 0 };

export function resetPublic() {
  publicCounters.hits = {};
  publicCounters.posts = [];
  publicCounters.collect = 0;
  publicCounters.css = 0;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

/** Every HTML page goes through here. */
function publicPage(title, body, script) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

async function readForm(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e5) throw new Error('body too large');
  }
  return new URLSearchParams(data);
}

/** The "second site": the request's Host with 127.0.0.1 and localhost swapped, or ?other=<host>. */
function otherHost(req, url) {
  const override = url.searchParams.get('other');
  if (override) return override;
  const host = req.headers.host ?? '';
  if (host.startsWith('127.0.0.1')) return `localhost${host.slice('127.0.0.1'.length)}`;
  if (host.startsWith('localhost')) return `127.0.0.1${host.slice('localhost'.length)}`;
  return host;
}

const int = (raw, fallback) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// ---- binary fixtures (real magic bytes) ----
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// SOI, a JFIF APP0 segment, EOI.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const PDF = Buffer.from([
  '%PDF-1.4',
  '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
  '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
  '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]>> endobj',
  'trailer <</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n'));

/** A ZIP archive with stored (uncompressed) entries, so entry names are visible in the first bytes. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILES = {
  'report.csv': { type: 'text/csv', body: Buffer.from('code,name\nSKU-1,Widget\n') },
  'archive.zip': { type: 'application/zip', body: storedZip([['readme.txt', 'Fixture archive.\n']]) },
  'doc.pdf': { type: 'application/pdf', body: PDF },
  'data.json': { type: 'application/json', body: Buffer.from('{"ok":true}') },
  'photo.jpg': { type: 'image/jpeg', body: JPEG },
  'letter.docx': {
    type: DOCX_MIME,
    body: storedZip([
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
      ['word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'],
    ]),
  },
};
const attachment = (res, name, type, body) =>
  send(res, 200, body, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });

// ---- page bodies ----
const TABLE = `<p id="total">Showing 3 results</p><table class="results"><thead><tr><th>Code</th><th>Product</th><th>Price</th><th>Stock</th></tr></thead><tbody>`
  + [['SKU-1001', 'Widget', '$10.00', '12'], ['SKU-1002', 'Gadget', '$12.50', '0'], ['SKU-1003', 'Gizmo', '$7.25', '5']]
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
  + '</tbody></table>';
const TABLE_EDGE = '<table class="edge"><tr><td>Name</td><td></td><td>Name</td><td>Notes</td></tr>'
  + '<tr><td>Alpha</td><td colspan="2">wide</td><td>n1</td></tr>'
  + '<tr><td>Beta</td><td>b2</td><td>b3</td><td>b4</td></tr></table>';
const ITEMS = [
  { code: 'SKU-2001', name: 'Blue mug', price: '$4.00' },
  { code: 'SKU-2002', name: 'Red mug', price: '$4.50' },
  { code: 'SKU-2003', name: 'Green mug', price: '$5.00' },
  { code: 'SKU-2004', name: 'Tea pot', price: '$20.00' },
  { code: 'SKU-2005', name: 'Saucer' },
];
const item = (it) => `<li class="item"><a class="title" href="/public/items/${it.code}" title="Item ${it.code}">${it.name}</a> <span class="code">${it.code}</span>`
  + `${it.price ? ` <span class="price">${it.price}</span>` : ''} <img class="thumb" src="/public/img/${it.code}.png" alt="${it.name} photo"></li>`;
const FORM_FIELDS = '<label>Name <input name="name"></label> <label>Message <textarea name="message"></textarea></label> '
  + '<label>Password <input type="password" name="password"></label> <button type="submit">Send</button>';
const form = (attrs, button = '') => `<h1>Contact</h1><form id="contact"${attrs}>${button ? FORM_FIELDS.replace('<button type="submit">Send</button>', button) : FORM_FIELDS}</form>`;
const STATUS = {
  '/public/missing': [404, 'Missing page'],
  '/public/gone': [410, 'Gone page'],
  '/public/error': [500, 'Error page'],
  '/public/forbidden': [403, 'Forbidden page'],
  '/public/limited': [429, 'Too many requests'],
};

/** Handles every path under /public/. */
export async function publicRoute(req, res, url) {
  const p = url.pathname;
  const other = esc(otherHost(req, url));
  if (p !== '/public/api/counters' && p !== '/public/api/counters/reset') publicCounters.hits[p] = (publicCounters.hits[p] ?? 0) + 1;

  if (p === '/public/api/counters' && req.method === 'GET') return json(res, 200, publicCounters);
  if (p === '/public/api/counters/reset' && req.method === 'POST') {
    resetPublic();
    return send(res, 204, '');
  }
  if (p === '/public/table') return send(res, 200, publicPage('Products', TABLE));
  if (p === '/public/table-edge') return send(res, 200, publicPage('Edge table', TABLE_EDGE));
  if (p === '/public/tables-two') return send(res, 200, publicPage('Two tables', `${TABLE}${TABLE}`));
  if (p === '/public/list') {
    const page2 = url.searchParams.get('page') === '2';
    const shown = page2 ? ITEMS.slice(3) : ITEMS.slice(0, 3);
    const count = page2 ? 'Showing 4–5 of 5' : 'Showing 1–3 of 5';
    const next = page2 ? '' : '<a class="next" href="/public/list?page=2">Next page</a>';
    return send(res, 200, publicPage('Items', `<p class="count">${count}</p><ul class="items">${shown.map(item).join('')}</ul>${next}`));
  }
  if (p === '/public/list-dup') {
    const dup = '<ul class="items"><li class="item"><a class="title" href="/public/items/SKU-2101" title="Item SKU-2101">Dup mug</a> '
      + '<span class="code">SKU-2101</span> <span class="price">$1.00</span> <span class="price">$2.00</span></li></ul>';
    return send(res, 200, publicPage('Duplicate fields', dup));
  }
  if (p === '/public/list-hidden') {
    const hidden = '<ul class="items"><li class="item"><a class="title" href="/public/items/SKU-2201">Hidden mug</a> '
      + '<span class="note" style="display:none">internal note</span></li></ul>';
    return send(res, 200, publicPage('Hidden field', hidden));
  }
  if (p === '/public/list-empty') return send(res, 200, publicPage('No items', '<p>No results found</p><ul class="items"></ul>'));
  if (/^\/public\/img\/[^/]+\.png$/.test(p)) return send(res, 200, PNG_1X1, { 'Content-Type': 'image/png' });

  if (p === '/public/form') return send(res, 200, publicPage('Contact', form(' method="post" action="/public/form/submit"')));
  if (p === '/public/form-cross') return send(res, 200, publicPage('Contact', form(` method="post" action="http://${other}/public/form/submit"`)));
  if (p === '/public/form-formaction') {
    const button = `<button type="submit" formaction="http://${other}/public/form/submit">Send</button>`;
    return send(res, 200, publicPage('Contact', form(' method="post" action="/public/form/submit"', button)));
  }
  if (p === '/public/form-script') {
    const script = "document.getElementById('contact').addEventListener('submit', async (e) => { e.preventDefault(); "
      + "await fetch('/public/api/submit', { method: 'POST' }); const s = document.createElement('p'); s.id = 'saved'; s.textContent = 'Saved'; document.body.append(s); });";
    return send(res, 200, publicPage('Contact', form(''), script));
  }
  if (p === '/public/form-many') {
    const script = "document.getElementById('contact').addEventListener('submit', async (e) => { e.preventDefault(); "
      + "for (let i = 0; i < 4; i++) { try { await fetch('/public/api/submit', { method: 'POST' }); } catch {} } "
      + "const d = document.createElement('p'); d.id = 'done'; d.textContent = 'Done'; document.body.append(d); });";
    return send(res, 200, publicPage('Contact', form(''), script));
  }
  if (p === '/public/form-late') return send(res, 200, publicPage('Contact', form(' method="post" action="/public/form/submit?late=1"')));
  if (p === '/public/form/submit' && req.method === 'POST') {
    const f = await readForm(req);
    const name = f.get('name') ?? '';
    const message = f.get('message') ?? '';
    publicCounters.posts.push({ path: p, name });
    const late = url.searchParams.get('late') === '1' ? "setTimeout(() => { fetch('/public/api/submit', { method: 'POST' }); }, 1500);" : undefined;
    return send(res, 200, publicPage('Thanks', `<h1>Thanks</h1><p id="echo">Received from ${esc(name)}: ${message.length} characters</p>`, late));
  }
  if (p === '/public/api/submit' && req.method === 'POST') {
    for await (const _chunk of req) { /* drain */ }
    publicCounters.posts.push({ path: p, name: '' });
    return json(res, 200, { ok: true });
  }

  if (p === '/public/files') {
    const links = [['csv', 'report.csv'], ['zip', 'archive.zip'], ['pdf', 'doc.pdf'], ['json', 'data.json'], ['jpeg', 'photo.jpg'], ['docx', 'letter.docx']]
      .map(([id, file]) => `<li><a id="${id}" href="/public/files/${file}">${file}</a></li>`).join('');
    return send(res, 200, publicPage('Files', `<h1>Files</h1><ul>${links}</ul><form method="post" action="/public/files/export"><button>Export via POST</button></form>`));
  }
  if (p === '/public/files/export' && req.method === 'POST') {
    for await (const _chunk of req) { /* drain */ }
    return attachment(res, 'export.csv', 'text/csv', Buffer.from('code,name\nSKU-1,Widget\n'));
  }
  const file = /^\/public\/files\/([^/]+)$/.exec(p)?.[1];
  if (file && Object.hasOwn(FILES, file)) return attachment(res, file, FILES[file].type, FILES[file].body);

  if (p === '/public/beacon') {
    const script = `navigator.sendBeacon('http://${other}/public/collect', 'x'); `
      + `fetch('http://${other}/public/collect', { method: 'POST', body: 'y', keepalive: true, mode: 'no-cors' }).catch(() => {}); `
      + "fetch('/public/collect', { method: 'POST', body: 'z' }).catch(() => {});";
    return send(res, 200, publicPage('Beacon page', '<h1>Beacon page</h1>', script));
  }
  if (p === '/public/url-text') {
    // Visible text that is a URL with a credential-like query string (an ID Pattern can pick it up as a row ID).
    return send(res, 200, publicPage('URL text', '<main><p>Report: https://reports.example/r/77?token=abc</p></main>'));
  }
  if (p === '/public/beacon-third-party') {
    // Only a third-party analytics beacon; #sent appears once it has had time to reach the browser's network layer.
    const script = `navigator.sendBeacon('http://${other}/public/collect', 'x'); `
      + "setTimeout(() => { const s = document.createElement('p'); s.id = 'sent'; s.textContent = 'sent'; document.body.append(s); }, 500);";
    return send(res, 200, publicPage('Third-party beacon page', '<h1>Third-party beacon page</h1>', script));
  }
  if (p === '/public/collect') {
    for await (const _chunk of req) { /* drain */ }
    publicCounters.collect++;
    return send(res, 204, '');
  }
  if (p === '/public/styled') {
    return send(res, 200, publicPage('Styled page', `<link rel="stylesheet" href="http://${other}/public/style.css"><h1 class="styled">Styled page</h1>`));
  }
  if (p === '/public/style.css') {
    publicCounters.css++;
    return send(res, 200, 'h1.styled { color: rgb(200, 0, 0); }', { 'Content-Type': 'text/css' });
  }

  if (STATUS[p]) {
    const [status, heading] = STATUS[p];
    return send(res, status, publicPage(heading, `<h1>${heading}</h1>`));
  }
  if (p === '/public/redirect') {
    const to = url.searchParams.get('to') ?? '';
    if (!/^https?:\/\//i.test(to)) return send(res, 400, publicPage('Bad redirect', '<h1>to must be an absolute http(s) URL</h1>'));
    return send(res, 302, '', { Location: to });
  }
  if (p === '/public/tall') {
    return send(res, 200, publicPage('Tall page', '<style>html, body { margin: 0; padding: 0; }</style><div id="tall" style="height: 20000px">Tall page</div>'));
  }
  if (p === '/public/poll') {
    return send(res, 200, publicPage('Polling page', '<h1>Polling page</h1>', "setInterval(() => { fetch('/public/ping').catch(() => {}); }, 200);"));
  }
  if (p === '/public/ping') return send(res, 204, '');
  if (p === '/public/echo') return send(res, 200, publicPage('Echo', `<p id="echo">${esc(url.searchParams.get('text') ?? '')}</p>`));
  if (p === '/public/slow') {
    const ms = Math.min(int(url.searchParams.get('ms'), 0), 10_000);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return send(res, 200, publicPage('Slow page', `<p id="slow">Answered after ${ms} ms</p>`));
  }
  if (p === '/public/many') {
    const n = Math.min(int(url.searchParams.get('n'), 0), 20_000);
    const rows = Array.from({ length: n }, (_, i) => `<li class="item"><span class="code">ROW-${i + 1}</span></li>`).join('');
    return send(res, 200, publicPage('Many items', `<ul class="items">${rows}</ul>`));
  }
  if (p === '/public/big') {
    const bytes = Math.min(int(url.searchParams.get('mb'), 1), 8) * 1024 * 1024;
    const text = 'lorem '.repeat(Math.ceil(bytes / 6)).slice(0, bytes);
    return send(res, 200, publicPage('Big page', `<p id="big">${text}</p>`));
  }
  return send(res, 404, publicPage('Not found', '<h1>Not found</h1>'));
}
