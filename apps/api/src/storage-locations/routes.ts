import type { StorageLocation, StorageLocationDetail } from '@listora/api-contract';
import { inTransaction, type DbExecutor, type ItemStatus } from '@listora/db';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyInstance } from 'fastify';

import { writeAudit } from '../audit.ts';
import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { isPgError, PG_ERROR } from '../db-errors.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { coverPhotoRows } from '../items/repository.ts';
import { photoFromRow } from '../photos/mapping.ts';
import type { Tenant } from '../tenancy.ts';
import { compareCodes, nextCode, normalizeCode, normalizeLabel } from './codes.ts';
import {
  countLocations,
  deleteLocation,
  findLocation,
  insertLocation,
  listLocationRows,
  locationCodes,
  locationItemCounts,
  locationItemRows,
  locationWithCode,
  lockItemsForMove,
  lockLocation,
  MAX_LOCATIONS,
  setItemsLocation,
  updateLocation,
  type StorageLocationRow,
} from './repository.ts';

export interface StorageLocationRouteDependencies extends RouteDependencies {
  storage: ObjectStorage;
}

/**
 * Storage bins (docs/features/storage-bins.md): `listStorageLocations`,
 * `createStorageLocation`, `getStorageLocation`, `replaceStorageLocation`,
 * `deleteStorageLocation`, `addStorageLocationItems`, `removeStorageLocationItem`. An item's
 * bin is `inventory_item.storage_location_id`; every move is in the item's history.
 */
export function registerStorageLocationRoutes(
  app: FastifyInstance,
  deps: StorageLocationRouteDependencies,
): void {
  contractRoute(app, deps, 'listStorageLocations', async ({ tenant, db }) => {
    const rows = await listLocationRows(db, tenant);
    const counts = await locationItemCounts(
      db,
      tenant,
      rows.map((row) => row.id),
    );
    return {
      status: 200,
      body: {
        data: [...rows]
          .sort((a, b) => compareCodes(a.code, b.code))
          .map((row) => locationView(row, counts.get(row.id) ?? 0)),
        nextCode: nextCode(rows.map((row) => row.code.toUpperCase())),
      },
    };
  });

  contractRoute(app, deps, 'createStorageLocation', async ({ tenant, db, body }) =>
    inTransaction(db, async (trx) => {
      const values = checkedValues(body);
      if ((await countLocations(trx, tenant)) >= MAX_LOCATIONS) {
        throw validationFailed(
          [],
          `You have ${String(MAX_LOCATIONS)} bins, the most an account can have. Delete one first.`,
        );
      }
      await refuseTakenCode(trx, tenant, values.code);
      const row = await insertLocation(trx, tenant, values).catch(translateWriteError);
      return { status: 201, body: locationView(row, 0) };
    }),
  );

  contractRoute(app, deps, 'getStorageLocation', async ({ tenant, db, params }) => {
    const row = await findLocation(db, tenant, params.storageLocationId);
    if (!row) throw notFound('Bin');
    return { status: 200, body: await detailView(db, tenant, row, deps.storage) };
  });

  contractRoute(app, deps, 'replaceStorageLocation', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const current = await lockLocation(trx, tenant, params.storageLocationId);
      if (!current) throw notFound('Bin');
      const values = checkedValues(body);
      await refuseTakenCode(trx, tenant, values.code, current.id);
      const row = await updateLocation(trx, tenant, current.id, values).catch(translateWriteError);
      const counts = await locationItemCounts(trx, tenant, [row.id]);
      return { status: 200, body: locationView(row, counts.get(row.id) ?? 0) };
    }),
  );

  contractRoute(app, deps, 'deleteStorageLocation', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      const deleted = await deleteLocation(trx, tenant, params.storageLocationId);
      if (!deleted) throw notFound('Bin');
      return { status: 204 };
    }),
  );

  contractRoute(app, deps, 'addStorageLocationItems', async ({ tenant, db, params, body }) =>
    inTransaction(db, async (trx) => {
      const location = await lockLocation(trx, tenant, params.storageLocationId);
      if (!location) throw notFound('Bin');
      const items = await lockItemsForMove(trx, tenant, body.itemIds);
      const unknown = body.itemIds.flatMap((itemId, index) =>
        items.has(itemId)
          ? []
          : [{ field: `itemIds[${String(index)}]`, message: 'is not an item in this account' }],
      );
      if (unknown.length > 0) throw validationFailed(unknown);
      const moving = [...items.values()].filter((item) => item.from !== location.id);
      await setItemsLocation(
        trx,
        tenant,
        moving.map((item) => item.id),
        location.id,
      );
      await auditMoves(trx, tenant, moving, location);
      return { status: 200, body: await detailView(trx, tenant, location, deps.storage) };
    }),
  );

  contractRoute(app, deps, 'removeStorageLocationItem', async ({ tenant, db, params }) =>
    inTransaction(db, async (trx) => {
      const location = await lockLocation(trx, tenant, params.storageLocationId);
      if (!location) throw notFound('Bin');
      const item = (await lockItemsForMove(trx, tenant, [params.itemId])).get(params.itemId);
      if (item?.from !== location.id) throw notFound('Item in this bin');
      await setItemsLocation(trx, tenant, [item.id], null);
      await writeAudit(trx, tenant, {
        itemId: item.id,
        action: 'item.storage_changed',
        changes: { storageLocation: { from: location.code, to: null } },
      });
      return { status: 200, body: await detailView(trx, tenant, location, deps.storage) };
    }),
  );
}

/** The contract's `StorageLocation` for a row and the items in it. */
export function locationView(row: StorageLocationRow, itemCount: number): StorageLocation {
  return {
    id: row.id,
    code: row.code,
    ...(row.label === null || row.label === '' ? {} : { label: row.label }),
    itemCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function detailView(
  db: DbExecutor,
  tenant: Tenant,
  row: StorageLocationRow,
  storage: ObjectStorage,
): Promise<StorageLocationDetail> {
  const [items, counts] = await Promise.all([
    locationItemRows(db, tenant, row.id),
    locationItemCounts(db, tenant, [row.id]),
  ]);
  const covers = await coverPhotoRows(
    db,
    tenant,
    items.map((item) => item.id),
  );
  return {
    location: locationView(row, counts.get(row.id) ?? 0),
    items: items.map((item) => {
      const cover = covers.get(item.id);
      const thumbnail =
        cover === undefined ? undefined : photoFromRow(cover, storage).urls?.thumbnail;
      return {
        itemId: item.id,
        sku: item.sku,
        ...(item.title === null || item.title === '' ? {} : { title: item.title }),
        status: item.status as ItemStatus,
        ...(thumbnail === undefined ? {} : { thumbnailUrl: thumbnail }),
      };
    }),
  };
}

/** One `item.storage_changed` history entry per item that moved, naming both bins by code. */
async function auditMoves(
  trx: DbExecutor,
  tenant: Tenant,
  moving: readonly { id: string; from: string | null }[],
  to: StorageLocationRow,
): Promise<void> {
  const fromIds = [...new Set(moving.flatMap((item) => (item.from === null ? [] : [item.from])))];
  const codes = await locationCodes(trx, tenant, fromIds);
  for (const item of moving) {
    await writeAudit(trx, tenant, {
      itemId: item.id,
      action: 'item.storage_changed',
      changes: {
        storageLocation: {
          from: item.from === null ? null : (codes.get(item.from) ?? null),
          to: to.code,
        },
      },
    });
  }
}

function checkedValues(body: { code: string; label?: string }): {
  code: string;
  label: string | null;
} {
  const code = normalizeCode(body.code);
  if (!code.ok) throw validationFailed([{ field: 'code', message: code.message }]);
  return { code: code.code, label: normalizeLabel(body.label) };
}

async function refuseTakenCode(
  db: DbExecutor,
  tenant: Tenant,
  code: string,
  exceptId?: string,
): Promise<void> {
  if ((await locationWithCode(db, tenant, code, exceptId)) !== undefined) throw takenCode(code);
}

function takenCode(code: string): ApiError {
  return new ApiError('already_exists', `You already have a bin ${code}. Pick another code.`);
}

/** Two requests making the same code at once: the unique constraint is the last word. */
function translateWriteError(error: unknown): never {
  if (isPgError(error, PG_ERROR.uniqueViolation, 'storage_location_account_id_code_key')) {
    throw new ApiError('already_exists', 'You already have a bin with this code.', {
      cause: error,
    });
  }
  throw error;
}
