/**
 * The Depop listing a create, revise, or relist sends (docs/architecture.md section 4), built
 * purely from the listing content and checked against Depop's rules before anything is sent.
 * The payload is Listora's view of the product; `productBody` (adapter.ts) adds the seller's
 * address and shipping and turns it into the Selling API's `ProductPutRequest`.
 *
 * Depop listings have no title: the description is the whole listing text, with the hashtags
 * on their own last line (`depopDescription`). The variant's title stays Listora's own
 * headline, and a read-back never checks it (`capabilities.title` is `none`).
 */
import type { JsonObject } from '@listora/db';
import {
  DEPOP_EMAIL_ADDRESS,
  depopDescription,
  endsWithHashtagLine,
  type CurrencyCode,
} from '@listora/shared';

import type { ValidationIssue } from '../adapter.ts';
import { photosInOrder, type ItemSnapshot, type ListingVariant } from '../content.ts';
import {
  DEPOP_TAXONOMY_ID,
  depopColours,
  depopCondition,
  depopDepartment,
  depopProductType,
} from './taxonomy.ts';

const NAME = 'Depop';

/** Depop's listing limits, from the Selling API's openapi.yaml (ProductPutRequest). */
export const DEPOP_LIMITS = {
  /** `description`: "Limited to 1000 characters", hashtags included. */
  descriptionLength: 1_000,
  /** "Can only have up to 5 hashtags." */
  hashtags: 5,
  /** `pictures`: "Minimum 1 image is required, maximum 8 images allowed." */
  minPhotos: 1,
  maxPhotos: 8,
  /** `price_amount`: "Must be at least $1.00 or £1.00." */
  minPriceCents: 100,
} as const;

/** Aspects that carry Depop's size ids, under Depop's own field names. */
export const DEPOP_SIZE_ASPECTS = { sizeSet: 'size_set_id', size: 'size_id' } as const;

/** A hashtag: letters and digits, as the item analysis writes them (without the `#`). */
const HASHTAG = /^[A-Za-z0-9]{1,30}$/;

export interface DepopListingPayload extends JsonObject {
  /** The listing copy, without the hashtags. */
  description: string;
  hashtags: string[];
  priceCents: number;
  currency: CurrencyCode;
  department: string | null;
  productType: string | null;
  /** Depop's size set and size ids, as the variant's aspects give them (whole numbers). */
  sizeSetId: string | null;
  sizeId: string | null;
  condition: string | null;
  /** Depop's "unbranded" for an item without a brand. */
  brand: string;
  colours: string[];
  /** Product attributes by Depop attribute id (`material`, `sleeve-length`, ...). */
  attributes: Record<string, string[]>;
  /** The listing photos in posting order; the first is the cover. */
  pictureUrls: string[];
}

export function buildDepopPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): DepopListingPayload {
  const attributes: Record<string, string[]> = {};
  let sizeSetId: string | null = null;
  let sizeId: string | null = null;
  for (const aspect of variant.aspects) {
    if (aspect.name === DEPOP_SIZE_ASPECTS.sizeSet || aspect.name === DEPOP_SIZE_ASPECTS.size) {
      const value = aspect.values.join(',');
      if (aspect.name === DEPOP_SIZE_ASPECTS.sizeSet) sizeSetId = value;
      else sizeId = value;
      continue;
    }
    // Other aspects named like Depop attribute ids become attributes; eBay-style names such
    // as "Size" are not Depop's and stay out.
    if (DEPOP_TAXONOMY_ID.test(aspect.name)) attributes[aspect.name] = [...aspect.values];
  }
  return {
    description: variant.description,
    hashtags: [...variant.hashtags],
    priceCents: variant.price.amountCents,
    currency: variant.price.currency,
    department: depopDepartment(item.department, item.category),
    productType: variant.categoryRef ?? depopProductType(item.category),
    sizeSetId,
    sizeId,
    condition: depopCondition(variant.condition ?? item.condition),
    brand: item.brand ?? 'unbranded',
    colours: depopColours(item.colors),
    attributes,
    pictureUrls: photosInOrder(item).map((photo) => photo.url),
  };
}

/** Depop's rules for a payload; empty when it can be sent. */
export function validateDepopPayload(payload: DepopListingPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (field: string, code: string, message: string) => {
    issues.push({ field, code, message });
  };

  if (payload.pictureUrls.length < DEPOP_LIMITS.minPhotos) {
    issue('item.photos', 'required', `${NAME} listings need at least one photo.`);
  } else if (payload.pictureUrls.length > DEPOP_LIMITS.maxPhotos) {
    issue(
      'item.photos',
      'too_many',
      `${NAME} listings can have at most ${String(DEPOP_LIMITS.maxPhotos)} photos.`,
    );
  }
  if (payload.priceCents < DEPOP_LIMITS.minPriceCents) {
    issue('variant.price', 'out_of_range', `${NAME} prices must be at least $1.00.`);
  }

  const text = depopDescription(payload.description, payload.hashtags);
  if (payload.description.trim() === '') {
    issue('variant.description', 'required', `${NAME} listings need a description.`);
  }
  if (text.length > DEPOP_LIMITS.descriptionLength) {
    issue(
      'variant.description',
      'too_long',
      `${NAME} descriptions, hashtags included, can be at most ${String(DEPOP_LIMITS.descriptionLength)} characters.`,
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

  if (payload.department === null) {
    issue(
      'item.department',
      'required',
      `${NAME} needs to know whether the item is menswear, womenswear, or kidswear.`,
    );
  }
  if (payload.productType === null) {
    issue('variant.categoryRef', 'required', `${NAME} needs a category for this item.`);
  } else if (!DEPOP_TAXONOMY_ID.test(payload.productType)) {
    issue('variant.categoryRef', 'invalid', `"${payload.productType}" isn't a ${NAME} category.`);
  }
  if ((payload.sizeSetId === null) !== (payload.sizeId === null)) {
    issue(
      'variant.aspects',
      'incomplete',
      `${NAME} sizes need both ${DEPOP_SIZE_ASPECTS.sizeSet} and ${DEPOP_SIZE_ASPECTS.size}.`,
    );
  }
  for (const [name, value] of [
    [DEPOP_SIZE_ASPECTS.sizeSet, payload.sizeSetId],
    [DEPOP_SIZE_ASPECTS.size, payload.sizeId],
  ] as const) {
    if (value !== null && depopSizeId(value) === null) {
      issue('variant.aspects', 'invalid', `${NAME}'s ${name} is one whole number.`);
    }
  }
  if (payload.condition === null) {
    issue('item.condition', 'required', `${NAME} needs the item's condition.`);
  }
  return issues;
}

/** `4500` → `"45.00"`, Depop's decimal amounts. */
export function depopAmount(cents: number): string {
  return `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** Depop's decimal amounts (`"25.99"`, `"5.0"`) in cents; `null` when one isn't. */
export function depopCents(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match?.[1] === undefined) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A Depop size or size set id from its aspect value; `null` when it isn't one. */
export function depopSizeId(value: string): number | null {
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}
