/**
 * The seller's sales, for Pack check's label reads (docs/features/pack-check.md, "Reading
 * labels"). `/order/sales` opens the Seller Hub's sales list (`/seller-hub/sales`), whose
 * embedded data holds the seller's orders in `$_order_list.userSales.data.sales_summary`, with
 * `meta.count` (read on the captain's session 2026-10-27, which has no sale: `sales_summary`
 * was empty and the page said "You have not sold anything yet."). One order's own page is
 * `/order/sales/<order id>`.
 *
 * An order's own fields are not known yet, so they are read by name only
 * (adapter/label-fields.ts): its `id` (or `order_id`), the listings it names (`listing_id`,
 * `post_id`), its `tracking_number`, and its buyer's `first_name`. An order that names neither
 * an id nor a listing is a page Listora doesn't know. Only reads.
 */
import { z } from 'zod';

import { buyerFirstName, fieldValues, texts, trackingField } from '../../adapter/label-fields.ts';
import { PageChangedError } from '../../runner/errors.ts';
import type { PageDriver } from '../../runner/types.ts';
import type { PoshmarkSite } from '../site.ts';
import { expectShape, readPageState } from './state.ts';

const PAGE = 'sales page';

const salesSchema = z.object({
  $_order_list: z.object({
    userSales: z.object({
      data: z.object({ sales_summary: z.array(z.record(z.string(), z.unknown())) }),
      meta: z.object({ count: z.number().optional() }).catchall(z.unknown()),
    }),
  }),
});

/** What Pack check takes from one order. */
export interface PoshmarkSale {
  orderId: string;
  listingIds: string[];
  trackingNumber: string | null;
  buyerFirstName: string | null;
}

/** The seller's sales the list shows, newest first. */
export async function readSales(page: PageDriver, site: PoshmarkSite): Promise<PoshmarkSale[]> {
  await page.goto(site.sales());
  const state = expectShape(salesSchema, await readPageState(page, PAGE), PAGE);
  return state.$_order_list.userSales.data.sales_summary.map((order) => saleOf(order, PAGE));
}

/** One order's page: its label and buyer's first name, as the order list may not show them. */
export async function readSale(
  page: PageDriver,
  site: PoshmarkSite,
  orderId: string,
): Promise<Pick<PoshmarkSale, 'trackingNumber' | 'buyerFirstName'>> {
  await page.goto(site.sale(orderId));
  const state = await readPageState(page, 'order page');
  return { trackingNumber: trackingField(state), buyerFirstName: buyerFirstName(state) };
}

function saleOf(order: Readonly<Record<string, unknown>>, where: string): PoshmarkSale {
  const [orderId] = texts([order['id'], order['order_id']]);
  const listingIds = texts(fieldValues(order, ['listing_id', 'post_id']));
  if (orderId === undefined) {
    throw new PageChangedError(`Poshmark's ${where} shows an order without an id`);
  }
  return {
    orderId,
    listingIds,
    trackingNumber: trackingField(order),
    buyerFirstName: buyerFirstName(order),
  };
}
