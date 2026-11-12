// n8n's public API for the two scripts that set n8n up: `npx n8n-nodes-rpa setup` (setup/setup.ts, bundled into
// dist/setup.mjs) and deploy/scripts/configure-n8n.mjs. Node 22+, no dependencies.
//
// Secrets never reach the output: every line a script prints passes through a redactor that knows them, which also
// covers server errors that echo the request body. The API key travels in a header only, never in a URL, and a
// redirect is refused, so the key is never replayed to another host.

const PAGE_LIMIT = 250; // the public API's maximum
const MAX_PAGES = 400;
const TIMEOUT_MS = 30_000;

/**
 * A redactor: add() registers a secret, redact() replaces every registered secret, and its URL-encoded and
 * JSON-escaped forms, with ***.
 */
export function createRedactor() {
  const secrets = new Set();
  return {
    add(secret) {
      if (typeof secret === 'string' && secret) secrets.add(secret);
    },
    redact(text) {
      let out = String(text);
      for (const s of secrets) {
        for (const form of new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)])) out = out.split(form).join('***');
      }
      return out;
    },
  };
}

/** localhost, 127.0.0.0/8 or ::1: http:// there never leaves the machine. */
export function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * n8n's base URL as typed → { origin, base (…/api/v1), plaintext (http:// to another machine) }, or { problem } in
 * words that name the flag.
 */
export function parseN8nUrl(value, flag) {
  let url;
  try { url = value && /^https?:\/\/[^\s'"]+$/.test(value) ? new URL(value) : null; } catch { url = null; }
  if (!url) return { problem: `${flag} must be n8n's http(s) base URL, for example https://n8n.example.com.` };
  if (url.username || url.password) return { problem: `${flag} must not carry a user or password: the API key goes in N8N_API_KEY.` };
  if (url.search || url.hash) return { problem: `${flag} must not carry a query or fragment.` };
  const origin = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return { origin, base: `${origin}/api/v1`, plaintext: url.protocol === 'http:' && !isLoopback(url.hostname) };
}

/**
 * A client for one n8n: api() never throws on an HTTP status, only on a network failure (its message redacted);
 * listAll() pages through a list; reason() is the server's error message, redacted and cut short.
 */
export function createClient({ base, apiKey, redact }) {
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { 'X-N8N-API-KEY': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error', // never replay the API key to another host
      });
    } catch (err) {
      throw new Error(redact(`${method} ${base}${path} failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`));
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }

  /** The server's error message, redacted and cut short; never the raw body of a credential request. */
  function reason(r) {
    const message = typeof r.json?.message === 'string' ? r.json.message : r.text;
    return redact(`HTTP ${r.status}${message ? `: ${String(message).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  }

  /** Every item of a paginated list (cursor pagination): { ok, items } or { ok: false, response }. */
  async function listAll(path, filter = {}) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...filter, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) });
      const r = await api('GET', `${path}?${query}`);
      if (r.status !== 200 || !Array.isArray(r.json?.data)) return { ok: false, response: r };
      items.push(...r.json.data);
      cursor = r.json.nextCursor;
      if (!cursor) return { ok: true, items };
    }
    return { ok: false, response: { status: 0, json: { message: `more than ${MAX_PAGES} pages` }, text: '' } };
  }

  return { api, reason, listAll };
}

/** A credential list's verdict on a name: { existing } (same name and type), { conflict } (same name, other type) or {}. */
export function findCredential(items, name, type, inProject = () => true) {
  const existing = items.find((c) => c?.name === name && inProject(c));
  if (existing && existing.type !== type) return { conflict: existing };
  return existing ? { existing } : {};
}
