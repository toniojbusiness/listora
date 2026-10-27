/**
 * How Mercari listings ship (docs/features/mercari.md, "Shipping"). Mercari's listing form needs
 * a shipping choice; Listora picks Mercari's prepaid label, paid by the buyer, and keeps the
 * label class Mercari's form recommends for the item (it suggests one from the category and the
 * listing). Listora does not know an item's weight, so it never picks a class itself.
 */
import type { JsonObject } from '@listora/db';

export interface MercariShipping extends JsonObject {
  /** Who pays the label: the buyer, on top of the price. */
  payer: 'buyer';
  /** Mercari's prepaid label. */
  method: 'prepaid_label';
}
