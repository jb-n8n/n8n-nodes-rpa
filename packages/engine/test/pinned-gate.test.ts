import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createGate, MIN_TOKEN_LENGTH } from 'n8n-rpa-gate';
import { selfSignedCert } from 'n8n-rpa-gate/selfsigned';
import { openPinnedTunnel } from '../src/browser/pinned-tunnel.js';
import { BROWSER_FINGERPRINT_MISMATCH } from '../src/messages.js';
import { bound } from './timing.js';

/**
 * The pinned tunnel (browser/pinned-tunnel.ts) in front of the gate serving TLS itself (images/browser/gate, the tls
 * option), with a certificate from the gate's own generator: the two halves of "a browser server with its own
 * certificate" together. Behind the gate is a fake run-server that answers every upgrade with 101, records the request
 * and echoes what follows. The key is made at run time.
 */
const TOKEN = 'p'.repeat(MIN_TOKEN_LENGTH);
const WRONG_TOKEN = 'w'.repeat(MIN_TOKEN_LENGTH);
const UPSTREAM_PATH = `/${'u'.repeat(32)}`;
const served = selfSignedCert();
const other = selfSignedCert();

const cleanups: (() => Promise<unknown> | void)[] = [];
// Last opened, first closed: the tunnels and their sockets go before the gate, the gate before the run-server.
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

interface Upgrade { url?: string; headers: IncomingHttpHeaders }

/** The fake run-server and the gate in front of it, serving TLS with the generated certificate. */
async function start(opts: { maxSessions?: number; tlsRequestDeadlineMs?: number } = {}) {
  const upgrades: Upgrade[] = [];
  const upstream = createHttpServer((_req, res) => { res.writeHead(500); res.end(); });
  upstream.on('upgrade', (req, socket, head: Buffer) => {
    upgrades.push({ url: req.url, headers: { ...req.headers } });
    socket.on('error', () => undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => upstream.close(r)));

  const gate = createGate({
    token: TOKEN, upstreamPort: (upstream.address() as { port: number }).port, upstreamPath: UPSTREAM_PATH,
    tls: { key: served.key, cert: served.cert }, ...opts,
  });
  // The TCP connections the gate accepted, and those that have closed.
  const connections = { opened: 0, closed: 0 };
  gate.on('connection', (socket: Socket) => {
    connections.opened += 1;
    socket.once('close', () => { connections.closed += 1; });
  });
  await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => gate.close(r)));
  return { gate, upgrades, connections, url: `wss://127.0.0.1:${(gate.address() as { port: number }).port}/pw?session=1` };
}

/** A tunnel to the gate at `url` that trusts `fingerprint`; closed after the test. */
async function tunnelTo(url: string, fingerprint: string) {
  const tunnel = await openPinnedTunnel(url, fingerprint);
  cleanups.push(() => tunnel.close());
  return tunnel;
}

/**
 * Sends a WebSocket upgrade to `wsUrl` (a tunnel's address) as plain bytes. `head` resolves with the response head, or
 * with what had arrived when the connection closed; `whole` with everything received, once the connection has closed.
 */
function upgradeThrough(wsUrl: string, token = TOKEN) {
  const u = new URL(wsUrl);
  const socket = netConnect(Number(u.port), u.hostname);
  cleanups.push(() => { socket.destroy(); });
  let got = '';
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const head = new Promise<string>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      got += chunk.toString('latin1');
      if (got.includes('\r\n\r\n')) resolve(got);
    });
    void closed.then(() => resolve(got));
  });
  socket.on('error', () => undefined);
  socket.write(
    `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  return { socket, head, closed, whole: closed.then(() => got), received: () => got };
}

describe('the pinned tunnel in front of the gate serving TLS itself', () => {
  it('accepts the fingerprint as the generator prints it, and in lowercase without colons', async () => {
    const { gate, url } = await start();
    expect(served.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    for (const fingerprint of [served.fingerprint, served.fingerprint.toLowerCase().replaceAll(':', '')]) {
      const tunnel = await tunnelTo(url, fingerprint);
      const up = upgradeThrough(tunnel.wsUrl);
      expect(await up.head).toMatch(/^HTTP\/1\.1 101 /);
      expect(tunnel.failure()).toBeUndefined();
    }
    expect(gate.stats().sessionsTotal).toBe(2);
  });

  it('the right token gets 101; the run-server sees the secret path and no Authorization header', async () => {
    const { gate, upgrades, url } = await start();
    const tunnel = await tunnelTo(url, served.fingerprint);
    const up = upgradeThrough(tunnel.wsUrl);
    expect(await up.head).toMatch(/^HTTP\/1\.1 101 /);
    expect(upgrades).toHaveLength(1);
    // The client's own path is replaced by the secret one; its query is kept.
    expect(upgrades[0].url).toBe(`${UPSTREAM_PATH}?session=1`);
    expect(upgrades[0].headers.authorization).toBeUndefined();
    expect(JSON.stringify(upgrades[0])).not.toContain(TOKEN);
    expect(gate.stats()).toMatchObject({ active: 1, sessionsTotal: 1 });
    // Bytes pass both ways through the tunnel, the gate and back.
    up.socket.write('ping');
    await expect.poll(() => up.received().endsWith('ping')).toBe(true);
  });

  it('a wrong token gets 401 through the tunnel', async () => {
    const { gate, upgrades, url } = await start();
    const tunnel = await tunnelTo(url, served.fingerprint);
    const answer = await upgradeThrough(tunnel.wsUrl, WRONG_TOKEN).whole;
    expect(answer).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
    expect(gate.stats()).toMatchObject({ sessionsTotal: 0, refused: { unauthorized: 1 } });
    expect(upgrades).toEqual([]);
    // The certificate matched: the refusal is the gate's, not the tunnel's.
    expect(tunnel.failure()).toBeUndefined();
  });

  it("a second session gets the gate's 503 busy answer whole", async () => {
    const { gate, url } = await start({ maxSessions: 1 });
    const first = upgradeThrough((await tunnelTo(url, served.fingerprint)).wsUrl);
    expect(await first.head).toMatch(/^HTTP\/1\.1 101 /);

    const answer = await upgradeThrough((await tunnelTo(url, served.fingerprint)).wsUrl).whole;
    expect(answer).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n/);
    expect(answer).toContain('\r\nX-RPA-Browser: busy\r\n');
    expect(answer).toContain('\r\nRetry-After: 2\r\n');
    expect(answer.endsWith('\r\n\r\nrpa-browser busy\n')).toBe(true);

    // Playwright's client, as the engine uses it: the status line and the body are in the connect error, which is what
    // the engine's retry reads (GATE_NO_SESSION in browser/session.ts).
    const viaClient = await tunnelTo(url, served.fingerprint);
    const err = await chromium.connect(viaClient.wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` }, timeout: bound(5000) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/\s503\b[^\n]*\n\s*rpa-browser busy\b/);

    expect(gate.stats()).toMatchObject({ active: 1, sessionsTotal: 1, refused: { capacity: 2 } });
    // The session that holds the slot is untouched.
    first.socket.write('ping');
    await expect.poll(() => first.received().endsWith('ping')).toBe(true);
  });

  it('another fingerprint gives the mismatch message and the gate counts no request', async () => {
    const { gate, upgrades, connections, url } = await start();
    const tunnel = await tunnelTo(url, other.fingerprint);
    const up = upgradeThrough(tunnel.wsUrl);
    await up.closed;
    expect(await up.head).toBe('');
    expect(tunnel.failure()).toBe(BROWSER_FINGERPRINT_MISMATCH);
    // Read once the gate's side of the connection has closed: a request sent before the check would have been counted by then.
    await expect.poll(() => connections.opened === 1 && connections.closed === 1).toBe(true);
    expect(gate.stats()).toMatchObject({
      active: 0, sessionsTotal: 0, refused: { capacity: 0, draining: 0, unauthorized: 0, forbidden: 0, bad_request: 0 },
    });
    expect(upgrades).toEqual([]);
  });

  it("a session idle past the gate's request deadline stays open; a connection that sends no request is closed at it", async () => {
    const { gate, url } = await start({ tlsRequestDeadlineMs: 300 });
    const tunnel = await tunnelTo(url, served.fingerprint);
    const up = upgradeThrough(tunnel.wsUrl);
    expect(await up.head).toMatch(/^HTTP\/1\.1 101 /);
    let closed = false;
    void up.closed.then(() => { closed = true; });

    // The deadline is in force on this gate: a connection through a tunnel that never sends a request is closed at it.
    const silentTunnel = await tunnelTo(url, served.fingerprint);
    const t0 = Date.now();
    const silent = netConnect(Number(new URL(silentTunnel.wsUrl).port), '127.0.0.1');
    cleanups.push(() => { silent.destroy(); });
    silent.on('error', () => undefined);
    await new Promise<void>((resolve) => silent.once('close', () => resolve()));
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(bound(3000));

    // Four deadlines, with nothing sent in either direction.
    await sleep(1200);
    expect(closed).toBe(false);
    expect(gate.stats()).toMatchObject({ active: 1, sessionsTotal: 1 });
    up.socket.write('still here');
    await expect.poll(() => up.received().endsWith('still here')).toBe(true);
  });
});
