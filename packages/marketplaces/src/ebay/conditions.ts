/**
 * eBay item condition ids for Listora's canonical conditions, from eBay's condition id list
 * (https://developer.ebay.com/api-docs/sell/static/metadata/condition-id-values.html, checked
 * 2026-10-24). Apparel categories have three pre-owned grades ("Pre-owned - Excellent" 2990,
 * "Pre-owned - Good" 3000, "Pre-owned - Fair" 3010); 2990 and 3010 are "only available in
 * apparel categories", so elsewhere every pre-owned grade is 3000 ("Used").
 */
import { assertNever } from '@listora/shared';

import type { ItemCondition } from '../content.ts';

/** Whether a category takes eBay's apparel condition grades (see categories.ts). */
export type ConditionScheme = 'apparel' | 'general';

export const EBAY_CONDITION_IDS = {
  new: 1000,
  newOther: 1500,
  newWithDefects: 1750,
  preOwnedExcellent: 2990,
  used: 3000,
  preOwnedFair: 3010,
} as const;

export function ebayConditionId(condition: ItemCondition, scheme: ConditionScheme): number {
  switch (condition) {
    case 'new_with_tags':
      return EBAY_CONDITION_IDS.new;
    case 'new_without_tags':
      return EBAY_CONDITION_IDS.newOther;
    case 'new_with_defects':
      return EBAY_CONDITION_IDS.newWithDefects;
    case 'pre_owned_excellent':
      return scheme === 'apparel' ? EBAY_CONDITION_IDS.preOwnedExcellent : EBAY_CONDITION_IDS.used;
    case 'pre_owned_good':
      return EBAY_CONDITION_IDS.used;
    case 'pre_owned_fair':
      return scheme === 'apparel' ? EBAY_CONDITION_IDS.preOwnedFair : EBAY_CONDITION_IDS.used;
    default:
      return assertNever(condition, 'item condition');
  }
}

/**
 * eBay ignores a condition description for brand-new items (ids 1000 to 1499) and answers with
 * a warning, so the payload leaves it out for them.
 */
export function takesConditionDescription(conditionId: number): boolean {
  return conditionId >= 1500;
}
