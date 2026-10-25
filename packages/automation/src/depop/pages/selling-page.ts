/**
 * The seller's listings for sale (`/sellinghub/selling/`), newest first, a page at a time
 * (`?page=N`). The page embeds each product as product pages do (page-data.ts), with its text,
 * price, status, and last change, so a row reads exactly as its product page would. Listings
 * that sold or were deleted are not on it.
 */
import { z } from 'zod';

import type { PageDriver } from '../../runner/types.ts';
import { DEPOP_PATHS } from '../site.ts';
import { absolute, type DepopSite } from './common.ts';
import {
  expectShape,
  productRead,
  productRecordSchema,
  readPageProps,
  type ProductRead,
} from './page-data.ts';

const PAGE = 'selling page';

const sellingPageSchema = z.object({
  products: z.array(productRecordSchema),
  hasMore: z.boolean(),
});

export interface SellingPage {
  products: ProductRead[];
  hasMore: boolean;
}

/** Opens one page of the seller's listings for sale and reads it. */
export async function readSellingPage(
  page: PageDriver,
  site: DepopSite,
  pageNumber: number,
): Promise<SellingPage> {
  await page.goto(absolute(site, DEPOP_PATHS.selling(pageNumber)));
  const props = expectShape(sellingPageSchema, await readPageProps(page, PAGE), PAGE);
  return {
    products: props.products.map((record) => productRead(record, site, PAGE)),
    hasMore: props.hasMore,
  };
}
