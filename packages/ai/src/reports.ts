import { sql } from 'kysely';

import type { AnalysisTier, DbExecutor } from '@listora/db';

import { PostgresUsageStore, utcMonthRange, type UsageTotals } from './usage-store.ts';

/** A UTC day (`YYYY-MM-DD`) or UTC calendar month (`YYYY-MM`) that a cost report covers. */
export type UsagePeriod =
  | { readonly kind: 'day'; readonly day: string }
  | { readonly kind: 'month'; readonly month: string };

/** The period's first day and the day after its last, as `YYYY-MM-DD`. */
export function usagePeriodRange(period: UsagePeriod): {
  readonly start: string;
  readonly end: string;
} {
  switch (period.kind) {
    case 'day': {
      const start = parseUtcDay(period.day);
      return { start: utcDay(start), end: utcDay(addDays(start, 1)) };
    }
    case 'month':
      return utcMonthRange(period.month);
  }
}

/** A `YYYY-MM-DD` calendar date as its UTC midnight; throws on anything else. */
export function parseUtcDay(day: string): Date {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T00:00:00Z`) : undefined;
  if (date === undefined || Number.isNaN(date.getTime()) || utcDay(date) !== day) {
    throw new RangeError(`day must be a calendar date as YYYY-MM-DD, got ${day}`);
  }
  return date;
}

export interface AccountSpend {
  readonly accountId: string;
  readonly accountName: string;
  readonly period: UsagePeriod;
  readonly totals: UsageTotals;
}

/**
 * One account's AI usage for a day (its `ai_usage_daily` row) or a month
 * (`UsageStore.monthlyUsage`); undefined when the account does not exist.
 */
export async function accountSpend(
  db: DbExecutor,
  accountId: string,
  period: UsagePeriod,
): Promise<AccountSpend | undefined> {
  const account = await db
    .selectFrom('account')
    .select('name')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (account === undefined) return undefined;
  const totals =
    period.kind === 'month'
      ? await new PostgresUsageStore(db).monthlyUsage(accountId, period.month)
      : await dayTotals(db, accountId, period.day);
  return { accountId, accountName: account.name, period, totals };
}

async function dayTotals(db: DbExecutor, accountId: string, day: string): Promise<UsageTotals> {
  const row = await db
    .selectFrom('ai_usage_daily')
    .select([
      'cost_micros as costMicros',
      'calls',
      'failed_calls as failedCalls',
      'input_tokens as inputTokens',
      'output_tokens as outputTokens',
      'cache_read_tokens as cacheReadTokens',
      'cache_write_tokens as cacheWriteTokens',
      'images',
      'web_searches as webSearches',
    ])
    .where('account_id', '=', accountId)
    .where('usage_date', '=', utcDay(parseUtcDay(day)))
    .executeTakeFirst();
  return (
    row ?? {
      costMicros: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 0,
      webSearches: 0,
    }
  );
}

export interface AccountSpendRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly costMicros: number;
  readonly calls: number;
  readonly failedCalls: number;
}

export interface TopAccountsReport {
  readonly period: UsagePeriod;
  /** Every account's usage in the period, not only the listed ones. */
  readonly total: {
    readonly costMicros: number;
    readonly calls: number;
    readonly failedCalls: number;
    readonly accounts: number;
  };
  /** The accounts that spent the most, highest first. */
  readonly accounts: readonly AccountSpendRow[];
}

/** The accounts with the highest AI spend in the period, from the daily rollups. */
export async function topAccountsBySpend(
  db: DbExecutor,
  period: UsagePeriod,
  limit: number,
): Promise<TopAccountsReport> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }
  const { start, end } = usagePeriodRange(period);
  const inPeriod = db
    .selectFrom('ai_usage_daily')
    .where('usage_date', '>=', start)
    .where('usage_date', '<', end);
  const total = await inPeriod
    .select([
      sum('cost_micros').as('costMicros'),
      sum('calls').as('calls'),
      sum('failed_calls').as('failedCalls'),
      sql<number>`count(distinct account_id)`.as('accounts'),
    ])
    .executeTakeFirstOrThrow();
  const accounts = await inPeriod
    .innerJoin('account', 'account.id', 'ai_usage_daily.account_id')
    .select([
      'ai_usage_daily.account_id as accountId',
      'account.name as accountName',
      sum('ai_usage_daily.cost_micros').as('costMicros'),
      sum('ai_usage_daily.calls').as('calls'),
      sum('ai_usage_daily.failed_calls').as('failedCalls'),
    ])
    .groupBy(['ai_usage_daily.account_id', 'account.name'])
    .orderBy('costMicros', 'desc')
    .orderBy('ai_usage_daily.account_id')
    .limit(limit)
    .execute();
  return { period, total, accounts };
}

export interface ItemCostReport {
  readonly period: UsagePeriod;
  /** Null for every account. */
  readonly accountId: string | null;
  /** Items that had at least one AI call in the period. */
  readonly items: number;
  /** What those items' calls cost, failed calls and escalations included. */
  readonly itemCostMicros: number;
  /** `itemCostMicros / items`, rounded to the nearest micro-dollar; null without items. */
  readonly averageItemCostMicros: number | null;
  readonly maxItemCostMicros: number;
  /** Calls with no item (for example after the item was deleted), and their cost. */
  readonly unattributedCalls: number;
  readonly unattributedCostMicros: number;
}

/**
 * What AI cost per item it worked on: every `ai_usage_event` in the period that names an
 * item, summed per item. An item's cost includes its failed calls and Premium escalations,
 * which is what the business pays to create it.
 */
export async function costPerItem(
  db: DbExecutor,
  period: UsagePeriod,
  options: { readonly accountId?: string } = {},
): Promise<ItemCostReport> {
  const events = eventsIn(db, period, options.accountId);
  const perItem = await db
    .selectFrom(
      events
        .select(['item_id', sum('cost_micros').as('cost')])
        .where('item_id', 'is not', null)
        .groupBy('item_id')
        .as('per_item'),
    )
    .select([
      sql<number>`count(*)`.as('items'),
      sum('cost').as('itemCostMicros'),
      sql<number>`coalesce(max(cost), 0)::bigint`.as('maxItemCostMicros'),
    ])
    .executeTakeFirstOrThrow();
  const unattributed = await events
    .select([sql<number>`count(*)`.as('calls'), sum('cost_micros').as('costMicros')])
    .where('item_id', 'is', null)
    .executeTakeFirstOrThrow();
  return {
    period,
    accountId: options.accountId ?? null,
    items: perItem.items,
    itemCostMicros: perItem.itemCostMicros,
    averageItemCostMicros:
      perItem.items === 0 ? null : Math.round(perItem.itemCostMicros / perItem.items),
    maxItemCostMicros: perItem.maxItemCostMicros,
    unattributedCalls: unattributed.calls,
    unattributedCostMicros: unattributed.costMicros,
  };
}

export interface SpendBreakdownRow {
  readonly purpose: string;
  readonly tier: AnalysisTier;
  readonly model: string;
  readonly calls: number;
  readonly failedCalls: number;
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** AI spend in the period by purpose, tier, and model, highest cost first. */
export async function spendBreakdown(
  db: DbExecutor,
  period: UsagePeriod,
  options: { readonly accountId?: string } = {},
): Promise<SpendBreakdownRow[]> {
  return eventsIn(db, period, options.accountId)
    .select([
      'purpose',
      'tier',
      'model',
      sql<number>`count(*)`.as('calls'),
      sql<number>`count(*) filter (where outcome = 'failed')`.as('failedCalls'),
      sum('cost_micros').as('costMicros'),
      sum('input_tokens').as('inputTokens'),
      sum('output_tokens').as('outputTokens'),
    ])
    .groupBy(['purpose', 'tier', 'model'])
    .orderBy('costMicros', 'desc')
    .orderBy('purpose')
    .orderBy('tier')
    .orderBy('model')
    .execute();
}

/** The period's usage events (UTC), for one account or all of them. */
function eventsIn(db: DbExecutor, period: UsagePeriod, accountId: string | undefined) {
  const { start, end } = usagePeriodRange(period);
  let query = db
    .selectFrom('ai_usage_event')
    .where('created_at', '>=', new Date(`${start}T00:00:00Z`))
    .where('created_at', '<', new Date(`${end}T00:00:00Z`));
  if (accountId !== undefined) query = query.where('account_id', '=', accountId);
  return query;
}

/** A column summed as a bigint (read as a number), zero over no rows. */
function sum(column: string) {
  return sql<number>`coalesce(sum(${sql.ref(column)}), 0)::bigint`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
