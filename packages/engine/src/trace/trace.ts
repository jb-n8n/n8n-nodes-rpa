import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Session } from '../browser/session.js';
import type { Masker } from '../secrets/mask.js';
import { isLoginPage } from '../steps/urls.js';
import type { PortalPolicy } from '../types.js';

export type SaveTrace = 'onFailure' | 'always' | 'never';

/** Whether a run that ended with `ok` keeps its trace under this mode (default 'onFailure'). */
export function wantTrace(mode: SaveTrace | undefined, ok: boolean): boolean {
  const m = mode ?? 'onFailure';
  return m === 'always' || (m === 'onFailure' && !ok);
}

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const BINARY_NAME = /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|zip|pdf)$/i;
const REMOVED = '[removed]';
// Header text anywhere in a line (e.g. inside a snapshot's HTML), up to end of line, '<' or a quote.
const RAW_HEADER_LINE = /\b(cookie|set-cookie|authorization|proxy-authorization)\s*:[^\r\n<"']*/gi;
const RAW_JSON_KEY = /"(cookie|set-cookie|authorization|proxy-authorization)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;
const RAW_JSON_PAIR = /\{"name":"(cookie|set-cookie|authorization|proxy-authorization)","value":"(?:[^"\\]|\\.)*"\}/gi;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface BodyRef { _file?: string; _sha1?: string }
interface NetworkSnapshot {
  request?: { url?: string; method?: string; postData?: BodyRef & Record<string, unknown> };
  response?: { content?: BodyRef };
}

/** Any method other than GET/HEAD/OPTIONS, or a missing one (the bodies of all writes are removed). */
function isWrite(method: unknown): boolean {
  return !SAFE_METHODS.has(typeof method === 'string' ? method.toUpperCase() : '');
}

function parse(line: string): unknown {
  try { return JSON.parse(line); } catch { return undefined; }
}

/** Blanks secret headers and cookie lists and drops stored browser state anywhere in a parsed trace event. */
function scrubValue(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(RAW_HEADER_LINE, (_m, header: string) => `${header}: ${REMOVED}`);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (typeof o.name === 'string' && 'value' in o && SECRET_HEADERS.has(o.name.toLowerCase())) return { ...o, value: REMOVED };
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) {
    if (k === 'storageState') continue;
    if (k === 'cookies' && Array.isArray(val)) { out[k] = []; continue; }
    if (SECRET_HEADERS.has(k.toLowerCase()) && typeof val === 'string') { out[k] = REMOVED; continue; }
    out[k] = scrubValue(val);
  }
  return out;
}

function scrubRaw(text: string): string {
  return text
    .replace(RAW_HEADER_LINE, (_m, header: string) => `${header}: ${REMOVED}`)
    .replace(RAW_JSON_KEY, (_m, header: string) => `"${header}":"${REMOVED}"`)
    .replace(RAW_JSON_PAIR, (_m, header: string) => `{"name":"${header}","value":"${REMOVED}"}`);
}

function scrubEventLine(line: string, policy: PortalPolicy): string {
  if (!line.trim()) return line;
  const event = parse(line);
  if (event === undefined) return scrubRaw(line);
  const req = (event as { snapshot?: NetworkSnapshot }).snapshot?.request;
  if (req?.url && isLoginPage(policy, req.url) && req.postData) req.postData = { text: REMOVED };
  else if (req && isWrite(req.method) && req.postData !== undefined) delete req.postData;
  return JSON.stringify(scrubValue(event));
}

/**
 * Removes credentials, cookies, auth headers, login bodies, the request bodies of all writes and binary entries from a
 * Playwright trace zip, and masks the rest.
 */
export function scrubTrace(raw: Buffer | Uint8Array, opts: { masker: Masker; policy: PortalPolicy }): Buffer {
  const files = unzipSync(new Uint8Array(raw));
  const isEvents = (name: string) => name.endsWith('.network') || name.endsWith('.trace');
  // Login pages lose their request and response bodies; every other write loses its request body.
  const drop = new Set<string>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!isEvents(name)) continue;
    for (const line of strFromU8(bytes).split('\n')) {
      const snap = (parse(line) as { snapshot?: NetworkSnapshot } | undefined)?.snapshot;
      const req = snap?.request;
      if (!req) continue;
      const login = !!req.url && isLoginPage(opts.policy, req.url);
      const refs = login ? [req.postData, snap?.response?.content] : isWrite(req.method) ? [req.postData] : [];
      for (const ref of refs) {
        if (ref?._file) drop.add(ref._file);
        if (ref?._sha1) drop.add(`resources/${ref._sha1}`);
      }
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const out: Zippable = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (drop.has(name) || BINARY_NAME.test(name)) continue;
    let text: string;
    try { text = decoder.decode(bytes); } catch { continue; } // binary: dropped
    text = isEvents(name) ? text.split('\n').map((l) => scrubEventLine(l, opts.policy)).join('\n') : scrubRaw(text);
    out[name] = strToU8(opts.masker.mask(text));
  }
  return Buffer.from(zipSync(out));
}

/** Stops (or collects the saved) trace of a session and returns it scrubbed; undefined when tracing was off or the browser is gone. */
export async function stopTrace(session: Session, opts: { masker: Masker; policy: PortalPolicy }): Promise<Buffer | undefined> {
  const raw = await session.takeTrace();
  return raw ? scrubTrace(raw, opts) : undefined;
}
