import {
  createInventoryItem,
  inTransaction,
  jsonb,
  SkuAllocationError,
  type DbTransaction,
  type InventoryItem,
} from '@listora/db';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { changedDetails, detailsFromRow } from '../items/details.ts';
import { findItem, lockItem } from '../items/repository.ts';
import type { ItemRouteDependencies } from '../items/routes.ts';
import { itemView } from '../items/views.ts';
import type { Tenant } from '../tenancy.ts';
import { identityFromUrl } from './identity.ts';
import { completeUserTask } from '../tasks/commands.ts';
import { openListTaskFor } from '../tasks/repository.ts';
import {
  findListing,
  findListingByIdentity,
  hasLiveListingOn,
  insertLinkedListing,
  type ListingIdentity,
  type ListingRow,
} from './repository.ts';
import { listingStates, listingView, marketplaceName, type ListingViewContext } from './views.ts';

/** Item statuses a shared listing can be linked to; the item's status then follows its listings. */
const LINKABLE_ITEM_STATUSES = new Set(['draft', 'ready', 'listed']);

/**
 * Listings the user created on a marketplace themselves and shared to Listora (assisted mode,
 * docs/features/marketplaces.md): `linkItemListing` links one to an item, and
 * `importSharedListing` creates an item for it first. Both only read the shared URL; nothing
 * is fetched from the marketplace, and the link is the user's confirmation, never the
 * marketplace's.
 */
export function registerListingRoutes(app: FastifyInstance, deps: ItemRouteDependencies): void {
  const views: ListingViewContext = { adapters: deps.connections.adapters };
  contractRoute(app, deps, 'linkItemListing', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const identity = identityFromUrl(body.url);
      const item = await lockItem(trx, tenant, params.itemId);
      if (!item) throw notFound('Item');
      // Sharing the listing an open list task asked for is the user saying they posted it.
      const taskId = await openListTaskFor(trx, tenant, item.id, identity.marketplace);
      if (taskId !== undefined) {
        const task = await completeUserTask(
          trx,
          tenant,
          taskId,
          { externalUrl: body.url },
          deps.connections.adapters.lookup,
        );
        const row =
          task.listing_id === null ? undefined : await findListing(trx, tenant, task.listing_id);
        const [state] = row === undefined ? [] : await listingStates(trx, tenant, [row]);
        if (state === undefined) throw new Error(`task ${task.id} lost its listing`);
        return { status: 201, body: listingView(state, views) };
      }
      const listing = await linkListing(trx, tenant, item, identity);
      return { status: 201, body: listingView({ row: listing, operation: undefined }, views) };
    }),
  );

  contractRoute(app, deps, 'importSharedListing', async ({ tenant, db, body }) =>
    inTransaction(db, async (trx) => {
      const identity = identityFromUrl(body.url);
      const title = body.title.trim();
      if (title === '') throw validationFailed([{ field: 'title', message: 'must not be blank' }]);

      // A refused link rolls the whole transaction back, so no item or SKU is left behind.
      const item = await insertImportedItem(trx, tenant, title);
      await writeAudit(trx, tenant, {
        itemId: item.id,
        action: 'item.created',
        changes: {
          sku: item.sku,
          source: 'shared_listing',
          ...changedDetails({}, detailsFromRow(item)),
        },
      });
      const listing = await linkListing(trx, tenant, item, identity);
      const linked = await findItem(trx, tenant, item.id);
      if (!linked) throw new Error(`item ${item.id} vanished inside its own transaction`);
      return {
        status: 201,
        body: {
          item: await itemView(trx, tenant, linked, deps),
          listing: listingView({ row: listing, operation: undefined }, views),
        },
      };
    }),
  );
}

async function assertNotLinked(
  trx: DbTransaction,
  tenant: Tenant,
  identity: ListingIdentity,
): Promise<void> {
  const existing = await findListingByIdentity(trx, tenant, identity);
  if (existing) {
    throw new ApiError(
      'already_exists',
      `This ${marketplaceName(identity.marketplace)} listing is already linked to ${existing.sku}.`,
    );
  }
}

/**
 * Links the listing to the item, which the caller has locked: the listing becomes `active` and
 * user-confirmed, a `draft` or `ready` item becomes `listed`, and the item's history records
 * both.
 */
async function linkListing(
  trx: DbTransaction,
  tenant: Tenant,
  item: InventoryItem,
  identity: ListingIdentity,
): Promise<ListingRow> {
  if (!LINKABLE_ITEM_STATUSES.has(item.status)) {
    throw new ApiError(
      'invalid_state_transition',
      `${item.sku} is ${item.status.replaceAll('_', ' ')}, so a listing cannot be linked to it.`,
    );
  }
  await assertNotLinked(trx, tenant, identity);
  const name = marketplaceName(identity.marketplace);
  if (await hasLiveListingOn(trx, tenant, item.id, identity.marketplace)) {
    throw new ApiError('already_exists', `${item.sku} already has a live ${name} listing.`);
  }

  let listing: ListingRow;
  try {
    listing = await insertLinkedListing(trx, tenant, item.id, identity);
  } catch (error) {
    // A concurrent link of the same listing, or to the same item, won the race.
    if (isPgError(error, PG_ERROR.uniqueViolation)) {
      throw new ApiError(
        'already_exists',
        `This ${name} listing was just linked. Reload and check.`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  const changes: Record<string, string | { from: string; to: string }> = {
    listingId: listing.id,
    marketplace: identity.marketplace,
    url: identity.url,
    ...(identity.listingId === null ? {} : { externalListingId: identity.listingId }),
  };
  if (item.status !== 'listed') {
    await trx
      .updateTable('inventory_item')
      .set({ status: 'listed' })
      .where('account_id', '=', tenant.accountId)
      .where('id', '=', item.id)
      .execute();
    changes['status'] = { from: item.status, to: 'listed' };
  }
  await writeAudit(trx, tenant, { itemId: item.id, action: 'listing.linked', changes });
  return listing;
}

/** An import placeholder: the next SKU and the user's title; linking its listing lists it. */
async function insertImportedItem(
  trx: DbTransaction,
  tenant: Tenant,
  title: string,
): Promise<InventoryItem> {
  try {
    return await createInventoryItem(trx, tenant.accountId, {
      title,
      field_provenance: jsonb({ title: 'user' }),
    });
  } catch (error) {
    if (error instanceof SkuAllocationError) {
      throw new ApiError(
        'invalid_state_transition',
        'This account has used all of its SKU numbers.',
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
