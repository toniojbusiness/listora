/**
 * Drives the fake Depop site for the shared adapter conformance suite (test-only): each failure
 * the suite asks for becomes the page Depop would show. A product Depop deleted for good answers
 * 410 Gone, which is definitive (product-page.ts), so `remove` makes the fake answer that.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakeDepopSite, FakeDepopSiteAction } from './fake-depop-site.ts';

/** The step timeout of adapters under test. */
export const DEPOP_STEP_TIMEOUT_MS = 4_000;
/**
 * When a `timeout_after_send` answer comes: well after the post step gave up (it has twice the
 * step timeout), and soon enough for a phone run to end within the suite's test time. The
 * phone's test host can't evaluate anything in a page whose form submission is still loading,
 * so its run ends only once the answer comes.
 */
const LATE_ANSWER_MS = 3 * DEPOP_STEP_TIMEOUT_MS;

/**
 * A relist posts a new listing, so it fails where a create does. A read by slug opens the
 * product's page, then reads the seller's own product from the API; a read by SKU opens the
 * selling hub, then reads the seller's listings from the API. So a failing read fails whichever
 * comes first.
 */
const SITE_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['delete'],
  relist: ['create'],
  mark_sold: [],
  read: ['health', 'listings', 'read'],
  health: ['health'],
} as const satisfies Record<ConformanceAction, readonly FakeDepopSiteAction[]>;

export function fakeDepopSiteConformance(site: FakeDepopSite): ConformanceMarketplace {
  return {
    failNext(action, failure) {
      for (const siteAction of SITE_ACTIONS[action]) {
        switch (failure.type) {
          case 'rate_limited':
            site.inject({
              action: siteAction,
              fault: {
                type: 'rate_limited',
                ...(failure.retryAfterSeconds === undefined
                  ? {}
                  : { retryAfterSeconds: failure.retryAfterSeconds }),
              },
            });
            break;
          case 'server_error':
            site.inject({
              action: siteAction,
              fault: { type: 'server_error', afterApply: failure.afterApply },
            });
            break;
          case 'reject':
            site.inject({
              action: siteAction,
              fault: { type: 'reject', message: failure.message },
            });
            break;
          case 'unauthorized':
            site.inject({ action: siteAction, fault: { type: 'session_expired' } });
            break;
          case 'timeout_after_send':
            site.inject({
              action: siteAction,
              fault: { type: 'slow', delayMs: LATE_ANSWER_MS, afterApply: true },
            });
            break;
        }
      }
    },
    serveStaleRead() {
      // The product's page, then the API's read of it: both as before the latest change.
      site.inject({ action: 'read', fault: { type: 'stale_read' }, times: 2 });
    },
    remove(externalListingId) {
      site.gone(externalListingId);
    },
    countListings: (listing) =>
      site.productsWithSku(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
