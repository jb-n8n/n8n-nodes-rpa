import { Inflate } from 'fflate';

/** Limits for one archive: entries in the central directory, bytes per accepted entry, and bytes of all accepted entries. */
export interface ZipCaps { maxEntries: number; perEntry: number; total: number }

export type ZipError = { error: 'too-large' | 'unreadable'; detail: string };

const SLICE = 16 * 1024;

class Unreadable extends Error {}

/** An entry name for a message: JSON-quoted and cut to 200 characters. */
const label = (name: string): string => JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}…` : name);

/**
 * Reads the accepted entries of a zip through its central directory (no recursive or whole-entry inflation). Each entry is
 * inflated in 16 KiB slices and aborted once it, or all accepted entries together, exceed the caps. The archive is
 * `unreadable` when it is malformed, has more than `caps.maxEntries` entries, is zip64, or when an accepted entry is
 * listed twice, encrypted, uses a method other than stored (0) or deflate (8), is deflated with no bytes, or fails to
 * inflate, when the accepted entries' compressed sizes together exceed the file (they overlap), or when `accept` throws. It is `too-large` when an accepted entry declares or inflates to more than `caps.perEntry` bytes, or all
 * accepted entries to more than `caps.total`. Never throws.
 */
export function readZipEntries(data: Buffer, accept: (name: string) => boolean, caps: ZipCaps): Map<string, Buffer> | ZipError {
  try {
    return read(data, accept, caps);
  } catch (e) {
    const detail = e instanceof Unreadable ? e.message : `the archive is malformed${e instanceof Error && e.message ? ` (${e.message})` : ''}`;
    return { error: 'unreadable', detail };
  }
}

function read(data: Buffer, accept: (name: string) => boolean, caps: ZipCaps): Map<string, Buffer> | ZipError {
  const need = (ok: boolean, detail: string) => { if (!ok) throw new Unreadable(detail); };
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65_535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  need(eocd >= 0, 'the file is not a zip archive (no end of central directory)');
  const count = data.readUInt16LE(eocd + 10);
  const cdOffset = data.readUInt32LE(eocd + 16);
  need(count !== 0xffff && cdOffset !== 0xffffffff, 'zip64 archives are not supported');
  need(count <= caps.maxEntries, `the archive has more than ${caps.maxEntries} entries`);
  const found = new Map<string, { method: number; csize: number; usize: number; local: number }>();
  let p = cdOffset;
  let inBytes = 0;
  for (let n = 0; n < count; n++) {
    need(p + 46 <= data.length && data.readUInt32LE(p) === 0x02014b50, 'the central directory is malformed');
    const flags = data.readUInt16LE(p + 8);
    const method = data.readUInt16LE(p + 10);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    need(p + 46 + nameLen <= data.length, 'the central directory is malformed');
    const name = data.toString('utf8', p + 46, p + 46 + nameLen);
    let wanted: boolean;
    try { wanted = accept(name); } catch { throw new Unreadable('the entry filter failed'); }
    if (wanted) {
      need(!found.has(name), `entry ${label(name)} is listed twice`);
      need((flags & 1) === 0, `entry ${label(name)} is encrypted`);
      need(method === 0 || method === 8, `entry ${label(name)} uses compression method ${method}`);
      const csize = data.readUInt32LE(p + 20);
      need(method === 0 || csize > 0, `entry ${label(name)} is deflated but has no compressed data`);
      // Entries that share bytes could make every record inflate the same stream (one that inflates to nothing escapes
      // the output caps), so the accepted entries' compressed sizes together must fit in the file.
      inBytes += csize;
      need(inBytes <= data.length, 'the accepted entries overlap');
      found.set(name, { method, csize, usize: data.readUInt32LE(p + 24), local: data.readUInt32LE(p + 42) });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  const result = new Map<string, Buffer>();
  for (const [name, e] of found) {
    const tooBig: ZipError = { error: 'too-large', detail: `entry ${label(name)} is larger than ${caps.perEntry} bytes` };
    if (e.usize > caps.perEntry) return { error: 'too-large', detail: `entry ${label(name)} declares ${e.usize} bytes, larger than ${caps.perEntry} bytes` };
    need(e.local + 30 <= data.length && data.readUInt32LE(e.local) === 0x04034b50, `entry ${label(name)} has no local header`);
    const start = e.local + 30 + data.readUInt16LE(e.local + 26) + data.readUInt16LE(e.local + 28);
    need(start + e.csize <= data.length, `entry ${label(name)} runs past the end of the file`);
    const parts: Uint8Array[] = [];
    let size = 0;
    let over: ZipError | null = null;
    const take = (chunk: Uint8Array): boolean => {
      size += chunk.length;
      total += chunk.length;
      if (size > caps.perEntry) over = tooBig;
      else if (total > caps.total) over = { error: 'too-large', detail: `the entries together are larger than ${caps.total} bytes` };
      if (over) return false;
      parts.push(chunk);
      return true;
    };
    if (e.method === 0) {
      if (!take(data.subarray(start, start + e.csize))) return over!;
    } else {
      const inflate = new Inflate((chunk) => { if (!over) take(chunk); });
      let at = start;
      const end = start + e.csize;
      do {
        const next = Math.min(end, at + SLICE);
        try {
          inflate.push(data.subarray(at, next), next >= end);
        } catch (err) {
          throw new Unreadable(`entry ${label(name)} cannot be inflated${err instanceof Error && err.message ? ` (${err.message})` : ''}`);
        }
        at = next;
        if (over) return over;
      } while (at < end);
    }
    result.set(name, Buffer.concat(parts));
  }
  return result;
}
