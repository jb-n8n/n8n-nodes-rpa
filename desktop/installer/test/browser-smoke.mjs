// Drives the installed RPA browser on this machine once, the way n8n does, and checks what it sees. For the desktop
// workflow and for a check by hand after an install; it is not part of the package. Run it with the Node that came
// with the install, as a user who can read the data directory (an administrator, or the bot user):
//
//   "C:\Program Files\RPA Runner\browser\node.exe" browser-smoke.mjs --fingerprint <AA:BB:...> [--port 3000]
//        [--install <dir>] [--data <dir>] [--hold-ms <n>]
//
//   --fingerprint  the browser's fingerprint as Show-RpaConnection.ps1 prints it
//   --port         the browser's port (default: browserPort in install.json)
//   --install      the install directory (default %ProgramFiles%\RPA Runner); Playwright's client is loaded from there
//   --data         the data directory (default %ProgramData%\RPA Runner); the token is read from browser-token there
//   --hold-ms      keep the page open this long before closing, so that the browser's processes can be looked at
//
// What it checks, in order:
//   1. the certificate served on 127.0.0.1:<port> has the fingerprint, and a connection that expects another
//      fingerprint is closed before a byte is sent;
//   2. a WebSocket upgrade without the token is answered 401;
//   3. Playwright's client connects with the token and {"headless":false}, opens a page and reads its title "ok";
//   4. a second upgrade with the token, while that session is open, is answered 503 with X-RPA-Browser: busy.
// Every connection goes through pinned(): a TLS connection whose certificate is compared with the fingerprint before
// anything is sent on it. The certificate is self-signed, so the chain check is off for that one connection and the
// fingerprint takes its place; certificate checks are never switched off for the process. Playwright's client cannot
// pin a certificate, so it connects to a loopback tunnel in this script that forwards one connection over pinned().
// The token is never printed. Exit code 0 when every check passed, 1 otherwise.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { connect } from 'node:tls';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const installDir = option('--install', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'RPA Runner'));
const dataDir = option('--data', join(process.env.ProgramData ?? 'C:\\ProgramData', 'RPA Runner'));
const fingerprint = option('--fingerprint', '');
const holdMs = Number(option('--hold-ms', '0'));
const port = Number(option('--port', JSON.parse(readFileSync(join(installDir, 'install.json'), 'utf8').replace(/^\uFEFF/, '')).browserPort));
const token = readFileSync(join(dataDir, 'browser-token'), 'utf8').trim();

const say = (text) => console.log(String(text).replaceAll(token, '<token>'));
const fail = (text) => {
  say(`FAIL: ${text}`);
  process.exit(1);
};
if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) fail('--fingerprint must be 32 upper-case hex pairs joined by colons');
if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('--port must be a port number');
if (!Number.isFinite(holdMs) || holdMs < 0) fail('--hold-ms must be a number of milliseconds');

/**
 * A TLS connection to the browser on loopback whose certificate has the expected SHA-256 fingerprint. Rejects, with
 * the connection closed and nothing sent, when the certificate is another one.
 */
function pinned(expected) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' });
    socket.setTimeout(15_000, () => socket.destroy(new Error('no TLS handshake within 15 s')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      const presented = raw ? createHash('sha256').update(raw).digest('hex').toUpperCase().match(/../g).join(':') : '';
      if (presented !== expected) {
        socket.destroy();
        reject(new Error('the certificate has another fingerprint'));
        return;
      }
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

/** The status line and headers of the answer to one WebSocket upgrade request on a pinned connection. */
async function upgradeAnswer(headers) {
  const socket = await pinned(fingerprint);
  const lines = ['GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...headers, '', ''];
  socket.write(lines.join('\r\n'));
  return new Promise((resolve, reject) => {
    let text = '';
    const done = () => {
      socket.destroy();
      const [status, ...rest] = text.split('\r\n\r\n')[0].split('\r\n');
      resolve({ status, headers: rest.map((line) => line.toLowerCase()) });
    };
    socket.setTimeout(15_000, () => reject(new Error('no answer within 15 s')));
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n')) done();
    });
    socket.once('end', done);
    socket.once('error', reject);
  });
}

/** A loopback server that forwards its first connection over pinned(), and closes every later one. */
async function tunnel() {
  let taken = false;
  const server = createServer(async (local) => {
    if (taken) return local.destroy();
    taken = true;
    local.on('error', () => local.destroy());
    local.pause();
    try {
      const remote = await pinned(fingerprint);
      remote.on('error', () => local.destroy());
      remote.on('close', () => local.destroy());
      local.on('close', () => remote.destroy());
      local.pipe(remote);
      remote.pipe(local);
    } catch (err) {
      say(`tunnel: ${err.message}`);
      local.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

try {
  (await pinned(fingerprint)).destroy();
  say(`ok: the certificate served on 127.0.0.1:${port} has the fingerprint ${fingerprint}`);
  const other = `${fingerprint.startsWith('00') ? '01' : '00'}${fingerprint.slice(2)}`;
  const refused = await pinned(other).then((socket) => { socket.destroy(); return false; }, () => true);
  if (!refused) fail('a connection that expects another fingerprint was not closed');
  say('ok: a connection that expects another fingerprint is closed before a byte is sent');

  const withoutToken = await upgradeAnswer([]);
  if (!/^HTTP\/1\.1 401 /.test(withoutToken.status)) fail(`an upgrade without the token was answered "${withoutToken.status}", not 401`);
  say('ok: an upgrade without the token is answered 401');

  const { chromium } = createRequire(join(installDir, 'browser', 'package.json'))('playwright');
  const server = await tunnel();
  const started = Date.now();
  const browser = await chromium.connect(`ws://127.0.0.1:${server.address().port}/`, {
    headers: { Authorization: `Bearer ${token}`, 'x-playwright-launch-options': JSON.stringify({ headless: false }) },
    timeout: 90_000,
  });
  const page = await (await browser.newContext()).newPage();
  await page.goto('data:text/html,<title>ok</title>');
  const title = await page.title();
  const agent = await page.evaluate(() => navigator.userAgent);
  if (title !== 'ok') fail(`the page title is "${title}", not "ok"`);
  if (agent.includes('HeadlessChrome')) fail('the browser is headless, though {"headless":false} was asked for');
  say(`ok: connected through the tunnel with {"headless":false}; title "${title}"; browser ${browser.version()}; ${Date.now() - started} ms`);

  const second = await upgradeAnswer([`Authorization: Bearer ${token}`]);
  if (!/^HTTP\/1\.1 503 /.test(second.status) || !second.headers.includes('x-rpa-browser: busy')) fail(`a second upgrade while the session is open was answered "${second.status}", not 503 busy`);
  say('ok: a second upgrade while that session is open is answered 503, X-RPA-Browser: busy');

  if (holdMs > 0) {
    say(`holding the page open for ${holdMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  await browser.close();
  server.close();
  say('ok: the session is closed');
  process.exit(0);
} catch (err) {
  fail(String(err?.message ?? err).split('\n')[0]);
}
