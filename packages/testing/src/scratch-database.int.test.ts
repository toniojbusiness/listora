import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { testDatabaseUrl } from './database-url.ts';
import { createScratchDatabase } from './scratch-database.ts';

async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query('select 1 from pg_database where datname = $1', [name]);
    return rows.length === 1;
  } finally {
    await client.end();
  }
}

describe('createScratchDatabase (real Postgres)', () => {
  it('creates an empty database and drops it even with open sessions', async () => {
    const scratch = await createScratchDatabase('helper');
    expect(scratch.name).toMatch(/^listora_test_helper_[0-9a-f]{12}$/);

    const client = new pg.Client({ connectionString: scratch.url });
    client.on('error', () => undefined);
    await client.connect();
    const { rows } = await client.query<{ tables: string }>(
      "select count(*) as tables from pg_tables where schemaname = 'public'",
    );
    expect(rows[0]?.tables).toBe('0');

    await scratch.drop();
    expect(await databaseExists(scratch.name)).toBe(false);
    await client.end().catch(() => undefined);
  });

  it('rejects a prefix that is not a plain identifier', async () => {
    await expect(createScratchDatabase('x; drop database listora')).rejects.toThrow(RangeError);
  });
});
