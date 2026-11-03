/**
 * Poshmark's public search (`/search?query=<words>`), as any logged-out visitor's browser reads
 * it (docs/features/thrift-scan.md, "Poshmark"): the comparison read's sold search (the page's
 * own "Sold items" filter, `availability=sold_out`) and its for-sale search (the page as it
 * opens, which shows listings available now). Each is one page load of the URL the search box
 * and that filter make; nothing else is sent.
 *
 * Both pages are rendered from the data they embed (`window.__INITIAL_STATE__`, read live on
 * 2026-11-02 in a fresh browser context with no cookies): the search's first 48 results in
 * `$_search.gridData.data`, the same listing records closet pages embed (state.ts), and the
 * search's own count in `$_search.gridData.total_listing_count`. Only those two are read, by
 * their path, not the whole page's data (several megabytes of filters). Of each result only its
 * title, brand, department and category, sizes, price, and (sold) the day it sold are used:
 * never the seller, the photos, the comments, or the likes.
 *
 * Poshmark dates a sold listing by its inventory's last change (`inventory.status_changed_at`,
 * the change to `sold_out`). A listing of many sizes or quantities (a boutique's, `multi_item`),
 * lots and bundles, and prices not in US dollars are never counted.
 */
import { z } from 'zod';

import type { MarketListing } from '@listora/sourcing/market';

import type { PageDriver } from '../../runner/types.ts';
import type { PoshmarkSite } from '../site.ts';
import { expectShape } from './state.ts';

const PAGE = 'search';

/** Which of the search's two pages: sold listings, or listings for sale now. */
export type PoshmarkSearchKind = 'sold' | 'for_sale';

/** Where the search's results and count are in the page's data (`PageDriver.pageData`). */
export const POSHMARK_SEARCH_DATA = {
  results: '__INITIAL_STATE__.$_search.gridData.data',
  total: '__INITIAL_STATE__.$_search.gridData.total_listing_count',
} as const;

/** Results Poshmark shows on a search page as it opens. */
export const POSHMARK_SEARCH_PAGE_SIZE = 48;

const money = z.object({ val: z.string(), currency_code: z.string() });
const display = z.object({ display: z.string() }).loose();

/** One result, as far as a comparison reads it; Poshmark's other fields are left alone. */
const searchListingSchema = z
  .object({
    title: z.string(),
    brand: z.string().nullish(),
    price_amount: money,
    size: z.string().nullish(),
    inventory: z
      .object({
        /** `available`, `reserved` (a buyer is checking out), `sold_out`, `not_for_sale`. */
        status: z.string(),
        status_changed_at: z.string().optional(),
        multi_item: z.boolean().optional(),
        size_quantities: z.array(z.object({ size_obj: display.optional() }).loose()).optional(),
      })
      .loose(),
    department: display.nullish(),
    category_v2: display.nullish(),
  })
  .loose();
type SearchListing = z.infer<typeof searchListingSchema>;

/** What one of the two searches found. */
export interface PoshmarkSearch {
  /** The page's results that may be counted, read as listings. */
  readonly listings: MarketListing[];
  /** How many results the whole search has, as Poshmark counts them; null when it doesn't say. */
  readonly total: number | null;
  /** How many results the page showed (before any was left out). */
  readonly shown: number;
}

/** The search's results page URL, as the search box and its sold filter make it. */
export function poshmarkSearchUrl(
  site: PoshmarkSite,
  words: string,
  kind: PoshmarkSearchKind,
): string {
  const url = new URL(`${site.origin}/search`);
  url.searchParams.set('query', words.trim());
  url.searchParams.set('type', 'listings');
  url.searchParams.set('src', 'dir');
  if (kind === 'sold') url.searchParams.set('availability', 'sold_out');
  return url.href;
}

/** Loads the search's results page and reads it. */
export async function readPoshmarkSearch(
  page: PageDriver,
  site: PoshmarkSite,
  words: string,
  kind: PoshmarkSearchKind,
): Promise<PoshmarkSearch> {
  await page.goto(poshmarkSearchUrl(site, words, kind));
  const results = await page.pageData(POSHMARK_SEARCH_DATA.results);
  const total = await page.pageData(POSHMARK_SEARCH_DATA.total);
  return poshmarkSearchFromData(results, total, kind);
}

/** The search's listings and count, out of the page's data. */
export function poshmarkSearchFromData(
  results: unknown,
  total: unknown,
  kind: PoshmarkSearchKind,
): PoshmarkSearch {
  const records = expectShape(z.array(z.unknown()), results, PAGE);
  const listings: MarketListing[] = [];
  for (const record of records) {
    const listing = listingOf(expectShape(searchListingSchema, record, PAGE), kind);
    if (listing !== null) listings.push(listing);
  }
  const count = z.number().int().min(0).safeParse(total);
  return { listings, total: count.success ? count.data : null, shown: records.length };
}

/** Words that make a result many items. */
const LOT = /\b(lots?|bundles?|bulk|wholesale|bale)\b/i;

/** A result as a listing; `null` for one the comparisons must not count. */
function listingOf(record: SearchListing, kind: PoshmarkSearchKind): MarketListing | null {
  const sold = kind === 'sold';
  // The sold filter shows only sold listings and the plain search only available ones; any other
  // on either page is not what that page counts.
  const status = record.inventory.status;
  if (sold ? status !== 'sold_out' : status !== 'available' && status !== 'reserved') return null;
  if (record.inventory.multi_item === true) return null;
  if (record.price_amount.currency_code !== 'USD') return null;
  const priceCents = cents(record.price_amount.val);
  if (priceCents === null || priceCents === 0) return null;
  const title = record.title.replace(/\s+/g, ' ').trim();
  if (title === '' || LOT.test(title)) return null;
  const at = sold ? soldAt(record.inventory.status_changed_at) : null;
  if (sold && at === null) return null;
  return {
    priceCents,
    sold,
    // A listing without a brand matches none: Poshmark has the field, so its words are not asked.
    brand: record.brand ?? '',
    productType: productTypeOf(record),
    sizes: sizesOf(record),
    text: title,
    at,
  };
}

/**
 * A listing's product type as the comparison query names Poshmark's (comps/query.ts): its
 * department and category (`Women/Jeans`), or `null` without both.
 */
export function productTypeOf(record: Pick<SearchListing, 'department' | 'category_v2'>) {
  const department = record.department?.display.trim() ?? '';
  const category = record.category_v2?.display.trim() ?? '';
  return department === '' || category === '' ? null : poshmarkProductType(department, category);
}

/** The product type a Poshmark department and category make (`Women/Jeans`). */
export function poshmarkProductType(department: string, category: string): string {
  return `${department}/${category}`;
}

/** The sizes a listing names: its own (`28`) and each of its sizes as the page shows them. */
function sizesOf(record: SearchListing): string[] {
  const sizes = new Set<string>();
  if (record.size !== undefined && record.size !== null && record.size.trim() !== '') {
    sizes.add(record.size.trim());
  }
  for (const quantity of record.inventory.size_quantities ?? []) {
    const shown = quantity.size_obj?.display.trim() ?? '';
    if (shown !== '') sizes.add(shown);
  }
  return [...sizes];
}

/** When a sold listing sold: its inventory's last change (ISO with an offset); null without. */
function soldAt(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

/** A US dollar amount (`"34.0"`) in cents, or null for one Listora can't read. */
function cents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
