import type { PricingSuggestion } from '@listora/api-contract';
import { describe, expect, it } from 'vitest';

import {
  AI_ESTIMATE_LABEL,
  claimsSoldData,
  labelGuardViolations,
  NO_SOLD_DATA_MESSAGE,
} from './labels.ts';
import {
  aiEstimatePayloadSchema,
  soldDataPayloadSchema,
  soldDataPayloadSchemaFor,
  type SoldDataSnapshot,
} from './snapshots.ts';
import {
  isRealSoldDataSource,
  PRICING_SNAPSHOT_SOURCES,
  REAL_SOLD_DATA_SOURCES,
  SOLD_DATA_LISTING_CONTEXT,
} from './sources.ts';
import { buildPricingSuggestion, LabelGuardError, type PricingInput } from './suggestion.ts';

const NOW = new Date('2026-10-24T12:00:00Z');
const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
const ANALYSIS_ID = '0190a2b8-0000-7000-8000-000000000001';

const base: PricingInput = {
  itemId: '0190a2b8-0000-7000-8000-0000000000aa',
  currency: 'USD',
  costCents: 1000,
  shippingCents: 0,
  minimumProfitCents: 0,
  marketplaces: ['ebay', 'depop', 'poshmark', 'mercari'],
  estimate: {
    payload: {
      analysisId: ANALYSIS_ID,
      low: usd(1800),
      mid: usd(2600),
      high: usd(3800),
      confidence: 0.55,
    },
    fetchedAt: NOW,
  },
  soldData: [],
  feeCalibrations: {},
  researchQuery: 'Patagonia Retro-X fleece',
  now: NOW,
};

const depopSold: SoldDataSnapshot = {
  source: 'depop_inspiration',
  payload: {
    label: 'Sold on Depop (last 90 days)',
    sampleSize: 12,
    low: usd(2000),
    median: usd(2800),
    high: usd(4000),
    marketplace: 'depop',
  },
  fetchedAt: NOW,
};

/** Every string in a value. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  return Object.values(value).flatMap(allStrings);
}

describe('buildPricingSuggestion without sold data', () => {
  const suggestion = buildPricingSuggestion(base);

  it('says there is no sold data and labels the AI estimate with its confidence', () => {
    expect(suggestion.soldComparables).toBeUndefined();
    expect(suggestion.noSoldDataMessage).toBe('No sold data available for this item');
    expect(suggestion.aiEstimate).toEqual({
      label: 'AI estimate - not based on sold listings',
      low: usd(1800),
      mid: usd(2600),
      high: usd(3800),
      confidence: 0.55,
    });
  });

  it('computes a floor per marketplace whose breakdown adds up', () => {
    expect(suggestion.floors.map((floor) => floor.marketplace)).toEqual([
      'ebay',
      'depop',
      'poshmark',
      'mercari',
    ]);
    for (const floor of suggestion.floors) {
      const { cost, estimatedFees, shipping, minimumProfit } = floor.breakdown;
      expect(floor.floorPrice.amountCents, floor.marketplace).toBe(
        cost.amountCents +
          estimatedFees.amountCents +
          shipping.amountCents +
          minimumProfit.amountCents,
      );
      expect(floor.feeSource).toBe('fee_table');
    }
    const poshmark = suggestion.floors.find((floor) => floor.marketplace === 'poshmark');
    expect(poshmark).toEqual({
      marketplace: 'poshmark',
      floorPrice: usd(1295),
      breakdown: {
        cost: usd(1000),
        estimatedFees: usd(295),
        shipping: usd(0),
        minimumProfit: usd(0),
      },
      feeTableVersion: 'poshmark-us-2026-10-24',
      feeSource: 'fee_table',
    });
  });

  it('adds the seller’s shipping and minimum profit to every floor', () => {
    const withCosts = buildPricingSuggestion({
      ...base,
      shippingCents: 500,
      minimumProfitCents: 700,
    });
    for (const floor of withCosts.floors) {
      expect(floor.breakdown.shipping).toEqual(usd(500));
      expect(floor.breakdown.minimumProfit).toEqual(usd(700));
    }
    expect(withCosts.floors.find((floor) => floor.marketplace === 'mercari')?.floorPrice).toEqual(
      usd(2445), // 2200 needed; 10% of 2445 rounds up to 245
    );
  });

  it('labels every tier as an estimate and keeps it at or above the highest floor', () => {
    expect(suggestion.tiers.map((tier) => tier.label)).toEqual([
      'Quick sale (AI estimate)',
      'Recommended (AI estimate)',
      'Higher profit (AI estimate)',
    ]);
    const expensive = buildPricingSuggestion({ ...base, costCents: 2500 });
    const highest = Math.max(...expensive.floors.map((floor) => floor.floorPrice.amountCents));
    for (const tier of expensive.tiers) {
      expect(tier.price.amountCents).toBeGreaterThanOrEqual(highest);
    }
    expect(expensive.tiers[0]).toMatchObject({
      basis: 'cost_floor',
      label: 'Quick sale (cost floor)',
    });
  });

  it('has no floors without a cost and no tiers or estimate without an analysis', () => {
    const bare = buildPricingSuggestion({ ...base, costCents: undefined, estimate: undefined });
    expect(bare.floors).toEqual([]);
    expect(bare.tiers).toEqual([]);
    expect(bare.aiEstimate).toBeUndefined();
    expect(bare.noSoldDataMessage).toBe(NO_SOLD_DATA_MESSAGE);
  });

  it('links to eBay sold listings and Terapeak, and to nothing without search words', () => {
    expect(suggestion.researchLinks).toHaveLength(2);
    expect(buildPricingSuggestion({ ...base, researchQuery: undefined }).researchLinks).toEqual([]);
  });

  it('mentions sold data only in the fixed no-data texts and the research links', () => {
    const { noSoldDataMessage, aiEstimate, researchLinks, ...rest } = suggestion;
    expect(allStrings(rest).filter(claimsSoldData)).toEqual([]);
    expect([noSoldDataMessage, aiEstimate?.label]).toEqual([
      NO_SOLD_DATA_MESSAGE,
      AI_ESTIMATE_LABEL,
    ]);
    expect(researchLinks.length).toBeGreaterThan(0);
  });
});

describe('buildPricingSuggestion with sold data', () => {
  it('shows real sold data as comparables, with its marketplace context', () => {
    const suggestion = buildPricingSuggestion({ ...base, soldData: [depopSold] });
    expect(suggestion.noSoldDataMessage).toBeUndefined();
    expect(suggestion.soldComparables).toEqual([
      {
        source: 'depop_inspiration',
        marketplace: 'depop',
        label: 'Sold on Depop (last 90 days)',
        sampleSize: 12,
        low: usd(2000),
        median: usd(2800),
        high: usd(4000),
        fetchedAt: NOW.toISOString(),
      },
    ]);
  });

  it('never sets tiers from sold data', () => {
    const suggestion = buildPricingSuggestion({ ...base, soldData: [depopSold] });
    expect(suggestion.tiers).toEqual(buildPricingSuggestion(base).tiers);
    expect(suggestion.tiers.every((tier) => tier.basis !== 'sold_data')).toBe(true);
  });
});

describe('fee calibration in floors', () => {
  const doubled = { sales: 5, actualFeesCents: 2000, estimatedFeesCents: 1000 };

  it('uses the account’s actual fees where the marketplace’s order data may feed prices', () => {
    const suggestion = buildPricingSuggestion({ ...base, feeCalibrations: { mercari: doubled } });
    const mercari = suggestion.floors.find((floor) => floor.marketplace === 'mercari');
    expect(mercari?.feeSource).toBe('actual_fees');
    expect(mercari?.floorPrice).toEqual(usd(1250)); // 20% instead of 10%
  });

  it('never uses eBay order data to compute a price (eBay API License)', () => {
    const suggestion = buildPricingSuggestion({ ...base, feeCalibrations: { ebay: doubled } });
    const ebay = suggestion.floors.find((floor) => floor.marketplace === 'ebay');
    expect(ebay?.feeSource).toBe('fee_table');
    expect(ebay).toEqual(
      buildPricingSuggestion(base).floors.find((floor) => floor.marketplace === 'ebay'),
    );
  });
});

describe('label guard', () => {
  const honest = buildPricingSuggestion(base);
  const withSold = buildPricingSuggestion({ ...base, soldData: [depopSold] });
  const clone = (suggestion: PricingSuggestion): PricingSuggestion => structuredClone(suggestion);

  it('passes honest suggestions', () => {
    expect(labelGuardViolations(honest)).toEqual([]);
    expect(labelGuardViolations(withSold)).toEqual([]);
  });

  it.each(['ai_estimate', 'cost_floor', 'listora', 'ebay_browse'])(
    'rejects sold comparables from %s',
    (source) => {
      const suggestion = clone(withSold);
      // A source a newer server could send; this build's types allow only real sold data.
      const first = suggestion.soldComparables?.[0] as { source: string } | undefined;
      if (first) first.source = source;
      expect(labelGuardViolations(suggestion)).toContain(`soldComparables[0] has source ${source}`);
    },
  );

  it('keeps Depop Pricing Inspiration and eBay Marketplace Insights in their listing context', () => {
    const unbound = clone(withSold);
    const first = unbound.soldComparables?.[0];
    if (first) delete first.marketplace;
    expect(labelGuardViolations(unbound)).toContain(
      'soldComparables[0] (depop_inspiration) has marketplace undefined instead of depop',
    );
    const elsewhere = clone(withSold);
    const second = elsewhere.soldComparables?.[0];
    if (second) second.marketplace = 'poshmark';
    expect(labelGuardViolations(elsewhere)).toContain(
      'soldComparables[0] (depop_inspiration) has marketplace poshmark instead of depop',
    );
    const ebay = buildPricingSuggestion({
      ...base,
      soldData: [
        { ...depopSold, source: 'ebay_mi', payload: { ...depopSold.payload, marketplace: 'ebay' } },
      ],
    });
    expect(labelGuardViolations(ebay)).toEqual([]);
    const ebayElsewhere = clone(ebay);
    const third = ebayElsewhere.soldComparables?.[0];
    if (third) third.marketplace = 'depop';
    expect(labelGuardViolations(ebayElsewhere)).toContain(
      'soldComparables[0] (ebay_mi) has marketplace depop instead of ebay',
    );
    expect(() =>
      buildPricingSuggestion({
        ...base,
        soldData: [{ ...depopSold, payload: { ...depopSold.payload, marketplace: undefined } }],
      }),
    ).toThrow(LabelGuardError);
  });

  it('lets own sales history name any marketplace, or none', () => {
    const own = (marketplace: 'ebay' | undefined) =>
      buildPricingSuggestion({
        ...base,
        soldData: [
          { ...depopSold, source: 'own_history', payload: { ...depopSold.payload, marketplace } },
        ],
      });
    expect(labelGuardViolations(own(undefined))).toEqual([]);
    expect(labelGuardViolations(own('ebay'))).toEqual([]);
  });

  it('requires the no-data message exactly when there is no sold data', () => {
    const missing = clone(honest);
    delete missing.noSoldDataMessage;
    expect(labelGuardViolations(missing)).toContain(
      'noSoldDataMessage is missing although there is no sold data',
    );
    const extra = clone(withSold);
    extra.noSoldDataMessage = NO_SOLD_DATA_MESSAGE;
    expect(labelGuardViolations(extra)).toContain(
      'noSoldDataMessage is present although there is sold data',
    );
  });

  it('requires the AI estimate label', () => {
    const relabeled = clone(honest);
    if (relabeled.aiEstimate) relabeled.aiEstimate.label = 'Sold comps';
    expect(labelGuardViolations(relabeled)).toContain('aiEstimate.label is "Sold comps"');
  });

  it('rejects tiers that claim sold data they are not based on', () => {
    const soldTier = clone(honest);
    const first = soldTier.tiers[0];
    if (first) first.basis = 'sold_data';
    expect(labelGuardViolations(soldTier)).toContain(
      'tiers[0] is based on sold data that is not there',
    );

    const soldLabel = clone(withSold);
    const second = soldLabel.tiers[1];
    if (second) second.label = 'Recommended (sold comps)';
    expect(labelGuardViolations(soldLabel)).toContain(
      'tiers[1] (ai_estimate) is labeled "Recommended (sold comps)"',
    );
  });

  it('rejects research links it did not build', () => {
    const link = clone(honest);
    link.researchLinks.push({ label: 'Sold comps: $40', url: 'https://example.com' });
    expect(labelGuardViolations(link)).toContain('researchLinks[2] is labeled "Sold comps: $40"');
  });

  it('rejects a sold claim in any other text, including fields added later', () => {
    const added = clone(honest) as PricingSuggestion & { summary?: string };
    added.summary = 'Based on 12 comparables';
    const floor = added.floors[0];
    if (floor) floor.feeTableVersion = 'sold-history';
    expect(labelGuardViolations(added)).toEqual([
      'floors[0].feeTableVersion mentions sold data: "sold-history"',
      'summary mentions sold data: "Based on 12 comparables"',
    ]);
  });

  it('makes buildPricingSuggestion fail rather than return a dishonest suggestion', () => {
    const bad = { ...depopSold, source: 'ai_estimate' } as unknown as SoldDataSnapshot;
    expect(() => buildPricingSuggestion({ ...base, soldData: [bad] })).toThrow(LabelGuardError);
  });
});

describe('sources and snapshot payloads', () => {
  it('name only depop_inspiration, ebay_mi, and own_history as real sold data', () => {
    expect(REAL_SOLD_DATA_SOURCES).toEqual(['depop_inspiration', 'ebay_mi', 'own_history']);
    expect(PRICING_SNAPSHOT_SOURCES.filter(isRealSoldDataSource)).toEqual(REAL_SOLD_DATA_SOURCES);
    expect(isRealSoldDataSource('ai_estimate')).toBe(false);
    expect(isRealSoldDataSource('cost_floor')).toBe(false);
  });

  it('bind Depop Pricing Inspiration to Depop and Marketplace Insights to eBay', () => {
    expect(SOLD_DATA_LISTING_CONTEXT).toEqual({ depop_inspiration: 'depop', ebay_mi: 'ebay' });
    const unbound = { ...depopSold.payload, marketplace: undefined };
    const depop = soldDataPayloadSchemaFor('depop_inspiration');
    expect(depop.safeParse(depopSold.payload).success).toBe(true);
    expect(depop.safeParse(unbound).success).toBe(false);
    expect(depop.safeParse({ ...unbound, marketplace: 'mercari' }).success).toBe(false);
    const ebay = soldDataPayloadSchemaFor('ebay_mi');
    expect(ebay.safeParse({ ...unbound, marketplace: 'ebay' }).success).toBe(true);
    expect(ebay.safeParse(unbound).success).toBe(false);
    expect(ebay.safeParse(depopSold.payload).success).toBe(false);
    const own = soldDataPayloadSchemaFor('own_history');
    expect(own.safeParse(unbound).success).toBe(true);
    expect(own.safeParse({ ...unbound, marketplace: 'poshmark' }).success).toBe(true);
    // The shared rules still apply.
    expect(depop.safeParse({ ...depopSold.payload, low: usd(5000) }).success).toBe(false);
  });

  it('validate sold data and estimate payloads, including their order', () => {
    expect(soldDataPayloadSchema.safeParse(depopSold.payload).success).toBe(true);
    expect(soldDataPayloadSchema.safeParse({ ...depopSold.payload, low: usd(5000) }).success).toBe(
      false,
    );
    expect(soldDataPayloadSchema.safeParse({ ...depopSold.payload, sampleSize: 0 }).success).toBe(
      false,
    );
    expect(soldDataPayloadSchema.safeParse({ ...depopSold.payload, extra: 1 }).success).toBe(false);
    const estimate = base.estimate?.payload;
    expect(aiEstimatePayloadSchema.safeParse(estimate).success).toBe(true);
    expect(aiEstimatePayloadSchema.safeParse({ ...estimate, confidence: 1.2 }).success).toBe(false);
    expect(aiEstimatePayloadSchema.safeParse({ ...estimate, mid: usd(100) }).success).toBe(false);
    expect(
      aiEstimatePayloadSchema.safeParse({ ...estimate, low: { amountCents: 1.5, currency: 'USD' } })
        .success,
    ).toBe(false);
  });
});
