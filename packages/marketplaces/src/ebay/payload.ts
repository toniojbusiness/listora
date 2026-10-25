/**
 * The eBay listing payload: Listora's listing content in the Trading API's terms
 * (AddFixedPriceItem, https://developer.ebay.com/devzone/xml/docs/reference/ebay/AddFixedPriceItem.html).
 * `buildEbayPayload` and `validateEbayPayload` are pure and golden-tested (`__golden__/`).
 *
 * What the builder decides:
 * - the keyword title as the variant has it (at most 80 characters);
 * - the description as HTML (description.ts);
 * - the category: the variant's `categoryRef` (set by `prepareListing` from Taxonomy
 *   suggestions, or by the user), else the canonical category map (categories.ts);
 * - the condition id for the category's condition scheme (conditions.ts), and the condition
 *   notes and flaws as the condition description;
 * - item specifics: Brand, Department, the standard size (sizes.ts), Color, Material, Pattern,
 *   and MPN from the item, then the variant's own aspects, which win by name;
 * - the photos in posting order (uploaded to eBay Picture Services when sent).
 *
 * The SKU, the UUID (duplicate protection), and the seller's shipping, payment, and return
 * terms are not content: the adapter adds them per attempt (adapter.ts).
 */
import type { JsonObject } from '@listora/db';
import type { CurrencyCode } from '@listora/shared';

import type { ValidationIssue } from '../adapter.ts';
import {
  photosInOrder,
  type ItemSnapshot,
  type ListingAspect,
  type ListingVariant,
} from '../content.ts';
import { categoryTraits, mapEbayCategory, mappedEbayCategory } from './categories.ts';
import { ebayConditionId, takesConditionDescription } from './conditions.ts';
import { descriptionHtml } from './description.ts';
import { ebaySizeSpecifics } from './sizes.ts';

export interface EbayItemSpecific extends JsonObject {
  name: string;
  values: string[];
}

export interface EbayListingPayload extends JsonObject {
  title: string;
  /** `Item.Description`: the variant's text as HTML. */
  descriptionHtml: string;
  /** `Item.PrimaryCategory.CategoryID`; `null` when the item has no eBay category yet. */
  categoryId: string | null;
  conditionId: number | null;
  conditionDescription: string | null;
  priceCents: number;
  currency: CurrencyCode;
  /** The photos' public URLs in posting order (the cover first). */
  photoUrls: string[];
  itemSpecifics: EbayItemSpecific[];
}

/** eBay's limits (AddFixedPriceItem field reference). */
export const EBAY_LIMITS = {
  title: 80,
  description: 500_000,
  conditionDescription: 1_000,
  photos: 24,
  itemSpecifics: 45,
  itemSpecificName: 65,
  itemSpecificValue: 65,
  itemSpecificValues: 30,
} as const;

/** eBay's color names (the Color aspect's values) for Listora's canonical colors. */
const COLORS: Readonly<Record<string, string>> = {
  cream: 'Ivory',
  tan: 'Beige',
  navy: 'Blue',
  multicolor: 'Multicolor',
};

const DEPARTMENTS: Readonly<Record<string, string>> = {
  men: 'Men',
  women: 'Women',
  unisex: 'Unisex Adults',
};

export function buildEbayPayload(item: ItemSnapshot, variant: ListingVariant): EbayListingPayload {
  const mapped = mapEbayCategory(item.category, item.department);
  const traits = mapped ?? categoryTraits(item.category);
  const condition = variant.condition ?? item.condition;
  const conditionId =
    condition === null ? null : ebayConditionId(condition, traits.conditionScheme);
  return {
    title: variant.title,
    descriptionHtml: descriptionHtml(variant.description),
    categoryId: variant.categoryRef ?? mapped?.categoryId ?? null,
    conditionId,
    conditionDescription:
      conditionId !== null && takesConditionDescription(conditionId) ? conditionNotes(item) : null,
    priceCents: variant.price.amountCents,
    currency: variant.price.currency,
    photoUrls: photosInOrder(item).map((photo) => photo.url),
    itemSpecifics: itemSpecifics(item, variant, traits.size),
  };
}

function conditionNotes(item: ItemSnapshot): string | null {
  const parts = [
    item.conditionNotes?.trim() ?? '',
    item.flaws.length === 0 ? '' : `Flaws: ${item.flaws.join('; ')}.`,
  ].filter((part) => part !== '');
  return parts.length === 0 ? null : parts.join(' ');
}

function itemSpecifics(
  item: ItemSnapshot,
  variant: ListingVariant,
  size: ReturnType<typeof categoryTraits>['size'],
): EbayItemSpecific[] {
  const derived: ListingAspect[] = [
    { name: 'Brand', values: [brandName(item.brand)] },
    ...optional('Department', item.department === null ? undefined : DEPARTMENTS[item.department]),
    ...ebaySizeSpecifics(item, size),
    ...optional('Color', item.colors.length === 0 ? undefined : colorName(item.colors[0] ?? '')),
    ...list('Material', unique(item.materials.map(materialName))),
    ...optional(
      'Pattern',
      item.pattern === null || item.pattern === 'other' ? undefined : titleCase(item.pattern),
    ),
    ...optional('MPN', item.styleNumber ?? undefined),
  ];
  // The variant's aspects are the seller's (or Taxonomy's) choice: they replace derived ones.
  const own = new Map(variant.aspects.map((aspect) => [aspect.name.toLowerCase(), aspect]));
  const merged = derived.map((aspect) => own.get(aspect.name.toLowerCase()) ?? aspect);
  const derivedNames = new Set(derived.map((aspect) => aspect.name.toLowerCase()));
  const extra = variant.aspects.filter((aspect) => !derivedNames.has(aspect.name.toLowerCase()));
  return [...merged, ...extra].map(({ name, values }) => ({ name, values: [...values] }));
}

/** eBay's convention for an item without a brand is `Unbranded`. */
function brandName(brand: string | null): string {
  const trimmed = brand?.trim() ?? '';
  return trimmed === '' ? 'Unbranded' : trimmed;
}

function optional(name: string, value: string | undefined): ListingAspect[] {
  return value === undefined || value.trim() === '' ? [] : [{ name, values: [value.trim()] }];
}

function list(name: string, values: string[]): ListingAspect[] {
  return values.length === 0 ? [] : [{ name, values }];
}

function colorName(color: string): string {
  return COLORS[color] ?? titleCase(color);
}

/** `100% cotton` → `Cotton`, `faux_leather` → `Faux Leather`. */
function materialName(material: string): string {
  return titleCase(material.replace(/^\s*\d{1,3}\s*%\s*/, ''));
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .trim()
    .split(/\s+/)
    .map((word) => (word === '' ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join(' ');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

export function validateEbayPayload(payload: EbayListingPayload): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (field: string, code: string, message: string): void => {
    issues.push({ field, code, message });
  };

  if (payload.title.trim() === '') {
    issue('variant.title', 'required', 'eBay needs a title.');
  } else if (payload.title.length > EBAY_LIMITS.title) {
    issue(
      'variant.title',
      'too_long',
      `eBay titles can be at most ${String(EBAY_LIMITS.title)} characters.`,
    );
  } else if (payload.title !== payload.title.trim()) {
    issue('variant.title', 'untrimmed', "eBay titles can't start or end with a space.");
  } else if (/<[a-z!/]/i.test(payload.title)) {
    issue('variant.title', 'invalid', "eBay titles can't contain HTML.");
  }

  if (payload.descriptionHtml.trim() === '') {
    issue('variant.description', 'required', 'eBay needs a description.');
  } else if (payload.descriptionHtml.length > EBAY_LIMITS.description) {
    issue('variant.description', 'too_long', 'This description is too long for eBay.');
  } else if (/^(?:\s|<br>)|(?:\s|<br>)$/.test(payload.descriptionHtml)) {
    issue(
      'variant.description',
      'untrimmed',
      "eBay descriptions can't start or end with a space or a blank line.",
    );
  }

  if (payload.priceCents <= 0) {
    issue('variant.price', 'out_of_range', 'eBay needs a price above $0.');
  }

  if (payload.photoUrls.length === 0) {
    issue('item.photos', 'required', 'eBay needs at least one photo.');
  } else if (payload.photoUrls.length > EBAY_LIMITS.photos) {
    issue('item.photos', 'too_many', `eBay takes at most ${String(EBAY_LIMITS.photos)} photos.`);
  }

  if (payload.categoryId === null) {
    issue('variant.categoryRef', 'required', 'eBay needs a category for this item.');
  }
  if (payload.conditionId === null) {
    issue('item.condition', 'required', "eBay needs the item's condition.");
  }
  if (
    payload.conditionDescription !== null &&
    payload.conditionDescription.length > EBAY_LIMITS.conditionDescription
  ) {
    issue(
      'item.conditionNotes',
      'too_long',
      `eBay condition notes can be at most ${String(EBAY_LIMITS.conditionDescription)} characters, flaws included.`,
    );
  }

  const size = payload.categoryId === null ? null : mappedEbayCategory(payload.categoryId)?.size;
  const has = (name: string): boolean =>
    payload.itemSpecifics.some((specific) => specific.name.toLowerCase() === name.toLowerCase());
  if (size === 'clothing' && !has('Size')) {
    issue(
      'item.sizeLabel',
      'not_standard',
      'eBay needs a standard size for clothing, for example M or 32.',
    );
  } else if (size === 'shoes' && !has('US Shoe Size')) {
    issue('item.sizeLabel', 'not_standard', 'eBay needs the US shoe size, for example 9 or 10.5.');
  }

  if (payload.itemSpecifics.length > EBAY_LIMITS.itemSpecifics) {
    issue(
      'variant.aspects',
      'too_many',
      `eBay takes at most ${String(EBAY_LIMITS.itemSpecifics)} item specifics.`,
    );
  }
  for (const specific of payload.itemSpecifics) {
    if (specific.name.length > EBAY_LIMITS.itemSpecificName) {
      issue(
        'variant.aspects',
        'too_long',
        `eBay item specific names can be at most ${String(EBAY_LIMITS.itemSpecificName)} characters.`,
      );
    } else if (specific.values.length > EBAY_LIMITS.itemSpecificValues) {
      issue(
        'variant.aspects',
        'too_many',
        `eBay takes at most ${String(EBAY_LIMITS.itemSpecificValues)} values for ${specific.name}.`,
      );
    } else if (specific.values.some((value) => value.length > EBAY_LIMITS.itemSpecificValue)) {
      issue(
        'variant.aspects',
        'too_long',
        `eBay values for ${specific.name} can be at most ${String(EBAY_LIMITS.itemSpecificValue)} characters.`,
      );
    }
  }
  return issues;
}
