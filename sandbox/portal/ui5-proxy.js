// OpenUI5 at SAP's own path: /sap/public/bc/ui5_ui5/resources/<p> is fetched from the OpenUI5 CDN once, with
// Node's built-in fetch, and served from a disk cache after that. Realistic mode only (server.js). No dependencies.
// Safety: only GET and HEAD of a plain relative path (letters, digits, _ - . /, no "..", no empty or "." segment, no escapes, no query but
// UI5's own ?sap-ui-dist-version=1.148.10);
// the cache file must resolve inside the cache dir; failures are never cached; a fetch gives up after 10 s.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const UI5_VERSION = '1.148.10';
export const UI5_BASE = 'https://sdk.openui5.org/1.148.10/resources/';

const ROOT = '/sap/public/bc/ui5_ui5/';
const PREFIX = `${ROOT}resources/`;
const SAFE = /^[A-Za-z0-9_\-./]+$/;
const TIMEOUT_MS = 10_000;
const TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.properties': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// Per user (uid in the name), so another user of a shared host cannot pre-create or read the default directory; it is made 0700.
const uid = () => { try { return userInfo().uid; } catch { return 'u'; } };
const defaultCacheDir = () => process.env.UI5_CACHE_DIR || join(tmpdir(), `rpa-ui5-${UI5_VERSION}-${uid()}`);
const inflight = new Map(); // cache file -> Promise<Buffer> for a fetch in progress, so parallel misses share one download

// UI5 appends this cache-buster to theme CSS (library.css?sap-ui-dist-version=1.148.10); it is the only query accepted, and ignored.
const DIST_QUERY = `?sap-ui-dist-version=${UI5_VERSION}`;

// The relative resource path, or null when the request is not a resource path this proxy may serve.
function resourcePath(raw) {
  if (!raw.startsWith(PREFIX)) return null;
  const path = raw.endsWith(DIST_QUERY) ? raw.slice(0, -DIST_QUERY.length) : raw;
  const p = path.slice(PREFIX.length);
  if (!SAFE.test(p) || p.includes('..')) return null;
  if (p.split('/').some((seg) => seg === '' || seg === '.')) return null;
  return p;
}

async function download(fetchImpl, p, file) {
  const r = await fetchImpl(UI5_BASE + p, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (r.status === 404) return { status: 404 };
  if (r.status !== 200) return { status: 502, reason: `HTTP ${r.status}` };
  const body = Buffer.from(await r.arrayBuffer());
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file); // atomic: a reader never sees a half-written file
  } catch { /* a read-only or full disk only costs the cache */ }
  return { status: 200, body };
}

const reasonOf = (e) => {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timed out after ${TIMEOUT_MS / 1000} s`;
  const cause = e?.cause?.code || e?.cause?.message;
  return String(cause ? `${e.message}: ${cause}` : e?.message || e).replace(/[\r\n]+/g, ' ').slice(0, 200);
};

// Returns true when the request was handled: everything under /sap/public/bc/ui5_ui5/ is answered here.
export async function ui5Route(req, res, url, send, opts = {}) {
  const raw = req.url || '';
  if (!raw.startsWith(ROOT) && !url.pathname.startsWith(ROOT)) return false;
  const text = (status, body, headers = {}) => { send(res, status, body, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); return true; };
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) return text(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  const p = resourcePath(raw);
  if (!p) return text(404, 'not found');
  const cacheDir = resolve(opts.cacheDir || defaultCacheDir());
  const file = resolve(cacheDir, p);
  if (!file.startsWith(cacheDir + sep)) return text(404, 'not found');
  const ok = (body) => { send(res, 200, head ? '' : body, { 'Content-Type': TYPES[extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' }); return true; };

  try { return ok(await readFile(file)); } catch { /* a miss: fetch it */ }
  let pending = inflight.get(file);
  if (!pending) {
    pending = download(opts.fetch || globalThis.fetch, p, file).finally(() => inflight.delete(file));
    inflight.set(file, pending);
  }
  let got;
  try { got = await pending; } catch (e) { return text(502, `OpenUI5 could not be loaded from sdk.openui5.org (${reasonOf(e)})`); }
  if (got.status === 404) return text(404, 'not found');
  if (got.status !== 200) return text(502, `OpenUI5 could not be loaded from sdk.openui5.org (${got.reason})`);
  return ok(got.body);
}
