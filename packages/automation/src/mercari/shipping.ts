/**
 * How Mercari listings ship (docs/mercari.md, "Shipping"). Mercari's listing form needs a
 * shipping choice; Listora picks Mercari's prepaid label, paid by the buyer, with the package
 * weight of the item's category (categories.ts). Listora does not know an item's weight yet, so
 * each category's weight is a generous upper bound: a label that is too light is adjusted and
 * charged to the seller, one that is too heavy only costs the buyer a little more.
 */
import type { JsonObject } from '@listora/db';

/** The weight classes of Mercari's prepaid label, as its form names them (`Up to 8 oz`). */
export const SHIPPING_WEIGHTS = [
  '4 oz',
  '8 oz',
  '12 oz',
  '1 lb',
  '2 lb',
  '3 lb',
  '5 lb',
  '10 lb',
] as const;
export type ShippingWeight = (typeof SHIPPING_WEIGHTS)[number];

export interface MercariShipping extends JsonObject {
  /** Who pays the label: the buyer, on top of the price. */
  payer: 'buyer';
  /** Mercari's prepaid label. */
  method: 'prepaid_label';
  weight: ShippingWeight;
}

/** The form's label for a weight class. */
export function weightLabel(weight: ShippingWeight): string {
  return `Up to ${weight}`;
}
