import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDatabase,
  createInventoryItem,
  inTransaction,
  SchemaMigrator,
  type Db,
} from '@listora/db';
import { createScratchDatabase, type ScratchDatabase } from '@listora/testing';

import { AiClient } from './client.ts';
import { AiCallError, AiGuardError } from './errors.ts';
import { FakeAiProvider, inMemoryFixtures } from './fake-provider.ts';
import { staticKillSwitch } from './guards.ts';
import { createModelRegistry } from './models.ts';
import { photoSetHashOfImages } from './photo-set-hash.ts';
import { CURRENT_PRICE_TABLE } from './prices.ts';
import type { AiProvider } from './provider.ts';
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

async function createUser(subject: string): Promise<string> {
  const { id } = await db
    .insertInto('app_user')
    .values({ auth_provider: 'dev', auth_subject: `${subject}-${accountId}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return id;
}

async function storedEvent(id: string) {
  return db
    .selectFrom('ai_usage_event')
    .select(['account_id', 'user_id', 'item_id', 'cost_micros'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** Inserts an event created at `createdAt`; the trigger files it under that UTC day. */
async function insertEventAt(createdAt: string, costMicros: number, failed = false) {
  await db
    .insertInto('ai_usage_event')
    .values({
      account_id: accountId,
      purpose: 'item_analysis',
      tier: 'standard',
      provider: 'fake',
      model: 'claude-haiku-5-5',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      images: 2,
      web_searches: 1,
      cost_micros: costMicros,
      price_table_version: CURRENT_PRICE_TABLE.version,
      outcome: failed ? 'failed' : 'succeeded',
      error_code: failed ? 'truncated' : null,
      created_at: new Date(createdAt),
    })
    .execute();
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

  it('still meters an event whose item and user were deleted before it was recorded', async () => {
    const store = new PostgresUsageStore(db);
    const item = await createInventoryItem(db, accountId);
    const userId = await createUser('deleted');
    await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();
    await db.deleteFrom('app_user').where('id', '=', userId).execute();

    const { id } = await store.record(event({ itemId: item.id, userId }));
    expect(await storedEvent(id)).toEqual({
      account_id: accountId,
      user_id: null,
      item_id: null,
      cost_micros: 1_430,
    });
    expect(await daily()).toEqual([expect.objectContaining({ calls: 1, cost_micros: 1_430 })]);
  });

  it('keeps the references that still exist when only one was deleted', async () => {
    const store = new PostgresUsageStore(db);
    const item = await createInventoryItem(db, accountId);
    const userId = await createUser('kept');
    await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();

    const { id } = await store.record(event({ itemId: item.id, userId }));
    expect(await storedEvent(id)).toMatchObject({ user_id: userId, item_id: null });
  });

  it('retries inside a caller transaction without aborting it', async () => {
    const store = new PostgresUsageStore(db);
    const item = await createInventoryItem(db, accountId);
    await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();

    const ids = await inTransaction(db, async (trx) => {
      const transactional = new PostgresUsageStore(trx);
      const first = await transactional.record(event({ itemId: item.id }));
      const second = await transactional.record(event());
      return [first.id, second.id];
    });
    expect(ids).toHaveLength(2);
    expect(await daily()).toEqual([expect.objectContaining({ calls: 2, cost_micros: 2_860 })]);
    expect(await store.spentTodayMicros(accountId)).toBe(2_860);
  });

  it('still enforces the account reference', async () => {
    await expect(
      new PostgresUsageStore(db).record(
        event({ accountId: '00000000-0000-7000-8000-000000000000' }),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'ai_usage_event_account_id_fkey' });
  });

  it('sums a UTC calendar month from the daily rollup, boundaries included', async () => {
    const store = new PostgresUsageStore(db);
    await insertEventAt('2026-09-30T23:59:59.999Z', 1);
    await insertEventAt('2026-10-01T00:00:00.000Z', 100);
    await insertEventAt('2026-10-15T12:00:00.000Z', 200, true);
    await insertEventAt('2026-10-31T23:59:59.999Z', 300);
    await insertEventAt('2026-11-01T00:00:00.000Z', 2);

    expect(await store.monthlyUsage(accountId, '2026-10')).toEqual({
      costMicros: 600,
      calls: 3,
      failedCalls: 1,
      inputTokens: 30,
      outputTokens: 60,
      cacheReadTokens: 9,
      cacheWriteTokens: 12,
      images: 6,
      webSearches: 3,
    });
    expect((await store.monthlyUsage(accountId, '2026-09')).costMicros).toBe(1);
    expect((await store.monthlyUsage(accountId, '2026-11')).costMicros).toBe(2);
    expect(await store.monthlyUsage(accountId, '2026-08')).toEqual({
      costMicros: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 0,
      webSearches: 0,
    });
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
    photoSetHash: photoSetHashOfImages(images),
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

  it('meters a billed call whose item is deleted while the call runs', async () => {
    const item = await createInventoryItem(db, accountId);
    const fake = new FakeAiProvider({ fixtures });
    const deletingProvider: AiProvider = {
      id: fake.id,
      generate: async (request) => {
        const response = await fake.generate(request);
        await db.deleteFrom('inventory_item').where('id', '=', item.id).execute();
        return response;
      },
    };
    const ai = new AiClient({
      provider: deletingProvider,
      registry: createModelRegistry({}, CURRENT_PRICE_TABLE),
      usageStore: new PostgresUsageStore(db),
      killSwitch: staticKillSwitch(false),
      dailyBudgetMicros: 1_000_000,
    });

    const result = await ai.generate({
      ...call(),
      context: { ...call().context, itemId: item.id },
    });
    expect(await storedEvent(result.usageEventId)).toEqual({
      account_id: accountId,
      user_id: null,
      item_id: null,
      cost_micros: 1_430,
    });
    expect(await daily()).toEqual([expect.objectContaining({ calls: 1, cost_micros: 1_430 })]);
  });
});
