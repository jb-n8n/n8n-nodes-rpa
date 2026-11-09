// A loopback tunnel to a wss:// browser server whose self-signed certificate is pinned by its SHA-256 fingerprint.
// Playwright's connect has no option to pin a certificate, so the tunnel does the TLS handshake and the fingerprint
// check itself and gives Playwright a plain ws://127.0.0.1:<port> address. The order is the same as in the desktop
// runner client (desktop/client.ts): TLS handshake, fingerprint check, and only then the client's bytes (the upgrade
// request that carries the token). A wrong certificate ends the connection before a single application byte is sent.
// The tunnel checks the one connection it forwards and nothing else. If the pinned server answers the WebSocket upgrade
// with a redirect to another host, Playwright follows it on a connection of its own, outside the tunnel and without the
// Authorization header, and that connection is not checked against the fingerprint. A redirect back to the tunnel's own
// address is closed by the tunnel (it takes one connection), so the connect fails.

import { createServer, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { fingerprintOf, normalizeFingerprint } from '../desktop/client.js';
import { BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_NEEDS_WSS } from '../messages.js';

/** How long the server may take to finish the TLS handshake when the caller gives no timeout. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The most the tunnel holds of the client's bytes while the handshake runs. An upgrade request is far smaller. */
const MAX_HELD_BYTES = 64 * 1024;

export interface PinnedTunnel {
  /** The address to connect to instead of the wss:// URL: ws://127.0.0.1:<port>, with the same path and query. */
  wsUrl: string;
  /**
   * Why the tunnel did not forward, when the reason is not a server that cannot be reached: BROWSER_FINGERPRINT_MISMATCH
   * once the server presented a certificate other than the pinned one, or the reason the TLS connection could not be
   * started. Else undefined.
   */
  failure(): string | undefined;
  /** Stops listening, which frees the port, and ends the open connection. Never throws; a second call does nothing. */
  close(): Promise<void>;
}

/** The pin as fingerprintOf prints one: uppercase hex pairs joined by colons. Throws BROWSER_FINGERPRINT_INVALID. */
export function pinnedFingerprint(value: string): string {
  try {
    return normalizeFingerprint(value);
  } catch {
    throw new Error(BROWSER_FINGERPRINT_INVALID);
  }
}

/**
 * Listens on a free loopback port and forwards the first connection to the wss:// server, once the server's certificate
 * matched the fingerprint. It forwards that one connection only: every later connection is accepted and closed at once,
 * with nothing read from it and nothing sent to the server. The tunnel keeps the port bound until close().
 * Throws BROWSER_FINGERPRINT_INVALID for a malformed fingerprint and BROWSER_FINGERPRINT_NEEDS_WSS for a URL that is
 * not wss://. A server that cannot be reached, that does not finish the TLS handshake within `handshakeTimeoutMs`, or
 * that presents another certificate, closes the connection to the tunnel; `failure()` tells the last case apart.
 */
export async function openPinnedTunnel(
  wssUrl: string, fingerprint: string, opts: { handshakeTimeoutMs?: number } = {},
): Promise<PinnedTunnel> {
  const pinned = pinnedFingerprint(fingerprint);
  const target = URL.canParse(wssUrl) ? new URL(wssUrl) : undefined;
  if (target?.protocol !== 'wss:') throw new Error(BROWSER_FINGERPRINT_NEEDS_WSS);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = target.port ? Number(target.port) : 443;
  let failure: string | undefined;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  let taken = false;
  const server = createServer((client) => {
    // One connection per tunnel: Playwright connects once. Every later connection is closed here, unread. The tunnel
    // keeps listening until close(), so it does not give up the port while the client may still connect.
    if (taken) {
      client.destroy();
      return;
    }
    taken = true;
    track(client);
    client.on('error', () => client.destroy());
    let upstream: TLSSocket;
    try {
      // The server's certificate is self-signed: chain and name checks are replaced by the fingerprint pin below.
      upstream = tlsConnect({
        host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2',
      });
    } catch (err) {
      failure = `could not connect to the browser server: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200)}`;
      client.destroy();
      return;
    }
    track(upstream);
    // The client's bytes are read and held here until the pin matched. Reading them is what shows the client leaving
    // while the handshake runs.
    let held: Buffer[] = [];
    let heldBytes = 0;
    let dropped = false;
    const drop = () => {
      dropped = true;
      held = [];
      clearTimeout(timer);
      client.destroy();
      upstream.destroy();
    };
    const timer = setTimeout(drop, opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    const hold = (chunk: Buffer) => {
      if (heldBytes + chunk.length > MAX_HELD_BYTES) {
        drop();
        return;
      }
      held.push(chunk);
      heldBytes += chunk.length;
    };
    client.on('data', hold);
    client.on('close', drop);
    upstream.on('error', drop);
    upstream.on('close', drop);
    upstream.once('secureConnect', () => {
      if (dropped) return;
      clearTimeout(timer);
      // A certificate that cannot be read is one that did not match.
      let presented: string | undefined;
      try {
        const raw = upstream.getPeerCertificate(true)?.raw;
        presented = raw ? fingerprintOf(raw) : undefined;
      } catch {
        presented = undefined;
      }
      if (presented !== pinned) {
        failure = BROWSER_FINGERPRINT_MISMATCH;
        drop();
        return;
      }
      client.off('data', hold);
      for (const chunk of held) upstream.write(chunk);
      held = [];
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  const stopped = new Promise<void>((resolve) => server.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  // A connection that could not be accepted never arrives: its client times out. The process must not end over it.
  server.on('error', () => undefined);

  const local = new URL(target.href);
  local.protocol = 'ws:';
  local.hostname = '127.0.0.1';
  local.port = String((server.address() as { port: number }).port);
  return {
    wsUrl: local.href,
    failure: () => failure,
    close: () => {
      if (server.listening) server.close();
      for (const socket of sockets) socket.destroy();
      return stopped;
    },
  };
}
