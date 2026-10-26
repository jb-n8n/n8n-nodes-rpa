// The realistic SAP "classic GUI for HTML": menu bar, standard toolbar, title, application toolbar, status bar,
// SIDs in lsdata, ids in the form M0:46:<salt>::<row>:<col> that change on every response, text dates (DD.MM.YYYY),
// an ALV grid and the "Select Spreadsheet" popup. Session contexts mirror webgui.js. No dependencies.
import { randomBytes } from 'node:crypto';
import { lineItems, newSalt } from './erp.js';
import { xlsxBytes, XLSX_MIME } from './xlsx.js';
import { sapSession } from './sap-logon.js';

const BASE = '/bc/gui/sap/its/webgui';
const MAX_CONTEXTS = 200;
const contexts = new Map(); // ctx -> { ctx, token, screen, company, from, to, dialog, format, message }

export const resetWebguiReal = () => contexts.clear();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function newContext(screen) {
  const ctx = Buffer.from(`s=SID:ANON:${randomBytes(8).toString('hex')}`).toString('base64url');
  const c = { ctx, token: randomBytes(12).toString('hex'), screen, company: '', from: '', to: '', dialog: false, format: 'XLSX', message: null };
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
  baseline: { tile: 'Line Item Report', run: 'Execute (F8)', xxl: 'Spreadsheet... (Ctrl+Shift+F7)' },
  renamed: { tile: 'G/L Line Items', run: 'Run (F8)', xxl: 'Export to Spreadsheet' },
  menu: { tile: 'Line Item Report', run: 'Execute (F8)', xxl: null },
  dialog: { tile: 'Line Item Report', run: 'Execute (F8)', xxl: 'Spreadsheet... (Ctrl+Shift+F7)' },
};

const HEADER = ['Document No.', 'Posting Date', 'Company Code', 'Amount', 'Currency'];
const toSap = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
// DD.MM.YYYY -> ISO, or null when it is not a real date.
function toIso(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[1] ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const tableRows = (c) => lineItems(c.company, toIso(c.from), toIso(c.to)).map((r) => [r.document, toSap(r.postingDate), r.company, r.amount, r.currency]);

const CSS = `body{font-family:Arial,sans-serif;font-size:13px;margin:0;background:#e8edf2;color:#1a1a1a}
.mbar{background:#dce3ea;border-bottom:1px solid #98a5b3;padding:2px 6px;display:flex;gap:2px;position:relative}
.mbar .item{position:relative}.mbar button{background:none;border:1px solid transparent;padding:3px 9px;font-size:13px;cursor:pointer}
.mbar button:hover{background:#fff;border-color:#98a5b3}.pop{position:absolute;top:100%;left:0;background:#fff;border:1px solid #98a5b3;min-width:170px;z-index:5;padding:2px 0}
.pop[hidden]{display:none}.pop button{display:block;width:100%;text-align:left}
.tbar{background:#eef2f6;border-bottom:1px solid #98a5b3;padding:4px 6px;display:flex;gap:6px;align-items:center}
.tbar input[type=text]{width:240px;padding:2px 4px}.tbar button,.app button{padding:3px 12px}
.title{margin:0;padding:8px 12px 4px;font-size:18px;font-weight:normal;background:#fff}
.app{background:#fff;padding:2px 12px 6px;border-bottom:1px solid #c5ced8;display:flex;gap:6px}
.usr{background:#fff;margin:0;padding:10px 12px 20px;min-height:260px}.row{margin:6px 0}.lbl{display:inline-block;min-width:110px}
.usr label.in{display:inline-block;min-width:40px;margin:0 4px 0 12px}table{border-collapse:collapse}td,th{border:1px solid #c5ced8;padding:3px 10px;text-align:left}th{background:#e6ecf2}td.num{text-align:right}
.sbar{background:#f3f5f8;border-top:1px solid #98a5b3;padding:4px 10px;min-height:18px}.sbar .ico{display:inline-block;width:16px;height:16px;line-height:16px;text-align:center;color:#fff;font-weight:bold;margin-right:8px}
.sbar .E{background:#bb0000}.sbar .W{background:#e9730c}.sbar .S{background:#107e3e}
[role=dialog]{position:fixed;top:120px;left:50%;margin-left:-200px;width:400px;background:#fff;border:2px solid #354a5f;box-shadow:0 4px 18px #0006;z-index:10}
[role=dialog] h2{margin:0;padding:6px 10px;font-size:14px;background:#354a5f;color:#fff}[role=dialog] .body{padding:10px 14px}[role=dialog] .btns{padding:8px 14px;text-align:right;background:#eef2f6}`;

function render(c, st) {
  const salt = newSalt();
  let n = 0;
  const at = (sid, ct, col = 0) => `id="M0:46:${salt}::${n++}:${col}" lsdata="${esc(sid)}" ct="${ct}"`;
  const L = LABELS[st.erp] || LABELS.baseline;
  const btn = (sid, okcode, label, col = 0, title = label) =>
    `<button type="submit" ${at(sid, 'B', col)} name="~okcode" value="${esc(okcode)}" title="${esc(title)}">${esc(label)}</button>`;
  const field = (label, name, sid, value, kind = 'text') => {
    const html = (i) => `<input type="text" ${i} name="${name}" value="${esc(value)}" title="${esc(label)}" autocomplete="off"${kind === 'date' ? ' placeholder="DD.MM.YYYY"' : ''}>`;
    const attrs = at(sid, 'I');
    const id = /id="([^"]+)"/.exec(attrs)[1];
    return { id, html: html(attrs) };
  };

  const sbar = () => {
    const m = c.message;
    c.message = null;
    const body = m ? `<span class="ico ${m.type}" ct="I" title="${{ E: 'Error', W: 'Warning', S: 'Success' }[m.type]}">${m.type}</span><span>${esc(m.text)}</span>` : '';
    return `<div class="sbar" role="status" ${at('wnd[0]/sbar', 'ST')}>${body}</div>`;
  };

  const inResult = c.screen === 'RESULT';
  const title = { EASY_ACCESS: 'SAP Easy Access', SELECTION: 'Line Item Report', RESULT: `Line Item Report: Company Code ${c.company}, ${c.from} - ${c.to}` }[c.screen];

  // Menu bar. On the list screen "List" comes first; its Export submenu holds Spreadsheet... (&XXL).
  const plain = ['Menu', 'Edit', 'Favorites', 'Extras', 'System', 'Help'].map((m, i) =>
    `<div class="item"><button type="button" role="menuitem" ${at(`wnd[0]/mbar/menu[${i + 1}]`, 'B', i + 1)} title="${m}">${m}</button></div>`).join('');
  const toggle = (id) => `onclick="var m=document.getElementById('${id}');m.hidden=!m.hidden"`;
  let listMenu = '';
  if (inResult) {
    const pop = `P${salt}a`, sub = `P${salt}b`;
    listMenu = `<div class="item"><button type="button" role="menuitem" ${at('wnd[0]/mbar/menu[0]', 'B')} title="List" ${toggle(pop)}>List</button>
<div class="pop" id="${pop}" hidden role="menu"><div class="item"><button type="button" role="menuitem" ${at('wnd[0]/mbar/menu[0]/menu[0]', 'B')} title="Export" ${toggle(sub)}>Export</button>
<div class="pop" id="${sub}" hidden style="left:100%;top:0" role="menu"><button type="submit" role="menuitem" ${at('wnd[0]/mbar/menu[0]/menu[0]/menu[0]', 'B')} name="~okcode" value="&amp;XXL" title="Spreadsheet...">Spreadsheet...</button></div></div></div></div>`;
  }
  const menubar = `<div class="mbar" role="menubar" ${at('wnd[0]/mbar', 'B')}>${listMenu}${plain}</div>`;

  const stdbar = `<div class="tbar" role="toolbar" ${at('wnd[0]/tbar[0]', 'B')}>
<input type="text" ${at('wnd[0]/tbar[0]/okcd', 'I')} name="~command" title="Enter transaction code" autocomplete="off">
${btn('wnd[0]/tbar[0]/btn[0]', 'ENTER', 'Enter', 1)}${btn('wnd[0]/tbar[0]/btn[3]', 'BACK', 'Back (F3)', 2)}${btn('wnd[0]/tbar[0]/btn[15]', 'EXIT', 'Exit (Shift+F3)', 3)}${btn('wnd[0]/tbar[0]/btn[12]', 'CANC', 'Cancel (F12)', 4)}</div>`;

  let app = '', usr = '';
  if (c.screen === 'EASY_ACCESS') {
    usr = `<div class="row"><b>Favorites</b></div><ul style="list-style:none;padding-left:16px"><li ${at('wnd[0]/usr/cntlIMAGE_CONTAINER/shellcont/shell/shellcont[0]/shell', 'ST')}>${btn('wnd[0]/usr/cntlIMAGE_CONTAINER/shellcont/shell/shellcont[0]/shell/node[1]', 'ZLINEITEMS', L.tile, 1)}</li></ul>`;
  } else if (c.screen === 'SELECTION') {
    app = `<div class="app" role="toolbar" ${at('wnd[0]/tbar[1]', 'B')}>${btn('wnd[0]/tbar[1]/btn[8]', 'ONLI', L.run, 1)}</div>`;
    const bukrs = field('Company Code', 'S_BUKRS-LOW', 'wnd[0]/usr/ctxtS_BUKRS-LOW', c.company);
    const low = field('From', 'S_BUDAT-LOW', 'wnd[0]/usr/ctxtS_BUDAT-LOW', c.from, 'date');
    const high = field('To', 'S_BUDAT-HIGH', 'wnd[0]/usr/ctxtS_BUDAT-HIGH', c.to, 'date');
    usr = `<div class="row"><label class="lbl" for="${bukrs.id}">Company Code</label>${bukrs.html}</div>
<div class="row"><span class="lbl">Posting Date</span><label class="in" for="${low.id}">From</label>${low.html}<label class="in" for="${high.id}">To</label>${high.html}</div>`;
  } else {
    let extra = '';
    if (L.xxl) extra += btn('wnd[0]/usr/cntlGRID1/shellcont/shell/tbar/btn[XXL]', '&XXL', L.xxl, 1);
    if (st.erpDecoy) extra += btn('wnd[0]/usr/cntlGRID1/shellcont/shell/tbar/btn[LAYO]', 'LAYO', 'Layout...', 2);
    const rows = tableRows(c);
    const grid = rows.length
      ? `<table role="grid" ${at('wnd[0]/usr/cntlGRID1/shellcont/shell', 'ST')} title="Line Item Report"><thead><tr>${HEADER.map((h, j) => `<th ${at(`wnd[0]/usr/cntlGRID1/shellcont/shell/col[${j}]`, 'C', j)}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r, i) => `<tr>${r.map((v, j) => `<td ${at(`wnd[0]/usr/cntlGRID1/shellcont/shell/cell[${i},${j}]`, 'C', j)}${j === 3 ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : '';
    if (!rows.length && !c.message) c.message = { type: 'S', text: 'No data found' };
    usr = `<div class="row" role="toolbar" ${at('wnd[0]/usr/cntlGRID1/shellcont/shell/tbar', 'B')}>${extra}</div>${grid}`;
  }

  let dialog = '';
  if (c.dialog) {
    const radio = (value, label) => {
      const a = at(`wnd[1]/usr/rad${value}`, 'RB');
      const id = /id="([^"]+)"/.exec(a)[1];
      return `<div class="row"><input type="radio" ${a} name="FORMAT" value="${value}" title="${esc(label)}"${c.format === value ? ' checked' : ''}><label for="${id}">${esc(label)}</label></div>`;
    };
    dialog = `<div role="dialog" aria-modal="true" aria-label="Select Spreadsheet" ${at('wnd[1]', 'B')}><h2>Select Spreadsheet</h2>
<div class="body">${radio('XLSX', 'Excel (in Office 2007 XLSX Format)')}${radio('TXT', 'Unconverted')}</div>
<div class="btns">${btn('wnd[1]/tbar[0]/btn[0]', 'ENTER', 'Continue (Enter)', 1)} ${btn('wnd[1]/tbar[0]/btn[12]', 'CANC', 'Cancel (F12)', 2)}</div></div>`;
  }
  const page = `${menubar}${stdbar}<h1 class="title" ${at('wnd[0]/titl', 'B')}>${esc(title)}</h1>${app}<div class="usr" ${at('wnd[0]/usr', 'B')}>${usr}</div>${sbar()}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><form id="wnd0" method="post" action="/sap(${c.ctx})${BASE}">
<input type="hidden" name="~sec_sesstoken" value="${c.token}">
<input type="submit" name="~okcode" value="ENTER" style="display:none" tabindex="-1" aria-hidden="true">
<div${c.dialog ? ' inert' : ''}>${page}</div>${dialog}</form>
<script>document.addEventListener('click',function(e){if(!e.target.closest('.mbar'))document.querySelectorAll('.pop').forEach(function(p){p.hidden=true})})</script></body></html>`;
}

function download(res, name, mime, body) {
  res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(body);
}

const endedPage = () => `<!doctype html><html><body><h1>Your session has ended</h1>
<p><a href="/sap${BASE}">Start again</a></p></body></html>`;

// Returns true when the request was handled.
export async function webguiRealRoute(req, res, url, st, send) {
  const p = url.pathname;
  if (p === `/sap${BASE}` && req.method === 'GET') {
    if (!sapSession(req)) return send(res, 401, 'Logon required'), true;
    const c = newContext(url.searchParams.get('~transaction') === 'ZLINEITEMS' ? 'SELECTION' : 'EASY_ACCESS');
    return send(res, 302, '', { Location: `/sap(${c.ctx})${BASE}` }), true;
  }

  const m = /^\/sap\(([^)/]*)\)\/bc\/gui\/sap\/its\/webgui$/.exec(p);
  if (!m) return false;
  if (!sapSession(req)) return send(res, 401, 'Logon required'), true;
  const c = contexts.get(m[1]);
  if (req.method === 'GET') {
    if (!c) return send(res, 200, endedPage()), true;
    return send(res, 200, render(c, st)), true;
  }
  if (req.method !== 'POST') return false;

  const f = await readForm(req);
  if (!c) return send(res, 200, endedPage()), true;
  if (f.get('~sec_sesstoken') !== c.token) return send(res, 403, 'Invalid session token'), true;

  const okcode = f.get('~okcode') || '';
  const cmd = (f.get('~command') || '').trim();
  const goto = (screen) => { c.screen = screen; c.dialog = false; };

  if (c.screen === 'SELECTION') {
    if (f.has('S_BUKRS-LOW')) { c.company = (f.get('S_BUKRS-LOW') || '').trim(); c.from = (f.get('S_BUDAT-LOW') || '').trim(); c.to = (f.get('S_BUDAT-HIGH') || '').trim(); }
  }
  if (c.dialog) {
    if (okcode === 'ENTER') {
      const format = f.get('FORMAT') || c.format;
      c.format = format;
      const rows = tableRows(c);
      c.dialog = false;
      if (format === 'TXT') return download(res, 'export.txt', 'text/plain; charset=utf-8', [HEADER, ...rows].map((r) => r.join('\t')).join('\n')), true;
      return download(res, 'export.XLSX', XLSX_MIME, xlsxBytes([HEADER, ...rows], 'Sheet1')), true;
    }
    if (okcode === 'CANC' || okcode === 'BACK') c.dialog = false;
    return send(res, 200, render(c, st)), true;
  }

  if (okcode === 'ENTER' && cmd) {
    const t = cmd.toUpperCase();
    if (t === '/N') goto('EASY_ACCESS');
    else if (t === 'ZLINEITEMS' || t === '/NZLINEITEMS') goto('SELECTION');
    else c.message = { type: 'E', text: `Transaction ${cmd} does not exist` };
  } else if (okcode === 'ZLINEITEMS' && c.screen === 'EASY_ACCESS') goto('SELECTION');
  else if (okcode === 'EXIT') goto('EASY_ACCESS');
  else if (okcode === 'BACK' || okcode === 'CANC') {
    if (c.screen === 'RESULT') goto('SELECTION'); else if (c.screen === 'SELECTION') goto('EASY_ACCESS');
  } else if (okcode === 'ONLI' && c.screen === 'SELECTION') {
    if (!c.company || !c.from || !c.to) c.message = { type: 'E', text: 'Fill in all required entry fields' };
    else if (!toIso(c.from) || !toIso(c.to)) c.message = { type: 'E', text: 'Invalid date format. Please enter the date in the format __.__.____' };
    else goto('RESULT');
  } else if (c.screen === 'RESULT') {
    if (okcode === '&XXL') { c.dialog = true; c.format = st.erp === 'dialog' ? 'TXT' : 'XLSX'; }
    else if (okcode === 'LAYO' && st.erpDecoy) {
      return download(res, 'layout.XLSX', XLSX_MIME, xlsxBytes([['Column', 'Width', 'Visible'], ['Document No.', '12', 'Yes'], ['Posting Date', '12', 'Yes'], ['Company Code', '8', 'Yes'], ['Amount', '14', 'Yes'], ['Currency', '8', 'No']], 'Sheet1')), true;
    }
  }
  return send(res, 200, render(c, st)), true;
}
