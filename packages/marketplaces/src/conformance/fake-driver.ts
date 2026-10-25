/**
 * Drives the fake marketplace for the conformance suite (test-only). Adapters with their own
 * fake (fake-ebay, fake-depop) bring their own driver.
 */
import type { Marketplace } from '@listora/db';

import type { FakeFault, FakeMarketplace } from '../fake/fake-marketplace.ts';
import type { ConformanceMarketplace } from './suite.ts';

/**
 * The request timeout of adapters under test: long enough that a loaded machine running every
 * test at once never times out a normal answer, short enough to keep timeout checks quick.
 */
export const CONFORMANCE_TIMEOUT_MS = 1_000;

/** When a `timeout_after_send` answer finally comes: well after the adapter gave up. */
const LATE_ANSWER_MS = 5 * CONFORMANCE_TIMEOUT_MS;

export function fakeConformanceMarketplace(
  fake: FakeMarketplace,
  marketplace: Marketplace,
): ConformanceMarketplace {
  return {
    failNext(action, failure) {
      const fault: FakeFault =
        failure.type === 'timeout_after_send'
          ? { type: 'timeout_after_send', delayMs: LATE_ANSWER_MS }
          : failure;
      fake.inject({ marketplace, action, fault });
    },
    serveStaleRead() {
      fake.inject({ marketplace, action: 'read', fault: { type: 'stale_read' } });
    },
    remove(externalListingId) {
      fake.remove(marketplace, externalListingId);
    },
    countListings: (listing) =>
      fake.listings(marketplace, listing.externalSku ?? listing.listingId).length,
    reset() {
      fake.clearFaults();
    },
  };
}
