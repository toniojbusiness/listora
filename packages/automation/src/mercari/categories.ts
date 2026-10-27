/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to Mercari US categories, which the listing form picks level by
 * level (department, category, subcategory). The names are Listora's model of Mercari's US
 * category tree as its site presents it; the sell form is behind Mercari's bot protection,
 * which Listora never gets around, so they are confirmed in the first linked session
 * (docs/mercari.md, "Live verification"). A name the form does not offer stops the create
 * before anything is sent, and the user lists the item.
 *
 * Each entry also says which size list the category takes and the package weight Mercari's
 * prepaid label defaults to for it: a generous upper bound for the category, so a label is
 * never short (docs/mercari.md, "Shipping"). The most specific key wins, as in eBay's map.
 * Kids' and unisex items, and canonical categories without an entry (home, other), get no
 * category: the listing then asks the user for one (`variant.categoryRef`).
 */
import type { ShippingWeight } from './shipping.ts';

/** Which of Mercari's size lists a category takes. */
export type MercariSizeKind = 'clothing' | 'shoes' | 'none';

export interface MercariCategory {
  /** The names to pick, top level first: `['Men', 'Coats & jackets']`. */
  path: readonly string[];
  size: MercariSizeKind;
  weight: ShippingWeight;
}

type Department = 'men' | 'women';

const clothing = (weight: ShippingWeight, ...path: string[]): MercariCategory => ({
  path,
  size: 'clothing',
  weight,
});
const shoes = (weight: ShippingWeight, ...path: string[]): MercariCategory => ({
  path,
  size: 'shoes',
  weight,
});
const unsized = (weight: ShippingWeight, ...path: string[]): MercariCategory => ({
  path,
  size: 'none',
  weight,
});

/**
 * Every path is one Mercari's category dialog offers, checked against the whole men's and women's
 * trees read on the seller's session (2026-10-27): a path that stops at a category with
 * subcategories picks its "All <category>" row (listing-form.ts).
 */
const MAP: Readonly<Record<Department, Readonly<Record<string, MercariCategory>>>> = {
  men: {
    'clothing/tops': clothing('8 oz', 'Men', 'Tops', 'T-shirts'),
    'clothing/tops/shirts': clothing('12 oz', 'Men', 'Tops', 'Button-front'),
    'clothing/tops/polos': clothing('12 oz', 'Men', 'Tops', 'Polos'),
    'clothing/tops/tank_tops': clothing('8 oz', 'Men', 'Tops', 'Tank'),
    'clothing/tops/sweaters': clothing('2 lb', 'Men', 'Sweaters'),
    'clothing/tops/cardigans': clothing('2 lb', 'Men', 'Sweaters', 'Cardigan'),
    'clothing/tops/hoodies_sweatshirts': clothing('2 lb', 'Men', 'Sweats & hoodies'),
    'clothing/bottoms': clothing('2 lb', 'Men', 'Pants'),
    'clothing/bottoms/jeans': clothing('2 lb', 'Men', 'Jeans'),
    'clothing/bottoms/shorts': clothing('1 lb', 'Men', 'Shorts'),
    'clothing/bottoms/joggers': clothing('1 lb', 'Men', 'Sweats & hoodies', 'Sweat Pants'),
    'clothing/outerwear': clothing('3 lb', 'Men', 'Coats & jackets'),
    'clothing/outerwear/vests': clothing('2 lb', 'Men', 'Coats & jackets', 'Vest'),
    'clothing/outerwear/blazers': clothing('3 lb', 'Men', 'Blazers & sport coats'),
    'clothing/activewear': clothing('1 lb', 'Men', 'Athletic apparel'),
    'clothing/swimwear': clothing('12 oz', 'Men', 'Swimwear'),
    // Mercari has no men's sleepwear, underwear, or socks category (read 2026-10-27): Other,
    // whose form asks no size.
    'clothing/sleep_lounge': unsized('1 lb', 'Men', 'Other'),
    'clothing/intimates': unsized('8 oz', 'Men', 'Other'),
    'clothing/intimates/socks': unsized('8 oz', 'Men', 'Other'),
    'clothing/suits_sets': clothing('3 lb', 'Men', 'Suits'),
    shoes: shoes('3 lb', 'Men', 'Shoes'),
    'shoes/sneakers': shoes('3 lb', 'Men', 'Shoes', 'Athletic'),
    'shoes/boots': shoes('5 lb', 'Men', 'Shoes', 'Boots'),
    'shoes/sandals': shoes('2 lb', 'Men', 'Shoes', 'Sandals'),
    'shoes/loafers': shoes('3 lb', 'Men', 'Shoes', 'Loafers'),
    'shoes/dress_shoes': shoes('3 lb', 'Men', 'Shoes', 'Oxfords'),
    'shoes/slippers': shoes('2 lb', 'Men', 'Shoes', 'Slippers'),
    bags: unsized('3 lb', 'Men', "Men's accessories", 'Bags'),
    'bags/wallets': unsized('8 oz', 'Men', "Men's accessories", 'Wallets'),
    accessories: unsized('12 oz', 'Men', "Men's accessories"),
    'accessories/hats': unsized('1 lb', 'Men', "Men's accessories", 'Hats'),
    'accessories/belts': unsized('12 oz', 'Men', "Men's accessories", 'Belts'),
    'accessories/ties': unsized('8 oz', 'Men', "Men's accessories", 'Ties'),
    'accessories/sunglasses': unsized('12 oz', 'Men', "Men's accessories", 'Sunglasses'),
    'accessories/watches': unsized('1 lb', 'Men', "Men's accessories", 'Watches'),
    jewelry: unsized('8 oz', 'Men', 'Jewelry'),
  },
  women: {
    'clothing/tops': clothing('8 oz', 'Women', 'Tops & blouses'),
    'clothing/tops/t_shirts': clothing('8 oz', 'Women', 'Tops & blouses', 'T-shirts'),
    'clothing/tops/shirts': clothing('12 oz', 'Women', 'Tops & blouses', 'Button down shirt'),
    'clothing/tops/blouses': clothing('12 oz', 'Women', 'Tops & blouses', 'Blouse'),
    'clothing/tops/tank_tops': clothing('8 oz', 'Women', 'Tops & blouses', 'Tank Tops'),
    'clothing/tops/polos': clothing('12 oz', 'Women', 'Tops & blouses', 'Polo shirt'),
    'clothing/tops/bodysuits': clothing('8 oz', 'Women', 'Tops & blouses', 'Bodysuits'),
    'clothing/tops/sweaters': clothing('2 lb', 'Women', 'Sweaters'),
    'clothing/tops/cardigans': clothing('2 lb', 'Women', 'Sweaters', 'Cardigan'),
    'clothing/tops/hoodies_sweatshirts': clothing(
      '2 lb',
      'Women',
      'Athletic apparel',
      'Athletic Sweatshirts',
    ),
    'clothing/bottoms': clothing('2 lb', 'Women', 'Pants'),
    'clothing/bottoms/jeans': clothing('2 lb', 'Women', 'Jeans'),
    'clothing/bottoms/shorts': clothing('1 lb', 'Women', 'Shorts'),
    'clothing/bottoms/skirts': clothing('1 lb', 'Women', 'Skirts'),
    'clothing/bottoms/leggings': clothing(
      '12 oz',
      'Women',
      'Athletic apparel',
      'Athletic Leggings',
    ),
    'clothing/dresses': clothing('2 lb', 'Women', 'Dresses'),
    'clothing/dresses/jumpsuits_rompers': clothing(
      '2 lb',
      'Women',
      'Dresses',
      'Jumpsuits & Rompers',
    ),
    'clothing/outerwear': clothing('3 lb', 'Women', 'Coats & jackets'),
    'clothing/outerwear/vests': clothing('2 lb', 'Women', 'Coats & jackets', 'Vest'),
    'clothing/outerwear/blazers': clothing('2 lb', 'Women', 'Suits & blazers', 'Blazer'),
    'clothing/activewear': clothing('1 lb', 'Women', 'Athletic apparel'),
    'clothing/activewear/sports_bras': clothing('8 oz', 'Women', 'Athletic apparel', 'Sports bras'),
    'clothing/swimwear': clothing('12 oz', 'Women', 'Swimwear'),
    'clothing/sleep_lounge': clothing('1 lb', 'Women', 'Sleepwear & robes'),
    'clothing/intimates': clothing('8 oz', 'Women', 'Underwear'),
    'clothing/intimates/bras': clothing('8 oz', 'Women', 'Underwear', 'Bras'),
    'clothing/intimates/socks': clothing('8 oz', 'Women', 'Athletic apparel', 'Socks'),
    'clothing/suits_sets': clothing('3 lb', 'Women', 'Suits & blazers'),
    shoes: shoes('3 lb', 'Women', 'Shoes'),
    'shoes/sneakers': shoes('3 lb', 'Women', 'Shoes', 'Athletic'),
    'shoes/boots': shoes('5 lb', 'Women', 'Shoes', 'Boots'),
    'shoes/sandals': shoes('2 lb', 'Women', 'Shoes', 'Sandals'),
    'shoes/heels': shoes('3 lb', 'Women', 'Shoes', 'Heels'),
    'shoes/flats': shoes('2 lb', 'Women', 'Shoes', 'Flats'),
    'shoes/loafers': shoes('2 lb', 'Women', 'Shoes', 'Loafers'),
    'shoes/slippers': shoes('2 lb', 'Women', 'Shoes', 'Slippers'),
    bags: unsized('3 lb', 'Women', "Women's handbags"),
    'bags/shoulder_bags': unsized('3 lb', 'Women', "Women's handbags", 'Shoulder Bags'),
    'bags/crossbody_bags': unsized('2 lb', 'Women', "Women's handbags", 'Crossbody Bags'),
    'bags/totes': unsized('3 lb', 'Women', "Women's handbags", 'Tote Bags'),
    'bags/backpacks': unsized('3 lb', 'Women', "Women's handbags", 'Backpacks'),
    'bags/clutches': unsized('1 lb', 'Women', "Women's handbags", 'Other'),
    'bags/wallets': unsized('8 oz', 'Women', "Women's accessories", 'Wallets'),
    accessories: unsized('12 oz', 'Women', "Women's accessories"),
    'accessories/hats': unsized('1 lb', 'Women', "Women's accessories", 'Hats'),
    'accessories/scarves': unsized('12 oz', 'Women', "Women's accessories", 'Scarves'),
    'accessories/belts': unsized('12 oz', 'Women', "Women's accessories", 'Belts'),
    'accessories/sunglasses': unsized('12 oz', 'Women', "Women's accessories", 'Sunglasses'),
    'accessories/hair_accessories': unsized(
      '8 oz',
      'Women',
      "Women's accessories",
      'Hair accessories',
    ),
    'accessories/watches': unsized('1 lb', 'Women', "Women's accessories", 'Watches'),
    jewelry: unsized('8 oz', 'Women', 'Jewelry'),
    'jewelry/necklaces': unsized('8 oz', 'Women', 'Jewelry', 'Necklaces'),
    'jewelry/earrings': unsized('4 oz', 'Women', 'Jewelry', 'Earrings'),
    'jewelry/bracelets': unsized('8 oz', 'Women', 'Jewelry', 'Bracelets'),
    'jewelry/rings': unsized('4 oz', 'Women', 'Jewelry', 'Rings'),
    'jewelry/brooches': unsized('4 oz', 'Women', 'Jewelry', 'Pins'),
  },
};

/** The mapped Mercari category for an item, or `null` when the map has none. */
export function mapMercariCategory(
  canonical: string | null,
  department: string | null,
): MercariCategory | null {
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

/**
 * A category the listing names itself (`variant.categoryRef`): Mercari's names joined with
 * `>`, for example `Women > Shoes > Boots`, two or three levels. `null` when it isn't one.
 */
export function parseCategoryRef(ref: string): string[] | null {
  const path = ref.split('>').map((name) => name.trim());
  if (path.length < 2 || path.length > 3 || path.some((name) => name === '')) return null;
  return path;
}

/**
 * The size list and default weight of a category the listing names itself: those of the
 * mapped category with the same path, else what the item's canonical category suggests.
 */
export function categoryTraits(
  path: readonly string[],
  canonical: string | null,
): Pick<MercariCategory, 'size' | 'weight'> {
  const key = path.join(' > ');
  for (const table of Object.values(MAP)) {
    for (const entry of Object.values(table)) {
      if (entry.path.join(' > ') === key) return { size: entry.size, weight: entry.weight };
    }
  }
  if (canonical?.startsWith('clothing/') === true) return { size: 'clothing', weight: '3 lb' };
  if (canonical?.startsWith('shoes') === true) return { size: 'shoes', weight: '5 lb' };
  return { size: 'none', weight: '3 lb' };
}

/** Every mapped category once (the fake Mercari site offers exactly these). */
export function mappedMercariCategories(): MercariCategory[] {
  const byPath = new Map<string, MercariCategory>();
  for (const table of Object.values(MAP)) {
    for (const entry of Object.values(table)) byPath.set(entry.path.join(' > '), entry);
  }
  return [...byPath.values()];
}
