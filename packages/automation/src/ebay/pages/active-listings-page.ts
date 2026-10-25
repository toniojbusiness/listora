/**
 * Seller Hub's active listings (`/sh/lst/active`), newest first, a page at a time (`?offset=N`,
 * with a "Next" link while more follow). Each row shows the listing's item number, title, Custom
 * label (SKU), and price; not its description or last update, so a listing read here is never a
 * read-back. Listings that sold or ended are not on it.
 */
import type { PageDriver } from '../../runner/types.ts';
import { EBAY_ITEM_ID, EBAY_PATHS } from '../site.ts';
import { absolute, changed, parsePrice, type EbaySite } from './common.ts';

export const ACTIVE_LISTINGS_PAGE = {
  list: '[data-testid="active-listings"]',
  row: '[data-testid="active-listings"] [data-testid="listing-row"]',
  title:
    '[data-testid="active-listings"] [data-testid="listing-row"] [data-testid="listing-row__title"]',
  customLabel:
    '[data-testid="active-listings"] [data-testid="listing-row"] [data-testid="listing-row__custom-label"]',
  price:
    '[data-testid="active-listings"] [data-testid="listing-row"] [data-testid="listing-row__price"]',
  next: 'a[data-testid="pagination__next"]',
} as const;

const PAGE = 'active listings page';

export interface ActiveListingRow {
  itemId: string;
  title: string;
  /** The Custom label: Listora's SKU, the seller's own, or `null` without one. */
  sku: string | null;
  priceCents: number | null;
}

export interface ActiveListingsPage {
  rows: ActiveListingRow[];
  hasMore: boolean;
}

/** Opens the page of active listings that starts at `offset` and reads its rows. */
export async function readActiveListingsPage(
  page: PageDriver,
  site: EbaySite,
  offset: number,
): Promise<ActiveListingsPage> {
  await page.goto(absolute(site, EBAY_PATHS.active(offset)));
  if (!(await page.exists(ACTIVE_LISTINGS_PAGE.list))) {
    throw changed(PAGE, `has no list of listings (${ACTIVE_LISTINGS_PAGE.list})`);
  }
  const ids = await page.attributes(ACTIVE_LISTINGS_PAGE.row, 'data-item-id');
  const titles = await page.texts(ACTIVE_LISTINGS_PAGE.title);
  const labels = await page.texts(ACTIVE_LISTINGS_PAGE.customLabel);
  const prices = await page.texts(ACTIVE_LISTINGS_PAGE.price);
  if (
    titles.length !== ids.length ||
    labels.length !== ids.length ||
    prices.length !== ids.length
  ) {
    throw changed(PAGE, 'shows rows without a title, Custom label, or price');
  }
  const rows = ids.map((id, index): ActiveListingRow => {
    if (id === null || !EBAY_ITEM_ID.test(id))
      throw changed(PAGE, 'shows a row without an item number');
    const label = labels[index] ?? '';
    return {
      itemId: id,
      title: titles[index] ?? '',
      sku: label === '' || label === '--' ? null : label,
      priceCents: parsePrice(prices[index] ?? null),
    };
  });
  return { rows, hasMore: await page.exists(ACTIVE_LISTINGS_PAGE.next) };
}
