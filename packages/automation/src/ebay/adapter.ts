/**
 * The eBay automation adapter (decision D1, revised 2026-10-24: eBay permitted the product
 * owner's automation for their own use; docs/features/ebay-automation.md). Until Listora's eBay
 * developer keys exist, Listora acts on eBay through the seller's own browser session in the
 * browser runner. Its scripts drive eBay's pages through the page modules in `pages/` (one per
 * page, with that page's selectors), under the runner's safety rules: human pacing, rate limits,
 * and a stop at any CAPTCHA, bot check, or login challenge, after which the step is the user's
 * task. A seller whose eBay connection uses the API is served by the eBay API adapter instead
 * (`ConnectionAwareAdapter`), never by this one; both address the same listings by eBay's item
 * number and the seller's SKU, so the switch needs no data migration.
 *
 * - Create: fill the listing form in the listing's category (photos in order, title, the SKU as
 *   the Custom label, item specifics, condition, description, price), then List it; only that
 *   click mutates. A later attempt first looks for the listing by its SKU, so a create eBay
 *   already took is never listed twice.
 * - Revise and price: the revise form, then Revise it.
 * - End: Seller Hub's end page ("The item is no longer available"). eBay keeps the ended
 *   listing, so the read-back confirms it ended. Relist: eBay's relist form, filled with the
 *   listing's content, lists it again under a new item number, as the Trading API's relist does.
 * - Mark sold is not needed: eBay marks its own sales sold.
 * - Read-back: the listing's page (status, title, price, and its newest time as the revision),
 *   and the revise form for the description of a listing on sale.
 * - Sale checks read Seller Hub's sold listings; its active listings list the seller's listings
 *   for imports and drift checks.
 */
import {
  createEbayAssistedAdapter,
  descriptionText,
  type OperationRequest,
  type RemoteListing,
  type RemoteListingState,
  type RemoteOrder,
} from '@listora/marketplaces';
import type { Logger } from '@listora/shared';

import {
  AutomationAdapter,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/automation-adapter.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import type { AutomationSessions } from '../adapter/sessions.ts';
import { listingSku } from '../adapter/sku-line.ts';
import { standInProfile, type AutomationProfile } from '../profiles.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';
import { readActiveListingsPage } from './pages/active-listings-page.ts';
import { changed, itemUrl, type EbaySite } from './pages/common.ts';
import { endListing, openEndPage } from './pages/end-page.ts';
import { readItem, readShownItem } from './pages/item-page.ts';
import {
  fillListing,
  fillPrice,
  openListingForm,
  openNewListingForm,
  readListingForm,
  submitListing,
  type Submitted,
} from './pages/listing-form.ts';
import { openOverview } from './pages/overview-page.ts';
import { readSoldListingsPage } from './pages/sold-listings-page.ts';
import {
  buildEbayAutomationPayload,
  EBAY_MIN_PRICE_CENTS,
  validateEbayAutomationPayload,
  type EbayAutomationPayload,
} from './payload.ts';
import { EBAY_SITE_URL } from './site.ts';

export interface EbayAutomationAdapterOptions {
  /** eBay's profile, as configured (pacing and limits). */
  profile: AutomationProfile;
  sessions: AutomationSessions;
  photos: PhotoSource;
  logger: Logger;
  /**
   * Development and tests only: the fake eBay site's URL, which then stands in for eBay (its
   * origin becomes the profile's). Defaults to eBay itself.
   */
  siteUrl?: string;
}

/**
 * How many of the newest active listings a lookup by SKU looks through. A listing whose item
 * number Listora never learned is one it just listed, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** Pages of active listings one read goes through at most (newest first). */
export const MAX_LISTING_PAGES = 25;
/** Pages of sold listings one sale check goes through at most (newest first). */
export const MAX_SOLD_PAGES = 5;

export function createEbayAutomationAdapter(
  options: EbayAutomationAdapterOptions,
): AutomationAdapter<EbayAutomationPayload> {
  const siteUrl = options.siteUrl ?? EBAY_SITE_URL;
  const site: EbaySite = { origin: new URL(siteUrl).origin };
  const profile =
    options.siteUrl === undefined ? options.profile : standInProfile(options.profile, siteUrl);

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on eBay yet.',
  });
  const sold = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_sold',
    message: 'This listing sold on eBay, so it cannot be changed.',
    fixHint: 'Relist the item to sell it again.',
  });
  const ended = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_ended',
    message: 'This listing ended on eBay, so it cannot be changed.',
    fixHint: 'Relist the item to put it back on sale.',
  });

  /** Reads a listing by its item number, with the description of one on sale. */
  async function readById(step: StepRunner, itemId: string): Promise<RemoteListingState> {
    const shown = await step('read the listing', { mutates: false }, (page) =>
      readItem(page, site, itemId),
    );
    if (!shown.found || shown.status !== 'active') return shown;
    const form = await step('read the description', { mutates: false }, (page) =>
      readListingForm(page, site, itemId),
    );
    // A listing on sale whose revise form is missing: the page is not what Listora knows.
    if (form === null) throw changed('revise form', 'shows no listing form for a listing on sale');
    return { ...shown, description: descriptionText(form.descriptionHtml) };
  }

  /** The listing the newest active listings hold under this SKU, if any. */
  async function findBySku(step: StepRunner, sku: string): Promise<RemoteListing | null> {
    const recent = await step('look at the newest listings', { mutates: false }, (page) =>
      readActiveListingsPage(page, site, 0),
    );
    const match = recent.rows.slice(0, SKU_LOOKUP_DEPTH).find((row) => row.sku === sku);
    if (match === undefined) return null;
    // The listing's own page, so a listing found by SKU reads exactly as it does by its number.
    const read = await readById(step, match.itemId);
    return read.found ? read : null;
  }

  /** After a submit: eBay's refusal, or the listing it opened, with its revision. */
  async function submitted(page: PageDriver, outcome: Submitted): Promise<WriteResult> {
    if (outcome.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: outcome.message };
    }
    const shown = await readShownItem(page, site);
    return { ...revisionOf(shown), externalListingId: outcome.itemId };
  }

  /** A listing an earlier attempt of a create or relist made, found by its SKU. */
  async function earlier(
    op: OperationRequest<EbayAutomationPayload>,
    step: StepRunner,
  ): Promise<WriteResult | null> {
    if (op.attempt <= 1) return null;
    // An earlier attempt may have gone through; eBay would take a second copy.
    const found = await findBySku(step, listingSku(op.listing));
    return found?.status === 'active'
      ? { ...revisionOf(found), externalListingId: found.externalListingId }
      : null;
  }

  /** The item number of a listing that can be changed; a result instead when it can't. */
  async function editable(
    op: OperationRequest<EbayAutomationPayload>,
    step: StepRunner,
    categoryId: string | null,
  ): Promise<{ itemId: string } | WriteResult> {
    const itemId = op.listing.externalListingId;
    if (itemId === null) return notListed();
    const opened = await step('open the revise form', { mutates: false }, (page) =>
      openListingForm(page, site, 'ReviseItem', itemId, categoryId),
    );
    if (opened === 'editing') return { itemId };
    const shown = await step('open the listing', { mutates: false }, (page) =>
      readItem(page, site, itemId),
    );
    if (!shown.found) return notListed();
    if (shown.status === 'sold') return sold();
    if (shown.status === 'ended') return ended();
    throw changed('revise form', 'shows no listing form for a listing on sale');
  }

  const scripts: AutomationScripts<EbayAutomationPayload> = {
    create: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a create has a payload');
      const categoryId = payload.categoryId;
      if (categoryId === null) throw new Error('a listing without a category passed validation');
      const found = await earlier(op, step);
      if (found !== null) return found;
      const files = await step('get the photos', { mutates: false }, (_page, signal) =>
        Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
      );
      await step('fill in the listing', { mutates: false }, async (page) => {
        await openNewListingForm(page, site, categoryId);
        await fillListing(page, payload, listingSku(op.listing), files);
      });
      return step('list it', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page)),
      );
    },
    revise: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      const opened = await editable(op, step, payload.categoryId);
      if (!('itemId' in opened)) return opened;
      await step('fill in the changes', { mutates: false }, (page) =>
        fillListing(page, payload, listingSku(op.listing), null),
      );
      return step('revise it', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page)),
      );
    },
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents < EBAY_MIN_PRICE_CENTS) {
        return {
          type: 'rejected',
          code: 'invalid_price',
          message: 'eBay prices must be at least $0.99.',
        };
      }
      const opened = await editable(op, step, null);
      if (!('itemId' in opened)) return opened;
      await step('fill in the price', { mutates: false }, (page) => fillPrice(page, priceCents));
      return step('revise it', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page)),
      );
    },
    end: async (op, step) => {
      const itemId = op.listing.externalListingId;
      if (itemId === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readItem(page, site, itemId),
      );
      if (!shown.found) return notListed();
      // Ended or sold: nothing is live, and the read-back decides.
      if (shown.status !== 'active') return { type: 'applied' };
      await step('open the end page', { mutates: false }, (page) =>
        openEndPage(page, site, itemId),
      );
      return step('end it', { mutates: true }, async (page) => {
        await endListing(page);
        return revisionOf(await readShownItem(page, site));
      });
    },
    relist: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a relist has a payload');
      const itemId = op.listing.externalListingId;
      if (itemId === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readItem(page, site, itemId),
      );
      if (!shown.found) return notListed();
      if (shown.status === 'active') return { type: 'applied', externalListingId: itemId };
      const found = await earlier(op, step);
      if (found !== null) return found;
      // Ended or sold: eBay's relist form, filled with the listing's content, under a new item
      // number. The relisted listing keeps the photos it had.
      const opened = await step('open the relist form', { mutates: false }, (page) =>
        openListingForm(page, site, 'RelistItem', itemId, payload.categoryId),
      );
      if (opened === 'not_editable') {
        throw changed('relist form', 'shows no listing form for an ended listing');
      }
      await step('fill in the listing', { mutates: false }, (page) =>
        fillListing(page, payload, listingSku(op.listing), null),
      );
      return step('list it', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page)),
      );
    },
    read: async (ref, step): Promise<RemoteListingState> => {
      const itemId = ref.externalListingId;
      if (itemId !== null) return readById(step, itemId);
      // Found by SKU: not finding it is no proof the listing is gone.
      return (await findBySku(step, listingSku(ref))) ?? { found: false, authoritative: false };
    },
    health: (step) =>
      step('open Seller Hub', { mutates: false }, (page) => openOverview(page, site)),
    orders: async (since, step) => {
      const orders = new Map<string, RemoteOrder>();
      let offset = 0;
      for (let number = 1; number <= MAX_SOLD_PAGES; number += 1) {
        const shown = await step('read the sold listings', { mutates: false }, (page) =>
          readSoldListingsPage(page, site, offset),
        );
        for (const row of shown.rows) {
          if (since !== null && row.soldAt < since) continue;
          // An order with several of the seller's listings shows a row for each.
          const order = orders.get(row.orderId) ?? {
            externalOrderId: row.orderId,
            soldAt: row.soldAt,
            items: [],
          };
          order.items.push({
            externalListingId: row.itemId,
            title: null,
            priceCents: row.priceCents,
            currency: 'USD',
          });
          orders.set(row.orderId, order);
        }
        // Newest first: a page that reaches past `since` is the last one needed.
        const oldest = shown.rows.at(-1)?.soldAt ?? null;
        if (!shown.hasMore || (since !== null && oldest !== null && oldest < since)) break;
        offset += shown.rows.length;
      }
      return [...orders.values()];
    },
    listings: async (step) => {
      const listings: RemoteListing[] = [];
      let offset = 0;
      for (let number = 1; number <= MAX_LISTING_PAGES; number += 1) {
        const shown = await step('read the active listings', { mutates: false }, (page) =>
          readActiveListingsPage(page, site, offset),
        );
        // Seller Hub's rows show no description or last update: these are never read-backs.
        listings.push(
          ...shown.rows.map((row): RemoteListing => ({
            found: true,
            externalListingId: row.itemId,
            externalUrl: itemUrl(site, row.itemId),
            status: 'active',
            title: row.title,
            description: null,
            priceCents: row.priceCents,
            currency: row.priceCents === null ? null : 'USD',
            revision: null,
          })),
        );
        if (!shown.hasMore) return { listings, complete: true };
        offset += shown.rows.length;
      }
      return { listings, complete: false };
    },
  };

  return new AutomationAdapter<EbayAutomationPayload>({
    marketplace: 'ebay',
    profile,
    sessions: options.sessions,
    // A step automation can't do opens the real eBay, where the user does it.
    assisted: createEbayAssistedAdapter(),
    scripts,
    readFreshness: 'revision',
    buildPayload: buildEbayAutomationPayload,
    validate: validateEbayAutomationPayload,
    logger: options.logger,
  });
}

/** An applied change, with the revision the listing's page showed after it. */
function revisionOf(read: RemoteListingState): Extract<WriteResult, { type: 'applied' }> {
  return read.found && read.revision !== null
    ? { type: 'applied', revision: read.revision }
    : { type: 'applied' };
}
