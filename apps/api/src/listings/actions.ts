/**
 * An item's listings Listora writes, and the actions on them (docs/features/marketplaces.md):
 * draft listings (`createListing`, `replaceListingDraft`), and publish, price change, revise,
 * end, relist, and verify. Every action that reaches a marketplace queues an operation with the
 * operation engine (`enqueueOperation`, in the request's transaction) and answers `202` with the
 * listing and that operation; the listing shows the change as done only once the engine has
 * verified it ("Active (confirmed by eBay)").
 */
import type { KnownListingAction, ListingVariant } from '@listora/api-contract';
import { marketplaceCategories } from '@listora/automation';
import { accountConnections } from '@listora/connections';
import {
  inTransaction,
  type DbExecutor,
  type DbTransaction,
  type InventoryItem,
  type Marketplace,
  type OperationKind,
} from '@listora/db';
import type { ConnectionRef, DesiredListingState, ListingContent } from '@listora/marketplaces';
import { enqueueOperation, type NewOperation } from '@listora/operations';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { writeAudit } from '../audit.ts';
import type { ConnectionsDependencies } from '../connections/routes.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { findItem, lockItem } from '../items/repository.ts';
import { engineCommand } from '../operations/routes.ts';
import { operationView } from '../operations/views.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import type { PublicUrls } from '../photos/mapping.ts';
import type { Tenant } from '../tenancy.ts';
import { listingContent } from './content.ts';
import {
  findListing,
  hasLiveListingOn,
  hasSentOperations,
  insertDraftListing,
  itemListingRows,
  listListingRows,
  lockListing,
  updateVariant,
  updateVariantPrice,
  type ListingRow,
} from './repository.ts';
import {
  actionsForState,
  LISTABLE_ITEM_STATUSES,
  listingStates,
  listingView,
  listingViews,
  marketplaceName,
  variantView,
  type ListingViewContext,
} from './views.ts';

export interface ListingActionDependencies extends RouteDependencies {
  /** Listing photo URLs for the content a publish sends. */
  storage: PublicUrls;
  /** Each marketplace's adapter: its capabilities, and the validation a publish runs first. */
  connections: Pick<ConnectionsDependencies, 'adapters'>;
}

export function registerListingActionRoutes(
  app: FastifyInstance,
  deps: ListingActionDependencies,
): void {
  const views: ListingViewContext = { adapters: deps.connections.adapters };

  contractRoute(app, deps, 'listItemListings', async ({ tenant, db, params }) => {
    const item = await findItem(db, tenant, params.itemId);
    if (!item) throw notFound('Item');
    const rows = (await itemListingRows(db, tenant, [item.id])).get(item.id) ?? [];
    return { status: 200, body: { data: await listingViews(db, tenant, rows, views) } };
  });

  contractRoute(app, deps, 'getItemMarketplaceCategories', async ({ tenant, db, params }) => {
    const item = await findItem(db, tenant, params.itemId);
    if (!item) throw notFound('Item');
    const categories = marketplaceCategories(params.marketplace, item);
    if (categories === null) throw notFound('Marketplace categories');
    return {
      status: 200,
      body: {
        ...(categories.suggested === null ? {} : { suggested: categories.suggested }),
        likely: categories.likely,
        choices: categories.choices,
      },
    };
  });

  contractRoute(app, deps, 'listListings', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listListingRows(db, tenant, {
      marketplace: query.marketplace,
      statuses: query.status,
      beforeId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: await listingViews(db, tenant, page, views),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'getListing', async ({ tenant, db, params }) => {
    const row = await findListing(db, tenant, params.listingId);
    if (!row) throw notFound('Listing');
    const [listing] = await listingViews(db, tenant, [row], views);
    if (!listing) throw notFound('Listing');
    return { status: 200, body: listing };
  });

  contractRoute(app, deps, 'createListing', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const item = await lockItem(trx, tenant, params.itemId);
      if (!item) throw notFound('Item');
      assertListable(item, 'listed');
      const { marketplace } = body;
      const name = marketplaceName(marketplace);
      if (await hasLiveListingOn(trx, tenant, item.id, marketplace)) {
        throw new ApiError('already_exists', `${item.sku} already has a ${name} listing.`);
      }
      const connectionId = await listingConnection(trx, tenant, marketplace, deps);
      const variant = checkedVariant(body.variant);
      let row: ListingRow;
      try {
        row = await insertDraftListing(trx, tenant, {
          itemId: item.id,
          marketplace,
          connectionId,
          variant,
        });
      } catch (error) {
        // A concurrent create on the same item and marketplace won the race.
        if (isPgError(error, PG_ERROR.uniqueViolation)) {
          throw new ApiError('already_exists', `${item.sku} already has a ${name} listing.`, {
            cause: error,
          });
        }
        throw error;
      }
      await writeAudit(trx, tenant, {
        itemId: item.id,
        action: 'listing.created',
        changes: { listingId: row.id, marketplace },
      });
      return { status: 201 as const, body: listingView({ row, operation: undefined }, views) };
    }),
  );

  contractRoute(app, deps, 'replaceListingDraft', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const row = await lockListing(trx, tenant, params.listingId);
      if (!row) throw notFound('Listing');
      if (row.status !== 'draft' || (await hasSentOperations(trx, tenant, row.id))) {
        throw new ApiError(
          'invalid_state_transition',
          'This listing was already sent to the marketplace. Change it with a price change or an update.',
        );
      }
      const updated = await updateVariant(trx, tenant, row.id, checkedVariant(body.variant));
      await writeAudit(trx, tenant, {
        itemId: row.item_id,
        action: 'listing.draft_updated',
        changes: { listingId: row.id },
      });
      return {
        status: 200 as const,
        body: listingView({ row: updated, operation: undefined }, views),
      };
    }),
  );

  // Each action below: lock the listing, check that its state allows the action under the
  // marketplace's capabilities, record Listora's version of the change, and queue the
  // operation. The response is the listing as it is now (the change in progress) and the
  // operation to follow.

  contractRoute(app, deps, 'publishListing', async ({ tenant, db, params, request }) => {
    const { trx, row, item } = await prepareAction(db, tenant, params.listingId, 'publish', views);
    assertListable(item, 'published');
    const variant = variantView(row);
    if (variant === undefined)
      throw new ApiError('invalid_state_transition', 'Add a title and a price first.');
    const content = await listingContent(trx, tenant, item, variant, deps.storage);
    assertValidContent(row, content, deps);
    return queue(
      trx,
      tenant,
      row,
      requestKey(request),
      views,
      { kind: 'create', content },
      'listing.publish_requested',
    );
  });

  contractRoute(app, deps, 'reviseListing', async ({ tenant, db, params, body, request }) => {
    const { trx, row, item } = await prepareAction(db, tenant, params.listingId, 'revise', views);
    const variant = checkedVariant(body.variant);
    const content = await listingContent(trx, tenant, item, variant, deps.storage);
    assertValidContent(row, content, deps);
    const updated = await updateVariant(trx, tenant, row.id, variant);
    return queue(
      trx,
      tenant,
      updated,
      requestKey(request),
      views,
      { kind: 'revise', content },
      'listing.revise_requested',
    );
  });

  contractRoute(app, deps, 'changeListingPrice', async ({ tenant, db, params, body, request }) => {
    const { trx, row } = await prepareAction(db, tenant, params.listingId, 'change_price', views);
    const { amountCents, currency } = body.price;
    if (amountCents <= 0) {
      throw validationFailed(
        [{ field: 'price', message: 'must be more than zero' }],
        'Enter a price above $0.',
      );
    }
    await updateVariantPrice(trx, tenant, row.id, amountCents);
    const desired: DesiredListingState = { priceCents: amountCents, currency };
    const updated = await reread(trx, tenant, row.id);
    return queue(
      trx,
      tenant,
      updated,
      requestKey(request),
      views,
      { kind: 'price', desired },
      'listing.price_change_requested',
      {
        priceCents: amountCents,
      },
    );
  });

  contractRoute(app, deps, 'endListing', async ({ tenant, db, params, body, request }) => {
    const { trx, row } = await prepareAction(db, tenant, params.listingId, 'end', views);
    return queue(
      trx,
      tenant,
      row,
      requestKey(request),
      views,
      { kind: 'end', desired: { status: 'ended' } },
      'listing.end_requested',
      {
        reason: body.reason,
      },
    );
  });

  contractRoute(app, deps, 'relistListing', async ({ tenant, db, params, request }) => {
    if (!db.isTransaction) throw new Error("relist must run in the request's transaction");
    return relistListing(db as DbTransaction, tenant, params.listingId, requestKey(request), deps);
  });

  contractRoute(app, deps, 'verifyListing', async ({ tenant, db, params, request }) => {
    const { trx, row } = await prepareAction(db, tenant, params.listingId, 'verify', views);
    // A check reads back the state Listora recorded; nothing is sent to the marketplace.
    const status = row.status === 'ended' ? 'ended' : 'active';
    return queue(
      trx,
      tenant,
      row,
      requestKey(request),
      views,
      { kind: 'verify', desired: { status } },
      'listing.check_requested',
    );
  });
}

/**
 * Locks the listing, then its item, and refuses the action unless the listing's state and
 * the marketplace's capabilities allow it now (the same rule as `availableActions`).
 */
async function prepareAction(
  db: DbExecutor,
  tenant: Tenant,
  listingId: string,
  action: KnownListingAction,
  views: ListingViewContext,
): Promise<{ trx: DbTransaction; row: ListingRow; item: InventoryItem }> {
  // Every action is an idempotent POST, which runs in the request's transaction.
  if (!db.isTransaction) throw new Error(`${action} must run in the request's transaction`);
  const trx = db as DbTransaction;
  const row = await lockListing(trx, tenant, listingId);
  if (!row) throw notFound('Listing');
  const [state] = await listingStates(trx, tenant, [row]);
  if (state === undefined) throw notFound('Listing');
  const view = listingView(state, views);
  if (!view.availableActions.some((available) => available.action === action)) {
    throw unavailable(row, action, actionsForState(state).includes(action));
  }
  const item = await lockItem(trx, tenant, row.item_id);
  if (!item) throw notFound('Item');
  return { trx, row, item };
}

/**
 * Relists an ended or sold listing (the item's screen, and the seller's answer to "Relist it?"
 * after a canceled or returned sale): the same checks as every action, then a `relist`
 * operation with the listing's content, keyed by `key`. A listing whose marketplace listing is
 * gone is posted again as a new listing (the executor sends its relist as a create).
 */
export async function relistListing(
  trx: DbTransaction,
  tenant: Tenant,
  listingId: string,
  key: string,
  deps: ListingActionDependencies,
) {
  const views: ListingViewContext = { adapters: deps.connections.adapters };
  const { row, item } = await prepareAction(trx, tenant, listingId, 'relist', views);
  assertListable(item, 'relisted');
  const variant = variantView(row);
  if (variant === undefined) {
    throw new ApiError(
      'marketplace_action_unavailable',
      `Listora didn't write this ${marketplaceName(row.marketplace)} listing, so it can't relist it.`,
    );
  }
  const content = await listingContent(trx, tenant, item, variant, deps.storage);
  assertValidContent(row, content, deps);
  return queue(
    trx,
    tenant,
    row,
    key,
    views,
    { kind: 'relist', content },
    'listing.relist_requested',
  );
}

/** The request's Idempotency-Key, which `contractRoute` requires on every POST. */
function requestKey(request: FastifyRequest): string {
  return String(request.headers['idempotency-key']);
}

/** Why an action cannot run now: the listing's state, or the marketplace (assisted). */
function unavailable(row: ListingRow, action: KnownListingAction, stateAllows: boolean): ApiError {
  const name = marketplaceName(row.marketplace);
  if (stateAllows) {
    return new ApiError(
      'marketplace_action_unavailable',
      `Listora can't do this on ${name} for you yet. You can do it in the ${name} app.`,
    );
  }
  return new ApiError('invalid_state_transition', STATE_REFUSAL[action]);
}

const STATE_REFUSAL = {
  publish: 'This listing was already sent. If it failed, use Retry.',
  revise: 'Only an active listing can be updated, and only once its current change is done.',
  change_price:
    "Only an active listing's price can change, and only once its current change is done.",
  end: 'Only an active listing can be ended, and only once its current change is done.',
  relist: 'Only an ended listing can be relisted, and only once its current change is done.',
  verify: 'This listing can be checked once its current change is done.',
} as const satisfies Record<KnownListingAction, string>;

function assertListable(item: InventoryItem, verb: string): void {
  if (!LISTABLE_ITEM_STATUSES.has(item.status)) {
    throw new ApiError(
      'invalid_state_transition',
      `${item.sku} is ${item.status.replaceAll('_', ' ')}, so it can't be ${verb}.`,
    );
  }
}

/** The variant with blank text refused, which the schema alone allows. */
function checkedVariant(variant: ListingVariant): ListingVariant {
  if (variant.title.trim() === '') {
    throw validationFailed(
      [{ field: 'variant.title', message: 'must not be blank' }],
      'Add a title.',
    );
  }
  if (variant.price.amountCents <= 0) {
    throw validationFailed(
      [{ field: 'variant.price', message: 'must be more than zero' }],
      'Enter a price above $0.',
    );
  }
  return { ...variant, title: variant.title.trim() };
}

function connectionRef(row: ListingRow): ConnectionRef | null {
  return row.connection_id === null ||
    row.connection_mode === null ||
    row.connection_status === null
    ? null
    : { id: row.connection_id, mode: row.connection_mode, status: row.connection_status };
}

/**
 * What the marketplace would refuse, before anything is queued, so the user fixes it on the
 * review screen (the engine checks again before every send).
 */
function assertValidContent(
  row: ListingRow,
  content: ListingContent,
  deps: ListingActionDependencies,
): void {
  const adapter = deps.connections.adapters.get(row.marketplace);
  if (adapter === undefined) return;
  const connection = connectionRef(row);
  const issues = adapter.validate(
    adapter.buildPayload(content.item, content.variant, connection),
    connection,
  );
  const [first] = issues;
  if (first !== undefined) {
    throw validationFailed(
      issues.map((issue) => ({ field: issue.field, message: issue.message })),
      first.message,
    );
  }
}

/**
 * The connection a new listing on the marketplace works through. A marketplace Listora reaches
 * only through its API (eBay) needs the account's connection, and a usable one; the assisted
 * marketplaces need none.
 */
async function listingConnection(
  db: DbExecutor,
  tenant: Tenant,
  marketplace: Marketplace,
  deps: ListingActionDependencies,
): Promise<string | null> {
  const name = marketplaceName(marketplace);
  const connection = (await accountConnections(db, tenant.accountId)).get(marketplace);
  const withoutConnection = deps.connections.adapters.capabilities(marketplace, null);
  const needsConnection = withoutConnection?.create === 'api';
  if (connection === undefined) {
    if (needsConnection) {
      throw new ApiError(
        'marketplace_not_connected',
        `Connect your ${name} account first, in Settings > Marketplaces.`,
      );
    }
    return null;
  }
  if (connection.mode === 'api') {
    if (connection.status === 'reauth_required' || connection.status === 'revoked') {
      throw new ApiError(
        'marketplace_reauth_required',
        `Reconnect your ${name} account in Settings > Marketplaces, then try again.`,
      );
    }
  }
  return connection.id;
}

async function reread(trx: DbTransaction, tenant: Tenant, listingId: string): Promise<ListingRow> {
  const row = await findListing(trx, tenant, listingId);
  if (!row) throw new Error(`listing ${listingId} vanished inside its own transaction`);
  return row;
}

/**
 * Queues the operation in the request's transaction, records the request in the item's history,
 * and answers with the listing and its new operation. The operation's key comes from the
 * request's own Idempotency-Key, so a replay can never queue a second one.
 */
async function queue(
  trx: DbTransaction,
  tenant: Tenant,
  row: ListingRow,
  requestKey: string,
  views: ListingViewContext,
  operation: Pick<NewOperation, 'kind'> &
    ({ content: ListingContent } | { desired: DesiredListingState }),
  auditAction: string,
  auditChanges: Record<string, string | number> = {},
) {
  const { operation: queued } = await engineCommand(() =>
    enqueueOperation(trx, {
      ...(operation as NewOperation),
      accountId: tenant.accountId,
      listingId: row.id,
      idempotencyKey: `${ACTION_PREFIX[operation.kind]}:${requestKey}`,
      origin: 'user',
    }),
  );
  await writeAudit(trx, tenant, {
    itemId: row.item_id,
    action: auditAction,
    changes: { listingId: row.id, operationId: queued.id, ...auditChanges },
  });
  return {
    status: 202 as const,
    body: {
      listing: listingView({ row, operation: queued }, views),
      operation: operationView(queued, row),
    },
  };
}

/** Operation keys name the action, so one request's key can never queue two kinds. */
const ACTION_PREFIX = {
  create: 'listing.publish',
  revise: 'listing.revise',
  price: 'listing.change_price',
  end: 'listing.end',
  relist: 'listing.relist',
  verify: 'listing.verify',
  mark_sold: 'listing.mark_sold',
} as const satisfies Record<OperationKind, string>;
