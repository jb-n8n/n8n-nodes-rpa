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
// - The browser server loads modules only from the install (the folder that holds host/, gate/ and node_modules/), not
//   from folders above it or from NODE_PATH, where another user of the machine could put one (run-server.mjs).
// - The browser server is started without the token: variables of the host's environment that hold it are not passed
//   on, so neither the browser server nor the browsers it launches hold the token. NODE_OPTIONS is not passed on
//   either, and the browser server's current folder is the install.
// - The gate always serves TLS. n8n connects with wss and a bearer token and checks the certificate by its SHA-256
//   fingerprint, which the start line shows. There is no plain-text mode.
//
// Files in the data directory (who may read and write them is up to the directory's access rules; the installer sets them):
// - browser-token: the bearer token, at least 32 characters of ASCII text without spaces. Read at start, never printed.
// - browser-key.pem and browser-cert.pem: the gate's key and self-signed certificate. Created together at the first
//   start (the key with mode 0600 where the platform has file modes) and reused after that, so the fingerprint stays
//   the same. With only one of the two present the host does not start. Each is written under a temporary name
//   (browser-key.pem.<16 hex>.tmp) and renamed; a start removes temporary files an earlier start left. After creating
//   them the host reads both back and serves what is on disk.
// - One host per data directory. Two that start at once on a directory without a certificate each create one; the host
//   then serves the pair it finds on disk, or does not start when the two files are not a pair.
//
// browser-temp, the temp folder of the browser server and its browsers (TEMP, TMP and TMPDIR of that process only):
// - Playwright keeps a session's trace, downloads and browser profile there, and a trace holds what was typed into
//   pages. So the folder is one that only the account of the host can use, without relying on how the data directory
//   was set up:
//   - On Windows: %LOCALAPPDATA%\RPA Runner\browser-temp, in the profile of the account the host runs as (a profile
//     is for its user only unless someone changed that). Without LOCALAPPDATA the host does not start; it uses no
//     other place.
//   - Elsewhere: <data directory>/browser-temp, created with mode 0700. With an existing folder that group or others
//     can use the host does not start.
//   The host does not start either when the folder, or a folder above it up to the profile (elsewhere: up to the data
//   directory), is a link or a file.
// - The host creates the folder, and empties it at every start before the browser server is started, after the browser
//   server's processes have ended in a stop, and when the browser server exits on its own. A host that is ended
//   without a chance to stop leaves what Playwright did not remove itself until the next start. Emptying removes a
//   link (a junction too) and never what it points at.
// - One host per data directory and, on Windows, per account: a second one would empty the first one's folder.
//
// Order and stopping:
// - The browser server starts first; the gate listens only once the browser server has printed its address.
// - The browser server exits: the gate closes at once and the host exits 1, so whatever started it starts it again.
//   When it exits while the host is still starting, the start fails and no start line is printed.
// - Ctrl+C (SIGINT), SIGTERM, SIGHUP or Ctrl+Break: the gate closes (open sessions end); the browser server is asked
//   to exit by ending its stdin, which lets Playwright end its browsers and remove its temp folders; if it has not
//   exited after a short wait its process tree is ended (taskkill /T /F on Windows; SIGTERM, then SIGKILL elsewhere);
//   browser-temp is emptied; exit 0. On Windows a process is usually ended without a signal; then no code of the host
//   runs, and the browser server ends by itself because its stdin, a pipe from the host, ends (run-server.mjs).
//   A stop asked for while the host is starting is acted on once the start has finished; if the start fails instead,
//   the host exits 0 without an error line.
//
// Environment of the main block: RPA_BROWSER_DATA_DIR (default %ProgramData%\RPA Runner on Windows; no default
// elsewhere), RPA_BROWSER_PORT (3000), RPA_BROWSER_BIND (0.0.0.0, an IP address), RPA_BROWSER_MAX_SESSIONS (1).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { MAX_SESSIONS_LIMIT, MIN_TOKEN_LENGTH, createGate } from '../gate/gate.mjs';
import { fingerprintOfPem, selfSignedCert } from '../gate/selfsigned.mjs';

const TOKEN_FILE = 'browser-token';
const KEY_FILE = 'browser-key.pem';
const CERT_FILE = 'browser-cert.pem';
const TEMP_DIR = 'browser-temp';
/** On Windows browser-temp is in this folder of the account's local application data. */
const LOCAL_FOLDER = 'RPA Runner';
/** The variables that name the temp folder: Node and Chromium read TEMP and TMP on Windows, TMPDIR elsewhere. */
const TEMP_VARIABLES = ['TEMP', 'TMP', 'TMPDIR'];
const TOKEN_RULE = `${TOKEN_FILE} must hold at least ${MIN_TOKEN_LENGTH} characters of ASCII text without spaces`;
const NEW_CERTIFICATE_HINT = 'delete both to create a new certificate (the fingerprint changes)';
/** The names under which the key and the certificate are written before they are renamed. */
const TEMPORARY_FILE = /^browser-(?:key|cert)\.pem\.[0-9a-f]{16}\.tmp$/;
const LAUNCHER_FILE = fileURLToPath(new URL('./run-server.mjs', import.meta.url));
/** Where run-server.mjs loads Playwright from. */
const NODE_MODULES = fileURLToPath(new URL('../node_modules', import.meta.url));
/** The install: the folder that holds host/, gate/ and node_modules/. The browser server runs with it as its current folder. */
const INSTALL_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** How long the browser server may take to print its address. */
const START_TIMEOUT_MS = 30_000;
/** How long the check of the browser server's plain HTTP answer may take (never longer than the start may take). */
const PLAIN_CHECK_MS = 5000;
/**
 * The unit of the waits when the browser server is ended. It gets 5 of them to exit after its stdin ended; then, where
 * signals are used, one after each SIGTERM; and 5 after a kill that cannot be ignored. Emptying browser-temp is tried
 * for 5 of them.
 */
const STOP_WAIT_MS = 1000;
/** On stop: SIGTERM this many times, then SIGKILL (the run-server ignores a SIGTERM that arrives while it closes a browser). */
const TERM_ATTEMPTS = 5;
/** How often emptying browser-temp is tried: on Windows a file stays in use for a moment after its process has ended. */
const EMPTY_ATTEMPTS = 20;
/** Exit codes with which run-server.mjs says why it did not start the browser server, and the host's line for each. */
const LAUNCHER_EXITS = new Map([
  [66, `Playwright is not installed, or not completely, in ${NODE_MODULES}`],
  [69, 'the browser server cannot limit module loading to the install with this Node; Node 22.15 or later is needed'],
]);
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

/** Removes a file if it is there; a failure is not reported (this is only used to clean up). */
function removeQuietly(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing more can be done about it here.
  }
}

/** Creates a file that does not exist yet and writes it to the disk before returning; if that fails, the file is removed. */
function writeNewFile(path, text, mode) {
  const fd = openSync(path, 'wx', mode);
  try {
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    removeQuietly(path);
    throw err;
  }
}

/**
 * The gate's key and certificate from the data directory: { key, cert, fingerprint }. With neither file there, both are
 * created: written under temporary names first, then renamed, so a host that is ended in between leaves no half-written
 * file under a final name; if anything fails, what was written is removed. Temporary files of an earlier start that was
 * ended in between are removed first. What is returned is always read from the two files, after creating them as well:
 * with one file there, or a pair that is not a key and its certificate, it throws.
 */
function certificate(dataDir) {
  const keyPath = join(dataDir, KEY_FILE);
  const certPath = join(dataDir, CERT_FILE);
  let names = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    // The data directory cannot be listed: the reads and writes below say why.
  }
  for (const name of names) if (TEMPORARY_FILE.test(name)) removeQuietly(join(dataDir, name));
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
      for (const path of written) removeQuietly(path);
      throw new Error(`cannot create ${KEY_FILE} and ${CERT_FILE}: ${err.code ?? 'error'}`);
    }
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
 * Where browser-temp is: { base, parts }, the folder it is looked for from and the names below it down to browser-temp.
 * On Windows that is the local application data of the account, from the profile down when it is inside the profile;
 * elsewhere the data directory.
 */
function browserTempPlace(dataDir) {
  if (process.platform !== 'win32') return { base: resolve(dataDir), parts: [TEMP_DIR] };
  const local = process.env.LOCALAPPDATA ?? '';
  if (!isAbsolute(local)) {
    throw new Error(`LOCALAPPDATA is not set to a folder; the browser host keeps ${TEMP_DIR} there (%LOCALAPPDATA%\\${LOCAL_FOLDER}\\${TEMP_DIR}) and uses no other place`);
  }
  const profile = process.env.USERPROFILE ?? '';
  const below = isAbsolute(profile) ? relative(profile, local) : '';
  if (below === '' || below.startsWith('..') || isAbsolute(below)) return { base: resolve(local), parts: [LOCAL_FOLDER, TEMP_DIR] };
  return { base: resolve(profile), parts: [...below.split(sep), LOCAL_FOLDER, TEMP_DIR] };
}

/**
 * Whether a path is a folder itself and not a link to one. lstat does not follow a link and reports a junction as a
 * link, with one exception on Windows: a junction whose target is written as a volume GUID path it reports as a folder
 * (Node 22). The listing of the folder above reports every reparse point as a link there. So on Windows both must say
 * "folder".
 */
function isOwnFolder(path) {
  if (!lstatSync(path).isDirectory()) return false;
  if (process.platform !== 'win32') return true;
  // Windows takes the names of files without regard to case.
  const name = basename(path).toLowerCase();
  const entry = readdirSync(dirname(path), { withFileTypes: true }).find((each) => each.name.toLowerCase() === name);
  return entry !== undefined && entry.isDirectory();
}

/**
 * The temp folder of the browser server, created when it is missing, with the folders above it. Throws when a name on
 * the way is taken by a link or a file: the host would empty, and the browsers would write to, whatever the link points
 * at. Throws as well where there are file modes and the folder is open to group or others.
 */
function browserTempFolder(dataDir) {
  const { base, parts } = browserTempPlace(dataDir);
  let folder = base;
  for (const part of parts) {
    folder = join(folder, part);
    let found;
    try {
      found = lstatSync(folder, { throwIfNoEntry: false });
      if (found !== undefined && !isOwnFolder(folder)) found = null;
    } catch (err) {
      throw new Error(`cannot use ${folder}: ${err.code ?? 'error'}`);
    }
    if (found === undefined) {
      try {
        mkdirSync(folder, { mode: 0o700 });
      } catch (err) {
        throw new Error(`cannot create ${folder}: ${err.code ?? 'error'}`);
      }
    } else if (found === null) {
      throw new Error(`${folder} must be a folder of its own, not a link or a file`);
    } else if (process.platform !== 'win32' && part === TEMP_DIR && (found.mode & 0o077) !== 0) {
      throw new Error(`${folder} must be for its owner only (mode 700); change its mode or remove it`);
    }
  }
  return folder;
}

/**
 * Removes an entry that is not a folder of its own: a file, or a link, which goes while what it points at stays. unlink
 * does not take a directory, and for Windows a junction is one; Node's unlink takes only those it can read as a link.
 * rmdir removes such a junction itself and never what is behind it (on a folder with content it fails).
 */
function removeEntry(path) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EISDIR') throw err;
    try {
      rmdirSync(path);
    } catch {
      throw err;
    }
  }
}

/**
 * Removes everything in a folder without following a link. The folder is checked with lstat directly before it is
 * listed: it may have become a link since it was last looked at. An entry is entered only when the listing and lstat
 * both report a folder (see isOwnFolder); anything else is removed as it is.
 */
function removeContent(folder) {
  if (!lstatSync(folder).isDirectory()) throw Object.assign(new Error(`${folder} is not a folder`), { code: 'ENOTDIR' });
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory() && lstatSync(path).isDirectory()) {
      removeContent(path);
      rmdirSync(path);
    } else {
      removeEntry(path);
    }
  }
}

/** Empties the folder, trying again for up to 5 waits. Resolves with undefined, or with the error code of the last try. */
async function emptied(folder, waitMs) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A folder that is gone holds nothing.
      if (lstatSync(folder, { throwIfNoEntry: false }) === undefined) return undefined;
      // It was a folder of its own at the start; it is looked at again each time, long after.
      if (!isOwnFolder(folder)) return 'ENOTDIR';
      removeContent(folder);
      return undefined;
    } catch (err) {
      if (attempt === EMPTY_ATTEMPTS) return err.code ?? 'error';
    }
    await new Promise((done) => setTimeout(done, (5 * waitMs) / EMPTY_ATTEMPTS));
  }
}

/**
 * Starts Playwright's run-server through run-server.mjs. The path and the port go in two variables of that process's
 * environment, never on its command line. stdin is a pipe the host never writes to: it ends when the host is gone, and
 * the launcher exits then. stdout is a pipe the host reads the address from; stderr is dropped. Its current folder is
 * the install, whatever folder the host was started in: Playwright ends its browsers on Windows with a bare `taskkill`
 * through cmd.exe, and cmd.exe looks for a program in the current folder before it looks along PATH.
 */
function runBrowserServer({ port, path, env }) {
  return spawn(process.execPath, [LAUNCHER_FILE], {
    cwd: INSTALL_ROOT,
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
 * address holds the path. Rejects when the server ends first (`ended` resolves with the message) or the time passes.
 */
function announcedPort(child, path, ended, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the browser server did not report its address within ${timeoutMs / 1000} s`)), timeoutMs);
    ended.then((message) => {
      clearTimeout(timer);
      reject(new Error(message));
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
function tellsItsPath(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/json', agent: false, timeout: timeoutMs }, (res) => {
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
 * Ends the browser server and the processes under it. First its stdin is ended: run-server.mjs exits then, in the way
 * that lets Playwright end its browsers and remove their profiles and the traces and downloads of open sessions. If it
 * has not exited after 5 waits, the tree is ended. On Windows a child's kill() ends that one process and the browsers it
 * launched would stay, so the tree is ended with taskkill (by its full path: a bare name would also be looked for in
 * the current directory). Elsewhere the run-server closes its browsers on SIGTERM. `gone` settles when the child has
 * exited and `isGone` says so at once: a process that has exited is never signalled, its id may be another process's by
 * then.
 */
async function endProcessTree(child, gone, isGone, waitMs) {
  if (isGone()) return;
  if (typeof child.stdin?.end === 'function') {
    // The pipe may break while it is closed; the process is going away either way.
    child.stdin.on?.('error', () => {});
    child.stdin.end();
    if (await settledWithin(gone, 5 * waitMs)) return;
  }
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((resolve) => {
      const taskkill = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      taskkill.once('error', resolve);
      taskkill.once('exit', resolve);
    });
    if (await settledWithin(gone, 5 * waitMs)) return;
  }
  for (let attempt = 0; attempt < TERM_ATTEMPTS; attempt += 1) {
    child.kill('SIGTERM');
    if (await settledWithin(gone, waitMs)) return;
  }
  child.kill('SIGKILL');
  await settledWithin(gone, 5 * waitMs);
}

/**
 * Starts the browser server, then the gate with TLS in front of it, and logs the start line.
 * - dataDir holds browser-token and, after the first start, browser-key.pem and browser-cert.pem; except on Windows
 *   also browser-temp (see the top of this file).
 * - port and bind are where the gate listens. upstreamPort is the browser server's port on 127.0.0.1; 0 lets the
 *   operating system pick one, and the host uses the port the browser server announces either way.
 * - runServer({ port, path, env }) starts the browser server and returns a child-process-like object: stdout (a
 *   stream on which the server prints "Listening on ws://127.0.0.1:<port><path>"), stdin (ended to ask the server to
 *   exit), on('exit'), kill(signal) and, for a real process, pid. env is the host's environment without the variables
 *   that hold the token and without NODE_OPTIONS, with browser-temp as the temp folder. For tests.
 * - warn gets a line when browser-temp could not be emptied after the browser server ended.
 * - startTimeoutMs is how long the browser server may take to announce its address, and stopWaitMs the unit of the
 *   waits when it is ended (STOP_WAIT_MS). For tests.
 * Resolves with { port, fingerprint, exited, stop }: the gate's port, the certificate's SHA-256 fingerprint, a promise
 * of the exit code (1 once the browser server has exited on its own, 0 once stop() has finished) and stop(), which
 * closes the gate, ends open sessions, ends the browser server's process tree and empties browser-temp.
 * Rejects, with nothing left running, when a parameter or a file in dataDir is not usable, browser-temp cannot be
 * used or emptied, the browser server does not come up, it tells its path to a plain request, or the gate cannot listen.
 */
export async function startHost({
  dataDir, port = 3000, bind = '0.0.0.0', upstreamPort = 0, maxSessions = 1, runServer = runBrowserServer, log = console.log,
  warn = (line) => console.error(`RPA browser: ${line}`), startTimeoutMs = START_TIMEOUT_MS, stopWaitMs = STOP_WAIT_MS,
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
  // What an earlier session left (a host that is ended without a chance to stop removes nothing) goes before a new
  // browser server is started.
  const browserTemp = browserTempFolder(dataDir);
  const notEmptied = await emptied(browserTemp, stopWaitMs);
  if (notEmptied !== undefined) throw new Error(`cannot empty ${browserTemp}: ${notEmptied}`);

  const path = `/${randomBytes(16).toString('hex')}`;
  // Windows takes the names of variables without regard to case.
  const sameName = (name) => (process.platform === 'win32' ? name.toUpperCase() : name);
  // NODE_OPTIONS is not passed on either: it can name a file that Node loads before run-server.mjs limits what is loaded.
  const dropped = (name) => TEMP_VARIABLES.includes(sameName(name)) || sameName(name) === 'NODE_OPTIONS';
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => !value.includes(token) && !dropped(name)));
  for (const name of TEMP_VARIABLES) env[name] = browserTemp;
  const child = runServer({ port: upstreamPort, path, env });
  let ended;
  let exitCode;
  const gone = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      ended ??= code === null ? `signal ${signal}` : `exit code ${code}`;
      exitCode = code;
      resolve();
    });
    // A process that could not be started has no id and never exits; any other error leaves it running.
    child.on('error', (err) => {
      if (child.pid !== undefined) return;
      ended ??= `it could not be started: ${err.code ?? 'error'}`;
      resolve();
    });
  });
  const endBrowserServer = () => endProcessTree(child, gone, () => ended !== undefined, stopWaitMs);
  /** After the browser server's processes have ended: what its sessions kept in browser-temp is removed. */
  const emptyBrowserTemp = async () => {
    const code = await emptied(browserTemp, stopWaitMs);
    if (code !== undefined) warn(`${browserTemp} could not be emptied (${code}); the next start empties it`);
  };

  // Every connection of the gate is kept until it closes, so closing the gate can end them all: an accepted session is
  // no longer among the connections the server itself closes.
  let gate;
  const sockets = new Set();
  const closeGate = () => new Promise((resolve) => {
    gate.server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  });
  /** The browser server may exit at any moment of the start; the gate must not come up, or be announced, without it. */
  const failIfStopped = () => {
    if (ended !== undefined) throw new Error(`the browser server stopped during the start (${ended})`);
  };
  let listeningPort;
  try {
    const stoppedEarly = () => LAUNCHER_EXITS.get(exitCode) ?? `the browser server stopped before it was listening (${ended})`;
    const upstream = await announcedPort(child, path, gone.then(stoppedEarly), startTimeoutMs);
    if (await tellsItsPath(upstream, path, Math.min(PLAIN_CHECK_MS, startTimeoutMs))) throw new Error('the browser server answers a plain request with its path; not starting');
    failIfStopped();
    gate = createGate({ token, upstreamPort: upstream, upstreamPath: path, maxSessions, metricsPort: 0, tls: { key, cert } });
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
      throw new Error(`cannot listen on port ${port}: ${err.code ?? err.message}`);
    }
    listeningPort = gate.server.address().port;
    failIfStopped();
  } catch (err) {
    if (gate?.server.listening) await closeGate();
    await endBrowserServer();
    throw err;
  }
  log(`RPA browser listening on wss://${bind.includes(':') ? `[${bind}]` : bind}:${listeningPort}, fingerprint ${fingerprint}`);

  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  let stopping;
  gone.then(async () => {
    if (stopping) return;
    await closeGate();
    await emptyBrowserTemp();
    finish(1);
  });
  const stop = () => {
    stopping ??= (async () => {
      await closeGate();
      await endBrowserServer();
      await emptyBrowserTemp();
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

  // A signal during the start is kept and acted on once the start has finished. Windows delivers Ctrl+C as SIGINT and
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
    // A stop was asked for and the start did not finish (Ctrl+C reaches the browser server as well): nothing is
    // running, which is what was asked for.
    if (stopAsked) process.exit(0);
    fail(err.message);
  }
  if (stopAsked) host.stop();
  const code = await host.exited;
  if (code !== 0) console.error('RPA browser: the browser server stopped; exiting');
  process.exit(code);
}
