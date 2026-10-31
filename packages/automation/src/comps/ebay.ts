/**
 * eBay's comparison reader (docs/features/thrift-scan.md, "eBay"): the item's public search on
 * eBay, read in a web view that holds no session, twice: its sold listings (eBay shows a visitor
 * those of about the last 90 days), the most recently sold first, and its listings for sale now.
 * Both are matched to the item (the brand and the type in the title, then the model and the
 * size) and reduced to counts and quartiles (`marketStats`), with each search's own count of
 * results. Nothing in it signs in, watches, bids, or buys anything: it only loads the results
 * pages any visitor's browser loads.
 */
import { marketStats, type MarketStats } from '@listora/sourcing/market';

import { readEbaySearch } from '../ebay/pages/search-page.ts';
import type { Script } from '../runner/types.ts';
import type { ComparisonQuery } from './types.ts';

/** What one eBay comparison read found. */
export interface EbayComparison {
  readonly stats: MarketStats;
  /** How many listings the whole search has for sale, and has sold, as eBay counts them. */
  readonly forSaleTotal: number | null;
  readonly soldTotal: number | null;
}

/** eBay's site for comparison reads: its own origin only. */
export function ebayComparisonSite(siteUrl: string) {
  return { origin: new URL(siteUrl).origin };
}

/** The warm-up: eBay's home page, loaded once while the seller walks to the bins. */
export function ebayWarmUpScript(siteUrl: string): Script<string> {
  const site = ebayComparisonSite(siteUrl);
  return (step) =>
    step('open eBay', { mutates: false }, async (page) => {
      await page.goto(`${site.origin}/`);
      return 'warm';
    });
}

/** One comparison read: the item's sold and for-sale searches, matched and counted. */
export function ebayComparisonScript(
  siteUrl: string,
  query: ComparisonQuery,
  now: Date,
): Script<EbayComparison> {
  const site = ebayComparisonSite(siteUrl);
  return async (step) => {
    const sold = await step('search eBay sold listings', { mutates: false }, (page) =>
      readEbaySearch(page, site, query.words, 'sold'),
    );
    const forSale = await step('search eBay listings for sale', { mutates: false }, (page) =>
      readEbaySearch(page, site, query.words, 'for_sale'),
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
    return { stats, forSaleTotal: forSale.total, soldTotal: sold.total };
  };
}
