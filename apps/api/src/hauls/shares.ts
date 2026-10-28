/**
 * A haul's cost split over its items (docs/features/hauls.md), in integer cents. The total over
 * the count, rounded down, is every item's base share; the leftover cents go one each to the
 * items that joined first, so a full haul's shares add back up to the total exactly.
 */

/** The share of the item at `place` (0: the first to join) in a haul of `count` items. */
export function haulShare(totalCents: number, count: number, place: number): number {
  assertHaul(totalCents, count);
  if (!Number.isSafeInteger(place) || place < 0) {
    throw new RangeError('A place in a haul is a whole number from 0');
  }
  const base = Math.floor(totalCents / count);
  return base + (place < totalCents % count ? 1 : 0);
}

/** Every item's share in joining order, for a haul of `count` items: they add up to the total. */
export function haulShares(totalCents: number, count: number): number[] {
  return Array.from({ length: count }, (_, place) => haulShare(totalCents, count, place));
}

/** The total over the count to the nearest cent, half up: the "$1.67 each" the app shows. */
export function eachCostCents(totalCents: number, count: number): number {
  assertHaul(totalCents, count);
  return Math.floor((2 * totalCents + count) / (2 * count));
}

function assertHaul(totalCents: number, count: number): void {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new RangeError('A haul total is whole cents, not negative');
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('A haul has at least one item');
  }
}
