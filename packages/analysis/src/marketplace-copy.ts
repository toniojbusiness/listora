/**
 * How long each marketplace's listing copy may be, from each marketplace's own documentation
 * (checked 2026-10-24). The analysis writes copy within these limits and the output schema
 * rejects copy that is not, so a variant never needs cutting before it is listed.
 */
import type { KnownMarketplace } from '@listora/api-contract';
import { DEPOP_EMAIL_ADDRESS } from '@listora/shared';

export interface MarketplaceCopyLimits {
  /** Characters in the title. */
  readonly title: number;
  /**
   * Characters in the description. For Depop the hashtags count too: they are part of the
   * description there (see `depopDescription`).
   */
  readonly description: number;
  /** Hashtags the marketplace accepts; 0 when it has none. */
  readonly hashtags: number;
  readonly sources: readonly string[];
}

export const MARKETPLACE_COPY_LIMITS = {
  ebay: {
    // Trading API AddFixedPriceItem, Item.Title: "Max length: 80". Descriptions may be far
    // longer (HTML up to 500,000 characters); Listora keeps plain-text copy short.
    title: 80,
    description: 4_000,
    hashtags: 0,
    sources: ['https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddFixedPriceItem.html'],
  },
  depop: {
    // Selling API product `description`: "Limited to 1000 characters", "Can only have up to 5
    // hashtags", "Email addresses are not allowed" (maxLength: 1000). Depop listings have no
    // title; the variant's title is Listora's own short headline for the item.
    title: 80,
    description: 1_000,
    hashtags: 5,
    sources: ['https://partnerapi.depop.com/api-docs/openapi.yaml'],
  },
  poshmark: {
    // Bulk Upload template: Title "80 Character Limit Max", Description "1500 Character
    // Limit Max".
    title: 80,
    description: 1_500,
    hashtags: 0,
    sources: ['https://support.poshmark.com/s/article/Bulk-Upload-Templates'],
  },
  mercari: {
    // Mercari publishes no limits: the Help Center's "Creating a Listing" guide states none,
    // and the listing form (mercari.com/sell) is behind a bot check that Listora does not get
    // around. These are the limits the listing form is commonly reported to enforce; copy is
    // pasted by the user (assisted mode), so a wrong limit shows up as text the form refuses.
    title: 80,
    description: 1_000,
    hashtags: 0,
    sources: ['https://www.mercari.com/us/help_center/topics/listing/guides/creating-a-listing/'],
  },
} as const satisfies Record<KnownMarketplace, MarketplaceCopyLimits>;

/**
 * Characters the analysis aims the Depop copy and its hashtags at: Depop's 1,000 less the 71 the
 * automation scripts keep free for the SKU line they add before the hashtags (`SKU_LINE_RESERVE`
 * in @listora/automation, docs/features/depop-automation.md, "Finding a listing again"). The
 * output schema still allows Depop's own limit, so a draft a little over this is a listing the
 * seller shortens, never a failed analysis.
 */
export const DEPOP_DRAFT_LENGTH = 929;

/** Hashtags as the model writes them: lowercase letters and digits, without the `#`. */
export const HASHTAG = /^[a-z0-9]{1,30}$/;

// Depop's listing text rules are shared with the Depop adapter (`@listora/shared`).
export { depopDescription } from '@listora/shared';

/** Text that looks like an email address, which Depop refuses in descriptions. */
export const EMAIL_ADDRESS = DEPOP_EMAIL_ADDRESS;
