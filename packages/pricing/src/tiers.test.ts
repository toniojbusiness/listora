import { describe, expect, it } from 'vitest';

import type { AiEstimatePayload } from './snapshots.ts';
import { priceTiers } from './tiers.ts';

const usd = (amountCents: number) => ({ amountCents, currency: 'USD' as const });
const estimate: AiEstimatePayload = {
  analysisId: '0190a2b8-0000-7000-8000-000000000001',
  low: usd(2000),
  mid: usd(3000),
  high: usd(4500),
  confidence: 0.6,
};

describe('priceTiers', () => {
  it('derives quick sale, recommended, and higher profit from the estimate', () => {
    expect(priceTiers(estimate, 1500)).toEqual([
      {
        tier: 'quick_sale',
        price: usd(2000),
        basis: 'ai_estimate',
        label: 'Quick sale (AI estimate)',
      },
      {
        tier: 'recommended',
        price: usd(3000),
        basis: 'ai_estimate',
        label: 'Recommended (AI estimate)',
      },
      {
        tier: 'higher_profit',
        price: usd(4500),
        basis: 'ai_estimate',
        label: 'Higher profit (AI estimate)',
      },
    ]);
  });

  it('never goes below the floor, and says when the floor set the price', () => {
    const tiers = priceTiers(estimate, 3200);
    expect(
      tiers.map((tier) => [tier.tier, tier.price.amountCents, tier.basis, tier.label]),
    ).toEqual([
      ['quick_sale', 3200, 'cost_floor', 'Quick sale (cost floor)'],
      ['recommended', 3200, 'cost_floor', 'Recommended (cost floor)'],
      ['higher_profit', 4500, 'ai_estimate', 'Higher profit (AI estimate)'],
    ]);
    for (const tier of priceTiers(estimate, 9999)) expect(tier.price.amountCents).toBe(9999);
  });

  it('uses the estimate as is without a floor', () => {
    expect(priceTiers(estimate, undefined).map((tier) => tier.price.amountCents)).toEqual([
      2000, 3000, 4500,
    ]);
  });

  it('has no tiers without an estimate, even with a floor', () => {
    expect(priceTiers(undefined, 1500)).toEqual([]);
  });
});
