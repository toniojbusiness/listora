import { describe, expect, it } from 'vitest';

import { moneySummary, type SaleMoneyFact } from './money.ts';

const NOW = new Date('2026-10-25T15:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const sale = (overrides: Partial<SaleMoneyFact>): SaleMoneyFact => ({
  saleId: 'sale',
  soldAt: ago(1),
  itemsSold: 1,
  priceCents: 4000,
  profitCents: 2500,
  ...overrides,
});

describe('money summary', () => {
  it('compares the last 7 days with the 7 before, ignoring older sales', () => {
    const summary = moneySummary(
      [
        sale({ saleId: 'a', soldAt: ago(0.5), itemsSold: 2, priceCents: 6000 }),
        sale({ saleId: 'b', soldAt: ago(6.9) }),
        sale({ saleId: 'c', soldAt: ago(7.5), priceCents: 2000, profitCents: 1700 }),
        sale({ saleId: 'old', soldAt: ago(14.1) }),
        sale({ saleId: 'future', soldAt: ago(-0.1) }),
      ],
      NOW,
    );
    expect(summary.currency).toBe('USD');
    expect(summary.thisWeek).toEqual({
      start: ago(7),
      end: NOW,
      sales: 2,
      itemsSold: 3,
      salesCents: 10_000,
      profitCents: 2500 + 2500,
      profitPendingSales: 0,
    });
    expect(summary.lastWeek).toEqual({
      start: ago(14),
      end: ago(7),
      sales: 1,
      itemsSold: 1,
      salesCents: 2000,
      profitCents: 1700,
      profitPendingSales: 0,
    });
  });

  it('leaves sales without a known profit out of the profit, and counts them', () => {
    const { thisWeek } = moneySummary(
      [sale({ saleId: 'known' }), sale({ saleId: 'no-fees', profitCents: null })],
      NOW,
    );
    expect(thisWeek).toMatchObject({
      sales: 2,
      salesCents: 8000,
      profitCents: 2500,
      profitPendingSales: 1,
    });
  });

  it('has no profit when no sale has a known one, and zero for a week without sales', () => {
    const summary = moneySummary([sale({ profitCents: null })], NOW);
    expect(summary.thisWeek).toMatchObject({ sales: 1, profitCents: null, profitPendingSales: 1 });
    expect(summary.lastWeek).toMatchObject({ sales: 0, salesCents: 0, profitCents: 0 });
  });
});
