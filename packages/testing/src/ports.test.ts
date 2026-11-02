import { createServer, type AddressInfo, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { freePort, isAddressInUse, startOnFreePort } from './ports.ts';

const servers: Server[] = [];

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, resolve);
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

describe('freePort', () => {
  it('offers a port below the ephemeral ranges that can be listened on', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThanOrEqual(32_767);
    await listen(port);
  });

  it('never offers a port something already listens on', async () => {
    const takenPorts = new Set<number>();
    // One at a time: two picks at once can choose the same port, which startOnFreePort retries.
    for (let server = 0; server < 20; server += 1) {
      const port = await freePort();
      await listen(port);
      takenPorts.add(port);
    }
    expect(takenPorts.size).toBe(20);
    for (let probe = 0; probe < 200; probe += 1) {
      expect(takenPorts.has(await freePort())).toBe(false);
    }
  });
});

describe('startOnFreePort', () => {
  it('starts again on another port when the first one was taken in between', async () => {
    const occupied = await listen(await freePort());
    const occupiedPort = (occupied.address() as AddressInfo).port;
    const tried: number[] = [];
    const server = await startOnFreePort(async (port) => {
      tried.push(port);
      // The first start loses the race: another test bound its port after the probe.
      return listen(tried.length === 1 ? occupiedPort : port);
    });
    expect(tried).toHaveLength(2);
    expect((server.address() as AddressInfo).port).toBe(tried[1]);
  });

  it('starts again when a child process reports the port in use on its stderr', async () => {
    let calls = 0;
    const result = await startOnFreePort(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          'process exited before the expected log line; stderr:\nError: listen EADDRINUSE: address already in use 127.0.0.1:33835',
        );
      }
      return 'started';
    });
    expect(result).toBe('started');
    expect(calls).toBe(2);
  });

  it('does not retry any other failure', async () => {
    let calls = 0;
    await expect(
      startOnFreePort(async () => {
        calls += 1;
        throw new Error('the API refused its settings');
      }),
    ).rejects.toThrow('the API refused its settings');
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts with the last error', async () => {
    let calls = 0;
    const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    await expect(
      startOnFreePort(
        async () => {
          calls += 1;
          throw inUse;
        },
        { attempts: 3 },
      ),
    ).rejects.toBe(inUse);
    expect(calls).toBe(3);
  });
});

describe('isAddressInUse', () => {
  it('recognizes a listen error by its code or its message, and nothing else', () => {
    expect(isAddressInUse(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(
      isAddressInUse(new Error('stderr:\nError: listen EADDRINUSE: address already in use')),
    ).toBe(true);
    expect(isAddressInUse(new Error('ECONNREFUSED'))).toBe(false);
    expect(isAddressInUse('EADDRINUSE')).toBe(false);
  });
});
