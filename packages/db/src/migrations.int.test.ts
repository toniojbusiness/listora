import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { createDatabase, type Db } from './database.ts';
import { MigrationError, SchemaMigrator, SqlFileMigrationProvider } from './migrations.ts';

const KYSELY_TABLES = ['kysely_migration', 'kysely_migration_lock'];

/** Every object in the public schema other than Kysely's bookkeeping tables. */
async function publicObjects(db: Db): Promise<string[]> {
  const { rows } = await sql<{ object: string }>`
    select c.relkind::text || ':' || c.relname as object
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname not like 'kysely_migration%'
    union all
    select 'type:' || t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('d', 'e', 'c') and t.typrelid = 0
    union all
    select 'function:' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by 1
  `.execute(db);
  return rows.map((row) => row.object);
}

async function tablesAndViews(db: Db): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' order by table_name
  `.execute(db);
  return rows.map((row) => row.name).filter((name) => !KYSELY_TABLES.includes(name));
}

/** Every migration in packages/db/migrations, in order. */
const MIGRATIONS = [
  '0001_schema_v1',
  '0002_ai_metering',
  '0003_idempotency',
  '0004_item_pre_archive_status',
  '0005_photo_pipeline',
  '0006_read_freshness',
  '0007_pending_listing_id',
  '0008_item_analysis',
  '0009_listing_content',
  '0010_deleted_identity',
  '0011_ai_controls',
];

describe('schema migrations (real Postgres)', () => {
  let scratch: ScratchDatabase;
  let db: Db;

  beforeEach(async () => {
    scratch = await createScratchDatabase('migrations');
    db = createDatabase({ connectionString: scratch.url, max: 4 });
  });

  afterEach(async () => {
    await db.destroy();
    await scratch.drop();
  });

  it('migrates an empty database up, down to empty, and up again', async () => {
    const migrator = new SchemaMigrator(db);
    expect(await publicObjects(db)).toEqual([]);

    expect(await migrator.migrateToLatest()).toEqual(MIGRATIONS);
    expect(await tablesAndViews(db)).toContain('inventory_item');
    expect(await tablesAndViews(db)).toContain('idempotency_record');
    expect(await tablesAndViews(db)).toContain('delist_run_listing');
    expect((await migrator.status()).every((migration) => migration.executedAt !== null)).toBe(
      true,
    );

    // Running again is a no-op.
    expect(await migrator.migrateToLatest()).toEqual([]);

    expect(await migrator.migrateToEmpty()).toEqual([...MIGRATIONS].reverse());
    expect(await publicObjects(db)).toEqual([]);
    expect((await migrator.status()).every((migration) => migration.executedAt === null)).toBe(
      true,
    );

    // The down migrations removed everything, so each up migration applies cleanly again, and
    // reverting one step at a time also ends with an empty schema.
    for (const migration of MIGRATIONS) expect(await migrator.migrateUp()).toEqual([migration]);
    for (const migration of [...MIGRATIONS].reverse()) {
      expect(await migrator.migrateDown()).toEqual([migration]);
    }
    expect(await publicObjects(db)).toEqual([]);
  });

  it('serializes concurrent migrators so the schema is applied exactly once', async () => {
    const other = createDatabase({ connectionString: scratch.url, max: 2 });
    try {
      const results = await Promise.all([
        new SchemaMigrator(db).migrateToLatest(),
        new SchemaMigrator(other).migrateToLatest(),
      ]);
      expect(results.flat()).toEqual(MIGRATIONS);
    } finally {
      await other.destroy();
    }
  });

  describe('with a failing migration', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'listora-migrations-'));
      await writeFile(join(directory, '0001_good.up.sql'), 'create table good (id int);');
      await writeFile(join(directory, '0001_good.down.sql'), 'drop table good;');
      await writeFile(
        join(directory, '0002_bad.up.sql'),
        'create table half_done (id int);\nselect * from table_that_does_not_exist;',
      );
      await writeFile(join(directory, '0002_bad.down.sql'), 'drop table half_done;');
    });

    afterEach(async () => {
      await rm(directory, { recursive: true });
    });

    it('reports the failing migration and rolls the whole run back', async () => {
      const migrator = new SchemaMigrator(db, new SqlFileMigrationProvider(directory));

      const error = await migrator.migrateToLatest().then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).message).toMatch(
        /^migrate to latest failed in 0002_bad \(up\): relation "table_that_does_not_exist" does not exist/,
      );
      expect((error as MigrationError).results.map((result) => result.status)).toEqual([
        'Success',
        'Error',
      ]);

      // Transactional DDL: neither the earlier migration nor the partial one left anything.
      expect(await publicObjects(db)).toEqual([]);
      expect((await migrator.status()).map((migration) => migration.executedAt)).toEqual([
        null,
        null,
      ]);
    });
  });

  it('refuses to apply a migration that sorts before an applied one', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'listora-migrations-'));
    try {
      await writeFile(join(directory, '0002_later.up.sql'), 'create table later (id int);');
      await writeFile(join(directory, '0002_later.down.sql'), 'drop table later;');
      await new SchemaMigrator(db, new SqlFileMigrationProvider(directory)).migrateToLatest();

      await writeFile(join(directory, '0001_earlier.up.sql'), 'create table earlier (id int);');
      await writeFile(join(directory, '0001_earlier.down.sql'), 'drop table earlier;');
      await expect(
        new SchemaMigrator(db, new SqlFileMigrationProvider(directory)).migrateToLatest(),
      ).rejects.toThrow(MigrationError);
      expect(await tablesAndViews(db)).toEqual(['later']);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
