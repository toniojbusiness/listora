/**
 * Test-only helpers for this package's integration tests (not exported from the package).
 */
import { createDatabase, SchemaMigrator, type Db } from '@listora/db';
import { createScratchDatabase } from '@listora/testing';

import { CURRENT_PRICE_TABLE } from './prices.ts';

export interface TestDatabase {
  readonly db: Db;
  close(): Promise<void>;
}

/** A scratch database with every migration applied. */
export async function migratedDatabase(prefix: string): Promise<TestDatabase> {
  const scratch = await createScratchDatabase(prefix);
  const db = createDatabase({ connectionString: scratch.url, max: 5 });
  await new SchemaMigrator(db).migrateToLatest();
  return {
    db,
    close: async () => {
      await db.destroy();
      await scratch.drop();
    },
  };
}

export async function insertAccount(db: Db, name: string, skuPrefix = 'AI'): Promise<string> {
  const { id } = await db
    .insertInto('account')
    .values({ name, sku_prefix: skuPrefix })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

export interface TestEvent {
  readonly accountId: string;
  readonly costMicros: number;
  /** Defaults to now. The trigger files the event under this instant's UTC day. */
  readonly at?: Date | string;
  readonly itemId?: string;
  readonly purpose?: string;
  readonly tier?: 'standard' | 'premium';
  readonly model?: string;
  readonly failed?: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Inserts one `ai_usage_event`, as `UsageStore.record` would. */
export async function insertEvent(db: Db, event: TestEvent): Promise<void> {
  await db
    .insertInto('ai_usage_event')
    .values({
      account_id: event.accountId,
      item_id: event.itemId ?? null,
      purpose: event.purpose ?? 'item_analysis',
      tier: event.tier ?? 'standard',
      provider: 'fake',
      model: event.model ?? 'claude-haiku-5-5',
      input_tokens: event.inputTokens ?? 6_800,
      output_tokens: event.outputTokens ?? 1_500,
      images: 4,
      cost_micros: event.costMicros,
      price_table_version: CURRENT_PRICE_TABLE.version,
      outcome: event.failed === true ? 'failed' : 'succeeded',
      error_code: event.failed === true ? 'invalid_output' : null,
      ...(event.at === undefined ? {} : { created_at: new Date(event.at) }),
    })
    .execute();
}
