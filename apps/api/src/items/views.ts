import type { Item, ItemSaleSummary, ItemSummary } from '@listora/api-contract';
import { loadDelistRuns, type DelistRunView } from '@listora/auto-delist';
import type { DbExecutor, InventoryItem } from '@listora/db';

import type { ListingRow } from '../listings/repository.ts';
import { itemListingRows } from '../listings/repository.ts';
import { listingSummaryView, listingView } from '../listings/views.ts';
import { photoFromRow, type PhotoRow, type PublicUrls } from '../photos/mapping.ts';
import { listPhotoRows } from '../photos/repository.ts';
import { doubleSaleRows, findSale, findSaleItem } from '../sales/repository.ts';
import { delistRunView, doubleSaleView } from '../sales/views.ts';
import type { Tenant } from '../tenancy.ts';
import { detailsFromRow, provenanceFromRow } from './details.ts';
import { storageLocationSummary } from './repository.ts';

/**
 * The full `Item` for a row: details, provenance, photos, storage location, its newest
 * listing on each marketplace with its honest `statusDisplay`, and, once it sold, its sale,
 * the delist run of that sale (the "Sold" banner and delist results), and any open double sale.
 *
 * `saleSummary` has no net proceeds or profit until fees are recorded (T-26, T-40).
 */
export async function itemView(
  db: DbExecutor,
  tenant: Tenant,
  row: InventoryItem,
  urls: PublicUrls,
): Promise<Item> {
  const [photos, listings, location, runs, doubleSales] = await Promise.all([
    listPhotoRows(db, tenant, row.id),
    itemListingRows(db, tenant, [row.id]),
    row.storage_location_id === null
      ? undefined
      : storageLocationSummary(db, tenant, row.storage_location_id),
    loadDelistRuns(db, tenant.accountId, { itemIds: [row.id] }),
    doubleSaleRows(db, tenant, { itemId: row.id, openOnly: true }),
  ]);
  const run = runs.at(-1);
  const sale = run === undefined ? undefined : await saleSummary(db, tenant, run);
  const doubleSale = doubleSales.at(-1);
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
    listings: (listings.get(row.id) ?? []).map(listingView),
    ...(sale ? { saleSummary: sale } : {}),
    ...(run ? { delistRun: delistRunView(run) } : {}),
    ...(doubleSale ? { doubleSale: doubleSaleView(doubleSale) } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The item's part of the sale its latest delist run is for, unless that sale was undone. */
async function saleSummary(
  db: DbExecutor,
  tenant: Tenant,
  run: DelistRunView,
): Promise<ItemSaleSummary | undefined> {
  if (run.saleStatus === 'canceled' || run.saleStatus === 'returned') return undefined;
  const [sale, line] = await Promise.all([
    findSale(db, tenant, run.saleId),
    findSaleItem(db, tenant, run.saleId, run.itemId),
  ]);
  if (sale === undefined || line === undefined) return undefined;
  return {
    saleId: sale.id,
    soldAt: sale.sold_at.toISOString(),
    salePrice: { amountCents: line.sale_price_cents, currency: line.currency },
  };
}

export function itemSummaryView(
  row: InventoryItem,
  cover: PhotoRow | undefined,
  urls: PublicUrls,
  listings: readonly ListingRow[] = [],
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
