/**
 * Mercari's comparison reader (docs/features/thrift-scan.md, "Mercari"): the item's public
 * search on Mercari, read in a web view that holds no session, twice: its sold listings (the
 * page's own "Sold" filter) and its listings for sale now. Both are matched to the item (the
 * brand Mercari names, else the name's words, and the type in the name, then the model and the
 * size) and reduced to counts and quartiles (`marketStats`), with the for-sale search's count and
 * the sold search's recent pace (`soldLately`). Nothing in it signs in, likes,
 * offers, or buys anything: it only loads the search pages any visitor's browser loads.
 */
import { marketStats, type MarketStats } from '@listora/sourcing/market';

import { readMercariSearch } from '../mercari/pages/search-page.ts';
import type { Script } from '../runner/types.ts';
import { COMPARISON_SOLD_WINDOW_DAYS, type ComparisonQuery } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What one Mercari comparison read found. */
export interface MercariComparison {
  readonly stats: MarketStats;
  /** How many listings the whole search has for sale, as Mercari counts them. */
  readonly forSaleTotal: number | null;
  /**
   * Mercari's recent sold pace: how many of the latest sold results read (`stats.read.sold`)
   * sold in the last 30 days; `null` when the page dated none of them.
   */
  readonly soldTotal: number | null;
}

/**
 * How many of the sold listings read sold within Mercari's pace window (30 days) before `now`;
 * `null` when none of them is dated (an undated one counts as not lately: the pace never runs
 * high on what the page did not say).
 */
export function soldLately(
  listings: readonly { readonly sold: boolean; readonly at: Date | null }[],
  now: Date,
): number | null {
  const sold = listings.filter((listing) => listing.sold);
  if (!sold.some((listing) => listing.at !== null)) return null;
  const since = now.getTime() - (COMPARISON_SOLD_WINDOW_DAYS.mercari ?? 30) * DAY_MS;
  return sold.filter((listing) => listing.at !== null && listing.at.getTime() >= since).length;
}

/** Mercari's site for comparison reads: its own origin only. */
export function mercariComparisonSite(siteUrl: string) {
  return { origin: new URL(siteUrl).origin };
}

/** The warm-up: Mercari's home page, loaded once while the seller walks to the bins. */
export function mercariWarmUpScript(siteUrl: string): Script<string> {
  const site = mercariComparisonSite(siteUrl);
  return (step) =>
    step('open Mercari', { mutates: false }, async (page) => {
      await page.goto(`${site.origin}/`);
      return 'warm';
    });
}

/** One comparison read: the item's sold and for-sale searches, matched and counted. */
export function mercariComparisonScript(
  siteUrl: string,
  query: ComparisonQuery,
  now: Date,
): Script<MercariComparison> {
  const site = mercariComparisonSite(siteUrl);
  return async (step) => {
    const sold = await step('search Mercari sold listings', { mutates: false }, (page) =>
      readMercariSearch(page, site, query.words, 'sold'),
    );
    const forSale = await step('search Mercari listings for sale', { mutates: false }, (page) =>
      readMercariSearch(page, site, query.words, 'for_sale'),
    );
    const stats = marketStats(
      [...sold.listings, ...forSale.listings],
      {
        brand: query.brand,
        productTypes: query.productTypes,
        typeWords: query.typeWords,
        model: query.model,
        sizeLabel: query.sizeLabel,
      },
      now,
    );
    return { stats, forSaleTotal: forSale.total, soldTotal: soldLately(sold.listings, now) };
  };
}
