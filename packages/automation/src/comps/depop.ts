/**
 * Depop's comparison reader (docs/features/thrift-scan.md, "Marketplace comparisons"): the
 * item's public search on Depop, read from a warm search page that holds no session, matched to
 * the item and reduced to counts and quartiles (`marketStats`). Nothing in it signs in, likes,
 * saves, or follows anything: it only reads what any visitor's browser reads.
 */
import { marketStats, type MarketStats } from '@listora/sourcing/market';

import { depopSearchPageUrl, readDepopSearch } from '../depop/pages/search.ts';
import { depopSite } from '../depop/site.ts';
import type { Script } from '../runner/types.ts';
import type { ComparisonQuery } from './types.ts';

/** What one Depop comparison read found. */
export interface DepopComparison {
  readonly stats: MarketStats;
  /** How many listings the whole search has for sale, as Depop counts them. */
  readonly forSaleTotal: number | null;
}

/** Depop's site for comparison reads: its own origin only, whose same-origin API it reads. */
export function depopComparisonSite(siteUrl: string) {
  const site = depopSite(siteUrl);
  // The search page reads its results from its own origin, not from webapi.depop.com.
  return { ...site, api: site.origin };
}

/** The warm-up: the public search page, loaded once while the seller walks to the bins. */
export function depopWarmUpScript(siteUrl: string): Script<string> {
  const site = depopComparisonSite(siteUrl);
  return (step) =>
    step('open the search', { mutates: false }, async (page) => {
      await page.goto(depopSearchPageUrl(site));
      return 'warm';
    });
}

/** One comparison read: the item's search, matched and counted. */
export function depopComparisonScript(
  siteUrl: string,
  query: ComparisonQuery,
  now: Date,
): Script<DepopComparison> {
  const site = depopComparisonSite(siteUrl);
  return async (step) => {
    const found = await step('search Depop', { mutates: false }, (page) =>
      readDepopSearch(page, site, query.words),
    );
    const stats = marketStats(
      found.listings,
      {
        brand: query.brand,
        productTypes: query.productTypes,
        typeWords: query.typeWords,
        model: query.model,
        sizeLabel: query.sizeLabel,
      },
      now,
    );
    return { stats, forSaleTotal: found.total };
  };
}
