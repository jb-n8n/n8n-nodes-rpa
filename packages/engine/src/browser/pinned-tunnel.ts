// A loopback tunnel to a wss:// browser server whose self-signed certificate is pinned by its SHA-256 fingerprint.
// Playwright's connect has no option to pin a certificate, so the tunnel does the TLS handshake and the fingerprint
// check itself and gives Playwright a plain ws://127.0.0.1:<port> address. The order is the guarantee, as in the desktop
// runner client (desktop/client.ts): TLS handshake, fingerprint check, and only then the client's bytes (the upgrade
// request that carries the token). A wrong certificate ends the connection before a single application byte is sent.

import { createServer, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { fingerprintOf, normalizeFingerprint } from '../desktop/client.js';
import { BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_NEEDS_WSS } from '../messages.js';

export interface PinnedTunnel {
  /** The address to connect to instead of the wss:// URL: ws://127.0.0.1:<port>, with the same path and query. */
  wsUrl: string;
  /** BROWSER_FINGERPRINT_MISMATCH once the server presented a certificate other than the pinned one; else undefined. */
  failure(): string | undefined;
  /** Stops listening and ends every open connection. Never throws; a second call does nothing. */
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
 * Listens on a free loopback port and forwards each connection to the wss:// server, once the server's certificate
 * matched the fingerprint. Throws BROWSER_FINGERPRINT_INVALID for a malformed fingerprint and
 * BROWSER_FINGERPRINT_NEEDS_WSS for a URL that is not wss://. A server that cannot be reached, or that presents another
 * certificate, closes the connection to the tunnel; `failure()` tells the two apart.
 */
export async function openPinnedTunnel(wssUrl: string, fingerprint: string): Promise<PinnedTunnel> {
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

  // Paused on connect: the client's bytes stay unread until the pin matched.
  const server = createServer({ pauseOnConnect: true }, (client) => {
    // The server's certificate is self-signed: chain and name checks are replaced by the fingerprint pin below.
    const upstream = tlsConnect({
      host, port, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2',
    });
    track(client);
    track(upstream);
    const drop = () => { client.destroy(); upstream.destroy(); };
    client.on('error', drop);
    client.on('close', drop);
    upstream.on('error', drop);
    upstream.on('close', drop);
    upstream.once('secureConnect', () => {
      const raw = upstream.getPeerCertificate(true)?.raw;
      if (!raw || fingerprintOf(raw) !== pinned) {
        failure = BROWSER_FINGERPRINT_MISMATCH;
        drop();
        return;
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
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
  let closing: Promise<void> | undefined;
  return {
    wsUrl: local.href,
    failure: () => failure,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
