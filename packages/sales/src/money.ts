/**
 * A sale's money, from its rows: what the buyer paid, the fees, the payout, and the profit and
 * return on investment of the order and of each item in it (docs/features/sales.md). Pure, in
 * integer cents.
 *
 * - **Payout.** `netProceeds` is the sale price plus the shipping the buyer paid, minus every
 *   fee line (a refunded fee is a negative line). It is unknown until the sale has fee lines.
 * - **Profit.** `profit` is the payout minus what the seller paid to ship outside the payout
 *   (`shippingCost`, zero until known) minus the items' cost; unknown until the payout is known
 *   and every item has a cost. ROI is the profit over the cost, in basis points (12550 is
 *   125.5%), and unknown for a zero cost.
 * - **Estimates.** `feesEstimated` is true while any fee line is an estimate from a fee table;
 *   the payout and profit are then estimates too.
 * - **Bundles.** An order-level amount (shipping charged, an order-level fee, the shipping cost)
 *   is split across the items in proportion to each item's sale price (equally when every price
 *   is zero), largest remainder first, so the items' shares add up to the order's amount
 *   exactly. A fee charged on one item is that item's alone.
 */
import type { FeeSource } from '@listora/db';

export interface SaleMoneyInput {
  shippingChargedCents: number;
  /** Null until known; counts as zero. */
  shippingCostCents: number | null;
  items: readonly {
    saleItemId: string;
    itemId: string;
    salePriceCents: number;
    /** The item's cost; null when the seller never entered one. */
    costCents: number | null;
  }[];
  fees: readonly {
    /** The item the fee was charged on; null for an order-level fee. */
    saleItemId: string | null;
    amountCents: number;
    source: FeeSource;
  }[];
}

export interface MoneyBreakdown {
  salePriceCents: number;
  shippingChargedCents: number;
  feesCents: number;
  shippingCostCents: number;
  /** The sum of the items' costs; null when one has none. */
  costCents: number | null;
  /** Null until the sale has fee lines. */
  netProceedsCents: number | null;
  profitCents: number | null;
  roiBasisPoints: number | null;
}

export interface SaleMoney extends MoneyBreakdown {
  /** True while any fee line is an estimate. */
  feesEstimated: boolean;
  /** Each item's share, keyed by item id. */
  items: Map<string, MoneyBreakdown>;
}

export function saleMoney(input: SaleMoneyInput): SaleMoney {
  const prices = input.items.map((item) => item.salePriceCents);
  const shippingShares = splitByWeight(input.shippingChargedCents, prices);
  const costShares = splitByWeight(input.shippingCostCents ?? 0, prices);
  const orderFees = input.fees
    .filter(
      (fee) =>
        fee.saleItemId === null || !input.items.some((item) => item.saleItemId === fee.saleItemId),
    )
    .reduce((sum, fee) => sum + fee.amountCents, 0);
  const orderFeeShares = splitByWeight(orderFees, prices);
  const hasFees = input.fees.length > 0;

  const items = new Map<string, MoneyBreakdown>();
  input.items.forEach((item, index) => {
    const ownFees = input.fees
      .filter((fee) => fee.saleItemId === item.saleItemId)
      .reduce((sum, fee) => sum + fee.amountCents, 0);
    items.set(
      item.itemId,
      breakdown({
        salePriceCents: item.salePriceCents,
        shippingChargedCents: shippingShares[index] ?? 0,
        feesCents: ownFees + (orderFeeShares[index] ?? 0),
        shippingCostCents: costShares[index] ?? 0,
        costCents: item.costCents,
        hasFees,
      }),
    );
  });

  const costs = input.items.map((item) => item.costCents);
  return {
    ...breakdown({
      salePriceCents: sum(prices),
      shippingChargedCents: input.shippingChargedCents,
      feesCents: input.fees.reduce((total, fee) => total + fee.amountCents, 0),
      shippingCostCents: input.shippingCostCents ?? 0,
      costCents: costs.some((cost) => cost === null) ? null : sum(costs as number[]),
      hasFees,
    }),
    feesEstimated: input.fees.some((fee) => fee.source === 'estimated'),
    items,
  };
}

function breakdown(parts: {
  salePriceCents: number;
  shippingChargedCents: number;
  feesCents: number;
  shippingCostCents: number;
  costCents: number | null;
  hasFees: boolean;
}): MoneyBreakdown {
  const netProceedsCents = parts.hasFees
    ? parts.salePriceCents + parts.shippingChargedCents - parts.feesCents
    : null;
  const profitCents =
    netProceedsCents === null || parts.costCents === null
      ? null
      : netProceedsCents - parts.shippingCostCents - parts.costCents;
  return {
    salePriceCents: parts.salePriceCents,
    shippingChargedCents: parts.shippingChargedCents,
    feesCents: parts.feesCents,
    shippingCostCents: parts.shippingCostCents,
    costCents: parts.costCents,
    netProceedsCents,
    profitCents,
    roiBasisPoints:
      profitCents === null || parts.costCents === null || parts.costCents === 0
        ? null
        : roundHalfAwayFromZero((profitCents * 10_000) / parts.costCents),
  };
}

/**
 * Splits `amount` into one share per weight, in proportion to the weights (equally when they are
 * all zero), so that the shares add up to `amount` exactly: each share is rounded down, and the
 * cents left over go to the shares with the largest remainders, earliest first on a tie.
 */
export function splitByWeight(amount: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const total = sum(weights);
  const effective = total === 0 ? weights.map(() => 1) : weights;
  const whole = total === 0 ? weights.length : total;
  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);
  const exact = effective.map((weight) => (magnitude * weight) / whole);
  const shares = exact.map((value) => Math.floor(value));
  let left = magnitude - sum(shares);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left === 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  return shares.map((share) => share * sign);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}
