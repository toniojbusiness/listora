/**
 * Drives the fake site for the shared adapter conformance suite (test-only): each failure the
 * suite asks for becomes the page a real marketplace would show.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakeAutomationSite, FakeSiteAction } from './fake-site.ts';

/** The step timeout of adapters under test; a `timeout_after_send` answer comes far later. */
export const CONFORMANCE_STEP_TIMEOUT_MS = 4_000;
const LATE_ANSWER_MS = 5 * CONFORMANCE_STEP_TIMEOUT_MS;

/** A read by SKU searches first, so a failing read fails whichever page it opens first. */
const SITE_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['end'],
  relist: ['relist'],
  mark_sold: [],
  read: ['search', 'read'],
  health: ['health'],
} as const satisfies Record<ConformanceAction, readonly FakeSiteAction[]>;

export function fakeSiteConformance(site: FakeAutomationSite): ConformanceMarketplace {
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
    remove(externalListingId) {
      site.remove(externalListingId);
    },
    countListings: (listing) => site.listings(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
