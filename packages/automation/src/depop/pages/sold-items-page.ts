/**
 * The seller's sold items (`/sellinghub/sold-items/`), newest first.
 *
 * Read on the seller's own session (2026-10-27): the page is an App Router page that draws its
 * list after load from Depop's own receipts query, one row per sale (a link to
 * `/sellinghub/sold-items/<purchase id>/`, the buyer, where it ships, and when it sold), with no
 * product slug in the row. A seller without sales sees a note instead. That account had no sale,
 * so only that note is known: a page with sales reads as a page Listora doesn't know yet, and
 * the sale check fails visibly instead of guessing which listing sold (a wrong guess would delist
 * that listing everywhere else).
 */
import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, changed, lookAgain, type DepopSite } from './common.ts';

export const SOLD_ITEMS_PAGE = {
  /** The note a seller without sales sees. */
  none: `p:text-is("Once you've made a sale, you'll be able to see your receipt here.")`,
  /** A sale's row links to its receipt. */
  receipt: 'a[href^="/sellinghub/sold-items/"]',
} as const;

const PAGE = 'sold items page';
/** How long the list may take to draw. */
const DRAW_MS = 10_000;
const LOOK_EVERY_MS = 500;

export interface SoldItem {
  slug: string;
  priceCents: number;
  soldAt: Date;
}

export interface SoldItemsPage {
  items: SoldItem[];
  hasMore: boolean;
}

/** Opens the seller's sold items and reads them. */
export async function readSoldItemsPage(
  page: PageDriver,
  site: DepopSite,
  pageNumber: number,
): Promise<SoldItemsPage> {
  await page.goto(absolute(site, DEPOP_PATHS.sold(pageNumber)));
  const end = Date.now() + DRAW_MS;
  for (;;) {
    if (await page.exists(SOLD_ITEMS_PAGE.none)) return { items: [], hasMore: false };
    if (await page.exists(SOLD_ITEMS_PAGE.receipt)) {
      throw changed(PAGE, 'lists sales in a way Listora cannot read yet');
    }
    if (Date.now() >= end) throw changed(PAGE, 'shows neither sales nor its no-sales note');
    await lookAgain(page, LOOK_EVERY_MS);
  }
}
