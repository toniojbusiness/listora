import type { Item, ItemSummary } from '@listora/api-contract';
import type { DbExecutor, InventoryItem } from '@listora/db';

import { photoFromRow, type PhotoRow, type PublicUrls } from '../photos/mapping.ts';
import { listPhotoRows } from '../photos/repository.ts';
import type { Tenant } from '../tenancy.ts';
import { detailsFromRow, provenanceFromRow } from './details.ts';
import { storageLocationSummary } from './repository.ts';

/**
 * The full `Item` for a row: details, provenance, photos, and storage location.
 *
 * `listings` is empty and `saleSummary` absent because nothing creates listings or sales yet;
 * the listing and sale tasks (T-19, T-20, T-26) fill them in, with each listing's honest
 * `statusDisplay`.
 */
export async function itemView(
  db: DbExecutor,
  tenant: Tenant,
  row: InventoryItem,
  urls: PublicUrls,
): Promise<Item> {
  const [photos, location] = await Promise.all([
    listPhotoRows(db, tenant, row.id),
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
    photos: photos.map((photo) => photoFromRow(photo, urls)),
    listings: [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function itemSummaryView(
  row: InventoryItem,
  cover: PhotoRow | undefined,
  urls: PublicUrls,
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
    listings: [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
