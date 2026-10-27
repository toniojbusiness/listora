/**
 * What the Depop scripts put into Depop's listing form, built purely from the listing content,
 * and Depop's rules for it (golden-tested in `__golden__/`). The payload extends the assisted
 * one, so a step that falls back to the user copies the same text, price, and photos.
 *
 * Depop listings have no title: the description is the whole listing text, with the hashtags on
 * their own last line (`depopDescription`, shared with the item analysis and the API adapter).
 * The variant's title stays Listora's own headline and is never posted or read back
 * (`capabilities.title` is `none`). Depop's web form has no seller SKU field, so the scripts put
 * Listora's SKU line (adapter/sku-line.ts) after the copy and before the hashtags; reads strip
 * both again, so the description Listora verifies is the listing's own copy.
 */
import {
  DEPOP_LIMITS,
  photosInOrder,
  type AssistedListingPayload,
  type ItemSnapshot,
  type ListingVariant,
  type ValidationIssue,
} from '@listora/marketplaces';
import { DEPOP_EMAIL_ADDRESS, depopDescription, endsWithHashtagLine } from '@listora/shared';

import { SKU_LINE_RESERVE, withSkuLine } from '../adapter/sku-line.ts';
import { depopDetails, type DepopFormPick } from './attributes.ts';
import { mapDepopCategory, parseCategoryRef } from './categories.ts';
import { depopFormCondition, type DepopFormCondition } from './conditions.ts';
import { depopProhibitedIssues } from './prohibited.ts';
import { depopSize } from './sizes.ts';

const NAME = 'Depop';

export interface DepopAutomationPayload extends AssistedListingPayload {
  /** The listing copy, without the hashtags (Listora's `variant.description`). */
  description: string;
  /** Without the `#`, in order. */
  hashtags: string[];
  /**
   * The form's names of the category, department first (`['Men', 'Tops', 'T-shirts']`); `null`
   * when Listora has none for the item.
   */
  category: string[] | null;
  /** Depop's ids of the same (`['menswear', 'tops', 'tshirts']`). */
  categoryIds: string[] | null;
  /** The size, exactly as the category's size list labels it; `null` when it takes none. */
  size: string | null;
  /** Whether the category takes a size. */
  sized: boolean;
  /** The brand to pick from Depop's brand list; posted without one when Depop lists none. */
  brand: string | null;
  condition: DepopFormCondition | null;
  /**
   * The other pickers to fill (colours, material), by the labels to pick; absent from the
   * payload of a phone call a server issued before them.
   */
  details?: DepopFormPick[];
  /** The size list's labels, for the message when the item's size is not one of them. */
  sizes: string[];
}

/** A hashtag: letters and digits, as the item analysis writes them (without the `#`). */
const HASHTAG = /^[A-Za-z0-9]{1,30}$/;

/** The listing text the form's description field gets: copy, SKU line, then hashtags. */
export function depopListingText(payload: DepopAutomationPayload, sku: string): string {
  return depopDescription(withSkuLine(payload.description, sku), payload.hashtags);
}

/** Depop's prices: decimal dollars with cents (`45.00`). */
export function depopPriceField(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

export function buildDepopAutomationPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): DepopAutomationPayload {
  const category =
    variant.categoryRef === null
      ? mapDepopCategory(item.category, item.department)
      : parseCategoryRef(variant.categoryRef, item.department);
  const brand = item.brand?.trim() ?? '';
  const sizes = category?.sizes ?? [];
  return {
    title: variant.title,
    description: variant.description,
    hashtags: [...variant.hashtags],
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    category: category === null ? null : [...category.path],
    categoryIds: category === null ? null : [...category.ids],
    size: depopSize(item, sizes),
    sized: sizes.length > 0,
    brand: brand === '' ? null : brand,
    condition: depopFormCondition(variant.condition ?? item.condition),
    details: category === null ? [] : depopDetails(item, category.attributes),
    sizes: [...sizes],
  };
}

/**
 * Depop's rules on top of the assisted ones (which already refuse a price of $0 or less and a
 * listing without photos), from the Selling API's limits (`DEPOP_LIMITS`), which the web form
 * shares.
 */
export function validateDepopAutomationPayload(payload: DepopAutomationPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (field: string, code: string, message: string) => {
    issues.push({ field, code, message });
  };

  if (payload.photos.length > DEPOP_LIMITS.maxPhotos) {
    issue(
      'item.photos',
      'too_many',
      `${NAME} listings can have at most ${String(DEPOP_LIMITS.maxPhotos)} photos.`,
    );
  }
  const cents = payload.price.amountCents;
  if (cents > 0 && cents < DEPOP_LIMITS.minPriceCents) {
    issue('variant.price', 'out_of_range', `${NAME} prices must be at least $1.00.`);
  }

  // The text as the form gets it, with the longest SKU line Listora writes.
  const textMax = DEPOP_LIMITS.descriptionLength - SKU_LINE_RESERVE;
  const text = depopDescription(payload.description, payload.hashtags);
  if (payload.description.trim() === '') {
    issue('variant.description', 'required', `${NAME} listings need a description.`);
  } else if (text.length > textMax) {
    issue(
      'variant.description',
      'too_long',
      `${NAME} descriptions, hashtags included, can be at most ${String(textMax)} characters here (Listora adds a SKU line to the ${String(DEPOP_LIMITS.descriptionLength)} ${NAME} allows).`,
    );
  }
  if (DEPOP_EMAIL_ADDRESS.test(text)) {
    issue(
      'variant.description',
      'invalid',
      `${NAME} doesn't allow email addresses in descriptions.`,
    );
  }
  if (endsWithHashtagLine(payload.description)) {
    issue(
      'variant.description',
      'invalid',
      `Put ${NAME} hashtags in the hashtag list, not on the last line of the description.`,
    );
  }
  if (payload.hashtags.some((tag) => !HASHTAG.test(tag))) {
    issue('variant.hashtags', 'invalid', `${NAME} hashtags are up to 30 letters and numbers each.`);
  }
  const inline = payload.description.match(/#[^\s#]+/g)?.length ?? 0;
  if (payload.hashtags.length + inline > DEPOP_LIMITS.hashtags) {
    issue(
      'variant.hashtags',
      'too_many',
      `${NAME} listings can have at most ${String(DEPOP_LIMITS.hashtags)} hashtags, the description's own included.`,
    );
  }

  if (payload.category === null) {
    issue(
      'variant.categoryRef',
      'required',
      `Listora has no ${NAME} category for this item. Choose one, for example 'Women > Footwear > Boots'.`,
    );
  }
  if (payload.condition === null) {
    issue('item.condition', 'required', `${NAME} needs the item's condition.`);
  }
  if (payload.sized && payload.size === null) {
    issue(
      'item.sizeLabel',
      'required',
      `${NAME} needs one of its sizes for this category: ${sizeExamples(payload.sizes)}.`,
    );
  }
  issues.push(...depopProhibitedIssues(payload));
  return issues;
}

/** A few of a size list's labels, for a message: `XS, S, M, L, XL, ... (14 sizes)`. */
function sizeExamples(sizes: readonly string[]): string {
  const real = sizes.filter((size) => size !== 'Other');
  const shown = real.slice(0, 8).join(', ');
  return real.length > 8 ? `${shown}, ... (${String(real.length)} sizes)` : shown;
}
