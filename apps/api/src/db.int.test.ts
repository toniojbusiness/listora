import { createServer, connect, type AddressInfo, type Socket } from 'node:net';

import { afterAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from '@listora/testing';

import { createDatabasePool, pingDatabase } from './db.ts';

/**
 * TCP proxy to Postgres that can stop forwarding traffic while keeping connections open,
 * simulating a network partition or a server that accepted the connection but hangs.
 */
async function startFreezableProxy(
  targetUrl: string,
): Promise<{ url: string; freeze: () => void; close: () => Promise<void> }> {
  const target = new URL(targetUrl);
  const sockets = new Set<Socket>();
  let frozen = false;
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    client.on('data', (chunk) => {
      if (!frozen) upstream.write(chunk);
    });
    upstream.on('data', (chunk) => {
      if (!frozen) client.write(chunk);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const proxied = new URL(targetUrl);
  proxied.port = String((server.address() as AddressInfo).port);
  return {
    url: proxied.toString(),
    freeze: () => {
      frozen = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('database connectivity (real Postgres)', () => {
  const pool = createDatabasePool({ connectionString: testDatabaseUrl() });

  afterAll(async () => {
    await pool.end();
  });

  it('connects to the test database on PostgreSQL 18', async () => {
    await pingDatabase(pool);
    const { rows } = await pool.query<{ database: string; version: number }>(
      "select current_database() as database, current_setting('server_version_num')::int as version",
    );
    expect(rows[0]?.database).toBe('listora_test');
    expect(rows[0]?.version).toBeGreaterThanOrEqual(180_000);
  });

  it('rejects promptly when Postgres is unreachable', async () => {
    // Port 1 is reserved and never runs Postgres, so the connection is refused.
    const unreachable = createDatabasePool({
      connectionString: 'postgres://listora@127.0.0.1:1/listora_test',
      connectionTimeoutMillis: 2_000,
    });
    try {
      await expect(pingDatabase(unreachable)).rejects.toThrow();
    } finally {
      await unreachable.end();
    }
  });

  it('rejects promptly when an open connection stops answering', async () => {
    const proxy = await startFreezableProxy(testDatabaseUrl());
    const stalled = createDatabasePool({ connectionString: proxy.url, max: 1 });
    try {
      await pingDatabase(stalled);
      proxy.freeze();

      const startedAt = Date.now();
      await expect(pingDatabase(stalled, 500)).rejects.toThrow(/timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await proxy.close();
      await stalled.end();
    }
  });
});
