/**
 * The comparison lane (docs/features/thrift-scan.md, "Marketplace comparisons"): what the
 * server asks the iPhone to read of a marketplace's public search for one scanned item, and
 * what the phone answers. The read runs in a web view that holds no session and never signed in,
 * so no seller's account is ever part of it; the phone answers only counts and quartiles, never
 * a listing, a seller, or a photo.
 */
import type { MarketStats } from '@listora/sourcing/market';

import type { PacingSettings } from '../profiles.ts';

/** The marketplaces with a comparison reader. */
export const COMPARISON_MARKETPLACES = ['depop'] as const;
export type ComparisonMarketplace = (typeof COMPARISON_MARKETPLACES)[number];

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

/** What the phone answers: the numbers, or why there are none. */
export type ComparisonOutput =
  | {
      readonly outcome: 'read';
      readonly stats: MarketStats;
      /** How many listings the whole for-sale search has, when the marketplace says. */
      readonly forSaleTotal: number | null;
      readonly ms: number;
    }
  | {
      /** `check`: the marketplace showed a bot check or CAPTCHA, which Listora never passes. */
      readonly outcome: Exclude<ComparisonOutcome, 'read'>;
      /** Safe to log: no page text. */
      readonly message: string;
      readonly ms: number;
    };
