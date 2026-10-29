// A self-signed P-256 certificate made at test time with node:crypto (a few lines of DER), so no key is committed and no
// openssl is needed. The fake desktop runner serves it, as the real runner serves the one it generates on first start.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function tlv(tag: number, content: Buffer): Buffer {
  const len = content.length;
  const head = len < 0x80 ? Buffer.from([tag, len]) : len < 0x100 ? Buffer.from([tag, 0x81, len]) : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([head, content]);
}
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utcTime = (d: Date) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`, 'ascii'));
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

export interface TestCert { key: string; cert: string; der: Buffer; fingerprint: string }

/** A fresh self-signed certificate for `cn`, valid from yesterday for a year. `fingerprint` as the runner prints it. */
export function selfSignedCert(cn = 'fake-desktop-runner'): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x3f) | 0x40; // a positive INTEGER in minimal DER (no leading zero byte, high bit clear)
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    ecdsaSha256,
    name(cn),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 365 * 86_400_000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  const fingerprint = createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert, der, fingerprint };
}
