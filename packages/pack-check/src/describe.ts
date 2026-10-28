/**
 * How Pack check names an item in a sentence: "This label is for the black Shaka Wear tee, 2XL".
 * A seller packing a box looks at the item in their hand, so the words are the ones on it: its
 * color, brand, and kind, then its size. An item without a brand or a kind Listora can name is
 * called by its title.
 */

export interface DescribedItem {
  title: string | null;
  sku: string;
  brand: string | null;
  /** The canonical path, `clothing/tops/t_shirts` (@listora/analysis's vocabulary). */
  category: string | null;
  sizeLabel: string | null;
  colors: readonly string[];
}

/** What a seller calls an item of each kind; the last segment of its category path. */
const KIND_NOUNS: Readonly<Record<string, string>> = {
  t_shirts: 'tee',
  shirts: 'shirt',
  blouses: 'blouse',
  tank_tops: 'tank top',
  polos: 'polo',
  sweaters: 'sweater',
  cardigans: 'cardigan',
  hoodies_sweatshirts: 'sweatshirt',
  bodysuits: 'bodysuit',
  jeans: 'jeans',
  pants: 'pants',
  shorts: 'shorts',
  skirts: 'skirt',
  leggings: 'leggings',
  joggers: 'joggers',
  dresses: 'dress',
  jumpsuits_rompers: 'jumpsuit',
  jackets: 'jacket',
  denim_jackets: 'denim jacket',
  coats: 'coat',
  vests: 'vest',
  blazers: 'blazer',
  sports_bras: 'sports bra',
  sneakers: 'sneakers',
  boots: 'boots',
  sandals: 'sandals',
  heels: 'heels',
  flats: 'flats',
};

/** The most characters the name takes before it is shortened. */
const MAX_LENGTH = 60;

/** "black Shaka Wear tee, 2XL"; the title (or the SKU) when Listora can't name the kind. */
export function describeItem(item: DescribedItem): string {
  const kind = item.category?.split('/').at(-1);
  const noun = kind === undefined ? undefined : KIND_NOUNS[kind];
  const brand = item.brand?.trim() ?? '';
  const title = item.title?.trim() ?? '';
  let name: string;
  if (noun !== undefined && brand !== '') {
    const color = item.colors[0]?.trim().toLowerCase() ?? '';
    name = [color, brand, noun].filter((part) => part !== '').join(' ');
  } else {
    name = title === '' ? item.sku : title;
  }
  const size = item.sizeLabel?.trim() ?? '';
  const described = size === '' || name.includes(size) ? name : `${name}, ${size}`;
  return described.length <= MAX_LENGTH ? described : `${described.slice(0, MAX_LENGTH - 3)}...`;
}

/** The items of an order, named: "the black Shaka Wear tee, 2XL", or "2 items: ...". */
export function describeOrder(items: readonly DescribedItem[]): string {
  const [first] = items;
  if (first === undefined) return 'this order';
  if (items.length === 1) return `the ${describeItem(first)}`;
  return `${String(items.length)} items: ${items.map(describeItem).join('; ')}`;
}
