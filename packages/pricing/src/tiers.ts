/**
 * The three price tiers. They come from the AI estimate's low, mid, and high values and are
 * never below the floor: a tier the estimate puts under the floor is raised to it, and its
 * label then says so. Every tier is labeled with its basis, so none reads as sold data.
 */
import type { PriceTier, PriceTierName } from '@listora/api-contract';

import type { AiEstimatePayload } from './snapshots.ts';

const TIER_NAMES: Readonly<Record<PriceTierName, string>> = {
  quick_sale: 'Quick sale',
  recommended: 'Recommended',
  higher_profit: 'Higher profit',
};

/**
 * Tiers from `estimate`, each at least `floorCents` when there is a floor. Empty without an
 * estimate: a floor alone is shown as the floor, not as a suggestion.
 */
export function priceTiers(
  estimate: AiEstimatePayload | undefined,
  floorCents: number | undefined,
): PriceTier[] {
  if (!estimate) return [];
  const values: Readonly<Record<PriceTierName, number>> = {
    quick_sale: estimate.low.amountCents,
    recommended: estimate.mid.amountCents,
    higher_profit: estimate.high.amountCents,
  };
  return (Object.keys(TIER_NAMES) as PriceTierName[]).map((tier) => {
    const estimated = values[tier];
    const raised = floorCents !== undefined && estimated < floorCents;
    return {
      tier,
      price: { amountCents: raised ? floorCents : estimated, currency: estimate.low.currency },
      basis: raised ? 'cost_floor' : 'ai_estimate',
      label: `${TIER_NAMES[tier]} (${raised ? 'cost floor' : 'AI estimate'})`,
    };
  });
}
