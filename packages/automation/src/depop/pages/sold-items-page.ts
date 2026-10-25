/**
 * The seller's sold items (`/sellinghub/sold-items/`), newest first, a page at a time
 * (`?page=N`): each sold product, its price, and when it sold. The page also shows the buyer and
 * where the item ships; Listora never reads those, and failure screenshots black them out.
 */
import { z } from 'zod';

import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, changed, type DepopSite } from './common.ts';
import { dollars, expectShape, readPageProps, soldItemSchema } from './page-data.ts';

const PAGE = 'sold items page';

const soldItemsPageSchema = z.object({
  soldItems: z.array(soldItemSchema),
  hasMore: z.boolean(),
});

export interface SoldItem {
  slug: string;
  priceCents: number;
  soldAt: Date;
}

export interface SoldItemsPage {
  items: SoldItem[];
  hasMore: boolean;
}

/** Opens one page of the seller's sold items and reads it. */
export async function readSoldItemsPage(
  page: PageDriver,
  site: DepopSite,
  pageNumber: number,
): Promise<SoldItemsPage> {
  await page.goto(absolute(site, DEPOP_PATHS.sold(pageNumber)));
  const props = expectShape(soldItemsPageSchema, await readPageProps(page, PAGE), PAGE);
  return {
    items: props.soldItems.map((item): SoldItem => {
      const soldAt = new Date(item.soldAt);
      if (Number.isNaN(soldAt.getTime())) {
        throw changed(PAGE, "shows a sale time Listora can't read");
      }
      return { slug: item.slug, priceCents: dollars(item.price, PAGE), soldAt };
    }),
    hasMore: props.hasMore,
  };
}
