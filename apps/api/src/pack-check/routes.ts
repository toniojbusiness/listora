import { randomBytes } from 'node:crypto';

import { queueLabelReads } from '@listora/automation';
import { inTransaction, type DbExecutor } from '@listora/db';
import {
  checkScan,
  loadPackCheckSettings,
  loadPackOrders,
  loadPackOrdersById,
  packOrder,
  PackOrderClosedError,
  PackOrderNotFoundError,
  PackOrderPackedError,
  PackRefusedError,
  removePackPhoto,
  savePackCheckSettings,
  savePackPhoto,
  unpackOrder,
  verdictWords,
  type PackOrderRecord,
} from '@listora/pack-check';
import { PUBLIC_CACHE_CONTROL, processImage, UnusableImageError } from '@listora/photos';
import type { ObjectStorage } from '@listora/storage';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { contractRoute, type RouteDependencies } from '../contract/routes.ts';
import { ApiError, notFound, validationFailed } from '../errors.ts';
import { coverPhotoRows } from '../items/repository.ts';
import type { PhotoUploads } from '../photos/uploads.ts';
import type { Tenant } from '../tenancy.ts';

import { packOrderView, packScanView, type PackViewContext } from './views.ts';

export interface PackCheckRouteDependencies extends RouteDependencies {
  /** Item photo URLs, and where package photos are kept. */
  storage: ObjectStorage;
  /** Where package photos come from. */
  uploads: PhotoUploads;
  now: () => Date;
}

/**
 * Pack check (docs/features/pack-check.md): the setting, the to-ship list, label reads, scans,
 * packing, and the package photo. Nothing here changes anything on a marketplace: label reads
 * only read the marketplaces' order pages, on the seller's iPhone.
 */
export function registerPackCheckRoutes(
  app: FastifyInstance,
  deps: PackCheckRouteDependencies,
): void {
  contractRoute(app, deps, 'getPackCheckSettings', async ({ tenant, db }) => ({
    status: 200,
    body: await loadPackCheckSettings(db, tenant.accountId),
  }));

  contractRoute(app, deps, 'replacePackCheckSettings', async ({ tenant, db, body }) => {
    const saved = await savePackCheckSettings(db, tenant.accountId, { enabled: body.enabled });
    // Turned on: the labels of the orders that wait now are read at once.
    if (saved.enabled) await queueLabelReads(db, { accountId: tenant.accountId, now: deps.now() });
    return { status: 200, body: saved };
  });

  contractRoute(app, deps, 'listPackOrders', async ({ tenant, db }) => {
    const now = deps.now();
    const orders = await loadPackOrders(db, tenant.accountId, now);
    return {
      status: 200,
      body: {
        data: await views(db, tenant, deps, orders, now),
        generatedAt: now.toISOString(),
      },
    };
  });

  contractRoute(app, deps, 'refreshPackLabels', async ({ tenant, db }) => {
    const queued = await queueLabelReads(db, { accountId: tenant.accountId, now: deps.now() });
    const reading = queued.filter((read) => read.where === 'phone');
    return {
      status: 200,
      body: {
        orders: reading.reduce((sum, read) => sum + read.orders, 0),
        marketplaces: reading.map((read) => read.marketplace),
      },
    };
  });

  contractRoute(app, deps, 'checkPackScan', async ({ tenant, db, query }) => {
    if (query.label === undefined && query.sticker === undefined) {
      throw validationFailed([{ field: 'label', message: 'scan a label or a sticker' }]);
    }
    const now = deps.now();
    try {
      const checked = await checkScan(db, tenant.accountId, query);
      const context = await viewContext(db, tenant, deps, [...checked.orders.values()], now);
      return { status: 200, body: packScanView(checked, context) };
    } catch (error) {
      if (error instanceof PackOrderNotFoundError) throw notFound('Order');
      throw error;
    }
  });

  contractRoute(app, deps, 'packOrder', async ({ tenant, db, params, body }) => {
    const now = deps.now();
    try {
      await inTransaction(db, (trx) =>
        packOrder(trx, tenant.accountId, {
          saleId: params.saleId,
          label: body.label,
          sticker: body.sticker,
          photoCheck: body.photoCheck,
          userId: tenant.userId,
        }),
      );
    } catch (error) {
      if (error instanceof PackOrderNotFoundError) throw notFound('Order');
      if (error instanceof PackOrderClosedError || error instanceof PackOrderPackedError) {
        throw new ApiError('invalid_state_transition', error.message, { cause: error });
      }
      if (error instanceof PackRefusedError) {
        const words = verdictWords(error.verdict, now);
        throw new ApiError('pack_refused', `${words.headline} ${words.detail}`, { cause: error });
      }
      throw error;
    }
    return { status: 200, body: await oneView(db, tenant, deps, params.saleId, now) };
  });

  contractRoute(app, deps, 'unpackOrder', async ({ tenant, db, params, request }) => {
    const removed = await inTransaction(db, (trx) =>
      unpackOrder(trx, tenant.accountId, params.saleId),
    );
    if (removed === undefined) throw notFound('Packed order');
    if (removed.photoKey !== null) await deletePhoto(deps.storage, removed.photoKey, request.log);
    return { status: 200, body: await oneView(db, tenant, deps, params.saleId, deps.now()) };
  });

  contractRoute(app, deps, 'addPackPhoto', async ({ tenant, db, params, body }) => {
    const now = deps.now();
    await inTransaction(db, async (trx) => {
      const packed = await trx
        .selectFrom('sale_pack')
        .select(['photo_key'])
        .where('account_id', '=', tenant.accountId)
        .where('sale_id', '=', params.saleId)
        .forUpdate()
        .executeTakeFirst();
      if (packed === undefined) {
        const sale = await trx
          .selectFrom('sale')
          .select('id')
          .where('account_id', '=', tenant.accountId)
          .where('id', '=', params.saleId)
          .executeTakeFirst();
        if (sale === undefined) throw notFound('Order');
        throw new ApiError('invalid_state_transition', 'Pack this order before adding its photo.');
      }
      if (packed.photo_key !== null) {
        throw new ApiError(
          'invalid_state_transition',
          'This package has a photo. Remove it first to take another.',
        );
      }
      const claim = await deps.uploads.claim(trx, tenant, body.uploadFileId);
      switch (claim.status) {
        case 'not_found':
          throw notFound('Upload file');
        case 'incomplete':
          throw new ApiError(
            'upload_incomplete',
            'This photo has not finished uploading. Upload it again.',
          );
        case 'expired':
          throw new ApiError('upload_expired', 'This upload has expired. Take the photo again.');
        case 'attached':
          throw new ApiError('already_exists', 'This uploaded file is already used.');
        case 'ready':
          break;
      }
      const bytes = await deps.storage.get(claim.file.storageKey);
      if (bytes === undefined) {
        throw new ApiError(
          'upload_incomplete',
          'This photo has not finished uploading. Upload it again.',
        );
      }
      let image;
      try {
        image = await processImage(bytes);
      } catch (error) {
        if (error instanceof UnusableImageError) throw validationFailed([], error.message);
        throw error;
      }
      // The listing-size image: upright, at most 1600 px, without any metadata (no location).
      const key = packPhotoKey();
      await deps.storage.put(key, image.derivatives.listing.bytes, {
        contentType: 'image/jpeg',
        cacheControl: PUBLIC_CACHE_CONTROL,
      });
      const saved = await savePackPhoto(trx, tenant.accountId, params.saleId, key);
      if (saved !== 'saved') throw new Error(`the package photo was not saved: ${saved}`);
      // The upload may carry the photo's location; only the stripped copy is kept. A failure
      // leaves it to the uploads' own expiry and the account's deletion.
      await deps.storage.delete(claim.file.storageKey).catch(() => undefined);
    });
    return { status: 200, body: await oneView(db, tenant, deps, params.saleId, now) };
  });

  contractRoute(app, deps, 'removePackPhoto', async ({ tenant, db, params, request }) => {
    const key = await removePackPhoto(db, tenant.accountId, params.saleId);
    if (key === undefined) throw notFound('Package photo');
    await deletePhoto(deps.storage, key, request.log);
    return { status: 200, body: await oneView(db, tenant, deps, params.saleId, deps.now()) };
  });
}

/**
 * A package photo's key: public under an unguessable name, as an item's listing photos are, so
 * the app (and a claim the seller files) can show it; deleted with the package's record or the
 * account (docs/features/pack-check.md, "Data").
 */
function packPhotoKey(): string {
  return `public/${randomBytes(16).toString('hex')}/package.jpg`;
}

async function deletePhoto(
  storage: ObjectStorage,
  key: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await storage.delete(key);
  } catch (error) {
    log.warn({ err: error }, 'could not delete a removed package photo');
  }
}

async function viewContext(
  db: DbExecutor,
  tenant: Tenant,
  deps: PackCheckRouteDependencies,
  orders: readonly PackOrderRecord[],
  now: Date,
): Promise<PackViewContext> {
  const itemIds = [...new Set(orders.flatMap((order) => order.items.map((item) => item.itemId)))];
  const [covers, reads] = await Promise.all([
    coverPhotoRows(db, tenant, itemIds),
    db
      .selectFrom('phone_work')
      .select('marketplace')
      .where('account_id', '=', tenant.accountId)
      .where('purpose', '=', 'label_read')
      .execute(),
  ]);
  return {
    covers,
    storage: deps.storage,
    reading: new Set(reads.map((read) => read.marketplace)),
    now,
  };
}

async function views(
  db: DbExecutor,
  tenant: Tenant,
  deps: PackCheckRouteDependencies,
  orders: readonly PackOrderRecord[],
  now: Date,
) {
  const context = await viewContext(db, tenant, deps, orders, now);
  return orders.map((order) => packOrderView(order, context));
}

async function oneView(
  db: DbExecutor,
  tenant: Tenant,
  deps: PackCheckRouteDependencies,
  saleId: string,
  now: Date,
) {
  const [order] = await loadPackOrdersById(db, tenant.accountId, [saleId]);
  if (order === undefined) throw notFound('Order');
  const [view] = await views(db, tenant, deps, [order], now);
  if (view === undefined) throw notFound('Order');
  return view;
}
