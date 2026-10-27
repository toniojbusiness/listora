/**
 * The seller's listings (`/mypage/listings/<tab>/`), one tab per state, newest first, a page at
 * a time with a "Next" link: `active` (on sale), `inactive` (deactivated), `in_progress` (sold,
 * waiting to ship), and `sold` (done). Each row links to its listing and shows the title and
 * price; sold rows also show when the item sold (`time[datetime]`).
 *
 * Read on a real session (2026-10-26): Mercari's scripts draw a tab after its document is ready,
 * from its own API (`userItemsQuery`), and a tab with nothing in it shows `ZeroListings` instead
 * of rows. The rows' markup is not confirmed yet: that session had none.
 */
import type { PageDriver } from '../../runner/types.ts';
import { itemIdFromPath, MERCARI_PATHS, type MercariListingTab } from '../site.ts';
import { absolute, awaitElement, changed, parsePrice, type MercariSite } from './common.ts';

/**
 * Read on the captain's verified session (2026-10-27, its active tab): the tab is a table
 * (`[data-testid="Listings"]`) of `tr[data-testid="ListingRow"]` rows, each with its listing's
 * link (`a[data-testid="ItemLink"]`, the title as its text) and price (`ItemPrice`, its amount
 * in an input). The sold tabs' rows and an empty tab keep Listora's earlier model.
 */
export const LISTINGS_PAGE = {
  /** What an empty tab shows instead of its rows. */
  empty: '[data-testid="ZeroListings"]',
  list: '[data-testid="Listings"], [data-testid="ListingList"]',
  row: '[data-testid="ListingRow"]',
  link: '[data-testid="ListingRow"] a[data-testid="ItemLink"], [data-testid="ListingRow"] a[data-testid="ListingLink"]',
  name: '[data-testid="ListingRow"] a[data-testid="ItemLink"], [data-testid="ListingRow"] [data-testid="ListingName"]',
  price:
    '[data-testid="ListingRow"] [data-testid="ItemPrice"], [data-testid="ListingRow"] [data-testid="ListingPrice"]',
  soldAt: '[data-testid="ListingRow"] time[data-testid="SoldAt"]',
  next: 'a[data-testid="NextPage"]',
} as const;

/** How long a tab's rows get to draw; a tab without any by then reads as empty. */
const ROWS_MS = 8_000;

export interface ListingRow {
  id: string;
  title: string;
  priceCents: number | null;
  /** On the `in_progress` and `sold` tabs. */
  soldAt: Date | null;
}

export interface ListingsPage {
  rows: ListingRow[];
  hasNext: boolean;
}

/** Opens one page of a tab and reads its rows. */
export async function readListingsPage(
  page: PageDriver,
  site: MercariSite,
  tab: MercariListingTab,
  pageNumber: number,
  /** The tab's own path, where the site names it (the done sales', from the account page). */
  path?: string,
): Promise<ListingsPage> {
  const url =
    path === undefined
      ? absolute(site, MERCARI_PATHS.listings(tab, pageNumber))
      : absolute(site, pageNumber > 1 ? `${path}?page=${String(pageNumber)}` : path);
  await page.goto(url);
  const name = `${tab.replace('_', ' ')} listings page`;
  await awaitElement(page, `${LISTINGS_PAGE.empty}, ${LISTINGS_PAGE.list}`, name, 'listing list');
  if (await page.exists(LISTINGS_PAGE.empty)) return { rows: [], hasNext: false };
  // The table comes before its rows: they draw once Mercari's own query answers.
  const end = Date.now() + ROWS_MS;
  while (!(await page.exists(LISTINGS_PAGE.row)) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.waitFor('body', 'attached');
  }
  const sold = tab === 'in_progress' || tab === 'sold';
  const [links, titles, prices, soldAts] = await Promise.all([
    page.attributes(LISTINGS_PAGE.link, 'href'),
    page.texts(LISTINGS_PAGE.name),
    page.texts(LISTINGS_PAGE.price),
    sold ? page.attributes(LISTINGS_PAGE.soldAt, 'datetime') : Promise.resolve([]),
  ]);
  if (
    titles.length !== links.length ||
    prices.length !== links.length ||
    (sold && soldAts.length !== links.length)
  ) {
    throw changed(name, 'has rows without a link, title, price, or sold time');
  }
  const rows = links.map((href, index): ListingRow => {
    const id = href === null ? null : itemIdFromPath(new URL(href, site.origin).pathname);
    if (id === null) throw changed(name, 'has a row that links to no listing');
    const soldAt = sold ? new Date(soldAts[index] ?? '') : null;
    if (soldAt !== null && Number.isNaN(soldAt.getTime())) {
      throw changed(name, 'has a sold row without a sold time');
    }
    return {
      id,
      title: titles[index] ?? '',
      priceCents: parsePrice(prices[index] ?? null),
      soldAt,
    };
  });
  return { rows, hasNext: await page.exists(LISTINGS_PAGE.next) };
}
