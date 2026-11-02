/**
 * The scan's price calibration (docs/features/thrift-scan.md, "Calibrated to the seller's
 * sales"): the AI estimate and the web's asking prices both run above what items really sell
 * for, so before either holds a range it is scaled by what the seller's own items sold for
 * against what their listings asked. Computed per account from its own sales, at the call, so
 * no seller's numbers live anywhere but in their own account.
 */
import type { HistorySale } from './own-history.ts';

export interface PriceCalibrationSettings {
  /**
   * What a seller's items are taken to sell for, as a share of their asking price, before they
   * have sales of their own: buyers' offers usually land a quarter under the ask.
   */
  readonly defaultSaleToAsking: number;
  /** How many sales the default counts as: a seller's own ratio takes over as their sales grow. */
  readonly priorSales: number;
  /** One sale's ratio is held to this range, so a typo'd ask or a bundle never moves it far. */
  readonly minSaleToAsking: number;
  readonly maxSaleToAsking: number;
}

/**
 * The defaults. 0.75 is about what resale buyers' offers come to; the household's 64 Depop sales
 * sold at a median of 0.75 of their asking price too (`npm run eval -- scan`, 2026-11-02).
 */
export const DEFAULT_PRICE_CALIBRATION_SETTINGS: PriceCalibrationSettings = {
  defaultSaleToAsking: 0.75,
  priorSales: 5,
  minSaleToAsking: 0.3,
  maxSaleToAsking: 1,
};

/** What the seller's items sell for against their asking price, and how many sales say so. */
export interface PriceCalibration {
  /** The median sale price over asking price of the seller's sales, drawn toward the default. */
  readonly saleToAsking: number;
  /** The sales with an asking price it rests on; 0 is the default alone. */
  readonly sales: number;
}

/**
 * The seller's calibration from their own sales: the median of each sale's price over its
 * listing's asking price (held to `minSaleToAsking`..`maxSaleToAsking`), weighed against the
 * default as if the default were `priorSales` more sales. Sales without an asking price are left
 * out. One ratio for all of the seller's sales: by category it measured worse on the backtest
 * (thrift-scan.md), since a category's few sales move its ratio more than its items differ.
 */
export function priceCalibration(
  sales: readonly HistorySale[],
  settings: PriceCalibrationSettings = DEFAULT_PRICE_CALIBRATION_SETTINGS,
): PriceCalibration {
  const ratios = sales
    .filter(
      (sale) =>
        sale.askingPriceCents !== undefined &&
        sale.askingPriceCents !== null &&
        sale.askingPriceCents > 0,
    )
    .map((sale) =>
      Math.min(
        settings.maxSaleToAsking,
        Math.max(settings.minSaleToAsking, sale.salePriceCents / (sale.askingPriceCents ?? 1)),
      ),
    )
    .sort((a, b) => a - b);
  const count = ratios.length;
  if (count === 0) return { saleToAsking: settings.defaultSaleToAsking, sales: 0 };
  const middle = Math.floor(count / 2);
  const median =
    count % 2 === 1
      ? (ratios[middle] ?? 0)
      : ((ratios[middle - 1] ?? 0) + (ratios[middle] ?? 0)) / 2;
  const saleToAsking =
    (count * median + settings.priorSales * settings.defaultSaleToAsking) /
    (count + settings.priorSales);
  return { saleToAsking, sales: count };
}

export interface PriceRange {
  readonly lowCents: number;
  readonly highCents: number;
}

/**
 * The AI estimate as what the item would sell for: the AI prices it like a listing would ask,
 * so it is scaled once by the seller's sale-to-asking ratio.
 */
export function calibratedAiEstimate<R extends PriceRange & { readonly midCents?: number }>(
  estimate: R,
  calibration: PriceCalibration,
): R {
  return scaled(estimate, calibration.saleToAsking);
}

/**
 * The web's asking prices as what the item would sell for: other sellers' asks run as far above
 * what the seller's own items list for as those listings run above what they sell for, so they
 * are scaled twice by the seller's ratio (on the backtest the web's asks were 2.2 times the sale
 * price, and the household's ratio squared is 0.56).
 */
export function calibratedWebAsks<R extends PriceRange>(asks: R, calibration: PriceCalibration): R {
  return scaled(asks, calibration.saleToAsking * calibration.saleToAsking);
}

/** The share as a whole percentage: 0.75 is "75%". */
export function calibrationPercent(share: number): string {
  return `${String(Math.round(share * 100))}%`;
}

function scaled<R extends PriceRange & { readonly midCents?: number }>(range: R, by: number): R {
  const scale = (cents: number) => Math.max(1, Math.round(cents * by));
  return {
    ...range,
    lowCents: scale(range.lowCents),
    highCents: scale(range.highCents),
    ...(range.midCents === undefined ? {} : { midCents: scale(range.midCents) }),
  };
}
