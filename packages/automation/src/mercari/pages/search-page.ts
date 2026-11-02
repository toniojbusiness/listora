/**
 * Mercari's public search (`/search/?keyword=<words>`), as any logged-out visitor's browser
 * reads it (docs/features/thrift-scan.md, "Mercari"): the comparison read's sold search (the
 * page's own "Sold" status filter, `itemStatuses=2`, sorted by its "Newest", `sortBy=2`) and its
 * for-sale search (its "On sale" filter, `itemStatuses=1`, "Best Match"). Each is one page load
 * of the URL the page's own filters and sort make; nothing else is sent.
 *
 * Each result is Mercari's product card (`ItemContainer`, the same card its listing pages show
 * under "More from this seller", read on a real page on 2026-10-27): its item id
 * (`data-productid`), brand (`data-brand`), size (`data-size`), whether it is on sale
 * (`data-is-on-sale`), its name (`ItemName`), and its price (`ProductThumbItemPrice`, the price
 * before a drop struck through after it). Cards in Mercari's carousels (`FeedContainer`) are not
 * the search's and are left out, as are lots and bundles.
 *
 * The cards show no dates. Mercari's server-drawn pages keep the data they were drawn from in
 * `window.__NEXT_DATA__` (`props.pageProps.serverState`, its Apollo cache: an item's `updated`
 * and `lastSoldAt` times, in seconds, read on its listing page on 2026-10-27), so where the
 * search page has its results there, a sold card's sale day (`lastSoldAt`, else its last
 * change) and the search's own count of results (`count`) are read from it; without them, a
 * card has no date and the search no count. Only those are read: never the seller, the photo,
 * or the description, and the item id never leaves the phone (it only joins a card to its data).
 */
import type { MarketListing } from '@listora/sourcing/market';

import type { PageDriver } from '../../runner/types.ts';
import { absolute, changed, type MercariSite } from './common.ts';

const PAGE = 'search results';

/** Which of the search's two pages: sold listings, or listings for sale now. */
export type MercariSearchKind = 'sold' | 'for_sale';

/** Mercari's own item status filter values (`itemStatuses`). */
const ITEM_STATUSES: Readonly<Record<MercariSearchKind, string>> = { sold: '2', for_sale: '1' };
/** Mercari's "Newest" sort (`sortBy`), for the sold search: the latest sold first. */
const NEWEST = '2';

/** A card of the search's own results, not one in a carousel of other items. */
const CARD = '[data-testid="ItemContainer"]:not([data-testid="FeedContainer"] *)';

export const MERCARI_SEARCH_PAGE = {
  /** The search's result cards, or the page's word that it found nothing. */
  ready: `${CARD}, [data-testid="SearchResultsEmpty"], [data-testid="NoSearchResults"]`,
  empty: '[data-testid="SearchResultsEmpty"], [data-testid="NoSearchResults"]',
  card: CARD,
  /**
   * One selector for every part read, so one read of their attributes and one of their texts
   * come back in the page's order and line up: each card, then its name and price.
   */
  parts: [
    CARD,
    `${CARD} [data-testid="ItemName"]`,
    `${CARD} [data-testid="ProductThumbItemPrice"]`,
  ].join(', '),
} as const;

/** What one of the two searches found. */
export interface MercariSearch {
  /** The cards of the first page that are the search's own, read as listings. */
  readonly listings: MarketListing[];
  /** How many results the whole search has, as Mercari counts them; null when it doesn't say. */
  readonly total: number | null;
  /** How many cards the page showed (before any was left out). */
  readonly shown: number;
}

/** The search page's URL, as the page's own status filter makes it. */
export function mercariSearchUrl(
  site: MercariSite,
  words: string,
  kind: MercariSearchKind,
): string {
  const query = new URLSearchParams({ keyword: words.trim(), itemStatuses: ITEM_STATUSES[kind] });
  if (kind === 'sold') query.set('sortBy', NEWEST);
  return absolute(site, `/search/?${query.toString()}`);
}

/** Loads the search page, waits for its results, and reads them. */
export async function readMercariSearch(
  page: PageDriver,
  site: MercariSite,
  words: string,
  kind: MercariSearchKind,
): Promise<MercariSearch> {
  await page.goto(mercariSearchUrl(site, words, kind));
  try {
    await page.waitFor(MERCARI_SEARCH_PAGE.ready, 'attached');
  } catch {
    if (!(await page.exists(MERCARI_SEARCH_PAGE.ready))) {
      throw changed(PAGE, `has no results (${MERCARI_SEARCH_PAGE.card})`);
    }
  }
  if (!(await page.exists(MERCARI_SEARCH_PAGE.card))) return { listings: [], total: 0, shown: 0 };
  const parts = MERCARI_SEARCH_PAGE.parts;
  const roles = await page.attributes(parts, 'data-testid');
  const ids = await page.attributes(parts, 'data-productid');
  const brands = await page.attributes(parts, 'data-brand');
  const sizes = await page.attributes(parts, 'data-size');
  const onSale = await page.attributes(parts, 'data-is-on-sale');
  const texts = await page.texts(parts);
  const lengths = new Set([
    roles.length,
    ids.length,
    brands.length,
    sizes.length,
    onSale.length,
    texts.length,
  ]);
  if (lengths.size !== 1) throw changed(PAGE, 'changed while it was read');
  const cards = groupCards(roles, { ids, brands, sizes, onSale, texts });
  const data = searchData(await page.pageData('__NEXT_DATA__'));
  const listings = cards.flatMap((card) => {
    const listing = listingOf(card, kind, data.times);
    return listing === null ? [] : [listing];
  });
  return { listings, total: data.count, shown: cards.length };
}

/** What the page's own data says of its results: each item's time, and the search's count. */
export interface MercariSearchData {
  /** Each item's sale time (a sold one's `lastSoldAt`) or else its last change, by item id. */
  readonly times: ReadonlyMap<string, Date>;
  /** The search's own count of results, when the page's data has one. */
  readonly count: number | null;
}

/**
 * The item times and the search's count out of `window.__NEXT_DATA__`, the data Mercari's
 * server drew the page from (its Apollo cache, `props.pageProps.serverState`); empty when the
 * page has none (its results drawn in the browser) or has another shape: the page's data is
 * never needed for a read, only for its dates.
 */
export function searchData(nextData: unknown): MercariSearchData {
  const state = field(field(field(nextData, 'props'), 'pageProps'), 'serverState');
  const times = new Map<string, Date>();
  let count: number | null = null;
  if (state === null || typeof state !== 'object') return { times, count };
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    if (key === 'ROOT_QUERY') {
      // The search's own answer, under its query (`search({"criteria":...})`): its `count`.
      for (const [name, answer] of Object.entries(value as Record<string, unknown>)) {
        const total = field(answer, 'count');
        if (/^search/i.test(name) && typeof total === 'number' && Number.isInteger(total)) {
          count = Math.max(0, total);
        }
      }
      continue;
    }
    const id = field(value, 'id');
    if (typeof id !== 'string') continue;
    const at = seconds(field(value, 'lastSoldAt')) ?? seconds(field(value, 'updated'));
    if (at !== null) times.set(id, at);
  }
  return { times, count };
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : null;
}

/** A time in Mercari's seconds since 1970 (or milliseconds) as a date; `null` for none. */
function seconds(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value < 1e12 ? value * 1000 : value);
}

/** One card's parts, as the page shows them. */
export interface MercariCard {
  /** `data-productid`: only to join the card to the page's data; it never leaves the phone. */
  readonly id: string | null;
  readonly brand: string | null;
  readonly size: string | null;
  /** `data-is-on-sale`: `"true"`, `"false"` (sold), or absent. */
  readonly onSale: string | null;
  readonly name: string | null;
  readonly price: string | null;
}

/** The page's parts, in its order, into cards: each card's own name and first price. */
export function groupCards(
  roles: readonly (string | null)[],
  values: {
    readonly ids: readonly (string | null)[];
    readonly brands: readonly (string | null)[];
    readonly sizes: readonly (string | null)[];
    readonly onSale: readonly (string | null)[];
    readonly texts: readonly string[];
  },
): MercariCard[] {
  const cards: {
    id: string | null;
    brand: string | null;
    size: string | null;
    onSale: string | null;
    name: string | null;
    price: string | null;
  }[] = [];
  for (const [index, role] of roles.entries()) {
    if (role === 'ItemContainer') {
      cards.push({
        id: values.ids[index] ?? null,
        brand: values.brands[index] ?? null,
        size: values.sizes[index] ?? null,
        onSale: values.onSale[index] ?? null,
        name: null,
        price: null,
      });
      continue;
    }
    const current = cards.at(-1);
    if (current === undefined) continue;
    const text = values.texts[index] ?? '';
    if (role === 'ItemName') current.name ??= text;
    else if (role === 'ProductThumbItemPrice') current.price ??= text;
  }
  return cards;
}

/** Words that make a listing many items. */
const LOT = /\b(lots?|bundles?|bulk|wholesale|bale)\b/i;

/** A card as a listing; `null` for one the comparisons must not count. */
export function listingOf(
  card: MercariCard,
  kind: MercariSearchKind,
  times: ReadonlyMap<string, Date> = new Map(),
): MarketListing | null {
  const sold = kind === 'sold';
  // A card of the other kind among the results (an item on sale in the sold search) is not one.
  if (sold ? card.onSale === 'true' : card.onSale === 'false') return null;
  const name = (card.name ?? '').replace(/\s+/g, ' ').trim();
  if (name === '' || LOT.test(name)) return null;
  const priceCents = firstPrice(card.price);
  if (priceCents === null) return null;
  const brand = card.brand?.trim() ?? '';
  return {
    priceCents,
    sold,
    // A card without a brand is matched by its name's words, as eBay's titles are.
    brand: brand === '' ? null : brand,
    productType: null,
    sizes: cardSizes(card.size),
    text: name,
    // A sold card's sale day, where the page's data has it; the cards themselves show none.
    at: sold && card.id !== null ? (times.get(card.id) ?? null) : null,
  };
}

/**
 * The price a card shows first, in cents: `$25.00` of `$25.00$60.00` (a dropped price, the old
 * one struck through after it); `null` when it shows none Listora can read.
 */
export function firstPrice(text: string | null): number | null {
  const match = /^\s*\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/.exec(text ?? '');
  if (match?.[1] === undefined) return null;
  return Number(match[1].replaceAll(',', '')) * 100 + Number(match[2] ?? '0');
}

/** A card's size as the comparisons match it: `S (4-6)` is `S`, and `4-6` too. */
export function cardSizes(size: string | null): string[] {
  const shown = size?.replace(/\s+/g, ' ').trim() ?? '';
  if (shown === '') return [];
  const sizes = new Set([shown]);
  const range = /^(.+?)\s*\(([^)]+)\)$/.exec(shown);
  if (range?.[1] !== undefined && range[2] !== undefined) {
    sizes.add(range[1].trim()).add(range[2].trim());
  }
  return [...sizes];
}
