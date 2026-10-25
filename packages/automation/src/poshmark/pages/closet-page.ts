/**
 * A seller's closet (`/closet/<username>`), newest listings first: how Listora finds a listing
 * by its SKU, lists the closet for imports and drift checks, and finds sold items for sale
 * checks. Closets are public pages that embed their listing records
 * (`$_closet.listingsPostData.data`), 48 to a page, and the cursor of the next page
 * (`more.next_max_id`, when `more.is_next_max_id_present`), which the next page's `max_id` takes.
 * Scripts read one page per step, so a long closet never runs into a step's time limit.
 */
import { z } from 'zod';

import type { PageDriver } from '../../runner/types.ts';
import type { ClosetQuery, PoshmarkSite } from '../site.ts';
import { expectShape, listingRecordSchema, readPageState, type ListingRecord } from './state.ts';

const PAGE = 'closet page';

const closetSchema = z.object({
  $_closet: z.object({
    listingsPostData: z.object({
      data: z.array(listingRecordSchema),
      more: z
        .object({
          next_max_id: z.union([z.string(), z.number()]).optional(),
          is_next_max_id_present: z.boolean().optional(),
        })
        .optional(),
    }),
  }),
});

/** One closet page: its listings, and the cursor of the next page (`null` at the end). */
export async function readClosetPage(
  page: PageDriver,
  site: PoshmarkSite,
  username: string,
  query: ClosetQuery,
): Promise<{ listings: ListingRecord[]; next: string | null }> {
  await page.goto(site.closet(username, query));
  const closet = expectShape(closetSchema, await readPageState(page, PAGE), PAGE);
  const { data, more } = closet.$_closet.listingsPostData;
  const next = more?.next_max_id;
  return {
    listings: data,
    next:
      more?.is_next_max_id_present === true && next !== undefined && data.length > 0
        ? String(next)
        : null,
  };
}
