/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to Depop's own categories: a department (Men, Women, Kids,
 * Everything else), a category ("group": Tops), and a product type (T-shirts), as Depop's sell
 * form offers them. Every Depop name, size list, and item specific comes from Depop's own data
 * (taxonomy/taxonomy.json, docs/features/depop-automation.md, "The taxonomy"); this file only
 * says which of Depop's product types fits each of Listora's categories.
 *
 * - Departments: women's items are Women, men's and unisex ones Men (Depop has no unisex
 *   department for adults, and lists unisex clothing under Men), kids' ones Kids, and home items
 *   Everything else whoever they are for.
 * - Each canonical category names Depop's category and its product types in order of fit; the
 *   first that Depop offers in the item's department is the one (men's tops have no Blouses, so
 *   a men's blouse is a Shirt). The most specific canonical path with an entry wins.
 * - `categories.test.ts` checks that every canonical category resolves, in every department,
 *   to a product type Depop offers there (or is one of the few listed as having none, such as a
 *   men's dress), so a taxonomy refresh that drops a product type fails a test, not a listing.
 *
 * A listing can name any Depop product type itself (`variant.categoryRef`, `parseCategoryRef`).
 */
import {
  depopProductType,
  depopProductTypes,
  type DepopDepartmentId,
  type DepopProductType,
} from './taxonomy/taxonomy.ts';

/** A Depop product type, as the payload carries it. */
export interface DepopCategory {
  /** Depop's ids: `menswear`, `tops`, `tshirts`. */
  ids: readonly [department: string, group: string, productType: string];
  /** The form's names, department first: `['Men', 'Tops', 'T-shirts']`. */
  path: readonly [department: string, category: string, productType: string];
  /** The size labels the form offers for it, in its order; empty when it takes no size. */
  sizes: readonly string[];
  /** The item specifics the form offers for it (`material`, `occasion`, ...). */
  attributes: readonly string[];
}

interface Choice {
  group: string;
  /** Depop's product types, best fit first; `<group>/<type>` for one in another category. */
  types: readonly string[];
}

const choice = (group: string, ...types: string[]): Choice => ({ group, types });

/** Listora's canonical categories (packages/analysis vocabulary.ts) to Depop's. */
export const CANONICAL_CATEGORIES: Readonly<Record<string, Choice>> = {
  'clothing/tops': choice('tops', 'tshirts'),
  'clothing/tops/t_shirts': choice('tops', 'tshirts'),
  'clothing/tops/shirts': choice('tops', 'shirts'),
  'clothing/tops/blouses': choice('tops', 'blouses', 'shirts'),
  'clothing/tops/tank_tops': choice('tops', 'vests-tanks-camis'),
  'clothing/tops/polos': choice('tops', 'polo-shirts'),
  'clothing/tops/sweaters': choice('tops', 'jumpers'),
  'clothing/tops/cardigans': choice('tops', 'cardigans'),
  'clothing/tops/hoodies_sweatshirts': choice('tops', 'hoodies'),
  'clothing/tops/bodysuits': choice('tops', 'bodysuits', 'other-tops'),
  'clothing/tops/other': choice('tops', 'other-tops'),
  'clothing/bottoms': choice('bottoms', 'trousers'),
  'clothing/bottoms/jeans': choice('bottoms', 'jeans'),
  'clothing/bottoms/pants': choice('bottoms', 'trousers'),
  'clothing/bottoms/shorts': choice('bottoms', 'shorts'),
  'clothing/bottoms/skirts': choice('bottoms', 'skirts'),
  'clothing/bottoms/leggings': choice('bottoms', 'leggings', 'joggers-tracksuits'),
  'clothing/bottoms/joggers': choice('bottoms', 'joggers-tracksuits'),
  'clothing/bottoms/other': choice('bottoms', 'other-bottoms'),
  'clothing/dresses': choice('dresses', 'dresses'),
  'clothing/dresses/dresses': choice('dresses', 'dresses'),
  'clothing/dresses/jumpsuits_rompers': choice('jumpsuit-and-playsuit', 'jumpsuit'),
  'clothing/dresses/other': choice('dresses', 'other-dresses'),
  'clothing/outerwear': choice('coats-jackets', 'jackets'),
  'clothing/outerwear/jackets': choice('coats-jackets', 'jackets'),
  'clothing/outerwear/coats': choice('coats-jackets', 'coats'),
  'clothing/outerwear/vests': choice('coats-jackets', 'gilets'),
  'clothing/outerwear/blazers': choice('suits', 'tailored-jackets', 'coats-jackets/jackets'),
  'clothing/outerwear/other': choice('coats-jackets', 'other-coats-jackets'),
  'clothing/activewear': choice('tops', 'other-tops'),
  'clothing/activewear/tops': choice('tops', 'other-tops'),
  'clothing/activewear/bottoms': choice('bottoms', 'leggings', 'joggers-tracksuits'),
  'clothing/activewear/sports_bras': choice('underwear', 'bras'),
  'clothing/activewear/sets': choice('tops', 'other-tops'),
  'clothing/activewear/other': choice('tops', 'other-tops'),
  'clothing/swimwear': choice('swim-beach-wear', 'other-swim-beach-wear'),
  'clothing/swimwear/one_pieces': choice('swim-beach-wear', 'swimsuit-one-piece'),
  'clothing/swimwear/bikinis': choice('swim-beach-wear', 'bikinis-and-tankini-sets'),
  'clothing/swimwear/swim_trunks': choice(
    'swim-beach-wear',
    'swim-briefs-shorts',
    'other-swim-beach-wear',
  ),
  'clothing/swimwear/cover_ups': choice('swim-beach-wear', 'cover-ups', 'other-swim-beach-wear'),
  'clothing/swimwear/other': choice('swim-beach-wear', 'other-swim-beach-wear'),
  'clothing/sleep_lounge': choice('nightwear', 'other-nightwear'),
  'clothing/sleep_lounge/pajamas': choice('nightwear', 'pajamas'),
  'clothing/sleep_lounge/robes': choice('nightwear', 'robes'),
  'clothing/sleep_lounge/loungewear': choice('nightwear', 'other-nightwear'),
  'clothing/sleep_lounge/other': choice('nightwear', 'other-nightwear'),
  'clothing/intimates': choice('underwear', 'other-underwear'),
  'clothing/intimates/bras': choice('underwear', 'bras'),
  'clothing/intimates/underwear': choice('underwear', 'panties', 'boxers-and-briefs'),
  'clothing/intimates/shapewear': choice('underwear', 'shapewear'),
  'clothing/intimates/socks': choice('underwear', 'socks'),
  'clothing/intimates/other': choice('underwear', 'other-underwear'),
  'clothing/suits_sets': choice('suits', 'suits'),
  'clothing/suits_sets/suits': choice('suits', 'suits'),
  'clothing/suits_sets/matching_sets': choice('suits', 'other-suits'),
  'clothing/suits_sets/other': choice('suits', 'other-suits'),
  shoes: choice('footwear', 'other-footwear'),
  'shoes/sneakers': choice('footwear', 'trainers'),
  'shoes/boots': choice('footwear', 'boots'),
  'shoes/sandals': choice('footwear', 'sandals'),
  'shoes/heels': choice('footwear', 'courts'),
  'shoes/flats': choice('footwear', 'ballet-shoes', 'loafers'),
  'shoes/loafers': choice('footwear', 'loafers'),
  'shoes/dress_shoes': choice('footwear', 'oxfords', 'brogues'),
  'shoes/slippers': choice('footwear', 'slippers'),
  'shoes/other': choice('footwear', 'other-footwear'),
  bags: choice('accessories', 'bag'),
  'bags/wallets': choice('accessories', 'wallet-purses'),
  accessories: choice('accessories', 'other-accessories'),
  'accessories/hats': choice('accessories', 'hat'),
  'accessories/scarves': choice('accessories', 'scarf-wraps'),
  'accessories/belts': choice('accessories', 'belt'),
  'accessories/sunglasses': choice('accessories', 'sunglasses'),
  'accessories/gloves': choice('accessories', 'gloves'),
  'accessories/hair_accessories': choice('accessories', 'hair-accessories', 'other-accessories'),
  'accessories/ties': choice('accessories', 'other-accessories'),
  'accessories/watches': choice('accessories', 'watch'),
  'accessories/other': choice('accessories', 'other-accessories'),
  jewelry: choice('accessories', 'jewellery'),
  home: choice('home', 'decor-home-accesories'),
  'home/decor': choice('home', 'decor-home-accesories'),
  'home/kitchen': choice('home', 'dinnerware'),
  'home/bedding': choice('home', 'soft-furnishings-textiles'),
};

/** Canonical categories that are Everything else, whoever the item is for. */
const EVERYTHING_ELSE = ['home'];

/** Depop's department for an item's department and category, or `null` when it can't tell. */
export function depopDepartment(
  department: string | null,
  canonical: string,
): DepopDepartmentId | null {
  const top = canonical.split('/')[0] ?? '';
  if (EVERYTHING_ELSE.includes(top)) return 'everything-else';
  switch (department) {
    case 'women':
      return 'womenswear';
    case 'men':
    case 'unisex':
      return 'menswear';
    case 'kids':
      return 'kidswear';
    case null:
    default:
      return null;
  }
}

/** The mapped Depop category for an item, or `null` when Depop has none for it. */
export function mapDepopCategory(
  canonical: string | null,
  department: string | null,
): DepopCategory | null {
  if (canonical === null) return null;
  const depopDepartmentId = depopDepartment(department, canonical);
  if (depopDepartmentId === null) return null;
  const segments = canonical.split('/');
  // The full path first, then shorter prefixes: `clothing/tops/t_shirts`, `clothing/tops`, ...
  for (let length = segments.length; length >= 1; length -= 1) {
    const found = CANONICAL_CATEGORIES[segments.slice(0, length).join('/')];
    if (found === undefined) continue;
    for (const type of found.types) {
      const [group, productType] = type.includes('/') ? type.split('/') : [found.group, type];
      const offered = depopProductType(depopDepartmentId, group ?? '', productType ?? '');
      if (offered !== null) return category(offered);
    }
    return null;
  }
  return null;
}

/** Depop's former department names, which listings saved before the taxonomy may name. */
const DEPARTMENT_NAMES: Readonly<Record<string, string>> = {
  menswear: 'Men',
  womenswear: 'Women',
  kidswear: 'Kids',
  men: 'Men',
  women: 'Women',
  kids: 'Kids',
  'everything else': 'Everything else',
};

/**
 * A category the listing names itself (`variant.categoryRef`), in any of the ways Depop names
 * one: the form's three names joined with `>` (`Women > Footwear > Boots`; `Womenswear` and the
 * other former department names still read), Depop's ids joined with `/`
 * (`womenswear/footwear/boots`), or a product type id alone (`boots`, in the item's
 * department). `null` when Depop has no such product type.
 */
export function parseCategoryRef(ref: string, department: string | null): DepopCategory | null {
  const byNames = ref.split('>').map((name) => name.trim().toLowerCase());
  if (byNames.length === 3) {
    const [top = '', group = '', type = ''] = byNames;
    const departmentName = (DEPARTMENT_NAMES[top] ?? top).toLowerCase();
    for (const offered of allProductTypes()) {
      if (
        offered.department.name.toLowerCase() === departmentName &&
        offered.group.name.toLowerCase() === group &&
        offered.productType.name.toLowerCase() === type
      ) {
        return category(offered);
      }
    }
    return null;
  }
  const byIds = ref.trim().split('/');
  if (byIds.length === 3) {
    const [top = '', group = '', type = ''] = byIds;
    const offered = depopProductType(top, group, type);
    return offered === null ? null : category(offered);
  }
  if (byIds.length !== 1) return null;
  const id = ref.trim();
  const departments: string[] =
    department === null ? [] : [depopDepartment(department, 'clothing') ?? '', 'everything-else'];
  for (const offered of allProductTypes()) {
    if (offered.productType.id === id && departments.includes(offered.department.id)) {
      return category(offered);
    }
  }
  return null;
}

const EVERY_TYPE = depopProductTypes();
const allProductTypes = (): readonly DepopProductType[] => EVERY_TYPE;

/** Every Depop product type, in every department, in Depop's order (the List flow's choices). */
export function allDepopCategories(): DepopCategory[] {
  return EVERY_TYPE.map(category);
}

function category(offered: DepopProductType): DepopCategory {
  return {
    ids: [offered.department.id, offered.group.id, offered.productType.id],
    path: [offered.department.name, offered.group.name, offered.productType.name],
    sizes: offered.sizes,
    attributes: offered.productType.attributes,
  };
}
