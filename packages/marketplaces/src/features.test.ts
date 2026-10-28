import { afterEach, describe, expect, it } from 'vitest';

import { MARKETPLACES } from '@listora/db';

import {
  FEATURE_REQUIRES,
  featuresOn,
  isFeatureInTesting,
  isFeatureOn,
  isFeatureVerified,
  loadMarketplaceFeatures,
  MARKETPLACE_FEATURES,
  MarketplaceFeaturesConfigError,
  marketplacesWith,
  SELLER_FEATURES,
  useMarketplaceFeatures,
  VERIFIED_FEATURES,
} from './features.ts';

const verifiedFeatures = (marketplace: (typeof MARKETPLACES)[number]) =>
  featuresOn(marketplace, SELLER_FEATURES);

describe('marketplace features (docs/features/verified-features.md)', () => {
  afterEach(() => {
    useMarketplaceFeatures('all');
  });

  it('marks a feature verified only with the live run that proved it', () => {
    for (const marketplace of MARKETPLACES) {
      for (const [feature, evidence] of Object.entries(VERIFIED_FEATURES[marketplace])) {
        expect(MARKETPLACE_FEATURES).toContain(feature);
        expect(evidence.passedOn).toMatch(/^2\d{3}-\d{2}-\d{2}$/);
        expect(evidence.run.length).toBeGreaterThan(20);
      }
    }
  });

  it('holds each list to what a feature needs under it', () => {
    for (const marketplace of MARKETPLACES) {
      for (const [feature, needs] of Object.entries(FEATURE_REQUIRES)) {
        if (Object.hasOwn(VERIFIED_FEATURES[marketplace], feature)) {
          expect(
            Object.hasOwn(VERIFIED_FEATURES[marketplace], needs),
            `${marketplace} ${feature}`,
          ).toBe(true);
        }
      }
    }
  });

  it('hides what has not passed live, and shows every built feature on the fakes', () => {
    useMarketplaceFeatures('verified');
    // Poshmark has no account with offers or sales to test on yet; no answer or refresh ran live.
    expect(verifiedFeatures('poshmark')).toEqual([]);
    expect(verifiedFeatures('ebay')).toEqual([]);
    expect(isFeatureVerified('depop', 'offers')).toBe(true);
    for (const marketplace of MARKETPLACES) {
      expect(isFeatureVerified(marketplace, 'offer_answers')).toBe(false);
      expect(isFeatureVerified(marketplace, 'listing_refresh')).toBe(false);
      // Editing a live listing's details has not run live anywhere.
      expect(isFeatureVerified(marketplace, 'revise')).toBe(false);
    }
    useMarketplaceFeatures('all');
    expect(verifiedFeatures('poshmark')).toEqual([...MARKETPLACE_FEATURES]);
  });

  it('gives an account in Test mode every built feature, tagging the ones not verified', () => {
    useMarketplaceFeatures('verified');
    const testing = { testMode: true };
    expect(featuresOn('poshmark', testing)).toEqual([...MARKETPLACE_FEATURES]);
    expect(isFeatureOn('depop', 'revise', testing)).toBe(true);
    expect(isFeatureOn('depop', 'revise', SELLER_FEATURES)).toBe(false);
    // A verified feature is no test; one on only because of Test mode is.
    expect(isFeatureInTesting('depop', 'offers', testing)).toBe(false);
    expect(isFeatureInTesting('depop', 'offer_answers', testing)).toBe(true);
    expect(isFeatureInTesting('depop', 'offer_answers', SELLER_FEATURES)).toBe(false);
    expect(marketplacesWith('offers', ['depop', 'poshmark'], SELLER_FEATURES)).toEqual(['depop']);
    expect(marketplacesWith('offers', ['depop', 'poshmark'], testing)).toEqual([
      'depop',
      'poshmark',
    ]);
  });

  it('reads MARKETPLACE_FEATURES, verified unless set, and never all beside Cognito', () => {
    expect(loadMarketplaceFeatures({})).toBe('verified');
    expect(loadMarketplaceFeatures({ MARKETPLACE_FEATURES: '' })).toBe('verified');
    expect(loadMarketplaceFeatures({ MARKETPLACE_FEATURES: 'all', AUTH_DRIVER: 'dev' })).toBe(
      'all',
    );
    expect(() => loadMarketplaceFeatures({ MARKETPLACE_FEATURES: 'some' })).toThrow(
      MarketplaceFeaturesConfigError,
    );
    expect(() =>
      loadMarketplaceFeatures({ MARKETPLACE_FEATURES: 'all', AUTH_DRIVER: 'cognito' }),
    ).toThrow(/never with Cognito sign-in/);
    expect(() =>
      loadMarketplaceFeatures({ MARKETPLACE_FEATURES: 'all', COGNITO_USER_POOL_ID: 'us-east-1_x' }),
    ).toThrow(MarketplaceFeaturesConfigError);
  });
});
