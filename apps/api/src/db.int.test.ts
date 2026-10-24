import { afterAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from '@listora/testing';

import { createDatabasePool, pingDatabase } from './db.ts';

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
});
