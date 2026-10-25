/**
 * A listing's public page (`/listing/<title>-<id>`): the read-back of every change. It reads the
 * listing record the page embeds (`$_listing_details.listingDetails`).
 *
 * Absences are never authoritative: Listora has not seen what Poshmark answers for a deleted
 * listing, so a page without the listing (a 404, a listing that is no longer published) reads as
 * "not found, maybe not yet", never as "gone" (docs/features/marketplaces.md).
 */
import { z } from 'zod';

import type { RemoteListingState } from '@listora/marketplaces';

import type { PageDriver } from '../../runner/types.ts';
import { isListingId, type PoshmarkSite } from '../site.ts';
import {
  expectShape,
  listingRecordSchema,
  readPageState,
  remoteListing,
  type ListingRecord,
} from './state.ts';

const PAGE = 'listing page';

const listingPageSchema = z.object({
  $_listing_details: z.object({ listingDetails: listingRecordSchema.nullable().optional() }),
});

/** Opens the listing's page and reads it; `null` when the page shows no such listing. */
export async function openListing(
  page: PageDriver,
  site: PoshmarkSite,
  id: string,
): Promise<ListingRecord | null> {
  if (!isListingId(id)) return null;
  await page.goto(site.listing(id));
  if (page.status() === 404) return null;
  const state = expectShape(listingPageSchema, await readPageState(page, PAGE), PAGE);
  const record = state.$_listing_details.listingDetails ?? null;
  if (record?.id !== id || record.status !== 'published') return null;
  return record;
}

/** The listing as a read-back. */
export async function readListing(
  page: PageDriver,
  site: PoshmarkSite,
  id: string,
): Promise<RemoteListingState> {
  const record = await openListing(page, site, id);
  return record === null
    ? { found: false, authoritative: false }
    : remoteListing(record, site, PAGE);
}
