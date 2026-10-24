/**
 * Marketplace seller-fee schedules as data, and the integer math that applies them.
 *
 * A schedule is a sum of rules (a final value fee, a per-order fee, a commission). Each rule
 * is piecewise linear in the sale price: the band containing the price charges a fixed amount
 * plus a percentage of the price above the band's marginal start. Every rule's percentage is
 * rounded up to the next cent, so an estimate never understates a fee.
 */
import type { KnownMarketplace } from '@listora/api-contract';

/** The `fee_line` kinds a schedule can estimate. */
export type EstimatedFeeKind = 'marketplace' | 'payment';

export interface FeeBand {
  /** The band applies from this sale price (inclusive) up to the next band's `fromCents`. */
  readonly fromCents: number;
  readonly fixedCents: number;
  /** Hundredths of a percent: 1360 is 13.6%. */
  readonly basisPoints: number;
  /** The percentage applies to the price above this amount (default 0, the whole price). */
  readonly marginalFromCents?: number;
}

export interface FeeRule {
  /** What the marketplace calls it, for example "Final value fee". */
  readonly name: string;
  readonly kind: EstimatedFeeKind;
  /** Sorted by `fromCents`; the first band starts at 0. */
  readonly bands: readonly FeeBand[];
}

export interface FeeTable {
  readonly marketplace: KnownMarketplace;
  /** Stable id stored with every floor, for example `poshmark-us-2025-10-01`. */
  readonly version: string;
  /** The first day (UTC, `YYYY-MM-DD`) the marketplace charged this schedule. */
  readonly effectiveFrom: string;
  /** The official page the schedule was read from. */
  readonly sourceUrl: string;
  /** The day (UTC, `YYYY-MM-DD`) someone last checked `sourceUrl` against this table. */
  readonly verifiedOn: string;
  /** False when the official page could not be read; the table is then a best estimate. */
  readonly verified: boolean;
  /** What the estimate leaves out or assumes. */
  readonly notes: string;
  readonly rules: readonly FeeRule[];
}

const BASIS_POINTS_PER_WHOLE = 10_000;

/** The estimated fees, in cents, for one item sold at `priceCents`. */
export function estimateFeesCents(table: FeeTable, priceCents: number): number {
  assertCents(priceCents, 'priceCents');
  let total = 0;
  for (const rule of table.rules) total += ruleFeeCents(rule, priceCents);
  return total;
}

function ruleFeeCents(rule: FeeRule, priceCents: number): number {
  const band = rule.bands.findLast((candidate) => candidate.fromCents <= priceCents);
  if (!band) throw new Error(`${rule.name} has no band for ${String(priceCents)} cents`);
  const base = Math.max(0, priceCents - (band.marginalFromCents ?? 0));
  return band.fixedCents + ceilDiv(base * band.basisPoints, BASIS_POINTS_PER_WHOLE);
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

export function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents`);
  }
}
