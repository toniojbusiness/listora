/**
 * What the Vinted scripts put into Vinted's upload form, built purely from the listing content,
 * and Vinted's rules for it (golden-tested in `__golden__/`). The payload extends the assisted
 * one, so a step that falls back to the seller copies the same title, description, price, and
 * photos (docs/features/vinted.md, "Create, price, hide, and unhide").
 *
 * - The category is a path of Vinted's category list (categories.ts), picked level by level.
 * - The condition is one of Vinted's five, never claiming more than the item's: "Very good" is
 *   pre-owned.
 * - Brand and size are picked on the form from Vinted's own lists: the brand matched by name
 *   (Vinted's "No brand" when it lists none), the size by the item's label. Vinted's size lists
 *   depend on the category and are not mapped yet (the taxonomy snapshot, Vinted plan M2), so a
 *   size the form doesn't offer stops the create before anything is sent.
 * - Colours: up to two, in Vinted's names.
 * - Package size sets the buyer's shipping: Vinted's form recommends one for the category, which
 *   Listora keeps unless the listing names one (a `Package size` aspect: small, medium, large).
 * - Vinted has no seller SKU field, so the scripts end the description with Listora's SKU line
 *   (`SKU: AJ-000184`), how a later attempt or a read-back finds a listing whose id Listora never
 *   learned; Vinted bans the same item listed twice, so a create is never posted twice.
 */
import {
  photosInOrder,
  VINTED_MAX_PHOTOS,
  type AssistedListingPayload,
  type ItemCondition,
  type ItemSnapshot,
  type ListingVariant,
  type ValidationIssue,
} from '@listora/marketplaces';

import { SKU_LINE_RESERVE } from '../adapter/sku-line.ts';
import { matchVintedCategory, parseVintedCategoryRef } from './categories.ts';

/** Vinted's package sizes, as its upload form offers them. */
export const VINTED_PACKAGE_SIZES = ['small', 'medium', 'large'] as const;
export type VintedPackageSize = (typeof VINTED_PACKAGE_SIZES)[number];

export interface VintedListingPayload extends AssistedListingPayload {
  /** The names to pick in the form's category list, top first; `null` when there is none. */
  category: string[] | null;
  /** Examples of categories to choose from when Listora can't tell (a jacket of no kind). */
  categoryExamples: string[];
  /** The brand to pick from Vinted's list; without it, or not listed, Vinted's "No brand". */
  brand: string | null;
  /** The item's size label, picked from the category's size list when the form asks one. */
  size: string | null;
  /** Vinted's condition label (`Very good`); `null` when the item has none. */
  condition: string | null;
  /** Up to two of Vinted's colour names (`Light blue` is `Blue` here: Listora has no shade). */
  colors: string[];
  /** The package size the listing names; `null` keeps the one Vinted's form recommends. */
  packageSize: VintedPackageSize | null;
}

/**
 * Vinted's limits for a listing (modeled from its US help center and the upload form until the
 * mapping, Vinted plan M2, reads the form's own): up to 20 photos, a title of up to 100
 * characters, a description of up to 2,000, and a price from $1 to $5,000 in cents.
 */
export const VINTED_LIMITS = {
  titleMinLength: 3,
  titleMaxLength: 100,
  descriptionMaxLength: 2_000,
  minPriceCents: 100,
  maxPriceCents: 500_000,
  maxPhotos: VINTED_MAX_PHOTOS,
  maxColors: 2,
} as const;

/** Vinted's conditions in Listora's terms, never claiming more than the item's. */
const CONDITIONS: Readonly<Record<ItemCondition, string>> = {
  new_with_tags: 'New with tags',
  new_without_tags: 'New without tags',
  // New, but not as new: Vinted's "Very good" is for items with slight signs of use.
  new_with_defects: 'Good',
  pre_owned_excellent: 'Very good',
  pre_owned_good: 'Good',
  pre_owned_fair: 'Satisfactory',
};

/** Listora's colours (packages/analysis `COLORS`) in Vinted's names. */
const COLOURS: Readonly<Record<string, string>> = {
  black: 'Black',
  white: 'White',
  gray: 'Grey',
  cream: 'Cream',
  beige: 'Beige',
  tan: 'Beige',
  brown: 'Brown',
  red: 'Red',
  pink: 'Pink',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  navy: 'Navy',
  purple: 'Purple',
  gold: 'Gold',
  silver: 'Silver',
  multicolor: 'Multi',
};

export function buildVintedPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): VintedListingPayload {
  const named = variant.categoryRef === null ? null : parseVintedCategoryRef(variant.categoryRef);
  const match =
    variant.categoryRef === null
      ? matchVintedCategory(item.category, item.department, {
          title: variant.title,
          productName: item.productName,
        })
      : null;
  const category = named ?? (match?.type === 'mapped' ? match.path : null);
  const condition = variant.condition ?? item.condition;
  const brand = item.brand?.trim() ?? '';
  const size = aspect(variant, 'size') ?? item.sizeLabel?.trim() ?? '';
  const colors = [
    ...new Set(item.colors.flatMap((color) => COLOURS[color.toLowerCase()] ?? [])),
  ].slice(0, VINTED_LIMITS.maxColors);
  return {
    title: variant.title,
    description: variant.description,
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    category: category === null ? null : [...category],
    categoryExamples: match?.type === 'by_kind' ? [...match.examples] : [],
    brand: brand === '' ? null : brand,
    size: size === '' ? null : size,
    condition: condition === null ? null : CONDITIONS[condition],
    colors,
    packageSize: packageSize(aspect(variant, 'package size')),
  };
}

/**
 * Vinted's rules on top of the assisted ones (which already refuse a price of $0 or less, a
 * listing without photos, and more than 20 photos).
 */
export function validateVintedPayload(payload: VintedListingPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const limits = VINTED_LIMITS;
  const title = payload.title.trim();
  if (title.length < limits.titleMinLength) {
    issues.push({
      field: 'variant.title',
      code: 'too_short',
      message: `Vinted titles need at least ${String(limits.titleMinLength)} characters.`,
    });
  } else if (payload.title.length > limits.titleMaxLength) {
    issues.push({
      field: 'variant.title',
      code: 'too_long',
      message: `Vinted titles can be at most ${String(limits.titleMaxLength)} characters.`,
    });
  }
  const descriptionMax = limits.descriptionMaxLength - SKU_LINE_RESERVE;
  if (payload.description.trim() === '') {
    issues.push({
      field: 'variant.description',
      code: 'required',
      message: 'Vinted needs a description.',
    });
  } else if (payload.description.length > descriptionMax) {
    issues.push({
      field: 'variant.description',
      code: 'too_long',
      message: `Vinted descriptions can be at most ${String(descriptionMax)} characters here (Listora adds a SKU line to the ${String(limits.descriptionMaxLength)} Vinted allows).`,
    });
  }
  const cents = payload.price.amountCents;
  if (cents > 0 && (cents < limits.minPriceCents || cents > limits.maxPriceCents)) {
    issues.push({
      field: 'variant.price',
      code: 'out_of_range',
      message: 'Vinted prices are from $1 to $5,000.',
    });
  }
  if (payload.category === null) {
    const [example] = payload.categoryExamples;
    issues.push({
      field: 'variant.categoryRef',
      code: 'required',
      message:
        example === undefined
          ? "Listora has no Vinted category for this item. Choose one, for example 'Women > Clothing > Dresses > Mini-dresses'."
          : `Vinted files this by its kind. Choose its category, for example '${example}'.`,
    });
  }
  if (payload.condition === null) {
    issues.push({
      field: 'item.condition',
      code: 'required',
      message: 'Vinted needs the item condition.',
    });
  }
  return issues;
}

/** The variant's aspect of that name (any case), trimmed; `null` without one. */
function aspect(variant: ListingVariant, name: string): string | null {
  const value = variant.aspects
    .find((one) => one.name.trim().toLowerCase() === name)
    ?.values[0]?.trim();
  return value === undefined || value === '' ? null : value;
}

function packageSize(named: string | null): VintedPackageSize | null {
  const value = named?.toLowerCase() ?? null;
  return VINTED_PACKAGE_SIZES.find((size) => size === value) ?? null;
}
