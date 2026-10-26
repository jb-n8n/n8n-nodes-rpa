import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { chromium, type Browser, type BrowserServer } from 'playwright-core';
import { createGate, MIN_TOKEN_LENGTH } from 'n8n-rpa-gate';
import { BrowserUnavailableError, NoFreeSessionError, openSession, SESSION_WAIT_MS } from '../src/browser/session.js';
import { openLaneRuntime, CANCELLED } from '../src/lane/script-lane.js';
import { runTask } from '../src/lane/task.js';
import { browserUnreachable, noFreeBrowserSession, tokenRefused } from '../src/messages.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint } from '../src/types.js';
import { fakeModel } from './fake-model.js';
import { baselineScript, policyFor, SECRETS, signedLaneInput } from './helpers.js';

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
        expect(took).toBeLessThan(10_000);
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
      expect(took).toBeLessThan(5000);
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
      expect(Date.now() - t0).toBeLessThan(1000);
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
      expect(Date.now() - t0).toBeLessThan(1000);
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
      expect(Date.now() - t0).toBeLessThan(3500);
      // A run budget is the same deadline: the lane never waits past it.
      const t1 = Date.now();
      const lane = await openLaneRuntime({ endpoint: endpoint(url), policy, masker, budgetMs: 1000, trace: false }).catch((e: Error) => e);
      expect(lane).toBeInstanceOf(BrowserUnavailableError);
      expect(Date.now() - t1).toBeLessThan(2500);
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
      expect(Date.now() - t0).toBeLessThan(1500);
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 300);
      const t1 = Date.now();
      const r = await runTask(signedLaneInput(baselineScript('http://127.0.0.1:9'), { policy, endpoint: endpoint(url), secrets: SECRETS, signal: ac2.signal }));
      expect(r).toMatchObject({ ok: false, code: 'incomplete', message: CANCELLED });
      expect(Date.now() - t1).toBeLessThan(1500);
      // A first run (no steps, AI repair on) opens the browser on its own path in runTask.
      const ac3 = new AbortController();
      setTimeout(() => ac3.abort(), 300);
      const t2 = Date.now();
      const first = await runTask({
        script: undefined, trust: { required: false }, policy, endpoint: endpoint(url), output: { idPattern: 'N26-\\d{4}' }, signal: ac3.signal,
        repair: { model: fakeModel([]), goal: 'Read every row.', name: 'first-run' },
      });
      expect(first).toMatchObject({ ok: false, lane: 'agent', code: 'incomplete', message: CANCELLED });
      expect(Date.now() - t2).toBeLessThan(1500);
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
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a CDP endpoint is never waited on, even behind a busy answer', async () => {
    body = 'rpa-browser busy\n';
    const t0 = Date.now();
    const err = await openSession({ endpoint: { mode: 'cdp', wsUrl: `ws://127.0.0.1:${port}/` }, policy, masker }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).not.toBe(noFreeBrowserSession(`ws://127.0.0.1:${port}/`, 0));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
