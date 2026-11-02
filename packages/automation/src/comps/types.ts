/**
 * The comparison lane (docs/features/thrift-scan.md, "Marketplace comparisons"): what the
 * server asks the iPhone to read of a marketplace's public search for one scanned item, and
 * what the phone answers. The read runs in a web view that holds no session and never signed in,
 * so no seller's account is ever part of it; the phone answers only counts and quartiles, never
 * a listing, a seller, or a photo.
 */
import type { MarketMatchLevel, MarketStats } from '@listora/sourcing/market';

import type { PacingSettings } from '../profiles.ts';

/** The marketplaces with a comparison reader, in the order the card shows them. */
export const COMPARISON_MARKETPLACES = ['depop', 'ebay', 'mercari'] as const;
export type ComparisonMarketplace = (typeof COMPARISON_MARKETPLACES)[number];

/**
 * Where a marketplace shows a visitor sold listings at all (Depop shows none), the window its
 * count of sold listings (`soldTotal`) covers: eBay's whole sold search, its last 90 days; and
 * Mercari's latest sold results read, those that sold in the last 30 days (Mercari's sold search
 * reaches back much further and gives no count of a window, so its pace is how many of the
 * latest sold sold lately, out of `stats.read.sold`).
 */
export const COMPARISON_SOLD_WINDOW_DAYS: Readonly<Partial<Record<ComparisonMarketplace, number>>> =
  { ebay: 90, mercari: 30 };

/** The version of `ComparisonInput` and `ComparisonOutput`; change it with either. */
export const COMPARISON_VERSION = 1;

/** The scanned item, as a comparison read searches and matches it. */
export interface ComparisonQuery {
  /** What is typed into the marketplace's search: the brand, the type, the model. */
  readonly words: string;
  readonly brand: string;
  /** The exact model or line, when the scan read one. */
  readonly model: string | null;
  readonly sizeLabel: string | null;
  /** The marketplace's own product types the item may be. */
  readonly productTypes: readonly string[];
  /** Words its type goes by, for a listing that names no product type. */
  readonly typeWords: readonly string[];
}

/** One comparison read, as the server hands it to the phone. */
export interface ComparisonInput {
  readonly version: number;
  readonly marketplace: ComparisonMarketplace;
  readonly query: ComparisonQuery;
  readonly pacing: PacingSettings;
  readonly stepTimeoutMs: number;
  readonly callTimeoutMs: number;
  /** The server's time, for how long ago listings sold (ISO). */
  readonly now: string;
}

/** How a read ended. */
export const COMPARISON_OUTCOMES = ['read', 'check', 'rate_limited', 'failed'] as const;
export type ComparisonOutcome = (typeof COMPARISON_OUTCOMES)[number];

/**
 * A read's numbers as the phone sends them: `MarketStats`, its level absent (not `null`) when
 * nothing matched, and its sold window absent when the marketplace dated none (Mercari's page
 * without its data), as the API's answer has them.
 */
export type ComparisonStats = Omit<MarketStats, 'level' | 'sold'> & {
  readonly level?: MarketMatchLevel;
  readonly sold?: Omit<NonNullable<MarketStats['sold']>, 'windowDays'> & {
    readonly windowDays?: number;
  };
};

/** `MarketStats` as the phone sends them. */
export function comparisonStats(stats: MarketStats): ComparisonStats {
  const { level, sold, ...rest } = stats;
  const sent: ComparisonStats = sold === undefined ? rest : { ...rest, sold: soldSent(sold) };
  return level === null ? sent : { ...sent, level };
}

function soldSent({
  windowDays,
  ...prices
}: NonNullable<MarketStats['sold']>): NonNullable<ComparisonStats['sold']> {
  return windowDays === null ? prices : { ...prices, windowDays };
}

/** What the phone answers: the numbers, or why there are none. */
export type ComparisonOutput =
  | {
      readonly outcome: 'read';
      readonly stats: ComparisonStats;
      /** How many listings the whole for-sale search has, when the marketplace says. */
      readonly forSaleTotal: number | null;
      /**
       * Sold listings in the marketplace's sold window (`COMPARISON_SOLD_WINDOW_DAYS`), where it
       * shows a visitor sold ones: eBay's whole sold search over its 90 days, Mercari's latest
       * sold read that sold in the last 30 days; absent where it shows none (Depop).
       */
      readonly soldTotal?: number | null;
      readonly ms: number;
    }
  | {
      /** `check`: the marketplace showed a bot check or CAPTCHA, which Listora never passes. */
      readonly outcome: Exclude<ComparisonOutcome, 'read'>;
      /** Safe to log: no page text. */
      readonly message: string;
      readonly ms: number;
    };
