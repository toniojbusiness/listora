/**
 * Poshmark's item conditions for Listora's canonical conditions. Poshmark's listing form offers
 * four, which its pages list with their codes (`featureSettings.web_resell_v2_guest.conditions`,
 * read 2026-10-24): `nwt` "New With Tags (NWT)", `uln` "Like New", `ug` "Good", and `uf` "Fair".
 * Poshmark has no "new without tags" or "new with defects": an unworn item without tags is Like
 * New, and a new item with defects is Good, so the listing never claims more than the item is.
 */
import type { ItemCondition } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

export const POSHMARK_CONDITIONS = {
  nwt: 'New With Tags (NWT)',
  uln: 'Like New',
  ug: 'Good',
  uf: 'Fair',
} as const;
export type PoshmarkConditionCode = keyof typeof POSHMARK_CONDITIONS;

export interface PoshmarkCondition {
  code: PoshmarkConditionCode;
  /** The label the listing form shows. */
  label: string;
}

export function poshmarkCondition(condition: ItemCondition): PoshmarkCondition {
  const code = conditionCode(condition);
  return { code, label: POSHMARK_CONDITIONS[code] };
}

function conditionCode(condition: ItemCondition): PoshmarkConditionCode {
  switch (condition) {
    case 'new_with_tags':
      return 'nwt';
    case 'new_without_tags':
    case 'pre_owned_excellent':
      return 'uln';
    case 'new_with_defects':
    case 'pre_owned_good':
      return 'ug';
    case 'pre_owned_fair':
      return 'uf';
    default:
      return assertNever(condition, 'item condition');
  }
}
