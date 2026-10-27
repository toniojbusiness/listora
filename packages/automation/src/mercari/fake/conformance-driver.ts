/**
 * Drives the fake Mercari site for the shared adapter conformance suite (test-only): each
 * failure the suite asks for becomes the page Mercari would show.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakeMercariAction, FakeMercariSite } from './fake-mercari.ts';

/**
 * The step timeout of adapters under test. List, the longest step, gets three times it, and a
 * `timeout_after_send` answer comes after that, soon enough for the check to finish within a
 * test's time (a host may hold the page until the answer comes).
 */
export const MERCARI_STEP_TIMEOUT_MS = 3_000;
const LATE_ANSWER_MS = 4 * MERCARI_STEP_TIMEOUT_MS;

/** A read by SKU looks at the newest listings first, so a failing read fails whichever opens first. */
const SITE_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['end'],
  relist: ['relist'],
  mark_sold: [],
  read: ['listings', 'read'],
  health: ['health'],
} as const satisfies Record<ConformanceAction, readonly FakeMercariAction[]>;

export function fakeMercariConformance(site: FakeMercariSite): ConformanceMarketplace {
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
    countListings: (listing) => site.itemsWithSku(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
