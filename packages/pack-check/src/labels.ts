/**
 * Shipping labels read from the marketplaces (docs/features/pack-check.md, "Reading labels"):
 * which orders a read of a marketplace's order pages covers, and what it found. The read itself
 * runs where the connection's automated steps run (@listora/automation's label reads, on the
 * seller's iPhone), and only reads: it never changes anything on the marketplace.
 *
 * An order is read while it still needs a package and has no label yet, newest first, a few at a
 * time; an order whose page showed no label yet is read again after `RETRY_MS[status]`, so
 * opening the to-ship list over and over never reads a page more often than that.
 */
import { sql } from 'kysely';

import {
  LABEL_CARRIERS,
  type DbExecutor,
  type LabelCarrier,
  type LabelOrderState,
  type LabelReadStatus,
  type Marketplace,
} from '@listora/db';

import { OPEN_SALE_STATUSES } from './orders.ts';
import { canonicalTracking, carrierOf } from './tracking.ts';

/** The most orders one read covers. */
export const MAX_LABEL_READS = 10;
/** How far back a read reaches: a label is bought within days of the sale. */
export const LABEL_READ_DAYS = 30;
/** How long after a read without a label the order is read again. */
export const RETRY_MS: Readonly<Record<Exclude<LabelReadStatus, 'read'>, number>> = {
  no_label: 30 * 60_000,
  failed: 15 * 60_000,
  not_found: 6 * 3_600_000,
};

/** An order a label read covers. */
export interface LabelReadTarget {
  saleId: string;
  externalOrderId: string;
  externalListingIds: string[];
}

/** The orders of `marketplace` whose labels a read should look for now. */
export async function ordersToRead(
  executor: DbExecutor,
  accountId: string,
  marketplace: Marketplace,
  now: Date,
): Promise<LabelReadTarget[]> {
  const retryAfter = (status: keyof typeof RETRY_MS) => new Date(now.getTime() - RETRY_MS[status]);
  const rows = await executor
    .selectFrom('sale')
    .leftJoin('sale_label as label', (join) =>
      join.onRef('label.account_id', '=', 'sale.account_id').onRef('label.sale_id', '=', 'sale.id'),
    )
    .leftJoin('sale_pack as pack', (join) =>
      join.onRef('pack.account_id', '=', 'sale.account_id').onRef('pack.sale_id', '=', 'sale.id'),
    )
    .select(['sale.id', 'sale.external_order_id'])
    .select((eb) =>
      eb
        .selectFrom('sale_item')
        .innerJoin('marketplace_listing as listing', (join) =>
          join
            .onRef('listing.account_id', '=', 'sale_item.account_id')
            .onRef('listing.id', '=', 'sale_item.listing_id'),
        )
        .select(
          sql<
            string[]
          >`coalesce(array_agg(listing.external_listing_id order by listing.id) filter (where listing.external_listing_id is not null), '{}')`.as(
            'ids',
          ),
        )
        .whereRef('sale_item.account_id', '=', 'sale.account_id')
        .whereRef('sale_item.sale_id', '=', 'sale.id')
        .as('listing_ids'),
    )
    .where('sale.account_id', '=', accountId)
    .where('sale.marketplace', '=', marketplace)
    .where('sale.status', 'in', OPEN_SALE_STATUSES)
    // Shipped or canceled on the marketplace: no package to pack.
    .where((eb) =>
      eb.or([eb('label.order_state', 'is', null), eb('label.order_state', '=', 'to_ship')]),
    )
    // A sale from the sales history is read once, for whether it still waits to ship there.
    .where((eb) =>
      eb.or([
        eb('sale.detection_source', '<>', 'history'),
        eb('label.read_at', 'is', null),
        eb('label.order_state', '=', 'to_ship'),
      ]),
    )
    .where('sale.external_order_id', 'is not', null)
    .where('sale.sold_at', '>', new Date(now.getTime() - LABEL_READ_DAYS * 86_400_000))
    .where('pack.sale_id', 'is', null)
    .where('label.tracking_number', 'is', null)
    .where((eb) =>
      eb.or([
        eb('label.read_at', 'is', null),
        eb.and([
          eb('label.read_status', '=', 'no_label'),
          eb('label.read_at', '<=', retryAfter('no_label')),
        ]),
        eb.and([
          eb('label.read_status', '=', 'failed'),
          eb('label.read_at', '<=', retryAfter('failed')),
        ]),
        eb.and([
          eb('label.read_status', '=', 'not_found'),
          eb('label.read_at', '<=', retryAfter('not_found')),
        ]),
      ]),
    )
    .orderBy('sale.sold_at', 'desc')
    .limit(MAX_LABEL_READS)
    .execute();
  return rows.flatMap((row) =>
    row.external_order_id === null
      ? []
      : [
          {
            saleId: row.id,
            externalOrderId: row.external_order_id,
            externalListingIds: row.listing_ids ?? [],
          },
        ],
  );
}

/** What a read found for one order. */
export type LabelReadResult =
  | ({ saleId: string; status: 'read'; trackingNumber: string } & FoundOrder)
  | ({ saleId: string; status: 'no_label' } & FoundOrder)
  | { saleId: string; status: 'not_found' }
  | { saleId: string; status: 'failed'; error: string };

/** What the page of an order it found says, besides its label's tracking number. */
export interface FoundOrder {
  buyerFirstName: string | null;
  /** How the order stands on the marketplace, when the page says. */
  orderState?: LabelOrderState;
  /** The label's carrier in the page's words (`USPS`). */
  carrierName?: string | null;
  shipBy?: Date | null;
  labelExpiresAt?: Date | null;
  /** The label's file on the marketplace's own site, when the page names one. */
  labelFileUrl?: string | null;
}

/**
 * Records what a read found. A label the marketplace shows replaces one the seller scanned (the
 * marketplace's own page is the truth; a packed order whose package has another label then shows
 * it, `labelMismatch` in the views). A read that found no label keeps a label already known.
 * How the order stands there decides whether it is a package to pack (`isPackOrder`), and the
 * date it must ship by becomes the sale's.
 */
export async function recordLabelReads(
  executor: DbExecutor,
  accountId: string,
  results: readonly LabelReadResult[],
  now: Date,
): Promise<void> {
  for (const result of results) {
    const found = result.status === 'read' || result.status === 'no_label' ? result : null;
    const firstName = found === null ? null : cleanFirstName(found.buyerFirstName);
    const tracking = result.status === 'read' ? canonicalTracking(result.trackingNumber) : null;
    // A page whose label isn't a tracking number Listora can use counts as no label yet.
    const status: LabelReadStatus =
      result.status === 'read' && tracking === null ? 'no_label' : result.status;
    const error = result.status === 'failed' ? result.error.slice(0, 200) || 'failed' : null;
    const label =
      tracking === null
        ? {}
        : {
            tracking_number: tracking,
            carrier: namedCarrier(found?.carrierName) ?? carrierOf(tracking),
            source: 'marketplace' as const,
            label_expires_at: found?.labelExpiresAt ?? null,
            label_file_url: labelFileUrl(found?.labelFileUrl),
          };
    const name = firstName === null ? {} : { buyer_first_name: firstName };
    const state = found?.orderState === undefined ? {} : { order_state: found.orderState };
    await executor
      .insertInto('sale_label')
      .values({
        account_id: accountId,
        sale_id: result.saleId,
        read_status: status,
        read_error: error,
        read_at: now,
        ...label,
        ...name,
        ...state,
      })
      .onConflict((conflict) =>
        conflict.columns(['account_id', 'sale_id']).doUpdateSet({
          read_status: status,
          read_error: error,
          read_at: now,
          ...label,
          ...name,
          ...state,
        }),
      )
      .execute();
    if (found?.shipBy !== undefined && found.shipBy !== null) {
      await executor
        .updateTable('sale')
        .set({ ship_by: found.shipBy })
        .where('account_id', '=', accountId)
        .where('id', '=', result.saleId)
        .execute();
    }
  }
}

/** The longest label file URL Listora keeps (`sale_label.label_file_url`). */
const MAX_LABEL_FILE_URL = 2_048;

/**
 * A label file's URL Listora can keep, or none: the read took it only from the marketplace's own
 * site, which is https (a local stand-in's http in development).
 */
function labelFileUrl(url: string | null | undefined): string | null {
  if (url === undefined || url === null || url.length > MAX_LABEL_FILE_URL) return null;
  const protocol = URL.canParse(url) ? new URL(url).protocol : null;
  return protocol === 'https:' || protocol === 'http:' ? url : null;
}

/** A carrier Listora knows by the name a page gives it (`USPS`). */
function namedCarrier(name: string | null | undefined): LabelCarrier | null {
  const shown = name?.trim().toLowerCase() ?? '';
  return (LABEL_CARRIERS as readonly string[]).includes(shown) && shown !== 'other'
    ? (shown as LabelCarrier)
    : null;
}

/** The buyer's first name only, as a page shows it ("Sarah M." is "Sarah"). */
export function cleanFirstName(name: string | null): string | null {
  const first =
    name
      ?.trim()
      .split(/\s+/)[0]
      ?.replace(/[^\p{L}\p{M}'-]/gu, '') ?? '';
  if (first === '') return null;
  return first.slice(0, 40);
}
