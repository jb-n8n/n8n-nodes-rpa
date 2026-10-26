import type { RequestRecord, Violation } from '../types.js';

export interface Masker {
  mask(text: string): string;
  containsSecret(text: string): boolean;
  readonly secrets: readonly string[];
  /** Length of the longest form mask() looks for (0 without secrets): text cut before masking drops this many characters. */
  readonly maxLength: number;
  /**
   * Adds secrets that appear during the run (a typed TOTP code), so every later mask, check and the trace scrubbing
   * cover them. `wholeNumber`: matched only where no digit is directly before or after, so a short code does not
   * mask a longer number that happens to contain it.
   */
  add(values: readonly (string | undefined | null)[], opts?: { wholeNumber?: boolean }): void;
}

const REPLACEMENT = '[secret]';

const hex2 = (c: number) => c.toString(16).padStart(2, '0');
const hex4 = (c: number) => c.toString(16).padStart(4, '0');
/** Escapes a literal for a RegExp with the `u` flag (where `\-` would be a syntax error, so `-` is left alone). */
const esc = (t: string) => t.replace(/[.*+?^${}()[\]|\\/]/g, '\\$&');

/** A regex alternative and the longest text it can match. */
type Alt = { src: string; max: number };
const alt = (src: string, max: number): Alt => ({ src, max });

/** One to three backslashes: a JS or JSON escape, also when the JSON was itself put in a JSON string. */
const BS = '\\\\{1,3}';
const BS_MAX = 3;
/** A percent sign, also double or triple percent-encoded (%25, %2525). */
const PCT = '%(?:25){0,2}';
const PCT_MAX = 5;
/** Leading zeros of an HTML numeric entity. */
const ZEROS = '0{0,6}';
const ZEROS_MAX = 6;
/**
 * An entity's optional semicolon. When a ";" follows, the entity takes it (as an HTML parser does): never "maybe", so
 * a secret with ";" after an encoded character cannot make the pattern try both ways at every character.
 */
const SEMI = '(?:;|(?!;))';

const HTML_NAMED: Record<string, Alt[]> = {
  '&': [alt('&(?:amp;){1,2}', 9), alt('&amp(?!;)', 4)],
  '<': [alt(`&lt${SEMI}`, 4)],
  '>': [alt(`&gt${SEMI}`, 4)],
  '"': [alt(`&quot${SEMI}`, 6)],
  "'": [alt('&apos;', 6)],
};
const JS_NAMED: Record<string, string> = { '"': '"', "'": "'", '/': '/', '\n': 'n', '\t': 't', '\r': 'r', '\b': 'b', '\f': 'f' };
/**
 * What whitespace in a secret may appear as, besides its own encoded forms: any whitespace character (\s covers the
 * secret's own, U+00A0 and U+3000), a non-breaking space entity, a form-encoded space. No two alternatives match the
 * same text, so a quantified run of them cannot backtrack exponentially.
 */
const WHITESPACE: Alt[] = [
  alt('\\s', 1), alt(`&nbsp${SEMI}`, 6), alt(`&#${ZEROS}160${SEMI}`, 6 + ZEROS_MAX), alt(`&#x${ZEROS}a0${SEMI}`, 6 + ZEROS_MAX),
  alt(`${PCT}c2${PCT}a0`, 2 * (PCT_MAX + 2)), alt('\\+', 1), alt(`${PCT}2b`, PCT_MAX + 2), alt(`${PCT}20`, PCT_MAX + 2),
];
/** A run of n whitespace characters in a secret matches 1 to n × this many whitespace forms (pages collapse or expand it). */
const WS_REPEAT = 4;

/**
 * Every form one character of a secret may take in a page, a URL or a trace: itself (case-insensitive), its full-width
 * form, percent-encoded (any hex case, also double and triple encoded, so form, path and query encodings all match),
 * HTML numeric entities (decimal or hex, leading zeros, with or without the semicolon), HTML named entities, JS and
 * JSON escapes (\uXXXX, \u{X}, \xNN, \", \/, \n …).
 */
function charAlts(ch: string): Alt[] {
  const cp = ch.codePointAt(0) as number;
  const bytes = [...Buffer.from(ch, 'utf8')];
  const units = Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i));
  const alts: Alt[] = [
    alt(esc(ch), ch.length),
    alt(bytes.map((b) => `${PCT}${hex2(b)}`).join(''), bytes.length * (PCT_MAX + 2)),
    alt(`&#${ZEROS}${cp}${SEMI}`, 3 + ZEROS_MAX + String(cp).length),
    alt(`&#x${ZEROS}${cp.toString(16)}${SEMI}`, 4 + ZEROS_MAX + cp.toString(16).length),
    alt(units.map((u) => `${BS}u${hex4(u)}`).join(''), units.length * (BS_MAX + 5)),
    alt(`${BS}u\\{${ZEROS}${cp.toString(16)}\\}`, BS_MAX + 3 + ZEROS_MAX + cp.toString(16).length),
    ...(cp < 0x100 ? [alt(`${BS}x${hex2(cp)}`, BS_MAX + 3)] : []),
    ...(HTML_NAMED[ch] ?? []),
    ...(ch in JS_NAMED ? [alt(`${BS}${esc(JS_NAMED[ch])}`, BS_MAX + 1)] : []),
  ];
  // Full-width ASCII (what NFKC folds back), and the compatibility form of the secret's own character.
  if (cp >= 0x21 && cp <= 0x7e) alts.push(alt(String.fromCodePoint(cp + 0xfee0), 1));
  const nfkc = ch.normalize('NFKC');
  if (nfkc !== ch && nfkc.length > 0) alts.push(alt(esc(nfkc), nfkc.length));
  return alts;
}

const group = (alts: Alt[]): string => `(?:${[...new Set(alts.map((a) => a.src))].join('|')})`;
const longest = (alts: Alt[]): number => Math.max(...alts.map((a) => a.max));

/**
 * The regex source matching a secret in any mix of its character forms, and the longest text it can match. A run of
 * whitespace is one quantified group, and a run of backslashes may also be that run doubled or quadrupled (JSON
 * escaping): one quantifier per run keeps the match linear, where one group per character would backtrack
 * exponentially over a long run of spaces or backslashes.
 */
function secretPattern(s: string): Alt {
  const parts: Alt[] = [];
  for (const run of s.match(/\s+|\\+|[^\s\\]/gsu) ?? []) {
    const chars = Array.from(run);
    const k = chars.length;
    if (/^\s/u.test(run)) {
      // The characters themselves (and their NFKC forms, all whitespace) are left to \s: two alternatives matching the
      // same space would double the ways to split a run at every character.
      const own = [...new Set(chars)].flatMap((ch) => charAlts(ch).filter((a) => !/^\s$/u.test(a.src) && a.src !== esc(ch)));
      const alts = own.concat(WHITESPACE);
      parts.push({ src: `${group(alts)}{1,${WS_REPEAT * k}}`, max: WS_REPEAT * k * longest(alts) });
    } else if (run.startsWith('\\')) {
      const one = charAlts('\\');
      parts.push({ src: `(?:\\\\{${k},${4 * k}}|${group(one).repeat(k)})`, max: Math.max(4 * k, k * longest(one)) });
    } else {
      const alts = charAlts(run);
      parts.push({ src: group(alts), max: longest(alts) });
    }
  }
  return { src: parts.map((p) => p.src).join(''), max: parts.reduce((n, p) => n + p.max, 0) };
}

/** Shortest base64 fragment of a secret that starts at a byte offset not divisible by 3 (shorter ones would mask noise). */
const MIN_UNALIGNED_B64 = 6;

/**
 * Base64 forms (standard and URL alphabets, case-sensitive). At byte offset 0 the whole encoding, with and without
 * padding. Inside a larger blob (`user:password` in basic auth, a JSON object) the secret may start at any byte offset:
 * for each offset modulo 3 only the characters made of the secret's own bits are fixed, and those are matched.
 */
function base64Forms(s: string): string[] {
  const bytes = Buffer.from(s, 'utf8');
  const out = new Set<string>();
  const b64 = bytes.toString('base64');
  for (const t of [b64, b64.replace(/=+$/, '')]) out.add(t);
  for (let offset = 0; offset < 3; offset++) {
    const std = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const start = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    const fragment = std.slice(start, end);
    if (fragment.length >= MIN_UNALIGNED_B64) out.add(fragment);
  }
  for (const t of [...out]) out.add(t.replace(/\+/g, '-').replace(/\//g, '_'));
  return [...out];
}

/** Percent-decodes runs of %XX (invalid UTF-8 becomes U+FFFD); `+` is a space, as in a form body. */
function percentDecode(t: string): string {
  return t.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
}
const NAMED_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function fromCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}
/** Decodes HTML numeric entities (leading zeros, no semicolon) and the named ones a serializer writes. */
function htmlDecode(t: string): string {
  return t.replace(/&(?:#(\d{1,8})|#x([0-9a-f]{1,8})|(amp|lt|gt|quot|apos|nbsp));?/gi, (m, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return fromCodePoint(Number(dec), m);
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16), m);
    return NAMED_ENTITY[(name ?? '').toLowerCase()] ?? m;
  });
}
/** Decodes JS and JSON escapes: \uXXXX, \u{X}, \xNN and a backslash before a quote, slash or backslash. */
function jsDecode(t: string): string {
  return t.replace(/\\+(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|(["'/\\])|([ntrbf]))/gi, (m, cp?: string, unit?: string, byte?: string, lit?: string, ws?: string) => {
    if (cp !== undefined) return fromCodePoint(parseInt(cp, 16), m);
    if (unit !== undefined) return String.fromCharCode(parseInt(unit, 16));
    if (byte !== undefined) return String.fromCharCode(parseInt(byte, 16));
    if (lit !== undefined) return lit;
    return ws ? ' ' : m;
  });
}

/**
 * The text as a reader would see it: percent-decoded (with + as space), HTML-entity and JS-escape decoded, twice (double
 * encoding, and one encoding inside another), then NFKC (full-width forms) and every whitespace run as one space.
 * Linear in the text: a fixed number of global replaces.
 */
function decodeNormalize(t: string): string {
  let out = t;
  for (let round = 0; round < 2; round++) out = jsDecode(htmlDecode(percentDecode(out)));
  return out.normalize('NFKC').replace(/\s+/gu, ' ');
}

/** A secret and how it is matched. A whole number (a one-time code) never matches inside a longer run of digits. */
type Entry = { value: string; wholeNumber: boolean };
// No digit directly before, judged by what the text decodes to: an escape for a non-digit (%22, \x22, ") ends in a
// digit character but is not one, so the code after it is still a whole number. An escaped digit (%31, 1) is not.
const NOT_DIGIT_BEFORE = String.raw`(?:(?<![0-9])|(?<=(?:%|\\x)(?!3[0-9])[0-9A-Fa-f]{2})|(?<=\\u(?!003[0-9])[0-9A-Fa-f]{4}))`;
const NOT_DIGIT_AFTER = '(?![0-9])';

/**
 * One secret's alternative in mask()'s alternation, a regex that finds it anywhere, and the longest text it can match.
 * `loose`, for a whole number: the same without the digit boundaries. It starts with the code's own characters, which
 * V8 scans for fast (a leading lookbehind is not), and when it finds nothing neither can `re`.
 */
type Pattern = { src: string; re: RegExp; loose?: RegExp; max: number };
/** Whether the pattern matches anywhere in the text. */
const found = (p: Pattern, text: string): boolean => (!p.loose || p.loose.test(text)) && p.re.test(text);

interface Compiled {
  /** Every secret's pattern, longest secret first: the order of the alternatives in mask(). */
  patterns: Pattern[];
  /** Global alternations of the patterns some text contains, keyed by their indexes in `patterns`. */
  subsets: Map<string, RegExp>;
  b64: string[];
  decoded?: RegExp;
  maxLength: number;
}

/** Distinct sets of present secrets kept compiled; past this the cache starts over (a run sees only a few). */
const MAX_SUBSETS = 64;

function compile(entries: Entry[]): Compiled {
  // Longest secret first: at a position where two secrets match, the longer one wins (one alternation, leftmost first).
  const bySize = [...entries].sort((a, b) => b.value.length - a.value.length);
  const patterns = bySize.map(({ value, wholeNumber }): Pattern => {
    // A blank secret (only whitespace) is matched exactly: as a whitespace run it would match every space of every text.
    const p = value.trim() ? secretPattern(value) : alt(esc(value), value.length);
    const src = wholeNumber ? `(?:${NOT_DIGIT_BEFORE}(?:${p.src})${NOT_DIGIT_AFTER})` : `(?:${p.src})`;
    return { src, re: new RegExp(src, 'iu'), ...(wholeNumber ? { loose: new RegExp(`(?:${p.src})`, 'iu') } : {}), max: p.max };
  });
  const b64 = [...new Set(bySize.flatMap((e) => base64Forms(e.value)))].sort((a, b) => b.length - a.length);
  // Decode-normalized secrets, for containsSecret on decode-normalized text (forms the per-character pattern misses).
  const normalized = new Map<string, boolean>();
  for (const e of entries) {
    const n = decodeNormalize(e.value).trim();
    if (n) normalized.set(n, (normalized.get(n) ?? true) && e.wholeNumber);
  }
  const decodedSource = [...normalized].map(([n, whole]) => (whole ? `${NOT_DIGIT_BEFORE}${esc(n)}${NOT_DIGIT_AFTER}` : esc(n))).join('|');
  return {
    patterns,
    subsets: new Map(),
    b64,
    ...(decodedSource ? { decoded: new RegExp(decodedSource, 'iu') } : {}),
    maxLength: Math.max(0, ...patterns.map((p) => p.max), ...b64.map((t) => t.length)),
  };
}

/** Base64 first (case-sensitive): a raw match inside a base64 run would break the run before it is recognised. */
function maskBase64(c: Compiled, text: string): string {
  let out = text;
  for (const n of c.b64) if (out.includes(n)) out = out.split(n).join(REPLACEMENT);
  return out;
}

/**
 * Replaces every match of the alternation of all patterns, in their order. At each position the first alternative that
 * matches wins, so a pattern that matches nowhere in the text never wins anywhere: the alternation of only the patterns
 * the text contains gives the same result. That one is usually empty or short, where the full one (many secrets, or
 * the lookbehinds of whole-number codes) runs far off V8's fast path: one TOTP step took 5 MB from 10 ms to 380 ms in
 * testing. Each set of present patterns is compiled once.
 */
function maskPatterns(c: Compiled, text: string): string {
  const present: number[] = [];
  c.patterns.forEach((p, i) => { if (found(p, text)) present.push(i); });
  if (present.length === 0) return text;
  const key = present.join(',');
  let re = c.subsets.get(key);
  if (!re) {
    if (c.subsets.size >= MAX_SUBSETS) c.subsets.clear();
    re = new RegExp(present.map((i) => c.patterns[i].src).join('|'), 'giu');
    c.subsets.set(key, re);
  }
  return text.replace(re, REPLACEMENT);
}

/** Each masker's current compiled state, for maskWithOneAlternation. */
const compiledOf = new WeakMap<Masker, () => Compiled>();

/**
 * Test-only reference, not exported by the package: mask() as it ran before maskPatterns, one global alternation of
 * every pattern. mask() must return exactly this.
 */
export function maskWithOneAlternation(masker: Masker, text: string): string {
  const get = compiledOf.get(masker);
  if (!get) throw new Error('not a masker from createMasker');
  const c = get();
  const out = maskBase64(c, String(text));
  return c.patterns.length ? out.replace(new RegExp(c.patterns.map((p) => p.src).join('|'), 'giu'), REPLACEMENT) : out;
}

/** Masks every listed secret, in every common encoding, longest first. Empty/undefined entries are ignored. */
export function createMasker(secrets: Array<string | undefined | null>): Masker {
  const entries: Entry[] = [];
  const addAll = (values: readonly (string | undefined | null)[], wholeNumber: boolean): boolean => {
    let added = false;
    for (const v of values) {
      if (typeof v !== 'string' || v.length === 0 || entries.some((e) => e.value === v)) continue;
      entries.push({ value: v, wholeNumber });
      added = true;
    }
    return added;
  };
  addAll(secrets, false);
  let c = compile(entries);
  const masker: Masker = {
    get secrets(): readonly string[] {
      return entries.map((e) => e.value);
    },
    get maxLength(): number {
      return c.maxLength;
    },
    mask(text: string): string {
      return maskPatterns(c, maskBase64(c, String(text)));
    },
    containsSecret(text: string): boolean {
      const t = String(text);
      if (c.b64.some((n) => t.includes(n))) return true;
      if (c.patterns.some((p) => found(p, t))) return true;
      return c.decoded ? c.decoded.test(decodeNormalize(t)) : false;
    },
    add(values: readonly (string | undefined | null)[], opts: { wholeNumber?: boolean } = {}): void {
      if (addAll(values, opts.wholeNumber === true)) c = compile(entries);
    },
  };
  compiledOf.set(masker, () => c);
  return masker;
}

/** Masks, then clips to `limit`, dropping a tail that could be the start of a cut secret the masker cannot recognise. */
export function maskClipped(masker: Masker, raw: string, limit: number): string {
  if (raw.length <= limit) return masker.mask(raw);
  const masked = masker.mask(raw.slice(0, limit));
  return masked.slice(0, Math.max(0, masked.length - masker.maxLength));
}

/** Violations as a result may carry them: each URL masked. */
export function maskViolations(violations: readonly Violation[], masker: Masker): Violation[] {
  return violations.map((v) => ({ ...v, url: masker.mask(v.url) }));
}

/** Blocked requests as a result may carry them: method, host and path, masked. */
export function maskRequests(requests: readonly RequestRecord[], masker: Masker): RequestRecord[] {
  return requests.map((b) => ({ method: masker.mask(b.method), host: masker.mask(b.host), path: masker.mask(b.path) }));
}
