/**
 * The retail anchor, measured and not shipped (docs/features/thrift-scan.md, "The retail anchor:
 * measured, not shipped"): a resold item goes for well under its original retail price, at
 * least 40% under unless it is vintage or trending, so when the scan knows an item's retail
 * price (off its tag, or from the web), what it resells for could be estimated as that price
 * times a resale-to-retail ratio, held ahead of the web's asks and the AI estimate. The backtest
 * makes that call beside today's (`anchoredCall`) to see whether it judges better. It did not,
 * so the scan's call (`scanCall` in @listora/sourcing) is unchanged and this lives here only.
 */
import {
  decideCall,
  scanCall,
  type CallBasis,
  type CallConfidence,
  type ScanCall,
  type ScanCallInput,
  type ScanCallSettings,
} from '@listora/sourcing';

export interface ResaleRatioSettings {
  /** The low end of the ratio before a seller has sales of a known retail price. */
  readonly defaultLow: number;
  /**
   * The high end before a seller has sales, and the most either end can ever be: resold items
   * go for at least 40% under retail. A seller's own sales only lower it.
   */
  readonly maxRatio: number;
  /** How many sales the default counts as: the seller's own ratio takes over as their sales grow. */
  readonly priorSales: number;
  /** One sale's ratio is held to this range, so a wrong retail price never moves it far. */
  readonly minSaleToRetail: number;
  readonly maxSaleToRetail: number;
}

/**
 * 20%-60% of retail: the rule of thumb (at least 40% off) with room for the far bigger
 * markdowns of mall brands, weighed as 5 sales like the price calibration.
 */
export const DEFAULT_RESALE_RATIO_SETTINGS: ResaleRatioSettings = {
  defaultLow: 0.2,
  maxRatio: 0.6,
  priorSales: 5,
  minSaleToRetail: 0.02,
  maxSaleToRetail: 1,
};

/** What the seller's items resell for as a share of their retail price, and what says so. */
export interface ResaleRatio {
  /** The low and high quartile of the seller's sale-to-retail ratios, drawn toward the default. */
  readonly low: number;
  readonly high: number;
  /** The seller's sales of a known retail price it rests on; 0 is the default alone. */
  readonly sales: number;
}

/** One sale as the ratio reads it: what it sold for, and its retail price where known. */
export interface RetailSale {
  readonly salePriceCents: number;
  readonly retailCents?: number | undefined;
}

/** One sale's price over its retail price, held to the settings' range. */
export function saleToRetail(
  salePriceCents: number,
  retailCents: number,
  settings: ResaleRatioSettings = DEFAULT_RESALE_RATIO_SETTINGS,
): number {
  return Math.min(
    settings.maxSaleToRetail,
    Math.max(settings.minSaleToRetail, salePriceCents / retailCents),
  );
}

/**
 * The seller's resale-to-retail ratio from their sales whose retail price is known: the low and
 * high quartile of each sale's price over its retail price, each weighed against the default as
 * if the default were `priorSales` more sales, and neither above `maxRatio`.
 */
export function resaleRatio(
  sales: readonly RetailSale[],
  settings: ResaleRatioSettings = DEFAULT_RESALE_RATIO_SETTINGS,
): ResaleRatio {
  const ratios = sales
    .flatMap((sale) =>
      sale.retailCents === undefined || sale.retailCents <= 0
        ? []
        : [saleToRetail(sale.salePriceCents, sale.retailCents, settings)],
    )
    .sort((a, b) => a - b);
  const count = ratios.length;
  const drawn = (own: number, fallback: number) =>
    (count * own + settings.priorSales * fallback) / (count + settings.priorSales);
  const high = Math.min(settings.maxRatio, drawn(quantile(ratios, 0.75), settings.maxRatio));
  const low = Math.min(high, drawn(quantile(ratios, 0.25), settings.defaultLow));
  return { low, high, sales: count };
}

/** The retail price's middle (a web price can be a range across models) times each end. */
export function retailAnchoredRange(
  retail: { readonly lowCents: number; readonly highCents: number },
  ratio: ResaleRatio,
): { lowCents: number; highCents: number } {
  const middle = (retail.lowCents + retail.highCents) / 2;
  return {
    lowCents: Math.max(1, Math.round(middle * ratio.low)),
    highCents: Math.max(1, Math.round(middle * ratio.high)),
  };
}

/** The read says the item is vintage: its era or its style ("vintage 1990s", "90s vintage"). */
export function isVintage(read: {
  readonly era?: string | null | undefined;
  readonly style?: string | null | undefined;
}): boolean {
  return [read.era, read.style].some(
    (text) => text !== undefined && text !== null && /\bvintage\b/i.test(text),
  );
}

/** Where the backtest's call rests: the scan's bases, and the retail anchor's. */
export type BacktestBasis = CallBasis | 'retail';
export type BacktestCall = Omit<ScanCall, 'basis'> & { readonly basis: BacktestBasis };

/**
 * The call with the retail anchor: today's call (`scanCall`), except that where it would rest on
 * the web's asks or the AI estimate (or nothing), a known retail price holds the range at the
 * ratio instead, unless the item is vintage or a marketplace's sold listings go above retail.
 * Medium confidence only with a sure read and a ratio from at least `minComparisons` of the
 * seller's own sales, never high; the payouts and the call follow `decideCall`, the rule every
 * call shares.
 */
export function anchoredCall(
  input: ScanCallInput,
  ratio: ResaleRatio,
  vintage: boolean,
  settings: ScanCallSettings,
): BacktestCall {
  const today = scanCall(input, settings);
  const retail = input.retail;
  if (
    (today.basis !== 'web_info' && today.basis !== 'ai_estimate' && today.basis !== 'none') ||
    retail === undefined ||
    retail.highCents <= 0 ||
    vintage ||
    soldAboveRetail(input, retail.highCents)
  ) {
    return today;
  }
  const range = retailAnchoredRange(retail, ratio);
  const confidence: CallConfidence =
    input.identityConfidence >= settings.highIdentityConfidence &&
    ratio.sales >= settings.minComparisons
      ? 'medium'
      : 'low';
  const conservativePayoutCents = payout(range.lowCents, input.fees);
  const optimisticPayoutCents = payout(range.highCents, input.fees);
  const flagged =
    input.flags.visibleDamage || input.flags.lotOrBundle || input.flags.counterfeitProne;
  return {
    ...today,
    call: decideCall(
      { conservativePayoutCents, optimisticPayoutCents, confidence, flagged },
      settings,
    ),
    confidence,
    basis: 'retail',
    range,
    conservativePayoutCents,
    optimisticPayoutCents,
    basedOn: `Retail, resale about ${String(Math.round(ratio.low * 100))}-${String(Math.round(ratio.high * 100))}% of it`,
  };
}

function soldAboveRetail(input: ScanCallInput, retailHighCents: number): boolean {
  return (input.markets ?? []).some(
    (market) =>
      market.sold !== undefined &&
      market.sold.count > 0 &&
      (market.sold.lowCents + market.sold.highCents) / 2 > retailHighCents,
  );
}

function payout(priceCents: number, fees: (priceCents: number) => number): number {
  return Math.max(0, priceCents - fees(priceCents));
}

/** The `q` quantile of sorted values, linear between the two nearest; 0 for none. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const lower = sorted[below] ?? 0;
  const upper = sorted[Math.min(below + 1, sorted.length - 1)] ?? lower;
  return lower + (upper - lower) * (position - below);
}
