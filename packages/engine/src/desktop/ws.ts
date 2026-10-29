// A minimal RFC 6455 WebSocket: the handshake key check and the frame format, for text messages over a socket the
// caller already secured. Node's built-in WebSocket offers no hook to check the server certificate before the upgrade
// request (with its Authorization header) is sent, and the desktop runner client must pin the certificate first; this
// keeps that in our hands without a new dependency. Binary messages and extensions are not used by the protocol.

import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** The Sec-WebSocket-Accept value for a Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** A fresh Sec-WebSocket-Key: 16 random bytes, base64. */
export function newKey(): string {
  return randomBytes(16).toString('base64');
}

/** One frame. Client frames are masked (`mask: true`), server frames are not. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const headLen = 2 + (len < 126 ? 0 : len < 65_536 ? 2 : 8) + (mask ? 4 : 0);
  const head = Buffer.alloc(headLen);
  head[0] = 0x80 | (opcode & 0x0f);
  let at = 2;
  if (len < 126) head[1] = len;
  else if (len < 65_536) { head[1] = 126; head.writeUInt16BE(len, 2); at = 4; }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); at = 10; }
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const key = randomBytes(4);
  key.copy(head, at);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([head, body]);
}

export interface Frame { fin: boolean; opcode: number; payload: Buffer }

export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

/**
 * Splits a byte stream into frames and joins fragmented messages. `expectMasked`: whether the peer must mask (a server
 * reading a client). Messages over `maxMessageBytes` are a protocol error, so a peer cannot make us hold unbounded data.
 */
export class FrameReader {
  /** Bytes not yet consumed, as received: joined only once they hold a whole frame (no quadratic copying). */
  private chunks: Buffer[] = [];
  private pending = 0;
  private buf: Buffer = Buffer.alloc(0);
  /** Bytes the next frame needs before parsing is worth trying (0: unknown yet). */
  private need = 0;
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private partOpcode = 0;

  constructor(private readonly expectMasked: boolean, private readonly maxMessageBytes: number) {}

  /** Feeds bytes; returns complete messages (text/binary joined) and control frames, in order. */
  push(chunk: Buffer): Frame[] {
    this.chunks.push(chunk);
    this.pending += chunk.length;
    const out: Frame[] = [];
    if (this.pending < this.need) return out;
    this.buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.pending);
    this.chunks = [];
    this.pending = 0;
    for (;;) {
      const frame = this.next();
      if (!frame) {
        if (this.buf.length) { this.chunks = [this.buf]; this.pending = this.buf.length; }
        this.buf = Buffer.alloc(0);
        return out;
      }
      const control = frame.opcode >= 0x8;
      if (control) {
        if (!frame.fin || frame.payload.length > 125) throw new WsProtocolError('invalid control frame');
        out.push(frame);
        continue;
      }
      if (frame.opcode === OPCODE.continuation) {
        if (!this.partOpcode) throw new WsProtocolError('continuation without a message');
      } else {
        if (this.partOpcode) throw new WsProtocolError('new message inside a fragmented one');
        this.partOpcode = frame.opcode;
      }
      this.partsBytes += frame.payload.length;
      if (this.partsBytes > this.maxMessageBytes) throw new WsProtocolError(`message larger than ${this.maxMessageBytes} bytes`);
      this.parts.push(frame.payload);
      if (frame.fin) {
        out.push({ fin: true, opcode: this.partOpcode, payload: Buffer.concat(this.parts) });
        this.parts = [];
        this.partsBytes = 0;
        this.partOpcode = 0;
      }
    }
  }

  private next(): Frame | undefined {
    const b = this.buf;
    this.need = 0;
    if (b.length < 2) return undefined;
    const fin = (b[0] & 0x80) !== 0;
    if ((b[0] & 0x70) !== 0) throw new WsProtocolError('reserved bits set');
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    if (masked !== this.expectMasked) throw new WsProtocolError(masked ? 'server frames must not be masked' : 'client frames must be masked');
    let len = b[1] & 0x7f;
    let at = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      at = 4;
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) throw new WsProtocolError(`message larger than ${this.maxMessageBytes} bytes`);
      len = Number(big);
      at = 10;
    }
    if (len > this.maxMessageBytes) throw new WsProtocolError(`message larger than ${this.maxMessageBytes} bytes`);
    const keyAt = at;
    if (masked) at += 4;
    if (b.length < at + len) { this.need = at + len; return undefined; }
    let payload = b.subarray(at, at + len);
    if (masked) {
      const key = b.subarray(keyAt, keyAt + 4);
      const plain = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) plain[i] = payload[i] ^ key[i & 3];
      payload = plain;
    } else {
      payload = Buffer.from(payload);
    }
    this.buf = b.subarray(at + len);
    return { fin, opcode, payload };
  }
}
