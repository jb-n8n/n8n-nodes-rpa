// The launcher of the browser server (Playwright's run-server) under the browser host (host.mjs). No dependencies of
// its own; it loads Playwright's CLI from ../node_modules/playwright/cli.js.
//
// Why a launcher: Playwright's CLI takes the server's path only as an argument (--path), and a process's command line
// can be read by other users of the machine. Whoever knows the server's port and path can drive the browser without the
// token. So the host starts `node run-server.mjs` and gives the path and the port in two environment variables of this
// process only. This file removes them from its environment (the browsers the server launches inherit the environment),
// puts the arguments into process.argv inside the process and loads the CLI. The command line the operating system
// shows stays `node run-server.mjs`.
//
// More happens here, all of it before any Playwright code runs:
// - Module loading is limited to the install: the folder that holds host/, gate/ and node_modules/. Node looks for a
//   module that is not installed in the node_modules of every folder above the one that asks, up to the root of the
//   drive (C:\node_modules on Windows, where any user of the machine may create a folder), then in the folders NODE_PATH
//   names and a few in the home and Node folders. Playwright's bundled ws asks for bufferutil and utf-8-validate that
//   way, and they are not installed; a module planted in one of those places would run inside the browser server, which
//   sees every password typed into the browser. So: ws is told not to ask (WS_NO_BUFFER_UTIL, WS_NO_UTF_8_VALIDATE);
//   NODE_PATH is removed; the folders require() searches are cut down to those inside the install; and whatever
//   require() or import resolves to, a file outside the install is answered "not found". Without the Node functions
//   this needs (Node 22.15 or later has them) the launcher does not start.
// - Every plain HTTP request to the server is answered 404 by this file. Playwright 1.63's run-server answers
//   GET /json with its path, to anyone who can connect to its port; on a machine with other users that would hand them
//   the path. The host checks this at every start and does not start otherwise.
// - A WebSocket upgrade reaches Playwright only when its target, up to the query, is exactly the path. The connection
//   of any other upgrade is closed here. Playwright 1.63 ends with an uncaught error on an upgrade whose target is not
//   a URL path (`*@`), so one request from any user of the machine would stop the browser server and the host.
// - On Windows, Chromium is started with its sandbox. Playwright adds --no-sandbox to every Chromium it starts unless
//   the client asks for the sandbox, and the run-server drops that option of a client. Without the sandbox, code that
//   gets out of a page runs as the account of the host, which can read the token and the key and drive the desktop. So
//   on win32 this file takes --no-sandbox out of the arguments of every process the browser server starts. Other
//   platforms are left as they are: in the rpa-browser image the container is around the browser.
// - When stdin ends, the process exits. The host holds the other end of that pipe and never writes to it, so stdin ends
//   when the host is gone, however it ended (on Windows the start script ends the host without a signal). The exit runs
//   Playwright's own exit handlers, which end the browsers it launched. Start this file with a pipe on stdin: with no
//   stdin at all it exits at once.
import childProcess from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import Module, { createRequire } from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exit code: this Node cannot limit module loading to the install. The host turns it into a line of its own. */
const EXIT_CANNOT_LIMIT_MODULES = 69;

const path = process.env.RPA_RUN_SERVER_PATH ?? '';
const port = process.env.RPA_RUN_SERVER_PORT ?? '';
delete process.env.RPA_RUN_SERVER_PATH;
delete process.env.RPA_RUN_SERVER_PORT;
if (!/^\/[0-9a-f]{32}$/.test(path) || !/^\d{1,5}$/.test(port)) {
  console.error('run-server: the browser host starts this file and gives it a path and a port');
  process.exit(2);
}

process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';
delete process.env.NODE_PATH;
const installRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const insidePrefix = installRoot.endsWith(sep) ? installRoot : installRoot + sep;
const inInstall = (file) => file.startsWith(insidePrefix);
const { _nodeModulePaths: nodeModulePaths, _resolveLookupPaths: resolveLookupPaths } = Module;
if (typeof nodeModulePaths !== 'function' || typeof resolveLookupPaths !== 'function' || typeof Module.registerHooks !== 'function') {
  console.error('run-server: this Node cannot limit module loading to the install; Node 22.15 or later is needed');
  process.exit(EXIT_CANNOT_LIMIT_MODULES);
}
// The node_modules folders above a file, and the full list require() searches for a name (the first list plus the
// folders of NODE_PATH, the home folder and the Node folder): only folders inside the install stay in either.
Module._nodeModulePaths = (from) => nodeModulePaths.call(Module, from).filter(inInstall);
Module._resolveLookupPaths = (request, parent) => resolveLookupPaths.call(Module, request, parent)?.filter(inInstall) ?? null;
// import looks for a name in the folders above the importing file without asking the two functions above, so the
// result of every resolution, by require() or import, is checked as well.
Module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith('file:') || inInstall(fileURLToPath(resolved.url))) return resolved;
    const notFound = new Error(`Cannot find module '${specifier}' inside ${installRoot}`);
    notFound.code = context.conditions.includes('import') ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND';
    throw notFound;
  },
});

process.stdin.once('end', () => process.exit(0));
process.stdin.once('error', () => process.exit(0));
process.stdin.resume();

if (process.platform === 'win32') {
  const { spawn } = childProcess;
  childProcess.spawn = function spawnWithoutNoSandbox(command, args, options) {
    return spawn.call(this, command, Array.isArray(args) ? args.filter((arg) => arg !== '--no-sandbox') : args, options);
  };
}

/** Whether the target of an upgrade request, up to its query, is the path of this start. */
const pathBytes = Buffer.from(path);
function isForThePath(target) {
  if (typeof target !== 'string') return false;
  const query = target.indexOf('?');
  const asked = Buffer.from(query === -1 ? target : target.slice(0, query));
  return asked.length === pathBytes.length && timingSafeEqual(asked, pathBytes);
}
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function emitOnlyUpgradesForThePath(event, ...args) {
  if (event === 'request') {
    const response = args[1];
    response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
    response.end('not found\n');
    return true;
  }
  if (event === 'upgrade' && !isForThePath(args[0]?.url)) {
    args[1]?.destroy();
    return true;
  }
  return emit.call(this, event, ...args);
};

const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));
process.argv.splice(1, Infinity, cli, 'run-server', '--port', port, '--host', '127.0.0.1', '--path', path);
createRequire(import.meta.url)(cli);
