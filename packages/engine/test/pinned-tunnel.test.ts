import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { openPinnedTunnel, type PinnedTunnel } from '../src/browser/pinned-tunnel.js';
import { BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH } from '../src/messages.js';
import { selfSignedCert } from './fake-runner-cert.js';

/**
 * The loopback tunnel in front of a wss:// browser server with a self-signed certificate. The server here is a bare
 * node:tls server that answers a WebSocket upgrade with 101 and records every application byte it received.
 */
const served = selfSignedCert('browser-server');
const other = selfSignedCert('browser-server');

let server: TlsServer;
let port = 0;
let received = Buffer.alloc(0);
beforeAll(async () => {
  server = createTlsServer({ key: served.key, cert: served.cert }, (socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes('\r\n\r\n')) socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
  });
  // A client that leaves during the handshake (the mismatch test) is not this server's concern.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tunnels: PinnedTunnel[] = [];
const open = async (fingerprint: string, path = '/') => {
  const tunnel = await openPinnedTunnel(`wss://127.0.0.1:${port}${path}`, fingerprint);
  tunnels.push(tunnel);
  return tunnel;
};
afterEach(async () => {
  for (const t of tunnels.splice(0)) await t.close();
  received = Buffer.alloc(0);
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

/** Whether a TCP connect to the loopback port is refused. */
const refused = (p: number) => new Promise<boolean>((resolve) => {
  const s = netConnect(p, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(false); });
  s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ECONNREFUSED'));
});

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
    expect(received.length).toBe(0);
    expect(tunnel.failure()).toBe(BROWSER_FINGERPRINT_MISMATCH);
  });

  it('refuses a malformed fingerprint', async () => {
    await expect(openPinnedTunnel(`wss://127.0.0.1:${port}/`, 'abc')).rejects.toThrow(BROWSER_FINGERPRINT_INVALID);
  });

  it('close() stops listening and ends open connections', async () => {
    const tunnel = await open(served.fingerprint);
    const tunnelPort = Number(new URL(tunnel.wsUrl).port);
    const up = rawUpgrade(tunnel.wsUrl);
    expect(await up.answer).toMatch(/^HTTP\/1\.1 101 /);
    await tunnel.close();
    await up.closed;
    expect(await refused(tunnelPort)).toBe(true);
    // A second close (the session's disconnect after a failed connect) is harmless.
    await tunnel.close();
  });
});
