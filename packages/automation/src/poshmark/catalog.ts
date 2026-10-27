/**
 * Poshmark's catalog as Listora uses it: the departments, categories, and subcategories a
 * listing is filed under, each category's size sets, and the static map from Listora's canonical
 * categories (`ItemSnapshot.category` with its department) onto them. The full rules are in
 * docs/features/poshmark.md.
 *
 * The catalog itself is data, `data/catalog.json`: Poshmark's whole catalog as its own listing
 * form holds it (every department, category, display group, subcategory, and size set, with the
 * names the form shows), which `data/refresh.ts` rewrites from the form. Only the map from
 * Listora's categories is written here; a test checks that every place it names is in the data,
 * so a refresh that drops one fails until the map follows.
 */
import catalogJson from './data/catalog.json' with { type: 'json' };
import { catalogDataSchema, type CatalogSize } from './data/normalize.ts';

const DATA = catalogDataSchema.parse(catalogJson);

export const POSHMARK_DEPARTMENTS = [
  'Women',
  'Men',
  'Kids',
  'Home',
  'Pets',
  'Electronics',
] as const;
export type PoshmarkDepartment = (typeof POSHMARK_DEPARTMENTS)[number];

/** Where a listing is filed: Poshmark's department, category, and optional subcategory. */
export interface PoshmarkCatalog {
  department: PoshmarkDepartment;
  category: string;
  subcategory: string | null;
  /** The display group the category picker files the category under (`null` for most). */
  group: string | null;
}

/** One of a category's size sets: its tab in the size picker and its sizes. */
export interface PoshmarkSizeSet {
  /** `Standard`, `Plus`, `Petite`, `Big & Tall`, `Juniors`, `Maternity`, `Baby`, `Girls`, `Boys`. */
  name: string;
  sizes: readonly CatalogSize[];
}

/** A category's size sets, in the picker's order. */
export type SizeSets = readonly PoshmarkSizeSet[];

interface CategoryEntry {
  group: string | null;
  subcategories: readonly string[];
  sizeSets: SizeSets;
}

const CATEGORIES: ReadonlyMap<string, CategoryEntry> = new Map(
  DATA.departments.flatMap((department) =>
    department.categories.map((category): [string, CategoryEntry] => [
      key(department.name, category.name),
      {
        group: category.group,
        subcategories: category.subcategories,
        sizeSets: category.sizeSets.map((name) => {
          const set = DATA.sizeSets[name];
          if (set === undefined) throw new Error(`catalog.json has no size set "${name}"`);
          return set;
        }),
      },
    ]),
  ),
);

function key(department: string, category: string): string {
  return `${department}\n${category}`;
}

/** When the catalog data was read from Poshmark, and when Poshmark last changed it. */
export const POSHMARK_CATALOG_READ = {
  readAt: DATA.readAt,
  catalogUpdatedAt: DATA.catalogUpdatedAt,
} as const;

/** The colors Poshmark's form offers, in its order. */
export const POSHMARK_COLORS: readonly string[] = DATA.colors;

/** The categories in a department, in the form's order. */
export function poshmarkCategories(department: PoshmarkDepartment): string[] {
  return (
    DATA.departments
      .find((entry) => entry.name === department)
      ?.categories.map((category) => category.name) ?? []
  );
}

/** The category's subcategories, or `null` for a category Poshmark doesn't have. */
export function subcategoriesOf(
  department: PoshmarkDepartment,
  category: string,
): readonly string[] | null {
  return CATEGORIES.get(key(department, category))?.subcategories ?? null;
}

/** The category's size sets, or `null` for a category Poshmark doesn't have. */
export function sizeSetsFor(department: PoshmarkDepartment, category: string): SizeSets | null {
  return CATEGORIES.get(key(department, category))?.sizeSets ?? null;
}

/**
 * The catalog for a department, category, and subcategory, with the category's display group;
 * `null` when Poshmark has no such category or subcategory.
 */
export function poshmarkCatalog(
  department: PoshmarkDepartment,
  category: string,
  subcategory: string | null = null,
): PoshmarkCatalog | null {
  const entry = CATEGORIES.get(key(department, category));
  if (entry === undefined) return null;
  if (subcategory !== null && !entry.subcategories.includes(subcategory)) return null;
  return { department, category, subcategory, group: entry.group };
}

type Department = 'men' | 'women' | 'kids';

/** A place in the catalog, as the map names it: `Category` or `Category/Subcategory`. */
type Place = string | null;

/**
 * `<canonical path>` or a shorter prefix of it, per department; the most specific key wins (as
 * in the eBay map). `null` means Poshmark has no place Listora can tell for it, so the seller
 * picks. Home items go to Home whatever their department (`HOME`).
 */
const MAP: Readonly<Record<Department, Readonly<Record<string, Place>>>> = {
  women: {
    'clothing/tops': 'Tops',
    'clothing/tops/t_shirts': 'Tops/Tees - Short Sleeve',
    'clothing/tops/shirts': 'Tops/Button Down Shirts',
    'clothing/tops/blouses': 'Tops/Blouses',
    'clothing/tops/tank_tops': 'Tops/Tank Tops',
    'clothing/tops/sweaters': 'Sweaters',
    'clothing/tops/cardigans': 'Sweaters/Cardigans',
    'clothing/tops/hoodies_sweatshirts': 'Tops/Sweatshirts & Hoodies',
    'clothing/tops/bodysuits': 'Tops/Bodysuits',
    'clothing/bottoms': 'Pants & Jumpsuits',
    'clothing/bottoms/jeans': 'Jeans',
    'clothing/bottoms/shorts': 'Shorts',
    'clothing/bottoms/skirts': 'Skirts',
    'clothing/bottoms/leggings': 'Pants & Jumpsuits/Leggings',
    'clothing/bottoms/joggers': 'Pants & Jumpsuits/Track Pants & Joggers',
    'clothing/dresses': 'Dresses',
    'clothing/dresses/jumpsuits_rompers': 'Pants & Jumpsuits/Jumpsuits & Rompers',
    'clothing/outerwear': 'Jackets & Coats',
    'clothing/outerwear/vests': 'Jackets & Coats/Vests',
    'clothing/outerwear/blazers': 'Jackets & Coats/Blazers & Suit Jackets',
    'clothing/activewear': 'Tops',
    'clothing/activewear/bottoms': 'Pants & Jumpsuits',
    'clothing/activewear/sports_bras': 'Intimates & Sleepwear/Sports Bras',
    'clothing/activewear/sets': null,
    'clothing/swimwear': 'Swim',
    'clothing/swimwear/one_pieces': 'Swim/One Pieces',
    'clothing/swimwear/bikinis': 'Swim/Bikinis',
    'clothing/swimwear/cover_ups': 'Swim/Coverups',
    'clothing/sleep_lounge': 'Intimates & Sleepwear',
    'clothing/sleep_lounge/pajamas': 'Intimates & Sleepwear/Pajamas',
    'clothing/sleep_lounge/robes': 'Intimates & Sleepwear/Robes',
    'clothing/intimates': 'Intimates & Sleepwear',
    'clothing/intimates/bras': 'Intimates & Sleepwear/Bras',
    'clothing/intimates/underwear': 'Intimates & Sleepwear/Panties',
    'clothing/intimates/shapewear': 'Intimates & Sleepwear/Shapewear',
    'clothing/intimates/socks': 'Accessories/Hosiery & Socks',
    'clothing/suits_sets': null,
    'clothing/suits_sets/suits': 'Pants & Jumpsuits/Pantsuits',
    shoes: 'Shoes',
    'shoes/sneakers': 'Shoes/Sneakers',
    'shoes/sandals': 'Shoes/Sandals',
    'shoes/heels': 'Shoes/Heels',
    'shoes/flats': 'Shoes/Flats & Loafers',
    'shoes/loafers': 'Shoes/Flats & Loafers',
    'shoes/slippers': 'Shoes/Slippers',
    bags: 'Bags',
    'bags/shoulder_bags': 'Bags/Shoulder Bags',
    'bags/crossbody_bags': 'Bags/Crossbody Bags',
    'bags/totes': 'Bags/Totes',
    'bags/backpacks': 'Bags/Backpacks',
    'bags/clutches': 'Bags/Clutches & Wristlets',
    'bags/wallets': 'Bags/Wallets',
    accessories: 'Accessories',
    'accessories/hats': 'Accessories/Hats',
    'accessories/scarves': 'Accessories/Scarves & Wraps',
    'accessories/belts': 'Accessories/Belts',
    'accessories/sunglasses': 'Accessories/Sunglasses',
    'accessories/gloves': 'Accessories/Gloves & Mittens',
    'accessories/hair_accessories': 'Accessories/Hair Accessories',
    'accessories/watches': 'Accessories/Watches',
    jewelry: 'Jewelry',
    'jewelry/necklaces': 'Jewelry/Necklaces',
    'jewelry/earrings': 'Jewelry/Earrings',
    'jewelry/bracelets': 'Jewelry/Bracelets',
    'jewelry/rings': 'Jewelry/Rings',
    'jewelry/brooches': 'Jewelry/Brooches',
  },
  men: {
    'clothing/tops': 'Shirts',
    'clothing/tops/t_shirts': 'Shirts/Tees - Short Sleeve',
    'clothing/tops/shirts': 'Shirts/Casual Button Down Shirts',
    'clothing/tops/tank_tops': 'Shirts/Tank Tops',
    'clothing/tops/polos': 'Shirts/Polos',
    'clothing/tops/sweaters': 'Sweaters',
    'clothing/tops/cardigans': 'Sweaters/Cardigan',
    'clothing/tops/hoodies_sweatshirts': 'Shirts/Sweatshirts & Hoodies',
    'clothing/bottoms': 'Pants',
    'clothing/bottoms/jeans': 'Jeans',
    'clothing/bottoms/shorts': 'Shorts',
    'clothing/bottoms/skirts': null,
    'clothing/bottoms/joggers': 'Pants/Sweatpants & Joggers',
    'clothing/dresses': null,
    'clothing/outerwear': 'Jackets & Coats',
    'clothing/outerwear/vests': 'Jackets & Coats/Vests',
    'clothing/outerwear/blazers': 'Suits & Blazers/Sport Coats & Blazers',
    'clothing/activewear': 'Shirts',
    'clothing/activewear/bottoms': 'Pants',
    'clothing/activewear/sports_bras': null,
    'clothing/activewear/sets': null,
    'clothing/swimwear': 'Swim',
    'clothing/swimwear/swim_trunks': 'Swim/Swim Trunks',
    'clothing/sleep_lounge': null,
    'clothing/intimates': 'Underwear & Socks',
    'clothing/intimates/bras': null,
    'clothing/intimates/socks': 'Underwear & Socks/Casual Socks',
    'clothing/suits_sets': null,
    'clothing/suits_sets/suits': 'Suits & Blazers/Suits',
    shoes: 'Shoes',
    'shoes/sneakers': 'Shoes/Sneakers',
    'shoes/boots': 'Shoes/Boots',
    'shoes/sandals': 'Shoes/Sandals & Flip-Flops',
    'shoes/loafers': 'Shoes/Loafers & Slip-Ons',
    'shoes/dress_shoes': 'Shoes/Oxfords & Derbys',
    bags: 'Bags',
    'bags/backpacks': 'Bags/Backpacks',
    'bags/wallets': 'Bags/Wallets',
    accessories: 'Accessories',
    'accessories/hats': 'Accessories/Hats',
    'accessories/scarves': 'Accessories/Scarves',
    'accessories/belts': 'Accessories/Belts',
    'accessories/sunglasses': 'Accessories/Sunglasses',
    'accessories/gloves': 'Accessories/Gloves',
    'accessories/ties': 'Accessories/Ties',
    'accessories/watches': 'Accessories/Watches',
    jewelry: 'Accessories/Jewelry',
  },
  kids: {
    'clothing/tops': 'Shirts & Tops',
    'clothing/tops/t_shirts': 'Shirts & Tops/Tees - Short Sleeve',
    'clothing/tops/shirts': 'Shirts & Tops/Button Down Shirts',
    'clothing/tops/blouses': 'Shirts & Tops/Blouses',
    'clothing/tops/tank_tops': 'Shirts & Tops/Tank Tops',
    'clothing/tops/polos': 'Shirts & Tops/Polos',
    'clothing/tops/sweaters': 'Shirts & Tops/Sweaters',
    'clothing/tops/cardigans': 'Shirts & Tops/Sweaters',
    'clothing/tops/hoodies_sweatshirts': 'Shirts & Tops/Sweatshirts & Hoodies',
    'clothing/tops/bodysuits': 'One Pieces/Bodysuits',
    'clothing/bottoms': 'Bottoms',
    'clothing/bottoms/jeans': 'Bottoms/Jeans',
    'clothing/bottoms/pants': 'Bottoms/Casual',
    'clothing/bottoms/shorts': 'Bottoms/Shorts',
    'clothing/bottoms/skirts': 'Bottoms/Skirts',
    'clothing/bottoms/leggings': 'Bottoms/Leggings',
    'clothing/bottoms/joggers': 'Bottoms/Sweatpants & Joggers',
    'clothing/dresses': 'Dresses',
    'clothing/dresses/jumpsuits_rompers': 'Bottoms/Jumpsuits & Rompers',
    'clothing/outerwear': 'Jackets & Coats',
    'clothing/outerwear/vests': 'Jackets & Coats/Vests',
    'clothing/outerwear/blazers': 'Jackets & Coats/Blazers',
    'clothing/activewear': 'Shirts & Tops',
    'clothing/activewear/bottoms': 'Bottoms',
    'clothing/activewear/sports_bras': null,
    'clothing/activewear/sets': 'Matching Sets',
    'clothing/swimwear': 'Swim',
    'clothing/swimwear/one_pieces': 'Swim/One Piece',
    'clothing/swimwear/bikinis': 'Swim/Bikinis',
    'clothing/swimwear/swim_trunks': 'Swim/Swim Trunks',
    'clothing/swimwear/cover_ups': 'Swim/Coverups',
    'clothing/sleep_lounge': 'Pajamas',
    'clothing/sleep_lounge/pajamas': 'Pajamas/Pajama Sets',
    'clothing/sleep_lounge/robes': 'Pajamas/Robes',
    'clothing/intimates': 'Accessories',
    'clothing/intimates/bras': null,
    'clothing/intimates/underwear': 'Accessories/Underwear',
    'clothing/intimates/socks': 'Accessories/Socks & Tights',
    'clothing/suits_sets': null,
    'clothing/suits_sets/matching_sets': 'Matching Sets',
    shoes: 'Shoes',
    'shoes/sneakers': 'Shoes/Sneakers',
    'shoes/boots': 'Shoes/Boots',
    'shoes/sandals': 'Shoes/Sandals & Flip Flops',
    'shoes/dress_shoes': 'Shoes/Dress Shoes',
    'shoes/slippers': 'Shoes/Slippers',
    bags: 'Accessories/Bags',
    accessories: 'Accessories',
    'accessories/hats': 'Accessories/Hats',
    'accessories/belts': 'Accessories/Belts',
    'accessories/sunglasses': 'Accessories/Sunglasses',
    'accessories/gloves': 'Accessories/Mittens',
    'accessories/hair_accessories': 'Accessories/Hair Accessories',
    'accessories/ties': 'Accessories/Ties',
    'accessories/watches': 'Accessories/Watches',
    jewelry: 'Accessories/Jewelry',
  },
};

/** Home items, whatever their department; the rest of `home/` is the seller's pick. */
const HOME: Readonly<Record<string, Place>> = {
  home: null,
  'home/decor': 'Accents/Decor',
  'home/kitchen': 'Kitchen',
  'home/bedding': 'Bedding',
};

/**
 * The Poshmark catalog for an item's canonical category and department, or `null` when the map
 * has none. Unisex items go under Men, whose letter sizes fit them; kids' items under Kids.
 */
export function mapPoshmarkCatalog(
  canonical: string | null,
  department: string | null,
): PoshmarkCatalog | null {
  if (canonical === null) return null;
  if (canonical === 'home' || canonical.startsWith('home/')) {
    return lookup(HOME, canonical, 'Home');
  }
  if (department === 'women') return lookup(MAP.women, canonical, 'Women');
  if (department === 'men' || department === 'unisex') return lookup(MAP.men, canonical, 'Men');
  if (department === 'kids') return lookup(MAP.kids, canonical, 'Kids');
  return null;
}

function lookup(
  table: Readonly<Record<string, Place>>,
  canonical: string,
  department: PoshmarkDepartment,
): PoshmarkCatalog | null {
  const segments = canonical.split('/');
  // The full path first, then shorter prefixes: `clothing/tops/t_shirts`, `clothing/tops`, ...
  for (let length = segments.length; length >= 1; length -= 1) {
    const path = segments.slice(0, length).join('/');
    if (!Object.hasOwn(table, path)) continue;
    const place = table[path] ?? null;
    if (place === null) return null;
    const [category = '', subcategory = null] = place.split('/');
    return poshmarkCatalog(department, category, subcategory);
  }
  return null;
}

/**
 * A Poshmark catalog the listing names itself in its `categoryRef`: `Department/Category` or
 * `Department/Category/Subcategory`, in Poshmark's display names. `null` when Poshmark has no
 * such place.
 */
export function parseCatalogRef(ref: string): PoshmarkCatalog | null {
  const [department, category, subcategory, ...rest] = ref.split('/').map((part) => part.trim());
  if (rest.length > 0 || department === undefined || category === undefined) return null;
  const known = POSHMARK_DEPARTMENTS.find((name) => name === department);
  if (known === undefined) return null;
  return poshmarkCatalog(
    known,
    category,
    subcategory === undefined || subcategory === '' ? null : subcategory,
  );
}

/**
 * Every catalog a listing can name: each category of every department, and each of its
 * subcategories (Poshmark's subcategory is optional).
 */
export function mappedPoshmarkCatalogs(): PoshmarkCatalog[] {
  return POSHMARK_DEPARTMENTS.flatMap((department) =>
    poshmarkCategories(department).flatMap((category) => {
      const subcategories = subcategoriesOf(department, category) ?? [];
      return [null, ...subcategories].flatMap((subcategory) => {
        const found = poshmarkCatalog(department, category, subcategory);
        return found === null ? [] : [found];
      });
    }),
  );
}

/** Every place the canonical map names, for the test that holds it to the data. */
export function canonicalMapPlaces(): { department: PoshmarkDepartment; place: string }[] {
  const named = (department: PoshmarkDepartment, table: Readonly<Record<string, Place>>) =>
    Object.values(table).flatMap((place) => (place === null ? [] : [{ department, place }]));
  return [
    ...named('Women', MAP.women),
    ...named('Men', MAP.men),
    ...named('Kids', MAP.kids),
    ...named('Home', HOME),
  ];
}
