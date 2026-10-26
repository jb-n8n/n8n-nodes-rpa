// A look-alike of an SAP Fiori list report: a launchpad shell plus an app that is rendered client-side,
// reading its rows through a CSRF-token fetch and then an OData $batch POST. No dependencies.
import { createHash, randomBytes } from 'node:crypto';
import { elementId, newSalt, lineItems, layoutCsv, LINE_ITEM_HEADER, lineItemsCsv, exportFileName } from './erp.js';

const SERVICE = '/sap/opu/odata/sap/ZLINEITEMS_SRV/';
const SECRET = randomBytes(16).toString('hex'); // one token per portal session, derived from its cookie
const tokenFor = (req) => {
  const sid = /(?:^|;\s*)sid_acme=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
  return createHash('sha256').update(`${SECRET}:${sid}`).digest('hex').slice(0, 32);
};

const LABELS = {
  baseline: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
  renamed: { tile: 'G/L Line Items', go: 'Apply', xls: 'Download spreadsheet' },
  menu: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
  dialog: { tile: 'Manage Line Items', go: 'Go', xls: 'Export to Spreadsheet' },
};

const FILTER = /^GET LineItems\?\$filter=CompanyCode eq '([A-Za-z0-9]{1,10})' and PostingDate ge datetime'(\d{4}-\d{2}-\d{2})T00:00:00' and PostingDate le datetime'(\d{4}-\d{2}-\d{2})T00:00:00'&\$format=json HTTP\/1\.1$/;

async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e5) throw new Error('body too large'); }
  return data;
}

// Returns the [company, from, to] of the one allowed inner request, or null.
function parseBatch(contentType, body) {
  const boundary = /boundary=("?)([^";\s]+)\1/.exec(contentType || '')?.[2];
  if (!boundary || !/^multipart\/mixed/i.test(contentType)) return null;
  const parts = body.split(`--${boundary}`).map((s) => s.trim()).filter((s) => s && s !== '--');
  if (parts.length !== 1) return null;
  const [head, ...rest] = parts[0].split(/\r?\n\r?\n/);
  if (!/^Content-Type:\s*application\/http/im.test(head)) return null;
  const m = FILTER.exec(rest[0].split(/\r?\n/)[0].trim());
  return m ? m.slice(1) : null;
}

// erp.js's own element-id, CSV and file-name code, shipped to the browser as source: the Fiori export and the web GUI
// export are built by the same functions, so both front ends produce byte-identical files. Keep these erp.js functions
// self-contained (only LINE_ITEM_HEADER from outside) so their source runs on its own.
const ERP_FILES = `window.erpFiles = (function () {
  var LINE_ITEM_HEADER = ${JSON.stringify(LINE_ITEM_HEADER)};
  var elementId = ${elementId.toString()};
  var lineItemsCsv = ${lineItemsCsv.toString()};
  var exportFileName = ${exportFileName.toString()};
  return {
    header: LINE_ITEM_HEADER.split(','),
    elementId: elementId,
    fileName: exportFileName,
    csv: function (results) {
      return lineItemsCsv(results.map(function (r) {
        return { document: r.Document, postingDate: r.PostingDate, company: r.CompanyCode, amount: r.Amount, currency: r.Currency };
      }));
    },
  };
})();`;

function page(st, salt) {
  const L = LABELS[st.erp] || LABELS.baseline;
  const cfg = JSON.stringify({ variant: LABELS[st.erp] ? st.erp : 'baseline', decoy: !!st.erpDecoy, layout: layoutCsv(), L, salt, service: SERVICE });
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fiori launchpad</title>
<style>body{font-family:"72",Arial,sans-serif;margin:0;background:#f5f6f7;color:#32363a}header{background:#354a5f;color:#fff;padding:8px 16px;font-size:14px}
main{padding:16px}.tile{display:inline-block;width:180px;height:100px;padding:12px;background:#fff;border:1px solid #d9d9d9;border-radius:8px;color:#0a6ed1;text-decoration:none}
.bar,.tools{background:#fff;border:1px solid #d9d9d9;padding:10px 14px;margin-bottom:10px}.f{display:inline-block;margin-right:14px}.f label{display:block;font-size:12px;color:#6a6d70}
table{border-collapse:collapse;background:#fff}td,th{border-bottom:1px solid #d9d9d9;padding:6px 12px;text-align:left}th{background:#f2f2f2}
button{padding:5px 12px;margin-right:6px}[role=dialog]{border:2px solid #0a6ed1;background:#fff;padding:10px 14px;margin:8px 0}.err{color:#b00}</style></head>
<body><header>SAP Fiori launchpad</header><main id="app"></main>
<script id="erp-files">${ERP_FILES}</script>
<script>
(function () {
  var C = ${cfg}, L = C.L, F = window.erpFiles, app = document.getElementById('app'), n = 0, token = null, rows = [], read = null;
  // Never reset or wrapped: every element id is unique for the life of the page load.
  function id() { return F.elementId(n++, C.salt); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function field(parent, label, type) {
    var i = id(), w = el('div', { 'class': 'f' }), inp = el('input', { type: type, id: i });
    w.appendChild(el('label', { 'for': i }, label)); w.appendChild(inp); parent.appendChild(w);
    return inp;
  }
  function button(parent, label, onclick) {
    var b = el('button', { type: 'button', id: id() }, label); b.addEventListener('click', onclick); parent.appendChild(b); return b;
  }
  function download(name, text) {
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })) });
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function getToken() {
    if (token) return Promise.resolve(token);
    return fetch(C.service, { method: 'HEAD', headers: { 'x-csrf-token': 'Fetch' }, credentials: 'same-origin' }).then(function (r) {
      token = r.headers.get('x-csrf-token'); if (!r.ok || !token) throw new Error('token'); return token;
    });
  }
  function batch(company, from, to) {
    var b = 'batch_' + Math.random().toString(16).slice(2);
    var body = '--' + b + '\\r\\nContent-Type: application/http\\r\\nContent-Transfer-Encoding: binary\\r\\n\\r\\n' +
      "GET LineItems?$filter=CompanyCode eq '" + company + "' and PostingDate ge datetime'" + from + "T00:00:00' and PostingDate le datetime'" + to +
      "T00:00:00'&$format=json HTTP/1.1\\r\\nAccept: application/json\\r\\n\\r\\n\\r\\n--" + b + '--';
    return getToken().then(function (t) {
      return fetch(C.service + '$batch', { method: 'POST', credentials: 'same-origin', body: body,
        headers: { 'x-csrf-token': t, 'content-type': 'multipart/mixed; boundary=' + b, accept: 'multipart/mixed' } });
    }).then(function (r) { return r.text().then(function (txt) {
      if (!r.ok) throw new Error('read');
      var a = txt.indexOf('{'), z = txt.lastIndexOf('}');
      return JSON.parse(txt.slice(a, z + 1)).d.results;
    }); });
  }
  function exportButtons(tools) {
    var run = function () { download(read.name, F.csv(rows)); };
    if (C.variant === 'menu') {
      var menu = el('div', { hidden: '' });
      button(tools, 'More', function () { menu.hidden = !menu.hidden; });
      button(menu, L.xls, run); tools.appendChild(menu);
    } else if (C.variant === 'dialog') {
      var dlg = null;
      button(tools, L.xls, function () {
        if (dlg) return;
        dlg = el('div', { role: 'dialog', 'aria-label': 'Export As' });
        dlg.appendChild(el('h2', {}, 'Export As'));
        var ri = id(); dlg.appendChild(el('input', { type: 'radio', name: 'fmt', id: ri }));
        dlg.appendChild(el('label', { 'for': ri }, 'Comma-separated (CSV)'));
        dlg.appendChild(el('br'));
        button(dlg, 'Export', function () { if (document.getElementById(ri).checked) { run(); dlg.remove(); dlg = null; } });
        tools.parentNode.insertBefore(dlg, tools.nextSibling);
      });
    } else button(tools, L.xls, run);
    if (C.decoy) button(tools, 'Export layout', function () { download('layout-settings.csv', C.layout); });
  }
  function renderResult(host, rs, msg) {
    host.textContent = '';
    if (msg) { host.appendChild(el('p', { 'class': 'err', role: 'alert' }, msg)); return; }
    var tools = el('div', { 'class': 'tools' }); host.appendChild(tools); exportButtons(tools);
    if (!rs.length) { host.appendChild(el('p', {}, 'No data')); return; }
    var t = el('table', { role: 'grid' }), tr = el('tr'); t.appendChild(el('thead')).appendChild(tr);
    F.header.forEach(function (h) { tr.appendChild(el('th', {}, h)); });
    var tb = t.appendChild(el('tbody'));
    rs.forEach(function (r) {
      var row = el('tr'); tb.appendChild(row);
      [r.Document, r.PostingDate, r.CompanyCode, r.Amount, r.Currency].forEach(function (v) { row.appendChild(el('td', {}, v)); });
    });
    host.appendChild(t);
  }
  function renderApp() {
    app.textContent = ''; rows = []; read = null;
    app.appendChild(el('h1', {}, L.tile));
    var bar = el('div', { 'class': 'bar' }); app.appendChild(bar);
    var co = field(bar, 'Company Code', 'text'), fr = field(bar, 'From', 'date'), to = field(bar, 'To', 'date');
    var out = el('div'); app.appendChild(out);
    button(bar, L.go, function () {
      var company = co.value.trim(), from = fr.value, upto = to.value;
      if (!company || !from || !upto) return renderResult(out, [], 'Fill in Company Code, From and To');
      batch(company, from, upto).then(function (rs) {
        rows = rs; read = { name: F.fileName(company, from, upto) }; renderResult(out, rs);
      }, function () { renderResult(out, [], 'The read failed'); });
    });
  }
  function route() {
    if (location.hash === '#LineItem-manage') return renderApp();
    app.textContent = '';
    var a = el('a', { 'class': 'tile', href: '#LineItem-manage', id: id() }, L.tile); app.appendChild(a);
  }
  window.addEventListener('hashchange', route); route();
})();
</script></body></html>`;
}

const edmx = () => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="2.0">
<Schema Namespace="ZLINEITEMS_SRV" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
<EntityType Name="LineItem"><Key><PropertyRef Name="Document"/></Key><Property Name="Document" Type="Edm.String" Nullable="false"/><Property Name="PostingDate" Type="Edm.String"/><Property Name="CompanyCode" Type="Edm.String"/><Property Name="Amount" Type="Edm.String"/><Property Name="Currency" Type="Edm.String"/></EntityType>
<EntityContainer Name="ZLINEITEMS_SRV_Entities" m:IsDefaultEntityContainer="true"><EntitySet Name="LineItems" EntityType="ZLINEITEMS_SRV.LineItem"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

// Returns true when the request was handled.
export async function fioriRoute(req, res, url, st, send) {
  const p = url.pathname;
  if (p === '/sap/bc/ui2/flp' && req.method === 'GET') {
    return send(res, 200, page(st, newSalt()), { 'Cache-Control': 'no-store' }), true;
  }
  if (p === SERVICE && (req.method === 'HEAD' || req.method === 'GET')) {
    if (req.headers['x-csrf-token'] !== 'Fetch') return send(res, 200, req.method === 'HEAD' ? '' : '{}', { 'Content-Type': 'application/json' }), true;
    return send(res, 200, req.method === 'HEAD' ? '' : '{}', { 'x-csrf-token': tokenFor(req), 'Content-Type': 'application/json' }), true;
  }
  if (p === `${SERVICE}$metadata` && req.method === 'GET') {
    return send(res, 200, edmx(), { 'Content-Type': 'application/xml' }), true;
  }
  if (p === `${SERVICE}$batch` && req.method === 'POST') {
    const body = await readBody(req);
    if (req.headers['x-csrf-token'] !== tokenFor(req)) return send(res, 403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' }), true;
    const q = parseBatch(req.headers['content-type'], body);
    if (!q) return send(res, 400, 'Unsupported batch request'), true;
    const results = lineItems(q[0], q[1], q[2]).map((r) => ({
      Document: r.document, PostingDate: r.postingDate, CompanyCode: r.company, Amount: r.amount, Currency: r.currency,
    }));
    const boundary = `batch_${randomBytes(6).toString('hex')}`;
    const out = `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ d: { results } })}\r\n--${boundary}--`;
    return send(res, 200, out, { 'Content-Type': `multipart/mixed; boundary=${boundary}` }), true;
  }
  return false;
}
