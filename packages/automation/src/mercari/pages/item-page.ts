/**
 * A listing's page (`/us/item/<id>/`), as its seller sees it: the read-back every automated
 * Mercari step is verified by.
 *
 * - Status: a sold badge is `sold` (sold and waiting to ship, or done), the inactive notice
 *   `ended` (the seller deactivated it), otherwise `active`.
 * - Freshness: the page's last-updated time (`time[datetime]`), in milliseconds, is the
 *   listing's revision. Mercari updates it on every change, and automated changes are seconds
 *   apart (human pacing), so it grows with every change.
 * - Absence: only Mercari's own "deleted" notice for the id is a definitive absence. A plain
 *   "not found" page could be a listing not visible yet, so it is not.
 * - The description's last line is Listora's SKU line (payload.ts); the read reports the
 *   description without it, and the SKU separately.
 */
import type { RemoteListingState } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { itemIdFromPath, MERCARI_PATHS } from '../site.ts';
import { splitSkuLine } from '../payload.ts';
import { absolute, changed, expectElement, parsePrice, type MercariSite } from './common.ts';

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
} as const;

export interface ItemRead {
  state: RemoteListingState;
  /** The SKU the description's last line names, when it has one. */
  sku: string | null;
}

export function itemUrl(site: MercariSite, id: string): string {
  return absolute(site, MERCARI_PATHS.item(id));
}

/** Opens the listing's page and reads it. */
export async function readItem(page: PageDriver, site: MercariSite, id: string): Promise<ItemRead> {
  await page.goto(itemUrl(site, id));
  if (await page.exists(ITEM_PAGE.deleted)) {
    return { state: { found: false, authoritative: true }, sku: null };
  }
  if (page.status() === 404 || (await page.exists(ITEM_PAGE.notFound))) {
    return { state: { found: false, authoritative: false }, sku: null };
  }
  return readShownItem(page, site);
}

/** Reads the listing page the browser shows now (after a form sent it there). */
export async function readShownItem(page: PageDriver, site: MercariSite): Promise<ItemRead> {
  const id = itemIdFromPath(new URL(page.url()).pathname);
  if (id === null) throw changed('listing page', 'is not at a listing address');
  await expectElement(page, ITEM_PAGE.root, 'listing page', 'listing details');
  const updated = await page.attribute(ITEM_PAGE.updated, 'datetime');
  const revision = updated === null ? Number.NaN : Date.parse(updated);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw changed('listing page', 'shows no last-updated time');
  }
  const shownPrice = await page.text(ITEM_PAGE.price);
  const priceCents = parsePrice(shownPrice);
  if (priceCents === null) throw changed('listing page', 'shows no price Listora can read');
  const shownDescription = await page.text(ITEM_PAGE.description);
  const { description, sku } = splitSkuLine(shownDescription ?? '');
  const status = (await page.exists(ITEM_PAGE.sold))
    ? 'sold'
    : (await page.exists(ITEM_PAGE.inactive))
      ? 'ended'
      : 'active';
  return {
    state: {
      found: true,
      externalListingId: id,
      externalUrl: itemUrl(site, id),
      status,
      title: await page.text(ITEM_PAGE.name),
      description: shownDescription === null ? null : description,
      priceCents,
      currency: 'USD',
      revision,
    },
    sku,
  };
}
