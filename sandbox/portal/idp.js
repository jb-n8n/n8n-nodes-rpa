// The identity provider in front of the realistic SAP look-alike, served when SANDBOX_SAP_LOGIN=sso (one page) or sso2 (email, password, code, then "Stay signed in?" unless IDP_KMSI=off).
// Path-based on the sandbox host, because the sandbox has one host name:
//   /idp/login  email and password (field names follow Microsoft Entra's sign-in page, unverified)
//   /idp/password (sso2 only) the password for the email, /idp/mfa a TOTP code, for the transaction the previous step opened
//   /idp/kmsi   (sso2 only) POST only: the "Stay signed in?" answer, with its own transaction (the code page's response carries the page); IDP_KMSI=off skips it
//   then an auto-submitting POST of the assertion to SAP's assertion consumer service, /sap/saml2/acs (acsRoute).
// Not SAML: the assertion is base64url JSON { user, exp, nonce }, a dot, and its HMAC-SHA256 under a per-process key.
// The ACS checks the MAC, the expiry (60 s) and that the nonce was handed out and not used yet. State lives in memory,
// capped at 200 entries per map (oldest dropped), and resetIdp (resetState) clears it.
import { createHmac, randomBytes } from 'node:crypto';
import { verifyTotp } from './totp.js';
import { sapLogin } from './sap-mode.js';
import { SAP_LOGON, createSapSession, esc, readForm, safeEqual, safeRelayState, sapSessionCookies } from './sap-logon.js';

export const IDP = {
  user: process.env.IDP_USER || 'rpa-bot@rpa.example',
  password: process.env.IDP_PASSWORD || 'idp-demo-password',
  totpSecret: process.env.IDP_TOTP_SECRET || 'JBSWY3DPEHPK3PXP',
};
const KEY = randomBytes(32);
const ASSERTION_MS = 60 * 1000;
const TX_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_CODE_FAILS = 5;

const transactions = new Map(); // tx -> { user, relay, exp, fails, stage }: one step waiting (stage 'password', 'mfa' or 'kmsi'); each step hands on a fresh tx
const nonces = new Map(); // nonce -> { exp }: assertions handed out and not used yet

export const resetIdp = () => { transactions.clear(); nonces.clear(); };

function remember(map, key, value) {
  const now = Date.now();
  for (const [k, v] of map) if (v.exp < now) map.delete(k);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
}

const mac = (payload) => createHmac('sha256', KEY).update(payload).digest('base64url');
const sameUser = (a, b) => safeEqual(String(a).trim().toLowerCase(), String(b).toLowerCase());

/** A signed assertion for user, valid for 60 s from now. Exported so tests can make an expired one. */
export function issueAssertion(user, now = Date.now()) {
  const nonce = randomBytes(16).toString('base64url');
  const exp = now + ASSERTION_MS;
  remember(nonces, nonce, { exp });
  const payload = Buffer.from(JSON.stringify({ user, exp, nonce })).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

/** The claims of a genuine, unexpired, unused assertion (using it up), or null. */
function acceptAssertion(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !safeEqual(parts[1], mac(parts[0]))) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims.user !== 'string' || typeof claims.exp !== 'number' || typeof claims.nonce !== 'string') return null;
  if (!(claims.exp > Date.now()) || !nonces.has(claims.nonce)) return null;
  nonces.delete(claims.nonce);
  return claims;
}

/** The live transaction waiting at this stage ('password', 'mfa' or 'kmsi'), or null. */
function liveTransaction(tx, stage = 'mfa') {
  const t = typeof tx === 'string' ? transactions.get(tx) : undefined;
  if (!t || t.exp < Date.now() || t.stage !== stage) return null;
  return t;
}
const newTransaction = (relay, stage) => {
  const tx = randomBytes(18).toString('hex');
  remember(transactions, tx, { user: IDP.user, relay, exp: Date.now() + TX_MS, fails: 0, stage });
  return tx;
};

const STYLE = `<style>body{font-family:"Segoe UI",Arial,sans-serif;background:#f2f2f2;margin:0}.box{width:380px;margin:80px auto;background:#fff;
padding:40px;box-shadow:0 2px 6px rgba(0,0,0,.2)}.brand{font-weight:600;color:#555}h1{font-size:24px;font-weight:600;margin:12px 0 16px}
.row{margin:12px 0}.row label{display:block;margin-bottom:4px}.row input{width:100%;box-sizing:border-box;padding:6px}
.msg{color:#e81123;margin:8px 0}button{background:#0067b8;color:#fff;border:0;padding:8px 24px}</style>`;
const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${STYLE}</head><body><main class="box"><div class="brand">RPA Corp</div>
${body}
</main></body></html>`;
const alert = (message) => (message ? `<div class="msg" role="alert">${esc(message)}</div>` : '');

// sso2: the email first, then a password page, then the code, then "Stay signed in?".
function emailPage({ message = '', user = '', relay }) {
  return shell('Sign in', `<h1>RPA Corp sign-in</h1>${alert(message)}
<form method="post" action="/idp/login">
<input type="hidden" name="RelayState" value="${esc(relay)}">
<div class="row"><label for="loginfmt">Email</label><input id="loginfmt" name="loginfmt" type="email" value="${esc(user)}" autocomplete="username"></div>
<div class="row"><button type="submit" id="idSIButton9">Next</button></div>
</form>`);
}

function passwordPage({ message = '', user, tx }) {
  return shell('Enter password', `<h1>Enter password</h1>${alert(message)}
<form method="post" action="/idp/password">
<input type="hidden" name="tx" value="${esc(tx)}">
<div class="row"><input id="displayName" name="displayName" type="email" value="${esc(user)}" readonly></div>
<div class="row"><label for="passwd">Password</label><input id="passwd" name="passwd" type="password" autocomplete="current-password"></div>
<div class="row"><button type="submit" id="idSIButton9">Sign in</button></div>
</form>`);
}

function kmsiPage({ tx }) {
  return shell('Stay signed in?', `<h1>Stay signed in?</h1><p>Do this to reduce the number of times you are asked to sign in.</p>
<form method="post" action="/idp/kmsi">
<input type="hidden" name="tx" value="${esc(tx)}">
<div class="row"><button type="submit" name="choice" value="no" id="idBtn_Back">No</button> <button type="submit" name="choice" value="yes" id="idSIButton9">Yes</button></div>
</form>`);
}

function loginPage({ message = '', user = '', relay }) {
  return shell('Sign in', `<h1>RPA Corp sign-in</h1>${alert(message)}
<form method="post" action="/idp/login">
<input type="hidden" name="RelayState" value="${esc(relay)}">
<div class="row"><label for="loginfmt">Email</label><input id="loginfmt" name="loginfmt" type="email" value="${esc(user)}" autocomplete="username"></div>
<div class="row"><label for="passwd">Password</label><input id="passwd" name="passwd" type="password" autocomplete="current-password"></div>
<div class="row"><button type="submit" id="idSIButton9">Sign in</button></div>
</form>`);
}

function mfaPage({ message = '', tx }) {
  return shell('Enter code', `<h1>Enter code</h1><p>Enter the code displayed in the authenticator app on your mobile device.</p>${alert(message)}
<form method="post" action="/idp/mfa">
<input type="hidden" name="tx" value="${esc(tx)}">
<div class="row"><label for="otc">Code</label><input id="otc" name="otc" type="tel" inputmode="numeric" autocomplete="one-time-code"></div>
<div class="row"><button type="submit" id="idSubmit_SAOTCC_Continue">Verify</button></div>
</form>`);
}

// The HTTP POST binding: the browser carries the assertion to the ACS itself. Without scripts, a Continue button does it.
const postBindingPage = (assertion, relay) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Working...</title></head><body>
<form id="saml" method="post" action="/sap/saml2/acs">
<input type="hidden" name="SAMLResponse" value="${esc(assertion)}">
<input type="hidden" name="RelayState" value="${esc(relay)}">
<noscript><p>Script is disabled. Continue to sign in to SAP.</p><button type="submit">Continue</button></noscript>
</form>
<script>document.getElementById('saml').submit();</script>
</body></html>`;

const REFUSED = `<!doctype html><html><head><meta charset="utf-8"><title>Logon failed</title></head>
<body><h1>SAML 2.0 logon failed</h1><p>The assertion was not accepted. Open the page again to sign in.</p></body></html>`;

/** The form body, or null when it is too large or cannot be read. */
const formOrNull = (req) => readForm(req).catch(() => null);
const refuse = (res, send) => { send(res, 403, REFUSED, { Connection: 'close' }); return true; };

const toSignIn = (res, send) => { send(res, 302, '', { Location: '/idp/login' }); return true; };
const notAllowed = (res, send, allow) => { send(res, 405, 'Method not allowed', { Allow: allow, 'Content-Type': 'text/plain; charset=utf-8' }); return true; };

const kmsiOn = () => process.env.IDP_KMSI !== 'off';

/** /idp/login, /idp/mfa and, with sso2, /idp/password and /idp/kmsi. True when it answered. The server calls it in realistic mode with single sign-on only. */
export async function idpRoute(req, res, url, send) {
  const two = sapLogin() === 'sso2';
  if (url.pathname === '/idp/login') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const relay = safeRelayState(url.searchParams.get('RelayState'));
      send(res, 200, two ? emailPage({ relay }) : loginPage({ relay }));
      return true;
    }
    if (req.method !== 'POST') return notAllowed(res, send, 'GET, POST');
    const f = await formOrNull(req);
    if (!f) return refuse(res, send);
    const user = f.loginfmt || '', relay = safeRelayState(f.RelayState);
    if (two) {
      if (!sameUser(user, IDP.user)) {
        send(res, 200, emailPage({ message: "We couldn't find an account with that username.", user, relay }));
        return true;
      }
      send(res, 302, '', { Location: `/idp/password?tx=${newTransaction(relay, 'password')}` });
      return true;
    }
    const userOk = sameUser(user, IDP.user), passwordOk = safeEqual(f.passwd || '', IDP.password);
    if (!(userOk && passwordOk)) {
      send(res, 200, loginPage({ message: 'Your account or password is incorrect.', user, relay }));
      return true;
    }
    send(res, 302, '', { Location: `/idp/mfa?tx=${newTransaction(relay, 'mfa')}` });
    return true;
  }
  if (two && url.pathname === '/idp/password') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const tx = url.searchParams.get('tx');
      const t = liveTransaction(tx, 'password');
      if (!t) return toSignIn(res, send);
      send(res, 200, passwordPage({ user: t.user, tx }));
      return true;
    }
    if (req.method !== 'POST') return notAllowed(res, send, 'GET, POST');
    const f = await formOrNull(req);
    if (!f) return refuse(res, send);
    const tx = f.tx ?? url.searchParams.get('tx');
    const t = liveTransaction(tx, 'password');
    if (!t) return toSignIn(res, send);
    if (!safeEqual(f.passwd || '', IDP.password)) {
      send(res, 200, passwordPage({ message: 'Your account or password is incorrect.', user: t.user, tx }));
      return true;
    }
    transactions.delete(tx);
    send(res, 302, '', { Location: `/idp/mfa?tx=${newTransaction(t.relay, 'mfa')}` });
    return true;
  }
  if (two && url.pathname === '/idp/kmsi') {
    // The page only comes back inline as the code's response (below), so this path takes the answer's POST only.
    if (req.method !== 'POST') return notAllowed(res, send, 'POST');
    const f = await formOrNull(req);
    if (!f) return refuse(res, send);
    const tx = f.tx ?? url.searchParams.get('tx');
    const t = liveTransaction(tx, 'kmsi');
    if (!t) return toSignIn(res, send);
    transactions.delete(tx);
    send(res, 200, postBindingPage(issueAssertion(t.user), t.relay));
    return true;
  }
  if (url.pathname === '/idp/mfa') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const tx = url.searchParams.get('tx');
      if (!liveTransaction(tx)) return toSignIn(res, send);
      send(res, 200, mfaPage({ tx }));
      return true;
    }
    if (req.method !== 'POST') return notAllowed(res, send, 'GET, POST');
    const f = await formOrNull(req);
    if (!f) return refuse(res, send);
    const tx = f.tx ?? url.searchParams.get('tx');
    const t = liveTransaction(tx);
    if (!t) return toSignIn(res, send);
    if (!verifyTotp(IDP.totpSecret, f.otc || '')) {
      t.fails += 1;
      if (t.fails >= MAX_CODE_FAILS) { transactions.delete(tx); return toSignIn(res, send); }
      send(res, 200, mfaPage({ message: "You didn't enter the expected verification code. Please try again.", tx }));
      return true;
    }
    if (two && kmsiOn()) {
      // The page is the code's response, so its own transaction stays out of URLs; the code page's one is used up.
      transactions.delete(tx);
      send(res, 200, kmsiPage({ tx: newTransaction(t.relay, 'kmsi') }));
      return true;
    }
    transactions.delete(tx);
    send(res, 200, postBindingPage(issueAssertion(t.user), t.relay));
    return true;
  }
  return false;
}

/** SAP's assertion consumer service, /sap/saml2/acs. True when it answered. The server calls it in realistic mode with single sign-on only. */
export async function acsRoute(req, res, url, send) {
  if (url.pathname !== '/sap/saml2/acs') return false;
  if (req.method !== 'POST') return notAllowed(res, send, 'POST');
  const f = await formOrNull(req);
  if (!f) return refuse(res, send);
  const claims = acceptAssertion(f.SAMLResponse);
  // SAP maps the asserted user to its own user: here the one IdP user is the bot, RPA_BOT.
  if (!claims || !sameUser(claims.user, IDP.user)) {
    send(res, 403, REFUSED);
    return true;
  }
  send(res, 302, '', { Location: safeRelayState(f.RelayState), 'Set-Cookie': sapSessionCookies(createSapSession(SAP_LOGON.user)) });
  return true;
}
