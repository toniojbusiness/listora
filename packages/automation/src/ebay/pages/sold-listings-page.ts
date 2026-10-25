/**
 * Seller Hub's sold listings (`/sh/lst/sold`), newest first, a page at a time (`?offset=N`, with
 * a "Next" link while more follow): each sale's order number, the item number that sold, the
 * price it sold for, and when. The page also shows the buyer and where the item ships; Listora
 * never reads those, and failure screenshots black them out.
 */
import type { PageDriver } from '../../runner/types.ts';
import { EBAY_ITEM_ID, EBAY_PATHS } from '../site.ts';
import { absolute, changed, ebayTimeIn, parsePrice, type EbaySite } from './common.ts';

export const SOLD_LISTINGS_PAGE = {
  list: '[data-testid="sold-listings"]',
  row: '[data-testid="sold-listings"] [data-testid="sold-row"]',
  order: '[data-testid="sold-listings"] [data-testid="sold-row"] [data-testid="sold-row__order"]',
  price: '[data-testid="sold-listings"] [data-testid="sold-row"] [data-testid="sold-row__price"]',
  soldAt: '[data-testid="sold-listings"] [data-testid="sold-row"] [data-testid="sold-row__date"]',
  next: 'a[data-testid="pagination__next"]',
} as const;

const PAGE = 'sold listings page';

/** eBay's order numbers: `12-34567-89012`, as the Fulfillment API names orders too. */
export const EBAY_ORDER_ID = /^\d{2}-\d{5}-\d{5}$/;

export interface SoldRow {
  orderId: string;
  itemId: string;
  priceCents: number;
  soldAt: Date;
}

export interface SoldListingsPage {
  rows: SoldRow[];
  hasMore: boolean;
}

/** Opens the page of sold listings that starts at `offset` and reads its rows. */
export async function readSoldListingsPage(
  page: PageDriver,
  site: EbaySite,
  offset: number,
): Promise<SoldListingsPage> {
  await page.goto(absolute(site, EBAY_PATHS.sold(offset)));
  if (!(await page.exists(SOLD_LISTINGS_PAGE.list))) {
    throw changed(PAGE, `has no list of sales (${SOLD_LISTINGS_PAGE.list})`);
  }
  const ids = await page.attributes(SOLD_LISTINGS_PAGE.row, 'data-item-id');
  const orders = await page.texts(SOLD_LISTINGS_PAGE.order);
  const prices = await page.texts(SOLD_LISTINGS_PAGE.price);
  const dates = await page.texts(SOLD_LISTINGS_PAGE.soldAt);
  if (orders.length !== ids.length || prices.length !== ids.length || dates.length !== ids.length) {
    throw changed(PAGE, 'shows sales without an order number, price, or date');
  }
  const rows = ids.map((id, index): SoldRow => {
    if (id === null || !EBAY_ITEM_ID.test(id))
      throw changed(PAGE, 'shows a sale without an item number');
    const orderId = /\d{2}-\d{5}-\d{5}/.exec(orders[index] ?? '')?.[0];
    if (orderId === undefined) throw changed(PAGE, "shows an order number Listora can't read");
    const priceCents = parsePrice(prices[index] ?? null);
    if (priceCents === null) throw changed(PAGE, "shows a price Listora can't read");
    const soldAt = ebayTimeIn(dates[index] ?? null);
    if (soldAt === null) throw changed(PAGE, "shows a sale time Listora can't read");
    return { orderId, itemId: id, priceCents, soldAt };
  });
  return { rows, hasMore: await page.exists(SOLD_LISTINGS_PAGE.next) };
}
