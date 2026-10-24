import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { AiUsageOutcome, DbExecutor } from '@listora/db';

import type { AiErrorCode } from './errors.ts';
import type { AiProviderId, AiTier, TokenUsage } from './types.ts';

/** One metered provider call, as written to `ai_usage_event`. */
export interface UsageEventInput {
  readonly accountId: string;
  readonly userId: string | null;
  readonly itemId: string | null;
  readonly purpose: string;
  readonly tier: AiTier;
  readonly provider: AiProviderId;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly images: number;
  readonly batch: boolean;
  readonly costMicros: number;
  readonly priceTableVersion: string;
  readonly latencyMs: number;
  readonly outcome: AiUsageOutcome;
  /** Set exactly when `outcome` is `failed`. */
  readonly errorCode: AiErrorCode | null;
}

/**
 * Where metering lives. `record` must also add the event to the account's rollup for its UTC
 * day, atomically, because the daily budget guard reads that rollup.
 */
export interface UsageStore {
  record(event: UsageEventInput): Promise<{ readonly id: string }>;
  /** What the account has spent on AI so far in the current UTC day, in micro-dollars. */
  spentTodayMicros(accountId: string): Promise<number>;
}

/**
 * The production store. The insert's trigger maintains `ai_usage_daily` in the same
 * statement, and both "today"s are the database clock's UTC date, so the guard and the
 * rollup always agree on the day.
 */
export class PostgresUsageStore implements UsageStore {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async record(event: UsageEventInput): Promise<{ id: string }> {
    return this.#db
      .insertInto('ai_usage_event')
      .values({
        account_id: event.accountId,
        user_id: event.userId,
        item_id: event.itemId,
        purpose: event.purpose,
        tier: event.tier,
        provider: event.provider,
        model: event.model,
        input_tokens: event.usage.inputTokens,
        output_tokens: event.usage.outputTokens,
        cache_read_tokens: event.usage.cacheReadTokens,
        cache_write_tokens: event.usage.cacheWriteTokens,
        images: event.images,
        web_searches: event.usage.webSearches,
        batch: event.batch,
        cost_micros: event.costMicros,
        price_table_version: event.priceTableVersion,
        latency_ms: event.latencyMs,
        outcome: event.outcome,
        error_code: event.errorCode,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async spentTodayMicros(accountId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('ai_usage_daily')
      .select('cost_micros')
      .where('account_id', '=', accountId)
      .where('usage_date', '=', sql<string>`(now() at time zone 'UTC')::date`)
      .executeTakeFirst();
    return row?.cost_micros ?? 0;
  }
}

/**
 * Keeps events in memory, for tests and for tools that run without a database (the eval
 * harness). Days are UTC days of the injected clock.
 */
export class InMemoryUsageStore implements UsageStore {
  readonly #events: (UsageEventInput & { readonly id: string; readonly createdAt: Date })[] = [];
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  get events(): readonly (UsageEventInput & { readonly id: string; readonly createdAt: Date })[] {
    return this.#events;
  }

  record(event: UsageEventInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.#events.push({ ...event, id, createdAt: this.#now() });
    return Promise.resolve({ id });
  }

  spentTodayMicros(accountId: string): Promise<number> {
    const today = utcDay(this.#now());
    return Promise.resolve(
      this.#events
        .filter((event) => event.accountId === accountId && utcDay(event.createdAt) === today)
        .reduce((sum, event) => sum + event.costMicros, 0),
    );
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
