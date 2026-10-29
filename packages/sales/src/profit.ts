/**
 * The profit dashboard's numbers (docs/features/profit.md): a period's totals, its series, the
 * seller's own totals per marketplace, and the best and worst brands and categories, from one
 * row per sold item and the period's fee lines summed per sale. Pure, in integer cents.
 *
 * - **Same money as the sale screen.** Each item's share of its order's shipping charged,
 *   order-level fees, and shipping cost is split by sale price with `splitByWeight`, exactly as
 *   `saleMoney` splits them, so an item's profit here equals its `Sale` profit to the cent and
 *   the totals equal the sum of the sales'.
 * - **The lines add up.** Revenue is the sale prices plus the shipping buyers paid; fees are
 *   every fee line but shipping labels; shipping is the labels the marketplace deducted plus
 *   the labels bought outside the payout; net profit is revenue minus fees, shipping, and cost
 *   of goods. An item without a cost counts as zero cost, and `missingCostCount` says how many.
 * - **Marketplaces side by side, never ranked.** They come in the fixed `MARKETPLACES` order
 *   with totals only: eBay's API License Agreement forbids presenting eBay's performance
 *   relative to another service's without eBay's consent.
 * - **Days.** Every date is a `YYYY-MM-DD` day in the seller's time zone; the caller converts.
 */
import { MARKETPLACES, type Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';

import { splitByWeight } from './money.ts';

/** One sold item of a sale that stands, with its order's amounts. */
export interface ProfitItemRow {
  saleId: string;
  marketplace: Marketplace;
  /** The day it sold, in the seller's time zone. */
  soldOn: string;
  shippingChargedCents: number;
  /** What the seller paid to ship outside the payout; null until known. */
  shippingCostCents: number | null;
  saleItemId: string;
  salePriceCents: number;
  costCents: number | null;
  brand: string | null;
  category: string | null;
  /** From the item's first listing (or, never listed, from when it was added) to the sale. */
  daysToSell: number;
}

/** The sum of a sale's fee lines of one kind, charged on one item or on the order. */
export interface ProfitFeeRow {
  saleId: string;
  /** Null for an order-level fee. */
  saleItemId: string | null;
  /** A `shipping_label` line: shipping, not a fee. */
  shippingLabel: boolean;
  amountCents: number;
  /** True when any of the summed lines is an estimate. */
  estimated: boolean;
}

export const PROFIT_GRANULARITIES = ['day', 'week', 'month'] as const;
export type ProfitGranularity = (typeof PROFIT_GRANULARITIES)[number];

/** The longest period a report covers, in days (about ten years of monthly buckets). */
export const MAX_PROFIT_PERIOD_DAYS = 3660;
/** How many brands or categories each of `best` and `worst` lists. */
export const PROFIT_RANKING_SIZE = 5;

export interface ProfitPeriodDays {
  /** First day, inclusive. */
  from: string;
  /** Last day, inclusive. */
  to: string;
}

export interface ProfitTotals {
  revenueCents: number;
  feesCents: number;
  shippingCents: number;
  costOfGoodsCents: number;
  netProfitCents: number;
  salesCount: number;
  itemsSold: number;
}

export interface ProfitSummary extends ProfitTotals {
  roiBasisPoints: number | null;
  missingCostCount: number;
  averageSalePriceCents: number | null;
  averageProfitPerItemCents: number | null;
  averageDaysToSell: number | null;
  sellThroughBasisPoints: number | null;
  feesEstimated: boolean;
}

export interface ProfitBucket {
  start: string;
  revenueCents: number;
  netProfitCents: number;
  itemsSold: number;
}

export interface MarketplaceProfit extends ProfitTotals {
  marketplace: Marketplace;
}

export interface ProfitGroup {
  key: string;
  itemsSold: number;
  revenueCents: number;
  netProfitCents: number;
  roiBasisPoints: number | null;
  averageDaysToSell: number;
}

export interface ProfitRanking {
  best: ProfitGroup[];
  worst: ProfitGroup[];
}

export interface ProfitReport {
  granularity: ProfitGranularity;
  summary: ProfitSummary;
  series: ProfitBucket[];
  marketplaces: MarketplaceProfit[];
  brands: ProfitRanking;
  categories: ProfitRanking;
}

export interface ProfitReportInput {
  period: ProfitPeriodDays;
  items: readonly ProfitItemRow[];
  fees: readonly ProfitFeeRow[];
  /** Items listed now that were added by the period's end (sell-through's unsold side). */
  listedItems: number;
}

/** One sold item's money: its share of its order's amounts. */
export interface SoldItemMoney<Row extends ProfitItemRow = ProfitItemRow> {
  row: Row;
  revenueCents: number;
  feesCents: number;
  shippingCents: number;
  /** The item's cost, zero without one (`row.costCents` is then null). */
  costOfGoodsCents: number;
  netProfitCents: number;
  /**
   * Where its sale's fees come from: the marketplace (`actual`), still the fee table's estimate
   * (`estimated`), or no fee line at all (`none`, so the fees are not known).
   */
  feeSource: SoldItemFeeSource;
}

export type SoldItemFeeSource = 'actual' | 'estimated' | 'none';

export function profitReport(input: ProfitReportInput): ProfitReport {
  const granularity = profitGranularity(input.period);
  const items = soldItemMoney(input.items, input.fees);
  const sold = input.items.length;

  const totals = sumTotals(items);
  const priceTotal = sum(input.items.map((row) => row.salePriceCents));
  const summary: ProfitSummary = {
    ...totals,
    roiBasisPoints: ratioBasisPoints(totals.netProfitCents, totals.costOfGoodsCents),
    missingCostCount: input.items.filter((row) => row.costCents === null).length,
    averageSalePriceCents: sold === 0 ? null : roundHalfAwayFromZero(priceTotal / sold),
    averageProfitPerItemCents:
      sold === 0 ? null : roundHalfAwayFromZero(totals.netProfitCents / sold),
    averageDaysToSell: sold === 0 ? null : averageDays(input.items),
    sellThroughBasisPoints: ratioBasisPoints(sold, sold + input.listedItems),
    feesEstimated: input.fees.some((fee) => fee.estimated),
  };

  const buckets = new Map<string, ProfitBucket>(
    bucketStarts(input.period, granularity).map((start) => [
      start,
      { start, revenueCents: 0, netProfitCents: 0, itemsSold: 0 },
    ]),
  );
  for (const item of items) {
    const bucket = buckets.get(bucketStart(item.row.soldOn, granularity, input.period.from));
    if (bucket === undefined) continue;
    bucket.revenueCents += item.revenueCents;
    bucket.netProfitCents += item.netProfitCents;
    bucket.itemsSold += 1;
  }

  const marketplaces = MARKETPLACES.flatMap((marketplace) => {
    const own = items.filter((item) => item.row.marketplace === marketplace);
    return own.length === 0 ? [] : [{ marketplace, ...sumTotals(own) }];
  });

  return {
    granularity,
    summary,
    series: [...buckets.values()],
    marketplaces,
    brands: ranking(items, (row) => row.brand),
    categories: ranking(items, (row) => row.category),
  };
}

/**
 * Each item's share of its order's amounts, split as `saleMoney` splits them, in the rows'
 * sale order. The reports (`reports.ts`) read the same shares, so every screen agrees.
 */
export function soldItemMoney<Row extends ProfitItemRow>(
  rows: readonly Row[],
  fees: readonly ProfitFeeRow[],
): SoldItemMoney<Row>[] {
  const bySale = groupBy(rows, (row) => row.saleId);
  const feesBySale = groupBy(fees, (fee) => fee.saleId);
  const result: SoldItemMoney<Row>[] = [];
  for (const [saleId, saleRows] of bySale) {
    const first = saleRows[0];
    if (first === undefined) continue;
    const saleFees = feesBySale.get(saleId) ?? [];
    const feeSource: SoldItemFeeSource =
      saleFees.length === 0
        ? 'none'
        : saleFees.some((fee) => fee.estimated)
          ? 'estimated'
          : 'actual';
    const ownIds = new Set(saleRows.map((row) => row.saleItemId));
    const orderLevel = saleFees.filter(
      (fee) => fee.saleItemId === null || !ownIds.has(fee.saleItemId),
    );
    const prices = saleRows.map((row) => row.salePriceCents);
    const shippingCharged = splitByWeight(first.shippingChargedCents, prices);
    const shippingCost = splitByWeight(first.shippingCostCents ?? 0, prices);
    // The order's fees are split as one amount, like `saleMoney` does, so each item's profit
    // matches its sale's; the labels' part of it is split alone to tell fees from shipping.
    const orderAll = splitByWeight(sumAmounts(orderLevel), prices);
    const orderLabels = splitByWeight(
      sumAmounts(orderLevel.filter((fee) => fee.shippingLabel)),
      prices,
    );
    saleRows.forEach((row, index) => {
      const own = saleFees.filter((fee) => fee.saleItemId === row.saleItemId);
      const ownLabels = sumAmounts(own.filter((fee) => fee.shippingLabel));
      const ownFees = sumAmounts(own) - ownLabels;
      const labelShare = orderLabels[index] ?? 0;
      const feesCents = ownFees + (orderAll[index] ?? 0) - labelShare;
      const shippingCents = ownLabels + labelShare + (shippingCost[index] ?? 0);
      const revenueCents = row.salePriceCents + (shippingCharged[index] ?? 0);
      const costOfGoodsCents = row.costCents ?? 0;
      result.push({
        row,
        revenueCents,
        feesCents,
        shippingCents,
        costOfGoodsCents,
        netProfitCents: revenueCents - feesCents - shippingCents - costOfGoodsCents,
        feeSource,
      });
    });
  }
  return result;
}

function sumTotals(items: readonly SoldItemMoney[]): ProfitTotals {
  return {
    revenueCents: sum(items.map((item) => item.revenueCents)),
    feesCents: sum(items.map((item) => item.feesCents)),
    shippingCents: sum(items.map((item) => item.shippingCents)),
    costOfGoodsCents: sum(items.map((item) => item.costOfGoodsCents)),
    netProfitCents: sum(items.map((item) => item.netProfitCents)),
    salesCount: new Set(items.map((item) => item.row.saleId)).size,
    itemsSold: items.length,
  };
}

/**
 * The groups by net profit: the best five, highest first, then the worst five of the rest,
 * lowest first. A brand or category is matched ignoring case and surrounding spaces and shown
 * as first seen; items without one are left out.
 */
function ranking(
  items: readonly SoldItemMoney[],
  keyOf: (row: ProfitItemRow) => string | null,
): ProfitRanking {
  const groups = new Map<string, { key: string; items: SoldItemMoney[] }>();
  for (const item of items) {
    const key = keyOf(item.row)?.trim();
    if (key === undefined || key === '') continue;
    const match = key.toLocaleLowerCase('en-US');
    const group = groups.get(match) ?? { key, items: [] };
    group.items.push(item);
    groups.set(match, group);
  }
  const ranked = [...groups.values()]
    .map(({ key, items: own }): ProfitGroup => {
      const totals = sumTotals(own);
      return {
        key,
        itemsSold: own.length,
        revenueCents: totals.revenueCents,
        netProfitCents: totals.netProfitCents,
        roiBasisPoints: ratioBasisPoints(totals.netProfitCents, totals.costOfGoodsCents),
        averageDaysToSell: averageDays(own.map((item) => item.row)),
      };
    })
    .sort(
      (a, b) =>
        b.netProfitCents - a.netProfitCents ||
        b.revenueCents - a.revenueCents ||
        a.key.localeCompare(b.key, 'en-US'),
    );
  const best = ranked.slice(0, PROFIT_RANKING_SIZE);
  const worst = ranked.slice(PROFIT_RANKING_SIZE).reverse().slice(0, PROFIT_RANKING_SIZE);
  return { best, worst };
}

/** The bucket size for a period: days up to a month, weeks up to half a year, then months. */
export function profitGranularity(period: ProfitPeriodDays): ProfitGranularity {
  const days = periodDays(period);
  if (days <= 31) return 'day';
  if (days <= 184) return 'week';
  return 'month';
}

/** How many days the period covers, both ends included. */
export function periodDays(period: ProfitPeriodDays): number {
  return (dayNumber(period.to) - dayNumber(period.from)) / DAY_MS + 1;
}

/** Every bucket's first day, in order; the first bucket starts on the period's first day. */
export function bucketStarts(period: ProfitPeriodDays, granularity: ProfitGranularity): string[] {
  const starts: string[] = [];
  let start = period.from;
  while (start <= period.to) {
    starts.push(start);
    start = nextBucket(truncate(start, granularity), granularity);
  }
  return starts;
}

/** The first day of the bucket `day` falls in. */
export function bucketStart(
  day: string,
  granularity: ProfitGranularity,
  periodFrom: string,
): string {
  const start = truncate(day, granularity);
  return start < periodFrom ? periodFrom : start;
}

function truncate(day: string, granularity: ProfitGranularity): string {
  switch (granularity) {
    case 'day':
      return day;
    case 'week': {
      // Weeks start on Monday (ISO 8601), as Postgres's `date_trunc('week', …)` does.
      const time = dayNumber(day);
      const weekday = (new Date(time).getUTCDay() + 6) % 7;
      return dayString(time - weekday * DAY_MS);
    }
    case 'month':
      return `${day.slice(0, 7)}-01`;
    default:
      return assertNever(granularity);
  }
}

function nextBucket(start: string, granularity: ProfitGranularity): string {
  switch (granularity) {
    case 'day':
      return dayString(dayNumber(start) + DAY_MS);
    case 'week':
      return dayString(dayNumber(start) + 7 * DAY_MS);
    case 'month': {
      const date = new Date(dayNumber(start));
      return dayString(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    }
    default:
      return assertNever(granularity);
  }
}

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function dayString(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function averageDays(rows: readonly ProfitItemRow[]): number {
  return Math.round(sum(rows.map((row) => row.daysToSell)) / rows.length);
}

/** `part` over `whole` in basis points; null for a zero whole. */
function ratioBasisPoints(part: number, whole: number): number | null {
  return whole === 0 ? null : roundHalfAwayFromZero((part * 10_000) / whole);
}

function sumAmounts(fees: readonly ProfitFeeRow[]): number {
  return sum(fees.map((fee) => fee.amountCents));
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [value]);
    else group.push(value);
  }
  return groups;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}
