import { estimateFeesCents, feeTableFor } from '@listora/pricing';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SCAN_CALL_SETTINGS } from './call.ts';
import { buildSourcingKit, MAX_KIT_BUCKETS, SOURCING_KIT_VERSION } from './kit.ts';
import { OWN_HISTORY_WINDOW_DAYS, type OwnSale } from './own-history.ts';

// Invented sales; no real shop's data.
const NOW = new Date('2026-10-30T12:00:00Z');
const LEGGINGS = 'clothing/bottoms/leggings';
const TANKS = 'clothing/tops/tank_tops';
let next = 0;
const sale = (overrides: Partial<OwnSale> = {}): OwnSale => ({
  id: `sale-item-${String((next += 1))}`,
  itemId: `sold-${String(next)}`,
  marketplace: 'depop',
  brand: 'Lululemon',
  category: LEGGINGS,
  sizeLabel: '6',
  salePriceCents: 2800,
  ...overrides,
});
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' });
const payout = (marketplace: 'depop' | 'ebay', price: number) =>
  price - estimateFeesCents(feeTableFor(marketplace, NOW), price);

describe('buildSourcingKit', () => {
  it('groups the sales by brand, then category, then size, each with its marketplaces', () => {
    const kit = buildSourcingKit({
      sales: [
        sale({ salePriceCents: 2200 }),
        sale({ salePriceCents: 3000, sizeLabel: 'Medium' }),
        sale({ salePriceCents: 2800, brand: 'LULULEMON' }),
        sale({ marketplace: 'mercari', salePriceCents: 2000 }),
        sale({ category: TANKS, sizeLabel: null, salePriceCents: 1500 }),
        sale({ brand: 'Patagonia', category: null, salePriceCents: 4500 }),
      ],
      unsold: [
        { brand: 'lululemon', category: LEGGINGS, sizeLabel: '6' },
        { brand: 'Lululemon', category: LEGGINGS, sizeLabel: '10' },
        { brand: 'Patagonia', category: null, sizeLabel: null },
        // Its brand never sold, so no group counts it.
        { brand: 'Athleta', category: LEGGINGS, sizeLabel: '6' },
        { brand: null, category: LEGGINGS, sizeLabel: '6' },
      ],
      now: NOW,
    });

    expect(kit.version).toBe(SOURCING_KIT_VERSION);
    expect(kit.generatedAt).toBe(NOW.toISOString());
    expect(kit.windowDays).toBe(OWN_HISTORY_WINDOW_DAYS);
    expect(
      kit.buckets.map((bucket) => [
        bucket.brandKey,
        bucket.category,
        bucket.sizeBucket,
        bucket.unsoldCount,
        bucket.marketplaces.map((line) => `${line.marketplace}:${String(line.soldCount)}`),
      ]),
    ).toEqual([
      ['lululemon', undefined, undefined, 2, ['depop:4', 'mercari:1']],
      ['lululemon', LEGGINGS, undefined, 2, ['depop:3', 'mercari:1']],
      ['lululemon', LEGGINGS, '6', 1, ['depop:2', 'mercari:1']],
      ['lululemon', LEGGINGS, 'm', 0, ['depop:1']],
      ['lululemon', TANKS, undefined, 0, ['depop:1']],
      ['patagonia', undefined, undefined, 1, ['depop:1']],
    ]);

    const leggings = kit.buckets[1];
    expect(leggings?.brand).toBe('Lululemon');
    expect(leggings?.marketplaces[0]).toEqual({
      marketplace: 'depop',
      soldCount: 3,
      low: usd(2500),
      median: usd(2800),
      high: usd(2900),
      medianPayout: usd(payout('depop', 2800)),
      feeTableVersion: feeTableFor('depop', NOW).version,
      displayOnly: false,
    });
  });

  it("marks eBay's sales display only and lists marketplaces in the fixed order", () => {
    const kit = buildSourcingKit({
      sales: [
        sale({ marketplace: 'mercari' }),
        sale({ marketplace: 'ebay', salePriceCents: 4000 }),
        sale({ marketplace: 'poshmark' }),
        sale(),
      ],
      unsold: [],
      now: NOW,
    });
    const lines = kit.buckets[0]?.marketplaces ?? [];
    expect(lines.map((line) => line.marketplace)).toEqual(['ebay', 'depop', 'poshmark', 'mercari']);
    expect(lines.map((line) => line.displayOnly)).toEqual([true, false, false, false]);
    expect(lines[0]?.medianPayout).toEqual(usd(payout('ebay', 4000)));
  });

  it('spells the brand as most sales do, a tie going to the first in order', () => {
    const kit = buildSourcingKit({
      sales: [
        sale({ brand: "levi's", category: null }),
        sale({ brand: 'Levi’s', category: null }),
        sale({ brand: "Levi's", category: null }),
        sale({ brand: "Levi's", category: null }),
        sale({ brand: 'B', category: null }),
        sale({ brand: 'b', category: null }),
      ],
      unsold: [],
      now: NOW,
    });
    expect(kit.buckets.map((bucket) => [bucket.brandKey, bucket.brand])).toEqual([
      ['b', 'B'],
      ['levi', "Levi's"],
    ]);
  });

  it('is empty without sales, and skips a sale whose brand has no letters or digits', () => {
    expect(buildSourcingKit({ sales: [], unsold: [], now: NOW }).buckets).toEqual([]);
    expect(
      buildSourcingKit({ sales: [sale({ brand: ' - ' })], unsold: [], now: NOW }).buckets,
    ).toEqual([]);
  });

  it('keeps at most the limit, leaving out size groups first, the fewest sales first', () => {
    const sales: OwnSale[] = [];
    // One brand with many sizes: more groups than the limit.
    for (let size = 0; size < MAX_KIT_BUCKETS + 10; size += 1) {
      sales.push(sale({ sizeLabel: `${String(size)}w` }));
    }
    sales.push(sale({ sizeLabel: '1w' }));
    const kit = buildSourcingKit({ sales, unsold: [], now: NOW });
    expect(kit.buckets).toHaveLength(MAX_KIT_BUCKETS);
    expect(kit.buckets[0]?.category).toBeUndefined();
    expect(kit.buckets[1]?.sizeBucket).toBeUndefined();
    expect(kit.buckets.some((bucket) => bucket.sizeBucket === '1w')).toBe(true);
  });

  it("gives each group the call's sales, payouts, and thresholds for the offline call", () => {
    const kit = buildSourcingKit({
      sales: [
        sale({ salePriceCents: 2000 }),
        sale({ salePriceCents: 3000 }),
        sale({ marketplace: 'mercari', salePriceCents: 2600 }),
        sale({ marketplace: 'mercari', salePriceCents: 2400 }),
        sale({ marketplace: 'mercari', salePriceCents: 2500 }),
        // eBay's sales show, but never feed the call.
        sale({ marketplace: 'ebay', salePriceCents: 9000 }),
        sale({ brand: 'Coach', marketplace: 'ebay', category: null, salePriceCents: 5000 }),
      ],
      unsold: [],
      now: NOW,
      // A flat $1 fee, as an account's calibrated estimate would be passed in.
      fees: (marketplace) => (price) => (marketplace === 'mercari' ? 100 : price),
      settings: { ...DEFAULT_SCAN_CALL_SETTINGS, worthListingCents: 900, minComparisons: 4 },
    });

    expect(kit.call).toEqual({ worthListing: usd(900), minComparisons: 4 });
    const brand = kit.buckets.find((bucket) => bucket.brandKey === 'lululemon' && !bucket.category);
    // Five sales (not eBay's): quartiles $24-$26, after Mercari's fees, which has most of them.
    expect(brand?.forCall).toEqual({
      soldCount: 5,
      low: usd(2400),
      high: usd(2600),
      payoutMarketplace: 'mercari',
      conservativePayout: usd(2300),
      optimisticPayout: usd(2500),
    });
    expect(kit.buckets.find((bucket) => bucket.brandKey === 'coach')?.forCall).toBeUndefined();
  });

  it("works payouts out by each marketplace's current fee table by default", () => {
    const kit = buildSourcingKit({ sales: [sale({ salePriceCents: 2800 })], unsold: [], now: NOW });
    expect(kit.buckets[0]?.forCall?.conservativePayout).toEqual(usd(payout('depop', 2800)));
    expect(kit.call).toEqual({ worthListing: usd(800), minComparisons: 3 });
  });
});
