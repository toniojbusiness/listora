/**
 * What the seller is shown of each marketplace (docs/features/verified-features.md): one list
 * of the customer features per marketplace, each marked verified only once it passed a live
 * end-to-end test on a real account. Everything not in it is hidden: the app shows no screen,
 * row, button, empty state, or error for it, and the server queues none of its checks. A
 * failing read of a verified feature goes to the owner's alerts and the admin view
 * (docs/features/read-health.md), never to the seller as an error.
 *
 * Mark a feature verified here only with the live run that proved it (its date and what it
 * read or did), in the same change as the doc's evidence table.
 */
import type { Marketplace } from '@listora/db';

export const MARKETPLACE_FEATURES = [
  /** The seller's past sales, read from the marketplace's sold pages (a sale check's first read). */
  'sales_history',
  /** New sales found by reading the marketplace (each one starts its delists elsewhere). */
  'sale_checks',
  /** The buyers' offers waiting on the seller, read into Tasks. */
  'offers',
  /** Accepting, declining, or countering an offer from Listora. */
  'offer_answers',
  /** Importing the seller's existing listings as items. */
  'listing_import',
  /** Refreshing live listings on a schedule. */
  'listing_refresh',
  /** Editing a live listing's details (title, description, aspects) from Listora. */
  'revise',
] as const;
export type MarketplaceFeature = (typeof MARKETPLACE_FEATURES)[number];

/**
 * A feature that only works on top of another: a sale check's first read is the sold history,
 * and an offer is answered from its read. The registry's test holds every list to these.
 */
export const FEATURE_REQUIRES: Readonly<Partial<Record<MarketplaceFeature, MarketplaceFeature>>> = {
  sale_checks: 'sales_history',
  offer_answers: 'offers',
};

/** The live end-to-end run that proved a feature on a marketplace. */
export interface FeatureEvidence {
  /** The day it passed, `YYYY-MM-DD`. */
  passedOn: string;
  /** What the run read or did, without any seller's data. */
  run: string;
}

type VerifiedFeatures = Readonly<
  Record<Marketplace, Partial<Readonly<Record<MarketplaceFeature, FeatureEvidence>>>>
>;

/** Each marketplace's verified features. A feature absent from a marketplace's list is hidden. */
export const VERIFIED_FEATURES: VerifiedFeatures = {
  ebay: {},
  depop: {
    sales_history: {
      passedOn: '2026-10-28',
      run: "The new sale check read every sale on a real shop's receipts, refund left out, totals matching to the cent.",
    },
    sale_checks: {
      passedOn: '2026-10-28',
      run: "A sync's sale check on the iPhone found a new sale on a real shop (detection by the check, not the history).",
    },
    offers: {
      passedOn: '2026-10-28',
      run: 'An offer read on the iPhone succeeded on a real shop and made the one waiting buyer offer a task.',
    },
    listing_import: {
      passedOn: '2026-10-28',
      run: 'An import read every listing of a real 118-listing shop and imported them all, none failed.',
    },
  },
  poshmark: {},
  mercari: {
    sales_history: {
      passedOn: '2026-10-27',
      run: "The sale check read the captain's one real sale correctly, with its listing.",
    },
    sale_checks: {
      passedOn: '2026-10-28',
      run: "Sale checks on the iPhone's mobile layout read the real sold page and succeed since that day's fix.",
    },
    listing_import: {
      passedOn: '2026-10-27',
      run: "An import read all 11 of the captain's listings for sale.",
    },
  },
};

/**
 * `verified`: only what passed live (every deployment). `all`: every feature Listora built,
 * for the local stacks and tests that run on the fake marketplaces (MARKETPLACE_FEATURES).
 */
export const MARKETPLACE_FEATURE_SETS = ['verified', 'all'] as const;
export type MarketplaceFeatureSet = (typeof MARKETPLACE_FEATURE_SETS)[number];

let featureSet: MarketplaceFeatureSet = 'verified';

/**
 * Picks the features this process shows and runs, once at startup (the API, the worker, the
 * runner). Tests on the fakes use `all`; a test of the gate itself sets `verified` again.
 */
export function useMarketplaceFeatures(set: MarketplaceFeatureSet): void {
  featureSet = set;
}

/** Whether the seller is shown the feature on the marketplace (and its checks run). */
export function isFeatureVerified(marketplace: Marketplace, feature: MarketplaceFeature): boolean {
  return featureSet === 'all' || Object.hasOwn(VERIFIED_FEATURES[marketplace], feature);
}

/** The marketplace's verified features, in `MARKETPLACE_FEATURES` order. */
export function verifiedFeatures(marketplace: Marketplace): MarketplaceFeature[] {
  return MARKETPLACE_FEATURES.filter((feature) => isFeatureVerified(marketplace, feature));
}

/** The marketplaces of `among` whose `feature` is verified. */
export function marketplacesWith<M extends Marketplace>(
  feature: MarketplaceFeature,
  among: readonly M[],
): M[] {
  return among.filter((marketplace) => isFeatureVerified(marketplace, feature));
}

export class MarketplaceFeaturesConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid marketplace features configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'MarketplaceFeaturesConfigError';
    this.issues = issues;
  }
}

/**
 * MARKETPLACE_FEATURES from the environment (`verified` when unset). `all` is refused beside
 * Cognito sign-in (AUTH_DRIVER=cognito, or the worker's COGNITO_USER_POOL_ID), which only real
 * deployments use: real sellers only ever see what passed live.
 */
export function loadMarketplaceFeatures(
  env: NodeJS.ProcessEnv = process.env,
): MarketplaceFeatureSet {
  const value = env['MARKETPLACE_FEATURES'] ?? '';
  if (value === '') return 'verified';
  if (!(MARKETPLACE_FEATURE_SETS as readonly string[]).includes(value)) {
    throw new MarketplaceFeaturesConfigError([
      `MARKETPLACE_FEATURES must be one of ${MARKETPLACE_FEATURE_SETS.join(', ')}`,
    ]);
  }
  const cognito = env['AUTH_DRIVER'] === 'cognito' || (env['COGNITO_USER_POOL_ID'] ?? '') !== '';
  if (value === 'all' && cognito) {
    throw new MarketplaceFeaturesConfigError([
      'MARKETPLACE_FEATURES=all is only for the fake marketplaces, never with Cognito sign-in',
    ]);
  }
  return value as MarketplaceFeatureSet;
}
