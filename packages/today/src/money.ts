/**
 * The Today screen's money summary: sales and profit in the last 7 days next to the 7 days
 * before, so a Monday morning compares two whole weeks instead of one morning with a week.
 *
 * Canceled and returned sales count for nothing. A sale's profit is the Sales tab's (`saleMoney`
 * in @listora/sales: the payout minus the label cost and the items' costs); it is unknown until
 * the sale has fee lines and every item has a cost, and an unknown profit is never guessed: it is
 * left out of the total and counted in `profitPendingSales`, so the app can say what is missing.
 */
import type { CurrencyCode } from '@listora/shared';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** One sale's money, from the sale, its items, and its fee lines. */
export interface SaleMoneyFact {
  saleId: string;
  soldAt: Date;
  itemsSold: number;
  priceCents: number;
  /** Null until the sale has fee lines and every item a cost. */
  profitCents: number | null;
}

export interface MoneyPeriod {
  start: Date;
  end: Date;
  /** Sales (orders), and the items they sold. */
  sales: number;
  itemsSold: number;
  /** What the items sold for, before shipping, fees, and costs. */
  salesCents: number;
  /** The profit of the sales whose profit is known; null when no sale's is. */
  profitCents: number | null;
  /** Sales whose profit is not known yet (no fees recorded, or an item without a cost). */
  profitPendingSales: number;
}

export interface MoneySummary {
  currency: CurrencyCode;
  thisWeek: MoneyPeriod;
  lastWeek: MoneyPeriod;
}

/** The two periods ending at `now`; `facts` may hold sales outside them, which are ignored. */
export function moneySummary(facts: readonly SaleMoneyFact[], now: Date): MoneySummary {
  const thisStart = new Date(now.getTime() - WEEK_MS);
  const lastStart = new Date(now.getTime() - 2 * WEEK_MS);
  return {
    currency: 'USD',
    thisWeek: period(facts, thisStart, now),
    lastWeek: period(facts, lastStart, thisStart),
  };
}

function period(facts: readonly SaleMoneyFact[], start: Date, end: Date): MoneyPeriod {
  const inPeriod = facts.filter(
    (fact) => fact.soldAt.getTime() >= start.getTime() && fact.soldAt.getTime() < end.getTime(),
  );
  const profits = inPeriod.map((fact) => fact.profitCents);
  const known = profits.filter((profit): profit is number => profit !== null);
  return {
    start,
    end,
    sales: inPeriod.length,
    itemsSold: inPeriod.reduce((sum, fact) => sum + fact.itemsSold, 0),
    salesCents: inPeriod.reduce((sum, fact) => sum + fact.priceCents, 0),
    profitCents:
      known.length > 0 || inPeriod.length === 0
        ? known.reduce((sum, profit) => sum + profit, 0)
        : null,
    profitPendingSales: profits.length - known.length,
  };
}
