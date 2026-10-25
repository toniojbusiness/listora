import { sql } from 'kysely';

import type { DbExecutor } from '@listora/db';

import {
  QUOTA_METRICS,
  type QuotaContext,
  type QuotaDecision,
  type QuotaMetric,
  type QuotaPolicy,
} from './guards.ts';

/** The quota period a moment falls in: `[start, end)` as `YYYY-MM-DD` dates. */
export interface QuotaPeriod {
  readonly start: string;
  readonly end: string;
}

/** The UTC calendar month of `now`, the default quota period until billing periods exist. */
export function utcMonthPeriod(now: Date): QuotaPeriod {
  const day = (date: Date): string => date.toISOString().slice(0, 10);
  return {
    start: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
    end: day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))),
  };
}

/** One quota's use in a period; `limit` null means unlimited. */
export interface QuotaUse {
  readonly metric: QuotaMetric;
  readonly used: number;
  readonly limit: number | null;
}

/** Every quota's use in the current period, in `QUOTA_METRICS` order. */
export interface AccountQuotaUsage {
  readonly period: QuotaPeriod;
  readonly quotas: readonly QuotaUse[];
}

export interface PostgresQuotaPolicyOptions {
  /** The period a moment counts toward; the UTC calendar month by default. */
  readonly period?: (now: Date) => QuotaPeriod;
  readonly now?: () => Date;
}

/**
 * Plan quotas counted in `usage_counter`: one row per account, metric (reseller unit, for
 * example `premium_identifications`), and period. `used` counts the units successful calls
 * used up; `quota` is the plan's limit for the period, and null (or no row) means unlimited.
 * Billing entitlements (plan task T-28) set `quota`; this policy counts and enforces it.
 *
 * `check` and `consume` are separate steps around the call (see `QuotaPolicy`), so calls that
 * are checked at the same moment can each finish and go over the limit by those calls.
 */
export class PostgresQuotaPolicy implements QuotaPolicy {
  readonly #db: DbExecutor;
  readonly #period: (now: Date) => QuotaPeriod;
  readonly #now: () => Date;

  constructor(db: DbExecutor, options: PostgresQuotaPolicyOptions = {}) {
    this.#db = db;
    this.#period = options.period ?? utcMonthPeriod;
    this.#now = options.now ?? (() => new Date());
  }

  async check(context: QuotaContext): Promise<QuotaDecision> {
    const period = this.#period(this.#now());
    const row = await this.#db
      .selectFrom('usage_counter')
      .select(['used', 'quota'])
      .where('account_id', '=', context.accountId)
      .where('metric', '=', context.charge.metric)
      .where('period_start', '=', period.start)
      .executeTakeFirst();
    if (row === undefined || row.quota === null) return { allowed: true };
    if (row.used + context.charge.units > row.quota) {
      return { allowed: false, used: row.used, limit: row.quota };
    }
    return { allowed: true };
  }

  async consume(context: QuotaContext): Promise<void> {
    const period = this.#period(this.#now());
    await this.#db
      .insertInto('usage_counter')
      .values({
        account_id: context.accountId,
        metric: context.charge.metric,
        period_start: period.start,
        period_end: period.end,
        used: context.charge.units,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['account_id', 'metric', 'period_start'])
          .doUpdateSet({ used: sql<number>`usage_counter.used + excluded.used` }),
      )
      .execute();
  }

  /** Units used in the current period (0 when nothing was counted yet). */
  async used(accountId: string, metric: QuotaContext['charge']['metric']): Promise<number> {
    const period = this.#period(this.#now());
    const row = await this.#db
      .selectFrom('usage_counter')
      .select('used')
      .where('account_id', '=', accountId)
      .where('metric', '=', metric)
      .where('period_start', '=', period.start)
      .executeTakeFirst();
    return row?.used ?? 0;
  }

  /** Every quota's use in the current period; a metric with no row is unused and unlimited. */
  async usage(accountId: string): Promise<AccountQuotaUsage> {
    const period = this.#period(this.#now());
    const rows = await this.#db
      .selectFrom('usage_counter')
      .select(['metric', 'used', 'quota'])
      .where('account_id', '=', accountId)
      .where('metric', 'in', QUOTA_METRICS)
      .where('period_start', '=', period.start)
      .execute();
    const byMetric = new Map(rows.map((row) => [row.metric, row]));
    return {
      period,
      quotas: QUOTA_METRICS.map((metric) => {
        const row = byMetric.get(metric);
        return { metric, used: row?.used ?? 0, limit: row?.quota ?? null };
      }),
    };
  }
}
