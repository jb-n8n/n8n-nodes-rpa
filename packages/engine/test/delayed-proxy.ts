import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';

/**
 * A TCP proxy in front of a server that holds every connection until release(): the client's first bytes (its TLS hello)
 * wait in the proxy, so the server's handshake starts late, as for a machine that signs a user in before it answers.
 * Until release() nothing reaches the server and nothing comes back.
 */
export interface DelayedProxy {
  port: number;
  release(): void;
  /** Resolves once a connection is held. Polls with setImmediate, which fake timers leave alone (vi.waitFor would advance them). */
  whenHeld(): Promise<void>;
  close(): Promise<void>;
}

export async function startDelayedProxy(targetPort: number): Promise<DelayedProxy> {
  const held: Socket[] = [];
  const all = new Set<Socket>();
  const forward = (client: Socket) => {
    const upstream = netConnect(targetPort, '127.0.0.1');
    all.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => { all.delete(upstream); client.destroy(); });
  };
  let released = false;
  let accepted = 0;
  const server: Server = createServer((client) => {
    accepted += 1;
    all.add(client);
    client.once('close', () => all.delete(client));
    client.on('error', () => undefined);
    if (released) forward(client);
    else { client.pause(); held.push(client); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as { port: number }).port,
    async whenHeld() {
      while (accepted === 0) await new Promise((r) => setImmediate(r));
    },
    release() {
      released = true;
      for (const c of held.splice(0)) forward(c);
    },
    close: async () => {
      for (const s of all) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
