/**
 * Test-only helpers for this workspace's integration tests.
 */
import { CURRENT_PRICE_TABLE } from '@listora/ai';
import { createDatabase, migrateJobQueue, SchemaMigrator, type Db } from '@listora/db';
import { createLogger } from '@listora/shared';
import { createScratchDatabase } from '@listora/testing';

export interface TestDatabase {
  readonly db: Db;
  readonly url: string;
  close(): Promise<void>;
}

/** A scratch database with every migration applied, and the job queue (purges add jobs). */
export async function migratedDatabase(prefix: string): Promise<TestDatabase> {
  const scratch = await createScratchDatabase(prefix);
  const db = createDatabase({ connectionString: scratch.url, max: 3 });
  await new SchemaMigrator(db).migrateToLatest();
  await migrateJobQueue({
    connectionString: scratch.url,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  return {
    db,
    url: scratch.url,
    close: async () => {
      await db.destroy();
      await scratch.drop();
    },
  };
}

export async function insertAccount(db: Db, name: string): Promise<string> {
  const { id } = await db
    .insertInto('account')
    .values({ name, sku_prefix: 'AD' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

/** One metered AI call, filed by the trigger under the UTC day of `at`. */
export async function insertEvent(
  db: Db,
  event: {
    accountId: string;
    costMicros: number;
    at: string;
    itemId?: string;
    purpose?: string;
    failed?: boolean;
  },
): Promise<void> {
  await db
    .insertInto('ai_usage_event')
    .values({
      account_id: event.accountId,
      item_id: event.itemId ?? null,
      purpose: event.purpose ?? 'item_analysis',
      tier: 'standard',
      provider: 'fake',
      model: 'claude-haiku-5-5',
      input_tokens: 6_800,
      output_tokens: 1_500,
      images: 4,
      cost_micros: event.costMicros,
      price_table_version: CURRENT_PRICE_TABLE.version,
      outcome: event.failed === true ? 'failed' : 'succeeded',
      error_code: event.failed === true ? 'invalid_output' : null,
      created_at: new Date(event.at),
    })
    .execute();
}
