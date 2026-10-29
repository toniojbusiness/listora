/**
 * The Reports screen's year (docs/features/reports.md): the year's totals, each month's, and the
 * seller's own totals per marketplace, for taxes and bookkeeping. Pure, in integer cents.
 *
 * - **The same shares as the dashboard.** Every sold item's money is `soldItemMoney`, the split
 *   the profit dashboard and the sale screen use, so the three agree to the cent; an item's cost
 *   is its own or its haul share ([hauls.md](../../../docs/features/hauls.md)).
 * - **Nothing guessed.** A row's fees are given only when every sale in it has the
 *   marketplace's own fees (not the fee table's estimate, and not none at all); its cost of goods
 *   only when every item in it has a cost; and its profit only when both are. Otherwise the
 *   number is null, and `feesUnknownCount` and `missingCostCount` say why.
 * - **Refunds excluded.** The caller passes only sales that stand: a canceled or returned sale
 *   counts nowhere.
 * - **Marketplaces side by side, never ranked**, in the fixed `MARKETPLACES` order (eBay's API
 *   License Agreement; see profit.ts).
 */
import { MARKETPLACES, type Marketplace } from '@listora/db';

import {
  soldItemMoney,
  type ProfitFeeRow,
  type ProfitItemRow,
  type SoldItemMoney,
} from './profit.ts';

/** The first and last years a report covers. */
export const REPORT_FIRST_YEAR = 2000;
export const REPORT_LAST_YEAR = 2100;

export interface ReportTotals {
  /** Orders (a bundle is one). */
  salesCount: number;
  itemsSold: number;
  /** The sale prices plus the shipping buyers paid. */
  revenueCents: number;
  /** Labels the marketplace deducted plus labels bought outside the payout. */
  shippingCents: number;
  /** Every fee but shipping labels; null unless every sale's fees are the marketplace's. */
  feesCents: number | null;
  /** Sales whose fees are still an estimate or not known at all. */
  feesUnknownCount: number;
  /** The items' costs (a haul item's is its share); null while any item has none. */
  costOfGoodsCents: number | null;
  missingCostCount: number;
  /** Revenue minus fees, shipping, and cost of goods; null unless both are known. */
  netProfitCents: number | null;
}

export interface MonthReport extends ReportTotals {
  /** `YYYY-MM`. */
  month: string;
}

export interface MarketplaceReport extends ReportTotals {
  marketplace: Marketplace;
}

export interface YearReport {
  year: number;
  total: ReportTotals;
  /** All twelve months, January first, empty ones included. */
  months: MonthReport[];
  /** Only marketplaces with a sale, in the fixed `MARKETPLACES` order. */
  marketplaces: MarketplaceReport[];
}

export interface YearReportInput {
  year: number;
  /** The year's sold items on sales that stand, `soldOn` in the seller's time zone. */
  items: readonly ProfitItemRow[];
  /** The fee lines of those sales, summed as `feeRows` sums them. */
  fees: readonly ProfitFeeRow[];
}

/** The year's first and last day, for the queries. */
export function yearDays(year: number): { from: string; to: string } {
  const padded = String(year).padStart(4, '0');
  return { from: `${padded}-01-01`, to: `${padded}-12-31` };
}

export function yearReport(input: YearReportInput): YearReport {
  const items = soldItemMoney(input.items, input.fees);
  const year = String(input.year).padStart(4, '0');
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`;
    return { month, ...reportTotals(items.filter((item) => item.row.soldOn.startsWith(month))) };
  });
  const marketplaces = MARKETPLACES.flatMap((marketplace) => {
    const own = items.filter((item) => item.row.marketplace === marketplace);
    return own.length === 0 ? [] : [{ marketplace, ...reportTotals(own) }];
  });
  return { year: input.year, total: reportTotals(items), months, marketplaces };
}

/** The totals of some sold items, with only the numbers that every item in them supports. */
export function reportTotals(items: readonly SoldItemMoney[]): ReportTotals {
  const sales = new Set(items.map((item) => item.row.saleId));
  const feesUnknown = new Set(
    items.filter((item) => item.feeSource !== 'actual').map((item) => item.row.saleId),
  );
  const missingCostCount = items.filter((item) => item.row.costCents === null).length;
  const revenueCents = sum(items.map((item) => item.revenueCents));
  const shippingCents = sum(items.map((item) => item.shippingCents));
  const feesCents = feesUnknown.size === 0 ? sum(items.map((item) => item.feesCents)) : null;
  const costOfGoodsCents =
    missingCostCount === 0 ? sum(items.map((item) => item.costOfGoodsCents)) : null;
  return {
    salesCount: sales.size,
    itemsSold: items.length,
    revenueCents,
    shippingCents,
    feesCents,
    feesUnknownCount: feesUnknown.size,
    costOfGoodsCents,
    missingCostCount,
    netProfitCents:
      feesCents === null || costOfGoodsCents === null
        ? null
        : revenueCents - feesCents - shippingCents - costOfGoodsCents,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
