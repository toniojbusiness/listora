/**
 * The Depop automation scripts: how each operation is done on Depop's pages (adapter.ts
 * describes it). They are the one definition both hosts run: the browser runner, and the
 * iPhone app for a seller whose Depop runs on their phone (docs/features/phone-execution.md).
 */
import {
  type LabelReadRequest,
  type ListedListing,
  type OperationRequest,
  type RemoteListingState,
  type RemoteOffer,
} from '@listora/marketplaces';

import {
  mayHaveAppliedBefore,
  sellerIdentity,
  type AutomationScripts,
  type WriteResult,
} from '../adapter/script-call.ts';
import type { PhotoSource } from '../adapter/photos.ts';
import { listingSku } from '../adapter/sku-line.ts';
import type { PageDriver, StepRunner } from '../runner/types.ts';
import { changed, type DepopSite } from './pages/common.ts';
import { deleteListing, expectDelete, openEditor } from './pages/edit-page.ts';
import { hubSeller, openHub } from './pages/hub-page.ts';
import {
  expectSubmit,
  fillListing,
  fillPrice,
  openSellForm,
  submitListing,
  type Submitted,
} from './pages/listing-form.ts';
import { onDepop, readOwnListings, readOwnProduct, type ApiProduct } from './pages/api.ts';
import { listingDetails } from './pages/listing-details.ts';
import { readProduct, type ProductPageRead } from './pages/product-page.ts';
import {
  MAX_RECEIPT_PAGES,
  orderLabel,
  readReceipts,
  type ReceiptLabel,
} from './pages/receipts.ts';
import {
  depopOfferPages,
  readOffer,
  readOfferProducts,
  readPendingOffers,
} from './pages/offers.ts';
import { answerOnOfferPage } from '../adapter/offer-page.ts';
import { type DepopAutomationPayload } from './payload.ts';
import { readSales, soldListings } from './sales.ts';

/**
 * Pages of the seller's newest listings for sale (24 each) a lookup by SKU looks through. A
 * listing whose slug Listora never learned is one it just posted, so it is among the newest.
 */
export const SKU_LOOKUP_PAGES = 1;
/** Reads of a refresh's new copy, `COPY_READ_GAP_MS` apart, before the old listing goes. */
export const COPY_READS = 4;
export const COPY_READ_GAP_MS = 3_000;
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

  /**
   * The listing the seller's newest listings for sale hold under this SKU, if any: from the
   * same list of the seller's own listings the selling hub loads (pages/api.ts), each with its
   * text and last change time, so it reads exactly as it does by its slug. `except` is a
   * listing that shares the SKU and is never the one looked for (a refresh's old listing).
   */
  async function findBySku(
    step: StepRunner,
    sku: string,
    except: string | null = null,
  ): Promise<ApiProduct | null> {
    return step('look for the listing', { mutates: false }, async (page) => {
      await onDepop(page, site);
      let cursor: string | null = null;
      for (let number = 1; number <= SKU_LOOKUP_PAGES; number += 1) {
        const shown = await readOwnListings(page, site, 'selling', cursor);
        const found = shown.products.find(
          (product) => product.sku === sku && product.state.externalListingId !== except,
        );
        if (found !== undefined) return found;
        if (shown.next === null) return null;
        cursor = shown.next;
      }
      return null;
    });
  }

  /**
   * After a submit: Depop's refusal, or the product it opened. The product is read back by the
   * operation's check, not here: the submit already happened, and its page may not show the
   * product for a moment.
   */
  function submitted(outcome: Submitted): WriteResult {
    if (outcome.type === 'refused') {
      return { type: 'rejected', code: 'validation_failed', message: outcome.message };
    }
    return outcome.slug === null
      ? { type: 'applied' }
      : { type: 'applied', externalListingId: outcome.slug };
  }

  /**
   * Posts a new listing (a create, a relist, or a refresh's fresh copy); an attempt after one
   * that may have posted first looks for it. `except` is the listing a refresh copies, which
   * has the same SKU and is never taken for the new one.
   */
  async function post(
    op: OperationRequest<DepopAutomationPayload>,
    step: StepRunner,
    except: string | null = null,
  ): Promise<WriteResult> {
    const payload = op.payload;
    if (payload === null) throw new Error(`a ${op.kind} has a payload`);
    const sku = listingSku(op.listing);
    if (mayHaveAppliedBefore(op)) {
      // An earlier attempt may have gone through; Depop would take a second copy.
      const earlier = await findBySku(step, sku, except);
      if (earlier !== null) {
        return { ...revisionOf(earlier), externalListingId: earlier.state.externalListingId };
      }
    }
    const files = await step('get the photos', { mutates: false }, (_page, signal) =>
      Promise.all(payload.photos.map((photo) => options.photos.fetch(photo.url, signal))),
    );
    await step('fill in the listing', { mutates: false, timeScale: 4 }, async (page) => {
      await openSellForm(page, site);
      await fillListing(page, payload, sku, files);
      await expectSubmit(page, 'post');
    });
    const result = await step('post', { mutates: true, timeScale: 2 }, async (page) =>
      submitted(await submitListing(page, 'post')),
    );
    if (result.type !== 'applied' || result.externalListingId !== undefined) return result;
    // Depop's Done page doesn't name the new listing: it is found by its SKU in the same run,
    // so it shows as listed at once. Not finding it yet leaves it to the operation's check.
    try {
      const found = await findBySku(step, sku, except);
      if (found !== null) {
        return { ...revisionOf(found), externalListingId: found.state.externalListingId };
      }
    } catch {
      // The check reads it back later.
    }
    return result;
  }

  const noContent = (): WriteResult => ({
    type: 'rejected',
    code: 'missing_content',
    message: "Listora didn't write this listing, so it can't post a fresh copy of it.",
  });

  /**
   * Reads a refresh's new copy until Depop shows it on sale (its page can lag a moment behind
   * the post); a copy not shown stops the refresh before the old listing is touched.
   */
  async function readCopy(page: PageDriver, copy: string): Promise<ProductPageRead> {
    for (let read = 1; ; read += 1) {
      const shown = await readProduct(page, site, copy);
      if (shown.state.found && shown.state.status === 'active') return shown;
      if (read >= COPY_READS) {
        throw changed('product page', "doesn't show the new copy of the listing as on sale");
      }
      await new Promise((resolve) => setTimeout(resolve, COPY_READ_GAP_MS));
    }
  }

  /**
   * Deletes one of the seller's listings by its slug (Delete listing on its product page, as an
   * end does), then reads it back: one Depop still shows on sale stops the run.
   */
  async function removeListing(step: StepRunner, slug: string): Promise<void> {
    const shown = await step('open the old listing', { mutates: false }, async (page) => {
      const read = await readProduct(page, site, slug);
      if (read.state.found && read.state.status === 'active') await expectDelete(page);
      return read;
    });
    if (!(shown.state.found && shown.state.status === 'active')) return;
    await step('delete the old listing', { mutates: true, timeScale: 2 }, (page) =>
      deleteListing(page),
    );
    await step('check the old listing is gone', { mutates: false }, async (page) => {
      const read = await readProduct(page, site, slug);
      if (read.state.found && read.state.status === 'active') {
        throw changed('product page', 'still shows the old listing on sale after deleting it');
      }
    });
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
    // Gone (Depop says so) is a deleted listing too.
    if (!shown.state.found) return shown.state.authoritative ? deleted() : notListed();
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
      // The same whole form a create fills in, so the same time.
      await step('fill in the changes', { mutates: false, timeScale: 4 }, async (page) => {
        await fillListing(page, payload, listingSku(op.listing), null);
        await expectSubmit(page, 'save');
      });
      return step('save', { mutates: true, timeScale: 2 }, async (page) =>
        submitted(await submitListing(page, 'save')),
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
      await step('fill in the price', { mutates: false }, async (page) => {
        await fillPrice(page, priceCents);
        await expectSubmit(page, 'save');
      });
      return step('save', { mutates: true, timeScale: 2 }, async (page) =>
        submitted(await submitListing(page, 'save')),
      );
    },
    end: async (op, step) => {
      const slug = op.listing.externalListingId;
      if (slug === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readProduct(page, site, slug),
      );
      // Gone (Depop says so) is ended already: the read-back confirms it.
      if (!shown.state.found) return shown.state.authoritative ? { type: 'applied' } : notListed();
      // Deleted or sold: nothing is live, and the read-back decides.
      if (shown.state.status !== 'active') return { type: 'applied' };
      // The seller's own product page has Delete listing, which asks to confirm in a dialog.
      await step('find Delete listing', { mutates: false }, (page) => expectDelete(page));
      return step('delete', { mutates: true, timeScale: 2 }, async (page) => {
        await deleteListing(page);
        return { type: 'applied' };
      });
    },
    relist: async (op, step) => {
      const slug = op.listing.externalListingId;
      if (slug === null) return notListed();
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readProduct(page, site, slug),
      );
      // Gone (Depop says so: End deletes a Depop listing), deleted, or sold: a new listing from
      // the listing's content, under a new slug.
      if (!shown.state.found) return shown.state.authoritative ? post(op, step) : notListed();
      if (shown.state.status === 'active') return { type: 'applied', externalListingId: slug };
      return post(op, step);
    },
    // A refresh reposts: Depop shows only a new listing as new, and an edit saved unchanged
    // moves its change time without moving it up (listing-refresh.md). A fresh copy from the
    // listing's content is posted and read back as on sale, and only then is the old listing
    // deleted and read back as gone; the result names the copy, so the operation's own
    // read-back confirms it and the listing moves to it. The old listing is never deleted
    // before its copy reads as live, and an attempt after one that may have posted finds that
    // copy by its SKU instead of posting another.
    refresh: async (op, step) => {
      const slug = op.listing.externalListingId;
      if (slug === null) return notListed();
      if (op.payload === null) return noContent();
      const sku = listingSku(op.listing);
      const shown = await step('open the listing', { mutates: false }, (page) =>
        readProduct(page, site, slug),
      );
      const old = shown.state;
      const earlier = mayHaveAppliedBefore(op) ? await findBySku(step, sku, slug) : null;
      if (old.found && old.status === 'sold') {
        // Sold meanwhile: a copy an earlier attempt posted must not stay on sale.
        if (earlier !== null) await removeListing(step, earlier.state.externalListingId);
        return sold();
      }
      if (!old.found || old.status !== 'active') {
        // Gone: an earlier attempt that posted its copy may have deleted it already.
        if (earlier !== null) {
          return { ...revisionOf(earlier), externalListingId: earlier.state.externalListingId };
        }
        return !old.found && !old.authoritative ? notListed() : deleted();
      }
      let copy = earlier?.state.externalListingId ?? null;
      if (copy === null) {
        const posted = await post(op, step, slug);
        if (posted.type !== 'applied') return posted;
        copy = posted.externalListingId ?? null;
      }
      if (copy === null || copy === slug) {
        // Posted, but not found yet: the next attempt finds it before the old one goes.
        throw changed('selling hub', 'shows no new copy of the listing after posting it');
      }
      const fresh = await step('read the new listing', { mutates: false, timeScale: 2 }, (page) =>
        readCopy(page, copy),
      );
      await removeListing(step, slug);
      return { ...revisionOf(fresh), externalListingId: copy };
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
      step('open the selling hub', { mutates: false }, async (page) => {
        await openHub(page, site);
        return sellerIdentity(await hubSeller(page, site));
      }),
    orders: (since, step) => readSales({ site, step, since }),
    labels: async (orders, step) => {
      // Newest first, until every order's purchase is read.
      const receipts: ReceiptLabel[] = [];
      const read = (order: LabelReadRequest) =>
        receipts.some((receipt) => receipt.purchaseId === order.externalOrderId);
      let cursor: string | null = null;
      for (let number = 1; number <= MAX_RECEIPT_PAGES; number += 1) {
        const shown = await step('read the sold items', { mutates: false }, async (page) => {
          await onDepop(page, site);
          return readReceipts(page, site, cursor);
        });
        receipts.push(...shown.receipts.map((receipt) => receipt.label));
        if (shown.next === null || orders.every(read)) break;
        cursor = shown.next;
      }
      // An order Listora names otherwise is found by its products: the sold listings give the
      // slugs of the other receipts' products.
      const others = receipts.filter(
        (receipt) => !orders.some((order) => order.externalOrderId === receipt.purchaseId),
      );
      const slugOf = new Map<number, string>();
      if (others.length > 0 && orders.some((order) => !read(order))) {
        const sold = await soldListings(
          { site, step },
          new Set(others.flatMap((receipt) => receipt.productIds)),
        );
        for (const [id, product] of sold) slugOf.set(id, product.state.externalListingId);
      }
      return orders.map((order) => orderLabel(order, receipts, slugOf));
    },
    listings: async (cursor, step, held) => {
      // One page of the listings for sale (24), newest first, then each one's own edit data
      // for its photos and details, one read at a time. A listing Listora already has settles
      // by its slug alone, so the list's record is all it needs: no read of its own.
      const shown = await step('read your listings for sale', { mutates: false }, async (page) => {
        await onDepop(page, site);
        return readOwnListings(page, site, 'selling', cursor);
      });
      const listings: ListedListing[] = [];
      for (const product of shown.products) {
        if (product.state.status !== 'active') continue;
        const slug = product.state.externalListingId;
        if (held.has(slug)) {
          listings.push({
            ...product.state,
            details: listingDetails(product.record, product.record, product.sku),
            fromList: true,
          });
          continue;
        }
        const own = await step('read a listing', { mutates: false }, (page) =>
          readOwnProduct(page, site, slug),
        );
        // Deleted since the list was read: nothing to import.
        if (own?.state.status !== 'active') continue;
        listings.push({
          ...own.state,
          details: listingDetails(own.record, product.record, own.sku ?? product.sku),
        });
      }
      return { listings, next: shown.next };
    },
    offers: async (step) => {
      // The products with offers, then each one's offers, one read at a time and a step each:
      // a real shop's offers, read in one step, took 24 to 28 of its 30 seconds (2026-10-28).
      const products = await step('read your offers', { mutates: false }, (page) =>
        readOfferProducts(page, site),
      );
      const offers: RemoteOffer[] = [];
      for (const product of products) {
        offers.push(
          ...(await step("read a listing's offers", { mutates: false }, (page) =>
            readPendingOffers(page, site, product),
          )),
        );
      }
      return offers;
    },
    offer: (ref, step) =>
      step('read the offer', { mutates: false }, (page) => readOffer(page, site, ref)),
    answerOffer: (request, step) => answerOnOfferPage(step, depopOfferPages(site), request),
  };
}

/** An applied change, with the revision a read showed after it. */
function revisionOf(read: ProductPageRead | ApiProduct): Extract<WriteResult, { type: 'applied' }> {
  return read.state.found && read.state.revision !== null
    ? { type: 'applied', revision: read.state.revision }
    : { type: 'applied' };
}
