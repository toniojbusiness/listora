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
export const COMPARISON_MARKETPLACES = ['depop', 'ebay'] as const;
export type ComparisonMarketplace = (typeof COMPARISON_MARKETPLACES)[number];

/**
 * How many days back a marketplace's sold search reaches, where it shows a visitor sold
 * listings at all (eBay's last 90 days; Depop shows none): the window its count of sold
 * listings (`soldTotal`) covers.
 */
export const COMPARISON_SOLD_WINDOW_DAYS: Readonly<Partial<Record<ComparisonMarketplace, number>>> =
  { ebay: 90 };

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
 * nothing matched, as the API's answer has it.
 */
export type ComparisonStats = Omit<MarketStats, 'level'> & { readonly level?: MarketMatchLevel };

/** `MarketStats` as the phone sends them. */
export function comparisonStats(stats: MarketStats): ComparisonStats {
  const { level, ...rest } = stats;
  return level === null ? rest : { ...rest, level };
}

/** What the phone answers: the numbers, or why there are none. */
export type ComparisonOutput =
  | {
      readonly outcome: 'read';
      readonly stats: ComparisonStats;
      /** How many listings the whole for-sale search has, when the marketplace says. */
      readonly forSaleTotal: number | null;
      /**
       * How many listings the whole sold search has, where the marketplace shows a visitor sold
       * ones and counts them (eBay's last 90 days); absent where it shows none (Depop).
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
