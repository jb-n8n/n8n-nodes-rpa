import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { openPinnedTunnel, type PinnedTunnel } from '../src/browser/pinned-tunnel.js';
import { BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_NEEDS_WSS } from '../src/messages.js';
import { selfSignedCert } from './fake-runner-cert.js';
import { connectRefused } from './helpers.js';
import { bound } from './timing.js';

/**
 * The loopback tunnel in front of a wss:// browser server with a self-signed certificate. The server here is a bare
 * node:tls server that answers a WebSocket upgrade with 101 and records every application byte it received. A second
 * server accepts TCP connections and never answers: a server that does not finish the TLS handshake.
 */
const served = selfSignedCert('browser-server');
const other = selfSignedCert('browser-server');

let server: TlsServer;
let port = 0;
let received = Buffer.alloc(0);
/** Connections the TLS server accepted, and those whose server side has ended: closed, or failed during the handshake. */
let opened = 0;
let settled = 0;
let stalledServer: NetServer;
let stalledPort = 0;
const stalled = { opened: 0, closed: 0 };
beforeAll(async () => {
  server = createTlsServer({ key: served.key, cert: served.cert }, (socket) => {
    socket.on('error', () => undefined);
    socket.once('close', () => { settled += 1; });
    let head = '';
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (answered) return;
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      answered = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
  });
  server.on('connection', () => { opened += 1; });
  // A client that leaves during the handshake (the mismatch test) never reaches the handler above.
  server.on('tlsClientError', () => { settled += 1; });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;

  stalledServer = createNetServer((socket) => {
    stalled.opened += 1;
    socket.on('error', () => undefined);
    socket.once('close', () => { stalled.closed += 1; });
    socket.resume();
  });
  await new Promise<void>((r) => stalledServer.listen(0, '127.0.0.1', r));
  stalledPort = (stalledServer.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => stalledServer.close(r));
});

const tunnels: PinnedTunnel[] = [];
const open = async (fingerprint: string, path = '/') => {
  const tunnel = await openPinnedTunnel(`wss://127.0.0.1:${port}${path}`, fingerprint);
  tunnels.push(tunnel);
  return tunnel;
};
const openStalled = async (handshakeTimeoutMs: number) => {
  const tunnel = await openPinnedTunnel(`wss://127.0.0.1:${stalledPort}/`, served.fingerprint, { handshakeTimeoutMs });
  tunnels.push(tunnel);
  return tunnel;
};
afterEach(async () => {
  for (const t of tunnels.splice(0)) await t.close();
  // The servers' side of this test's connections ends before the next test counts its own.
  await expect.poll(() => settled === opened && stalled.closed === stalled.opened).toBe(true);
  received = Buffer.alloc(0);
  opened = settled = stalled.opened = stalled.closed = 0;
});

const UPGRADE = 'GET /some/path?q=1 HTTP/1.1\r\nHost: tunnel\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
  + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

/**
 * Sends a WebSocket upgrade to `wsUrl` as plain bytes. `answer` resolves with the response head, or with what had
 * arrived when the connection closed; the socket stays open after a head so a test can watch it close.
 */
function rawUpgrade(wsUrl: string): { socket: Socket; answer: Promise<string>; closed: Promise<void> } {
  const u = new URL(wsUrl);
  const socket = netConnect(Number(u.port), u.hostname);
  let got = '';
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const answer = new Promise<string>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      got += chunk.toString('latin1');
      if (got.includes('\r\n\r\n')) resolve(got);
    });
    void closed.then(() => resolve(got));
  });
  socket.on('error', () => undefined);
  socket.write(UPGRADE);
  return { socket, answer, closed };
}

const portOf = (tunnel: PinnedTunnel) => Number(new URL(tunnel.wsUrl).port);

describe('the pinned tunnel to a wss:// browser server', () => {
  it('forwards bytes both ways when the certificate matches', async () => {
    const tunnel = await open(served.fingerprint, '/some/path?q=1');
    expect(tunnel.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/some\/path\?q=1$/);
    const up = rawUpgrade(tunnel.wsUrl);
    expect(await up.answer).toMatch(/^HTTP\/1\.1 101 /);
    expect(received.toString('latin1')).toBe(UPGRADE);
    expect(tunnel.failure()).toBeUndefined();
    up.socket.destroy();
  });

  it('accepts the fingerprint in lowercase, with spaces, and without colons', async () => {
    const lower = served.fingerprint.toLowerCase();
    for (const fingerprint of [lower, ` ${lower.replace(/:/g, ' ')} `, served.fingerprint.replace(/:/g, '')]) {
      const tunnel = await open(fingerprint);
      const up = rawUpgrade(tunnel.wsUrl);
      expect(await up.answer).toMatch(/^HTTP\/1\.1 101 /);
      expect(tunnel.failure()).toBeUndefined();
      up.socket.destroy();
    }
  });

  it('sends nothing to a server with another certificate', async () => {
    const tunnel = await open(other.fingerprint);
    const up = rawUpgrade(tunnel.wsUrl);
    await up.closed;
    expect(await up.answer).toBe('');
    // Read once the server's side of the connection has ended: bytes sent before the check would have arrived by then.
    await expect.poll(() => opened === 1 && settled === 1).toBe(true);
    expect(received.length).toBe(0);
    expect(tunnel.failure()).toBe(BROWSER_FINGERPRINT_MISMATCH);
  });

  it('refuses a malformed fingerprint', async () => {
    await expect(openPinnedTunnel(`wss://127.0.0.1:${port}/`, 'abc')).rejects.toThrow(BROWSER_FINGERPRINT_INVALID);
  });

  it('refuses a URL that is not wss://', async () => {
    for (const url of [`ws://127.0.0.1:${port}/`, `https://127.0.0.1:${port}/`, 'not a url']) {
      await expect(openPinnedTunnel(url, served.fingerprint)).rejects.toThrow(BROWSER_FINGERPRINT_NEEDS_WSS);
    }
    expect(opened).toBe(0);
  });

  it('the tunnel takes one connection, and a second local connect is refused', async () => {
    const tunnel = await open(served.fingerprint);
    const up = rawUpgrade(tunnel.wsUrl);
    expect(await up.answer).toMatch(/^HTTP\/1\.1 101 /);
    expect(await connectRefused(portOf(tunnel))).toBe(true);
    // The first connection lives on.
    up.socket.write('more');
    await expect.poll(() => received.toString('latin1')).toBe(`${UPGRADE}more`);
    expect(opened).toBe(1);
    up.socket.destroy();
  });

  it('a server that never finishes the handshake is dropped after the timeout', async () => {
    const tunnel = await openStalled(300);
    const t0 = Date.now();
    const up = rawUpgrade(tunnel.wsUrl);
    await up.closed;
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(bound(2000));
    expect(await up.answer).toBe('');
    await expect.poll(() => stalled.closed).toBe(1);
    // Not a certificate that did not match: the caller reports the server as unreachable.
    expect(tunnel.failure()).toBeUndefined();
  });

  it('the client leaving during the handshake closes the upstream connection', async () => {
    // A timeout far beyond this test: only the client leaving can close the upstream connection in time.
    const tunnel = await openStalled(60_000);
    const up = rawUpgrade(tunnel.wsUrl);
    await expect.poll(() => stalled.opened).toBe(1);
    expect(stalled.closed).toBe(0);
    up.socket.end();
    await expect.poll(() => stalled.closed, { timeout: bound(2000) }).toBe(1);
    expect(tunnel.failure()).toBeUndefined();
  });

  it('close() stops listening and ends open connections', async () => {
    const tunnel = await open(served.fingerprint);
    const up = rawUpgrade(tunnel.wsUrl);
    expect(await up.answer).toMatch(/^HTTP\/1\.1 101 /);
    await tunnel.close();
    await up.closed;
    expect(await connectRefused(portOf(tunnel))).toBe(true);
    // A second close (the session's disconnect after a failed connect) is harmless.
    await tunnel.close();
  });

  it('close() before any connection stops listening', async () => {
    const tunnel = await open(served.fingerprint);
    await tunnel.close();
    expect(await connectRefused(portOf(tunnel))).toBe(true);
    expect(opened).toBe(0);
  });
});
