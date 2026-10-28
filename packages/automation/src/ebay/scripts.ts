/**
 * The eBay automation scripts: how each operation is done on eBay's pages (adapter.ts
 * describes it). They are the one definition both hosts run: the browser runner, and the
 * iPhone app for a seller whose eBay runs on their phone (docs/features/phone-execution.md).
 */
import {
  descriptionText,
  type OperationRequest,
  type ListedListing,
  type RemoteListing,
  type RemoteListingState,
  type RemoteOrder,
} from '@listora/marketplaces';

import {
  mayHaveAppliedBefore,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/script-call.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import { listingSku } from '../adapter/sku-line.ts';
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
import { EBAY_MIN_PRICE_CENTS, type EbayAutomationPayload } from './payload.ts';

/**
 * How many of the newest active listings a lookup by SKU looks through. A listing whose item
 * number Listora never learned is one it just listed, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** Pages of sold listings one sale check goes through at most (newest first). */
export const MAX_SOLD_PAGES = 5;

export interface EbayScriptOptions {
  /** The site the scripts drive: eBay, or its stand-in in development and tests. */
  site: EbaySite;
  photos: PhotoSource;
}

export function createEbayScripts(
  options: EbayScriptOptions,
): AutomationScripts<EbayAutomationPayload> {
  const { site } = options;

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
    if (!mayHaveAppliedBefore(op)) return null;
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

  return {
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
    listings: async (cursor, step) => {
      // One page of Seller Hub's active listings: the cursor is the page's offset. Its rows
      // show no description, last update, or photos, so a listing found here is never a
      // read-back, and eBay is not offered for imports yet (docs/features/imports.md).
      const offset = cursor === null ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(`an eBay listings cursor is an offset, not ${String(cursor)}`);
      }
      const shown = await step('read the active listings', { mutates: false }, (page) =>
        readActiveListingsPage(page, site, offset),
      );
      return {
        listings: shown.rows.map((row): ListedListing => ({
          found: true,
          externalListingId: row.itemId,
          externalUrl: itemUrl(site, row.itemId),
          status: 'active',
          title: row.title,
          description: null,
          priceCents: row.priceCents,
          currency: row.priceCents === null ? null : 'USD',
          revision: null,
          refreshedAt: null,
          details: {
            photoUrls: [],
            brand: null,
            size: null,
            condition: null,
            categoryRef: null,
            categoryPath: [],
            colors: [],
            originalPriceCents: null,
            sku: null,
          },
        })),
        next: shown.hasMore ? String(offset + shown.rows.length) : null,
      };
    },
  };
}

/** An applied change, with the revision the listing's page showed after it. */
function revisionOf(read: RemoteListingState): Extract<WriteResult, { type: 'applied' }> {
  return read.found && read.revision !== null
    ? { type: 'applied', revision: read.revision }
    : { type: 'applied' };
}
