/**
 * What an item is likely to cost the seller where they source (docs/features/thrift-scan.md,
 * "What it costs"): at the bins (an outlet that sells by the pound) its typical weight at the
 * seller's price per pound, or at a thrift store its typical shelf price. The call weighs the
 * expected payout against it. Estimates only; the real cost is known at the haul's checkout.
 * Pure.
 */

/** Where the seller sources: `bins` sells by the pound; `store` prices each item. */
export const SOURCING_MODES = ['bins', 'store'] as const;
export type SourcingMode = (typeof SOURCING_MODES)[number];

export interface SourcingCostSettings {
  readonly mode: SourcingMode;
  /** The bins' price per pound, in cents. */
  readonly binsPricePerPoundCents: number;
  /** At a store, the seller's own price for any item; absent: the typical price by category. */
  readonly storeItemCents?: number | undefined;
}

/**
 * The default: the bins at $1.99 a pound. Goodwill's outlets price most goods by weight at about
 * $0.49 to $1.89 a pound depending on the location (Wikipedia, "Goodwill Industries", 2026);
 * $1.99 sits just above that, so the cost is never understated where prices have risen.
 */
export const DEFAULT_SOURCING_COST: SourcingCostSettings = {
  mode: 'bins',
  binsPricePerPoundCents: 199,
};

/** The bounds a seller's own prices are held to: $0.10 to $20 a pound, $0 to $1,000 an item. */
export const BINS_PRICE_PER_POUND_RANGE = { minCents: 10, maxCents: 2_000 } as const;
export const STORE_ITEM_RANGE = { minCents: 0, maxCents: 100_000 } as const;

/**
 * Typical weights in pounds, by category path (`clothing/dresses/dresses`) and else by its group
 * (`clothing/dresses`): common laundry and shipping figures for one used adult garment (a T-shirt
 * about 5 oz, jeans about 1.4 lb, a coat about 3 lb, a pair of sneakers about 2 lb). Rough on
 * purpose: at bins prices a pound either way moves the cost by about $2.
 */
const WEIGHT_LB: Readonly<Record<string, number>> = {
  'clothing/tops': 0.5,
  'clothing/tops/t_shirts': 0.35,
  'clothing/tops/shirts': 0.45,
  'clothing/tops/blouses': 0.35,
  'clothing/tops/tank_tops': 0.2,
  'clothing/tops/polos': 0.45,
  'clothing/tops/sweaters': 1,
  'clothing/tops/cardigans': 0.9,
  'clothing/tops/hoodies_sweatshirts': 1.25,
  'clothing/tops/bodysuits': 0.3,
  'clothing/bottoms': 0.8,
  'clothing/bottoms/jeans': 1.4,
  'clothing/bottoms/pants': 1,
  'clothing/bottoms/shorts': 0.5,
  'clothing/bottoms/skirts': 0.5,
  'clothing/bottoms/leggings': 0.4,
  'clothing/bottoms/joggers': 0.9,
  'clothing/dresses': 0.75,
  'clothing/outerwear': 2,
  'clothing/outerwear/jackets': 2,
  'clothing/outerwear/coats': 3,
  'clothing/outerwear/vests': 1,
  'clothing/outerwear/blazers': 1.5,
  'clothing/activewear': 0.4,
  'clothing/activewear/sets': 0.6,
  'clothing/swimwear': 0.3,
  'clothing/sleep_lounge': 0.8,
  'clothing/sleep_lounge/robes': 1.5,
  'clothing/intimates': 0.15,
  'clothing/suits_sets': 1.2,
  'clothing/suits_sets/suits': 3,
  shoes: 2,
  'shoes/boots': 3.5,
  'shoes/sandals': 1,
  'shoes/heels': 1.5,
  'shoes/flats': 1,
  'shoes/slippers': 0.8,
  bags: 1.3,
  'bags/backpacks': 2,
  'bags/clutches': 0.6,
  'bags/wallets': 0.3,
  accessories: 0.3,
  jewelry: 0.1,
  home: 2,
  other: 1,
};

/** An item the read could not place weighs about a pound. */
const DEFAULT_WEIGHT_LB = 1;

/**
 * Typical thrift-store shelf prices in cents, by category path and else its group: what a
 * chain thrift store (Goodwill, Savers) usually tags a used item of the kind.
 */
const STORE_PRICE_CENTS: Readonly<Record<string, number>> = {
  'clothing/tops': 500,
  'clothing/tops/sweaters': 700,
  'clothing/tops/cardigans': 700,
  'clothing/tops/hoodies_sweatshirts': 700,
  'clothing/bottoms': 700,
  'clothing/bottoms/shorts': 500,
  'clothing/dresses': 800,
  'clothing/outerwear': 1_200,
  'clothing/outerwear/coats': 1_500,
  'clothing/outerwear/vests': 800,
  'clothing/activewear': 500,
  'clothing/swimwear': 500,
  'clothing/sleep_lounge': 500,
  'clothing/intimates': 300,
  'clothing/suits_sets': 1_200,
  shoes: 1_000,
  bags: 800,
  'bags/wallets': 400,
  accessories: 400,
  jewelry: 400,
  home: 500,
  other: 500,
};

const DEFAULT_STORE_PRICE_CENTS = 600;

/** What one item is likely to cost, and how that was worked out. */
export interface ItemCost {
  readonly cents: number;
  readonly mode: SourcingMode;
  /** As the card says it: "Bins cost about $1". */
  readonly label: string;
  /** What it rests on: "About 0.75 lb for a dress, at your $1.99 a pound". */
  readonly basedOn: string;
}

/** The item's likely cost where the seller sources, from its category path (null: unplaced). */
export function itemCost(
  category: string | null,
  settings: SourcingCostSettings = DEFAULT_SOURCING_COST,
): ItemCost {
  if (settings.mode === 'store') {
    const own = settings.storeItemCents;
    const cents = own ?? lookup(STORE_PRICE_CENTS, category) ?? DEFAULT_STORE_PRICE_CENTS;
    return {
      cents,
      mode: 'store',
      label: `Store price about ${dollarsAndCents(cents)}`,
      basedOn:
        own === undefined
          ? `What a thrift store usually asks for ${kindOf(category)}`
          : 'Your store price per item',
    };
  }
  const pounds = lookup(WEIGHT_LB, category) ?? DEFAULT_WEIGHT_LB;
  const cents = Math.round(pounds * settings.binsPricePerPoundCents);
  return {
    cents,
    mode: 'bins',
    label: `Bins cost about ${dollarsAndCents(cents)}`,
    basedOn: `About ${String(pounds)} lb for ${kindOf(category)}, at your ${dollarsAndCents(settings.binsPricePerPoundCents)} a pound`,
  };
}

/** The path's own entry, else its parents', most specific first. */
function lookup(table: Readonly<Record<string, number>>, category: string | null): number | undefined {
  if (category === null || category === '') return undefined;
  const parts = category.split('/');
  for (let length = parts.length; length > 0; length -= 1) {
    const found = table[parts.slice(0, length).join('/')];
    if (found !== undefined) return found;
  }
  return undefined;
}

/** "a dress", "jeans", "an item like it": the category's last step in words. */
function kindOf(category: string | null): string {
  const last = category?.split('/').filter((part) => part !== 'other').at(-1);
  if (last === undefined || last === '' || last === 'clothing') return 'an item like it';
  return SINGULAR[last] ?? last.replaceAll('_', ' ');
}

const SINGULAR: Readonly<Record<string, string>> = {
  dresses: 'a dress',
  t_shirts: 'a T-shirt',
  shirts: 'a shirt',
  blouses: 'a blouse',
  tank_tops: 'a tank top',
  polos: 'a polo',
  sweaters: 'a sweater',
  cardigans: 'a cardigan',
  hoodies_sweatshirts: 'a hoodie',
  bodysuits: 'a bodysuit',
  skirts: 'a skirt',
  jackets: 'a jacket',
  coats: 'a coat',
  vests: 'a vest',
  blazers: 'a blazer',
  suits: 'a suit',
  handbags: 'a handbag',
  totes: 'a tote',
  backpacks: 'a backpack',
  hats: 'a hat',
  scarves: 'a scarf',
  belts: 'a belt',
  sneakers: 'a pair of sneakers',
  boots: 'a pair of boots',
  heels: 'a pair of heels',
  sandals: 'a pair of sandals',
};

/** "$1.49", or "$8" for whole dollars. */
export function dollarsAndCents(cents: number): string {
  return cents % 100 === 0
    ? `$${String(cents / 100)}`
    : `$${(cents / 100).toFixed(2)}`;
}
