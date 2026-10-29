import { afterEach, describe, expect, it } from 'vitest';
import { bound } from './timing.js';
import { connectRunner, fingerprintOf, normalizeFingerprint, probeRunner, runnerAddress } from '../src/desktop/client.js';
import {
  DesktopUnavailableError, ElementNotFoundError, ElementNotUniqueError, ExpectedFileMissingError, FingerprintMismatchError, NoRunError, PolicyRefusedError,
  RunnerBusyError, RunnerConnectError, RunnerDisconnectedError, runnerError, RunnerError, RunnerTimeoutError, RunnerTokenRefusedError,
} from '../src/desktop/protocol.js';
import { acceptKey, encodeFrame, FrameReader, OPCODE, WsProtocolError } from '../src/desktop/ws.js';
import { RUNNER_FINGERPRINT_INVALID, RUNNER_URL_HAS_CREDENTIALS, RUNNER_URL_NOT_SECURE } from '../src/messages.js';
import { FakeRunner } from './fake-runner.js';
import { selfSignedCert } from './fake-runner-cert.js';

let runner: FakeRunner | undefined;
afterEach(async () => {
  await runner?.close();
  runner = undefined;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WebSocket framing', () => {
  it('matches the RFC 6455 examples: the accept key, an unmasked and a masked "Hello"', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(encodeFrame(OPCODE.text, Buffer.from('Hello'), false)).toEqual(Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    const masked = Buffer.from([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    expect(new FrameReader(true, 100).push(masked)).toEqual([{ fin: true, opcode: OPCODE.text, payload: Buffer.from('Hello') }]);
  });
  it('joins fragments and split chunks, round-trips 16- and 64-bit lengths, and bounds message size', () => {
    const reader = new FrameReader(false, 200_000);
    const frag1 = Buffer.from([0x01, 0x03, 0x48, 0x65, 0x6c]);
    const frag2 = Buffer.from([0x80, 0x02, 0x6c, 0x6f]);
    const both = Buffer.concat([frag1, frag2]);
    expect(reader.push(both.subarray(0, 3))).toEqual([]);
    expect(reader.push(both.subarray(3))).toEqual([{ fin: true, opcode: OPCODE.text, payload: Buffer.from('Hello') }]);
    for (const size of [200, 70_000]) {
      const payload = Buffer.alloc(size, 0x61);
      expect(new FrameReader(true, 200_000).push(encodeFrame(OPCODE.text, payload, true))[0].payload).toEqual(payload);
    }
    expect(() => new FrameReader(false, 10).push(encodeFrame(OPCODE.text, Buffer.alloc(11), false))).toThrow(WsProtocolError);
    // A 20 MiB message in 16 KiB chunks is joined once, not once per chunk.
    const big = encodeFrame(OPCODE.text, Buffer.alloc(20 * 1024 * 1024, 0x61), false);
    const r = new FrameReader(false, 30 * 1024 * 1024);
    const t0 = Date.now();
    let got: unknown[] = [];
    for (let i = 0; i < big.length; i += 16_384) got = got.concat(r.push(big.subarray(i, i + 16_384)));
    expect(got).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(bound(1000));
    expect(() => new FrameReader(false, 100).push(encodeFrame(OPCODE.text, Buffer.from('x'), true))).toThrow('server frames must not be masked');
  });
});

describe('runner address, token and fingerprint', () => {
  it('takes wss:// only, defaults the port to 8765 and the path to /rpa/v1, and refuses credentials in the URL', () => {
    expect(runnerAddress('wss://runner.example.com')).toMatchObject({ host: 'runner.example.com', port: 8765, path: '/rpa/v1', servername: 'runner.example.com', shown: 'wss://runner.example.com:8765/rpa/v1' });
    expect(runnerAddress('wss://10.0.0.5:9000/')).toMatchObject({ host: '10.0.0.5', port: 9000, path: '/rpa/v1' });
    expect(runnerAddress('wss://10.0.0.5:9000/')).not.toHaveProperty('servername');
    for (const bad of ['ws://runner.example.com:8765', 'https://runner.example.com', 'runner.example.com:8765', '']) expect(() => runnerAddress(bad), bad).toThrow(RUNNER_URL_NOT_SECURE);
    for (const bad of ['wss://u:p@runner.example.com', 'wss://runner.example.com/?token=abc', 'wss://runner.example.com/#x']) expect(() => runnerAddress(bad), bad).toThrow(RUNNER_URL_HAS_CREDENTIALS);
  });
  it('normalises a fingerprint to uppercase colon-separated pairs and refuses anything else', () => {
    const c = selfSignedCert();
    expect(fingerprintOf(c.der)).toBe(c.fingerprint);
    expect(normalizeFingerprint(c.fingerprint.toLowerCase().replace(/:/g, ''))).toBe(c.fingerprint);
    expect(normalizeFingerprint(` ${c.fingerprint} `)).toBe(c.fingerprint);
    for (const bad of ['', 'AB:CD', c.fingerprint.slice(3), `${c.fingerprint}:00`, 'Z'.repeat(64)]) expect(() => normalizeFingerprint(bad), bad).toThrow(RUNNER_FINGERPRINT_INVALID);
  });
});

describe('pinning', () => {
  it('a wrong fingerprint ends the connection after the TLS handshake: nothing is sent, the token least of all', async () => {
    runner = await FakeRunner.start();
    const wrong = selfSignedCert().fingerprint;
    const err = await connectRunner({ ...runner.endpoint, fingerprint: wrong }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FingerprintMismatchError);
    expect((err as FingerprintMismatchError).presented).toBe(runner.fingerprint);
    expect((err as Error).message).toBe(
      `The desktop runner at ${runner.url}/rpa/v1 presented a certificate with fingerprint ${runner.fingerprint}, which is not the fingerprint in the RPA Desktop Runner credential. Nothing was sent.`,
    );
    await sleep(50);
    expect(runner.tcpConnections).toBe(1); // the client reached the runner and finished its side of the handshake
    expect(Buffer.concat(runner.bytes.flat()).length).toBe(0); // and sent not one application byte
    expect(runner.refusedUpgrades).toBe(0);
    expect(runner.requests).toEqual([]);
  });
  it('under TLS 1.2 (the server finishes the handshake last, so it would see any byte the client wrote): still nothing', async () => {
    runner = await FakeRunner.start({ tlsMaxVersion: 'TLSv1.2' });
    await expect(connectRunner({ ...runner.endpoint, fingerprint: selfSignedCert().fingerprint })).rejects.toBeInstanceOf(FingerprintMismatchError);
    await sleep(100);
    expect(runner.bytes).toHaveLength(1); // the server completed the handshake and listened
    expect(Buffer.concat(runner.bytes[0]).length).toBe(0);
    // The same server receives the upgrade (and its token) once the fingerprint matches.
    const client = await connectRunner(runner.endpoint);
    expect(Buffer.concat(runner.bytes[1]).toString('latin1')).toContain(`Authorization: Bearer ${runner.token}\r\n`);
    await client.close();
  });
  it('the right fingerprint connects, sends the token on the upgrade, and hello answers', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    expect(await client.hello()).toMatchObject({ protocol: 1, runner: { session: { interactive: true, locked: false } } });
    const sent = Buffer.concat(runner.bytes[0]).toString('latin1');
    expect(sent.startsWith('GET /rpa/v1 HTTP/1.1\r\n')).toBe(true);
    expect(sent).toContain(`Authorization: Bearer ${runner.token}\r\n`);
    await client.close();
    expect(client.closed).toBe(true);
  });
  it('a wrong token is refused with 401 and named as the token', async () => {
    runner = await FakeRunner.start();
    const err = await connectRunner({ ...runner.endpoint, token: 'not-the-token' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerTokenRefusedError);
    expect((err as Error).message).toBe(`The desktop runner at ${runner.url}/rpa/v1 refused the token. Check the Token in the RPA Desktop Runner credential.`);
    expect(runner.refusedUpgrades).toBe(1);
  });
  it('an unreachable runner is a connect error naming the address', async () => {
    runner = await FakeRunner.start();
    const url = runner.url;
    await runner.close();
    runner = undefined;
    const err = await connectRunner({ url, token: 't', fingerprint: selfSignedCert().fingerprint }, { timeoutMs: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerConnectError);
    expect((err as Error).message).toMatch(new RegExp(`^Could not connect to the desktop runner at ${url}/rpa/v1 \\(.+\\)\\. Is it running, and is the port open\\?$`));
  });
  it('a token with a line break is refused before connecting', async () => {
    runner = await FakeRunner.start();
    await expect(connectRunner({ ...runner.endpoint, token: 'a\r\nX-Evil: 1' })).rejects.toThrow('The desktop runner token is empty or contains a line break, a space or a character that is not ASCII.');
    expect(runner.bytes).toEqual([]);
  });
  it('probeRunner connects, calls hello and closes', async () => {
    runner = await FakeRunner.start({ session: { interactive: true, locked: true } });
    expect((await probeRunner(runner.endpoint)).runner.session).toEqual({ interactive: true, locked: true });
    expect(runner.methods()).toEqual(['hello']);
  });
});

describe('error codes and the lease', () => {
  it('maps every runner error code to its typed error, keeping the first line of the message', () => {
    const cases: [number, new (...a: never[]) => RunnerError, string][] = [
      [-32001, RunnerBusyError, 'runner_busy'], [-32002, DesktopUnavailableError, 'desktop_unavailable'], [-32003, PolicyRefusedError, 'policy_refused'],
      [-32004, ElementNotFoundError, 'not_found'], [-32005, ElementNotUniqueError, 'not_unique'], [-32006, ExpectedFileMissingError, 'expected_file_missing'],
      [-32007, RunnerTimeoutError, 'timeout'], [-32008, NoRunError, 'no_run'],
    ];
    for (const [code, Kind, kind] of cases) {
      const e = runnerError(code, 'first line\nsecond line');
      expect(e).toBeInstanceOf(Kind);
      expect(e).toBeInstanceOf(RunnerError);
      expect({ code: e.code, kind: e.kind, message: e.message }).toEqual({ code, kind, message: 'first line' });
    }
    expect(runnerError(-32601, 'unknown method')).toMatchObject({ kind: 'runner_error', code: -32601 });
    expect(runnerError('x', undefined).message).toBe('runner error 0');
  });
  it('a typed error comes back from a call; run.begin is refused while another run holds the lock', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await expect(client.call('run.heartbeat', { runId: 'nope' })).rejects.toBeInstanceOf(NoRunError);
    runner.holdLock();
    await expect(client.call('run.begin', { runId: 'r1', leaseMs: 5000 })).rejects.toBeInstanceOf(RunnerBusyError);
    await client.close();
  });
  it('heartbeats keep the lease alive while the run is open; without them it expires', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await client.call('run.begin', { runId: 'kept', leaseMs: 5000 });
    // The fake's floor is 5 s like the real runner's; shorten its timer to watch the lease in test time.
    const shorten = (ms: number) => { runner!.run!.leaseMs = ms; };
    shorten(600);
    const lease = client.startLease('kept', 600);
    await sleep(1500);
    expect(runner.heartbeats).toBeGreaterThanOrEqual(2); // every max(500 ms, a third of the lease)
    expect(runner.run?.runId).toBe('kept');
    expect(lease.error).toBeUndefined();
    lease.stop();
    await sleep(900);
    expect(runner.expiredRuns).toEqual(['kept']);
    expect(runner.run).toBeUndefined();
    // The next heartbeat finds no run: the lease records it and stops.
    const late = client.startLease('kept', 600);
    await sleep(800);
    expect(late.error).toBeInstanceOf(NoRunError);
    await client.close();
  });
  it('a slow heartbeat (a runner busy with a long action) does not end the lease', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await client.call('run.begin', { runId: 'slow', leaseMs: 5000 });
    runner.run!.leaseMs = 2000;
    runner.heartbeatDelayMs = 900; // longer than a beat (500 ms): beats overlap and time out on the old client
    const lease = client.startLease('slow', 600);
    await sleep(2500);
    expect(lease.error).toBeUndefined();
    expect(runner.heartbeats).toBeGreaterThanOrEqual(2);
    expect(runner.run?.runId).toBe('slow');
    lease.stop();
    await client.close();
  });
  it('pending calls fail with a disconnect when the connection drops', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await client.call('run.begin', { runId: 'r', leaseMs: 5000 });
    await client.call('app.launch', { runId: 'r', app: { exe: 'ErpDemo.exe' } });
    const pending = client.call('resolve', { runId: 'r', target: { path: [{ automationId: 'never' }] }, timeoutMs: 10_000 }, 15_000);
    await sleep(50);
    runner.dropConnections();
    await expect(pending).rejects.toBeInstanceOf(RunnerDisconnectedError);
    await expect(client.call('hello', {})).rejects.toBeInstanceOf(RunnerDisconnectedError);
  });
  it('a call nobody answers fails as a disconnect, not as the runner\'s own timeout', async () => {
    runner = await FakeRunner.start();
    const client = await connectRunner(runner.endpoint);
    await client.call('run.begin', { runId: 'r', leaseMs: 5000 });
    await client.call('app.launch', { runId: 'r', app: { exe: 'ErpDemo.exe' } });
    const err = await client.call('resolve', { runId: 'r', target: { path: [{ automationId: 'never' }] }, timeoutMs: 5_000 }, 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerDisconnectedError);
    expect((err as Error).message).toBe('the desktop runner did not answer resolve within 1 s');
    await client.close();
  });
});
