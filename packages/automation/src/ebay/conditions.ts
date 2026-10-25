/**
 * The condition eBay's listing form shows for each of eBay's condition ids, by the kind of
 * category (docs/features/ebay-automation.md, "Mapping"). Listora's canonical condition maps to
 * the condition id exactly as in API mode (`buildEbayPayload`, from eBay's condition id list:
 * apparel has three pre-owned grades, other categories one), so a listing gets the same grade
 * in either mode. The form's condition options carry those ids as their values, and the labels
 * here are what the seller sees next to them: the script picks the id, and messages name the
 * label.
 */
import type { JsonObject } from '@listora/db';
import { EBAY_CONDITION_IDS, type SizeAspect } from '@listora/marketplaces';

/** Which list of condition names a category shows: clothing, shoes, or everything else. */
export type EbayConditionList = 'apparel' | 'shoes' | 'general';

const {
  new: NEW,
  newOther,
  newWithDefects,
  preOwnedExcellent,
  used,
  preOwnedFair,
} = EBAY_CONDITION_IDS;

export const EBAY_CONDITION_LABELS: Readonly<
  Record<EbayConditionList, Readonly<Record<number, string>>>
> = {
  apparel: {
    [NEW]: 'New with tags',
    [newOther]: 'New without tags',
    [newWithDefects]: 'New with defects',
    [preOwnedExcellent]: 'Pre-owned - Excellent',
    [used]: 'Pre-owned - Good',
    [preOwnedFair]: 'Pre-owned - Fair',
  },
  shoes: {
    [NEW]: 'New with box',
    [newOther]: 'New without box',
    [newWithDefects]: 'New with defects',
    [used]: 'Pre-owned',
  },
  general: {
    [NEW]: 'New with tags',
    [newOther]: 'New without tags',
    [newWithDefects]: 'New with defects',
    [used]: 'Pre-owned',
  },
};

/** The condition list of a category that takes `size` (categories.ts in the eBay adapter). */
export function conditionList(size: SizeAspect): EbayConditionList {
  switch (size) {
    case 'clothing':
      return 'apparel';
    case 'shoes':
      return 'shoes';
    case 'none':
      return 'general';
  }
}

export interface EbayFormCondition extends JsonObject {
  /** eBay's condition id, the value of the form's option. */
  id: number;
  /** What the form shows for it in this category. */
  label: string;
}

/** The form's condition for an id in a category of this kind; `null` when it offers none. */
export function ebayFormCondition(
  conditionId: number | null,
  size: SizeAspect,
): EbayFormCondition | null {
  if (conditionId === null) return null;
  const label = EBAY_CONDITION_LABELS[conditionList(size)][conditionId];
  return label === undefined ? null : { id: conditionId, label };
}
