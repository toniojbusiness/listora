/**
 * Poshmark's catalog as Listora uses it: the departments and categories a listing is filed
 * under, each category's size sets, and the static map from Listora's canonical categories
 * (`ItemSnapshot.category` with its department) onto them. The full rules and their sources are
 * in docs/features/poshmark.md.
 *
 * Source: Poshmark's own public pages (search, category, and closet pages), read logged out on
 * 2026-10-24. Every page embeds the catalog values of its listings (`department`, `category_v2`,
 * `category_features`), and search pages embed each category's size sets
 * (`facets.sizesGroupedByDepartmentAndCategory`). Names are Poshmark's display names, which its
 * listing form shows. Only values seen there are mapped; a subcategory Listora has not seen is
 * left out (Poshmark's subcategory is optional), so the map never invents a value Poshmark lacks.
 *
 * Women's and men's items are mapped. Kids' items need a girls', boys', or baby size set Listora
 * cannot tell from the item, and Home, Pets, and Electronics are not mapped yet: those items
 * name their Poshmark category in the listing's `categoryRef` (`Women/Tops/Blouses`), or are
 * listed by the user.
 */

export const POSHMARK_DEPARTMENTS = ['Women', 'Men'] as const;
export type PoshmarkDepartment = (typeof POSHMARK_DEPARTMENTS)[number];

/** Where a listing is filed: Poshmark's department, category, and optional subcategory. */
export interface PoshmarkCatalog {
  department: PoshmarkDepartment;
  category: string;
  subcategory: string | null;
}

/** A category's size sets (`Standard`, `Plus`, `Petite`, `Big & Tall`) and their size ids. */
export type SizeSets = Readonly<Record<string, readonly string[]>>;

/**
 * Size sets per category, from the search facets (comma-separated size ids, in Poshmark's
 * order). Juniors and Maternity sets are left out: nothing on an item tells Listora it is either.
 * Categories marked "assumed" were not in the facets Listora read: one-size categories take
 * `OS`, and men's swimwear takes the men's letter sizes.
 */
const SIZE_SETS_SOURCE: Readonly<
  Record<PoshmarkDepartment, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = {
  Women: {
    Accessories: { Standard: 'OS' },
    Bags: { Standard: 'OS' },
    'Bath & Body': { Standard: 'OS' },
    Dresses: {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    // Assumed: one size.
    Hair: { Standard: 'OS' },
    'Intimates & Sleepwear': {
      Standard:
        'OS,XXS,XS,S,M,L,XL,30A,30B,32AA,32A,32B,32C,32D,32E (DD),32F (3D),32G (4D),32H (5D),34AA,34A,34B,34C,34D,34E (DD),34F (3D),34G (4D),34H (5D),36AA,36A,36B,36C,36D,36E (DD),36F (3D),36G (4D),36H (5D)',
      Plus: 'XXL,XXXL,0X,1X,2X,3X,4X,5X,38A,38B,38C,38D,38E (DD),38F (3D),38G (4D),38H (5D),40A,40B,40C,40D,40E (DD),40F (3D),40G (4D),40H (5D),42A,42B,42C,42D,42E (DD),42F (3D),42G (4D),42H (5D),44A,44B,44C,44D,44E (DD),44F (3D),44G (4D),44H (5D),46A,46B,46C,46D,46DD,46F (3D),46G (4D),46H (5D),48A,48B,48C,48D,48DD,48F,48G,48H (5D)',
    },
    'Jackets & Coats': {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    Jeans: {
      Standard: '23,24,25,26,27,28,29,30,31,00,0,2,4,6,8,10,12',
      Plus: '32,33,34,14,14W,16,16W,18,18W,20,20W,22,22W,24Plus,24W,26Plus,26W,28Plus,28W,30Plus,30W,32Plus,32W',
      Petite:
        '23P,24P,25P,26P,27P,28P,29P,30P,31P,32P,33P,34P,00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P',
    },
    Jewelry: { Standard: 'OS' },
    // Assumed: one size.
    Makeup: { Standard: 'OS' },
    'Pants & Jumpsuits': {
      Standard: '23,24,25,26,27,28,29,30,31,00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '32,33,34,14,14W,16,16W,18,18W,20,20W,22,22W,24Plus,24W,26Plus,26W,28Plus,28W,30Plus,30W,32Plus,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite:
        '23P,24P,25P,26P,27P,28P,29P,30P,31P,32P,33P,34P,00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP',
    },
    Shoes: { Standard: '5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,10.5,11,11.5,12,12.5,13' },
    Shorts: {
      Standard: '23,24,25,26,27,28,29,30,31,00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '32,33,34,14,14W,16,16W,18,18W,20,20W,22,22W,24Plus,24W,26Plus,26W,28Plus,28W,30Plus,30W,32Plus,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite:
        '23P,24P,25P,26P,27P,28P,29P,30P,31P,32P,33P,34P,00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    // Assumed: one size.
    Skincare: { Standard: 'OS' },
    Skirts: {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    Sweaters: {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    Swim: {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
    Tops: {
      Standard: '00,0,2,4,6,8,10,12,XXS,XS,S,M,L,XL',
      Plus: '14,14W,16,16W,18,18W,20,20W,22,22W,24,24W,26,26W,28,28W,30,30W,32,32W,XXL,XXXL,0X,1X,2X,3X,4X,5X',
      Petite: '00P,0P,2P,4P,6P,8P,10P,12P,14P,16P,18P,20P,XXSP,XSP,SP,MP,LP,XLP,XXLP',
    },
  },
  Men: {
    Accessories: { Standard: 'OS' },
    // Assumed: one size.
    Bags: { Standard: 'OS' },
    // Assumed: one size.
    Grooming: { Standard: 'OS' },
    'Jackets & Coats': {
      Standard: 'XS,S,M,L,XL',
      'Big & Tall': 'XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    Jeans: {
      Standard: '28,29,30,31,32,33,34,35,36,37,38,39,40,41',
      'Big & Tall': '36BT,37BT,38BT,39BT,40BT,41BT,42,43,44,46,48,50,52,54,56,58,60',
    },
    Pants: {
      Standard: 'XS,S,M,L,XL,28,29,30,31,32,33,34,35,36,37,38,39,40,41',
      'Big & Tall':
        '36BT,37BT,38BT,39BT,40BT,42,43,44,46,48,50,52,54,56,58,60,XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    Shirts: {
      Standard: 'XS,S,M,L,XL,14.5,15,15.5,16,16.5,17,17.5,18',
      'Big & Tall':
        '16.5BT,17BT,17.5BT,18BT,18.5,19,19.5,20,20.5,21,21.5,22,22.5,XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    Shoes: {
      Standard:
        '4,4.5,5,5.5,6,6.5,7,7.5,8,8.5,9,9.5,10,10.5,11,11.5,12,12.5,13,13.5,14,14.5,15,15.5,16',
    },
    Shorts: {
      Standard: 'XS,S,M,L,XL,28,29,30,31,32,33,34,35,36,37,38,39,40,41',
      'Big & Tall':
        '36BT,37BT,38BT,39BT,40BT,42,43,44,46,48,50,52,54,56,58,60,XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    'Suits & Blazers': {
      Standard:
        '34S,34R,34L,35S,35R,35L,36S,36R,36L,37S,37R,37L,38S,38R,38L,39S,39R,39L,40S,40R,40L,41S,41R,41L,42S,42R,42L,43S,43R,43L,44S,44R,44L,45S,45R,45L,46S,46R,46L,47S,47R,47L,48S,48R,48L,49S,49R,49L,50S,50R,50L,51S,51R,51L,52S,52R,52L,53S,53R,53L,54S,54R,54L,55S,55R,55L,56S,56R,56L',
    },
    Sweaters: {
      Standard: 'XS,S,M,L,XL',
      'Big & Tall': 'XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    // Assumed: the men's letter sizes.
    Swim: {
      Standard: 'XS,S,M,L,XL',
      'Big & Tall': 'XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
    'Underwear & Socks': {
      Standard: 'OS,XS,S,M,L,XL',
      'Big & Tall': 'XXL,3XL,4XL,5XL,6XL,LT,XLT,2XLT,3XLT,4XLT,5XLT,6XLT',
    },
  },
};

const SIZE_SETS: Readonly<Record<PoshmarkDepartment, Readonly<Record<string, SizeSets>>>> = {
  Women: parseSets(SIZE_SETS_SOURCE.Women),
  Men: parseSets(SIZE_SETS_SOURCE.Men),
};

function parseSets(
  source: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, SizeSets> {
  return Object.fromEntries(
    Object.entries(source).map(([category, sets]) => [
      category,
      Object.fromEntries(Object.entries(sets).map(([name, ids]) => [name, ids.split(',')])),
    ]),
  );
}

/** The categories Listora knows in a department. */
export function poshmarkCategories(department: PoshmarkDepartment): string[] {
  return Object.keys(SIZE_SETS[department]);
}

/** The category's size sets, or `null` for a category Listora does not know. */
export function sizeSetsFor(department: PoshmarkDepartment, category: string): SizeSets | null {
  return SIZE_SETS[department][category] ?? null;
}

type Department = 'men' | 'women';

const at = (
  department: PoshmarkDepartment,
  category: string,
  subcategory: string | null = null,
): PoshmarkCatalog => ({ department, category, subcategory });
const women = (category: string, subcategory?: string) => at('Women', category, subcategory);
const men = (category: string, subcategory?: string) => at('Men', category, subcategory);

/**
 * `<canonical path>` or a shorter prefix of it, per department; the most specific key wins
 * (as in the eBay map). Subcategories are named only where Poshmark's pages showed them.
 */
const MAP: Readonly<Record<Department, Readonly<Record<string, PoshmarkCatalog>>>> = {
  women: {
    'clothing/tops': women('Tops'),
    'clothing/tops/t_shirts': women('Tops', 'Tees - Short Sleeve'),
    'clothing/tops/blouses': women('Tops', 'Blouses'),
    'clothing/tops/tank_tops': women('Tops', 'Tank Tops'),
    'clothing/tops/sweaters': women('Sweaters'),
    'clothing/tops/cardigans': women('Sweaters', 'Cardigans'),
    'clothing/tops/hoodies_sweatshirts': women('Tops', 'Sweatshirts & Hoodies'),
    'clothing/bottoms': women('Pants & Jumpsuits'),
    'clothing/bottoms/jeans': women('Jeans'),
    'clothing/bottoms/shorts': women('Shorts'),
    'clothing/bottoms/skirts': women('Skirts'),
    'clothing/bottoms/leggings': women('Pants & Jumpsuits', 'Leggings'),
    'clothing/bottoms/joggers': women('Pants & Jumpsuits', 'Track Pants & Joggers'),
    'clothing/dresses': women('Dresses'),
    'clothing/dresses/jumpsuits_rompers': women('Pants & Jumpsuits', 'Jumpsuits & Rompers'),
    'clothing/outerwear': women('Jackets & Coats'),
    'clothing/activewear': women('Tops'),
    'clothing/activewear/bottoms': women('Pants & Jumpsuits'),
    'clothing/activewear/sports_bras': women('Intimates & Sleepwear', 'Bras'),
    'clothing/swimwear': women('Swim'),
    'clothing/swimwear/bikinis': women('Swim', 'Bikinis'),
    'clothing/sleep_lounge': women('Intimates & Sleepwear'),
    'clothing/sleep_lounge/pajamas': women('Intimates & Sleepwear', 'Pajamas'),
    'clothing/intimates': women('Intimates & Sleepwear'),
    'clothing/intimates/bras': women('Intimates & Sleepwear', 'Bras'),
    shoes: women('Shoes'),
    'shoes/sneakers': women('Shoes', 'Sneakers'),
    'shoes/heels': women('Shoes', 'Heels'),
    'shoes/sandals': women('Shoes', 'Sandals'),
    bags: women('Bags'),
    'bags/shoulder_bags': women('Bags', 'Shoulder Bags'),
    'bags/crossbody_bags': women('Bags', 'Crossbody Bags'),
    'bags/totes': women('Bags', 'Totes'),
    'bags/backpacks': women('Bags', 'Backpacks'),
    'bags/wallets': women('Bags', 'Wallets'),
    accessories: women('Accessories'),
    'accessories/hats': women('Accessories', 'Hats'),
    'accessories/watches': women('Accessories', 'Watches'),
    jewelry: women('Jewelry'),
    'jewelry/necklaces': women('Jewelry', 'Necklaces'),
    'jewelry/earrings': women('Jewelry', 'Earrings'),
    'jewelry/bracelets': women('Jewelry', 'Bracelets'),
    'jewelry/rings': women('Jewelry', 'Rings'),
    'jewelry/brooches': women('Jewelry', 'Brooches'),
  },
  men: {
    'clothing/tops': men('Shirts'),
    'clothing/tops/t_shirts': men('Shirts', 'Tees - Short Sleeve'),
    'clothing/tops/shirts': men('Shirts', 'Casual Button Down Shirts'),
    'clothing/tops/polos': men('Shirts', 'Polos'),
    'clothing/tops/sweaters': men('Sweaters'),
    'clothing/tops/cardigans': men('Sweaters'),
    'clothing/tops/hoodies_sweatshirts': men('Shirts', 'Sweatshirts & Hoodies'),
    'clothing/bottoms': men('Pants'),
    'clothing/bottoms/jeans': men('Jeans'),
    'clothing/bottoms/shorts': men('Shorts'),
    'clothing/bottoms/joggers': men('Pants', 'Sweatpants & Joggers'),
    'clothing/outerwear': men('Jackets & Coats'),
    'clothing/outerwear/vests': men('Jackets & Coats', 'Vests'),
    'clothing/outerwear/blazers': men('Suits & Blazers', 'Sport Coats & Blazers'),
    'clothing/activewear': men('Shirts'),
    'clothing/activewear/bottoms': men('Pants'),
    'clothing/swimwear': men('Swim'),
    'clothing/intimates': men('Underwear & Socks'),
    'clothing/suits_sets/suits': men('Suits & Blazers', 'Suits'),
    shoes: men('Shoes'),
    'shoes/sneakers': men('Shoes', 'Sneakers'),
    'shoes/boots': men('Shoes', 'Boots'),
    'shoes/loafers': men('Shoes', 'Loafers & Slip-Ons'),
    'shoes/dress_shoes': men('Shoes', 'Oxfords & Derbys'),
    bags: men('Bags'),
    'bags/backpacks': men('Bags', 'Backpacks'),
    'bags/wallets': men('Bags', 'Wallets'),
    accessories: men('Accessories'),
    'accessories/hats': men('Accessories', 'Hats'),
    'accessories/sunglasses': men('Accessories', 'Sunglasses'),
    'accessories/watches': men('Accessories', 'Watches'),
    jewelry: men('Accessories'),
  },
};

/**
 * The Poshmark catalog for an item's canonical category and department, or `null` when the map
 * has none. Unisex items go under Men, whose letter sizes fit them.
 */
export function mapPoshmarkCatalog(
  canonical: string | null,
  department: string | null,
): PoshmarkCatalog | null {
  const table =
    department === 'women'
      ? MAP.women
      : department === 'men' || department === 'unisex'
        ? MAP.men
        : null;
  if (canonical === null || table === null) return null;
  const segments = canonical.split('/');
  // The full path first, then shorter prefixes: `clothing/tops/t_shirts`, `clothing/tops`, ...
  for (let length = segments.length; length >= 1; length -= 1) {
    const found = table[segments.slice(0, length).join('/')];
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * A Poshmark catalog the listing names itself in its `categoryRef`: `Department/Category` or
 * `Department/Category/Subcategory`, in Poshmark's display names. `null` when it is not one
 * Listora knows (any subcategory is accepted; Poshmark's form shows whether it exists).
 */
export function parseCatalogRef(ref: string): PoshmarkCatalog | null {
  const [department, category, subcategory, ...rest] = ref.split('/').map((part) => part.trim());
  if (rest.length > 0 || department === undefined || category === undefined) return null;
  const known = POSHMARK_DEPARTMENTS.find((name) => name === department);
  if (known === undefined || sizeSetsFor(known, category) === null) return null;
  return at(known, category, subcategory === undefined || subcategory === '' ? null : subcategory);
}

/** Every catalog the map can produce (for tests). */
export function mappedPoshmarkCatalogs(): PoshmarkCatalog[] {
  return Object.values(MAP).flatMap((table) => Object.values(table));
}
