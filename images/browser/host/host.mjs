// The browser host: Playwright's browser server (run-server) and the token gate with TLS, run by one Node process.
// No dependencies of its own. It is what entrypoint.sh is in the rpa-browser image, for a machine without containers:
// a Windows machine where it runs inside the session of a signed-in user, so the browser has a desktop.
//
// The browser server needs no authentication, so only the gate may reach it:
// - It listens on 127.0.0.1, on a port the operating system picks at each start and on a random 128-bit path made at
//   each start. Other users of the machine share 127.0.0.1, so the path is all that keeps them out. The host gives it to
//   the browser server through run-server.mjs (not on a command line, which other users can read) and to the gate in
//   memory. It is never logged: the browser server prints its address on stdout, which the host reads through a pipe to
//   learn the port and then drops; its stderr goes nowhere.
// - The browser server must not tell its path to a plain HTTP request (Playwright 1.63 does on GET /json unless
//   run-server.mjs is in front). The host asks at each start and does not start the gate if the answer holds the path.
// - The browser server is started without the token: variables of the host's environment that hold it are not passed
//   on, so neither the browser server nor the browsers it launches hold the token.
// - The gate always serves TLS. n8n connects with wss and a bearer token and checks the certificate by its SHA-256
//   fingerprint, which the start line shows. There is no plain-text mode.
//
// Files in the data directory (who may read and write them is up to the directory's access rules; the installer sets them):
// - browser-token: the bearer token, at least 32 characters of ASCII text without spaces. Read at start, never printed.
// - browser-key.pem and browser-cert.pem: the gate's key and self-signed certificate. Created together at the first
//   start (the key with mode 0600 where the platform has file modes) and reused after that, so the fingerprint stays
//   the same. With only one of the two present the host does not start.
//
// Order and stopping:
// - The browser server starts first; the gate listens only once the browser server has printed its address.
// - The browser server exits: the gate closes at once and the host exits 1, so whatever started it starts it again.
// - Ctrl+C (SIGINT), SIGTERM, SIGHUP or Ctrl+Break: the gate closes (open sessions end), the browser server's process
//   tree is ended, exit 0. On Windows a process is usually ended without a signal; then no code of the host runs, and
//   the browser server ends by itself because its stdin, a pipe from the host, ends (run-server.mjs).
//
// Environment of the main block: RPA_BROWSER_DATA_DIR (default %ProgramData%\RPA Runner on Windows; no default
// elsewhere), RPA_BROWSER_PORT (3000), RPA_BROWSER_BIND (0.0.0.0, an IP address), RPA_BROWSER_MAX_SESSIONS (1).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { MAX_SESSIONS_LIMIT, MIN_TOKEN_LENGTH, createGate } from '../gate/gate.mjs';
import { fingerprintOfPem, selfSignedCert } from '../gate/selfsigned.mjs';

const TOKEN_FILE = 'browser-token';
const KEY_FILE = 'browser-key.pem';
const CERT_FILE = 'browser-cert.pem';
const TOKEN_RULE = `${TOKEN_FILE} must hold at least ${MIN_TOKEN_LENGTH} characters of ASCII text without spaces`;
const NEW_CERTIFICATE_HINT = 'delete both to create a new certificate (the fingerprint changes)';
const LAUNCHER_FILE = fileURLToPath(new URL('./run-server.mjs', import.meta.url));
/** How long the browser server may take to print its address. */
const START_TIMEOUT_MS = 30_000;
/** How long the check of the browser server's plain HTTP answer may take. */
const PLAIN_CHECK_MS = 5000;
/** On stop: SIGTERM once a second this many times, then SIGKILL (the run-server ignores a SIGTERM that arrives while it closes a browser). */
const TERM_ATTEMPTS = 5;
/** How long to wait for the exit after a kill that cannot be ignored. */
const EXIT_WAIT_MS = 5000;
/** The line the run-server prints once it listens; the path follows the port. */
const LISTENING = /^Listening on ws:\/\/127\.0\.0\.1:(\d+)(\/\S*)$/;
/** Lines of the browser server's output longer than this are dropped unread. */
const MAX_OUTPUT_LINE = 4096;

const validPort = (n) => Number.isInteger(n) && n >= 0 && n <= 65_535;

/** The token in the data directory, trimmed. The messages never show the file's content. */
function readToken(dataDir) {
  let text;
  try {
    text = readFileSync(join(dataDir, TOKEN_FILE), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(TOKEN_RULE);
    throw new Error(`cannot read ${TOKEN_FILE}: ${err.code ?? 'error'}`);
  }
  // The gate's rule for a token file: a file saved as UTF-16, or a space inside the token, would start a gate that
  // answers every client 401.
  const token = text.trim();
  if (token.length < MIN_TOKEN_LENGTH || !/^[\x21-\x7e]*$/.test(token)) throw new Error(TOKEN_RULE);
  return token;
}

/** Creates a file that does not exist yet and writes it to the disk before returning. */
function writeNewFile(path, text, mode) {
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The gate's key and certificate from the data directory: { key, cert, fingerprint }. With neither file there, both are
 * created: written under temporary names first, then renamed, so a host that is ended in between leaves no half-written
 * file under a final name; if anything fails, what was written is removed. With one file there, or a pair that is not a
 * key and its certificate, it throws.
 */
function certificate(dataDir) {
  const keyPath = join(dataDir, KEY_FILE);
  const certPath = join(dataDir, CERT_FILE);
  const hasKey = existsSync(keyPath);
  if (hasKey !== existsSync(certPath)) {
    const [missing, present] = hasKey ? [CERT_FILE, KEY_FILE] : [KEY_FILE, CERT_FILE];
    throw new Error(`${missing} is missing beside ${present}; restore it, or ${NEW_CERTIFICATE_HINT}`);
  }
  if (!hasKey) {
    const created = selfSignedCert();
    const temporary = `.${randomBytes(8).toString('hex')}.tmp`;
    const written = [];
    try {
      writeNewFile(keyPath + temporary, created.key, 0o600);
      written.push(keyPath + temporary);
      writeNewFile(certPath + temporary, created.cert, 0o644);
      written.push(certPath + temporary);
      renameSync(keyPath + temporary, keyPath);
      written[0] = keyPath;
      renameSync(certPath + temporary, certPath);
    } catch (err) {
      for (const path of written) rmSync(path, { force: true });
      throw new Error(`cannot create ${KEY_FILE} and ${CERT_FILE}: ${err.code ?? 'error'}`);
    }
    return created;
  }
  try {
    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    createSecureContext({ key, cert });
    return { key, cert, fingerprint: fingerprintOfPem(cert) };
  } catch (err) {
    throw new Error(`${KEY_FILE} and ${CERT_FILE} do not hold a usable key and its certificate (${err.code ?? 'error'}); restore them, or ${NEW_CERTIFICATE_HINT}`);
  }
}

/**
 * Starts Playwright's run-server through run-server.mjs. The path and the port go in two variables of that process's
 * environment, never on its command line. stdin is a pipe the host never writes to: it ends when the host is gone, and
 * the launcher exits then. stdout is a pipe the host reads the address from; stderr is dropped.
 */
function runBrowserServer({ port, path, env }) {
  return spawn(process.execPath, [LAUNCHER_FILE], {
    env: { ...env, RPA_RUN_SERVER_PATH: path, RPA_RUN_SERVER_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

/** Resolves true when the promise settles within ms, false when the time passes first. */
function settledWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * The port in the address line the browser server prints on stdout. Other lines are dropped, and so is everything the
 * server prints later (the pipe is still read, so the server never blocks on it). Nothing read here is logged: the
 * address holds the path. Rejects when the server ends first (`ended` resolves with how) or the time passes.
 */
function announcedPort(child, path, ended, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the browser server did not report its address within ${timeoutMs / 1000} s`)), timeoutMs);
    ended.then((how) => {
      clearTimeout(timer);
      reject(new Error(`the browser server stopped before it was listening (${how})`));
    });
    let pending = '';
    let found = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (found) return;
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      if (pending.length > MAX_OUTPUT_LINE) pending = '';
      for (const line of lines) {
        const match = LISTENING.exec(line.trimEnd());
        if (match && match[2] === path) {
          found = true;
          pending = '';
          clearTimeout(timer);
          resolve(Number(match[1]));
          return;
        }
      }
    });
  });
}

/** Whether the browser server's answer to a plain GET /json on loopback holds its path. No answer holds nothing. */
function tellsItsPath(port, path) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/json', agent: false, timeout: PLAIN_CHECK_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 65_536) body += chunk;
      });
      res.on('close', () => resolve(body.includes(path.slice(1))));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Ends the browser server and the processes under it. On Windows a child's kill() ends that one process and the
 * browsers it launched would stay, so the tree is ended with taskkill (by its full path: a bare name would also be
 * looked for in the current directory). Elsewhere the run-server closes its browsers on SIGTERM. `gone` settles when
 * the child has exited and `isGone` says so at once: a process that has exited is never signalled, its id may be
 * another process's by then.
 */
async function endProcessTree(child, gone, isGone) {
  if (isGone()) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((resolve) => {
      const taskkill = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      taskkill.once('error', resolve);
      taskkill.once('exit', resolve);
    });
    if (await settledWithin(gone, EXIT_WAIT_MS)) return;
  }
  for (let attempt = 0; attempt < TERM_ATTEMPTS; attempt += 1) {
    child.kill('SIGTERM');
    if (await settledWithin(gone, 1000)) return;
  }
  child.kill('SIGKILL');
  await settledWithin(gone, EXIT_WAIT_MS);
}

/**
 * Starts the browser server, then the gate with TLS in front of it, and logs the start line.
 * - dataDir holds browser-token and, after the first start, browser-key.pem and browser-cert.pem.
 * - port and bind are where the gate listens. upstreamPort is the browser server's port on 127.0.0.1; 0 lets the
 *   operating system pick one, and the host uses the port the browser server announces either way.
 * - runServer({ port, path, env }) starts the browser server and returns a child-process-like object: stdout (a
 *   stream on which the server prints "Listening on ws://127.0.0.1:<port><path>"), on('exit'), kill(signal) and, for a
 *   real process, pid. env is the host's environment without the variables that hold the token. For tests.
 * - startTimeoutMs is how long the browser server may take to announce its address. For tests.
 * Resolves with { port, fingerprint, exited, stop }: the gate's port, the certificate's SHA-256 fingerprint, a promise
 * of the exit code (1 once the browser server has exited on its own, 0 once stop() has finished) and stop(), which
 * closes the gate, ends open sessions and ends the browser server's process tree.
 * Rejects, with nothing left running, when a parameter or a file in dataDir is not usable, the browser server does not
 * come up, it tells its path to a plain request, or the gate cannot listen.
 */
export async function startHost({
  dataDir, port = 3000, bind = '0.0.0.0', upstreamPort = 0, maxSessions = 1, runServer = runBrowserServer, log = console.log,
  startTimeoutMs = START_TIMEOUT_MS,
}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('dataDir must name the data directory');
  if (!validPort(port)) throw new Error('port must be a whole number from 0 to 65535');
  if (!validPort(upstreamPort)) throw new Error('upstreamPort must be a whole number from 0 to 65535');
  if (typeof bind !== 'string' || isIP(bind) === 0) throw new Error('bind must be an IP address');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS_LIMIT) {
    throw new Error(`maxSessions must be a whole number from 1 to ${MAX_SESSIONS_LIMIT}`);
  }
  // The token before the certificate, and both before anything is started: a start that is refused creates nothing.
  const token = readToken(dataDir);
  const { key, cert, fingerprint } = certificate(dataDir);

  const path = `/${randomBytes(16).toString('hex')}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => !value.includes(token)));
  const child = runServer({ port: upstreamPort, path, env });
  let ended;
  const gone = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      ended ??= code === null ? `signal ${signal}` : `exit code ${code}`;
      resolve();
    });
    // A process that could not be started has no id and never exits; any other error leaves it running.
    child.on('error', (err) => {
      if (child.pid !== undefined) return;
      ended ??= `it could not be started: ${err.code ?? 'error'}`;
      resolve();
    });
  });
  const endBrowserServer = () => endProcessTree(child, gone, () => ended !== undefined);

  let upstream;
  try {
    upstream = await announcedPort(child, path, gone.then(() => ended), startTimeoutMs);
    if (await tellsItsPath(upstream, path)) throw new Error('the browser server answers a plain request with its path; not starting');
  } catch (err) {
    await endBrowserServer();
    throw err;
  }

  const gate = createGate({ token, upstreamPort: upstream, upstreamPath: path, maxSessions, metricsPort: 0, tls: { key, cert } });
  // Every connection is kept until it closes, so closing the gate can end them all: an accepted session is no longer
  // among the connections the server itself closes.
  const sockets = new Set();
  gate.server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      gate.server.once('error', reject);
      gate.server.listen(port, bind, () => {
        gate.server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await endBrowserServer();
    throw new Error(`cannot listen on port ${port}: ${err.code ?? err.message}`);
  }
  const listeningPort = gate.server.address().port;
  log(`RPA browser listening on wss://${bind.includes(':') ? `[${bind}]` : bind}:${listeningPort}, fingerprint ${fingerprint}`);

  const closeGate = () => new Promise((resolve) => {
    gate.server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  });
  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  let stopping;
  gone.then(async () => {
    if (stopping) return;
    await closeGate();
    finish(1);
  });
  const stop = () => {
    stopping ??= (async () => {
      await closeGate();
      await endBrowserServer();
      finish(0);
    })();
    return stopping;
  };
  return { port: listeningPort, fingerprint, exited, stop };
}

// The loader resolves symlinks in the entry path; argv[1] keeps them, so compare real paths.
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const fail = (message) => {
    console.error(`RPA browser: ${message}`);
    process.exit(1);
  };
  /** A whole-number env value within [min, max], or the default when unset or empty; exits 1 with the rule otherwise. */
  const intEnv = (name, fallback, min, max) => {
    const raw = (process.env[name] ?? '').trim();
    if (raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    return fail(`${name} must be a whole number from ${min} to ${max}`);
  };
  const programData = process.platform === 'win32' ? process.env.ProgramData ?? '' : '';
  const dataDir = (process.env.RPA_BROWSER_DATA_DIR ?? '') || (programData === '' ? '' : join(programData, 'RPA Runner'));
  if (dataDir === '') fail('RPA_BROWSER_DATA_DIR is not set');
  const port = intEnv('RPA_BROWSER_PORT', 3000, 1, 65_535);
  const maxSessions = intEnv('RPA_BROWSER_MAX_SESSIONS', 1, 1, MAX_SESSIONS_LIMIT);
  const bind = (process.env.RPA_BROWSER_BIND ?? '').trim() || '0.0.0.0';
  if (isIP(bind) === 0) fail('RPA_BROWSER_BIND must be an IP address');

  // A signal during the start is kept and acted on once the host is up. Windows delivers Ctrl+C as SIGINT and
  // Ctrl+Break as SIGBREAK; it has no SIGTERM, and a process ended by another one gets no signal at all.
  let host;
  let stopAsked = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      stopAsked = true;
      host?.stop();
    });
  }
  try {
    host = await startHost({ dataDir, port, bind, maxSessions });
  } catch (err) {
    fail(err.message);
  }
  if (stopAsked) host.stop();
  const code = await host.exited;
  if (code !== 0) console.error('RPA browser: the browser server stopped; exiting');
  process.exit(code);
}
