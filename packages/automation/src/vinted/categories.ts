/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to Vinted's categories, which its upload form picks level by level
 * in its category list (`Women`, `Clothing`, `Dresses`, `Mini-dresses`) down to a category
 * without subcategories: Vinted takes only those.
 *
 * Every target is a category Vinted's upload form offered the test account (its category list,
 * `GET /api/v2/item_upload/catalogs`, read 2026-11-05 by the read-only mapping, Vinted plan M2).
 * The taxonomy snapshot that mapping writes is what the targets get checked against once it
 * lands; until then `categories.test.ts` holds the map to its shape.
 *
 * - Women's and men's clothing, shoes, bags, accessories, and jewellery map to Vinted's Women and
 *   Men trees; the most specific canonical key wins. Vinted files jackets and coats only by
 *   their kind (denim, bomber, puffer, ...), so the item's title and name pick that kind; one
 *   that names none is the seller's to choose.
 * - Unisex items take the men's category, except the kinds Vinted files only under Women
 *   (dresses, skirts, blouses, heels, handbags, ...).
 * - Kids', home, and other items have no category here yet, nor shoes of no kind (Vinted lists no
 *   "Other shoes") or men's heels: the seller names one (`variant.categoryRef`), and validation
 *   asks for it.
 *
 * A listing can name any Vinted category itself (`variant.categoryRef`): its names joined with
 * ` > `, for example `Women > Clothing > Dresses > Mini-dresses`.
 */

type Department = 'women' | 'men';

/** A category Vinted files by its kind: the item's words pick it, else the seller does. */
interface ByKind {
  kinds: readonly (readonly [RegExp, string])[];
}

type Target = string | ByKind;

const WOMEN_JACKETS: ByKind = {
  kinds: [
    [/\bdenim|\bjean/i, 'Women > Clothing > Outerwear > Jackets > Denim jackets'],
    [/\bbomber/i, 'Women > Clothing > Outerwear > Jackets > Bomber jackets'],
    [/\b(puffer|down)\b/i, 'Women > Clothing > Outerwear > Jackets > Puffer jackets'],
    [/\bfleece/i, 'Women > Clothing > Outerwear > Jackets > Fleece jackets'],
    [
      /\b(biker|moto|racer|leather)/i,
      'Women > Clothing > Outerwear > Jackets > Biker & racer jackets',
    ],
    [/\bquilted/i, 'Women > Clothing > Outerwear > Jackets > Quilted jackets'],
    [/\bshacket/i, 'Women > Clothing > Outerwear > Jackets > Shackets'],
    [/\b(ski|snowboard)/i, 'Women > Clothing > Outerwear > Jackets > Ski & snowboard jackets'],
    [/\bvarsity|letterman/i, 'Women > Clothing > Outerwear > Jackets > Varsity jackets'],
    [
      /\b(windbreaker|rain jacket|anorak)/i,
      'Women > Clothing > Outerwear > Jackets > Windbreakers',
    ],
    [
      /\b(utility|field|cargo|chore|trucker)/i,
      'Women > Clothing > Outerwear > Jackets > Field & utility jackets',
    ],
  ],
};

const MEN_JACKETS: ByKind = {
  kinds: [
    [/\bdenim|\bjean|\btrucker/i, 'Men > Clothing > Outerwear > Jackets > Denim jackets'],
    [/\bbomber/i, 'Men > Clothing > Outerwear > Jackets > Bomber jackets'],
    [/\b(puffer|down)\b/i, 'Men > Clothing > Outerwear > Jackets > Puffer jackets'],
    [/\bfleece/i, 'Men > Clothing > Outerwear > Jackets > Fleece jackets'],
    [
      /\b(biker|moto|racer|leather)/i,
      'Men > Clothing > Outerwear > Jackets > Biker & racer jackets',
    ],
    [/\bharrington/i, 'Men > Clothing > Outerwear > Jackets > Harrington jackets'],
    [/\bquilted/i, 'Men > Clothing > Outerwear > Jackets > Quilted jackets'],
    [/\bshacket/i, 'Men > Clothing > Outerwear > Jackets > Shackets'],
    [/\b(ski|snowboard)/i, 'Men > Clothing > Outerwear > Jackets > Ski & snowboard jackets'],
    [/\bvarsity|letterman/i, 'Men > Clothing > Outerwear > Jackets > Varsity jackets'],
    [/\b(windbreaker|rain jacket|anorak)/i, 'Men > Clothing > Outerwear > Jackets > Windbreakers'],
    [
      /\b(utility|field|cargo|chore)/i,
      'Men > Clothing > Outerwear > Jackets > Field & utility jackets',
    ],
  ],
};

const coats = (department: 'Women' | 'Men'): ByKind => ({
  kinds: [
    [/\btrench/i, `${department} > Clothing > Outerwear > Coats > Trench coats`],
    [/\bpea ?coat/i, `${department} > Clothing > Outerwear > Coats > Peacoats`],
    [/\bparka/i, `${department} > Clothing > Outerwear > Coats > Parkas`],
    [/\bduffle|duffel/i, `${department} > Clothing > Outerwear > Coats > Duffle coats`],
    [/\b(raincoat|rain coat|mac)\b/i, `${department} > Clothing > Outerwear > Coats > Raincoats`],
    ...(department === 'Women'
      ? ([[/\bfaux fur/i, 'Women > Clothing > Outerwear > Coats > Faux fur coats']] as const)
      : []),
    [
      /\b(overcoat|long coat|wool coat|topcoat)/i,
      `${department} > Clothing > Outerwear > Coats > Overcoats & long coats`,
    ],
  ],
});

/** Vinted's paths by canonical category, per department. */
const MAP: Readonly<Record<Department, Readonly<Record<string, Target>>>> = {
  women: {
    'clothing/tops': 'Women > Clothing > Tops & T-shirts > Other tops & t-shirts',
    'clothing/tops/t_shirts': 'Women > Clothing > Tops & T-shirts > T-shirts',
    'clothing/tops/shirts': 'Women > Clothing > Tops & T-shirts > Shirts',
    'clothing/tops/blouses': 'Women > Clothing > Tops & T-shirts > Blouses',
    'clothing/tops/tank_tops': 'Women > Clothing > Tops & T-shirts > Tank tops',
    'clothing/tops/sweaters': 'Women > Clothing > Jumpers & sweaters > Sweaters > Other sweaters',
    'clothing/tops/cardigans': 'Women > Clothing > Jumpers & sweaters > Cardigans',
    'clothing/tops/hoodies_sweatshirts':
      'Women > Clothing > Jumpers & sweaters > Hoodies & sweatshirts',
    'clothing/tops/bodysuits': 'Women > Clothing > Tops & T-shirts > Bodysuits',
    'clothing/bottoms': 'Women > Clothing > Pants & leggings > Other trousers',
    'clothing/bottoms/jeans': 'Women > Clothing > Jeans > Other',
    'clothing/bottoms/shorts':
      'Women > Clothing > Shorts & cropped pants > Other shorts & cropped pants',
    'clothing/bottoms/skirts': 'Women > Clothing > Skirts',
    'clothing/bottoms/leggings': 'Women > Clothing > Pants & leggings > Leggings',
    'clothing/bottoms/joggers': 'Women > Clothing > Activewear > Pants',
    'clothing/dresses': 'Women > Clothing > Dresses > Other dresses',
    'clothing/dresses/jumpsuits_rompers':
      'Women > Clothing > Jumpsuits & rompers > Other jumpsuits & rompers',
    'clothing/outerwear/jackets': WOMEN_JACKETS,
    'clothing/outerwear/denim_jackets': 'Women > Clothing > Outerwear > Jackets > Denim jackets',
    'clothing/outerwear/coats': coats('Women'),
    'clothing/outerwear/vests': 'Women > Clothing > Outerwear > Vests',
    'clothing/outerwear/blazers': 'Women > Clothing > Suits & blazers > Blazers',
    'clothing/activewear': 'Women > Clothing > Activewear > Other activewear',
    'clothing/activewear/tops': 'Women > Clothing > Activewear > Tops & T-shirts',
    'clothing/activewear/bottoms': 'Women > Clothing > Activewear > Pants',
    'clothing/activewear/sports_bras': 'Women > Clothing > Activewear > Sports bras',
    'clothing/activewear/sets': 'Women > Clothing > Activewear > Tracksuits',
    'clothing/swimwear': 'Women > Clothing > Swimwear > Other swimwear & beachwear',
    'clothing/swimwear/one_pieces': 'Women > Clothing > Swimwear > One-pieces',
    'clothing/swimwear/bikinis': 'Women > Clothing > Swimwear > Bikinis & tankinis',
    'clothing/swimwear/cover_ups': 'Women > Clothing > Swimwear > Cover-ups & sarongs',
    'clothing/sleep_lounge': 'Women > Clothing > Lingerie & nightwear > Sleepwear',
    'clothing/sleep_lounge/robes': 'Women > Clothing > Lingerie & nightwear > Dressing gowns',
    'clothing/intimates': 'Women > Clothing > Lingerie & nightwear > Other',
    'clothing/intimates/bras': 'Women > Clothing > Lingerie & nightwear > Bras',
    'clothing/intimates/underwear': 'Women > Clothing > Lingerie & nightwear > Panties',
    'clothing/intimates/shapewear': 'Women > Clothing > Lingerie & nightwear > Shapewear',
    'clothing/intimates/socks': 'Women > Clothing > Lingerie & nightwear > Socks',
    'clothing/suits_sets': 'Women > Clothing > Suits & blazers > Other suits & blazers',
    'clothing/suits_sets/suits': 'Women > Clothing > Suits & blazers > Pantsuits',
    'clothing/suits_sets/matching_sets': 'Women > Clothing > Other clothing',
    clothing: 'Women > Clothing > Other clothing',
    'shoes/sneakers': 'Women > Shoes > Sneakers',
    'shoes/boots': 'Women > Shoes > Boots > Ankle boots',
    'shoes/sandals': 'Women > Shoes > Sandals',
    'shoes/heels': 'Women > Shoes > Heels',
    'shoes/flats': 'Women > Shoes > Ballerinas',
    'shoes/loafers': 'Women > Shoes > Boat shoes, loafers & moccasins',
    'shoes/dress_shoes': 'Women > Shoes > Heels',
    'shoes/slippers': 'Women > Shoes > Slippers',
    bags: 'Women > Bags > Handbags',
    'bags/shoulder_bags': 'Women > Bags > Shoulder bags',
    'bags/crossbody_bags': 'Women > Bags > Satchels & messenger bags',
    'bags/totes': 'Women > Bags > Tote bags',
    'bags/backpacks': 'Women > Bags > Backpacks',
    'bags/clutches': 'Women > Bags > Clutches',
    'bags/wallets': 'Women > Bags > Wallets',
    accessories: 'Women > Accessories > Other accessories',
    'accessories/hats': 'Women > Accessories > Hats & caps > Hats',
    'accessories/scarves': 'Women > Accessories > Scarves & shawls',
    'accessories/belts': 'Women > Accessories > Belts',
    'accessories/sunglasses': 'Women > Accessories > Sunglasses',
    'accessories/gloves': 'Women > Accessories > Gloves',
    'accessories/hair_accessories': 'Women > Accessories > Hair accessories',
    'accessories/watches': 'Women > Accessories > Watches',
    jewelry: 'Women > Accessories > Jewelry > Other jewelry',
    'jewelry/necklaces': 'Women > Accessories > Jewelry > Necklaces',
    'jewelry/earrings': 'Women > Accessories > Jewelry > Earrings',
    'jewelry/bracelets': 'Women > Accessories > Jewelry > Bracelets',
    'jewelry/rings': 'Women > Accessories > Jewelry > Rings',
    'jewelry/brooches': 'Women > Accessories > Jewelry > Brooches',
  },
  men: {
    'clothing/tops': 'Men > Clothing > Tops & T-shirts > T-shirts > Other T-shirts',
    'clothing/tops/t_shirts': 'Men > Clothing > Tops & T-shirts > T-shirts > Other T-shirts',
    'clothing/tops/shirts': 'Men > Clothing > Tops & T-shirts > Shirts > Other shirts',
    'clothing/tops/tank_tops': 'Men > Clothing > Tops & T-shirts > Tank tops',
    'clothing/tops/polos': 'Men > Clothing > Tops & T-shirts > Polo shirts',
    'clothing/tops/sweaters': 'Men > Clothing > Sweaters & sweatshirts > Sweaters',
    'clothing/tops/cardigans': 'Men > Clothing > Sweaters & sweatshirts > Cardigans',
    'clothing/tops/hoodies_sweatshirts':
      'Men > Clothing > Sweaters & sweatshirts > Hoodies & sweatshirts',
    'clothing/bottoms': 'Men > Clothing > Pants > Other pants',
    'clothing/bottoms/jeans': 'Men > Clothing > Jeans > Straight fit jeans',
    'clothing/bottoms/shorts': 'Men > Clothing > Shorts > Other shorts',
    'clothing/bottoms/joggers': 'Men > Clothing > Pants > Sweatpants',
    'clothing/outerwear/jackets': MEN_JACKETS,
    'clothing/outerwear/denim_jackets': 'Men > Clothing > Outerwear > Jackets > Denim jackets',
    'clothing/outerwear/coats': coats('Men'),
    'clothing/outerwear/vests': 'Men > Clothing > Outerwear > Vests',
    'clothing/outerwear/blazers': 'Men > Clothing > Suits & blazers > Suit jackets & blazers',
    'clothing/activewear': 'Men > Clothing > Activewear > Other activewear',
    'clothing/activewear/tops': 'Men > Clothing > Activewear > Tops & T-shirts',
    'clothing/activewear/bottoms': 'Men > Clothing > Activewear > Pants',
    'clothing/activewear/sets': 'Men > Clothing > Activewear > Tracksuits',
    'clothing/swimwear': 'Men > Clothing > Swimwear',
    'clothing/sleep_lounge': 'Men > Clothing > Sleepwear > Pyjama sets',
    'clothing/sleep_lounge/robes': 'Men > Clothing > Socks & underwear > Bathrobes',
    'clothing/intimates': 'Men > Clothing > Socks & underwear > Other socks & underwear',
    'clothing/intimates/underwear': 'Men > Clothing > Socks & underwear > Underwear',
    'clothing/intimates/socks': 'Men > Clothing > Socks & underwear > Socks',
    'clothing/suits_sets': 'Men > Clothing > Suits & blazers > Other suits & blazers',
    'clothing/suits_sets/suits': 'Men > Clothing > Suits & blazers > Suit sets',
    'clothing/suits_sets/matching_sets': 'Men > Clothing > Other clothing',
    clothing: 'Men > Clothing > Other clothing',
    'shoes/sneakers': 'Men > Shoes > Sneakers',
    'shoes/boots': 'Men > Shoes > Boots > Desert & lace-up boots',
    'shoes/sandals': 'Men > Shoes > Sandals',
    'shoes/flats': 'Men > Shoes > Boat shoes, loafers & moccasins',
    'shoes/loafers': 'Men > Shoes > Boat shoes, loafers & moccasins',
    'shoes/dress_shoes': 'Men > Shoes > Formal shoes',
    'shoes/slippers': 'Men > Shoes > Slippers',
    bags: 'Men > Accessories > Bags & backpacks > Shoulder bags',
    'bags/backpacks': 'Men > Accessories > Bags & backpacks > Backpacks',
    'bags/wallets': 'Men > Accessories > Bags & backpacks > Wallets',
    accessories: 'Men > Accessories > Other accessories',
    'accessories/hats': 'Men > Accessories > Hats & caps > Hats',
    'accessories/scarves': 'Men > Accessories > Scarves & shawls',
    'accessories/belts': 'Men > Accessories > Belts',
    'accessories/sunglasses': 'Men > Accessories > Sunglasses',
    'accessories/gloves': 'Men > Accessories > Gloves',
    'accessories/ties': 'Men > Accessories > Ties & bow ties',
    'accessories/watches': 'Men > Accessories > Watches',
    jewelry: 'Men > Accessories > Jewelry > Other jewelry',
    'jewelry/necklaces': 'Men > Accessories > Jewelry > Necklaces',
    'jewelry/earrings': 'Men > Accessories > Jewelry > Earrings',
    'jewelry/bracelets': 'Men > Accessories > Jewelry > Bracelets',
    'jewelry/rings': 'Men > Accessories > Jewelry > Rings',
  },
};

/** The kinds Vinted files only under Women: unisex items of these take the women's category. */
const WOMEN_ONLY = [
  'clothing/tops/blouses',
  'clothing/tops/bodysuits',
  'clothing/bottoms/skirts',
  'clothing/bottoms/leggings',
  'clothing/dresses',
  'clothing/activewear/sports_bras',
  'clothing/swimwear/one_pieces',
  'clothing/swimwear/bikinis',
  'clothing/swimwear/cover_ups',
  'clothing/intimates/bras',
  'clothing/intimates/shapewear',
  'shoes/heels',
  'bags/handbags',
  'bags/shoulder_bags',
  'bags/crossbody_bags',
  'bags/totes',
  'bags/clutches',
  'accessories/hair_accessories',
  'jewelry/brooches',
];

/** What the map says for an item. */
export type VintedCategoryMatch =
  | { type: 'mapped'; path: readonly string[] }
  /** Vinted files the kind by words the item doesn't have (a jacket that names no kind). */
  | { type: 'by_kind'; examples: readonly string[] }
  | { type: 'unmapped' };

/** The item's words that tell Vinted's kind of jacket or coat. */
export interface ItemWords {
  title: string;
  productName: string | null;
}

/**
 * The Vinted category for an item's canonical category and department: the most specific key
 * of its department's map, from the full path up to its first part.
 */
export function matchVintedCategory(
  canonical: string | null,
  department: string | null,
  words: ItemWords,
): VintedCategoryMatch {
  if (canonical === null) return { type: 'unmapped' };
  const key = departmentFor(canonical, department);
  if (key === null) return { type: 'unmapped' };
  const parts = canonical.split('/');
  for (let length = parts.length; length > 0; length -= 1) {
    const target = MAP[key][parts.slice(0, length).join('/')];
    if (target === undefined) continue;
    if (typeof target === 'string') return { type: 'mapped', path: splitPath(target) };
    const text = `${words.title} ${words.productName ?? ''}`;
    const kind = target.kinds.find(([pattern]) => pattern.test(text));
    return kind === undefined
      ? { type: 'by_kind', examples: target.kinds.slice(0, 3).map(([, path]) => path) }
      : { type: 'mapped', path: splitPath(kind[1]) };
  }
  return { type: 'unmapped' };
}

/**
 * A category a listing names itself (`variant.categoryRef`): Vinted's names joined with `>`,
 * from a top category (Women, Men, Kids, Home, ...) down, at least two levels; `null` when it is
 * not one.
 */
export function parseVintedCategoryRef(ref: string): readonly string[] | null {
  const path = splitPath(ref);
  if (path.length < 2 || path.length > 6) return null;
  return path.every((name) => name.length > 0 && name.length <= 100) ? path : null;
}

/** Every path the map names, for its tests. */
export function mappedVintedPaths(): string[] {
  const paths = new Set<string>();
  for (const map of Object.values(MAP)) {
    for (const target of Object.values(map)) {
      if (typeof target === 'string') paths.add(target);
      else for (const [, path] of target.kinds) paths.add(path);
    }
  }
  return [...paths].sort();
}

function departmentFor(canonical: string, department: string | null): Department | null {
  if (department === 'women' || department === 'men') return department;
  if (department === 'unisex') {
    return WOMEN_ONLY.some((kind) => canonical === kind || canonical.startsWith(`${kind}/`))
      ? 'women'
      : 'men';
  }
  // Kids', and an item without a department: the seller names the category.
  return null;
}

function splitPath(path: string): string[] {
  return path.split('>').map((name) => name.trim());
}
