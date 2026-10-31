import { describe, expect, it } from 'vitest';

import type { HistorySale } from './own-history.ts';
import { salesTrend } from './trend.ts';

// Invented sales; no real shop's data.
const NOW = new Date('2026-10-31T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
let next = 0;
const soldDaysAgo = (...days: number[]): HistorySale[] =>
  days.map((day) => {
    next += 1;
    return {
      id: `s${String(next)}`,
      brand: 'Lululemon',
      category: 'clothing/bottoms/leggings',
      salePriceCents: 2_800,
      soldAt: new Date(NOW.getTime() - day * DAY_MS),
    };
  });

describe('salesTrend', () => {
  it('is up only when recent sales come clearly faster, with enough on each side', () => {
    const trend = salesTrend(soldDaysAgo(5, 20, 60, 150, 300), NOW);
    expect(trend).toEqual({
      source: 'own_history',
      direction: 'up',
      recentSales: 3,
      earlierSales: 2,
      lastSoldDaysAgo: 5,
      label: 'Trending up',
      basedOn: 'Your 3 sales like it in the last 90 days, 2 sales in the 9 months before',
    });
    // Without earlier sales to compare, a recent run is no trend: the history may be new.
    expect(salesTrend(soldDaysAgo(5, 20, 60), NOW)).toMatchObject({ direction: 'steady' });
    expect(salesTrend(soldDaysAgo(5, 20, 60), NOW).label).toBeUndefined();
  });

  it('is slowing when earlier sales came faster, and unknown with too few', () => {
    expect(salesTrend(soldDaysAgo(100, 130, 160, 200, 250, 280), NOW)).toMatchObject({
      direction: 'down',
      recentSales: 0,
      earlierSales: 6,
      label: 'Slowing',
      lastSoldDaysAgo: 100,
    });
    expect(salesTrend(soldDaysAgo(10, 200), NOW)).toMatchObject({ direction: 'unknown' });
    expect(salesTrend([], NOW)).toMatchObject({ direction: 'unknown', recentSales: 0 });
    // Sales older than the window, or without a sale time, never count.
    expect(
      salesTrend(
        [...soldDaysAgo(400), { id: 'x', brand: null, category: null, salePriceCents: 1 }],
        NOW,
      ),
    ).toMatchObject({ recentSales: 0, earlierSales: 0 });
  });
});
