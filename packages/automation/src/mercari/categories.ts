/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to Mercari's categories, which its sell form picks level by level
 * in a dialog (department, category, subcategory). Every target is a category of Mercari's
 * catalog (catalog/catalog.json, read from its sell page on the seller's session), and the
 * catalog says what that category's form asks for: its size list, or none, and whether it asks
 * for an IMEI. `categories.test.ts` checks that every canonical category resolves for every
 * department and that each target is in the catalog.
 *
 * - Women's and men's items map to Mercari's Women and Men trees; the most specific key wins.
 * - Unisex items take the men's category, except where Mercari files the kind only under
 *   Women (dresses, skirts, heels, handbags, ...).
 * - Kids' items go to Mercari's Kids tree, which files clothing by girls or boys and by age
 *   (0-24 months, 2T-5T, 4 and up). The age comes from the size; girls or boys from the kind
 *   when only one fits (a dress is a girls' item). Otherwise Listora cannot tell, and
 *   validation asks the user to choose between the two, naming both.
 * - Home and other items go to Mercari's Home and Other trees whatever the department.
 *
 * A listing can name any Mercari category itself (`variant.categoryRef`): its names joined with
 * `>`, for example `Women > Shoes > Boots`, checked against the catalog before anything is sent.
 */
import { mercariCatalog, type MercariCategory } from './catalog/catalog.ts';

export type { MercariCategory } from './catalog/catalog.ts';

type Department = 'women' | 'men';

/** Mercari's paths, as `Department > Category > Subcategory`, by canonical category. */
const MAP: Readonly<Record<Department, Readonly<Record<string, string>>>> = {
  women: {
    'clothing/tops': 'Women > Tops & blouses',
    'clothing/tops/t_shirts': 'Women > Tops & blouses > T-shirts',
    'clothing/tops/shirts': 'Women > Tops & blouses > Button down shirt',
    'clothing/tops/blouses': 'Women > Tops & blouses > Blouse',
    'clothing/tops/tank_tops': 'Women > Tops & blouses > Tank Tops',
    'clothing/tops/polos': 'Women > Tops & blouses > Polo shirt',
    'clothing/tops/sweaters': 'Women > Sweaters',
    'clothing/tops/cardigans': 'Women > Sweaters > Cardigan',
    'clothing/tops/hoodies_sweatshirts': 'Women > Athletic apparel > Athletic Sweatshirts',
    'clothing/tops/bodysuits': 'Women > Tops & blouses > Bodysuits',
    'clothing/tops/other': 'Women > Tops & blouses > Other',
    'clothing/bottoms': 'Women > Pants',
    'clothing/bottoms/jeans': 'Women > Jeans',
    'clothing/bottoms/pants': 'Women > Pants > Casual pants',
    'clothing/bottoms/shorts': 'Women > Shorts',
    'clothing/bottoms/skirts': 'Women > Skirts',
    'clothing/bottoms/leggings': 'Women > Athletic apparel > Athletic Leggings',
    'clothing/bottoms/joggers': 'Women > Athletic apparel > Athletic Sweat Pants',
    'clothing/bottoms/other': 'Women > Pants > Other',
    'clothing/dresses': 'Women > Dresses',
    'clothing/dresses/jumpsuits_rompers': 'Women > Dresses > Jumpsuits & Rompers',
    'clothing/dresses/other': 'Women > Dresses > Other',
    'clothing/outerwear': 'Women > Coats & jackets',
    'clothing/outerwear/vests': 'Women > Coats & jackets > Vest',
    'clothing/outerwear/blazers': 'Women > Suits & blazers > Blazer',
    'clothing/outerwear/other': 'Women > Coats & jackets > Other',
    'clothing/activewear': 'Women > Athletic apparel',
    'clothing/activewear/tops': 'Women > Athletic apparel > Athletic T-Shirts',
    'clothing/activewear/bottoms': 'Women > Athletic apparel > Athletic Pants',
    'clothing/activewear/sports_bras': 'Women > Athletic apparel > Sports bras',
    'clothing/activewear/sets': 'Women > Athletic apparel > Athletic Sweatsuits',
    'clothing/activewear/other': 'Women > Athletic apparel > Other',
    'clothing/swimwear': 'Women > Swimwear',
    'clothing/swimwear/one_pieces': 'Women > Swimwear > One-piece',
    'clothing/swimwear/bikinis': 'Women > Swimwear > Two-piece',
    'clothing/swimwear/cover_ups': 'Women > Swimwear > Cover-ups',
    'clothing/sleep_lounge': 'Women > Sleepwear & robes',
    'clothing/sleep_lounge/pajamas': 'Women > Sleepwear & robes > Pajama sets',
    'clothing/sleep_lounge/robes': 'Women > Sleepwear & robes > Robes',
    'clothing/sleep_lounge/loungewear': 'Women > Sleepwear & robes > Other',
    'clothing/sleep_lounge/other': 'Women > Sleepwear & robes > Other',
    'clothing/intimates': 'Women > Underwear',
    'clothing/intimates/bras': 'Women > Underwear > Bras',
    'clothing/intimates/underwear': 'Women > Underwear > Panties',
    'clothing/intimates/shapewear': 'Women > Underwear > Other',
    'clothing/intimates/socks': 'Women > Athletic apparel > Socks',
    'clothing/intimates/other': 'Women > Underwear > Other',
    'clothing/suits_sets': 'Women > Suits & blazers',
    'clothing/suits_sets/matching_sets': 'Women > Other',
    'clothing/suits_sets/other': 'Women > Suits & blazers > Other',
    shoes: 'Women > Shoes',
    'shoes/sneakers': 'Women > Shoes > Athletic',
    'shoes/boots': 'Women > Shoes > Boots',
    'shoes/sandals': 'Women > Shoes > Sandals',
    'shoes/heels': 'Women > Shoes > Heels',
    'shoes/flats': 'Women > Shoes > Flats',
    'shoes/loafers': 'Women > Shoes > Loafers',
    'shoes/slippers': 'Women > Shoes > Slippers',
    'shoes/other': 'Women > Shoes > Other',
    bags: "Women > Women's handbags",
    'bags/shoulder_bags': "Women > Women's handbags > Shoulder Bags",
    'bags/crossbody_bags': "Women > Women's handbags > Crossbody Bags",
    'bags/totes': "Women > Women's handbags > Tote Bags",
    'bags/backpacks': "Women > Women's handbags > Backpacks",
    'bags/clutches': "Women > Women's handbags > Other",
    'bags/wallets': "Women > Women's accessories > Wallets",
    'bags/other': "Women > Women's handbags > Other",
    accessories: "Women > Women's accessories",
    'accessories/hats': "Women > Women's accessories > Hats",
    'accessories/scarves': "Women > Women's accessories > Scarves",
    'accessories/belts': "Women > Women's accessories > Belts",
    'accessories/sunglasses': "Women > Women's accessories > Sunglasses",
    'accessories/gloves': "Women > Women's accessories > Fashion Gloves",
    'accessories/hair_accessories': "Women > Women's accessories > Hair accessories",
    'accessories/watches': "Women > Women's accessories > Watches",
    'accessories/other': "Women > Women's accessories > Other",
    jewelry: 'Women > Jewelry',
    'jewelry/necklaces': 'Women > Jewelry > Necklaces',
    'jewelry/earrings': 'Women > Jewelry > Earrings',
    'jewelry/bracelets': 'Women > Jewelry > Bracelets',
    'jewelry/rings': 'Women > Jewelry > Rings',
    'jewelry/brooches': 'Women > Jewelry > Pins',
  },
  men: {
    'clothing/tops': 'Men > Tops',
    'clothing/tops/t_shirts': 'Men > Tops > T-shirts',
    'clothing/tops/shirts': 'Men > Tops > Button-front',
    'clothing/tops/tank_tops': 'Men > Tops > Tank',
    'clothing/tops/polos': 'Men > Tops > Polos',
    'clothing/tops/sweaters': 'Men > Sweaters',
    'clothing/tops/cardigans': 'Men > Sweaters > Cardigan',
    'clothing/tops/hoodies_sweatshirts': 'Men > Sweats & hoodies',
    'clothing/tops/other': 'Men > Tops > Other',
    'clothing/bottoms': 'Men > Pants',
    'clothing/bottoms/jeans': 'Men > Jeans',
    'clothing/bottoms/pants': 'Men > Pants > Casual pants',
    'clothing/bottoms/shorts': 'Men > Shorts',
    'clothing/bottoms/leggings': 'Men > Athletic apparel > Pants',
    'clothing/bottoms/joggers': 'Men > Sweats & hoodies > Sweat Pants',
    'clothing/bottoms/other': 'Men > Pants > Other',
    // Mercari's Men tree has no dresses, skirts, sleepwear, underwear, or sets (read
    // 2026-10-27): Other, whose form asks no size.
    'clothing/bottoms/skirts': 'Men > Other',
    'clothing/dresses': 'Men > Other',
    'clothing/outerwear': 'Men > Coats & jackets',
    'clothing/outerwear/vests': 'Men > Coats & jackets > Vest',
    'clothing/outerwear/blazers': 'Men > Blazers & sport coats',
    'clothing/outerwear/other': 'Men > Coats & jackets > Other',
    'clothing/activewear': 'Men > Athletic apparel',
    'clothing/activewear/tops': 'Men > Athletic apparel > Athletic T-Shirts',
    'clothing/activewear/bottoms': 'Men > Athletic apparel > Pants',
    'clothing/activewear/sports_bras': 'Men > Other',
    'clothing/activewear/sets': 'Men > Athletic apparel > Tracksuits',
    'clothing/activewear/other': 'Men > Athletic apparel > Other',
    'clothing/swimwear': 'Men > Swimwear',
    'clothing/swimwear/swim_trunks': 'Men > Swimwear > Swim trunks',
    'clothing/sleep_lounge': 'Men > Other',
    'clothing/intimates': 'Men > Other',
    'clothing/suits_sets': 'Men > Suits',
    'clothing/suits_sets/matching_sets': 'Men > Other',
    shoes: 'Men > Shoes',
    'shoes/sneakers': 'Men > Shoes > Athletic',
    'shoes/boots': 'Men > Shoes > Boots',
    'shoes/sandals': 'Men > Shoes > Sandals',
    'shoes/flats': 'Men > Shoes > Slip-Ons',
    'shoes/loafers': 'Men > Shoes > Loafers',
    'shoes/dress_shoes': 'Men > Shoes > Oxfords',
    'shoes/slippers': 'Men > Shoes > Slippers',
    bags: "Men > Men's accessories > Bags",
    'bags/backpacks': "Men > Men's accessories > Backpacks",
    'bags/wallets': "Men > Men's accessories > Wallets",
    accessories: "Men > Men's accessories",
    'accessories/hats': "Men > Men's accessories > Hats",
    'accessories/scarves': "Men > Men's accessories > Scarves",
    'accessories/belts': "Men > Men's accessories > Belts",
    'accessories/sunglasses': "Men > Men's accessories > Sunglasses",
    'accessories/gloves': "Men > Men's accessories > Fashion Gloves",
    'accessories/ties': "Men > Men's accessories > Ties",
    'accessories/watches': "Men > Men's accessories > Watches",
    'accessories/other': "Men > Men's accessories > Other",
    jewelry: 'Men > Jewelry',
    'jewelry/necklaces': 'Men > Jewelry > Necklaces',
    'jewelry/earrings': 'Men > Jewelry > Earrings',
    'jewelry/bracelets': 'Men > Jewelry > Bracelets',
    'jewelry/rings': 'Men > Jewelry > Rings',
    'jewelry/brooches': 'Men > Jewelry > Pins',
  },
};

/** The kinds Mercari files only under Women: unisex items of these take the women's category. */
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
  'shoes/heels',
  'bags/handbags',
  'bags/shoulder_bags',
  'bags/crossbody_bags',
  'bags/totes',
  'bags/clutches',
  'accessories/hair_accessories',
];

/** Home and other items: the same Mercari category for every department. */
const ANY_DEPARTMENT: Readonly<Record<string, string>> = {
  home: 'Home > Other',
  'home/decor': 'Home > Home decor > Home decor accents',
  'home/kitchen': 'Home > Kitchen & dining > Other',
  'home/bedding': 'Home > Bedding > Other',
  other: 'Other > Other',
};

/**
 * Mercari's Kids categories by canonical category: the girls' and the boys' one, or only one
 * of them when the kind is only one's (a dress, swim trunks).
 */
const KIDS: Readonly<Record<string, { girls?: string; boys?: string }>> = {
  'clothing/tops': { girls: 'Girls tops & t-shirts', boys: 'Boys tops & t-shirts' },
  'clothing/tops/blouses': { girls: 'Girls tops & t-shirts' },
  'clothing/tops/bodysuits': { girls: 'Girls one-pieces', boys: 'Boys one-pieces' },
  'clothing/bottoms': { girls: 'Girls bottoms', boys: 'Boys bottoms' },
  'clothing/bottoms/skirts': { girls: 'Girls bottoms' },
  'clothing/bottoms/leggings': { girls: 'Girls bottoms' },
  'clothing/dresses': { girls: 'Girls dresses' },
  'clothing/dresses/jumpsuits_rompers': { girls: 'Girls one-pieces', boys: 'Boys one-pieces' },
  'clothing/outerwear': { girls: 'Girls coats & jackets', boys: 'Boys coats & jackets' },
  'clothing/activewear': { girls: 'Girls other', boys: 'Boys other' },
  'clothing/activewear/tops': { girls: 'Girls tops & t-shirts', boys: 'Boys tops & t-shirts' },
  'clothing/activewear/bottoms': { girls: 'Girls bottoms', boys: 'Boys bottoms' },
  'clothing/activewear/sports_bras': { girls: 'Girls other' },
  'clothing/swimwear': { girls: 'Girls swimwear', boys: 'Boys swimwear' },
  'clothing/swimwear/one_pieces': { girls: 'Girls swimwear' },
  'clothing/swimwear/bikinis': { girls: 'Girls swimwear' },
  'clothing/swimwear/swim_trunks': { boys: 'Boys swimwear' },
  'clothing/sleep_lounge': { girls: 'Girls other', boys: 'Boys other' },
  'clothing/intimates': { girls: 'Girls other', boys: 'Boys other' },
  'clothing/intimates/bras': { girls: 'Girls other' },
  'clothing/intimates/socks': { girls: 'Girls accessories', boys: 'Boys accessories' },
  'clothing/suits_sets': { girls: 'Girls other', boys: 'Boys other' },
  'clothing/suits_sets/suits': { boys: 'Boys other' },
  shoes: { girls: 'Girls shoes', boys: 'Boys shoes' },
  'shoes/heels': { girls: 'Girls shoes' },
  bags: { girls: 'Girls accessories', boys: 'Boys accessories' },
  accessories: { girls: 'Girls accessories', boys: 'Boys accessories' },
  'accessories/hair_accessories': { girls: 'Girls accessories' },
  'accessories/ties': { boys: 'Boys accessories' },
  jewelry: { girls: 'Girls accessories', boys: 'Boys accessories' },
};

/** Mercari's kids' age bands, as its third level names them after "Girls" or "Boys". */
export type KidsAge = '0-24 mos' | '2T-5T' | '(4+)';

/** What the map says for an item. */
export type CategoryMatch =
  | { type: 'mapped'; category: MercariCategory }
  /** A kids' item that could be a girls' or a boys' one: the user picks. */
  | { type: 'choose'; options: readonly MercariCategory[] }
  | { type: 'unmapped' };

/** The Mercari category for an item's canonical category, department, and size. */
export function matchMercariCategory(
  canonical: string | null,
  department: string | null,
  sizeLabel: string | null = null,
): CategoryMatch {
  if (canonical === null) return { type: 'unmapped' };
  const any = mostSpecific(ANY_DEPARTMENT, canonical);
  if (any !== undefined) return found(any);
  switch (department) {
    case 'women':
    case 'men': {
      const path = mostSpecific(MAP[department], canonical);
      return path === undefined ? { type: 'unmapped' } : found(path);
    }
    case 'unisex': {
      const women = WOMEN_ONLY.some((kind) => isWithin(canonical, kind));
      const path = mostSpecific(MAP[women ? 'women' : 'men'], canonical);
      return path === undefined ? { type: 'unmapped' } : found(path);
    }
    case 'kids': {
      const entry = mostSpecific(KIDS, canonical);
      if (entry === undefined) return { type: 'unmapped' };
      const age = kidsAge(sizeLabel);
      const options = (['girls', 'boys'] as const).flatMap((who) => {
        const name = entry[who];
        if (name === undefined) return [];
        const prefix = who === 'girls' ? 'Girls' : 'Boys';
        // Not every Kids category has every age (one-pieces stop at 5T): the other kind then.
        const category =
          catalogCategory(['Kids', name, `${prefix} ${age}`]) ??
          catalogCategory(['Kids', `${prefix} other`, `${prefix} ${age}`]);
        return category === null ? [] : [category];
      });
      const [only] = options;
      if (only === undefined) return { type: 'unmapped' };
      return options.length === 1 ? { type: 'mapped', category: only } : { type: 'choose', options };
    }
    default:
      return { type: 'unmapped' };
  }
}

/**
 * The Mercari category Listora maps an item to, or `null` when the seller picks (the List
 * flow's suggestion, `../categories.ts`).
 */
export function mapMercariCategory(
  canonical: string | null,
  department: string | null,
): MercariCategory | null {
  const match = matchMercariCategory(canonical, department);
  return match.type === 'mapped' ? match.category : null;
}

/**
 * Every category a listing can be filed in: each of Mercari's categories below its departments,
 * the ones with subcategories included (the dialog picks those whole).
 */
export function mappedMercariCategories(): MercariCategory[] {
  return [...mercariCatalog().byId.values()].filter((category) => category.path.length >= 2);
}

/**
 * A kids' item's age band from its size: `2T` to `5T` are toddlers', months and newborn sizes
 * babies', and everything else (letters, `6`, `10-12`) is 4 and up.
 */
export function kidsAge(sizeLabel: string | null): KidsAge {
  const label = sizeLabel?.trim().toLowerCase() ?? '';
  if (/^[2-5]\s*t$/.test(label)) return '2T-5T';
  if (/\b(nb|newborn|preemie)\b|\d\s*(m|mo|mos|months?)\b/.test(label)) return '0-24 mos';
  return '(4+)';
}

/**
 * A category the listing names itself (`variant.categoryRef`): Mercari's names joined with
 * `>`, for example `Women > Shoes > Boots`, which must be a category of Mercari's catalog.
 * `null` when it isn't one.
 */
export function parseCategoryRef(ref: string): MercariCategory | null {
  const path = ref.split('>').map((name) => name.trim());
  if (path.length < 2 || path.some((name) => name === '')) return null;
  return catalogCategory(path);
}

function catalogCategory(path: readonly string[]): MercariCategory | null {
  return mercariCatalog().find(path);
}

function found(path: string): CategoryMatch {
  const category = catalogCategory(path.split(' > '));
  // categories.test.ts keeps every path in the catalog; one Mercari dropped since asks the user.
  return category === null ? { type: 'unmapped' } : { type: 'mapped', category };
}

/** The table's entry for the canonical path or its longest prefix. */
function mostSpecific<T>(table: Readonly<Record<string, T>>, canonical: string): T | undefined {
  const segments = canonical.split('/');
  for (let length = segments.length; length >= 1; length -= 1) {
    const entry = table[segments.slice(0, length).join('/')];
    if (entry !== undefined) return entry;
  }
  return undefined;
}

function isWithin(canonical: string, kind: string): boolean {
  return canonical === kind || canonical.startsWith(`${kind}/`);
}

/** Every Mercari path the map names, for its test. */
export function mappedMercariPaths(): string[] {
  const kids = Object.values(KIDS).flatMap((entry) =>
    (['girls', 'boys'] as const).flatMap((who) => {
      const name = entry[who];
      if (name === undefined) return [];
      const prefix = who === 'girls' ? 'Girls' : 'Boys';
      return [`Kids > ${name} > ${prefix} 2T-5T`];
    }),
  );
  return [
    ...new Set([
      ...Object.values(MAP.women),
      ...Object.values(MAP.men),
      ...Object.values(ANY_DEPARTMENT),
      ...kids,
    ]),
  ];
}
