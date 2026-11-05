/**
 * Vinted's comparison reader (docs/features/thrift-scan.md, "Vinted"): the item's public search
 * on Vinted, read in a web view that holds no session, one page load. Vinted shows a visitor no
 * sold listings, so the read is of close matches' asking prices, as Depop's: matched to the item
 * (the brand Vinted names, else the title's words, and the type in the title, then the model and
 * the size) and reduced to counts and quartiles (`marketStats`), with the search's own count.
 * Nothing in it signs in, favourites, offers, or buys anything: it only loads the search page any
 * visitor's browser loads.
 */
import { marketStats, type MarketStats } from '@listora/sourcing/market';

import type { Script } from '../runner/types.ts';
import { readVintedSearch } from '../vinted/pages/search-page.ts';
import type { ComparisonQuery } from './types.ts';

/** What one Vinted comparison read found. */
export interface VintedComparison {
  readonly stats: MarketStats;
  /** How many listings the whole search has for sale, as Vinted counts them ("500+" is 500). */
  readonly forSaleTotal: number | null;
}

/** Vinted's site for comparison reads: its own origin only. */
export function vintedComparisonSite(siteUrl: string) {
  return { origin: new URL(siteUrl).origin };
}

/** The warm-up: Vinted's home page, loaded once while the seller walks to the bins. */
export function vintedWarmUpScript(siteUrl: string): Script<string> {
  const site = vintedComparisonSite(siteUrl);
  return (step) =>
    step('open Vinted', { mutates: false }, async (page) => {
      await page.goto(`${site.origin}/`);
      return 'warm';
    });
}

/** One comparison read: the item's search, matched and counted. */
export function vintedComparisonScript(
  siteUrl: string,
  query: ComparisonQuery,
  now: Date,
): Script<VintedComparison> {
  const site = vintedComparisonSite(siteUrl);
  return async (step) => {
    const found = await step('search Vinted', { mutates: false }, (page) =>
      readVintedSearch(page, site, query.words),
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
