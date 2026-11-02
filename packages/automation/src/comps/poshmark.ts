/**
 * Poshmark's comparison reader (docs/features/thrift-scan.md, "Poshmark"): the item's public
 * search on Poshmark, read in a web view that holds no session, twice: its sold listings (the
 * search's own "Sold items" filter), each dated by the day it sold, and its listings for sale
 * now. Both are matched to the item (its brand, and Poshmark's department and category for its
 * type, then the model in the title and the size) and reduced to counts and quartiles
 * (`marketStats`). Only listings sold in the last `COMPARISON_SOLD_WINDOW_DAYS.poshmark` days
 * are counted: an older sale says little of today's price. Nothing in it signs in, likes,
 * shares, follows, or offers anything: it only loads the results pages any visitor's browser
 * loads.
 */
import { marketStats, type MarketListing, type MarketStats } from '@listora/sourcing/market';

import { readPoshmarkSearch } from '../poshmark/pages/search-page.ts';
import { PoshmarkSite } from '../poshmark/site.ts';
import type { Script } from '../runner/types.ts';
import { COMPARISON_SOLD_WINDOW_DAYS, type ComparisonQuery } from './types.ts';

/** What one Poshmark comparison read found. */
export interface PoshmarkComparison {
  readonly stats: MarketStats;
  /** How many listings the whole search has for sale, as Poshmark counts them. */
  readonly forSaleTotal: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The warm-up: Poshmark's home page, loaded once while the seller walks to the bins. */
export function poshmarkWarmUpScript(siteUrl: string): Script<string> {
  const site = new PoshmarkSite(siteUrl);
  return (step) =>
    step('open Poshmark', { mutates: false }, async (page) => {
      await page.goto(`${site.origin}/`);
      return 'warm';
    });
}

/** One comparison read: the item's sold and for-sale searches, matched and counted. */
export function poshmarkComparisonScript(
  siteUrl: string,
  query: ComparisonQuery,
  now: Date,
): Script<PoshmarkComparison> {
  const site = new PoshmarkSite(siteUrl);
  return async (step) => {
    const sold = await step('search Poshmark sold listings', { mutates: false }, (page) =>
      readPoshmarkSearch(page, site, query.words, 'sold'),
    );
    const forSale = await step('search Poshmark listings for sale', { mutates: false }, (page) =>
      readPoshmarkSearch(page, site, query.words, 'for_sale'),
    );
    const stats = marketStats(
      [...recentlySold(sold.listings, now), ...forSale.listings],
      {
        brand: query.brand,
        productTypes: query.productTypes,
        typeWords: query.typeWords,
        model: query.model,
        sizeLabel: query.sizeLabel,
      },
      now,
    );
    return { stats, forSaleTotal: forSale.total };
  };
}

/** The sold listings of the sold window (`COMPARISON_SOLD_WINDOW_DAYS.poshmark`). */
export function recentlySold(listings: readonly MarketListing[], now: Date): MarketListing[] {
  const days = COMPARISON_SOLD_WINDOW_DAYS.poshmark ?? 0;
  const since = now.getTime() - days * DAY_MS;
  return listings.filter((listing) => listing.at !== null && listing.at.getTime() >= since);
}
