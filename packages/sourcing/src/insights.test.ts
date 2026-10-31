import { describe, expect, it } from 'vitest';

import { DEFAULT_SCAN_CALL_SETTINGS } from './call.ts';
import {
  buildSourcingInsights,
  INSIGHT_LIST_LENGTH,
  INSIGHT_UNSOLD_MIN_AGE_DAYS,
  type SourcingInsightsInput,
} from './insights.ts';
import { buildSourcingKit } from './kit.ts';
import type { OwnSale } from './own-history.ts';
import type { UnsoldItem } from './unsold.ts';

// Invented sales and stock; no real shop's data.
const NOW = new Date('2026-10-30T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGGINGS = 'clothing/bottoms/leggings';
const JACKETS = 'clothing/outerwear/jackets';
const JEANS = 'clothing/bottoms/jeans';
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
let next = 0;
const sale = (overrides: Partial<OwnSale> = {}): OwnSale => ({
  id: `sale-item-${String((next += 1))}`,
  itemId: `sold-${String(next)}`,
  marketplace: 'depop',
  brand: 'Lululemon',
  category: LEGGINGS,
  sizeLabel: '6',
  salePriceCents: 2800,
  soldAt: daysAgo(10),
  ...overrides,
});
const stock = (overrides: Partial<UnsoldItem> = {}): UnsoldItem => ({
  brand: 'Lululemon',
  category: LEGGINGS,
  sizeLabel: '6',
  addedAt: daysAgo(60),
  ...overrides,
});
/** A flat $3 fee, so payouts are easy to read. */
const flatFees: SourcingInsightsInput['fees'] = () => () => 300;
const insights = (sales: OwnSale[], unsold: UnsoldItem[] = []) =>
  buildSourcingInsights({ sales, unsold, now: NOW, fees: flatFees });
const pairs = (groups: readonly { brandKey: string; category: string }[]) =>
  groups.map((group) => `${group.brandKey} ${group.category}`);

describe('buildSourcingInsights', () => {
  it('judges brand and item type pairs, never a brand alone', () => {
    // Lululemon's leggings sell; its jackets sit. A brand-wide figure would hide both.
    const result = insights(
      [
        sale(),
        sale(),
        sale(),
        sale({ category: JACKETS, salePriceCents: 6000 }),
        sale({ category: null }),
        sale({ brand: null }),
      ],
      [
        stock({ category: JACKETS }),
        stock({ category: JACKETS }),
        stock({ category: JACKETS }),
        stock({ category: null }),
      ],
    );
    expect(pairs(result.best)).toEqual([`lululemon ${LEGGINGS}`]);
    expect(pairs(result.worst)).toEqual([`lululemon ${JACKETS}`]);
    expect(result.worst[0]).toMatchObject({
      soldCount: 1,
      unsoldCount: 3,
      inStockCount: 3,
      sellThroughBasisPoints: 2500,
    });
    // Only the sales with both a brand and a category count.
    expect(result.soldCount).toBe(4);
  });

  it('works out sell-through, the median days to sell, and the median payout', () => {
    const result = insights(
      [
        sale({ listedAt: daysAgo(20), salePriceCents: 2000 }),
        sale({ listedAt: daysAgo(14), salePriceCents: 3000 }),
        sale({ listedAt: daysAgo(40), salePriceCents: 2600 }),
        // Imported: no listing date, so no day count; it still sold.
        sale({ salePriceCents: 2400 }),
      ],
      [stock()],
    );
    expect(result.daysToSellCount).toBe(3);
    expect(result.best).toEqual([
      {
        brand: 'Lululemon',
        brandKey: 'lululemon',
        category: LEGGINGS,
        soldCount: 4,
        unsoldCount: 1,
        inStockCount: 1,
        sellThroughBasisPoints: 8000,
        // Sold 10 days ago after 20, 14, and 40 days listed: 10, 4, and 30 days.
        medianDaysToSell: 10,
        // $20, $24, $26, $30 less $3 each.
        medianPayout: { amountCents: 2200, currency: 'USD' },
      },
    ]);
  });

  it('needs three items to judge a pair, and two dated sales for a day count', () => {
    const result = insights(
      [sale({ listedAt: daysAgo(30) }), sale(), sale({ brand: 'Patagonia', category: JACKETS })],
      [stock({ brand: 'Patagonia', category: JACKETS })],
    );
    // Lululemon leggings: 2 sold, nothing in stock. Patagonia jackets: 1 sold, 1 unsold.
    expect(result.best).toEqual([]);
    expect(result.worst).toEqual([]);

    const dated = insights([sale({ listedAt: daysAgo(30) }), sale(), sale()]);
    expect(dated.best[0]?.medianDaysToSell).toBeUndefined();
  });

  it('counts an unsold item against its pair only once it had time to sell', () => {
    const fresh = stock({ addedAt: daysAgo(INSIGHT_UNSOLD_MIN_AGE_DAYS - 1) });
    const result = insights([sale(), sale()], [fresh, fresh, fresh, stock()]);
    expect(result.best[0]).toMatchObject({
      soldCount: 2,
      unsoldCount: 1,
      inStockCount: 4,
      sellThroughBasisPoints: 6667,
    });
  });

  it('lists a pair that never sold among the worst', () => {
    const result = insights(
      [],
      [
        stock({ brand: 'Shein', category: JEANS }),
        stock({ brand: 'SHEIN', category: JEANS }),
        stock({ brand: 'Shein', category: JEANS }),
      ],
    );
    expect(result.worst).toEqual([
      {
        brand: 'Shein',
        brandKey: 'shein',
        category: JEANS,
        soldCount: 0,
        unsoldCount: 3,
        inStockCount: 3,
        sellThroughBasisPoints: 0,
      },
    ]);
    expect(result.best).toEqual([]);
    expect(result.lookFor).toEqual([]);
  });

  it('calls a slow seller worst even when most of it sold', () => {
    const slow = { brand: 'Levi’s', category: JEANS };
    const result = insights(
      [
        sale({ ...slow, listedAt: daysAgo(130) }),
        sale({ ...slow, listedAt: daysAgo(110) }),
        sale({ ...slow, listedAt: daysAgo(100) }),
      ],
      [],
    );
    expect(result.worst.map((group) => [group.brandKey, group.medianDaysToSell])).toEqual([
      ['levi', 100],
    ]);
    expect(result.best).toEqual([]);
  });

  it('orders the best by sell-through, then speed, then sales; the worst the other way', () => {
    const result = insights(
      [
        // Madewell jeans: 3 of 3, in 5 days.
        ...[0, 1, 2].map(() => sale({ brand: 'Madewell', category: JEANS, listedAt: daysAgo(15) })),
        // Lululemon leggings: 3 of 3, in 20 days.
        ...[0, 1, 2].map(() => sale({ listedAt: daysAgo(30) })),
        // Patagonia jackets: 3 of 4.
        ...[0, 1, 2].map(() => sale({ brand: 'Patagonia', category: JACKETS })),
        // Gap jeans: 1 of 4. Old Navy jeans: 1 of 3.
        sale({ brand: 'Gap', category: JEANS }),
        sale({ brand: 'Old Navy', category: JEANS }),
      ],
      [
        stock({ brand: 'Patagonia', category: JACKETS }),
        ...[0, 1, 2].map(() => stock({ brand: 'Gap', category: JEANS })),
        ...[0, 1].map(() => stock({ brand: 'Old Navy', category: JEANS })),
      ],
    );
    expect(pairs(result.best)).toEqual([
      `madewell ${JEANS}`,
      `lululemon ${LEGGINGS}`,
      `patagonia ${JACKETS}`,
    ]);
    expect(pairs(result.worst)).toEqual([`gap ${JEANS}`, `old navy ${JEANS}`]);
  });

  it('looks for the best sellers that pay out enough, and keeps each list short', () => {
    const brands = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'];
    const result = insights(
      brands
        .flatMap((brand) => [0, 1, 2].map(() => sale({ brand, salePriceCents: 2800 })))
        .concat(
          // Cheap tees sell every time but pay out less than worth listing.
          [0, 1, 2].map(() =>
            sale({ brand: 'Hanes', category: 'clothing/tops/t_shirts', salePriceCents: 900 }),
          ),
        ),
    );
    expect(result.best).toHaveLength(INSIGHT_LIST_LENGTH);
    expect(result.lookFor).toHaveLength(INSIGHT_LIST_LENGTH);
    expect(result.lookFor.every((group) => group.brandKey !== 'hanes')).toBe(true);
    const worth = DEFAULT_SCAN_CALL_SETTINGS.worthListingCents;
    expect(result.lookFor.every((group) => (group.medianPayout?.amountCents ?? 0) >= worth)).toBe(
      true,
    );
  });

  it("leaves eBay's sales out of the payout, which they never model, but counts them sold", () => {
    const result = insights([
      sale({ marketplace: 'ebay' }),
      sale({ marketplace: 'ebay' }),
      sale({ marketplace: 'ebay' }),
    ]);
    expect(result.best[0]?.soldCount).toBe(3);
    expect(result.best[0]?.medianPayout).toBeUndefined();
    expect(result.lookFor).toEqual([]);
  });

  it('is empty without sales or stock, and rides in the kit', () => {
    expect(insights([])).toEqual({
      soldCount: 0,
      daysToSellCount: 0,
      lookFor: [],
      best: [],
      worst: [],
    });
    const kit = buildSourcingKit({ sales: [sale(), sale(), sale()], unsold: [], now: NOW });
    expect(pairs(kit.insights.best)).toEqual([`lululemon ${LEGGINGS}`]);
  });
});
