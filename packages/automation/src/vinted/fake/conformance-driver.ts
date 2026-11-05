/**
 * Drives the fake Vinted site for the shared adapter conformance suite (test-only): each failure
 * the suite asks for becomes the page or answer Vinted would give. Vinted's answer for a listing
 * its seller deleted is not read yet, so the suite gets no `remove`, and checks that no absence
 * is authoritative.
 */
import type { ConformanceAction, ConformanceMarketplace } from '@listora/marketplaces/conformance';

import type { FakeVintedAction, FakeVintedSite } from './fake-vinted-site.ts';

/**
 * The step timeout of adapters under test. Upload, the longest step, gets three times it, and a
 * `timeout_after_send` answer comes after that, soon enough for the check to finish within a
 * test's time.
 */
export const VINTED_STEP_TIMEOUT_MS = 3_000;
const LATE_ANSWER_MS = 4 * VINTED_STEP_TIMEOUT_MS;

/** Every read opens the seller's settings first (the web API's page), so a read fails there. */
const SITE_ACTIONS = {
  create: ['create'],
  update: ['update'],
  end: ['end'],
  relist: ['relist'],
  mark_sold: [],
  read: ['health'],
  health: ['health'],
} as const satisfies Record<ConformanceAction, readonly FakeVintedAction[]>;

export function fakeVintedConformance(site: FakeVintedSite): ConformanceMarketplace {
  return {
    failNext(action, failure) {
      for (const siteAction of SITE_ACTIONS[action]) {
        switch (failure.type) {
          case 'rate_limited':
            site.injectFault({
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
            site.injectFault({
              action: siteAction,
              fault: { type: 'server_error', afterApply: failure.afterApply },
            });
            break;
          case 'reject':
            site.injectFault({
              action: siteAction,
              fault: { type: 'reject', message: failure.message },
            });
            break;
          case 'unauthorized':
            site.injectFault({ action: siteAction, fault: { type: 'session_expired' } });
            break;
          case 'timeout_after_send':
            site.injectFault({
              action: siteAction,
              fault: { type: 'slow', delayMs: LATE_ANSWER_MS, afterApply: true },
            });
            break;
        }
      }
    },
    serveStaleRead() {
      site.injectFault({ action: 'listings', fault: { type: 'stale_read' } });
    },
    countListings: (listing) => site.itemsWithSku(listing.externalSku ?? listing.listingId).length,
    reset() {
      site.clearFaults();
    },
  };
}
