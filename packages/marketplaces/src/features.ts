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
  // Vinted is assisted only; each automation feature joins here once it passes live
  // (docs/features/vinted.md).
  vinted: {},
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
 * Linking by signing in (Link accounts, docs/features/marketplace-linking.md) is not on the
 * feature list yet: it shows for every marketplace browser automation serves, except on these
 * marketplaces, which join automation in milestones and whose linking has not passed a live
 * link yet. Each is linked only in Test mode, the way its live link is run
 * (docs/features/test-mode.md), and leaves this list in the change that records that run.
 * Vinted: linking, the session check, and the member read are built (Vinted plan M3), and their
 * live test is the captain's link of the Vinted test account on the iPhone.
 */
export const LINKING_NOT_VERIFIED: readonly Marketplace[] = ['vinted'];

/** Whether linking the marketplace passed live (or this process runs `all`). */
export function isLinkingVerified(marketplace: Marketplace): boolean {
  return featureSet === 'all' || !LINKING_NOT_VERIFIED.includes(marketplace);
}

/** Whether the account may link the marketplace by signing in: it passed live, or Test mode. */
export function isLinkingOn(marketplace: Marketplace, gate: FeatureGate): boolean {
  return gate.testMode || isLinkingVerified(marketplace);
}

/**
 * Listing steps done by browser automation (publishing, price changes, delisting, relisting:
 * docs/features/automation.md) are not on the feature list either: they passed live on every
 * marketplace automation serves, except on these, which join automation in milestones. Here a
 * linked session's listing steps stay the seller's assisted tasks, and are automated only for an
 * account in Test mode, the way their live test is run (docs/features/test-mode.md); the
 * marketplace leaves this list in the change that records that run. Vinted: create, price, hide,
 * and unhide are built (Vinted plan M5), and their live test is on the captain's Vinted test
 * account (docs/features/vinted.md).
 */
export const LISTING_AUTOMATION_NOT_VERIFIED: readonly Marketplace[] = ['vinted'];

/** Whether the marketplace's automated listing steps passed live (or this process runs `all`). */
export function isListingAutomationVerified(marketplace: Marketplace): boolean {
  return featureSet === 'all' || !LISTING_AUTOMATION_NOT_VERIFIED.includes(marketplace);
}

/**
 * Whether the account's listing steps on the marketplace may be automated on a linked session:
 * they passed live, or the account is in Test mode. Otherwise they stay assisted.
 */
export function isListingAutomationOn(marketplace: Marketplace, gate: FeatureGate): boolean {
  return gate.testMode || isListingAutomationVerified(marketplace);
}

/**
 * Pack check's label reads (docs/features/pack-check.md, "Reading labels") are not on the
 * feature list either: they run for every marketplace that reads its order labels while Pack
 * check is on, except on these, which join in milestones and whose label read has not passed a
 * live test yet. Here an order's label is read only for an account in Test mode, the way its live
 * test is run (docs/features/test-mode.md); otherwise the seller scans the label, as on a
 * marketplace Listora doesn't read. The marketplace leaves this list in the change that records
 * that run. Vinted: the label read is built (Vinted plan M8), and its live test is a label of a
 * sale on the captain's Vinted test account (docs/features/vinted.md).
 */
export const LABEL_READS_NOT_VERIFIED: readonly Marketplace[] = ['vinted'];

/** Whether the marketplace's label read passed live (or this process runs `all`). */
export function isLabelReadVerified(marketplace: Marketplace): boolean {
  return featureSet === 'all' || !LABEL_READS_NOT_VERIFIED.includes(marketplace);
}

/** Whether the account's orders on the marketplace have their labels read: live, or Test mode. */
export function isLabelReadOn(marketplace: Marketplace, gate: FeatureGate): boolean {
  return gate.testMode || isLabelReadVerified(marketplace);
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
