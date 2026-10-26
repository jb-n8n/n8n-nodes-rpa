import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { chromium, type BrowserServer } from 'playwright-core';
import { openSession, type Session } from '../src/browser/session.js';
import { createMasker } from '../src/secrets/mask.js';
import type { BrowserEndpoint } from '../src/types.js';
import { LOCAL, policyFor } from './helpers.js';

/**
 * Paths that context.route and routeWebSocket never see: shared workers, WebSockets opened from worker scopes,
 * WebSocketStream, WebTransport and WebRTC. An off-list host is a raw TCP server on another loopback port; the checks
 * hold only when it receives no connection at all.
 */
const masker = createMasker([]);
let off: TcpServer;
let offPort = 0;
let connections = 0;
const sockets = new Set<Socket>();
let site: HttpServer;
let sitePort = 0;
let remoteServer: BrowserServer;

const scripts = (offUrl: string, offWs: string): Record<string, string> => ({
  '/shared.js': `
    const report = [];
    fetch(${JSON.stringify(offUrl)}).then((r) => r.text()).then((t) => report.push('get:' + t), () => report.push('get:failed'));
    fetch(${JSON.stringify(offUrl)}, { method: 'POST', body: 'leak' }).then((r) => r.text()).then((t) => report.push('post:' + t), () => report.push('post:failed'));
    onconnect = (e) => { e.ports[0].postMessage(report); };`,
  '/ws-worker.js': `
    let opened = typeof WebSocket;
    try { new WebSocket(${JSON.stringify(offWs)}); } catch (e) { opened += ':threw'; }
    try { new WebSocketStream(${JSON.stringify(offWs)}); } catch (e) { opened += ':stream-threw'; }
    postMessage(opened);`,
  '/ws-module.js': `
    let opened = typeof WebSocket;
    try { new WebSocket(${JSON.stringify(offWs)}); } catch (e) { opened += ':threw'; }
    postMessage(opened);
    export {};`,
  '/nested.js': `
    const w = new Worker('ws-worker.js');
    w.onmessage = (e) => postMessage('nested:' + e.data);`,
  '/fetch-worker.js': `
    fetch('/data').then((r) => r.text()).then((t) => postMessage(t), (e) => postMessage('failed:' + e));`,
  '/fetch-module.js': `
    const t = await (await fetch('data')).text();
    postMessage(t + ':' + (typeof WebSocket));`,
  '/off-fetch-worker.js': `
    fetch(${JSON.stringify(offUrl)}).then(() => postMessage('sent'), () => postMessage('blocked'));`,
});

beforeAll(async () => {
  off = createTcpServer((s) => {
    connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => undefined);
    // Answer anything as HTTP so a successful read is visible, then hang up.
    s.once('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\naccess-control-allow-origin: *\r\n\r\nLEAKED'));
  });
  await new Promise<void>((r) => off.listen(0, '127.0.0.1', r));
  offPort = (off.address() as { port: number }).port;
  const files = scripts(`http://127.0.0.1:${offPort}/x`, `ws://127.0.0.1:${offPort}/x`);
  site = createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (files[path] !== undefined) {
      res.setHeader('content-type', 'text/javascript');
      res.end(files[path]);
    } else if (path === '/data') {
      res.setHeader('content-type', 'text/plain');
      res.end('worker-data');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><html><head><title>t</title></head><body><p>page</p></body></html>');
    }
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  sitePort = (site.address() as { port: number }).port;
  remoteServer = await chromium.launchServer({ headless: true });
});
afterAll(async () => {
  await remoteServer.close();
  for (const s of sockets) s.destroy();
  await new Promise((r) => off.close(r));
  await new Promise((r) => site.close(r));
});
beforeEach(() => { connections = 0; });

// A loopback connection reaches the off-list server within milliseconds of the page starting it.
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const endpoints = (): Array<[string, () => BrowserEndpoint]> => [
  ['local', () => LOCAL],
  ['playwright server', () => ({ mode: 'playwright', wsUrl: remoteServer.wsEndpoint() })],
];

async function withPage(endpoint: BrowserEndpoint, fn: (s: Session) => Promise<void>): Promise<void> {
  const host = `127.0.0.1:${sitePort}`;
  const s = await openSession({ endpoint, policy: policyFor({ url: `http://${host}`, host }), masker });
  try {
    await s.page.goto(`http://${host}/page`);
    await fn(s);
  } finally { await s.close(); }
}

describe.each(endpoints())('egress paths the route handler cannot see (%s)', (_name, endpoint) => {
  it('a page cannot start a shared worker: its GET and POST never reach an off-list host', async () => {
    await withPage(endpoint(), async (s) => {
      const result = await s.page.evaluate(() => new Promise<string>((resolve) => {
        if (typeof SharedWorker === 'undefined') { resolve('no SharedWorker'); return; }
        try {
          const w = new SharedWorker('/shared.js');
          w.port.onmessage = (e) => setTimeout(() => resolve(JSON.stringify(e.data)), 1_000);
          w.port.start();
        } catch (e) { resolve(`threw: ${String(e)}`); }
        setTimeout(() => resolve('timeout'), 3_000);
      }));
      await settle();
      expect({ result, connections }).toEqual({ result: 'no SharedWorker', connections: 0 });
    });
  });

  it('worker scopes have no WebSocket: classic, module, blob and nested workers never reach an off-list host', async () => {
    await withPage(endpoint(), async (s) => {
      const reports = await s.page.evaluate(async (wsUrl) => {
        const run = (w: Worker) => new Promise<string>((resolve) => {
          w.onmessage = (e) => resolve(String(e.data));
          w.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 3_000);
        });
        const blob = URL.createObjectURL(new Blob([`let o = typeof WebSocket; try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) { o += ':threw'; } postMessage(o);`]));
        return Promise.all([
          run(new Worker('/ws-worker.js')),
          run(new Worker('/ws-module.js', { type: 'module' })),
          run(new Worker(blob)),
          run(new Worker('/nested.js')),
        ]);
      }, `ws://127.0.0.1:${offPort}/x`);
      await settle();
      expect({ reports, connections }).toEqual({
        reports: ['undefined:threw:stream-threw', 'undefined:threw', 'undefined:threw', 'nested:undefined:threw:stream-threw'], connections: 0,
      });
    });
  });

  it('page windows have no WebSocketStream or WebTransport (routeWebSocket only covers WebSocket)', async () => {
    await withPage(endpoint(), async (s) => {
      const types = await s.page.evaluate((wsUrl) => {
        const g = globalThis as Record<string, unknown>;
        try { new (g.WebSocketStream as new (u: string) => unknown)(wsUrl); } catch { /* removed */ }
        return [typeof g.WebSocketStream, typeof g.WebTransport];
      }, `ws://127.0.0.1:${offPort}/x`);
      await settle();
      expect({ types, connections }).toEqual({ types: ['undefined', 'undefined'], connections: 0 });
    });
  });

  it('WebRTC is unavailable: a TURN-over-TCP server on an off-list host is never contacted', async () => {
    await withPage(endpoint(), async (s) => {
      const result = await s.page.evaluate(async (turn) => {
        const g = globalThis as Record<string, unknown>;
        const types = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].map((k) => typeof g[k]).join(',');
        try {
          const pc = new RTCPeerConnection({ iceServers: [{ urls: turn, username: 'u', credential: 'p' }], iceTransportPolicy: 'relay' });
          pc.createDataChannel('x');
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise((r) => setTimeout(r, 1_500));
          return `${types} opened`;
        } catch { return types; }
      }, `turn:127.0.0.1:${offPort}?transport=tcp`);
      await settle();
      expect({ result, connections }).toEqual({ result: 'undefined,undefined,undefined', connections: 0 });
    });
  });

  it('page script cannot restore what was removed, nor reach it from a fresh frame or popup', async () => {
    await withPage(endpoint(), async (s) => {
      const report = await s.page.evaluate(async (wsUrl) => {
        const g = globalThis as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        try { delete g.SharedWorker; } catch { /* non-configurable */ }
        try { g.SharedWorker = function fake() { /* page */ }; } catch { /* non-writable */ }
        try { Object.defineProperty(g, 'RTCPeerConnection', { value: 1 }); } catch { /* non-configurable */ }
        try { Object.defineProperty(g, 'Worker', { value: 1 }); } catch { /* non-configurable */ }
        out.top = [typeof g.SharedWorker, typeof g.RTCPeerConnection, typeof g.Worker];
        out.ctor = Worker.prototype.constructor === Worker;
        const realms: Array<[string, Window | null]> = [];
        const blank = document.createElement('iframe');
        document.body.append(blank);
        realms.push(['about:blank', blank.contentWindow]);
        const srcdoc = document.createElement('iframe');
        srcdoc.srcdoc = '<p>x</p>';
        document.body.append(srcdoc);
        realms.push(['srcdoc (sync)', srcdoc.contentWindow]);
        const sandboxed = document.createElement('iframe');
        sandboxed.setAttribute('sandbox', 'allow-same-origin');
        document.body.append(sandboxed);
        realms.push(['sandbox allow-same-origin', sandboxed.contentWindow]);
        realms.push(['popup', window.open('')]);
        out.realms = realms.map(([name, w]) => {
          const r = (w ?? {}) as Record<string, unknown>;
          return `${name}:${typeof r.SharedWorker},${typeof r.RTCPeerConnection},${typeof r.WebSocketStream}`;
        });
        // A worker started through a child frame's Worker has no WebSocket either.
        const FrameWorker = (blank.contentWindow as unknown as { Worker: typeof Worker }).Worker;
        const blob = URL.createObjectURL(new Blob([`let o = typeof WebSocket; try { new WebSocket(${JSON.stringify(wsUrl)}); } catch (e) { o += ':threw'; } postMessage(o);`]));
        out.frameWorker = await new Promise<string>((resolve) => {
          const w = new FrameWorker(blob);
          w.onmessage = (e) => resolve(String(e.data));
          w.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 3_000);
        });
        return out;
      }, `ws://127.0.0.1:${offPort}/x`);
      await settle();
      expect(report).toEqual({
        top: ['undefined', 'undefined', 'function'],
        ctor: true,
        realms: [
          'about:blank:undefined,undefined,undefined',
          'srcdoc (sync):undefined,undefined,undefined',
          'sandbox allow-same-origin:undefined,undefined,undefined',
          'popup:undefined,undefined,undefined',
        ],
        frameWorker: 'undefined:threw',
      });
      expect(connections).toBe(0);
    });
  });

  it('a dedicated worker still fetches from the allowed site (relative URLs included); its off-list fetch is blocked and logged', async () => {
    await withPage(endpoint(), async (s) => {
      const result = await s.page.evaluate(() => {
        const run = (w: Worker) => new Promise<string>((resolve) => {
          w.onmessage = (e) => resolve(String(e.data));
          w.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 5_000);
        });
        return Promise.all([
          run(new Worker('/fetch-worker.js')),
          run(new Worker('fetch-module.js', { type: 'module' })),
          run(new Worker('/off-fetch-worker.js')),
        ]);
      });
      expect(result).toEqual(['worker-data', 'worker-data:undefined', 'blocked']);
      expect(connections).toBe(0);
      expect(s.violations).toContainEqual(expect.objectContaining({ kind: 'host', fatal: false, url: `http://127.0.0.1:${offPort}/x` }));
      expect(s.closed).toBe(false);
    });
  });
});
