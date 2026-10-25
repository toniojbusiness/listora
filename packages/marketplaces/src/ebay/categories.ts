/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to eBay US leaf categories. The ids and names come from eBay's
 * published US category structure (https://ir.ebaystatic.com/cr/v/c01/US_New_Structure_Jun2026.csv,
 * linked from https://pages.ebay.com/sellerinformation/news/categorychanges.html; checked
 * 2026-10-24), and `npm run ebay:sandbox-check` confirms each one is still a leaf.
 *
 * The map is the deterministic default and the input to Taxonomy suggestions: `prepareListing`
 * (adapter.ts) asks `getCategorySuggestions` for a finer leaf inside the mapped category's
 * branch, and keeps the mapped one when eBay suggests nothing there. A category the map does
 * not cover (kids, unisex, home, other) gets its category from the suggestions alone.
 */
import type { ConditionScheme } from './conditions.ts';

/** Which size item specific a category takes (sizes.ts). */
export type SizeAspect = 'clothing' | 'shoes' | 'none';

export interface EbayCategory {
  categoryId: string;
  /** eBay's name for the leaf, for messages. */
  name: string;
  /**
   * The branch the leaf is in: an ancestor name that a Taxonomy suggestion for the same item
   * must have, for example "Men's Clothing".
   */
  branch: string;
  conditionScheme: ConditionScheme;
  size: SizeAspect;
}

type Department = 'men' | 'women';

const category = (
  categoryId: string,
  name: string,
  branch: string,
  conditionScheme: ConditionScheme,
  size: SizeAspect,
): EbayCategory => ({ categoryId, name, branch, conditionScheme, size });

const menClothing = (id: string, name: string) =>
  category(id, name, "Men's Clothing", 'apparel', 'clothing');
const womenClothing = (id: string, name: string) =>
  category(id, name, "Women's Clothing", 'apparel', 'clothing');
const menShoes = (id: string, name: string) =>
  category(id, name, "Men's Shoes", 'general', 'shoes');
const womenShoes = (id: string, name: string) =>
  category(id, name, "Women's Shoes", 'general', 'shoes');
const menAccessory = (id: string, name: string) =>
  category(id, name, "Men's Accessories", 'general', 'none');
const womenAccessory = (id: string, name: string) =>
  category(id, name, "Women's Accessories", 'general', 'none');

/**
 * `<canonical path>` or `<category>` (the first two path segments for clothing, the first for
 * the rest), per department; the most specific key wins.
 */
const MAP: Readonly<Record<Department, Readonly<Record<string, EbayCategory>>>> = {
  men: {
    'clothing/tops': menClothing('15687', 'T-Shirts'),
    'clothing/tops/t_shirts': menClothing('15687', 'T-Shirts'),
    'clothing/tops/tank_tops': menClothing('15687', 'T-Shirts'),
    'clothing/tops/shirts': menClothing('57990', 'Casual Button-Down Shirts'),
    'clothing/tops/polos': menClothing('185101', 'Polos'),
    'clothing/tops/sweaters': menClothing('11484', 'Sweaters'),
    'clothing/tops/cardigans': menClothing('11484', 'Sweaters'),
    'clothing/tops/hoodies_sweatshirts': menClothing('155183', 'Hoodies & Sweatshirts'),
    'clothing/bottoms': menClothing('57989', 'Pants'),
    'clothing/bottoms/jeans': menClothing('11483', 'Jeans'),
    'clothing/bottoms/shorts': menClothing('15689', 'Shorts'),
    'clothing/outerwear': menClothing('57988', 'Coats, Jackets & Vests'),
    'clothing/activewear': menClothing('185076', 'Activewear Tops'),
    'clothing/activewear/bottoms': menClothing('260956', 'Activewear Pants'),
    'clothing/activewear/sets': menClothing('185708', 'Tracksuits & Sets'),
    'clothing/swimwear': menClothing('15690', 'Swimwear'),
    'clothing/sleep_lounge': menClothing('11510', 'Sleepwear & Robes'),
    'clothing/intimates/underwear': menClothing('11507', 'Underwear'),
    'clothing/intimates/socks': menClothing('11511', 'Socks'),
    'clothing/suits_sets/suits': menClothing('3001', 'Suits & Suit Separates'),
    'shoes/sneakers': menShoes('15709', 'Athletic Shoes'),
    'shoes/boots': menShoes('11498', 'Boots'),
    'shoes/sandals': menShoes('11504', 'Sandals'),
    'shoes/slippers': menShoes('11505', 'Slippers'),
    'shoes/dress_shoes': menShoes('53120', 'Dress Shoes'),
    'shoes/loafers': menShoes('24087', 'Casual Shoes'),
    'shoes/other': menShoes('24087', 'Casual Shoes'),
    'bags/wallets': menAccessory('2996', 'Wallets'),
    bags: menAccessory('52357', 'Bags'),
    'accessories/hats': menAccessory('52365', 'Hats'),
    'accessories/scarves': menAccessory('52382', 'Scarves'),
    'accessories/belts': menAccessory('2993', 'Belts'),
    'accessories/gloves': menAccessory('2994', 'Gloves & Mittens'),
    'accessories/ties': menAccessory('15662', 'Ties'),
  },
  women: {
    'clothing/tops': womenClothing('53159', 'Tops'),
    'clothing/tops/sweaters': womenClothing('63866', 'Sweaters'),
    'clothing/tops/cardigans': womenClothing('63866', 'Sweaters'),
    'clothing/tops/hoodies_sweatshirts': womenClothing('155226', 'Hoodies & Sweatshirts'),
    'clothing/bottoms': womenClothing('63863', 'Pants'),
    'clothing/bottoms/jeans': womenClothing('11554', 'Jeans'),
    'clothing/bottoms/shorts': womenClothing('11555', 'Shorts'),
    'clothing/bottoms/skirts': womenClothing('63864', 'Skirts'),
    'clothing/bottoms/leggings': womenClothing('169001', 'Leggings'),
    'clothing/dresses': womenClothing('63861', 'Dresses'),
    'clothing/dresses/jumpsuits_rompers': womenClothing('3009', 'Jumpsuits & Rompers'),
    'clothing/outerwear': womenClothing('63862', 'Coats, Jackets & Vests'),
    'clothing/activewear': womenClothing('185082', 'Activewear Tops'),
    'clothing/activewear/bottoms': womenClothing('260954', 'Activewear Pants'),
    'clothing/activewear/sports_bras': womenClothing('185083', 'Sports Bras'),
    'clothing/activewear/sets': womenClothing('185084', 'Tracksuits & Sets'),
    'clothing/swimwear': womenClothing('63867', 'Swimwear'),
    'clothing/sleep_lounge': womenClothing('63855', 'Sleepwear & Robes'),
    'clothing/intimates/bras': womenClothing('63853', 'Bras & Bra Sets'),
    'clothing/intimates/underwear': womenClothing('63854', 'Panties'),
    'clothing/intimates/shapewear': womenClothing('11530', 'Shapewear'),
    'clothing/intimates/socks': womenClothing('163588', 'Socks'),
    'clothing/suits_sets/suits': womenClothing('63865', 'Suits & Suit Separates'),
    'clothing/suits_sets/matching_sets': womenClothing('260011', 'Outfits & Sets'),
    'shoes/sneakers': womenShoes('95672', 'Athletic Shoes'),
    'shoes/boots': womenShoes('53557', 'Boots'),
    'shoes/sandals': womenShoes('62107', 'Sandals'),
    'shoes/heels': womenShoes('55793', 'Heels'),
    'shoes/flats': womenShoes('45333', 'Flats'),
    'shoes/loafers': womenShoes('45333', 'Flats'),
    'shoes/slippers': womenShoes('11632', 'Slippers'),
    'bags/wallets': womenAccessory('45258', 'Wallets'),
    bags: category('169291', "Women's Bags & Handbags", 'Women', 'general', 'none'),
    'accessories/hats': womenAccessory('45230', 'Hats'),
    'accessories/scarves': womenAccessory('45238', 'Scarves & Wraps'),
    'accessories/belts': womenAccessory('3003', 'Belts'),
    'accessories/gloves': womenAccessory('105559', 'Gloves & Mittens'),
    'accessories/hair_accessories': womenAccessory('45220', 'Hair Accessories'),
  },
};

/** The mapped eBay category for an item, or `null` when the map has none. */
export function mapEbayCategory(
  canonical: string | null,
  department: string | null,
): EbayCategory | null {
  if (canonical === null || (department !== 'men' && department !== 'women')) return null;
  const table = MAP[department];
  const segments = canonical.split('/');
  // The full path first, then shorter prefixes: `clothing/tops/t_shirts`, `clothing/tops`, ...
  for (let length = segments.length; length >= 1; length -= 1) {
    const found = table[segments.slice(0, length).join('/')];
    if (found !== undefined) return found;
  }
  return null;
}

/** Every mapped category once (for the sandbox check and the fake's fixtures). */
export function mappedEbayCategories(): EbayCategory[] {
  const byId = new Map<string, EbayCategory>();
  for (const table of Object.values(MAP)) {
    for (const entry of Object.values(table)) byId.set(entry.categoryId, entry);
  }
  return [...byId.values()];
}

/** The mapped category with this id, when the map has it. */
export function mappedEbayCategory(categoryId: string): EbayCategory | null {
  return mappedEbayCategories().find((entry) => entry.categoryId === categoryId) ?? null;
}

/**
 * How a category not in the map is treated, from the item's canonical category: clothing
 * takes the apparel conditions and a size, shoes a shoe size.
 */
export function categoryTraits(
  canonical: string | null,
): Pick<EbayCategory, 'conditionScheme' | 'size'> {
  if (canonical?.startsWith('clothing/') === true)
    return { conditionScheme: 'apparel', size: 'clothing' };
  if (canonical?.startsWith('shoes/') === true)
    return { conditionScheme: 'general', size: 'shoes' };
  return { conditionScheme: 'general', size: 'none' };
}
