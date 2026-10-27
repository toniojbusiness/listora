/**
 * The Poshmark automation scripts: how each operation is done on Poshmark's pages (adapter.ts
 * describes it). They are the one definition both hosts run: the browser runner, and the
 * iPhone app for a seller whose Poshmark runs on their phone (docs/features/phone-execution.md).
 */
import type { ListingRef, OperationRequest, RemoteOrder } from '@listora/marketplaces';

import type { AutomationScripts, WriteResult } from '../adapter/script-call.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import { PageChangedError } from '../runner/errors.ts';
import type { StepRunner } from '../runner/types.ts';
import { loggedInSeller } from './pages/account.ts';
import { readClosetPage } from './pages/closet-page.ts';
import {
  addPhotos,
  chooseCatalog,
  chooseSizeAndCondition,
  fillSku,
  fillBrand,
  fillPrices,
  fillText,
  newListingId,
  openForm,
  privateSku,
  setAvailability,
  setPrice,
  submit,
  type Availability,
} from './pages/listing-form.ts';
import {
  openListing,
  openListingPage,
  readListing,
  remoteState,
  type ListingPage,
} from './pages/listing-page.ts';
import { cents, remoteListing, revision, type ListingRecord } from './pages/state.ts';
import { type PoshmarkListingPayload } from './payload.ts';
import type { PoshmarkSite } from './site.ts';
import { listingIdFromPath, type ClosetQuery } from './site.ts';

/** How far Listora looks for a listing it may have posted already (see `findBySku`). */
export const SKU_LOOKUP = {
  /** Closet pages (48 listings each, newest first) searched. */
  closetPages: 3,
  /** Listings whose private SKU is checked, newest first. */
  candidates: 12,
  /** Without a title to search for, only listings created this recently are candidates. */
  recentMs: 72 * 3_600_000,
} as const;

/** How often, and how far apart, a listing page that shows no listing is read again. */
const SETTLE_LOOKS = 4;
const SETTLE_WAIT_MS = 30_000;
/** How often, and how far apart, a new listing's own page is read right after List. */
const NEW_LOOKS = 3;
const NEW_WAIT_MS = 5_000;

/** Closet pages read for a full closet listing (48 listings each). */
const CLOSET_PAGES = 50;
/** Sold-item pages read per sale check (48 each, the newest sales among them). */
const SOLD_PAGES = 5;

export interface PoshmarkScriptOptions {
  /** The site the scripts drive: Poshmark, or its stand-in in development and tests. */
  site: PoshmarkSite;
  photos: PhotoSource;
  /**
   * How long between looks at a listing page that shows no listing without saying it is gone
   * (default 30 seconds, as Poshmark takes); tests shorten it.
   */
  settleWaitMs?: number;
}

export function createPoshmarkScripts(
  options: PoshmarkScriptOptions,
): AutomationScripts<PoshmarkListingPayload> {
  const { site } = options;
  const settleWaitMs = options.settleWaitMs ?? SETTLE_WAIT_MS;
  const skuOf = (listing: ListingRef): string => listing.externalSku ?? listing.listingId;

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on Poshmark yet.',
  });
  // Poshmark hides a listing it removed under its rules: nothing changes it until Poshmark
  // shows it again.
  const hiddenListing = (): WriteResult => ({
    type: 'rejected',
    code: 'hidden',
    message:
      'Poshmark is hiding this listing, as it does with a listing it removed under its rules.',
    fixHint: 'Check the listing in Poshmark.',
  });

  /**
   * The id of the seller's listing with this private SKU, or `null`. Poshmark can't search by
   * SKU, so the closet is searched for the title (or, without one, its recent listings are
   * taken), and each candidate's edit form shows its SKU. Newest first, within `SKU_LOOKUP`.
   */
  async function findBySku(
    step: StepRunner,
    sku: string,
    title?: string,
    { search = true }: { search?: boolean } = {},
  ): Promise<string | null> {
    const username = await seller(step);
    const since = Date.now() - SKU_LOOKUP.recentMs;
    const matches = (listing: ListingRecord): boolean =>
      title === undefined ? Date.parse(listing.created_at) >= since : listing.title === title;
    // Poshmark's closet search lags behind a listing just made: right after List, its newest
    // listings are read instead (`search: false`), where the new one already is.
    const query = title === undefined || !search ? {} : { query: title };
    const { listings } = await closet(
      step,
      username,
      { availability: 'all', newestFirst: true, ...query },
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
      // Each candidate's SKU is on its edit form, as heavy a page as the listing form.
      const found = await step(
        `check the SKU of candidate ${String(index + 1)}`,
        { mutates: false, timeScale: 2 },
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
    // After List, Poshmark shows the closet, which doesn't name the new listing: the
    // operation's check finds it by its SKU.
    if (id === null) return { type: 'applied' };
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
    await step('fill in the title and description', { mutates: false, timeScale: 2 }, (page) =>
      fillText(page, payload),
    );
    await step('fill in the prices', { mutates: false, timeScale: 2 }, (page) =>
      fillPrices(page, payload),
    );
    await step('fill in the brand', { mutates: false, timeScale: 2 }, (page) =>
      fillBrand(page, payload.brand),
    );
    await step('choose the category', { mutates: false, timeScale: 2 }, (page) =>
      chooseCatalog(page, catalog),
    );
    await step('choose the size and condition', { mutates: false, timeScale: 2 }, (page) =>
      chooseSizeAndCondition(page, size, condition),
    );
  }

  /** Saves the open form; Poshmark's validation messages are a rejection in its own words. */
  async function save(step: StepRunner, button: 'list' | 'update'): Promise<WriteResult> {
    // Next uploads the photos and creates the listing before the share step's List shows.
    const result = await step(
      button === 'list' ? 'list' : 'update',
      { mutates: true, timeScale: 4 },
      (page) => submit(page, button),
    );
    if (result.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: result.message };
    }
    return applied(step, result.path);
  }

  /**
   * The listing as its page shows it, read again a few times while the page shows no listing
   * without saying it is gone: right after a change, Poshmark's page showed none for about two
   * minutes (read on the seller's own listing, 2026-10-27).
   */
  async function settledListing(step: StepRunner, id: string): Promise<ListingPage> {
    for (let look = 1; ; look += 1) {
      const shown = await step('open the listing', { mutates: false }, (page) =>
        openListingPage(page, site, id),
      );
      if (shown.type === 'listing' || shown.type === 'deleted' || look === SETTLE_LOOKS) {
        return shown;
      }
      await new Promise((resolve) => setTimeout(resolve, settleWaitMs));
    }
  }

  /**
   * A listing just listed, as its own page shows it, read again for a moment while the page
   * shows none yet; `null` when it never shows the listing. A listing Poshmark hides is there
   * all the same (its page names it), so its id is known; the operation's check reads it again.
   */
  async function newListing(step: StepRunner, id: string): Promise<WriteResult | null> {
    for (let look = 1; look <= NEW_LOOKS; look += 1) {
      const shown = await step('read the new listing', { mutates: false }, (page) =>
        openListingPage(page, site, id),
      );
      if (shown.type === 'listing') {
        return {
          type: 'applied',
          externalListingId: id,
          revision: revision(shown.record, 'listing page'),
        };
      }
      if (shown.type === 'hidden') return { type: 'applied', externalListingId: id };
      if (look < NEW_LOOKS) await new Promise((resolve) => setTimeout(resolve, NEW_WAIT_MS));
    }
    return null;
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
    const page = await settledListing(step, id);
    if (page.type === 'hidden') return hiddenListing();
    const shown = remoteState(page, site);
    if (!shown.found) {
      if (!shown.authoritative) return notListed();
      // A listing Poshmark says is gone is ended already (the read-back confirms it), and
      // relisting it lists it again, as a new listing with its own id, from the item's details.
      return availability === 'not_for_sale'
        ? { type: 'applied', externalListingId: id }
        : createListing(op, step);
    }
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

  /** Lists a new listing from the payload (List, or a relist of a listing Poshmark removed). */
  async function createListing(
    op: OperationRequest<PoshmarkListingPayload>,
    step: StepRunner,
  ): Promise<WriteResult> {
    const payload = op.payload;
    if (payload === null) throw new Error('a create has a payload');
    const sku = skuOf(op.listing);
    const existing = await findBySku(step, sku, payload.title);
    if (existing !== null) return { type: 'applied', externalListingId: existing };
    const files = await step('get the photos', { mutates: false }, (_page, signal) =>
      Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
    );
    // Poshmark's listing editor is a heavy page: it gets more time than a step's default.
    const opened = await step(
      'open the listing form',
      { mutates: false, timeScale: 2 },
      async (page) =>
        (await openForm(page, site.createListing())) ? { id: await newListingId(page) } : null,
    );
    // Poshmark sends a seller to the form, never to a 404, so a missing one is a changed page.
    if (opened === null) throw new PageChangedError("Poshmark's listing form isn't there");
    await step('add the photos', { mutates: false, timeScale: 2 }, (page) =>
      addPhotos(page, files),
    );
    await fillListing(step, payload);
    await step('set the SKU and availability', { mutates: false }, async (page) => {
      await fillSku(page, sku);
      await setAvailability(page, 'for_sale');
    });
    const result = await save(step, 'list');
    if (result.type !== 'applied' || result.externalListingId !== undefined) return result;
    // After List, Poshmark shows the closet, which doesn't name the new listing: its own page,
    // by the id its form named, confirms it at once. Without that, it is looked for by its SKU
    // in the same run. Not finding it yet leaves it to the operation's check.
    try {
      const listed = opened.id === null ? null : await newListing(step, opened.id);
      if (listed !== null) return listed;
      const id = await findBySku(step, sku, payload.title, { search: false });
      if (id !== null) return { ...result, externalListingId: id };
    } catch {
      // The check reads it back later.
    }
    return result;
  }

  return {
    create: (op, step) => createListing(op, step),
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
}
