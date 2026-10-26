/**
 * The Depop automation scripts: how each operation is done on Depop's pages (adapter.ts
 * describes it). They are the one definition both hosts run: the browser runner, and the
 * iPhone app for a seller whose Depop runs on their phone (docs/features/phone-execution.md).
 */
import {
  type OperationRequest,
  type RemoteListing,
  type RemoteListingState,
  type RemoteOrder,
} from '@listora/marketplaces';

import type { AutomationScripts, WriteResult } from '../adapter/script-call.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import { listingSku } from '../adapter/sku-line.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';
import { changed, type DepopSite } from './pages/common.ts';
import { deleteListing, openEditor } from './pages/edit-page.ts';
import { openHub } from './pages/hub-page.ts';
import {
  fillListing,
  fillPrice,
  openSellForm,
  submitListing,
  type Submitted,
} from './pages/listing-form.ts';
import { readProduct, readShownProduct, type ProductPageRead } from './pages/product-page.ts';
import { readSellingPage } from './pages/selling-page.ts';
import { readSoldItemsPage } from './pages/sold-items-page.ts';
import { type DepopAutomationPayload } from './payload.ts';

/**
 * How many of the newest listings for sale a lookup by SKU looks through. A listing whose slug
 * Listora never learned is one it just posted, so it is among the newest.
 */
export const SKU_LOOKUP_DEPTH = 8;
/** Pages of the selling page one read goes through at most (newest first). */
export const MAX_LISTING_PAGES = 25;
/** Pages of sold items one sale check goes through at most (newest first). */
export const MAX_SOLD_PAGES = 5;

export interface DepopScriptOptions {
  /** The site the scripts drive: Depop, or its stand-in in development and tests. */
  site: DepopSite;
  photos: PhotoSource;
}

export function createDepopScripts(
  options: DepopScriptOptions,
): AutomationScripts<DepopAutomationPayload> {
  const { site } = options;

  const notListed = (): WriteResult => ({
    type: 'rejected',
    code: 'not_listed',
    message: 'This listing is not on Depop yet.',
  });
  const sold = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_sold',
    message: 'This listing sold on Depop, so it cannot be changed.',
    fixHint: 'Relist the item as a new Depop listing.',
  });
  const deleted = (): WriteResult => ({
    type: 'rejected',
    code: 'listing_ended',
    message: 'This listing was deleted on Depop, so it cannot be changed.',
    fixHint: 'Relist the item as a new Depop listing.',
  });

  /** The listing the newest listings for sale hold under this SKU, if any. */
  async function findBySku(step: StepRunner, sku: string): Promise<ProductPageRead | null> {
    const recent = await step('look at the newest listings', { mutates: false }, (page) =>
      readSellingPage(page, site, 1),
    );
    const match = recent.products.slice(0, SKU_LOOKUP_DEPTH).find((product) => product.sku === sku);
    if (match === undefined) return null;
    // The product's own page, so a listing found by SKU reads exactly as it does by its slug.
    return step('read the listing', { mutates: false }, (page) =>
      readProduct(page, site, match.listing.externalListingId),
    );
  }

  /** After a submit: Depop's refusal, or the product it opened, with its revision. */
  async function submitted(page: PageDriver, outcome: Submitted): Promise<WriteResult> {
    if (outcome.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: outcome.message };
    }
    const shown = await readShownProduct(page, site);
    return { ...revisionOf(shown), externalListingId: outcome.slug };
  }

  /** Posts a new listing (a create, or a relist); a later attempt first looks for it. */
  async function post(
    op: OperationRequest<DepopAutomationPayload>,
    step: StepRunner,
  ): Promise<WriteResult> {
    const payload = op.payload;
    if (payload === null) throw new Error(`a ${op.kind} has a payload`);
    const sku = listingSku(op.listing);
    if (op.attempt > 1) {
      // An earlier attempt may have gone through; Depop would take a second copy.
      const earlier = await findBySku(step, sku);
      if (earlier?.state.found === true) {
        return { ...revisionOf(earlier), externalListingId: earlier.state.externalListingId };
      }
    }
    const files = await step('get the photos', { mutates: false }, (_page, signal) =>
      Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
    );
    await step('fill in the listing', { mutates: false }, async (page) => {
      await openSellForm(page, site);
      await fillListing(page, payload, sku, files);
    });
    return step('post', { mutates: true }, async (page) =>
      submitted(page, await submitListing(page, 'post')),
    );
  }

  /** Opens the editor of a listing on sale; a result instead when it can't be edited. */
  async function editor(
    op: OperationRequest<DepopAutomationPayload>,
    step: StepRunner,
  ): Promise<{ slug: string } | WriteResult> {
    const slug = op.listing.externalListingId;
    if (slug === null) return notListed();
    const opened = await step('open the editor', { mutates: false }, (page) =>
      openEditor(page, site, slug),
    );
    if (opened === 'editing') return { slug };
    const shown = await step('open the listing', { mutates: false }, (page) =>
      readProduct(page, site, slug),
    );
    if (!shown.state.found) return notListed();
    if (shown.state.status === 'sold') return sold();
    if (shown.state.status === 'ended') return deleted();
    // A listing on sale whose edit page has no form: the page is not what Listora knows.
    throw changed('edit page', 'shows no listing form for a listing on sale');
  }

  return {
    create: (op, step) => post(op, step),
    revise: async (op, step) => {
      const payload = op.payload;
      if (payload === null) throw new Error('a revise has a payload');
      const opened = await editor(op, step);
      if (!('slug' in opened)) return opened;
      await step('fill in the changes', { mutates: false }, (page) =>
        fillListing(page, payload, listingSku(op.listing), null),
      );
      return step('save', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page, 'save')),
      );
    },
    price: async (op, step) => {
      const priceCents = op.desired.priceCents;
      if (priceCents === undefined) {
        return { type: 'rejected', code: 'missing_price', message: 'There is no price to set.' };
      }
      if (priceCents < 100) {
        return {
          type: 'rejected',
          code: 'invalid_price',
          message: 'Depop prices must be at least $1.00.',
        };
      }
      const opened = await editor(op, step);
      if (!('slug' in opened)) return opened;
      await step('fill in the price', { mutates: false }, (page) => fillPrice(page, priceCents));
      return step('save', { mutates: true }, async (page) =>
        submitted(page, await submitListing(page, 'save')),
      );
    },
    end: async (op, step) => {
      const slug = op.listing.externalListingId;
      if (slug === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readProduct(page, site, slug),
      );
      if (!shown.state.found) return notListed();
      // Deleted or sold: nothing is live, and the read-back decides.
      if (shown.state.status !== 'active') return { type: 'applied' };
      const opened = await editor(op, step);
      if (!('slug' in opened)) return opened;
      return step('delete', { mutates: true }, async (page) => {
        await deleteListing(page);
        return revisionOf(await readShownProduct(page, site));
      });
    },
    relist: async (op, step) => {
      const slug = op.listing.externalListingId;
      if (slug === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readProduct(page, site, slug),
      );
      if (!shown.state.found) return notListed();
      if (shown.state.status === 'active') return { type: 'applied', externalListingId: slug };
      // Deleted or sold: a new listing from the listing's content, under a new slug.
      return post(op, step);
    },
    read: async (ref, step): Promise<RemoteListingState> => {
      const slug = ref.externalListingId;
      if (slug !== null) {
        const read = await step('read the listing', { mutates: false }, (page) =>
          readProduct(page, site, slug),
        );
        return read.state;
      }
      // Found by SKU: not finding it is no proof the listing is gone.
      const found = await findBySku(step, listingSku(ref));
      return found?.state ?? { found: false, authoritative: false };
    },
    health: (step) =>
      step('open the selling hub', { mutates: false }, (page) => openHub(page, site)),
    orders: async (since, step) => {
      const orders: RemoteOrder[] = [];
      for (let number = 1; number <= MAX_SOLD_PAGES; number += 1) {
        const shown = await step('read the sold items', { mutates: false }, (page) =>
          readSoldItemsPage(page, site, number),
        );
        for (const item of shown.items) {
          if (since !== null && item.soldAt < since) continue;
          // Listora lists one of each item, so a Depop listing sells once: its slug names the
          // order.
          orders.push({
            externalOrderId: item.slug,
            soldAt: item.soldAt,
            items: [
              {
                externalListingId: item.slug,
                title: null,
                priceCents: item.priceCents,
                currency: 'USD',
              },
            ],
          });
        }
        // Newest first: a page that reaches past `since` is the last one needed.
        const oldest = shown.items.at(-1)?.soldAt ?? null;
        if (!shown.hasMore || (since !== null && oldest !== null && oldest < since)) break;
      }
      return orders;
    },
    listings: async (step) => {
      const listings: RemoteListing[] = [];
      for (let number = 1; number <= MAX_LISTING_PAGES; number += 1) {
        const shown = await step('read the listings for sale', { mutates: false }, (page) =>
          readSellingPage(page, site, number),
        );
        listings.push(...shown.products.map((product) => product.listing));
        if (!shown.hasMore) return { listings, complete: true };
      }
      return { listings, complete: false };
    },
  };
}

/** An applied change, with the revision the product page showed after it. */
function revisionOf(read: ProductPageRead): Extract<WriteResult, { type: 'applied' }> {
  return read.state.found && read.state.revision !== null
    ? { type: 'applied', revision: read.state.revision }
    : { type: 'applied' };
}
