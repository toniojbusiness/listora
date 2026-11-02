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
  /**
   * The thrift scan's comparisons from the marketplace's public search, read on the iPhone
   * logged out (docs/features/thrift-scan.md, "Marketplace comparisons").
   */
  'market_comps',
  /**
   * Smart price drops: the seller's rules lower a live listing's price after it went unsold a
   * while, each drop a price change confirmed by a read-back (docs/features/price-drops.md).
   */
  'price_drops',
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
    listing_refresh: {
      passedOn: '2026-10-31',
      run: "A relist refresh on the captain's test shop posted a fresh copy, read it on sale with the same content and refreshed after the send, then deleted the old listing (read back as gone).",
    },
    price_drops: {
      passedOn: '2026-10-31',
      run: "A rule's drop on the captain's test shop showed a day ahead, then the schedule ran it to the rule's floor, confirmed by read-back, and queued no more past the floor or the daily cap.",
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

/** Whether the feature passed live on the marketplace (or this process runs `all`). */
export function isFeatureVerified(marketplace: Marketplace, feature: MarketplaceFeature): boolean {
  return featureSet === 'all' || Object.hasOwn(VERIFIED_FEATURES[marketplace], feature);
}

/**
 * Whose features: what one account is shown and runs. A seller gets the verified features; the
 * deployment owner's account in Test mode (docs/features/test-mode.md) gets every built one, to
 * live-test them. Every gate takes one, loaded with `loadFeatureGate` for the account at hand.
 */
export interface FeatureGate {
  /** The account is in Test mode. */
  readonly testMode: boolean;
}

/** The gate of an account not in Test mode: every customer's. */
export const SELLER_FEATURES: FeatureGate = { testMode: false };

/** Whether the account is shown the feature on the marketplace (and its checks run). */
export function isFeatureOn(
  marketplace: Marketplace,
  feature: MarketplaceFeature,
  gate: FeatureGate,
): boolean {
  return gate.testMode || isFeatureVerified(marketplace, feature);
}

/** Whether the feature is on only because of Test mode: the app tags it "Testing". */
export function isFeatureInTesting(
  marketplace: Marketplace,
  feature: MarketplaceFeature,
  gate: FeatureGate,
): boolean {
  return gate.testMode && !isFeatureVerified(marketplace, feature);
}

/** The marketplace's features on for the account, in `MARKETPLACE_FEATURES` order. */
export function featuresOn(marketplace: Marketplace, gate: FeatureGate): MarketplaceFeature[] {
  return MARKETPLACE_FEATURES.filter((feature) => isFeatureOn(marketplace, feature, gate));
}

/** The marketplaces of `among` whose `feature` is on for the account. */
export function marketplacesWith<M extends Marketplace>(
  feature: MarketplaceFeature,
  among: readonly M[],
  gate: FeatureGate,
): M[] {
  return among.filter((marketplace) => isFeatureOn(marketplace, feature, gate));
}

/**
 * Customer features of Listora itself rather than of one marketplace, held to the same rule:
 * hidden until a live end-to-end test passes, except in the owner's Test mode.
 */
export const APP_FEATURES = [
  /** The thrift scan at the store: one shot, the AI's read, and the Buy / Your call / Skip call. */
  'thrift_scan',
] as const;
export type AppFeature = (typeof APP_FEATURES)[number];

/** The app features that passed live, with the run that proved each. */
export const VERIFIED_APP_FEATURES: Partial<Readonly<Record<AppFeature, FeatureEvidence>>> = {};

/** Whether the app feature passed live (or this process runs `all`). */
export function isAppFeatureVerified(feature: AppFeature): boolean {
  return featureSet === 'all' || Object.hasOwn(VERIFIED_APP_FEATURES, feature);
}

/** Whether the account is shown the app feature: it passed live, or the account is in Test mode. */
export function isAppFeatureOn(feature: AppFeature, gate: FeatureGate): boolean {
  return gate.testMode || isAppFeatureVerified(feature);
}

/** The app features on for the account, in `APP_FEATURES` order. */
export function appFeaturesOn(gate: FeatureGate): AppFeature[] {
  return APP_FEATURES.filter((feature) => isAppFeatureOn(feature, gate));
}

/** Whether the app feature is on only because of Test mode: the app tags it "Testing". */
export function isAppFeatureInTesting(feature: AppFeature, gate: FeatureGate): boolean {
  return gate.testMode && !isAppFeatureVerified(feature);
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
