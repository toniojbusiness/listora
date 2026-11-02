/**
 * The scan card's three prices (docs/features/thrift-scan.md, "Three prices"): what to list the
 * item at, what it realistically sells for, and what it goes for fast. All three come from the
 * range the call already rests on, with no further AI call or lookup, so the scan is as fast as
 * before.
 */
import { DEFAULT_PRICE_CALIBRATION_SETTINGS, type PriceCalibration } from './calibration.ts';

export interface ScanPrices {
  /** The asking price: the realistic sale over the seller's sale-to-asking ratio, room for offers. */
  readonly listAtCents: number;
  /** What the item is expected to sell for: the middle of what the call rests on. */
  readonly realisticCents: number;
  /** The low end it would likely go at quickly: the range's low end. */
  readonly fastCents: number;
}

/**
 * The three prices from the call's range and its expected sale (`realisticCents`, inside the
 * range), each rounded to a price a seller would type: whole dollars under $20, $5 steps under
 * $100, $10 steps above. The fast sale rounds down and the list price up, so the three never
 * cross. The list price is the realistic sale over the seller's sale-to-asking ratio
 * (`priceCalibration`), or over the 75% default for a seller with no sales of their own.
 */
export function scanPrices(
  range: { readonly lowCents: number; readonly highCents: number },
  realisticCents: number,
  calibration: PriceCalibration | undefined,
): ScanPrices {
  const ratio = calibration?.saleToAsking ?? DEFAULT_PRICE_CALIBRATION_SETTINGS.defaultSaleToAsking;
  const expected = Math.min(range.highCents, Math.max(range.lowCents, realisticCents));
  const realistic = friendlyPrice(expected, 'nearest');
  const fast = Math.min(realistic, friendlyPrice(range.lowCents, 'down'));
  const listAt = Math.max(realistic, friendlyPrice(expected / ratio, 'up'));
  return { listAtCents: listAt, realisticCents: realistic, fastCents: fast };
}

/**
 * A price a seller would type: whole dollars under $20, $5 steps under $100, then $10 steps,
 * never under $1.
 */
export function friendlyPrice(cents: number, direction: 'down' | 'nearest' | 'up'): number {
  const step = cents < 2_000 ? 100 : cents < 10_000 ? 500 : 1_000;
  const steps = cents / step;
  const rounded =
    direction === 'down'
      ? Math.floor(steps + 1e-9)
      : direction === 'up'
        ? Math.ceil(steps - 1e-9)
        : Math.round(steps);
  return Math.max(100, rounded * step);
}
