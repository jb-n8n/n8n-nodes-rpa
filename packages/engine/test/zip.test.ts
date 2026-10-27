import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { readZipEntries } from '../src/steps/zip.js';
import { bound } from './timing.js';
import { timed, zeros, zip } from './zip-fixtures.js';

const MiB = 1024 * 1024;
const CAPS = { maxEntries: 2_000, perEntry: 4 * MiB, total: 32 * MiB };
const all = () => true;

const entries = (r: ReturnType<typeof readZipEntries>): Map<string, Buffer> => {
  if (!(r instanceof Map)) throw new Error(`${r.error}: ${r.detail}`);
  return r;
};
const failure = (r: ReturnType<typeof readZipEntries>) => (r instanceof Map ? null : r.error);

/** One deflated local entry `raw`, listed `n` times in the central directory under the names f0..f(n-1), all at offset 0. */
function overlapping(n: number, raw: Buffer): Buffer {
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(raw.length, 18); lh.writeUInt16LE(2, 26);
  const central: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const name = Buffer.from(`f${i}`);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(raw.length, 20); ch.writeUInt16LE(name.length, 28);
    central.push(ch, name);
  }
  const cd = Buffer.concat(central);
  const local = Buffer.concat([lh, Buffer.from('f0'), raw]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, cd, end]);
}

describe('readZipEntries', () => {
  it('reads accepted entries from a stored and a deflated zip', () => {
    const files = {
      'Main.xaml': strToU8('<Activity/>'),
      'project.json': strToU8('{"name":"Bot"}'),
      'empty.txt': new Uint8Array(0),
      'big.txt': strToU8('x'.repeat(100_000)),
    };
    for (const level of [0, 6] as const) {
      const data = Buffer.from(zipSync(files, { level }));
      const got = entries(readZipEntries(data, (n) => n !== 'project.json', CAPS));
      expect([...got.keys()].sort()).toEqual(['Main.xaml', 'big.txt', 'empty.txt']);
      expect(got.get('Main.xaml')!.toString('utf8')).toBe('<Activity/>');
      expect(got.get('big.txt')!.toString('utf8')).toBe('x'.repeat(100_000));
      expect(got.get('empty.txt')!.length).toBe(0);
      expect(Buffer.isBuffer(got.get('Main.xaml'))).toBe(true);
    }
    // The accept callback sees every name in the central directory, wanted or not.
    const seen: string[] = [];
    readZipEntries(Buffer.from(zipSync(files)), (n) => { seen.push(n); return false; }, CAPS);
    expect(seen.sort()).toEqual(['Main.xaml', 'big.txt', 'empty.txt', 'project.json']);
    // A hand-built stored (method 0) entry and an unwanted duplicate are fine.
    const raw = Buffer.from('<Sequence/>');
    const hand = zip([{ name: 'a.xaml', raw, method: 0, usize: raw.length }, { name: 'skip', raw, method: 0, usize: 1 }, { name: 'skip', raw, method: 0, usize: 1 }]);
    expect(entries(readZipEntries(hand, (n) => n === 'a.xaml', CAPS)).get('a.xaml')!.toString()).toBe('<Sequence/>');
  });

  it('refuses duplicates, encryption and bombs', () => {
    const ok = deflateRawSync(Buffer.from('<row/>'));
    const quick = (z: Buffer, expected: 'too-large' | 'unreadable', detail: RegExp) => {
      const { out, ms } = timed(() => readZipEntries(z, all, CAPS));
      expect(out).toEqual({ error: expected, detail: expect.stringMatching(detail) });
      expect(ms).toBeLessThan(bound(2000));
    };
    quick(zip([{ name: 'a', raw: ok, usize: 6 }, { name: 'a', raw: ok, usize: 6 }]), 'unreadable', /twice/);
    quick(zip([{ name: 'a', raw: ok, usize: 6, flags: 1 }]), 'unreadable', /encrypted/);
    quick(zip([{ name: 'a', raw: ok, usize: 6, method: 12 }]), 'unreadable', /compression method 12/);
    quick(zip([{ name: 'a', raw: Buffer.alloc(0), usize: 6 }]), 'unreadable', /no compressed data/);
    quick(zip([{ name: 'a', raw: Buffer.alloc(40, 0xff), usize: 6 }]), 'unreadable', /inflate/);
    // A real bomb that declares 100 bytes, the same with a data descriptor, and a declared-huge entry.
    const raw = zeros(256);
    expect(raw.length).toBeLessThan(MiB);
    quick(zip([{ name: 'a', raw, usize: 100 }]), 'too-large', /larger than 4194304 bytes/);
    quick(zip([{ name: 'a', raw, usize: 100, flags: 8 }]), 'too-large', /larger than 4194304 bytes/);
    quick(zip([{ name: 'a', raw: ok, usize: 0xfffffff0 }]), 'too-large', /declares/);
    // 1,000 copies of the same name: refused as duplicates before anything is inflated.
    quick(zip(Array.from({ length: 1000 }, () => ({ name: 'a', raw, usize: 100 }))), 'unreadable', /twice/);
    // 100 central-directory records with distinct accepted names, all pointing at one ~19 MiB stream of empty stored
    // deflate blocks: it inflates to nothing, so no output cap fires; the compressed input across entries is bounded instead.
    const empty = Buffer.alloc(Math.floor((19 * MiB) / 5) * 5);
    for (let i = 0; i < empty.length; i += 5) { empty[i + 3] = 0xff; empty[i + 4] = 0xff; }
    empty[empty.length - 5] = 1;
    const overlap = timed(() => readZipEntries(overlapping(100, empty), all, CAPS));
    expect(overlap.out).toEqual({ error: 'unreadable', detail: 'the accepted entries overlap' });
    expect(overlap.ms).toBeLessThan(bound(1000));
    // One such record alone is a valid, empty entry.
    expect(entries(readZipEntries(overlapping(1, empty), all, CAPS)).get('f0')!.length).toBe(0);
    // Not a zip, truncated, empty, and zip64 markers.
    const good = Buffer.from(zipSync({ a: strToU8('hello') }));
    for (const bad of [Buffer.alloc(0), Buffer.from('PK\u0003\u0004garbage'), good.subarray(0, 40), good.subarray(0, good.length - 1)]) {
      expect(failure(readZipEntries(bad, all, CAPS))).toBe('unreadable');
    }
    const z64 = Buffer.from(good);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    expect(readZipEntries(z64, all, CAPS)).toEqual({ error: 'unreadable', detail: expect.stringMatching(/zip64/) });
  });

  it('never throws on corrupted archives', () => {
    const good = Buffer.from(zipSync({ 'Main.xaml': strToU8('<Activity>' + 'x'.repeat(2000) + '</Activity>'), b: strToU8('y') }));
    let seed = 12345;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const bad = Buffer.from(good);
      for (let k = 0; k < 1 + rand(4); k++) bad[rand(bad.length)] = rand(256);
      const cut = rand(3) === 0 ? bad.subarray(rand(bad.length)) : bad;
      expect(() => readZipEntries(cut, all, CAPS)).not.toThrow();
    }
    expect(readZipEntries(good, () => { throw new Error('boom'); }, CAPS)).toEqual({ error: 'unreadable', detail: 'the entry filter failed' });
  });

  it('caps entries and total bytes', () => {
    const tiny = deflateRawSync(Buffer.from('x'));
    const filler = (n: number) => Array.from({ length: n }, (_v, i) => ({ name: `f${i}`, raw: tiny, usize: 1 }));
    const atCap = timed(() => readZipEntries(zip(filler(2000)), all, CAPS));
    expect(entries(atCap.out).size).toBe(2000);
    const over = timed(() => readZipEntries(zip(filler(2001)), all, CAPS));
    expect(over.out).toEqual({ error: 'unreadable', detail: 'the archive has more than 2000 entries' });
    expect(over.ms).toBeLessThan(bound(1000));

    // Per entry: exactly the cap is read, one byte more is refused (stored and deflated alike).
    const exact = Buffer.alloc(4 * MiB, 'a');
    const plus = Buffer.alloc(4 * MiB + 1, 'a');
    expect(entries(readZipEntries(zip([{ name: 'a', raw: exact, method: 0, usize: exact.length }]), all, CAPS)).get('a')!.length).toBe(4 * MiB);
    expect(failure(readZipEntries(zip([{ name: 'a', raw: plus, method: 0, usize: plus.length }]), all, CAPS))).toBe('too-large');
    expect(failure(readZipEntries(zip([{ name: 'a', raw: deflateRawSync(plus), usize: 1 }]), all, CAPS))).toBe('too-large');

    // Total: nine 3.9 MiB entries pass each per-entry cap but not the 32 MiB total.
    const part = deflateRawSync(Buffer.alloc(Math.floor(3.9 * MiB)));
    const nine = Array.from({ length: 9 }, (_v, i) => ({ name: `p${i}`, raw: part, usize: 100 }));
    const total = timed(() => readZipEntries(zip(nine), all, CAPS));
    expect(total.out).toEqual({ error: 'too-large', detail: 'the entries together are larger than 33554432 bytes' });
    expect(total.ms).toBeLessThan(bound(2000));
    expect(entries(readZipEntries(zip(nine.slice(0, 8)), all, CAPS)).size).toBe(8);
    // Only accepted entries count toward the total.
    expect(entries(readZipEntries(zip(nine), (n) => n !== 'p8', CAPS)).size).toBe(8);
  });
});
