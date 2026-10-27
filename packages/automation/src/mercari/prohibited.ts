/**
 * Items Mercari prohibits that Listora can recognize from the listing itself, refused before
 * anything is sent: posting one breaks Mercari's terms whether or not the seller meant to, and
 * Mercari may remove the listing or suspend the account. From Mercari's Prohibited Items list
 * (`/us/help_center/topics/account/policies/prohibited-items/`, read 2026-10-27):
 *
 * - "items that are soiled with human materials such as used underwear": a pre-owned item whose
 *   own category is underwear;
 * - "counterfeit goods ... non-brand, non-genuine, imitation, fake, or replica": a title or
 *   description that calls the item a replica, counterfeit, knockoff, or bootleg;
 * - weapons ("firearms and firearm parts; including airsoft and bb guns", ammunition,
 *   switchblades and butterfly knives, self defense items), tobacco and nicotine (cigarettes,
 *   e-cigarettes, vaping), and items that contain CBD, named in the title or description.
 *
 * Only words that name the item are matched, so ordinary listings ("bomber jacket", "knife
 * pleats") pass. The rest of the list (stolen goods, items not in hand, explicit items, ...)
 * can't be told from a listing; Mercari's own check at List still applies, and its warning
 * stops the step (pages/listing-form.ts).
 */
import type { ItemCondition, ValidationIssue } from '@listora/marketplaces';

import { isUnderwear } from '../adapter/underwear.ts';

interface Rule {
  pattern: RegExp;
  message: string;
}

const RULES: readonly Rule[] = [
  {
    pattern: /\b(replicas?|counterfeits?|knock-?offs?|bootlegs?|unauthentic|not authentic)\b/i,
    message:
      "Mercari doesn't allow replicas, imitations, or counterfeit items (its Prohibited Items list).",
  },
  {
    pattern:
      /\b(firearms?|handguns?|rifles?|shotguns?|ammunition|ammo|airsoft|bb guns?|switchblades?|butterfly knife|brass knuckles|pepper spray|stun guns?|tasers?)\b/i,
    message: "Mercari doesn't allow weapons or self-defense items (its Prohibited Items list).",
  },
  {
    pattern: /\b(cigarettes?|e-?cigs?|e-?cigarettes?|vapes?|vape pens?|vaping|nicotine|cbd)\b/i,
    message: "Mercari doesn't allow tobacco, nicotine, vaping, or CBD products (its Prohibited Items list).",
  },
];

/** The reasons Mercari would refuse the listing as a prohibited item, before anything is sent. */
export function prohibitedIssues(listing: {
  title: string;
  description: string;
  itemCategory: string | null;
  condition: ItemCondition | null;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (isUnderwear(listing.itemCategory) && listing.condition?.startsWith('pre_owned') === true) {
    issues.push({
      field: 'item.condition',
      code: 'not_allowed',
      message: "Mercari doesn't take used underwear.",
    });
  }
  const text = `${listing.title}\n${listing.description}`;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      issues.push({ field: 'variant.title', code: 'not_allowed', message: rule.message });
    }
  }
  return issues;
}
