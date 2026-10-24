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

/** An account's AI usage summed over a period. */
export interface UsageTotals {
  /** Micro-dollars. */
  readonly costMicros: number;
  readonly calls: number;
  readonly failedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly images: number;
  readonly webSearches: number;
}

/**
 * Where metering lives. `record` must also add the event to the account's rollup for its UTC
 * day, atomically, because the daily budget guard reads that rollup. A billed call must
 * always be metered: `record` keeps the event, without the reference, when its item or user
 * was deleted while the call ran.
 */
export interface UsageStore {
  record(event: UsageEventInput): Promise<{ readonly id: string }>;
  /** What the account has spent on AI so far in the current UTC day, in micro-dollars. */
  spentTodayMicros(accountId: string): Promise<number>;
  /** The account's totals for a UTC calendar month, given as `YYYY-MM`. */
  monthlyUsage(accountId: string, month: string): Promise<UsageTotals>;
}

/** The first day of a `YYYY-MM` UTC month and of the month after it, as `YYYY-MM-DD`. */
export function utcMonthRange(month: string): { readonly start: string; readonly end: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new RangeError(`month must be YYYY-MM, got ${month}`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    start: utcDay(new Date(Date.UTC(year, monthIndex, 1))),
    end: utcDay(new Date(Date.UTC(year, monthIndex + 1, 1))),
  };
}

/**
 * The foreign keys that `on delete set null` would have cleared had the row existed before
 * the delete. The account reference is not among them: an event always has its account.
 */
const DELETABLE_REFERENCES = new Set([
  'ai_usage_event_account_id_item_id_fkey',
  'ai_usage_event_user_id_fkey',
]);

function isDeletedReference(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23503' &&
    'constraint' in error &&
    typeof error.constraint === 'string' &&
    DELETABLE_REFERENCES.has(error.constraint)
  );
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
    try {
      return await this.#inSavepoint(() => this.#insert(event, false));
    } catch (error) {
      if (!isDeletedReference(error)) throw error;
      // The item or user was deleted while the call ran. Retry once, keeping only the
      // references that still exist, as `on delete set null` does for older events.
      return this.#insert(event, true);
    }
  }

  async #insert(event: UsageEventInput, dropDeletedReferences: boolean): Promise<{ id: string }> {
    return this.#db
      .insertInto('ai_usage_event')
      .values((eb) => ({
        account_id: event.accountId,
        user_id:
          dropDeletedReferences && event.userId !== null
            ? eb.selectFrom('app_user').select('id').where('id', '=', event.userId)
            : event.userId,
        item_id:
          dropDeletedReferences && event.itemId !== null
            ? eb
                .selectFrom('inventory_item')
                .select('id')
                .where('account_id', '=', event.accountId)
                .where('id', '=', event.itemId)
            : event.itemId,
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
      }))
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  /** A failed statement aborts an open transaction; a savepoint keeps it usable for a retry. */
  async #inSavepoint<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#db.isTransaction) return work();
    await sql`savepoint ai_usage_event_record`.execute(this.#db);
    try {
      const result = await work();
      await sql`release savepoint ai_usage_event_record`.execute(this.#db);
      return result;
    } catch (error) {
      await sql`rollback to savepoint ai_usage_event_record`.execute(this.#db);
      throw error;
    }
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

  /**
   * Sums the month's `ai_usage_daily` rows. The table's primary key, (account_id, usage_date),
   * already serves this range scan, so it needs no index of its own.
   */
  async monthlyUsage(accountId: string, month: string): Promise<UsageTotals> {
    const { start, end } = utcMonthRange(month);
    const total = (column: string) => sql<number>`coalesce(sum(${sql.ref(column)}), 0)::bigint`;
    return this.#db
      .selectFrom('ai_usage_daily')
      .select([
        total('cost_micros').as('costMicros'),
        total('calls').as('calls'),
        total('failed_calls').as('failedCalls'),
        total('input_tokens').as('inputTokens'),
        total('output_tokens').as('outputTokens'),
        total('cache_read_tokens').as('cacheReadTokens'),
        total('cache_write_tokens').as('cacheWriteTokens'),
        total('images').as('images'),
        total('web_searches').as('webSearches'),
      ])
      .where('account_id', '=', accountId)
      .where('usage_date', '>=', start)
      .where('usage_date', '<', end)
      .executeTakeFirstOrThrow();
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

  monthlyUsage(accountId: string, month: string): Promise<UsageTotals> {
    const { start, end } = utcMonthRange(month);
    const totals = {
      costMicros: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 0,
      webSearches: 0,
    };
    for (const event of this.#events) {
      const day = utcDay(event.createdAt);
      if (event.accountId !== accountId || day < start || day >= end) continue;
      totals.costMicros += event.costMicros;
      totals.calls += 1;
      if (event.outcome === 'failed') totals.failedCalls += 1;
      totals.inputTokens += event.usage.inputTokens;
      totals.outputTokens += event.usage.outputTokens;
      totals.cacheReadTokens += event.usage.cacheReadTokens;
      totals.cacheWriteTokens += event.usage.cacheWriteTokens;
      totals.images += event.images;
      totals.webSearches += event.usage.webSearches;
    }
    return Promise.resolve(totals);
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
