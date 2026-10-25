/**
 * A product's page (`/products/<slug>/`), as its seller sees it: the read-back every automated
 * Depop step is verified by. It reads the product the page embeds (page-data.ts).
 *
 * - Status: Depop's product status (on sale, sold, deleted). A product the seller deleted stays
 *   readable as `ended`, so an end is confirmed by its read-back.
 * - Freshness: the product's last change time, in milliseconds, is its revision.
 * - Absence: never definitive. A page without a product (a 404) could be a listing not visible
 *   yet, as Depop says of its API too ("A newly created listing can take a short time to become
 *   retrievable").
 */
import { z } from 'zod';

import type { RemoteListingState } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { slugFromPath } from '../site.ts';
import { changed, expectElement, productUrl, type DepopSite } from './common.ts';
import { expectShape, productRead, productRecordSchema, readPageProps } from './page-data.ts';

/** The page's own element, which only a product's page has. */
export const PRODUCT_PAGE = {
  root: '[data-testid="productPage"]',
} as const;

const PAGE = 'product page';

const productPageSchema = z.object({ product: productRecordSchema.nullable().optional() });

export interface ProductPageRead {
  state: RemoteListingState;
  /** The SKU Listora's line in the text names, when it has one. */
  sku: string | null;
}

/** Opens the product's page and reads it. */
export async function readProduct(
  page: PageDriver,
  site: DepopSite,
  slug: string,
): Promise<ProductPageRead> {
  await page.goto(productUrl(site, slug));
  if (page.status() === 404) return { state: { found: false, authoritative: false }, sku: null };
  const props = expectShape(productPageSchema, await readPageProps(page, PAGE), PAGE);
  if (props.product === null || props.product === undefined) {
    return { state: { found: false, authoritative: false }, sku: null };
  }
  if (props.product.slug !== slug) throw changed(PAGE, 'shows a different product');
  const read = productRead(props.product, site, PAGE);
  return { state: read.listing, sku: read.sku };
}

/** Reads the product page the browser shows now (after a form sent it there). */
export async function readShownProduct(
  page: PageDriver,
  site: DepopSite,
): Promise<ProductPageRead> {
  const slug = slugFromPath(new URL(page.url()).pathname);
  if (slug === null) throw changed(PAGE, 'is not at a product address');
  await expectElement(page, PRODUCT_PAGE.root, PAGE, 'product details');
  const props = expectShape(productPageSchema, await readPageProps(page, PAGE), PAGE);
  if (props.product?.slug !== slug) throw changed(PAGE, 'shows no product');
  const read = productRead(props.product, site, PAGE);
  return { state: read.listing, sku: read.sku };
}
