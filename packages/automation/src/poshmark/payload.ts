/**
 * What the Poshmark automation adapter fills into Poshmark's listing form, built purely from the
 * listing content (golden-tested in `__golden__/`), and Poshmark's own rules for it.
 *
 * The payload extends the assisted one (title, description, price, photos in posting order), so a
 * step that falls back to the user copies the same text. Values come from the listing's variant
 * first and the item second, as for eBay: the variant's `categoryRef` names a Poshmark catalog
 * (`Men/Jackets & Coats/Vests`), its `Brand`, `Size`, and `Original Price` aspects win over the
 * item's, and its condition over the item's.
 *
 * Rules (sources in docs/features/poshmark.md): titles at most 80 characters and descriptions at
 * most 1,500 (Poshmark's Bulk Upload template, as in @listora/analysis); a price in whole
 * dollars (every price Poshmark's pages showed was) from $3
 * (`app_listing_fee__us.minimum_selling_price`) up to $1,000,000 (`max_listing_price_amount`);
 * at most 16 photos; a department, category, size, and condition, which the form requires; up to
 * two of Poshmark's colors; and nothing Poshmark prohibits (`prohibited.ts`: used underwear,
 * makeup, and personal care, replicas, and what its labels cannot ship).
 */
import type { JsonObject } from '@listora/db';
import type {
  AssistedListingPayload,
  ItemSnapshot,
  ListingVariant,
  ValidationIssue,
} from '@listora/marketplaces';
import { photosInOrder } from '@listora/marketplaces';
import { assertNever } from '@listora/shared';

import { isUnderwear } from '../adapter/underwear.ts';
import {
  mapPoshmarkCatalog,
  parseCatalogRef,
  sizeSetsFor,
  type PoshmarkCatalog,
} from './catalog.ts';
import { poshmarkColors } from './colors.ts';
import { poshmarkCondition, type PoshmarkCondition } from './conditions.ts';
import { prohibitedReason } from './prohibited.ts';
import { poshmarkSize, type PoshmarkSize } from './sizes.ts';

export interface PoshmarkListingPayload extends AssistedListingPayload {
  /** `null` when Listora can't place the item; validation then names what to set. */
  catalog: (PoshmarkCatalog & JsonObject) | null;
  size: (PoshmarkSize & JsonObject) | null;
  condition: (PoshmarkCondition & JsonObject) | null;
  brand: string | null;
  /** Poshmark's names of the item's colors, at most two (`colors.ts`). */
  colors: string[];
  /** What the item cost new, which Poshmark shows struck through; only when known. */
  originalPrice: { amountCents: number; currency: 'USD' } | null;
  /**
   * Where the size and category came from, for validation messages, and the item's own
   * category, whatever the listing's.
   */
  source: {
    category: string | null;
    department: string | null;
    sizeLabel: string | null;
    itemCategory: string | null;
  };
}

export const POSHMARK_LIMITS = {
  titleMaxLength: 80,
  descriptionMaxLength: 1_500,
  maxPhotos: 16,
  minPriceCents: 300,
  maxPriceCents: 100_000_000,
} as const;

export function buildPoshmarkPayload(
  item: ItemSnapshot,
  variant: ListingVariant,
): PoshmarkListingPayload {
  const aspect = (name: string): string | null => {
    const found = variant.aspects.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    const value = found?.values[0]?.trim();
    return value === undefined || value === '' ? null : value;
  };
  const catalog =
    variant.categoryRef === null
      ? mapPoshmarkCatalog(item.category, item.department)
      : parseCatalogRef(variant.categoryRef);
  const sizeLabel = aspect('Size') ?? item.sizeLabel;
  const sets = catalog === null ? null : sizeSetsFor(catalog.department, catalog.category);
  const size =
    sets === null || catalog === null
      ? null
      : // A `Size` aspect is Poshmark's own size (the review's pick), not the tag's to read.
        poshmarkSize(
          sizeLabel,
          aspect('Size') === null ? item.sizeSystem : null,
          sets,
          catalog.department,
        );
  const condition = variant.condition ?? item.condition;
  const originalCents = dollarsToCents(aspect('Original Price'));
  return {
    title: variant.title,
    description: variant.description,
    price: { amountCents: variant.price.amountCents, currency: variant.price.currency },
    photos: photosInOrder(item).map(({ photoId, url }) => ({ photoId, url })),
    catalog: catalog === null ? null : { ...catalog },
    size: size === null ? null : { ...size },
    condition: condition === null ? null : { ...poshmarkCondition(condition) },
    brand: aspect('Brand') ?? item.brand,
    colors: poshmarkColors(item.colors),
    originalPrice: originalCents === null ? null : { amountCents: originalCents, currency: 'USD' },
    source: {
      category: variant.categoryRef ?? item.category,
      department: item.department,
      sizeLabel,
      itemCategory: item.category,
    },
  };
}

/** Poshmark's rules, on top of the assisted ones (a price above $0, at least one photo). */
export function validatePoshmarkPayload(payload: PoshmarkListingPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const limits = POSHMARK_LIMITS;
  if (payload.title.length > limits.titleMaxLength) {
    issues.push({
      field: 'variant.title',
      code: 'too_long',
      message: `Poshmark titles can be at most ${String(limits.titleMaxLength)} characters.`,
    });
  }
  if (payload.description.trim() === '') {
    issues.push({
      field: 'variant.description',
      code: 'required',
      message: 'Poshmark needs a description.',
    });
  } else if (payload.description.length > limits.descriptionMaxLength) {
    issues.push({
      field: 'variant.description',
      code: 'too_long',
      message: `Poshmark descriptions can be at most ${limits.descriptionMaxLength.toLocaleString('en-US')} characters.`,
    });
  }
  const cents = payload.price.amountCents;
  if (cents > 0 && cents < limits.minPriceCents) {
    issues.push({
      field: 'variant.price',
      code: 'out_of_range',
      message: 'Poshmark prices start at $3.',
    });
  } else if (cents > limits.maxPriceCents) {
    issues.push({
      field: 'variant.price',
      code: 'out_of_range',
      message: 'Poshmark prices can be at most $1,000,000.',
    });
  }
  if (cents > 0 && cents % 100 !== 0) {
    issues.push({
      field: 'variant.price',
      code: 'whole_dollars',
      message: `Poshmark prices are whole dollars: use $${String(Math.round(cents / 100))} instead.`,
    });
  }
  if (payload.photos.length > limits.maxPhotos) {
    issues.push({
      field: 'item.photos',
      code: 'too_many',
      message: `Poshmark takes at most ${String(limits.maxPhotos)} photos.`,
    });
  }
  const { source } = payload;
  if (payload.catalog === null) {
    issues.push({
      field: 'variant.categoryRef',
      code: 'unmapped',
      message:
        source.category === null
          ? 'Poshmark needs a category: add the item category.'
          : `Listora can't place this ${describe(source)} in a Poshmark category yet. Choose one for the Poshmark listing.`,
    });
  } else if (payload.size === null) {
    issues.push({
      field: 'item.sizeLabel',
      code: source.sizeLabel === null ? 'required' : 'unmapped',
      message:
        source.sizeLabel === null
          ? `Poshmark needs a size for ${catalogName(payload.catalog)}.`
          : payload.catalog.department === 'Kids'
            ? `Poshmark files kids' sizes under Girls, Boys, or Baby, and "${source.sizeLabel}" doesn't say which one it is for ${catalogName(payload.catalog)}. Write the size as, for example, "Girls 8" or "Boys 8".`
            : `Poshmark has no size "${source.sizeLabel}" for ${catalogName(payload.catalog)}. Set a size Poshmark offers.`,
    });
  }
  if (payload.condition === null) {
    issues.push({
      field: 'item.condition',
      code: 'required',
      message: "Poshmark needs the item's condition.",
    });
  }
  const prohibited = prohibitedReason({
    catalog: payload.catalog,
    condition: payload.condition?.code ?? null,
    title: payload.title,
    description: payload.description,
    underwear: isUnderwear(source.itemCategory),
  });
  if (prohibited !== null) {
    issues.push({ field: prohibited.field, code: 'not_allowed', message: prohibited.message });
  }
  return issues;
}

function describe(source: PoshmarkListingPayload['source']): string {
  const department = source.department === null ? '' : `${source.department} `;
  return `${department}${source.category ?? 'item'}`.replaceAll('_', ' ');
}

function catalogName(catalog: PoshmarkCatalog): string {
  switch (catalog.department) {
    case 'Women':
    case 'Men':
      return `${catalog.department}'s ${catalog.category}`;
    case 'Kids':
      return `Kids' ${catalog.category}`;
    case 'Home':
    case 'Pets':
    case 'Electronics':
      return `${catalog.department} ${catalog.category}`;
    default:
      return assertNever(catalog.department, 'Poshmark department');
  }
}

/** `$110`, `110.00`, `110` → cents; `null` for anything else. */
function dollarsToCents(text: string | null): number | null {
  const match = text === null ? null : /^\$?\s*(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (match?.[1] === undefined) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}
