import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A TCP connection that gets no answer at all (a private address n8n cannot reach, a firewall that drops it, a machine
// that is off) cannot be made on a test machine, so node:tls is replaced by a socket that never connects. Every other
// case (refused, reset, a late TLS handshake) runs against real sockets in desktop-client.test.ts.
const opened = vi.hoisted(() => ({ hosts: [] as string[], sockets: [] as (import('node:events').EventEmitter & { destroyed: boolean })[] }));
vi.mock('node:tls', () => ({
  connect: (options: { host: string }) => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { socket.destroyed = true; } });
    opened.hosts.push(options.host);
    opened.sockets.push(socket);
    return socket;
  },
}));

const { connectRunner, RUNNER_TCP_CONNECT_TIMEOUT_MS } = await import('../src/desktop/client.js');
const { RunnerConnectError } = await import('../src/desktop/protocol.js');

const FINGERPRINT = 'AB:'.repeat(31) + 'AB';
const CHECKS_PUBLIC = 'Check, in this order: 1. The address in the Connection Line is one n8n can reach. '
  + '2. The port is open to n8n\'s address (Install-Rpa.ps1 -AllowFrom, and any firewall on the way). '
  + '3. The Windows machine is on and the runner runs there (rpa status).';

/** Starts a connection that never gets a TCP answer and returns how it ended and when (in fake time). */
function noAnswer(url: string, timeoutMs?: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const outcome = connectRunner({ url, token: 't', fingerprint: FINGERPRINT }, timeoutMs === undefined ? {} : { timeoutMs })
    .catch((e: unknown) => e)
    .finally(() => { settled = true; });
  return { outcome, settled: () => settled };
}

describe('a runner whose address gets no TCP answer', () => {
  afterEach(() => {
    vi.useRealTimers();
    opened.hosts.length = 0;
    opened.sockets.length = 0;
  });

  it('gives the TCP connection 10 s of its own', () => {
    expect(RUNNER_TCP_CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  it('fails after 10 s, not 60 s, and says what to check in order', async () => {
    const { outcome, settled } = noAnswer('wss://runner.example.com:8765');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(RunnerConnectError);
    expect((err as Error).message).toBe(`Could not connect to the desktop runner at wss://runner.example.com:8765/rpa/v1 (no answer within 10 s). ${CHECKS_PUBLIC}`);
    expect(opened.sockets.every((s) => s.destroyed)).toBe(true);
    // Not tried again: nothing answered, so a second try would only wait as long again.
    expect(opened.hosts).toEqual(['runner.example.com']);
  });

  it.each([
    ['10.90.0.10', 'wss://10.90.0.10:8765'],
    ['172.16.0.1', 'wss://172.16.0.1:8765'],
    ['172.31.255.254', 'wss://172.31.255.254:8765'],
    ['192.168.1.20', 'wss://192.168.1.20:8765'],
    ['fd00::20', 'wss://[fd00::20]:8765'],
    ['fe80::1', 'wss://[fe80::1]:8765'],
  ])('names %s as a private address and the whole command that prints the line with -Address', async (host, url) => {
    const { outcome } = noAnswer(url);
    await vi.advanceTimersByTimeAsync(10_000);
    const message = ((await outcome) as Error).message;
    expect(message).toBe(
      `Could not connect to the desktop runner at ${url}/rpa/v1 (no answer within 10 s). Check, in this order: `
      + `1. The address in the Connection Line is one n8n can reach. ${host} is a private address: if n8n is outside the `
      + 'Windows machine\'s network, print the line there in an administrator PowerShell with '
      + '& "C:\\Program Files\\RPA Runner\\rpa.cmd" connection -ShowTokens -Address followed by the name or address n8n can reach, '
      + 'and paste it again. '
      + '2. The port is open to n8n\'s address (Install-Rpa.ps1 -AllowFrom, and any firewall on the way). '
      + '3. The Windows machine is on and the runner runs there (rpa status).',
    );
  });

  it.each(['172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '203.0.113.10', '2001:db8::1'])('does not call %s private', async (host) => {
    const { outcome } = noAnswer(`wss://${host.includes(':') ? `[${host}]` : host}:8765`);
    await vi.advanceTimersByTimeAsync(10_000);
    const message = ((await outcome) as Error).message;
    expect(message).not.toContain('private address');
    expect(message).toContain(CHECKS_PUBLIC);
  });

  it('a shorter overall limit than 10 s also bounds the TCP connection', async () => {
    const { outcome, settled } = noAnswer('wss://runner.example.com:8765', 3_000);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await outcome) as Error).message).toContain('(no answer within 3 s). Check, in this order: 1.');
  });

  it('a TCP connection made in time is given the rest of the long limit for the TLS handshake', async () => {
    const { outcome, settled } = noAnswer('wss://10.90.0.10:8765');
    await vi.advanceTimersByTimeAsync(5_000);
    opened.sockets[0].emit('connect');
    await vi.advanceTimersByTimeAsync(54_999);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The port answered, so this is the wait for the runner (a sign-in), with its own words.
    expect(((await outcome) as Error).message).toBe('Could not connect to the desktop runner at wss://10.90.0.10:8765/rpa/v1 (no answer within 60 s). Is it running, and is the port open?');
  });
});
