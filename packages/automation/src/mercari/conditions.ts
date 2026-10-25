/**
 * Mercari's item conditions for Listora's canonical ones. Mercari US grades items New, Like
 * new, Good, Fair, or Poor; the meanings below are how Mercari's listing form commonly
 * describes them (new with tags; new without tags and unused; gently used with a minor flaw or
 * two; used with several flaws; damaged). Like every Mercari page detail, the labels and their
 * values are confirmed in the first linked session (docs/mercari.md, "Live verification").
 * The form offers them as one radio group; `id` is the value of each option.
 */
import type { ItemCondition } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

export const MERCARI_CONDITIONS = {
  new: { id: 1, label: 'New' },
  likeNew: { id: 2, label: 'Like new' },
  good: { id: 3, label: 'Good' },
  fair: { id: 4, label: 'Fair' },
  poor: { id: 5, label: 'Poor' },
} as const;

export type MercariCondition = (typeof MERCARI_CONDITIONS)[keyof typeof MERCARI_CONDITIONS];

/**
 * New with defects is unused but flawed, which Mercari grades as Good ("one or two minor
 * flaws"); pre-owned excellent shows no wear, Mercari's Like new. Listora never proposes Poor:
 * its fair grade is still sellable as described.
 */
export function mercariCondition(condition: ItemCondition): MercariCondition {
  switch (condition) {
    case 'new_with_tags':
      return MERCARI_CONDITIONS.new;
    case 'new_without_tags':
      return MERCARI_CONDITIONS.likeNew;
    case 'new_with_defects':
      return MERCARI_CONDITIONS.good;
    case 'pre_owned_excellent':
      return MERCARI_CONDITIONS.likeNew;
    case 'pre_owned_good':
      return MERCARI_CONDITIONS.good;
    case 'pre_owned_fair':
      return MERCARI_CONDITIONS.fair;
    default:
      return assertNever(condition, 'item condition');
  }
}
