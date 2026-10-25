/**
 * Drives the fake Poshmark for the shared adapter conformance suite (test-only): each failure the
 * suite asks for becomes the page Poshmark would show. Poshmark never says a listing is gone for
 * good (Listora has not seen its answer for a deleted listing), so there is no `remove`, and the
 * suite checks that no absence is authoritative.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakePoshmark, FakePoshmarkAction, FakePoshmarkFault } from './fake-poshmark.ts';

/** The step timeout of adapters under test; a `timeout_after_send` answer comes far later. */
export const CONFORMANCE_STEP_TIMEOUT_MS = 4_000;
const LATE_ANSWER_MS = 5 * CONFORMANCE_STEP_TIMEOUT_MS;

/**
 * The pages each action opens. A read by SKU opens the listing form first (to learn the
 * seller), so a failing read fails whichever page it opens first; a health check opens the form.
 */
const POSHMARK_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['update'],
  relist: ['update'],
  mark_sold: [],
  read: ['new_form', 'closet', 'listing'],
  health: ['new_form'],
} as const satisfies Record<ConformanceAction, readonly FakePoshmarkAction[]>;

export function fakePoshmarkConformance(site: FakePoshmark): ConformanceMarketplace {
  return {
    failNext(action, failure) {
      const fault: FakePoshmarkFault = (() => {
        switch (failure.type) {
          case 'rate_limited':
            return {
              type: 'rate_limited',
              ...(failure.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: failure.retryAfterSeconds }),
            };
          case 'server_error':
            return { type: 'server_error', afterApply: failure.afterApply };
          case 'reject':
            return { type: 'reject', message: failure.message };
          case 'unauthorized':
            return { type: 'session_expired' };
          case 'timeout_after_send':
            return { type: 'slow', delayMs: LATE_ANSWER_MS, afterApply: true };
        }
      })();
      for (const siteAction of POSHMARK_ACTIONS[action]) site.inject({ action: siteAction, fault });
    },
    serveStaleRead() {
      site.inject({ action: 'listing', fault: { type: 'stale_read' } });
    },
    countListings: (listing) => site.listings(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
