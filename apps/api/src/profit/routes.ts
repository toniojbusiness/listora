import type { DeadStockItem, Money, ProfitGroup, ProfitReport } from '@listora/api-contract';
import {
  MAX_PROFIT_PERIOD_DAYS,
  periodDays,
  profitReport,
  type ProfitGroup as Group,
  type ProfitTotals,
} from '@listora/sales';
import type { FastifyInstance } from 'fastify';

import { contractRoute } from '../contract/routes.ts';
import { validationFailed } from '../errors.ts';
import type { ApiRouteContext } from '../features.ts';
import {
  deadStockRows,
  feeRows,
  listedItemCount,
  soldItemRows,
  type DeadStockItemRow,
  type DeadStockTotals,
  type ProfitPeriodQuery,
} from './repository.ts';

/** How many of the oldest dead-stock items the report lists. */
const DEAD_STOCK_LIST_SIZE = 5;

/**
 * `getProfit`: the profit dashboard for a period of days in the seller's time zone, from the
 * sales' fee lines and the items' costs (`profitReport` in @listora/sales); see
 * docs/features/profit.md. It reads only Listora's own rows: no marketplace or AI call.
 */
export function registerProfitRoutes(app: FastifyInstance, deps: ApiRouteContext): void {
  contractRoute(app, deps, 'getProfit', async ({ tenant, db, query }) => {
    const period = checkedPeriod(query);
    const [items, fees, listedItems, deadStock] = await Promise.all([
      soldItemRows(db, tenant, period),
      feeRows(db, tenant, period),
      listedItemCount(db, tenant, period),
      deadStockRows(db, tenant, {
        today: dayIn(period.timeZone, deps.now()),
        timeZone: period.timeZone,
        limit: DEAD_STOCK_LIST_SIZE,
      }),
    ]);
    const report = profitReport({ period, items, fees, listedItems });
    const { summary } = report;
    const body: ProfitReport = {
      period: {
        from: period.from,
        to: period.to,
        timeZone: period.timeZone,
        granularity: report.granularity,
      },
      summary: {
        ...totalsView(summary),
        ...optional('roiBasisPoints', summary.roiBasisPoints),
        missingCostCount: summary.missingCostCount,
        ...optional('averageSalePrice', moneyOrNull(summary.averageSalePriceCents)),
        ...optional('averageProfitPerItem', moneyOrNull(summary.averageProfitPerItemCents)),
        ...optional('averageDaysToSell', summary.averageDaysToSell),
        ...optional('sellThroughBasisPoints', summary.sellThroughBasisPoints),
        feesEstimated: summary.feesEstimated,
      },
      series: report.series.map((bucket) => ({
        start: bucket.start,
        revenue: money(bucket.revenueCents),
        netProfit: money(bucket.netProfitCents),
        itemsSold: bucket.itemsSold,
      })),
      marketplaces: report.marketplaces.map((row) => ({
        marketplace: row.marketplace,
        ...totalsView(row),
      })),
      brands: {
        best: report.brands.best.map(groupView),
        worst: report.brands.worst.map(groupView),
      },
      categories: {
        best: report.categories.best.map(groupView),
        worst: report.categories.worst.map(groupView),
      },
      deadStock: {
        over60Days: deadStockBucketView(deadStock.over60Days),
        over90Days: deadStockBucketView(deadStock.over90Days),
        oldest: deadStock.oldest.map(deadStockItemView),
      },
    };
    return { status: 200, body };
  });
}

/** The query's period, or `422` for an empty, too long, or unknown-zone one. */
function checkedPeriod(query: { from: string; to: string; timeZone: string }): ProfitPeriodQuery {
  if (!isTimeZone(query.timeZone)) {
    throw validationFailed(
      [{ field: 'timeZone', message: 'must be an IANA time zone, for example America/New_York' }],
      'The time zone is not known.',
    );
  }
  if (query.to < query.from) {
    throw validationFailed(
      [{ field: 'to', message: 'must not be before from' }],
      'The period ends before it starts.',
    );
  }
  if (periodDays(query) > MAX_PROFIT_PERIOD_DAYS) {
    throw validationFailed(
      [
        {
          field: 'to',
          message: `the period must be at most ${String(MAX_PROFIT_PERIOD_DAYS)} days`,
        },
      ],
      'The period is too long.',
    );
  }
  return { from: query.from, to: query.to, timeZone: query.timeZone };
}

/** Whether the runtime knows the zone; Postgres and Node both use the IANA database. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The day `at` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function dayIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function totalsView(totals: ProfitTotals) {
  return {
    salesCount: totals.salesCount,
    itemsSold: totals.itemsSold,
    revenue: money(totals.revenueCents),
    fees: money(totals.feesCents),
    shipping: money(totals.shippingCents),
    costOfGoods: money(totals.costOfGoodsCents),
    netProfit: money(totals.netProfitCents),
  };
}

function groupView(group: Group): ProfitGroup {
  return {
    key: group.key,
    itemsSold: group.itemsSold,
    revenue: money(group.revenueCents),
    netProfit: money(group.netProfitCents),
    ...optional('roiBasisPoints', group.roiBasisPoints),
    averageDaysToSell: group.averageDaysToSell,
  };
}

function deadStockBucketView(totals: DeadStockTotals) {
  return {
    itemCount: totals.itemCount,
    cost: money(totals.costCents),
    missingCostCount: totals.missingCostCount,
  };
}

function deadStockItemView(row: DeadStockItemRow): DeadStockItem {
  return {
    itemId: row.id,
    sku: row.sku,
    ...optional('title', row.title),
    ageDays: row.ageDays,
    ...optional('cost', moneyOrNull(row.costCents)),
    status: row.status,
  };
}

function money(amountCents: number): Money {
  return { amountCents, currency: 'USD' };
}

function moneyOrNull(amountCents: number | null): Money | null {
  return amountCents === null ? null : money(amountCents);
}

/** `{ [key]: value }`, or nothing for null: the contract omits a value it does not have. */
function optional<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>;
}
