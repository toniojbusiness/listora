/**
 * What the eBay scripts put into eBay's listing form, built purely from the listing content,
 * and eBay's rules for it (golden-tested in `__golden__/`). The payload extends the assisted
 * one, so a step that falls back to the user copies the same title, text, price, and photos.
 *
 * Everything eBay-specific comes from the eBay API adapter's builder (`buildEbayPayload`): the
 * category from the variant's `categoryRef` or the canonical category map, the condition id,
 * the condition notes, the item specifics (Brand, Department, eBay's standard size, Color,
 * Material, Pattern, MPN, then the variant's own), and the description as eBay's HTML. So a
 * listing automated today is the listing the API would have made, and stays the same listing
 * record when the seller connects the API. The SKU is not content: the scripts type the
 * listing's SKU into the form's Custom label field per attempt, as the API adapter sends it.
 */
import {
  buildEbayPayload,
  categoryTraits,
  mappedEbayCategory,
  photosInOrder,
  validateEbayPayload,
  type AssistedListingPayload,
  type EbayItemSpecific,
  type ItemSnapshot,
  type ListingVariant,
  type SizeAspect,
  type ValidationIssue,
} from '@listora/marketplaces';

import { ebayFormCondition, type EbayFormCondition } from './conditions.ts';

export interface EbayAutomationPayload extends AssistedListingPayload {
  /** The description as eBay stores it: the text escaped, line breaks as `<br>`. */
  descriptionHtml: string;
  /** eBay's leaf category id; `null` when the item has no eBay category. */
  categoryId: string | null;
  /** Which size item specific the category takes (eBay's standard sizes). */
  size: SizeAspect;
  /** The form's condition for the category; `null` when unknown or the category has none. */
  condition: EbayFormCondition | null;
  conditionDescription: string | null;
  itemSpecifics: EbayItemSpecific[];
}

/** eBay's lowest price for a fixed-price listing. */
export const EBAY_MIN_PRICE_CENTS = 99;

/** eBay's prices on the form: decimal dollars with cents (`45.00`). */
export function ebayPriceField(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

export function buildEbayAutomationPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): EbayAutomationPayload {
  const api = buildEbayPayload(item, variant);
  const size =
    (api.categoryId === null ? null : mappedEbayCategory(api.categoryId))?.size ??
    categoryTraits(item.category).size;
  return {
    title: variant.title,
    description: variant.description,
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    descriptionHtml: api.descriptionHtml,
    categoryId: api.categoryId,
    size,
    condition: ebayFormCondition(api.conditionId, size),
    conditionDescription: api.conditionDescription,
    itemSpecifics: api.itemSpecifics,
  };
}

/**
 * eBay's rules on top of the assisted ones (which already refuse a title over 80 characters, a
 * price of $0 or less, and no photos or more than 24): the API adapter's validation, which the
 * web form shares, and eBay's lowest fixed price.
 */
export function validateEbayAutomationPayload(payload: EbayAutomationPayload): ValidationIssue[] {
  const issues = validateEbayPayload({
    title: payload.title,
    descriptionHtml: payload.descriptionHtml,
    categoryId: payload.categoryId,
    conditionId: payload.condition?.id ?? null,
    conditionDescription: payload.conditionDescription,
    priceCents: payload.price.amountCents,
    currency: payload.price.currency,
    photoUrls: payload.photos.map((photo) => photo.url),
    itemSpecifics: payload.itemSpecifics,
  }).filter((issue) => !assistedCovers(issue));
  const cents = payload.price.amountCents;
  if (cents > 0 && cents < EBAY_MIN_PRICE_CENTS) {
    issues.push({
      field: 'variant.price',
      code: 'out_of_range',
      message: 'eBay prices must be at least $0.99.',
    });
  }
  return issues;
}

/** The issues the assisted adapter already reports (with the same words). */
function assistedCovers(issue: ValidationIssue): boolean {
  return (
    (issue.field === 'variant.title' && issue.code === 'too_long') ||
    (issue.field === 'variant.price' && issue.code === 'out_of_range') ||
    issue.field === 'item.photos'
  );
}
