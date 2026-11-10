import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { chromium, type Browser, type BrowserServer } from 'playwright-core';
import { createGate, MIN_TOKEN_LENGTH } from 'n8n-rpa-gate';
import { BrowserUnavailableError, NoFreeSessionError, openSession, SESSION_WAIT_MS, type ConnectServer } from '../src/browser/session.js';
import { openLaneRuntime, CANCELLED } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import {
  BROWSER_CERT_NOT_TRUSTED, BROWSER_CERT_NOT_TRUSTED_CDP, BROWSER_FINGERPRINT_INVALID, BROWSER_FINGERPRINT_MISMATCH, BROWSER_FINGERPRINT_NEEDS_WSS,
  browserUnreachable, noFreeBrowserSession, tokenRefused,
} from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { selfSignedCert } from './fake-runner-cert.js';
import { baselineScript, connectRefused, policyFor, SECRETS, signedLaneInput } from './helpers.js';
import { bound } from './timing.js';

/**
 * A Browser Server endpoint whose gate answers 503 busy/draining is retried with backoff for up to
 * sessionWaitMs, then fails browser_unavailable with noFreeBrowserSession. The gate is the real one
 * (images/browser/gate) with one session per replica, in front of a real Playwright run-server.
 */
const TOKEN = 'g'.repeat(MIN_TOKEN_LENGTH);
const UPSTREAM_PATH = `/${'u'.repeat(32)}`;
const masker = createMasker([TOKEN]);
const policy = policyFor({ url: 'http://127.0.0.1:9', host: '127.0.0.1:9' });

let runServer: BrowserServer;
beforeAll(async () => { runServer = await chromium.launchServer({ headless: true, host: '127.0.0.1', port: 0, wsPath: UPSTREAM_PATH }); });
afterAll(async () => { await runServer.close(); });

type Gate = ReturnType<typeof createGate>;

/** A real gate with one session in front of the run-server, and its client-facing URL. */
async function startGate(): Promise<{ gate: Gate; url: string; port: number }> {
  const gate = createGate({ token: TOKEN, upstreamPort: Number(new URL(runServer.wsEndpoint()).port), upstreamPath: UPSTREAM_PATH, maxSessions: 1 });
  await new Promise<void>((r) => gate.listen(0, '127.0.0.1', r));
  const port = (gate.address() as { port: number }).port;
  return { gate, port, url: `ws://127.0.0.1:${port}/` };
}
const closeGate = async (gate: Gate) => { gate.closeAllConnections(); await new Promise((r) => gate.close(r)); };
/** Takes the gate's only session. */
const hold = (url: string): Promise<Browser> => chromium.connect(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
const endpoint = (url: string, over: Partial<BrowserEndpoint> = {}): BrowserEndpoint => ({ mode: 'playwright', wsUrl: url, token: TOKEN, ...over });

describe('waiting for a free browser session', () => {
  it('waits 60 s by default', () => {
    expect(SESSION_WAIT_MS).toBe(60_000);
  });

  it('a busy replica then a free one connects', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const t0 = Date.now();
      setTimeout(() => { void held.close(); }, 2000);
      const s = await openSession({ endpoint: endpoint(url), policy, masker });
      const took = Date.now() - t0;
      try {
        expect(s.closed).toBe(false);
        expect(took).toBeGreaterThanOrEqual(1900);
        expect(took).toBeLessThan(bound(10_000, 60_000));
        expect(gate.stats().refused.capacity).toBeGreaterThanOrEqual(1);
        expect(gate.stats().sessionsTotal).toBe(2);
      } finally { await s.close(); }
    } finally { await held.close().catch(() => undefined); await closeGate(gate); }
  });

  it('waits for a free session and then fails clearly', async () => {
    const { gate, port } = await startGate();
    const held = await hold(`ws://127.0.0.1:${port}/`);
    try {
      const t0 = Date.now();
      const err = await openSession({
        endpoint: endpoint(`ws://someone:hunter22@127.0.0.1:${port}/pw?session=abc`, { sessionWaitMs: 3000 }), policy, masker,
      }).catch((e: Error) => e);
      const took = Date.now() - t0;
      expect(err).toBeInstanceOf(NoFreeSessionError);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(noFreeBrowserSession(`ws://127.0.0.1:${port}/pw`, 3));
      expect((err as Error).message).toBe(
        `The browser service at ws://127.0.0.1:${port}/pw had no free browser session for 3 s. Add browser capacity (more replicas or sessions per replica) or start fewer RPA runs at once.`,
      );
      expect((err as Error).message).not.toMatch(/abc|someone|hunter22|g{32}/);
      expect(took).toBeGreaterThanOrEqual(2900);
      expect(took).toBeLessThan(bound(5000));
      expect(gate.stats().refused.capacity).toBeGreaterThanOrEqual(3);
    } finally { await held.close(); await closeGate(gate); }
  });

  it('a wrong token still fails at once', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const t0 = Date.now();
      const err = await openSession({ endpoint: endpoint(url, { token: 'wrong-token-123456' }), policy, masker: createMasker(['wrong-token-123456']) })
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(tokenRefused(url));
      expect(Date.now() - t0).toBeLessThan(bound(1000));
      expect(gate.stats().refused.unauthorized).toBe(1);
      expect(gate.stats().refused.capacity).toBe(0);
    } finally { await held.close(); await closeGate(gate); }
  });

  it('a draining replica is a busy one: sessionWaitMs 0 fails at the first refusal', async () => {
    const { gate, url } = await startGate();
    void gate.drain(60_000);
    try {
      const t0 = Date.now();
      const err = await openSession({ endpoint: endpoint(url, { sessionWaitMs: 0 }), policy, masker }).catch((e: Error) => e);
      expect((err as Error).message).toBe(noFreeBrowserSession(url, 0));
      expect(Date.now() - t0).toBeLessThan(bound(1000));
      expect(gate.stats().refused.draining).toBe(1);
    } finally { await closeGate(gate); }
  });

  it('backs off 1, 2, 4, then 5 s with ±20 % jitter, the last sleep shortened to the wait', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const schedule = async (random: number, sessionWaitMs: number) => {
        let clock = 1_000_000;
        const sleeps: number[] = [];
        const err = await openSession({
          endpoint: endpoint(url, { sessionWaitMs }), policy, masker,
          sessionWait: { now: () => clock, random: () => random, sleep: async (ms: number) => { sleeps.push(ms); clock += ms; } },
        }).catch((e: Error) => e);
        expect((err as Error).message).toBe(noFreeBrowserSession(url, Math.round(sessionWaitMs / 1000)));
        return sleeps;
      };
      expect(await schedule(0.5, 20_000)).toEqual([1000, 2000, 4000, 5000, 5000, 3000]);
      expect(await schedule(1, 20_000)).toEqual([1200, 2400, 4800, 6000, 5600]);
      expect(await schedule(0, 20_000)).toEqual([800, 1600, 3200, 4000, 4000, 4000, 2400]);
      expect(await schedule(0.5, 2500)).toEqual([1000, 1500]);
    } finally { await held.close(); await closeGate(gate); }
  });

  it('a cancellation during a backoff sleep connects no more', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const ac = new AbortController();
      const err = await openSession({
        endpoint: endpoint(url), policy, masker, signal: ac.signal,
        sessionWait: { sleep: async () => { ac.abort(); } },
      }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(NoFreeSessionError);
      expect(gate.stats().refused.capacity).toBe(1);
    } finally { await held.close(); await closeGate(gate); }
  });

  it('the run deadline caps the wait', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const t0 = Date.now();
      const err = await openSession({ endpoint: endpoint(url), policy, masker, deadlineMs: Date.now() + 1800 }).catch((e: Error) => e);
      // 1.8 s of sleeps plus the connects around them.
      expect((err as Error).message).toMatch(/ had no free browser session for [23] s\. /);
      expect(Date.now() - t0).toBeLessThan(bound(3500));
      // A run budget is the same deadline: the lane never waits past it.
      const t1 = Date.now();
      const lane = await openLaneRuntime({ endpoint: endpoint(url), policy, masker, budgetMs: 1000, trace: false }).catch((e: Error) => e);
      expect(lane).toBeInstanceOf(BrowserUnavailableError);
      expect(Date.now() - t1).toBeLessThan(bound(2500));
    } finally { await held.close(); await closeGate(gate); }
  });

  it('a cancelled run stops waiting and reports the cancellation', async () => {
    const { gate, url } = await startGate();
    const held = await hold(url);
    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300);
      const t0 = Date.now();
      const err = await openSession({ endpoint: endpoint(url), policy, masker, signal: ac.signal }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect(Date.now() - t0).toBeLessThan(bound(1500));
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 300);
      const t1 = Date.now();
      const r = await runTask(signedLaneInput(baselineScript('http://127.0.0.1:9'), { policy, endpoint: endpoint(url), secrets: SECRETS, signal: ac2.signal }));
      expect(r).toMatchObject({ ok: false, code: 'incomplete', message: CANCELLED });
      expect(Date.now() - t1).toBeLessThan(bound(1500));
      // A first run (no steps, AI repair on) opens the browser on its own path in runTask.
      const ac3 = new AbortController();
      setTimeout(() => ac3.abort(), 300);
      const t2 = Date.now();
      const first = await runTask({
        script: undefined, trust: { required: false }, policy, endpoint: endpoint(url), output: { idPattern: 'N26-\\d{4}' }, signal: ac3.signal,
        repair: { model: fakeModel([]), goal: 'Read every row.', name: 'first-run' },
      });
      expect(first).toMatchObject({ ok: false, lane: 'agent', code: 'incomplete', message: CANCELLED });
      expect(Date.now() - t2).toBeLessThan(bound(1500));
    } finally { await held.close(); await closeGate(gate); }
  });
});

describe('what is not waited on', () => {
  let srv: HttpServer;
  let port = 0;
  let body = '';
  beforeAll(async () => {
    srv = createHttpServer((_q, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end(body); });
    srv.on('upgrade', (_q, socket) => {
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as { port: number }).port;
  });
  afterAll(async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); });

  it('a 503 without the gate marker (some other proxy) fails at once as unreachable', async () => {
    body = '';
    const t0 = Date.now();
    const err = await openSession({ endpoint: { mode: 'playwright', wsUrl: `ws://127.0.0.1:${port}/` }, policy, masker }).catch((e: Error) => e);
    expect((err as Error).message).toBe(browserUnreachable(`ws://127.0.0.1:${port}/`));
    expect(Date.now() - t0).toBeLessThan(bound(1000));
  });

  it('a CDP endpoint is never waited on, even behind a busy answer', async () => {
    body = 'rpa-browser busy\n';
    const t0 = Date.now();
    const err = await openSession({ endpoint: { mode: 'cdp', wsUrl: `ws://127.0.0.1:${port}/` }, policy, masker }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).not.toBe(noFreeBrowserSession(`ws://127.0.0.1:${port}/`, 0));
    expect(Date.now() - t0).toBeLessThan(bound(1000));
  });
});

/**
 * A Browser Server reached over wss:// with a self-signed certificate, trusted by its SHA-256 fingerprint. The server
 * is the real gate in front of the real run-server, behind a TLS listener that records the bytes it decrypted.
 */
describe('a wss:// browser server pinned by its certificate fingerprint', () => {
  const served = selfSignedCert('browser-server');
  const other = selfSignedCert('browser-server');
  let gate: Gate;
  let tls: TlsServer;
  let url = '';
  let received = 0;
  /** Connections the TLS listener accepted, and those whose server side has ended: closed, or failed during the handshake. */
  let opened = 0;
  let settled = 0;
  beforeAll(async () => {
    const started = await startGate();
    gate = started.gate;
    tls = createTlsServer({ key: served.key, cert: served.cert }, (socket) => {
      const upstream = netConnect(started.port, '127.0.0.1');
      socket.on('data', (chunk: Buffer) => { received += chunk.length; });
      socket.once('close', () => { settled += 1; });
      socket.on('error', () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    tls.on('connection', () => { opened += 1; });
    // A client that leaves during the handshake (a refused certificate) never reaches the handler above.
    tls.on('tlsClientError', () => { settled += 1; });
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    url = `wss://127.0.0.1:${(tls.address() as { port: number }).port}/`;
  });
  afterAll(async () => { await new Promise((r) => tls.close(r)); await closeGate(gate); });

  /** Whether a TCP connect to the loopback port of `wsUrl` (the tunnel's address) is refused. */
  const refused = (wsUrl: string) => connectRefused(Number(new URL(wsUrl).port));
  /** The connect seam: records the URL the session hands to chromium.connect, then connects for real. */
  const recording = (urls: string[]): ConnectServer => (wsUrl, options) => {
    urls.push(wsUrl);
    return chromium.connect(wsUrl, options);
  };

  it('a fingerprint with ws:// or outside Browser Server mode is refused', async () => {
    const urls: string[] = [];
    const fingerprint = served.fingerprint;
    for (const refusedEndpoint of [
      { mode: 'playwright', wsUrl: 'ws://10.0.0.5:3000', fingerprint },
      { mode: 'cdp', wsUrl: 'wss://x', fingerprint },
      { mode: 'local', fingerprint },
    ] satisfies BrowserEndpoint[]) {
      const err = await openSession({ endpoint: refusedEndpoint, policy, masker, connectServer: recording(urls) }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message).toBe(BROWSER_FINGERPRINT_NEEDS_WSS);
    }
    expect(urls).toEqual([]);
  });

  it('a malformed fingerprint is refused before any connection', async () => {
    const urls: string[] = [];
    const err = await openSession({ endpoint: endpoint(url, { fingerprint: 'abc' }), policy, masker, connectServer: recording(urls) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(BROWSER_FINGERPRINT_INVALID);
    expect(urls).toEqual([]);
  });

  it('a wrong fingerprint fails as browser unavailable with the mismatch message', async () => {
    received = 0;
    const sessions = gate.stats().sessionsTotal;
    const connections = opened;
    const urls: string[] = [];
    const t0 = Date.now();
    const err = await openSession({ endpoint: endpoint(url, { fingerprint: other.fingerprint }), policy, masker, connectServer: recording(urls) })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(BROWSER_FINGERPRINT_MISMATCH);
    expect(Date.now() - t0).toBeLessThan(bound(2000));
    // Read once the server's side of the connection has ended: bytes sent before the check would have arrived by then.
    await expect.poll(() => opened === connections + 1 && settled === opened).toBe(true);
    // Neither the upgrade request nor the token left this process, and the tunnel is gone.
    expect(received).toBe(0);
    expect(gate.stats().sessionsTotal).toBe(sessions);
    expect(urls).toHaveLength(1);
    expect(await refused(urls[0])).toBe(true);
  });

  it('a matching fingerprint connects through a loopback tunnel that closes with the session', async () => {
    const urls: string[] = [];
    const sessions = gate.stats().sessionsTotal;
    const connections = opened;
    const s = await openSession({ endpoint: endpoint(url, { fingerprint: served.fingerprint.toLowerCase() }), policy, masker, connectServer: recording(urls) });
    try {
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/);
      expect(await s.page.evaluate(() => 1 + 1)).toBe(2);
      // The token went through the tunnel to the gate, which checks it before it admits a session.
      expect(gate.stats().sessionsTotal).toBe(sessions + 1);
      // The tunnel still holds its port, and a second connect to it reaches nothing: the server saw one connection.
      expect(await refused(urls[0])).toBe(false);
      expect(await s.page.evaluate(() => 2 + 2)).toBe(4);
      expect(opened).toBe(connections + 1);
      expect(settled).toBe(connections);
    } finally { await s.close(); }
    await expect.poll(() => refused(urls[0])).toBe(true);
    await expect.poll(() => settled).toBe(connections + 1);
  });

  it('a browser that had already disconnected when the connect returned leaves no tunnel open', async () => {
    const urls: string[] = [];
    const err = await openSession({
      endpoint: endpoint(url, { fingerprint: served.fingerprint }), policy, masker,
      // The connection ends before the session can listen for its end: the disconnect event has fired by then.
      connectServer: async (wsUrl, options) => {
        urls.push(wsUrl);
        const browser = await chromium.connect(wsUrl, options);
        await browser.close();
        return browser;
      },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(urls).toHaveLength(1);
    await expect.poll(() => refused(urls[0])).toBe(true);
  });

  it('a redirect from the pinned server opens no second connection through the tunnel', async () => {
    // A pinned server that answers the upgrade with a redirect, and records each connection's request.
    const requests: string[] = [];
    let location = '';
    const redirecting = createTlsServer({ key: served.key, cert: served.cert }, (socket) => {
      const index = requests.push('') - 1;
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        const answered = requests[index].includes('\r\n\r\n');
        requests[index] += chunk.toString('latin1');
        if (answered || !requests[index].includes('\r\n\r\n')) return;
        const host = /^host: (.+)$/im.exec(requests[index])?.[1].trim() ?? '';
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${location.replace('{host}', host)}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      });
    });
    redirecting.on('tlsClientError', () => undefined);
    await new Promise<void>((r) => redirecting.listen(0, '127.0.0.1', r));
    const wsUrl = `wss://127.0.0.1:${(redirecting.address() as { port: number }).port}/`;
    try {
      // A relative Location, which Playwright does not take as a URL, and one that names the address the request came
      // through (the tunnel's own): Playwright connects there again, and the tunnel closes that second connection.
      for (const to of ['/elsewhere', 'ws://{host}/elsewhere']) {
        location = to;
        requests.length = 0;
        const urls: string[] = [];
        const t0 = Date.now();
        const err = await openSession({ endpoint: endpoint(wsUrl, { fingerprint: served.fingerprint }), policy, masker, connectServer: recording(urls) })
          .catch((e: Error) => e);
        expect(err).toBeInstanceOf(BrowserUnavailableError);
        expect((err as Error).message).toBe(browserUnreachable(wsUrl));
        expect(Date.now() - t0).toBeLessThan(bound(2000));
        // The one request the server saw is the first, which the pin admitted. No second connection carried the token.
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain(`Host: ${new URL(urls[0]).host}`);
        expect(requests[0]).toContain(`Authorization: Bearer ${TOKEN}`);
        expect(await refused(urls[0])).toBe(true);
      }
    } finally { await new Promise((r) => redirecting.close(r)); }
  });

  it('a pinned server that is not reachable fails as unreachable at its wss:// address', async () => {
    // A loopback port nothing listens on.
    const idle = createNetServer();
    await new Promise<void>((r) => idle.listen(0, '127.0.0.1', r));
    const closedPort = (idle.address() as { port: number }).port;
    await new Promise((r) => idle.close(r));
    const urls: string[] = [];
    const err = await openSession({
      endpoint: endpoint(`wss://127.0.0.1:${closedPort}/pw?session=abc`, { fingerprint: served.fingerprint }), policy, masker, connectServer: recording(urls),
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(browserUnreachable(`wss://127.0.0.1:${closedPort}/pw`));
    // Playwright connected to the tunnel, and its loopback address is not what the user is shown.
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).port).not.toBe(String(closedPort));
    expect((err as Error).message).not.toContain(new URL(urls[0]).host);
    expect((err as Error).message).not.toContain('abc');
    expect(await refused(urls[0])).toBe(true);
  });

  it('no fingerprint leaves wss:// connecting as before', async () => {
    const urls: string[] = [];
    const wsUrl = 'wss://browser.example:3000/pw?session=abc';
    const err = await openSession({
      endpoint: endpoint(wsUrl), policy, masker,
      connectServer: async (given) => { urls.push(given); throw new Error('connect ECONNREFUSED'); },
    }).catch((e: Error) => e);
    expect(urls).toEqual([wsUrl]);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(browserUnreachable('wss://browser.example:3000/pw'));
  });

  it('a certificate n8n does not trust, with no fingerprint, fails with a message that names the Certificate Fingerprint field', async () => {
    received = 0;
    const sessions = gate.stats().sessionsTotal;
    const err = await openSession({ endpoint: endpoint(`${url}pw?session=abc`), policy, masker }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(BROWSER_CERT_NOT_TRUSTED);
    expect((err as Error).message).toBe(
      "n8n does not trust the browser server's certificate. If the server uses a certificate of its own, put its SHA-256 fingerprint in Certificate Fingerprint (SHA-256) on the RPA Browser credential.",
    );
    // Over https:// (a Chrome DevTools Protocol endpoint's discovery address) and over wss:// in that mode, the message
    // names no Certificate Fingerprint field: the credential has none in CDP mode.
    for (const wsUrl of [url.replace('wss://', 'https://'), url]) {
      const cdp = await openSession({ endpoint: { mode: 'cdp', wsUrl, token: TOKEN }, policy, masker }).catch((e: Error) => e);
      expect(cdp, wsUrl).toBeInstanceOf(BrowserUnavailableError);
      expect((cdp as Error).message, wsUrl).toBe(BROWSER_CERT_NOT_TRUSTED_CDP);
      expect((cdp as Error).message, wsUrl).toBe(
        "n8n does not trust the browser server's certificate. Use a certificate that n8n's Node.js process trusts, for example one from an authority listed in NODE_EXTRA_CA_CERTS.",
      );
    }
    // Each handshake was with the configured address itself and failed in this process: neither a request nor the token reached the server.
    await expect.poll(() => settled === opened).toBe(true);
    expect(received).toBe(0);
    expect(gate.stats().sessionsTotal).toBe(sessions);
  });

  it('the certificate failures Node reports get that message, with nothing of the raw error in it', async () => {
    const wsUrl = 'wss://browser.example:3000/pw?session=abc';
    for (const raw of [
      'self-signed certificate', 'self signed certificate', 'self-signed certificate in certificate chain', 'unable to verify the first certificate',
      'unable to get local issuer certificate', 'certificate has expired',
      // The names in the presented certificate are the server's own text: they choose no other message.
      "Hostname/IP does not match certificate's altnames: Host: browser.example. is not cert's CN: server version: v1.2 401",
      'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      const err = await openSession({
        endpoint: endpoint(wsUrl), policy, masker,
        connectServer: async (given) => { throw new Error(`browserType.connect: WebSocket error: ${raw}\nCall log:\n  - <ws connecting> ${given}`); },
      }).catch((e: Error) => e);
      expect(err, raw).toBeInstanceOf(BrowserUnavailableError);
      expect((err as Error).message, raw).toBe(BROWSER_CERT_NOT_TRUSTED);
    }
  });

  it('only the first line of the connect error is read for a certificate failure: a 401 whose body names a certificate is a refused token', async () => {
    const wsUrl = 'wss://browser.example:3000/pw?session=abc';
    const err = await openSession({
      endpoint: endpoint(wsUrl), policy, masker,
      // The server's certificate was accepted and it answered; the lines after the first are its response body.
      connectServer: async () => {
        throw new Error('browserType.connect: WebSocket error: wss://browser.example:3000/pw 401 Unauthorized\nself-signed certificate\nCall log:\n  - <ws connecting> wss://browser.example:3000/pw');
      },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(tokenRefused('wss://browser.example:3000/pw'));
  });

  it('a wss:// server that is not reachable, with no fingerprint, is still reported as unreachable', async () => {
    // A loopback port nothing listens on.
    const idle = createNetServer();
    await new Promise<void>((r) => idle.listen(0, '127.0.0.1', r));
    const closedPort = (idle.address() as { port: number }).port;
    await new Promise((r) => idle.close(r));
    const err = await openSession({ endpoint: endpoint(`wss://127.0.0.1:${closedPort}/pw?session=abc`), policy, masker }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(browserUnreachable(`wss://127.0.0.1:${closedPort}/pw`));
  });

  it('a ws:// endpoint never gets the certificate message, whatever its connect error says', async () => {
    const wsUrl = `ws://127.0.0.1:${new URL(url).port}/`;
    const err = await openSession({
      endpoint: endpoint(wsUrl), policy, masker,
      connectServer: async () => { throw new Error('browserType.connect: WebSocket error: self-signed certificate'); },
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toBe(browserUnreachable(wsUrl));
  });
});
