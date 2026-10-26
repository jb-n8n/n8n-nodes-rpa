import { createMasker } from 'n8n-rpa-engine';
import { strFromU8, unzipSync } from 'fflate';

/** label → secret value */
export type Secrets = Record<string, string>;

const hex4 = (c: number) => c.toString(16).padStart(4, '0');

/** Base64 characters fully determined by the secret, for each of the three byte alignments inside a longer blob. */
function base64Cores(bytes: Buffer): string[] {
  const cores: string[] = [];
  for (const shift of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64');
    const core = b64.slice(Math.ceil((shift * 8) / 6), Math.floor(((shift + bytes.length) * 8) / 6));
    if (core.length >= 8) cores.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return cores;
}

// Every encoding the engine's masker covers, plus base64 at any alignment. Text forms are compared
// case-insensitively; base64 forms exactly.
function forms(s: string): { text: string; caseless: boolean }[] {
  const bytes = Buffer.from(s, 'utf8');
  const b64 = bytes.toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_');
  const json = JSON.stringify(s).slice(1, -1);
  const points = Array.from(s, (ch) => ch.codePointAt(0) as number);
  const units = Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  return [
    { text: s, caseless: true },
    { text: encodeURIComponent(s), caseless: true },
    { text: encodeURIComponent(s).replace(/%20/g, '+'), caseless: true },
    { text: json, caseless: true },
    { text: json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${hex4(ch.charCodeAt(0))}`), caseless: true },
    { text: units.map((c) => `\\u${hex4(c)}`).join(''), caseless: true },
    { text: s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'), caseless: true },
    { text: points.map((c) => `&#${c};`).join(''), caseless: false },
    { text: points.map((c) => `&#x${c.toString(16)};`).join(''), caseless: true },
    { text: b64, caseless: false },
    { text: b64.replace(/=+$/, ''), caseless: false },
    { text: b64url, caseless: false },
    { text: b64url.replace(/=+$/, ''), caseless: false },
    ...base64Cores(bytes).map((text) => ({ text, caseless: false })),
  ];
}

/**
 * Labels of the secrets that appear in `text` in any encoding. A named form reports the bare label; an encoding
 * only the engine's masker recognises (escaped-slash JSON, minimal entities, …) reports `<label>:encoded`. Each
 * secret is reported at most once, and a named form wins.
 */
export function textLeaks(text: string, secrets: Secrets): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const [label, secret] of Object.entries(secrets)) {
    if (!secret) continue;
    if (forms(secret).some((f) => (f.caseless ? lower.includes(f.text.toLowerCase()) : text.includes(f.text)))) found.push(label);
    else if (createMasker([secret]).containsSecret(text)) found.push(`${label}:encoded`);
  }
  return found;
}

const BINARY_KEYS = new Set(['screenshot', 'before', 'after', 'data', 'trace']);

/** Scans a result, row or transcript as JSON, skipping binary fields (traces are scanned separately). */
export function valueLeaks(value: unknown, secrets: Secrets): string[] {
  return textLeaks(JSON.stringify(value, (k, v) => (BINARY_KEYS.has(k) ? undefined : v)) ?? '', secrets);
}

/** Scans every entry of a trace zip. */
export function traceLeaks(zip: Buffer | undefined, secrets: Secrets): string[] {
  if (!zip) return [];
  const found = new Set<string>();
  for (const bytes of Object.values(unzipSync(new Uint8Array(zip)))) for (const label of textLeaks(strFromU8(bytes), secrets)) found.add(label);
  return [...found];
}
