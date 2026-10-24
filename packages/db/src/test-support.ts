/**
 * Test-only helpers for this package's integration tests (not exported from the package).
 */
import { expect } from 'vitest';

import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { createDatabase, type Db } from './database.ts';
import { SchemaMigrator } from './migrations.ts';

export interface MigratedDatabase {
  db: Db;
  scratch: ScratchDatabase;
  close(): Promise<void>;
}

/** A scratch database with every migration applied. */
export async function createMigratedDatabase(prefix: string, max = 5): Promise<MigratedDatabase> {
  const scratch = await createScratchDatabase(prefix);
  const db = createDatabase({ connectionString: scratch.url, max });
  try {
    await new SchemaMigrator(db).migrateToLatest();
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

/** Postgres SQLSTATE codes the constraint tests expect. */
export const PG_ERROR = {
  invalidTextRepresentation: '22P02',
  restrictViolation: '23001',
  notNullViolation: '23502',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;

/** Asserts that `work` fails with the given SQLSTATE and, when given, constraint name. */
export async function expectPgError(
  work: PromiseLike<unknown>,
  code: (typeof PG_ERROR)[keyof typeof PG_ERROR],
  constraint?: string,
): Promise<void> {
  const error = await Promise.resolve(work).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, 'expected the statement to fail').toBeDefined();
  expect(error).toMatchObject(constraint === undefined ? { code } : { code, constraint });
}
