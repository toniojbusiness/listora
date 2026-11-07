import { describe, expect, it } from 'vitest';

import {
  OFFER_RULES,
  offerFloorCents,
  SELLER_FEATURES,
  useMarketplaceFeatures,
} from '@listora/marketplaces';

import { offerActions } from '../../offers/answer.ts';
import { offerMarketplaces } from '../../offers/schedule.ts';

import { vintedOfferId, vintedOfferStatus } from './offers.ts';

describe("where a Vinted conversation's newest offer stands", () => {
  it("reads the buyer's pending offer as waiting on the seller, and the seller's as their counter", () => {
    expect(vintedOfferStatus('pending', 'buyer')).toBe('pending');
    expect(vintedOfferStatus('Pending', 'seller')).toBe('countered');
  });

  it("reads an accepted, declined, or ended offer, and the seller's declined counter as over", () => {
    expect(vintedOfferStatus('accepted', 'seller')).toBe('accepted');
    expect(vintedOfferStatus('rejected', 'buyer')).toBe('declined');
    expect(vintedOfferStatus('declined', 'buyer')).toBe('declined');
    expect(vintedOfferStatus('rejected', 'seller')).toBe('over');
    for (const status of ['expired', 'canceled', 'cancelled', 'withdrawn']) {
      expect(vintedOfferStatus(status, 'buyer')).toBe('over');
    }
  });

  it('knows no other status, so a read stops rather than guess', () => {
    expect(vintedOfferStatus('on_hold', 'buyer')).toBeNull();
    expect(vintedOfferStatus('', 'seller')).toBeNull();
  });

  it('names an offer by its conversation and its sale', () => {
    expect(vintedOfferId('9100001', '59100001')).toBe('9100001/59100001');
  });
});

describe("Vinted's offer rules", () => {
  it("are non-binding, with a counter, and a floor 40% below the listing's price", () => {
    expect(OFFER_RULES.vinted).toMatchObject({
      counter: true,
      accept: 'buyer_checkout',
      floorPercent: 60,
    });
    expect(OFFER_RULES.vinted.acceptNote).toContain("aren't binding");
    expect(offerFloorCents('vinted', 5000)).toBe(3000);
    // Rounded up: an offer a cent under 60% is below the floor.
    expect(offerFloorCents('vinted', 1999)).toBe(1200);
    expect(offerFloorCents('vinted', null)).toBeNull();
    expect(offerFloorCents('depop', 5000)).toBeNull();
  });
});

describe("Vinted's offers until they pass live", () => {
  it('are neither read nor answered for a seller, and both in Test mode', () => {
    useMarketplaceFeatures('verified');
    try {
      expect(offerMarketplaces(SELLER_FEATURES)).not.toContain('vinted');
      expect(offerActions('vinted', SELLER_FEATURES)).toEqual([]);
      const testMode = { testMode: true };
      expect(offerMarketplaces(testMode)).toContain('vinted');
      expect(offerActions('vinted', testMode)).toEqual(['accept', 'decline', 'counter']);
      // A read-only account answers none, Test mode or not.
      expect(offerActions('vinted', testMode, true)).toEqual([]);
    } finally {
      useMarketplaceFeatures('all');
    }
  });
});
