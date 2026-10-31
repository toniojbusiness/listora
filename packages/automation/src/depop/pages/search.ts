/**
 * Depop's public search, as any logged-out visitor's browser reads it (docs/features/
 * thrift-scan.md, "Marketplace comparisons"). The search page (`/search/?q=<words>`) loads its
 * results from Depop's own same-origin API, 24 at a time, the most relevant first:
 * `GET /presentation/api/v1/search/products/?what=<words>&limit=24&country=us&currency=USD
 * &from=in_country_search`, answering `{ meta: { total_count }, page_info, objects }` (read live
 * on 2026-10-31 in a fresh browser context with no cookies: the page's next pages as it
 * scrolled, and its first page in its App Router payload). The comparison read makes that one
 * GET from a warm search page, as the page itself does.
 *
 * Each product carries its brand (`brand_name`), its product type (`attributes.product_type`,
 * Depop's taxonomy id, `jeans`), its sizes, its description, its status, and its price (the
 * item's own, without shipping). Only those are read: never the seller (the slug names them),
 * the photos, or the location.
 */
import { z } from 'zod';

import type { MarketListing } from '@listora/sourcing/market';

import type { PageDriver } from '../../runner/types.ts';
import { changed, type DepopSite } from './common.ts';

const PAGE = 'search';

/** Statuses of a product that sold, as Depop names them (page-data.ts). */
const SOLD_STATUSES = new Set([
  'STATUS_SOLD',
  'STATUS_PURCHASED',
  'STATUS_MARKED_AS_SOLD',
  'SOLD',
  'PURCHASED',
  'MARKED_AS_SOLD',
]);
const ON_SALE_STATUSES = new Set(['STATUS_ONSALE', 'ONSALE']);

const amount = z.object({ amount: z.string() });

const searchProductSchema = z.object({
  brand_name: z.string().nullish(),
  status: z.string(),
  description: z.string(),
  sizes: z.array(z.object({ name: z.string() })).nullish(),
  attributes: z.object({ product_type: z.string().nullish() }).catchall(z.unknown()).nullish(),
  pricing: z
    .object({
      currency_name: z.string(),
      current_price: z.object({ price_breakdown: z.object({ price: amount }) }),
    })
    .catchall(z.unknown()),
});

const searchAnswerSchema = z.object({
  meta: z.object({ total_count: z.number().int().min(0).optional() }).catchall(z.unknown()),
  objects: z.array(z.unknown()),
});

/** One page of results, as the search page asks for it. */
export const DEPOP_SEARCH_PAGE_SIZE = 24;

/** What the search found. */
export interface DepopSearch {
  /** The products of the first page, in US dollars only (others are left out). */
  readonly listings: MarketListing[];
  /** How many products the whole search has, as Depop counts them; null when it doesn't say. */
  readonly total: number | null;
}

/** The public search page, where a comparison read starts (and its warm-up loads). */
export function depopSearchPageUrl(site: DepopSite): string {
  return `${site.origin}/search/`;
}

/** The search API's first page for these words, as the search page asks for it. */
export function depopSearchApiUrl(site: DepopSite, words: string): string {
  const query = new URLSearchParams({
    what: words.trim(),
    limit: String(DEPOP_SEARCH_PAGE_SIZE),
    country: 'us',
    currency: 'USD',
    from: 'in_country_search',
  });
  return `${site.origin}/presentation/api/v1/search/products/?${query.toString()}`;
}

/** Reads the first page of the public search for `words`, from a page on Depop's site. */
export async function readDepopSearch(
  page: PageDriver,
  site: DepopSite,
  words: string,
): Promise<DepopSearch> {
  if (!page.url().startsWith(`${site.origin}/`)) await page.goto(depopSearchPageUrl(site));
  const answer = await page.apiGet(depopSearchApiUrl(site, words));
  if (answer.status !== 200) throw changed(PAGE, `answered ${String(answer.status)}`);
  return depopSearchFromAnswer(answer.body);
}

/** The search's products and count, out of its API answer. */
export function depopSearchFromAnswer(body: unknown): DepopSearch {
  const read = searchAnswerSchema.safeParse(body);
  if (!read.success) throw changed(PAGE, 'answered with results Listora does not know');
  const listings: MarketListing[] = [];
  for (const entry of read.data.objects) {
    const product = searchProductSchema.safeParse(entry);
    if (!product.success) throw changed(PAGE, 'shows a product Listora does not know');
    const listing = listingOf(product.data);
    if (listing !== null) listings.push(listing);
  }
  return { listings, total: read.data.meta.total_count ?? null };
}

function listingOf(product: z.infer<typeof searchProductSchema>): MarketListing | null {
  if (product.pricing.currency_name !== 'USD') return null;
  const sold = SOLD_STATUSES.has(product.status);
  if (!sold && !ON_SALE_STATUSES.has(product.status)) return null;
  const priceCents = cents(product.pricing.current_price.price_breakdown.price.amount);
  if (priceCents === null) return null;
  return {
    priceCents,
    sold,
    // A product without a brand matches none: Depop has the field, so its words are not asked.
    brand: product.brand_name ?? '',
    productType: product.attributes?.product_type ?? null,
    sizes: (product.sizes ?? []).map((size) => size.name),
    text: product.description,
    // Depop shows a visitor no listing or sale date.
    at: null,
  };
}

/** A US dollar amount (`"18.00"`) in cents, or null for one Listora can't read. */
function cents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match?.[1] === undefined) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
}
