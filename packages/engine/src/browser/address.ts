import { lookup, Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { PortalPolicy } from '../types.js';

/** Resolves a hostname (no port, no brackets) to its addresses. Test seam: never reachable from TaskInput. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export interface AddressGuard {
  check(host: string): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: 'private' | 'unresolved' }>;
  /** True when the policy admits private addresses for this host: allowPrivateNetwork and a navigation host, port included. */
  admitted(host: string): boolean;
  /** The same session's guard under another policy: the lookups, their cache, the name cap and the in-flight limit are shared. */
  withPolicy(policy: PortalPolicy): AddressGuard;
}

// DNS lookups run in the n8n process, and dns.lookup uses the libuv threadpool (4 threads by default) that file and
// crypto work share. Page script under the '*' wildcard picks the names, so lookups are bounded per session.
/**
 * Distinct wildcard-only hostnames looked up per session; later ones are treated as unresolved (fail closed: the request
 * is aborted). Hosts listed on the policy are exempt.
 */
const MAX_HOST_NAMES = 64;
/** Lookups running at once per session; the rest wait in a queue. */
const MAX_LOOKUPS_IN_FLIGHT = 2;
/** A lookup that has not answered after this long is unresolved (and gives its slot back). */
const LOOKUP_TIMEOUT_MS = 4000;

/** Hosts listed on the policy by name. They may rely on /etc/hosts, so they keep dns.lookup. */
export const defaultResolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Names admitted only by the '*' wildcard: c-ares (off the libuv threadpool), one try, 4 s, A and AAAA records. No
 * /etc/hosts. Either record type may be missing; no answer at all throws (unresolved).
 */
const resolveWithCares: ResolveHost = async (hostname) => {
  const resolver = new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 });
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const addresses = [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])];
  if (addresses.length === 0) throw new Error(`${hostname} did not resolve`);
  return addresses;
};

interface GuardOptions {
  /** Test seam: replaces dns.lookup for listed hosts, and also c-ares for wildcard-only names unless resolveWildcard is given. */
  resolveHost?: ResolveHost;
  /** Test seam: replaces c-ares for names admitted only by the '*' wildcard. */
  resolveWildcard?: ResolveHost;
  isPrivate?: (ip: string) => boolean;
  /** Test seam: the per-lookup timeout (default 4 s). */
  lookupTimeoutMs?: number;
}

type Lookups = (name: string, listed: boolean) => Promise<string[]>;

/** One session's lookups: cached by hostname, at most MAX_HOST_NAMES names, MAX_LOOKUPS_IN_FLIGHT at once, each timed out. */
function createLookups(opts: GuardOptions): Lookups {
  const resolveListed = opts.resolveHost ?? defaultResolveHost;
  // dns.lookup itself never serves wildcard-only names; an injected (test) resolveHost does unless resolveWildcard is given.
  const injected = opts.resolveHost !== undefined && opts.resolveHost !== defaultResolveHost ? opts.resolveHost : undefined;
  const resolveWildcard = opts.resolveWildcard ?? injected ?? resolveWithCares;
  const timeoutMs = opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
  // Bounded: at most MAX_HOST_NAMES wildcard-only names, plus the names listed on the policy (a fixed, operator-set list).
  const cache = new Map<string, Promise<string[]>>();
  let wildcardNames = 0;
  let active = 0;
  // Listed hosts jump ahead of wildcard-only names: page script cannot delay the site's own hosts by queueing junk names.
  const listedQueue: (() => void)[] = [];
  const wildcardQueue: (() => void)[] = [];
  const acquire = (listed: boolean) => new Promise<void>((resolve) => {
    if (active < MAX_LOOKUPS_IN_FLIGHT) {
      active++;
      resolve();
    } else {
      (listed ? listedQueue : wildcardQueue).push(() => { active++; resolve(); });
    }
  });
  const release = () => {
    active--;
    (listedQueue.shift() ?? wildcardQueue.shift())?.();
  };
  const run = async (name: string, listed: boolean): Promise<string[]> => {
    const resolve = listed ? resolveListed : resolveWildcard;
    await acquire(listed);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        resolve(name).then((a) => (Array.isArray(a) ? a : []), () => [] as string[]),
        new Promise<string[]>((done) => { timer = setTimeout(() => done([]), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      release();
    }
  };
  return (name, listed) => {
    const known = cache.get(name);
    if (known) return known;
    // The cap applies to wildcard-only names; hosts listed on the policy are always looked up.
    if (!listed) {
      if (wildcardNames >= MAX_HOST_NAMES) return Promise.resolve([]);
      wildcardNames++;
    }
    const pending = run(name, listed);
    cache.set(name, pending);
    return pending;
  };
}

/** The hostname of a policy host entry (`host` or `host:port`, IPv6 in brackets): lowercase, no port, no brackets; '' when unparseable. */
export function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Eight 16-bit groups, or null. Accepts '::' compression and a dotted IPv4 tail (::ffff:10.0.0.1). Input is lowercase. */
function parseV6(input: string): number[] | null {
  let s = input;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = parseV4(dotted[2]);
    if (!o) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  return [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
}

function privateV4([a, b, c]: number[]): boolean {
  return a === 0                                         // 0.0.0.0/8 unspecified
    || a === 10                                          // 10/8
    || a === 127                                         // 127/8 loopback
    || (a === 100 && b >= 64 && b <= 127)                // 100.64/10 CGNAT
    || (a === 169 && b === 254)                          // 169.254/16 link-local
    || (a === 172 && b >= 16 && b <= 31)                 // 172.16/12
    || (a === 192 && b === 168)                          // 192.168/16
    || (a === 192 && b === 0 && c === 0)                 // 192.0.0/24 IETF protocol assignments
    || (a === 192 && b === 0 && c === 2)                 // 192.0.2/24 TEST-NET-1
    || (a === 192 && b === 88 && c === 99)               // 192.88.99/24 6to4 relay anycast
    || (a === 198 && (b === 18 || b === 19))             // 198.18/15 benchmarking
    || (a === 198 && b === 51 && c === 100)              // 198.51.100/24 TEST-NET-2
    || (a === 203 && b === 0 && c === 113)               // 203.0.113/24 TEST-NET-3
    || (a >= 224 && a <= 239)                            // 224/4 multicast
    || a >= 240;                                         // 240/4 reserved, includes broadcast 255.255.255.255
}

function privateV6(g: number[]): boolean {
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  const v4 = () => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
  if (zeros(8)) return true;                                     // :: unspecified
  if (zeros(7) && g[7] === 1) return true;                       // ::1 loopback
  if (zeros(5) && g[5] === 0xffff) return privateV4(v4());       // ::ffff:a.b.c.d IPv4-mapped
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return privateV4(v4()); // ::ffff:0:a.b.c.d IPv4-translated
  if (zeros(6)) return privateV4(v4());                          // ::a.b.c.d IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(v4()); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return privateV4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]); // 2002::/16 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true;                // 2001::/32 Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;           // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return true;  // 2001:2::/48 benchmarking
  if (g[0] === 0x3fff && g[1] < 0x1000) return true;             // 3fff::/20 documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true;                   // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                   // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                   // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                   // ff00::/8 multicast
  return false;
}

/**
 * True for loopback, RFC 1918, ULA, link-local, site-local, CGNAT, unspecified, multicast, reserved 240/4 (broadcast
 * included), benchmarking 198.18/15, IETF protocol assignments 192.0.0/24, the documentation ranges (192.0.2/24,
 * 198.51.100/24, 203.0.113/24, 2001:db8::/32, 3fff::/20), IPv6 benchmarking 2001:2::/48, the 6to4 relay 192.88.99/24,
 * Teredo 2001::/32, local-use NAT64
 * 64:ff9b:1::/48, discard-only 100::/64, and the IPv4-mapped, IPv4-translated, IPv4-compatible, NAT64 64:ff9b::/96 and
 * 6to4 2002::/16 forms of the private IPv4 ranges. Anything that is not an IP address counts as
 * private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = parseV4(s);
  if (v4) return privateV4(v4);
  const v6 = parseV6(s);
  return v6 ? privateV6(v6) : true;
}

/**
 * Address checks for one session. An IP literal is its own address; names are resolved once per session (cached by
 * hostname, port ignored), 2 at a time, each within 4 s; a timeout or a failed lookup is unresolved. Hosts listed on the
 * policy use dns.lookup, are never capped and go ahead of names admitted only by the '*' wildcard, which use c-ares and
 * are capped at 64 distinct names (later ones are unresolved). A host with any private address is refused unless allowPrivateNetwork is on and the host (port included) is a
 * navigation host: never through sub-resource or frame hosts.
 */
export function createAddressGuard(policy: PortalPolicy, opts: GuardOptions = {}): AddressGuard {
  return guardFor(policy, opts, createLookups(opts));
}

function guardFor(policy: PortalPolicy, opts: GuardOptions, lookups: Lookups): AddressGuard {
  const isPrivate = opts.isPrivate ?? isPrivateAddress;
  // Every host the policy names: navigation, listed sub-resource and frame hosts, login, submit and write-window hosts.
  const listed = new Set([
    ...policy.navHosts, ...(Array.isArray(policy.subresourceHosts) ? policy.subresourceHosts : []), ...(policy.frameHosts ?? []),
    ...policy.login.map((l) => l.host), ...policy.allowedSubmits.map((a) => a.host), ...(policy.writeWindow?.hosts ?? []),
  ].map(hostnameOf));
  const admitted = (host: string) => policy.allowPrivateNetwork === true && policy.navHosts.includes(host);
  return {
    admitted,
    withPolicy: (next) => guardFor(next, opts, lookups),
    async check(host) {
      const name = hostnameOf(host);
      if (!name) return { ok: false, reason: 'unresolved' };
      const addresses = isIP(name) ? [name] : await lookups(name, listed.has(name));
      if (addresses.length === 0) return { ok: false, reason: 'unresolved' };
      if (addresses.some((a) => isPrivate(a)) && !admitted(host)) return { ok: false, reason: 'private' };
      return { ok: true, addresses };
    },
  };
}
