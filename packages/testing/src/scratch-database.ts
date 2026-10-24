import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { testDatabaseUrl } from './database-url.ts';

export interface ScratchDatabase {
  /** Connection URL of the new, empty database. */
  readonly url: string;
  readonly name: string;
  /** Drops the database, disconnecting any remaining sessions. */
  drop(): Promise<void>;
}

/**
 * Creates an empty database on the test cluster, for tests that need a schema of their own
 * (migrations, schema-wide constraints) without disturbing tests that share `listora_test`.
 * Always `drop()` it in the test's teardown.
 */
export async function createScratchDatabase(prefix = 'scratch'): Promise<ScratchDatabase> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(prefix)) {
    throw new RangeError(`scratch database prefix must be a lowercase identifier, got ${prefix}`);
  }
  const name = `listora_test_${prefix}_${randomBytes(6).toString('hex')}`;
  const baseUrl = testDatabaseUrl();
  await withAdminClient(baseUrl, async (client) => {
    await client.query(`create database ${name} template template0 encoding 'UTF8'`);
  });
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: () =>
      withAdminClient(baseUrl, async (client) => {
        await client.query(`drop database if exists ${name} with (force)`);
      }),
  };
}

async function withAdminClient(
  baseUrl: string,
  work: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString: baseUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}
