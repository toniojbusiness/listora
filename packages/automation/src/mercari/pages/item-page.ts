/**
 * A listing's page (`/us/item/<id>/`), as its seller sees it: the read-back every automated
 * Mercari step is verified by.
 *
 * - Status: the item's status in the page's data (STATUSES): `on_sale` is `active`, `trading`
 *   and `sold_out` are `sold`, and `stop` (what Mercari calls a listing the seller deactivated,
 *   read 2026-10-27) is `ended`.
 * - Freshness: the item's last change (`updated`, in the page's data), in milliseconds, is the
 *   listing's revision. Mercari updates it on every change, and automated changes are seconds
 *   apart (human pacing), so it grows with every change.
 * - Absence: only Mercari's own "deleted" notice for the id is a definitive absence. A plain
 *   "not found" page could be a listing not visible yet, so it is not.
 * - The description's last line is Listora's SKU line (payload.ts); the read reports the
 *   description without it, and the SKU separately.
 */
import { z } from 'zod';

import type { RemoteListingState, RemoteListingStatus } from '@listora/marketplaces';

import { splitSkuLine } from '../../adapter/sku-line.ts';
import type { PageDriver } from '../../runner/types.ts';
import { itemIdFromPath, MERCARI_PATHS } from '../site.ts';
import { absolute, changed, type MercariSite } from './common.ts';

export const ITEM_PAGE = {
  root: '[data-testid="ItemDetail"]',
  name: '[data-testid="ItemName"]',
  price: '[data-testid="ItemPrice"]',
  description: '[data-testid="ItemDescription"]',
  updated: 'time[data-testid="ItemUpdated"]',
  sold: '[data-testid="ItemSoldBadge"]',
  inactive: '[data-testid="ItemInactiveNotice"]',
  deleted: '[data-testid="ItemDeletedNotice"]',
  notFound: '[data-testid="NotFound"]',
  data: 'script#__NEXT_DATA__',
} as const;

export interface ItemRead {
  state: RemoteListingState;
  /** The SKU the description's last line names, when it has one. */
  sku: string | null;
  /** When it last sold (`lastSoldAt`), for a listing that sold. */
  soldAt: Date | null;
}

export function itemUrl(site: MercariSite, id: string): string {
  return absolute(site, MERCARI_PATHS.item(id));
}

/** Opens the listing's page and reads it. */
export async function readItem(page: PageDriver, site: MercariSite, id: string): Promise<ItemRead> {
  await page.goto(itemUrl(site, id));
  // A deleted item's page answers 410 "This item is no longer available" without the item's
  // data (seen on Listora's own test listing deleted from the captain's account, 2026-10-27).
  // A sold item's page answers 410 too, but still with its data (status `sold_out`).
  if (page.status() === 410) {
    const shown = (await page.exists(ITEM_PAGE.data)) ? await readShownItem(page, site) : null;
    return shown?.state.found === true
      ? shown
      : { state: { found: false, authoritative: true }, sku: null, soldAt: null };
  }
  if (await page.exists(ITEM_PAGE.deleted)) {
    return { state: { found: false, authoritative: true }, sku: null, soldAt: null };
  }
  if (page.status() === 404 || (await page.exists(ITEM_PAGE.notFound))) {
    return { state: { found: false, authoritative: false }, sku: null, soldAt: null };
  }
  return readShownItem(page, site);
}

/** Mercari's item statuses, as its pages' data names them. */
const STATUSES: Readonly<Record<string, RemoteListingStatus>> = {
  on_sale: 'active',
  trading: 'sold',
  sold_out: 'sold',
  stop: 'ended',
  inactive: 'ended',
  cancelled: 'ended',
  suspended: 'ended',
};

const itemRecordSchema = z.object({
  name: z.string(),
  /** In cents (`800` is $8.00). */
  price: z.number().int().nonnegative(),
  description: z.string(),
  status: z.string(),
  /** The last change, in seconds. */
  updated: z.number().int().positive(),
  /** When it last sold, in seconds; absent or 0 before it ever sold. */
  lastSoldAt: z.number().int().nonnegative().nullish(),
});

/**
 * Reads the listing page the browser shows now. Read on real item pages (2026-10-27): the page
 * is a Next.js page whose data (`__NEXT_DATA__`) holds the item as
 * `props.pageProps.serverState["ItemDetail:<id>"]`, with its name, price in cents, description,
 * status (`on_sale`, ...), and last change in seconds (the revision).
 */
export async function readShownItem(page: PageDriver, site: MercariSite): Promise<ItemRead> {
  const id = itemIdFromPath(new URL(page.url()).pathname);
  if (id === null) throw changed('listing page', 'is not at a listing address');
  const text = await page.text(ITEM_PAGE.data);
  if (text === null) throw changed('listing page', 'embeds none of the data Listora reads');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw changed('listing page', "embeds data Listora can't parse");
  }
  const parsed = z
    .object({
      props: z.object({ pageProps: z.object({ serverState: z.record(z.string(), z.unknown()) }) }),
    })
    .safeParse(data);
  if (!parsed.success) throw changed('listing page', 'has none of the listing data Listora reads');
  const raw = parsed.data.props.pageProps.serverState[`ItemDetail:${id}`];
  if (raw === undefined || raw === null)
    return { state: { found: false, authoritative: false }, sku: null, soldAt: null };
  const record = itemRecordSchema.safeParse(raw);
  if (!record.success)
    throw changed('listing page', 'shows the listing without what Listora reads');
  const status = STATUSES[record.data.status];
  if (status === undefined) throw changed('listing page', 'shows a status Listora does not know');
  const { description, sku } = splitSkuLine(record.data.description);
  return {
    state: {
      found: true,
      externalListingId: id,
      externalUrl: itemUrl(site, id),
      status,
      title: record.data.name,
      description,
      priceCents: record.data.price,
      currency: 'USD',
      revision: record.data.updated * 1000,
    },
    sku,
    soldAt: record.data.lastSoldAt ? new Date(record.data.lastSoldAt * 1000) : null,
  };
}
