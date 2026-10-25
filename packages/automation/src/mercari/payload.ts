/**
 * What the Mercari scripts put into Mercari's listing form, built purely from the listing
 * content, and Mercari's rules for it (golden-tested in `__golden__/`). The payload extends
 * the assisted one, so a step that falls back to the user copies the same title, description,
 * price, and photos.
 *
 * Mercari has no seller SKU field, so the scripts end the description with a line naming the
 * listing's SKU (`SKU: AJ-000184`). It is how a later attempt or a read-back finds a listing
 * whose id Listora never learned (a create that timed out after Mercari took it), so a create
 * is never posted twice. Reads strip the line again, so the description Listora verifies is the
 * listing's own (docs/mercari.md, "Finding a listing again").
 */
import {
  photosInOrder,
  type AssistedListingPayload,
  type ItemSnapshot,
  type ListingVariant,
  type ValidationIssue,
} from '@listora/marketplaces';

import { SKU_LINE_RESERVE } from '../adapter/sku-line.ts';
import { categoryTraits, mapMercariCategory, parseCategoryRef } from './categories.ts';
import { mercariCondition } from './conditions.ts';
import type { MercariShipping } from './shipping.ts';
import { mercariSize } from './sizes.ts';

export { listingSku, skuLine, splitSkuLine, withSkuLine } from '../adapter/sku-line.ts';

export interface MercariListingPayload extends AssistedListingPayload {
  /** The names to pick in the form's category levels, top first; `null` when unmapped. */
  category: string[] | null;
  /** Mercari's size label for the category's size list; `null` when it takes none or is unknown. */
  size: string | null;
  /** Whether the category takes a size (clothing and shoes). */
  sized: boolean;
  /** The brand to pick from Mercari's brand list; posted without one when Mercari lists none. */
  brand: string | null;
  /** The value and label of Mercari's condition option; `null` when the item has none. */
  condition: { id: number; label: string } | null;
  shipping: MercariShipping;
}

/**
 * Mercari's limits: titles and descriptions as the listing form enforces them (the same as the
 * analysis copy limits, `packages/analysis/src/marketplace-copy.ts`), whole-dollar prices from
 * $1 to $2,000, and up to 12 photos.
 */
export const MERCARI_LIMITS = {
  titleMaxLength: 80,
  descriptionMaxLength: 1_000,
  minPriceCents: 100,
  maxPriceCents: 200_000,
  maxPhotos: 12,
} as const;

export function buildMercariPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): MercariListingPayload {
  const named = variant.categoryRef === null ? null : parseCategoryRef(variant.categoryRef);
  const mapped = named === null ? mapMercariCategory(item.category, item.department) : null;
  const path = named ?? (mapped === null ? null : [...mapped.path]);
  const traits = mapped ?? categoryTraits(named ?? [], item.category);
  const condition = variant.condition ?? item.condition;
  const mercari = condition === null ? null : mercariCondition(condition);
  return {
    title: variant.title,
    description: variant.description,
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    category: path,
    size: mercariSize(item, traits.size),
    sized: traits.size !== 'none',
    brand: item.brand?.trim() === '' ? null : (item.brand?.trim() ?? null),
    condition: mercari === null ? null : { id: mercari.id, label: mercari.label },
    shipping: { payer: 'buyer', method: 'prepaid_label', weight: traits.weight },
  };
}

/**
 * Mercari's rules on top of the assisted ones (which already refuse a price of $0 or less and a
 * listing without photos).
 */
export function validateMercariPayload(payload: MercariListingPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const limits = MERCARI_LIMITS;
  if (payload.title.length > limits.titleMaxLength) {
    issues.push({
      field: 'variant.title',
      code: 'too_long',
      message: `Mercari titles can be at most ${String(limits.titleMaxLength)} characters.`,
    });
  }
  const descriptionMax = limits.descriptionMaxLength - SKU_LINE_RESERVE;
  if (payload.description.trim() === '') {
    issues.push({
      field: 'variant.description',
      code: 'required',
      message: 'Mercari needs a description.',
    });
  } else if (payload.description.length > descriptionMax) {
    issues.push({
      field: 'variant.description',
      code: 'too_long',
      message: `Mercari descriptions can be at most ${String(descriptionMax)} characters here (Listora adds a SKU line to the ${String(limits.descriptionMaxLength)} Mercari allows).`,
    });
  }
  const cents = payload.price.amountCents;
  if (cents > 0 && cents % 100 !== 0) {
    issues.push({
      field: 'variant.price',
      code: 'invalid',
      message: 'Mercari prices are whole dollars.',
    });
  }
  if (cents > 0 && (cents < limits.minPriceCents || cents > limits.maxPriceCents)) {
    issues.push({
      field: 'variant.price',
      code: 'out_of_range',
      message: 'Mercari prices are from $1 to $2,000.',
    });
  }
  if (payload.photos.length > limits.maxPhotos) {
    issues.push({
      field: 'item.photos',
      code: 'too_many',
      message: `Mercari takes at most ${String(limits.maxPhotos)} photos.`,
    });
  }
  if (payload.category === null) {
    issues.push({
      field: 'variant.categoryRef',
      code: 'required',
      message:
        "Listora has no Mercari category for this item. Choose one, for example 'Women > Shoes > Boots'.",
    });
  }
  if (payload.condition === null) {
    issues.push({
      field: 'item.condition',
      code: 'required',
      message: 'Mercari needs the item condition.',
    });
  }
  if (payload.sized && payload.size === null) {
    issues.push({
      field: 'item.sizeLabel',
      code: 'required',
      message: 'Mercari needs a size it lists for this category (for example M, 8, 32, or 9.5).',
    });
  }
  return issues;
}
