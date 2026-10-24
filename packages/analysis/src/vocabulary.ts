/**
 * Listora's canonical item vocabulary: the values an analysis may propose for the details
 * that marketplace adapters map to each marketplace's own taxonomy, aspects, and conditions.
 * The model must pick from these lists (the output schema enforces it), so every analyzed
 * value has a deterministic mapping. Values are stable snake_case ids; never rename one.
 */
import type { ItemCondition } from '@listora/api-contract';
import { MATERIAL_NAMES, type Material, type SizeSystem } from '@listora/tag-parse';

/**
 * The category tree. A category path is `<category>/<subcategory>`, for example
 * `clothing/tops/t_shirts` (`ItemDetails.category`). Every category ends with `other`.
 */
export const CATEGORY_TREE = {
  'clothing/tops': [
    't_shirts',
    'shirts',
    'blouses',
    'tank_tops',
    'polos',
    'sweaters',
    'cardigans',
    'hoodies_sweatshirts',
    'bodysuits',
    'other',
  ],
  'clothing/bottoms': ['jeans', 'pants', 'shorts', 'skirts', 'leggings', 'joggers', 'other'],
  'clothing/dresses': ['dresses', 'jumpsuits_rompers', 'other'],
  'clothing/outerwear': ['jackets', 'coats', 'vests', 'blazers', 'other'],
  'clothing/activewear': ['tops', 'bottoms', 'sports_bras', 'sets', 'other'],
  'clothing/swimwear': ['one_pieces', 'bikinis', 'swim_trunks', 'cover_ups', 'other'],
  'clothing/sleep_lounge': ['pajamas', 'robes', 'loungewear', 'other'],
  'clothing/intimates': ['bras', 'underwear', 'shapewear', 'socks', 'other'],
  'clothing/suits_sets': ['suits', 'matching_sets', 'other'],
  shoes: [
    'sneakers',
    'boots',
    'sandals',
    'heels',
    'flats',
    'loafers',
    'dress_shoes',
    'slippers',
    'other',
  ],
  bags: [
    'handbags',
    'shoulder_bags',
    'crossbody_bags',
    'totes',
    'backpacks',
    'clutches',
    'wallets',
    'other',
  ],
  accessories: [
    'hats',
    'scarves',
    'belts',
    'sunglasses',
    'gloves',
    'hair_accessories',
    'ties',
    'watches',
    'other',
  ],
  jewelry: ['necklaces', 'earrings', 'bracelets', 'rings', 'brooches', 'other'],
  home: ['decor', 'kitchen', 'bedding', 'other'],
  other: ['other'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type Category = keyof typeof CATEGORY_TREE;
export type Subcategory = (typeof CATEGORY_TREE)[Category][number];

export const CATEGORIES = Object.keys(CATEGORY_TREE) as [Category, ...Category[]];
export const SUBCATEGORIES = [...new Set(Object.values(CATEGORY_TREE).flat())] as [
  Subcategory,
  ...Subcategory[],
];

export function isSubcategoryOf(category: Category, subcategory: string): boolean {
  return (CATEGORY_TREE[category] as readonly string[]).includes(subcategory);
}

/** `ItemDetails.category`: the canonical path, for example `clothing/tops/t_shirts`. */
export function categoryPath(category: Category, subcategory: Subcategory): string {
  return `${category}/${subcategory}`;
}

/** Who the item is made for (`ItemDetails.department`). */
export const DEPARTMENTS = ['women', 'men', 'kids', 'unisex'] as const;
export type Department = (typeof DEPARTMENTS)[number];

/** Size systems are the tag parsers' own, so a parsed size and an analyzed size compare. */
export const SIZE_SYSTEMS = [
  'letter',
  'numeric',
  'waist_inseam',
  'us',
  'uk',
  'eu',
  'one_size',
] as const satisfies readonly SizeSystem[];

export const COLORS = [
  'black',
  'white',
  'gray',
  'cream',
  'beige',
  'tan',
  'brown',
  'red',
  'pink',
  'orange',
  'yellow',
  'green',
  'blue',
  'navy',
  'purple',
  'gold',
  'silver',
  'multicolor',
] as const;
export type Color = (typeof COLORS)[number];

export const PATTERNS = [
  'solid',
  'striped',
  'plaid',
  'floral',
  'polka_dot',
  'animal_print',
  'camouflage',
  'graphic',
  'geometric',
  'paisley',
  'tie_dye',
  'colorblock',
  'abstract',
  'other',
] as const;
export type Pattern = (typeof PATTERNS)[number];

/**
 * Materials: the fibers the tag parsers recognize (their ids, so a parsed fiber and an
 * analyzed material compare), plus materials of shoes, bags, and jewelry that fiber tags do
 * not name.
 */
export const MATERIALS = [
  ...(Object.keys(MATERIAL_NAMES) as Material[]),
  'denim',
  'suede',
  'faux_leather',
  'faux_fur',
  'fur',
  'fleece',
  'down',
  'canvas',
  'rubber',
  'plastic',
  'metal',
  'gold',
  'sterling_silver',
  'wood',
] as const;
export type AnalyzedMaterial = (typeof MATERIALS)[number];

/** The contract's `ItemCondition`, in order from best to worst. */
export const CONDITIONS = [
  'new_with_tags',
  'new_without_tags',
  'new_with_defects',
  'pre_owned_excellent',
  'pre_owned_good',
  'pre_owned_fair',
] as const satisfies readonly ItemCondition[];
