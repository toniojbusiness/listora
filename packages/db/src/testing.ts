/**
 * Integration-test helpers for other workspaces, imported as `@listora/db/testing`. Never
 * imported by runtime code. Helpers that depend on Vitest stay in test-support.ts.
 */
import { createLogger } from '@listora/shared';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { createDatabase, type Db } from './database.ts';
import { migrateJobQueue } from './job-queue.ts';
import { SchemaMigrator } from './migrations.ts';

export interface MigratedDatabase {
  db: Db;
  scratch: ScratchDatabase;
  close(): Promise<void>;
}

export interface MigratedDatabaseOptions {
  /** Pool size of `db` (default 5). */
  max?: number;
  /** Also install the job queue schema, for tests that enqueue or run jobs. */
  jobQueue?: boolean;
}

/** A scratch database with every migration applied. Always `close()` it in teardown. */
export async function createMigratedDatabase(
  prefix: string,
  options: MigratedDatabaseOptions = {},
): Promise<MigratedDatabase> {
  const scratch = await createScratchDatabase(prefix);
  const db = createDatabase({ connectionString: scratch.url, max: options.max ?? 5 });
  try {
    await new SchemaMigrator(db).migrateToLatest();
    if (options.jobQueue === true) {
      await migrateJobQueue({
        connectionString: scratch.url,
        logger: createLogger({ service: 'test', level: 'silent' }),
      });
    }
  } catch (error) {
    await db.destroy();
    await scratch.drop();
    throw error;
  }
  return {
    db,
    scratch,
    close: async () => {
      await db.destroy();
      await scratch.drop();
    },
  };
}

export async function insertAccount(
  db: Db,
  skuPrefix = 'AJ',
  name = 'Test account',
): Promise<string> {
  const { id } = await db
    .insertInto('account')
    .values({ name, sku_prefix: skuPrefix })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}
