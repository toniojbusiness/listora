/**
 * Drives the fake eBay for the shared conformance suite (test-only): each suite action is the
 * eBay call that performs it, and each failure is the fault eBay answers with.
 */
import type { ConformanceAction, ConformanceMarketplace } from '../../conformance/suite.ts';
import type { FakeEbay, FakeEbayAction } from './fake-ebay.ts';

const ACTIONS = {
  create: 'add',
  update: 'revise',
  end: 'end',
  relist: 'relist',
  // eBay marks its own sales sold; the adapter never sends a mark-sold.
  mark_sold: 'end',
  read: 'get_item',
  // The health check is one Fulfillment getOrders call.
  health: 'orders',
} as const satisfies Record<ConformanceAction, FakeEbayAction>;

export function fakeEbayConformanceMarketplace(
  fake: FakeEbay,
  options: { lateAnswerMs: number },
): ConformanceMarketplace {
  return {
    failNext(action, failure) {
      const target = ACTIONS[action];
      switch (failure.type) {
        case 'rate_limited':
          fake.inject({
            action: target,
            fault: {
              type: 'rate_limited',
              ...(failure.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: failure.retryAfterSeconds }),
            },
          });
          return;
        case 'server_error':
          fake.inject({
            action: target,
            fault: { type: 'server_error', afterApply: failure.afterApply },
          });
          return;
        case 'reject':
          fake.inject({ action: target, fault: { type: 'reject', message: failure.message } });
          return;
        case 'unauthorized':
          // The seller's grant is gone: the call is refused, and so is the token refresh a
          // stale-looking token leads to.
          fake.inject({ action: target, fault: { type: 'unauthorized' } });
          fake.inject({ action: 'token', fault: { type: 'unauthorized' } });
          return;
        case 'timeout_after_send':
          fake.inject({
            action: target,
            fault: { type: 'timeout_after_send', delayMs: options.lateAnswerMs },
          });
          return;
      }
    },
    serveStaleRead() {
      fake.inject({ action: 'get_item', fault: { type: 'stale_read' } });
    },
    remove(externalListingId) {
      fake.remove(externalListingId);
    },
    countListings: (sku) => fake.listings(sku).length,
    reset() {
      fake.clearFaults();
    },
  };
}
