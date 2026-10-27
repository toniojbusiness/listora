/**
 * A listing's public page (`/listing/<title>-<id>`): the read-back of every change. It reads the
 * listing record the page embeds (`$_listing_details.listingDetails`).
 *
 * A listing that isn't on the site answers 404, and its page holds Poshmark's own record of what
 * became of it instead (`listingDetails.error`, a `PostRemovedError` whose `params.post_info`
 * names the listing and its status; read on the captain's listings, 2026-10-27): `archived` for
 * one its seller deleted, which is definitive (the listing is gone), and `hidden` for one Poshmark
 * hides, as it did with a listing it removed under its rules, which is not (Poshmark can show it
 * again). Any other page without the listing (one without that record, or no longer published)
 * reads as "not found, maybe not yet", never as "gone" (docs/features/marketplaces.md).
 *
 * After a change Poshmark reviews the listing (`status: "for_review"`, read on the captain's
 * listings, 2026-10-27: over 20 minutes after a price change). Its page still embeds the
 * listing, with the change, for its seller, but buyers get the 404 page: the listing is not live
 * while it is reviewed. So a listing under review is there to change, and as a read-back it is
 * live only once Poshmark publishes it again (an ended or sold one reads as what it is).
 */
import { z } from 'zod';

import type { RemoteListingState } from '@listora/marketplaces';

import { PageChangedError } from '../../runner/errors.ts';
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

/** Poshmark's record of a listing that isn't on the site, on its 404 page. */
const removedSchema = z.object({
  error: z.object({
    errorType: z.string(),
    params: z
      .object({ post_info: z.object({ id: z.string(), status: z.string() }).optional() })
      .optional(),
  }),
});

const listingPageSchema = z.object({
  $_listing_details: z.object({
    listingDetails: z.union([listingRecordSchema, removedSchema]).nullable().optional(),
  }),
});

/** What a listing's page shows of it. */
export type ListingPage =
  | { type: 'listing'; record: ListingRecord }
  /** Poshmark is reviewing it after a change: its seller sees it, buyers don't yet. */
  | { type: 'reviewing'; record: ListingRecord }
  /** Its seller deleted it: it is gone. */
  | { type: 'deleted' }
  /** Poshmark hides it, as it does with a listing it removed under its rules. */
  | { type: 'hidden' }
  /** No listing, and no word of what became of it. */
  | { type: 'none' };

/** Opens the listing's page and reads what it shows of the listing. */
export async function openListingPage(
  page: PageDriver,
  site: PoshmarkSite,
  id: string,
): Promise<ListingPage> {
  if (!isListingId(id)) return { type: 'none' };
  await page.goto(site.listing(id));
  const missing = page.status() === 404;
  let details: z.infer<typeof listingPageSchema>['$_listing_details']['listingDetails'];
  try {
    const state = expectShape(listingPageSchema, await readPageState(page, PAGE), PAGE);
    details = state.$_listing_details.listingDetails;
  } catch (error) {
    // A 404 page without Poshmark's record says nothing more.
    if (missing && error instanceof PageChangedError) return { type: 'none' };
    throw error;
  }
  if (details === undefined || details === null) return { type: 'none' };
  if ('error' in details) {
    const info = details.error.params?.post_info;
    if (details.error.errorType !== 'PostRemovedError' || info?.id !== id) return { type: 'none' };
    if (info.status === 'archived') return { type: 'deleted' };
    return info.status === 'hidden' ? { type: 'hidden' } : { type: 'none' };
  }
  if (details.id !== id) return { type: 'none' };
  if (details.status === 'for_review') return { type: 'reviewing', record: details };
  if (details.status !== 'published') return { type: 'none' };
  return { type: 'listing', record: details };
}

/**
 * Opens the listing's page and reads its record (one under review too); `null` when the page
 * shows no such listing.
 */
export async function openListing(
  page: PageDriver,
  site: PoshmarkSite,
  id: string,
): Promise<ListingRecord | null> {
  const shown = await openListingPage(page, site, id);
  return shown.type === 'listing' || shown.type === 'reviewing' ? shown.record : null;
}

/** The listing as a read-back. */
export async function readListing(
  page: PageDriver,
  site: PoshmarkSite,
  id: string,
): Promise<RemoteListingState> {
  return remoteState(await openListingPage(page, site, id), site);
}

/**
 * What a listing's page shows, as a read-back: only a deleted listing is definitely gone, and
 * one under review that is for sale is not live yet.
 */
export function remoteState(shown: ListingPage, site: PoshmarkSite): RemoteListingState {
  if (shown.type === 'listing') return remoteListing(shown.record, site, PAGE);
  if (shown.type === 'reviewing') {
    const listing = remoteListing(shown.record, site, PAGE);
    return listing.status === 'active' ? { found: false, authoritative: false } : listing;
  }
  return { found: false, authoritative: shown.type === 'deleted' };
}

/** The listing as its seller has it, whether or not Poshmark is reviewing it. */
export function sellersListing(shown: ListingPage, site: PoshmarkSite): RemoteListingState {
  return shown.type === 'reviewing'
    ? remoteListing(shown.record, site, PAGE)
    : remoteState(shown, site);
}
