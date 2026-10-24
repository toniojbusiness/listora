/**
 * The cost floor ("Don't sell below"): the lowest price whose estimated payout covers the
 * item's cost, the seller's shipping, and their minimum profit. Fees grow with the price, so
 * the floor is the least price P with P = cost + fees(P) + shipping + minimumProfit, and the
 * breakdown always adds up to the floor exactly.
 */
import { assertCents, estimateFeesCents, type FeeTable } from './fees.ts';

/**
 * The account's actual fees on recent sales of one marketplace, compared with what the fee
 * table estimates for the same sale prices. Fee estimates are scaled by their ratio.
 */
export interface FeeCalibration {
  /** How many sales the totals cover. */
  readonly sales: number;
  readonly actualFeesCents: number;
  readonly estimatedFeesCents: number;
}

/** A recent sale of one marketplace: its item price and the actual fees charged on it. */
export interface ObservedSale {
  readonly salePriceCents: number;
  readonly actualFeesCents: number;
}

/** Fewer sales than this say too little about an account's fees to replace the table. */
export const MIN_SALES_FOR_FEE_CALIBRATION = 3;

/**
 * Actual fees more than this many times the table's estimate point at bad order data (a fee
 * attributed to the wrong sale), not at the account's real rate, so they are not used.
 */
export const MAX_FEE_CALIBRATION_RATIO = 3;

/**
 * Compares actual fees with the table's estimate. Sales with a refund that leaves their fees
 * negative are skipped. Undefined when too few sales remain, when the table estimates no fees
 * for them (nothing to scale), or when the ratio is implausible.
 */
export function calibrateFees(
  table: FeeTable,
  sales: readonly ObservedSale[],
): FeeCalibration | undefined {
  const usable = sales.filter((sale) => sale.actualFeesCents >= 0);
  if (usable.length < MIN_SALES_FOR_FEE_CALIBRATION) return undefined;
  let actualFeesCents = 0;
  let estimatedFeesCents = 0;
  for (const sale of usable) {
    assertCents(sale.actualFeesCents, 'actualFeesCents');
    actualFeesCents += sale.actualFeesCents;
    estimatedFeesCents += estimateFeesCents(table, sale.salePriceCents);
  }
  if (estimatedFeesCents === 0) return undefined;
  if (actualFeesCents > estimatedFeesCents * MAX_FEE_CALIBRATION_RATIO) return undefined;
  return { sales: usable.length, actualFeesCents, estimatedFeesCents };
}

/** The fee estimate for one price: the table's, scaled by a calibration when there is one. */
export function feeEstimator(
  table: FeeTable,
  calibration: FeeCalibration | undefined,
): (priceCents: number) => number {
  if (!calibration) return (priceCents) => estimateFeesCents(table, priceCents);
  const actual = BigInt(calibration.actualFeesCents);
  const estimated = BigInt(calibration.estimatedFeesCents);
  return (priceCents) => {
    const tableFees = BigInt(estimateFeesCents(table, priceCents));
    // Rounded up, like every fee estimate.
    return Number((tableFees * actual + estimated - 1n) / estimated);
  };
}

export interface FloorInput {
  readonly costCents: number;
  readonly shippingCents: number;
  readonly minimumProfitCents: number;
}

export interface Floor {
  readonly floorPriceCents: number;
  readonly estimatedFeesCents: number;
}

/** Fee schedules converge in a handful of steps; this many means a schedule is broken. */
const MAX_FLOOR_ITERATIONS = 1_000;

/**
 * Solves P = required + fees(P) from below. `fees` must never decrease as the price rises
 * (every real fee schedule is like that, and a test checks each table): then each step stays
 * at or below the least solution, and the first fixed point reached is the floor.
 */
export function computeFloor(input: FloorInput, fees: (priceCents: number) => number): Floor {
  assertCents(input.costCents, 'costCents');
  assertCents(input.shippingCents, 'shippingCents');
  assertCents(input.minimumProfitCents, 'minimumProfitCents');
  const required = input.costCents + input.shippingCents + input.minimumProfitCents;
  let price = required;
  for (let step = 0; step < MAX_FLOOR_ITERATIONS; step += 1) {
    const estimatedFeesCents = fees(price);
    const next = required + estimatedFeesCents;
    if (next === price) return { floorPriceCents: price, estimatedFeesCents };
    if (next < price || !Number.isSafeInteger(next)) {
      throw new Error('the fee schedule decreases as the price rises or overflows');
    }
    price = next;
  }
  throw new Error(`the floor did not converge in ${String(MAX_FLOOR_ITERATIONS)} steps`);
}
