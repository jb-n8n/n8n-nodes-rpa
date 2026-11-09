// The self-signed certificate the gate serves where it does TLS itself. node:test, no dependencies. Every key is made
// at run time; none is committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { connect, createServer } from 'node:tls';
import { fingerprintOfPem, selfSignedCert } from '../selfsigned.mjs';

const DAY_MS = 86_400_000;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** `years` after now, the way a calendar counts them. */
function yearsAhead(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}

test('the certificate parses, is signed by its own key and names rpa-browser', () => {
  const { key, cert } = selfSignedCert();
  assert.match(key, /^-----BEGIN PRIVATE KEY-----\n/);
  assert.match(cert, /^-----BEGIN CERTIFICATE-----\n/);
  const x509 = new X509Certificate(cert);
  assert.equal(x509.subject, 'CN=rpa-browser');
  assert.equal(x509.issuer, 'CN=rpa-browser');
  assert.equal(x509.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(x509.verify(x509.publicKey), true, 'self-signed');
  assert.equal(x509.checkPrivateKey(createPrivateKey(key)), true, 'the key belongs to the certificate');
  assert.equal(new X509Certificate(selfSignedCert({ commonName: 'browser-host-1' }).cert).subject, 'CN=browser-host-1');
});

test('the fingerprint is the SHA-256 of the certificate, as uppercase hex pairs joined by colons', () => {
  const { cert, fingerprint } = selfSignedCert();
  assert.match(fingerprint, FINGERPRINT);
  assert.equal(fingerprint, new X509Certificate(cert).fingerprint256);
  assert.equal(fingerprintOfPem(cert), fingerprint);
  assert.equal(fingerprintOfPem(cert.replaceAll('\n', '\r\n')), fingerprint, 'a file with CRLF line ends reads the same');
  assert.throws(() => fingerprintOfPem('not a certificate'));
});

test('it is valid from yesterday for 10 years', () => {
  const x509 = new X509Certificate(selfSignedCert().cert);
  assert.ok(Math.abs(Date.parse(x509.validTo) - yearsAhead(10)) < DAY_MS, `validTo ${x509.validTo}`);
  assert.ok(Math.abs(Date.parse(x509.validFrom) - (Date.now() - DAY_MS)) < DAY_MS, `validFrom ${x509.validFrom}`);
  const short = new X509Certificate(selfSignedCert({ years: 1 }).cert);
  assert.ok(Math.abs(Date.parse(short.validTo) - yearsAhead(1)) < DAY_MS, `validTo ${short.validTo}`);
});

test('a validity that ends after 2049 still parses to the right year', () => {
  // X.509 writes dates from 2050 on in another form (GeneralizedTime); a two-digit year would read as 19xx.
  const years = 2060 - new Date().getUTCFullYear();
  const x509 = new X509Certificate(selfSignedCert({ years }).cert);
  assert.ok(Math.abs(Date.parse(x509.validTo) - yearsAhead(years)) < DAY_MS, `validTo ${x509.validTo}`);
});

test('a tls server started with the key and certificate completes a handshake', async (t) => {
  const { key, cert, fingerprint } = selfSignedCert();
  const server = createServer({ key, cert }, (socket) => socket.end('hello'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  // The certificate is its own trust anchor. It names no host, so the client checks the fingerprint, not the name.
  const client = connect({ host: '127.0.0.1', port: server.address().port, ca: cert, checkServerIdentity: () => undefined });
  await once(client, 'secureConnect');
  assert.equal(client.authorized, true);
  assert.equal(client.getPeerCertificate().fingerprint256, fingerprint);
  const [chunk] = await once(client, 'data');
  assert.equal(chunk.toString(), 'hello');
  client.destroy();
});

test('two calls give different keys', () => {
  const a = selfSignedCert();
  const b = selfSignedCert();
  assert.notEqual(a.key, b.key);
  assert.notEqual(a.cert, b.cert);
  assert.notEqual(a.fingerprint, b.fingerprint);
});
