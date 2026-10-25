/**
 * Listora's canonical categories (`ItemSnapshot.category`, for example `clothing/tops/t_shirts`,
 * plus the department) mapped to Depop's categories, which the listing form picks level by
 * level: the department (Menswear, Womenswear), the category (Tops), and the product type
 * (T-shirts). The names are Listora's model of Depop's US category picker; the form is only seen
 * through a seller's session, so they are confirmed in the first linked session
 * (docs/features/depop-automation.md, "Live verification"). A name the form does not offer stops
 * the create before anything is sent, and the user lists the item.
 *
 * Where Depop's own documentation names an entry's product type id (`tshirts`, `jeans`,
 * `joggers-tracksuits`, `dresses`, `swimsuit-one-piece`, `boots`, `other-accessories`; the
 * Selling API's taxonomy, `@listora/marketplaces` depop/taxonomy.ts), the entry carries it, so a
 * listing that names that id in its `categoryRef` (as API mode takes it) maps here too. The
 * others carry none: Listora does not guess Depop's ids.
 *
 * Each entry also says which size list the category takes. The most specific key wins, as in the
 * other maps. Kids' and unisex items (Depop has no unisex department), home and other items, and
 * canonical categories without an entry get no category: the listing then names one itself
 * (`variant.categoryRef`).
 */

/** Which of Depop's size lists a category takes. */
export type DepopSizeKind = 'clothing' | 'shoes' | 'none';

export interface DepopCategory {
  /** The names to pick, department first: `['Menswear', 'Tops', 'T-shirts']`. */
  path: readonly [department: string, category: string, productType: string];
  /** Depop's product type id, where Depop's documentation names it. */
  productType: string | null;
  size: DepopSizeKind;
}

type Department = 'men' | 'women';

const entry =
  (size: DepopSizeKind) =>
  (department: string, category: string, type: string, productType?: string): DepopCategory => ({
    path: [department, category, type],
    productType: productType ?? null,
    size,
  });
const clothing = entry('clothing');
const shoes = entry('shoes');
const unsized = entry('none');

const M = 'Menswear';
const W = 'Womenswear';

const MAP: Readonly<Record<Department, Readonly<Record<string, DepopCategory>>>> = {
  men: {
    'clothing/tops': clothing(M, 'Tops', 'T-shirts', 'tshirts'),
    'clothing/tops/t_shirts': clothing(M, 'Tops', 'T-shirts', 'tshirts'),
    'clothing/tops/shirts': clothing(M, 'Tops', 'Shirts'),
    'clothing/tops/polos': clothing(M, 'Tops', 'Polo shirts'),
    'clothing/tops/tank_tops': clothing(M, 'Tops', 'Tank tops'),
    'clothing/tops/sweaters': clothing(M, 'Tops', 'Sweaters'),
    'clothing/tops/cardigans': clothing(M, 'Tops', 'Cardigans'),
    'clothing/tops/hoodies_sweatshirts': clothing(M, 'Tops', 'Hoodies'),
    'clothing/bottoms': clothing(M, 'Bottoms', 'Pants'),
    'clothing/bottoms/jeans': clothing(M, 'Bottoms', 'Jeans', 'jeans'),
    'clothing/bottoms/shorts': clothing(M, 'Bottoms', 'Shorts'),
    'clothing/bottoms/joggers': clothing(M, 'Bottoms', 'Sweatpants', 'joggers-tracksuits'),
    'clothing/outerwear': clothing(M, 'Coats & jackets', 'Jackets'),
    'clothing/outerwear/coats': clothing(M, 'Coats & jackets', 'Coats'),
    'clothing/outerwear/vests': clothing(M, 'Coats & jackets', 'Vests'),
    'clothing/outerwear/blazers': clothing(M, 'Coats & jackets', 'Blazers'),
    'clothing/swimwear': clothing(M, 'Bottoms', 'Swimwear'),
    shoes: shoes(M, 'Footwear', 'Sneakers'),
    'shoes/sneakers': shoes(M, 'Footwear', 'Sneakers'),
    'shoes/boots': shoes(M, 'Footwear', 'Boots', 'boots'),
    'shoes/sandals': shoes(M, 'Footwear', 'Sandals'),
    'shoes/loafers': shoes(M, 'Footwear', 'Loafers'),
    'shoes/dress_shoes': shoes(M, 'Footwear', 'Dress shoes'),
    bags: unsized(M, 'Accessories', 'Bags'),
    'bags/wallets': unsized(M, 'Accessories', 'Wallets'),
    accessories: unsized(M, 'Accessories', 'Other', 'other-accessories'),
    'accessories/hats': unsized(M, 'Accessories', 'Hats'),
    'accessories/belts': unsized(M, 'Accessories', 'Belts'),
    'accessories/ties': unsized(M, 'Accessories', 'Ties'),
    'accessories/sunglasses': unsized(M, 'Accessories', 'Sunglasses'),
    'accessories/watches': unsized(M, 'Accessories', 'Watches'),
    jewelry: unsized(M, 'Accessories', 'Jewelry'),
  },
  women: {
    'clothing/tops': clothing(W, 'Tops', 'T-shirts', 'tshirts'),
    'clothing/tops/t_shirts': clothing(W, 'Tops', 'T-shirts', 'tshirts'),
    'clothing/tops/shirts': clothing(W, 'Tops', 'Shirts'),
    'clothing/tops/blouses': clothing(W, 'Tops', 'Blouses'),
    'clothing/tops/tank_tops': clothing(W, 'Tops', 'Tank tops'),
    'clothing/tops/polos': clothing(W, 'Tops', 'Polo shirts'),
    'clothing/tops/bodysuits': clothing(W, 'Tops', 'Bodysuits'),
    'clothing/tops/sweaters': clothing(W, 'Tops', 'Sweaters'),
    'clothing/tops/cardigans': clothing(W, 'Tops', 'Cardigans'),
    'clothing/tops/hoodies_sweatshirts': clothing(W, 'Tops', 'Hoodies'),
    'clothing/bottoms': clothing(W, 'Bottoms', 'Pants'),
    'clothing/bottoms/jeans': clothing(W, 'Bottoms', 'Jeans', 'jeans'),
    'clothing/bottoms/shorts': clothing(W, 'Bottoms', 'Shorts'),
    'clothing/bottoms/skirts': clothing(W, 'Bottoms', 'Skirts'),
    'clothing/bottoms/leggings': clothing(W, 'Bottoms', 'Leggings'),
    'clothing/bottoms/joggers': clothing(W, 'Bottoms', 'Sweatpants', 'joggers-tracksuits'),
    'clothing/dresses': clothing(W, 'Dresses', 'Dresses', 'dresses'),
    'clothing/dresses/jumpsuits_rompers': clothing(W, 'Dresses', 'Jumpsuits & rompers'),
    'clothing/outerwear': clothing(W, 'Coats & jackets', 'Jackets'),
    'clothing/outerwear/coats': clothing(W, 'Coats & jackets', 'Coats'),
    'clothing/outerwear/vests': clothing(W, 'Coats & jackets', 'Vests'),
    'clothing/outerwear/blazers': clothing(W, 'Coats & jackets', 'Blazers'),
    'clothing/activewear/sports_bras': clothing(W, 'Tops', 'Sports bras'),
    'clothing/swimwear': clothing(W, 'Swimwear', 'Bikinis'),
    'clothing/swimwear/one_pieces': clothing(W, 'Swimwear', 'One-pieces', 'swimsuit-one-piece'),
    'clothing/swimwear/cover_ups': clothing(W, 'Swimwear', 'Cover-ups'),
    shoes: shoes(W, 'Footwear', 'Sneakers'),
    'shoes/sneakers': shoes(W, 'Footwear', 'Sneakers'),
    'shoes/boots': shoes(W, 'Footwear', 'Boots', 'boots'),
    'shoes/sandals': shoes(W, 'Footwear', 'Sandals'),
    'shoes/heels': shoes(W, 'Footwear', 'Heels'),
    'shoes/flats': shoes(W, 'Footwear', 'Flats'),
    'shoes/loafers': shoes(W, 'Footwear', 'Loafers'),
    bags: unsized(W, 'Bags', 'Handbags'),
    'bags/shoulder_bags': unsized(W, 'Bags', 'Shoulder bags'),
    'bags/crossbody_bags': unsized(W, 'Bags', 'Crossbody bags'),
    'bags/totes': unsized(W, 'Bags', 'Tote bags'),
    'bags/backpacks': unsized(W, 'Bags', 'Backpacks'),
    'bags/clutches': unsized(W, 'Bags', 'Clutches'),
    'bags/wallets': unsized(W, 'Accessories', 'Wallets'),
    accessories: unsized(W, 'Accessories', 'Other', 'other-accessories'),
    'accessories/hats': unsized(W, 'Accessories', 'Hats'),
    'accessories/scarves': unsized(W, 'Accessories', 'Scarves'),
    'accessories/belts': unsized(W, 'Accessories', 'Belts'),
    'accessories/sunglasses': unsized(W, 'Accessories', 'Sunglasses'),
    'accessories/hair_accessories': unsized(W, 'Accessories', 'Hair accessories'),
    'accessories/watches': unsized(W, 'Accessories', 'Watches'),
    jewelry: unsized(W, 'Jewelry', 'Necklaces'),
    'jewelry/earrings': unsized(W, 'Jewelry', 'Earrings'),
    'jewelry/bracelets': unsized(W, 'Jewelry', 'Bracelets'),
    'jewelry/rings': unsized(W, 'Jewelry', 'Rings'),
    'jewelry/brooches': unsized(W, 'Jewelry', 'Brooches'),
  },
};

/** The mapped Depop category for an item, or `null` when the map has none. */
export function mapDepopCategory(
  canonical: string | null,
  department: string | null,
): DepopCategory | null {
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
 * A category the listing names itself (`variant.categoryRef`): Depop's three names joined with
 * `>` (`Womenswear > Footwear > Boots`), or a product type id Depop documents and the map holds
 * (`boots`, for the item's department). `null` when it is neither.
 */
export function parseCategoryRef(
  ref: string,
  department: string | null,
): DepopCategory['path'] | null {
  const path = ref.split('>').map((name) => name.trim());
  if (path.length === 3 && path.every((name) => name !== '')) {
    const [top, category, type] = path as [string, string, string];
    return [top, category, type];
  }
  if (path.length !== 1 || (department !== 'men' && department !== 'women')) return null;
  const id = ref.trim();
  return Object.values(MAP[department]).find((entry) => entry.productType === id)?.path ?? null;
}

/**
 * The size list of a category the listing names itself: that of the mapped category with the
 * same path, else what the item's canonical category suggests.
 */
export function categorySizeKind(path: readonly string[], canonical: string | null): DepopSizeKind {
  const key = path.join(' > ');
  for (const table of Object.values(MAP)) {
    for (const found of Object.values(table)) {
      if (found.path.join(' > ') === key) return found.size;
    }
  }
  if (canonical?.startsWith('clothing/') === true) return 'clothing';
  if (canonical?.startsWith('shoes') === true) return 'shoes';
  return 'none';
}

/** Every mapped category once (the fake Depop site offers exactly these). */
export function mappedDepopCategories(): DepopCategory[] {
  const byPath = new Map<string, DepopCategory>();
  for (const table of Object.values(MAP)) {
    for (const found of Object.values(table)) {
      const key = found.path.join(' > ');
      // An entry with Depop's documented id wins over a broader one with the same names.
      if (!byPath.has(key) || found.productType !== null) byPath.set(key, found);
    }
  }
  return [...byPath.values()];
}
