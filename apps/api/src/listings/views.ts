import type {
  IntegrationMode,
  KnownListingAction,
  Listing,
  ListingActionAvailability,
  ListingAspect,
  ListingStatusSummary,
  ListingVariant,
  StatusDisplay,
  Verification,
} from '@listora/api-contract';
import type { DbExecutor, Marketplace, OperationKind } from '@listora/db';
import { operationMode, type AdapterRegistry } from '@listora/marketplaces';
import { describeListingStatus, UNFINISHED_STATUSES } from '@listora/operations';
import { assertNever } from '@listora/shared';

import { operationView } from '../operations/views.ts';
import type { Tenant } from '../tenancy.ts';
import { latestOperations, type ListingRow, type OperationRow } from './repository.ts';

const MARKETPLACE_NAMES = {
  ebay: 'eBay',
  depop: 'Depop',
  poshmark: 'Poshmark',
  mercari: 'Mercari',
} as const satisfies Record<Marketplace, string>;

export function marketplaceName(marketplace: Marketplace): string {
  return MARKETPLACE_NAMES[marketplace];
}

/** What the listing views need besides the rows: each marketplace's capabilities. */
export interface ListingViewContext {
  adapters: AdapterRegistry;
}

/** A listing and its newest operation that was not canceled, if any. */
export interface ListingState {
  row: ListingRow;
  operation: OperationRow | undefined;
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
 * The honest status label (docs/features/operations.md). A listing with an operation shows
 * that operation's truth (`describeListingStatus`: "Delisting... retry 2 of 6", "Delist failed
 * - Retry", "Active (confirmed by eBay)" only for a read-back). One without, such as a listing
 * the user linked, shows its recorded state: `success` only for a state that a read-back or the
 * user confirmed; an unverified `active` or `ended` is still being checked.
 */
export function listingStatusDisplay(row: ListingRow, operation?: OperationRow): StatusDisplay {
  if (operation !== undefined) {
    return describeListingStatus({
      marketplace: row.marketplace,
      listingStatus: row.status,
      operation: {
        kind: operation.kind,
        status: operation.status,
        attempts: operation.attempts,
        errorMessage: operation.error_message,
        successEvidence: operation.success_evidence,
      },
    });
  }
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

/** The operation each listing action queues. */
export const ACTION_KIND = {
  publish: 'create',
  revise: 'revise',
  change_price: 'price',
  end: 'end',
  relist: 'relist',
  verify: 'verify',
} as const satisfies Record<KnownListingAction, OperationKind>;

/**
 * The actions the listing's state allows, before capabilities: none while an operation is
 * unfinished (one change at a time, and the screen shows its progress); `publish` only for a
 * draft that was never queued (a failed publish is retried, since it may have been applied);
 * changes and delisting for an active listing; relisting for an ended one. A failed
 * operation's Retry is the operation's own (`retryOperation`), not a listing action.
 */
export function actionsForState(state: ListingState): KnownListingAction[] {
  const { row, operation } = state;
  if (
    operation !== undefined &&
    (UNFINISHED_STATUSES as readonly string[]).includes(operation.status)
  ) {
    return [];
  }
  switch (row.status) {
    case 'draft':
      return operation === undefined ? ['publish'] : [];
    case 'active':
      return ['change_price', 'revise', 'end', 'verify'];
    case 'ended':
      return ['relist', 'verify'];
    case 'queued':
    case 'publishing':
    case 'ending':
    case 'sold':
    case 'error':
    case 'unknown':
    case 'needs_user_action':
      return [];
    default:
      return assertNever(row.status);
  }
}

/**
 * The actions the user can take now, each in the mode the marketplace's capabilities give it
 * under the listing's connection. Only API actions for now: assisted ones join with the task
 * inbox that lets the user finish them (T-21).
 */
export function availableActions(
  state: ListingState,
  context: ListingViewContext,
): ListingActionAvailability[] {
  const connection =
    state.row.connection_id === null || state.row.connection_mode === null
      ? null
      : { id: state.row.connection_id, mode: state.row.connection_mode };
  const capabilities = context.adapters.capabilities(state.row.marketplace, connection);
  if (capabilities === undefined) return [];
  return actionsForState(state).flatMap((action) =>
    operationMode(capabilities, ACTION_KIND[action]) === 'api' ? [{ action, mode: 'api' }] : [],
  );
}

/** The listing's variant as the contract shows it; absent for a listing Listora never wrote. */
export function variantView(row: ListingRow): ListingVariant | undefined {
  if (row.title === null || row.price_cents === null) return undefined;
  const aspects = Array.isArray(row.aspects) ? (row.aspects as unknown as ListingAspect[]) : [];
  return {
    title: row.title,
    description: row.description ?? '',
    price: { amountCents: row.price_cents, currency: row.currency },
    ...(row.category_ref === null ? {} : { categoryRef: row.category_ref }),
    ...(row.condition === null
      ? {}
      : { condition: row.condition as NonNullable<ListingVariant['condition']> }),
    ...(aspects.length === 0 ? {} : { aspects }),
    ...(row.hashtags.length === 0 ? {} : { hashtags: row.hashtags }),
  };
}

/**
 * The contract's `Listing`. `variant` is present only for a listing Listora wrote: a linked
 * listing has no title or price, because Listora never read it.
 */
export function listingView(state: ListingState, context: ListingViewContext): Listing {
  const { row, operation } = state;
  const verification = listingVerification(row);
  const variant = variantView(row);
  return {
    id: row.id,
    itemId: row.item_id,
    marketplace: row.marketplace,
    mode: listingMode(row),
    status: row.status,
    statusDisplay: listingStatusDisplay(row, operation),
    ...(verification ? { verification } : {}),
    ...(row.external_listing_id === null ? {} : { externalListingId: row.external_listing_id }),
    ...(row.external_sku === null ? {} : { externalSku: row.external_sku }),
    ...(row.external_url === null ? {} : { externalUrl: row.external_url }),
    ...(variant === undefined ? {} : { variant }),
    ...(operation === undefined ? {} : { latestOperation: operationView(operation, row) }),
    availableActions: availableActions(state, context),
    ...(row.listed_at === null ? {} : { listedAt: row.listed_at.toISOString() }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    ...(row.last_verified_at === null
      ? {}
      : { lastVerifiedAt: row.last_verified_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function listingSummaryView(state: ListingState): ListingStatusSummary {
  const { row, operation } = state;
  return {
    listingId: row.id,
    marketplace: row.marketplace,
    mode: listingMode(row),
    status: row.status,
    statusDisplay: listingStatusDisplay(row, operation),
  };
}

/** Each row with its newest operation that was not canceled. */
export async function listingStates(
  db: DbExecutor,
  tenant: Tenant,
  rows: readonly ListingRow[],
): Promise<ListingState[]> {
  const operations = await latestOperations(
    db,
    tenant,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ row, operation: operations.get(row.id) }));
}

/** `listingView` for rows read without their operations. */
export async function listingViews(
  db: DbExecutor,
  tenant: Tenant,
  rows: readonly ListingRow[],
  context: ListingViewContext,
): Promise<Listing[]> {
  return (await listingStates(db, tenant, rows)).map((state) => listingView(state, context));
}
