/**
 * The context init script that closes the network paths context.route and routeWebSocket never see.
 *
 * Playwright intercepts requests from pages and dedicated workers, and routeWebSocket patches WebSocket in page windows
 * only. These leave the browser unchecked: shared workers (not intercepted at all), WebSocket and WebSocketStream in any
 * worker scope, WebSocketStream and WebTransport in a page window, and WebRTC (a TURN server over TCP is a raw connection).
 *
 * The script runs in every frame before page script (child frames and popups included, synchronously for about:blank):
 * - SharedWorker, WebSocketStream, WebTransport and every RTC* / webkitRTC* global are replaced by non-writable,
 *   non-configurable `undefined`, so page script can neither restore nor redefine them.
 * - Worker is wrapped (also non-writable, non-configurable): every worker starts from a blob bootstrap that runs this same
 *   function in the worker scope first, removing WebSocket too, and then loads the original script (importScripts for a
 *   classic worker, import() for a module worker). Requests the worker makes still go through context.route. Relative
 *   URLs in the worker resolve against the original script URL, as they would without the bootstrap.
 *
 * The source is a string, not a serialized function, so no transpiler helper can leak into it.
 */
const HARDEN_FUNCTION = String.raw`function harden(base) {
  'use strict';
  const g = globalThis;
  const SELF = '(' + harden.toString() + ')';
  const define = Object.defineProperty;
  const ownNames = Object.getOwnPropertyNames;
  const construct = Reflect.construct;
  const stringify = JSON.stringify;
  const URLC = g.URL;
  const BlobC = g.Blob;
  const createObjectURL = URLC.createObjectURL;
  const inWorker = base !== undefined;
  const lock = (o, k, value) => {
    try { delete o[k]; } catch (e) { /* already locked */ }
    try { define(o, k, { value, writable: false, configurable: false, enumerable: false }); } catch (e) { /* already locked */ }
  };
  const gone = ['SharedWorker', 'WebSocketStream', 'WebTransport'];
  if (inWorker) gone.push('WebSocket');
  for (const k of ownNames(g)) if (/^(webkit)?RTC/.test(k)) gone.push(k);
  for (const k of gone) lock(g, k, undefined);

  // Worker scopes: relative URLs resolve against the original script, not the blob bootstrap.
  if (inWorker) {
    const abs = (u) => (typeof u === 'string' || u instanceof URLC) ? new URLC(String(u), base).href : u;
    const loc = new URLC(base);
    const shown = {};
    for (const k of ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) shown[k] = loc[k];
    shown.toString = () => loc.href;
    try { define(g, 'location', { get: () => shown, configurable: true, enumerable: true }); } catch (e) { /* keep the native one */ }
    const fetchN = g.fetch;
    if (typeof fetchN === 'function') g.fetch = function fetch(input, init) { return fetchN.call(g, abs(input), init); };
    const RequestN = g.Request;
    if (typeof RequestN === 'function') {
      g.Request = class Request extends RequestN { constructor(input, init) { super(abs(input), init); } };
    }
    const importN = g.importScripts;
    if (typeof importN === 'function') g.importScripts = function importScripts(...urls) { return importN.apply(g, urls.map(abs)); };
    const XHR = g.XMLHttpRequest;
    if (typeof XHR === 'function') {
      const open = XHR.prototype.open;
      XHR.prototype.open = function (method, url, ...rest) { return open.call(this, method, abs(url), ...rest); };
    }
    const ES = g.EventSource;
    if (typeof ES === 'function') {
      g.EventSource = class EventSource extends ES { constructor(url, init) { super(abs(url), init); } };
    }
  }

  // Every worker, nested ones included, runs this function before its own code.
  const NativeWorker = g.Worker;
  if (typeof NativeWorker === 'function') {
    const resolveBase = () => (inWorker ? base : g.document.baseURI);
    const sameOrigin = (href) => {
      const u = new URLC(href);
      if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
      return u.origin === (inWorker ? new URLC(base).origin : g.location.origin);
    };
    const Worker = function Worker(url, options) {
      if (new.target === undefined) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
      const href = new URLC(String(url), resolveBase()).href;
      if (!sameOrigin(href)) {
        throw new DOMException("Failed to construct 'Worker': Script at '" + href + "' cannot be accessed from this origin.", 'SecurityError');
      }
      const module = options != null && options.type === 'module';
      const boot = SELF + '(' + stringify(href) + ');\n' + (module ? 'await import(' + stringify(href) + ');' : 'importScripts(' + stringify(href) + ');');
      const bootUrl = createObjectURL(new BlobC([boot], { type: 'text/javascript' }));
      return construct(NativeWorker, [bootUrl, options], new.target);
    };
    define(Worker, 'length', { value: 1, writable: false, configurable: true, enumerable: false });
    define(Worker, 'prototype', { value: NativeWorker.prototype, writable: false, configurable: false, enumerable: false });
    lock(NativeWorker.prototype, 'constructor', Worker);
    lock(g, 'Worker', Worker);
  }
}`;

/** The init script: hardens the frame it runs in. */
export const HARDEN_SCRIPT = `(${HARDEN_FUNCTION})(undefined);`;
