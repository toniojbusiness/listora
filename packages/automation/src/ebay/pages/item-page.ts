/**
 * A listing's page (`/itm/<item number>`), as its seller sees it: the read-back every automated
 * eBay step is verified by, with the listing form (listing-form.ts) for the description.
 *
 * - Status: a sold notice is `sold` (the listing sold out), an ended notice `ended` (the seller
 *   ended it, or it ran out), otherwise `active`. eBay keeps an ended listing's page, so an end
 *   is confirmed by its read-back.
 * - Freshness: the listing's revision is the newest time the page shows, in milliseconds: when
 *   it was last updated ("Last updated on Oct 25, 2026 09:12:45 PDT"), ended, or sold; `0` for a
 *   listing never changed since it was listed. eBay shows these to the second, and every
 *   Listora change is its own browser session, at least two seconds after the last
 *   (`PACING_FLOOR.sessionGapMs`), so each change has a newer revision. An item number never
 *   comes back on sale (a relist is a new item number), so the times only grow.
 * - Absence: never definitive. eBay's "we looked everywhere" page could be a listing not
 *   visible yet, and eBay drops old ended listings' pages after a while.
 */
import type { RemoteListingState } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { itemIdFromPath } from '../site.ts';
import {
  changed,
  ebayTimeIn,
  expectElement,
  itemUrl,
  parsePrice,
  type EbaySite,
} from './common.ts';

export const ITEM_PAGE = {
  root: '[data-testid="x-item-page"]',
  title: '[data-testid="x-item-title"]',
  price: '[data-testid="x-price-primary"]',
  itemNumber: '[data-testid="x-item-number"]',
  lastUpdated: '[data-testid="x-last-updated"]',
  ended: '[data-testid="x-ended-notice"]',
  sold: '[data-testid="x-sold-notice"]',
  notFound: '[data-testid="x-page-missing"]',
} as const;

const PAGE = 'listing page';

/** Opens the listing's page and reads it. */
export async function readItem(
  page: PageDriver,
  site: EbaySite,
  itemId: string,
): Promise<RemoteListingState> {
  await page.goto(itemUrl(site, itemId));
  if (page.status() === 404 || (await page.exists(ITEM_PAGE.notFound))) {
    return { found: false, authoritative: false };
  }
  return readShownItem(page, site);
}

/** Reads the listing page the browser shows now (after a form sent it there). */
export async function readShownItem(page: PageDriver, site: EbaySite): Promise<RemoteListingState> {
  const itemId = itemIdFromPath(new URL(page.url()).pathname);
  if (itemId === null) throw changed(PAGE, 'is not at a listing address');
  await expectElement(page, ITEM_PAGE.root, PAGE, 'listing details');
  const shownNumber = (await page.text(ITEM_PAGE.itemNumber))?.replace(/\D/g, '') ?? '';
  if (shownNumber !== itemId) throw changed(PAGE, 'shows a different item number');
  const title = await page.text(ITEM_PAGE.title);
  if (title === null || title === '') throw changed(PAGE, 'shows no title');
  const priceCents = parsePrice(await page.text(ITEM_PAGE.price));
  if (priceCents === null) throw changed(PAGE, 'shows no price Listora can read');

  const soldNotice = await page.text(ITEM_PAGE.sold);
  const endedNotice = await page.text(ITEM_PAGE.ended);
  const status = soldNotice !== null ? 'sold' : endedNotice !== null ? 'ended' : 'active';
  const times = [];
  for (const [shown, what] of [
    [await page.text(ITEM_PAGE.lastUpdated), 'last-updated time'],
    [soldNotice, 'sale time'],
    [endedNotice, 'end time'],
  ] as const) {
    if (shown === null) continue;
    const time = ebayTimeIn(shown);
    if (time === null) throw changed(PAGE, `shows a ${what} Listora can't read`);
    times.push(time.getTime());
  }
  return {
    found: true,
    externalListingId: itemId,
    externalUrl: itemUrl(site, itemId),
    status,
    title,
    // The description is in a frame of eBay's description server: the listing form reads it.
    description: null,
    priceCents,
    currency: 'USD',
    revision: Math.max(0, ...times),
  };
}
