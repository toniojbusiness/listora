/**
 * What the Mercari scripts put into Mercari's listing form, built purely from the listing
 * content and Mercari's catalog, and Mercari's rules for it (golden-tested in `__golden__/`).
 * The payload extends the assisted one, so a step that falls back to the user copies the same
 * title, description, price, and photos.
 *
 * The category is a category of Mercari's catalog (catalog/catalog.json), and the catalog says
 * what its form asks for: the size list, from which the payload names the exact label to pick,
 * and whether it wants a phone's IMEI, which Listora doesn't have, so such a listing goes to the
 * seller. Mercari has no seller SKU field, so the scripts end the description with a line naming
 * the listing's SKU (`SKU: AJ-000184`). It is how a later attempt or a read-back finds a listing
 * whose id Listora never learned (a create that timed out after Mercari took it), so a create is
 * never posted twice. Reads strip the line again, so the description Listora verifies is the
 * listing's own (docs/features/mercari.md, "Finding a listing again"). Items Mercari prohibits
 * (prohibited.ts) are refused before anything is sent.
 */
import {
  photosInOrder,
  type AssistedListingPayload,
  type ItemCondition,
  type ItemSnapshot,
  type ListingVariant,
  type ValidationIssue,
} from '@listora/marketplaces';

import { SKU_LINE_RESERVE } from '../adapter/sku-line.ts';
import { mercariCatalog } from './catalog/catalog.ts';
import { matchMercariCategory, parseCategoryRef, type MercariCategory } from './categories.ts';
import { mercariCondition } from './conditions.ts';
import { prohibitedIssues } from './prohibited.ts';
import type { MercariShipping } from './shipping.ts';
import { mercariSizeLabel } from './sizes.ts';

export { listingSku, skuLine, splitSkuLine, withSkuLine } from '../adapter/sku-line.ts';

export interface MercariListingPayload extends AssistedListingPayload {
  /** The names to pick in the form's category dialog, top first; `null` when there is none. */
  category: string[] | null;
  /** Mercari's id of that category. */
  categoryId: number | null;
  /** Mercari's size label to pick (`M (8-10)`); `null` when the form asks none or none fits. */
  size: string | null;
  /** Whether the category's form asks for a size. */
  sized: boolean;
  /** A few of the category's sizes, for the message that asks for one. */
  sizeExamples: string[];
  /** Whether the category's form asks for the phone's IMEI. */
  imei: boolean;
  /** The brand to pick from Mercari's brand list; without it, or not listed, "No brand". */
  brand: string | null;
  /** The value and label of Mercari's condition option; `null` when the item has none. */
  condition: { id: number; label: string } | null;
  shipping: MercariShipping;
  /** The categories the user chooses between when Listora can't tell (a kids' item). */
  categoryOptions: string[];
  /** The item's own category and condition, whatever the listing's, for Mercari's rules. */
  source: { itemCategory: string | null; condition: ItemCondition | null };
}

/**
 * Mercari's limits as its sell form enforces them (read 2026-10-27): titles up to 80
 * characters, descriptions of at least five words and up to 1,000 characters, whole-dollar
 * prices from $1 to $2,000, and 1 to 12 photos.
 */
export const MERCARI_LIMITS = {
  titleMaxLength: 80,
  descriptionMaxLength: 1_000,
  descriptionMinWords: 5,
  minPriceCents: 100,
  maxPriceCents: 200_000,
  maxPhotos: 12,
} as const;

export function buildMercariPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): MercariListingPayload {
  const named = variant.categoryRef === null ? null : parseCategoryRef(variant.categoryRef);
  const match =
    variant.categoryRef === null
      ? matchMercariCategory(item.category, item.department, item.sizeLabel)
      : null;
  const category: MercariCategory | null =
    named ?? (match?.type === 'mapped' ? match.category : null);
  const group = category?.sizeGroupId ?? null;
  const labels = group === null ? [] : mercariCatalog().sizeLabels(group);
  const condition = variant.condition ?? item.condition;
  const mercari = condition === null ? null : mercariCondition(condition);
  const brand = item.brand?.trim() ?? '';
  return {
    title: variant.title,
    description: variant.description,
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    category: category === null ? null : [...category.path],
    categoryId: category?.id ?? null,
    size: labels.length === 0 ? null : mercariSizeLabel(item, labels),
    sized: labels.length > 0,
    sizeExamples: labels.slice(0, 4),
    imei: category?.imei ?? false,
    brand: brand === '' ? null : brand,
    condition: mercari === null ? null : { id: mercari.id, label: mercari.label },
    shipping: { payer: 'buyer', method: 'prepaid_label' },
    categoryOptions:
      match?.type === 'choose' ? match.options.map((option) => option.path.join(' > ')) : [],
    source: { itemCategory: item.category, condition },
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
  const words = payload.description.split(/\s+/).filter((word) => word !== '').length;
  if (payload.description.trim() === '') {
    issues.push({
      field: 'variant.description',
      code: 'required',
      message: 'Mercari needs a description.',
    });
  } else if (words < limits.descriptionMinWords) {
    issues.push({
      field: 'variant.description',
      code: 'too_short',
      message: `Mercari descriptions need at least ${String(limits.descriptionMinWords)} words.`,
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
    const [first, second] = payload.categoryOptions;
    issues.push({
      field: 'variant.categoryRef',
      code: 'required',
      message:
        first !== undefined && second !== undefined
          ? `Mercari files kids' items as girls' or boys'. Choose '${first}' or '${second}'.`
          : "Listora has no Mercari category for this item. Choose one, for example 'Women > Shoes > Boots'.",
    });
  } else if (payload.imei) {
    issues.push({
      field: 'variant.categoryRef',
      code: 'not_supported',
      message:
        "Mercari asks for the phone's IMEI in this category, which Listora doesn't have. List it in Mercari.",
    });
  }
  if (payload.condition === null) {
    issues.push({
      field: 'item.condition',
      code: 'required',
      message: 'Mercari needs the item condition.',
    });
  }
  issues.push(
    ...prohibitedIssues({
      title: payload.title,
      description: payload.description,
      itemCategory: payload.source.itemCategory,
      condition: payload.source.condition,
    }),
  );
  if (payload.sized && payload.size === null) {
    const examples = payload.sizeExamples.join(', ');
    issues.push({
      field: 'item.sizeLabel',
      code: 'required',
      message: `Mercari needs a size it lists for this category (for example ${examples}).`,
    });
  }
  return issues;
}
