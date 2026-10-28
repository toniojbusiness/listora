import type { Item, ItemSaleSummary, ItemSummary } from '@listora/api-contract';
import { loadDelistRuns, type DelistRunView } from '@listora/auto-delist';
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
import {
  doubleSaleRows,
  feeLineRows,
  findSale,
  pendingRelistSale,
  saleItemRows,
} from '../sales/repository.ts';
import { delistRunView, doubleSaleView, moneyOfSale } from '../sales/views.ts';
import { listingRefreshes } from '../listing-refresh/views.ts';
import type { Tenant } from '../tenancy.ts';
import { detailsFromRow, provenanceFromRow } from './details.ts';
import { storageLocationSummary } from './repository.ts';

/** What item views need besides the rows: photo URLs and each marketplace's capabilities. */
export interface ItemViewContext {
  storage: PublicUrls;
  connections: ListingViewContext;
}

/**
 * The full `Item` for a row: details, provenance, photos, storage location, its newest
 * listing on each marketplace with its honest `statusDisplay` and the actions it allows, and,
 * once it sold, its sale, the delist run of that sale (the "Sold" banner and delist results),
 * and any open double sale; after a canceled or returned sale, the relist question.
 */
export async function itemView(
  db: DbExecutor,
  tenant: Tenant,
  row: InventoryItem,
  context: ItemViewContext,
): Promise<Item> {
  const [photos, listings, location, runs, doubleSales, relistSale] = await Promise.all([
    listPhotoRows(db, tenant, row.id),
    itemListingRows(db, tenant, [row.id]).then(async (rows) => {
      const states = await listingStates(db, tenant, rows.get(row.id) ?? []);
      const refreshes = await listingRefreshes(
        db,
        tenant,
        states.map((state) => state.row.id),
        new Date(),
      );
      return states.map((state) => ({ ...state, refresh: refreshes.get(state.row.id) }));
    }),
    row.storage_location_id === null
      ? undefined
      : storageLocationSummary(db, tenant, row.storage_location_id),
    loadDelistRuns(db, tenant.accountId, { itemIds: [row.id] }),
    doubleSaleRows(db, tenant, { itemId: row.id, openOnly: true }),
    pendingRelistSale(db, tenant, row.id),
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
    photos: photos.map((photo) => photoFromRow(photo, context.storage)),
    listings: listings.map((state) => listingView(state, context.connections)),
    ...(sale ? { saleSummary: sale } : {}),
    ...(run ? { delistRun: delistRunView(run) } : {}),
    ...(doubleSale ? { doubleSale: doubleSaleView(doubleSale) } : {}),
    ...(relistSale
      ? {
          relistPrompt: {
            saleId: relistSale.id,
            saleStatus: relistSale.status,
            soldOn: relistSale.marketplace,
          },
        }
      : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The item's part of the sale its latest delist run is for, unless that sale was undone: its
 * price, and its share of the payout, profit, and ROI (estimates while `feesEstimated`).
 */
async function saleSummary(
  db: DbExecutor,
  tenant: Tenant,
  run: DelistRunView,
): Promise<ItemSaleSummary | undefined> {
  if (run.saleStatus === 'canceled' || run.saleStatus === 'returned') return undefined;
  const [sale, items, fees] = await Promise.all([
    findSale(db, tenant, run.saleId),
    saleItemRows(db, tenant, [run.saleId]).then((rows) => rows.get(run.saleId) ?? []),
    feeLineRows(db, tenant, [run.saleId]).then((rows) => rows.get(run.saleId) ?? []),
  ]);
  const line = items.find((item) => item.item_id === run.itemId);
  if (sale === undefined || line === undefined) return undefined;
  const money = moneyOfSale(sale, items, fees);
  const share = money.items.get(run.itemId);
  const usd = (amountCents: number) => ({ amountCents, currency: sale.currency });
  return {
    saleId: sale.id,
    soldOn: sale.marketplace,
    saleStatus: sale.status,
    ...(fees.length === 0 ? {} : { feesEstimated: money.feesEstimated }),
    soldAt: sale.sold_at.toISOString(),
    salePrice: { amountCents: line.sale_price_cents, currency: line.currency },
    ...(share === undefined || share.netProceedsCents === null
      ? {}
      : { netProceeds: usd(share.netProceedsCents) }),
    ...(share === undefined || share.profitCents === null
      ? {}
      : { profit: usd(share.profitCents) }),
    ...(share === undefined || share.roiBasisPoints === null
      ? {}
      : { roiBasisPoints: share.roiBasisPoints }),
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
