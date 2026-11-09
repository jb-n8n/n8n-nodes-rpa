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
// Two more things happen here, both before any Playwright code runs:
// - Every plain HTTP request to the server is answered 404 by this file. Playwright 1.63's run-server answers
//   GET /json with its path, to anyone who can connect to its port; on a machine with other users that would hand them
//   the path. Only WebSocket upgrades reach Playwright. The host checks this at every start and does not start
//   otherwise.
// - When stdin ends, the process exits. The host holds the other end of that pipe and never writes to it, so stdin ends
//   when the host is gone, however it ended (on Windows the start script ends the host without a signal). The exit runs
//   Playwright's own exit handlers, which end the browsers it launched. Start this file with a pipe on stdin: with no
//   stdin at all it exits at once.
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const path = process.env.RPA_RUN_SERVER_PATH ?? '';
const port = process.env.RPA_RUN_SERVER_PORT ?? '';
delete process.env.RPA_RUN_SERVER_PATH;
delete process.env.RPA_RUN_SERVER_PORT;
if (!/^\/[0-9a-f]{32}$/.test(path) || !/^\d{1,5}$/.test(port)) {
  console.error('run-server: the browser host starts this file and gives it a path and a port');
  process.exit(2);
}

process.stdin.once('end', () => process.exit(0));
process.stdin.once('error', () => process.exit(0));
process.stdin.resume();

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function emitUnlessPlainRequest(event, ...args) {
  if (event !== 'request') return emit.call(this, event, ...args);
  const response = args[1];
  response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
  response.end('not found\n');
  return true;
};

const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));
process.argv.splice(1, Infinity, cli, 'run-server', '--port', port, '--host', '127.0.0.1', '--path', path);
createRequire(import.meta.url)(cli);
