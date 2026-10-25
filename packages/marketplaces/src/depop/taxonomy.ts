/**
 * Depop's taxonomy, as far as Depop publishes it. A listing names its `department` and its
 * `product_type` (Depop's category), and a sized product type also its `size_set_id` and
 * `size_id`. Depop serves the full taxonomy only at https://api.depop.com/api/v3/attributes/,
 * which is "not yet serv[ed] through our Selling API" and has "bot-detection protection"
 * (https://partnerapi.depop.com/api-docs/concepts/taxonomy/). Listora never works around bot
 * checks, so it holds only what Depop's own documentation names (checked 2026-10-24):
 *
 * - the departments, conditions, and colours of the Selling API's openapi.yaml;
 * - the product types its taxonomy guide and API reference use as examples, mapped from the
 *   canonical categories they match exactly (`PRODUCT_TYPES`).
 *
 * Every other item names its Depop product type in the variant's `categoryRef`, and its size in
 * the aspects `size_set_id` and `size_id` (Depop's own field names). A snapshot of Depop's full
 * taxonomy, downloaded by hand once Listora's partner access is granted, replaces this
 * (`capabilities.taxonomy` is `static_snapshot`).
 */
import type { ItemCondition } from '../content.ts';

/** `department`: "Currently we support: womenswear, menswear, kidswear and everything-else." */
export const DEPOP_DEPARTMENTS = ['menswear', 'womenswear', 'kidswear', 'everything-else'] as const;
export type DepopDepartment = (typeof DEPOP_DEPARTMENTS)[number];

/** `condition` (ProductPutRequest). */
export const DEPOP_CONDITIONS = [
  'brand_new',
  'used_like_new',
  'used_excellent',
  'used_good',
  'used_fair',
] as const;
export type DepopCondition = (typeof DEPOP_CONDITIONS)[number];

/** `colour` (ProductPutRequest), at most two per listing. */
export const DEPOP_COLOURS = [
  'black',
  'grey',
  'white',
  'brown',
  'tan',
  'cream',
  'yellow',
  'red',
  'burgundy',
  'orange',
  'pink',
  'purple',
  'blue',
  'navy',
  'green',
  'khaki',
  'multi',
  'silver',
  'gold',
] as const;
export type DepopColour = (typeof DEPOP_COLOURS)[number];
export const DEPOP_MAX_COLOURS = 2;

/** A Depop taxonomy id: a product type or attribute id such as `joggers-tracksuits`. */
export const DEPOP_TAXONOMY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Canonical categories whose Depop product type Depop's documentation names: `tshirts` and
 * `dresses` (openapi.yaml examples), `jeans`, `joggers-tracksuits` ("Sweatpants"),
 * `swimsuit-one-piece`, `boots`, and `other-accessories` (the taxonomy guide).
 */
const PRODUCT_TYPES: Readonly<Record<string, string>> = {
  'clothing/tops/t_shirts': 'tshirts',
  'clothing/bottoms/jeans': 'jeans',
  'clothing/bottoms/joggers': 'joggers-tracksuits',
  'clothing/dresses/dresses': 'dresses',
  'clothing/swimwear/one_pieces': 'swimsuit-one-piece',
  'shoes/boots': 'boots',
  'accessories/other': 'other-accessories',
};

/** The Depop product type of a canonical category, when Depop's documentation names it. */
export function depopProductType(category: string | null): string | null {
  return category === null ? null : (PRODUCT_TYPES[category] ?? null);
}

/** The Depop department of an item: clothing by who it is for, home and other items apart. */
export function depopDepartment(
  department: string | null,
  category: string | null,
): DepopDepartment | null {
  if (category !== null && (category.startsWith('home/') || category.startsWith('other/'))) {
    return 'everything-else';
  }
  switch (department) {
    case 'men':
      return 'menswear';
    case 'women':
      return 'womenswear';
    case 'kids':
      return 'kidswear';
    case null:
    default:
      // Depop has no unisex department; the seller picks one.
      return null;
  }
}

/**
 * Listora's conditions in Depop's terms. Depop's grades are "brand new" and four used grades,
 * so unworn items are brand new and a new item with defects is graded as used (excellent),
 * with its flaws in the description.
 */
const CONDITIONS = {
  new_with_tags: 'brand_new',
  new_without_tags: 'brand_new',
  new_with_defects: 'used_excellent',
  pre_owned_excellent: 'used_excellent',
  pre_owned_good: 'used_good',
  pre_owned_fair: 'used_fair',
} as const satisfies Record<ItemCondition, DepopCondition>;

export function depopCondition(condition: ItemCondition | null): DepopCondition | null {
  return condition === null ? null : CONDITIONS[condition];
}

/** Listora's colours that have a Depop colour of the same meaning. */
const COLOURS: Readonly<Record<string, DepopColour>> = {
  black: 'black',
  gray: 'grey',
  white: 'white',
  brown: 'brown',
  tan: 'tan',
  cream: 'cream',
  yellow: 'yellow',
  red: 'red',
  burgundy: 'burgundy',
  orange: 'orange',
  pink: 'pink',
  purple: 'purple',
  blue: 'blue',
  navy: 'navy',
  green: 'green',
  khaki: 'khaki',
  multicolor: 'multi',
  silver: 'silver',
  gold: 'gold',
};

/** The item's colours as Depop names them, in order, at most two. */
export function depopColours(colors: readonly string[]): DepopColour[] {
  const mapped = colors.flatMap((color) => {
    const colour = COLOURS[color.toLowerCase()];
    return colour === undefined ? [] : [colour];
  });
  return [...new Set(mapped)].slice(0, DEPOP_MAX_COLOURS);
}
