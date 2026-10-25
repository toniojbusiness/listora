/**
 * The Poshmark automation adapter (decision D1, revised 2026-10-24: Poshmark permitted the
 * product owner's automation). It lists, edits, reprices, ends, and relists in the seller's own
 * Poshmark session on the browser runner, reads every change back from the listing's page, lists
 * the closet, and finds sold items for sale checks. The runner's safety rules hold for all of it
 * (human pacing, rate limits, a stop at any check, no stored password), and every step that has to
 * stop falls back to the user's assisted task. docs/features/poshmark.md describes the flows.
 *
 * How each Listora operation is done on Poshmark:
 *
 * - create: the listing form, with the item's photos in posting order, and Listora's SKU in the
 *   seller's private SKU field. An earlier attempt may have gone through, so the script first
 *   looks for a listing with the same title and SKU and reports that one instead of posting twice.
 * - revise, price: the edit form, then Update.
 * - end: availability "Not For Sale". The listing can no longer be bought, keeps its likes and
 *   comments, and comes back with a relist. Listora never deletes a Poshmark listing: a deletion
 *   cannot be read back, and Poshmark's guidelines name deleting and reposting.
 * - relist: availability "For Sale" again. A sold listing cannot be relisted.
 * - mark sold: not needed; Poshmark marks its own sales sold.
 *
 * Reads carry a revision (the listing's newest change time, pages/state.ts). Absences are never
 * authoritative (pages/listing-page.ts).
 */
import type { ListingRef, OperationRequest, RemoteOrder } from '@listora/marketplaces';
import { createPoshmarkAdapter } from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import {
  AutomationAdapter,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import type { AutomationProfile } from '../profiles.ts';
import type { StepRunner } from '../runner/types.ts';
import { loggedInSeller } from './pages/account.ts';
import { readClosetPage } from './pages/closet-page.ts';
import {
  addPhotos,
  chooseCatalog,
  chooseSizeAndCondition,
  fillSku,
  fillText,
  openForm,
  privateSku,
  setAvailability,
  setPrice,
  submit,
  type Availability,
} from './pages/listing-form.ts';
import { openListing, readListing } from './pages/listing-page.ts';
import { cents, remoteListing, revision, type ListingRecord } from './pages/state.ts';
import {
  buildPoshmarkPayload,
  validatePoshmarkPayload,
  type PoshmarkListingPayload,
} from './payload.ts';
import { listingIdFromPath, PoshmarkSite, type ClosetQuery } from './site.ts';

export interface PoshmarkAdapterOptions {
  /** Poshmark's profile; its first origin is the site (the fake Poshmark's in development). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
}

/** How far Listora looks for a listing it may have posted already (see `findBySku`). */
export const SKU_LOOKUP = {
  /** Closet pages (48 listings each, newest first) searched. */
  closetPages: 3,
  /** Listings whose private SKU is checked, newest first. */
  candidates: 12,
  /** Without a title to search for, only listings created this recently are candidates. */
  recentMs: 72 * 3_600_000,
} as const;

/** Closet pages read for a full closet listing (48 listings each). */
const CLOSET_PAGES = 50;
/** Sold-item pages read per sale check (48 each, the newest sales among them). */
const SOLD_PAGES = 5;

export function createPoshmarkAutomationAdapter(
  options: PoshmarkAdapterOptions,
): AutomationAdapter<PoshmarkListingPayload> {
  const [origin] = options.profile.origins;
  if (options.profile.marketplace !== 'poshmark' || origin === undefined) {
    throw new Error('the Poshmark adapter needs the Poshmark profile');
  }
  const site = new PoshmarkSite(origin);
  const skuOf = (listing: ListingRef): string => listing.externalSku ?? listing.listingId;

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on Poshmark yet.',
  });

  /**
   * The id of the seller's listing with this private SKU, or `null`. Poshmark can't search by
   * SKU, so the closet is searched for the title (or, without one, its recent listings are
   * taken), and each candidate's edit form shows its SKU. Newest first, within `SKU_LOOKUP`.
   */
  async function findBySku(step: StepRunner, sku: string, title?: string): Promise<string | null> {
    const username = await seller(step);
    const since = Date.now() - SKU_LOOKUP.recentMs;
    const matches = (listing: ListingRecord): boolean =>
      title === undefined ? Date.parse(listing.created_at) >= since : listing.title === title;
    const { listings } = await closet(
      step,
      username,
      { availability: 'all', newestFirst: true, ...(title === undefined ? {} : { query: title }) },
      {
        maxPages: SKU_LOOKUP.closetPages,
        enough: (found) => found.filter(matches).length >= SKU_LOOKUP.candidates,
      },
    );
    const candidates = listings
      .filter(matches)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, SKU_LOOKUP.candidates);
    for (const [index, candidate] of candidates.entries()) {
      const found = await step(
        `check the SKU of candidate ${String(index + 1)}`,
        { mutates: false },
        async (page) =>
          (await openForm(page, site.editListing(candidate.id))) &&
          (await privateSku(page)) === sku,
      );
      if (found) return candidate.id;
    }
    return null;
  }

  /** The logged-in seller's username (closets are addressed by it). */
  function seller(step: StepRunner): Promise<string> {
    return step('find the seller', { mutates: false }, (page) => loggedInSeller(page, site));
  }

  /**
   * The seller's closet for `query`, one page per step, until it ends, `maxPages` pages were
   * read, or `enough` says the listings so far suffice.
   */
  async function closet(
    step: StepRunner,
    username: string,
    query: Omit<ClosetQuery, 'maxId'>,
    limits: { maxPages: number; enough?: (listings: readonly ListingRecord[]) => boolean },
  ): Promise<{ listings: ListingRecord[]; complete: boolean }> {
    const listings: ListingRecord[] = [];
    let maxId: string | undefined;
    for (let number = 1; number <= limits.maxPages; number += 1) {
      const shown = await step(`read closet page ${String(number)}`, { mutates: false }, (page) =>
        readClosetPage(page, site, username, {
          ...query,
          ...(maxId === undefined ? {} : { maxId }),
        }),
      );
      listings.push(...shown.listings);
      if (shown.next === null) return { listings, complete: true };
      if (limits.enough?.(listings) === true) return { listings, complete: false };
      maxId = shown.next;
    }
    return { listings, complete: false };
  }

  /** The listing page a saved form led to, as an applied write with its id and revision. */
  async function applied(step: StepRunner, path: string): Promise<WriteResult> {
    const id = listingIdFromPath(path);
    if (id === null) throw new Error('Poshmark saved the listing but showed no listing page');
    return step('read the saved listing', { mutates: false }, async (page) => {
      const record = await openListing(page, site, id);
      return record === null
        ? { type: 'applied', externalListingId: id }
        : { type: 'applied', externalListingId: id, revision: revision(record, 'listing page') };
    });
  }

  /** Fills in the details of a new or changed listing, one step per part of the form. */
  async function fillListing(step: StepRunner, payload: PoshmarkListingPayload): Promise<void> {
    const { catalog, size, condition } = payload;
    if (catalog === null || size === null || condition === null) {
      // Validation refuses such a payload before any attempt; this guards the form all the same.
      throw new Error('the listing has no Poshmark catalog, size, or condition');
    }
    await step('fill in the text and prices', { mutates: false }, (page) =>
      fillText(page, payload),
    );
    await step('choose the category', { mutates: false }, (page) => chooseCatalog(page, catalog));
    await step('choose the size and condition', { mutates: false }, (page) =>
      chooseSizeAndCondition(page, size, condition),
    );
  }

  /** Saves the open form; Poshmark's validation messages are a rejection in its own words. */
  async function save(step: StepRunner, button: 'list' | 'update'): Promise<WriteResult> {
    const result = await step(button === 'list' ? 'list' : 'update', { mutates: true }, (page) =>
      submit(page, button),
    );
    if (result.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: result.message };
    }
    return applied(step, result.path);
  }

  /** Opens the listing's edit form; `false` when the listing is not there to edit. */
  async function openEditor(step: StepRunner, id: string): Promise<boolean> {
    return step('open the edit form', { mutates: false }, (page) =>
      openForm(page, site.editListing(id)),
    );
  }

  /** Sets the listing's availability (ending or relisting it), unless it already has it. */
  async function changeAvailability(
    op: OperationRequest<PoshmarkListingPayload>,
    step: StepRunner,
    availability: Availability,
  ): Promise<WriteResult> {
    const id = op.listing.externalListingId;
    if (id === null) return notListed();
    const shown = await step('open the listing', { mutates: false }, (page) =>
      readListing(page, site, id),
    );
    if (!shown.found) return notListed();
    if (availability === 'not_for_sale' && shown.status !== 'active') {
      // Already not for sale, or sold: nothing to end. The read-back decides.
      return { type: 'applied', externalListingId: id };
    }
    if (availability === 'for_sale') {
      if (shown.status === 'active') return { type: 'applied', externalListingId: id };
      if (shown.status === 'sold') {
        return {
          type: 'rejected',
          code: 'sold',
          message: 'This listing sold on Poshmark, and a sold listing cannot be relisted.',
          fixHint: 'List the item on Poshmark again as a new listing.',
        };
      }
    }
    if (!(await openEditor(step, id))) return notListed();
    await step('set the availability', { mutates: false }, (page) =>
      setAvailability(page, availability),
    );
    return save(step, 'update');
  }

  const scripts: AutomationScripts<PoshmarkListingPayload> = {
    create: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a create has a payload');
      const sku = skuOf(op.listing);
      const existing = await findBySku(step, sku, payload.title);
      if (existing !== null) return { type: 'applied', externalListingId: existing };
      const files = await step('get the photos', { mutates: false }, (_page, signal) =>
        Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
      );
      const opened = await step('open the listing form', { mutates: false }, (page) =>
        openForm(page, site.createListing()),
      );
      if (!opened) throw new Error('Poshmark showed no listing form');
      await step('add the photos', { mutates: false }, (page) => addPhotos(page, files));
      await fillListing(step, payload);
      await step('set the SKU and availability', { mutates: false }, async (page) => {
        await fillSku(page, sku);
        await setAvailability(page, 'for_sale');
      });
      return save(step, 'list');
    },
    revise: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      const id = op.listing.externalListingId;
      if (id === null || !(await openEditor(step, id))) return notListed();
      await fillListing(step, payload);
      return save(step, 'update');
    },
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents < 300 || priceCents % 100 !== 0) {
        return {
          type: 'rejected',
          code: 'out_of_range',
          message: 'Poshmark prices are whole dollars from $3.',
        };
      }
      const id = op.listing.externalListingId;
      if (id === null || !(await openEditor(step, id))) return notListed();
      await step('set the price', { mutates: false }, (page) => setPrice(page, priceCents));
      return save(step, 'update');
    },
    end: (op, step) => changeAvailability(op, step, 'not_for_sale'),
    relist: (op, step) => changeAvailability(op, step, 'for_sale'),
    read: async (ref, step) => {
      if (ref.externalListingId !== null) {
        const id = ref.externalListingId;
        return step('read the listing', { mutates: false }, (page) => readListing(page, site, id));
      }
      const id = await findBySku(step, skuOf(ref));
      if (id === null) return { found: false, authoritative: false };
      const remote = await step('read the listing', { mutates: false }, (page) =>
        readListing(page, site, id),
      );
      // Found by SKU: a missing page is no proof the listing is gone.
      return remote.found ? remote : { found: false, authoritative: false };
    },
    health: async (step) => {
      await seller(step);
    },
    orders: async (since, step) => {
      const username = await seller(step);
      const soldAt = (listing: ListingRecord): Date =>
        new Date(listing.inventory.status_changed_at ?? listing.updated_at);
      const { listings } = await closet(
        step,
        username,
        { availability: 'sold_out' },
        // Listora has not seen the order of sold items, so every page up to the cap is read.
        { maxPages: SOLD_PAGES },
      );
      return listings.flatMap((listing): RemoteOrder[] => {
        const at = soldAt(listing);
        if (Number.isNaN(at.getTime()) || (since !== null && at < since)) return [];
        return [
          {
            // Poshmark's closet shows no order number; each listing sells once.
            externalOrderId: `listing:${listing.id}`,
            soldAt: at,
            items: [
              {
                externalListingId: listing.id,
                title: listing.title,
                priceCents: cents(listing.price_amount.val, 'closet page'),
                currency: 'USD',
              },
            ],
          },
        ];
      });
    },
    listings: async (step) => {
      const username = await seller(step);
      const { listings, complete } = await closet(
        step,
        username,
        { availability: 'all', newestFirst: true },
        { maxPages: CLOSET_PAGES },
      );
      return {
        listings: listings
          .filter((listing) => listing.status === 'published')
          .map((listing) => remoteListing(listing, site, 'closet page')),
        complete,
      };
    },
  };

  return new AutomationAdapter<PoshmarkListingPayload>({
    marketplace: 'poshmark',
    profile: options.profile,
    sessions: options.sessions,
    // Fallback tasks open the real Poshmark, where the user does the step.
    assisted: createPoshmarkAdapter(),
    scripts,
    readFreshness: 'revision',
    buildPayload: buildPoshmarkPayload,
    validate: validatePoshmarkPayload,
    logger: options.logger,
  });
}
