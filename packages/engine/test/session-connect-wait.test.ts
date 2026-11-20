import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect as netConnect } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { openSession, type ConnectServer } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint } from '../src/types.js';
import { startDelayedProxy, type DelayedProxy } from './delayed-proxy.js';
import { selfSignedCert } from './fake-runner-cert.js';
import { policyFor } from './helpers.js';

/**
 * How long a Browser Server connection waits for the server's TLS handshake. An endpoint with a certificate fingerprint
 * may sit on a machine that signs a user in before it answers (60 s); one without keeps 10 s. The server here is a bare
 * node:tls server that answers a WebSocket upgrade with 101 and records what it received, behind a proxy that holds the
 * connection until released.
 */
const served = selfSignedCert('browser-server');
const masker = createMasker(['t'.repeat(32)]);
const policy = policyFor({ url: 'http://127.0.0.1:9', host: '127.0.0.1:9' });
const UPGRADE = 'GET / HTTP/1.1\r\nHost: tunnel\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n';

let server: TlsServer;
let received = '';
let proxy: DelayedProxy;
beforeAll(async () => {
  server = createTlsServer({ key: served.key, cert: served.cert }, (socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('latin1');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  proxy = await startDelayedProxy((server.address() as { port: number }).port);
});
afterAll(async () => {
  await proxy.close();
  await new Promise((r) => server.close(r));
});
afterEach(() => { vi.useRealTimers(); received = ''; });

const pinned = (): BrowserEndpoint => ({ mode: 'playwright', wsUrl: `wss://127.0.0.1:${proxy.port}/`, fingerprint: served.fingerprint });

/** The connect seam: records the timeout it is given, sends an upgrade to the tunnel and reports how it ended. */
function seam(): { connectServer: ConnectServer; timeouts: number[]; ended: Promise<string> } {
  const timeouts: number[] = [];
  let finish: (how: string) => void = () => undefined;
  const ended = new Promise<string>((r) => { finish = r; });
  const connectServer: ConnectServer = (wsUrl, options) => {
    timeouts.push(options.timeout);
    const u = new URL(wsUrl);
    const socket = netConnect(Number(u.port), u.hostname);
    socket.on('error', () => undefined);
    let got = '';
    socket.on('data', (c: Buffer) => { got += c.toString('latin1'); if (got.includes('\r\n\r\n')) finish('answered'); });
    socket.once('close', () => finish(got ? 'answered' : 'closed'));
    socket.write(UPGRADE);
    return ended.then((how) => { socket.destroy(); throw new Error(`stopped: ${how}`); });
  };
  return { connectServer, timeouts, ended };
}

describe('the wait for a Browser Server endpoint with a fingerprint', () => {
  it('a server that answers its TLS handshake after 20 s is connected', async () => {
    const { connectServer, timeouts, ended } = seam();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opening = openSession({ endpoint: pinned(), policy, masker, connectServer }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    proxy.release();
    await opening;
    expect(await ended).toBe('answered');
    expect(received).toBe(UPGRADE);
    expect(timeouts).toEqual([60_000]);
  });

  it('a server that never answers is dropped after 60 s, not before', async () => {
    const stalled = await startDelayedProxy(1);
    try {
      const { connectServer, ended } = seam();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let state = 'waiting';
      void ended.then((how) => { state = how; });
      const opening = openSession({ endpoint: { ...pinned(), wsUrl: `wss://127.0.0.1:${stalled.port}/` }, policy, masker, connectServer }).catch((e: Error) => e);
      await stalled.whenHeld();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(state).toBe('waiting');
      await vi.advanceTimersByTimeAsync(1);
      await opening;
      expect(await ended).toBe('closed');
    } finally { vi.useRealTimers(); await stalled.close(); }
  });
});

describe('the wait for a Browser Server endpoint without a fingerprint', () => {
  it('keeps its 10 s', async () => {
    const { connectServer, timeouts } = seam();
    const err = await openSession({ endpoint: { mode: 'playwright', wsUrl: 'ws://127.0.0.1:9/' }, policy, masker, connectServer }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(timeouts).toEqual([10_000]);
  });
});
