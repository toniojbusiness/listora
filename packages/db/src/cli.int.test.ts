import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScratchDatabase, startNodeProcess, type ScratchDatabase } from '@listora/testing';

const entry = fileURLToPath(new URL('cli.ts', import.meta.url));
/** The migrations shipped in migrations/, in order. */
const SHIPPED = [
  '0001_schema_v1',
  '0002_ai_metering',
  '0003_idempotency',
  '0004_item_pre_archive_status',
  '0005_photo_pipeline',
  '0006_read_freshness',
  '0007_pending_listing_id',
  '0008_item_analysis',
];
const LATEST = SHIPPED.at(-1) ?? '';

/** Runs the real migrate command (`node src/cli.ts ...`) to completion. */
async function migrate(env: NodeJS.ProcessEnv, ...args: string[]) {
  const process_ = startNodeProcess(entry, { PATH: process.env['PATH'], ...env }, args);
  const code = await process_.waitForExit(20_000);
  return { code, logs: process_.logs, stderr: process_.stderr };
}

async function functionExists(url: string, name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ found: boolean }>(
      "select exists (select 1 from pg_proc where oid::regprocedure::text like $1 || '(%') as found",
      [name],
    );
    return rows[0]?.found === true;
  } finally {
    await client.end();
  }
}

describe('migrate command (real Postgres)', () => {
  let scratch: ScratchDatabase;

  beforeEach(async () => {
    scratch = await createScratchDatabase('cli');
  });

  afterEach(async () => {
    await scratch.drop();
  });

  it('applies, reports, and reverts migrations', async () => {
    const env = { DATABASE_URL: scratch.url };

    const applied = await migrate(env, 'latest');
    expect(applied.code).toBe(0);
    expect(applied.logs).toContainEqual(
      expect.objectContaining({ msg: 'migrations applied', applied: SHIPPED }),
    );

    expect(applied.logs).toContainEqual(
      expect.objectContaining({ msg: 'job queue schema is up to date', schema: 'graphile_worker' }),
    );
    expect(await functionExists(scratch.url, 'graphile_worker.add_job')).toBe(true);

    const again = await migrate(env);
    expect(again.code).toBe(0);
    expect(again.logs).toContainEqual(expect.objectContaining({ msg: 'schema is up to date' }));

    const status = await migrate(env, 'status');
    expect(status.code).toBe(0);
    for (const migration of SHIPPED) {
      expect(status.logs).toContainEqual(expect.objectContaining({ msg: 'applied', migration }));
    }

    const reverted = await migrate(env, 'down', LATEST);
    expect(reverted.code).toBe(0);
    expect(reverted.logs).toContainEqual(
      expect.objectContaining({ msg: 'migration reverted', reverted: [LATEST] }),
    );
    const pending = await migrate(env, 'status');
    for (const migration of SHIPPED.slice(0, -1)) {
      expect(pending.logs).toContainEqual(expect.objectContaining({ msg: 'applied', migration }));
    }
    expect(pending.logs).toContainEqual(
      expect.objectContaining({ msg: 'pending', migration: LATEST }),
    );
  });

  it('refuses to revert a migration that is not the latest applied one', async () => {
    const env = { DATABASE_URL: scratch.url };
    expect((await migrate(env)).code).toBe(0);

    const refused = await migrate(env, 'down', '0000_wrong');
    expect(refused.code).toBe(1);
    const failure = refused.logs.find((line) => line['msg'] === 'migration command failed');
    expect(failure?.['err']).toMatchObject({
      message: `Refusing to revert: the latest applied migration is ${LATEST}, not 0000_wrong`,
    });
    expect((await migrate(env, 'status')).logs).toContainEqual(
      expect.objectContaining({ msg: 'applied', migration: LATEST }),
    );
  });

  it('exits non-zero when the database is unreachable', async () => {
    const result = await migrate({ DATABASE_URL: 'postgres://listora@127.0.0.1:1/listora_test' });
    expect(result.code).toBe(1);
    expect(result.logs).toContainEqual(
      expect.objectContaining({ msg: 'migration command failed' }),
    );
  });

  it('refuses to start without DATABASE_URL', async () => {
    const result = await migrate({});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL is required');
  });
});
