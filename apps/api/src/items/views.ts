import type { Item, ItemSummary } from '@listora/api-contract';
import type { DbExecutor, InventoryItem } from '@listora/db';

import { itemListingRows } from '../listings/repository.ts';
import {
  listingStates,
  listingSummaryView,
  listingView,
  type ListingState,
  type ListingViewContext,
} from '../listings/views.ts';
import { photoFromRow, type PhotoRow, type PublicUrls } from '../photos/mapping.ts';
import { listPhotoRows } from '../photos/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { detailsFromRow, provenanceFromRow } from './details.ts';
import { storageLocationSummary } from './repository.ts';

/** What item views need besides the rows: photo URLs and each marketplace's capabilities. */
export interface ItemViewContext {
  storage: PublicUrls;
  connections: ListingViewContext;
}

/**
 * The full `Item` for a row: details, provenance, photos, storage location, and its newest
 * listing on each marketplace with its honest `statusDisplay` and the actions it allows.
 *
 * `saleSummary` is absent because nothing records sales yet (T-20, T-26).
 */
export async function itemView(
  db: DbExecutor,
  tenant: Tenant,
  row: InventoryItem,
  context: ItemViewContext,
): Promise<Item> {
  const [photos, listings, location] = await Promise.all([
    listPhotoRows(db, tenant, row.id),
    itemListingRows(db, tenant, [row.id]).then((rows) =>
      listingStates(db, tenant, rows.get(row.id) ?? []),
    ),
    row.storage_location_id === null
      ? undefined
      : storageLocationSummary(db, tenant, row.storage_location_id),
  ]);
  const provenance = provenanceFromRow(row);
  return {
    id: row.id,
    sku: row.sku,
    status: row.status,
    version: row.version,
    details: detailsFromRow(row),
    ...(Object.keys(provenance).length > 0 ? { fieldProvenance: provenance } : {}),
    ...(location
      ? {
          // The contract requires a label; a location without one shows its code.
          storageLocation: {
            id: location.id,
            code: location.code,
            label: location.label ?? location.code,
          },
        }
      : {}),
    photos: photos.map((photo) => photoFromRow(photo, context.storage)),
    listings: listings.map((state) => listingView(state, context.connections)),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function itemSummaryView(
  row: InventoryItem,
  cover: PhotoRow | undefined,
  urls: PublicUrls,
  listings: readonly ListingState[] = [],
): ItemSummary {
  return {
    id: row.id,
    sku: row.sku,
    status: row.status,
    ...(row.title === null || row.title === '' ? {} : { title: row.title }),
    ...(row.brand === null || row.brand === '' ? {} : { brand: row.brand }),
    ...(row.size_label === null || row.size_label === '' ? {} : { sizeLabel: row.size_label }),
    ...(row.list_price_cents === null
      ? {}
      : { listPrice: { amountCents: row.list_price_cents, currency: row.currency } }),
    ...(cover ? { coverPhoto: photoFromRow(cover, urls) } : {}),
    listings: listings.map(listingSummaryView),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
