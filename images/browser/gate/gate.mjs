// Bearer-token gate in front of a Playwright run-server. No dependencies.
// The run-server listens on 127.0.0.1 inside its container, on a random path generated at container start; only
// this gate is reachable on the compose network. A WebSocket upgrade is forwarded byte for byte, to that path, only
// when it carries "Authorization: Bearer <token>", asks for no launch option outside a short allowlist and does not
// ask the browser to use the client's network. Everything else is refused. The path is never logged or echoed.
//
// As a scalable browser service, each replica takes at most maxSessions sessions at a time and answers the rest
// 503 + "X-RPA-Browser: busy" (the engine waits and retries); GET /healthz reports whether this replica should get new
// sessions; Prometheus metrics (session counts and refusals only, never a header, path or token) are on their own port;
// on SIGTERM the gate drains: it refuses new sessions (503 "draining", /healthz 503) and exits once the open ones end
// or the drain time passes. On Amazon ECS it can also keep its task protected from scale-in while sessions are open and
// print CloudWatch EMF metrics (ecs.mjs; both off by default).
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVICE_NAME_RULE, protectionMinutes, startEmf, taskProtection, validAgentUri, validServiceName } from './ecs.mjs';

export const MIN_TOKEN_LENGTH = 32;
/** Characters of the random run-server path after the leading "/" (32 hex characters = 128 bits). */
export const MIN_UPSTREAM_PATH_SECRET = 32;
/**
 * The only launch options a client may send (x-playwright-launch-options header or launch-options query), with the
 * value type each must have. executablePath, args, ignoreDefaultArgs, env, proxy and the rest are refused: the
 * run-server drops some of them on its own, but the gate does not rely on that.
 */
const LAUNCH_OPTION_CHECKS = {
  headless: (v) => typeof v === 'boolean',
  timeout: (v) => Number.isFinite(v) && v >= 0,
  slowMo: (v) => Number.isFinite(v) && v >= 0,
};
export const ALLOWED_LAUNCH_OPTIONS = Object.freeze(Object.keys(LAUNCH_OPTION_CHECKS));

const UPSTREAM_PATH = new RegExp(`^/[A-Za-z0-9_-]{${MIN_UPSTREAM_PATH_SECRET},}$`);
const UPSTREAM_PATH_RULE = `BROWSER_UPSTREAM_PATH must be "/" followed by at least ${MIN_UPSTREAM_PATH_SECRET} letters, digits, "-" or "_"`;

/** Timing-safe check of an Authorization header against the token (length checked first, as timingSafeEqual needs). */
function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer (\S+)$/.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A launch-options value is acceptable when absent or empty, or a JSON object whose keys and values pass the allowlist. */
function launchOptionsAllowed(value) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.entries(parsed).every(([k, v]) => Object.hasOwn(LAUNCH_OPTION_CHECKS, k) && LAUNCH_OPTION_CHECKS[k](v));
}

/** Whether an authorised upgrade asks only for what the gate allows. Duplicate headers arrive joined, so they fail to parse. */
function requestAllowed(req, url) {
  const queryOptions = url.searchParams.getAll('launch-options');
  if (queryOptions.length > 1 || !queryOptions.every(launchOptionsAllowed)) return false;
  if (!launchOptionsAllowed(req.headers['x-playwright-launch-options'])) return false;
  // exposeNetwork: a non-empty value makes the browser reach the network through the client (here: n8n's loopback).
  const proxyHeader = req.headers['x-playwright-proxy'];
  if (proxyHeader !== undefined && proxyHeader !== '') return false;
  if (url.searchParams.getAll('proxy').some((p) => p !== '')) return false;
  return true;
}

const refuse = (socket, status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());

/**
 * 503 to an upgrade this replica cannot take now: `busy` (every session is in use) or `draining` (shutting down). The
 * engine retries on exactly this status and X-RPA-Browser value; the body repeats the state for clients whose connect
 * error shows the response body but not its headers.
 */
function unavailable(socket, state) {
  const body = `rpa-browser ${state}\n`;
  socket.end(
    `HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nX-RPA-Browser: ${state}\r\nContent-Type: text/plain\r\n` +
      `Connection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    () => socket.destroy(),
  );
}

export const MAX_SESSIONS_LIMIT = 64;
const MAX_SESSIONS_RULE = `must be a whole number from 1 to ${MAX_SESSIONS_LIMIT}`;
const validSessions = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS_LIMIT;
const REFUSAL_REASONS = Object.freeze(['capacity', 'draining', 'unauthorized', 'forbidden', 'bad_request']);
/** How long /healthz waits for a TCP connect to the run-server. */
const HEALTH_CONNECT_MS = 1000;
/** How long a session's connect to the run-server may take before the attempt (and the client connection) is dropped. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
/** TCP keepalive on session sockets, so a peer that vanished without a FIN (a dead NAT entry, a lost host) is noticed. */
const KEEPALIVE_MS = 30_000;
const sessionsOpen = (n) => `${n} ${n === 1 ? 'session' : 'sessions'} open`;

/** The Prometheus text exposition (format 0.0.4) of the gate's counts. Only numbers and fixed names: nothing a client sent. */
function metricsText(s) {
  const lines = [
    '# HELP rpa_browser_sessions_active Browser sessions open on this replica.',
    '# TYPE rpa_browser_sessions_active gauge',
    `rpa_browser_sessions_active ${s.active}`,
    '# HELP rpa_browser_sessions_capacity Browser sessions this replica takes at most.',
    '# TYPE rpa_browser_sessions_capacity gauge',
    `rpa_browser_sessions_capacity ${s.capacity}`,
    '# HELP rpa_browser_draining 1 while this replica is shutting down and refuses new sessions.',
    '# TYPE rpa_browser_draining gauge',
    `rpa_browser_draining ${s.draining ? 1 : 0}`,
    '# HELP rpa_browser_sessions_total Browser sessions accepted since start.',
    '# TYPE rpa_browser_sessions_total counter',
    `rpa_browser_sessions_total ${s.sessionsTotal}`,
    '# HELP rpa_browser_refused_total Upgrades refused since start, by reason.',
    '# TYPE rpa_browser_refused_total counter',
    ...REFUSAL_REASONS.map((r) => `rpa_browser_refused_total{reason="${r}"} ${s.refused[r]}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The gate. Returns its http.Server (listen on it as before) with these added:
 * - server: the same server, so `const { server, metricsServer, stats, drain } = createGate(...)` reads naturally;
 * - metricsServer: an http.Server for GET /metrics when metricsPort is set and not 0 (the caller listens on it);
 * - stats(): { active, capacity, draining, sessionsTotal, refused: { capacity, draining, unauthorized, forbidden, bad_request } };
 * - drain(timeoutMs): refuse new sessions and fail /healthz from now on; resolves 'idle' when no session is open, or
 *   'timeout' when timeoutMs passes first (the open sessions are left alone; the caller exits);
 * - onSessions(cb): cb(active) on every change of the open-session count.
 * GET and HEAD /healthz answer the same status (HEAD without a body). upstreamConnectTimeoutMs is for tests.
 */
export function createGate({
  token, upstreamHost = '127.0.0.1', upstreamPort, upstreamPath, maxSessions = 4, metricsPort,
  upstreamConnectTimeoutMs = UPSTREAM_CONNECT_TIMEOUT_MS,
}) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`BROWSER_GATE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  if (typeof upstreamPath !== 'string' || !UPSTREAM_PATH.test(upstreamPath)) throw new Error(UPSTREAM_PATH_RULE);
  if (!validSessions(maxSessions)) throw new Error(`maxSessions ${MAX_SESSIONS_RULE}`);

  let active = 0;
  let sessionsTotal = 0;
  let draining = false;
  let drained;
  let onIdle;
  const refused = Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0]));
  const listeners = [];
  const stats = () => ({ active, capacity: maxSessions, draining, sessionsTotal, refused: { ...refused } });
  const changed = () => {
    for (const cb of listeners) {
      try {
        cb(active);
      } catch {
        // A listener's failure never breaks the gate.
      }
    }
  };

  /** Whether the run-server accepts a TCP connection within HEALTH_CONNECT_MS. */
  const upstreamUp = () => new Promise((resolve) => {
    const probe = connect({ host: upstreamHost, port: upstreamPort });
    const done = (up) => { probe.destroy(); resolve(up); };
    probe.setTimeout(HEALTH_CONNECT_MS, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const answer = (status, text) => {
        res.writeHead(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end(`${text}\n`);
      };
      if (draining) return answer(503, 'draining');
      upstreamUp().then((up) => (draining ? answer(503, 'draining') : up ? answer(200, 'ok') : answer(503, 'upstream down')));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const refuseFor = (reason, status) => { refused[reason] += 1; refuse(socket, status); };
    // Only WebSocket upgrades exist on the run-server; h2c, TLS and other upgrades never reach it.
    const upgradeTo = typeof req.headers.upgrade === 'string' ? req.headers.upgrade.trim().toLowerCase() : '';
    if (upgradeTo !== 'websocket') return refuseFor('bad_request', '400 Bad Request');
    if (!authorized(req.headers.authorization, token)) return refuseFor('unauthorized', '401 Unauthorized');
    const url = URL.canParse(req.url, 'http://gate') ? new URL(req.url, 'http://gate') : undefined;
    if (!url || !requestAllowed(req, url)) return refuseFor('forbidden', '403 Forbidden');
    // After the token and request checks, so a wrong token or option is still 401/403 (the engine retries only on 503).
    if (draining) { refused.draining += 1; return unavailable(socket, 'draining'); }
    if (active >= maxSessions) { refused.capacity += 1; return unavailable(socket, 'busy'); }

    // The session holds its slot until both the client socket and the upstream socket have closed, and frees it once.
    active += 1;
    sessionsTotal += 1;
    changed();
    let clientClosed = false;
    let upstreamClosed = false;
    let released = false;
    const release = () => {
      if (released || !clientClosed || !upstreamClosed) return;
      released = true;
      active -= 1;
      changed();
      if (active === 0 && onIdle) onIdle();
    };

    socket.setKeepAlive(true, KEEPALIVE_MS);
    const upstream = connect({ host: upstreamHost, port: upstreamPort }, () => {
      upstream.setTimeout(0);
      upstream.setKeepAlive(true, KEEPALIVE_MS);
      // Replay the request to the secret path (the client's own path is dropped, its query kept), with the headers
      // minus the token, then the bytes already read, then pipe both ways. Host becomes the run-server's own address:
      // bound to loopback, it refuses (403) any Host but localhost, 127.0.0.1 or [::1] (DNS-rebinding protection),
      // and n8n sends Host: browser:3000. Origin is passed on, so the run-server's Origin check still applies.
      const lines = [`${req.method} ${upstreamPath}${url.search} HTTP/${req.httpVersion}`, `Host: ${upstreamHost}:${upstreamPort}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (name === 'authorization' || name === 'host') continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    // A run-server that never accepts (overloaded, or a SYN lost) must not hold the slot: give the connect a deadline, and
    // drop the attempt when the client half-closes before it completes (after it, the pipe passes the FIN on).
    upstream.setTimeout(upstreamConnectTimeoutMs, () => upstream.destroy());
    socket.once('end', () => { if (upstream.connecting) socket.destroy(); });
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => { upstreamClosed = true; socket.destroy(); release(); });
    socket.on('close', () => { clientClosed = true; upstream.destroy(); release(); });
    // The client may already be gone (its close event has fired before this handler ran).
    if (socket.destroyed) { clientClosed = true; upstream.destroy(); }
  });

  let metricsServer;
  if (metricsPort !== undefined && metricsPort !== null && metricsPort !== 0) {
    metricsServer = createServer((req, res) => {
      if ((req.url ?? '').split('?')[0] === '/metrics' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        res.end(metricsText(stats()));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
    });
  }

  const drain = (timeoutMs) => {
    if (drained) return drained;
    draining = true;
    drained = new Promise((resolve) => {
      if (active === 0) return resolve('idle');
      const timer = setTimeout(() => { onIdle = undefined; resolve('timeout'); }, timeoutMs);
      onIdle = () => { clearTimeout(timer); onIdle = undefined; resolve('idle'); };
    });
    return drained;
  };
  const onSessions = (cb) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  return Object.assign(server, { server, metricsServer, stats, drain, onSessions });
}

// The loader resolves symlinks in the entry path; argv[1] keeps them, so compare real paths. A path that cannot be
// resolved (for example when this file is loaded with --import ahead of another entry point) is not this file.
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
const isMain = isMainModule();
if (isMain) {
  const token = process.env.BROWSER_GATE_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error(`browser-gate: BROWSER_GATE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32)`);
    process.exit(1);
  }
  const upstreamPath = process.env.BROWSER_UPSTREAM_PATH ?? '';
  if (!UPSTREAM_PATH.test(upstreamPath)) {
    console.error(`browser-gate: ${UPSTREAM_PATH_RULE}`);
    process.exit(1);
  }
  /** A whole-number env value within [min, max], or the default when unset or empty; exits 1 with the rule otherwise. */
  const intEnv = (name, fallback, min, max, rule) => {
    const raw = (process.env[name] ?? '').trim();
    if (raw === '') return fallback;
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n >= min && n <= max) return n;
    console.error(`browser-gate: ${name} ${rule}`);
    process.exit(1);
  };
  const maxSessions = intEnv('BROWSER_GATE_MAX_SESSIONS', 4, 1, MAX_SESSIONS_LIMIT, MAX_SESSIONS_RULE);
  const drainSeconds = intEnv('BROWSER_GATE_DRAIN_SECONDS', 600, 1, 86_400, 'must be a whole number of seconds from 1 to 86400');
  const metricsPort = intEnv('BROWSER_GATE_METRICS_PORT', 9464, 0, 65_535, 'must be a port from 1 to 65535, or 0 to turn metrics off');
  /** An on/off env value: unset, empty or "off" is off, "on" is on; anything else exits 1. */
  const flagEnv = (name) => {
    const raw = (process.env[name] ?? '').trim();
    if (raw === '' || raw === 'off') return false;
    if (raw === 'on') return true;
    console.error(`browser-gate: ${name} must be on or off`);
    process.exit(1);
  };
  const ecsProtection = flagEnv('BROWSER_GATE_ECS_PROTECTION');
  const emf = flagEnv('BROWSER_GATE_EMF');
  // The service name is the operator's own setting, so a missing or bad one stops the gate at start, like the others.
  const serviceName = process.env.BROWSER_GATE_SERVICE_NAME ?? '';
  if (emf && !validServiceName(serviceName)) {
    console.error(`browser-gate: BROWSER_GATE_EMF=on needs BROWSER_GATE_SERVICE_NAME; ${SERVICE_NAME_RULE}`);
    process.exit(1);
  }
  const port = Number(process.env.BROWSER_GATE_PORT ?? '3000');
  const upstreamPort = Number(process.env.BROWSER_UPSTREAM_PORT ?? '3001');
  const gate = createGate({ token, upstreamPort, upstreamPath, maxSessions, metricsPort });
  const listenFailed = (what) => (err) => {
    console.error(`browser-gate: cannot listen for ${what}: ${err.code ?? err.message}`);
    process.exit(1);
  };
  gate.server.on('error', listenFailed('sessions'));
  // No host: Node listens on :: dual-stack (IPv4 and IPv6), or on 0.0.0.0 where IPv6 is off.
  gate.server.listen(port, () => {
    console.log(`browser-gate: listening on :${gate.server.address().port} (max sessions ${maxSessions}), forwarding authorised upgrades to the run-server on 127.0.0.1:${upstreamPort}`);
  });
  if (gate.metricsServer) {
    gate.metricsServer.on('error', listenFailed('metrics'));
    gate.metricsServer.listen(metricsPort, () => {
      console.log(`browser-gate: metrics on :${gate.metricsServer.address().port}/metrics`);
    });
  }
  // ECS_AGENT_URI is set by the ECS agent itself, so without it the gate is not on ECS: say so once and carry on.
  let protection;
  if (ecsProtection) {
    if (!validAgentUri(process.env.ECS_AGENT_URI ?? '')) {
      console.log('browser-gate: BROWSER_GATE_ECS_PROTECTION=on but ECS_AGENT_URI is not set or not an http URL; ECS task protection is off');
    } else {
      protection = taskProtection({ agentUri: process.env.ECS_AGENT_URI, drainSeconds });
      // update() never rejects; the catch is a safety net so a future change cannot crash the gate with an unhandled rejection.
      gate.onSessions((active) => { protection.update(active).catch(() => {}); });
      console.log(`browser-gate: ECS task protection on while sessions are open (${protectionMinutes(drainSeconds)} min, renewed while they stay open)`);
    }
  }
  if (emf) {
    startEmf({ serviceName, stats: gate.stats });
    console.log(`browser-gate: CloudWatch EMF metrics on stdout every 60 s (namespace RPA/Browser, ServiceName ${serviceName})`);
  }
  /** On exit: a last "off" to the ECS agent when no session is open, waited for 2.5 s at most. */
  const finishProtection = () => {
    if (!protection) return Promise.resolve();
    return new Promise((resolve) => {
      setTimeout(resolve, 2500).unref();
      protection.stop().then(resolve, resolve);
    });
  };
  // The supervisor (entrypoint.sh) sends TERM here first and stops the run-server only after this process exits.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) {
      console.log(`browser-gate: ${signal} again, exiting now with ${sessionsOpen(gate.stats().active)}`);
      process.exit(0);
    }
    stopping = true;
    console.log(`browser-gate: ${signal}: draining, refusing new sessions; ${sessionsOpen(gate.stats().active)}, waiting up to ${drainSeconds} s`);
    gate.drain(drainSeconds * 1000).then(async (result) => {
      if (result === 'idle') console.log('browser-gate: drained, no sessions open; exiting');
      else console.log(`browser-gate: drain time passed with ${sessionsOpen(gate.stats().active)}; exiting`);
      await finishProtection();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
