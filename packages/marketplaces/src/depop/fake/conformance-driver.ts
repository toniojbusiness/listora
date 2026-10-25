/**
 * Drives the fake Depop for the shared conformance suite (test-only): each suite action is the
 * Selling API call that performs it, and each failure is the fault Depop answers with. Depop
 * never says for certain that a listing is gone (a product it can't find may only be new), so
 * the suite gets no `remove`, and checks that no absence is authoritative.
 */
import type { ConformanceAction, ConformanceMarketplace } from '../../conformance/suite.ts';
import type { FakeDepop, FakeDepopAction } from './fake-depop.ts';

const ACTIONS = {
  create: 'put',
  update: 'patch',
  end: 'delete',
  relist: 'put',
  mark_sold: 'mark_sold',
  read: 'get',
  // The health check is one `GET /api/v1/shop/`.
  health: 'shop',
} as const satisfies Record<ConformanceAction, FakeDepopAction>;

export function fakeDepopConformanceMarketplace(
  fake: FakeDepop,
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
          // The seller's grant is gone: the call is refused, and so is the refresh that follows.
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
      fake.inject({ action: 'get', fault: { type: 'stale_read' } });
    },
    countListings: (listing) =>
      listing.externalListingId === null ? 0 : fake.products(listing.externalListingId).length,
    reset() {
      fake.clearFaults();
    },
  };
}
