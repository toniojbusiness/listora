/**
 * Drives the fake Depop site for the shared adapter conformance suite (test-only): each failure
 * the suite asks for becomes the page Depop would show. Depop keeps a deleted product readable
 * as deleted and never says a product is gone for good, so the driver offers no `remove`: the
 * suite then checks that no absence is authoritative.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakeDepopSite, FakeDepopSiteAction } from './fake-depop-site.ts';

/** The step timeout of adapters under test; a `timeout_after_send` answer comes far later. */
export const DEPOP_STEP_TIMEOUT_MS = 4_000;
const LATE_ANSWER_MS = 5 * DEPOP_STEP_TIMEOUT_MS;

/**
 * A relist posts a new listing, so it fails where a create does. A read by SKU looks at the
 * newest listings first, so a failing read fails whichever opens first.
 */
const SITE_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['delete'],
  relist: ['create'],
  mark_sold: [],
  read: ['listings', 'read'],
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
      site.inject({ action: 'read', fault: { type: 'stale_read' } });
    },
    countListings: (listing) =>
      site.productsWithSku(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
