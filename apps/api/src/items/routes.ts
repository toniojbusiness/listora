import { analysisResultOf, findAnalysis } from '@listora/analysis';
import type {
  AnalyzedDetails,
  FieldError,
  ItemStatus,
  UserSettableItemStatus,
} from '@listora/api-contract';
import {
  inTransaction,
  SkuAllocationError,
  type DbExecutor,
  type InventoryItem,
  type Marketplace,
  type PreArchiveItemStatus,
} from '@listora/db';
import { MARKETPLACE_NAMES } from '@listora/marketplaces';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { lockHauls, settleHaul } from '../hauls/repository.ts';
import { itemListingRows } from '../listings/repository.ts';
import { listingStates, type ListingViewContext } from '../listings/views.ts';
import { decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor } from '../pagination.ts';
import { listPhotoRows } from '../photos/repository.ts';
import { deletePhotoObjects } from '../photos/stored-objects.ts';
import type { Tenant } from '../tenancy.ts';
import {
  changedDetails,
  columnsFromDetails,
  detailErrors,
  detailsFromRow,
  normalizeDetails,
  provenanceAfterWrite,
  provenanceFromRow,
  type ItemDetailsInput,
} from './details.ts';
import {
  analysisBelongsToItem,
  coverPhotoRows,
  deleteItem,
  findItem,
  findItemBySku,
  hasLiveListing,
  hasSale,
  inFlightOperationMarketplaces,
  insertItem,
  listItemRows,
  liveListingMarketplaces,
  lockItem,
  storageLocationSummary,
  updateItem,
} from './repository.ts';
import { itemSummaryView, itemView } from './views.ts';

export interface ItemRouteDependencies extends RouteDependencies {
  /** Photo URLs, and deleting a deleted item's photo objects. */
  storage: ObjectStorage;
  /** Each marketplace's capabilities, for the actions a listing allows. */
  connections: ListingViewContext;
}

/** Items CRUD: `listItems`, `createItem`, `getItem`, `replaceItem`, `deleteItem`, `getItemBySku`. */
export function registerItemRoutes(app: FastifyInstance, deps: ItemRouteDependencies): void {
  contractRoute(app, deps, 'listItems', async ({ tenant, db, query }) => {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await listItemRows(db, tenant, {
      statuses: query.status,
      search: query.q,
      marketplace: query.marketplace,
      brand: query.brand,
      attention: query.attention,
      beforeId: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit,
    });
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    const [covers, listingRows] = await Promise.all([
      coverPhotoRows(db, tenant, ids),
      itemListingRows(db, tenant, ids),
    ]);
    const states = await listingStates(db, tenant, [...listingRows.values()].flat());
    const listings = Map.groupBy(states, (state) => state.row.item_id);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        data: page.map((row) =>
          itemSummaryView(row, covers.get(row.id), deps.storage, listings.get(row.id)),
        ),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor(last.id) } : {}),
      },
    };
  });

  contractRoute(app, deps, 'createItem', async ({ tenant, db, body }) =>
    inTransaction(db, async (trx) => {
      const details = normalizeDetails(body.details);
      await assertValidDetails(trx, tenant, undefined, details);
      let row: InventoryItem;
      try {
        row = await insertItem(
          trx,
          tenant,
          columnsFromDetails(details),
          provenanceAfterWrite(details, undefined),
        );
      } catch (error) {
        throw translateWriteError(error);
      }
      await writeAudit(trx, tenant, {
        itemId: row.id,
        action: 'item.created',
        changes: { sku: row.sku, ...changedDetails({}, detailsFromRow(row)) },
      });
      return { status: 201, body: await itemView(trx, tenant, row, deps) };
    }),
  );

  contractRoute(app, deps, 'getItem', async ({ tenant, db, params }) => {
    const row = await findItem(db, tenant, params.itemId);
    if (!row) throw notFound('Item');
    return { status: 200, body: await itemView(db, tenant, row, deps) };
  });

  contractRoute(app, deps, 'getItemBySku', async ({ tenant, db, params }) => {
    const row = await findItemBySku(db, tenant, params.sku);
    if (!row) throw notFound('Item');
    return { status: 200, body: await itemView(db, tenant, row, deps) };
  });

  contractRoute(app, deps, 'replaceItem', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const row = await lockItem(trx, tenant, params.itemId);
      if (!row) throw notFound('Item');
      if (row.version !== body.expectedVersion) throw versionConflict();

      const details = normalizeDetails(body.details);
      await assertValidDetails(trx, tenant, row.id, details);
      assertHaulCostKept(row, details);
      const { status, preArchiveStatus } = await nextStatus(trx, tenant, row, body.status);
      const columns = columnsFromDetails(details);
      const before = detailsFromRow(row);
      const after = detailsFromRow({ ...row, ...columns });
      const changes = changedDetails(before, after);
      if (status !== row.status) changes['status'] = { from: row.status, to: status };
      // Nothing to change: no new version, no history entry.
      if (Object.keys(changes).length === 0) {
        return { status: 200, body: await itemView(trx, tenant, row, deps) };
      }

      let updated: InventoryItem | undefined;
      try {
        updated = await updateItem(trx, tenant, row.id, body.expectedVersion, {
          columns,
          status,
          preArchiveStatus,
          provenance: provenanceAfterWrite(
            details,
            { details: before, provenance: provenanceFromRow(row) },
            await acceptedAnalysisDetails(trx, tenant, details.acceptedAnalysisId),
          ),
        });
      } catch (error) {
        throw translateWriteError(error);
      }
      if (!updated) throw versionConflict();
      await writeAudit(trx, tenant, {
        itemId: row.id,
        action: 'item.updated',
        changes: { fromVersion: row.version, toVersion: updated.version, ...changes },
      });
      return { status: 200, body: await itemView(trx, tenant, updated, deps) };
    }),
  );

  contractRoute(app, deps, 'deleteItem', async ({ tenant, db, params, query, request }) => {
    const photos = await inTransaction(db, async (trx) => {
      // A haul's lock comes before its items' (hauls/routes.ts), so it is taken first.
      const haulId = (await findItem(trx, tenant, params.itemId))?.haul_id ?? null;
      if (haulId !== null) await lockHauls(trx, tenant, [haulId]);
      const row = await lockItem(trx, tenant, params.itemId);
      if (!row) throw notFound('Item');
      await assertDeletable(trx, tenant, row.id, query.leaveListings === true);
      // Read before the delete cascades to them, so their objects can be deleted afterwards.
      const itemPhotos = await listPhotoRows(trx, tenant, row.id);
      await deleteItem(trx, tenant, row);
      // The item's own history goes with it, so this entry is not linked to the item.
      await writeAudit(trx, tenant, {
        action: 'item.deleted',
        changes: { itemId: row.id, sku: row.sku },
      });
      // The items still in its haul move up a place, so their shares may change.
      if (row.haul_id !== null) {
        if (row.haul_id !== haulId) await lockHauls(trx, tenant, [row.haul_id]);
        await settleHaul(trx, tenant, row.haul_id);
      }
      return itemPhotos;
    });
    await deletePhotoObjects(deps.storage, photos, request.log);
    return { status: 204 };
  });
}

/**
 * Refuses a delete that would lose something (contract: `deleteItem`): a sale's records, a change
 * still on its way to a marketplace, or, unless the seller chose to leave them up, a listing that
 * may be live. A listing already off its marketplace never stops it.
 */
async function assertDeletable(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string,
  leaveListings: boolean,
): Promise<void> {
  if (await hasSale(db, tenant, itemId)) {
    throw new ApiError(
      'invalid_state_transition',
      'This item was sold, so Listora keeps it with the sale. Archive it instead.',
    );
  }
  const working = await inFlightOperationMarketplaces(db, tenant, itemId);
  if (working.length > 0) {
    throw new ApiError(
      'invalid_state_transition',
      `Listora is still working on this item on ${marketplaceNames(working)}. ` +
        'Delete it once that is done, or cancel it.',
    );
  }
  if (leaveListings) return;
  const live = await liveListingMarketplaces(db, tenant, itemId);
  if (live.length > 0) {
    throw new ApiError(
      'invalid_state_transition',
      `This item is still listed on ${marketplaceNames(live)}. End those listings first, or ` +
        'remove it from Listora only and leave them up.',
    );
  }
}

/** "Poshmark", "eBay and Poshmark": the marketplaces as the seller reads them. */
function marketplaceNames(marketplaces: readonly Marketplace[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(
    marketplaces.map((marketplace) => MARKETPLACE_NAMES[marketplace]),
  );
}

/** What the item's accepted analysis proposed, when it has one that completed. */
async function acceptedAnalysisDetails(
  db: DbExecutor,
  tenant: Tenant,
  analysisId: string | undefined,
): Promise<AnalyzedDetails | undefined> {
  if (analysisId === undefined) return undefined;
  const analysis = await findAnalysis(db, tenant.accountId, analysisId);
  return analysis === undefined ? undefined : analysisResultOf(analysis)?.details;
}

/** Contract rules beyond the JSON Schema, plus references that must exist in this account. */
export async function assertValidDetails(
  db: DbExecutor,
  tenant: Tenant,
  itemId: string | undefined,
  details: ItemDetailsInput,
): Promise<void> {
  const errors: FieldError[] = detailErrors(details);
  if (
    details.storageLocationId !== undefined &&
    !(await storageLocationSummary(db, tenant, details.storageLocationId))
  ) {
    errors.push({
      field: 'details.storageLocationId',
      message: 'is not a storage location in this account',
    });
  }
  if (
    details.acceptedAnalysisId !== undefined &&
    (itemId === undefined ||
      !(await analysisBelongsToItem(db, tenant, itemId, details.acceptedAnalysisId)))
  ) {
    errors.push({
      field: 'details.acceptedAnalysisId',
      message: 'is not an analysis of this item',
    });
  }
  if (errors.length > 0) throw validationFailed(errors);
}

interface StatusChange {
  status: ItemStatus;
  preArchiveStatus: PreArchiveItemStatus | null;
}

/**
 * The status after a replace. `draft` and `ready` are the user's to set only while the server
 * does not own the status (it does once the item is listed or sold); `archived` needs every
 * listing to be off the marketplaces and records the status the item had. Unarchiving moves
 * an item that was `draft` or `ready` when archived, and has no sale, to whichever of `draft`
 * or `ready` is requested: both are pre-listing states the user may already move between. An
 * item that was listed, sold, or shipped, or that has a sale, stays archived, so a sold item
 * can never become available inventory again.
 */
async function nextStatus(
  db: DbExecutor,
  tenant: Tenant,
  row: InventoryItem,
  requested: UserSettableItemStatus | undefined,
): Promise<StatusChange> {
  if (requested === undefined || requested === row.status) {
    return { status: row.status, preArchiveStatus: row.pre_archive_status };
  }
  if (row.status === 'archived') {
    const before = row.pre_archive_status;
    if (before !== 'draft' && before !== 'ready') {
      throw new ApiError(
        'invalid_state_transition',
        'This item was listed, sold, or shipped before it was archived, so it stays archived.',
      );
    }
    if (await hasSale(db, tenant, row.id)) {
      throw new ApiError(
        'invalid_state_transition',
        'This item has been sold, so it stays archived.',
      );
    }
    return { status: requested, preArchiveStatus: null };
  }
  if (requested === 'archived') {
    if (await hasLiveListing(db, tenant, row.id)) {
      throw new ApiError(
        'invalid_state_transition',
        'This item is live on a marketplace. End its listings before archiving it.',
      );
    }
    return { status: requested, preArchiveStatus: row.status };
  }
  if (row.status === 'draft' || row.status === 'ready') {
    return { status: requested, preArchiveStatus: null };
  }
  throw new ApiError(
    'invalid_state_transition',
    `This item is ${row.status.replaceAll('_', ' ')}; its status now follows its listings and sales.`,
  );
}

/**
 * An item in a haul costs its share of the haul (docs/features/hauls.md): only the haul changes
 * it, so a replace must send the cost the item has.
 */
function assertHaulCostKept(row: InventoryItem, details: ItemDetailsInput): void {
  if (row.haul_id === null) return;
  if (details.cost?.amountCents === row.cost_cents) return;
  throw validationFailed([
    {
      field: 'details.cost',
      message: "is this item's share of its haul; change the haul, or take the item out of it",
    },
  ]);
}

export function versionConflict(): ApiError {
  return new ApiError(
    'version_conflict',
    'This item was changed since you loaded it. Reload it and try again.',
  );
}

/** The database's last word on references and SKUs, for races the checks above cannot see. */
export function translateWriteError(error: unknown): unknown {
  if (error instanceof SkuAllocationError) {
    return new ApiError(
      'invalid_state_transition',
      'This account has used all of its SKU numbers.',
      {
        cause: error,
      },
    );
  }
  if (
    isPgError(
      error,
      PG_ERROR.foreignKeyViolation,
      'inventory_item_account_id_storage_location_id_fkey',
    )
  ) {
    return validationFailed([
      { field: 'details.storageLocationId', message: 'is not a storage location in this account' },
    ]);
  }
  if (
    isPgError(
      error,
      PG_ERROR.foreignKeyViolation,
      'inventory_item_account_id_id_accepted_analysis_id_fkey',
    )
  ) {
    return validationFailed([
      { field: 'details.acceptedAnalysisId', message: 'is not an analysis of this item' },
    ]);
  }
  return error;
}
