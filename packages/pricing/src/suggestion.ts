/**
 * Builds the API's `PricingSuggestion` from an item's cost, its pricing snapshots, and the fee
 * tables. Pure: the API loads the inputs and returns the result. The result always passes the
 * label guard; `buildPricingSuggestion` checks it before returning.
 */
import type {
  KnownMarketplace,
  MarketplaceFloor,
  PricingSuggestion,
  SoldComparables,
} from '@listora/api-contract';

import { feeTableFor } from './fee-tables.ts';
import { computeFloor, feeEstimator, type FeeCalibration } from './floor.ts';
import { AI_ESTIMATE_LABEL, labelGuardViolations, NO_SOLD_DATA_MESSAGE } from './labels.ts';
import { researchLinks } from './research-links.ts';
import type { AiEstimateSnapshot, SoldDataSnapshot } from './snapshots.ts';
import { ORDER_DATA_MAY_ADJUST_FEES } from './sources.ts';
import { priceTiers } from './tiers.ts';

export interface PricingInput {
  readonly itemId: string;
  readonly currency: 'USD';
  /** Absent when the user has not entered the item's cost: then there are no floors. */
  readonly costCents: number | undefined;
  readonly shippingCents: number;
  readonly minimumProfitCents: number;
  /** The marketplaces to compute a floor for. */
  readonly marketplaces: readonly KnownMarketplace[];
  /** The current analysis's estimate, if the item has one. */
  readonly estimate: AiEstimateSnapshot | undefined;
  /** Current real sold data, any source. */
  readonly soldData: readonly SoldDataSnapshot[];
  /**
   * The account's actual fees per marketplace. A calibration for a marketplace whose order
   * data may not feed prices (`ORDER_DATA_MAY_ADJUST_FEES`) is ignored.
   */
  readonly feeCalibrations: Partial<Readonly<Record<KnownMarketplace, FeeCalibration>>>;
  /** Search words for the research links (`researchQuery`). */
  readonly researchQuery: string | undefined;
  readonly now: Date;
}

export class LabelGuardError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`pricing suggestion breaks the label rules: ${violations.join('; ')}`);
    this.name = 'LabelGuardError';
    this.violations = violations;
  }
}

export function buildPricingSuggestion(input: PricingInput): PricingSuggestion {
  const floors = input.costCents === undefined ? [] : marketplaceFloors(input, input.costCents);
  const highestFloor = floors.reduce<number | undefined>(
    (highest, floor) => Math.max(highest ?? 0, floor.floorPrice.amountCents),
    undefined,
  );
  const soldComparables = input.soldData.map(soldComparablesView);
  const estimate = input.estimate?.payload;

  const suggestion: PricingSuggestion = {
    itemId: input.itemId,
    ...(soldComparables.length > 0
      ? { soldComparables }
      : { noSoldDataMessage: NO_SOLD_DATA_MESSAGE }),
    ...(estimate
      ? {
          aiEstimate: {
            label: AI_ESTIMATE_LABEL,
            low: estimate.low,
            mid: estimate.mid,
            high: estimate.high,
            confidence: estimate.confidence,
          },
        }
      : {}),
    // Sold data never sets the tiers: Depop's may be shown only in its own listing, eBay's
    // may not be used to model prices, and no other source exists yet.
    tiers: priceTiers(estimate, highestFloor),
    floors,
    researchLinks: researchLinks(input.researchQuery),
    generatedAt: input.now.toISOString(),
  };

  const violations = labelGuardViolations(suggestion);
  if (violations.length > 0) throw new LabelGuardError(violations);
  return suggestion;
}

function marketplaceFloors(input: PricingInput, costCents: number): MarketplaceFloor[] {
  return input.marketplaces.map((marketplace) => {
    const table = feeTableFor(marketplace, input.now);
    const calibration = ORDER_DATA_MAY_ADJUST_FEES[marketplace]
      ? input.feeCalibrations[marketplace]
      : undefined;
    const floor = computeFloor(
      {
        costCents,
        shippingCents: input.shippingCents,
        minimumProfitCents: input.minimumProfitCents,
      },
      feeEstimator(table, calibration),
    );
    const money = (amountCents: number) => ({ amountCents, currency: input.currency });
    return {
      marketplace,
      floorPrice: money(floor.floorPriceCents),
      breakdown: {
        cost: money(costCents),
        estimatedFees: money(floor.estimatedFeesCents),
        shipping: money(input.shippingCents),
        minimumProfit: money(input.minimumProfitCents),
      },
      feeTableVersion: table.version,
      feeSource: calibration ? 'actual_fees' : 'fee_table',
    };
  });
}

function soldComparablesView(snapshot: SoldDataSnapshot): SoldComparables {
  const { payload } = snapshot;
  return {
    source: snapshot.source,
    ...(payload.marketplace === undefined ? {} : { marketplace: payload.marketplace }),
    label: payload.label,
    sampleSize: payload.sampleSize,
    low: payload.low,
    median: payload.median,
    high: payload.high,
    fetchedAt: snapshot.fetchedAt.toISOString(),
  };
}
