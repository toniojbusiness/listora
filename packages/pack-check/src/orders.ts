/**
 * The to-ship list (docs/features/pack-check.md, "The to-ship list"): one order per package to
 * pack (`isPackOrder`), newest first, with its items (title, SKU, shelf), the buyer's
 * first name and the shipping label Listora read or the seller scanned, and whether it is
 * packed. Packed orders stay on the list for a day, so a packing session shows what it packed.
 * Computed from the account's own rows on every request; no marketplace call.
 */
import { sql } from 'kysely';

import type {
  DbExecutor,
  LabelCarrier,
  LabelOrderState,
  LabelReadStatus,
  Marketplace,
  PackMatch,
  SaleLabelSource,
  SaleStatus,
} from '@listora/db';

import { describeOrder, type DescribedItem } from './describe.ts';
import type { VerdictOrder } from './verdict.ts';

/** Sale statuses that may still need a package (`isPackOrder`). */
export const OPEN_SALE_STATUSES = [
  'detected',
  'confirmed',
] as const satisfies readonly SaleStatus[];

/**
 * Whether the sale (the query's `sale`) is a package to pack: it is open, the marketplace's order
 * page doesn't say it shipped or was canceled there (a refunded order is never one to ship), and
 * it isn't from the seller's sales history (detection source `history`: recorded only) unless
 * that page says it still waits to ship: one sold before Listora watched the marketplace and not
 * shipped yet is a package all the same.
 */
export function isPackOrder() {
  const state = (states: readonly LabelOrderState[]) =>
    sql<boolean>`exists (select 1 from sale_label as state where state.account_id = sale.account_id and state.sale_id = sale.id and state.order_state in (${sql.join(states)}))`;
  return sql<boolean>`(sale.status in (${sql.join(OPEN_SALE_STATUSES)}) and not ${state(['shipped', 'canceled'])} and (sale.detection_source <> 'history' or ${state(['to_ship'])}))`;
}
/** How long a packed order stays on the list. */
export const PACKED_SHOWN_MS = 24 * 3_600_000;
/** How far back the list reaches: an older sale that never shipped is not a package to pack. */
export const OPEN_ORDER_DAYS = 60;
/** The most orders the list holds. */
export const MAX_PACK_ORDERS = 200;

export interface PackItemRecord extends DescribedItem {
  itemId: string;
  location: { code: string; label: string | null } | null;
}

export interface PackLabelRecord {
  trackingNumber: string;
  carrier: LabelCarrier;
  source: SaleLabelSource;
}

export interface PackRecord {
  trackingNumber: string;
  matchedBy: PackMatch;
  stickerSku: string | null;
  packedAt: Date;
  photoKey: string | null;
  photoAddedAt: Date | null;
}

export interface PackOrderRecord {
  saleId: string;
  marketplace: Marketplace;
  externalOrderId: string | null;
  soldAt: Date;
  shipBy: Date | null;
  saleStatus: SaleStatus;
  items: PackItemRecord[];
  /** "the black Shaka Wear tee, 2XL" */
  description: string;
  buyerFirstName: string | null;
  label: PackLabelRecord | null;
  /** The last read of the order page for its label; `null` before the first. */
  read: { status: LabelReadStatus; error: string | null; at: Date } | null;
  pack: PackRecord | null;
}

/** The to-ship list. */
export async function loadPackOrders(
  executor: DbExecutor,
  accountId: string,
  now: Date,
): Promise<PackOrderRecord[]> {
  const sales = await executor
    .selectFrom('sale')
    .leftJoin('sale_pack as pack', (join) =>
      join.onRef('pack.account_id', '=', 'sale.account_id').onRef('pack.sale_id', '=', 'sale.id'),
    )
    .select('sale.id')
    .where('sale.account_id', '=', accountId)
    .where(isPackOrder())
    .where('sale.sold_at', '>', new Date(now.getTime() - OPEN_ORDER_DAYS * 86_400_000))
    .where((eb) =>
      eb.or([
        eb('pack.sale_id', 'is', null),
        eb('pack.packed_at', '>', new Date(now.getTime() - PACKED_SHOWN_MS)),
      ]),
    )
    .orderBy('sale.sold_at', 'desc')
    .orderBy('sale.id', 'desc')
    .limit(MAX_PACK_ORDERS)
    .execute();
  return loadPackOrdersById(
    executor,
    accountId,
    sales.map((sale) => sale.id),
  );
}

/**
 * The orders with these sale ids, in that order. An id that isn't the account's is left out, and
 * so is a packed sale past buyer data retention, whose package no longer has its tracking number
 * (docs/features/privacy.md#retention): it is done, so it is no longer an order to pack.
 */
export async function loadPackOrdersById(
  executor: DbExecutor,
  accountId: string,
  saleIds: readonly string[],
): Promise<PackOrderRecord[]> {
  if (saleIds.length === 0) return [];
  const [sales, items, labels, packs] = await Promise.all([
    executor
      .selectFrom('sale')
      .select(['id', 'marketplace', 'external_order_id', 'sold_at', 'ship_by', 'status'])
      .where('account_id', '=', accountId)
      .where('id', 'in', saleIds)
      .execute(),
    executor
      .selectFrom('sale_item')
      .innerJoin('inventory_item as item', (join) =>
        join
          .onRef('item.account_id', '=', 'sale_item.account_id')
          .onRef('item.id', '=', 'sale_item.item_id'),
      )
      .leftJoin('storage_location as location', (join) =>
        join
          .onRef('location.account_id', '=', 'item.account_id')
          .onRef('location.id', '=', 'item.storage_location_id'),
      )
      .select([
        'sale_item.sale_id',
        'item.id as item_id',
        'item.sku',
        'item.title',
        'item.brand',
        'item.category',
        'item.size_label',
        'item.colors',
        'location.code as location_code',
        'location.label as location_label',
      ])
      .where('sale_item.account_id', '=', accountId)
      .where('sale_item.sale_id', 'in', saleIds)
      .orderBy('sale_item.created_at')
      .orderBy('sale_item.id')
      .execute(),
    executor
      .selectFrom('sale_label')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('sale_id', 'in', saleIds)
      .execute(),
    executor
      .selectFrom('sale_pack')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('sale_id', 'in', saleIds)
      .execute(),
  ]);
  const byId = new Map(sales.map((sale) => [sale.id, sale]));
  const labelOf = new Map(labels.map((label) => [label.sale_id, label]));
  const packOf = new Map(packs.map((pack) => [pack.sale_id, pack]));
  const itemsOf = new Map<string, PackItemRecord[]>();
  for (const row of items) {
    const list = itemsOf.get(row.sale_id) ?? [];
    list.push({
      itemId: row.item_id,
      sku: row.sku,
      title: row.title,
      brand: row.brand,
      category: row.category,
      sizeLabel: row.size_label,
      colors: row.colors,
      location:
        row.location_code === null ? null : { code: row.location_code, label: row.location_label },
    });
    itemsOf.set(row.sale_id, list);
  }
  return saleIds.flatMap((saleId) => {
    const sale = byId.get(saleId);
    if (sale === undefined) return [];
    const orderItems = itemsOf.get(saleId) ?? [];
    const label = labelOf.get(saleId);
    const pack = packOf.get(saleId);
    if (pack?.tracking_number === null) return [];
    return [
      {
        saleId,
        marketplace: sale.marketplace,
        externalOrderId: sale.external_order_id,
        soldAt: sale.sold_at,
        shipBy: sale.ship_by,
        saleStatus: sale.status,
        items: orderItems,
        description: describeOrder(orderItems),
        buyerFirstName: label?.buyer_first_name ?? null,
        label:
          label === undefined ||
          label.tracking_number === null ||
          label.carrier === null ||
          label.source === null
            ? null
            : {
                trackingNumber: label.tracking_number,
                carrier: label.carrier,
                source: label.source,
              },
        read:
          label === undefined || label.read_status === null || label.read_at === null
            ? null
            : { status: label.read_status, error: label.read_error, at: label.read_at },
        pack:
          pack === undefined
            ? null
            : {
                trackingNumber: pack.tracking_number,
                matchedBy: pack.matched_by,
                stickerSku: pack.sticker_sku,
                packedAt: pack.packed_at,
                photoKey: pack.photo_key,
                photoAddedAt: pack.photo_added_at,
              },
      },
    ];
  });
}

/** An order as a verdict names it. */
export function verdictOrder(order: PackOrderRecord): VerdictOrder {
  return {
    saleId: order.saleId,
    description: order.description,
    skus: order.items.map((item) => item.sku),
  };
}

/**
 * Whether a tracking number column matches a scanned canonical code: the same number, or a
 * longer barcode ending with it (`scanMatchesTracking`, in SQL). Both are letters and digits
 * only, so the pattern has no wildcard but the one added.
 */
export function matchesScan(column: string, scanned: string) {
  return sql<boolean>`(${sql.ref(column)} = ${scanned} or (char_length(${sql.ref(column)}) >= 10 and ${scanned} like '%' || ${sql.ref(column)}))`;
}

/** The open orders whose label is the scanned one. */
export async function openSalesWithLabel(
  executor: DbExecutor,
  accountId: string,
  scanned: string,
): Promise<string[]> {
  const rows = await executor
    .selectFrom('sale_label as label')
    .innerJoin('sale', (join) =>
      join.onRef('sale.account_id', '=', 'label.account_id').onRef('sale.id', '=', 'label.sale_id'),
    )
    .select('sale.id')
    .where('label.account_id', '=', accountId)
    .where('label.tracking_number', 'is not', null)
    .where(matchesScan('label.tracking_number', scanned))
    .where(isPackOrder())
    .orderBy('sale.sold_at', 'desc')
    .execute();
  return rows.map((row) => row.id);
}

/** The package the scanned label already went on, if any. */
export async function packWithLabel(
  executor: DbExecutor,
  accountId: string,
  scanned: string,
): Promise<{ saleId: string; packedAt: Date } | undefined> {
  const row = await executor
    .selectFrom('sale_pack')
    .select(['sale_id', 'packed_at'])
    .where('account_id', '=', accountId)
    .where(matchesScan('tracking_number', scanned))
    .orderBy('packed_at')
    .executeTakeFirst();
  return row === undefined ? undefined : { saleId: row.sale_id, packedAt: row.packed_at };
}

/** The newest open order the item with this SKU sold in, if any. */
export async function openSaleWithSku(
  executor: DbExecutor,
  accountId: string,
  sku: string,
): Promise<string | undefined> {
  const row = await executor
    .selectFrom('sale_item')
    .innerJoin('sale', (join) =>
      join
        .onRef('sale.account_id', '=', 'sale_item.account_id')
        .onRef('sale.id', '=', 'sale_item.sale_id'),
    )
    .innerJoin('inventory_item as item', (join) =>
      join
        .onRef('item.account_id', '=', 'sale_item.account_id')
        .onRef('item.id', '=', 'sale_item.item_id'),
    )
    .select('sale.id')
    .where('sale_item.account_id', '=', accountId)
    .where('item.sku', '=', sku)
    .where(isPackOrder())
    .orderBy('sale.sold_at', 'desc')
    .executeTakeFirst();
  return row?.id;
}
