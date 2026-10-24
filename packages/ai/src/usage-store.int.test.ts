import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, createInventoryItem, SchemaMigrator, type Db } from '@listora/db';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { AiClient } from './client.ts';
import { AiCallError, AiGuardError } from './errors.ts';
import { FakeAiProvider, inMemoryFixtures } from './fake-provider.ts';
import { staticKillSwitch } from './guards.ts';
import { createModelRegistry } from './models.ts';
import { photoSetHashOfImages } from './photo-set-hash.ts';
import { CURRENT_PRICE_TABLE } from './prices.ts';
import { COLOR_OUTPUT, image } from './test-support.ts';
import { PostgresUsageStore, type UsageEventInput } from './usage-store.ts';

let scratch: ScratchDatabase;
let db: Db;
let accountId: string;

beforeAll(async () => {
  scratch = await createScratchDatabase('ai_usage');
  db = createDatabase({ connectionString: scratch.url, max: 5 });
  await new SchemaMigrator(db).migrateToLatest();
});

afterAll(async () => {
  await db.destroy();
  await scratch.drop();
});

beforeEach(async () => {
  ({ id: accountId } = await db
    .insertInto('account')
    .values({ name: 'AI test account', sku_prefix: 'AI' })
    .returning('id')
    .executeTakeFirstOrThrow());
});

function event(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    accountId,
    userId: null,
    itemId: null,
    purpose: 'item_analysis',
    tier: 'standard',
    provider: 'fake',
    model: 'claude-haiku-5-5',
    usage: {
      inputTokens: 6_800,
      outputTokens: 1_500,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      webSearches: 0,
    },
    images: 4,
    batch: false,
    costMicros: 1_430,
    priceTableVersion: CURRENT_PRICE_TABLE.version,
    latencyMs: 812,
    outcome: 'succeeded',
    errorCode: null,
    ...overrides,
  };
}

async function daily() {
  return db.selectFrom('ai_usage_daily').selectAll().where('account_id', '=', accountId).execute();
}

describe('PostgresUsageStore (real Postgres)', () => {
  it('writes every column of the usage event', async () => {
    const store = new PostgresUsageStore(db);
    const item = await createInventoryItem(db, accountId);
    const { id } = await store.record(event({ itemId: item.id, batch: true }));
    const row = await db
      .selectFrom('ai_usage_event')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      account_id: accountId,
      item_id: item.id,
      purpose: 'item_analysis',
      tier: 'standard',
      provider: 'fake',
      model: 'claude-haiku-5-5',
      input_tokens: 6_800,
      output_tokens: 1_500,
      cache_read_tokens: 100,
      cache_write_tokens: 50,
      images: 4,
      web_searches: 0,
      batch: true,
      cost_micros: 1_430,
      price_table_version: CURRENT_PRICE_TABLE.version,
      latency_ms: 812,
      outcome: 'succeeded',
      error_code: null,
    });
  });

  it('keeps the daily rollup in step with the events, failed calls included', async () => {
    const store = new PostgresUsageStore(db);
    await store.record(event());
    await store.record(event({ outcome: 'failed', errorCode: 'truncated', costMicros: 4_680 }));
    await store.record(event({ usage: { ...event().usage, webSearches: 2 }, costMicros: 21_430 }));

    const today = await sql<{
      today: string;
    }>`select (now() at time zone 'UTC')::date::text as today`.execute(db);
    expect(await daily()).toEqual([
      expect.objectContaining({
        usage_date: today.rows[0]?.today,
        calls: 3,
        failed_calls: 1,
        input_tokens: 20_400,
        output_tokens: 4_500,
        cache_read_tokens: 300,
        cache_write_tokens: 150,
        images: 12,
        web_searches: 2,
        cost_micros: 27_540,
      }),
    ]);
    expect(await store.spentTodayMicros(accountId)).toBe(27_540);
  });

  it('rolls events up by their UTC day', async () => {
    const store = new PostgresUsageStore(db);
    await store.record(event());
    // Insert an event dated yesterday directly; the trigger files it under that day.
    await db
      .insertInto('ai_usage_event')
      .values({
        account_id: accountId,
        purpose: 'item_analysis',
        tier: 'standard',
        provider: 'fake',
        model: 'claude-haiku-5-5',
        cost_micros: 999,
        price_table_version: CURRENT_PRICE_TABLE.version,
        outcome: 'succeeded',
        created_at: sql<Date>`now() - interval '1 day'`,
      })
      .execute();
    expect((await daily()).map((row) => row.cost_micros).sort()).toEqual([1_430, 999].sort());
    expect(await store.spentTodayMicros(accountId)).toBe(1_430);
  });

  it('reports zero spend for an account with no usage today', async () => {
    expect(await new PostgresUsageStore(db).spentTodayMicros(accountId)).toBe(0);
  });

  it('is append-only: events cannot be updated or deleted directly', async () => {
    const { id } = await new PostgresUsageStore(db).record(event());
    await expect(
      db.updateTable('ai_usage_event').set({ cost_micros: 0 }).where('id', '=', id).execute(),
    ).rejects.toThrow();
    await expect(db.deleteFrom('ai_usage_event').where('id', '=', id).execute()).rejects.toThrow();
  });

  it('keeps the event when its item is deleted, and deletes it with the account', async () => {
    const store = new PostgresUsageStore(db);
    const item = await createInventoryItem(db, accountId);
    const { id } = await store.record(event({ itemId: item.id }));
    await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();
    const kept = await db
      .selectFrom('ai_usage_event')
      .select(['item_id', 'cost_micros'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(kept).toEqual({ item_id: null, cost_micros: 1_430 });

    await db.deleteFrom('account').where('id', '=', accountId).execute();
    expect(
      await db.selectFrom('ai_usage_event').select('id').where('id', '=', id).execute(),
    ).toEqual([]);
    expect(await daily()).toEqual([]);
  });

  it('rejects a failed event without an error code, and a success with one', async () => {
    const store = new PostgresUsageStore(db);
    await expect(store.record(event({ outcome: 'failed', errorCode: null }))).rejects.toMatchObject(
      {
        constraint: 'ai_usage_event_failed_has_error_code',
      },
    );
    await expect(store.record(event({ errorCode: 'truncated' }))).rejects.toMatchObject({
      constraint: 'ai_usage_event_failed_has_error_code',
    });
  });

  it('counts concurrent events exactly once each in the rollup', async () => {
    const store = new PostgresUsageStore(db);
    await Promise.all(Array.from({ length: 20 }, () => store.record(event())));
    expect(await daily()).toEqual([expect.objectContaining({ calls: 20, cost_micros: 28_600 })]);
  });
});

describe('AiClient with Postgres metering', () => {
  const photos = [image('front'), image('back')];
  const fixtures = inMemoryFixtures({
    [photoSetHashOfImages(photos)]: {
      outputs: { dominant_color: { color: 'navy', confidence: 0.9 } },
      usage: { inputTokens: 6_800, outputTokens: 1_500 },
    },
    [photoSetHashOfImages([image('broken')])]: {
      error: { code: 'invalid_output' },
      usage: { inputTokens: 6_800, outputTokens: 1_500 },
    },
  });

  function client(dailyBudgetMicros: number): AiClient {
    return new AiClient({
      provider: new FakeAiProvider({ fixtures }),
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: new PostgresUsageStore(db),
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros,
    });
  }

  const call = (images = photos) => ({
    context: { accountId, purpose: 'item_analysis' },
    tier: 'standard' as const,
    system: 'Name the dominant color.',
    prompt: 'Answer in JSON.',
    images,
    output: COLOR_OUTPUT,
  });

  it('meters successes and failures and trips the breaker at the cap', async () => {
    const ai = client(2 * 1_430);
    await ai.generate(call());
    await expect(ai.generate(call([image('broken')]))).rejects.toBeInstanceOf(AiCallError);
    // Spend is now exactly the cap, so the next call is refused and nothing is recorded.
    await expect(ai.generate(call())).rejects.toBeInstanceOf(AiGuardError);

    const events = await db
      .selectFrom('ai_usage_event')
      .select(['outcome', 'error_code', 'cost_micros'])
      .where('account_id', '=', accountId)
      .orderBy('id')
      .execute();
    expect(events).toEqual([
      { outcome: 'succeeded', error_code: null, cost_micros: 1_430 },
      { outcome: 'failed', error_code: 'invalid_output', cost_micros: 1_430 },
    ]);
    expect(await daily()).toEqual([
      expect.objectContaining({ calls: 2, failed_calls: 1, cost_micros: 2_860 }),
    ]);
  });
});
