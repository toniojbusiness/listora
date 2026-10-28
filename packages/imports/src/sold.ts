/**
 * Sold items for the seller's sales history (docs/features/sales.md, "Sales history"): a sale
 * check found an order whose listing no item of the account has (a sale from before Listora was
 * connected, or of a listing the seller made on the marketplace itself), so the sale gets an item
 * of its own. The item is made from the sold listing as the marketplace's sold pages showed it,
 * the way an import makes one (its title, text, details, and up to `SOLD_ITEM_PHOTOS` photos),
 * with that listing on its marketplace, sold. Without the listing, the order line's title alone
 * makes it. The sale check then records the sale on it (`recordSaleOrder` in
 * @listora/automation), which marks it sold.
 *
 * It never joins an item Listora has, even one that looks the same: a wrong match would delist
 * that item everywhere else. Nothing on the marketplace changes.
 *
 * A sold item made without photos (its order line came without the listing) gets them when a
 * later check reads the sold listing with its photos (`soldItemPhotoMaker`).
 */
import { createInventoryItem, jsonb, type DbTransaction, type JsonObject } from '@listora/db';
import type { SoldItemMaker, SoldItemPhotoMaker, SoldItemSource } from '@listora/automation';
import type { ListedListing } from '@listora/marketplaces';
import { remoteSnapshot } from '@listora/operations';
import type { Logger } from '@listora/shared';

import {
  fetchPhotos,
  fetchPhotoUrls,
  insertItemPhotos,
  type ImportApplyDependencies,
} from './apply.ts';
import {
  IMPORTED_TITLE_LIMIT,
  importedItem,
  importedListingColumns,
  type ImportedItem,
} from './details.ts';
import type { ImportedPhoto } from './photos.ts';
import { listedListing } from './read-entry.ts';

/** The photos a sold item keeps at most, cover first: enough to recognize it by. */
export const SOLD_ITEM_PHOTOS = 4;

/** A sold item ready to make: the order line, its listing, and the photos fetched for it. */
export interface PreparedSoldItem {
  source: SoldItemSource;
  listing: ListedListing | null;
  photos: ImportedPhoto[];
}

export type SoldItemDependencies = Pick<
  ImportApplyDependencies,
  'storage' | 'photos' | 'photoJobs'
> & {
  logger: Logger;
};

/** The maker the worker's sale checks make sold items with. */
export function soldItemMaker(deps: SoldItemDependencies): SoldItemMaker<PreparedSoldItem> {
  const log = deps.logger.child({ task: 'sold_item' });
  return {
    prepare: async (source) => {
      const listing = source.listing === null ? null : listedListing(source.listing);
      if (listing === null && (source.title ?? '').trim() === '') return null;
      const photos =
        listing === null ? [] : await fetchPhotos(deps, listing, log, SOLD_ITEM_PHOTOS);
      return { source, listing, photos };
    },
    create: (trx, prepared) => createSoldItem(deps, trx, prepared),
  };
}

/** The item and its sold listing, in the sale's transaction; the sale is recorded on them after. */
export async function createSoldItem(
  deps: Pick<ImportApplyDependencies, 'storage' | 'photoJobs'>,
  trx: DbTransaction,
  prepared: PreparedSoldItem,
): Promise<{ itemId: string; listingId: string | null }> {
  const { source, listing, photos } = prepared;
  const details = listing === null ? titledItem(source) : importedItem(source.marketplace, listing);
  const item = await createInventoryItem(trx, source.accountId, {
    title: details.title,
    description: details.description,
    brand: details.brand,
    category: details.category,
    department: details.department,
    size_label: details.sizeLabel,
    size_system: details.sizeSystem,
    condition: details.condition,
    colors: details.colors,
    list_price_cents: details.listPriceCents,
    status: 'ready',
    field_provenance: jsonb(
      Object.fromEntries(
        details.fromListing.map((field) => [
          field === 'listPriceCents' ? 'listPrice' : field,
          'marketplace',
        ]),
      ) as JsonObject,
    ),
  });
  await insertItemPhotos(deps, trx, source.accountId, item.id, photos);
  const externalListingId = listing?.externalListingId ?? source.externalListingId;
  let listingId: string | null = null;
  if (externalListingId !== null) {
    const columns = listing === null ? null : importedListingColumns(source.marketplace, listing);
    const now = new Date();
    const inserted = await trx
      .insertInto('marketplace_listing')
      .values({
        account_id: source.accountId,
        item_id: item.id,
        marketplace: source.marketplace,
        connection_id: source.connectionId,
        status: 'sold',
        external_listing_id: externalListingId,
        external_sku: columns?.sku ?? null,
        external_url: listing?.externalUrl ?? null,
        title: columns?.title ?? source.title,
        description: columns?.description ?? null,
        price_cents: columns?.priceCents ?? source.priceCents,
        category_ref: columns?.categoryRef ?? null,
        condition: columns?.condition ?? null,
        // The sale check's read of the sold pages is the listing's read-back.
        last_verified_at: listing === null ? null : now,
        remote_snapshot: listing === null ? null : jsonb(remoteSnapshot(listing)),
        remote_revision: listing?.revision ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    listingId = inserted.id;
  }
  await trx
    .insertInto('audit_log')
    .values({
      account_id: source.accountId,
      item_id: item.id,
      actor_kind: 'marketplace',
      action: 'item.imported',
      changes: jsonb({
        marketplace: source.marketplace,
        externalListingId,
        sold: true,
        photos: photos.length,
      }),
    })
    .execute();
  return { itemId: item.id, listingId };
}

/**
 * The photo maker of the worker's `automation_sold_item_photos` job (@listora/automation,
 * sold-photos.ts): a sold item made without photos gets its sold listing's, up to
 * `SOLD_ITEM_PHOTOS`, fetched like an import's (one that can't be fetched is left out) and
 * processed like any photo (its thumbnail and listing size).
 */
export function soldItemPhotoMaker(
  deps: SoldItemDependencies,
): SoldItemPhotoMaker<ImportedPhoto[]> {
  const log = deps.logger.child({ task: 'sold_item_photos' });
  return {
    fetch: async (photoUrls) => {
      const photos = await fetchPhotoUrls(deps, photoUrls.slice(0, SOLD_ITEM_PHOTOS), log);
      return photos.length === 0 ? null : photos;
    },
    add: async (trx, accountId, itemId, photos) => {
      await insertItemPhotos(deps, trx, accountId, itemId, photos);
      return photos.length;
    },
  };
}

/** An item from the order line alone: its title and price. */
function titledItem(source: SoldItemSource): ImportedItem {
  const title = (source.title ?? '').replace(/\s+/g, ' ').trim().slice(0, IMPORTED_TITLE_LIMIT);
  return {
    title: title === '' ? null : title,
    description: null,
    brand: null,
    category: null,
    department: null,
    sizeLabel: null,
    sizeSystem: null,
    condition: null,
    colors: [],
    listPriceCents: source.priceCents,
    fromListing: title === '' ? ['listPriceCents'] : ['title', 'listPriceCents'],
  };
}
