// The SAP system logon of the realistic look-alike: rendered in place at the requested URL (no redirect), POSTing to the same path.
// Wording not taken from a real SAP system is synthetic. Sessions live in memory and are cleared by resetSapSessions (resetState).
// With SANDBOX_SAP_LOGIN=sso or sso2 the logon is off: a sessionless page redirects to the identity provider (idp.js), whose
// assertion comes back through the ACS, which opens the session with createSapSession.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sapLogin } from './sap-mode.js';

export const SAP_LOGON = {
  client: process.env.SAP_CLIENT || '100',
  user: process.env.SAP_USER || 'RPA_BOT',
  password: process.env.SAP_PASSWORD || 'sap-demo-password',
  language: 'EN',
  cookie: 'SAP_SESSIONID_RPA_100',
};
const CONTEXT_COOKIE = 'sap-usercontext';
const MAX_FAILS = 5;
const SESSION_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;

const sessions = new Map(); // sid -> { user, exp }
let fails = 0;
let locked = false;

export const resetSapSessions = () => { sessions.clear(); fails = 0; locked = false; };

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
const cookiesOf = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));

export function sapSession(req) {
  const sid = cookiesOf(req)[SAP_LOGON.cookie];
  const s = sid && sessions.get(sid);
  if (!s || s.exp < Date.now()) return null;
  s.exp = Date.now() + SESSION_MS;
  return { user: s.user };
}

export async function readForm(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1e5) throw new Error('body too large'); }
  return Object.fromEntries(new URLSearchParams(data));
}

function logonPage(message = '', client = SAP_LOGON.client, user = '', language = SAP_LOGON.language) {
  const row = (name, label, value, type = 'text') =>
    `<div class="row"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${esc(value)}" autocomplete="off"></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Logon</title>
<style>body{font-family:Arial,sans-serif;background:#dfe6ee;margin:0}.box{width:420px;margin:60px auto;background:#fff;border:1px solid #98a5b3;padding:20px}
h1{font-size:20px;margin:0}.sys{color:#556;margin:4px 0 16px}.row{margin:8px 0}.row label{display:inline-block;width:90px}.msg{color:#b00;margin:8px 0}</style></head>
<body><div class="box"><h1>SAP NetWeaver</h1><div class="sys">System RPA, Client ${esc(SAP_LOGON.client)}</div>
${message ? `<div class="msg" role="alert">${esc(message)}</div>` : ''}
<form id="LOGIN_FORM" method="post">
${row('sap-client', 'Client', client)}${row('sap-user', 'User', user)}${row('sap-password', 'Password', '', 'password')}${row('sap-language', 'Language', language)}
<div class="row"><button type="submit" id="LOGON_BUTTON">Log On</button></div>
</form></div></body></html>`;
}

/** Opens an SAP session for user and returns its id, the value of the SAP_LOGON.cookie cookie. The map is capped, dropping the oldest. */
export function createSapSession(user) {
  const sid = randomBytes(18).toString('hex');
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  sessions.set(sid, { user, exp: now + SESSION_MS });
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return sid;
}
/** The Set-Cookie values for a new session: the session id, and the client context SAP sets beside it. */
export const sapSessionCookies = (sid) => [
  `${SAP_LOGON.cookie}=${sid}; Path=/; HttpOnly; SameSite=Lax`,
  `${CONTEXT_COOKIE}=sap-client=${SAP_LOGON.client}; Path=/`,
];

// Where single sign-on returns to (the RelayState): a path under /sap/ on this host, matching the single sign-on pattern. It must also stay
// under /sap/ after every percent-decoding, with no //, no backslash, no . or .. segment and no control character, so no
// layer that decodes it again can make it //host or /\host. Anything else becomes the launchpad.
export const SSO_LANDING = '/sap/bc/ui2/flp';
const RELAY_STATE = /^\/sap\/[A-Za-z0-9_\-./()~%?=&]*$/;
const OFF_PATH = /\/\/|\\|[\x00-\x20\x7f]|\/\.\.?(?:[/?#]|$)/;
export function safeRelayState(v) {
  if (typeof v !== 'string' || v.length > 2048 || !RELAY_STATE.test(v)) return SSO_LANDING;
  let s = v;
  for (let i = 0; i < 4; i++) {
    if (!s.startsWith('/sap/') || OFF_PATH.test(s)) return SSO_LANDING;
    if (!s.includes('%')) return v;
    try { s = decodeURIComponent(s); } catch { return SSO_LANDING; }
  }
  return SSO_LANDING;
}

export const isPublicSapPath = (pathname) => pathname.startsWith('/sap/public/');

const expired = (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

// True when it answered: the logon page (any /sap* path without a session), the logon POST, or the logoff. With single
// sign-on, a sessionless request (other than OData and /sap/public/) is redirected to the identity provider instead.
export async function sapLogonGate(req, res, url, send) {
  if (url.pathname === '/sap/public/bc/icf/logoff') {
    const sid = cookiesOf(req)[SAP_LOGON.cookie];
    if (sid) sessions.delete(sid);
    const res2 = '<!doctype html><html><head><meta charset="utf-8"><title>Logoff</title></head><body><h1>You have logged off from the SAP system</h1></body></html>';
    send(res, 200, res2, { 'Set-Cookie': [expired(SAP_LOGON.cookie), expired(CONTEXT_COOKIE)] });
    return true;
  }
  if (isPublicSapPath(url.pathname) || sapSession(req)) return false;
  if (url.pathname.startsWith('/sap/opu/')) {
    send(res, 401, 'Logon required', { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Basic realm="SAP NetWeaver Application Server [RPA/100]"' });
    return true;
  }
  if (sapLogin() !== 'sap') {
    send(res, 302, '', { Location: `/idp/login?RelayState=${encodeURIComponent(safeRelayState(url.pathname + url.search))}` });
    return true;
  }
  if (req.method === 'POST') {
    const f = await readForm(req);
    const client = f['sap-client'] || '', user = f['sap-user'] || '', language = f['sap-language'] || SAP_LOGON.language;
    const again = (msg) => { send(res, 200, logonPage(msg, client, user, language)); return true; };
    if (locked) return again('User is locked. Please notify the person responsible');
    if (!safeEqual(client, SAP_LOGON.client)) return again(`Client ${SAP_LOGON.client} is the only client`);
    const isBot = safeEqual(user.toUpperCase(), SAP_LOGON.user.toUpperCase());
    if (!(isBot && safeEqual(f['sap-password'] || '', SAP_LOGON.password))) {
      if (isBot) fails += 1; // only failures for the configured user count toward its lock
      if (fails >= MAX_FAILS) { locked = true; return again('User is locked. Please notify the person responsible'); }
      return again('Name or password is incorrect (repeat logon)');
    }
    fails = 0;
    send(res, 302, '', { Location: url.pathname + url.search, 'Set-Cookie': sapSessionCookies(createSapSession(SAP_LOGON.user)) });
    return true;
  }
  send(res, 200, logonPage());
  return true;
}
