import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createAddressGuard, defaultResolveHost, hostnameOf, isPrivateAddress } from '../src/browser/address.js';
import { bound } from './timing.js';

// The c-ares resolver used for names admitted only by the '*' wildcard: recorded, never sent to the network here.
const { caresCalls } = vi.hoisted(() => ({ caresCalls: { options: [] as unknown[], names: [] as string[] } }));
vi.mock('node:dns/promises', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:dns/promises')>();
  class Resolver {
    constructor(options: unknown) { caresCalls.options.push(options); }
    async resolve4(name: string) { caresCalls.names.push(`A ${name}`); return ['93.184.215.20']; }
    async resolve6(name: string): Promise<string[]> { caresCalls.names.push(`AAAA ${name}`); throw Object.assign(new Error('no AAAA'), { code: 'ENODATA' }); }
  }
  return { ...mod, Resolver, default: { ...mod, Resolver } };
});
import type { ScriptLaneInput } from '../src/lane/script-lane.js';
import type { TaskInput } from '../src/lane/task.js';
import type { PortalPolicy } from '../src/types.js';

const PRIVATE = [
  '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '255.255.255.255',
  '::1', '::', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fe80::1%en0', 'ff02::1',
  '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:192.168.0.1', '64:ff9b::a00:1',
  'not-an-ip',
  // Benchmarking, IETF protocol assignments, reserved 240/4, documentation and 6to4 relay ranges.
  '198.18.0.1', '198.19.255.254', '192.0.0.8', '240.0.0.1', '250.1.2.3', '254.255.255.255',
  '192.0.2.1', '198.51.100.7', '203.0.113.9', '192.88.99.1',
  // 6to4 with a private embedded IPv4, Teredo, local-use NAT64, site-local, IPv4-translated, documentation, discard-only.
  '2002:7f00:1::', '2002:a00:1::1', '2002:c0a8:101::', '2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '64:ff9b:1::1', '64:ff9b:1:ffff::5db8:d70e', 'fec0::1', 'feff::1', '::ffff:0:a00:1', '::ffff:0:7f00:1',
  '2001:db8::1', '2001:db8:ffff::1', '100::1', '100::ffff:1:2',
];
const PUBLIC = [
  '93.184.215.14', '8.8.8.8', '1.1.1.1', '11.0.0.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
  '169.253.0.1', '192.167.1.1', '223.255.255.255', '2606:4700::1', '2001:4860:4860::8888', '::ffff:93.184.215.14', 'fbff::1',
  // Neighbours of the added ranges.
  '198.17.255.255', '198.20.0.1', '192.0.1.1', '192.0.3.1', '198.51.101.1', '203.0.114.1', '192.88.100.1',
  '2002:5db8:d70e::', '::ffff:0:5db8:d70e', '2001:1::1', '2001:db9::1', '100:0:0:1::1', 'fe00::1',
];

describe('isPrivateAddress', () => {
  it.each(PRIVATE)('%s is private', (ip) => expect(isPrivateAddress(ip)).toBe(true));
  it.each(PUBLIC)('%s is public', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('hostnameOf', () => {
  it('drops the port and the IPv6 brackets', () => {
    expect(hostnameOf('example.com')).toBe('example.com');
    expect(hostnameOf('Example.com:8443')).toBe('example.com');
    expect(hostnameOf('[::1]:8080')).toBe('::1');
    expect(hostnameOf('127.0.0.1:9999')).toBe('127.0.0.1');
    expect(hostnameOf('bad host')).toBe('');
  });
});

const policy = (over: Partial<PortalPolicy> = {}): PortalPolicy => ({
  startUrl: 'https://example.com/', navHosts: ['example.com'], subresourceHosts: [], login: [], allowedSubmits: [], ...over,
});
const TABLE: Record<string, string[]> = {
  'example.com': ['93.184.215.14'],
  'intranet.example': ['10.0.0.5'],
  'mixed.example': ['93.184.215.14', '192.168.1.10'],
  'cdn.example': ['10.0.0.7'],
};
const resolver = () => vi.fn(async (h: string) => TABLE[h] ?? []);

describe('createAddressGuard', () => {
  it('resolves a hostname once per session, whatever the port', async () => {
    const resolveHost = resolver();
    const g = createAddressGuard(policy({ navHosts: ['example.com', 'example.com:8443'] }), { resolveHost });
    expect(await g.check('example.com')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    await g.check('example.com');
    expect(await g.check('example.com:8443')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });
  it('an IP literal is its own address and is never looked up', async () => {
    const resolveHost = resolver();
    const g = createAddressGuard(policy({ navHosts: ['93.184.215.14:8443', '[2606:4700::1]', '127.0.0.1:8080'] }), { resolveHost });
    expect(await g.check('93.184.215.14:8443')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await g.check('[2606:4700::1]')).toEqual({ ok: true, addresses: ['2606:4700::1'] });
    expect(await g.check('127.0.0.1:8080')).toEqual({ ok: false, reason: 'private' });
    expect(resolveHost).not.toHaveBeenCalled();
  });
  it('a name that does not resolve, or a resolver that throws, is unresolved', async () => {
    expect(await createAddressGuard(policy(), { resolveHost: resolver() }).check('nowhere.example')).toEqual({ ok: false, reason: 'unresolved' });
    const throwing = async () => { throw new Error('ENOTFOUND'); };
    expect(await createAddressGuard(policy(), { resolveHost: throwing }).check('example.com')).toEqual({ ok: false, reason: 'unresolved' });
  });
  it('without the opt-in a private address is refused, even on a navigation host', async () => {
    const g = createAddressGuard(policy({ navHosts: ['intranet.example'] }), { resolveHost: resolver() });
    expect(await g.check('intranet.example')).toEqual({ ok: false, reason: 'private' });
  });
  it('the opt-in admits private addresses only for navigation hosts, port included, never for sub-resource hosts', async () => {
    const p = policy({ navHosts: ['intranet.example', '127.0.0.1:8080'], subresourceHosts: ['cdn.example'], allowPrivateNetwork: true });
    const g = createAddressGuard(p, { resolveHost: resolver() });
    expect(await g.check('intranet.example')).toEqual({ ok: true, addresses: ['10.0.0.5'] });
    expect(await g.check('127.0.0.1:8080')).toEqual({ ok: true, addresses: ['127.0.0.1'] });
    expect(await g.check('127.0.0.1:9090')).toEqual({ ok: false, reason: 'private' });
    expect(await g.check('intranet.example:8443')).toEqual({ ok: false, reason: 'private' });
    expect(await g.check('cdn.example')).toEqual({ ok: false, reason: 'private' });
  });
  it('one private address among public ones counts as private', async () => {
    const g = createAddressGuard(policy({ navHosts: ['mixed.example'] }), { resolveHost: resolver() });
    expect(await g.check('mixed.example')).toEqual({ ok: false, reason: 'private' });
  });
  it('admitted(host) is the one opt-in rule: navigation hosts only, port compared exactly', () => {
    const p = policy({ navHosts: ['intranet.example', '127.0.0.1:8080'], subresourceHosts: ['cdn.example'], allowPrivateNetwork: true });
    const g = createAddressGuard(p, { resolveHost: resolver() });
    expect(g.admitted('intranet.example')).toBe(true);
    expect(g.admitted('127.0.0.1:8080')).toBe(true);
    expect(g.admitted('127.0.0.1:9090')).toBe(false);
    expect(g.admitted('cdn.example')).toBe(false);
    expect(createAddressGuard(policy({ navHosts: ['intranet.example'] })).admitted('intranet.example')).toBe(false);
  });
  it('2001:2::/48 (benchmarking) and 3fff::/20 (documentation) are private; their neighbours are public', () => {
    for (const ip of ['2001:2::1', '2001:2:0:ffff::1', '3fff::1', '3fff:fff:ffff::1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['2001:2:1::1', '2001:3::1', '3ffe::1', '3fff:1000::1']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('the isPrivate seam replaces the classifier', async () => {
    const g = createAddressGuard(policy({ navHosts: ['intranet.example'] }), { resolveHost: resolver(), isPrivate: () => false });
    expect(await g.check('intranet.example')).toEqual({ ok: true, addresses: ['10.0.0.5'] });
  });
});

describe('bounded lookups', () => {
  afterEach(() => { vi.useRealTimers(); caresCalls.options.length = 0; caresCalls.names.length = 0; });
  const wildcard = (over: Partial<PortalPolicy> = {}) => policy({ subresourceHosts: '*', ...over });
  const never = () => new Promise<string[]>(() => undefined);

  it('a resolver that never answers gives unresolved after 4 s', async () => {
    vi.useFakeTimers();
    const g = createAddressGuard(policy(), { resolveHost: never });
    let out: unknown;
    void g.check('example.com').then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(3999);
    expect(out).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(out).toEqual({ ok: false, reason: 'unresolved' });
  });
  it('the timeout is a seam: a short one fails a silent resolver closed, and the slot is given back', async () => {
    const answered = vi.fn(async () => ['93.184.215.14']);
    const g = createAddressGuard(wildcard(), { resolveHost: (h) => (h.startsWith('slow') ? never() : answered()), lookupTimeoutMs: 20 });
    expect(await Promise.all([g.check('slow1.example'), g.check('slow2.example')])).toEqual([
      { ok: false, reason: 'unresolved' }, { ok: false, reason: 'unresolved' },
    ]);
    expect(await g.check('fast.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
  });
  it('at most 64 distinct names are looked up per session: the 65th is refused without a lookup', async () => {
    const resolveHost = vi.fn(async () => ['93.184.215.14']);
    const g = createAddressGuard(wildcard(), { resolveHost });
    for (let i = 1; i <= 64; i++) expect(await g.check(`h${i}.example`)).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await g.check('h65.example')).toEqual({ ok: false, reason: 'unresolved' });
    expect(resolveHost).toHaveBeenCalledTimes(64);
    // Cached names still answer; IP literals need no lookup and are never refused by the cap.
    expect(await g.check('h1.example:8443')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await g.check('93.184.215.15')).toEqual({ ok: true, addresses: ['93.184.215.15'] });
    expect(resolveHost).toHaveBeenCalledTimes(64);
  });
  it('no more than 2 lookups are in flight; the rest wait in a queue and all finish', async () => {
    let active = 0;
    let peak = 0;
    const resolveHost = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return ['93.184.215.14'];
    };
    const g = createAddressGuard(wildcard(), { resolveHost });
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => g.check(`q${i}.example`)));
    expect(all.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
  });
  it('listed hosts are exempt from the cap and jump ahead of wildcard-only names in the queue', async () => {
    const slow = async (h: string) => {
      await new Promise((r) => setTimeout(r, h.endsWith('.junk') ? 50 : 1));
      return ['93.184.215.14'];
    };
    const p = wildcard({
      navHosts: ['nav.example'], frameHosts: ['frame.example'], login: [{ host: 'login.example', path: '/in' }],
      allowedSubmits: [{ host: 'submit.example', path: '/s', method: 'POST' }],
    });
    const g = createAddressGuard(p, { resolveHost: slow });
    // 64 junk wildcard names queue up behind 2 slots (about 1.6 s of lookups)...
    const junk = Array.from({ length: 64 }, (_, i) => g.check(`n${i}.junk`));
    // ...and the navigation host still resolves within one junk lookup.
    const t0 = Date.now();
    expect(await g.check('nav.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(Date.now() - t0).toBeLessThan(bound(500, 1600));
    await Promise.all(junk);
    // The cap is full for wildcard names, never for listed ones (login and submit hosts included).
    expect(await g.check('n64.junk')).toEqual({ ok: false, reason: 'unresolved' });
    for (const h of ['frame.example', 'login.example', 'submit.example']) expect(await g.check(h)).toEqual({ ok: true, addresses: ['93.184.215.14'] });
  });
  it('withPolicy() keeps the lookups, the cap and the cache: restrict() never resets the budget', async () => {
    const resolveHost = vi.fn(async () => ['93.184.215.14']);
    const g = createAddressGuard(wildcard(), { resolveHost });
    for (let i = 1; i <= 64; i++) await g.check(`h${i}.example`);
    const next = g.withPolicy(wildcard({ navHosts: ['example.com'] }));
    expect(await next.check('h2.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await next.check('h65.example')).toEqual({ ok: false, reason: 'unresolved' });
    expect(resolveHost).toHaveBeenCalledTimes(64);
  });
  it('wildcard-only names go to c-ares (A + AAAA, timeout 4000, one try); listed names keep dns.lookup', async () => {
    const resolveHost = vi.fn(async () => ['93.184.215.14']);
    const g = createAddressGuard(wildcard({ navHosts: ['example.com'], subresourceHosts: '*', frameHosts: ['widget.example'] }), {
      resolveHost, resolveWildcard: undefined,
    });
    // An injected resolveHost serves both kinds (test seam); without one, the defaults split them.
    expect(await g.check('cdn.other.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(caresCalls.names).toEqual([]);
    const d = createAddressGuard(wildcard({ navHosts: ['example.com'] }));
    expect(await d.check('cdn.other.example')).toEqual({ ok: true, addresses: ['93.184.215.20'] });
    expect(caresCalls.options).toEqual([{ timeout: 4000, tries: 1 }]);
    expect(caresCalls.names.sort()).toEqual(['A cdn.other.example', 'AAAA cdn.other.example']);
    // The session passes dns.lookup explicitly: it still never serves a wildcard-only name.
    const viaSession = createAddressGuard(wildcard({ navHosts: ['example.com'] }), { resolveHost: defaultResolveHost });
    expect(await viaSession.check('beacon.other.example')).toEqual({ ok: true, addresses: ['93.184.215.20'] });
    expect(caresCalls.names).toContain('A beacon.other.example');
    const split = createAddressGuard(wildcard({ navHosts: ['listed.example'], frameHosts: ['widget.example'] }), {
      resolveHost, resolveWildcard: async () => ['93.184.215.30'],
    });
    expect(await split.check('listed.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await split.check('widget.example')).toEqual({ ok: true, addresses: ['93.184.215.14'] });
    expect(await split.check('beacon.other.example')).toEqual({ ok: true, addresses: ['93.184.215.30'] });
  });
});

describe('test seams stay out of the run input', () => {
  it('TaskInput and ScriptLaneInput have no resolveHost or isPrivate', () => {
    expectTypeOf<TaskInput>().not.toHaveProperty('resolveHost');
    expectTypeOf<TaskInput>().not.toHaveProperty('isPrivate');
    expectTypeOf<ScriptLaneInput>().not.toHaveProperty('resolveHost');
    expectTypeOf<ScriptLaneInput>().not.toHaveProperty('isPrivate');
  });
});
