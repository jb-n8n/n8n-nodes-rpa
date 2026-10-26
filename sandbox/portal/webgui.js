// A look-alike of the SAP "classic web GUI" (ITS): every interaction is a POST to the session URL,
// the session ID sits in the path, and element IDs change on every response. No dependencies.
import { randomBytes } from 'node:crypto';
import { elementId, newSalt, lineItems, lineItemsCsv, layoutCsv, exportFileName } from './erp.js';

const BASE = '/bc/gui/sap/its/webgui';
const MAX_CONTEXTS = 200;
const contexts = new Map(); // ctx -> { ctx, token, screen, company, from, to, dialog, message }

export const resetWebgui = () => contexts.clear();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function newContext(screen) {
  const ctx = Buffer.from(`s=SID:ANON:${randomBytes(8).toString('hex')}`).toString('base64url');
  const c = { ctx, token: randomBytes(12).toString('hex'), screen, company: '', from: '', to: '', dialog: false, message: '' };
  contexts.set(ctx, c);
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value);
  return c;
}

async function readForm(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e5) throw new Error('body too large'); }
  return new URLSearchParams(data);
}

const LABELS = {
  baseline: { tile: 'Line Item Report', run: 'Execute', xxl: 'Export' },
  renamed: { tile: 'G/L Line Items', run: 'Run', xxl: 'Download spreadsheet' },
  menu: { tile: 'Line Item Report', run: 'Execute', xxl: 'Export' },
  dialog: { tile: 'Line Item Report', run: 'Execute', xxl: 'Export' },
};

function shell(c, title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;margin:0;background:#dde3ea;color:#1a1a1a}.bar{background:#354a5f;color:#fff;padding:6px 14px;font-size:13px}
main{background:#fff;margin:14px;padding:14px 18px;border:1px solid #b5bfca}h1{font-size:18px;margin:0 0 12px}
label{display:inline-block;min-width:110px}.row{margin:6px 0}.msg{background:#fff4d6;border:1px solid #e0b84a;padding:6px 10px;margin:8px 0}
table{border-collapse:collapse}td,th{border:1px solid #b5bfca;padding:4px 10px;text-align:left}th{background:#eef1f4}
button{padding:4px 12px;margin-right:6px}[role=dialog]{border:2px solid #354a5f;padding:10px 14px;margin:10px 0;background:#f7f9fb}</style></head>
<body><div class="bar">SAP &nbsp;|&nbsp; Classic GUI for HTML</div>
<main><form id="webguiform" method="post" action="/sap(${c.ctx})${BASE}">
<input type="hidden" name="~sec_sesstoken" value="${c.token}">
${inner}</form></main></body></html>`;
}

function renderScreen(c, st) {
  const salt = newSalt();
  let n = 0;
  const id = () => elementId(n++, salt);
  const btn = (okcode, label, extra = '') => { const i = id(); return `<button type="submit" id="${i}" name="~okcode" value="${esc(okcode)}"${extra}>${esc(label)}</button>`; };
  const field = (label, control) => { const i = id(); return `<div class="row"><label for="${i}">${esc(label)}</label>${control(i)}</div>`; };
  const L = LABELS[st.erp] || LABELS.baseline;
  const msg = c.message ? `<div class="msg" role="alert">${esc(c.message)}</div>` : '';
  c.message = '';

  if (c.screen === 'EASY_ACCESS') {
    return shell(c, 'SAP Easy Access', `<h1>SAP Easy Access</h1>${msg}
${field('Command', (i) => `<input type="text" id="${i}" name="~command" autocomplete="off">`)}
<div class="row">${btn('ENTER', 'Enter')}</div>
<h2>Favorites</h2><div class="row">${btn('ZLINEITEMS', L.tile)}</div>`);
  }

  if (c.screen === 'SELECTION') {
    return shell(c, 'Line Item Report', `<h1>Line Item Report</h1>${msg}
${field('Company Code', (i) => `<select id="${i}" name="S_BUKRS">${['1000', '2000'].map((v) => `<option value="${v}"${c.company === v ? ' selected' : ''}>${v}</option>`).join('')}</select>`)}
${field('From', (i) => `<input type="date" id="${i}" name="S_BUDAT-LOW" value="${esc(c.from)}">`)}
${field('To', (i) => `<input type="date" id="${i}" name="S_BUDAT-HIGH" value="${esc(c.to)}">`)}
<div class="row">${btn('ONLI', L.run)}${btn('BACK', 'Back')}</div>`);
  }

  // RESULT
  const rows = lineItems(c.company, c.from, c.to);
  const grid = rows.length
    ? `<table role="grid"><thead><tr><th>Document</th><th>Posting Date</th><th>Company Code</th><th>Amount</th><th>Currency</th></tr></thead><tbody>${
      rows.map((r) => `<tr><td>${r.document}</td><td>${r.postingDate}</td><td>${r.company}</td><td>${r.amount}</td><td>${r.currency}</td></tr>`).join('')}</tbody></table>`
    : '<p>No data found</p>';
  let toolbar;
  if (st.erp === 'menu') {
    const more = id(); const menu = id();
    toolbar = `<button type="button" id="${more}" onclick="var m=document.getElementById('${menu}');m.hidden=!m.hidden">More</button>
<div id="${menu}" hidden>${btn('&XXL', 'Export')}</div>`;
  } else if (st.erp === 'dialog') {
    toolbar = btn('&XXL_DIALOG', 'Export');
  } else {
    toolbar = btn('&XXL', L.xxl);
  }
  if (st.erpDecoy) toolbar += btn('LAYO', 'Export layout');
  let dialog = '';
  if (st.erp === 'dialog' && c.dialog) {
    const r = id();
    dialog = `<div role="dialog" aria-label="Export"><h2>Export</h2>${msg}
<div class="row"><input type="radio" id="${r}" name="FORMAT" value="CSV"><label for="${r}">Comma-separated (CSV)</label></div>
<div class="row">${btn('&XXL', 'Continue')}</div></div>`;
  }
  return shell(c, 'Line Items', `<h1>Line Items: Company Code ${esc(c.company)}, ${esc(c.from)} to ${esc(c.to)}</h1>${dialog ? '' : msg}
<div class="row">${toolbar}${btn('BACK', 'Back')}</div>${dialog}${grid}`);
}

function csvResponse(res, name, body) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Returns true when the request was handled.
export async function webguiRoute(req, res, url, st, send) {
  const p = url.pathname;

  if (p === '/sap/test/redirect' && req.method === 'POST') {
    // Same-origin paths only: a single / then a path character (never //host, /\host, or a control character or space anywhere, which browsers read as another host).
    const to = url.searchParams.get('to') || '';
    if (!/^\/[^/\\\x00-\x20\x7f]/.test(to) || /[\x00-\x20\x7f]/.test(to)) return send(res, 400, 'bad target'), true;
    return send(res, 307, '', { Location: to }), true;
  }
  if (p === '/sap/test/redirect-form' && req.method === 'GET') {
    const to = url.searchParams.get('to') || '/';
    return send(res, 200, `<!doctype html><html><body><form method="post" action="/sap/test/redirect?to=${encodeURIComponent(to)}">
<button type="submit" id="send">Send</button></form></body></html>`), true;
  }

  if (p === `/sap${BASE}` && req.method === 'GET') {
    const c = newContext(url.searchParams.get('~transaction') === 'ZLINEITEMS' ? 'SELECTION' : 'EASY_ACCESS');
    return send(res, 302, '', { Location: `/sap(${c.ctx})${BASE}` }), true;
  }

  const m = /^\/sap\(([^)/]*)\)\/bc\/gui\/sap\/its\/webgui$/.exec(p);
  if (!m) return false;
  const c = contexts.get(m[1]);
  if (req.method === 'GET') {
    if (!c) return send(res, 200, endedPage()), true;
    return send(res, 200, renderScreen(c, st)), true;
  }
  if (req.method !== 'POST') return false;

  const f = await readForm(req);
  if (!c) return send(res, 200, endedPage()), true;
  if (f.get('~sec_sesstoken') !== c.token) return send(res, 403, 'Invalid session token'), true;

  const okcode = f.get('~okcode') || '';
  if (c.screen === 'EASY_ACCESS') {
    const cmd = (f.get('~command') || '').trim();
    if (okcode === 'ZLINEITEMS' || (okcode === 'ENTER' && (cmd === 'ZLINEITEMS' || cmd === '/nZLINEITEMS'))) c.screen = 'SELECTION';
    else if (okcode === 'ENTER') c.message = 'Transaction does not exist';
  } else if (c.screen === 'SELECTION') {
    if (okcode === 'BACK') c.screen = 'EASY_ACCESS';
    else if (okcode === 'ONLI') {
      const company = f.get('S_BUKRS') || '', from = f.get('S_BUDAT-LOW') || '', to = f.get('S_BUDAT-HIGH') || '';
      c.company = company; c.from = from; c.to = to;
      if (!company || !from || !to) c.message = 'Fill in all required entry fields';
      else { c.screen = 'RESULT'; c.dialog = false; }
    }
  } else if (c.screen === 'RESULT') {
    if (okcode === 'BACK') { c.screen = 'SELECTION'; c.dialog = false; }
    else if (okcode === '&XXL_DIALOG' && st.erp === 'dialog') c.dialog = true;
    else if (okcode === '&XXL') {
      if (st.erp === 'dialog' && f.get('FORMAT') !== 'CSV') { c.dialog = true; c.message = 'Choose a format'; }
      else { c.dialog = false; return csvResponse(res, exportFileName(c.company, c.from, c.to), lineItemsCsv(lineItems(c.company, c.from, c.to))), true; }
    } else if (okcode === 'LAYO') return csvResponse(res, 'layout-settings.csv', layoutCsv()), true;
  }
  return send(res, 200, renderScreen(c, st)), true;
}

const endedPage = () => `<!doctype html><html><body><h1>Your session has ended</h1>
<p><a href="/sap${BASE}">Start again</a></p></body></html>`;
