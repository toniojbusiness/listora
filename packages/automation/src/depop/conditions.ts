/**
 * Depop's item conditions for Listora's canonical ones. Depop grades items Brand new, Like new,
 * Used - Excellent, Used - Good, or Used - Fair: the Selling API's `condition` values
 * (`brand_new`, `used_like_new`, ...), which the listing form offers as one radio group with
 * those values. The mapping is the Depop API adapter's (`depopCondition`), so a listing gets
 * the same grade in either mode: unworn items are brand new, and a new item with defects is
 * graded as used (excellent), with its flaws in the description. Like every Depop page detail,
 * the labels are confirmed in the first linked session (docs/features/depop-automation.md).
 */
import { depopCondition, type DepopCondition, type ItemCondition } from '@listora/marketplaces';

/** The form's label for each of Depop's conditions. */
export const DEPOP_CONDITION_LABELS = {
  brand_new: 'Brand new',
  used_like_new: 'Like new',
  used_excellent: 'Used - Excellent',
  used_good: 'Used - Good',
  used_fair: 'Used - Fair',
} as const satisfies Record<DepopCondition, string>;

/** A type, not an interface, so it fits the payload's JSON. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DepopFormCondition = { value: DepopCondition; label: string };

/** The radio option a listing with this condition picks; `null` when it has none. */
export function depopFormCondition(condition: ItemCondition | null): DepopFormCondition | null {
  const value = depopCondition(condition);
  return value === null ? null : { value, label: DEPOP_CONDITION_LABELS[value] };
}
