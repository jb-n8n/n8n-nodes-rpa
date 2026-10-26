import { deflateRawSync } from 'node:zlib';

/** One entry of a hand-built zip: sizes, flags and method may lie. */
export interface Ent { name: string; raw: Buffer; method?: number; usize: number; flags?: number }

/**
 * A zip built by hand, so sizes and flags can lie (the builder from test/file-check.test.ts). Local headers carry zero
 * sizes when flag bit 3 is set. `cdCopies` repeats every central-directory record.
 */
export function zip(entries: Ent[], cdCopies = 1): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const flags = e.flags ?? 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(e.method ?? 8, 8);
    if (!(flags & 8)) { lh.writeUInt32LE(e.raw.length, 18); lh.writeUInt32LE(e.usize, 22); }
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(e.method ?? 8, 10);
    ch.writeUInt32LE(e.raw.length, 20); ch.writeUInt32LE(e.usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, e.raw);
    for (let i = 0; i < cdCopies; i++) central.push(ch, name);
    off += 30 + name.length + e.raw.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length * cdCopies, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** `mb` MiB of zeros, raw-deflated (about 1,000:1). */
export const zeros = (mb: number): Buffer => deflateRawSync(Buffer.alloc(mb * 1024 * 1024));

/** Runs f and returns its result with the elapsed milliseconds. */
export const timed = <T>(f: () => T): { out: T; ms: number } => {
  const t = performance.now();
  const out = f();
  return { out, ms: performance.now() - t };
};
