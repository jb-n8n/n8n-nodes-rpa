// The desktop runner client: JSON-RPC 2.0 over a WebSocket over TLS, with the runner's self-signed certificate pinned
// by its SHA-256 fingerprint. The order is the guarantee: TLS handshake, fingerprint check, and only then the upgrade
// request that carries the token. A wrong certificate ends the connection before a single application byte is sent.

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import {
  RUNNER_DISCONNECTED, RUNNER_FINGERPRINT_INVALID, RUNNER_URL_HAS_CREDENTIALS, RUNNER_URL_NOT_SECURE, runnerFingerprintMismatch, runnerTokenRefused,
  runnerUnreachable,
} from '../messages.js';
import {
  DEFAULT_RUNNER_PORT, FingerprintMismatchError, NoRunError, RUNNER_PATH, RunnerConnectError, RunnerDisconnectedError, runnerError, RunnerTokenRefusedError, type HelloResult, type RunnerMethod, type RunnerMethods,
} from './protocol.js';
import { acceptKey, encodeFrame, FrameReader, newKey, OPCODE } from './ws.js';

/** The RPA Desktop Runner credential: where the runner listens, its token, and its certificate's SHA-256 fingerprint. */
export interface RunnerEndpoint {
  /** wss://host:port (port 8765 when absent); the path defaults to /rpa/v1. */
  url: string;
  token: string;
  fingerprint: string;
}

export const RUNNER_CONNECT_TIMEOUT_MS = 10_000;
/** How long a call waits beyond the timeout it gives the runner. */
const CALL_MARGIN_MS = 5_000;
/** Calls without a timeout of their own (hello, run.begin, run.end, app.launch, snapshot) wait this long. */
export const DEFAULT_CALL_MS = 30_000;
/** Largest message the client accepts: a 50 MiB file in base64, plus room. */
const MAX_MESSAGE_BYTES = 72 * 1024 * 1024;
const MAX_RESPONSE_HEAD = 16 * 1024;

/** A fingerprint as the runner prints it: uppercase hex pairs joined by colons. Throws RUNNER_FINGERPRINT_INVALID. */
export function normalizeFingerprint(value: string): string {
  const hex = String(value ?? '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error(RUNNER_FINGERPRINT_INVALID);
  return hex.match(/../g)!.join(':');
}

/** The SHA-256 fingerprint of a DER certificate, as the runner prints it. */
export function fingerprintOf(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}

export interface RunnerAddress { host: string; port: number; path: string; servername?: string; hostHeader: string; shown: string }

/** Checks and splits the runner URL: wss:// only, no userinfo, query or fragment. `shown` is safe for messages. */
export function runnerAddress(url: string): RunnerAddress {
  const raw = String(url ?? '').trim();
  if (!URL.canParse(raw)) throw new Error(RUNNER_URL_NOT_SECURE);
  const u = new URL(raw);
  if (u.protocol !== 'wss:') throw new Error(RUNNER_URL_NOT_SECURE);
  if (u.username || u.password || u.search || u.hash) throw new Error(RUNNER_URL_HAS_CREDENTIALS);
  const port = u.port ? Number(u.port) : DEFAULT_RUNNER_PORT;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const path = u.pathname && u.pathname !== '/' ? u.pathname : RUNNER_PATH;
  const hostHeader = `${u.hostname}:${port}`;
  return { host, port, path, ...(isIP(host) ? {} : { servername: host }), hostHeader, shown: `wss://${hostHeader}${path}` };
}

function checkToken(token: string): string {
  // The token goes into a header line: visible ASCII only, so it cannot add a header of its own.
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new Error('The desktop runner token is empty or contains a line break, a space or a character that is not ASCII.');
  return token;
}

/** Opens TLS and resolves once the handshake finished, before anything is written. */
function openTls(addr: RunnerAddress, timeoutMs: number, signal?: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    // The runner's certificate is self-signed: chain and name checks are replaced by the fingerprint pin below.
    const socket = tlsConnect({
      host: addr.host, port: addr.port, ...(addr.servername ? { servername: addr.servername } : {}), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.2',
    });
    const done = (err?: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.off('secureConnect', onSecure);
      socket.off('error', onError);
      if (err) { socket.destroy(); reject(err); } else resolve(socket);
    };
    const onSecure = () => done();
    const onError = (e: Error) => done(new RunnerConnectError(runnerUnreachable(addr.shown, e.message.split('\n')[0].slice(0, 200))));
    const onAbort = () => done(new RunnerConnectError(runnerUnreachable(addr.shown, 'cancelled')));
    const timer = setTimeout(() => done(new RunnerConnectError(runnerUnreachable(addr.shown, `no answer within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Sends the upgrade request and reads the answer. Resolves with any bytes that followed the response head. */
function upgrade(socket: TLSSocket, addr: RunnerAddress, token: string, timeoutMs: number): Promise<Buffer> {
  const key = newKey();
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const done = (err?: Error, rest?: Buffer) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      // Held until the client attaches its own listener, so no frame that follows the upgrade is lost.
      socket.pause();
      if (err) { socket.destroy(); reject(err); } else resolve(rest ?? Buffer.alloc(0));
    };
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_RESPONSE_HEAD) done(new RunnerConnectError(runnerUnreachable(addr.shown, 'the answer is not a WebSocket upgrade')));
        return;
      }
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0);
      const headers = new Map(lines.slice(1).map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as const;
      }));
      if (status === 401 || status === 403) { done(new RunnerTokenRefusedError(runnerTokenRefused(addr.shown))); return; }
      if (status !== 101) { done(new RunnerConnectError(runnerUnreachable(addr.shown, `HTTP ${status || 'answer not understood'}`))); return; }
      if (headers.get('upgrade')?.toLowerCase() !== 'websocket' || headers.get('sec-websocket-accept') !== acceptKey(key)) {
        done(new RunnerConnectError(runnerUnreachable(addr.shown, 'the answer is not a valid WebSocket upgrade')));
        return;
      }
      done(undefined, head.subarray(end + 4));
    };
    const onError = (e: Error) => done(new RunnerConnectError(runnerUnreachable(addr.shown, e.message.split('\n')[0].slice(0, 200))));
    const onClose = () => done(new RunnerConnectError(runnerUnreachable(addr.shown, 'the connection closed during the upgrade')));
    const timer = setTimeout(() => done(new RunnerConnectError(runnerUnreachable(addr.shown, `no upgrade within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(
      `GET ${addr.path} HTTP/1.1\r\nHost: ${addr.hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
  });
}

/**
 * Connects to the runner: TLS, pin check, then the upgrade with the token. Throws RunnerConnectError (unreachable,
 * not a WebSocket), FingerprintMismatchError (nothing sent) or RunnerTokenRefusedError (401); a malformed URL,
 * token or fingerprint throws a plain Error with a configuration message.
 */
export async function connectRunner(endpoint: RunnerEndpoint, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunnerClient> {
  const addr = runnerAddress(endpoint.url);
  const pinned = Buffer.from(normalizeFingerprint(endpoint.fingerprint).replace(/:/g, ''), 'hex');
  const token = checkToken(endpoint.token);
  const timeoutMs = opts.timeoutMs ?? RUNNER_CONNECT_TIMEOUT_MS;
  const socket = await openTls(addr, timeoutMs, opts.signal);
  const raw = socket.getPeerCertificate(false)?.raw;
  const presented = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
  if (presented.length !== pinned.length || !timingSafeEqual(presented, pinned)) {
    socket.destroy();
    const shown = raw ? fingerprintOf(raw) : 'none';
    throw new FingerprintMismatchError(runnerFingerprintMismatch(addr.shown, shown), shown);
  }
  const rest = await upgrade(socket, addr, token, timeoutMs);
  return new RunnerClient(socket, rest);
}

interface Pending { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/**
 * A lease kept alive by heartbeats while a run is open. A heartbeat that times out (the runner busy with a long action)
 * is retried at the next beat; the lease stops only when the runner says the run is gone (`error`, a NoRunError) or the
 * connection ends.
 */
export interface Lease { stop(): void; readonly error: Error | undefined }

/** One connection to the runner. Requests are answered by id; every pending request fails when the connection ends. */
export class RunnerClient {
  private readonly reader = new FrameReader(false, MAX_MESSAGE_BYTES);
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private isClosed = false;
  private closeError: Error | undefined;
  private readonly closedPromise: Promise<void>;

  constructor(private readonly socket: TLSSocket, rest: Buffer) {
    this.closedPromise = new Promise((resolve) => socket.once('close', () => { this.ended(); resolve(); }));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (e: Error) => { this.closeError ??= e; });
    if (rest.length) this.onData(rest);
    socket.resume();
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Resolves when the connection has closed, however it ended. */
  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (e) {
      this.closeError = e as Error;
      this.socket.destroy();
      return;
    }
    for (const f of frames) {
      if (f.opcode === OPCODE.ping) this.send(OPCODE.pong, f.payload);
      else if (f.opcode === OPCODE.close) { this.send(OPCODE.close, f.payload.subarray(0, 2)); this.socket.end(); }
      else if (f.opcode === OPCODE.text) this.onMessage(f.payload.toString('utf8'));
      else if (f.opcode !== OPCODE.pong) { this.socket.destroy(); return; }
    }
  }

  private onMessage(text: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg?.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(runnerError(msg.error.code, msg.error.message));
    else p.resolve(msg.result ?? {});
  }

  private ended(): void {
    this.isClosed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new RunnerDisconnectedError(RUNNER_DISCONNECTED));
    }
  }

  private send(opcode: number, payload: Buffer): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(encodeFrame(opcode, payload, true));
  }

  /**
   * Calls a method. `waitMs` bounds the wait (default DEFAULT_CALL_MS); a method that takes `timeoutMs` should be given
   * that plus a margin (callWithin). Rejects with the runner's typed error, or RunnerDisconnectedError when the
   * connection ended or no answer came in time.
   */
  call<M extends RunnerMethod>(method: M, params: RunnerMethods[M]['params'], waitMs = DEFAULT_CALL_MS): Promise<RunnerMethods[M]['result']> {
    if (this.isClosed) return Promise.reject(new RunnerDisconnectedError(RUNNER_DISCONNECTED));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // No answer at all is a runner fault, not the runner's own `timeout` (an element that did not settle in time).
        reject(new RunnerDisconnectedError(`the desktop runner did not answer ${method} within ${Math.ceil(waitMs / 1000)} s`));
      }, waitMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(OPCODE.text, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8'));
    });
  }

  /** A call whose params carry `timeoutMs` for the runner: the client waits that long plus a margin. */
  callWithin<M extends RunnerMethod>(method: M, params: RunnerMethods[M]['params'] & { timeoutMs: number }): Promise<RunnerMethods[M]['result']> {
    return this.call(method, params, params.timeoutMs + CALL_MARGIN_MS);
  }

  hello(): Promise<HelloResult> {
    return this.call('hello', {});
  }

  /** Renews the run's lease every third of `leaseMs` until stopped or until a heartbeat fails. */
  startLease(runId: string, leaseMs: number): Lease {
    const every = Math.max(500, Math.floor(leaseMs / 3));
    let error: Error | undefined;
    let inFlight = false;
    const timer = setInterval(() => {
      if (this.isClosed) { clearInterval(timer); return; }
      if (inFlight) return; // one heartbeat at a time: a slow answer is not a lost lease
      inFlight = true;
      // Waits up to the lease itself: a runner that answers one request at a time answers it after the current action.
      this.call('run.heartbeat', { runId }, leaseMs).then(() => { inFlight = false; }, (e: Error) => {
        inFlight = false;
        if (e instanceof NoRunError) { error ??= e; clearInterval(timer); }
      });
    }, every);
    timer.unref();
    return {
      stop: () => clearInterval(timer),
      get error() { return error; },
    };
  }

  /** Sends a close frame and waits (at most 2 s) for the connection to end. Never throws. */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.send(OPCODE.close, Buffer.from([0x03, 0xe8]));
    this.socket.end();
    const timer = setTimeout(() => this.socket.destroy(), 2_000);
    await this.closedPromise;
    clearTimeout(timer);
  }

  /** Ends the connection now (cancel, budget). Pending calls fail with RunnerDisconnectedError. */
  destroy(): void {
    this.socket.destroy();
  }
}

/** Connects (pinned), calls hello and closes: the credential test. Throws what connectRunner and call throw. */
export async function probeRunner(endpoint: RunnerEndpoint, opts: { timeoutMs?: number } = {}): Promise<HelloResult> {
  const client = await connectRunner(endpoint, opts);
  try {
    return await client.call('hello', {}, opts.timeoutMs ?? RUNNER_CONNECT_TIMEOUT_MS);
  } finally {
    await client.close();
  }
}
