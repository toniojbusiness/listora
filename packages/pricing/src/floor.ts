/**
 * The cost floor ("Don't sell below"): the lowest price whose estimated payout covers the
 * item's cost, the seller's shipping, and their minimum profit. Fees grow with the price, so
 * the floor is the least price P with P = cost + fees(P) + shipping + minimumProfit, and the
 * breakdown always adds up to the floor exactly.
 */
import type { KnownMarketplace } from '@listora/api-contract';

import { feeTableForSale, FEE_TABLES } from './fee-tables.ts';
import { assertCents, estimateFeesCents, type EstimatedFeeKind, type FeeTable } from './fees.ts';

/**
 * The account's actual fees on recent sales of one marketplace, compared with what the fee
 * tables in effect on those sales' days estimate for the same sale prices. Fee estimates are
 * scaled by their ratio.
 */
export interface FeeCalibration {
  /** How many sales the totals cover. */
  readonly sales: number;
  readonly actualFeesCents: number;
  readonly estimatedFeesCents: number;
}

/** One actual `fee_line` of a sale. Negative for a refunded fee. */
export interface ObservedFee {
  readonly kind: EstimatedFeeKind;
  readonly amountCents: number;
}

/** A recent sale of one marketplace: when it sold, its item price, and its actual fees. */
export interface ObservedSale {
  readonly soldAt: Date;
  readonly salePriceCents: number;
  readonly fees: readonly ObservedFee[];
}

/** Fewer sales than this say too little about an account's fees to replace the table. */
export const MIN_SALES_FOR_FEE_CALIBRATION = 3;

/**
 * Actual fees more than this many times the table's estimate point at bad order data (a fee
 * attributed to the wrong sale), not at the account's real rate, so they are not used.
 */
export const MAX_FEE_CALIBRATION_RATIO = 3;

/**
 * Actual fees under this share of the table's estimate point at bad order data too (fee lines
 * missing or netted down), and using them would put the floor below what the seller nets.
 */
export const MIN_FEE_CALIBRATION_RATIO = 1 / 3;

/**
 * Compares actual fees with the estimate of the table in effect on each sale's day
 * (`feeTableForSale`), so a fee change is not masked by sales at the old rate. Only sales
 * with complete fee data count (`hasCompleteFees`). Undefined when too few sales remain, when
 * the tables estimate no fees for them (nothing to scale), or when the ratio is implausible.
 */
export function calibrateFees(
  marketplace: KnownMarketplace,
  sales: readonly ObservedSale[],
  tables: readonly FeeTable[] = FEE_TABLES,
): FeeCalibration | undefined {
  let usable = 0;
  let actualFeesCents = 0;
  let estimatedFeesCents = 0;
  for (const sale of sales) {
    const table = feeTableForSale(marketplace, sale.soldAt, tables);
    if (!hasCompleteFees(table, sale)) continue;
    usable += 1;
    for (const fee of sale.fees) actualFeesCents += fee.amountCents;
    estimatedFeesCents += estimateFeesCents(table, sale.salePriceCents);
  }
  if (usable < MIN_SALES_FOR_FEE_CALIBRATION || estimatedFeesCents === 0) return undefined;
  const ratio = actualFeesCents / estimatedFeesCents;
  if (ratio < MIN_FEE_CALIBRATION_RATIO || ratio > MAX_FEE_CALIBRATION_RATIO) return undefined;
  return { sales: usable, actualFeesCents, estimatedFeesCents };
}

/**
 * Whether a sale's actual fees can stand for what it was charged: every fee kind the table
 * charges has a line, and no line is a zero-amount placeholder or a refund (negative).
 */
function hasCompleteFees(table: FeeTable, sale: ObservedSale): boolean {
  for (const fee of sale.fees) {
    if (fee.amountCents <= 0) return false;
    assertCents(fee.amountCents, 'amountCents');
  }
  return table.rules.every((rule) => sale.fees.some((fee) => fee.kind === rule.kind));
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
