// A self-signed P-256 certificate made with node:crypto (a few lines of DER), for a gate that serves TLS itself: no
// openssl, no dependencies. The certificate names no host (no subjectAltName), so a client trusts it by its SHA-256
// fingerprint, not by its name. Nothing here is used by the gate at run time; the gate only reads the files.
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const DAY_MS = 86_400_000;

/** One DER element: tag, length (up to 65535 bytes), content. */
function tlv(tag, content) {
  const len = content.length;
  const head = len < 0x80 ? Buffer.from([tag, len]) : len < 0x100 ? Buffer.from([tag, 0x81, len]) : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([head, content]);
}
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** A validity date: UTCTime (two-digit year) up to 2049, GeneralizedTime from 2050 on, as RFC 5280 requires. */
function time(d) {
  const digits = d.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));

/** SHA-256 of a DER certificate as uppercase hex pairs joined by colons. */
const fingerprintOfDer = (der) => createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');

/** The SHA-256 fingerprint of a PEM certificate (the first one in the text), as uppercase hex pairs joined by colons. */
export function fingerprintOfPem(certPem) {
  return fingerprintOfDer(new X509Certificate(certPem).raw);
}

/**
 * A fresh key and its self-signed certificate for `commonName`, valid from yesterday for `years` years.
 * Returns { key: PEM pkcs8 P-256 private key, cert: PEM certificate, fingerprint }. The key is a secret: write it to a
 * file only its owner can read, and never print it.
 */
export function selfSignedCert({ commonName = 'rpa-browser', years = 10 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(8);
  serial[0] = (serial[0] & 0x3f) | 0x40; // a positive INTEGER in minimal DER (no leading zero byte, high bit clear)
  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(now.getUTCFullYear() + years);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    ecdsaSha256,
    name(commonName),
    seq(time(new Date(now.getTime() - DAY_MS)), time(notAfter)),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, fingerprint: fingerprintOfDer(der) };
}
