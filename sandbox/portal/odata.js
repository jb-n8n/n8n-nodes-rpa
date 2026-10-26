// A strict, read-only OData V2 service for the realistic Fiori app (ZLINEITEMS_SRV). It answers the request shapes OpenUI5's
// ODataModel V2 sends and refuses everything else with a 400 that names what is unsupported. No writes. No dependencies.
// server.js's realistic dispatch calls odataRoute behind the SAP logon gate. Lenient on encoding, strict on semantics.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LEDGER } from './erp.js';
import { SAP_LOGON } from './sap-logon.js';

export const SERVICE_ROOT = '/sap/opu/odata/sap/ZLINEITEMS_SRV';

const SECRET = randomBytes(16).toString('hex'); // one token per SAP session, derived from its cookie
const MAX_TOP = 500;
const MAX_PARTS = 50;
const MAX_FILTER = 2000;
const MAX_DEPTH = 16;
const MAX_BODY = 1e5;
const FIELDS = ['Document', 'PostingDate', 'CompanyCode', 'Amount', 'Currency'];
const QUERY_OPTIONS = new Set(['$skip', '$top', '$filter', '$orderby', '$inlinecount', '$select', '$format', 'sap-client']);

const sessionId = (req) => {
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === SAP_LOGON.cookie) return c.slice(i + 1).trim();
  }
  return '';
};
const tokenFor = (sid) => createHash('sha256').update(`${SECRET}:${sid}`).digest('hex').slice(0, 32);
const tokenOk = (given, sid) => {
  if (!sid || typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(tokenFor(sid));
  return a.length === b.length && timingSafeEqual(a, b);
};

const err = (error) => ({ error });
const errorBody = (message, code = 'RPA/400') => JSON.stringify({ error: { code, message: { lang: 'en', value: message } } });

// ---- $filter -------------------------------------------------------------------------------------------------------------

const DATETIME = /^datetime'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?'/;
const COMPANY = /^CompanyCode\s+eq\s+'([A-Za-z0-9]{1,10})'/;
const POSTING = /^PostingDate\s+(eq|ge|le|gt|lt)\s+/;

function isoDate(m) {
  const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map((x) => (x === undefined ? 0 : Number(x)));
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return err('PostingDate is not a valid date');
  if (h || mi || s || ms) return err('PostingDate literals must be midnight (T00:00:00); other times are not supported');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// A conjunction (nested parentheses allowed) of CompanyCode eq '<v>' and PostingDate (eq|ge|le|gt|lt) datetime'...'.
// A single left-to-right scan: every step consumes input or fails, nesting is capped, and the input length is capped.
export function parseFilter(s) {
  if (typeof s !== 'string' || s.length > MAX_FILTER) return err('$filter is too long');
  const out = {};
  let i = 0, depth = 0, expectTerm = true;
  const bad = () => err(`Unsupported $filter near "${s.slice(i, i + 24)}": only CompanyCode eq '<v>' and PostingDate eq/ge/le/gt/lt datetime'yyyy-MM-ddTHH:mm:ss' joined by and are supported`);
  const skipWs = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  while (true) {
    skipWs();
    if (expectTerm) {
      if (s[i] === '(') { if (++depth > MAX_DEPTH) return err('$filter is nested too deeply'); i++; continue; }
      const rest = s.slice(i);
      const c = COMPANY.exec(rest);
      if (c) {
        if (out.company !== undefined) return err('$filter names CompanyCode more than once');
        out.company = c[1]; i += c[0].length;
      } else {
        const p = POSTING.exec(rest);
        if (!p) return bad();
        const d = DATETIME.exec(rest.slice(p[0].length));
        if (!d) return bad();
        const date = isoDate(d);
        if (typeof date !== 'string') return date;
        const op = p[1];
        if (op === 'eq') {
          if (out.from !== undefined || out.to !== undefined) return err('$filter has more than one PostingDate bound on one side');
          out.from = date; out.to = date; out.fromOp = 'eq'; out.toOp = 'eq';
        } else if (op === 'ge' || op === 'gt') {
          if (out.from !== undefined) return err('$filter has more than one PostingDate lower bound');
          out.from = date; out.fromOp = op;
        } else {
          if (out.to !== undefined) return err('$filter has more than one PostingDate upper bound');
          out.to = date; out.toOp = op;
        }
        i += p[0].length + d[0].length;
      }
      expectTerm = false;
      continue;
    }
    if (s[i] === ')') { if (--depth < 0) return bad(); i++; continue; }
    if (i >= s.length) break;
    if (/^and(?=[\s(])/.test(s.slice(i, i + 4))) { i += 3; expectTerm = true; continue; }
    return bad();
  }
  if (depth !== 0) return err('$filter has unbalanced parentheses');
  return out;
}

// ---- LineItems query -----------------------------------------------------------------------------------------------------

const dateMs = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
// __metadata.uri is what UI5's ODataModel keys a row by (without it the list binding never settles); kept under $select too.
// Amount is Edm.Decimal, which OData V2 JSON sends as a string ("1234.56"); the ledger already holds it as one.
const edmRow = (r) => ({
  __metadata: { uri: `${SERVICE_ROOT}/LineItems('${r.document}')`, type: 'ZLINEITEMS_SRV.LineItem' },
  Document: r.document, PostingDate: `/Date(${dateMs(r.postingDate)})/`, CompanyCode: r.company, Amount: String(r.amount), Currency: r.currency,
});
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function uint(q, name) {
  const v = q.get(name);
  if (v === null) return undefined;
  if (!/^\d{1,9}$/.test(v.trim())) return err(`${name} must be a non-negative integer`);
  return Number(v);
}

export function lineItemsQuery(q) {
  const seen = new Set();
  for (const k of q.keys()) {
    if (!QUERY_OPTIONS.has(k)) return err(`Unsupported query option ${k}`);
    if (seen.has(k)) return err(`Query option ${k} is given more than once`);
    seen.add(k);
  }
  if (q.has('$format') && q.get('$format') !== 'json') return err('Only $format=json is supported');
  if (q.has('$inlinecount') && !['allpages', 'none'].includes(q.get('$inlinecount'))) return err('Only $inlinecount=allpages or none is supported');
  const skip = uint(q, '$skip'), top = uint(q, '$top');
  if (skip?.error) return skip;
  if (top?.error) return top;

  let f = {};
  if (q.has('$filter')) { f = parseFilter(q.get('$filter')); if (f.error) return f; }

  let select = null;
  if (q.has('$select')) {
    const names = q.get('$select').split(',').map((x) => x.trim());
    if (names.includes('*')) select = null;
    else {
      const unknown = names.find((n) => !FIELDS.includes(n));
      if (unknown !== undefined) return err(`Unsupported $select field "${unknown}"`);
      select = names;
    }
  }

  const keys = [];
  if (q.has('$orderby')) {
    for (const item of q.get('$orderby').split(',')) {
      const m = /^\s*(PostingDate|Document)(?:\s+(asc|desc))?\s*$/.exec(item);
      if (!m) return err(`Unsupported $orderby "${item.trim()}": only PostingDate and Document, asc or desc`);
      keys.push([m[1], m[2] === 'desc' ? -1 : 1]);
    }
  }

  let rows = LEDGER.filter((r) => {
    if (f.company !== undefined && r.company !== f.company) return false;
    if (f.from !== undefined && !(f.fromOp === 'gt' ? r.postingDate > f.from : r.postingDate >= f.from)) return false;
    if (f.to !== undefined && !(f.toOp === 'lt' ? r.postingDate < f.to : r.postingDate <= f.to)) return false;
    return true;
  });
  const last = keys.length ? keys[keys.length - 1][1] : 1;
  const value = { PostingDate: (r) => r.postingDate, Document: (r) => r.document };
  rows = rows.sort((a, b) => {
    for (const [k, dir] of keys) { const c = cmp(value[k](a), value[k](b)) * dir; if (c) return c; }
    return (cmp(a.postingDate, b.postingDate) || cmp(a.document, b.document)) * last;
  });
  const count = rows.length;
  rows = rows.slice(skip ?? 0, (skip ?? 0) + Math.min(top ?? MAX_TOP, MAX_TOP)).map(edmRow);
  if (select) rows = rows.map((r) => Object.fromEntries([['__metadata', r.__metadata], ...select.map((n) => [n, r[n]])]));
  return { rows, count };
}

// ---- $batch --------------------------------------------------------------------------------------------------------------

const REQUEST_LINE = /^([A-Za-z]+)\s+(.*?)\s+HTTP\/\d(?:\.\d)?\s*$/;
const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseTarget(target) {
  let t = target.trim();
  const root = SERVICE_ROOT;
  if (t.startsWith(root)) t = t.slice(root.length);
  t = t.replace(/^\/+/, '');
  const qi = t.indexOf('?');
  const rawPath = qi < 0 ? t : t.slice(0, qi);
  const path = decode(rawPath);
  if (path === null) return err('Malformed percent-encoding in the request path');
  const pairs = [];
  if (qi >= 0) {
    for (const piece of t.slice(qi + 1).split('&')) {
      if (!piece) continue;
      const ei = piece.indexOf('=');
      const k = decode(ei < 0 ? piece : piece.slice(0, ei));
      const v = decode(ei < 0 ? '' : piece.slice(ei + 1));
      if (k === null || v === null) return err('Malformed percent-encoding in the query string');
      pairs.push([k, v]);
    }
  }
  return { path, query: new URLSearchParams(pairs) };
}

export function parseBatchRequests(contentType, body) {
  const boundary = /boundary=("?)([^";\s]+)\1/i.exec(contentType || '')?.[2];
  if (!boundary || !/^\s*multipart\/mixed/i.test(contentType || '')) return err('A $batch request must be multipart/mixed with a boundary');
  const delim = new RegExp(`(?:^|\\r?\\n)--${escapeRe(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const marks = [...String(body).matchAll(delim)];
  const parts = [];
  for (let k = 0; k < marks.length && !marks[k][1]; k++) {
    const start = marks[k].index + marks[k][0].length;
    const end = k + 1 < marks.length ? marks[k + 1].index : body.length;
    parts.push(body.slice(start, end));
  }
  if (!parts.length) return err('The $batch request holds no parts');
  if (parts.length > MAX_PARTS) return err(`A $batch request may hold at most ${MAX_PARTS} parts`);

  const out = [];
  for (const raw of parts) {
    const part = raw.replace(/^\s*\r?\n/, '').replace(/^(\r?\n)+/, '');
    if (/changeset/i.test(part.split(/\r?\n\r?\n/)[0])) return err('Changesets are not supported: this service is read-only');
    let rest = part;
    if (!REQUEST_LINE.test(part.split(/\r?\n/)[0].trim())) {
      const split = part.search(/\r?\n\r?\n/);
      const head = split < 0 ? part : part.slice(0, split);
      const type = /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1].trim().toLowerCase();
      if (type && type !== 'application/http') return err(`Unsupported batch part content type ${type}: only application/http reads are supported`);
      rest = split < 0 ? '' : part.slice(split).replace(/^\s+/, '');
    }
    const line = rest.split(/\r?\n/).find((l) => l.trim() !== '');
    const m = line === undefined ? null : REQUEST_LINE.exec(line.trim());
    if (!m) return err('A batch part must hold one request line such as GET LineItems?$top=20 HTTP/1.1');
    if (m[1].toUpperCase() !== 'GET') return err(`${m[1].toUpperCase()} is not supported: this service is read-only, only GET of LineItems and LineItems/$count`);
    const t = parseTarget(m[2]);
    if (t.error) return t;
    if (t.path !== 'LineItems' && t.path !== 'LineItems/$count') return err(`Unsupported resource "${t.path}": only LineItems and LineItems/$count are supported`);
    out.push(t);
  }
  return out;
}

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData"><edmx:DataServices m:DataServiceVersion="2.0">
<Schema Namespace="ZLINEITEMS_SRV" xml:lang="en" sap:schema-version="1" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
<EntityType Name="LineItem" sap:content-version="1"><Key><PropertyRef Name="Document"/></Key><Property Name="Document" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Document"/><Property Name="PostingDate" Type="Edm.DateTime" Precision="0" sap:display-format="Date" sap:label="Posting Date"/><Property Name="CompanyCode" Type="Edm.String" MaxLength="4" sap:label="Company Code"/><Property Name="Amount" Type="Edm.Decimal" Precision="13" Scale="2" sap:label="Amount"/><Property Name="Currency" Type="Edm.String" MaxLength="5" sap:label="Currency"/></EntityType>
<EntityContainer Name="ZLINEITEMS_SRV_Entities" m:IsDefaultEntityContainer="true"><EntitySet Name="LineItems" EntityType="ZLINEITEMS_SRV.LineItem" sap:creatable="false" sap:updatable="false" sap:deletable="false" sap:pageable="true" sap:content-version="1"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > MAX_BODY) throw new Error('body too large'); }
  return data;
}

const DSV = { dataserviceversion: '2.0' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...DSV };

// Returns true when the request was handled: everything under the service root is answered here, nothing else is.
export async function odataRoute(req, res, url, send) {
  const p = url.pathname;
  if (p !== SERVICE_ROOT && !p.startsWith(`${SERVICE_ROOT}/`)) return false;
  const sub = p.slice(SERVICE_ROOT.length).replace(/^\//, '');
  const fail = (status, message, headers = {}) => { send(res, status, errorBody(message, `RPA/${status}`), { ...JSON_HEADERS, ...headers }); return true; };

  if (sub === '' && (req.method === 'HEAD' || req.method === 'GET')) {
    const head = {};
    const sid = sessionId(req);
    if (req.headers['x-csrf-token'] === 'Fetch' && sid) head['x-csrf-token'] = tokenFor(sid);
    send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ d: { EntitySets: ['LineItems'] } }), { ...JSON_HEADERS, ...head });
    return true;
  }
  if (sub === '$metadata' && (req.method === 'GET' || req.method === 'HEAD')) {
    send(res, 200, req.method === 'HEAD' ? '' : EDMX, { 'Content-Type': 'application/xml', ...DSV });
    return true;
  }
  if (sub === '$batch' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return fail(413, 'The request body is too large'); }
    if (!tokenOk(req.headers['x-csrf-token'], sessionId(req))) return fail(403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' });
    const parts = parseBatchRequests(req.headers['content-type'], body);
    if (parts.error) return fail(400, parts.error);
    const answers = [];
    for (const part of parts) {
      const isCount = part.path === 'LineItems/$count';
      if (isCount) {
        for (const k of part.query.keys()) if (k !== '$filter' && k !== 'sap-client') return fail(400, `Unsupported query option ${k} on LineItems/$count`);
      }
      const r = lineItemsQuery(isCount ? new URLSearchParams([...part.query].filter(([k]) => k === '$filter')) : part.query);
      if (r.error) return fail(400, r.error);
      if (isCount) answers.push({ type: 'text/plain;charset=utf-8', text: String(r.count) });
      else {
        const d = { results: r.rows };
        if (part.query.get('$inlinecount') === 'allpages') d.__count = String(r.count);
        answers.push({ type: 'application/json', text: JSON.stringify({ d }) });
      }
    }
    const boundary = `batch_${randomBytes(6).toString('hex')}`;
    const out = answers.map((a) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: ${a.type}\r\ndataserviceversion: 2.0\r\n\r\n${a.text}\r\n`).join('') + `--${boundary}--`;
    send(res, 200, out, { 'Content-Type': `multipart/mixed; boundary=${boundary}`, ...DSV });
    return true;
  }
  if (['$metadata', '$batch', ''].includes(sub)) return fail(405, `${req.method} is not supported here: this service is read-only`, { Allow: sub === '$batch' ? 'POST' : 'GET, HEAD' });
  return fail(404, `Unsupported resource "${sub}": read LineItems through $batch`);
}
