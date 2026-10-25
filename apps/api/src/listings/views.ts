import type {
  IntegrationMode,
  Listing,
  ListingStatusSummary,
  StatusDisplay,
  Verification,
} from '@listora/api-contract';
import type { Marketplace } from '@listora/db';
import { assertNever } from '@listora/shared';

import type { ListingRow } from './repository.ts';

const MARKETPLACE_NAMES = {
  ebay: 'eBay',
  depop: 'Depop',
  poshmark: 'Poshmark',
  mercari: 'Mercari',
} as const satisfies Record<Marketplace, string>;

export function marketplaceName(marketplace: Marketplace): string {
  return MARKETPLACE_NAMES[marketplace];
}

/**
 * A listing is `api` only while it is on an API connection. Without one Listora cannot act on
 * the marketplace or read the listing back, so the user does the marketplace's part: assisted.
 */
export function listingMode(row: ListingRow): IntegrationMode {
  return row.connection_mode ?? 'assisted';
}

/**
 * How the listing's current state was established. Only an API listing can be verified by a
 * read-back and only an assisted one by the user, so an assisted listing can never claim the
 * marketplace confirmed it.
 */
export function listingVerification(row: ListingRow): Verification | undefined {
  const mode = listingMode(row);
  if (mode === 'api') {
    return row.last_verified_at === null
      ? undefined
      : { method: 'marketplace_api', verifiedAt: row.last_verified_at.toISOString() };
  }
  return row.user_confirmed_at === null
    ? undefined
    : { method: 'user_confirmation', verifiedAt: row.user_confirmed_at.toISOString() };
}

/**
 * The honest status label (docs/features/operations.md). `success` only for a state that a
 * read-back or the user confirmed; an unverified `active` or `ended` is still being checked.
 * The listing actions (T-19) and assisted tasks (T-21) refine the in-progress and assisted
 * labels with operation details such as retry counts.
 */
export function listingStatusDisplay(row: ListingRow): StatusDisplay {
  const name = marketplaceName(row.marketplace);
  const verification = listingVerification(row);
  const checking: StatusDisplay = { tone: 'checking', label: 'Checking...' };
  switch (row.status) {
    case 'draft':
      return { tone: 'neutral', label: 'Draft' };
    case 'queued':
      return { tone: 'in_progress', label: 'Queued' };
    case 'publishing':
      return { tone: 'in_progress', label: 'Publishing...' };
    case 'active':
      if (verification?.method === 'marketplace_api') {
        return { tone: 'success', label: `Active (confirmed by ${name})` };
      }
      if (verification?.method === 'user_confirmation') {
        return { tone: 'success', label: 'Active (you confirmed)' };
      }
      return checking;
    case 'ending':
      return { tone: 'in_progress', label: 'Ending...' };
    case 'ended':
      // The user's confirmation that a listing was live says nothing about it having ended.
      return verification?.method === 'marketplace_api'
        ? { tone: 'success', label: `Ended (confirmed by ${name})` }
        : { tone: 'neutral', label: 'Ended' };
    case 'sold':
      return { tone: 'neutral', label: `Sold on ${name}` };
    case 'error':
      return { tone: 'failed', label: 'Failed - Retry' };
    case 'unknown':
      return checking;
    case 'needs_user_action':
      return { tone: 'action_needed', label: `Action needed on ${name}` };
    default:
      return assertNever(row.status);
  }
}

/**
 * The contract's `Listing`. `availableActions` is empty until the listing actions (T-19) and
 * assisted tasks (T-21) exist. `variant` is present only for a listing Listora wrote: a linked
 * listing has no title or price, because Listora never read it.
 */
export function listingView(row: ListingRow): Listing {
  const verification = listingVerification(row);
  return {
    id: row.id,
    itemId: row.item_id,
    marketplace: row.marketplace,
    mode: listingMode(row),
    status: row.status,
    statusDisplay: listingStatusDisplay(row),
    ...(verification ? { verification } : {}),
    ...(row.external_listing_id === null ? {} : { externalListingId: row.external_listing_id }),
    ...(row.external_sku === null ? {} : { externalSku: row.external_sku }),
    ...(row.external_url === null ? {} : { externalUrl: row.external_url }),
    ...(row.title === null || row.price_cents === null
      ? {}
      : {
          variant: {
            title: row.title,
            description: row.description ?? '',
            price: { amountCents: row.price_cents, currency: row.currency },
            ...(row.category_ref === null ? {} : { categoryRef: row.category_ref }),
          },
        }),
    availableActions: [],
    ...(row.listed_at === null ? {} : { listedAt: row.listed_at.toISOString() }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    ...(row.last_verified_at === null
      ? {}
      : { lastVerifiedAt: row.last_verified_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function listingSummaryView(row: ListingRow): ListingStatusSummary {
  return {
    listingId: row.id,
    marketplace: row.marketplace,
    mode: listingMode(row),
    status: row.status,
    statusDisplay: listingStatusDisplay(row),
  };
}
