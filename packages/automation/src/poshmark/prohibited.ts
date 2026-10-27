/**
 * Items Poshmark doesn't allow, refused before anything is sent to it. Poshmark deletes such
 * listings and suspends sellers who keep listing them, so Listora never lists one for the seller.
 *
 * Source: Poshmark's "What can I sell on Poshmark?" (support.poshmark.com, read 2026-10-27):
 * makeup and personal care products must be new; used makeup and skincare and used underwear
 * are prohibited; so are replicas, listings that use a trademarked name to describe an item
 * ("inspired by Chanel"), medical products such as N95 masks, and what Poshmark's labels cannot
 * ship (nail polish, perfumes, aerosols). Listora can tell from the listing only the catalog,
 * the condition, and the words of its title and description, so those are what it checks; the
 * rest of the policy is the seller's.
 */
import type { PoshmarkCatalog } from './catalog.ts';
import type { PoshmarkConditionCode } from './conditions.ts';

/** Personal care categories, whose products Poshmark takes only new. */
const PERSONAL_CARE: ReadonlySet<string> = new Set([
  'Women/Makeup',
  'Women/Skincare',
  'Women/Hair',
  'Women/Bath & Body',
  'Men/Grooming',
  'Kids/Bath, Skin & Hair',
]);

/** Underwear, which Poshmark takes only new. */
const UNDERWEAR: ReadonlySet<string> = new Set([
  'Women/Intimates & Sleepwear/Panties',
  'Men/Underwear & Socks/Boxer Briefs',
  'Men/Underwear & Socks/Boxers',
  'Men/Underwear & Socks/Briefs',
  'Kids/Accessories/Underwear',
]);

/** Words that name an item Poshmark prohibits, with what Poshmark's policy says of it. */
const PROHIBITED_WORDS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\breplicas?\b/i, reason: "Poshmark doesn't allow replicas." },
  {
    pattern: /\binspired by\b/i,
    reason: 'Poshmark doesn\'t allow a brand\'s name to describe another item ("inspired by").',
  },
  { pattern: /\bn95\b/i, reason: "Poshmark doesn't allow medical products such as N95 masks." },
  {
    pattern: /\b(nail polish|perfumes?|eau de (parfum|toilette)|cologne|aerosols?)\b/i,
    reason: "Poshmark's shipping labels can't carry nail polish, perfume, or aerosols.",
  },
];

/** Why Poshmark wouldn't take the listing, and the field that says so. */
export interface ProhibitedReason {
  field: 'item.condition' | 'variant.title' | 'variant.description';
  message: string;
}

const USED_UNDERWEAR =
  "Poshmark doesn't take used underwear: it lists underwear only new with tags.";

/** Why Poshmark wouldn't take the listing, or `null` when Listora sees no reason. */
export function prohibitedReason(listing: {
  catalog: PoshmarkCatalog | null;
  condition: PoshmarkConditionCode | null;
  title: string;
  description: string;
  /** Whether the item's own category is underwear, whatever the Poshmark catalog. */
  underwear: boolean;
}): ProhibitedReason | null {
  const { catalog, condition } = listing;
  const used = condition !== null && condition !== 'nwt';
  if (catalog !== null && used) {
    const category = `${catalog.department}/${catalog.category}`;
    if (PERSONAL_CARE.has(category)) {
      return {
        field: 'item.condition',
        message:
          'Poshmark takes makeup and personal care products only new: it lists them only new with tags.',
      };
    }
    if (catalog.subcategory !== null && UNDERWEAR.has(`${category}/${catalog.subcategory}`)) {
      return { field: 'item.condition', message: USED_UNDERWEAR };
    }
  }
  if (listing.underwear && used) return { field: 'item.condition', message: USED_UNDERWEAR };
  for (const { pattern, reason } of PROHIBITED_WORDS) {
    if (pattern.test(listing.title)) return { field: 'variant.title', message: reason };
    if (pattern.test(listing.description)) {
      return { field: 'variant.description', message: reason };
    }
  }
  return null;
}
