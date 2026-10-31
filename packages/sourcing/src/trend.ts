import type { HistorySale } from './own-history.ts';

/** Which way similar items are selling, as far as the data says. */
export const TREND_DIRECTIONS = ['up', 'down', 'steady', 'unknown'] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

/** Recent sales are the last this many days; earlier ones the rest of the 365-day window. */
export const TREND_RECENT_DAYS = 90;
export const TREND_WINDOW_DAYS = 365;
/** Fewest sales on each side before a direction is named: fewer say nothing about a trend. */
export const TREND_MIN_RECENT = 3;
export const TREND_MIN_EARLIER = 2;
/** How much faster (or slower) recent sales must come than earlier ones to be called a trend. */
export const TREND_RATIO = 1.5;

/** Where a trend comes from: the household's own sales now; marketplace data with M3. */
export const TREND_SOURCES = ['own_history'] as const;
export type TrendSource = (typeof TREND_SOURCES)[number];

export interface SalesTrend {
  readonly source: TrendSource;
  readonly direction: TrendDirection;
  /** Sales in the last `TREND_RECENT_DAYS`, and in the rest of the window before them. */
  readonly recentSales: number;
  readonly earlierSales: number;
  /** Days since the latest one sold; absent with none. */
  readonly lastSoldDaysAgo?: number;
  /** "Trending up" or "Slowing", only when the data supports a direction. */
  readonly label?: string;
  /** What it rests on, as the seller reads it. */
  readonly basedOn: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How recently and how fast the household's own sales like an item came
 * (docs/features/thrift-scan.md, "Trend"): the sales per day of the last 90 days against the
 * 275 before them. Up only with at least 3 recent and 2 earlier sales and recent ones coming at
 * least 1.5 times as fast; down (slowing) with at least 3 earlier and recent ones at most
 * two-thirds as fast. Otherwise steady, or unknown with too few sales to say. Sales without a
 * sale time are left out.
 */
export function salesTrend(sales: readonly HistorySale[], now: Date): SalesTrend {
  const ages = sales
    .flatMap((sale) =>
      sale.soldAt === undefined ? [] : [(now.getTime() - sale.soldAt.getTime()) / DAY_MS],
    )
    .filter((age) => age >= 0 && age < TREND_WINDOW_DAYS);
  const recentSales = ages.filter((age) => age < TREND_RECENT_DAYS).length;
  const earlierSales = ages.length - recentSales;
  const lastSoldDaysAgo = ages.length === 0 ? undefined : Math.floor(Math.min(...ages));
  const recentRate = recentSales / TREND_RECENT_DAYS;
  const earlierRate = earlierSales / (TREND_WINDOW_DAYS - TREND_RECENT_DAYS);
  const direction: TrendDirection =
    recentSales >= TREND_MIN_RECENT &&
    earlierSales >= TREND_MIN_EARLIER &&
    recentRate >= TREND_RATIO * earlierRate
      ? 'up'
      : earlierSales >= TREND_MIN_RECENT && recentRate * TREND_RATIO <= earlierRate
        ? 'down'
        : recentSales + earlierSales >= TREND_MIN_RECENT
          ? 'steady'
          : 'unknown';
  const sold = (count: number) => (count === 1 ? '1 sale' : `${String(count)} sales`);
  return {
    source: 'own_history',
    direction,
    recentSales,
    earlierSales,
    ...(lastSoldDaysAgo === undefined ? {} : { lastSoldDaysAgo }),
    ...(direction === 'up'
      ? { label: 'Trending up' }
      : direction === 'down'
        ? { label: 'Slowing' }
        : {}),
    basedOn:
      `Your ${sold(recentSales)} like it in the last ${String(TREND_RECENT_DAYS)} days, ` +
      `${sold(earlierSales)} in the 9 months before`,
  };
}
