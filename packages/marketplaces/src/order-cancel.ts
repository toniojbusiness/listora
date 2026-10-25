/**
 * How a seller cancels an order on each marketplace. Listora never cancels an order itself: when
 * an item sells twice (a double sale), the seller cancels one of the orders, and these steps go
 * with the double-sale incident (docs/features/auto-delist.md). Each marketplace refunds the
 * buyer of an order its seller cancels.
 *
 * The steps follow the marketplaces' own help as Listora understands it and are still to be
 * checked against each app, like the assisted deep links (plan red flag RF15); keep them short
 * and free of promises about the marketplace's policies.
 */
import type { Marketplace } from '@listora/db';

import { MARKETPLACE_NAMES } from './adapter.ts';

export interface OrderCancelGuide {
  marketplace: Marketplace;
  /** Where the seller's orders are, on the marketplace's site (its app opens such links). */
  url: string;
  /** What to do, in order; each one sentence. */
  steps: readonly string[];
}

const GUIDES = {
  ebay: {
    url: 'https://www.ebay.com/sh/ord',
    steps: [
      'Open Orders in Seller Hub on eBay (in the eBay app: My eBay, then Selling).',
      'Find this order and choose Cancel order.',
      "Pick the reason that you can't fulfill the order, and confirm.",
    ],
  },
  depop: {
    url: 'https://www.depop.com/',
    steps: [
      'In the Depop app, open your profile and go to Sold items.',
      'Open this order and choose to cancel it and refund the buyer.',
      'Confirm the full refund.',
    ],
  },
  poshmark: {
    url: 'https://poshmark.com/',
    steps: [
      'In the Poshmark app, open your account and go to My Sales.',
      'Open this order and choose Cancel Order.',
      'Pick the reason that the item is no longer available, and confirm.',
    ],
  },
  mercari: {
    url: 'https://www.mercari.com/',
    steps: [
      'In the Mercari app, open your profile and go to Selling, then In progress.',
      "Open this order and choose to cancel it (Mercari's Help Center has the option if the order doesn't show one).",
      'Confirm the cancellation.',
    ],
  },
} as const satisfies Record<Marketplace, Omit<OrderCancelGuide, 'marketplace'>>;

export function orderCancelGuide(marketplace: Marketplace): OrderCancelGuide {
  return { marketplace, ...GUIDES[marketplace] };
}

/** "Cancel the order on Depop." */
export function orderCancelTitle(marketplace: Marketplace): string {
  return `Cancel the order on ${MARKETPLACE_NAMES[marketplace]}`;
}
